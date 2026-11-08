/**
 * captcha-service.ts —— auto 模式接缝层。
 *
 * 把 happy-dom 求解器（src/solver/*，移植自 zcode-api）接到协议失败语义上。
 * 设计原则与之前 aether-extension 原型一致：
 *
 *  1. **懒启动**：没有真实挑战/未显式开启 auto 时，一行 happy-dom 都不加载。
 *     coding-plan 的条件验证码意味着 auto 模式下多数时间根本不需要求解。
 *  2. **单一失败出口**：池耗尽/求解失败 → ProtocolError NEEDS_CAPTCHA，
 *     绝不裸发（裸发是真实客户端永不产生的形态，主动暴露）。
 *  3. **CPU 治理联动**：governor 超限时降低池并发，防止求解吃满容器配额。
 *
 * ⚠️ 合规提示：auto 模式是绕过风控的自动化行为，违反上游 ToS 的可能性极高，
 * 且移植源自 CC BY-NC-SA 4.0 代码 —— 由此部分**不可商用**。默认 manual。
 * 由部署者显式设置 ZCODE_CAPTCHA_MODE=auto 并自行承担后果。
 */
import { CaptchaTokenPool } from '../../solver/token-pool.js'
import { CpuGovernor } from '../../solver/cpu-governor.js'
import { withRetry, RetryBudgetExhaustedError } from '../../solver/retry.js'
import { setSolverLogger, shutdownSolver, solverStats } from '../../solver/happy-solver.js'
import { errors } from '../../protocol/errors.js'
import { DEFAULT_CAPTCHA_CONFIG, type ZCodeCaptchaConfig } from './captcha-config.js'

export type CaptchaMode = 'manual' | 'auto' | 'off'

export interface CaptchaServiceConfig {
  mode: CaptchaMode
  /** 显式配置；auto 模式缺省时用内置默认（与 Core 相同的 no8xfe/sgp/11xygtvd） */
  sceneId?: string
  region?: string
  prefix?: string
  poolMin?: number
  poolMax?: number
  solveConcurrency?: number
  solveRetries?: number
  solveTimeoutMs?: number
  cpuLimitPercent?: number
  /** 每次获取的重试预算 */
  acquireBudgetMs?: number
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void
}

export class CaptchaService {
  private pool: CaptchaTokenPool | null = null
  private governor: CpuGovernor | null = null
  private warming: Promise<void> | null = null
  private log: (level: 'info' | 'warn' | 'error', msg: string) => void

  constructor(private readonly config: CaptchaServiceConfig) {
    this.log = config.log ?? ((lvl, m) => process.stderr.write(`[captcha:${lvl}] ${m}\n`))
    setSolverLogger(this.log)
  }

  get mode(): CaptchaMode {
    return this.config.mode
  }

  /**
   * 懒启动：首次 acquire 时建立池并预热。幂等 —— 并发调用共享同一个
   * warm promise（单飞），失败时清空以便下次重试。
   */
  private async ensurePool(cfg: ZCodeCaptchaConfig): Promise<CaptchaTokenPool> {
    if (this.pool) return this.pool
    if (this.warming) {
      await this.warming
      if (this.pool) return this.pool
      throw errors.needsCaptcha('captcha pool warming failed previously')
    }
    this.warming = (async () => {
      const pool = new CaptchaTokenPool({
        scene: cfg.sceneId,
        region: cfg.region,
        prefix: cfg.prefix,
        min: this.config.poolMin ?? 5,
        max: this.config.poolMax ?? 20,
        concurrency: this.config.solveConcurrency ?? 2,
        solveRetries: this.config.solveRetries ?? 3,
        solveTimeoutMs: this.config.solveTimeoutMs ?? 30_000,
        onIpBlock: (reason) => {
          this.log('error', `captcha IP block risk: ${reason} — suspending solves`)
          try {
            this.pool?.stop()
          } catch {
            /* ignore */
          }
        },
        log: this.log,
      })
      if (this.config.cpuLimitPercent && this.config.cpuLimitPercent > 0) {
        const governor = new CpuGovernor({
          limitPercent: this.config.cpuLimitPercent,
          hysteresisPercent: 15,
          maxConcurrency: this.config.solveConcurrency ?? 2,
          minConcurrency: 1,
          intervalMs: 2_000,
          onChange: (c) => pool.setConcurrency(c),
        })
        governor.start()
        this.governor = governor
      }
      await pool.start()
      this.pool = pool
      this.log('info', `captcha auto pool started (min=${this.config.poolMin ?? 5}, region=${cfg.region})`)
    })()
    try {
      await this.warming
    } catch (err) {
      this.warming = null
      throw err
    }
    if (this.pool) return this.pool
    throw errors.needsCaptcha('captcha pool failed to start')
  }

  /**
   * auto 模式取一个已解好的 verifyParam。
   *
   * 池先服务（亚毫秒），空池同步抢解（400-800ms），失败走有界重试；
   * 全部失败 → ProtocolError NEEDS_CAPTCHA（绝不返回伪造值、绝不裸发）。
   */
  async acquire(): Promise<string> {
    if (this.config.mode !== 'auto') {
      throw errors.needsCaptcha('captcha auto mode is not enabled')
    }
    const cfg: ZCodeCaptchaConfig = {
      ...DEFAULT_CAPTCHA_CONFIG,
      sceneId: this.config.sceneId ?? DEFAULT_CAPTCHA_CONFIG.sceneId,
      region: this.config.region ?? DEFAULT_CAPTCHA_CONFIG.region,
      prefix: this.config.prefix ?? DEFAULT_CAPTCHA_CONFIG.prefix,
    }
    const pool = await this.ensurePool(cfg)
    try {
      return await withRetry(async () => (await pool.take()).verifyParam, {
        budgetMs: this.config.acquireBudgetMs ?? 50_000,
        maxAttempts: 3,
        onRetry: (err, attempt) => this.log('warn', `captcha acquire retry ${attempt}: ${err.message}`),
      })
    } catch (err) {
      if (err instanceof RetryBudgetExhaustedError) {
        throw errors.needsCaptcha(
          `captcha auto-solve failed after ${err.attempts} attempts: ${err.lastError?.message ?? err.message}`,
        )
      }
      if (err instanceof Error && errors_needsCaptcha_marker(err)) {
        throw err
      }
      throw errors.needsCaptcha(`captcha auto-solve failed: ${(err as Error).message}`)
    }
  }

  /** 请求结束后调用：长流式期间刷新池的活跃时钟。 */
  touch(): void {
    this.pool?.touch()
  }

  stats(): Record<string, unknown> {
    return {
      mode: this.config.mode,
      pool: this.pool?.stats() ?? null,
      governor: this.governor?.snapshot() ?? null,
      solver: solverStats(),
    }
  }

  async shutdown(): Promise<void> {
    try {
      this.pool?.stop()
    } catch {
      /* ignore */
    }
    try {
      this.governor?.stop()
    } catch {
      /* ignore */
    }
    shutdownSolver()
    this.pool = null
    this.governor = null
  }
}

/** 已是 ProtocolError 的错误原样上抛（避免二次包装丢失 kind）。 */
function errors_needsCaptcha_marker(err: Error): boolean {
  return (err as { name?: string }).name === 'ProtocolError'
}

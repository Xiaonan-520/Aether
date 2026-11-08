/**
 * token-pool.ts —— 预生成令牌池。
 *
 * 核心思想：**热路径永不等求解**。
 *
 * 求解一次要 400-800ms，聊天请求的关键路径上多等 800ms 不可接受。
 * 所以池子常备一批已解好的 token，请求来了直接 take（亚毫秒），后台补充。
 *
 * 保留 zcode-api 的关键机制：
 *   - 双重 TTL（token 95s + certifyId 登记防重复）
 *   - 空闲缩容 / 深闲停机（留 1 个供唤醒秒用）
 *   - 空池同步抢解
 *   - F008（certifyId 重复）去重
 *   - IP 封禁快速失败（不加深封禁）
 */
import { solveTraceless } from "./happy-solver.js";

export interface PoolConfig {
  scene: string;
  region: string;
  prefix: string;
  min?: number;
  max?: number;
  /** token 存活时间，默认 95s */
  ttlMs?: number;
  refillIntervalMs?: number;
  solveRetries?: number;
  concurrency?: number;
  /** 单次求解超时，透传给 solveTraceless */
  solveTimeoutMs?: number;
  scaleDownIdleMs?: number;
  deepIdleAfterMs?: number;
  onIpBlock?: (reason: string) => void;
  log?: (level: "info" | "warn" | "error", msg: string) => void;
}

interface TokenEntry {
  param: string;
  cachedAt: number;
  certifyId: string | null;
}

/**
 * certifyId 登记表 —— 防 F008。
 *
 * 阿里云的 certifyId 是一次性的，同一 id 提交两次第二次必然 F008。
 * SDK 内部超时重试、以及我们自己重试时复用旧 token，都会导致重复。
 * 所以必须登记已发出的 id，take 时跳过。
 */
class CertifyIdRegistry {
  private seen = new Map<string, number>();
  constructor(private ttlMs: number) {}

  prune(now = Date.now()): void {
    const cutoff = now - this.ttlMs;
    for (const [id, at] of this.seen) {
      if (at < cutoff) this.seen.delete(id);
    }
  }
  has(id: string): boolean {
    return this.seen.has(id);
  }
  add(id: string): void {
    this.prune();
    this.seen.set(id, Date.now());
  }
}

/** 从 verify param（base64 JSON）里抠出 certifyId。 */
export function parseCertifyId(param: string): string | null {
  try {
    const decoded = JSON.parse(Buffer.from(param, "base64").toString("utf8")) as Record<string, unknown>;
    const id = decoded.certifyId ?? decoded.CertifyId;
    return id ? String(id) : null;
  } catch {
    return null;
  }
}

export function isDuplicateError(msg: string): boolean {
  return /F008|duplicate/i.test(msg);
}

export function isIpBlockError(msg: string): boolean {
  return /too many captcha|ip.?block|frequency|F011|F010/i.test(msg);
}

type Logger = (level: "info" | "warn" | "error", msg: string) => void;

export class CaptchaTokenPool {
  private tokens: TokenEntry[] = [];
  private registry: CertifyIdRegistry;
  private timer: ReturnType<typeof setInterval> | null = null;
  private solving = 0;
  private lastDemandAt = Date.now();
  private stopping = false;
  private cfg: Required<
    Pick<
      PoolConfig,
      | "scene"
      | "region"
      | "prefix"
      | "min"
      | "max"
      | "ttlMs"
      | "refillIntervalMs"
      | "solveRetries"
      | "concurrency"
      | "solveTimeoutMs"
      | "scaleDownIdleMs"
      | "deepIdleAfterMs"
    >
  >;
  private onIpBlock?: (reason: string) => void;
  private log: Logger;

  constructor(cfg: PoolConfig) {
    this.cfg = {
      scene: cfg.scene,
      region: cfg.region,
      prefix: cfg.prefix,
      min: cfg.min ?? 15,
      max: cfg.max ?? 60,
      ttlMs: cfg.ttlMs ?? 95_000,
      refillIntervalMs: cfg.refillIntervalMs ?? 2_000,
      solveRetries: cfg.solveRetries ?? 4,
      concurrency: cfg.concurrency ?? 3,
      solveTimeoutMs: cfg.solveTimeoutMs ?? 30_000,
      scaleDownIdleMs: cfg.scaleDownIdleMs ?? 120_000,
      deepIdleAfterMs: cfg.deepIdleAfterMs ?? 900_000,
    };
    this.registry = new CertifyIdRegistry(this.cfg.ttlMs * 2);
    this.onIpBlock = cfg.onIpBlock;
    this.log = cfg.log ?? ((lvl, m) => process.stderr.write(`[captcha-pool:${lvl}] ${m}\n`));
  }

  async start(): Promise<void> {
    this.stopping = false;
    this.timer = setInterval(() => {
      void this.refillTick();
    }, this.cfg.refillIntervalMs);
    if (this.timer && typeof (this.timer as { unref?: () => void }).unref === "function") {
      (this.timer as { unref(): void }).unref();
    }
    await this.prefill(this.cfg.min);
  }

  stop(): void {
    this.stopping = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.tokens = [];
  }

  /** 记录"还有请求活着" —— 长流式请求不该让池子衰减。 */
  touch(): void {
    this.lastDemandAt = Date.now();
  }

  /**
   * 取一个 token。池空时**原地抢解**。
   * 抢解会阻塞 400-800ms，所以调用方必须在"已决定必须带 captcha"之后才调。
   */
  async take(): Promise<{ verifyParam: string; region: string }> {
    this.touch();
    this.pruneExpired();

    for (;;) {
      const hit = this.tokens.shift();
      if (hit) {
        if (hit.certifyId && this.registry.has(hit.certifyId)) continue;
        if (hit.certifyId) this.registry.add(hit.certifyId);
        return { verifyParam: hit.param, region: this.cfg.region };
      }
      this.log("warn", "池空，同步抢解中");
      const minted = await this.solveOnce();
      if (minted) {
        if (minted.certifyId) this.registry.add(minted.certifyId);
        return { verifyParam: minted.param, region: this.cfg.region };
      }
      throw new Error("captcha 池耗尽且抢解失败");
    }
  }

  /** CPU 治理回调：动态调整求解并发 */
  setConcurrency(n: number): void {
    if (Number.isFinite(n) && n >= 1) this.cfg.concurrency = Math.floor(n)
  }

  stats(): { size: number; min: number; max: number; solving: number } {
    this.pruneExpired();
    return { size: this.tokens.length, min: this.cfg.min, max: this.cfg.max, solving: this.solving };
  }

  private pruneExpired(now = Date.now()): void {
    const cutoff = now - this.cfg.ttlMs;
    this.tokens = this.tokens.filter((t) => t.cachedAt >= cutoff);
  }

  /**
   * 目标池大小 —— 按需求活跃度自适应。
   * 刚有请求 → min；空闲超 scaleDownIdleMs → 1；深度空闲 → 0（停解省 CPU）。
   */
  private targetSize(now = Date.now()): number {
    const idle = now - this.lastDemandAt;
    if (idle > this.cfg.deepIdleAfterMs) return 0;
    if (idle > this.cfg.scaleDownIdleMs) return 1;
    return this.cfg.min;
  }

  private async prefill(n: number): Promise<void> {
    const jobs: Promise<void>[] = [];
    const limit = Math.min(n, this.cfg.concurrency);
    for (let i = 0; i < limit; i++) jobs.push(this.mintToPool());
    await Promise.all(jobs);
  }

  private async refillTick(): Promise<void> {
    if (this.stopping) return;
    this.pruneExpired();
    const target = this.targetSize();
    if (target === 0) {
      if (this.tokens.length < 1 && this.solving === 0) await this.mintToPool();
      return;
    }
    const need = Math.min(target - this.tokens.length, this.cfg.max - this.tokens.length);
    if (need <= 0) return;
    const slots = Math.min(need, this.cfg.concurrency - this.solving);
    const jobs: Promise<void>[] = [];
    for (let i = 0; i < slots; i++) jobs.push(this.mintToPool());
    await Promise.all(jobs);
  }

  private async mintToPool(): Promise<void> {
    if (this.stopping || this.tokens.length >= this.cfg.max) return;
    this.solving += 1;
    try {
      const minted = await this.solveOnce();
      if (minted) {
        if (minted.certifyId && this.registry.has(minted.certifyId)) {
          this.log("warn", `丢弃重复 certifyId: ${minted.certifyId}`);
        } else {
          this.tokens.push(minted);
        }
      }
    } finally {
      this.solving -= 1;
    }
  }

  /** 单次求解（带重试）。失败返回 null，绝不抛（避免打崩补充循环）。 */
  private async solveOnce(): Promise<TokenEntry | null> {
    let lastErr = "";
    for (let attempt = 1; attempt <= this.cfg.solveRetries; attempt++) {
      if (this.stopping) return null;
      try {
        const param = await solveTraceless({
          scene: this.cfg.scene,
          region: this.cfg.region,
          prefix: this.cfg.prefix,
          timeoutMs: this.cfg.solveTimeoutMs,
        });
        return { param, cachedAt: Date.now(), certifyId: parseCertifyId(param) };
      } catch (err) {
        lastErr = (err as Error).message;
        // IP 被封：重试只会加深封禁，直接上报并放弃本轮
        if (isIpBlockError(lastErr)) {
          this.log("error", `疑似 IP 被封，停止本轮求解: ${lastErr}`);
          try {
            this.onIpBlock?.(lastErr);
          } catch {
            /* ignore */
          }
          return null;
        }
        this.log("warn", `求解失败（${attempt}/${this.cfg.solveRetries}）: ${lastErr}`);
        // 抖动退避：确定性延迟在跨境链路上会让每次重试落在同一故障点
        if (attempt < this.cfg.solveRetries) {
          await sleep(300 * attempt + Math.floor(Math.random() * 400));
        }
      }
    }
    this.log("error", `求解 ${this.cfg.solveRetries} 次全部失败: ${lastErr}`);
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

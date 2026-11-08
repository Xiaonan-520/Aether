/**
 * retry.ts —— 有界重试。
 *
 * 为什么单独抽出来：Aether 的 Provider 失败语义里已有 RATE_LIMIT /
 * AUTH_INVALID / NEEDS_CAPTCHA 等类型，captcha 获取失败必须映射成
 * 一个**明确的、有界的**失败，而不是无限重试或静默放过。
 *
 * zcode-api 的核心纪律（值得抄）：
 *   **拿不到 captcha 就诚实失败，绝不裸发请求。**
 * 因为裸发是"真实客户端永不产生的形态"，上游会以空体 502 之类的
 * 形式拒绝，而且这种拒绝比 503 更难诊断。
 */

export interface RetryOptions {
  /** 总预算（ms），默认 45s */
  budgetMs?: number;
  /** 最大尝试次数，默认 4 */
  maxAttempts?: number;
  /** 首次退避，之后指数增长 */
  baseDelayMs?: number;
  /** 抖动上限，避免重试对齐到同一故障点 */
  jitterMs?: number;
  /** 外部取消信号 */
  signal?: AbortSignal;
  onRetry?: (err: Error, attempt: number) => void;
}

export class RetryBudgetExhaustedError extends Error {
  constructor(
    message: string,
    readonly attempts: number,
    readonly lastError?: Error,
  ) {
    super(message);
    this.name = "RetryBudgetExhaustedError";
  }
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const budgetMs = opts.budgetMs ?? 45_000;
  const maxAttempts = opts.maxAttempts ?? 4;
  const baseDelayMs = opts.baseDelayMs ?? 400;
  const jitterMs = opts.jitterMs ?? 400;
  const started = Date.now();

  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (opts.signal?.aborted) {
      throw new RetryBudgetExhaustedError("已取消", attempt - 1, lastError);
    }
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const elapsed = Date.now() - started;
      if (attempt >= maxAttempts) break;
      const delay = baseDelayMs * 2 ** (attempt - 1) + Math.floor(Math.random() * jitterMs);
      if (elapsed + delay > budgetMs) {
        throw new RetryBudgetExhaustedError(
          `重试预算耗尽（已用 ${elapsed}ms / ${budgetMs}ms，尝试 ${attempt} 次）`,
          attempt,
          lastError,
        );
      }
      opts.onRetry?.(lastError, attempt);
      await sleep(delay);
    }
  }

  throw new RetryBudgetExhaustedError(
    `重试 ${maxAttempts} 次全部失败`,
    maxAttempts,
    lastError,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

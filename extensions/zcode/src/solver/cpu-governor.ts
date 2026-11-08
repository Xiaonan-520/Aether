/**
 * cpu-governor.ts —— CPU 天花板。
 *
 * 求解是 CPU 密集型（混淆的 450KB pe VM + 指纹采集），并发开大就会把
 * 整个 Extension 容器跑满，网关的其它请求跟着卡。
 *
 * 移植自 zcode-api 的 captcha-cpu-governor.ts，特别注意一个坑：
 * **不要用 os.loadavg()**。它在 Windows 上恒为 [0,0,0]（Node 文档明写），
 * governor 会永远认为"0% 忙"，并发无限爬升 —— zcode-api 上真实发生过
 * 一次事故：堆涨到 2.8GB，所有 HTTP 路由失去响应。
 *
 * 正确做法：Linux 读 /proc/stat；其它平台用 os.cpus() 的累计毫秒做差。
 */
import fs from "node:fs/promises";
import os from "node:os";

export interface GovernorSnapshot {
  cpuPercent: number;
  limitPercent: number;
  concurrency: number;
  throttled: boolean;
  source: "proc" | "os";
}

type CpuCounters = { idle: number; total: number; source: "proc" | "os" };

async function readProcStatCounters(): Promise<CpuCounters | null> {
  try {
    const stat = await fs.readFile("/proc/stat", "utf8");
    const line = stat.split("\n")[0] ?? "";
    const parts = line.split(/\s+/).slice(1).map((v) => Number(v) || 0);
    const idle = (parts[3] ?? 0) + (parts[4] ?? 0);
    const total = parts.reduce((s, n) => s + n, 0);
    if (total <= 0) return null;
    return { idle, total, source: "proc" };
  } catch {
    return null;
  }
}

/** 跨平台回退：os.cpus() 的累计毫秒做差（Windows 上也有效）。 */
function readOsCpusCounters(): CpuCounters {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    const t = c.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total, source: "os" };
}

export class CpuGovernor {
  private last: CpuCounters | null = null;
  private currentConcurrency: number;
  private lastPercent = 0;
  private lastThrottled = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private opts: {
      /** 上限百分比，100 = 全部 vCPU；0 = 关闭 */
      limitPercent: number;
      /** 回滞带：低于 limit - hysteresis 才回升，避免抖动 */
      hysteresisPercent: number;
      maxConcurrency: number;
      minConcurrency: number;
      intervalMs: number;
      onChange?: (concurrency: number) => void;
    },
  ) {
    this.currentConcurrency = opts.maxConcurrency;
  }

  start(): void {
    if (this.opts.limitPercent <= 0) return;
    this.timer = setInterval(() => void this.tick(), this.opts.intervalMs);
    if (this.timer && typeof (this.timer as { unref?: () => void }).unref === "function") {
      (this.timer as { unref(): void }).unref();
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  get concurrency(): number {
    return this.currentConcurrency;
  }

  snapshot(): GovernorSnapshot {
    return {
      cpuPercent: this.lastPercent,
      limitPercent: this.opts.limitPercent,
      concurrency: this.currentConcurrency,
      throttled: this.lastThrottled,
      source: this.last?.source ?? "os",
    };
  }

  async tick(): Promise<void> {
    const now = (await readProcStatCounters()) ?? readOsCpusCounters();
    if (!this.last) {
      this.last = now;
      return;
    }
    const dTotal = now.total - this.last.total;
    const dIdle = now.idle - this.last.idle;
    this.last = now;
    if (dTotal <= 0) return;

    const busyPercent = Math.round(((dTotal - dIdle) / dTotal) * 100);
    this.lastPercent = busyPercent;

    const { limitPercent, hysteresisPercent, maxConcurrency, minConcurrency } = this.opts;

    if (busyPercent > limitPercent) {
      this.lastThrottled = true;
      if (this.currentConcurrency > minConcurrency) {
        this.currentConcurrency -= 1;
        this.opts.onChange?.(this.currentConcurrency);
      }
    } else if (busyPercent < limitPercent - hysteresisPercent) {
      this.lastThrottled = false;
      if (this.currentConcurrency < maxConcurrency) {
        this.currentConcurrency += 1;
        this.opts.onChange?.(this.currentConcurrency);
      }
    } else {
      this.lastThrottled = false;
    }
  }
}

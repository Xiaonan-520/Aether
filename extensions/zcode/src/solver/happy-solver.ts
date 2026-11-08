/**
 * happy-solver.ts —— happy-dom 阿里云「无痕验证」求解器。
 *
 * 架构移植自 zcode-api（src/proxy/captcha-happy.ts），但做了针对性改造：
 *
 *   - 目标运行时是 **Node.js**（Aether Core 用 tsx / tsc），不是 Bun。
 *     这是本次移植最重要的运行时差异：
 *     zcode-api 用 `GlobalWindow` + 宿主 globalThis 别名层，是因为 Bun 下
 *     happy-dom 的 VM realm 隔离失效、脚本跑在宿主 realm，必须把 window
 *     属性挂到 globalThis 上裸标识符才能解析。Node 下 VM realm **是好的**
 *     —— 实测：`new Window(...)` + realm eval 里 window/document/裸 Event
 *     全部就位、script tag 正常执行、realm 内 patch isTrusted 生效。
 *     所以我们用普通 `Window`，彻底去掉别名层（实测 GlobalWindow 的
 *     window→globalThis getter 别名在 Node 下会与宿主 getter 互相递归
 *     → Maximum call stack size exceeded）。
 *     ⚠️ 后果一：guest 作用域不能挂宿主 globalThis（guest 看不见），
 *     改挂 window 自身。
 *     ⚠️ 后果二：`Event.isTrusted` 等 patch 必须在 realm 内 eval 才生效
 *     （GlobalWindow 下 w.eval 是宿主 eval，才显得"宿主侧 patch 就行"）。
 *
 *   - 不需要 `Atomics.wait` + 子 worker 的同步 XHR 兜底（那是为了绕开
 *     `bun build --compile` 单文件二进制里 spawn 失效）。Node 里 happy-dom
 *     原生同步 XHR 走 child_process 是正常的，我们在拦截器里直接给它缓存/直通。
 *
 *   - 去掉了所有 TUI / 单文件打包相关的耦合，只暴露 solve()。
 *
 * 保留的核心机制（一个都不能少，每个都有实弹原因，见各处注释）：
 *   1. 指纹固定化             → 避免 F001
 *   2. 网络层完全接管          → 注入 Client Hints / CORS / Cookie 回流
 *   3. toString() 原生化       → 过 FeiLin 的 [native code] 探测
 *   4. Event.isTrusted 恒真    → 最关键的一处伪造
 *   5. 巨型 polyfill           → 缺一个全局变量，风控探测链就断
 *   6. 行为模拟                ← 缓动鼠标轨迹，不是直线
 *   7. 严格结果校验            → 拒绝降级 param，宁可失败
 *   8. Window 复用 + 失败销毁  → CPU 减半，且不许毒害后续求解
 *   9. 停滞检测                → pe VM 卡死时提前 abort
 */
import { Window, PropertySymbol } from "happy-dom";
import { createRequire } from "node:module";

const nodeRequire = createRequire(import.meta.url);
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FINGERPRINT as fp } from "./fingerprint.js";

export interface SolveOptions {
  /** 阿里云 SceneId */
  scene: string;
  /** 区域，如 "sgp" */
  region: string;
  /** 前缀，如 "no8xfe" */
  prefix: string;
  /** 总超时，默认 30s */
  timeoutMs?: number;
  /** 停滞判定窗口，默认 12s */
  stallMs?: number;
  /** 是否复用 window，默认 true */
  reuseWindow?: boolean;
  /** 日志回调 */
  log?: (level: "info" | "warn" | "error", msg: string) => void;
}

const DEBUG = /^(1|true|yes)$/i.test(process.env.CAPTCHA_DEBUG ?? "");

const ALIYUN_CAPTCHA_JS =
  "https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js";
/** 需要打 XHR 超时补丁的脚本（SDK 主体 + 轮换的 pe VM 包）。 */
const CAPTCHA_SCRIPT_PATCH_RE = /aliyunCaptcha|dynamicJS\/.*\/pe\.\d+\./i;

const CDN_CACHE_DIR = path.join(os.homedir(), ".aether-captcha-cdn-cache");
/** pe 包会轮换，缓存必须限量，否则每次轮换都钉住几百 KB 到进程结束。 */
const MEM_CDN_CACHE_CAP = 16;
const _memCdnCache = new Map<string, Buffer>();

// ─────────────────────────────────────────────────────────────────────────────
// SDK 的 XHR 超时补丁
// ─────────────────────────────────────────────────────────────────────────────
/**
 * SDK 硬编码了 5s 的 XHR 超时（`arguments[4]?arguments[4]:5e3`）。
 * 移动网络/跨境链路下 verify POST 常超 5s → SDK 超时后**用同一个 certifyId 重发**
 * → 第一次已消费 → 每次都回 F008（duplicate verify）→ 所有重试全灭。
 * 放宽到 30s 让首次提交能完成。
 *
 * 实测：5.3s 的 verify 延迟，补丁前是 F008 级联，补丁后直接 T001。
 *
 * 注意这个模式在**两个 bundle** 里都有（AliyunCaptcha.js 和 pe 包），
 * verify POST 走的是 pe 那份，所以两处都要打。
 * Fail-open：模式不存在（SDK 升级了）就原样发出并记一次日志。
 */
const SDK_XHR_TIMEOUT_PATTERN = "arguments[4]?arguments[4]:5e3";
const SDK_XHR_TIMEOUT_REPLACEMENT = "arguments[4]?arguments[4]:30e3";

let _patchMissLogged = false;

export function patchSdkXhrTimeout(body: Uint8Array): Buffer {
  const src = Buffer.from(body).toString("utf8");
  if (!src.includes(SDK_XHR_TIMEOUT_PATTERN)) {
    if (!_patchMissLogged) {
      _patchMissLogged = true;
      logOnce(
        "warn",
        "[captcha] SDK_XHR_TIMEOUT_PATTERN 未命中 —— SDK 可能已升级，XHR 超时补丁失效（fail-open）",
      );
    }
    return Buffer.from(body);
  }
  return Buffer.from(src.split(SDK_XHR_TIMEOUT_PATTERN).join(SDK_XHR_TIMEOUT_REPLACEMENT), "utf8");
}

/**
 * pe 包还可能有别的定点 patch。这里保留一个统一的钩子，
 * 方便你在 SDK 轮换后加新规则而不用改主流程。
 */
export function patchPeBundle(body: Uint8Array, url: string): Buffer {
  let out = patchSdkXhrTimeout(body);
  // 预留：针对特定 pe 版本的定向修补
  void url;
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 日志（不依赖 Core 的 logger，避免循环依赖；由调用方注入）
// ─────────────────────────────────────────────────────────────────────────────
type LogFn = (level: "info" | "warn" | "error", msg: string) => void;
let _log: LogFn = (level, msg) => {
  if (level === "error" || DEBUG) process.stderr.write(`[captcha] ${msg}\n`);
};
export function setSolverLogger(fn: LogFn): void {
  _log = fn;
}
function logOnce(level: "info" | "warn" | "error", msg: string): void {
  try {
    _log(level, msg);
  } catch {
    /* 日志绝不影响求解 */
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CDN 缓存（磁盘 + 内存）
// ─────────────────────────────────────────────────────────────────────────────
function diskPathFor(url: string): string {
  return path.join(CDN_CACHE_DIR, crypto.createHash("sha1").update(url).digest("hex"));
}

function sniffMime(url: string): string {
  if (/\.js(\?|$)/i.test(url)) return "application/javascript; charset=utf-8";
  if (/\.css(\?|$)/i.test(url)) return "text/css; charset=utf-8";
  if (/\.json(\?|$)/i.test(url)) return "application/json; charset=utf-8";
  if (/\.png(\?|$)/i.test(url)) return "image/png";
  if (/\.svg(\?|$)/i.test(url)) return "image/svg+xml";
  return "application/octet-stream";
}

/** 写入缓存（同时打补丁）—— 所有缓存入口都走这里，保证补丁不会漏。 */
export function rememberCdnBody(url: string, body: Uint8Array): void {
  const patched = CAPTCHA_SCRIPT_PATCH_RE.test(url) ? patchPeBundle(Buffer.from(body), url) : Buffer.from(body);
  _memCdnCache.set(url, patched as Buffer);
  // FIFO 淘汰：Map 保插入序
  while (_memCdnCache.size > MEM_CDN_CACHE_CAP) {
    const oldest = _memCdnCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    _memCdnCache.delete(oldest);
  }
  try {
    fs.mkdirSync(CDN_CACHE_DIR, { recursive: true });
    fs.writeFileSync(diskPathFor(url), patched);
  } catch {
    /* 磁盘缓存是优化，不是必需 */
  }
}

function getCachedBody(url: string): Buffer | null {
  const mem = _memCdnCache.get(url);
  if (mem) return mem;
  try {
    const disk = fs.readFileSync(diskPathFor(url));
    if (disk.length > 0) {
      _memCdnCache.set(url, disk);
      return disk;
    }
  } catch {
    /* miss */
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 请求日志（停滞检测的依据）
// ─────────────────────────────────────────────────────────────────────────────
const REQUEST_LOG_CAP = 256;
interface ReqEntry {
  at: number;
  method: string;
  url: string;
  sync?: boolean;
}
const _requestLog: ReqEntry[] = [];
export function noteRequest(entry: ReqEntry): void {
  _requestLog.push(entry);
  if (_requestLog.length > REQUEST_LOG_CAP) _requestLog.splice(0, _requestLog.length - REQUEST_LOG_CAP);
}

/** 连续卡死的 pe 版本计数，用于下一次求解时绕过它的缓存。 */
const _stallCounts = new Map<string, number>();
let _bypassPeCacheOnce = false;

function noteStallAndMaybeEvict(peUrl: string): void {
  const n = (_stallCounts.get(peUrl) ?? 0) + 1;
  _stallCounts.set(peUrl, n);
  if (n >= 2) {
    _bypassPeCacheOnce = true;
    _stallCounts.delete(peUrl);
    logOnce("warn", `[captcha] pe 连续卡死 ${n} 次，下次求解绕过其缓存强制刷新: ${peUrl}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 网络拦截器：完全接管 happy-dom 的网络层
// ─────────────────────────────────────────────────────────────────────────────
/**
 * 这里做四件事，每一件都是为了让风控以为「这是浏览器发的请求」：
 *   1. 注入 Client Hints / UA / referer
 *   2. 按 CORS 语义补 origin（跨域 或 非幂等方法才带）
 *   3. 手动管理 Cookie（绕开 happy-dom 的 SameSite/domain 限制，让 set-cookie 能回流）
 *   4. CDN 缓存（但 pe 包绝不缓存）
 */
function injectRequestHeaders(request: {
  headers: { set(k: string, v: string): void };
  url: string;
  method?: string;
}): void {
  const h = request.headers;
  try {
    h.set("sec-ch-ua", fp.uaBrands);
    h.set("sec-ch-ua-mobile", "?0");
    h.set("sec-ch-ua-platform", '"Linux"');
    h.set("user-agent", fp.userAgent);
    h.set("accept-language", fp.languages);
    h.set("referer", "https://zcode.z.ai/");
    let origin: string | null = null;
    try {
      const u = new URL(request.url);
      const method = String(request.method || "GET").toUpperCase();
      const crossOrigin = u.origin !== "https://zcode.z.ai";
      if (crossOrigin || (method !== "GET" && method !== "HEAD")) {
        origin = "https://zcode.z.ai";
      }
    } catch {
      /* 相对 URL 忽略 */
    }
    if (origin) h.set("origin", origin);
  } catch {
    /* 拦截器永不抛 */
  }
}

/** 从 cookieContainer 取 cookie，拼成请求头。 */
function cookieHeader(
  request: { url: string; credentials?: string },
  ctx: CookieLike,
): string | null {
  try {
    if (request.credentials === "omit") return null;
    const u = new URL(request.url);
    const cookies = ctx.cookieContainer.getCookies(u, false) as Array<{ name: string; value: string }>;
    if (cookies.length > 0) return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  } catch {
    /* fall through */
  }
  return null;
}

interface CookieLike {
  cookieContainer: {
    getCookies(u: URL, isHttpOnly?: boolean): unknown;
    addCookies(list: unknown[]): void;
  };
}

/** 解析 Set-Cookie 并写回 cookieContainer。 */
function storeSetCookies(res: Response, url: string, ctx: CookieLike): void {
  try {
    const list = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
    for (const raw of list) {
      const u = new URL(url);
      const parts = raw.split(";");
      const head = parts[0] ?? "";
      const pair = head.split("=");
      const cookie: Record<string, unknown> = {
        name: (pair[0] ?? "").trim(),
        value: pair.slice(1).join("=").trim(),
        url: u.origin,
        domain: u.hostname,
        path: "/",
      };
      for (const p of parts.slice(1)) {
        const kv = p.trim().split(/=(.*)/s);
        const k = (kv[0] || "").toLowerCase();
        if (k === "domain" && kv[1]) cookie.domain = kv[1];
        if (k === "path" && kv[1]) cookie.path = kv[1];
        if (k === "expires" && kv[1]) cookie.expires = new Date(kv[1]).getTime();
        if (k === "max-age" && kv[1]) cookie.maxAge = parseInt(kv[1], 10);
        if (k === "httponly") cookie.httpOnly = true;
        if (k === "secure") cookie.secure = true;
        if (k === "samesite" && kv[1]) cookie.sameSite = kv[1];
      }
      try {
        ctx.cookieContainer.addCookies([cookie]);
      } catch {
        /* 单个 cookie 失败不影响整体 */
      }
    }
  } catch {
    /* 拦截器永不抛 */
  }
}

/**
 * 在飞请求计数 —— 停滞检测的关键输入。
 *
 * 为什么需要：跨境 verify/config POST 可能跑 5-10s，这期间**没有任何新请求发起**。
 * 如果停滞检测只看「最后请求时间」，会把一个健康但慢的请求误判为卡死，
 * 白白烧掉一次重试。所以有在飞请求时，停滞检测必须让路。
 */
let _asyncRequestsInFlight = 0;

type InterceptorCtx = {
  request: {
    url: string;
    method?: string;
    headers: { set(k: string, v: string): void; forEach(cb: (v: string, k: string) => void): void };
    body?: unknown;
    arrayBuffer?(): Promise<ArrayBuffer>;
    credentials?: string;
  };
  window: HappyWindow;
};

interface HappyWindow {
  Response: typeof Response;
  __lastPeUrl?: string;
  [key: string]: unknown;
}

function makeInterceptor(bypassPeCache: boolean, getCtx: () => CookieLike, win: () => HappyWindow) {
  const skipPeCache = (url: string): boolean => bypassPeCache && /dynamicJS\/.*\/pe\.\d+\./.test(url);
  return {
    async beforeAsyncRequest({ request }: InterceptorCtx): Promise<Response> {
      _asyncRequestsInFlight += 1;
      try {
        return await handleAsyncRequest(request, skipPeCache, getCtx, win);
      } finally {
        _asyncRequestsInFlight -= 1;
      }
    },
    beforeSyncRequest(opts: InterceptorCtx): Response {
      return handleSyncRequest(opts.request, skipPeCache, getCtx, win);
    },
  };
}

type ReqLike = InterceptorCtx["request"];

async function handleAsyncRequest(
  request: ReqLike,
  skipPeCache: (u: string) => boolean,
  getCtx: () => CookieLike,
  win: () => HappyWindow,
): Promise<Response> {
  const url = request.url;
  noteRequest({ at: Date.now(), method: request.method ?? "GET", url });
  injectRequestHeaders(request);

  // ── 静态资源：走缓存 ──
  if (/\balicdn\.com/i.test(url)) {
    let body = skipPeCache(url) ? null : getCachedBody(url);
    if (body && /\.js(\?|$)/i.test(url)) {
      // 缓存完整性自检：截断/损坏的 JS 直接丢弃重新拉。
      // （历史上有过 CDN 返回 truncated body 被写进缓存的案例）
      try {
        new Function(body.toString("utf8"));
      } catch (parseErr) {
        logOnce("warn", `[captcha] 缓存 JS 损坏，丢弃重取: ${url} ${(parseErr as Error).message}`);
        _memCdnCache.delete(url);
        try {
          fs.unlinkSync(diskPathFor(url));
        } catch {
          /* ignore */
        }
        body = null;
      }
    }
    if (body) {
      if (/dynamicJS\/[^/]*\/pe\.\d+\./.test(url)) {
        try {
          win().__lastPeUrl = url;
        } catch {
          /* ignore */
        }
      }
      return new (win().Response)(new Uint8Array(patchPeBundle(body, url)), {
        status: 200,
        statusText: "OK",
        headers: { "content-type": sniffMime(url) },
      }) as unknown as Response;
    }
  }

  // ── 直通：用宿主 fetch 发出去，再把结果包成 window.Response ──
  try {
    const init: RequestInit & { headers: Record<string, string> } = {
      method: request.method ?? "GET",
      headers: {},
    };
    request.headers.forEach((value, key) => {
      init.headers[key] = value;
    });
    const cookie = cookieHeader(request, getCtx());
    if (cookie) init.headers.cookie = cookie;
    try {
      if (request.body && typeof request.arrayBuffer === "function") {
        const ab = await request.arrayBuffer();
        if (ab && ab.byteLength > 0) init.body = ab;
      }
    } catch {
      /* GET 没有 body */
    }

    const res = await solveFetch(url, init);
    const abuf = await res.arrayBuffer();
    let buf: Buffer = Buffer.from(abuf);
    // pe 包只走这条直通路径，所以补丁必须在这里也打一次
    if (CAPTCHA_SCRIPT_PATCH_RE.test(url)) buf = patchPeBundle(buf, url);
    storeSetCookies(res, url, getCtx());

    // 首次拉取成功 → 写入缓存（rememberCdnBody 内部会再打一次补丁，幂等）
    if (/\balicdn\.com/i.test(url) && res.ok && buf.length > 0 && !skipPeCache(url)) {
      rememberCdnBody(url, buf);
    }

    const headers: Record<string, string> = {};
    const ct = res.headers.get("content-type");
    if (ct) headers["content-type"] = ct;
    if (DEBUG) logOnce("info", `[xhr] ${init.method} ${url} -> ${res.status} (${buf.length}b)`);
    return new (win().Response)(new Uint8Array(buf), {
      status: res.status,
      statusText: res.statusText || "",
      headers,
    }) as unknown as Response;
  } catch (err) {
    logOnce("warn", `[captcha] 直通失败 ${url}: ${(err as Error).message}`);
    return new (win().Response)("", {
      status: 503,
      statusText: "passthrough failed",
    }) as unknown as Response;
  }
}

/**
 * 同步 XHR。只从缓存服务；miss 就交给 happy-dom 的原生实现。
 * （Node 里原生同步 XHR 是可用的，不需要 zcode-api 那套 Atomics 兜底）
 */
function handleSyncRequest(
  request: ReqLike,
  skipPeCache: (u: string) => boolean,
  getCtx: () => CookieLike,
  win: () => HappyWindow,
): Response {
  const url = request.url;
  noteRequest({ at: Date.now(), method: request.method ?? "GET", url, sync: true });
  injectRequestHeaders(request);

  if (/\balicdn\.com/i.test(url)) {
    const body = skipPeCache(url) ? null : getCachedBody(url);
    if (body) {
      // ⚠️ 返回 SyncFetch 的**内部响应格式**（plain object）：
      // SyncFetch.send() 对 interceptor 返回值是直接透传的 —— 不经过
      // ResourceFetch 的 {content} 包装，也不经过 happy-dom Response 的
      // body 流转换。所以这里必须自己给出完整字段（实测缺 ok/headers
      // 会导致 script 加载静默失败）。
      const patched = new Uint8Array(patchPeBundle(body, url));
      return {
        status: 200,
        statusText: "OK",
        ok: true,
        url,
        redirected: false,
        headers: new (win().Headers as new (i: object) => unknown)( { "content-type": sniffMime(url) } ) as never,
        body: Buffer.from(patched),
      } as unknown as Response;
    }
  }

  // 同步直通：这里用同步 XHR 语义发出去（happy-dom 期望拿到 Response）
  try {
    const u = new URL(url);
    void u;
    // Node 没有同步 fetch；交给一个最小化的同步实现（见 sync-fetch.ts）
    const { blockingFetch } = requireSyncFetch();
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key] = value;
    });
    const cookie = cookieHeader(request, getCtx());
    if (cookie) headers.cookie = cookie;
    const out = blockingFetch(url, { method: request.method ?? "GET", headers });
    if ("error" in out) {
      return new (win().Response)("", { status: 503, statusText: out.error }) as unknown as Response;
    }
    storeSetCookies(
      new Response(null, { status: out.status, headers: out.headers as Record<string, string> }),
      url,
      getCtx(),
    );
    let buf = out.body;
    if (CAPTCHA_SCRIPT_PATCH_RE.test(url)) buf = patchPeBundle(buf, url);
    return new (win().Response)(new Uint8Array(buf), {
      status: out.status,
      statusText: out.statusText,
      headers: out.headers,
    }) as unknown as Response;
  } catch (err) {
    return new (win().Response)("", {
      status: 503,
      statusText: `sync failed: ${(err as Error).message}`,
    }) as unknown as Response;
  }
}

// 懒加载，避免主路径引入 child_process
let _syncFetchModule: { blockingFetch: BlockingFetchFn } | null = null;
type BlockingFetchFn = (url: string, init: { method: string; headers: Record<string, string> }) =>
  | { status: number; statusText: string; headers: Record<string, string>; body: Buffer }
  | { error: string };
function requireSyncFetch(): { blockingFetch: BlockingFetchFn } {
  if (!_syncFetchModule) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    _syncFetchModule = nodeRequire("./sync-fetch.js") as { blockingFetch: BlockingFetchFn };
  }
  return _syncFetchModule;
}

/** 带 Happy Eyeballs 的 fetch（IPv6 黑洞防护）。 */
async function solveFetch(url: string, init: RequestInit & { headers: Record<string, string> }): Promise<Response> {
  const timeoutMs = Number(process.env.CAPTCHA_SOLVE_FETCH_TIMEOUT_MS || 15_000);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ac.signal } as RequestInit);
  } finally {
    clearTimeout(timer);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Guest 作用域：让 guest 脚本的裸 setTimeout 落到 window 的计时器注册表
// ─────────────────────────────────────────────────────────────────────────────
/**
 * 为什么必须做：pe/FeiLin 是混淆的字节码 VM，内部大量用裸 `setTimeout`。
 * 在 happy-dom 的 VM realm 里这些标识符能正常解析到 window；但如果脚本
 * 通过间接 eval 跑在宿主 realm（或我们用 `with` 包裹后被展平），裸标识符
 * 就会落到**宿主**的 globalThis 上 —— 后果是 guest 的心跳定时器**脱离
 * window 生命周期**，window 关了它还在跑，进程退不出去。
 *
 * 两个设计约束（都是实测踩出来的）：
 *   1. 必须用 `with`，不能用 IIFE 包裹 —— 因为 guest 的顶层 `var` / `function`
 *      声明必须继续逃逸到全局对象上，否则 `initAliyunCaptcha` 永远不会出现，
 *      每次求解都会超时（实测 ok=0 fail=3）。
 *   2. 同时要保证表达式结果能透出去 —— happy-dom 的 JavaScriptCompiler 会把
 *      源码包成 `(function anonymous($happy_dom){...})` 并调用返回值，
 *      `eval` 的 completion value 必须能穿过 `with` 返回。
 *
 * console 也要一起接管：FeiLin 会每秒往所有 console 方法打印不可见的
 * `%c%d` 格式串来探测 devtools。不接管就会污染宿主日志。
 */
const GUEST_TIMER_PROPS = ["setTimeout", "setInterval", "clearTimeout", "clearInterval"] as const;
const GUEST_SCOPE_ROOT = "__aetherGuestScopes";
let _guestScopeSeq = 0;

type ScopeRoot = Record<string, Record<string, unknown>>;

function installGuestScope(w: Record<string, unknown>): string {
  // ⚠️ 挂在 window 自身，不是宿主 globalThis —— Node 下 guest 跑在 VM realm，
  // 裸标识符在 realm 解析，宿主 globalThis 不可达（zcode-api 挂宿主是因为
  // Bun 下两者是同一个对象）。
  const root = ((w[GUEST_SCOPE_ROOT] ??= Object.create(null)) as ScopeRoot);
  const id = `w${++_guestScopeSeq}`;
  const scope: Record<string, unknown> = Object.create(null);
  for (const name of GUEST_TIMER_PROPS) {
    const fn = w[name];
    scope[name] = typeof fn === "function" ? (fn as () => void).bind(w) : fn;
  }
  scope.Function = makeScopedFunction(w);
  if (!DEBUG && w.console) scope.console = w.console;
  root[id] = scope;
  w.__capScopeId = id;
  return id;
}

function removeGuestScope(w: Record<string, unknown>): void {
  try {
    const id = w.__capScopeId as string | undefined;
    const root = w[GUEST_SCOPE_ROOT] as ScopeRoot | undefined;
    if (id && root) delete root[id];
  } catch {
    /* ignore */
  }
}

/**
 * guest 侧的 `Function` 替身。
 *
 * `new Function(body)` 在**全局作用域**编译，生成的函数会重新看到宿主计时器，
 * 把上面的逃生口又打开一次（实测：它的心跳在 window 关闭后继续存活）。
 * 所以这里把生成体再包一次同样的 `with` 作用域，让 pe VM 运行时动态生成的
 * 代码也继承 window 的计时器。
 *
 * `eval` 不需要替身 —— 它本来就继承调用者的作用域链。
 */
function makeScopedFunction(w: Record<string, unknown>): unknown {
  const Scoped = function (...args: string[]) {
    const body = args.length ? String(args[args.length - 1]) : "";
    const params = args
      .slice(0, -1)
      .map(String)
      .join(",");
    const id = w.__capScopeId as string;
    const source = `return function(${params}){with(window.${GUEST_SCOPE_ROOT}[${JSON.stringify(id)}]){\n${body}\n}}`;
    return Function(source)();
  };
  Scoped.prototype = Function.prototype;
  try {
    Object.defineProperty(Scoped, "name", { value: "Function", configurable: true });
    Object.defineProperty(Scoped, "toString", {
      value: () => "function Function() { [native code] }",
      configurable: true,
      writable: true,
    });
  } catch {
    /* ignore */
  }
  return Scoped;
}

function wrapGuestSource(code: string, filename: string | undefined, scopeId: string): string {
  const sourceUrl = filename && /^https?:/.test(String(filename)) ? `\n//# sourceURL=${filename}` : "";
  const scopeRef = `window.${GUEST_SCOPE_ROOT}[${JSON.stringify(scopeId)}]`;
  // 前置换行保持 guest 行号与 CDN 原文一致；后置换行防源码以行注释结尾
  return `with(${scopeRef}){\n${code}\n}${sourceUrl}`;
}

/**
 * 包住 happy-dom 的 eval 漏斗。
 * 这是**唯一的**脚本入口（script 标签 / 编译模块 / 动态 pe 分块都从这里过），
 * 所以在这里包一次就全覆盖了。
 */
function installEvalInstrumentation(w: Record<string, unknown>): void {
  const sym = PropertySymbol && (PropertySymbol as Record<string, unknown>).evaluateScript;
  if (!sym || typeof (w as Record<symbol, unknown>)[sym as symbol] !== "function") {
    logOnce("warn", "[captcha] 未找到 evaluateScript 符号 —— happy-dom 版本可能不兼容，跳过作用域注入");
    return;
  }
  const key = sym as symbol;
  const orig = (w as Record<symbol, unknown>)[key] as (code: string, options?: unknown) => unknown;
  (w as Record<symbol, unknown>)[key] = function (this: unknown, code: unknown, options: unknown) {
    const scopeId = w.__capScopeId as string | undefined;
    try {
      if (scopeId) {
        try {
          return orig.call(
            this,
            wrapGuestSource(
              String(code ?? ""),
              (options as { filename?: string } | undefined)?.filename,
              scopeId,
            ),
            options,
          );
        } catch (scopeErr) {
          // 只有"包裹导出的解析失败"才回退（例如源码顶层有 "use strict"，`with` 非法）。
          // guest 自身的语法错误必须原样抛给下面诊断。
          if (!(scopeErr instanceof SyntaxError)) throw scopeErr;
          logOnce("warn", `[captcha] guest scope 被拒（${(scopeErr as Error).message.slice(0, 80)}），改为不包裹求值`);
        }
      }
      return orig.call(this, String(code ?? ""), options);
    } catch (err) {
      // 解析失败诊断：SDK 轮换后最常见的症状就是这里报 SyntaxError
      try {
        const src = String(code ?? "");
        const filename = String((options as { filename?: string } | undefined)?.filename ?? "?");
        const sha1 = crypto.createHash("sha1").update(src).digest("hex");
        logOnce(
          "error",
          `[captcha] EVAL-PARSE-FAIL file=${filename} len=${src.length} sha1=${sha1} err=${(err as Error).message}`,
        );
        // 缓存可能截断/过期 —— 删掉，下次强制回源
        if (/^https?:/.test(filename)) {
          try {
            fs.unlinkSync(diskPathFor(filename));
          } catch {
            /* ignore */
          }
          _memCdnCache.delete(filename);
        }
      } catch {
        /* ignore */
      }
      throw err;
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 把 JS 实现的平台 API 伪装成原生（FeiLin 的 toString 扫描）
// ─────────────────────────────────────────────────────────────────────────────
/**
 * 风控最经典的一招：`Function.prototype.toString.call(fn)` 看是不是 `[native code]`。
 * 我们的 polyfill 全是 JS 函数，不伪装就是明牌。
 *
 * 遍历深度 5，覆盖 12 个原型对象。三个必须注意的坑：
 *   1. 跳过宿主对象（Socket/Timeout/Process…），碰到原生内部槽会直接崩
 *   2. getter 探测可能返回已 reject 的 Promise（stream.closed 等），
 *      不接住就是每次求解一堆 unhandledRejection，淹没真实告警
 *   3. 已原生的函数不要重复包装（有些环境的 toString 本身就很怪）
 */
function installNativeToString(w: Record<string, unknown>): void {
  const realToString = Function.prototype.toString;
  const nativeRe = /\[native code\]/;

  const mask = (fn: unknown): void => {
    if (typeof fn !== "function") return;
    try {
      if (nativeRe.test(realToString.call(fn))) return;
      const f = fn as { name?: string; toString?: () => string };
      const name = f.name || "";
      const nativeStr = `function ${name}() { [native code] }`;
      Object.defineProperty(fn, "toString", {
        value: () => nativeStr,
        configurable: true,
        writable: true,
      });
    } catch {
      /* 只读属性跳过 */
    }
  };

  const seen = new Set<unknown>();
  const maskObj = (obj: unknown, depth: number): void => {
    if (!obj || (typeof obj !== "object" && typeof obj !== "function") || depth > 5) return;
    try {
      const ctor = (obj as { constructor?: { name?: string } }).constructor;
      if (ctor && ctor.name && /^(WriteStream|ReadStream|Socket|Process|Timeout|Immediate)$/.test(ctor.name)) {
        return;
      }
    } catch {
      /* ignore */
    }
    if (seen.has(obj)) return;
    seen.add(obj);

    let names: string[];
    try {
      names = Object.getOwnPropertyNames(obj);
    } catch {
      return;
    }
    for (const name of names) {
      if (name === "toString" || name === "constructor") continue;
      let desc: PropertyDescriptor | undefined;
      try {
        desc = Object.getOwnPropertyDescriptor(obj, name);
      } catch {
        continue;
      }
      if (!desc) continue;
      if (typeof desc.value === "function") {
        mask(desc.value);
      } else if (typeof desc.get === "function") {
        mask(desc.get);
        try {
          const v = (desc.get as () => unknown).call(obj);
          if (typeof v === "function") mask(v);
          else if (v && typeof (v as PromiseLike<unknown>).then === "function") {
            (v as Promise<unknown>).catch(() => {});
          }
        } catch {
          /* ignore */
        }
      }
      if (depth < 3) {
        try {
          const v = desc.value;
          if (v && (typeof v === "function" || typeof v === "object")) maskObj(v, depth + 1);
        } catch {
          /* ignore */
        }
      }
    }
  };

  const ww = w as Record<string, { prototype?: object } | undefined>;
  const targets = [
    w,
    w.navigator,
    w.document,
    ww.Document?.prototype,
    ww.Element?.prototype,
    ww.HTMLElement?.prototype,
    ww.Node?.prototype,
    ww.EventTarget?.prototype,
    ww.HTMLCanvasElement?.prototype,
    ww.XMLHttpRequest?.prototype,
    ww.Event?.prototype,
    ww.Window?.prototype,
  ].filter(Boolean);
  for (const t of targets) {
    try {
      maskObj(t, 0);
    } catch {
      /* ignore */
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Guest 侧补丁（在 VM realm 内 eval）
// ─────────────────────────────────────────────────────────────────────────────
/**
 * 最关键的一处伪造：`Event.isTrusted` 恒为 true。
 *
 * 真浏览器里，"用户真实操作"产生的事件 isTrusted=true，"脚本 dispatchEvent"
 * 产生的 isTrusted=false。我们全是脚本派发的，不伪造等于每一次交互都在
 * 主动告诉风控"这是自动化"。
 *
 * ⚠️ 必须通过 w.eval 在 **VM realm 内**执行：
 * - realm 内裸 `Event` = happy-dom 的 Event（与 window.Event 相同）
 * - 宿主侧直接 patch w.Event.prototype 也有效，但 GUEST_EVAL_PATCH 里
 *   的错误捕获 hook 需要 realm 内的 window —— 统一走 realm。
 * - 实测（happy-dom v20 / Node 20）：realm 内 patch 后 new Event().isTrusted
 *   为 true，script tag 内同样生效。
 */
export const GUEST_EVAL_PATCH = `
(function() {
  try {
    Object.defineProperty(Event.prototype, "isTrusted", {
      get() { return true; },
      configurable: true
    });
  } catch (e) {}
  try {
    if (window.HTMLDocument) {
      Object.defineProperty(window.HTMLDocument, "name", { value: "HTMLDocument", configurable: true });
      Object.defineProperty(window.HTMLDocument.prototype, Symbol.toStringTag, { value: "HTMLDocument", configurable: true });
    }
  } catch (e) {}
  try {
    Object.defineProperty(window.Document.prototype, Symbol.toStringTag, { value: "HTMLDocument", configurable: true });
  } catch (e) {}
  // guest 错误只记录不打印：SDK 每次求解都会在 happy-dom 上抛一些
  // "良性" TypeError（DOM 模拟不完美），求解照样成功，打印就是刷屏噪音。
  // 只在求解失败时才把这里的内容带进错误信息。
  try {
    window.__capErrs = window.__capErrs || [];
    window.addEventListener("error", function(ev) {
      try {
        var e = ev && ev.error;
        var msg = (e && e.message) || (ev && ev.message) || "unknown";
        var kind = (e && e.name) || "Error";
        var arr = window.__capErrs;
        for (var i = 0; i < arr.length; i++) {
          if (arr[i].k === kind && arr[i].m === msg) { arr[i].n = (arr[i].n || 1) + 1; return; }
        }
        if (arr.length < 8) arr.push({ k: kind, m: msg, n: 1 });
      } catch (_) {}
    });
  } catch (e) {}
})();
`;

// ─────────────────────────────────────────────────────────────────────────────
// Polyfill 表
// ─────────────────────────────────────────────────────────────────────────────
/**
 * happy-dom 缺什么补什么。理由不是"完善兼容性"，而是：
 * **缺一个全局变量，风控的探测链里就会抛 ReferenceError，整个采集流程断掉。**
 * 探测链一断，SDK 走降级路径，返回没有 securityToken 的垃圾 param。
 *
 * 注意所有 stub 的返回值也是**固定**的（confirm 恒 false、prompt 恒 null），
 * 同样服务于"指纹稳定"原则。
 */
export function applyPolyfills(w: Record<string, unknown>): void {
  const doc = w.document as {
    createElement(tag: string): Record<string, unknown>;
  };

  // 构造器快捷方式
  if (typeof w.Option !== "function") {
    const HTMLOptionElement = w.HTMLOptionElement as (new () => object) | undefined;
    if (HTMLOptionElement) {
      w.Option = class Option extends (HTMLOptionElement as new () => object) {
        constructor(text?: string, value?: string, defaultSelected?: boolean, selected?: boolean) {
          super();
          if (text !== undefined) {
            const el = doc.createElement("option");
            el.text = text;
            if (value !== undefined) el.value = value;
            if (defaultSelected) el.defaultSelected = true;
            if (selected) el.selected = true;
            return el;
          }
        }
      };
    }
  }
  if (typeof w.Video !== "function" && w.HTMLVideoElement) {
    const HTMLVideoElement = w.HTMLVideoElement as new () => object;
    w.Video = class Video extends HTMLVideoElement {
      constructor() {
        super();
        return doc.createElement("video");
      }
    };
  }

  // 对话框：happy-dom 的 close() 是**破坏性的**（会拆掉整个 window），必须中和
  const stubs: Record<string, () => unknown> = {
    alert: () => undefined,
    prompt: () => null,
    confirm: () => false,
    open: () => null,
    close: () => undefined,
    print: () => undefined,
    stop: () => undefined,
    moveTo: () => undefined,
    moveBy: () => undefined,
    showModalDialog: () => null,
    find: () => false,
  };
  for (const [k, v] of Object.entries(stubs)) {
    try {
      Object.defineProperty(w, k, { value: v, configurable: true, writable: true });
    } catch {
      /* ignore */
    }
  }

  // 能力 API stub
  if (!w.EventSource) {
    w.EventSource = class EventSource {
      readyState = 2;
      onopen: unknown = null;
      onmessage: unknown = null;
      onerror: unknown = null;
      close(): void {
        this.readyState = 2;
      }
      addEventListener(): void {}
      removeEventListener(): void {}
    };
  }
  if (!w.Beacon) w.Beacon = class Beacon {};
  if (!w.RTCPeerConnection) {
    w.RTCPeerConnection = class RTCPeerConnection {
      createDataChannel(): object {
        return {};
      }
      close(): void {}
      createOffer(): Promise<object> {
        return Promise.resolve({});
      }
      setLocalDescription(): Promise<void> {
        return Promise.resolve();
      }
      addEventListener(): void {}
      removeEventListener(): void {}
    };
  }
  if (!w.MessageChannel) {
    w.MessageChannel = class MessageChannel {
      port1 = makePort();
      port2 = makePort();
    };
  }
  if (!w.IntersectionObserver) {
    w.IntersectionObserver = class IntersectionObserver {
      constructor(cb?: unknown) {
        this.cb = cb;
      }
      cb?: unknown;
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
      takeRecords(): unknown[] {
        return [];
      }
    };
  }
  if (!w.ResizeObserver) {
    w.ResizeObserver = class ResizeObserver {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
  }
  if (!w.MutationObserver) {
    w.MutationObserver = class MutationObserver {
      observe(): void {}
      disconnect(): void {}
      takeRecords(): unknown[] {
        return [];
      }
    };
  }
  if (!w.PerformanceObserver) {
    w.PerformanceObserver = class PerformanceObserver {
      observe(): void {}
      disconnect(): void {}
      takeRecords(): unknown[] {
        return [];
      }
    };
  }

  // navigator 子对象：风控会挨个探测
  installNavigatorPlugins(w);
  // WebGL / Canvas 指纹
  installWebglFingerprint(w);
  installCanvasFingerprint(w);
}

function makePort(): Record<string, unknown> {
  return {
    onmessage: null,
    postMessage(): void {},
    start(): void {},
    close(): void {},
    addEventListener(): void {},
    removeEventListener(): void {},
  };
}

/**
 * navigator.plugins / mimeTypes / connection 等。
 * 真浏览器里 plugins 有 5 个固定条目，空数组是很强的"自动化"信号。
 */
function installNavigatorPlugins(w: Record<string, unknown>): void {
  const nav = w.navigator as Record<string, unknown> | undefined;
  if (!nav) return;

  const pluginNames = [
    "PDF Viewer",
    "Chrome PDF Viewer",
    "Chromium PDF Viewer",
    "Microsoft Edge PDF Viewer",
    "WebKit built-in PDF",
  ];

  const makePlugin = (name: string): Record<string, unknown> => ({
    name,
    filename: "internal-pdf-viewer",
    description: "Portable Document Format",
    length: 1,
  });

  const plugins = pluginNames.map(makePlugin);
  Object.defineProperty(plugins, "item", { value: (i: number) => plugins[i] ?? null });
  Object.defineProperty(plugins, "namedItem", {
    value: (n: string) => plugins.find((p) => p.name === n) ?? null,
  });
  Object.defineProperty(plugins, "refresh", { value: () => undefined });

  try {
    Object.defineProperty(nav, "plugins", { value: plugins, configurable: true });
    Object.defineProperty(nav, "mimeTypes", {
      value: Object.assign(
        [{ type: "application/pdf", suffixes: "pdf", description: "Portable Document Format" }],
        { item: (i: number) => null, namedItem: (n: string) => null },
      ),
      configurable: true,
    });
  } catch {
    /* ignore */
  }

  const setNav = (k: string, v: unknown): void => {
    try {
      Object.defineProperty(nav, k, { value: v, configurable: true });
    } catch {
      /* ignore */
    }
  };
  // 固定值 —— 真实机器上也基本是这个数
  setNav("hardwareConcurrency", 8);
  setNav("deviceMemory", 8);
  setNav("platform", "Linux x86_64");
  setNav("language", "en-US");
  setNav("languages", ["en-US", "en"]);
  setNav("webdriver", false);
  setNav("doNotTrack", null);
  setNav("maxTouchPoints", 0);
  setNav("vendor", "Google Inc.");
  setNav("productSub", "20030107");
  setNav("connection", {
    effectiveType: "4g",
    rtt: 50,
    downlink: 10,
    saveData: false,
    onchange: null,
    addEventListener(): void {},
    removeEventListener(): void {},
  });
  setNav("permissions", {
    query: () => Promise.resolve({ state: "granted", onchange: null }),
  });

  // getBattery：无头环境常直接抛，必须返回 resolved promise
  if (typeof nav.getBattery !== "function") {
    setNav("getBattery", () =>
      Promise.resolve({
        charging: true,
        chargingTime: 0,
        dischargingTime: Infinity,
        level: 1,
        onchargingchange: null,
        addEventListener(): void {},
        removeEventListener(): void {},
      }),
    );
  }
}

/** WebGL 指纹：固定 vendor/renderer，与 SwiftShader 身份自洽。 */
function installWebglFingerprint(w: Record<string, unknown>): void {
  const proto = (w.WebGLRenderingContext as { prototype?: Record<string, unknown> } | undefined)?.prototype;
  if (!proto) return;
  const origGetParameter = proto.getParameter as ((p: number) => unknown) | undefined;
  if (typeof origGetParameter !== "function") return;
  proto.getParameter = function (this: unknown, p: number): unknown {
    // 0x1F00 UNMASKED_VENDOR_WEBGL / 0x1F01 UNMASKED_RENDERER_WEBGL / 0x9245 / 0x9246
    if (p === 0x1f00 || p === 0x9245) return fp.webglVendor;
    if (p === 0x1f01 || p === 0x9246) return fp.webglRenderer;
    try {
      return origGetParameter.call(this, p);
    } catch {
      return null;
    }
  };
  try {
    Object.defineProperty(proto.getParameter, "name", { value: "getParameter" });
    Object.defineProperty(proto.getParameter, "toString", {
      value: () => "function getParameter() { [native code] }",
    });
  } catch {
    /* ignore */
  }
}

/** Canvas 指纹：toDataURL 恒返回固定图，保证跨请求一致。 */
function installCanvasFingerprint(w: Record<string, unknown>): void {
  const proto = (w.HTMLCanvasElement as { prototype?: Record<string, unknown> } | undefined)?.prototype;
  if (!proto) return;
  const fake = () => fp.canvasImage;
  try {
    Object.defineProperty(proto, "toDataURL", {
      value: function toDataURL() {
        return fake();
      },
      configurable: true,
      writable: true,
    });
    Object.defineProperty(proto.toDataURL as () => string, "toString", {
      value: () => "function toDataURL() { [native code] }",
    });
  } catch {
    /* ignore */
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 人机行为模拟
// ─────────────────────────────────────────────────────────────────────────────
/**
 * 600ms 内派发 22 步鼠标轨迹，起点 (140±30,110±20) → 终点 (540±40,380±30)。
 *
 * 关键在**轨迹形状**：用 lerp 缓动 0.16 + 抖动，而不是匀速直线或纯随机。
 * 风控会看速度分布，匀速直线是最典型的机器人特征；纯随机则没有
 * "先快后慢接近目标"的人类减速特征。
 */
export function simulateBehavior(w: Record<string, unknown>, durationMs = 600): void {
  const doc = w.document as {
    dispatchEvent(e: unknown): boolean;
    body?: { dispatchEvent(e: unknown): boolean };
  };
  const MouseEventCtor = w.MouseEvent as (new (t: string, o: object) => object) | undefined;
  const KeyboardEventCtor = w.KeyboardEvent as (new (t: string, o: object) => object) | undefined;
  const UIEventCtor = w.UIEvent as (new (t: string, o: object) => object) | undefined;
  if (!doc || !MouseEventCtor) return;

  const fire = (type: string, ctor?: new (t: string, o: object) => object, opts?: object): void => {
    try {
      const Ctor = ctor ?? UIEventCtor;
      if (!Ctor) return;
      const ev = new Ctor(type, { bubbles: true, cancelable: true, view: w, ...opts });
      doc.dispatchEvent(ev);
      if (doc.body) doc.body.dispatchEvent(ev);
    } catch {
      /* ignore */
    }
  };

  let x = 140 + Math.random() * 30;
  let y = 110 + Math.random() * 20;
  const targetX = 540 + Math.random() * 40;
  const targetY = 380 + Math.random() * 30;
  const steps = 22;
  let i = 0;
  const start = Date.now();

  const moveStep = (): void => {
    if (i > steps) return;
    x += (targetX - x) * 0.16 + (Math.random() - 0.5) * 5;
    y += (targetY - y) * 0.16 + (Math.random() - 0.5) * 4;
    fire("mousemove", MouseEventCtor, {
      screenX: Math.round(x),
      screenY: Math.round(y),
      clientX: Math.round(x),
      clientY: Math.round(y),
      button: 0,
      buttons: 1,
    });
    i += 1;
    const done = Date.now() - start >= durationMs;
    if (i <= steps && !done) {
      // 用 window 注册表的计时器：这条轨迹只属于这个 window，必须随它一起死
      const setT = w.setTimeout as ((fn: () => void, ms: number) => void) | undefined;
      if (setT) setT.call(w, moveStep, 26 + Math.floor(Math.random() * 32));
    } else {
      fire("mousedown", MouseEventCtor, {
        clientX: Math.round(x),
        clientY: Math.round(y),
        button: 0,
        buttons: 1,
      });
      fire("mouseup", MouseEventCtor, {
        clientX: Math.round(x),
        clientY: Math.round(y),
        button: 0,
        buttons: 0,
      });
      fire("click", MouseEventCtor, { clientX: Math.round(x), clientY: Math.round(y), button: 0 });
      if (KeyboardEventCtor) {
        fire("keyup", KeyboardEventCtor, { key: "a", code: "KeyA", keyCode: 65, which: 65 });
      }
    }
  };
  moveStep();
}

function waitFor(cond: () => boolean, timeoutMs = 15_000, intervalMs = 40): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      let ok = false;
      try {
        ok = cond();
      } catch {
        /* 条件抛错视为未满足 */
      }
      if (ok) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error("waitFor timeout"));
      }
    }, intervalMs);
    // 注意：这里**不能** unref。waitFor 是有界的（最长 timeoutMs 必然
    // resolve/reject），但它等待的条件依赖 guest 脚本的异步加载 —— 若
    // unref 且没有其它句柄撑住事件循环（如全部 mock 的测试环境），
    // 循环排空、进程直接退出（exit code 13），表现为"求解静默消失"。
    // 后台循环（池/governor）才应该 unref，见 token-pool.ts。
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// DOM 构造
// ─────────────────────────────────────────────────────────────────────────────
const SOLVE_HTML = `<!DOCTYPE html><html><head></head><body>
<div id="cap"></div><button id="btn"></button>
<script src="${ALIYUN_CAPTCHA_JS}"></script>
</body></html>`;

interface CookieCacheEntry {
  cookies: string[];
  ts: number;
}
let _cookieCache: CookieCacheEntry = { cookies: [], ts: 0 };
const COOKIE_CACHE_TTL_MS = 5 * 60 * 1000;

type HappyDomWindow = Record<string, unknown> & {
  document: {
    write(h: string): void;
    dispatchEvent(e: unknown): boolean;
    body?: { dispatchEvent(e: unknown): boolean };
  };
  eval(code: string): unknown;
  Response: typeof Response;
  console?: unknown;
  navigator: Record<string, unknown>;
};

export interface DomHandle {
  window: HappyDomWindow;
  ctx: CookieLike;
}


/**
 * 预热 SDK 脚本 —— 必须在 document.write 之前完成。
 *
 * 为什么必须：happy-dom 加载 <script src> 走的是 **SyncFetch**（同步路径），
 * 它不经过全局 fetch、也不经过我们的异步拦截器 —— 直接发真实同步 HTTP。
 * 在容器/代理环境里这条路径经常不可用，而失败是静默的（script error 事件
 * 只进 page console，不进宿主 stderr），表现为"initAliyunCaptcha 永远不出现"。
 *
 * 解法（与 zcode-api 相同）：先用异步 solveFetch 把 SDK 拉下来写进 CDN 缓存，
 * 同步路径 handleSyncRequest 永远命中缓存，绝不下真网络。
 */
async function prewarmCaptchaScript(): Promise<void> {
  if (getCachedBody(ALIYUN_CAPTCHA_JS)) return;
  try {
    const res = await solveFetch(ALIYUN_CAPTCHA_JS, {
      headers: { "user-agent": fp.userAgent, referer: "https://zcode.z.ai/" },
    });
    if (!res.ok) {
      logOnce("warn", `[captcha] SDK 预热失败 http=${res.status}`);
      return;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 0) rememberCdnBody(ALIYUN_CAPTCHA_JS, buf);
  } catch (err) {
    // 预热失败不致命：sync 路径 cache miss 时会自己再试（可能失败，
    // 但那时 error 事件至少能通过 waitFor 超时暴露出来）
    logOnce("warn", `[captcha] SDK 预热异常: ${(err as Error).message}`);
  }
}

async function createDom(region: string, prefix: string): Promise<DomHandle> {
  // 0. 预热 SDK —— 必须最先做（cookie 预热也依赖网络，顺序无所谓）
  await prewarmCaptchaScript();
  // 1. Cookie 预热（5 分钟缓存）：先访问一次目标站点，拿到初始 cookie，
  //    否则 SDK 里某些请求会因为缺 cookie 而走异常分支
  let cookies: string[] = [];
  if (_cookieCache.ts > 0 && Date.now() - _cookieCache.ts < COOKIE_CACHE_TTL_MS) {
    cookies = _cookieCache.cookies;
  } else {
    try {
      const res = await solveFetch("https://zcode.z.ai/", {
        headers: {
          "User-Agent": fp.userAgent,
          "sec-ch-ua": fp.uaBrands,
          "sec-ch-ua-mobile": "?0",
          "sec-ch-ua-platform": '"Linux"',
          "Accept-Language": fp.languages,
        },
      });
      cookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
      _cookieCache = { cookies, ts: Date.now() };
    } catch {
      /* 预热失败不致命 */
    }
  }

  // 2. 建 window。console 在非 debug 下静音 —— SDK 会疯狂打印
  const noop = (): void => {};
  const guestConsole = DEBUG
    ? {
        log: (...a: unknown[]) => process.stderr.write(`[guest-log] ${fmtArgs(a)}\n`),
        warn: (...a: unknown[]) => process.stderr.write(`[guest-warn] ${fmtArgs(a)}\n`),
        error: (...a: unknown[]) => process.stderr.write(`[guest-err] ${fmtArgs(a)}\n`),
        info: (...a: unknown[]) => process.stderr.write(`[guest-info] ${fmtArgs(a)}\n`),
        debug: (...a: unknown[]) => process.stderr.write(`[guest-debug] ${fmtArgs(a)}\n`),
        trace: (...a: unknown[]) => process.stderr.write(`[guest-trace] ${fmtArgs(a)}\n`),
      }
    : { log: noop, warn: noop, error: noop, info: noop, debug: noop, trace: noop };

  const bypass = _bypassPeCacheOnce;
  _bypassPeCacheOnce = false;

  let holder: HappyDomWindow | null = null;
  const interceptor = makeInterceptor(
    bypass,
    () => ctxRef!,
    () => holder!,
  );

  const w = new (Window as unknown as new (o: object) => HappyDomWindow)({
    url: "https://zcode.z.ai/",
    console: guestConsole,
    settings: {
      enableJavaScriptEvaluation: true,
      enableImageFileLoading: true,
      suppressInsecureJavaScriptEnvironmentWarning: true,
      navigator: { userAgent: fp.userAgent },
      viewport: { width: fp.screen.w, height: fp.screen.h, devicePixelRatio: 1 },
      fetch: { disableSameOriginPolicy: true, interceptor },
    },
  });
  holder = w;

  // 3. 拿 cookieContainer（happy-dom 的 cookie 容器在这里面）
  const browserFrame = getBrowserFrame(w);
  const ctx: CookieLike = { cookieContainer: browserFrame.page.context.cookieContainer };
  ctxRef = ctx;

  // 4. 写入预热的 cookie
  for (const raw of cookies) {
    try {
      ctx.cookieContainer.addCookies([parseSetCookie(raw, "https://zcode.z.ai/")]);
    } catch {
      /* ignore */
    }
  }

  // 5. 设备身份 cookie：必须在 SDK 加载前就位
  const visitorId = crypto.randomUUID();
  const deviceMid = crypto.randomUUID();
  for (const c of [
    { name: "zcode_visitor_id", value: visitorId, domain: "zcode.z.ai" },
    { name: "zcode_device_mid", value: deviceMid, domain: "zcode.z.ai" },
    { name: "visitor_id", value: visitorId, domain: "zcode.z.ai", httpOnly: true },
  ]) {
    try {
      ctx.cookieContainer.addCookies([{ ...c, url: "https://zcode.z.ai", path: "/" }]);
    } catch {
      /* ignore */
    }
  }

  // 6. 伪装层：**必须在 SDK 脚本执行之前**全部就位
  applyPolyfills(w as unknown as Record<string, unknown>);
  installNativeToString(w as unknown as Record<string, unknown>);
  installGuestScope(w as unknown as Record<string, unknown>); // 必须先于 eval 钩子
  installEvalInstrumentation(w as unknown as Record<string, unknown>);
  w.eval(GUEST_EVAL_PATCH);

  // 7. 写页面 —— 这一步会触发 <script src> 同步执行 SDK
  w.document.write(SOLVE_HTML);
  w.AliyunCaptchaConfig = { region, prefix };

  return { window: w, ctx };
}

let ctxRef: CookieLike | null = null;

function fmtArgs(a: unknown[]): string {
  return a
    .map((x) => {
      if (typeof x === "object") {
        try {
          return JSON.stringify(x).slice(0, 400);
        } catch {
          return "[obj]";
        }
      }
      return String(x);
    })
    .join(" ");
}

function parseSetCookie(raw: string, origin: string): Record<string, unknown> {
  const u = new URL(origin);
  const parts = raw.split(";");
  const head = parts[0] ?? "";
  const pair = head.split("=");
  const cookie: Record<string, unknown> = {
    name: (pair[0] ?? "").trim(),
    value: pair.slice(1).join("=").trim(),
    url: u.origin,
    domain: u.hostname,
    path: "/",
  };
  for (const p of parts.slice(1)) {
    const kv = p.trim().split(/=(.*)/s);
    const k = (kv[0] || "").toLowerCase();
    if (k === "domain" && kv[1]) cookie.domain = kv[1];
    if (k === "path" && kv[1]) cookie.path = kv[1];
    if (k === "expires" && kv[1]) cookie.expires = new Date(kv[1]).getTime();
    if (k === "max-age" && kv[1]) cookie.maxAge = parseInt(kv[1], 10);
    if (k === "httponly") cookie.httpOnly = true;
    if (k === "secure") cookie.secure = true;
    if (k === "samesite" && kv[1]) cookie.sameSite = kv[1];
  }
  return cookie;
}

/**
 * happy-dom 的 browserFrame 拿法。
 *
 * ⚠️ 这里访问的是 happy-dom 的**私有路径**（lib/window/WindowBrowserContext.js）。
 * 上游小版本升级可能改结构 —— 所以整段包在 try 里，失败时降级为
 * "没有 cookie 容器"的最小实现（求解仍可跑，只是 cookie 不回流）。
 */
function getBrowserFrame(w: HappyDomWindow): {
  page: { context: { cookieContainer: CookieLike["cookieContainer"] } };
} {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = nodeRequire("happy-dom/lib/window/WindowBrowserContext.js") as {
      default: new (w: unknown) => { getBrowserFrame(): unknown };
    };
    const BrowserContext = mod.default ?? (mod as unknown as new (w: unknown) => { getBrowserFrame(): unknown });
    const bf = new BrowserContext(w).getBrowserFrame() as {
      page: { context: { cookieContainer: CookieLike["cookieContainer"] } };
    };
    return bf;
  } catch (err) {
    logOnce(
      "warn",
      `[captcha] 无法访问 happy-dom 私有 browserFrame（${(err as Error).message}），cookie 回流降级`,
    );
    return {
      page: {
        context: {
          cookieContainer: {
            getCookies: () => [],
            addCookies: () => undefined,
          },
        },
      },
    };
  }
}

function destroyDom(w: HappyDomWindow | null): void {
  if (!w) return;
  try {
    removeGuestScope(w as unknown as Record<string, unknown>);
  } catch {
    /* ignore */
  }
  try {
    const closeFn = (w as unknown as { close?: () => void }).close;
    // happy-dom 的 close() 是破坏性的 —— 这里我们**就是要**它破坏
    if (typeof closeFn === "function") closeFn.call(w);
  } catch {
    /* ignore */
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 结果严格校验 —— 这是整个模块最重要的一段
// ─────────────────────────────────────────────────────────────────────────────
/**
 * 拿到 param 后**绝不能直接用**。
 *
 * SDK 有降级路径：风控觉得环境可疑时，仍然会走 success 回调，但给一个
 * 76 字符的 `{"certifyId":"...","isSign":true}` —— 没有 securityToken。
 * 这种东西上游一定回 3007。
 *
 * 关键判断：**发出一个坏 param 比不发出去更糟**（等于主动暴露"我不正常"）。
 * 所以宁可在本地判失败去重试。
 */
export function extractVerifyParam(param: unknown): string {
  let verifyParam = param;
  if (param && typeof param === "object") {
    const o = param as Record<string, unknown>;
    verifyParam = o.verifyParam || o.data || o.param;
  }
  if (!verifyParam || String(verifyParam).length < 20) {
    throw new Error(`求解返回空 param: ${JSON.stringify(param)}`);
  }
  const str = String(verifyParam);

  // 校验 1：真实 param 约 280 字符（base64 的 JSON）
  if (str.length < 200) {
    throw new Error(`verify param 过短（${str.length} 字符）—— 疑似降级结果，拒绝: ${str.slice(0, 80)}`);
  }

  // 校验 2：必须是合法 base64 JSON
  let decoded: Record<string, unknown>;
  try {
    decoded = JSON.parse(Buffer.from(str, "base64").toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new Error(`verify param 不是 base64-JSON: ${str.slice(0, 80)}`);
  }

  // 校验 3：必须有足够长的 securityToken
  const secTok = decoded.securityToken ?? decoded.SecurityToken;
  if (!secTok || String(secTok).length < 50) {
    throw new Error(`verify param 缺少 securityToken —— 拒绝降级结果: ${str.slice(0, 80)}`);
  }

  return str;
}

function handleCaptchaResult(result: unknown): unknown {
  if (result && typeof result === "object") {
    const r = result as Record<string, unknown>;
    if (r.verifyResult === false) {
      throw new Error(
        `verify 被拒: ${JSON.stringify({ verifyCode: r.verifyCode, certifyId: r.certifyId })}`,
      );
    }
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Window 复用池
// ─────────────────────────────────────────────────────────────────────────────
/**
 * 实测：复用 window 426ms/solve vs 重建 815ms/solve（**CPU 降约 48%**）。
 *
 * 但必须限量：每次求解都会在 window 里留下常驻的 SDK 实例图，涨到几十 MB。
 * 所以：
 *   - 上限 8 次（不是 25 次，25 次实测内存峰值是 8 次的约 3 倍）
 *   - 空闲 120s 丢弃
 *   - **失败必销毁** —— 卡死的 window 绝不能毒害下一次求解
 */
const _reusePool: { dom: DomHandle | null; solves: number; lastUsedAt: number } = {
  dom: null,
  solves: 0,
  lastUsedAt: 0,
};
const REUSE_MAX_SOLVES = Number(process.env.CAPTCHA_REUSE_MAX_SOLVES || 8);
const REUSE_MAX_IDLE_MS = Number(process.env.CAPTCHA_REUSE_MAX_IDLE_MS || 120_000);

function takeReusableWindow(): DomHandle | null {
  const p = _reusePool;
  if (!p.dom) return null;
  if (p.solves >= REUSE_MAX_SOLVES) {
    discardReusableWindow();
    return null;
  }
  if (Date.now() - p.lastUsedAt > REUSE_MAX_IDLE_MS) {
    discardReusableWindow();
    return null;
  }
  return p.dom;
}
function stageReusableWindow(dom: DomHandle): void {
  _reusePool.dom = dom;
  _reusePool.solves = 0;
  _reusePool.lastUsedAt = Date.now();
}
function discardReusableWindow(): void {
  const p = _reusePool;
  if (p.dom) {
    try {
      destroyDom(p.dom.window);
    } catch {
      /* ignore */
    }
  }
  p.dom = null;
  p.solves = 0;
}
function noteWindowSolved(): void {
  _reusePool.solves += 1;
  _reusePool.lastUsedAt = Date.now();
}

/** 释放所有复用的 window（进程退出/停机时调用）。 */
export function shutdownSolver(): void {
  discardReusableWindow();
  _memCdnCache.clear();
}

function guestErrorSummary(w: HappyDomWindow, max = 4): string {
  try {
    const errs = (w as unknown as { __capErrs?: Array<{ k?: string; m?: string; n?: number }> }).__capErrs;
    if (!errs || !errs.length) return "";
    const total = errs.reduce((a, e) => a + (e.n ?? 1), 0);
    const parts = errs.slice(0, max).map((e) => {
      const n = e.n && e.n > 1 ? `x${e.n}` : "";
      return `${e.k ?? "?"}${n}: ${String(e.m ?? "?").slice(0, 120)}`;
    });
    return ` guestErrors(${total}): ${parts.join(" || ")}`;
  } catch {
    return "";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 主流程
// ─────────────────────────────────────────────────────────────────────────────
export async function solveTraceless(opts: SolveOptions): Promise<string> {
  const scene = opts.scene;
  const region = opts.region;
  const prefix = opts.prefix;
  if (!scene || !region || !prefix) {
    throw new Error("scene / region / prefix 均为必填");
  }
  const timeoutMs = opts.timeoutMs ?? Number(process.env.CAPTCHA_SOLVE_TIMEOUT_MS || 30_000);
  const wantReuse = opts.reuseWindow ?? process.env.CAPTCHA_WINDOW_REUSE !== "0";

  let dom: DomHandle | null = null;
  let reused = false;
  if (wantReuse) {
    dom = takeReusableWindow();
    if (dom) reused = true;
  }
  if (!dom) dom = await createDom(region, prefix);

  const { window: w } = dom;
  const solveStart = Date.now();
  let keepWindow = false;

  try {
    // 等 SDK 就绪
    await waitFor(() => typeof (w as Record<string, unknown>).initAliyunCaptcha === "function", timeoutMs, 50);

    simulateBehavior(w as unknown as Record<string, unknown>, 600);

    const param = await new Promise<unknown>((resolve, reject) => {
      let settled = false;
      const finish = (fn: (v: unknown) => void) => (value: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearInterval(stallTimer);
        fn(value);
      };

      const ok = finish(resolve);
      const fail = finish(reject);

      // 总超时
      const timer = setTimeout(() => {
        fail(new Error(`求解超时（${timeoutMs}ms）${recentReqs(solveStart)}`));
      }, timeoutMs);

      // 停滞检测：连续 12s 没有新 XHR 且无在飞请求 → pe VM 已卡死
      //
      // 为什么是 12s 而不是 6s：混淆的 450KB pe VM 在慢机器上正常也要
      // 啃 CPU 6s 以上才发下一个请求，6s 会误杀健康求解、白白烧掉一次重试。
      // 为什么有在飞请求就跳过：跨境 verify POST 可能跑 5-10s，这期间
      // 没有新请求发起，但它是在**推进**，不是卡死。
      const stallMs = opts.stallMs ?? Number(process.env.CAPTCHA_STALL_MS || 12_000);
      const stallTimer = setInterval(() => {
        const last = _requestLog[_requestLog.length - 1] as ReqEntry | undefined;
        if (last && Date.now() - last.at > stallMs && _asyncRequestsInFlight === 0) {
          const peUrl = (w as unknown as { __lastPeUrl?: string }).__lastPeUrl || "?";
          noteStallAndMaybeEvict(peUrl);
          fail(new Error(`求解停滞 pe=${shortPe(peUrl)} lastXhr=${last.at - solveStart}ms${recentReqs(solveStart)}`));
        }
      }, 500);
      // stallTimer 同样不 unref：它被 500ms 间隔引用着，而整个 Promise 被
      // 总超时兜底（timer 必然触发），没有"泄漏到进程 lifetime"的风险。

      try {
        const initFn = (w as unknown as { initAliyunCaptcha: (o: object) => void }).initAliyunCaptcha;
        initFn.call(w, {
          SceneId: scene,
          mode: "popup",
          region,
          prefix,
          language: "en",
          element: "#cap",
          button: "#btn",
          captchaLogoImg: "",
          showErrorTip: false,
          getInstance: (inst: { startTracelessVerification?: () => void; show?: () => void }) => {
            try {
              (inst.startTracelessVerification || inst.show)?.call(inst);
            } catch (e) {
              fail(new Error(`start: ${(e as Error).message}`));
            }
          },
          success: (result: unknown) => {
            try {
              ok(handleCaptchaResult(result));
            } catch (err) {
              fail(err);
            }
          },
          fail: (err: unknown) => fail(new Error(`fail: ${JSON.stringify(err)}`)),
          onError: (err: unknown) => fail(new Error(`onError: ${JSON.stringify(err)}`)),
        });
      } catch (err) {
        fail(err);
      }
    });

    // 成功：清掉这个 pe 的卡死记录 & guest 错误缓冲（复用的 window 下一次
    // 失败时不该报告上一次已成功求解的错误）
    try {
      const okPe = (w as unknown as { __lastPeUrl?: string }).__lastPeUrl;
      if (okPe) _stallCounts.delete(okPe);
      (w as unknown as { __capErrs?: unknown[] }).__capErrs = [];
    } catch {
      /* ignore */
    }

    const out = extractVerifyParam(param);
    if (wantReuse) {
      if (reused) noteWindowSolved();
      else stageReusableWindow(dom);
      keepWindow = true;
    }
    return out;
  } catch (err) {
    // 把 guest 错误附到失败信息上 —— 这是它唯一有价值的时机
    const summary = guestErrorSummary(w);
    if (summary) {
      try {
        (err as Error).message = `${(err as Error).message}${summary}`;
      } catch {
        /* ignore */
      }
    }
    throw err;
  } finally {
    if (!keepWindow) {
      if (_reusePool.dom === dom) _reusePool.dom = null;
      destroyDom(w);
    }
  }
}

function shortPe(peUrl: string): string {
  const parts = peUrl.split("/");
  return parts[parts.length - 1] || peUrl;
}

function recentReqs(since: number): string {
  const list = (_requestLog as ReqEntry[])
    .filter((r) => r.at >= since)
    .slice(-12)
    .map((r) => `${r.at - since}ms ${r.method} ${String(r.url).replace(/^https?:\/\//, "").slice(0, 60)}`);
  return ` reqs=${JSON.stringify(list)}`;
}

/** 供测试/运维观测。 */
export function solverStats(): {
  requestLogLength: number;
  requestLogCap: number;
  cdnCacheSize: number;
  cdnCacheCap: number;
  reuseSolves: number;
  inFlight: number;
} {
  return {
    requestLogLength: _requestLog.length,
    requestLogCap: REQUEST_LOG_CAP,
    cdnCacheSize: _memCdnCache.size,
    cdnCacheCap: MEM_CDN_CACHE_CAP,
    reuseSolves: _reusePool.solves,
    inFlight: _asyncRequestsInFlight,
  };
}

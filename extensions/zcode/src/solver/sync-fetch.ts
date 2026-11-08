/**
 * sync-fetch.ts —— 同步 HTTP（给 happy-dom 的同步 XHR 用）。
 *
 * 为什么需要：阿里云 SDK 在部分路径用**同步 XHR**。happy-dom 的默认实现
 * 是靠 spawn 一个新的 node 进程跑脚本，这条路径在容器里往往不可用。
 * 而同步 XHR 必须真同步返回 —— Promise 不行。
 *
 * 解法：execFileSync 起一个极简 node -e 脚本，结果用 JSON 从 stdout 传回。
 * 相比 zcode-api 的 SharedArrayBuffer + Atomics 方案更简单，代价是每次同步
 * 请求多一次进程启动（约 20-30ms）。
 */
import { execFileSync } from "node:child_process";

export interface BlockingFetchResult {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: Buffer;
}

const WORKER_SCRIPT = [
  'const https = require("https");',
  'const http = require("http");',
  'let input = "";',
  'process.stdin.on("data", (c) => (input += c));',
  'process.stdin.on("end", () => {',
  "  const { url, method, headers, timeoutMs } = JSON.parse(input);",
  "  const u = new URL(url);",
  '  const mod = u.protocol === "http:" ? http : https;',
  "  const h = Object.assign({}, headers);",
  '  delete h["accept-encoding"];',
  "  const req = mod.request(u, {",
  "    method: method || 'GET',",
  "    headers: h,",
  "    autoSelectFamily: true,",
  "    autoSelectFamilyAttemptTimeout: 300,",
  "  }, (res) => {",
  "    const chunks = [];",
  '    res.on("data", (c) => chunks.push(c));',
  '    res.on("end", () => {',
  "      process.stdout.write(JSON.stringify({",
  "        status: res.statusCode || 0,",
  '        statusText: res.statusMessage || "",',
  "        headers: res.headers,",
  '        body: Buffer.concat(chunks).toString("base64"),',
  "      }));",
  "    });",
  "  });",
  '  req.setTimeout(timeoutMs, () => req.destroy(new Error("socket idle timeout")));',
  '  req.on("error", (e) => {',
  '    process.stdout.write(JSON.stringify({ error: String((e && e.message) || e) }));',
  "  });",
  "  req.end();",
  "});",
].join("\n");

const DEFAULT_TIMEOUT_MS = Number(process.env.CAPTCHA_SYNC_FETCH_TIMEOUT_MS || 12_000);

export function blockingFetch(
  url: string,
  init: { method: string; headers: Record<string, string> },
  timeoutMs = DEFAULT_TIMEOUT_MS,
): BlockingFetchResult | { error: string } {
  try {
    const out = execFileSync(process.execPath, ["-e", WORKER_SCRIPT], {
      input: JSON.stringify({ url, method: init.method, headers: init.headers, timeoutMs }),
      timeout: timeoutMs + 2_000,
      maxBuffer: 16 * 1024 * 1024,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    });
    const parsed = JSON.parse(out) as
      | { error: string }
      | { status: number; statusText: string; headers: Record<string, string>; body: string };
    if ("error" in parsed) return { error: parsed.error };
    return {
      status: parsed.status,
      statusText: parsed.statusText,
      headers: parsed.headers,
      body: Buffer.from(parsed.body, "base64"),
    };
  } catch (err) {
    return { error: `sync fetch 失败: ${(err as Error).message}` };
  }
}

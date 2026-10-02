/**
 * Built-in captcha handlers and the handler chain.
 *
 * "Solver" here means the *disposition* of a captcha challenge, not solving
 * the verification programmatically: the default `ManualCaptchaHandler`
 * serves a human-completed token from the shared cache (submitted through
 * the admin API or the `/api/accounts/zcode/captcha/authorize` page, which
 * loads the official Aliyun widget). There is deliberately no automated
 * backend — see README "安全与合规边界". Future backends (e.g. an external
 * operator tool) plug in by implementing `CaptchaHandler` and passing it via
 * `createZCodeProvider({ captchaHandler })`; the provider stays agnostic.
 */
import type { ZCodeCaptchaManager } from './manager.js'
import type { CaptchaChallenge, CaptchaHandler, CaptchaResult } from './types.js'
import { CaptchaConfigCache, widgetParams } from './captcha-config.js'

export type { CaptchaChallenge, CaptchaHandler, CaptchaResult } from './types.js'

/**
 * Human-in-the-loop handler backed by the shared token cache.
 *
 * - A cached token resolves the challenge immediately (45s TTL keeps reuse
 *   within the window upstream accepts it).
 * - An expired/absent token yields `{ ok: false, reason: 'unavailable' }`,
 *   which the provider maps onto NEEDS_CAPTCHA → `needs_manual_action`.
 */
export class ManualCaptchaHandler implements CaptchaHandler {
  readonly id = 'manual'

  constructor(private readonly manager: ZCodeCaptchaManager) {}

  async handle(challenge: CaptchaChallenge): Promise<CaptchaResult> {
    const cached = this.manager.peek()
    if (cached) return { ok: true, verifyParam: cached }
    return { ok: false, reason: 'unavailable' }
  }

  /** Drop the cached token (called when upstream rejects it). */
  invalidate(): void {
    this.manager.invalidate()
  }
}

/**
 * Try handlers in order; the first `ok: true` wins. When every handler is
 * unavailable the chain reports `unavailable` (never a fabricated token).
 */
export class CaptchaHandlerChain implements CaptchaHandler {
  readonly id: string

  constructor(private readonly handlers: CaptchaHandler[]) {
    this.id = handlers.map((handler) => handler.id).join('+') || 'none'
  }

  async handle(challenge: CaptchaChallenge): Promise<CaptchaResult> {
    for (const handler of this.handlers) {
      const result = await handler.handle(challenge)
      if (result.ok) return result
    }
    return { ok: false, reason: 'unavailable' }
  }
}

/** Which handler id resolved the challenge (for logs/tests). */
export function describeChain(handlers: CaptchaHandler[]): string {
  return handlers.map((handler) => handler.id).join('+') || 'none'
}

/** HTML for the human authorization page (official Aliyun widget). */
export function renderAuthorizePage(config: {
  prefix: string
  region: string
  sceneId: string
  scriptUrl: string
  submitPath: string
}): string {
  const safe = {
    prefix: escapeHtml(config.prefix),
    region: escapeHtml(config.region),
    sceneId: escapeHtml(config.sceneId),
    scriptUrl: escapeHtml(config.scriptUrl),
    submitPath: escapeHtml(config.submitPath),
  }
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ZCode captcha authorization</title>
<script src="${safe.scriptUrl}"></script>
<style>
  body { font-family: system-ui, sans-serif; max-width: 640px; margin: 3rem auto; padding: 0 1rem; color: #1a1a1a; }
  h1 { font-size: 1.25rem; }
  #captcha-element { min-height: 100px; }
  button { margin-top: 1rem; padding: .5rem 1.25rem; font-size: 1rem; }
  pre { background: #f5f5f5; padding: .75rem; white-space: pre-wrap; word-break: break-all; }
  .ok { color: #0a7d32; } .err { color: #b00020; }
  label { display: block; margin-top: 1rem; font-size: .9rem; }
  input { width: 100%; padding: .4rem; margin-top: .25rem; box-sizing: border-box; }
</style>
</head>
<body>
<h1>ZCode captcha authorization</h1>
<p>Complete the verification below. It is the official Aliyun widget in your
real browser — nothing is automated. On success the token is submitted to the
gateway and used for subsequent ZCode requests.</p>
<div id="captcha-element"></div>
<label>Gateway admin token (required to submit — it is sent only to this gateway)
  <input id="token" type="password" autocomplete="off" placeholder="GATEWAY_ADMIN_TOKEN">
</label>
<button id="btn">Start verification</button>
<pre id="status"></pre>
<script>
  var status = document.getElementById('status');
  var tokenInput = document.getElementById('token');
  var preset = new URLSearchParams(location.search).get('token');
  if (preset) tokenInput.value = preset;
  function log(kind, message) {
    status.className = kind;
    status.textContent = message;
  }
  document.getElementById('btn').addEventListener('click', function () {
    if (typeof initAliyunCaptcha !== 'function') {
      log('err', 'widget script failed to load — check network access to ' + '${safe.scriptUrl}');
      return;
    }
    initAliyunCaptcha({
      SceneId: '${safe.sceneId}',
      prefix: '${safe.prefix}',
      region: '${safe.region}',
      mode: 'embed',
      element: '#captcha-element',
      captchaVerifyCallback: function (captchaVerifyParam) {
        var token = tokenInput.value.trim();
        if (!token) {
          log('err', 'Enter the gateway admin token first.');
          return Promise.resolve({ captchaResult: false });
        }
        return fetch('${safe.submitPath}', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + token },
          body: JSON.stringify({ verify_param: captchaVerifyParam })
        }).then(function (res) { return res.json().then(function (out) { return { status: res.status, out: out }; }); }).then(function (r) {
          if (r.out && r.out.ok) {
            log('ok', 'Token accepted (expires in ~' + r.out.expires_in + 's). You can close this page.');
            return { captchaResult: true };
          }
          if (r.status === 401) {
            log('err', 'Admin token missing or invalid — paste a valid token and retry.');
          } else {
            log('err', 'Gateway rejected the token: ' + JSON.stringify(r.out));
          }
          return { captchaResult: false };
        }).catch(function (err) {
          log('err', 'Submission failed: ' + err);
          return { captchaResult: false };
        });
      },
      onBizError: function () { log('err', 'Widget error — retry.'); }
    });
  });
</script>
</body>
</html>`
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export { CaptchaConfigCache, widgetParams }

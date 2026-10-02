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
<script>
  // Required by AliyunCaptcha.js: region/prefix are read ONLY from this global,
  // never from initAliyunCaptcha params. Must be defined before the SDK loads.
  window.AliyunCaptchaConfig = {
    region: '${safe.region}',
    prefix: '${safe.prefix}'
  };
</script>
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
real browser &mdash; nothing is automated. On success the token is submitted to the
gateway and used for subsequent ZCode requests.</p>
<div id="captcha-element"></div>
<label>Gateway admin token (required to submit &mdash; it is sent only to this gateway)
  <input id="token" type="password" autocomplete="off" placeholder="GATEWAY_ADMIN_TOKEN">
</label>
<button id="btn">Start verification</button>
<pre id="status"></pre>
<script>
  // NOTE: never name this variable 'status' — window.status is a legacy string
  // setter and silently swallows the assignment, blanking all page feedback.
  var statusEl = document.getElementById('status');
  var tokenInput = document.getElementById('token');
  var preset = new URLSearchParams(location.search).get('token');
  if (preset) tokenInput.value = preset;
  function log(kind, message) {
    statusEl.className = kind;
    statusEl.textContent = message;
  }
  function submitToken(captchaVerifyParam) {
    var token = tokenInput.value.trim();
    if (!token) {
      log('err', 'Enter the gateway admin token first.');
      return Promise.resolve(false);
    }
    return fetch('${safe.submitPath}', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + token },
      body: JSON.stringify({ verify_param: captchaVerifyParam })
    }).then(function (res) {
      return res.json().then(function (out) { return { status: res.status, out: out }; });
    }).then(function (r) {
      if (r.out && r.out.ok) {
        log('ok', 'Token accepted (expires in ~' + r.out.expires_in + 's). You can close this page.');
        return true;
      }
      if (r.status === 401) {
        log('err', 'Admin token missing or invalid — paste a valid token and retry.');
      } else {
        log('err', 'Gateway rejected the token: ' + JSON.stringify(r.out));
      }
      return false;
    }).catch(function (err) {
      log('err', 'Submission failed: ' + err);
      return false;
    });
  }
  document.getElementById('btn').addEventListener('click', function () {
    if (typeof initAliyunCaptcha !== 'function') {
      log('err', 'Widget script failed to load — check network access to ' + '${safe.scriptUrl}');
    }
  });
  // Popup mode: the SDK binds #btn itself and opens the widget on click.
  // initAliyunCaptcha must be called exactly once, at page load.
  if (typeof initAliyunCaptcha === 'function') {
    initAliyunCaptcha({
      SceneId: '${safe.sceneId}',
      mode: 'popup',
      element: '#captcha-element',
      button: '#btn',
      language: 'cn',
      getInstance: function (instance) { window.__captchaInstance = instance; },
      success: function (result) {
        var param = result && typeof result === 'object'
          ? (result.captchaVerifyParam || result.verifyParam || result.data || result.param || result)
          : result;
        if (param && typeof param === 'object') {
          log('err', 'Widget returned an unusable result: ' + JSON.stringify(param));
          return;
        }
        submitToken(String(param));
      },
      fail: function (result) {
        log('err', 'Verification failed: ' + JSON.stringify(result || {}) + ' — click again to retry.');
      },
      onError: function (err) {
        log('err', 'Widget error: ' + JSON.stringify(err || {}) + ' — click again to retry.');
      }
    });
  } else {
    log('err', 'Widget script failed to load — check network access to ' + '${safe.scriptUrl}');
  }
</script>
</body>
</html>`
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

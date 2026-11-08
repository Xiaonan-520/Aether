/**
 * 人工验证码授权页：真实浏览器里加载**官方** AliyunCaptcha.js widget，
 * 人类完成验证后把 verifyParam 提交回扩展。
 *
 * 与 Core 内置适配器的 renderAuthorizePage 同源（含同样的已知坑修复：
 * 不用 window.status 作为变量名）。submitPath 指向本扩展自身的
 * POST /v1/captcha 端点。
 */
export function renderCaptchaPage(config: {
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
<title>ZCode captcha authorization (extension)</title>
<script>
  // AliyunCaptcha.js 要求：region/prefix 只从这个全局读取。
  // 必须在 SDK 脚本加载前定义。
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
<p>Complete the verification below &mdash; the official Aliyun widget in your real
browser, nothing automated. On success the token is stored in this extension and
used for subsequent ZCode requests.</p>
<div id="captcha-element"></div>
<label>Extension bearer token (GATEWAY_EXTENSION_TOKEN; sent only to this extension)
  <input id="token" type="password" autocomplete="off" placeholder="extension token">
</label>
<button id="btn">Start verification</button>
<pre id="out"></pre>
<script>
  // 不叫 'status' —— window.status 是遗留字符串 setter，会静默吞掉赋值。
  var out = document.getElementById('out');
  var tokenInput = document.getElementById('token');
  function log(kind, message) {
    out.className = kind;
    out.textContent = message;
  }
  function submitToken(param) {
    var token = tokenInput.value.trim();
    if (!token) { log('err', 'Enter the extension token first.'); return; }
    fetch('${safe.submitPath}', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + token },
      body: JSON.stringify({ verify_param: param })
    }).then(function (r) { return r.json().then(function (j) { return { s: r.status, j: j }; }); })
      .then(function (r) {
        if (r.j && r.j.ok) log('ok', 'Token accepted. You can close this page.');
        else if (r.s === 401) log('err', 'Extension token missing or invalid.');
        else log('err', 'Rejected: ' + JSON.stringify(r.j));
      })
      .catch(function (e) { log('err', 'Submission failed: ' + e); });
  }
  if (typeof initAliyunCaptcha === 'function') {
    initAliyunCaptcha({
      SceneId: '${safe.sceneId}',
      mode: 'popup',
      element: '#captcha-element',
      button: '#btn',
      language: 'cn',
      getInstance: function (i) { window.__captchaInstance = i; },
      success: function (result) {
        var param = result && typeof result === 'object'
          ? (result.captchaVerifyParam || result.verifyParam || result.data || result.param)
          : result;
        if (!param || typeof param === 'object') {
          log('err', 'Widget returned an unusable result.');
          return;
        }
        submitToken(String(param));
      },
      fail: function (r) { log('err', 'Verification failed: ' + JSON.stringify(r || {}) + ' — click again to retry.'); },
      onError: function (e) { log('err', 'Widget error: ' + JSON.stringify(e || {}) + ' — click again to retry.'); }
    });
  } else {
    log('err', 'Widget script failed to load — check network access to ${safe.scriptUrl}');
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

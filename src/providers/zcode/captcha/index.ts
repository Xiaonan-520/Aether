/**
 * ZCode captcha module — pluggable challenge handling.
 *
 * Layout:
 *   types.ts           — CaptchaHandler contract (provider stays agnostic)
 *   captcha-client.ts  — challenge detection/classification (header + in-body 3007)
 *   captcha-config.ts  — Aliyun scene config fetch (positive/negative cache)
 *   captcha-solver.ts  — built-in handlers (manual) + handler chain
 *   manager.ts         — shared human-submitted token cache (single-flight)
 *
 * Policy boundary: the gateway never automates, bypasses or solves the
 * captcha. Challenges are resolved by a human through the official Aliyun
 * widget; when nobody does, the provider reports `needs_manual_action`.
 */
export * from './types.js'
export * from './captcha-client.js'
export * from './captcha-config.js'
export * from './captcha-solver.js'
export * from './manager.js'

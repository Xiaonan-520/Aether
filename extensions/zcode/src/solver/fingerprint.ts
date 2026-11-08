/**
 * 指纹常量 —— 全部**固定**，绝不随机化。
 *
 * 这是从 zcode-api 移植过来最反直觉、也最重要的一条经验：
 * 阿里云风控比较的是「同一设备跨请求的一致性」。每次求解换一套随机指纹，
 * 反而会被判 `verifyCode: F001`（环境异常）。所以这里的值必须稳定。
 *
 * 适配 Aether 时改这里就够了：如果你的部署区域/目标站点不同，
 * 整套 UA / Client Hints / 屏幕参数要**整体**换成另一套自洽的值，
 * 不要只改一项（混合来源的指纹本身就是特征）。
 */

export interface Fingerprint {
  userAgent: string;
  uaMajor: string;
  uaBrands: string;
  platform: string;
  screen: { w: number; h: number; aw: number; ah: number };
  webglVendor: string;
  webglRenderer: string;
  canvasImage: string;
  languages: string;
  timezone: string;
}

export const FINGERPRINT: Fingerprint = {
  userAgent:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
  uaMajor: "127",
  uaBrands: '"Chromium";v="127", "Not)A;Brand";v="24"',
  platform: "Linux x86_64",
  screen: { w: 1280, h: 720, aw: 1280, ah: 720 },
  // 故意露出 SwiftShader：无头/软件渲染环境本来就长这样，
  // 伪装成真 GPU 反而与其它信号（无硬件加速）矛盾。
  webglVendor: "Google Inc. (Google)",
  webglRenderer:
    "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)",
  // 1x1 固定 PNG，保证 canvas 指纹恒定
  canvasImage:
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  languages: "en-US,en;q=0.9",
  timezone: "Asia/Shanghai",
};

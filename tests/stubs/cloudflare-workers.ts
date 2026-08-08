// vitest 里 `cloudflare:workers` 这个虚拟模块不存在，任何直接或间接 import 它的源码
// （_crypto、各 route.ts）都会在收集阶段整份挂掉。这里提供一个最小桩，
// 让纯逻辑测试能安全地 import 生产源码，而不必把函数复制一份到测试里。
//
// 只提供 env；需要 D1 的测试仍应 mock 具体模块（见 tests/setup.ts 对 _shared 的处理）。
export const env = {
  PLATFORM_CREDENTIALS_KEY: "test-platform-credentials-key",
  DEFAULT_ADMIN_USERNAME: "admin",
  DEFAULT_ADMIN_PASSWORD: "admin123456",
  COLLECTOR_PROXY_URL: "",
  LOG_LEVEL: "error",
};

export default { env };

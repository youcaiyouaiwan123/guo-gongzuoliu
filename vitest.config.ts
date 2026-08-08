import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["app/**/*.test.ts", "app/**/*.test.tsx"],
    exclude: ["node_modules", "dist", ".next", ".vinext", ".wrangler"],
    testTimeout: 15000,
    setupFiles: ["./tests/setup.ts"],
  },
  resolve: {
    alias: {
      "@": __dirname,
      // Workers 运行时的虚拟模块在 Node 下不存在，指向测试桩，
      // 否则任何 import 链上带 _crypto / route.ts 的用例都会在收集阶段整份失败。
      "cloudflare:workers": `${__dirname}/tests/stubs/cloudflare-workers.ts`,
    },
  },
});
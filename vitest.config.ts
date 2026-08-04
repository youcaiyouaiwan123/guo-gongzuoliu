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
    alias: { "@": __dirname },
  },
});
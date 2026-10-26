import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // server 与 client 各有独立的 tsconfig，用同一个 vitest 实例跑两边的用例
    include: [
      "server/src/**/*.test.ts",
      "client/src/**/*.test.ts",
      "orchestrator/src/**/*.test.ts",
      "packages/*/src/**/*.test.ts",
      "apps/*/test/**/*.test.mjs",
    ],
    environment: "node",
    globals: false,
    reporters: ["default"],
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "html"],
      include: ["server/src/**/*.ts", "client/src/**/*.ts", "packages/*/src/**/*.ts"],
      exclude: [
        "**/*.test.ts",
        "**/node_modules/**",
        "server/src/index.ts",
        "**/*.d.ts",
      ],
    },
  },
});

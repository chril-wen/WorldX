import { defineConfig } from "vite";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@server-types": path.resolve(__dirname, "../server/src/types"),
      // 地图数据层 —— 指到**源码**，不是 dist。
      //
      // 跟 @server-types 同一个模式：client 不在根 workspaces 里，
      // 拿不到 workspace 的 node_modules 链接，所以走 alias。
      // 指源码而不是 dist，是为了改 client-core 不用先 build。
      "@own-world/client-core": path.resolve(__dirname, "../packages/client-core/src/index.ts"),
      // core 的**子路径** —— 指到源码。
      //
      // ⚠ 必须是子路径，不能是包根：从包根 import 会把整个 core
      // （包括 `engine/world-manager.js`，它顶层读 `process.env`）
      // 拖进浏览器 bundle。
      //
      // 跟 @server-types、@own-world/client-core 同一个模式：client 不在
      // 根 workspaces 里，拿不到 workspace 的 node_modules 链接，所以走 alias。
      "@own-world/core": path.resolve(__dirname, "../packages/core/src"),
    },
  },
  server: {
    port: 3200,
    proxy: {
      "/api": "http://localhost:3100",
      "/assets": "http://localhost:3100",
      "/ws": {
        target: "ws://localhost:3100",
        ws: true,
      },
    },
  },
  /**
   * 预览台 —— 阶段 8.2 的浏览器验收页。
   *
   * `preview.html` 是**独立**的入口（不走 `index.html`）——
   * 它不启动 Phaser，只挂新的 Canvas 2D 渲染器。
   *
   * 这样「旧实现」和「新实现」可以在同一个 server 上分别看，
   * 互不干扰。
   */
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, "index.html"),
        preview: path.resolve(__dirname, "preview.html"),
        ab: path.resolve(__dirname, "ab.html"),
      },
    },
  },
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "react",
  },
});

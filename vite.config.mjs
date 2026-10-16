// 拾阅（shiyue）· Vite 构建配置
//
// 多页面应用（MPA）：两个入口 HTML 都在仓库根 ——
//   index.html  主站（阅读 / 卡片 / AI / 设置）
//   login.html  登录页（独立页面，自包含样式）
// 其余静态资源（app.js / style.css / sw.js / 图标）仍放 public/，
// 由 publicDir 原样拷入 dist/，CSS 与旧 JS 一行不改。
//
// React 采用渐进式接入：src/ 下的新组件通过 <script type="module">
// 挂载到旧 HTML 的挂载点上，期间通过 window.shiyue 桥接旧全局能力，
// 迁移完成后桥接层逐步拆除。

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  // public/ 原样拷贝到 dist/：style.css / app.js / sw.js / 图标 / manifest
  publicDir: 'public',
  build: {
    outDir: 'dist',
    // 产物带 hash，文件名稳定可缓存；publicDir 拷出来的文件不带 hash，保持原路径
    rollupOptions: {
      input: {
        index: path.resolve(import.meta.dirname, 'index.html'),
        login: path.resolve(import.meta.dirname, 'login.html'),
      },
    },
  },
  server: {
    port: 5173,
    // 前端 dev server 把 /api 代理到本地后端，前后端分离联调
    proxy: {
      '/api': { target: 'http://127.0.0.1:3000', changeOrigin: false },
    },
  },
});

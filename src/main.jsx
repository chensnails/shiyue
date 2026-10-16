/* 拾阅前端 React 入口（渐进式混合期）。
 * 职责：把 React 组件挂到旧 HTML 的挂载点上。
 * 目前挂命令面板（#cmdkRoot）、设置弹层（#settingsRoot）、AI 视图（#aiRoot）；
 * 设置弹层六面板与 AI 视图均已 React 化，其余视图随 P3 继续迁移。
 * window.shiyue 桥由旧 app.js 在脚本执行时建立，本模块只消费。 */

import React from 'react';
import { createRoot } from 'react-dom/client';
import { CommandPalette } from './cmdk/CommandPalette.jsx';
import { SettingsModal } from './settings/SettingsModal.jsx';
import { AiView } from './ai/AiView.jsx';

const el = document.getElementById('cmdkRoot');
if (el) {
  createRoot(el).render(
    <React.StrictMode>
      <CommandPalette />
    </React.StrictMode>
  );
}

const settingsRoot = document.getElementById('settingsRoot');
if (settingsRoot) {
  createRoot(settingsRoot).render(
    <React.StrictMode>
      <SettingsModal />
    </React.StrictMode>
  );
}

const aiRoot = document.getElementById('aiRoot');
if (aiRoot) {
  createRoot(aiRoot).render(
    <React.StrictMode>
      <AiView />
    </React.StrictMode>
  );
}

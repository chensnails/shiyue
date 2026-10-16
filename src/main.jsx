/* 拾阅前端 React 入口（渐进式混合期）。
 * 职责：把 React 组件挂到旧 HTML 的挂载点上。
 * 目前只挂命令面板（#cmdkRoot）；后续设置弹层、各视图按阶段迁入。
 * window.shiyue 桥由旧 app.js 在脚本执行时建立，本模块只消费。 */

import React from 'react';
import { createRoot } from 'react-dom/client';
import { CommandPalette } from './cmdk/CommandPalette.jsx';

const el = document.getElementById('cmdkRoot');
if (el) {
  createRoot(el).render(
    <React.StrictMode>
      <CommandPalette />
    </React.StrictMode>
  );
}

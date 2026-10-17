/* 拾阅核心逻辑的统一入口。
 *
 * 组件一律 `import { core } from '@core'`（别名见 vite.config.mjs / tests/ui/build.mjs），
 * 不再依赖 window 上的全局桥 —— v2.0.0 起 window.shiyue 已拆除。
 *
 * 导入本模块即执行 src/core/app.js 的顶层副作用（主题/视图首屏应用、事件绑定、init()）。
 */
export { core } from './app.js';

# 更新日志 / Changelog

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)（SemVer）：`主版本.次版本.修订号`。

- **主版本（MAJOR）**：不兼容的架构 / 接口变更（如数据库结构破坏性迁移）。
- **次版本（MINOR）**：向后兼容的新功能（如新增一类页面、新的订阅能力）。
- **修订号（PATCH）**：向后兼容的问题修复与细节优化。

## 版本发布流程

1. 在 `main` 上完成改动并合并。
2. 更新本文件，新增对应版本的条目。
3. 同步更新 `VERSION` 文件与 `package.json` 的 `version` 为同一版本号。
4. 打标签并推送：`git tag -a vX.Y.Z -m "vX.Y.Z" && git push origin main --tags`。
5. 服务器拉取并重建：登录部署主机执行 `./deploy.sh`。

> 后续每次更新都按此版本号流程推进；`main` 始终是可发布的稳定分支。

---

## [1.7.0] — 2026-10-16

新增：

- **「AI」视图 React 化**（React 渐进式迁移的 P3a 阶段，三大视图迁移的第一个切片）：视图内容整体迁往 `src/ai/AiView.jsx`，挂载到 `index.html` 的 `#aiRoot`（外层 `#aiView` 容器仍由旧 `switchView` 控制显隐）；类名 / ID / data 属性、视觉与交互保持不变。
  - **日报子页**：进入即拉 `/api/digests` 日期列表与所选日期摘要，概览 / 元信息（生成时间·模型·采集→精选·覆盖频道）/ 今日亮点 / 分组条目全部由 JSX 渲染；日期下拉切换、生成 / 重新生成（`/api/digest/generate`）、空态 / 加载 / 读取失败 / 生成失败各状态齐备；条目复制按钮与缩略图兜底改由 React 处理（替代旧 `bindCardActions`）。
  - **日报设置子页**（仅管理员）：`/api/config` 的 `digest` 段表单（自动生成 / 时间 / 范围 / 条数上限 / 保留天数）受控渲染，联动副标题与两个折叠分组的摘要行；保存 `POST /api/config`。
  - 子页光标按账号持久化（`users.prefs.layout.aiPage`），经桥 `getAiPage` / `setAiPage` 读写；React 常驻挂载但只在切到 AI 页时拉数据（视图切换经 `__viewChanged` 事件感知）。
- 迁移中顺手清理落后实现（遵循「技术落后 / 体验不好的可丢弃」原则）：
  - 日报展示由 `innerHTML` 字符串拼接改为 JSX 组件（概览 / 元信息 / 亮点 / 分组 / 条目拆为组件）。
  - 子页显隐 / 高亮由命令式 `classList` / `hidden` 改写为 React 条件渲染，管理员专属的「日报设置」入口按 `admin` 直接不渲染（而非 DOM 隐藏）。
  - 桥新增 `getAiPage` / `setAiPage` / `linkLabel`；`applyRoleUI` 不再处理 `#aiNav`。

---

## [1.6.0] — 2026-10-16

新增：

- **「账号」「状态」设置面板 React 化**（React 渐进式迁移的 P2d 阶段，也是设置弹层迁移的收官）：两面板分别迁往 `src/settings/AccountPane.jsx` 与 `StatusPane.jsx`；至此设置弹层六个面板（数据源 / 模型 / 账号 / 外观 / 状态 / 关于）**全部 React 化**，混合期的 legacy-slot 搬运机制与 `index.html` 的 `#legacyPanes` 隐藏容器一并退役。
  - **账号面板**：登录信息（改用户名 / 改密码，需验证当前密码）、用户管理（增删用户、切换角色、重置密码，仅管理员可见）、添加到手机（引导文案 + 一键安装）、退出登录，能力与旧实现一致；表单改由受控状态管理，操作结果提示内联在组件里。
  - **状态面板**：只读体检页，进入即拉 `/api/status` 快照并每 30s 自动刷新，「已运行时长」在本地每秒递增；健康条 + 运行与数据库 / 采集与条目 / 异常频道（失败时出现且默认展开）/ 日报四个可折叠分组；「复制诊断」把快照拍平成纯文本（带剪贴板降级兜底），异常频道可逐个「重试」抓取。
- 迁移中顺势清理落后实现（遵循「技术落后 / 体验不好的可丢弃」原则）：
  - 状态轮询与运行时长递增改由组件 `useEffect` 生命周期自洽启停（旧 `startStatusPolling` / `stopStatusPolling` 全局定时器退役，不再依赖 `window.__settingsOpen` 判活）。
  - 状态页由 `innerHTML` 字符串拼接改为 JSX 组件渲染，格式化函数（时长 / 字节 / 相对时间 / 千分位）下沉为组件内纯函数（`fmtFull` 仍留在旧 app.js 供阅读页复用）。
  - 用户管理与账号操作的结果提示、按钮 busy 态改由组件状态驱动；危险操作（删除用户）仍走确认弹窗。
  - 桥收缩：移除 `settingsTabEffect` / `getLegacySettingsPane` / `stopStatusPolling`，新增 `promptInstall`（账号面板「一键安装」）。

---

## [1.5.0] — 2026-10-16

新增：

- **「数据源」设置面板 React 化**（React 渐进式迁移的 P2c 阶段）：面板迁往 `src/settings/SourcePane.jsx`，DOM 结构、ID、类名、data 属性与全部 API 契约逐字段保留，视觉与交互无变化；legacy-slot 承接的面板收窄为「账号 / 状态」。
  - 数据流沿用混合期约定：频道数据以旧 app 的 `window.shiyue.state` 为单一数据源（原地修改 + tick 重绘），服务端往返统一走桥 `loadFeeds()` 刷新共享 state；侧栏下拉（`renderFeedSelect` / `renderReaderChannels`）与页面重载随操作同步。
  - 拖拽排序由 Pointer 事件移植（桌面 + 触屏通用）：频道组内重排 / 跨组落库 `/api/feeds/reorder`，分组重排落库 `/api/prefs`（groupOrder），拖拽过程有声明式落点指示。
  - 采集参数（管理员专属）进入面板拉 `/api/config` 回填；`cfgLoaded` 守卫复刻旧 `srcFormReady` 语义——没加载完禁止保存，避免把兜底值当成用户设置存下去。
  - 折叠分组状态按账号持久化（`users.prefs.layout.collapsedGroups`），可折叠 section 的开合同样按账号记住（复用 `bindSections` 机制，存档无缝衔接）。
- 迁移中顺手清理落后实现（遵循「技术落后 / 体验不好的可丢弃」原则）：
  - **修复「出网代理」不回填的 bug**：服务端 `GET /api/config` 原来漏返 `source.proxyUrl`，管理员重开面板代理输入框是空的，再点保存会被清空——本次服务端补返该字段，GET 与 POST 字段集一致。
  - 频道重命名由命令式就地改 `innerHTML` 改为受控编辑态（Enter 提交 / Esc 取消 / 失焦提交）。
  - 排序 / 跨组后同步刷新工具栏频道下拉（旧实现漏更 `renderFeedSelect`）。
  - 采集参数拉取失败不再把整个面板打成「读取失败」（频道列表正常展示，参数区保持兜底值并禁止保存，toast 报错）。
  - 增删频道后不再重复请求 `/api/config`（旧实现每次 add/delete 都重拉一遍全局配置）。
  - 行内控件保存期间逐控件禁用（`pendingIds`），防重复提交；保存失败时受控控件回滚到服务端值并报错误 toast。
  - 每频道频率 / 序号输入等即时生效路径都带非法输入复原。

---

新增：

- **「模型」设置面板 React 化**（React 渐进式迁移的 P2b 阶段）：面板迁往 `src/settings/ModelPane.jsx`，类名、ID、data 属性与请求体逐字段保留，视觉与交互无变化；legacy-slot 承接的面板收窄为「数据源 / 账号 / 状态」。
- 改造中顺势清理落后实现：表单由受控状态管理（旧实现裸读 DOM `.value`）；temperature 数值化后发送（旧实现传字符串、依赖服务端 `clampNum` 容错）；保存 / 清除成功后保留「已保存」结果提示（与旧表现一致），Key 输入框每次回填清空并回到掩码态（留空 = 不修改的服务端语义不变）。

---

## [1.3.0] — 2026-10-16

新增：

- **设置弹层 React 化**（React 渐进式迁移的 P2a 阶段）：
  - 弹层外壳（遮罩 / 标题 / tab 栏 / 关闭）与「外观」「关于」两个面板迁往 `src/settings/`，键位、类名、data 属性与 aria 全部保留，视觉与交互无变化。
  - 「数据源 / 模型 / 账号 / 状态」四个面板暂由旧 DOM 承接：装在 `#legacyPanes` 隐藏容器中，选中对应 tab 时由 React 外壳搬进 `.tab-pane-legacy` 插槽显示（移动节点，旧监听与 ID 全部保留，行为零变化），随后续版本逐个迁移后移除。
  - 旧 `openSettings` / `closeSettings` 委托给 React 宿主（`window.__settingsHost`），开合状态经 `window.__settingsOpen` 同步给 Escape 关闭 / j·k 键盘导航 / 自动刷新守卫；tab 切换副作用（表单加载、状态轮询启停）经 `window.shiyue.settingsTabEffect` 桥接。
  - 外观面板改造中顺势清理了落后实现：控件选中态不再由旧 `applyAppearance` 回写 DOM，React 从偏好数据直接推导；「GitHub 主题固定主色」不再轮询 `<html data-fixed-accent>`，由 `theme === 'github'` 等价推导；外部改动（顶栏主题按钮、恢复默认、localStorage 迁移）经 `window.__appearanceChanged` 事件回流同步。
  - 副标题（订阅源统计）提取为纯函数 `getSettingsSummary()`，宿主打开弹层与 `updateSourceSummary()` 共用同一份计算。

---

## [1.2.0] — 2026-10-16

新增：

- **前端接入 Vite + React 构建链**（React 渐进式迁移的 P0/P1 阶段）：
  - Vite 多页面双入口：`index.html` / `login.html` 移至仓库根；`public/` 经 `publicDir` 原样拷入 `dist/`，CSS 与旧交互逻辑零改动。
  - Dockerfile 改多阶段构建（builder 产出 dist → 运行时镜像只带生产依赖）；不再挂载 `./public:/app/public`，前端改动随镜像重建生效；`serveStatic` 优先读 `dist/`，未构建时回退 `public/`（fresh clone 可直接 `node server.js`）。
  - `npm run dev` 本地 Vite 开发（5173，`/api` 代理到 3000）。
- **⌘K / Ctrl+K 命令面板 React 化**（P1）：组件迁往 `src/cmdk/`（拼音表 / 命令构建 / 过滤 / 组件），键位、拼音过滤、分组与类名逐行等价，视觉与交互无变化；旧 app 通过 `window.shiyue` 桥向 React 组件提供能力（混合期临时方案，迁移完成后拆除）。
- 登录页内联样式外提为 `public/login.css`（规避 Vite 在 Windows 上处理内联 `<style>` 的路径 bug），并加入 sw.js 预缓存清单。

---

## [1.1.0] — 2026-10-16

新增：

- **「设置 → 关于」页面**：版本信息卡片（当前版本 / 仓库地址 / 许可）。
- **版本检测（检查更新）**：向 GitHub 查询最新 Release（未发布 Release 时回退 Tags 列表），提示是否有新版本并附发布链接；服务端结果缓存 10 分钟，避免频繁请求 GitHub API；网络不通时给出友好失败提示。当前版本取自 `package.json`，发布新 tag 后即被检测到。

---

## [1.0.0] — 2026-10-16

首个正式版本。包含：

- **自托管 RSS 阅读器**：左频道（按分组）右文章，点标题就地展开全文；已读 / 未读 / 收藏齐全，顶部搜索 + 可选网页自动刷新。
- **图文原样呈现**：图片按原文图文顺序内联排版，统一经服务端代理加载，源站防盗链也不裂图。
- **订阅源管理**：OPML 导入 / 导出（含分组、自动去重），频道名可自定义，单频道可设抓取频率。
- **卡片墙**：网格 / 列表展示资源卡片，可按频道、体积筛选与搜索。
- **AI 日报**：定时将过去 24h 新条目交大模型生成中文简报，按用户各自生成。
- **多用户与角色**：每人独立订阅源 / 已读 / 收藏 / 日报。
- **模型配置按账户绑定**：每个用户在「设置 → 模型」填自己的 Key，各自的日报用各自的模型；未填则回退管理员配的站点默认。管理员可管理用户与站点级设置。
- **外观可定制**：4 套主题、6 套主色，字号 / 字体 / 行高 / 阅读宽度可调；外观偏好按账户持久化。
- **移动端友好 + PWA**：可「添加到主屏幕」离线使用。
- **交互增强**：⌘K 命令面板（支持拼音过滤）、View Transitions 视图切换、阅读进度条、j/k/o/f/r 键盘导航、统一焦点环。
- **反代层 gzip 压缩**已开启。

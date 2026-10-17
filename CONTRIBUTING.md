# 面向开发者

本文档收录拾阅实现中容易踩的坑与内部约定，供改动代码前参考。普通用户请看 [README.md](README.md)。

## 后端要点

- **多用户 / 数据隔离**：`users` 表存账号（`username` 唯一、`scrypt` 派生哈希 + 盐、`role`、`prefs` JSONB）。隔离靠**数据模型**而不是查询时过滤：`feeds.owner_id` 是硬外键（`ON DELETE CASCADE`），`entries` 通过 `feed_id` 间接归属，`digests` 主键是 `(owner_id, date)`。唯一性也是按用户的 —— `UNIQUE (owner_id, url)` 写成**表级约束**（Postgres 自动生成同名索引 `feeds_owner_id_url_key`），`addFeed` 的 `ON CONFLICT (owner_id, url)` 才有约束可匹配；老库补的是同名 `CREATE UNIQUE INDEX`，新库因名字已存在而自动跳过，不会重复建索引。老库升级路径：`MIGRATIONS` 给 `feeds`/`digests` 补 `owner_id` 列、删掉旧的全局唯一约束与旧主键，`ensureAdmin()` 把 `settings.auth` 迁成首个管理员，`bootstrapOwnership()` 再把 `owner_id IS NULL` 的行回填给该管理员并收紧 `NOT NULL`（全部幂等，每次启动都跑）。
- **⚠️ `pg` 把 `BIGINT` 当字符串返回**：`uid` 来自会话、`user.id` 来自内存注册表，两者若类型不一致，`uid === user.id` 这类**严格比较会静默为 false**（例如「不能删除当前登录账号」的守卫会失效）。`loadUsers()` 里统一 `Number()` 归一化，新增比较用户 id 的代码请用同一套（或直接比 `numId()` 后的值）。
- **会话与权限**：Cookie 是 HMAC 签名的无状态载荷 `{ uid, u, exp }`，每次请求用 `uid` 去内存注册表 `usersById` 解析当前用户 —— 所以**改角色 / 删账号立刻生效**，不用等 Cookie 过期；账号被删则视为未登录。角色守卫集中在请求前段：`/api/status`、`/api/config`（站点级设置）、`/api/users*`、`/api/digest/test-llm` 都是管理员专属，普通用户拿 403。**每用户偏好**（`groupOrder`）走独立的 `/api/prefs`，不要再往 `/api/config` 里塞。
- **已读 / 收藏**是 `entries` 上的四个字段（`is_read` / `read_at` / `is_favorite` / `favorited_at`）。`GET /api/entries` 支持 `unread=1` / `fav=1` 叠加筛选，收藏范围按 `favorited_at` 倒序；`PATCH /api/entries/:id` 改单条，`POST /api/entries/read-all` 按当前筛选条件批量标已读（和列表查询共用同一套 `buildFilter`，所以「看到的」就是「被标掉的」）。`buildFilter` 里第一段就是归属子查询（`e.feed_id IN (SELECT id FROM feeds WHERE owner_id = $n)`），新增筛选条件请加在这里，别另起一套。两个清理函数都会跳过 `is_favorite = TRUE` 的条目。
- **抓取调度**：每分钟 tick 一次，只抓「距上次抓取已超过自己间隔」的频道（`feeds.refresh_minutes` 优先，为空则用全局 `refreshMinutes`）。手动「刷新全部」不看到期与否，全抓。
- **模型 API Key** 以 `enc.v1.<iv>.<tag>.<密文>` 形式存在 `settings.llm.apiKeyEnc`（AES-256-GCM，主密钥由 `cryptoSecret` 经 scrypt 派生，与 `sessionSecret` 分开，轮换会话密钥不会弄丢 Key）。内存里保留明文副本供调用模型，`GET /api/config` 只回 `apiKeySet` + 掩码。老版本写在 `llm.apiKey` 里的明文会在启动时自动迁成密文。
- **状态接口优先级**：`GET /api/status` 一次返回全部运行指标，且**刻意排在数据库就绪检查之前**——数据库连不上正是这个页面要报的事，被 503 挡掉就什么诊断信息都看不到。容器内存 / CPU 直接读 cgroup v2（`memory.current` / `cpu.stat`，v1 兜底），读不到就降级不显示。
- 列表接口**不返回正文**，展开某条时才单独取，避免响应过大。

## 前端容易踩的点

- **`src/core/app.js` 是 ES 模块，顶层就往下跑** —— 在靠前的位置同步调用一个「内部会读后面 `const` 常量」的函数，会踩 TDZ：`ReferenceError: Cannot access 'APPR_DEFAULTS' before initialization`，而且**整页 JS 就此中断、页面一片空白**，排查时很难第一时间想到是执行顺序。所以主题 / 视图 / 外观的首次应用统一延后到 `requestAnimationFrame` 里（DOM 早已就绪，晚一个 tick 不闪，`<head>` 内联脚本已先写好首屏值）。同理，`applyTheme()` 内部不要引用定义在它后面的 `APPR_VALUES` 这类常量。
- **颜色只引用语义 token，别写死色值**：`style.css` 顶部一次性定义全部变量，深色由 `html[data-theme="dark"]` 整体覆盖。主色分三个角色，混用就会出对比度问题 —— `--accent` 是**填充色**（按钮底、激活胶囊底、圆点），`--accent-text` 是**主色当文字/图标**用（深色下比 `--accent` 更亮、亮色下更暗，专为可读性补偿），`--accent-strong` 是填充色的 hover 态；填充色上的文字一律用 `--on-accent`（深色下主色偏亮，那里得用深色字而不是白字）。改色请改 `tools/gen-theme.mjs` 再重新生成 —— 脚本会把 12 套配色（6 主色 × 深浅）的对比度逐项校验一遍，任一项不达标就 `exit 1`。
- **图标基类不能漏**：所有图标都是 `<svg>` 引用顶部 sprite 里的 `<symbol>`，尺寸 / 描边 / 填充由基类规则统一给。这条规则里除了 `.ico`，还必须列上那些用**自己类名**的图标（`.search-ico` / `.sec-arrow` / `.art-caret` / `.rd-group-chip-*` / `.new-pill-ico`）—— 漏掉任何一个，那个 `<svg>` 就没有宽高约束，会被撑成一大块黑图形。写自动化断言时记得上下都卡：既不能是 0 尺寸，也不能超大。
- **字号全部用 `rem`**：`html[data-font-size="s|m|l"]` 改根字号就能整站等比缩放（15 / 16 / 17.5px）。新写 `font-size` 请用 rem，写 px 会让「字号」这个设置失效。阅读宽度也用 rem，这样调大字号时每行字数基本不变。
- **外观偏好在首屏就要定下来**：`<head>` 里的内联脚本负责在样式表之前把 `data-theme` / `data-accent` / `data-font-size` / `data-reader-*` 写进 `<html>`，否则会先按默认值画一遍再跳一下。`localStorage` 是用户可改的，脏值在那里也要兜一层（取不到就落回默认档）。`data-theme` 有四个合法值（`light` / `dark` / `github`，以及由 `data-theme-mode=auto` 按系统深浅解析），内联脚本要自己把 `github` 判掉 —— `github` 不进「跟随系统」。
- **滚动锁用计数**：设置面板、图片灯箱、频道抽屉都可能开着，`lockPageScroll()` / `unlockPageScroll()` 靠 `scrollLockCount` 配对；只给 body 写 `overflow:hidden` 在 iOS 上挡不住惯性滚动，必须 `position:fixed` + 负 `top`。
- **吸顶偏移量不写死**：阅读页头部吸在顶栏下面，`top` 取 CSS 变量 `--topbar-h`，由 `ResizeObserver` 实测顶栏高度写入 —— 屏宽、程序名显隐、刘海屏安全区都会改变它。
- **穿透只发生在遮罩空白处**：弹层内部（`.modal-body` 是 `overflow:hidden`）本来就不穿透。用真实浏览器验证滚动锁时，滚轮坐标要打在遮罩上，打在弹层里会得到假阳性。
- **折叠分组用原生 `<details>`**：键盘可操作、无障碍语义天然正确、不需要 JS 维护开合；JS 只负责把状态记进 localStorage，以及更新标题右侧的摘要行。**动态重绘的区域必须在每次渲染后再调一次 `bindSections(root)`** —— 状态页每 30 秒重绘，漏了这一步用户展开的分组会被冲掉。**（v1.6.0 起折叠分组的开合按账号持久化到 `users.prefs.layout.sections`；React 面板在挂载 / 重绘后经 `core.bindSections(ref)` 复用同一机制。）**
- **每个 tab 只能有一个滚动容器**：`.tab-pane` 是 flex 列（`flex:1; min-height:0`），`.pane-scroll` 负责滚，`.pane-foot` 固定。新增 tab 时漏了这条，内容会被 `.modal-body` 的 `overflow:hidden` 直接裁掉。
- **AI 页是「容器 + 子页」结构**：`#aiView` 是一个普通 `.wrap` 页面，内部用 `#aiNav`（`.ainav-btn[data-ai]`）+ 若干 `.ai-pane[data-ai-pane]` 靠 `hidden` 切换。加一个新 AI 功能只要三步：`#aiNav` 里加个按钮、加一个 `.ai-pane`、需要拉数据的话在 `AI_LOADERS` 里登记一个加载函数。当前子页记在 `localStorage`，`switchView('ai')` 会回到离开前那一页。**（v1.7.0 起 AI 视图已 React 化 —— 子页切换 / 加载见 `src/ai/AiView.jsx`，`AI_LOADERS` 与 `localStorage` 存储已退役，改按账号持久化 `layout.aiPage`。）**
- **角色显隐集中在一个函数里**：`applyRoleUI()` 按 `state.role` 决定管理员专属部分的显隐（模型 / 状态 tab、采集参数、用户管理、保存设置、日报设置），并在 `init()` 里拿到 `/api/session` 的 `role` 后调用一次。`switchTab()` 与 `switchAiPage()` 各自再兜一层（非管理员请求管理员 tab / 子页时回落），这样**深链**（`#ai/settings`）也不会漏进去。新增管理员专属 UI 时，请在 `applyRoleUI()` 里加一行，别在别处散着判角色。**（v1.6.0 起大部分管理员专属 UI 已移入各自 React 面板（按 `admin` 条件渲染），`applyRoleUI()` 现在只把 admin 标志推给设置弹层宿主；新的管理员专属 UI 直接在对应 React 组件里判 `isAdmin()`。）**
- **hash 只在启动时解析一次**（`init()` 里的路由），改 `location.hash` 不会重新路由 —— 深链是要在冷启动时用的。支持 `#ai`、`#ai/settings`、`#favorite`、`#unread`、`#cards`，以及老链接 `#digest`（落到 AI → 日报）。`localStorage` 里的老页面值 `'digest'` 也会被 `currentTab()` 自动迁成 `'ai'`。
- **视口高度一律用 `dvh`，不要用 `vh`**：手机浏览器的 `vh` 取的是「地址栏收起时」的大视口高度，比当前真正看得见的区域高，于是弹层底部的按钮、页面页脚会被地址栏压住。凡是「必须塞进可视区」的高度（弹层 `max-height`、遮罩与灯箱的高度、抽屉高度、图片 `max-height`）都写成 `100vh;` + `100dvh;` 两行 —— 不支持的浏览器自动回退，不会因为一条无效声明把整个属性丢掉。
  可滚动内容的底部另有一层保险：`@supports (height: 100svh)` 里给 `body` 补出 `clamp(0px, 100vh - 100svh, 140px)` 的 `padding-bottom`，也就是「浏览器底栏高度」。用 `svh`（静态）而不是 `dvh` 是为了避免滚动时高度来回抖；`clamp` 的下限防负值让整条声明失效，上限防个别 App 内置浏览器留出大片空白。桌面与 PWA 下 `100vh == 100svh`，这条等于不生效。

## 本机怎么验（没有 Docker / PostgreSQL 也能测）

改动**数据库或抓取逻辑**时不要只靠肉眼读代码 —— 这两块出错往往只在生产暴露（例如 `matchAll(PAN_RE)` 少写 `g` 会让整频道抓取静默失败）。

**后端：用 PGlite 跑真实 SQL。** `pg-mem` 是纯 JS 模拟，缺 `xmax`、不支持 `UPDATE` 目标表别名与 plpgsql，会把合法 SQL 判错；改用 **`@electric-sql/pglite`**（编译成 WASM 的真实 Postgres），上述语法与迁移里的 `DO $$` 块都能跑。做法：给 `pg.Pool` 写一个薄垫片（`query` / `connect` / `on` / `end`，`connect` 返回同一个单连接客户端即可，事务靠 `BEGIN` / `COMMIT` 正常走），再用 `Module._load` 把 `require('pg')` 换成垫片。垫片有个坑：**`SELECT` 的 `affectedRows` 是 0，不能直接当 `rowCount`**，否则 `hasDigest()` 之类 `rowCount > 0` 的判断会误判 —— 写成 `affectedRows || rows.length`。测完记得**两条路径都跑**：全新库（`migrate()` 直接建多用户结构）+ **老库升级**（手工造旧 schema → `migrate()` → `ensureAdmin()` → `bootstrapOwnership()`，断言数据没丢、归属回填、约束收紧）。

**前端：UI 回归测试（推荐先跑）。** `npm run test:ui` 在 jsdom 里挂载真实的 React 组件（设置弹层六面板 / AI 视图 / 卡片视图 / 阅读页 / 顶栏），核心逻辑用**替身**顶掉（`build.mjs` 把 `@core` 别名指向 `tests/ui/stub-core.js`）+ 迷你内存后端，跑 190+ 断言，秒级出结果、无需浏览器。测试资产在 `tests/ui/`（`ui-regression.cjs` 断言 + `mount-*.jsx` 挂载入口 + `stub-core.js` 替身 + `build.mjs` 用 esbuild 打包）。新增 React 组件时，建议同步补一个 `mount-*.jsx` 与对应断言。

**前端：假后端 + 无头 Edge（端到端兜底）。** `public/` 用假后端（纯内存 API）静态托管，CDP 连无头 Edge 用 `Runtime.evaluate` 取断言结果。几个反复踩过的坑：

- 工具沙箱内 Edge 起不来（sandbox init 失败），且**沙箱内外网络隔离** —— 假后端与 Edge 必须在同一侧；`&` 起的后台进程会随命令结束被杀，所以写成**一个** `/tmp/run-*.sh`：起假后端 → 等端口 → 起 Edge → 跑 CDP 脚本 → `trap` 收尾杀进程。
- 注入到 `index.html` 的自动测试脚本会**污染交互测试**（它点开某条后，你再点同一处等于把它收起，表现为「展开失效」）—— 注入必须按需开关（如 `?inject=1`）。
- `Page.navigate` 同文档只改 hash 不会触发 load，深链测试要塞 `?_t=<时间戳>`；`localStorage.setItem` 必须在导航到目标 origin **之后**。
- 用 `Page.captureScreenshot` 有时返回空，几何断言（`getBoundingClientRect`）比截图更可靠。
- 验证生产时只做只读冒烟；反代会挡 `python-urllib` 的 UA（403），脚本要带浏览器 UA。

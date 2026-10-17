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

## [2.5.0] — 2026-10-18

> 死链频道**自动处置**：连续失败达到阈值的频道自动停用采集（状态页可见），重试成功即自动恢复，不用再盯着一排 503 手动关。

### 1. 连续失败自动停用（仅采集，不动订阅）

- `feeds` 表新增 `fail_streak`（v19 迁移）：每次抓取失败 +1，成功 / 304 / 手动重启用时清零。
- 单轮抓取里某 URL 组失败即对组内所有频道累加；达到 `settings.source.feedFailLimit`（默认 5，可在「设置 → 数据源 → 采集参数」调整，夹取 2~20）且频道处于启用态时**自动停用**并记入日志；已达上限的停用态频道不重复触发。
- 失败/成功路径都会把 `last_status` / `last_error` 同步到该频道（此前只有首次/部分路径落库）。

### 2. 一键恢复

- 单个频道重试（`POST /api/feeds/:id/refresh`）**成功且该频道此前是被自动停用的**时，自动清零失败计数并恢复采集；用户手动停用的频道不受影响（尊重「我就是想关着」）。
- 数据源列表 PATCH 重新启用同样清零。

### 3. 状态页与可观测性

- 「运行与数据库」新增**数据库体积**卡片（`pg_database_size`，含索引、图片缓存另计）——线上已改为 `keepPerFeed=0 / keepDays=0`（条目只增不减），体积需要持续可见。
- 频道行新增「自动停用 N」计数（warn 色）与阈值说明行（含恢复方式）。
- 异常频道列表中，被自动停用的频道带**「已自动停用」徽标**，按钮文案变**「重试并恢复」**。
- 复制诊断文本同步：数据库体积、自动停用阈值与当前停用数、上次结果的自动停用数、异常频道是否已停用。
- `/api/status` 的 RSS 段新增 `feedFailLimit` 与 `feeds.autoDisabled`；抓取结果新增 `autoDisabled` 计数并写入日志。

---

> 图片缓存从「env -only」升级为**设置可调**，并新增**手动清空**入口；另修复一个线上 503 死链频道。

### 1. 图片缓存参数接入「采集参数」（仅管理员）

- 新增四个可调项（`settings.source`，落库保存，改完即时生效、无需重启）：
  - **图片回源窗口**（`imgTtlDays`，默认 7 天）：stale-while-revalidate 窗口，窗口内重复访问不再请求上游；
  - **图片保留**（`imgKeepDays`，默认 90 天）：缓存图片在库保留时长，超期由每日清理删除；
  - **图片最长边**（`imgMaxDim`，默认 1280 px）与 **图片质量**（`imgQuality`，默认 78）：WebP 压缩强度。
- `compressImage` 增加可选 `opts` 参数，模块级 env（`IMG_MAX_DIM` / `IMG_WEBP_QUALITY` 等）降级为首次落库的部署级默认值；旧环境变量 `IMG_CACHE_TTL_DAYS` 的兼容语义保留。
- GET / POST `/api/config` 字段集同步扩充；后端对脏值一律 `clampInt` 夹回区间而非报错。

### 2. 图片缓存统计 + 手动清空

- 新增 `GET /api/image-cache`（张数 / 体积统计）与 `POST /api/image-cache/clear`（清库 + 清 L1 内存，返回删除行数），均仅管理员。
- 「采集参数」区新增「图片缓存 N 张 · X.X MB + 清空图片缓存」一行：点击 confirm 后立即按当前压缩参数重新缓存全部图片。

### 3. 修复线上 503 死链频道

- `rsshub.9610000.xyz/gitee/releases/fj1994/fnos-iptv`（两个用户各订阅一份）持续 503。定位为**上游 gitee API v5 匿名限流（403）**导致该 RSSHub 实例所有 `/gitee/*` 路由失败，非 URL 错误、也无 GitHub 镜像可换源；已停用这两个频道的采集（订阅与已抓条目保留，待 RSSHub 侧恢复 gitee 访问后可随时再开）。

---

## [2.3.1] — 2026-10-17

> 修正 `/api/feeds/refresh` 失败列表的字段：抓取去重后结果按 URL 组归并，失败项原引用不存在的 `results[].feedId` 会返回 `undefined`，改为返回 `url`。前端只读 `.length`，`/api/status` 的频道级失败列表另走 `feeds` 表（仍带 `feedId`），均不受影响。

---

## [2.3.0] — 2026-10-17

> 两个性能与成本优化：**图片永久缓存**（落库 + 压缩，避免重复回源）、**抓取按 URL 去重**（多用户订阅同频道只抓一次）。

### 1. 图片永久缓存（落库 + 压缩，避免重复请求）

- 新增 `image_cache` 表（PostgreSQL `bytea`）：与文章同一套持久化存储，服务器重启不丢，不再有「内存缓存清空 → 全站重新回源」。
- `/api/img` 改为 **L1 内存 + L2 数据库** 两级缓存，并引入 **过期回源（stale-while-revalidate，默认 7 天）**：首次请求回源 → 压缩 → 落库；之后命中直接出，不再碰上游；超过窗口仍先返回旧图、后台静默刷新，兼顾「省带宽」与「头像/配图换了别永远陈旧」。
- 压缩：栅格图统一 `sharp` 缩到最长边 ≤1280px、转 **WebP q78**（典型从几百 KB 压到 30–120KB）；svg/ico 等不重编码、原样存。
- 保留 SSRF 主机拦截、8MB 上限、上游 4xx/5xx 透传等既有守卫。
- 新增按保留期（默认 90 天）清理图片缓存，限频每天一次。

### 2. 抓取按 URL 去重（多用户同频道只抓一次）

- `refreshFeeds` 现在先把 `allEnabledFeeds()` 按归一化 URL 分组；每个 URL 组**只 `loadFeed` 一次**，结果写回组内每一个 feed 行的 `entries` 与 meta（etag/last_modified 同步给所有订阅者）。
- 用「按 URL 的 in-flight Promise」做跨用户 / 跨「手动+定时」并发合并；保留 5s 节流防连点打爆源站。
- 净效果：N 个用户订阅同一频道 → 上游**只被请求 1 次**（条目仍按 feed 各存一份，用户隔离性不变）。

### 3. 部署相关

- 运行时基础镜像由 `node:22-alpine` 改为 `node:22-bookworm-slim`：图片压缩依赖 `sharp`（原生 libvips）的预编译二进制基于 glibc，在 Alpine(musl) 上加载会失败，Debian 上开箱即用。
- 新增依赖 `sharp`（运行时依赖，随镜像安装）。

---

## [2.2.5] — 2026-10-17

> 修复「部分频道图标加载不出来」（`/api/img` 代理拒绝 `data:` 内嵌图标、且把 `https:https://` 双协议头当非法地址）。

### 1. 频道图标：放行 data: 内嵌图标、归一化重复协议头

**现象**：设置 → 数据源里个别频道头像整片加载失败（破图标 / 空白）。

**根因**：所有外链图标都经 `/api/img` 代理；代理用 `new URL()` 解析时——
- 源给的是 `data:image/svg+xml;base64,...` 内嵌图标，协议不是 `http(s)` → 被判 `url not allowed` 返回 400；
- 个别源把图标写成 `https:https://cdn.x.com/...` 这种重复协议头，解析出的主机名是 `https:` → 抓取必然 504。

**修复**（`lib/dto.js` 新增 `cleanIcon`、`server.js` 的 `proxyImage` 兜底）：`data:` 图标直接原样返回给浏览器（本就是完整资源，无需代理）；`https:https://` 在代理入口与 DTO 两处都归一化成单协议头。

### 2. 频道头像加载失败兜底

**修复**（`src/settings/SourcePane.jsx`、`src/views/ReaderView.jsx`）：头像 `<img>` 加 `onError`，拉取 404 / 防盗链时回退到首字母占位，不再显示破图标。

### 3. 卡片图片说明

卡片大图仍全部来自 Telegram CDN（`cdn*.telesco.pe`），**绝大多数为正常时效内链接**；个别旧条目因上游 CDN 链接到期返回 404，已由 `LazyImg` 走占位图标正常降级，非代码缺陷。

---

## [2.2.4] — 2026-10-17

> 两个卡片页视觉误读修复（用户反馈）。

### 1. 无原文地址的卡片：不再渲染置灰「打开」按钮

**现象**：部分卡片的「打开」按钮是一个置灰、不可点的小方块，看起来像一把锁 / 卡片被上了锁，引人误会。

**根因**：条目缺 `sourceUrl` 与 `link` 时，`OpenButton` 渲染 `btn-open disabled`（opacity .45 + not-allowed 光标），视觉上读作「锁定」。

**修复**（`src/views/CardsView.jsx`、`src/views/ReaderView.jsx`）：无原文地址时干脆不渲染该按钮——复制按钮仍可用（资源网盘链接不受影响）。阅读页正文操作区同样处理。

### 2. 已读卡片不再整卡蒙灰

**现象**：标记已读的卡片整张变淡、像被遮罩盖住。

**根因**：`.card.is-read { opacity: 0.6 }` 把封面、按钮、文字一起压暗。

**修复**（`public/style.css`）：改为只压暗标题与摘要（`opacity: .55`），封面与操作按钮保持清晰；已读语义与阅读页一致（文字级弱化）。

**测试**：`tests/ui/ui-regression.cjs` 新增断言——有原文地址的卡片有可点「打开」，无原文地址的卡片不渲染「打开」。

---

## [2.2.3] — 2026-10-17

> 三个 bug 修复：两个来自全面验证发现的问题，一个来自用户反馈的阅读连贯性问题。

### 1. 修复阅读连贯性：上一篇未收起时，点下方文章会跳到错误位置（P3，最影响体验）

**现象**：手风琴模式（默认开启）下，展开文章 A 后向下滚动，点开下方的文章 B —— B 会整体向上跳，甚至滚出屏幕，停在完全不是用户点击的位置。

**根因**：`expandReaderArt()` 在手风琴模式下会**先把其它已展开的文章收起，再展开目标文章**。如果被收起的那篇（A）在目标文章（B）**上方**，A 一收起，列表在 B 上方就矮了一大截；而窗口 `scrollTop` 保持不变，于是 B 及下方所有内容整体**向上平移**了 A 正文的高度 —— B 就跳离了用户点击时的位置。

**修复**（`src/core/reader.js`）：
- 展开前记录目标文章的视口位置（`getBoundingClientRect().top`）；
- 收起其它 + 展开当前之后，在 `requestAnimationFrame` 里重新测量，用 `window.scrollBy` 把差值补回去，保证「点哪一篇、它就停在哪」。
- **用瞬时滚动而非平滑动画**：位移在一帧内被抵消最连贯（用户几乎看不到跳动），平滑动画反而会把这次修正放大成一次可见的滚动。
- 若被收起的那篇在目标文章**下方**，差值为 0，不会有多余滚动；非手风琴模式（多篇展开）本就不收起其它，也不触发补偿。

### 2. 图片代理不再把「上游 4xx」冒充成「502 网关错误」（P1）

`server.js` 的 `proxyImage` 把 `!resp.ok` 一律返回 `502 upstream N`。上游图片源明确返回 404 时，代理本身工作正常，却对外报网关错误 —— 排查时看到 502 会误以为代理/缓存坏了（v2.2.1 的教训）。改为**透传上游状态码**；网络层失败仍归 504。

### 3. 登录页默认凭据提示过时（P2）

`login.html` 硬编码「默认账号 admin / admin」，但 admin 密码一旦修改就与提示不符，且明示默认密码有暴露面。改为「默认管理员账号 admin（初始密码 admin），登录后请在「设置 → 账号」中修改」—— 描述的是初始状态，密码改了也不算错。

### 测试

build 成功；UI 204/204；deploy 护栏 5/5；Dockerfile 清单 + 标识符静态校验通过；后端单测 54/54。

---

## [2.2.2] — 2026-10-17

> **工程加固**：把 v2.2.1 事故的发现手法固化成部署护栏 —— 健康检查通过不再等于部署成功。

### 背景

v2.2.1 的 `imgCache` 事故是靠「部署后人工 grep 全站错误日志」抓到的。当时的健康检查只证明「进程活着」，对业务路径是否炸掉毫无感知 —— 容器 healthy、日志干净、测试全绿，但 `/api/img` 每个请求都在抛 `ReferenceError`。这意味着**下一次部署没人记得手动扫日志，故障就会静默上线**。

### 变更

- **`deploy.sh`：健康检查通过后新增启动期错误日志扫描**
  - 扫最近 10 分钟的 `app` 容器日志，关键词覆盖 `ReferenceError` / `TypeError` / `SyntaxError` / `MODULE_NOT_FOUND` / `Cannot find module` / `unhandled` / `uncaught` / `ECONNREFUSED` / `EADDRINUSE` / `panic`。
  - 命中即`exit 2`，**部署视为失败**，不会带着运行时错误继续上线（健康检查超时仍是 `exit 1`）。
  - 收尾打印 `VERSION`，避免部署完还要手动确认版本号。
- **新增 `tests/server/deploy-guard.cjs`**：5 项静态断言钉住这道护栏不被误删 —— 日志扫描存在、关键词齐全、健康检查通过后不直接 `exit 0`、扫到错误必须非零退出、超时路径非零退出。已用「把 `exit 0` 塞回健康检查分支」验证确实报 FAIL。接入 `npm run test:server` 与 CI。

### 结论

往后 `./deploy.sh` 跑完不需要再手工 `docker logs | grep` —— 它自己会拦。

---

## [2.2.1] — 2026-10-17

> **紧急修复**：v2.2.0 的重构误删了图片代理的缓存状态，`/api/img` 全线 500。

### 问题

v2.2.0 抽取后端纯函数时，用「起止锚点区间删除」清理 `isPrivateHost` 上方的旧代码，把紧随其后的 `IMG_CACHE_TTL` / `imgCache` 一并删掉了 —— 它们是被 `proxyImage` 闭包持有的**运行时状态**（6 小时内存缓存），不是纯函数，不该跟着搬走。

后果异常隐蔽：容器正常启动、健康检查通过、启动日志干净、`node --check` 通过、前后端测试全绿 —— 但**每一次请求 `/api/img` 都抛 `ReferenceError: imgCache is not defined`**。只有真正加载出带图文章的用户才会发现（46 个频道里绝大多数带图，实际影响面很大）。

### 修复

- `server.js` 补回 `IMG_CACHE_TTL` / `imgCache` 声明，并注释说明它们是运行时状态、不可搬入 `lib/`。

### 防回归

- **新增 `tests/server/server-globals.cjs`**：拿抽出之前的基线（默认 `v2.1.0`，可用 `SHIYUE_BASELINE` 覆盖）列出它声明过的顶层标识符，找出「消失但仍被裸引用」的：
  - 有顶部 `require` 解构 → 已从 `lib/` 引进，正常
  - 仍零散出现且无声明 → 漏删了运行时状态，报错退出
- 已用「临时再删一次 `imgCache` 声明」验证该脚本确实会报出 2 项（`IMG_CACHE_TTL` / `imgCache`）。
- 接入 `npm run test:server` 与 CI。

---

## [2.2.0] — 2026-10-17

> 后端可测试性：把埋在 `server.js` 里的纯函数抽到 `lib/`，首次为后端建立自动化测试。运行时行为不变。

### 为什么动后端

`server.js` 有 1927 行、28 个路由，但**零测试** —— 更根本的问题是它 `require` 即 `listen` + `db.start()`，测试根本无法触及它内部的逻辑。里面藏着一批典型的高风险纯函数：`clampInt/clampNum` 的边界、`sanitizeAppearance/sanitizeLayout` 的用户输入清洗、`parseOpml` 的正则解析、`encryptSecret/decryptSecret` 的加解密往返、`isPrivateHost` 的 SSRF 拦截。这些恰好都是「改错一行就出事、但手点测不出来」的部分。

### 变更

- **新增 `lib/`**（无副作用、无外部依赖，可直接 `require`）：
  | 模块 | 内容 |
  |---|---|
  | `lib/util.js` | `int` / `bool` / `clampInt` / `clampNum` / `normUrl` / `compareVersion` / `isPrivateHost` / `groupsOf` |
  | `lib/opml.js` | `parseOpml` / `parseOpmlAttrs` |
  | `lib/prefs.js` | `sanitizeAppearance` / `userAppearance` / `sanitizeLayout` / `userLayout` + 取值表 |
  | `lib/dto.js` | `toCard` / `toFeedDto` / `proxyBodyJson` / `proxied` |
  | `lib/crypto.js` | `encryptSecret` / `decryptSecret` / `maskSecret` / `hashPassword` / `safeEqual` |
  | `lib/llm.js` | `llmForStore` / `sanitizeUserLlm` / `userLlmForStore` / `userLlmForView` / `resolveUserLlm` |
- **去隐式全局改显式传参**：原先直接读模块级 `settings` 的函数改为由调用方传入 —— `toFeedDto(f, globalRefreshMinutes)`、`resolveUserLlm(user, siteLlm, cryptoSecret)`、`encryptSecret(plain, cryptoSecret)`、`*ForStore(x, cryptoSecret)`、`*ForView(prefs, cryptoSecret)`。这是让它们可测的前提。
- `server.js` 净减约 12 KB，其余逻辑与接口**零变化**。

### 测试

- 新增 `tests/server/unit.test.js`（`node:test`，零依赖、零外部服务），**54 项全绿**。重点覆盖：
  - `isPrivateHost`：`169.254.169.254`（云元数据）、各私有段、IPv6 一律拦下；`8.8.8.8` / `172.15/32` 等正确放行
  - `encryptSecret` / `decryptSecret`：往返一致、**密钥漂移**返回空串、密文篡改返回空串、每次 iv 随机
  - `sanitizeAppearance` / `sanitizeLayout`：白名单过滤、**原型污染尝试被丢弃**、`accordion` 只有显式 `false` 才关、`collapsedGroups` 截断到 40 字符、`sections` 强制布尔
  - `parseOpml`：嵌套文件夹路径、自闭合空文件夹不污染后续、`text` 是 `title` 的回落、脏输入不抛
  - `toCard` / `toFeedDto`：**所有外链图片必须改写为 `/api/img` 代理**、`own` 频率优先于全局、从未抓取时 `nextRefreshAt` 为 `null`
  - `resolveUserLlm`：用户配置优先、未配逐字段回退站点、密文解不开时回退站点 Key
  - `clampInt` / `clampNum`：上下界夹取、脏值回落、默认值超界也夹住
- **Dockerfile 补 `COPY lib ./lib`** —— 这是本轮唯一的部署阻断项：原来只拷根目录 5 个 js，抽到 `lib/` 后镜像构建照样成功，但容器启动会 `MODULE_NOT_FOUND`。本地与普通 CI 都发现不了。
- **新增 `tests/server/dockerfile-files.cjs`**：从 Dockerfile 解析最终镜像的 COPY 清单，按 `server.js` 的 require 图逐个核对。这类"构建通过但运行时崩"的坑从此在 CI 就暴露（已用「临时删掉 `COPY lib`」验证过该脚本确实会报错）。
- `package.json` 新增 `test:server`（清单校验 + 单测）与 `test`（串跑前后端）；CI 增加「后端单测 + Dockerfile 清单校验」一步。

### 顺带评估：index.html 静态骨架

评估结论是**不再收敛**，理由已写进开发文档：`<head>` 的主题引导脚本必须阻塞内联（挪进 bundle 会造成首屏主题闪烁）；SVG sprite 内联对离线 / SW 最稳，外置会多一次请求；3 个视图容器的 `hidden` 切换理论可进组件，但那正是 v1.10.0 踩过 `display: contents` 网格塌陷的位置，为 6 行 HTML 冒布局回归风险不划算。

---

## [2.1.0] — 2026-10-17

> 架构整理：拆分核心单文件、接入 CI、覆盖层 React 化。对外接口零变更。

### A1 · 核心逻辑拆分

- **`src/core/app.js` 退役**，按职责拆成 8 个 ES 模块，**依赖单向无环**：
  `util.js`（DOM 选择器 / `apiFetch` / 格式化 / toast / 链接菜单）→ `state.js`（全局 `state`、layout/appearance/theme 偏好、滚动锁、设置弹层开合）→ `feeds.js`（频道加载 / 卡片分页 / 筛选 / 视图模式）→ `reader.js`（文章数据、抽屉 / 手势 / 无限滚动 / 键盘导航）→ `autorefresh.js`（定时刷新 / 新内容浮标）→ `ui.js`（刷新 / OPML / `switchView` / 灯箱 / 折叠分组 / 安装提示 / `shellSnapshot`）→ `bootstrap.js`（首屏主题与视图、登录态校验、首次加载、深链）→ `index.js`（汇总 `core` 单例）。
- **组件零改动**：`@core` 别名仍指向 `src/core/index.js`，`core.*` 接口一一保持。
- 删除拆分过程中发现的重复导出 `prefersReducedMotion`（`util.js` 与 `state.js` 各有一份）。

### A2 · 持续集成

- 新增 `.github/workflows/ci.yml`：push / PR 到 `main` 时自动跑 `npm ci` → `npm run build` → `npm run test:ui` → `node --check server.js`（Node 22）。

### A3 · 清理

- 全仓代码注释、`README.md`、`CONTRIBUTING.md`、`docs/开发文档.md` 中的 `src/core/app.js` 路径引用统一更新为 `src/core/*.js`。
- `index.html` 里三段指令式覆盖层 DOM 移除（见下），净减 ~15 行。

### A4 · 覆盖层 React 化

- **`toast` / 「N 条新内容」浮标 / 图片灯箱改由 `src/ui/Overlays.jsx` 渲染**，挂载到新的 `#overlaysRoot`。
- 核心侧不再直接改 DOM，改为维护状态（`util.toastState` / `autorefresh.newPillState` / `ui.lightboxState`）并派发 `__overlaysTick`，组件监听后重读快照重绘 —— 与顶栏 `__shellTick` 同一套范式。
- 新增 core 接口：`getToastState` / `getNewPillState` / `getLightboxState` / `applyPendingFresh` / `openLightbox` / `closeLightbox`。
- CSS 与类名零改动（`.toast` / `.new-pill` / `.lightbox` 全部沿用）。
- **至此页面上不再有任何由核心直接操作的展示性 DOM。**

### 测试

- `npm run test:ui` 新增 9 项覆盖层用例（toast 三态 / 浮标显隐与点击 / 灯箱渲染与关闭），**204 项全绿**。
- 挂载点回归断言扩充到 8 个（含 `overlaysRoot`）。
- 真实核心冒烟用例的接口清单同步补上 6 个覆盖层接口。

---

## [2.0.0] — 2026-10-17

> **MAJOR：前端架构收口。** 渐进式 React 迁移完成——不再有并行的经典脚本，也不再依赖 `window` 全局桥。

变更（破坏性）：

- **核心逻辑迁入 Vite 模块图**：原 `public/app.js` 整体迁为 `src/core/app.js`（ES 模块），末尾 `export const core = {…}`；`src/core/index.js` 再导出。`vite.config.mjs` 新增 `resolve.alias { '@core': src/core/index.js }`，全部组件改为 `import { core } from '@core'`，不再读写 `window.shiyue`。
- **`window.shiyue` 桥拆除**：`window` 上不再挂任何应用桥；组件与核心之间是普通模块引用。
- **`public/app.js` 退役**：文件删除，`index.html` 只保留唯一的 `<script type="module" src="/src/main.jsx">` 入口（`main.jsx` 先 `import '@core'` 初始化核心，再挂载各组件）。
- **Service Worker**：预缓存移除 `/app.js`，`VERSION` 升到 `shiyue-v2`（旧缓存随 `activate` 清理）。

保持不变：

- 视觉、类名、DOM 挂载点与交互零变化：核心仍以「共享状态 + 窗口事件（`__cardsTick` / `__readerTick` / `__shellTick` / `__viewChanged` / `__appearanceChanged`）」驱动 React 视图重绘，两种协作范式（自持状态 / 共享状态 + tick）沿用。
- `toast` / 新内容浮标（`#newPill`）/ 图片灯箱（`#lightbox`）仍是 `index.html` 里的指令式外挂，由 `core` 直接操作 DOM（转瞬即逝的提示与全屏遮罩用命令式更直接）。
- 服务端 / 数据库无改动。

验证：

- UI 回归 **195/195**：组件通过 `@core` 别名指向 `tests/ui/stub-core.js`（读 Node 的 `globalThis.__uiCore`，即测试那份桩）被完全接管；冒烟用例改为在 jsdom 里真实执行打包后的核心模块（`core-entry.js` → `.build/core-iife.js`），断言顶层无异常且 `core` 接口齐全。
- 真实产物端到端自检（jsdom 内联 `dist` bundle + `index.html`）：无报错，7 个挂载点全部渲染，`window.shiyue === undefined`。
- `npm run build`：44 模块，`index-*.js` 369.63 kB（gzip 115.48 kB）；`dist/` 内已无 `app.js`。

## [1.10.1] — 2026-10-17

移除：

- **「新版本已发布，点此刷新生效」提示条**（用户要求移除）：删掉前端 `checkAppBuild()` / `showUpdateBar()` 与 `apiFetch` 里的调用、`.updBar` 样式，以及服务端 `X-App-Build` 响应头与 `APP_BUILD` 常量。旧标签页此后不再自动提示更新（如需拿到新代码，手动刷新即可）；「关于」页的版本检查（`/api/version/check`）与手动「检查更新」不受影响。

## [1.10.0] — 2026-10-17

新增：

- **App Shell 顶栏 + 顶部阅读进度条 React 化**（React 渐进式迁移 P4 收尾的第一块，即「迁移残留胶水」）：顶栏（品牌 / 视图导航 / 条资源统计 / 刷新 / 添加到手机 / 主题 / 设置）与阅读进度条迁往 `src/shell/TopBar.jsx`，分别挂载到 `index.html` 的 `#topbarRoot`（即 `<header class="topbar">` 本身）与 `#shellRoot`；类名 / ID / 视觉与交互保持不变。**三大视图 → 设置弹层 → 顶栏外壳，React 化已覆盖全部可见页面层。**
  - 数据经桥 `getShell()` 一次性快照读取；旧 app.js 需要刷新顶栏时派发 `window.__shellTick`，组件监听后重读快照重绘。交互回桥：`switchView` / `refresh` / `cycleTheme` / `openSettings` / `promptInstall`。
  - 顶栏「刷新」按钮的忙态（禁用 + 图标自旋）改由组件本地维护；原 app.js 中的刷新逻辑抽为 `refreshFeeds()` 并经桥 `refresh` 暴露。
  - 「顶栏高度 → CSS 变量 `--topbar-h`」（阅读页头部窄屏吸顶依赖）由组件用 `ResizeObserver` 实测维护；阅读进度条的滚动驱动（rAF 节流）亦下沉组件。
- 旧 app.js 清理：移除 `statCount` / `subtitle` DOM 常量与直接写入、`#viewNav` / `#refreshBtn` / `#settingsBtn` / `#themeBtn` 事件绑定、`syncViewNav`（改为 `emitShell` 派发事件）、`syncTopbarHeight`、`updateProgress` 及未再使用的 `$$` 选择器。

修复：

- **文章页布局错位**（v1.9.0 引入的回归）：阅读页 React 化后，视图内容外面多了一层 `#readerRoot` 挂载点，而 `.reader` 是 `grid-template-columns: 232px minmax(0,1fr)` 的两列网格 —— 侧栏与正文被整体塞进 232px 的第一列，页面看起来「不见了 / 位置错误」。修复：新增 `.reader > #readerRoot { display: contents; }`，抹掉这层盒子、还原两列网格（并加 UI 回归断言钉死该规则）。

## [1.9.0] — 2026-10-17

新增：

- **「文章」视图 React 化**（React 渐进式迁移的 P3c 阶段，也是三大视图的最后一块）：视图内容整体迁往 `src/views/ReaderView.jsx`，挂载到 `index.html` 的 `#readerRoot`（外层 `#readerView` 容器仍由旧 `switchView` 控制显隐）；类名 / ID / data 属性、视觉与交互保持不变。**至此三大视图（文章 / 卡片 / AI）全部 React 化。**
  - 渲染覆盖：左侧频道侧栏（范围入口 全部/未读/收藏、分组行、频道项与未读徽标、添加频道）、头部（标题、手风琴开关、全部已读、全部收起、频道抽屉按钮）、阅读页搜索框、条目列表（未读/已读/收藏态、展开箭头）、展开后的正文（图文按原顺序内联、图片经 `/api/img` 代理、句读分段、发布时间、标签、复制/打开）、空态（各种文案）、加载更多、滚动哨兵、页脚。
  - 采用 **「共享状态 + tick」** 范式（同卡片视图）：数据与逻辑仍归旧 app.js（`state.rdEntries` / `rdExpanded` / `rdBody` / `rdScope` / `rdFeedId` / `rdGroup` / `rdQ` / `rdFlags`，以及 `loadReader` / 展开取正文 / 已读收藏 / 抽屉 / 边缘手势 / 无限滚动 / 键盘导航 / 自动刷新）；控件经桥 `readerSetScope` / `readerSetFeed` / `readerSetGroup` / `readerSearch` / `readerToggleArt` / `readerToggleFav` / `readerCollapseAll` / `readerReadAll` / `readerTagToCards` / `readerToggleAccordion` / `readerToggleDrawer` / `readerCloseDrawer` / `readerOpenSource` 改共享 state；app.js 需刷新阅读页 UI 时派发 `window.__readerTick`。
- 迁移中顺手清理落后实现（遵循「技术落后 / 体验不好的可丢弃」原则）：
  - 正文由 `innerHTML` 字符串拼接（`artBodyHtml` / `artItemHtml` / `renderReaderChannels` / `renderReader`）改为 JSX 组件；分段纯函数（`splitLongLine` / `bodyParagraphs` / `parseBlocks`）下沉组件。
  - 展开 / 收起、已读 / 收藏由就地改 DOM（`expandArt` / `collapseArt` / `paintEntryFlag`）改为改共享 state 后 tick 重绘；正文懒加载改为「展开时写入 `state.rdBody`、组件按 state 渲染」。
  - 无限滚动哨兵由 `IntersectionObserver`（加载时元素尚未存在）改为窗口滚动监听（与卡片页统一）。
  - 抽屉边缘手势对 `#readerSide` / `#readerMask` 改为惰性查询（React 渲染的节点在脚本加载时还不存在）。
  - 清理阅读页迁出后彻底无引用的旧函数：`bindCardActions` / `copyBtnHtml` / `openBtnHtml` / `copyableLinks` / `doCopy` / `icon`（app.js 2371 → 1892 行）。
- **测试**：UI 回归测试补 ReaderView 套件（渲染 / 展开收起 / 收藏 / 标签跳转 / 范围与频道切换 / 搜索去抖 / 空态）与两条**冒烟断言**（加载真实 `index.html` + `app.js`，断言顶层无异常、`window.shiyue` 桥函数齐全）——后一条正是为拦截本次迁移中出现过的「桥引用未定义函数导致 app.js 顶层抛错」；共 **179/179**。

---

## [1.8.2] — 2026-10-16

修复：

- **修复「设置按钮点击无反应」**：`index.html` 的 React 挂载点 `#settingsRoot` 在 v1.7.0（AI 视图 React 化）的 HTML 手术中被误删（替换区间跨过了它），导致设置弹层不再挂载、`window.__settingsHost` 未注册，点击顶栏「设置」无任何反应。本次补回该挂载点。**影响范围：v1.7.0 ~ v1.8.1 线上版本。**
- **补回归防护**：`npm run test:ui` 新增断言，钉死 `index.html` 的四个 React 挂载点（`#settingsRoot` / `#cmdkRoot` / `#aiRoot` / `#cardsRoot`）与入口脚本引用次数，防止同类「手术误删挂载点」再次发生。

---

## [1.8.1] — 2026-10-16

工程收尾（无用户可见变更，为 v2.0.0 拆桥做准备）：

- **UI 回归测试纳入仓库**：把原本散在本地缓存目录的 jsdom 运行时测试迁入 `tests/ui/`（`ui-regression.cjs` 断言 + `mount-*.jsx` 三个挂载入口 + `build.mjs` 用 esbuild 打包），新增 `npm run test:ui` 脚本与 `jsdom` / `esbuild` devDependency —— 现在在干净环境（含 CI）也能一键复跑 160+ 断言，覆盖设置弹层六面板 / AI 视图 / 卡片视图。
- **清理迁移后死代码**：移除 `app.js` 中迁移后已无引用的 `showResult()`、`ADMIN_TABS`、`APPR_KEY` 与 `state.config` / `state.digest` 字段（设置面板 / AI 视图迁出后遗留）。
- **文档**：README / CONTRIBUTING / 开发文档补充「两种迁移范式」（自持状态 vs 共享状态 + tick）、UI 测试运行方式、P3c（文章视图）待迁与 P4 拆桥清单。

---

## [1.8.0] — 2026-10-16

新增：

- **「卡片」视图 React 化**（React 渐进式迁移的 P3b 阶段）：视图内容整体迁往 `src/views/CardsView.jsx`，挂载到 `index.html` 的 `#cardsRoot`（外层 `#cardsView` 容器仍由旧 `switchView` 控制显隐）；类名 / ID / data 属性、视觉与交互保持不变。
  - 数据与状态仍由旧 app.js 持有（`state.entries` / `tags` / `q` / `tag` / `feedFilter` / `sort` / `size` / `view` / `hasMore` / `loading`，以及 `loadPage` / 自动刷新 / 收藏 PATCH 等逻辑）；组件只负责渲染 + 控件，控件经桥 `cardsSearch` / `cardsFilterFeed` / `cardsSort` / `cardsSize` / `cardsView` / `cardsTag` / `cardsLoadMore` / `cardsSetFlag` 改共享 state；app.js 每次需要刷新卡片 UI 时派发 `window.__cardsTick`，组件监听后读实时 state 重绘（沿用 SourcePane 的「共享状态 + tick」约定）。
  - 渲染覆盖：工具栏（搜索框 / 频道筛选 optgroup / 排序 / 体积筛选 / 卡片·列表视图切换）、标签栏、卡片网格与列表行（懒加载图片 + 失败重试一次再兜底、来源短名、体积、日期、标签、复制 / 打开按钮）、骨架屏、各类空态（无订阅源 / 卡片开关全关 / 无匹配 / 该标签无内容 / 加载失败）、加载更多、页脚。
  - 跨视图共享机制仍留在 app.js：自动刷新 / 新内容浮标（`fetchHead` / `applyFresh` / `checkForNew`）、`j/k` 键盘导航（`kbdItems` 查 `#grid` 内 `.card`/`.row-item`）、收藏 / 已读（`cardSetFlag`）、`/` 聚焦搜索（经 `window.__cardsFocusSearch` 委托到组件输入框）。
- 迁移中顺手清理落后实现（遵循「技术落后 / 体验不好的可丢弃」原则）：
  - 卡片 / 列表由 `innerHTML` 字符串拼接（`cardHtml` / `rowHtml`）改为 JSX 组件；骨架屏由命令式 `innerHTML` 改为 JSX。
  - 空态、加载态、视图模式高亮由就地操作 DOM（`emptyBox` / `loadMoreBtn` / `viewModeEl`）改为 React 条件渲染；首屏失败由改空态文案改为 `state.loadError` 标志驱动。
  - 收藏 / 已读由就地改 DOM 类名（`paintCardFlag`）改为改共享 state 后 tick 重绘。
  - 频道筛选兜底（筛选频道被删 / 关卡片开关后回落全部）从 `renderFeedSelect` 移入 `loadFeeds`。

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

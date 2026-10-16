# 拾阅 · shiyue

> 拾取值得读的 —— 一个干净、顺手的**自托管 RSS 阅读器**，附资源卡片墙与每日 AI 简报。多用户、无广告、无遥测，数据都在你自己的服务器上。

## 功能

- **专注阅读**：左频道（按分组）右文章，点标题就地展开全文；已读 / 未读 / 收藏齐全，顶部搜索 + 可选自动刷新。
- **图文原样呈现**：图片按原文顺序内联，统一经服务端代理加载，源站防盗链也不裂图。
- **订阅管理**：OPML 导入 / 导出（含分组、自动去重），频道名可自定义，单频道可设抓取频率。
- **卡片墙**：网格 / 列表展示资源卡片，可按频道、体积筛选与搜索。
- **AI 日报**：定时把过去 24h 新条目交大模型生成中文简报，按用户各自生成。
- **外观可定制**：4 套主题、6 套主色，字号 / 字体 / 行高 / 阅读宽度可调，即时生效。
- **多用户与角色**：每人独立订阅源 / 已读 / 收藏 / 日报；**模型配置按账户绑定**（自己的 Key 优先，未配回退站点默认）；管理员可管理用户与站点级设置。
- **移动端友好 + PWA**：可「添加到主屏幕」离线使用。

## 快速开始

需要 **Docker（含 Compose）**。

```bash
git clone https://github.com/chensnails/shiyue.git
cd shiyue
cp .env.example .env      # 至少把 PG_PASSWORD 改成强密码
docker compose up -d --build
```

打开 `http://<主机>:3210`，默认账号 **admin / admin**，登录后请到「设置 → 账号」改密码。

**上手三步**：①「设置 → 数据源」粘贴 RSS / Atom 添加频道，或导入 OPML；② 想要 AI 日报，「设置 → 模型」填大模型地址与 Key（管理员也可在「设置 → 模型」配站点默认），再到「AI → 日报设置」打开自动生成；③ 回「文章」页开始读。

## 配置（`.env`）

除端口与数据库外，其余项**首次启动后一律以页面「设置」为准**，再改 `.env` 不生效。关键变量见 `.env.example`；`.env` 不入库。

## 多用户与角色

| 角色 | 权限 |
| --- | --- |
| **管理员** | 全部功能 + 用户管理、站点级设置（采集参数 / 状态 / 日报设置 / 模型站点默认） |
| **普通用户** | 自己的订阅源、外观、AI 日报与**个人模型配置**（与管理员能力一致，仅不能管理用户与站点级设置） |

- 账号只由管理员创建，无开放注册。
- 不同用户订阅同一 URL 互不影响；频道 / 文章 / 已读 / 收藏 / 日报均按账号隔离。
- **模型配置按账户绑定**：每个用户在「设置 → 模型」填自己的 Key，各自的日报用各自的模型；未填则用管理员配的站点默认兜底。
- 删除用户会级联删除其数据，不可恢复；系统拦截「删最后一个管理员」「删除自己」。

## 部署与更新

在服务器把项目目录设为 git 工作树，一条命令更新：

```bash
cd <项目目录>
./deploy.sh        # = git pull --ff-only && docker compose up -d --build
```

- 前端已接入 **Vite 构建**（入口 `index.html` / `login.html` 在仓库根，React 源码在 `src/`）：任何改动都要 `docker compose up -d --build` 重建镜像才生效（ARM 服务器约 +30~60s）。**三大视图（文章 / 卡片 / AI）、设置弹层六面板与 App Shell 顶栏均已 React 化**，旧 `public/app.js` 现主要承担逻辑 / 状态与残留胶水。
- 本地纯前端联调：`npm ci && npm run dev`（Vite 5173，`/api` 代理到本地 3000 的后端）。
- **UI 回归测试**：`npm ci && npm run test:ui`（jsdom 中挂载真实 React 组件，覆盖设置弹层六面板 / AI 视图 / 卡片视图，160+ 断言）。
- 部署后端与前端一起重建；页面本身不主动提示更新（如需拿到新代码，请手动刷新）。

## 在手机上用（PWA）

HTTPS 下用浏览器「添加到主屏幕」即可当 App；建议用反向代理挂域名与证书。

## 常见问题

- **图片裂图？** 图统一经服务端 `/api/img` 代理；大量裂图多半源站失效，可到「设置 → 状态」查看。
- **别人能看到我的订阅吗？** 不能，全部按账号隔离。
- **数据备份？** 备份 PostgreSQL 数据卷（`db` 服务）。
- **怎么知道有没有新版本？** 「设置 → 关于 → 检查更新」（向 GitHub 查最新 Release，结果缓存 10 分钟）。
- **端口占用？** 改 `.env` 的 `HOST_PORT` 后 `docker compose up -d`。

## 技术栈与结构

Node 22（内置模块 + `pg` / `undici`）+ PostgreSQL + **Vite + React 渐进迁移**的前端：入口 `index.html` / `login.html` 在仓库根，新交互写在 `src/`，旧交互 `public/app.js` 逐步迁入。

```
server.js  ── 单进程 HTTP 服务：路由 / 静态资源 / 定时调度
 ├─ db.js      PostgreSQL 连接、迁移、按用户隔离的 CRUD
 ├─ rss.js     RSS/Atom/RDF 解析 + 图文顺序块
 ├─ digest.js  AI 日报生成（按用户各生成一份）
 └─ proxy.js   出网代理（图片 / 抓取走代理）
        ▼
   PostgreSQL（users / feeds / entries / settings / digests）
```

| 路径 | 说明 |
| --- | --- |
| `server.js` / `db.js` / `rss.js` / `digest.js` / `proxy.js` | 后端 |
| `index.html` / `login.html` | 前端入口（Vite 多页面双入口） |
| `src/` | React 组件（`shell/` 顶栏与进度条、`cmdk/` 命令面板、`settings/` 设置弹层六面板、`ai/` AI 视图、`views/` 文章与卡片视图） |
| `tests/ui/` | UI 回归测试（jsdom 运行时挂载，`npm run test:ui`） |
| `public/` | 静态资源与旧交互（`app.js` / `style.css` / `sw.js`，构建时原样拷入 dist） |
| `tools/gen-theme.mjs` | 生成并校验主题配色 |
| `docker-compose.yml` / `Dockerfile` | 编排与构建 |

数据模型：`feeds` 带 `owner_id`，`entries` 经 `feed_id` 归属用户，`digests` 主键 `(owner_id, date)` —— 隔离是数据库层面的。

## 开发文档

架构、部署、权限、数据模型、版本发布等详见 [docs/开发文档.md](docs/开发文档.md)。

## 许可

[MIT](LICENSE)。

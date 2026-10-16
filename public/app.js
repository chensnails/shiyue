'use strict';

/* ---------------- 常量 ----------------
 * 分页长度固定：卡片页 50 条，文章页 40 篇。
 */
const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_READER_PAGE = 40;

/* ---------------- 状态 ---------------- */
const state = {
  entries: [],
  offset: 0,
  hasMore: true,
  loading: false,
  loadError: false,   // 首屏加载失败（React 卡片视图据此显示错误空态）
  q: '',
  sort: 'new',        // 阅读页排序：new 最新 / old 最早 / name 名称（按账号持久化）
  size: 'all',
  tag: null,
  view: 'grid',       // 'grid' 卡片视图 | 'list' 列表视图（按账号持久化）
  pageSize: DEFAULT_PAGE_SIZE,
  readerPageSize: DEFAULT_READER_PAGE,
  tagline: '拾取值得读的',
  feedFilter: null,   // 列表页的频道筛选：null = 全部已开启卡片开关的频道
  feedList: null,     // /api/feeds 的 feeds 数组
  feedMeta: null,     // /api/feeds 的整体信息（total / enabled / cardEnabled / groups）
  groupOrder: [],     // 分组顺序（显式保存的串名数组，未分组不计入）
  collapsedGroups: new Set(),  // 分组折叠状态（折叠的分组名集合，按账号持久化）
  tags: [],           // 服务端返回的标签计数
  username: null,
  role: null,         // 'admin' | 'user' —— 决定设置里哪些 tab / 分组可见

  /* ---- 阅读页（文章）----
   * 跟卡片页各自持有自己的一份列表，互不干扰：阅读页按「当前选中的频道」拉，
   * 卡片页按工具栏的筛选条件拉。展开状态只存在内存里，刷新页面就回到全部收起。 */
  tab: 'reader',        // 当前页面：reader 文章 / cards 卡片 / ai AI（按账号持久化）
  rdScope: 'all',       // 阅读页默认范围：all 全部 / unread 未读 / favorite 收藏（按账号持久化）
  rdFeedId: null,       // 阅读页选中的频道：null = 全部已开启频道
  rdGroup: null,        // 阅读页选中的分组：null = 不限分组；'' 表示「未分组」
  rdQ: '',              // 阅读页搜索关键词（走服务端检索）
  rdFlags: { total: 0, unread: 0, favorite: 0 },   // 侧栏「全部 / 未读 / 收藏」的计数
  rdEntries: [],
  rdOffset: 0,
  rdHasMore: true,
  rdLoading: false,
  rdExpanded: new Set(),   // 已展开的条目 id
  rdBody: new Map(),       // id -> 正文（展开时才拉，拉过就缓存）
  rdBodyErr: new Set(),    // 拉正文失败的 id，避免反复重试
  rdReadError: false,      // 首屏加载失败（React 阅读页据此显示错误空态）
  rdReadErrorMsg: '',
};

/* ---------------- 按账号保存的 UI 布局偏好 ----------------
 * 视图模式 / 当前页面 / 分组折叠 / 阅读手风琴 / AI 子页 / 设置分组开合 /
 * 阅读页排序方式 / 阅读页默认范围，
 * 统一按账号维度持久化到服务端（users.prefs.layout），不再落浏览器 localStorage，
 * 换设备也一致。首屏初值由 server.js 注入的 window.__LAYOUT__ 提供。
 * 单一可信源是 window.__LAYOUT__（缺省回落默认）。 */
const LAYOUT_DEFAULTS = { view: 'grid', tab: 'reader', collapsedGroups: [], accordion: true, aiPage: 'digest', sections: {}, sort: 'new', rdScope: 'all' };
const LAYOUT_VALUES = { view: ['grid', 'list'], tab: ['reader', 'cards', 'ai'], aiPage: ['digest', 'settings'], sort: ['new', 'old', 'name'], rdScope: ['all', 'unread', 'favorite'] };
function sanitizeLayoutLocal(raw) {
  const out = Object.assign({}, LAYOUT_DEFAULTS);
  if (raw && typeof raw === 'object') {
    if (LAYOUT_VALUES.view.indexOf(raw.view) >= 0) out.view = raw.view;
    if (LAYOUT_VALUES.tab.indexOf(raw.tab) >= 0) out.tab = raw.tab;
    if (Array.isArray(raw.collapsedGroups)) {
      out.collapsedGroups = raw.collapsedGroups.filter((g) => typeof g === 'string').map((g) => g.slice(0, 40));
    }
    out.accordion = raw.accordion === false ? false : true;
    if (LAYOUT_VALUES.aiPage.indexOf(raw.aiPage) >= 0) out.aiPage = raw.aiPage;
    if (raw.sections && typeof raw.sections === 'object') {
      const sec = {};
      Object.keys(raw.sections).forEach((k) => { sec[k] = raw.sections[k] === true; });
      out.sections = sec;
    }
    if (LAYOUT_VALUES.sort.indexOf(raw.sort) >= 0) out.sort = raw.sort;
    if (LAYOUT_VALUES.rdScope.indexOf(raw.rdScope) >= 0) out.rdScope = raw.rdScope;
  }
  return out;
}
let layoutPref = sanitizeLayoutLocal(window.__LAYOUT__);

// 排序方式与默认阅读范围：从账号偏好取初值（服务端未注入时回落默认）
state.sort = layoutPref.sort;
state.rdScope = layoutPref.rdScope;
/* ---------------- DOM ---------------- */
const $ = (s) => document.querySelector(s);
const toastEl = $('#toast');
/* ---------------- 工具 ---------------- */
/** 带登录态处理的 fetch：401 时跳登录页 */
async function apiFetch(url, opts) {
  const res = await fetch(url, opts);
  if (res.status === 401) {
    location.replace('/login.html?next=' + encodeURIComponent(location.pathname + location.search));
    throw new Error('未登录');
  }
  return res;
}

/** 完整时间戳，用于 title 提示与展开体的发布时间 */
function fmtFull(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 文章日期：始终显示到分钟。今天/昨天给「今天 HH:mm」，同年给「MM-DD HH:mm」，跨年补上年份 */
function fmtDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const yesterday = new Date(now.getTime() - 86400000).toDateString() === d.toDateString();
  if (sameDay) return `今天 ${hm}`;
  if (yesterday) return `昨天 ${hm}`;
  if (d.getFullYear() === now.getFullYear()) return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${hm}`;
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${hm}`;
}

function sizeToMB(s) {
  if (!s) return null;
  const m = String(s).match(/([\d.]+)\s*(TB|GB|G|MB|M|KB|K)?/i);
  if (!m) return null;
  const v = parseFloat(m[1]);
  if (isNaN(v)) return null;
  const unit = (m[2] || 'MB').toUpperCase();
  const mult = { TB: 1024 * 1024, GB: 1024, G: 1024, MB: 1, M: 1, KB: 1 / 1024, K: 1 / 1024 }[unit] || 1;
  return v * mult;
}

let toastTimer = null;
function toast(msg, ok = true) {
  toastEl.textContent = msg;
  toastEl.className = 'toast show' + (ok ? ' ok' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.className = 'toast'), 1900);
}

async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (_) { /* 降级 */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (_) { return false; }
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function shortFeedName(n) {
  return String(n || '').replace(/\s*-\s*Telegram Channel\s*$/i, '').trim();
}

/** 频道的展示名：自定义名优先，否则抓取来的标题，再否则 url */
function feedTitle(f) {
  if (!f || typeof f !== 'object') return f || '';
  return f.customTitle || f.title || f.url || '';
}

/** 按分组名把频道归类：未分组的排最前，其余按名称排序；组内保持原顺序 */
function groupFeeds(feeds) {
  const map = new Map();
  for (const f of feeds) {
    const g = String(f.groupName || '').trim();
    if (!map.has(g)) map.set(g, []);
    map.get(g).push(f);
  }
  // 分组顺序：优先用显式保存的 groupOrder；不在其中的命名分组按出现顺序补到后面；
  // 「未分组」（空串）永远放最后，不参与拖拽排序。
  const order = state.groupOrder || [];
  const seen = new Set();
  const names = [];
  for (const g of order) if (g && map.has(g) && !seen.has(g)) { names.push(g); seen.add(g); }
  for (const g of map.keys()) if (g && !seen.has(g)) { names.push(g); seen.add(g); }
  if (map.has('')) names.push('');
  return names.map((name) => ({ name, feeds: map.get(name) }));
}

/* ---------------- 视图模式（卡片 / 列表） ----------------
 * 按账号持久化（users.prefs.layout.view），不再落浏览器 localStorage。
 * 两种模式用同一份 state.entries 重新渲染，不做双份 DOM 隐藏切换。
 */
const VIEW_MODES = ['grid', 'list'];

function currentViewMode() {
  return VIEW_MODES.indexOf(layoutPref.view) >= 0 ? layoutPref.view : 'grid';
}

/* 分组折叠状态：按账号持久化（users.prefs.layout.collapsedGroups），不再落浏览器 */
function loadCollapsedGroups() {
  const arr = Array.isArray(layoutPref.collapsedGroups) ? layoutPref.collapsedGroups : [];
  return new Set(arr.filter((g) => typeof g === 'string'));
}

/** 把模式写到 state / DOM / 按钮态；persist=true 时才写账号（手动切换才记） */
function applyViewMode(mode, persist) {
  state.view = VIEW_MODES.indexOf(mode) >= 0 ? mode : 'grid';
  if (persist) setLayout('view', state.view);
  render();   // 通知 CardsView 重绘（含 viewMode 按钮态）
}

/** 用户点击切换：切完立刻按新模式重绘 */
function setViewMode(mode) {
  if (mode === state.view) return;
  applyViewMode(mode, true);   // 内部已 render()
  toast(state.view === 'list' ? '已切换到列表视图' : '已切换到卡片视图');
}

/* ---------------- 当前页面（文章 / 卡片 / 日报） ----------------
 * 按账号持久化（users.prefs.layout.tab），不再落浏览器 localStorage：
 * 切到「卡片」再刷新不会又跳回「文章」。首次访问回落到「文章」（阅读为主的主页）。
 */
const TABS = ['reader', 'cards', 'ai'];

function currentTab() {
  const t = layoutPref.tab;
  // 老版本存的是 'digest'，那个页面已经升级成「AI」了
  if (t === 'digest') return 'ai';
  return TABS.indexOf(t) >= 0 ? t : 'reader';
}

/* ---------------- 数据加载 ---------------- */
async function loadFeeds() {
  const res = await apiFetch('/api/feeds');
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  state.feedList = data.feeds || [];
  state.feedMeta = data;
  state.groupOrder = Array.isArray(data.groupOrder) ? data.groupOrder : [];
  state.collapsedGroups = loadCollapsedGroups();
  // 侧栏「全部 / 未读 / 收藏」的计数跟频道一起回来，省一次请求
  if (data.flags) state.rdFlags = data.flags;
  // 之前筛选的频道被关掉卡片开关 / 删掉了，回落到全部（旧 renderFeedSelect 的兜底职责）
  if (state.feedFilter != null
    && !(state.feedList || []).some((f) => String(f.id) === String(state.feedFilter) && f.cardEnabled)) {
    state.feedFilter = null;
  }
  render();
  return data;
}

async function loadPage(reset = false) {
  if (state.loading) return;
  state.loading = true;

  if (reset) { state.offset = 0; state.hasMore = true; state.entries = []; }

  const first = state.entries.length === 0;
  render();   // 立刻反映骨架 / 加载态（渲染归 React 卡片视图）

  try {
    const qs = new URLSearchParams({
      limit: String(state.pageSize),
      offset: String(state.offset),
    });
    if (state.q) qs.set('q', state.q);
    // 没指定具体频道时，卡片页只取「卡片开关」打开的频道
    if (state.feedFilter) qs.set('feeds', String(state.feedFilter));
    else qs.set('scope', 'cards');

    const res = await apiFetch('/api/entries?' + qs.toString());
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();

    if (reset) state.tags = data.tags || [];

    const list = data.entries || [];
    const seen = new Set(state.entries.map((e) => e.id));
    for (const e of list) if (!seen.has(e.id)) state.entries.push(e);

    state.offset += list.length;
    state.hasMore = !!data.hasMore && list.length > 0;
    state.loadError = false;
  } catch (err) {
    if (first) state.loadError = true;   // 首屏失败 → React 显示错误空态
    else toast('加载失败：' + (err.message || err), false);
  } finally {
    state.loading = false;
    render();
  }
}

/* ---------------- 筛选与排序 ---------------- */
function applyFilters() {
  const list = state.entries.filter((e) => {
    if (state.tag && !(e.tags || []).includes(state.tag)) return false;
    if (state.size !== 'all') {
      const mb = sizeToMB(e.size);
      if (mb == null) return false;
      if (state.size === 'small' && mb > 1024) return false;
      if (state.size === 'mid' && (mb <= 1024 || mb > 20 * 1024)) return false;
      if (state.size === 'big' && mb <= 20 * 1024) return false;
    }
    return true;
  });

  if (state.sort === 'new') list.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  else if (state.sort === 'old') list.sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
  else if (state.sort === 'name') list.sort((a, b) => a.name.localeCompare(b.name, 'zh'));

  return list;
}

/* ---------------- 渲染 ---------------- */
/** 顶栏副标题文本（纯计算；App Shell 的 TopBar 经桥 getShell 读取） */
function subtitleText() {
  const meta = state.feedMeta;
  if (!meta) return '正在加载频道…';
  if (!meta.total) return '还没有订阅源 · 点右上角「设置 → 数据源」添加 RSS';
  return `${state.tagline} · 采集 ${meta.enabled}/${meta.total} 个频道`
    + (Number(meta.cardEnabled) !== Number(meta.enabled) ? ` · 卡片展示 ${meta.cardEnabled} 个` : '');
}

/** 通知 App Shell（顶栏，src/shell/TopBar.jsx）重绘：它监听 __shellTick 后重读 getShell() */
function emitShell() { window.dispatchEvent(new Event('__shellTick')); }

function render() {
  // 顶栏（条资源计数 / 副标题）由 React 渲染
  emitShell();
  // 卡片列表渲染交给 React 卡片视图（src/views/CardsView.jsx）：通知它读实时 state 重绘
  window.dispatchEvent(new Event('__cardsTick'));
}

/* ---------------- 链接：标签 / 复制 / 打开原文 ---------------- */

/** 常见网盘域名 → 中文标签，其余用主机名 */
const HOST_LABELS = [
  [/pan\.quark\.cn$|(^|\.)quark\.cn$/, '夸克'],
  [/pan\.baidu\.com$/, '百度网盘'],
  [/aliyundrive\.(com|net)$|(^|\.)alipan\.com$/, '阿里云盘'],
  [/cloud\.189\.cn$/, '天翼云盘'],
  [/(^|\.)115\.com$/, '115 网盘'],
  [/123pan\.com$|123684\.com$/, '123 网盘'],
  [/mypikpak\.com$/, 'PikPak'],
  [/(^|\.)t\.me$|(^|\.)telegram\.me$/, 'Telegram'],
];
function linkLabel(url) {
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch (_) { return '链接'; }
  for (const [re, name] of HOST_LABELS) if (re.test(host)) return name;
  return host.replace(/^www\./, '');
}
/** 菜单里显示的短地址：去协议、超长中间省略 */
function shortUrl(url) {
  const s = String(url).replace(/^https?:\/\//i, '');
  return s.length > 46 ? s.slice(0, 30) + '…' + s.slice(-12) : s;
}

/* 链接选择菜单：多条链接时从按钮旁弹出（fixed 定位，自动避让视口边缘） */
let linkMenuEl = null;
function closeLinkMenu() {
  if (!linkMenuEl) return;
  linkMenuEl.remove();
  linkMenuEl = null;
  document.removeEventListener('click', onLinkMenuDocClick, true);
  document.removeEventListener('keydown', onLinkMenuKey, true);
  window.removeEventListener('resize', closeLinkMenu);
  window.removeEventListener('scroll', closeLinkMenu, true);
}
function onLinkMenuDocClick(ev) {
  if (linkMenuEl && !linkMenuEl.contains(ev.target)) closeLinkMenu();
}
function onLinkMenuKey(ev) { if (ev.key === 'Escape') closeLinkMenu(); }

function openLinkMenu(anchor, urls, onPick) {
  closeLinkMenu();
  const menu = document.createElement('div');
  menu.className = 'link-menu';
  menu.setAttribute('role', 'menu');
  menu.innerHTML = urls.map((u, i) => `
    <button type="button" class="link-menu-item" role="menuitem" data-i="${i}">
      <span class="link-menu-label">${escapeHtml(linkLabel(u))}</span>
      <span class="link-menu-url">${escapeHtml(shortUrl(u))}</span>
    </button>`).join('');
  document.body.appendChild(menu);
  linkMenuEl = menu;

  const r = anchor.getBoundingClientRect();
  const gap = 6;
  const left = Math.min(Math.max(8, r.left), Math.max(8, window.innerWidth - menu.offsetWidth - 8));
  let top = r.bottom + gap;
  if (top + menu.offsetHeight > window.innerHeight - 8) top = Math.max(8, r.top - menu.offsetHeight - gap);
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';

  menu.addEventListener('click', (ev) => {
    const item = ev.target.closest('.link-menu-item');
    if (!item) return;
    const u = urls[Number(item.getAttribute('data-i'))];
    closeLinkMenu();
    if (u) onPick(u);
  });
  // 延后一帧再挂「点外面关闭」，否则这次点击本身就会把刚弹出的菜单关掉
  setTimeout(() => {
    document.addEventListener('click', onLinkMenuDocClick, true);
    document.addEventListener('keydown', onLinkMenuKey, true);
    window.addEventListener('resize', closeLinkMenu);
    window.addEventListener('scroll', closeLinkMenu, true);
  }, 0);
}

/* ============================================================
 * 设置面板
 * ============================================================ */
// 设置弹层自 v1.3.0 起外壳 React 化（挂载点 #settingsRoot，组件见 src/settings/）：
// 开合状态由 React 组件同步到 window.__settingsOpen，旧 #settingsMask / #settingsSummary
// DOM 已移除；openSettings / closeSettings 委托给 React 宿主 window.__settingsHost。

const isAdmin = () => state.role === 'admin';

/** 按角色显隐：设置弹层的管理员专属 tab 由 React 外壳过滤；
 *  采集参数 / 用户管理 / 日报设置分别在各自 React 面板内按 admin 显隐（P3a 起 AI 视图亦 React 化） */
function applyRoleUI() {
  const admin = isAdmin();
  // 设置弹层 tab 已 React 化：按角色过滤交给宿主（管理员专属 tab 由外壳不再渲染）
  const host = window.__settingsHost;
  if (host && host.setAdminFlag) host.setAdminFlag(admin);
}

/* ---------- 弹层打开时锁住背景页面 ----------
 * 弹层本身是 position:fixed，但背景页面照样能滚：滚到弹层内容尽头后，滚轮会「接力」给
 * body，页面就跟着跑了。只给 body 加 overflow:hidden 在 iOS 上无效（惯性滚动挡不住），
 * 所以用 position:fixed + 负 top 把页面钉在原处，关掉时再滚回去。
 * 用计数是因为「设置弹层」和「图片灯箱」可能同时开着。
 */
let scrollLockCount = 0;
let scrollLockY = 0;

function lockPageScroll() {
  scrollLockCount += 1;
  if (scrollLockCount > 1) return;
  scrollLockY = window.scrollY || window.pageYOffset || 0;
  // 页面滚动条会消失，先量出它的宽度补到右内边距上，否则整页会往右跳一下
  const sbw = Math.max(0, window.innerWidth - document.documentElement.clientWidth);
  document.body.style.setProperty('--sbw', sbw + 'px');
  document.body.style.top = `-${scrollLockY}px`;
  document.body.classList.add('modal-open');
}

function unlockPageScroll() {
  scrollLockCount = Math.max(0, scrollLockCount - 1);
  if (scrollLockCount > 0) return;
  if (!document.body.classList.contains('modal-open')) return;
  document.body.classList.remove('modal-open');
  document.body.style.top = '';
  document.body.style.removeProperty('--sbw');
  window.scrollTo(0, scrollLockY);   // 回到打开弹层前的位置
}

/** 打开设置弹层（外壳 React 化后仅作为委托入口：锁屏 / tab 副作用 / 面板加载
 *  都由 SettingsModal 挂载后自行完成） */
function openSettings(tab) {
  const host = window.__settingsHost;
  if (host && host.open) host.open(tab || 'source');
}

function closeSettings() {
  const host = window.__settingsHost;
  if (host && host.close) host.close();
}

/** 设置弹层副标题文本（纯计算：React 宿主打开弹层时也要用同一份） */
function getSettingsSummary() {
  const meta = state.feedMeta || {};
  const total = meta.total || 0;
  if (!total) return '还没有订阅源';
  const on = meta.enabled || 0;
  const card = meta.cardEnabled == null ? on : meta.cardEnabled;
  return `共 ${total} 个订阅源 · 采集开启 ${on} 个 · 卡片展示 ${card} 个`;
}

/** 推送副标题给 React 外壳（宿主未就绪时静默） */
function setSettingsSummary(text) {
  const host = window.__settingsHost;
  if (host && host.setSummary) host.setSummary(text);
}


/* ============================================================
 * 事件绑定
 * ============================================================ */
// 卡片工具栏（搜索 / 频道 / 排序 / 体积）与视图模式已随卡片视图 React 化
// （src/views/CardsView.jsx），交互经桥 cardsSearch / cardsFilterFeed / cardsSort /
// cardsSize / cardsView 改共享 state 并重绘；旧 DOM 绑定移除。

/* 刷新：先让服务端去抓一轮最新条目，再重新拉列表。
   顶栏「刷新」按钮已 React 化（src/shell/TopBar.jsx），经桥 switchView / refresh 调用。
   按钮的忙态（disabled + 图标自旋）由组件本地维护，这里只负责数据。 */
async function refreshFeeds() {
  hideNewPill();   // 手动刷新了，自动刷新挂的那个「有新内容」提示就作废了
  try {
    const r = await apiFetch('/api/feeds/refresh', { method: 'POST' });
    const data = await r.json();
    await loadFeeds();
    state.tag = null;
    await loadPage(true);
    // 阅读页有自己的列表，也一起刷新（顺带更新左侧频道计数）
    renderReaderChannels();
    if (state.tab === 'reader' || state.rdEntries.length) await loadReader({ reset: true });
    if (data.failed && data.failed.length) toast(`已刷新，${data.failed.length} 个频道抓取失败`, false);
    else toast(data.added ? `已刷新，新增 ${data.added} 条` : '已刷新，没有新内容');
  } catch (err) {
    toast('刷新失败：' + (err.message || err), false);
  }
}

// 顶栏（设置 / 主题 / 刷新 / 视图导航）已随 App Shell React 化，
// 交互经桥 openSettings / cycleTheme / refresh / switchView；旧 DOM 绑定移除。
// 设置弹层的关闭按钮 / 遮罩点击 / tab 点击由 src/settings/SettingsModal.jsx 内部处理。

/* OPML 导出：把当前账号的订阅源整理成标准 OPML（分组作为文件夹），浏览器下载 */
function exportOpml() {
  const feeds = state.feedList || [];
  if (!feeds.length) { toast('没有可导出的订阅源', false); return; }
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const feedOutline = (f) => {
    const title = feedTitle(f) || f.url || '未命名订阅源';
    const xml = f.url || '';
    const html = f.siteUrl || '';
    return '    <outline type="rss" text="' + esc(title) + '" title="' + esc(title)
      + '" xmlUrl="' + esc(xml) + '" htmlUrl="' + esc(html) + '"/>';
  };
  // 按分组归类；未分组的放在顶层
  const groups = {};
  const ungrouped = [];
  for (const f of feeds) {
    const g = String(f.groupName || '').trim();
    if (g) (groups[g] = groups[g] || []).push(f);
    else ungrouped.push(f);
  }
  let body = '';
  for (const g of Object.keys(groups).sort((a, b) => a.localeCompare(b, 'zh'))) {
    body += '  <outline text="' + esc(g) + '" title="' + esc(g) + '">\n'
      + groups[g].map(feedOutline).join('\n') + '\n'
      + '  </outline>\n';
  }
  body += ungrouped.map(feedOutline).join('\n') + (ungrouped.length ? '\n' : '');
  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<opml version="2.0">\n'
    + '  <head><title>ShiYue 订阅导出</title></head>\n'
    + '  <body>\n' + body + '  </body>\n</opml>\n';
  const blob = new Blob([xml], { type: 'text/x-opml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'shiyue-subscriptions-' + new Date().toISOString().slice(0, 10) + '.opml';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('已导出 ' + feeds.length + ' 个订阅源');
}
/* ============================================================
 * 日报 / 模型 / 日报设置 事件绑定
 * ============================================================ */
/* ============================================================
 * 网页自动刷新
 * 间隔存在服务端（settings.source.autoRefreshMinutes），各设备一致。
 * 只重新读一次列表，不触发服务端抓取。发现新内容时：
 *   - 用户停在顶部、也没有展开中的文章 → 直接套用
 *   - 已经滚下去了 → 挂个浮标，点了才套用，避免列表在眼皮底下跳
 * ============================================================ */
let autoRefreshTimer = null;
let autoRefreshLastAt = 0;    // 上一次检查的时刻（回到前台时判断要不要补一次）
let pendingFresh = null;      // { view, data, n } 已拉到但还没套用的新内容

const newPill = $('#newPill');
const newPillText = $('#newPillText');

function autoRefreshMinutes() {
  const n = Number(state.feedMeta && state.feedMeta.autoRefreshMinutes);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function scheduleAutoRefresh() {
  if (autoRefreshTimer) { clearInterval(autoRefreshTimer); autoRefreshTimer = null; }
  const mins = autoRefreshMinutes();
  if (!mins) return;
  autoRefreshLastAt = Date.now();
  autoRefreshTimer = setInterval(() => {
    if (document.hidden) return;                        // 后台不跑，回到前台再补
    if (window.__settingsOpen) return;   // 正在改设置就别动列表
    autoRefreshLastAt = Date.now();
    checkForNew().catch(() => { /* 自动刷新失败就静默跳过，不打扰用户 */ });
  }, mins * 60000);
}

/** 按当前页面的筛选条件拉一页首屏（卡片页的标签是前端过滤的，不用带 tag） */
async function fetchHead(view) {
  const params = new URLSearchParams();
  const loaded = view === 'reader' ? state.rdEntries.length : state.entries.length;
  const base = view === 'reader' ? state.readerPageSize : state.pageSize;
  params.set('limit', String(Math.min(Math.max(loaded, base), 200)));
  params.set('offset', '0');

  if (view === 'reader') {
    // 和 loadReader 用同一套条件，否则「新内容」会按错误的范围去数
    for (const [k, v] of readerFilterParams()) params.set(k, v);
  } else {
    if (state.feedFilter) params.set('feeds', String(state.feedFilter));
    else params.set('scope', 'cards');
    if (state.q) params.set('q', state.q);
  }

  const res = await apiFetch('/api/entries?' + params.toString());
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

/** 只数「排在当前最头条目之前」的那些，避免把翻页拿到的旧条目也算成新的 */
function countNewHead(fresh, current) {
  const known = new Set(current.map((e) => String(e.id)));
  let n = 0;
  for (const e of fresh) {
    if (known.has(String(e.id))) break;
    n += 1;
  }
  return n;
}

function hideNewPill() {
  pendingFresh = null;
  if (newPill) newPill.hidden = true;
}

/** 把拉到的新首屏套进当前列表 */
function applyFresh({ view, data }) {
  const list = data.entries || [];
  if (view === 'reader') {
    state.rdEntries = list;
    state.rdOffset = list.length;
    state.rdHasMore = !!data.hasMore;
    // 展开态与正文缓存留着：条目 id 没变，重绘后会自己恢复展开
    renderReader();
  } else {
    state.entries = list;
    state.offset = list.length;
    state.hasMore = !!data.hasMore && list.length > 0;
    state.tags = data.tags || state.tags;
    render();
  }
  emitShell();
  hideNewPill();
}

async function checkForNew() {
  if (state.tab === 'ai') return 0;                     // AI 页（日报按日期取、设置是表单）不参与自动刷新
  // 收藏列表里不可能冒出新内容（新条目默认都不是收藏），别白拉一次
  if (state.tab === 'reader' && state.rdScope === 'favorite') return 0;
  if (state.loading || state.rdLoading) return 0;
  const view = state.tab === 'cards' ? 'cards' : 'reader';
  const current = view === 'reader' ? state.rdEntries : state.entries;

  const data = await fetchHead(view);
  const n = countNewHead(data.entries || [], current);
  if (!n) return 0;

  // 停在顶部、也没有展开中的文章时才敢直接换列表；否则挂浮标等用户点
  const atTop = window.scrollY < 300;
  const busy = view === 'reader' && state.rdExpanded.size > 0;
  if (atTop && !busy) {
    applyFresh({ view, data });
    toast(`已更新 ${n} 条新内容`);
    return n;
  }
  pendingFresh = { view, data, n };
  if (newPill) {
    newPillText.textContent = `${n} 条新内容`;
    newPill.hidden = false;
  }
  return n;
}

if (newPill) {
  newPill.addEventListener('click', () => {
    const p = pendingFresh;
    hideNewPill();
    if (!p) return;
    applyFresh(p);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
}

// 回到前台时如果已经过了间隔就补一次（后台期间定时器被跳过了）
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  const mins = autoRefreshMinutes();
  if (!mins) return;
  if (Date.now() - autoRefreshLastAt < mins * 60000) return;
  if (window.__settingsOpen) return;
  autoRefreshLastAt = Date.now();
  checkForNew().catch(() => {});
});

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && window.__settingsOpen) closeSettings();
});


let scrollLock = false;
window.addEventListener('scroll', () => {
  if (scrollLock || state.loading || !state.hasMore) return;
  if (window.innerHeight + window.scrollY >= document.body.offsetHeight - 600) {
    scrollLock = true;
    loadPage(false).finally(() => setTimeout(() => (scrollLock = false), 400));
  }
});

/* ============================================================
 * 页面切换（文章 / 卡片 / AI）
 * ============================================================ */
function switchView(name) {
  if (TABS.indexOf(name) < 0) name = 'reader';
  const apply = () => {
    state.tab = name;
    setLayout('tab', name);   // 按账号持久化当前页面，刷新后保持一致
    hideNewPill();   // 浮标里的新内容是上一个页面拉到的，切页就作废
    // 离开文章页时把频道抽屉收掉（否则它会盖在卡片/AI 页上，还占着页面滚动锁）
    if (name !== 'reader') setReaderDrawer(false);

    $('#readerView').hidden = name !== 'reader';
    $('#cardsView').hidden = name !== 'cards';
    $('#aiView').hidden = name !== 'ai';
    // 顶栏（视图高亮 + 「条资源」仅卡片页可见）由 React 重绘
    emitShell();

    if (name === 'reader') {
      renderReaderChannels();
      // 已经有数据就不重新拉，避免来回切页面时列表闪一下
      if (!state.rdEntries.length) loadReader({ reset: true });
      else renderReader();
    }
    // AI 视图已 React 化：通知 AiView 激活 / 隐去（切到 ai 时由组件自行加载子页数据）
    window.dispatchEvent(new CustomEvent('__viewChanged', { detail: name }));

    window.scrollTo({ top: 0 });
  };
  // View Transitions API：视图切换时整页交叉淡入（渐进增强，减少动态效果时跳过）
  if (document.startViewTransition && !prefersReducedMotion()) {
    document.startViewTransition(apply);
  } else {
    apply();
  }
}

/* ============================================================
 * 阅读页（文章）：左频道 / 右文章，点标题展开全文
 * ============================================================ */

/* ============================================================
 * 阅读页（文章）：逻辑归 app.js，渲染归 React（src/views/ReaderView.jsx）
 * v1.9.0 起阅读页 React 化：频道侧栏 / 头部工具 / 搜索 / 条目与正文渲染全部移除，
 * 这里只保留数据 / 加载 / 交互逻辑，需要刷新 UI 时派发 __readerTick（组件监听后读实时 state 重绘）。
 * ============================================================ */

/** 通知 ReaderView 重绘 */
function renderReader() { window.dispatchEvent(new Event('__readerTick')); }
/** 兼容旧调用名：频道侧栏同样由 ReaderView 渲染，故与 renderReader 同为一次重绘 */
function renderReaderChannels() { renderReader(); }

/**
 * 阅读页当前的筛选条件 → URLSearchParams。
 * 列表查询、自动刷新、批量标为已读三处共用，保证「屏幕上看到的」和「被操作的」是同一批。
 * 分组里一个频道都没有时传 `feeds=`（空），服务端会返回空列表 —— 别退化成「不过滤」。
 */
function readerFilterParams() {
  const params = new URLSearchParams();
  const feeds = state.feedList || [];
  let ids = null;
  if (state.rdFeedId != null) {
    ids = [Number(state.rdFeedId)];
  } else if (state.rdGroup != null) {
    // 分组筛选：把该分组的频道 id 摊平了传给 feeds=（未分组用 '' 表示）
    ids = feeds.filter((f) => (f.groupName || '').trim() === state.rdGroup).map((f) => f.id);
  }
  if (ids) params.set('feeds', ids.join(','));
  // 阅读页的「全部」看的是全部内容，不受「卡片」开关影响
  else params.set('scope', 'all');
  if (state.rdScope === 'unread') params.set('unread', '1');
  if (state.rdScope === 'favorite') params.set('fav', '1');
  if (state.rdQ) params.set('q', state.rdQ);
  return params;
}

async function loadReader({ reset = false } = {}) {
  if (state.rdLoading) return;
  if (!reset && !state.rdHasMore) return;

  state.rdLoading = true;
  if (reset) {
    state.rdOffset = 0;
    state.rdHasMore = true;
    state.rdEntries = [];
    state.rdExpanded.clear();
    state.rdBody.clear();
    state.rdBodyErr.clear();
  }
  renderReader();

  try {
    const params = readerFilterParams();
    params.set('limit', String(state.readerPageSize));
    params.set('offset', String(state.rdOffset));

    const res = await apiFetch('/api/entries?' + params.toString());
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();

    const list = data.entries || [];
    state.rdEntries = reset ? list : state.rdEntries.concat(list);
    state.rdOffset = state.rdEntries.length;
    state.rdHasMore = !!data.hasMore;
    state.rdReadError = false;
  } catch (err) {
    if (!state.rdEntries.length) {
      state.rdReadError = true;
      state.rdReadErrorMsg = '加载失败：' + String((err && err.message) || err);
    } else {
      toast('加载失败：' + (err.message || err), false);
    }
  } finally {
    state.rdLoading = false;
    renderReader();
  }
}

/* ---------- 手风琴模式 ---------- */
let accordionOn = layoutPref.accordion;
function readerAccordionOn() { return accordionOn; }
function readerToggleAccordion() {
  accordionOn = !accordionOn;
  setLayout('accordion', accordionOn);   // 按账号持久化
  renderReader();
  toast(accordionOn ? '已开启单篇展开' : '已改为可同时展开多篇');
}

async function expandReaderArt(id) {
  // 手风琴：先把其它展开的收掉，再展开这一条
  if (accordionOn) {
    for (const openId of Array.from(state.rdExpanded)) {
      if (String(openId) !== String(id)) state.rdExpanded.delete(openId);
    }
  }
  state.rdExpanded.add(id);
  renderReader();
  markEntryRead(id);   // 展开了就算读过了

  if (state.rdBody.has(id) || state.rdBodyErr.has(id)) return;
  try {
    const res = await apiFetch('/api/entries/' + encodeURIComponent(id));
    if (!res.ok) throw new Error('HTTP ' + res.status);
    state.rdBody.set(id, await res.json());
  } catch (_) {
    state.rdBodyErr.add(id);
  }
  renderReader();
}

function collapseReaderArt(id) { state.rdExpanded.delete(id); renderReader(); }

function readerToggleArt(id) {
  if (state.rdExpanded.has(id)) collapseReaderArt(id);
  else expandReaderArt(id);
}

function readerCollapseAll() {
  state.rdExpanded.clear();
  renderReader();
  toast('已全部收起');
}

/* ---------- 已读 / 未读 / 收藏 ---------- */

/** 就地改一条的状态：内存 + 侧栏计数 + 重绘（原 paintEntryFlag 的就地 DOM 改类名移除） */
function applyEntryFlag(id, patch) {
  const e = state.rdEntries.find((x) => String(x.id) === String(id));
  if (!e) return;
  const wasRead = !!e.isRead;
  const wasFav = !!e.isFavorite;
  if (patch.isRead !== undefined) e.isRead = !!patch.isRead;
  if (patch.isFavorite !== undefined) e.isFavorite = !!patch.isFavorite;

  if (wasRead !== e.isRead) {
    state.rdFlags.unread = Math.max(0, (state.rdFlags.unread || 0) + (e.isRead ? -1 : 1));
  }
  if (wasFav !== e.isFavorite) {
    state.rdFlags.favorite = Math.max(0, (state.rdFlags.favorite || 0) + (e.isFavorite ? 1 : -1));
  }
  renderReader();

  // 在「收藏」范围里取消收藏 = 明确的「移出这里」，立刻从列表拿掉。
  if (state.rdScope === 'favorite' && !e.isFavorite) {
    state.rdEntries = state.rdEntries.filter((x) => String(x.id) !== String(id));
    state.rdOffset = Math.max(0, state.rdOffset - 1);
    renderReader();
  }
}

/** 打标记：先乐观更新界面，再发请求；失败回滚并提示 */
async function setEntryFlag(id, patch) {
  const e = state.rdEntries.find((x) => String(x.id) === String(id));
  const before = e ? { isRead: !!e.isRead, isFavorite: !!e.isFavorite } : null;
  if (e) applyEntryFlag(id, patch);
  try {
    const res = await apiFetch('/api/entries/' + encodeURIComponent(id), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const d = await res.json();
    if (e) applyEntryFlag(id, { isRead: d.isRead, isFavorite: d.isFavorite });
    return true;
  } catch (err) {
    if (e && before) applyEntryFlag(id, before);
    toast('标记失败：' + (err.message || err), false);
    return false;
  }
}

/** 展开全文即视为已读（只在还没读过时发请求） */
function markEntryRead(id) {
  const e = state.rdEntries.find((x) => String(x.id) === String(id));
  if (!e || e.isRead) return;
  setEntryFlag(id, { isRead: true });
}

/** 收藏 / 取消收藏（原 toggleFavorite(el) → 改按 id） */
function readerToggleFav(id) {
  const e = state.rdEntries.find((x) => String(x.id) === String(id));
  const next = !(e && e.isFavorite);
  setEntryFlag(id, { isFavorite: next }).then((ok) => {
    if (ok) toast(next ? '已收藏' : '已取消收藏');
  });
}

/** 正文里的标签：跳到卡片页按这个标签筛选 */
function readerTagToCards(tag) {
  state.tag = tag;
  switchView('cards');
  render();   // 卡片视图重绘
  toast('已按标签筛选：#' + tag);
}

/* ---------- 频道 / 范围 / 分组切换（ReaderView 经桥调用） ---------- */
function readerSetScope(scope) {
  if (scope === state.rdScope && state.rdFeedId == null && state.rdGroup == null) return;
  state.rdScope = scope;
  setLayout('rdScope', scope);   // 默认范围按账号持久化
  state.rdFeedId = null;
  state.rdGroup = null;
  renderReader();
  loadReader({ reset: true });
  emitShell();
  setReaderDrawer(false);
  scrollReaderTop();
}
function readerSetGroup(g) {
  state.rdScope = 'all';   // 看某个分组 = 回到「全部」范围
  if (g === state.rdGroup) state.rdGroup = null;
  else { state.rdGroup = g; state.rdFeedId = null; }
  renderReader();
  loadReader({ reset: true });
  emitShell();
  setReaderDrawer(false);
  scrollReaderTop();
}
function readerSetFeed(id) {
  const next = id != null ? Number(id) : null;
  state.rdScope = 'all';
  if (next === state.rdFeedId && state.rdGroup == null) return;
  state.rdFeedId = next;
  state.rdGroup = null;
  renderReader();
  loadReader({ reset: true });
  emitShell();
  setReaderDrawer(false);
  scrollReaderTop();
}
function readerOpenSource() { openSettings('source'); setReaderDrawer(false); }

/* ---------- 移动端：左侧频道抽屉 ---------- */
let readerDrawerLocked = false;   // 抽屉当前是否拿着页面滚动锁

/** 打开/收起左侧频道抽屉。宽屏上没有视觉效果，切走阅读页或窗口变宽时自动收起 */
function setReaderDrawer(open) {
  const on = !!open;
  if (on === document.body.classList.contains('reader-drawer-open')) return;
  document.body.classList.toggle('reader-drawer-open', on);
  // 抽屉铺满整屏，背景也得真的钉住：iOS 上只写 overflow:hidden 挡不住惯性滚动
  if (on) { lockPageScroll(); readerDrawerLocked = true; }
  else if (readerDrawerLocked) { readerDrawerLocked = false; unlockPageScroll(); }
}

/** 换了频道 / 范围 / 分组 = 换了一整个列表，把视线带回顶部，别停在新列表中间 */
function scrollReaderTop() {
  window.scrollTo({ top: 0, behavior: 'auto' });
}

// 抽屉开合按钮（菜单 / 关闭 / 遮罩）已随阅读页 React 化，改由 ReaderView 经桥触发
function readerToggleDrawer() { setReaderDrawer(!document.body.classList.contains('reader-drawer-open')); }
function readerCloseDrawer() { setReaderDrawer(false); }
window.addEventListener('resize', () => { if (window.innerWidth > 720) setReaderDrawer(false); });

/* 手势：从左侧滑出频道抽屉（拖拽跟手 + 松手吸附）
 * 未打开时，手指在左边缘一段区域内向右横滑即可「拖」出抽屉；
 * 已打开时，向左横滑即可收回。竖滑交给页面自己滚动，互不干扰。
 * 起手区比旧版更宽（EDGE），避开 iOS / Android 最边缘的系统返回手势，
 * 否则贴着 0~15px 的触摸常被系统吞掉，用户根本滑不动抽屉。 */
(() => {
  const EDGE = 60;          // 未打开时，可起手的左边缘宽度（px）
  const THRESH = 48;        // 松手判定开 / 关的最小位移（px）
  const getSide = () => document.getElementById('readerSide');
  const getMask = () => document.getElementById('readerMask');
  if (true) {
    const drawerW = () => Math.min(272, window.innerWidth * 0.84);
    let x0 = 0, y0 = 0, dragging = false, decided = false, dir = 0;

    // px = 抽屉已滑出的像素（0=关，drawerW=开）→ 换算成 translateX 百分比
    function place(px) {
      px = Math.max(0, Math.min(drawerW(), px));
      const pct = px / drawerW();
      const side = getSide();
      if (side) side.style.transform = `translateX(${(-104 + pct * 104).toFixed(2)}%)`;
      const mask = getMask();
      if (mask) {
        mask.style.visibility = 'visible';
        mask.style.opacity = String(pct);
      }
    }

    document.addEventListener('touchstart', (ev) => {
      const t = ev.touches && ev.touches[0];
      if (!t) return;
      const open = document.body.classList.contains('reader-drawer-open');
      // 未开：只在左边缘一段起手；已开：任意位置都可起手（方便左滑收起）
      if (!open && t.clientX > EDGE) { dragging = false; return; }
      x0 = t.clientX; y0 = t.clientY; dragging = true; decided = false; dir = 0;
    }, { passive: true });

    document.addEventListener('touchmove', (ev) => {
      if (!dragging) return;
      const t = ev.touches && ev.touches[0];
      if (!t) return;
      const dx = t.clientX - x0, dy = t.clientY - y0;
      if (!decided) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;        // 等方向明确
        if (Math.abs(dy) > Math.abs(dx)) { dragging = false; return; }  // 竖滑 → 不接管
        decided = true; dir = dx >= 0 ? 1 : -1;
        const side0 = getSide(); if (side0) side0.style.transition = 'none';   // 跟手期间关掉过渡
      }
      if (dir > 0) place(Math.max(0, dx));                        // 从 0 滑出
      else place(drawerW() + dx);                                 // 已开 → 从满位左收（dx 为负）
      if (ev.cancelable) ev.preventDefault();                     // 拦掉默认横滑 / 回弹
    }, { passive: false });

    document.addEventListener('touchend', (ev) => {
      if (!dragging) return;
      dragging = false;
      if (!decided) return;                                       // 只是轻点，没拖动
      const t = ev.changedTouches && ev.changedTouches[0];
      if (!t) return;
      const dx = t.clientX - x0;
      const open = dir > 0 ? dx >= THRESH                        // 右滑够距 → 开
                            : (dx <= -THRESH ? false : true);     // 左滑够距 → 关，否则维持开
      const sideEl = getSide();
      if (sideEl) {
        sideEl.style.transition = '';                             // 恢复过渡，交给 CSS 吸附
        sideEl.style.transform = open ? 'translateX(0%)' : 'translateX(-104%)';
      }
      const maskEl = getMask();
      if (maskEl) maskEl.style.opacity = open ? '1' : '0';
      setReaderDrawer(open);                                      // 类切换 + 页面滚动锁
      // 吸附动画结束后把内联样式交还给 CSS，避免后续用按钮开关时内联值压住类样式
      setTimeout(() => {
        const side1 = getSide(); if (side1) side1.style.transform = '';
        const mask1 = getMask(); if (mask1) { mask1.style.opacity = ''; mask1.style.visibility = ''; }
      }, 300);
    }, { passive: true });
  }
})();

/* 阅读页条目的点击（星标 / 展开 / 正文标签）已随 React 化移至 src/views/ReaderView.jsx，
   经桥 readerToggleFav / readerToggleArt / readerTagToCards 触发；旧事件委托移除。 */

/* ---------- 图片灯箱 ----------
 * index.html 与 style.css 里一直有 .lightbox，但之前没有任何 JS 接上它，
 * 于是图片上写着「点击查看大图」却点不动。这里补齐：点图看大图，点任意处或 Esc 关闭。
 */
const lightbox = $('#lightbox');
const lightboxImg = $('#lightboxImg');

function openLightbox(src) {
  if (!src) return;
  lightboxImg.src = src;
  lightbox.hidden = false;
  lockPageScroll();
}

function closeLightbox() {
  if (lightbox.hidden) return;
  lightbox.hidden = true;
  lightboxImg.src = '';
  unlockPageScroll();
}

document.addEventListener('click', (ev) => {
  if (!lightbox.hidden) { closeLightbox(); return; }   // 开着的时候点哪儿都关
  const img = ev.target.closest ? ev.target.closest('.art-img') : null;
  if (img) openLightbox(img.getAttribute('src'));
});

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && !lightbox.hidden) closeLightbox();
});

/* 文章页：滚到底部自动加载下一页（不再需要点「加载更多」）
   用 IntersectionObserver 观察列表末尾的哨兵；加载完若哨兵仍在触发区
   （首屏没被填满，比如大屏 / 筛选后条目少），就再补一次，直到填满或没有更多 */
/* 文章页：滚到底部自动加载下一页。哨兵（#readerSentinel）现由 React 渲染，
   改用窗口滚动监听触发（与卡片页一致），避免加载时元素尚不存在。 */
let readerAutoBusy = false;

function readerSentinelNear() {
  const el = document.getElementById('readerSentinel');
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return r.top < window.innerHeight + 500;
}

async function readerAutoLoad() {
  if (readerAutoBusy) return;
  if (state.tab !== 'reader' || state.rdLoading || !state.rdHasMore || !state.rdEntries.length) return;
  readerAutoBusy = true;
  try {
    await loadReader();
  } finally {
    readerAutoBusy = false;
    if (state.rdHasMore && readerSentinelNear()) setTimeout(readerAutoLoad, 120);
  }
}

window.addEventListener('scroll', () => {
  if (state.tab !== 'reader') return;
  if (state.rdLoading || !state.rdHasMore || !state.rdEntries.length) return;
  if (readerSentinelNear()) readerAutoLoad();
});

/* 「全部标为已读」：条件与当前列表完全一致，标完刷新徽标（ReaderView 经桥 readerReadAll 调用） */
async function readerReadAll() {
  // 破坏性操作（可能一口气把几百篇标成已读），先确认一次，与「删除订阅/用户」保持一致
  const label = state.rdScope === 'unread' ? '全部未读'
    : (state.rdScope === 'favorite' ? '全部收藏' : '当前列表');
  if (!window.confirm(`确定把「${label}」全部标为已读？此操作不可撤销。`)) return;
  try {
    const p = readerFilterParams();
    const feedsRaw = p.get('feeds');
    const res = await apiFetch('/api/entries/read-all', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        // 没传 feeds = 不限频道；传空串 = 分组里没有频道，那就什么都不标
        feeds: p.has('feeds') ? (feedsRaw ? feedsRaw.split(',').map(Number) : []) : null,
        q: p.get('q') || '',
      }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const d = await res.json();
    toast(d.updated ? `已标为已读 ${d.updated} 篇` : '这里没有未读文章');
    await loadFeeds();
    renderReader();
    loadReader({ reset: true });
  } catch (err) {
    toast('操作失败：' + (err.message || err), false);
  }
}

function readerSearch(q) {
  q = String(q || '').trim();
  if (q === state.rdQ) return;
  state.rdQ = q;
  renderReader();
  loadReader({ reset: true });
}

// 全局快捷键：按 "/" 聚焦当前视图的搜索框（阅读页 / 卡片页）。输入框内正在打字时不拦截，
// 也不拦截带修饰键的组合（如 Ctrl+/），避免和浏览器/系统快捷键打架
document.addEventListener('keydown', (ev) => {
  if (ev.key !== '/' || ev.metaKey || ev.ctrlKey || ev.altKey) return;
  const ae = document.activeElement;
  if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return;
  if (state.tab === 'cards') {
    // 卡片视图的搜索框已 React 化，聚焦经 window.__cardsFocusSearch 委托
    if (!window.__cardsFocusSearch) return;
    ev.preventDefault();
    window.__cardsFocusSearch();
    return;
  }
  if (state.tab !== 'reader') return;
  // 阅读页搜索框已 React 化，聚焦经 window.__readerFocusSearch 委托
  if (!window.__readerFocusSearch) return;
  ev.preventDefault();
  window.__readerFocusSearch();
});


/* ============================================================
 * AI 子页光标（React AiView 读写；持久化 users.prefs.layout.aiPage）
 * AI 视图自 v1.7.0 起 React 化（src/ai/AiView.jsx），旧渲染 / 绑定全部移除。
 * ============================================================ */
let aiPage = (['digest', 'settings'].indexOf(layoutPref.aiPage) >= 0) ? layoutPref.aiPage : 'digest';

/* ============================================================
 * 主题（跟随系统 / 浅色 / 深色）
 * 首屏由 index.html <head> 的内联脚本先定好 data-theme，这里只负责
 * 后续切换、持久化，以及「跟随系统」时响应系统偏好变化。
 * ============================================================ */
// 4 档：跟随系统 / 浅色 / CommaFeed 暗色 / GitHub 暗黑。
// 前两档保持原样（dark 是 CommaFeed 中性灰），github 是整包主题，不进「跟随系统」
// —— 跟随系统只在浅色与 CommaFeed 暗之间切，想要 GitHub 暗黑必须显式选。
const THEME_MODES = ['auto', 'light', 'dark', 'github'];
const THEME_META = {
  auto: { ico: 'theme-auto', label: '跟随系统', color: null },
  light: { ico: 'sun', label: '浅色', color: '#ffffff' },
  dark: { ico: 'moon', label: 'CommaFeed 暗色', color: '#242424' },
  github: { ico: 'github', label: 'GitHub 暗黑', color: '#0d1117' },
};
// 每档主题实际写进 data-theme 的值：github 主题另外用一套 CSS 变量块，
// 主色固定 GitHub 蓝（不对应 6 套 accent，所以外观页要把主色调板禁掉）。
const THEME_DATA_ATTR = {
  auto: null, light: 'light', dark: 'dark', github: 'github',
};
// 这些主题自带主色，不随 6 套主色调板变
const THEME_FIXED_ACCENT = { github: '#1f6feb' };
// GitHub 主题自带主色：切到它时把当前主色暂存，切回浅/暗时恢复（仅会话内有效，不落本机）
let githubKeepAccent = null;

function prefersDark() {
  return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
}

function currentThemeMode() {
  return (appearancePref && THEME_MODES.indexOf(appearancePref.theme) >= 0) ? appearancePref.theme : 'auto';
}

function applyTheme(mode, animate) {
  const m = THEME_MODES.indexOf(mode) >= 0 ? mode : 'auto';
  // auto 只看系统深浅（不出 GitHub），其余三档各自写自己的 CSS 变量块
  const resolved = m === 'auto' ? null : THEME_DATA_ATTR[m];
  const eff = resolved || (prefersDark() ? 'dark' : 'light');
  const dark = eff === 'dark' || eff === 'github';
  const el = document.documentElement;

  if (animate) {
    el.classList.add('theme-anim');
    setTimeout(() => el.classList.remove('theme-anim'), 260);
  }
  el.setAttribute('data-theme', eff);
  el.setAttribute('data-theme-mode', m);

  // github 主题自带主色，不跟随 6 套主色调板：切到它时把当前主色暂存，
  // 切回浅/暗时恢复成暂存值（会话内有效，不写本机 localStorage）。
  const fixed = THEME_FIXED_ACCENT[m];
  const accent = (appearancePref && appearancePref.accent) || githubKeepAccent || 'blue';
  if (fixed) {
    githubKeepAccent = accent;
    el.setAttribute('data-accent', 'github');
  } else {
    el.setAttribute('data-accent', APPR_VALUES.accent.indexOf(accent) >= 0 ? accent : 'blue');
    githubKeepAccent = null;
  }
  el.setAttribute('data-fixed-accent', fixed ? 'github' : '');
  applyAppearance(readAppearance());

  // 主题持久化到服务端（按账号维度），与外观配置同一份
  if (m !== (appearancePref && appearancePref.theme)) {
    appearancePref.theme = m;
    saveAppearance(appearancePref);
  }

  const meta = THEME_META[m];
  const tc = document.querySelector('meta[name="theme-color"]');
  if (tc) tc.setAttribute('content', meta.color || (dark ? '#242424' : '#ffffff'));
  emitShell();   // 顶栏主题按钮的图标与提示由 React 重绘

  // 外观页的主题分段控件已 React 化：选中态由窗口级 __appearanceChanged 事件回流，
  // 不再在这里直接操作 DOM
}

function cycleTheme() {
  const next = THEME_MODES[(THEME_MODES.indexOf(currentThemeMode()) + 1) % THEME_MODES.length];
  applyTheme(next, true);
  toast('主题：' + THEME_META[next].label);
}

try {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (currentThemeMode() === 'auto') applyTheme('auto', false);
  });
} catch (_) { /* 老浏览器不支持 addEventListener，忽略 */ }

// ⚠️ 执行顺序：applyTheme() 内部会读外观偏好（APPR_* 常量定义在更下面），
// 而这个文件是 defer 脚本、模块顶层就往下跑。直接在这里同步调用会踩 const 的
// TDZ（"Cannot access 'APPR_DEFAULTS' before initialization"），整页 JS 中断。
// 所以主题 / 视图 / 外观的首次应用统一延后到本 tick 之后 —— DOM 早已就绪，
// 属性写晚一个 tick 不闪（<head> 内联脚本已经先写好首屏值了）。
function bootThemeAndView() {
  applyTheme(currentThemeMode(), false);
  applyViewMode(currentViewMode(), false);
}
requestAnimationFrame(() => requestAnimationFrame(bootThemeAndView));

/* ============================================================
 * 外观偏好（主题 / 主色调 / 字号 / 阅读字体 / 行高 / 阅读宽度）
 * 按账号维度持久化到服务端（users.prefs.appearance），不再落本机 localStorage，
 * 换设备也一致。
 * 首屏由 index.html <head> 的内联脚本从服务端注入的 window.__APPEARANCE__ 应用
 * （否则会先闪一下默认值），这里负责后续修改、持久化与界面回填。
 * ============================================================ */
// 默认值与合法值表（与服务端 APPEARANCE_DEFAULTS / APPEARANCE_KEYS 对齐）
const APPR_DEFAULTS = { theme: 'auto', accent: 'blue', fontSize: 'm', readerFont: 'sans', readerLh: 'm', readerWidth: 'm' };
// 键名 → html 属性名；同时这个属性名就是控件上用来标值的 data 属性名
const APPR_ATTR = {
  accent: 'data-accent',
  fontSize: 'data-font-size',
  readerFont: 'data-reader-font',
  readerLh: 'data-reader-lh',
  readerWidth: 'data-reader-width',
};
const APPR_VALUES = {
  theme: ['auto', 'light', 'dark', 'github'],
  accent: ['blue', 'violet', 'teal', 'green', 'amber', 'rose'],
  fontSize: ['s', 'm', 'l'],
  readerFont: ['sans', 'serif'],
  readerLh: ['s', 'm', 'l'],
  readerWidth: ['s', 'm', 'l', 'full'],
};
// 注：旧 APPR_GROUP 控件选择器表随外观面板 React 化移除（React 侧自行渲染控件）

// 单一可信源：优先服务端注入的 window.__APPEARANCE__，缺省回落默认（登录页等无注入场景）
function sanitizeAppearanceLocal(raw) {
  const out = Object.assign({}, APPR_DEFAULTS);
  if (raw && typeof raw === 'object') {
    for (const k of Object.keys(APPR_DEFAULTS)) {
      if (APPR_VALUES[k] && APPR_VALUES[k].indexOf(raw[k]) >= 0) out[k] = raw[k];
    }
  }
  return out;
}
let appearancePref = sanitizeAppearanceLocal(window.__APPEARANCE__);

function readAppearance() {
  return sanitizeAppearanceLocal(appearancePref);
}

// 统一按账号持久化：外观与布局共用一次防抖 POST（避免两路并发互相覆盖）
let prefsSaveTimer = null;
function saveUserPrefs() {
  clearTimeout(prefsSaveTimer);
  prefsSaveTimer = setTimeout(() => {
    fetch('/api/prefs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appearance: appearancePref, layout: layoutPref }),
    }).catch(() => { /* 离线 / 网络异常时静默，下次改动再试 */ });
  }, 150);
}

// 布局单键修改：替换对应键后写账号（sections / collapsedGroups 由调用方传完整对象）
function setLayout(key, value) {
  layoutPref = sanitizeLayoutLocal(Object.assign({}, layoutPref, { [key]: value }));
  saveUserPrefs();
}

function saveAppearance(pref) {
  appearancePref = sanitizeAppearanceLocal(pref);
  // 防抖后写服务端（按账号持久化，不再落本机 localStorage）
  saveUserPrefs();
}

/** 写进 <html> 属性（样式全挂在属性选择器上）。
 *  控件选中态自 v1.3.0 起由 React 外观面板（src/settings/AppearancePane.jsx）从
 *  偏好数据直接推导、不再回写 DOM；末尾派发 __appearanceChanged 通知面板同步，
 *  覆盖顶栏主题按钮、恢复默认、localStorage 迁移等一切外部改动。 */
function applyAppearance(pref) {
  const el = document.documentElement;
  Object.keys(APPR_ATTR).forEach((k) => el.setAttribute(APPR_ATTR[k], pref[k]));
  window.dispatchEvent(new Event('__appearanceChanged'));
}

function setAppearance(key, value) {
  if (!APPR_VALUES[key] || APPR_VALUES[key].indexOf(value) < 0) return;
  const pref = readAppearance();
  pref[key] = value;
  saveAppearance(pref);
  applyAppearance(pref);
}

// 外观面板的控件点击 / 「恢复默认」已 React 化：经桥 setAppearance / resetAppearance
// 回调到这里，状态与持久化逻辑不变，仅 DOM 绑定移除

/** 恢复默认外观（React 外观面板的「恢复默认」按钮经桥调用）：
 *  主题一并带回「跟随系统」，避免默认主色 + GitHub 主题的错配 */
function resetAppearance() {
  appearancePref = Object.assign({}, APPR_DEFAULTS);
  saveAppearance(appearancePref);
  applyTheme('auto', true);
  applyAppearance(readAppearance());
  toast('外观已恢复默认');
}

applyAppearance(readAppearance());

// 旧版把外观 / 布局偏好存在本机 localStorage：升级后迁移到账号（仅执行一次），随后清掉本机副本
(function migrateLocalPrefs() {
  let apref = Object.assign({}, appearancePref);
  let lpref = Object.assign({}, layoutPref);
  let aChanged = false, lChanged = false;
  try {
    // —— 外观 ——
    const a = JSON.parse(localStorage.getItem('shiyue.appearance.v1') || '{}');
    if (a && typeof a === 'object') {
      ['accent', 'fontSize', 'readerFont', 'readerLh', 'readerWidth'].forEach((k) => {
        if (APPR_VALUES[k] && APPR_VALUES[k].indexOf(a[k]) >= 0) { apref[k] = a[k]; aChanged = true; }
      });
    }
    const t = localStorage.getItem('shiyue.theme.v1');
    if (t && APPR_VALUES.theme.indexOf(t) >= 0 && t !== 'auto') { apref.theme = t; aChanged = true; }
    // —— 布局 ——
    const v = localStorage.getItem('shiyue.view.v1');
    if (LAYOUT_VALUES.view.indexOf(v) >= 0) { lpref.view = v; lChanged = true; }
    const tb = localStorage.getItem('shiyue.tab.v1');
    if (LAYOUT_VALUES.tab.indexOf(tb) >= 0) { lpref.tab = tb; lChanged = true; }
    const cg = JSON.parse(localStorage.getItem('shiyue.collapsedGroups.v1') || 'null');
    if (Array.isArray(cg)) {
      lpref.collapsedGroups = cg.filter((g) => typeof g === 'string').map((g) => g.slice(0, 40));
      lChanged = true;
    }
    const ac = localStorage.getItem('shiyue.reader.accordion.v1');
    if (ac === '0' || ac === '1') { lpref.accordion = ac !== '0'; lChanged = true; }
    const ai = localStorage.getItem('shiyue.ai.page.v1');
    if (LAYOUT_VALUES.aiPage.indexOf(ai) >= 0) { lpref.aiPage = ai; lChanged = true; }
    const sec = JSON.parse(localStorage.getItem('shiyue.settings.sections.v1') || 'null');
    if (sec && typeof sec === 'object') { lpref.sections = sec; lChanged = true; }
  } catch (_) { return; }
  if (aChanged) appearancePref = sanitizeAppearanceLocal(apref);
  if (lChanged) layoutPref = sanitizeLayoutLocal(lpref);
  if (aChanged || lChanged) saveUserPrefs();   // 一次合并写账号
  try {
    ['shiyue.appearance.v1', 'shiyue.theme.v1', 'shiyue.appearance.accent.v1',
     'shiyue.view.v1', 'shiyue.tab.v1', 'shiyue.collapsedGroups.v1',
     'shiyue.reader.accordion.v1', 'shiyue.ai.page.v1', 'shiyue.settings.sections.v1']
      .forEach((k) => localStorage.removeItem(k));
  } catch (_) { /* 忽略 */ }
})();

/* ============================================================
 * PWA：Service Worker + 「添加到手机」
 * ============================================================ */
// 注册 Service Worker（仅 https / localhost 会生效；用 http 的局域网 IP 访问时静默忽略）
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* 非安全上下文，忽略 */ });
  });
}

// 安装到手机：Chromium 系（Edge / Chrome）满足条件时会触发 beforeinstallprompt
let deferredInstall = null;   // 捕获到的 beforeinstallprompt 事件（顶栏安装按钮经桥 promptInstall 触发）

window.addEventListener('beforeinstallprompt', (ev) => {
  ev.preventDefault();
  deferredInstall = ev;
  emitShell();   // 顶栏「添加到手机」按钮由 React 按 installReady 显隐
});

window.addEventListener('appinstalled', () => {
  deferredInstall = null;
  emitShell();
  toast('已添加到手机');
});

/** 触发安装（返回是否真的弹了；顶栏按钮与账号面板「一键安装」共用） */
async function promptInstall() {
  if (!deferredInstall) return false;
  deferredInstall.prompt();
  let outcome = 'dismissed';
  try { ({ outcome } = await deferredInstall.userChoice); } catch (_) { /* 忽略 */ }
  deferredInstall = null;
  emitShell();
  if (outcome === 'accepted') toast('已添加到手机');
  return true;
}

// 让浏览器地址栏 / 状态栏颜色跟随主题（取顶栏底色 --panel，PWA 独立窗口更协调）
function syncThemeColor() {
  const dark = document.documentElement.getAttribute('data-theme') === 'dark';
  let meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) { meta = document.createElement('meta'); meta.name = 'theme-color'; document.head.appendChild(meta); }
  meta.setAttribute('content', dark ? '#171b22' : '#ffffff');
}
syncThemeColor();
new MutationObserver(syncThemeColor).observe(document.documentElement, {
  attributes: true, attributeFilter: ['data-theme'],
});

/* ============================================================
 * 可折叠分组（<details class="sec" data-sec="…">）
 * 用原生 <details>/<summary>（键盘可操作、无障碍语义天然正确），
 * 这里只做两件事：按 data-sec 记住每组的开合状态、由各表单更新摘要行。
 * 开合状态按账号持久化（users.prefs.layout.sections），不再落浏览器 localStorage。
 * ============================================================ */
function savedSections() {
  return (layoutPref.sections && typeof layoutPref.sections === 'object') ? layoutPref.sections : {};
}

function saveSectionState(key, open) {
  const next = Object.assign({}, layoutPref.sections || {}, { [key]: !!open });
  setLayout('sections', next);
}

/**
 * 给 root 里所有 details.sec 套上记住的开合状态，并挂上变化监听。
 * 静态区域在启动时调一次就够；**动态重绘的区域每次渲染后都要再调一次**
 * —— 状态页每 30s 重绘一遍，不重新绑定的话展开态会被冲掉。
 */
function bindSections(root) {
  const saved = savedSections();
  (root || document).querySelectorAll('details.sec[data-sec]').forEach((d) => {
    if (d.dataset.secBound === '1') return;   // 已经绑过，别重复挂监听
    d.dataset.secBound = '1';
    const k = d.getAttribute('data-sec');
    if (k in saved) d.open = !!saved[k];
    d.addEventListener('toggle', () => saveSectionState(k, d.open));
  });
}

bindSections(document);

/* ============================================================
 * 启动
 * ============================================================ */
(async function init() {
  // 校验登录态（未登录由 apiFetch 自动跳转）
  try {
    const res = await fetch('/api/session');
    const s = await res.json();
    if (!s.authenticated) {
      location.replace('/login.html');
      return;
    }
    state.username = s.username;
    state.role = s.role || 'user';
  } catch (_) { /* 忽略 */ }
  applyRoleUI();

  try {
    await loadFeeds();
  } catch (err) {
    toast('频道列表加载失败：' + (err.message || err), false);
  }
  // 频道接口顺带带回了「页面自动刷新」间隔，据此起定时器
  scheduleAutoRefresh();

  // 分享链接 ?feed=<id> 可直接筛到某个频道（卡片页和阅读页都生效）
  const urlFeed = new URLSearchParams(location.search).get('feed');
  if (urlFeed && (state.feedList || []).some((f) => String(f.id) === urlFeed && f.enabled)) {
    state.feedFilter = Number(urlFeed);
    state.rdFeedId = Number(urlFeed);
  }

  emitShell();
  await loadPage(true);

  // 打开哪个页面：hash 优先（可分享深链），其次上次记住的，默认「文章」
  let tab = currentTab();
  if (location.hash.startsWith('#cards')) tab = 'cards';
  else if (location.hash.startsWith('#favorite')) { tab = 'reader'; state.rdScope = 'favorite'; }
  else if (location.hash.startsWith('#unread')) { tab = 'reader'; state.rdScope = 'unread'; }
  else if (location.hash.startsWith('#reader')) tab = 'reader';
  // #digest 是老深链，那个页面已经升级成「AI」了，仍然认
  else if (location.hash.startsWith('#digest')) { tab = 'ai'; aiPage = 'digest'; }
  else if (location.hash.startsWith('#ai')) {
    tab = 'ai';
    // #ai/settings 这种可以直达某个子页
    const sub = location.hash.slice(3).replace(/^[/:]+/, '');
    if (['digest', 'settings'].indexOf(sub) >= 0) aiPage = sub;
  }
  switchView(tab);

  if (location.hash.startsWith('#settings')) openSettings();
})();

/* ============================================================
 * 现代交互增强（渐进增强，与现有快捷键互不冲突）
 *  1) 顶部阅读进度条（滚动驱动）
 *  2) 命令面板 ⌘K / Ctrl+K（参考 Linear / Vercel）
 *  3) 阅读页键盘导航 j/k 上下、o/↵ 展开、f 收藏、r 已读
 * ============================================================ */

function prefersReducedMotion() {
  return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

/* ---------- 1) 阅读进度条 / 2) 命令面板（均已迁移为 React 组件） ----------
   进度条见 src/shell/TopBar.jsx 的 ReadProgress；
   实现在 src/cmdk/CommandPalette.jsx，由 <script type="module" src="/src/main.jsx">
   挂载到 index.html 的 #cmdkRoot；旧 DOM（#cmdkMask 等）与 PINYIN 表已一并移除。
   下面的 selectScope / jumpToFeed / focusSearchBox 是普通页面函数，
   通过文件末尾的 window.shiyue 桥供 React 组件调用。 */

function selectScope(scope) {
  if (state.tab !== 'reader') switchView('reader');
  state.rdScope = scope;
  setLayout('rdScope', scope);
  state.rdFeedId = null;
  state.rdGroup = null;
  renderReaderChannels();
  loadReader({ reset: true });
  emitShell();
  setReaderDrawer(false);
  scrollReaderTop();
}
function jumpToFeed(id) {
  switchView('reader');
  state.rdScope = 'all';
  state.rdFeedId = Number(id);
  state.rdGroup = null;
  renderReaderChannels();
  loadReader({ reset: true });
  emitShell();
  setReaderDrawer(false);
  scrollReaderTop();
}
function focusSearchBox() {
  if (state.tab === 'cards') {
    if (window.__cardsFocusSearch) window.__cardsFocusSearch();   // 卡片搜索框已 React 化
    return;
  }
  if (state.tab !== 'reader') switchView('reader');
  if (window.__readerFocusSearch) window.__readerFocusSearch();
}


/* ---------- 3) 阅读页键盘导航 ---------- */
let kbdIdx = -1;
function kbdItems() {
  if (state.tab === 'reader') return Array.prototype.slice.call(document.querySelectorAll('#readerList .art-item'));
  if (state.tab === 'cards') return Array.prototype.slice.call(document.querySelectorAll(state.view === 'list' ? '#grid .row-item' : '#grid .card'));
  return [];
}
function clearKbdFocus() {
  document.querySelectorAll('.art-item.kbd-focus, .card.kbd-focus, .row-item.kbd-focus')
    .forEach((el) => el.classList.remove('kbd-focus'));
  kbdIdx = -1;
}
function moveKbd(d) {
  const items = kbdItems();
  if (!items.length) return;
  kbdIdx = kbdIdx < 0 ? (d > 0 ? 0 : items.length - 1) : Math.min(items.length - 1, Math.max(0, kbdIdx + d));
  items.forEach((el, i) => el.classList.toggle('kbd-focus', i === kbdIdx));
  if (items[kbdIdx]) items[kbdIdx].scrollIntoView({ block: 'nearest' });
}
function isTypingTarget(el) {
  if (!el) return false;
  const t = el.tagName;
  return t === 'INPUT' || t === 'TEXTAREA' || t === 'BUTTON' || t === 'SELECT' || t === 'A' || el.isContentEditable;
}
document.addEventListener('keydown', (ev) => {
  // 面板开着时不响应 j/k（命令面板 / 设置弹层均已 React 化，
  // 通过 window.__cmdkOpen / window.__settingsOpen 同步开合状态）
  if (window.__cmdkOpen || window.__settingsOpen) return;
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
  if (isTypingTarget(document.activeElement)) return;
  if (window.__settingsOpen || !lightbox.hidden) return;
  const items = kbdItems();
  if (ev.key === 'j' || ev.key === 'k') {
    ev.preventDefault();
    moveKbd(ev.key === 'j' ? 1 : -1);
  } else if (kbdIdx >= 0 && items[kbdIdx]) {
    const el = items[kbdIdx];
    const onCards = state.tab === 'cards';
    if (ev.key === 'o' || ev.key === 'Enter') {
      ev.preventDefault();
      if (onCards) { const b = el.querySelector('.btn-open'); if (b) b.click(); }
      else readerToggleArt(el.dataset.id);
    } else if (ev.key === 'f') {
      ev.preventDefault();
      if (onCards) cardSetFlag(el.dataset.id, { isFavorite: !isCardFav(el.dataset.id) });
      else readerToggleFav(el.dataset.id);
    } else if (ev.key === 'r') {
      ev.preventDefault();
      if (onCards) cardSetFlag(el.dataset.id, { isRead: true });
      else markEntryRead(el.dataset.id);
    }
  }
});
// 列表重绘（翻页 / 筛选 / 点击）后清掉键盘焦点态，避免错位
// 阅读页列表由 React 渲染，用事件委托清键盘焦点态
document.addEventListener('click', (ev) => { if (ev.target.closest && ev.target.closest('#readerList')) clearKbdFocus(); });
// 卡片列表由 React 渲染，用事件委托清键盘焦点态（旧 grid 常量已移除）
document.addEventListener('click', (ev) => { if (ev.target.closest && ev.target.closest('#grid')) clearKbdFocus(); });

/* 卡片页条目收藏/已读：复用与阅读页相同的 /api/entries PATCH，但作用于卡片列表 state.entries */
function isCardFav(id) {
  const e = (state.entries || []).find((x) => String(x.id) === String(id));
  return !!(e && e.isFavorite);
}
async function cardSetFlag(id, patch) {
  const list = state.entries || [];
  const e = list.find((x) => String(x.id) === String(id));
  if (!e) return false;
  const before = { isRead: !!e.isRead, isFavorite: !!e.isFavorite };
  Object.assign(e, patch);
  render();   // 卡片由 React 渲染：改共享 state 后 tick 重绘（旧 paintCardFlag 就地改 DOM 移除）
  try {
    const res = await apiFetch('/api/entries/' + encodeURIComponent(id), {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return true;
  } catch (err) {
    Object.assign(e, before); render();
    toast('标记失败：' + (err.message || err), false);
    return false;
  }
}

/** App Shell（顶栏）一次性快照：React 的 TopBar 经桥 getShell() 读取 */
function shellSnapshot() {
  const mode = THEME_MODES.indexOf(currentThemeMode()) >= 0 ? currentThemeMode() : 'auto';
  const meta = THEME_META[mode];
  return {
    stat: state.entries.length,
    subtitle: subtitleText(),
    view: state.tab,
    themeLabel: meta.label,
    themeIco: meta.ico,
    installReady: !!deferredInstall,
    statVisible: state.tab === 'cards',
  };
}

/* ============================================================
 * window.shiyue 桥（混合期临时方案）
 * ------------------------------------------------------------
 * React 组件（如命令面板）通过这个对象读取 / 操作旧 app 的能力：
 *   state            全局状态对象（原地修改，实时引用，feedList 等直接读）
 *   switchView / applyTheme / openSettings / selectScope / jumpToFeed
 *   focusSearchBox / exportOpml / shortFeedName / feedTitle
 *   prefersReducedMotion / THEME_MODES / THEME_META
 *   refresh / scrollTop    常用操作的小包装
 *   loadFeeds / loadPage / renderReaderChannels / scheduleAutoRefresh   （阅读页见 P3c）
 *   setLayout / setSettingsSummary / bindSections / groupFeeds   P2c 数据源面板
 * 注意：必须在文件末尾建立，上游 const（THEME_MODES 等）此时已初始化。
 * 待视图与设置全部 React 化、旧 app.js 退役后，此桥一并拆除。
 * ============================================================ */
window.shiyue = {
  state,
  switchView, applyTheme, openSettings, selectScope, jumpToFeed,
  focusSearchBox, exportOpml, shortFeedName, feedTitle, prefersReducedMotion,
  THEME_MODES, THEME_META,
  refresh: refreshFeeds,
  cycleTheme,
  scrollTop: () => window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' }),
  // —— v1.3.0 起 React 化组件的桥接面（设置弹层 / 外观 / 关于） ——
  apiFetch, isAdmin, toast,
  lockPageScroll, unlockPageScroll,
  getSettingsSummary,
  getAppearance: readAppearance, setAppearance, resetAppearance,
  // —— v1.5.0 起数据源面板 React 化（P2c，组件见 src/settings/SourcePane.jsx） ——
  loadFeeds, loadPage, renderReaderChannels,
  scheduleAutoRefresh, setLayout, setSettingsSummary,
  bindSections, groupFeeds,
  // —— v1.6.0 起账号 / 状态面板 React 化（P2d，组件见 src/settings/AccountPane.jsx / StatusPane.jsx） ——
  promptInstall,
  // —— v1.7.0 起 AI 视图 React 化（P3a，组件见 src/ai/AiView.jsx） ——
  getAiPage: () => aiPage,
  setAiPage: (n) => { aiPage = (['digest', 'settings'].indexOf(n) >= 0) ? n : 'digest'; setLayout('aiPage', aiPage); },
  linkLabel,
  // —— v1.8.0 起卡片视图 React 化（P3b，组件见 src/views/CardsView.jsx） ——
  filterEntries: () => applyFilters(),
  cardsSearch: (v) => { state.q = v; state.tag = null; return loadPage(true); },
  cardsFilterFeed: (v) => { state.feedFilter = v ? v : null; state.tag = null; return loadPage(true); },
  cardsSort: (v) => { state.sort = v; setLayout('sort', v); render(); },
  cardsSize: (v) => { state.size = v; render(); },
  cardsView: (m) => setViewMode(m),
  cardsTag: (t) => { state.tag = t || null; render(); window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' }); },
  cardsLoadMore: () => loadPage(false),
  cardsSetFlag: (id, patch) => cardSetFlag(id, patch),
  copyText, openLinkMenu, fmtDate,
  // —— v1.10.0 起 App Shell 顶栏 React 化（P4a，组件见 src/shell/TopBar.jsx） ——
  getShell: shellSnapshot,
  // —— v1.9.0 起文章视图 React 化（P3c，组件见 src/views/ReaderView.jsx） ——
  fmtFull,
  readerSetScope, readerSetFeed, readerSetGroup, readerOpenSource,
  readerSearch, readerToggleArt, readerCollapseAll, readerReadAll,
  readerToggleFav, readerTagToCards, readerToggleAccordion, readerAccordionOn,
  readerToggleDrawer, readerCloseDrawer,
};

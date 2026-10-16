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
  config: null,
  digest: null,       // { dates: [], current: null }
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
// 排序下拉回填账号偏好值（否则数据按 name 排但下拉显示「最新」）
const _sortSel = document.getElementById('sortSelect');
if (_sortSel) _sortSel.value = state.sort;

/* ---------------- DOM ---------------- */
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
const grid = $('#grid');
const skeleton = $('#skeleton');
const emptyBox = $('#empty');
const tagBar = $('#tagBar');
const loadMoreBtn = $('#loadMoreBtn');
const loadingMore = $('#loadingMore');
const toastEl = $('#toast');
const statCount = $('#statCount');
const subtitle = $('#subtitle');
const feedSelect = $('#feedSelect');
const digestBody = $('#digestBody');
const digestDateSel = $('#digestDate');
const digestSub = $('#digestSub');
const dgResult = $('#dgResult');
const feedResult = $('#feedResult');
const viewModeEl = $('#viewMode');
/* 阅读页 */
const readerChannels = $('#readerChannels');
const readerSideN = $('#readerSideN');
const readerList = $('#readerList');
const readerTitle = $('#readerTitle');
const readerEmpty = $('#readerEmpty');
const readerMore = $('#readerMore');
const readerCollapseAll = $('#readerCollapseAll');
const readerReadAllBtn = $('#readerReadAllBtn');

/* ---------------- 工具 ---------------- */
/** 带登录态处理的 fetch：401 时跳登录页 */
async function apiFetch(url, opts) {
  const res = await fetch(url, opts);
  if (res.status === 401) {
    location.replace('/login.html?next=' + encodeURIComponent(location.pathname + location.search));
    throw new Error('未登录');
  }
  checkAppBuild(res);
  return res;
}

/* 部署新版本后，已经打开的旧标签页不会自动拿到新代码（SPA 不刷新就是旧 JS），
   曾导致「明明修了、页面还是老样子」。服务端在每次 API 响应头里带 X-App-Build
   （容器重建即变），这里发现与本地记录不一致就弹一条可点击的提示条，用户点了才刷新 —— 不强制打断阅读。 */
function checkAppBuild(res) {
  try {
    const v = res.headers.get('X-App-Build');
    if (!v) return;
    const KEY = 'shiyue.appBuild.v1';
    const prev = localStorage.getItem(KEY);
    if (prev === v) return;
    localStorage.setItem(KEY, v);
    if (prev === null) return; // 首次访问只记基线，不提示
    showUpdateBar();
  } catch (_) { /* localStorage 不可用等，静默忽略 */ }
}

function showUpdateBar() {
  if (document.getElementById('updBar')) return;
  const bar = document.createElement('button');
  bar.id = 'updBar';
  bar.type = 'button';
  bar.textContent = '新版本已发布，点此刷新生效';
  bar.addEventListener('click', () => location.reload());
  document.body.appendChild(bar);
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

/** 设置面板里显示「今天 12:36」这类相对时间 */
function fmtDateTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const yesterday = new Date(now.getTime() - 86400000).toDateString() === d.toDateString();
  if (sameDay) return `今天 ${hm}`;
  if (yesterday) return `昨天 ${hm}`;
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${hm}`;
}

/** 订阅地址只显示「主机名 + 路径」，太长就截断 */
function prettyUrl(u) {
  try {
    const x = new URL(u);
    const path = x.pathname.replace(/\/$/, '');
    const s = x.host + path;
    return s.length > 64 ? s.slice(0, 62) + '…' : s;
  } catch (_) { return String(u || ''); }
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
/* 内联 SVG 图标：符号定义在 index.html 顶部的 sprite 里（#i-xxx）。
   一律用这套，别再用 ⟳ ★ ✕ 这类字符图标 —— 它们在 Windows / Android / iOS
   上的字形、粗细、基线各不相同，同一排按钮会显得参差不齐。 */
function icon(name, cls) {
  return `<svg class="ico${cls ? ' ' + cls : ''}" aria-hidden="true" focusable="false"><use href="#i-${name}"/></svg>`;
}

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
function saveCollapsedGroups(set) {
  setLayout('collapsedGroups', [...set]);
}

/** 把模式写到 state / DOM / 按钮态；persist=true 时才写账号（手动切换才记） */
function applyViewMode(mode, persist) {
  state.view = VIEW_MODES.indexOf(mode) >= 0 ? mode : 'grid';
  const isList = state.view === 'list';
  if (persist) setLayout('view', state.view);

  grid.classList.toggle('list-mode', isList);
  skeleton.classList.toggle('list-mode', isList);
  viewModeEl.querySelectorAll('.viewmode-btn').forEach((b) => {
    b.classList.toggle('active', b.getAttribute('data-mode') === state.view);
  });
}

/** 用户点击切换：切完立刻按新模式重绘（有数据就重绘数据，没数据就重绘骨架） */
function setViewMode(mode) {
  if (mode === state.view) return;
  applyViewMode(mode, true);
  if (state.entries.length) render();
  else renderSkeletons();
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
  renderFeedSelect();
  return data;
}

/** 工具栏的频道筛选下拉：只列「卡片开关」打开的频道，按分组用 optgroup 归拢 */
function renderFeedSelect() {
  const feeds = (state.feedList || []).filter((f) => f.cardEnabled);
  const cur = state.feedFilter == null ? '' : String(state.feedFilter);

  const opt = (f) => `<option value="${escapeHtml(f.id)}">${escapeHtml(shortFeedName(feedTitle(f)))}（${f.entryCount}）</option>`;
  let html = `<option value="">全部频道（${feeds.length}）</option>`;
  for (const g of groupFeeds(feeds)) {
    const opts = g.feeds.map(opt).join('');
    html += g.name
      ? `<optgroup label="${escapeHtml(g.name)}">${opts}</optgroup>`
      : opts;
  }
  feedSelect.innerHTML = html;
  feedSelect.value = cur;
  // 之前筛选的频道被关掉卡片开关 / 删掉了，回落到全部
  if (feedSelect.value !== cur) { state.feedFilter = null; feedSelect.value = ''; }
}

async function loadPage(reset = false) {
  if (state.loading) return;
  state.loading = true;

  if (reset) { state.offset = 0; state.hasMore = true; state.entries = []; }

  const first = state.entries.length === 0;
  if (first) { skeleton.hidden = false; renderSkeletons(); grid.hidden = true; }
  else { loadingMore.hidden = false; }
  loadMoreBtn.hidden = true;
  emptyBox.hidden = true;

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

    skeleton.hidden = true;
    grid.hidden = false;
    render();
  } catch (err) {
    skeleton.hidden = true;
    grid.hidden = false;
    if (first) {
      emptyBox.hidden = false;
      emptyBox.querySelector('p').textContent = '数据加载失败，请稍后点击「刷新」重试';
    } else {
      toast('加载失败：' + (err.message || err), false);
    }
  } finally {
    state.loading = false;
    loadingMore.hidden = true;
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
function updateSubtitle() {
  const meta = state.feedMeta;
  if (!meta) { subtitle.textContent = '正在加载频道…'; return; }
  if (!meta.total) { subtitle.textContent = '还没有订阅源 · 点右上角「设置 → 数据源」添加 RSS'; return; }
  subtitle.textContent = `${state.tagline} · 采集 ${meta.enabled}/${meta.total} 个频道`
    + (Number(meta.cardEnabled) !== Number(meta.enabled) ? ` · 卡片展示 ${meta.cardEnabled} 个` : '');
}

function render() {
  const list = applyFilters();
  statCount.textContent = state.entries.length;
  updateSubtitle();
  renderTagBar();

  if (!state.feedList || !state.feedList.length) {
    grid.innerHTML = '';
    emptyBox.hidden = false;
    emptyBox.querySelector('p').innerHTML = '还没有订阅源，点右上角「设置 → 数据源」添加 RSS 地址';
    loadMoreBtn.hidden = true;
    return;
  }
  // 有频道，但「卡片」开关一个都没开 —— 这时候不该报「没有找到匹配的资源」，误导
  if (!state.feedFilter && !state.feedList.some((f) => f.cardEnabled)) {
    grid.innerHTML = '';
    emptyBox.hidden = false;
    emptyBox.querySelector('p').innerHTML = '所有频道的「卡片」开关都关掉了。去「设置 → 数据源」打开，或切到「文章」页阅读';
    loadMoreBtn.hidden = true;
    return;
  }
  if (!list.length) {
    grid.innerHTML = '';
    emptyBox.hidden = false;
    emptyBox.querySelector('p').textContent = state.q
      ? '没有找到匹配的资源'
      : (state.tag ? '该标签下暂无内容' : '所选频道暂无内容');
    loadMoreBtn.hidden = true;
    return;
  }
  emptyBox.hidden = true;
  grid.innerHTML = list.map(state.view === 'list' ? rowHtml : cardHtml).join('');
  bindCardActions(grid);

  grid.querySelectorAll('.mini-tag').forEach((t) => {
    t.addEventListener('click', () => {
      const tag = t.getAttribute('data-tag');
      state.tag = state.tag === tag ? null : tag;
      render();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  });

  loadMoreBtn.hidden = !state.hasMore;
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

/** 该条目可复制的链接（后端 links 数组；老数据退回单条 link） */
function copyableLinks(e) {
  const list = Array.isArray(e.links) ? e.links.filter(Boolean) : [];
  if (list.length) return list;
  return e.link ? [e.link] : [];
}

/** 复制按钮（图标）。多条时点击弹出选择菜单 */
function copyBtnHtml(e, cls = 'btn-copy') {
  const urls = copyableLinks(e);
  if (!urls.length) {
    return `<button class="${cls}" disabled title="无链接" aria-label="无链接">${icon('copy')}</button>`;
  }
  const many = urls.length > 1;
  const title = many ? `复制链接（${urls.length} 条，可选择）` : '复制链接';
  return `<button class="${cls}" type="button" data-copy="${escapeHtml(urls[0])}"`
    + ` data-links="${escapeHtml(JSON.stringify(urls))}" title="${title}" aria-label="复制链接">${icon('copy')}</button>`;
}

/** 打开按钮（图标）：跳转「原文章」（sourceUrl，缺失时退回主链接） */
function openBtnHtml(e, cls = 'btn-open') {
  const url = e.sourceUrl || e.link || null;
  if (!url) return `<span class="${cls} disabled" title="没有原文地址" aria-label="没有原文地址">${icon('external')}</span>`;
  return `<a class="${cls}" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer"`
    + ` title="打开原文章" aria-label="打开原文章">${icon('external')}</a>`;
}

/** 复制到剪贴板 + 按钮反馈 */
async function doCopy(btn, url) {
  const ok = await copyText(url);
  if (!ok) { toast('复制失败，请手动选择链接', false); return; }
  const old = btn.innerHTML;
  const iconOnly = !btn.textContent.trim();
  btn.classList.add('copied');
  btn.innerHTML = iconOnly ? icon('check') : `${icon('check')} 已复制`;
  toast(`已复制：${linkLabel(url)}`);
  setTimeout(() => { btn.classList.remove('copied'); btn.innerHTML = old; }, 1600);
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

/** 统一绑定卡片上的复制 / 图片兜底交互 */
function bindCardActions(root) {
  root.querySelectorAll('[data-copy]').forEach((btn) => {
    btn.addEventListener('click', () => {
      let urls = [];
      try { urls = JSON.parse(btn.getAttribute('data-links') || '[]'); } catch (_) { urls = []; }
      urls = (Array.isArray(urls) ? urls : []).filter(Boolean);
      if (!urls.length) {
        const one = btn.getAttribute('data-copy');
        if (one) urls = [one];
      }
      if (!urls.length) return;
      // 只有一条就直接复制；多条让用户挑（网盘帖常见「百度 / 夸克 / 阿里」并列）
      if (urls.length === 1) doCopy(btn, urls[0]);
      else openLinkMenu(btn, urls, (u) => doCopy(btn, u));
    });
  });

  root.querySelectorAll('.card-media img, .row-thumb img, .dg-item-thumb, .art-img').forEach((img) => {
    // 已缓存（complete 且确实拿到了图）直接标 ready，避免再转一次流光
    if (img.complete && img.naturalWidth > 0) img.classList.add('img-ready');
    else {
      img.addEventListener('load', () => img.classList.add('img-ready'), { once: true });
      // 已读缓存但 naturalWidth 为 0（比如 data: 占位）也别一直空转
      img.addEventListener('error', () => img.classList.add('img-ready'), { once: true });
    }
    img.addEventListener('error', () => {
      // 图片代理偶发 502/504（源站瞬时抖动）时先自动重试一次，仍失败再走降级
      if (!img.dataset.retried && img.getAttribute('src')) {
        img.dataset.retried = '1';
        img.src = img.src.split('#')[0] + (img.src.includes('?') ? '&' : '?') + 'r=1';
        return;
      }
      // 阅读页的配图加载失败就直接不显示，塞个占位图反而更难看
      if (img.classList.contains('art-img')) { img.remove(); return; }
      const fb = document.createElement('div');
      fb.className = img.classList.contains('dg-item-thumb') ? 'dg-item-thumb-fb'
        : (img.closest('.row-thumb') ? 'row-thumb-fb' : 'media-fallback');
      fb.innerHTML = icon('image');
      img.replaceWith(fb);
    });
  });
}

function cardHtml(e) {
  const srcName = e.feedName ? shortFeedName(e.feedName) : '';
  const hasImg = !!e.image;

  const tags = e.tags.slice(0, 4)
    .map((t) => `<span class="mini-tag" data-tag="${escapeHtml(t)}">#${escapeHtml(t)}</span>`)
    .join('');

  const desc = e.desc ? `<p class="card-desc">${escapeHtml(e.desc)}</p>` : '';

  const copyBtn = copyBtnHtml(e);
  const openBtn = openBtnHtml(e);

  let media = '';
  let metaRow = '';
  if (hasImg) {
    // 复制/打开按钮浮于图片右下角，腾出底部空间让图片框更高更大
    media = `<div class="card-media">
      <img loading="lazy" src="${escapeHtml(e.image)}" alt="${escapeHtml(e.name)}">
      ${srcName ? `<span class="badge-source" title="${escapeHtml(e.feedName)}">${escapeHtml(srcName)}</span>` : ''}
      ${e.size ? `<span class="badge-size">${escapeHtml(e.size)}</span>` : ''}
      ${e.date ? `<span class="badge-idx">${fmtDate(e.date)}</span>` : ''}
      <div class="card-media-actions">${copyBtn}${openBtn}</div>
    </div>`;
  } else {
    metaRow = `<div class="card-meta">
      ${srcName ? `<span class="src-pill" title="${escapeHtml(e.feedName)}">${escapeHtml(srcName)}</span>` : ''}
      ${e.size ? `<span class="meta-size">${escapeHtml(e.size)}</span>` : ''}
      <span class="meta-date">${fmtDate(e.date)}</span>
    </div>`;
  }

  // 无图卡片没有图片浮层位，按钮仍落到底部操作条
  const foot = hasImg ? '' : `<div class="card-foot">${copyBtn}${openBtn}</div>`;

  return `
    <article class="card" data-id="${escapeHtml(e.id)}">
      ${media}
      <div class="card-body">
        ${metaRow}
        <h3 class="card-title" title="${escapeHtml(e.name)}">${escapeHtml(e.name)}</h3>
        ${desc}
        <div class="card-tags">${tags}</div>
        ${foot}
      </div>
    </article>`;
}

/** 列表视图的一行：缩略图 + 标题/描述/标签 + 操作，复用同一套 data-* 交互 */
function rowHtml(e) {
  const srcName = e.feedName ? shortFeedName(e.feedName) : '';
  const tags = e.tags.slice(0, 4)
    .map((t) => `<span class="mini-tag" data-tag="${escapeHtml(t)}">#${escapeHtml(t)}</span>`)
    .join('');

  const thumb = e.image
    ? `<img loading="lazy" src="${escapeHtml(e.image)}" alt="${escapeHtml(e.name)}">`
    : `<span class="row-thumb-fb">${icon('image')}</span>`;

  const copyBtn = copyBtnHtml(e);
  const openBtn = openBtnHtml(e);

  const meta = [
    srcName ? `<span class="src-pill" title="${escapeHtml(e.feedName)}">${escapeHtml(srcName)}</span>` : '',
    tags,
  ].join('');
  const metaRow = meta.trim() ? `<div class="row-tags">${meta}</div>` : '';

  return `
    <article class="row-item" data-id="${escapeHtml(e.id)}">
      <div class="row-thumb">${thumb}</div>
      <div class="row-main">
        <div class="row-head">
          <h3 class="row-title" title="${escapeHtml(e.name)}">${escapeHtml(e.name)}</h3>
          <span class="row-facts">
            ${e.size ? `<span class="meta-size">${escapeHtml(e.size)}</span>` : ''}
            <span class="row-date">${fmtDate(e.date)}</span>
          </span>
        </div>
        ${e.desc ? `<p class="row-desc">${escapeHtml(e.desc)}</p>` : ''}
        ${metaRow}
      </div>
      <div class="row-actions">
        ${copyBtn}
        ${openBtn}
      </div>
    </article>`;
}

function renderTagBar() {
  const top = (state.tags || []).slice(0, 16);
  if (!top.length) { tagBar.innerHTML = ''; return; }

  tagBar.innerHTML =
    `<span class="tag-chip ${state.tag ? '' : 'active'}" data-tag="">全部</span>` +
    top.map(({ tag, n }) =>
      `<span class="tag-chip ${state.tag === tag ? 'active' : ''}" data-tag="${escapeHtml(tag)}">${escapeHtml(tag)}<span class="cnt">${n}</span></span>`
    ).join('');

  tagBar.querySelectorAll('.tag-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      state.tag = chip.getAttribute('data-tag') || null;
      render();
    });
  });
}

function renderSkeletons(n = 8) {
  if (state.view === 'list') {
    skeleton.innerHTML = Array.from({ length: n }).map(() => `
      <div class="sk-row">
        <div class="sk-row-thumb"></div>
        <div class="sk-row-lines">
          <div class="sk-row-line w70"></div>
          <div class="sk-row-line w90"></div>
          <div class="sk-row-line w40"></div>
        </div>
      </div>`).join('');
    return;
  }
  skeleton.innerHTML = Array.from({ length: n }).map(() => `
    <div class="sk-card">
      <div class="sk-media"></div>
      <div class="sk-line w85"></div>
      <div class="sk-line"></div>
      <div class="sk-line w60"></div>
    </div>`).join('');
}

/* ============================================================
 * 设置面板
 * ============================================================ */
// 设置弹层自 v1.3.0 起外壳 React 化（挂载点 #settingsRoot，组件见 src/settings/）：
// 开合状态由 React 组件同步到 window.__settingsOpen，旧 #settingsMask / #settingsSummary
// DOM 已移除；openSettings / closeSettings 委托给 React 宿主 window.__settingsHost。
const feedListEl = $('#feedList');
const settingsHint = $('#settingsHint');
const accResult = $('#accResult');

/* 管理员专属的 tab（状态）；模型配置每用户独立，普通用户也能配 */
const ADMIN_TABS = ['status'];
const isAdmin = () => state.role === 'admin';

/** 按角色显隐设置里管理员专属的部分：模型/状态 tab、采集参数、用户管理、保存设置、日报设置 */
function applyRoleUI() {
  const admin = isAdmin();
  // 设置弹层 tab 已 React 化：按角色过滤交给宿主（管理员专属 tab 由外壳不再渲染）
  const host = window.__settingsHost;
  if (host && host.setAdminFlag) host.setAdminFlag(admin);
  const srcParams = document.querySelector('[data-sec="src-params"]');
  if (srcParams) srcParams.hidden = !admin;          // 采集参数是站点级设置
  const usersSec = $('#accUsersSec');
  if (usersSec) usersSec.hidden = !admin;            // 用户管理仅管理员
  const saveSrc = $('#saveSourceBtn');
  if (saveSrc) saveSrc.hidden = !admin;              // 普通用户没有「全局采集参数」可存
  const aiSettings = document.querySelector('#aiNav [data-ai="settings"]');
  if (aiSettings) aiSettings.hidden = !admin;        // 日报设置是全局设置
  // 普通用户若正停在管理员子页（如深链 #ai/settings），退回默认子页
  if (!admin && aiPage === 'settings') switchAiPage('digest');
}

/** 设置弹层 tab 切换的副作用（v1.3.0 起由 React 外壳在打开 / 切 tab 时经桥调用）。
 *  tab 高亮与面板显隐由 React 层管理（legacy 面板搬入 / 还回插槽），这里只加载
 *  对应表单并启停状态轮询；显隐循环做了 legacy 容器兜底，防止节点遗落在错误状态。 */
function settingsTabEffect(name) {
  if (!isAdmin() && ADMIN_TABS.indexOf(name) >= 0) name = 'source';   // 普通用户看不到这些 tab
  $$('#legacyPanes .tab-pane, .tab-pane-legacy .tab-pane').forEach((p) => {
    p.hidden = p.getAttribute('data-pane') !== name;
  });
  if (name === 'source') loadSourceForm();
  // 「日报」已经不是这里的 tab 了，搬去「AI → 日报设置」子页
  if (name === 'account') loadAccountForm();
  // appearance / model / about 已 React 化，随面板挂载自行加载，无旧 loader
  // 状态页是唯一会自己轮询的页面，切走就停，别在后台空转
  if (name === 'status') { loadStatusForm(); startStatusPolling(); } else stopStatusPolling();
}

/** legacy 设置面板查询（React 外壳搬运用）：面板只存在于 #legacyPanes 隐藏容器
 *  或弹层内的 .tab-pane-legacy 插槽，全局查找两个位置都能命中 */
function getLegacySettingsPane(tab) {
  return document.querySelector('[data-pane="' + tab + '"]');
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

function showResult(el, ok, msg) {
  if (!el) return;
  el.textContent = msg;
  el.className = 'test-result show ' + (ok ? 'ok' : 'err');
  if (ok) setTimeout(() => { el.className = 'test-result'; }, 4000);
}

/* ---------- 数据源 ---------- */
let srcFormReady = false;   // 表单是否已被配置填充过；没填充就禁止保存，避免把兜底值当成用户设置存下去

/** 给 select 赋一个可能不在选项列表里的值：不在就先补一个选项，避免静默回落到第一项（会把设置改坏） */
function setSelectValue(el, val) {
  if (!el) return;
  const v = String(val == null ? '' : val);
  if (![...el.options].some((o) => o.value === v)) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = v;
    el.appendChild(o);
  }
  el.value = v;
}

async function loadSourceForm() {
  srcFormReady = false;
  try {
    // 「采集参数」是站点级设置，只有管理员能读 /api/config；普通用户只取自己的频道列表
    const admin = isAdmin();
    const [feedsRes, cfgRes] = await Promise.all([
      apiFetch('/api/feeds'),
      admin ? apiFetch('/api/config') : Promise.resolve(null),
    ]);
    if (!feedsRes.ok) throw new Error('HTTP ' + feedsRes.status);
    const data = await feedsRes.json();
    state.feedList = data.feeds || [];
    state.feedMeta = data;
    state.groupOrder = Array.isArray(data.groupOrder) ? data.groupOrder : [];
    state.collapsedGroups = loadCollapsedGroups();
    if (admin && cfgRes) {
      state.config = await cfgRes.json();
      const src = state.config.source || {};
      setSelectValue($('#srcRefresh'), src.refreshMinutes);
      $('#srcKeep').value = String(src.keepPerFeed);
      setSelectValue($('#srcKeepDays'), src.keepDays == null ? 0 : src.keepDays);
      $('#srcTimeout').value = String(src.timeoutSeconds);
      $('#srcConcurrency').value = String(src.concurrency);
      setSelectValue($('#srcAutoRefresh'), src.autoRefreshMinutes == null ? 0 : src.autoRefreshMinutes);
      $('#srcProxy').value = String(src.proxyUrl || '');
      updateSourceParamsSub();
    }
    renderFeedList();
    renderFeedSelect();
    srcFormReady = true;
    scheduleAutoRefresh();   // 间隔刚可能被改过，重启定时器
  } catch (err) {
    feedListEl.innerHTML = `<div class="hint" style="padding:20px">读取失败：${escapeHtml(err.message || String(err))}</div>`;
  }
}

function feedStatusText(f) {
  const parts = [`${f.entryCount} 条`];
  parts.push(f.lastFetchedAt ? fmtDateTime(f.lastFetchedAt) + ' 抓取' : '尚未抓取');
  parts.push(`每 ${fmtMinutes(f.effectiveRefreshMinutes)}`);
  if (!f.enabled && f.lastFetchedAt) parts.push('已停采');
  return parts.join(' · ');
}

/** 频率选项：与「设置 → 数据源」的全局间隔保持一致的可读写法 */
const FREQ_OPTIONS = [
  [5, '每 5 分钟'], [10, '每 10 分钟'], [15, '每 15 分钟'], [20, '每 20 分钟'],
  [30, '每 30 分钟'], [60, '每 1 小时'], [120, '每 2 小时'], [180, '每 3 小时'],
  [360, '每 6 小时'], [720, '每 12 小时'], [1440, '每天'],
];

function fmtMinutes(m) {
  const n = Number(m);
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n < 60) return `${n} 分钟`;
  if (n === 60) return '1 小时';
  if (n < 1440) return `${(n / 60).toFixed(n % 60 ? 1 : 0)} 小时`;
  return '1 天';
}

function renderFeedList() {
  const feeds = state.feedList || [];
  if (!feeds.length) {
    feedListEl.innerHTML = '<div class="hint" style="padding:24px 12px">还没有订阅源，在上方粘贴一个 RSS 地址试试</div>';
    updateSourceSummary();
    return;
  }

  // 分组名的候选列表：供每行的分组输入框下拉选择
  const groupList = $('#groupList');
  if (groupList) {
    groupList.innerHTML = (state.feedMeta && state.feedMeta.groups || [])
      .map((g) => `<option value="${escapeHtml(g)}"></option>`).join('');
  }

  // 全局抓取间隔：每行的「跟随全局（N 分钟）」要显示真实值
  const gMins = (state.feedMeta && state.feedMeta.refreshMinutes) || 30;

  const GRIP_SVG = '<svg class="ico drag-grip" aria-hidden="true" focusable="false" viewBox="0 0 16 16"><circle cx="5" cy="3.5" r="1.35"/><circle cx="11" cy="3.5" r="1.35"/><circle cx="5" cy="8" r="1.35"/><circle cx="11" cy="8" r="1.35"/><circle cx="5" cy="12.5" r="1.35"/><circle cx="11" cy="12.5" r="1.35"/></svg>';
  const rowHtmlFor = (f, order) => {
    const name = shortFeedName(feedTitle(f));
    const avatar = f.icon
      ? `<img class="feed-avatar" src="${escapeHtml(f.icon)}" alt="" loading="lazy">`
      : `<span class="feed-avatar feed-avatar-txt">${escapeHtml((name || '?').slice(0, 1))}</span>`;
    const err = f.status === 'error'
      ? `<span class="err" title="${escapeHtml(f.error || '')}">${icon('alert')} 抓取失败</span>` : '';
    const cls = [f.enabled ? '' : 'off', f.cardEnabled ? '' : 'no-card'].filter(Boolean).join(' ');
    return `
      <div class="feed-row ${cls}" data-id="${escapeHtml(f.id)}">
        <span class="drag-handle" title="拖动排序：组内重排，或拖到其它分组" aria-label="拖动排序">${GRIP_SVG}</span>
        <input class="feed-order" type="number" min="1" value="${order}" data-order="${escapeHtml(f.id)}"
               title="序号：填数字调整在本组内的顺序（与拖拽并存）" aria-label="序号">
        ${avatar}
        <div class="feed-info">
          <div class="feed-title" title="${escapeHtml(feedTitle(f))}">${escapeHtml(name)}</div>
          <div class="feed-url" title="${escapeHtml(f.url)}">${escapeHtml(prettyUrl(f.url))}</div>
          <div class="feed-stat">${escapeHtml(feedStatusText(f))} ${err}</div>
          <div class="feed-metas">
            <label class="feed-group">
              <span>分组</span>
              <input type="text" list="groupList" data-group="${escapeHtml(f.id)}"
                     value="${escapeHtml(f.groupName || '')}" placeholder="未分组" maxlength="40"
                     spellcheck="false" autocomplete="off">
            </label>
            <label class="feed-group">
              <span>频率</span>
              <select class="feed-freq${f.refreshMinutes == null ? '' : ' own'}"
                      data-freq="${escapeHtml(f.id)}" title="这个频道多久抓一次；未设置则跟随全局">
                <option value=""${f.refreshMinutes == null ? ' selected' : ''}>跟随全局（${escapeHtml(fmtMinutes(gMins))}）</option>
                ${FREQ_OPTIONS.map(([v, t]) => `<option value="${v}"${f.refreshMinutes === v ? ' selected' : ''}>${t}</option>`).join('')}
              </select>
            </label>
          </div>
        </div>
        <div class="feed-actions">
          <label class="feed-sw" title="采集：开启后定时抓取这个频道的新条目">
            <span class="feed-sw-label">采集</span>
            <span class="switch">
              <input type="checkbox" data-toggle="${escapeHtml(f.id)}" ${f.enabled ? 'checked' : ''}>
              <span class="switch-slider"></span>
            </span>
          </label>
          <label class="feed-sw" title="卡片：开启后在「卡片」页展示这个频道的条目">
            <span class="feed-sw-label">卡片</span>
            <span class="switch">
              <input type="checkbox" data-card-toggle="${escapeHtml(f.id)}" ${f.cardEnabled ? 'checked' : ''}>
              <span class="switch-slider"></span>
            </span>
          </label>
          <button class="feed-icon-btn" data-rename="${escapeHtml(f.id)}" title="重命名">${icon('edit')}</button>
          <button class="feed-icon-btn" data-refresh="${escapeHtml(f.id)}" title="立即抓取">${icon('refresh')}</button>
          <button class="feed-icon-btn danger" data-del="${escapeHtml(f.id)}" title="删除该订阅">${icon('trash')}</button>
        </div>
      </div>`;
  };

  feedListEl.innerHTML = groupFeeds(feeds).map((g) => {
    const isCollapsed = (g.name && state.collapsedGroups.has(g.name));
    const head = g.name
      ? `<div class="feed-group-head ${isCollapsed ? 'collapsed' : ''}" data-group="${escapeHtml(g.name)}"><span class="drag-handle" title="拖动排序分组" aria-label="拖动排序分组">${GRIP_SVG}</span><span class="feed-group-caret" aria-hidden="true"></span><span class="feed-group-name">${escapeHtml(g.name)}</span><span class="feed-group-n">${g.feeds.length}</span></div>`
      : (feeds.some((f) => String(f.groupName || '').trim())
        ? `<div class="feed-group-head ${isCollapsed ? 'collapsed' : ''}" data-group=""><span class="feed-group-caret" aria-hidden="true"></span><span class="feed-group-name muted">未分组</span><span class="feed-group-n">${g.feeds.length}</span></div>`
        : '');
    const rows = isCollapsed ? '' : g.feeds.map((f, i) => rowHtmlFor(f, i + 1)).join('');
    return head + rows;
  }).join('');

  updateSourceSummary();
}

/* ---------------- 拖拽排序（设置-数据源） ----------------
 * Pointer 事件实现，桌面 + 触屏通用，且能被 CDP 模拟（不像 HTML5 DnD 难触发）。
 * - 频道行：拖拽手柄可拖动，组内重排、跨组移动（自动改 groupName）
 * - 分组标题：拖拽手柄可拖动，标题之间重排（落库分组顺序 groupOrder）
 * 落库：频道重排 / 跨组 → /api/feeds/reorder（按组重算 sort_order）；
 *       分组重排 → /api/config（groupOrder）。sort_order 是全局排序轴，组内顺序由它决定。 */
let dragCtx = null;

feedListEl.addEventListener('pointerdown', (ev) => {
  const h = ev.target.closest('.drag-handle');
  if (!h) return;
  const row = h.closest('.feed-row');
  const head = h.closest('.feed-group-head');
  if (row) onDragHandleDown(ev, 'feed', { id: row.getAttribute('data-id') });
  else if (head) {
    const g = head.getAttribute('data-group') || '';
    if (g === '') return;                       // 「未分组」不可拖动（仍可作放置目标）
    onDragHandleDown(ev, 'group', { group: g });
  }
});

function onDragHandleDown(ev, kind, payload) {
  if (ev.button != null && ev.button !== 0) return;
  ev.preventDefault();
  dragCtx = {
    kind, x0: ev.clientX, y0: ev.clientY, moved: false,
    id: payload.id, group: payload.group,
    el: kind === 'feed' ? ev.target.closest('.feed-row') : ev.target.closest('.feed-group-head'),
  };
  document.addEventListener('pointermove', onDragMove, { passive: false });
  document.addEventListener('pointerup', onDragEnd);
  document.addEventListener('pointercancel', onDragEnd);
}

function onDragMove(ev) {
  if (!dragCtx) return;
  if (!dragCtx.moved) {
    if (Math.hypot(ev.clientX - dragCtx.x0, ev.clientY - dragCtx.y0) < 6) return;
    dragCtx.moved = true;
    document.body.classList.add('is-dragging-feeds');
  }
  ev.preventDefault();
  // 拖动的源元素隐藏命中，便于 elementFromPoint 找到真正的放置目标
  if (dragCtx.el) dragCtx.el.style.pointerEvents = 'none';
  const under = document.elementFromPoint(ev.clientX, ev.clientY);
  if (!under) { dragCtx.target = null; clearDropIndicator(); return; }
  if (dragCtx.kind === 'feed') {
    const row = under.closest('.feed-row');
    const head = under.closest('.feed-group-head');
    let elm = null, before = true, group = '';
    if (row && dragCtx.el && !row.contains(dragCtx.el)) {
      const r = row.getBoundingClientRect();
      before = ev.clientY < r.top + r.height / 2;
      elm = row; group = groupOfRow(row);
    } else if (head && dragCtx.el && !head.contains(dragCtx.el)) {
      elm = head; group = head.getAttribute('data-group') || ''; before = true;
    }
    if (!elm) { dragCtx.target = null; clearDropIndicator(); return; }
    dragCtx.target = { elm, before, group, type: (head && elm === head) ? 'head' : 'row' };
    markDrop(elm, before);
  } else {
    const head = under.closest('.feed-group-head');
    let elm = null, before = true;
    if (head && dragCtx.el && !head.contains(dragCtx.el)) {
      const r = head.getBoundingClientRect();
      before = ev.clientY < r.top + r.height / 2;
      elm = head;
    }
    if (!elm) { dragCtx.target = null; clearDropIndicator(); return; }
    dragCtx.target = { elm, before, group: head.getAttribute('data-group') || '', type: 'group' };
    markDrop(elm, before);
  }
}

function groupOfRow(row) {
  const id = row.getAttribute('data-id');
  if (!id) return '';
  const f = (state.feedList || []).find((x) => String(x.id) === String(id));
  return f ? (f.groupName || '') : '';
}

function clearDropIndicator() {
  feedListEl.querySelectorAll('.drag-over-before, .drag-over-after')
    .forEach((e) => e.classList.remove('drag-over-before', 'drag-over-after'));
}
function markDrop(elm, before) {
  clearDropIndicator();
  if (elm) elm.classList.add(before ? 'drag-over-before' : 'drag-over-after');
}

function onDragEnd() {
  document.removeEventListener('pointermove', onDragMove);
  document.removeEventListener('pointerup', onDragEnd);
  document.removeEventListener('pointercancel', onDragEnd);
  document.body.classList.remove('is-dragging-feeds');
  if (dragCtx && dragCtx.el) dragCtx.el.style.pointerEvents = '';
  clearDropIndicator();
  const ctx = dragCtx; dragCtx = null;
  if (!ctx || !ctx.moved || !ctx.target) return;
  if (ctx.kind === 'feed') applyFeedReorder(ctx);
  else applyGroupReorder(ctx);
}

function applyFeedReorder(ctx) {
  const dragId = ctx.id;
  const grouped = groupFeeds(state.feedList);
  for (const g of grouped) {
    const i = g.feeds.findIndex((f) => String(f.id) === String(dragId));
    if (i >= 0) { g.feeds.splice(i, 1); break; }
  }
  const t = ctx.target;
  let gi = grouped.findIndex((g) => g.name === t.group);
  if (gi < 0) { grouped.push({ name: t.group || '', feeds: [] }); gi = grouped.length - 1; }
  let idx;
  if (t.type === 'head') idx = 0;
  else {
    const tid = t.elm.getAttribute('data-id');
    idx = grouped[gi].feeds.findIndex((f) => String(f.id) === String(tid));
    if (idx < 0) idx = grouped[gi].feeds.length;
    else if (!t.before) idx += 1;
  }
  const dragFeed = (state.feedList || []).find((f) => String(f.id) === String(dragId));
  if (!dragFeed) return;
  dragFeed.groupName = t.group || '';
  grouped[gi].feeds.splice(idx, 0, dragFeed);
  flattenAndRenumber(grouped);
  renderFeedList();
  renderReaderChannels();
  persistReorder();
}

function applyGroupReorder(ctx) {
  const order = (state.groupOrder || []).slice();
  const i = order.indexOf(ctx.group);
  if (i >= 0) order.splice(i, 1);
  const t = ctx.target;
  let j = order.indexOf(t.group);
  if (j < 0) j = order.length;
  else if (!t.before) j += 1;
  order.splice(j, 0, ctx.group);
  state.groupOrder = order;
  const grouped = groupFeeds(state.feedList);
  flattenAndRenumber(grouped);
  renderFeedList();
  renderReaderChannels();
  persistReorder();
  persistGroupOrder();
}

// 按 groupOrder 把分组铺平为全局数组（组内保持相对顺序），并给每组重算 sort_order
function flattenAndRenumber(grouped) {
  const order = state.groupOrder || [];
  const seq = [];
  for (const n of order) { const g = grouped.find((g) => g.name === n); if (g) seq.push(g); }
  for (const g of grouped) if (!order.includes(g.name)) seq.push(g);
  const flat = [];
  let so = 0;
  for (const g of seq) for (const f of g.feeds) { f.sortOrder = so++; flat.push(f); }
  state.feedList = flat;
}

async function persistReorder() {
  const items = (state.feedList || []).map((f) => ({ id: f.id, sortOrder: f.sortOrder, groupName: f.groupName || '' }));
  try {
    await apiFetch('/api/feeds/reorder', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ feeds: items }),
    });
  } catch (e) { console.error('保存排序失败', e); if (typeof toast === 'function') toast('排序保存失败'); }
}

async function persistGroupOrder() {
  try {
    // 分组顺序是「每用户」偏好，走 /api/prefs（普通用户也能保存自己的分组顺序）
    await apiFetch('/api/prefs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupOrder: state.groupOrder }),
    });
  } catch (e) { console.error('保存分组顺序失败', e); }
}

// 手动填序号：把某频道排到所在分组的第 N 位（1 基），与拖拽并存。
// 只在「本组」内调整顺序；跨组仍用拖拽（拖拽会改 groupName）。
function applyNumericOrder(id, pos) {
  if (!Number.isFinite(pos) || pos < 1) { renderFeedList(); return; } // 非法输入：恢复显示
  const feeds = state.feedList || [];
  const grouped = groupFeeds(feeds);
  let src = null;
  for (const g of grouped) {
    const i = g.feeds.findIndex((f) => String(f.id) === String(id));
    if (i >= 0) { src = g; break; }
  }
  if (!src) return;
  const feed = src.feeds.splice(src.feeds.findIndex((f) => String(f.id) === String(id)), 1)[0];
  const p = Math.min(Math.max(1, Math.floor(pos)), src.feeds.length + 1);
  src.feeds.splice(p - 1, 0, feed);
  flattenAndRenumber(grouped);   // 重算全局 sort_order（组内顺序由它决定）
  renderFeedList();
  renderReaderChannels();
  persistReorder();
}

// 折叠 / 展开分组（状态按账号持久化）
function toggleGroupCollapse(name) {
  const set = state.collapsedGroups;
  if (set.has(name)) set.delete(name); else set.add(name);
  saveCollapsedGroups(set);
  renderFeedList();
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

function updateSourceSummary() {
  const meta = state.feedMeta || {};
  const total = meta.total || 0;
  const on = meta.enabled || 0;
  const card = meta.cardEnabled == null ? on : meta.cardEnabled;
  const groups = (meta.groups || []).length;

  setSettingsSummary(getSettingsSummary());

  const bits = [];
  bits.push(`<strong>${on}</strong> / ${total} 个频道在定时采集`);
  bits.push(`<strong>${card}</strong> 个在「卡片」页展示`);
  if (groups) bits.push(`${groups} 个分组`);
  settingsHint.innerHTML = total ? bits.join(' · ') : '添加一个 RSS 地址即可开始';

  const tb = $('#feedToolbarHint');
  if (tb) {
    const own = (state.feedList || []).filter((f) => f.refreshMinutes != null).length;
    tb.textContent = total
      ? `${total} 个频道${groups ? ` · ${groups} 个分组` : ''}`
        + (own ? ` · ${own} 个单独设了频率` : '')
        + ' · 改分组或频率后即保存'
      : '';
  }
}

/** 「采集参数」折叠分组的摘要行：收起时也能一眼看到当前值，不用展开 */
function updateSourceParamsSub() {
  const el = $('#srcParamsSub');
  if (!el) return;
  const keepDays = Number($('#srcKeepDays').value || 0);
  const keepDaysText = keepDays > 0
    ? (($('#srcKeepDays').selectedOptions[0] || {}).textContent || `${keepDays} 天`)
    : '不限时长';
  const auto = Number($('#srcAutoRefresh').value || 0);
    const keepN = Number($('#srcKeep').value || 0);
    const keepNText = keepN > 0 ? `${keepN} 条` : '不限条数';
    const proxy = String($('#srcProxy').value || '').trim();
    const proxyText = proxy ? ` · 代理 ${proxy.replace(/\/\/[^@]*@/, '//***@')}` : '';
    el.textContent = `每 ${fmtMinutes($('#srcRefresh').value)}抓取 · 保留 ${keepNText}`
    + ` · ${keepDaysText}`
    + (auto ? ` · 页面刷新 ${fmtMinutes(auto)}` : '')
    + proxyText;
}

/* ---------- 账号 ---------- */
/** 「登录信息」折叠分组的摘要行 */
function updateAccountSub() {
  const el = $('#accSub');
  if (el) el.textContent = state.username ? `当前用户 ${state.username}` : '';
}

async function loadAccountForm() {
  // 用户名/角色在启动时已从 /api/session 拿到，不必再打 /api/config（那个现在是管理员专属）
  $('#accUsername').value = state.username || '';
  $('#accCurrent').value = '';
  $('#accNew').value = '';
  accResult.className = 'test-result';
  updateAccountSub();
  if (isAdmin()) loadUserList();
}

/* ============================================================
 * 状态（只读体检页）
 * 数据来自 GET /api/status 的一次快照；页面停留时每 30s 拉一次，
 * 「已运行时长」在本地每秒递增，不必等服务端。
 * ============================================================ */
let statusData = null;        // 最近一次快照，供「复制诊断」用
let statusPoll = null;        // 30s 轮询
let statusTick = null;        // 1s 本地递增运行时长
let statusUptimeBase = null;  // { sec, at } 用于推算当前 uptime

/** 秒 → 粗粒度时长：3 天 4 小时 / 2 小时 5 分 / 42 秒 */
function fmtDuration(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d} 天 ${h} 小时`;
  if (h) return `${h} 小时 ${m} 分`;
  if (m) return `${m} 分 ${s % 60} 秒`;
  return `${s} 秒`;
}

/** 字节 → MB / GB */
function fmtBytes(n) {
  const b = Number(n);
  if (!Number.isFinite(b) || b <= 0) return '—';
  const mb = b / 1048576;
  if (mb >= 1024) return (mb / 1024).toFixed(2) + ' GB';
  return mb.toFixed(mb >= 100 ? 0 : 1) + ' MB';
}

/** 相对时间。dir='past' → 「12 分钟前」；dir='future' → 「约 12 分钟后」 */
function fmtRel(ts, dir) {
  if (!ts) return '';
  const diff = dir === 'future'
    ? new Date(ts).getTime() - Date.now()
    : Date.now() - new Date(ts).getTime();
  const s = Math.abs(Math.round(diff / 1000));
  let txt;
  if (s < 60) txt = `${s} 秒`;
  else if (s < 3600) txt = `${Math.round(s / 60)} 分钟`;
  else if (s < 86400) txt = `${Math.round(s / 3600)} 小时`;
  else txt = `${Math.round(s / 86400)} 天`;
  return dir === 'future' ? `约 ${txt}后` : `${txt}前`;
}

const numFmt = new Intl.NumberFormat('zh-CN');
const fmtNum = (n) => numFmt.format(Number(n) || 0);

/** 一张小指标卡（value 允许放 HTML） */
const statCard = (label, value, sub) => `
  <div class="stat-card">
    <p class="stat-label">${escapeHtml(label)}</p>
    <p class="stat-value">${value}</p>
    ${sub ? `<p class="stat-sub">${escapeHtml(sub)}</p>` : ''}
  </div>`;

/** 一行「键 → 值」，键转义、值放 HTML */
const statRow = (k, v) => `<div class="stat-row"><span class="stat-k">${escapeHtml(k)}</span><span class="stat-v">${v}</span></div>`;

/** 状态页的一个折叠分组。open 只是首次的默认值，用户改过之后以记住的状态为准 */
const statSection = (key, title, sub, open, inner) => `
  <details class="sec" data-sec="${key}"${open ? ' open' : ''}>
    <summary class="sec-head">
      <svg class="sec-arrow" aria-hidden="true" focusable="false"><use href="#i-chevron-right"/></svg>
      <span class="sec-title">${escapeHtml(title)}</span>
      <span class="sec-sub">${escapeHtml(sub)}</span>
    </summary>
    <div class="sec-body">${inner}</div>
  </details>`;

function renderStatus(d) {
  const body = $('#statusBody');
  if (!body) return;

  const app = d.app || {};
  const db = d.db || {};
  const rss = d.rss || {};
  const dg = d.digest || {};
  const f = rss.feeds || {};
  const e = rss.entries || {};
  const last = rss.lastResult;
  const problems = rss.problems || [];
  const mem = app.memory || {};
  const ctn = app.container;

  const dbOk = !!db.ready;
  const hasErr = (f.error || 0) > 0;
  const rssState = !dbOk ? 'bad' : (hasErr ? 'warn' : 'ok');
  const headline = !dbOk
    ? '数据库未就绪' + (db.error ? '：' + db.error : '')
    : (hasErr ? `${f.error} 个频道抓取失败` : '运行正常');

  statusUptimeBase = { sec: Number(app.uptimeSec) || 0, at: Date.now() };

  const out = [];

  /* ---- 健康条：常显 ----
     顶上这一条已经回答了「是否正常」，所以下面的分组默认全收起，
     想深挖哪个再展开 —— 每个分组的标题右侧都带着关键数字，不展开也知道大概。 */
  out.push(`<div class="stat-health">
    <span class="stat-pill"><i class="stat-dot ok"></i>服务</span>
    <span class="stat-pill"><i class="stat-dot ${dbOk ? 'ok' : 'bad'}"></i>数据库</span>
    <span class="stat-pill"><i class="stat-dot ${rssState}"></i>抓取</span>
    <span class="stat-health-msg${dbOk && !hasErr ? '' : ' warn'}">${escapeHtml(headline)}</span>
  </div>`);

  /* ---- 运行实例 + 数据库 ---- */
  // 容器内存取 cgroup 口径（和 docker stats 一致）；进程 RSS 只作对照放副行。
  // 两者不等是正常的：RSS 含共享库等重复计入的页，容器 cgroup 只算真正记在它账上的页。
  const load = app.loadavg || [];
  const cpuPct = ctn && ctn.cpuPercent != null ? ctn.cpuPercent + '%' : null;
  const memUsed = ctn && ctn.memoryUsed ? ctn.memoryUsed : mem.rss;

  out.push(statSection('st-runtime', '运行与数据库',
    `${fmtDuration(app.uptimeSec)} · 内存 ${fmtBytes(memUsed)}`
      + ` · 数据库 ${dbOk ? db.latencyMs + ' ms' : '未就绪'}`,
    false,
    `<h3 class="stat-h">运行实例</h3><div class="stat-grid">
      ${statCard('已运行', `<span id="statUptime">${fmtDuration(app.uptimeSec)}</span>`,
      app.startedAt ? '启动于 ' + fmtFull(app.startedAt) : '')}
      ${statCard(ctn && ctn.memoryUsed ? '容器内存' : '内存占用', fmtBytes(memUsed),
      ctn && ctn.memoryUsed
        ? `进程 RSS ${fmtBytes(mem.rss)}${ctn.memoryLimit ? ' · 上限 ' + fmtBytes(ctn.memoryLimit) : ''}`
        : `堆 ${fmtBytes(mem.heapUsed)}`)}
      ${statCard('Node', escapeHtml(String(app.node || '—')),
      `应用 v${escapeHtml(String(app.version || '—'))} · PID ${escapeHtml(String(app.pid || '—'))}`)}
      ${statCard('系统负载', escapeHtml(String(load[0] != null ? load[0] : '—')),
      `${cpuPct ? '容器 CPU ' + cpuPct + ' · ' : ''}${app.cpuCount || '—'} 核`)}
    </div>
    <h3 class="stat-h">数据库</h3><div class="stat-grid">
      ${statCard('状态', dbOk ? '已连接' : '未就绪',
      dbOk ? `往返 ${db.latencyMs} ms` : (db.error || ''))}
      ${statCard('连接池', db.pool ? `${db.pool.total} / ${db.pool.max}` : '—',
      db.pool ? `空闲 ${db.pool.idle} · 等待 ${db.pool.waiting}` : '')}
      ${statCard('条目总数', fmtNum(db.tables && db.tables.entries), `近 24h 新增 ${fmtNum(e.added24h)}`)}
      ${statCard('日报存档', fmtNum(db.tables && db.tables.digests), dg.oldestDate ? `最早 ${dg.oldestDate}` : '')}
    </div>`));

  /* ---- RSS 采集 ---- */
  const lastLine = last
    ? `${fmtFull(rss.lastRefreshAt)} · 新增 ${last.added} 条 · 耗时 ${(last.durationMs / 1000).toFixed(1)}s`
      + (last.failed ? ` · 失败 ${last.failed} 个` : '')
      + (last.pruned ? ` · 清理 ${last.pruned} 条` : '')
      + (last.skipped ? ` · 跳过 ${last.skipped} 个` : '')
    : '尚未抓取';

  out.push(statSection('st-collect', '采集与条目',
    `${f.total} 个频道 · ${fmtNum(e.total)} 条 · 未读 ${fmtNum(e.unread)} · 收藏 ${fmtNum(e.favorite)}`,
    false,
    `<div class="stat-list">
      ${statRow('抓取间隔', `全局每 ${rss.refreshMinutes} 分钟`
      + (f.perFeedInterval ? ` · ${f.perFeedInterval} 个频道单独设置` : ' · 全部跟随全局')
      + ` · 并发 ${rss.concurrency} · 超时 ${rss.timeoutSeconds}s`)}
      ${statRow('上次抓取', escapeHtml(lastLine))}
      ${statRow('下次抓取', rss.nextRefreshAt
      ? `${fmtFull(rss.nextRefreshAt)} <span class="stat-muted">（${fmtRel(rss.nextRefreshAt, 'future')}`
        + (rss.dueCount ? ` · 已到期 ${rss.dueCount} 个待抓` : '') + '）</span>' : '—')}
      ${statRow('在途抓取', rss.refreshing ? `${rss.refreshing} 个频道正在抓取` : '空闲')}
      ${statRow('频道', `${f.total} 个 · 采集中 ${f.enabled} · 卡片展示 ${f.cardEnabled}`
      + ` · 未抓过 ${f.neverFetched}` + (f.error ? ` · <span class="stat-bad">异常 ${f.error}</span>` : ''))}
      ${statRow('条目', `${fmtNum(e.total)} 条 · 近 24h 新增 ${fmtNum(e.added24h)}`
      + ` · 未读 ${fmtNum(e.unread)} · 收藏 ${fmtNum(e.favorite)}`)}
      ${statRow('保留策略', (rss.keepPerFeed > 0 ? `每频道最多 ${fmtNum(rss.keepPerFeed)} 条` : '每频道不设条数上限')
      + (rss.keepDays ? ` · 最长 ${fmtNum(rss.keepDays)} 天` : ' · 不限时长')
      + ' · <span class="stat-muted">收藏的条目不参与清理</span>')}
      ${statRow('时间跨度', e.oldest && e.newest ? `${fmtFull(e.oldest)} → ${fmtFull(e.newest)}` : '—')}
    </div>`));

  /* ---- 异常频道：只有失败时才出现，且默认展开 —— 这是最不该藏起来的信息 ---- */
  if (problems.length) {
    out.push(statSection('st-problems', '异常频道', `${problems.length} 个频道抓取失败`, true,
      `<div class="stat-problems">${problems.map((p) => `
        <div class="stat-problem">
          <i class="stat-dot bad"></i>
          <span class="stat-problem-name" title="${escapeHtml(p.title)}">${escapeHtml(p.title)}</span>
          <span class="stat-problem-err" title="${escapeHtml(p.error)}">${escapeHtml(p.error)}</span>
          <button class="btn btn-ghost btn-sm" data-retry="${escapeHtml(p.feedId)}">重试</button>
        </div>`).join('')}</div>`));
  }

  /* ---- 日报 ---- */
  const latest = dg.latest;
  const latestLine = latest
    ? `${latest.date} · ${latest.fallback ? '规则降级' : (latest.model || '未配置模型')}`
      + (latest.stats ? ` · 采集 ${latest.stats.collected} → 保留 ${latest.stats.kept} · ${latest.stats.feeds} 频道` : '')
      + (latest.error ? `（大模型失败：${latest.error}）` : '')
    : '还没有生成过';

  out.push(statSection('st-digest', '日报',
    dg.enabled ? `已开启 · 每天 ${dg.time}` : '未开启',
    false,
    `<div class="stat-list">
      ${statRow('自动生成', dg.enabled ? `已开启 · 每天 ${dg.time}` : '未开启')}
      ${statRow('下次生成', dg.nextRunAt
      ? `${fmtFull(dg.nextRunAt)} <span class="stat-muted">（${fmtRel(dg.nextRunAt, 'future')}）</span>` : '—')}
      ${statRow('摘要范围', dg.scope === 'all' ? '全部频道' : '仅「采集」开启的频道')}
      ${statRow('最近一份', escapeHtml(latestLine))}
    </div>`));

  body.innerHTML = out.join('');
  // 状态页每 30s 重绘一次，重绘后必须重新套上展开态，否则用户展开的分组会被冲掉
  bindSections(body);
}

async function loadStatusForm() {
  const body = $('#statusBody');
  if (!body) return;
  const hint = $('#statusHint');
  if (!statusData) body.innerHTML = '<p class="stat-loading">正在读取运行状态…</p>';
  try {
    const res = await apiFetch('/api/status');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    statusData = await res.json();
    renderStatus(statusData);
    if (hint) hint.textContent = '每 30 秒自动刷新 · 内存与 CPU 取自容器 cgroup';
  } catch (err) {
    if (!statusData) body.innerHTML = `<p class="stat-error">读取失败：${escapeHtml(String(err.message || err))}</p>`;
    if (hint) hint.textContent = '读取失败：' + String(err.message || err);
  }
}

function startStatusPolling() {
  stopStatusPolling();
  statusPoll = setInterval(() => { if (window.__settingsOpen) loadStatusForm(); }, 30000);
  // 运行时长本地递增，省掉每秒一次请求
  statusTick = setInterval(() => {
    const el = $('#statUptime');
    if (el && statusUptimeBase) {
      el.textContent = fmtDuration(statusUptimeBase.sec + (Date.now() - statusUptimeBase.at) / 1000);
    }
  }, 1000);
}

function stopStatusPolling() {
  if (statusPoll) { clearInterval(statusPoll); statusPoll = null; }
  if (statusTick) { clearInterval(statusTick); statusTick = null; }
}

/* 「关于」面板已 React 化（src/settings/AboutPane.jsx）：版本号拉取与检查更新
   随面板挂载 / 卸载自洽完成（进入即拉、离开即清），旧 DOM 绑定移除 */

/** 把快照拍平成纯文本，方便贴到 issue / 聊天里 */
function buildDiagnostics(d) {
  const app = d.app || {}; const db = d.db || {}; const rss = d.rss || {}; const dg = d.digest || {};
  const f = rss.feeds || {}; const e = rss.entries || {}; const mem = app.memory || {};
  const L = [];
  L.push('拾阅（shiyue）诊断信息');
  L.push('生成时间: ' + fmtFull(app.now));
  L.push('');
  L.push('[运行实例]');
  L.push('版本 v' + app.version + ' | Node ' + app.node + ' | PID ' + app.pid);
  L.push('启动于 ' + fmtFull(app.startedAt) + ' | 已运行 ' + fmtDuration(app.uptimeSec));
  L.push('内存 RSS ' + fmtBytes(mem.rss) + ' | 堆 ' + fmtBytes(mem.heapUsed));
  if (app.container) {
    L.push('容器内存 ' + fmtBytes(app.container.memoryUsed)
      + (app.container.memoryLimit ? ' / ' + fmtBytes(app.container.memoryLimit) : '（未设上限）')
      + ' | 容器 CPU ' + (app.container.cpuPercent == null ? '—' : app.container.cpuPercent + '%'));
  }
  L.push('负载 ' + (app.loadavg || []).join(' / ') + '（' + app.cpuCount + ' 核）');
  L.push('');
  L.push('[数据库]');
  L.push('就绪: ' + (db.ready ? '是' : '否') + (db.error ? ' | 错误: ' + db.error : ''));
  L.push('往返延迟: ' + (db.latencyMs == null ? '—' : db.latencyMs + ' ms'));
  if (db.pool) L.push('连接池: ' + db.pool.total + '/' + db.pool.max + '（空闲 ' + db.pool.idle + '，等待 ' + db.pool.waiting + '）');
  if (db.tables) L.push('表行数: feeds ' + db.tables.feeds + ' | entries ' + db.tables.entries + ' | digests ' + db.tables.digests);
  L.push('');
  L.push('[RSS]');
  L.push('间隔: 全局每 ' + rss.refreshMinutes + ' 分钟 | 单独设置 ' + f.perFeedInterval + ' 个'
    + ' | 并发 ' + rss.concurrency + ' | 超时 ' + rss.timeoutSeconds + 's');
  L.push('保留: 每频道 ' + (rss.keepPerFeed > 0 ? rss.keepPerFeed + ' 条' : '无条数上限') + ' | ' + (rss.keepDays ? '最长 ' + rss.keepDays + ' 天' : '不限时长')
    + ' | 收藏条目不清理');
  L.push('上次抓取: ' + (rss.lastRefreshAt ? fmtFull(rss.lastRefreshAt) : '无'));
  L.push('下次抓取: ' + (rss.nextRefreshAt ? fmtFull(rss.nextRefreshAt) : '—')
    + (rss.dueCount ? ' | 已到期 ' + rss.dueCount + ' 个' : ''));
  if (rss.lastResult) {
    L.push('上次结果: 新增 ' + rss.lastResult.added + ' | 失败 ' + rss.lastResult.failed
      + ' | 耗时 ' + rss.lastResult.durationMs + 'ms');
  }
  L.push('频道: 共 ' + f.total + ' | 采集中 ' + f.enabled + ' | 卡片 ' + f.cardEnabled
    + ' | 异常 ' + f.error + ' | 未抓过 ' + f.neverFetched);
  L.push('条目: 共 ' + e.total + ' | 未读 ' + e.unread + ' | 收藏 ' + e.favorite + ' | 近 24h 新增 ' + e.added24h);
  L.push('页面自动刷新: ' + (rss.autoRefreshMinutes ? '每 ' + rss.autoRefreshMinutes + ' 分钟' : '关闭'));
  (rss.problems || []).forEach((p) => L.push('  ! ' + p.title + ' → ' + p.error));
  L.push('');
  L.push('[日报]');
  L.push('自动生成: ' + (dg.enabled ? '开 · ' + dg.time : '关') + ' | 存档 ' + dg.count + ' 份');
  if (dg.latest) L.push('最近一份: ' + dg.latest.date + ' | ' + (dg.latest.fallback ? '规则降级' : dg.latest.model));
  return L.join('\n');
}

/* ============================================================
 * 事件绑定
 * ============================================================ */
let searchTimer = null;
$('#searchInput').addEventListener('input', (ev) => {
  clearTimeout(searchTimer);
  const v = ev.target.value;
  searchTimer = setTimeout(() => {
    state.q = v;
    state.tag = null;
    loadPage(true);
  }, 420);
});

$('#sortSelect').addEventListener('change', (ev) => { state.sort = ev.target.value; setLayout('sort', state.sort); render(); });
$('#sizeSelect').addEventListener('change', (ev) => { state.size = ev.target.value; render(); });

feedSelect.addEventListener('change', async (ev) => {
  state.feedFilter = ev.target.value || null;
  state.tag = null;
  await loadPage(true);
});

/* 刷新：先让服务端去抓一轮最新条目，再重新拉列表 */
$('#refreshBtn').addEventListener('click', async () => {
  const btn = $('#refreshBtn');
  const ico = btn.querySelector('.ico');
  btn.disabled = true;
  ico.classList.add('spin');
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
  } finally {
    btn.disabled = false;
    ico.classList.remove('spin');
  }
});

$('#settingsBtn').addEventListener('click', () => openSettings());
$('#themeBtn').addEventListener('click', cycleTheme);
viewModeEl.addEventListener('click', (ev) => {
  const b = ev.target.closest('.viewmode-btn');
  if (b) setViewMode(b.getAttribute('data-mode'));
});
// 设置弹层的关闭按钮 / 遮罩点击 / tab 点击已随外壳 React 化由
// src/settings/SettingsModal.jsx 内部处理，旧绑定移除

/* ---------- 状态页：刷新 / 复制诊断 / 异常频道重试 ---------- */
$('#statusRefreshBtn').addEventListener('click', async () => {
  const btn = $('#statusRefreshBtn');
  btn.disabled = true;
  await loadStatusForm();
  btn.disabled = false;
});

$('#statusCopyBtn').addEventListener('click', async () => {
  if (!statusData) { toast('还没有读到状态，稍等一下', false); return; }
  const text = buildDiagnostics(statusData);
  try {
    await navigator.clipboard.writeText(text);
    toast('诊断信息已复制');
  } catch (_) {
    // 非 HTTPS / 无剪贴板权限时的兜底：把文本塞进一个可全选的输入框
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:absolute;left:-9999px;top:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    toast(ok ? '诊断信息已复制' : '复制失败，请手动复制', ok);
  }
});

// 重试按钮是渲染出来的，用事件委托挂一次就够
$('#statusBody').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('[data-retry]');
  if (!btn) return;
  const id = btn.getAttribute('data-retry');
  btn.disabled = true;
  btn.textContent = '抓取中…';
  try {
    const res = await apiFetch('/api/feeds/' + id + '/refresh', { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    const err = (data.result && data.result.error) || data.error;
    if (!res.ok || err) throw new Error(err || 'HTTP ' + res.status);
    toast('抓取成功，新增 ' + ((data.result && data.result.added) || 0) + ' 条');
    await loadFeeds();
    await loadStatusForm();
  } catch (e) {
    toast('重试失败：' + (e.message || e), false);
    btn.disabled = false;
    btn.textContent = '重试';
  }
});

/* 采集参数一改就刷新折叠分组的摘要行（收起来也能看到当前值） */
['#srcRefresh', '#srcKeep', '#srcKeepDays', '#srcAutoRefresh'].forEach((sel) => {
  const el = $(sel);
  if (!el) return;
  el.addEventListener('change', updateSourceParamsSub);
  if (el.tagName === 'INPUT') el.addEventListener('input', updateSourceParamsSub);
});

/* ---------- 数据源：添加 / 开关 / 单抓 / 删除 ---------- */
$('#addFeedBtn').addEventListener('click', async () => {
  const input = $('#rssUrl');
  const url = input.value.trim();
  if (!url) { showResult(feedResult, false, '请先填入 RSS 地址'); input.focus(); return; }

  const btn = $('#addFeedBtn');
  btn.disabled = true; btn.textContent = '抓取中…';
  feedResult.className = 'test-result';
  try {
    const res = await apiFetch('/api/feeds', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = await res.json();
    if (!res.ok) { showResult(feedResult, false, data.error || '添加失败'); return; }
    input.value = '';
    showResult(feedResult, true, `已添加「${shortFeedName(feedTitle(data.feed))}」，新增 ${data.added} 条`);
    toast('订阅已添加');
    await loadSourceForm();
    state.tag = null;
    await loadPage(true);
  } catch (err) {
    showResult(feedResult, false, '添加失败：' + (err.message || err));
  } finally {
    btn.disabled = false; btn.textContent = '添加';
  }
});

$('#rssUrl').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') { ev.preventDefault(); $('#addFeedBtn').click(); }
});

/* OPML 导入：读本地文件 → 发给后端解析去重 → 刷新列表 */
$('#importOpmlBtn').addEventListener('click', () => { $('#opmlFile').click(); });
$('#opmlFile').addEventListener('change', async (ev) => {
  const file = ev.target.files && ev.target.files[0];
  ev.target.value = '';   // 允许重新选择同一文件
  if (!file) return;
  const btn = $('#importOpmlBtn');
  btn.disabled = true; btn.textContent = '导入中…';
  try {
    const text = await file.text();
    const res = await apiFetch('/api/feeds/import', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ opml: text }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '导入失败');
    const parts = [`已导入 ${data.added} 个新频道`];
    if (data.duplicated) parts.push(`跳过 ${data.duplicated} 个重复`);
    if (data.groups && data.groups.length) parts.push(`${data.groups.length} 个分组`);
    showResult(feedResult, true, parts.join(' · '));
    await loadSourceForm();
  } catch (err) {
    showResult(feedResult, false, '导入失败：' + (err.message || err));
  } finally { btn.disabled = false; btn.textContent = '导入 OPML'; }
});

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
const exportOpmlBtn = document.getElementById('exportOpmlBtn');
if (exportOpmlBtn) exportOpmlBtn.addEventListener('click', exportOpml);

/** 频道行的开关 / 分组改完统一走这里保存，保存后同步刷新各页面的列表 */
async function patchFeed(id, patch, okMsg) {
  const res = await apiFetch('/api/feeds/' + id, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
  toast(okMsg);
  await loadFeeds();
  state.tag = null;
  await loadPage(true);
  renderFeedList();
  renderReaderChannels();
}

/** 频道列表里点「重命名」：把标题就地变成输入框，回车/失焦保存，Esc 取消 */
function startRename(id) {
  const row = feedListEl.querySelector(`.feed-row[data-id="${CSS.escape(id)}"]`);
  if (!row) return;
  const titleEl = row.querySelector('.feed-title');
  if (!titleEl || titleEl.querySelector('input')) return;
  const feed = (state.feedList || []).find((f) => f.id === id);
  const cur = feed ? feedTitle(feed) : '';
  titleEl.innerHTML = `<input class="feed-title-edit" type="text" maxlength="200" value="${escapeHtml(cur)}" spellcheck="false" autocomplete="off">`;
  const inp = titleEl.querySelector('input');
  inp.focus(); inp.select();
  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    if (!commit) { renderFeedList(); return; }
    const v = inp.value.trim();
    if (!v || v === cur) { renderFeedList(); return; }
    patchFeed(id, { title: v }, '名称已更新').catch(() => renderFeedList());
  };
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  inp.addEventListener('blur', () => finish(true));
}

feedListEl.addEventListener('change', async (ev) => {
  const t = ev.target;

  // 采集开关
  const cb = t.closest('input[data-toggle]');
  if (cb) {
    const id = cb.getAttribute('data-toggle');
    cb.disabled = true;
    try {
      await patchFeed(id, { enabled: cb.checked }, cb.checked ? '已开启采集' : '已停止采集');
    } catch (err) {
      cb.checked = !cb.checked;
      toast('保存失败：' + (err.message || err), false);
    } finally { cb.disabled = false; }
    return;
  }

  // 卡片开关
  const cc = t.closest('input[data-card-toggle]');
  if (cc) {
    const id = cc.getAttribute('data-card-toggle');
    cc.disabled = true;
    try {
      await patchFeed(id, { cardEnabled: cc.checked }, cc.checked ? '已在卡片页展示' : '已从卡片页隐藏');
    } catch (err) {
      cc.checked = !cc.checked;
      toast('保存失败：' + (err.message || err), false);
    } finally { cc.disabled = false; }
    return;
  }

  // 分组名（失焦 / 回车才触发 change）
  const gi = t.closest('input[data-group]');
  if (gi) {
    const id = gi.getAttribute('data-group');
    const val = gi.value.trim();
    const feed = (state.feedList || []).find((f) => f.id === id);
    if (feed && String(feed.groupName || '') === val) return;   // 没变就不发请求
    gi.disabled = true;
    try {
      await patchFeed(id, { groupName: val }, val ? `已归入「${val}」` : '已移出分组');
    } catch (err) {
      if (feed) gi.value = feed.groupName || '';
      toast('保存失败：' + (err.message || err), false);
      gi.disabled = false;
    }
    return;
  }

  // 抓取频率：空值 = 跟随全局；其余 = 该频道单独设置（分钟）
  const fq = t.closest('select[data-freq]');
  if (fq) {
    const id = fq.getAttribute('data-freq');
    const feed = (state.feedList || []).find((f) => f.id === id);
    const next = fq.value === '' ? null : Number(fq.value);
    if (feed && (feed.refreshMinutes == null ? null : Number(feed.refreshMinutes)) === next) return;
    fq.disabled = true;
    try {
      await patchFeed(id, { refreshMinutes: next },
        next == null ? '已改为跟随全局频率' : `该频道已设为每 ${fmtMinutes(next)}抓取`);
    } catch (err) {
      toast('保存失败：' + (err.message || err), false);
      fq.disabled = false;
    }
  }
});

feedListEl.addEventListener('click', async (ev) => {
  // 分组头（非手柄区域）点击 → 折叠 / 展开
  const gh = ev.target.closest('.feed-group-head');
  if (gh && !ev.target.closest('.drag-handle')) {
    toggleGroupCollapse(gh.getAttribute('data-group') || '');
    return;
  }
  const del = ev.target.closest('[data-del]');
  if (del) {
    const id = del.getAttribute('data-del');
    const feed = (state.feedList || []).find((f) => f.id === id);
    if (!confirm(`确定删除订阅「${feed ? shortFeedName(feedTitle(feed)) : id}」？\n该频道已抓取的条目会一并删除。`)) return;
    del.disabled = true;
    try {
      const res = await apiFetch('/api/feeds/' + id, { method: 'DELETE' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      toast('订阅已删除');
      await loadSourceForm();
      state.tag = null;
      await loadPage(true);
    } catch (err) {
      toast('删除失败：' + (err.message || err), false);
      del.disabled = false;
    }
    return;
  }

  const rn = ev.target.closest('[data-rename]');
  if (rn) {
    startRename(rn.getAttribute('data-rename'));
    return;
  }

  const rf = ev.target.closest('[data-refresh]');
  if (rf) {
    const id = rf.getAttribute('data-refresh');
    rf.disabled = true;
    const old = rf.textContent;
    rf.textContent = '…';
    try {
      const res = await apiFetch('/api/feeds/' + id + '/refresh', { method: 'POST' });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error((data.result && data.result.error) || '抓取失败');
      toast(data.result.added ? `新增 ${data.result.added} 条` : '没有新内容');
      await loadSourceForm();
      await loadPage(true);
    } catch (err) {
      toast('抓取失败：' + (err.message || err), false);
    } finally {
      rf.disabled = false;
      rf.textContent = old;
    }
  }
});

// 手动填序号：input 失焦 / 回车时触发
feedListEl.addEventListener('change', (ev) => {
  const oi = ev.target.closest('[data-order]');
  if (oi) { applyNumericOrder(oi.getAttribute('data-order'), parseInt(oi.value, 10)); }
});

$('#refreshAllFeedsBtn').addEventListener('click', async () => {
  const btn = $('#refreshAllFeedsBtn');
  btn.disabled = true; btn.textContent = '抓取中…';
  try {
    const res = await apiFetch('/api/feeds/refresh', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const failed = (data.failed || []).length;
    showResult(feedResult, !failed, failed
      ? `抓取完成，新增 ${data.added} 条，${failed} 个频道失败`
      : `抓取完成，新增 ${data.added} 条`);
    await loadSourceForm();
    state.tag = null;
    await loadPage(true);
  } catch (err) {
    showResult(feedResult, false, '抓取失败：' + (err.message || err));
  } finally {
    btn.disabled = false; btn.textContent = '刷新全部';
  }
});

$('#saveSourceBtn').addEventListener('click', async () => {
  if (!srcFormReady) { showResult(feedResult, false, '设置尚未加载完成，请稍后再试'); return; }
  const btn = $('#saveSourceBtn');
  btn.disabled = true; btn.textContent = '保存中…';
  try {
    const res = await apiFetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: {
          refreshMinutes: $('#srcRefresh').value,
          keepPerFeed: $('#srcKeep').value,
          keepDays: $('#srcKeepDays').value,
          timeoutSeconds: $('#srcTimeout').value,
          concurrency: $('#srcConcurrency').value,
          autoRefreshMinutes: $('#srcAutoRefresh').value,
          proxyUrl: $('#srcProxy').value,
        },
      }),
    });
    const data = await res.json();
    if (!res.ok) { showResult(feedResult, false, data.error || '保存失败'); return; }
    showResult(feedResult, true, '抓取设置已保存');
    toast('抓取设置已保存');
    scheduleAutoRefresh();   // 立刻按新的「页面自动刷新」间隔重排
  } catch (err) {
    showResult(feedResult, false, '保存失败：' + (err.message || err));
  } finally {
    btn.disabled = false; btn.textContent = '保存设置';
  }
});

/* 账号：保存 */
$('#saveAccBtn').addEventListener('click', async () => {
  const btn = $('#saveAccBtn');
  btn.disabled = true;
  btn.textContent = '保存中…';
  accResult.className = 'test-result';
  try {
    const res = await apiFetch('/api/account', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: $('#accUsername').value,
        currentPassword: $('#accCurrent').value,
        newPassword: $('#accNew').value,
      }),
    });
    const data = await res.json();
    if (!res.ok) { showResult(accResult, false, data.error || '保存失败'); return; }
    showResult(accResult, true, '账号已更新');
    toast('账号已更新');
    $('#accCurrent').value = '';
    $('#accNew').value = '';
    state.username = data.username;
  } catch (err) {
    showResult(accResult, false, '保存失败：' + (err.message || err));
  } finally {
    btn.disabled = false;
    btn.textContent = '保存账号';
  }
});

/* 账号：退出登录 */
$('#logoutBtn').addEventListener('click', async () => {
  try {
    await apiFetch('/api/logout', { method: 'POST' });
  } catch (_) { /* 忽略 */ }
  location.replace('/login.html');
});

/* ---------- 用户管理（仅管理员，见「账号 → 用户管理」）---------- */
const userResult = $('#userResult');
let userListCache = [];

async function loadUserList() {
  const listEl = $('#userList');
  if (!listEl) return;
  try {
    const res = await apiFetch('/api/users');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    userListCache = data.users || [];
    renderUserList();
  } catch (err) {
    listEl.innerHTML = `<div class="hint" style="padding:10px">读取用户失败：${escapeHtml(err.message || String(err))}</div>`;
  }
}

function renderUserList() {
  const listEl = $('#userList');
  if (!listEl) return;
  const sub = $('#accUsersSub');
  if (sub) sub.textContent = userListCache.length ? `共 ${userListCache.length} 个` : '';
  if (!userListCache.length) { listEl.innerHTML = '<div class="hint">还没有用户</div>'; return; }
  listEl.innerHTML = userListCache.map((u) => `
    <div class="user-row" data-id="${escapeHtml(u.id)}">
      <span class="u-name">${escapeHtml(u.username)}</span>
      ${u.role === 'admin' ? '<span class="u-badge">管理员</span>' : '<span class="u-badge role-user">普通</span>'}
      <span class="u-meta">${Number(u.feedCount) || 0} 个源</span>
      ${u.isSelf ? '<span class="u-self">当前</span>' : ''}
      <span class="u-spacer"></span>
      ${u.isSelf ? '' : `<button class="u-btn" data-act="role" data-id="${escapeHtml(u.id)}">${u.role === 'admin' ? '降为普通' : '设为管理员'}</button>`}
      <button class="u-btn" data-act="pass" data-id="${escapeHtml(u.id)}">改密码</button>
      ${u.isSelf ? '' : `<button class="u-btn danger" data-act="del" data-id="${escapeHtml(u.id)}">删除</button>`}
    </div>`).join('');
}

$('#userList').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('.u-btn');
  if (!btn) return;
  const id = btn.getAttribute('data-id');
  const act = btn.getAttribute('data-act');
  const u = userListCache.find((x) => String(x.id) === String(id));
  if (!u) return;
  try {
    if (act === 'del') {
      if (!window.confirm(`确定删除用户「${u.username}」？其订阅源、条目与日报都会一并删除，且不可恢复。`)) return;
      const res = await apiFetch('/api/users/' + id, { method: 'DELETE' });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || 'HTTP ' + res.status);
      showResult(userResult, true, `已删除 ${u.username}`);
      toast(`已删除用户 ${u.username}`);
      await loadUserList();
    } else if (act === 'role') {
      const next = u.role === 'admin' ? 'user' : 'admin';
      const res = await apiFetch('/api/users/' + id, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: next }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || 'HTTP ' + res.status);
      showResult(userResult, true, `已将 ${u.username} 设为${next === 'admin' ? '管理员' : '普通用户'}`);
      await loadUserList();
    } else if (act === 'pass') {
      const np = window.prompt(`为「${u.username}」设置新密码（至少 4 位）：`);
      if (np == null) return;
      if (np.length < 4) { showResult(userResult, false, '密码至少 4 位'); return; }
      const res = await apiFetch('/api/users/' + id, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: np }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || 'HTTP ' + res.status);
      showResult(userResult, true, `已重置 ${u.username} 的密码`);
    }
  } catch (err) {
    showResult(userResult, false, '操作失败：' + (err.message || err));
  }
});

$('#addUserBtn').addEventListener('click', async () => {
  const btn = $('#addUserBtn');
  const username = $('#newUserName').value.trim();
  const password = $('#newUserPass').value;
  const role = $('#newUserRole').value;
  if (!username) { showResult(userResult, false, '请填写用户名'); return; }
  if (password.length < 4) { showResult(userResult, false, '密码至少 4 位'); return; }
  btn.disabled = true;
  try {
    const res = await apiFetch('/api/users', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, role }),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.error || 'HTTP ' + res.status);
    showResult(userResult, true, `已创建用户 ${username}`);
    toast(`已创建用户 ${username}`);
    $('#newUserName').value = '';
    $('#newUserPass').value = '';
    $('#newUserRole').value = 'user';
    await loadUserList();
  } catch (err) {
    showResult(userResult, false, '创建失败：' + (err.message || err));
  } finally {
    btn.disabled = false;
  }
});

/* ============================================================
 * 日报 / 模型 / 日报设置 事件绑定
 * ============================================================ */
$('#viewNav').addEventListener('click', (ev) => {
  const b = ev.target.closest('.viewnav-btn');
  // 「收藏」不再是顶栏入口，只作为文章页侧栏里的一个范围（state.rdScope）
  if (b) switchView(b.getAttribute('data-view'));
});

$('#genDigestBtn').addEventListener('click', () => generateDigest(false));
$('#regenDigestBtn').addEventListener('click', () => generateDigest(true));
digestDateSel.addEventListener('change', () => showDigest(digestDateSel.value));

/* 模型面板已 React 化（src/settings/ModelPane.jsx）：显示/隐藏 Key、测试、保存、
   清除四个动作随面板挂载/卸载自洽完成，请求体与旧实现逐字段一致，旧绑定移除 */

/* 日报设置：联动提示（含两个折叠分组的摘要行） */
['#dgEnabled', '#dgTime', '#dgScope', '#dgMaxPerFeed', '#dgMaxTotal', '#dgKeepDays'].forEach((sel) => {
  const el = $(sel);
  if (!el) return;
  el.addEventListener('change', updateDigestHint);
  if (el.tagName === 'INPUT' && el.type === 'number') el.addEventListener('input', updateDigestHint);
});

/* 日报设置：保存 */
$('#saveDgBtn').addEventListener('click', async () => {
  const btn = $('#saveDgBtn');
  btn.disabled = true; btn.textContent = '保存中…';
  try {
    const res = await apiFetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        digest: {
          enabled: $('#dgEnabled').checked,
          time: $('#dgTime').value || '08:00',
          scope: $('#dgScope').value,
          maxPerFeed: $('#dgMaxPerFeed').value,
          maxTotal: $('#dgMaxTotal').value,
          keepDays: $('#dgKeepDays').value,
        },
      }),
    });
    const data = await res.json();
    if (!res.ok) { showResult(dgResult, false, data.error || '保存失败'); return; }
    showResult(dgResult, true, '日报设置已保存');
    toast('日报设置已保存');
    updateDigestHint();
  } catch (err) {
    showResult(dgResult, false, '保存失败：' + (err.message || err));
  } finally {
    btn.disabled = false; btn.textContent = '保存日报设置';
  }
});

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
  updateSubtitle();
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

loadMoreBtn.addEventListener('click', () => loadPage(false));

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
    // 顶栏「条资源」只对卡片页有意义
    $('#stat').hidden = name !== 'cards';
    syncViewNav();

    if (name === 'reader') {
      renderReaderChannels();
      // 已经有数据就不重新拉，避免来回切页面时列表闪一下
      if (!state.rdEntries.length) loadReader({ reset: true });
      else renderReader();
    }
    // AI 有多个子页，回到它时停在离开前的那个
    if (name === 'ai') switchAiPage(aiPage);

    window.scrollTo({ top: 0 });
    if (typeof updateProgress === 'function') updateProgress();
  };
  // View Transitions API：视图切换时整页交叉淡入（渐进增强，减少动态效果时跳过）
  if (document.startViewTransition && !prefersReducedMotion()) {
    document.startViewTransition(apply);
  } else {
    apply();
  }
}

/** 顶栏高亮：只反映当前页面（「收藏」已不再是顶栏入口） */
function syncViewNav() {
  $$('#viewNav .viewnav-btn').forEach((b) => {
    b.classList.toggle('active', b.getAttribute('data-view') === state.tab);
  });
}

/* ============================================================
 * 阅读页（文章）：左频道 / 右文章，点标题展开全文
 * ============================================================ */

/** 阅读页的频道列表：所有频道都列（这是内容归档，不跟「卡片」开关走），按分组归拢 */
function renderReaderChannels() {
  const feeds = state.feedList || [];
  const grouped = groupFeeds(feeds);
  const flags = state.rdFlags || { total: 0, unread: 0, favorite: 0 };
  // 顶部三个固定入口只在「没选具体频道/分组」时才算选中
  const atScope = state.rdFeedId == null && state.rdGroup == null;

  /* 固定入口：全部 / 未读 / 收藏。它们是「范围」，点了会清掉频道与分组选择，
     避免出现「收藏里再看某个频道」这种说不清的叠加。 */
  const scopeBtn = (key, ico, name, n, cls) => `
    <button class="rd-ch${atScope && state.rdScope === key ? ' active' : ''}" type="button" data-scope="${key}">
      <span class="rd-ch-avatar ${cls}">${ico}</span>
      <span class="rd-ch-name">${name}</span>
      ${n > 0 ? `<span class="rd-ch-n">${n}</span>` : ''}
    </button>`;
  const scopes = scopeBtn('all', icon('circle'), '全部文章', flags.total, 'rd-ch-avatar-all')
    + scopeBtn('unread', icon('dot'), '未读', flags.unread, 'rd-ch-avatar-unread')
    + scopeBtn('favorite', icon('star'), '收藏', flags.favorite, 'rd-ch-avatar-fav')
    + '<div class="rd-ch-sep" aria-hidden="true"></div>';

  const chHtml = (f) => {
    const name = shortFeedName(feedTitle(f));
    const av = f.icon
      ? `<img class="rd-ch-avatar" src="${escapeHtml(f.icon)}" alt="" loading="lazy">`
      : `<span class="rd-ch-avatar rd-ch-avatar-txt">${escapeHtml((name || '?').slice(0, 1))}</span>`;
    const dim = f.enabled ? '' : ' off';
    const tip = f.enabled ? feedTitle(f) : `${feedTitle(f)}（已停止采集）`;
    // 徽标只表示「未读」：有未读才显示数字，全部已读就不显示
    // （以前全读完会退回显示总数，容易被当成未读数）
    const unread = Number(f.unreadCount || 0);
    const count = Number(f.entryCount || 0);
    const active = state.rdFeedId != null && String(state.rdFeedId) === String(f.id);
    return `
      <button class="rd-ch${dim} ${active ? 'active' : ''}" type="button" data-feed="${escapeHtml(f.id)}">
        ${av}
        <span class="rd-ch-name" title="${escapeHtml(tip || '')}">${escapeHtml(name)}</span>
        ${unread > 0 ? `<span class="rd-ch-n hot" title="${unread} 条未读 / 共 ${count} 条">${unread}</span>` : ''}
      </button>`;
  };

  const hasGroups = grouped.some((g) => g.name);
  let body = '';
  for (const g of grouped) {
    const gname = g.name || '';
    // 分组徽标统一用「组内未读总数」，与未读/频道徽标保持同一信号
    // （以前显示频道数跟"全部文章 10128"那种"条数"对不上，扫一眼分不清是频道数还是文章数）
    const gUnread = g.feeds.reduce((s, x) => s + Number(x.unreadCount || 0), 0);
    if (hasGroups) {
      body += `<div class="rd-ch-group-row">
        <button type="button" class="rd-ch-group${gname ? '' : ' muted'}${state.rdGroup === gname ? ' active' : ''}${gUnread > 0 ? ' has-unread' : ''}"
          data-group="${escapeHtml(gname)}" title="只看「${escapeHtml(gname || '未分组')}」分组下的文章">
          <span class="rd-ch-group-name">${escapeHtml(gname || '未分组')}</span>
          ${gUnread > 0 ? `<span class="rd-ch-n hot">${gUnread}</span>` : `<span class="rd-ch-group-empty" aria-hidden="true">✓</span>`}
        </button>
      </div>`;
    }
    body += g.feeds.map(chHtml).join('');
  }

  // 末尾加一个"添加频道"链接，跟"未读为 0 的分组用 ✓ 提示"风格一致：
  // 不在主路径里塞按钮，扫一眼能发现，点击直接进设置的数据源 tab
  body += `<button type="button" class="rd-ch-add" data-action="open-source">
    <svg class="rd-ch-add-ico" aria-hidden="true" focusable="false"><use href="#i-plus"/></svg>
    <span>添加频道</span>
  </button>`;

  readerChannels.innerHTML = scopes + body;
  readerSideN.textContent = feeds.length ? `${feeds.length} 个` : '';
}

/** 列表项：折叠时只有标题 + 来源/体积/日期，正文容器留空，展开时才填 */
function artItemHtml(e) {
  const src = e.feedName ? shortFeedName(e.feedName) : '';
  const read = !!e.isRead;
  const fav = !!e.isFavorite;
  // 未读圆点始终渲染（已读时用 opacity 藏掉），这样已读/未读两行标题左边缘是对齐的
  return `
    <article class="art-item${read ? ' is-read' : ' is-unread'}${fav ? ' is-fav' : ''}" data-id="${escapeHtml(e.id)}">
      <div class="art-row">
        <button class="art-head" type="button" aria-expanded="false">
          <span class="art-dot" aria-hidden="true"></span>
          <svg class="art-caret" aria-hidden="true" focusable="false"><use href="#i-chevron-right"/></svg>
          <span class="art-title">${escapeHtml(e.name)}</span>
          <span class="art-meta">
            ${src ? `<span class="src-pill">${escapeHtml(src)}</span>` : ''}
            ${e.size ? `<span class="art-size">${escapeHtml(e.size)}</span>` : ''}
            <span class="art-date" title="${escapeHtml(fmtFull(e.date))}">${fmtDate(e.date)}</span>
          </span>
        </button>
        <button class="art-star" type="button" data-fav="${escapeHtml(e.id)}"
          aria-pressed="${fav ? 'true' : 'false'}"
          aria-label="${fav ? '取消收藏' : '收藏'}"
          title="${fav ? '取消收藏' : '收藏这篇'}">${fav ? icon('star') : icon('star-o')}</button>
      </div>
      <div class="art-body" hidden></div>
    </article>`;
}

/** 正文第一行常是「名称：xxx」，跟上面已经显示的标题重复，去掉它 */
function readerBodyText(e) {
  let t = e.content || e.desc || '';
  if (!t) return '';
  const first = t.split('\n')[0] || '';
  const m = first.match(/^\s*(?:名\s*称|标\s*题|主\s*题|题\s*目)\s*[：:]\s*(.*)$/);
  if (m && m[1].trim() === String(e.name || '').trim()) t = t.slice(first.length).replace(/^\n+/, '');
  return t.trim();
}

/* 源站点本身没分段时，按句读切成多段，避免一整块糊在屏幕上。
   只在「这一行确实长」的时候切，短行原样返回 —— 不强行为短文本加分段。

   实现要点：不在 URL 内部断。网盘链接（?pwd=xxxx）极常见，若把 ? ! . 当
   断点会把链接拦腰砍断，所以先扫出「URL / 邮箱」区间并跳过，再在中日韩句读
   与英文 . ! 处切。 */
const LONG_LINE = 110;
const MIN_SEG = 36;
const URL_RE = /(?:https?:\/\/|www\.)\S+/gi;
// 断点：中文句读为主，英文只认 . !（? 太像 query，; 更像列表分隔，都不做断点）
const BREAK_RE = /(?<=[。！？；!])/g;

function splitLongLine(line) {
  if (line.length < LONG_LINE) return [line];
  const spans = [];
  for (const m of line.matchAll(URL_RE)) spans.push([m.index, m.index + m[0].length]);
  const inUrl = (i) => spans.some(([a, b]) => i >= a && i < b);

  // 按断点切句
  const sentences = [];
  let last = 0;
  for (const m of line.matchAll(BREAK_RE)) {
    if (inUrl(m.index)) continue;
    sentences.push(line.slice(last, m.index));
    last = m.index;
  }
  sentences.push(line.slice(last));

  // 短句合并，避免出现一两个字一段的碎块
  const out = [];
  let buf = '';
  for (const s of sentences) {
    if (!s.trim()) continue;
    buf += s;
    if (buf.trim().length >= MIN_SEG) { out.push(buf.trim()); buf = ''; }
  }
  if (buf.trim()) out.push(buf.trim());
  return out.length ? out : [line];
}

/** 纯文本正文 → 段落 HTML。已分行的保持原样；超长行按句读细分。
    以句读结尾的算「散文段」，加 is-prose 让 CSS 做首行缩进 —— 字段行
    （名称：xxx / 百度：https://…）不缩，否则对齐会歪。 */
function bodyParagraphs(text) {
  const paras = [];
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    for (const seg of splitLongLine(raw)) {
      const s = seg.trim();
      if (!s) continue;
      const prose = /[。！？；!?;]$/.test(s) || /[。！？；!?;][”’")）]*$/.test(s);
      paras.push(prose ? { cls: 'is-prose', text: s } : { cls: '', text: s });
    }
  }
  return paras;
}

function parseBlocks(json) {
  if (!json) return null;
  try {
    const a = JSON.parse(json);
    return Array.isArray(a) && a.length ? a : null;
  } catch (_) { return null; }
}

// 首行「名称：/标题：xxx」若与文章标题重复则跳过（避免和阅读页标题栏重复）
const TITLE_LINE_RE = /^\s*(?:名\s*称|标\s*题|主\s*题|题\s*目)\s*[：:]\s*(.*)$/;
function isDuplicateTitleLine(txt, name) {
  const m = txt.match(TITLE_LINE_RE);
  return !!(m && m[1].trim() === String(name || '').trim());
}

function artBodyHtml(e) {
  const parts = [];
  const blocks = parseBlocks(e.bodyJson);
  // 块里的图片一律走同源 /api/img 代理（外链直连会被防盗链拦 / 签名过期）；
  // 已是同源路径（服务端已代理过）原样返回，天然幂等
  const proxied = (u) => /^https?:\/\//i.test(u) ? '/api/img?u=' + encodeURIComponent(u) : u;
  const imgTag = (src) => `<img class="art-img" src="${escapeHtml(proxied(src))}" alt="" loading="lazy" decoding="async" title="点击查看大图">`;

  if (blocks) {
    // 按原文「图文顺序」内联渲染：文本段保留在图片原本出现的位置
    let i = 0;
    while (i < blocks.length) {
      const b = blocks[i];
      if (b.t === 'img') {
        // 连续的图片归为一组网格（仍保持它们在原文里的先后次序）
        const grp = [];
        while (i < blocks.length && blocks[i].t === 'img') { grp.push(blocks[i].src); i++; }
        parts.push(grp.length === 1 ? imgTag(grp[0]) : `<div class="art-imgs">${grp.map(imgTag).join('')}</div>`);
      } else {
        // 首块若是与标题重复的行，跳过
        if (i === 0 && isDuplicateTitleLine(b.text, e.name)) { i++; continue; }
        parts.push(`<div class="art-text">${
          bodyParagraphs(b.text).map((p) => `<p${p.cls ? ` class="${p.cls}"` : ''}>${escapeHtml(p.text)}</p>`).join('')
        }</div>`);
        i++;
      }
    }
    if (!parts.length) parts.push(`<div class="art-text art-text-empty">这条没有正文，点「打开」看原文</div>`);
  } else {
    // 老数据 / 纯文本回退：图片收在顶部（单图或网格），正文按句读切段
    const imgs = (Array.isArray(e.images) && e.images.length) ? e.images : (e.image ? [e.image] : []);
    if (imgs.length) {
      parts.push(imgs.length === 1 ? imgTag(imgs[0]) : `<div class="art-imgs">${imgs.map(imgTag).join('')}</div>`);
    }
    const text = readerBodyText(e);
    parts.push(text
      ? `<div class="art-text">${bodyParagraphs(text)
          .map((p) => `<p${p.cls ? ` class="${p.cls}"` : ''}>${escapeHtml(p.text)}</p>`).join('')}</div>`
      : `<div class="art-text art-text-empty">这条没有正文，点「打开」看原文</div>`);
  }

  if (e.date) {
    const day = new Date(e.date);
    parts.push(`<p class="art-pub"><span class="art-pub-label">发布时间</span><time datetime="${day.toISOString()}">${escapeHtml(fmtFull(e.date))}</time></p>`);
  }

  if (e.tags && e.tags.length) {
    parts.push(`<div class="art-tags">${e.tags
      .map((t) => `<span class="mini-tag" data-tag="${escapeHtml(t)}">#${escapeHtml(t)}</span>`).join('')}</div>`);
  }

  // 正文操作：复制（多条链接可挑选）+ 打开原文章（都是小方块图标按钮）
  parts.push(`<div class="art-actions">${copyBtnHtml(e)}${openBtnHtml(e)}</div>`);

  return `<div class="art-inner">${parts.join('')}</div>`;
}

function renderReader() {
  const feeds = state.feedList || [];
  const cur = state.rdFeedId == null
    ? null : feeds.find((f) => String(f.id) === String(state.rdFeedId));

  let title = '全部文章';
  if (cur) title = shortFeedName(feedTitle(cur));
  else if (state.rdGroup != null) title = `分组 · ${state.rdGroup || '未分组'}`;
  else if (state.rdScope === 'unread') title = '未读';
  else if (state.rdScope === 'favorite') title = '收藏';

  readerTitle.textContent = title;

  // 「全部标为已读」只在这一屏还有未读时才出现
  readerReadAllBtn.hidden = !state.rdEntries.some((e) => !e.isRead);

  if (!state.rdEntries.length) {
    readerList.innerHTML = '';
    readerEmpty.hidden = false;
    readerEmpty.querySelector('p').textContent = state.rdQ
      ? `没有找到匹配「${state.rdQ}」的文章`
      : (state.rdScope === 'unread' ? '没有未读文章了'
        : state.rdScope === 'favorite' ? '还没有收藏，点文章右侧的星标收藏'
          : (feeds.length ? '这个频道还没有内容' : '还没有订阅源，去「设置 → 数据源」添加 RSS 地址'));
    readerCollapseAll.hidden = true;
    return;
  }

  readerEmpty.hidden = true;
  readerList.innerHTML = state.rdEntries.map(artItemHtml).join('');

  // 重绘后恢复展开态（展开过的条目不该因为翻页/筛选又合上）
  if (state.rdExpanded.size) {
    readerList.querySelectorAll('.art-item').forEach((el) => {
      if (state.rdExpanded.has(el.dataset.id)) expandArt(el, el.dataset.id);
    });
  }
  readerCollapseAll.hidden = state.rdExpanded.size === 0;
}

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
  readerMore.hidden = false;

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

    renderReader();
  } catch (err) {
    if (!state.rdEntries.length) {
      readerEmpty.hidden = true;
      readerList.innerHTML = `<div class="hint" style="padding:32px 4px">加载失败：${escapeHtml(err.message || String(err))}</div>`;
    } else {
      toast('加载失败：' + (err.message || err), false);
    }
  } finally {
    state.rdLoading = false;
    readerMore.hidden = true;
  }
}

/* ---------- 手风琴模式 ----------
 * 展开新文章时自动收起上一篇，避免一屏堆好几篇长正文。
 * 刻意**不监听失焦 / blur**：点图片看大图、复制正文选中文字、点「打开」跳新标签页、
 * 手机上切到别的 App 再回来，全都会触发 blur —— 那些时刻把文章折掉是帮倒忙。
 * 只在用户主动点开一篇时触发，可预期、零误伤。 */
let accordionOn = layoutPref.accordion;

const readerAccBtn = $('#readerAccBtn');
const readerAccLabel = $('#readerAccLabel');

function renderAccordionBtn() {
  readerAccBtn.setAttribute('aria-pressed', accordionOn ? 'true' : 'false');
  // 标签刻意用两个字：窄屏也保留（CSS 里给这个按钮单独放开了 .btn-label），
  // 因为它表示「模式」而不是「动作」，只留图标看不出当前是哪种模式
  readerAccLabel.textContent = accordionOn ? '单篇' : '多篇';
  readerAccBtn.title = accordionOn
    ? '单篇展开：展开一篇时自动收起上一篇（点这里改成多篇）'
    : '多篇展开：可以同时展开多篇（点这里改成单篇）';
}

readerAccBtn.addEventListener('click', () => {
  accordionOn = !accordionOn;
  setLayout('accordion', accordionOn);   // 按账号持久化
  renderAccordionBtn();
  toast(accordionOn ? '已开启单篇展开' : '已改为可同时展开多篇');
});
renderAccordionBtn();

/** 展开：正文懒加载，拉过就缓存，收起再展开不再请求 */
async function expandArt(el, id) {
  const body = el.querySelector('.art-body');
  if (!body) return;
  // 手风琴：先把其它展开的收掉，再展开这一条（state.rdExpanded 是个 Set，改它之前先复制一份）
  if (accordionOn) {
    for (const openId of Array.from(state.rdExpanded)) {
      if (String(openId) === String(id)) continue;
      const other = readerList.querySelector(`.art-item[data-id="${CSS.escape(String(openId))}"]`);
      if (other) collapseArt(other, openId);
      else state.rdExpanded.delete(openId);
    }
  }
  el.classList.add('open');
  el.querySelector('.art-head').setAttribute('aria-expanded', 'true');
  body.hidden = false;
  state.rdExpanded.add(id);
  readerCollapseAll.hidden = false;
  markEntryRead(id);   // 展开了就算读过了

  if (state.rdBody.has(id)) {
    body.innerHTML = artBodyHtml(state.rdBody.get(id));
    bindCardActions(body);
    return;
  }
  if (state.rdBodyErr.has(id)) {
    body.innerHTML = `<div class="art-inner"><div class="hint">正文加载失败，刷新页面重试</div></div>`;
    return;
  }

  body.innerHTML = `<div class="art-inner"><div class="art-loading"><i></i><i></i><i></i></div></div>`;
  try {
    const res = await apiFetch('/api/entries/' + encodeURIComponent(id));
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const full = await res.json();
    state.rdBody.set(id, full);
    // 等待期间用户可能又把它收起了，那就先不渲染
    if (state.rdExpanded.has(id)) {
      body.innerHTML = artBodyHtml(full);
      bindCardActions(body);
    }
  } catch (err) {
    state.rdBodyErr.add(id);
    body.innerHTML = `<div class="art-inner"><div class="hint">正文加载失败：${escapeHtml(err.message || String(err))}</div></div>`;
  }
}

function collapseArt(el, id) {
  const body = el.querySelector('.art-body');
  if (!body) return;
  el.classList.remove('open');
  el.querySelector('.art-head').setAttribute('aria-expanded', 'false');
  body.hidden = true;
  state.rdExpanded.delete(id);
  if (!state.rdExpanded.size) readerCollapseAll.hidden = true;
}

function toggleArt(el) {
  const id = el.dataset.id;
  if (state.rdExpanded.has(id)) collapseArt(el, id);
  else expandArt(el, id);
}

/* ---------- 已读 / 未读 / 收藏 ---------- */

/**
 * 就地改一条的状态：内存、DOM、侧栏计数一次改到位。
 * 计数用「新旧差值」调整，所以同一个 patch 重复应用也不会数错（乐观更新 + 回滚都靠它）。
 */
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
  paintEntryFlag(id, e);
  renderReaderChannels();

  // 在「收藏」范围里取消收藏 = 明确的「移出这里」，立刻从列表拿掉。
  // 反过来，「未读」范围里读一篇不会把它抽走 —— 那会把正在看的文章弄没。
  if (state.rdScope === 'favorite' && !e.isFavorite) {
    state.rdEntries = state.rdEntries.filter((x) => String(x.id) !== String(id));
    state.rdOffset = Math.max(0, state.rdOffset - 1);
    renderReader();
  }
}

/** 只重绘这一条上的标识，不整页重绘（否则展开态和滚动位置都会抖） */
function paintEntryFlag(id, e) {
  const el = readerList.querySelector(`.art-item[data-id="${CSS.escape(String(id))}"]`);
  if (!el) return;
  el.classList.toggle('is-read', !!e.isRead);
  el.classList.toggle('is-unread', !e.isRead);
  el.classList.toggle('is-fav', !!e.isFavorite);
  const star = el.querySelector('.art-star');
  if (!star) return;
  star.innerHTML = e.isFavorite ? icon('star') : icon('star-o');
  star.setAttribute('aria-pressed', e.isFavorite ? 'true' : 'false');
  star.setAttribute('aria-label', e.isFavorite ? '取消收藏' : '收藏');
  star.title = e.isFavorite ? '取消收藏' : '收藏这篇';
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

function toggleFavorite(el) {
  const id = el.getAttribute('data-fav');
  const e = state.rdEntries.find((x) => String(x.id) === String(id));
  const next = !(e && e.isFavorite);
  setEntryFlag(id, { isFavorite: next }).then((ok) => {
    if (ok) toast(next ? '已收藏' : '已取消收藏');
  });
}

readerChannels.addEventListener('click', (ev) => {
  // 「添加频道」：直接打开设置的数据源 tab，避免用户到处找入口
  const addBtn = ev.target.closest('.rd-ch-add');
  if (addBtn) { openSettings('source'); setReaderDrawer(false); return; }
  // 顶部固定入口：全部 / 未读 / 收藏。切范围会清掉频道与分组，避免说不清的叠加
  const scopeBtn = ev.target.closest('[data-scope]');
  if (scopeBtn) {
    const scope = scopeBtn.getAttribute('data-scope');
    if (scope === state.rdScope && state.rdFeedId == null && state.rdGroup == null) return;
    state.rdScope = scope;
    setLayout('rdScope', state.rdScope);   // 默认范围按账号持久化
    state.rdFeedId = null;
    state.rdGroup = null;
    renderReaderChannels();
    loadReader({ reset: true });
    syncViewNav();
    setReaderDrawer(false);
    scrollReaderTop();
    return;
  }
  // 分组标题也是按钮：点了只看这个分组，再点一次取消
  const group = ev.target.closest('.rd-ch-group');
  if (group) {
    const g = group.getAttribute('data-group') || '';
    state.rdScope = 'all';   // 看某个分组 = 回到「全部」范围
    if (g === state.rdGroup) state.rdGroup = null;
    else { state.rdGroup = g; state.rdFeedId = null; }
    renderReaderChannels();
    loadReader({ reset: true });
    syncViewNav();
    setReaderDrawer(false);
    scrollReaderTop();
    return;
  }
  const b = ev.target.closest('.rd-ch');
  if (!b) return;
  const raw = b.getAttribute('data-feed');
  const next = raw ? Number(raw) : null;
  state.rdScope = 'all';
  if (next === state.rdFeedId && state.rdGroup == null) return;
  state.rdFeedId = next;
  state.rdGroup = null;
  renderReaderChannels();
  loadReader({ reset: true });
  syncViewNav();
  setReaderDrawer(false);
  scrollReaderTop();
});

/* ---------- 移动端：左侧频道抽屉 ---------- */
const readerMask = $('#readerMask');
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

$('#readerMenuBtn').addEventListener('click', () => {
  setReaderDrawer(!document.body.classList.contains('reader-drawer-open'));
});
$('#readerSideClose').addEventListener('click', () => setReaderDrawer(false));
readerMask.addEventListener('click', () => setReaderDrawer(false));
window.addEventListener('resize', () => { if (window.innerWidth > 720) setReaderDrawer(false); });

/* 手势：从左侧滑出频道抽屉（拖拽跟手 + 松手吸附）
 * 未打开时，手指在左边缘一段区域内向右横滑即可「拖」出抽屉；
 * 已打开时，向左横滑即可收回。竖滑交给页面自己滚动，互不干扰。
 * 起手区比旧版更宽（EDGE），避开 iOS / Android 最边缘的系统返回手势，
 * 否则贴着 0~15px 的触摸常被系统吞掉，用户根本滑不动抽屉。 */
(() => {
  const EDGE = 60;          // 未打开时，可起手的左边缘宽度（px）
  const THRESH = 48;        // 松手判定开 / 关的最小位移（px）
  const side = $('#readerSide');
  if (side) {
    const drawerW = () => Math.min(272, window.innerWidth * 0.84);
    let x0 = 0, y0 = 0, dragging = false, decided = false, dir = 0;

    // px = 抽屉已滑出的像素（0=关，drawerW=开）→ 换算成 translateX 百分比
    function place(px) {
      px = Math.max(0, Math.min(drawerW(), px));
      const pct = px / drawerW();
      side.style.transform = `translateX(${(-104 + pct * 104).toFixed(2)}%)`;
      if (readerMask) {
        readerMask.style.visibility = 'visible';
        readerMask.style.opacity = String(pct);
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
        side.style.transition = 'none';                          // 跟手期间关掉过渡
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
      side.style.transition = '';                                 // 恢复过渡，交给 CSS 吸附
      side.style.transform = open ? 'translateX(0%)' : 'translateX(-104%)';
      if (readerMask) readerMask.style.opacity = open ? '1' : '0';
      setReaderDrawer(open);                                      // 类切换 + 页面滚动锁
      // 吸附动画结束后把内联样式交还给 CSS，避免后续用按钮开关时内联值压住类样式
      setTimeout(() => {
        side.style.transform = '';
        if (readerMask) { readerMask.style.opacity = ''; readerMask.style.visibility = ''; }
      }, 300);
    }, { passive: true });
  }
})();

readerList.addEventListener('click', (ev) => {
  // 收藏星标：必须排在 .art-head 之前判断（它俩是同一行的兄弟节点）
  const star = ev.target.closest('.art-star');
  if (star) { toggleFavorite(star); return; }
  // 展开体里的标签：跳到卡片页按这个标签筛选
  const tag = ev.target.closest('.mini-tag');
  if (tag) {
    state.tag = tag.getAttribute('data-tag');
    switchView('cards');
    render();
    toast('已按标签筛选：#' + state.tag);
    return;
  }
  const head = ev.target.closest('.art-head');
  if (head) toggleArt(head.closest('.art-item'));
});

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
const readerSentinel = $('#readerSentinel');
let readerAutoBusy = false;

function readerSentinelNear() {
  if (!readerSentinel) return false;
  const r = readerSentinel.getBoundingClientRect();
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

if (readerSentinel && 'IntersectionObserver' in window) {
  new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) readerAutoLoad();
  }, { rootMargin: '500px 0px' }).observe(readerSentinel);
}

/* 「全部标为已读」：条件与当前列表完全一致，标完刷新徽标 */
readerReadAllBtn.addEventListener('click', async () => {
  if (readerReadAllBtn.disabled) return;
  // 破坏性操作（可能一口气把几百篇标成已读），先确认一次，与「删除订阅/用户」保持一致
  const label = state.rdScope === 'unread' ? '全部未读'
    : (state.rdScope === 'favorite' ? '全部收藏' : '当前列表');
  if (!window.confirm(`确定把「${label}」全部标为已读？此操作不可撤销。`)) return;
  readerReadAllBtn.disabled = true;
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
    renderReaderChannels();
    loadReader({ reset: true });
  } catch (err) {
    toast('操作失败：' + (err.message || err), false);
  } finally {
    readerReadAllBtn.disabled = false;
  }
});

readerCollapseAll.addEventListener('click', () => {
  readerList.querySelectorAll('.art-item.open').forEach((el) => collapseArt(el, el.dataset.id));
  toast('已全部收起');
});

/* 阅读页搜索：防抖后走服务端检索（/api/entries?q=…），与当前频道/分组叠加 */
const readerSearch = $('#readerSearch');
const readerSearchClear = $('#readerSearchClear');
let rdSearchTimer = null;

function setReaderQuery(q) {
  q = String(q || '').trim();
  if (q === state.rdQ) return;
  state.rdQ = q;
  loadReader({ reset: true });
}

readerSearch.addEventListener('input', () => {
  const v = readerSearch.value.trim();
  readerSearchClear.hidden = !v;
  clearTimeout(rdSearchTimer);
  rdSearchTimer = setTimeout(() => setReaderQuery(v), 280);
});
readerSearch.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') { clearTimeout(rdSearchTimer); setReaderQuery(readerSearch.value); }
});
readerSearchClear.addEventListener('click', () => {
  readerSearch.value = '';
  readerSearchClear.hidden = true;
  readerSearch.focus();
  setReaderQuery('');
});

// 全局快捷键：按 "/" 聚焦当前视图的搜索框（阅读页 / 卡片页）。输入框内正在打字时不拦截，
// 也不拦截带修饰键的组合（如 Ctrl+/），避免和浏览器/系统快捷键打架
document.addEventListener('keydown', (ev) => {
  if (ev.key !== '/' || ev.metaKey || ev.ctrlKey || ev.altKey) return;
  const ae = document.activeElement;
  if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return;
  const box = state.tab === 'reader' ? readerSearch : (state.tab === 'cards' ? $('#searchInput') : null);
  if (!box) return;
  ev.preventDefault();
  box.focus();
  if (typeof box.select === 'function') box.select();
});

/* 阻止移动端密码管理器 / 浏览器自动填充劫持搜索框：
   初始设为 readonly（密码管理器在页面加载扫描时视为「不可填充」，不会弹窗），
   等用户真正点按（pointerdown，先于键盘弹出）或聚焦时再解除 —— 既挡掉自动填充，
   又不耽误移动端键盘（单次点按即可唤起），桌面端同样生效。配合 input 的
   autocomplete="off" 与 name="q"/"rq"（非凭据字段名）三重保险。 */
function defeatAutofill(el) {
  if (!el) return;
  el.readOnly = true;
  const unlock = () => { el.readOnly = false; };
  el.addEventListener('pointerdown', unlock);
  el.addEventListener('focus', unlock);
}
defeatAutofill($('#searchInput'));
defeatAutofill(readerSearch);

/* ============================================================
 * AI 页：把大模型相关的能力聚在一个入口下，内部再分子页。
 * 加一个新功能只要三步：
 *   1. 在 index.html 的 #aiNav 里加一个 <button data-ai="xxx">
 *   2. 加一个 <section class="ai-pane" data-ai-pane="xxx">
 *   3. 需要拉数据的话，在 AI_LOADERS 里登记一下（纯静态子页不用）
 * 日报是第一个子页；「日报设置」也从设置弹层搬了过来，顺带把设置页变短。
 * ============================================================ */
const AI_PAGES = ['digest', 'settings'];

/** 子页 → 拉数据的函数 */
const AI_LOADERS = {
  digest: () => loadDigestView(),
  settings: () => loadDigestForm(),
};

// 按账号持久化（users.prefs.layout.aiPage），不再落浏览器 localStorage
let aiPage = (AI_PAGES.indexOf(layoutPref.aiPage) >= 0) ? layoutPref.aiPage : AI_PAGES[0];

function switchAiPage(name) {
  if (AI_PAGES.indexOf(name) < 0) name = AI_PAGES[0];
  if (name === 'settings' && !isAdmin()) name = 'digest';   // 日报设置是全局设置，仅管理员
  aiPage = name;
  setLayout('aiPage', name);   // 按账号持久化
  $$('#aiNav .ainav-btn').forEach((b) => {
    b.classList.toggle('active', b.getAttribute('data-ai') === name);
  });
  $$('#aiView .ai-pane').forEach((p) => {
    p.hidden = p.getAttribute('data-ai-pane') !== name;
  });
  const load = AI_LOADERS[name];
  if (load) load();
}

$('#aiNav').addEventListener('click', (ev) => {
  const b = ev.target.closest('.ainav-btn');
  if (b) switchAiPage(b.getAttribute('data-ai'));
});

/* ============================================================
 * 日报
 * ============================================================ */
function shanghaiToday() {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function refreshDateOptions(selected) {
  const dates = (state.digest.dates || []).slice();
  const today = shanghaiToday();
  if (!dates.includes(today)) dates.unshift(today);
  const want = selected || digestDateSel.value || today;
  digestDateSel.innerHTML = dates
    .map((d) => `<option value="${d}">${d === today ? '今天 · ' : ''}${d}</option>`)
    .join('');
  digestDateSel.value = dates.includes(want) ? want : today;
}

async function loadDigestView() {
  if (!state.digest) state.digest = { dates: [], current: null };
  try {
    const res = await apiFetch('/api/digests');
    const data = await res.json();
    state.digest.dates = data.dates || [];
  } catch (_) { state.digest.dates = []; }

  // 顺带刷新一次频道列表：摘要是按「已开启频道」采集的，这里要显示准确的开关数
  try { await loadFeeds(); } catch (_) { /* 忽略，用已有缓存 */ }
  if (isAdmin() && !state.config) { try { state.config = await (await apiFetch('/api/config')).json(); } catch (_) { /* 忽略 */ } }

  refreshDateOptions(state.digest.current);
  updateDigestSubtitle();
  await showDigest(digestDateSel.value);
}

function updateDigestSubtitle() {
  const feeds = state.feedList || [];
  const enabled = feeds.filter((f) => f.enabled).length;
  const scope = (state.config && state.config.digest && state.config.digest.scope) || 'selected';
  const which = scope === 'all' ? '全部频道' : '「采集」开启的频道';
  digestSub.textContent = `把${which}过去 24 小时的新条目整理成一份中文简报`
    + ` · 共 ${feeds.length} 个频道，采集开启 ${enabled} 个`;
}

async function showDigest(date) {
  if (!state.digest) state.digest = { dates: [], current: null };
  state.digest.current = date;
  digestBody.innerHTML = '<div class="dg-loading"><div class="dg-spinner"></div>读取中…</div>';
  try {
    const res = await apiFetch('/api/digest?date=' + encodeURIComponent(date));
    const data = await res.json();
    renderDigest(data.digest, date);
  } catch (err) {
    digestBody.innerHTML = `<div class="dg-error">读取失败：${escapeHtml(err.message || err)}</div>`;
  }
}

function dgItemHtml(it) {
  const e = it.item || {};
  const comment = it.comment ? `<span class="dg-comment">${escapeHtml(it.comment)}</span>` : '';
  const src = e.feedName ? `<span class="src-pill">${escapeHtml(e.feedName)}</span>` : '';
  const thumb = e.image
    ? `<img class="dg-item-thumb" loading="lazy" src="${escapeHtml(e.image)}" alt="">`
    : `<div class="dg-item-thumb-fb">${icon('file')}</div>`;
  const copy = e.link
    ? `<button class="btn-copy" data-copy="${escapeHtml(e.link)}">${icon('link')} 复制链接</button>` : '';
  const open = e.link
    ? `<a class="btn-open" href="${escapeHtml(e.link)}" target="_blank" rel="noopener noreferrer">打开</a>` : '';
  const size = e.size ? `<span class="dg-item-size">${escapeHtml(e.size)}</span>` : '';

  return `<div class="dg-item">
    ${thumb}
    <div class="dg-item-main">
      <div class="dg-item-top">${comment}${src}</div>
      <div class="dg-item-name">${escapeHtml(e.name || '(无标题)')}</div>
      <div class="dg-item-foot">${copy}${open}${size}</div>
    </div>
  </div>`;
}

function renderDigest(d, date) {
  if (!d) {
    digestBody.innerHTML = `<div class="dg-empty">
      <div class="dg-empty-ico">${icon('calendar')}</div>
      <p><strong>${escapeHtml(date)}</strong> 还没有摘要</p>
      <p class="hint">点击右上角「生成摘要」，把所选频道过去 24 小时的新内容整理成简报</p>
    </div>`;
    return;
  }

  const gen = d.generatedAt
    ? new Date(d.generatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
    : '—';

  const meta = `<div class="dg-meta">
    <span><b>生成时间</b> ${escapeHtml(gen)}</span>
    <span><b>模型</b> ${escapeHtml(d.model || '—')}</span>
    <span><b>采集</b> ${(d.stats && d.stats.collected) || 0} 条 → 精选 ${(d.stats && d.stats.kept) || 0} 条</span>
    <span><b>覆盖频道</b> ${(d.stats && d.stats.feeds) || 0} 个</span>
    ${d.usedMapReduce ? '<span><b>模式</b> 分批汇总</span>' : ''}
  </div>`;

  const hl = (d.highlights || []).map((h, i) => `
    <div class="dg-hl">
      <div class="dg-hl-idx">${i + 1}</div>
      <div class="dg-hl-body">
        <div class="dg-hl-text">${escapeHtml(h.text || '')}</div>
        ${h.item && h.item.name ? `<div class="dg-hl-name">${escapeHtml(h.item.name)}</div>` : ''}
      </div>
    </div>`).join('');

  const secs = (d.sections || []).map((s) => `
    <div class="dg-card">
      <h3 class="dg-section-title">${escapeHtml(s.title || '未分类')}<span class="cnt">${s.items.length} 条</span></h3>
      <div class="dg-items">${s.items.map(dgItemHtml).join('')}</div>
    </div>`).join('');

  const errNote = d.error
    ? `<div class="dg-meta" style="border-top:none;padding-top:0"><span style="color:#b7791f">模型调用失败，已降级为规则摘要：${escapeHtml(d.error)}</span></div>`
    : '';

  digestBody.innerHTML = `
    <div class="dg-card">
      <div class="dg-overview">${escapeHtml(d.overview || '（无概览）')}${d.fallback ? '<span class="dg-tag-fallback">规则摘要</span>' : ''}</div>
      ${meta}
      ${errNote}
    </div>
    ${hl ? `<div class="dg-card">
      <h3 class="dg-section-title">今日亮点<span class="cnt">${(d.highlights || []).length} 条</span></h3>
      <div class="dg-hl-list">${hl}</div>
    </div>` : ''}
    ${secs || `<div class="dg-empty"><div class="dg-empty-ico">${icon('inbox')}</div><p>没有可展示的条目</p></div>`}
  `;
  bindCardActions(digestBody);
}

async function generateDigest(force) {
  if (!state.digest) state.digest = { dates: [], current: null };
  const genBtn = $('#genDigestBtn');
  const reBtn = $('#regenDigestBtn');
  genBtn.disabled = true; reBtn.disabled = true;

  digestBody.innerHTML = `<div class="dg-loading">
    <div class="dg-spinner"></div>
    正在采集过去 24 小时的新条目并生成摘要…
    <div class="hint" style="margin-top:8px">首次生成约需 30~60 秒，请勿关闭页面</div>
  </div>`;

  try {
    const res = await apiFetch('/api/digest/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // 不传 feeds：由服务端按「摘要范围」设置决定采集哪些频道
      body: JSON.stringify({ force: !!force }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '生成失败');

    const d = data.digest;
    if (!state.digest.dates.includes(d.date)) state.digest.dates.unshift(d.date);
    refreshDateOptions(d.date);
    renderDigest(d, d.date);
    toast(data.cached ? '已读取当日缓存摘要' : `摘要生成完成（${d.stats.kept} 条 / ${d.stats.feeds} 频道）`);
  } catch (err) {
    digestBody.innerHTML = `<div class="dg-error">
      <div class="dg-empty-ico">${icon('alert')}</div>
      <p>生成失败：${escapeHtml(err.message || err)}</p>
      <p class="hint">请在「设置 → 模型」检查模型地址与 Key 是否正确</p>
    </div>`;
  } finally {
    genBtn.disabled = false; reBtn.disabled = false;
  }
}

/* ============================================================
 * 设置：日报（模型面板已 React 化，见 src/settings/ModelPane.jsx）
 * ============================================================ */

async function loadDigestForm() {
  try {
    const res = await apiFetch('/api/config');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const cfg = await res.json();
    state.config = cfg;
    $('#dgEnabled').checked = !!cfg.digest.enabled;
    $('#dgTime').value = cfg.digest.time || '08:00';
    $('#dgScope').value = cfg.digest.scope || 'selected';
    $('#dgMaxPerFeed').value = cfg.digest.maxPerFeed;
    $('#dgMaxTotal').value = cfg.digest.maxTotal;
    $('#dgKeepDays').value = cfg.digest.keepDays;
    updateDigestHint();
  } catch (err) {
    showResult(dgResult, false, '读取配置失败：' + (err.message || err));
  }
}

function updateDigestHint() {
  const on = $('#dgEnabled').checked;
  const scope = $('#dgScope').value === 'all' ? '全部频道' : '仅「采集」开启的频道';
  dgResult.className = 'test-result';
  $('#dgHint').innerHTML = on
    ? `每天 <strong>${$('#dgTime').value || '08:00'}</strong>（北京时间）自动生成 · 范围：${scope}`
    : '自动生成已关闭，可随时在「日报」页手动生成';

  // 折叠分组的摘要行：收起时也能一眼看到当前设置
  const autoSub = $('#dgAutoSub');
  if (autoSub) autoSub.textContent = on ? `每天 ${$('#dgTime').value || '08:00'} · ${scope}` : '已关闭';
  const limSub = $('#dgLimitsSub');
  if (limSub) {
    limSub.textContent = `每频道 ${$('#dgMaxPerFeed').value} 条 · 总计 ${$('#dgMaxTotal').value} 条`
      + ` · 保留 ${$('#dgKeepDays').value} 天`;
  }
}

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
  const ico = document.getElementById('themeIco');
  if (ico) {
    const use = ico.querySelector('use');
    if (use) use.setAttribute('href', '#i-' + meta.ico);
  }
  const btn = document.getElementById('themeBtn');
  if (btn) {
    btn.title = '主题：' + meta.label + '（点击切换）';
    btn.setAttribute('aria-label', '主题：' + meta.label);
  }
  const tc = document.querySelector('meta[name="theme-color"]');
  if (tc) tc.setAttribute('content', meta.color || (dark ? '#242424' : '#ffffff'));

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
const APPR_KEY = 'shiyue.appearance.v1'; // 仅用于旧数据一次性迁移，迁移后不再写入本机
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
// 安装指引里显示当前访问的域名（不写死，谁自建就显示谁自己的）
const installHost = $('#installHost');
if (installHost) installHost.textContent = location.host;

// 注册 Service Worker（仅 https / localhost 会生效；用 http 的局域网 IP 访问时静默忽略）
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* 非安全上下文，忽略 */ });
  });
}

// 安装到手机：Chromium 系（Edge / Chrome）满足条件时会触发 beforeinstallprompt
const installBtn = $('#installBtn');
let deferredInstall = null;

window.addEventListener('beforeinstallprompt', (ev) => {
  ev.preventDefault();
  deferredInstall = ev;
  if (installBtn) installBtn.hidden = false;
});

window.addEventListener('appinstalled', () => {
  deferredInstall = null;
  if (installBtn) installBtn.hidden = true;
  toast('已添加到手机');
});

async function promptInstall() {
  if (!deferredInstall) return false;
  deferredInstall.prompt();
  let outcome = 'dismissed';
  try { ({ outcome } = await deferredInstall.userChoice); } catch (_) { /* 忽略 */ }
  deferredInstall = null;
  if (installBtn) installBtn.hidden = true;
  if (outcome === 'accepted') toast('已添加到手机');
  return true;
}

document.querySelectorAll('.install-trigger').forEach((btn) => {
  btn.addEventListener('click', async () => {
    if (await promptInstall()) return;
    // 浏览器没给出安装事件：给手动指引（iOS Safari / 部分 Edge 版本）
    toast('请用手机浏览器菜单里的「安装应用 / 添加到主屏幕」');
  });
});

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
 * 顶栏高度 → CSS 变量 --topbar-h
 * 阅读页头部在窄屏下要吸在顶栏下面，得知道顶栏到底多高。
 * 高度会随屏宽、程序名显隐、刘海屏安全区变化，所以实测后写进变量，别在 CSS 里写死。
 * ResizeObserver 顺带覆盖字体加载完成、横竖屏切换这些时机。
 * ============================================================ */
const topbarEl = document.querySelector('.topbar');
function syncTopbarHeight() {
  if (topbarEl) {
    document.documentElement.style.setProperty('--topbar-h', topbarEl.offsetHeight + 'px');
  }
}
syncTopbarHeight();
window.addEventListener('resize', syncTopbarHeight);
window.addEventListener('orientationchange', syncTopbarHeight);
if (window.ResizeObserver && topbarEl) new ResizeObserver(syncTopbarHeight).observe(topbarEl);

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
    renderFeedSelect();
  }

  updateSubtitle();
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
    if (AI_PAGES.indexOf(sub) >= 0) aiPage = sub;
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

/* ---------- 1) 阅读进度条 ---------- */
function updateProgress() {
  const bar = document.getElementById('readProgress');
  if (!bar) return;
  const el = document.scrollingElement || document.documentElement;
  const max = el.scrollHeight - el.clientHeight;
  const p = max > 8 ? Math.min(1, Math.max(0, el.scrollTop / max)) : 0;
  bar.style.transform = 'scaleX(' + p + ')';
}
let _progRAF = 0;
window.addEventListener('scroll', () => {
  if (_progRAF) return;
  _progRAF = requestAnimationFrame(() => { _progRAF = 0; updateProgress(); });
}, { passive: true });
window.addEventListener('resize', updateProgress);
window.addEventListener('load', updateProgress);

/* ---------- 2) 命令面板（已迁移为 React 组件） ----------
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
  syncViewNav();
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
  syncViewNav();
  setReaderDrawer(false);
  scrollReaderTop();
}
function focusSearchBox() {
  let box;
  if (state.tab === 'reader') box = readerSearch;
  else if (state.tab === 'cards') box = $('#searchInput');
  else { switchView('reader'); box = readerSearch; }
  if (box) { box.focus(); if (typeof box.select === 'function') box.select(); }
}


/* ---------- 3) 阅读页键盘导航 ---------- */
let kbdIdx = -1;
function kbdItems() {
  if (state.tab === 'reader') return Array.prototype.slice.call(readerList.querySelectorAll('.art-item'));
  if (state.tab === 'cards') return Array.prototype.slice.call(grid.querySelectorAll(state.view === 'list' ? '.row-item' : '.card'));
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
      else toggleArt(el);
    } else if (ev.key === 'f') {
      ev.preventDefault();
      if (onCards) cardSetFlag(el.dataset.id, { isFavorite: !isCardFav(el.dataset.id) });
      else { const s = el.querySelector('.art-star'); if (s) toggleFavorite(s); }
    } else if (ev.key === 'r') {
      ev.preventDefault();
      if (onCards) cardSetFlag(el.dataset.id, { isRead: true });
      else markEntryRead(el.dataset.id);
    }
  }
});
// 列表重绘（翻页 / 筛选 / 点击）后清掉键盘焦点态，避免错位
readerList.addEventListener('click', clearKbdFocus);
grid.addEventListener('click', clearKbdFocus);

/* 卡片页条目收藏/已读：复用与阅读页相同的 /api/entries PATCH，但作用于卡片列表 state.entries */
function isCardFav(id) {
  const e = (state.entries || []).find((x) => String(x.id) === String(id));
  return !!(e && e.isFavorite);
}
function paintCardFlag(id, e) {
  const el = grid.querySelector('[data-id="' + CSS.escape(String(id)) + '"]');
  if (!el) return;
  el.classList.toggle('is-read', !!e.isRead);
  el.classList.toggle('is-unread', !e.isRead);
  el.classList.toggle('is-fav', !!e.isFavorite);
}
async function cardSetFlag(id, patch) {
  const list = state.entries || [];
  const e = list.find((x) => String(x.id) === String(id));
  if (!e) return false;
  const before = { isRead: !!e.isRead, isFavorite: !!e.isFavorite };
  Object.assign(e, patch);
  paintCardFlag(id, e);
  try {
    const res = await apiFetch('/api/entries/' + encodeURIComponent(id), {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return true;
  } catch (err) {
    Object.assign(e, before); paintCardFlag(id, e);
    toast('标记失败：' + (err.message || err), false);
    return false;
  }
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
 * 注意：必须在文件末尾建立，上游 const（THEME_MODES 等）此时已初始化。
 * 待视图与设置全部 React 化、旧 app.js 退役后，此桥一并拆除。
 * ============================================================ */
window.shiyue = {
  state,
  switchView, applyTheme, openSettings, selectScope, jumpToFeed,
  focusSearchBox, exportOpml, shortFeedName, feedTitle, prefersReducedMotion,
  THEME_MODES, THEME_META,
  refresh: () => { const b = $('#refreshBtn'); if (b) b.click(); },
  scrollTop: () => window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' }),
  // —— v1.3.0 起 React 化组件的桥接面（设置弹层 / 外观 / 关于） ——
  apiFetch, isAdmin, toast,
  lockPageScroll, unlockPageScroll, stopStatusPolling,
  settingsTabEffect, getLegacySettingsPane, getSettingsSummary,
  getAppearance: readAppearance, setAppearance, resetAppearance,
};

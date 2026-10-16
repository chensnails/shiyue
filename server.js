'use strict';

/**
 * 拾阅（shiyue）· RSS 驱动的资源卡片站
 * 数据源：直接抓取 RSS / Atom（不再依赖 CommaFeed）
 * 存储：PostgreSQL（设置 / 账号 / 频道 / 条目 / 日报 全部落库）
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const createDb = require('./db');
const rss = require('./rss');
const { getDispatcher: getProxyDispatcher } = require('./proxy');
const createDigest = require('./digest');
const pkg = require('./package.json');

const PORT = Number(process.env.PORT || 3000);
const HOST = '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');

const DATABASE_URL = process.env.DATABASE_URL
  || `postgres://${process.env.PG_USER || 'shiyue'}:${process.env.PG_PASSWORD || 'shiyue'}`
  + `@${process.env.PG_HOST || 'postgres'}:${process.env.PG_PORT || 5432}/${process.env.PG_DB || 'shiyue'}`;

const SESSION_TTL = 7 * 24 * 3600 * 1000;
const COOKIE_NAME = 'shiyue_sid';
const LOGIN_MAX_FAILS = 6;
const LOGIN_LOCK_MS = 60 * 1000;

const log = (...a) => console.log(...a);
const logErr = (...a) => console.error(...a);

/* ============================================================
 * 数据库
 * ============================================================ */
const db = createDb({ connectionString: DATABASE_URL, log });

/* ============================================================
 * 设置（落库，进程内缓存一份）
 * ============================================================ */
function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/* ============================================================
 * 敏感字段加密（模型 API Key 落库前加密）
 * 主密钥由 cryptoSecret 经 scrypt 派生，AES-256-GCM 加密。
 * 说清楚边界：cryptoSecret 本身也在库里，所以这**不是**用来防「拿到库的人」——
 * 它防的是「备份 / 日志 / 截图 / 误导出被拖走」时直接读到一枚可用的凭据，
 * 同时让接口不再回吐明文（前端只看到掩码）。
 * ============================================================ */
const ENC_PREFIX = 'enc.v1.';
const ENC_SALT = 'shiyue.secret.v1';

function secretKey() {
  return crypto.scryptSync(String((settings && settings.cryptoSecret) || ''), ENC_SALT, 32);
}

/** 明文 → "enc.v1.<iv>.<tag>.<密文>"（base64url）；空值返回空串 */
function encryptSecret(plain) {
  const text = String(plain == null ? '' : plain);
  if (!text) return '';
  try {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', secretKey(), iv);
    const body = Buffer.concat([c.update(text, 'utf8'), c.final()]);
    return ENC_PREFIX + [
      iv.toString('base64url'),
      c.getAuthTag().toString('base64url'),
      body.toString('base64url'),
    ].join('.');
  } catch (e) {
    logErr('[crypto] 加密失败：' + ((e && e.message) || e));
    return '';
  }
}

/** 密文 → 明文；格式不对或密钥变过（认证失败）时返回空串 */
function decryptSecret(enc) {
  const s = String(enc == null ? '' : enc);
  if (!s.startsWith(ENC_PREFIX)) return '';
  const parts = s.slice(ENC_PREFIX.length).split('.');
  if (parts.length !== 3 || parts.some((x) => !x)) return '';
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', secretKey(), Buffer.from(parts[0], 'base64url'));
    d.setAuthTag(Buffer.from(parts[1], 'base64url'));
    return Buffer.concat([d.update(Buffer.from(parts[2], 'base64url')), d.final()]).toString('utf8');
  } catch (e) {
    logErr('[crypto] 解密失败（cryptoSecret 是否变过？）：' + ((e && e.message) || e));
    return '';
  }
}

/** 只露头尾：sk-ab••••••••wxyz。用于前端回显「已保存的是哪一枚」 */
function maskSecret(s) {
  const t = String(s || '');
  if (!t) return '';
  if (t.length <= 8) return '•'.repeat(t.length);
  return t.slice(0, 3) + '•'.repeat(Math.min(12, t.length - 7)) + t.slice(-4);
}

/** llm 组的「落库形态」：内存里持有明文 apiKey，写库前必须换成 apiKeyEnc */
function llmForStore(llm) {
  const src = llm || {};
  const out = Object.assign({}, src);
  delete out.apiKey;
  // 传了新的明文 Key 就重新加密；没传就沿用原有密文（万一解密失败也不会把 Key 抹掉）。
  // 要「清除 Key」时显式传 apiKeyEnc: ''，那样这里会写成空串。
  out.apiKeyEnc = src.apiKey ? encryptSecret(src.apiKey) : String(src.apiKeyEnc || '');
  return out;
}

/* ============================================================
 * 每用户模型配置（与站点级 settings.llm 同构，但跟随账号生效）
 * 内存里持有明文 apiKey；落库前换 apiKeyEnc；前端只见「是否设置 + 掩码」。
 * 站点级 settings.llm 作为兜底 / 默认值：用户自己配了就用用户的，否则回退站点默认。
 * ============================================================ */

/** 校验并夹取用户写入的 llm 字段（落库前） */
function sanitizeUserLlm(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  out.baseUrl = typeof raw.baseUrl === 'string' ? raw.baseUrl.trim().replace(/\/+$/, '') : '';
  out.model = typeof raw.model === 'string' ? raw.model.trim() : '';
  out.temperature = clampNum(raw.temperature, 0.3, 0, 1.5);
  return out;
}

/** 落库形态：明文 apiKey → 密文 apiKeyEnc；clearApiKey 则清空；否则沿用原密文 */
function userLlmForStore(raw) {
  const src = raw || {};
  const out = sanitizeUserLlm(src);
  if (src.clearApiKey) { out.apiKeyEnc = ''; return out; }
  out.apiKeyEnc = src.apiKey ? encryptSecret(src.apiKey) : String(src.apiKeyEnc || '');
  return out;
}

/** 读库后返回给前端的视图：含「是否设置 + 掩码」，绝不含明文 / 密文 */
function userLlmForView(prefs) {
  const l = (prefs && prefs.llm) || {};
  const enc = typeof l.apiKeyEnc === 'string' ? l.apiKeyEnc : '';
  const set = !!enc;
  return {
    baseUrl: typeof l.baseUrl === 'string' ? l.baseUrl : '',
    model: typeof l.model === 'string' ? l.model : '',
    temperature: typeof l.temperature === 'number' ? l.temperature : 0.3,
    apiKeySet: set,
    apiKeyHint: set ? maskSecret(decryptSecret(enc)) : '',
  };
}

/** 解析「当前用户的有效模型配置」：用户自己配的优先，未配则回退站点默认 */
function resolveUserLlm(user) {
  const u = (user && user.prefs && user.prefs.llm) || {};
  const site = settings.llm || {};
  let apiKey = '';
  if (typeof u.apiKeyEnc === 'string' && u.apiKeyEnc) apiKey = decryptSecret(u.apiKeyEnc) || '';
  if (!apiKey) apiKey = site.apiKey || '';
  return {
    baseUrl: u.baseUrl || site.baseUrl || '',
    model: u.model || site.model || '',
    temperature: (typeof u.temperature === 'number') ? u.temperature
      : (typeof site.temperature === 'number' ? site.temperature : 0.3),
    apiKey,
  };
}

const int = (v, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};
const bool = (v, d) => {
  if (v === undefined || v === null || v === '') return d;
  return v === true || v === '1' || v === 'true' || v === 'yes';
};
/** 取整并夹到 [lo, hi]，防止手改库 / 表单塞进离谱值 */
const clampInt = (v, d, lo, hi) => Math.min(Math.max(int(v, d), lo), hi);
/** 取浮点并夹到 [lo, hi] */
const clampNum = (v, d, lo, hi) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(Math.max(n, lo), hi) : d;
};

function defaults() {
  const env = process.env;
  const salt = crypto.randomBytes(16).toString('hex');
  return {
    auth: {
      username: env.ADMIN_USER || 'admin',
      salt,
      // 默认 admin / admin；可用 ADMIN_USER / ADMIN_PASS 覆盖（仅首次初始化时生效）
      passwordHash: hashPassword(env.ADMIN_PASS || 'admin', salt),
    },
    llm: {
      baseUrl: (env.LLM_BASE || '').replace(/\/+$/, ''),
      apiKey: env.LLM_KEY || '',
      model: env.LLM_MODEL || '',
      temperature: clampNum(env.LLM_TEMPERATURE, 0.3, 0, 1.5),
    },
    digest: {
      enabled: bool(env.DIGEST_ENABLED, false),
      time: env.DIGEST_TIME || '08:00',
      maxPerFeed: int(env.DIGEST_MAX_PER_FEED, 20),
      maxTotal: int(env.DIGEST_MAX_TOTAL, 150),
      keepDays: int(env.DIGEST_KEEP_DAYS, 30),
      scope: env.DIGEST_SCOPE === 'all' ? 'all' : 'selected',
    },
    source: {
      refreshMinutes: clampInt(env.REFRESH_MINUTES, 20, 5, 1440),
      keepPerFeed: clampInt(env.KEEP_PER_FEED, 300, 20, 5000),
      // 按时间保留：0 = 不限（只按 keepPerFeed 的条数上限）
      keepDays: clampInt(env.KEEP_DAYS, 0, 0, 3650),
      timeoutSeconds: clampInt(env.RSS_TIMEOUT_SECONDS, 25, 5, 120),
      concurrency: clampInt(env.REFRESH_CONCURRENCY, 3, 1, 10),
      // 网页自动刷新：前端按这个间隔重新拉列表，0 = 关闭
      autoRefreshMinutes: clampInt(env.AUTO_REFRESH_MINUTES, 0, 0, 1440),
      // 出网代理：空 = 直连；http(s):// 或 socks5://
      proxyUrl: '',
    },
    sessionSecret: crypto.randomBytes(32).toString('hex'),
    // 敏感字段（模型 API Key）的加密主密钥，与 sessionSecret 分开：
    // 将来轮换会话密钥不会把已经存好的 Key 弄丢
    cryptoSecret: crypto.randomBytes(32).toString('hex'),
  };
}

/** 把一组设置里的数值/枚举夹回合法区间（读库后和保存前都要过一遍） */
function normalizeSettings(s) {
  s.llm.temperature = clampNum(s.llm.temperature, 0.3, 0, 1.5);

  s.digest.maxPerFeed = clampInt(s.digest.maxPerFeed, 20, 1, 100);
  s.digest.maxTotal = clampInt(s.digest.maxTotal, 150, 10, 500);
  s.digest.keepDays = clampInt(s.digest.keepDays, 30, 1, 365);
  s.digest.scope = s.digest.scope === 'all' ? 'all' : 'selected';

  s.source.refreshMinutes = clampInt(s.source.refreshMinutes, 20, 5, 1440);
  // 0 = 不限（只按 keepDays 的时长上限清理）
  s.source.keepPerFeed = clampInt(s.source.keepPerFeed, 300, 0, 5000);
  s.source.keepDays = clampInt(s.source.keepDays, 0, 0, 3650);
  s.source.timeoutSeconds = clampInt(s.source.timeoutSeconds, 25, 5, 120);
  s.source.concurrency = clampInt(s.source.concurrency, 3, 1, 10);
  s.source.autoRefreshMinutes = clampInt(s.source.autoRefreshMinutes, 0, 0, 1440);
  // 代理：剥空白 + 长度上限 + 不接受非标准协议（前端做提示，服务端做兜底校验）
  s.source.proxyUrl = String(s.source.proxyUrl || '').trim().slice(0, 500);
  return s;
}

let settings = null;

async function loadSettings() {
  const def = defaults();
  const stored = await db.getSettings();

  const merged = normalizeSettings({
    auth: Object.assign({}, def.auth, stored.auth || {}),
    llm: Object.assign({}, def.llm, stored.llm || {}),
    digest: Object.assign({}, def.digest, stored.digest || {}),
    source: Object.assign({}, def.source, stored.source || {}),
    sessionSecret: stored.sessionSecret || def.sessionSecret,
    cryptoSecret: stored.cryptoSecret || def.cryptoSecret,
  });
  if (!merged.auth.salt || !merged.auth.passwordHash) {
    merged.auth.salt = def.auth.salt;
    merged.auth.passwordHash = def.auth.passwordHash;
  }

  // 先落到 settings，解密要用到 cryptoSecret
  settings = merged;

  /* API Key：库里是密文，内存里保留明文副本供调用模型时使用。
   * 老版本把明文直接写在 llm.apiKey 里，这里一并读出来（下面会迁成密文）。 */
  const legacyKey = typeof merged.llm.apiKey === 'string' ? merged.llm.apiKey : '';
  merged.llm.apiKey = decryptSecret(merged.llm.apiKeyEnc) || legacyKey;

  // 回写缺失的键，保证库里是完整的
  const patch = {};
  for (const k of ['auth', 'digest', 'source']) {
    if (!stored[k]) patch[k] = merged[k];
  }
  // llm 组要特殊处理：只要库里还是明文形态（有 apiKey / 没有 apiKeyEnc），就重写一次
  if (!stored.llm || stored.llm.apiKey !== undefined || stored.llm.apiKeyEnc === undefined) {
    patch.llm = llmForStore(merged.llm);
  }
  if (!stored.sessionSecret) patch.sessionSecret = merged.sessionSecret;
  if (!stored.cryptoSecret) patch.cryptoSecret = merged.cryptoSecret;
  if (Object.keys(patch).length) await db.setSettings(patch);
  if (patch.llm && legacyKey) log('[app] 模型 API Key 已从明文迁移为加密存储');

  return merged;
}

async function saveSettings(patch) {
  Object.assign(settings, patch);
  const persisted = Object.assign({}, patch);
  // llm 组内存里是明文，落库前换成密文，并把密文同步回内存副本，
  // 否则下一次保存会把 apiKeyEnc 当成「没有」而清掉
  if (persisted.llm) {
    persisted.llm = llmForStore(persisted.llm);
    settings.llm.apiKeyEnc = persisted.llm.apiKeyEnc;
  }
  await db.setSettings(persisted);
}

/* ============================================================
 * 会话：HMAC 签名 Cookie（无状态）
 * ============================================================ */
function signSession(user) {
  // uid 是账号主键；u 只是给人看的名字（改用户名后旧 Cookie 里的名字会过期，但 uid 仍有效）
  const payload = Buffer.from(JSON.stringify({ uid: user.id, u: user.username, exp: Date.now() + SESSION_TTL })).toString('base64url');
  const sig = crypto.createHmac('sha256', settings.sessionSecret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}
function verifySession(token) {
  if (!token || token.indexOf('.') < 0) return null;
  const idx = token.lastIndexOf('.');
  const payload = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  const expect = crypto.createHmac('sha256', settings.sessionSecret).update(payload).digest('base64url');
  if (sig.length !== expect.length || !safeEqual(sig, expect)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data.exp || data.exp < Date.now()) return null;
    return data;
  } catch (_) { return null; }
}
function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
const getSession = (req) => verifySession(parseCookies(req)[COOKIE_NAME]);

/* 账号内存注册表：id -> { id, username, role, prefs }。
 * 会话只带 uid，每次请求从这张表解析出当前用户；账号增删改后重新 loadUsers() 即可，
 * 于是「改了角色 / 删了用户」立刻生效（不用等 Cookie 过期）。
 * 注意：pg 会把 BIGINT 当字符串返回，这里统一转成 Number，否则 uid === user.id 之类的
 * 严格比较会静默失败（例如「不能删除自己」的守卫）。 */
let usersById = new Map();
const numId = (v) => (v == null ? null : Number(v));
async function loadUsers() {
  const rows = await db.listUsers();
  usersById = new Map(rows.map((u) => [numId(u.id), Object.assign({}, u, { id: numId(u.id) })]));
}
/** 从会话解析当前用户；账号已被删除则视为未登录 */
const userOf = (session) => (session ? usersById.get(numId(session.uid)) || null : null);
const isAdmin = (user) => !!user && user.role === 'admin';

function setSession(res, user) {
  res.setHeader('Set-Cookie',
    `${COOKIE_NAME}=${signSession(user)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL / 1000)}`);
}
function clearSession(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

const loginFails = new Map();
function loginLocked(ip) {
  const rec = loginFails.get(ip);
  if (!rec) return 0;
  if (rec.lockedUntil && rec.lockedUntil > Date.now()) return rec.lockedUntil - Date.now();
  if (rec.lockedUntil && rec.lockedUntil <= Date.now()) loginFails.delete(ip);
  return 0;
}
function noteLoginFail(ip) {
  const rec = loginFails.get(ip) || { n: 0, lockedUntil: 0 };
  rec.n += 1;
  if (rec.n >= LOGIN_MAX_FAILS) { rec.lockedUntil = Date.now() + LOGIN_LOCK_MS; rec.n = 0; }
  loginFails.set(ip, rec);
}

/* ============================================================
 * 抓取
 * ============================================================ */
const refreshing = new Set();   // 正在抓取的 feed id，避免并发重复抓
// 状态页要展示的最近一次抓取快照；results 是逐个频道的结果明细
let lastRefresh = {
  at: 0, startedAt: 0, durationMs: 0,
  results: [], added: 0, pruned: 0, skipped: 0, failed: 0,
};

/** 抓单个频道。
 *
 * 两层去重 / 节流：
 *  1. refreshing Set：同一频道**正在抓**的请求直接返回 skipped（并发去重）
 *  2. recentFetch Map：同一频道**刚抓完 < 5s** 的请求直接跳过（防连点"刷新全部"打爆源站）
 *
 * 抓取失败由 rss.fetchFeed 内部按指数退避重试 3 次；仍失败才在这里记 error。
 *
 * 注意：没做"同 URL 跨 feed 共享 Promise"那种去重 —— 同一 URL 被多个 feed 引用时，
 * 共享 promise 只会把条目写到先到那个 feed 的库里，另一个 feed 看似刷新了但条目没存，
 * 比多发一次 HTTP 麻烦得多。如果将来真的撞了同 URL，再单独设计。
 */
const recentFetchMs = new Map();   // feedId -> 上次抓取完成时间
const REFRESH_MIN_INTERVAL_MS = 5000;

async function refreshFeed(feed) {
  // 1) 同一频道并发去重
  if (refreshing.has(feed.id)) return { feedId: feed.id, skipped: true };
  // 2) 刚抓完 5 秒内不重复（成功 / 失败都算）
  const last = recentFetchMs.get(feed.id);
  if (last && Date.now() - last < REFRESH_MIN_INTERVAL_MS) {
    return { feedId: feed.id, skipped: 'too-recent' };
  }
  return doRefresh(feed);
}

async function doRefresh(feed) {
  refreshing.add(feed.id);
  try {
    const r = await rss.loadFeed(feed.url, {
      etag: feed.etag,
      lastModified: feed.last_modified,
      timeoutMs: settings.source.timeoutSeconds * 1000,
      proxyUrl: settings.source.proxyUrl,
    });

    if (r.notModified) {
      await db.saveFeedMeta(feed.id, { status: 'ok', error: null });
      return { feedId: feed.id, notModified: true, added: 0, total: 0 };
    }

    const added = await db.upsertEntries(feed.id, r.items);
    await db.saveFeedMeta(feed.id, {
      title: r.title, siteUrl: r.siteUrl, description: r.description, iconUrl: r.iconUrl,
      etag: r.etag, lastModified: r.lastModified, status: 'ok', error: null,
    });
    return { feedId: feed.id, notModified: false, added, total: r.items.length, title: r.title };
  } catch (e) {
    const msg = String((e && e.message) || e).slice(0, 300);
    await db.saveFeedMeta(feed.id, { status: 'error', error: msg }).catch(() => {});
    return { feedId: feed.id, error: msg };
  } finally {
    refreshing.delete(feed.id);
    // 无论成功失败都记"刚抓完"时间，避免源站被连点刷新打爆
    recentFetchMs.set(feed.id, Date.now());
  }
}

/** 这个频道该隔多久抓一次：频道自己设了就用它，否则跟随全局设置 */
function feedIntervalMs(f) {
  const own = Number(f && f.refresh_minutes);
  const mins = Number.isFinite(own) && own > 0
    ? own
    : (settings ? settings.source.refreshMinutes : 30);
  return mins * 60000;
}

/** 距上次抓取已超过自己间隔的频道（从没抓过的一律算到期） */
function dueFeeds(all, now = Date.now()) {
  return (all || []).filter((f) => {
    if (!f.enabled) return false;
    const last = f.last_fetched_at ? new Date(f.last_fetched_at).getTime() : 0;
    return !last || now - last >= feedIntervalMs(f);
  });
}

/**
 * 并发抓一批频道，抓完做清理并记下快照。
 * 「手动刷新全部」和「定时 tick」都走这里，区别只在传入的 feeds 不同。
 */
async function refreshFeeds(feeds, { concurrency, total, startedAt = Date.now(), label = '抓取' } = {}) {
  const limit = clampInt(concurrency, settings.source.concurrency, 1, 10);
  const results = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < feeds.length) {
      const f = feeds[cursor++];
      results.push(await refreshFeed(f));
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, feeds.length || 1) }, worker));

  // 两个上限是「并且」关系：条数上限 + 时间上限（keepDays = 0 表示不限时间）
  const prunedByCount = await db.pruneEntries(settings.source.keepPerFeed).catch(() => 0);
  const prunedByAge = await db.pruneEntriesByAge(settings.source.keepDays).catch(() => 0);
  const added = results.reduce((n, r) => n + (r.added || 0), 0);
  const failed = results.filter((r) => r.error).length;
  const skipped = total == null ? 0 : Math.max(0, total - feeds.length);
  lastRefresh = {
    at: Date.now(), startedAt, durationMs: Date.now() - startedAt,
    results, added, pruned: prunedByCount + prunedByAge, prunedByAge, skipped, failed,
  };
  log(`[rss] ${label}完成：${feeds.length} 个频道，新增 ${added} 条`
    + (skipped ? `，跳过 ${skipped} 个（未开启采集或未到期）` : '')
    + (failed ? `，失败 ${failed} 个` : '')
    + (prunedByCount ? `，按条数清理 ${prunedByCount} 条` : '')
    + (prunedByAge ? `，按时间清理 ${prunedByAge} 条` : ''));
  return {
    at: lastRefresh.at, results, added, failed, skipped,
    pruned: lastRefresh.pruned, prunedByAge,
  };
}

/** 手动「刷新全部」：不看到期与否，把所有用户开启采集的频道都抓一遍 */
async function refreshAll({ concurrency } = {}) {
  const all = await db.allEnabledFeeds();
  return refreshFeeds(all, { concurrency, total: all.length });
}

/** 定时 tick：只抓「到期」的频道（跨用户）。每个频道按自己的频率，没设的跟随全局 */
async function refreshDue() {
  const all = await db.allEnabledFeeds();
  const feeds = dueFeeds(all);
  if (!feeds.length) return null;
  return refreshFeeds(feeds, { total: all.length, label: '定时抓取' });
}

/**
 * 调度：改成每分钟 tick 一次，自己判断哪些频道到期。
 * 老实现是「全局 setInterval 到点全抓」，无法支持每频道不同频率；
 * 现在是「到期的才抓」，效果上每个频道仍然是各自间隔一次，只是更平滑。
 */
const REFRESH_TICK_MS = 60000;
let refreshTimer = null;

function scheduleRefresh() {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  refreshTimer = setInterval(() => {
    refreshDue().catch((e) => logErr('[rss] 定时抓取失败：' + ((e && e.message) || e)));
  }, REFRESH_TICK_MS);
  log(`[rss] 调度就绪：全局 ${settings.source.refreshMinutes} 分钟，每分钟检查一次到期频道`
    + (settings.source.keepDays
      ? `；条目保留 ${settings.source.keepDays} 天`
      : `；条目仅按每频道 ${settings.source.keepPerFeed} 条保留`));
}

/* ============================================================
 * 图片代理（RSS 里的图直接由后端取，绕开防盗链与混合内容）
 * ============================================================ */
const IMG_CACHE_TTL = 6 * 3600 * 1000;
const imgCache = new Map();

function isPrivateHost(host) {
  const h = String(host || '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h === '0.0.0.0') return true;
  if (h === '[::1]' || h === '::1') return true;
  const m = h.match(/^\[?([0-9a-f:]+)\]?$/);
  if (m && /:/.test(m[1])) return true;                     // 其它 IPv6 一律拒绝
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a >= 224) return true;
  }
  return false;
}

async function proxyImage(rawUrl, res) {
  let target;
  try { target = new URL(String(rawUrl || '')); } catch (_) {
    res.writeHead(400, { 'Content-Type': 'text/plain' }).end('bad url');
    return;
  }
  if (!/^https?:$/.test(target.protocol) || isPrivateHost(target.hostname)) {
    res.writeHead(400, { 'Content-Type': 'text/plain' }).end('url not allowed');
    return;
  }

  const key = target.toString();
  const hit = imgCache.get(key);
  if (hit && Date.now() - hit.t < IMG_CACHE_TTL) {
    res.writeHead(200, {
      'Content-Type': hit.type, 'Content-Length': hit.buf.length,
      'Cache-Control': 'public, max-age=86400, immutable',
    });
    res.end(hit.buf);
    return;
  }

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15000);
  try {
    const resp = await fetch(key, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Shiyue/2.0)' },
      signal: ctl.signal,
      redirect: 'follow',
      dispatcher: getProxyDispatcher(settings && settings.source && settings.source.proxyUrl) || undefined,
    });
    if (!resp.ok) { res.writeHead(502).end('upstream ' + resp.status); return; }
    const type = resp.headers.get('content-type') || 'image/jpeg';
    if (!/^image\//i.test(type)) { res.writeHead(502).end('not an image'); return; }
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length > 8 * 1024 * 1024) { res.writeHead(502).end('image too large'); return; }

    imgCache.set(key, { t: Date.now(), type, buf });
    if (imgCache.size > 400) imgCache.delete(imgCache.keys().next().value);

    res.writeHead(200, {
      'Content-Type': type, 'Content-Length': buf.length,
      'Cache-Control': 'public, max-age=86400, immutable',
    });
    res.end(buf);
  } catch (e) {
    res.writeHead(504, { 'Content-Type': 'text/plain' }).end('image fetch failed');
  } finally {
    clearTimeout(timer);
  }
}

/* ============================================================
 * HTTP 基础设施
 * ============================================================ */
function readBody(req, maxBytes = 1e6) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > maxBytes) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (_) { reject(new Error('invalid json')); }
    });
    req.on('error', reject);
  });
}

/** 把 url 归一化用于去重比较（忽略大小写与首尾空白） */
const normUrl = (u) => String(u || '').trim().toLowerCase();

/* ============================================================
 * OPML 解析（无依赖）：从订阅管理软件导出的 opml 里抽出订阅源与分组
 * ============================================================ */
function parseOpmlAttrs(s) {
  const out = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(s)) !== null) out[m[1].toLowerCase()] = m[2];
  return out;
}

function parseOpml(text) {
  const feeds = [];
  const groups = [];          // 当前嵌套分组栈（文件夹名）
  const tagRe = /<(\/?)(outline|opml|head|body)\b([^>]*?)(\/?)>/gi;
  let m;
  while ((m = tagRe.exec(text)) !== null) {
    const closing = m[1] === '/';
    const name = m[2].toLowerCase();
    const attrs = m[3] || '';
    const selfClose = m[4] === '/';
    if (closing) { if (name === 'outline') groups.pop(); continue; }
    if (name !== 'outline') continue;
    const a = parseOpmlAttrs(attrs);
    const xmlUrl = (a.xmlurl || a.url || '').trim();
    if (xmlUrl) {
      const title = (a.title || a.text || '').trim();
      feeds.push({ url: xmlUrl, title, group: groups.filter(Boolean).join(' / ') || null });
      if (!selfClose) groups.push(null);   // 占位，等它自己的 </outline> 弹出
    } else {
      const folder = (a.title || a.text || '').trim();
      if (folder) {
        groups.push(folder);
        if (selfClose) groups.pop();        // 空文件夹，立即弹回
      }
    }
  }
  return feeds;
}

// 构建标识：容器每次重建启动都变。SPA 旧标签页不会自动拿到新代码，
// 靠 API 响应头把它带给前端，前端发现变化就提示「点此刷新」。
const APP_BUILD = Date.now().toString(36);

const json = (res, code, obj) => {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'X-App-Build': APP_BUILD,
  });
  res.end(JSON.stringify(obj));
};

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

// 外观配置：按账号维度持久化到 users.prefs.appearance（不再落浏览器 localStorage）
const APPEARANCE_DEFAULTS = { theme: 'auto', accent: 'blue', fontSize: 'm', readerFont: 'sans', readerLh: 'm', readerWidth: 'm' };
const APPEARANCE_KEYS = {
  theme: ['auto', 'light', 'dark', 'github'],
  accent: ['blue', 'violet', 'teal', 'green', 'amber', 'rose'],
  fontSize: ['s', 'm', 'l'],
  readerFont: ['sans', 'serif'],
  readerLh: ['s', 'm', 'l'],
  readerWidth: ['s', 'm', 'l', 'full'],
};
function sanitizeAppearance(raw) {
  const out = Object.assign({}, APPEARANCE_DEFAULTS);
  if (raw && typeof raw === 'object') {
    for (const k of Object.keys(APPEARANCE_DEFAULTS)) {
      if (APPEARANCE_KEYS[k].indexOf(raw[k]) >= 0) out[k] = raw[k];
    }
  }
  return out;
}
function userAppearance(u) {
  return sanitizeAppearance((u && u.prefs && u.prefs.appearance) || {});
}

// 布局偏好（视图模式 / 当前页面 / 分组折叠 / 阅读手风琴 / AI 子页 / 设置分组开合）
// 同样按账号维度持久化到 users.prefs.layout，不再落浏览器 localStorage
const LAYOUT_DEFAULTS = { view: 'grid', tab: 'reader', collapsedGroups: [], accordion: true, aiPage: 'digest', sections: {}, sort: 'new', rdScope: 'all' };
const LAYOUT_VALUES = { view: ['grid', 'list'], tab: ['reader', 'cards', 'ai'], aiPage: ['digest', 'settings'], sort: ['new', 'old', 'name'], rdScope: ['all', 'unread', 'favorite'] };
function sanitizeLayout(raw) {
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
    // 阅读页排序方式（最新 / 最早 / 名称）与默认范围（全部 / 未读 / 收藏）
    if (LAYOUT_VALUES.sort.indexOf(raw.sort) >= 0) out.sort = raw.sort;
    if (LAYOUT_VALUES.rdScope.indexOf(raw.rdScope) >= 0) out.rdScope = raw.rdScope;
  }
  return out;
}
function userLayout(u) {
  return sanitizeLayout((u && u.prefs && u.prefs.layout) || {});
}

function serveStatic(pathname, res, user) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403).end('forbidden'); return; }
  fs.readFile(filePath, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found'); return; }
    let body = buf;
    // 已登录访问首页：把该账号的外观配置注入 <head>，首屏即生效，无需本机存储
    if (rel === '/index.html' && user && user.prefs) {
      const anchor = '<meta name="theme-color" content="#ffffff">';
      const s = buf.toString('utf8');
      const idx = s.indexOf(anchor);
      if (idx >= 0) {
        const inj = '<script>window.__APPEARANCE__=' + JSON.stringify(userAppearance(user))
          + ';window.__LAYOUT__=' + JSON.stringify(userLayout(user)) + ';</script>';
        body = Buffer.from(s.slice(0, idx + anchor.length) + '\n' + inj + s.slice(idx + anchor.length));
      }
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(body);
  });
}

/** 数据库行 → 前端卡片结构 */
// bodyJson 里的图片块存的是原始外链，浏览器直连会被防盗链拦 / 过期签名失效
// （卡片缩略图的 image/images 都走了 /api/img 代理，这里保持一致）
function proxyBodyJson(json) {
  if (!json) return null;
  try {
    const blocks = JSON.parse(json);
    if (!Array.isArray(blocks)) return json;
    let changed = false;
    for (const b of blocks) {
      if (b && b.t === 'img' && typeof b.src === 'string' && /^https?:\/\//i.test(b.src)) {
        b.src = '/api/img?u=' + encodeURIComponent(b.src);
        changed = true;
      }
    }
    return changed ? JSON.stringify(blocks) : json;
  } catch { return json; }
}

function toCard(row) {
  return {
    id: String(row.id),
    name: row.title,
    desc: row.description || '',
    size: row.size || '',
    tags: row.tags || [],
    link: row.link || null,
    pwd: row.pwd || null,
    // 文章内所有可复制的链接（主链接优先）；复制按钮用它做多选，不做代理（复制的是原始地址）
    links: Array.isArray(row.links) ? row.links : [],
    image: row.image ? '/api/img?u=' + encodeURIComponent(row.image) : null,
    // 多图文章：每张都走 /api/img 代理；没有就空数组（前端会退回单张 image）
    images: Array.isArray(row.images)
      ? row.images.map((u) => '/api/img?u=' + encodeURIComponent(u))
      : [],
    // 图文顺序块 JSON（阅读页内联渲染用）；图片块统一走 /api/img 代理；没有就 null（前端退回纯文本路径）
    bodyJson: proxyBodyJson(row.body_json),
    sourceUrl: row.source_url || null,
    date: row.published_at ? new Date(row.published_at).toISOString() : null,
    feedId: String(row.feed_id),
    feedName: row.feed_name || '',
    isRead: !!row.is_read,
    isFavorite: !!row.is_favorite,
    favoritedAt: row.favorited_at ? new Date(row.favorited_at).toISOString() : null,
  };
}

function toFeedDto(f) {
  // 频道自己设了频率就用它，否则跟随全局；nextRefreshAt 由「上次抓取 + 自己的间隔」推出来
  const own = Number(f.refresh_minutes);
  const ownMins = Number.isFinite(own) && own > 0 ? own : null;
  const effMins = ownMins || (settings ? settings.source.refreshMinutes : 30);
  const lastMs = f.last_fetched_at ? new Date(f.last_fetched_at).getTime() : 0;
  return {
    id: String(f.id),
    url: f.url,
    title: f.title || f.url,
    customTitle: f.custom_title || null,
    siteUrl: f.site_url || null,
    description: f.description || '',
    icon: f.icon_url ? '/api/img?u=' + encodeURIComponent(f.icon_url) : null,
    // enabled = 采集开关；cardEnabled = 卡片页展示开关
    enabled: !!f.enabled,
    cardEnabled: !!f.card_enabled,
    groupName: f.group_name || '',
    sortOrder: Number(f.sort_order || 0),
    entryCount: Number(f.entry_count || 0),
    unreadCount: Number(f.unread_count || 0),
    // refreshMinutes = 该频道单独设置的频率（null 表示跟随全局）
    refreshMinutes: ownMins,
    effectiveRefreshMinutes: effMins,
    nextRefreshAt: lastMs ? new Date(lastMs + effMins * 60000).toISOString() : null,
    status: f.last_status || null,
    error: f.last_error || null,
    lastFetchedAt: f.last_fetched_at ? new Date(f.last_fetched_at).toISOString() : null,
  };
}

/** 从频道列表里抽出分组名（去重、未分组不列入） */
function groupsOf(feeds) {
  const set = new Set();
  for (const f of feeds) {
    const g = (f.groupName || '').trim();
    if (g) set.add(g);
  }
  return [...set].sort((a, b) => a.localeCompare(b, 'zh'));
}

/* ============================================================
 * 路由
 * ============================================================ */
const dbRequired = (res) => {
  const st = db.status();
  if (st.ready) return false;
  json(res, 503, { error: '数据库未就绪，请稍后重试', detail: st.error || null });
  return true;
};

/* ---------- 关于 / 版本检测 ----------
 * 当前版本取自 package.json；「检查更新」向 GitHub 查最新 Release，
 * 没有发布 Release 时退回 tags 列表；结果全站缓存 10 分钟，避免频繁命中
 * GitHub 未认证限流（每小时 60 次/IP）。不需要数据库，放在登录闸门之后单独处理。 */
const GITHUB_REPO = process.env.GITHUB_REPO || 'chensnails/shiyue';
const VERSION_CHECK_TTL = 10 * 60 * 1000;
let versionCheckCache = { at: 0, data: null };

/** 语义化版本比较：a 比 b 新返回 1，相同 0，旧 -1 */
function compareVersion(a, b) {
  const pa = String(a || '0').replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '0').replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

async function fetchGithubLatest() {
  const headers = { 'User-Agent': 'shiyue-version-check', Accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = 'Bearer ' + process.env.GITHUB_TOKEN;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const relRes = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, { headers, signal: ctrl.signal });
    if (relRes.ok) {
      const rel = await relRes.json();
      if (rel && rel.tag_name) {
        return {
          latest: String(rel.tag_name).replace(/^v/i, ''),
          releaseUrl: rel.html_url || null,
          name: rel.name || null,
          publishedAt: rel.published_at || null,
          source: 'release',
        };
      }
    }
    const tagRes = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/tags`, { headers, signal: ctrl.signal });
    if (tagRes.ok) {
      const tags = await tagRes.json();
      if (Array.isArray(tags) && tags.length && tags[0].name) {
        const latest = String(tags[0].name).replace(/^v/i, '');
        return {
          latest,
          releaseUrl: `https://github.com/${GITHUB_REPO}/releases/tag/v${latest}`,
          name: null,
          publishedAt: null,
          source: 'tag',
        };
      }
    }
    throw new Error('GitHub 上还没有任何发布');
  } finally {
    clearTimeout(timer);
  }
}

const server = http.createServer(async (req, res) => {
  const { pathname, searchParams } = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const ip = req.socket.remoteAddress || 'unknown';
  const session = settings ? getSession(req) : null;
  const user = userOf(session);

  try {
    /* ---------- 公开接口 ---------- */
    if (pathname === '/api/health') {
      const st = db.status();
      json(res, st.ready ? 200 : 503, { ok: st.ready, authed: !!user, db: st });
      return;
    }

    if (pathname === '/api/session' && req.method === 'GET') {
      json(res, 200, {
        authenticated: !!user,
        username: user ? user.username : null,
        role: user ? user.role : null,
        id: user ? String(user.id) : null,
        dbReady: db.status().ready,
      });
      return;
    }

    if (pathname === '/api/login' && req.method === 'POST') {
      if (dbRequired(res)) return;
      const lock = loginLocked(ip);
      if (lock > 0) { json(res, 429, { error: `尝试次数过多，请 ${Math.ceil(lock / 1000)} 秒后再试` }); return; }
      const body = await readBody(req);
      const row = await db.getUserByName(body.username);
      // 用户名不存在时也走一次哈希，避免「响应快慢」暴露某个用户名是否存在
      const salt = row ? row.salt : 'shiyue.dummy.salt';
      const okPass = row ? safeEqual(hashPassword(body.password || '', salt), row.password_hash) : false;
      if (!row || !okPass) { noteLoginFail(ip); json(res, 401, { error: '用户名或密码错误' }); return; }
      loginFails.delete(ip);
      const acct = usersById.get(numId(row.id)) || { id: numId(row.id), username: row.username, role: row.role };
      setSession(res, acct);
      json(res, 200, { ok: true, username: row.username, role: row.role });
      return;
    }

    if (pathname === '/api/logout' && req.method === 'POST') {
      clearSession(res);
      json(res, 200, { ok: true });
      return;
    }

    /* ---------- 状态页（仅管理员）----------
     * 故意放在下面那道 dbRequired 闸门之前：数据库连不上正是这个页面要报的事，
     * 被 503 挡掉就什么诊断信息都看不到了。所以这里自己校验登录态与角色。 */
    if (pathname === '/api/status' && req.method === 'GET') {
      if (!user) { json(res, 401, { error: 'unauthorized' }); return; }
      if (!isAdmin(user)) { json(res, 403, { error: '需要管理员权限' }); return; }
      json(res, 200, await buildStatus());
      return;
    }

    /* ---------- 关于 / 版本（所有登录用户，不依赖数据库）---------- */
    if (pathname === '/api/version' && req.method === 'GET') {
      if (!user) { json(res, 401, { error: 'unauthorized' }); return; }
      json(res, 200, { version: pkg.version, repo: GITHUB_REPO });
      return;
    }

    if (pathname === '/api/version/check' && req.method === 'POST') {
      if (!user) { json(res, 401, { error: 'unauthorized' }); return; }
      const now = Date.now();
      if (versionCheckCache.data && now - versionCheckCache.at < VERSION_CHECK_TTL) {
        json(res, 200, versionCheckCache.data);
        return;
      }
      try {
        const info = await fetchGithubLatest();
        const result = {
          ok: true,
          current: pkg.version,
          latest: info.latest,
          hasUpdate: compareVersion(info.latest, pkg.version) > 0,
          releaseUrl: info.releaseUrl,
          name: info.name || null,
          publishedAt: info.publishedAt || null,
          source: info.source,
        };
        versionCheckCache = { at: now, data: result };
        json(res, 200, result);
      } catch (e) {
        json(res, 200, { ok: false, error: String((e && e.message) || e) });
      }
      return;
    }

    /* ---------- 静态资源 ---------- */
    if (pathname === '/login.html') { serveStatic(pathname, res); return; }
    if (pathname === '/favicon.ico' || pathname === '/favicon.svg'
      || pathname === '/manifest.json' || /^\/icon-/.test(pathname)
      || pathname === '/apple-touch-icon.png' || pathname === '/favicon-32.png') {
      serveStatic(pathname, res);
      return;
    }

    if (!user && (pathname === '/' || pathname === '/index.html')) {
      res.writeHead(302, { Location: '/login.html' });
      res.end();
      return;
    }
    if (user && pathname === '/login.html') {
      res.writeHead(302, { Location: '/' });
      res.end();
      return;
    }

    /* ---------- 以下均需登录 ---------- */
    if (pathname.startsWith('/api/')) {
      if (!user) { json(res, 401, { error: 'unauthorized' }); return; }
      if (dbRequired(res)) return;

      /* ---- 图片代理 ---- */
      if (pathname === '/api/img') { await proxyImage(searchParams.get('u'), res); return; }

      /* ---- 频道（RSS 订阅） ---- */
      if (pathname === '/api/feeds' && req.method === 'GET') {
        const rows = await db.listFeeds(user.id);
        const feeds = rows.map(toFeedDto);
        // 侧栏「全部 / 未读 / 收藏」三个固定入口的计数（只算当前用户的）
        const flags = await db.entryFlagCounts(user.id).catch(() => ({ total: 0, unread: 0, favorite: 0 }));
        // 下一次抓取 = 所有开启采集的频道里最早到期的那个时刻
        const nextAt = feeds
          .filter((f) => f.enabled)
          .map((f) => (f.nextRefreshAt ? new Date(f.nextRefreshAt).getTime() : Date.now()))
          .reduce((min, t) => (min === null || t < min ? t : min), null);
        json(res, 200, {
          feeds,
          total: feeds.length,
          enabled: feeds.filter((f) => f.enabled).length,          // 采集开关打开数
          cardEnabled: feeds.filter((f) => f.cardEnabled).length,  // 卡片开关打开数
          groups: groupsOf(feeds),
          groupOrder: (user.prefs && user.prefs.groupOrder) || [],
          flags,
          lastRefreshAt: lastRefresh.at || null,
          nextRefreshAt: nextAt ? new Date(nextAt).toISOString() : null,
          refreshMinutes: settings.source.refreshMinutes,
          keepDays: settings.source.keepDays,
          autoRefreshMinutes: settings.source.autoRefreshMinutes,
        });
        return;
      }

      if (pathname === '/api/feeds/reorder' && req.method === 'POST') {
        const body = await readBody(req);
        const items = Array.isArray(body && body.feeds) ? body.feeds
          : (Array.isArray(body) ? body : []);
        const n = await db.reorderFeeds(user.id, items);
        json(res, 200, { ok: true, updated: n });
        return;
      }

      if (pathname === '/api/feeds' && req.method === 'POST') {
        const body = await readBody(req);
        let url;
        try { url = rss.assertFeedUrl(body.url); }
        catch (e) { json(res, 400, { error: String(e.message || e) }); return; }

        const existed = (await db.listFeeds(user.id)).find((f) => f.url === url);
        const feed = await db.addFeed(user.id, url, {
          enabled: body.enabled !== false,
          cardEnabled: body.cardEnabled !== false,
          groupName: body.groupName ? String(body.groupName).trim().slice(0, 40) : null,
        });
        const result = await refreshFeed(feed);

        if (result.error && !result.skipped) {
          // 首次抓取就失败：不留半成品，回滚掉
          if (!existed) await db.deleteFeed(feed.id, user.id);
          json(res, 400, { error: '抓取失败：' + result.error });
          return;
        }
        json(res, 200, {
          ok: true,
          existed: !!existed,
          feed: toFeedDto(await db.getFeed(feed.id, user.id)),
          added: result.added || 0,
        });
        return;
      }

      if (pathname === '/api/feeds/refresh' && req.method === 'POST') {
        // 只刷新「当前用户自己」的频道（别人的频道由各自的刷新/定时 tick 负责）
        const mine = (await db.listFeeds(user.id)).filter((f) => f.enabled);
        const r = await refreshFeeds(mine, { total: mine.length, label: '手动刷新' });
        json(res, 200, {
          ok: true, at: r.at, added: r.added, skipped: r.skipped || 0,
          failed: r.results.filter((x) => x.error).map((x) => ({ feedId: String(x.feedId), error: x.error })),
        });
        return;
      }

      /* ---- OPML 导入（订阅源 + 分组，去重） ---- */
      if (pathname === '/api/feeds/import' && req.method === 'POST') {
        const body = await readBody(req, 8 * 1024 * 1024);
        const text = String(body.opml || '');
        if (!text.trim()) { json(res, 400, { error: '未收到 OPML 内容' }); return; }
        let parsed;
        try { parsed = parseOpml(text); }
        catch (e) { json(res, 400, { error: 'OPML 解析失败：' + (e.message || e) }); return; }
        if (!parsed.length) { json(res, 400, { error: '文件中没有找到任何订阅源（xmlUrl）' }); return; }

        const existing = await db.listFeeds(user.id);
        const existingUrls = new Set(existing.map((f) => normUrl(f.url)));
        const seen = new Set();
        const toAdd = [];
        const groupSet = new Set();
        for (const it of parsed) {
          const nu = normUrl(it.url);
          if (!nu) continue;
          if (seen.has(nu)) continue;          // 文件内去重
          seen.add(nu);
          if (existingUrls.has(nu)) continue;   // 与现有库去重
          toAdd.push(it);
          if (it.group) groupSet.add(it.group);
        }

        const added = [];
        for (const it of toAdd) {
          const feed = await db.addFeed(user.id, it.url, {
            groupName: it.group ? it.group.split(' / ').pop().slice(0, 40) : null,
            customTitle: it.title ? it.title.slice(0, 200) : null,
          });
          added.push(feed);
        }

        // 后台刷新新导入的频道（不阻塞响应）；抓取结果会落到状态页
        if (added.length) {
          refreshFeeds(added, { concurrency: settings.source.concurrency, label: '导入刷新' })
            .catch((e) => log('[opml] 导入后刷新失败：' + (e && e.message || e)));
        }

        json(res, 200, {
          ok: true,
          added: added.length,
          duplicated: parsed.length - added.length,
          groups: [...groupSet],
          feeds: added.map(toFeedDto),
        });
        return;
      }

      const feedRoute = pathname.match(/^\/api\/feeds\/(\d+)(\/refresh)?$/);
      if (feedRoute) {
        const id = Number(feedRoute[1]);
        const feed = await db.getFeed(id, user.id);
        if (!feed) { json(res, 404, { error: '频道不存在' }); return; }

        if (feedRoute[2] && req.method === 'POST') {
          const r = await refreshFeed(feed);
          json(res, 200, { ok: !r.error, result: r, feed: toFeedDto(await db.getFeed(id, user.id)) });
          return;
        }
        if (req.method === 'PATCH' || req.method === 'POST') {
          const body = await readBody(req);
          const patch = {};
          if (body.enabled !== undefined) patch.enabled = !!body.enabled;           // 采集开关
          if (body.cardEnabled !== undefined) patch.cardEnabled = !!body.cardEnabled; // 卡片开关
          if (body.groupName !== undefined) patch.groupName = String(body.groupName).trim().slice(0, 40) || null;
          // 自定义频道名：写 custom_title，不被抓取刷新覆盖（刷新只更新 title 字段）
          if (body.title !== undefined) patch.customTitle = String(body.title).trim().slice(0, 200) || null;
          if (body.sortOrder !== undefined) patch.sortOrder = int(body.sortOrder, 0);
          // 抓取频率：空 / 0 / 'global' 都表示「跟随全局」→ 存 NULL
          if (body.refreshMinutes !== undefined) {
            const raw = body.refreshMinutes;
            const n = Number(raw);
            patch.refreshMinutes = (raw === null || raw === '' || raw === 'global'
              || !Number.isFinite(n) || n <= 0)
              ? null : clampInt(n, null, 5, 1440);
          }
          await db.updateFeed(id, patch, user.id);
          json(res, 200, { ok: true, feed: toFeedDto(await db.getFeed(id, user.id)) });
          return;
        }
        if (req.method === 'DELETE') {
          await db.deleteFeed(id, user.id);
          json(res, 200, { ok: true });
          return;
        }
      }

      /* ---- 条目 ---- */
      if (pathname === '/api/entries' && req.method === 'GET') {
        const limit = Math.min(Math.max(int(searchParams.get('limit'), 50), 1), 200);
        const offset = Math.max(int(searchParams.get('offset'), 0), 0);
        const kw = (searchParams.get('q') || '').trim().slice(0, 100);
        const tag = (searchParams.get('tag') || '').trim().slice(0, 60) || null;
        // 未读 / 收藏是在频道范围之上再收窄一层，可叠加
        const unread = searchParams.get('unread') === '1';
        const favorite = searchParams.get('fav') === '1';
        // 收藏列表默认按「收藏时刻」倒序（最近收藏的在前），其余按发布时间
        const sort = searchParams.get('sort') === 'old' ? 'old' : 'new';
        const order = favorite ? 'fav' : sort;

        /* feedIds = null 表示「不加频道过滤，取全部条目」。
         * - 传了 feeds=1,2 → 就用这几个频道（显式指定，优先）
         * - 否则看 scope：
         *     cards（默认）→ 只取「卡片开关」打开的频道（卡片页）
         *     all          → 不过滤（文章页的「全部频道」） */
        let feedIds = null;
        const feedsParam = searchParams.get('feeds');
        if (feedsParam !== null) {
          const ids = feedsParam.split(',').map((s) => s.trim()).filter(Boolean).map(Number).filter(Number.isFinite);
          if (!ids.length) { json(res, 200, { entries: [], hasMore: false, total: 0, tags: [] }); return; }
          feedIds = ids;
        } else {
          const scope = searchParams.get('scope') === 'all' ? 'all' : 'cards';
          feedIds = scope === 'all' ? null : await db.cardFeedIds(user.id);
        }

        const [page, total, tags] = await Promise.all([
          db.queryEntries({ ownerId: user.id, feedIds, q: kw, tag, unread, favorite, order, limit, offset }),
          db.countEntries({ ownerId: user.id, feedIds, q: kw, tag, unread, favorite }),
          db.tagCounts(user.id, feedIds),
        ]);

        json(res, 200, {
          entries: page.rows.map(toCard),
          hasMore: page.hasMore,
          total,
          offset,
          limit,
          tags: tags.map((t) => ({ tag: t.tag, n: Number(t.n) })),
        });
        return;
      }

      /* ---- 侧栏徽标：全部 / 未读 / 收藏 ---- */
      if (pathname === '/api/entries/flags' && req.method === 'GET') {
        json(res, 200, await db.entryFlagCounts(user.id));
        return;
      }

      /* ---- 批量标为已读：条件与列表查询一致，所以「看到的」就是「被标掉的」 ---- */
      if (pathname === '/api/entries/read-all' && req.method === 'POST') {
        const body = await readBody(req);
        // feeds 不传 = 全部频道；传了空数组 = 什么都不标（交给 db 的 FALSE 分支）
        const feedIds = Array.isArray(body.feeds)
          ? body.feeds.map(Number).filter(Number.isFinite)
          : null;
        const updated = await db.markEntriesRead({
          ownerId: user.id,
          feedIds,
          q: String(body.q || '').trim().slice(0, 100),
          tag: String(body.tag || '').trim().slice(0, 60) || null,
          unread: true,
        });
        json(res, 200, { ok: true, updated });
        return;
      }

      /* ---- 单条条目（阅读页展开全文时才取，正文不跟着列表一起传） ---- */
      const entryRoute = pathname.match(/^\/api\/entries\/(\d+)$/);
      if (entryRoute && req.method === 'GET') {
        const row = await db.getEntry(Number(entryRoute[1]), user.id);
        if (!row) { json(res, 404, { error: '条目不存在' }); return; }
        json(res, 200, { ...toCard(row), content: row.content || '' });
        return;
      }

      /* ---- 单条标记：已读 / 未读 / 收藏，只改传进来的字段 ---- */
      if (entryRoute && req.method === 'PATCH') {
        const body = await readBody(req);
        const patch = {};
        if (body.isRead !== undefined) patch.isRead = !!body.isRead;
        if (body.isFavorite !== undefined) patch.isFavorite = !!body.isFavorite;
        if (!Object.keys(patch).length) { json(res, 400, { error: '没有要修改的标记' }); return; }
        const row = await db.setEntryFlags(Number(entryRoute[1]), patch, user.id);
        if (!row) { json(res, 404, { error: '条目不存在' }); return; }
        json(res, 200, {
          ok: true,
          id: String(row.id),
          isRead: !!row.is_read,
          isFavorite: !!row.is_favorite,
          favoritedAt: row.favorited_at ? new Date(row.favorited_at).toISOString() : null,
        });
        return;
      }

      /* ---- 站点级设置（LLM / 采集 / 日报调度）—— 仅管理员 ---- */
      if (pathname === '/api/config' && req.method === 'GET') {
        if (!isAdmin(user)) { json(res, 403, { error: '需要管理员权限' }); return; }
        json(res, 200, {
          username: user.username,
          role: user.role,
          llm: {
            baseUrl: settings.llm.baseUrl,
            // 明文 Key 一律不回传：前端只知道「有没有存」和掩码，要换就重新填
            apiKey: '',
            apiKeySet: !!settings.llm.apiKey,
            apiKeyHint: maskSecret(settings.llm.apiKey),
            model: settings.llm.model,
            temperature: settings.llm.temperature,
          },
          digest: {
            enabled: !!settings.digest.enabled,
            time: settings.digest.time,
            maxPerFeed: settings.digest.maxPerFeed,
            maxTotal: settings.digest.maxTotal,
            keepDays: settings.digest.keepDays,
            scope: settings.digest.scope || 'selected',
          },
          source: {
            refreshMinutes: settings.source.refreshMinutes,
            keepPerFeed: settings.source.keepPerFeed,
            keepDays: settings.source.keepDays,
            timeoutSeconds: settings.source.timeoutSeconds,
            concurrency: settings.source.concurrency,
            autoRefreshMinutes: settings.source.autoRefreshMinutes,
          },
        });
        return;
      }

      if (pathname === '/api/config' && req.method === 'POST') {
        if (!isAdmin(user)) { json(res, 403, { error: '需要管理员权限' }); return; }
        const body = await readBody(req);
        const patch = {};

        if (body.llm) {
          const baseUrl = String(body.llm.baseUrl || '').trim().replace(/\/+$/, '');
          if (baseUrl && !/^https?:\/\//i.test(baseUrl)) { json(res, 400, { error: '模型地址需以 http:// 或 https:// 开头' }); return; }
          const next = Object.assign({}, settings.llm);
          next.baseUrl = baseUrl;
          next.model = String(body.llm.model || '').trim();
          next.temperature = clampNum(body.llm.temperature, settings.llm.temperature, 0, 1.5);
          /* Key 三态（前端不再回填明文，所以「留空」必须等于「不改」）：
           *   clearApiKey=true → 清除
           *   apiKey 有内容    → 换成新的（落库前加密）
           *   apiKey 空 / 未传 → 保持原值 */
          if (body.llm.clearApiKey) {
            next.apiKey = '';
            next.apiKeyEnc = '';
          } else if (typeof body.llm.apiKey === 'string' && body.llm.apiKey.trim()) {
            next.apiKey = body.llm.apiKey.trim();
          }
          patch.llm = next;
        }

        if (body.digest) {
          const d = body.digest;
          const next = Object.assign({}, settings.digest);
          if (d.time !== undefined) {
            if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(d.time))) { json(res, 400, { error: '生成时间格式应为 HH:MM' }); return; }
            next.time = String(d.time);
          }
          if (d.enabled !== undefined) next.enabled = !!d.enabled;
          if (d.scope !== undefined) next.scope = d.scope === 'all' ? 'all' : 'selected';
          if (d.maxPerFeed !== undefined) next.maxPerFeed = clampInt(d.maxPerFeed, 20, 1, 100);
          if (d.maxTotal !== undefined) next.maxTotal = clampInt(d.maxTotal, 150, 10, 500);
          if (d.keepDays !== undefined) next.keepDays = clampInt(d.keepDays, 30, 1, 365);
          patch.digest = next;
        }

        if (body.source) {
          const s = body.source;
          const next = Object.assign({}, settings.source);
          if (s.refreshMinutes !== undefined) next.refreshMinutes = clampInt(s.refreshMinutes, 20, 5, 1440);
          if (s.keepPerFeed !== undefined) next.keepPerFeed = clampInt(s.keepPerFeed, 300, 0, 5000);
          // 0 = 不限（只按条数上限保留）
          if (s.keepDays !== undefined) next.keepDays = clampInt(s.keepDays, 0, 0, 3650);
          if (s.timeoutSeconds !== undefined) next.timeoutSeconds = clampInt(s.timeoutSeconds, 25, 5, 120);
          if (s.concurrency !== undefined) next.concurrency = clampInt(s.concurrency, 3, 1, 10);
          if (s.autoRefreshMinutes !== undefined) next.autoRefreshMinutes = clampInt(s.autoRefreshMinutes, 0, 0, 1440);
          if (s.proxyUrl !== undefined) next.proxyUrl = String(s.proxyUrl || '').trim().slice(0, 500);
          patch.source = next;
        }

        if (!Object.keys(patch).length) { json(res, 400, { error: '没有可保存的字段' }); return; }
        await saveSettings(patch);
        if (patch.digest) scheduleDigest();
        if (patch.source) scheduleRefresh();
        json(res, 200, { ok: true });
        return;
      }

      /* ---- 每用户偏好（分组顺序 + 外观配置 + 布局偏好）—— 所有登录用户 ---- */
      if (pathname === '/api/prefs' && req.method === 'GET') {
        json(res, 200, {
          groupOrder: (user.prefs && user.prefs.groupOrder) || [],
          appearance: userAppearance(user),
          layout: userLayout(user),
          llm: userLlmForView(user.prefs),
        });
        return;
      }
      if (pathname === '/api/prefs' && req.method === 'POST') {
        const body = await readBody(req);
        const prefs = Object.assign({}, user.prefs || {});
        if (Array.isArray(body.groupOrder)) {
          prefs.groupOrder = body.groupOrder
            .filter((g) => typeof g === 'string')
            .map((g) => g.trim().slice(0, 40))
            .filter(Boolean);
        }
        // 外观配置按账号保存（主题 / 主色 / 字号 / 阅读字体 / 行高 / 阅读宽度）
        if (body.appearance && typeof body.appearance === 'object') {
          prefs.appearance = sanitizeAppearance(body.appearance);
        }
        // 布局偏好按账号保存（视图模式 / 当前页面 / 分组折叠 / 手风琴 / AI 子页 / 设置分组开合）
        if (body.layout && typeof body.layout === 'object') {
          prefs.layout = sanitizeLayout(body.layout);
        }
        // 模型配置按账号保存：与已有配置合并（只覆盖传入字段，避免未改的 Key 被清空）；
        // apiKey 仅在填写时加密成文，clearApiKey 则清空
        if (body.llm && typeof body.llm === 'object') {
          const prev = (user.prefs && user.prefs.llm) || {};
          prefs.llm = userLlmForStore(Object.assign({}, prev, body.llm));
        }
        await db.setUserPrefs(user.id, prefs);
        await loadUsers();
        json(res, 200, {
          ok: true,
          groupOrder: prefs.groupOrder || [],
          appearance: sanitizeAppearance(prefs.appearance),
          layout: sanitizeLayout(prefs.layout),
        });
        return;
      }

      /* ---- 用户管理（仅管理员）---- */
      if (pathname === '/api/users' && req.method === 'GET') {
        if (!isAdmin(user)) { json(res, 403, { error: '需要管理员权限' }); return; }
        const rows = await db.listUsers();
        const list = await Promise.all(rows.map(async (u) => ({
          id: String(u.id), username: u.username, role: u.role,
          createdAt: u.created_at ? new Date(u.created_at).toISOString() : null,
          feedCount: (await db.listFeeds(numId(u.id))).length,
          isSelf: numId(u.id) === user.id,
        })));
        json(res, 200, { users: list });
        return;
      }

      if (pathname === '/api/users' && req.method === 'POST') {
        if (!isAdmin(user)) { json(res, 403, { error: '需要管理员权限' }); return; }
        const body = await readBody(req);
        const username = String(body.username || '').trim();
        const password = String(body.password || '');
        const role = body.role === 'admin' ? 'admin' : 'user';
        if (!/^[\w.\-@]{1,40}$/.test(username)) { json(res, 400, { error: '用户名只能包含字母、数字、. _ - @，且不超过 40 位' }); return; }
        if (password.length < 4) { json(res, 400, { error: '密码至少 4 位' }); return; }
        if (await db.getUserByName(username)) { json(res, 409, { error: '用户名已存在' }); return; }
        const salt = crypto.randomBytes(16).toString('hex');
        const created = await db.createUser({ username, salt, passwordHash: hashPassword(password, salt), role });
        await loadUsers();
        json(res, 200, { ok: true, user: { id: String(created.id), username: created.username, role: created.role } });
        return;
      }

      const userRoute = pathname.match(/^\/api\/users\/(\d+)$/);
      if (userRoute) {
        if (!isAdmin(user)) { json(res, 403, { error: '需要管理员权限' }); return; }
        const uid = Number(userRoute[1]);
        const target = await db.getUserById(uid);
        if (!target) { json(res, 404, { error: '用户不存在' }); return; }
        const adminCount = async () => (await db.listUsers()).filter((u) => u.role === 'admin').length;

        if (req.method === 'PATCH') {
          const body = await readBody(req);
          if (body.role !== undefined) {
            const role = body.role === 'admin' ? 'admin' : 'user';
            if (target.role === 'admin' && role !== 'admin' && (await adminCount()) <= 1) {
              json(res, 400, { error: '至少要保留一个管理员' }); return;
            }
            await db.setUserRole(uid, role);
          }
          if (typeof body.password === 'string' && body.password) {
            if (body.password.length < 4) { json(res, 400, { error: '密码至少 4 位' }); return; }
            const salt = crypto.randomBytes(16).toString('hex');
            await db.setUserPassword(uid, salt, hashPassword(body.password, salt));
          }
          await loadUsers();
          const fresh = await db.getUserById(uid);
          json(res, 200, { ok: true, user: { id: String(fresh.id), username: fresh.username, role: fresh.role } });
          return;
        }
        if (req.method === 'DELETE') {
          if (uid === user.id) { json(res, 400, { error: '不能删除当前登录的账号' }); return; }
          if (target.role === 'admin' && (await adminCount()) <= 1) {
            json(res, 400, { error: '至少要保留一个管理员' }); return;
          }
          await db.deleteUser(uid);
          await loadUsers();
          json(res, 200, { ok: true });
          return;
        }
      }

      /* ---- 账号：改「自己」的密码 / 用户名 ---- */
      if (pathname === '/api/account' && req.method === 'POST') {
        const body = await readBody(req);
        const me = await db.getUserByName(user.username);
        if (!me || !safeEqual(hashPassword(body.currentPassword || '', me.salt), me.password_hash)) {
          json(res, 400, { error: '当前密码不正确' });
          return;
        }
        const newUser = String(body.username || '').trim();
        const newPass = String(body.newPassword || '');
        if (newPass && newPass.length < 4) { json(res, 400, { error: '新密码至少 4 位' }); return; }
        if (!newUser && !newPass) { json(res, 400, { error: '用户名和新密码至少填一项' }); return; }

        if (newPass) {
          const salt = crypto.randomBytes(16).toString('hex');
          await db.setUserPassword(user.id, salt, hashPassword(newPass, salt));
        }
        if (newUser && newUser !== me.username) {
          if (!/^[\w.\-@]{1,40}$/.test(newUser)) { json(res, 400, { error: '用户名只能包含字母、数字、. _ - @，且不超过 40 位' }); return; }
          if (await db.getUserByName(newUser)) { json(res, 400, { error: '用户名已被占用' }); return; }
          await db.setUsername(user.id, newUser);
        }
        await loadUsers();
        const fresh = usersById.get(user.id);
        setSession(res, fresh);
        json(res, 200, { ok: true, username: fresh.username, role: fresh.role });
        return;
      }

      /* ---- 摘要：测试模型（所有登录用户，用自己的配置）---- */
      if (pathname === '/api/digest/test-llm' && req.method === 'POST') {
        const body = await readBody(req);
        const llm = resolveUserLlm(user);
        // 允许前端临时覆盖（填了就用填的，留空沿用已保存 / 站点默认）
        if (body.llm) {
          if (body.llm.baseUrl !== undefined && body.llm.baseUrl.trim()) llm.baseUrl = body.llm.baseUrl.trim().replace(/\/+$/, '');
          if (body.llm.model !== undefined && body.llm.model.trim()) llm.model = body.llm.model.trim();
          if (typeof body.llm.apiKey === 'string' && body.llm.apiKey.trim()) llm.apiKey = body.llm.apiKey.trim();
        }
        try { json(res, 200, await digest.testLlm(llm)); }
        catch (e) { json(res, 200, { ok: false, error: String((e && e.message) || e) }); }
        return;
      }

      if (pathname === '/api/digests' && req.method === 'GET') {
        json(res, 200, { dates: await db.listDigestDates(user.id) });
        return;
      }

      if (pathname === '/api/digest' && req.method === 'GET') {
        const date = searchParams.get('date') || shanghaiDateStr();
        json(res, 200, { date, digest: await db.readDigest(user.id, date) });
        return;
      }

      if (pathname === '/api/digest/generate' && req.method === 'POST') {
        const body = await readBody(req);
        const date = String(body.date || '').trim() || shanghaiDateStr();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { json(res, 400, { error: '日期格式应为 YYYY-MM-DD' }); return; }
        // 未显式指定频道时，按「摘要范围」设置决定：selected = 仅当前用户已开启的频道，all = 该用户全部
        const feeds = Array.isArray(body.feeds) && body.feeds.length
          ? body.feeds.map(Number).filter(Number.isFinite)
          : (settings.digest.scope === 'all' ? null : await db.enabledFeedIds(user.id));
        try {
          const r = await digest.generate({ ownerId: user.id, feeds, date, force: !!body.force, llm: resolveUserLlm(user) });
          json(res, 200, { ok: true, cached: r.cached, digest: r.digest });
        } catch (e) {
          json(res, 502, { error: String((e && e.message) || e) });
        }
        return;
      }

      json(res, 404, { error: 'not found' });
      return;
    }

    serveStatic(pathname, res, user);
  } catch (err) {
    logErr('[http] ' + (err && err.stack || err));
    if (!res.headersSent) json(res, 502, { error: String((err && err.message) || err) });
    else res.end();
  }
});

/* ============================================================
 * 每日 AI 摘要：调度
 * ============================================================ */
function shanghaiDateStr(d) {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d || new Date());
}

function msUntilNext(timeStr) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(timeStr || '08:00'));
  const hh = m ? Number(m[1]) : 8;
  const mm = m ? Number(m[2]) : 0;
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', hour12: false,
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date()).reduce((a, x) => (a[x.type] = x.value, a), {});
  const cur = Number(p.hour) * 3600 + Number(p.minute) * 60 + Number(p.second);
  const target = hh * 3600 + mm * 60;
  let delta = target - cur;
  if (delta <= 0) delta += 86400;
  return delta * 1000;
}

let digestTimer = null;
function scheduleDigest() {
  if (digestTimer) { clearTimeout(digestTimer); digestTimer = null; }
  if (!settings || !settings.digest.enabled) return;

  const wait = msUntilNext(settings.digest.time);
  digestTimer = setTimeout(async () => {
    digestTimer = null;
    try {
      // 到点给「每个用户」各生成一份自己的日报（各用各自的订阅源）
      const ids = await db.allUserIds();
      for (const uid of ids) {
        try {
          const u = await db.getUserById(uid);
          const llm = u ? resolveUserLlm(u) : settings.llm;
          const feeds = settings.digest.scope === 'all' ? null : await db.enabledFeedIds(uid);
          const r = await digest.generate({ ownerId: uid, feeds, force: true, llm });
          log(`[digest] 用户#${uid} 已生成 ${r.digest.date} 摘要：`
            + `${r.digest.stats.kept}/${r.digest.stats.collected} 条，${r.digest.stats.feeds} 个频道`
            + (r.digest.fallback ? '（规则降级）' : `（${r.digest.model}）`));
        } catch (e) {
          logErr(`[digest] 用户#${uid} 自动生成失败：` + ((e && e.message) || e));
        }
      }
    } catch (e) {
      logErr('[digest] 自动生成失败：' + ((e && e.message) || e));
    } finally {
      scheduleDigest();
    }
  }, wait);
  log(`[digest] 下次自动生成：${settings.digest.time}（约 ${Math.round(wait / 60000)} 分钟后，覆盖全部用户）`);
}

/* ============================================================
 * 状态页：把散落在各处的运行指标聚成一次快照
 * ============================================================ */

const readCgroupFile = (file) => {
  try { return String(fs.readFileSync(file, 'utf8')).trim(); } catch (_) { return null; }
};

/** 正整数字节数；cgroup v2 未设限额时内容是 "max" → NaN，正好被挡掉 */
function cgroupBytes(raw, { cap = 2 ** 40 } = {}) {
  const n = Number(raw);
  // 上限 1 TiB（注意必须写 2 ** 40：JS 的位运算只有 32 位，1 << 40 会变成 256）
  // v1 的「无限制」是个接近 2^63 的巨数，超过这个量级一律当作未设限
  return Number.isFinite(n) && n > 0 && n < cap ? n : null;
}

/** 容器内存。v2 优先、v1 兜底；即使没设限额，memory.current 也是有意义的真实占用 */
function readCgroupMemory() {
  const v2Used = cgroupBytes(readCgroupFile('/sys/fs/cgroup/memory.current'));
  if (v2Used !== null) {
    return { used: v2Used, limit: cgroupBytes(readCgroupFile('/sys/fs/cgroup/memory.max')) };
  }
  const v1Used = cgroupBytes(readCgroupFile('/sys/fs/cgroup/memory/memory.usage_in_bytes'));
  if (v1Used !== null) {
    return { used: v1Used, limit: cgroupBytes(readCgroupFile('/sys/fs/cgroup/memory/memory.limit_in_bytes')) };
  }
  return null;
}

// 容器 CPU 是累计值，只有两次采样相减才有意义；状态页每 30s 拉一次，正好当采样点
let lastCpuSample = null;
/** 容器 CPU 占用（%，相对单核；多核可超过 100）。首次请求没有基准，返回 null */
function readCgroupCpu() {
  let usec = null;
  const v2 = /^usage_usec\s+(\d+)/m.exec(readCgroupFile('/sys/fs/cgroup/cpu.stat') || '');
  if (v2) usec = Number(v2[1]) / 1000;                                  // v2 单位是微秒
  else {
    const v1 = readCgroupFile('/sys/fs/cgroup/cpuacct/cpuacct.usage');
    if (v1) usec = Number(v1) / 1000;                                   // v1 单位是纳秒
  }
  if (!Number.isFinite(usec)) return null;

  const at = Date.now();
  const prev = lastCpuSample;
  lastCpuSample = { usec, at };
  if (!prev) return null;                                               // 第一次只记基准
  const dtMs = at - prev.at;
  if (dtMs < 1000) return null;
  const cpuMs = usec - prev.usec;
  if (!Number.isFinite(cpuMs) || cpuMs < 0) return null;                // 容器重启过，重新记基准
  return Math.round((cpuMs / dtMs) * 10000) / 100;
}

async function buildStatus() {
  const now = Date.now();
  const mem = process.memoryUsage();
  const st = db.status();

  /* ---- 数据库 ---- */
  const dbInfo = { ready: st.ready, error: st.error || null, latencyMs: null, pool: null, tables: null };
  if (st.ready) {
    try {
      const [latencyMs, tables] = await Promise.all([db.ping(), db.tableCounts()]);
      dbInfo.latencyMs = latencyMs;
      dbInfo.tables = tables;
    } catch (e) {
      dbInfo.error = String((e && e.message) || e);
    }
    const p = db.pool;
    dbInfo.pool = {
      total: p.totalCount, idle: p.idleCount, waiting: p.waitingCount,
      max: (p.options && p.options.max) || Number(process.env.PG_POOL_MAX || 10),
    };
  }

  /* ---- RSS ---- */
  let feedStats = { total: 0, enabled: 0, cardEnabled: 0, error: 0, neverFetched: 0, perFeedInterval: 0 };
  let problems = [];
  let dueCount = 0;
  let nextRefreshAt = null;
  const entryInfo = { total: 0, unread: 0, favorite: 0, added24h: 0, oldest: null, newest: null };
  if (st.ready) {
    try {
      const feeds = (await db.allFeeds()).map(toFeedDto);
      feedStats = {
        total: feeds.length,
        enabled: feeds.filter((f) => f.enabled).length,
        cardEnabled: feeds.filter((f) => f.cardEnabled).length,
        error: feeds.filter((f) => f.status === 'error').length,
        neverFetched: feeds.filter((f) => !f.lastFetchedAt).length,
        // 有多少个频道用了自己的抓取频率（其余跟随全局）
        perFeedInterval: feeds.filter((f) => f.refreshMinutes != null).length,
      };
      problems = feeds.filter((f) => f.status === 'error').map((f) => ({
        feedId: f.id, title: f.title, error: f.error || '抓取失败',
        lastFetchedAt: f.lastFetchedAt, groupName: f.groupName,
      }));
      // 「下次抓取」= 已开启采集的频道里最早到期的那个；已经过了的时刻算「现在就该抓」
      let earliest = null;
      for (const f of feeds) {
        if (!f.enabled) continue;
        const at = f.nextRefreshAt ? new Date(f.nextRefreshAt).getTime() : now;
        if (at <= now) dueCount += 1;
        if (earliest === null || at < earliest) earliest = at;
      }
      nextRefreshAt = earliest === null ? null : new Date(Math.max(earliest, now)).toISOString();
      Object.assign(entryInfo, await db.entryWindow());
      const flags = await db.entryFlagCounts(null).catch(() => null);
      if (flags) { entryInfo.unread = flags.unread; entryInfo.favorite = flags.favorite; }
    } catch (_) { /* 上面的错误已记录在 dbInfo.error，这里不重复报 */ }
  }
  if (dbInfo.tables) entryInfo.total = dbInfo.tables.entries;

  /* ---- 日报 ---- */
  const dg = (settings && settings.digest) || {};
  const digestInfo = {
    enabled: !!dg.enabled, time: dg.time || '08:00', scope: dg.scope || 'selected',
    nextRunAt: null, count: 0, oldestDate: null, latest: null,
  };
  if (digestInfo.enabled) digestInfo.nextRunAt = new Date(now + msUntilNext(dg.time)).toISOString();
  if (st.ready) {
    try {
      const ds = await db.digestStatsAll();
      digestInfo.count = (dbInfo.tables && dbInfo.tables.digests) || ds.count;
      digestInfo.oldestDate = ds.oldestDate;
      const d = ds.latest;
      if (d) {
        digestInfo.latest = {
          date: d.date, generatedAt: d.generatedAt || null, model: d.model || '',
          fallback: !!d.fallback, error: d.error || null,
          usedMapReduce: !!d.usedMapReduce, stats: d.stats || null,
        };
      }
    } catch (_) { /* 静默：日报不是关键路径 */ }
  }

  // 容器指标拿不到（非 Docker 环境 / 权限不足）不该影响整页，所以单独兜一层
  let container = null;
  try {
    const cgMem = readCgroupMemory();
    const cgCpu = readCgroupCpu();
    if (cgMem || cgCpu !== null) {
      container = {
        memoryUsed: cgMem ? cgMem.used : null,
        memoryLimit: cgMem ? cgMem.limit : null,
        cpuPercent: cgCpu,
      };
    }
  } catch (_) { /* 忽略：下面其余指标照常返回 */ }

  return {
    app: {
      version: pkg.version, node: process.version, pid: process.pid,
      uptimeSec: Math.round(process.uptime()),
      startedAt: new Date(now - process.uptime() * 1000).toISOString(),
      timezone: 'Asia/Shanghai',
      now: new Date(now).toISOString(),
      today: shanghaiDateStr(new Date(now)),
      memory: { rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal, external: mem.external },
      container,
      loadavg: os.loadavg().map((n) => Math.round(n * 100) / 100),
      cpuCount: os.cpus().length,
    },
    db: dbInfo,
    rss: {
      refreshMinutes: settings ? settings.source.refreshMinutes : 30,
      keepPerFeed: settings ? settings.source.keepPerFeed : 300,
      keepDays: settings ? settings.source.keepDays : 0,
      autoRefreshMinutes: settings ? settings.source.autoRefreshMinutes : 0,
      concurrency: settings ? settings.source.concurrency : 3,
      timeoutSeconds: settings ? settings.source.timeoutSeconds : 25,
      proxyUrl: settings ? settings.source.proxyUrl : '',
      lastRefreshAt: lastRefresh.at || null,
      nextRefreshAt,
      dueCount,
      refreshing: refreshing.size,
      lastResult: lastRefresh.at ? {
        added: lastRefresh.added, pruned: lastRefresh.pruned,
        skipped: lastRefresh.skipped, failed: lastRefresh.failed,
        durationMs: lastRefresh.durationMs,
      } : null,
      feeds: feedStats,
      entries: entryInfo,
      problems,
    },
    digest: digestInfo,
  };
}

/* ============================================================
 * 启动
 * ============================================================ */
let digest = null;

/** 首次部署时用 SEED_FEEDS 播种几个 RSS 地址（逗号分隔），挂到首个管理员名下 */
async function seedFeeds() {
  const raw = String(process.env.SEED_FEEDS || '').trim();
  if (!raw) return;
  const admin = (await db.listUsers()).find((u) => u.role === 'admin');
  if (!admin) return;
  const existing = await db.listFeeds(admin.id);
  if (existing.length) return;
  for (const u of raw.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean)) {
    try {
      const url = rss.assertFeedUrl(u);
      const feed = await db.addFeed(admin.id, url);
      const r = await refreshFeed(feed);
      log(`[seed] 已添加 ${url} → ${r.error ? '失败：' + r.error : `新增 ${r.added} 条`}`);
    } catch (e) {
      logErr(`[seed] 跳过 ${u}：${(e && e.message) || e}`);
    }
  }
}

/**
 * 首次启动 / 老库升级：把 settings.auth 里原有的单账号迁成第一个管理员。
 * 已存在用户时什么都不做（幂等）。
 */
async function ensureAdmin() {
  if ((await db.countUsers()) > 0) return;
  const a = settings.auth || {};
  const username = String(a.username || 'admin').trim() || 'admin';
  const salt = a.salt || crypto.randomBytes(16).toString('hex');
  const passwordHash = a.passwordHash || hashPassword('admin', salt);
  await db.createUser({ username, salt, passwordHash, role: 'admin' });
  log(`[app] 已创建首个管理员账号：${username}（原单账号已迁移，密码不变）`);
}

db.onReady(async () => {
  await loadSettings();
  await ensureAdmin();
  await db.bootstrapOwnership();   // 把没有归属的老 feeds / digests 归给首个管理员
  await loadUsers();
  const names = [...usersById.values()].map((u) => `${u.username}(${u.role})`).join(', ');
  log(`[app] 设置已载入 | 用户: ${names || '（无）'} | 库: ${DATABASE_URL.replace(/:[^:@/]*@/, ':***@')}`);
  digest = createDigest({ db, getSettings: () => settings, log });
  scheduleDigest();
  scheduleRefresh();
  await seedFeeds().catch((e) => logErr('[seed] 失败：' + ((e && e.message) || e)));
  // 启动后稍等再抓一轮，避免和容器健康检查抢资源
  setTimeout(() => refreshAll().catch((e) => logErr('[rss] 首次抓取失败：' + ((e && e.message) || e))), 3000);
});

db.start();

server.listen(PORT, HOST, () => {
  log(`拾阅（shiyue）已启动: http://${HOST}:${PORT}`);
  log(`数据库: ${DATABASE_URL.replace(/:[^:@/]*@/, ':***@')}`);
});

/* 优雅退出 */
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    log(`收到 ${sig}，正在退出…`);
    server.close();
    if (digestTimer) clearTimeout(digestTimer);
    if (refreshTimer) clearInterval(refreshTimer);
    await db.close();
    process.exit(0);
  });
}

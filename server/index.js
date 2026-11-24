/**
 * HTTP + WebSocket 入口
 * ------------------------------------------------------------------
 *   GET  /            客户端（web/）
 *   WS   /ws          房间协议
 *
 * 协议（JSON）：
 *   C→S  {t:'create', name, seats:4|8, ante?, durationMin?}
 *        {t:'join', room, name, token?}
 *        {t:'start'}                       房主开局（≥2 人）
 *        {t:'act', action:'follow'|'raise'|'knock'|'pass'|'fold'}
 *        {t:'split', index}
 *        {t:'buyin', amount}               申请带入（房主审核）
 *        {t:'review', seat, approve}       房主同意/拒绝带入
 *        {t:'endTable'}                    房主提前结束本桌
 *        {t:'leave'}                       离开房间（让出座位）
 *        {t:'rooms'}                       大厅房间列表
 *        {t:'logs'}                        拉整局回顾（只含本手之前的历史手）
 *        {t:'showLogHand', handNo}         回顾页秀这一手底牌（10 钻，仅限历史手）
 *        {t:'peekLog', handNo, seat}       回顾里偷看某家底牌（2 钻，仅限历史手）
 *        {t:'ping'}
 *   S→C  {t:'created', roomId, seat, token}
 *        {t:'joined', seat, token, roomId, reconnected, queued}
 *        {t:'seated', seat, token, roomId} 排队的人补位成功
 *        {t:'left'}
 *        {t:'rooms', list}
 *        {t:'state', data: 快照}
 *        {t:'buyinAsk', amount, auto}
 *        {t:'error', msg, code}
 *        {t:'pong'}
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import https from 'node:https';
import crypto from 'node:crypto';
import { Room, STAKES, DURATIONS, findStake, EMOTE_IDS, FREE_EMOTE_IDS, actLogFlushSync } from './room.js';
import { PRICE, createCost, SIGNUP_DIAMONDS } from './price.js';
import { PHASE } from '../engine/game.js';
import { Accounts } from './accounts.js';
import { historicalHands, isHistoricalHand } from './logview.js';
import {
  clientIp, FixedWindow, ConnQuota, SecurityLog, sanitizeMsg, safeInterval,
} from './guard.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 5173);
// 数据目录：默认 data/，测试时可指到别处（DH_DATA=/tmp/dhdata）不污染线上房间表
const DATA_DIR = process.env.DH_DATA ? path.resolve(process.env.DH_DATA) : path.resolve(ROOT, 'data');
const STORE = path.join(DATA_DIR, 'rooms.json');
// 账号库：开发者账号名由 DH_OWNER 指定，默认 owner（注册这个账号名即成为开发者）
const accounts = new Accounts(DATA_DIR, { owner: process.env.DH_OWNER || 'owner' });
// 钻石价格统一在 server/price.js：开房 / 发发看 / 强制秀牌 / 搓牌 / 表情 / 改名
/** 结算期「强制秀牌」：全亮状态一直保持到收牌那一刻，不再中途变暗（v0.22.75）。
 *  玩家点按钮的时刻不定：收牌定时器整体后移「保底 1.2 秒」，revealUntil 直接顶到新的
 *  收牌时刻。于是从点击到收牌全程全亮，且无论多晚点击都至少亮 1.2 秒。 */
const SHOW_HOLD_MS = 1200;
/** v0.20.57 洗牌动画时长：客户端 CSS 动画、这里的收牌顺延共用同一个值，播完才发下一手 */
const WASH_FX_MS = 2800;

/* 开发者账号：启动即确保存在，data/ 被清空也能找回来。
   账号名可用 DH_OWNER 改；DH_PASS 只在「建号」或「显式重置」时生效，默认 owner / kuanzhai2026。
   v0.20.48：账号已经在库里时不再覆盖密码 —— 自己改过的密码重启后照样有效。
   真忘了密码：DH_RESET_OWNER_PASS=1 启动一次，密码会被重置成 DH_PASS（或默认值）。 */
const OWNER_ACCOUNT = process.env.DH_OWNER || 'owner';
const OWNER_PASS = process.env.DH_PASS || 'kuanzhai2026';
const RESET_OWNER_PASS = process.env.DH_RESET_OWNER_PASS === '1';
const ownerUser = accounts.ensureOwner(OWNER_ACCOUNT, OWNER_PASS, { resetPass: RESET_OWNER_PASS });
const canUseCheat = (u) => !!u && (u.role === 'owner' || u.canCheat);

/** 登录态落在连接上：顺手把「透视资格」也带过去，广播时不用再查库 */
function bindUser(ws, u, token = '') {
  ws.userId = u ? u.id : null;
  ws.authToken = u ? String(token || '') : '';   // v0.20.93：单点登录靠它区分「同一台设备 / 另一台」
  ws.cheat = !!u && canUseCheat(u);
  // v0.22.64：有透视资格的账号默认关闭，需本人手动开启（连点「窄」6 下）
  ws.cheatOff = true;
  ws.avatar = (u && u.avatar) || '';   // 座位头像跟着账号走，房间广播时直接取
  // 已经坐在桌上的人重新登录：立刻按新身份重发一次视图
  if (ws.room && typeof ws.room.broadcast === 'function') ws.room.broadcast();
  return u;
}

/**
 * v0.20.93 单点登录：同一账号只允许一处在线。
 * 新设备登录成功后，把该账号的其它连接收掉 —— 先发 kicked 说明原因再断开，
 * 让旧设备是「明确被告知已被顶下线」，而不是莫名其妙掉线。
 * 同 token 的连接不踢：同一台设备开多个标签共用一份 token，不该互踢。
 */
function kickOtherSessions(u, token, exceptWs) {
  if (!u) return 0;
  const uid = String(u.id);
  let n = 0;
  for (const c of wss.clients) {
    if (c === exceptWs || !c.userId) continue;
    if (String(c.userId) !== uid) continue;
    if (c.authToken && token && c.authToken === String(token)) continue;
    send(c, { t: 'kicked', msg: '该账号已在另一台设备登录，本机已退出' });
    c.userId = null;
    c.authToken = '';
    // 留一点时间把消息送出去再关，别让它连原因都收不到
    setTimeout(() => { try { c.close(4402, 'another device'); } catch { /* 已经断了 */ } }, 80);
    n++;
  }
  return n;
}

/* ── 防护参数 ────────────────────────────────
 * 全部可用环境变量调，线上按默认值走：
 *   DH_MAX_CONN      全局并发连接上限（默认 600）
 *   DH_MAX_CONN_IP   单 IP 并发连接上限（默认 40）
 *   DH_HTTP_RPM      单 IP 每分钟 HTTP 请求上限（默认 1200）
 *   DH_ROOM_PER_10M  单 IP 每 10 分钟建房上限（默认 30）
 *
 * 网关：本机 Caddy 反代（kuanzhai36.it.com / 43.129.229.47.nip.io），
 * 已用 header_up 透传真实客户端 IP（X-Real-IP），单 IP 限流可以放心用。
 * 真正兜底的是下面几个全局阈值（连接总数、新建连接速率、全局消息速率、全局 HTTP 速率）。
 */
const MAX_CONN = Number(process.env.DH_MAX_CONN || 600);
const MAX_CONN_IP = Number(process.env.DH_MAX_CONN_IP || 40);
const HTTP_RPM = Number(process.env.DH_HTTP_RPM || 1200);
const ROOM_PER_10M = Number(process.env.DH_ROOM_PER_10M || 30);

const securityLog = new SecurityLog(path.join(DATA_DIR, 'security.log'));
const httpLimit = new FixedWindow({ windowMs: 60 * 1000, max: HTTP_RPM });
const createLimit = new FixedWindow({ windowMs: 10 * 60 * 1000, max: ROOM_PER_10M });
const globalCreateLimit = new FixedWindow({ windowMs: 60 * 1000, max: 40, maxKeys: 8 });
// 全服消息熔断：所有连接加起来每秒最多处理 2000 条，超出就丢。
// 正常几十桌远达不到；被脚本刷时这层保证 CPU 不被吃满。
const globalMsgLimit = new FixedWindow({ windowMs: 1000, max: 2000, maxKeys: 4 });
// 全服 HTTP 速率与新建连接速率：IP 维度不可靠时，这两条是真正的堤坝
const globalHttpLimit = new FixedWindow({ windowMs: 60 * 1000, max: 6000, maxKeys: 4 });
const connRateLimit = new FixedWindow({ windowMs: 1000, max: 40, maxKeys: 4 });
const connQuota = new ConnQuota({ perIp: MAX_CONN_IP, total: MAX_CONN });
const counters = { httpBlocked: 0, wsRejected: 0, msgDropped: 0, badMsg: 0, createBlocked: 0 };

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
};

/* ── 分享码透传 ─────────────────────────────
 * 分享网关会校验每个请求是否带 ?sharecode=，不带直接回 403「链接不完整」。
 * 页面里的 style.css / app.js 是相对路径，浏览器请求它们时会把 query 丢掉，
 * 于是 HTML 能打开、样式和脚本却全 403，表现就是白屏打不开。
 * 这里把同一个分享码补到资源地址上，页面才真正能加载。
 */
function sharecodeOf(url) {
  try {
    return new URL(url || '/', 'http://localhost').searchParams.get('sharecode') || '';
  } catch {
    return '';
  }
}

function injectSharecode(html, sc) {
  const q = '?sharecode=' + encodeURIComponent(sc);
  // 只补本地相对资源，已经是绝对地址或自带参数的保持不动
  return html.replace(/(href|src)="([^"?:#]+\.(?:css|js))"/g, (m, attr, p) => `${attr}="${p}${q}"`);
}

/* ── 静态资源 ─────────────────────────────── */
/* ── TLS 可插拔：设了 DH_SSL_KEY + DH_SSL_CRT 就起 https+wss，否则回落 http ── */
const SSL_KEY = process.env.DH_SSL_KEY || '';
const SSL_CRT = process.env.DH_SSL_CRT || '';
const ALLOW_REFERER = (process.env.DH_ALLOW_REFERER || '').split(',').map((s) => s.trim()).filter(Boolean);
function refererAllowed(req) {
  const r = String(req.headers.referer || req.headers.referrer || '').trim();
  if (!r) return true; // 直接输入 / 隐私模式放行
  try {
    const u = new URL(r);
    const host = String(req.headers.host || '').split(':')[0];
    if (u.host === req.headers.host) return true;
    if (u.host.split(':')[0] === host) return true;
    if (ALLOW_REFERER.includes(u.host)) return true;
    /* v0.20.89：App 壳用 Capacitor 本地加载，页面 origin 是 https://localhost，
       里面 <img src="https://正式域名/avatar/..."> 天然会带这个 Referer。
       不认它的话上传成功的头像在 App 里全是 403，看着像「上传了但不显示」。 */
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return true;
    return false;
  } catch { return true; } // 畸形 referer 不当作攻击
}

/* ── 热更新清单（updates/manifest.json）────────
 * 每次发版由 tools/make-update.mjs 覆写。按 mtime + 5 秒节流缓存，
 * 免得每个 App 启动都读一次盘；发版后最多 5 秒生效。 */
let mfCache = { at: 0, mtime: 0, data: null };
function readUpdateManifest() {
  const f = path.join(ROOT, 'updates', 'manifest.json');
  try {
    const st = fs.statSync(f);
    if (mfCache.data && mfCache.mtime === st.mtimeMs && Date.now() - mfCache.at < 5000) return mfCache.data;
    const data = JSON.parse(fs.readFileSync(f, 'utf8'));
    mfCache = { at: Date.now(), mtime: st.mtimeMs, data };
    return data;
  } catch {
    // 清单被删 / 坏了：立刻停止推送（不能继续吐缓存里的旧版本，否则「撤包」撤不掉）
    mfCache = { at: Date.now(), mtime: 0, data: null };
    return null;
  }
}

/* ── 对外入口清单（data/entries.json）────────
 * 下发当前可用的网页 / 下载 / WebSocket 地址列表，供中转下载页与前端域名池使用。
 * 运维只需改这个 json（加 GitHub 备用源、换主域名），不用动代码、不用重启。
 * 缺省兜底写在这里：即使 json 缺失或损坏，也有两条自建线路可用。 */
const DEFAULT_ENTRIES = {
  web: [
    { url: 'https://kuanzhai36.it.com/', label: '主线路' },
    { url: 'https://43.129.229.47.nip.io/', label: '备用线路' },
  ],
  apk: [
    { url: 'https://kuanzhai36.it.com/kuanzhai.apk', label: '主线路下载' },
    { url: 'https://43.129.229.47.nip.io/kuanzhai.apk', label: '备用线路下载' },
  ],
  ws: 'wss://kuanzhai36.it.com',
};
let entriesCache = { at: 0, mtime: 0, data: null };
function readEntries() {
  const f = path.join(DATA_DIR, 'entries.json');
  try {
    const st = fs.statSync(f);
    if (entriesCache.data && entriesCache.mtime === st.mtimeMs && Date.now() - entriesCache.at < 5000) return entriesCache.data;
    const d = JSON.parse(fs.readFileSync(f, 'utf8'));
    const out = {
      web: Array.isArray(d.web) && d.web.length ? d.web : DEFAULT_ENTRIES.web,
      apk: Array.isArray(d.apk) && d.apk.length ? d.apk : DEFAULT_ENTRIES.apk,
      ws: typeof d.ws === 'string' && d.ws ? d.ws : DEFAULT_ENTRIES.ws,
    };
    entriesCache = { at: Date.now(), mtime: st.mtimeMs, data: out };
    return out;
  } catch {
    entriesCache = { at: Date.now(), mtime: 0, data: DEFAULT_ENTRIES };
    return DEFAULT_ENTRIES;
  }
}

function requestHandler(req, res) {
  const ip = clientIp(req);
  const method = req.method || 'GET';
  const nonce = crypto.randomBytes(16).toString('base64');

  // 基础安全头：禁嗅探、禁被当脚本引用时的跨站执行、禁 referer 外泄
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'SAMEORIGIN');
  res.setHeader('referrer-policy', 'no-referrer');
  // v0.20.76：显式声明本页要用到麦克风（对讲机）。顶层文档默认只放行 self，
  // 这里放宽到 *，让被同源/授权容器嵌入时也不至于被 Permissions Policy 静默掐掉；
  // 真正能否弹出系统授权仍取决于宿主浏览器 / App 与 iframe 的 allow="microphone"。
  res.setHeader('permissions-policy', 'microphone=*, camera=()');
  // v0.20.78：CSP。内联脚本用每请求随机 nonce，外链脚本/样式走 'self'
  res.setHeader('content-security-policy',
    `default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; ` +
    // v0.22.43：去掉 ws: 明文许可，页面只允许 wss（页面本身是 https，配对升级）
    `connect-src 'self' wss:; style-src 'self' 'unsafe-inline'; ` +
    `script-src 'self' 'nonce-${nonce}'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'`);

  // 本项目只有 GET/HEAD，其余方法一律拒绝（也挡掉扫描器的 POST 探测）
  // 例外：/client-crash 允许 POST（App 崩溃堆栈上报）
  const crashPost = String(req.url || '').split('?')[0] === '/client-crash' && method === 'POST';
  if (!crashPost && method !== 'GET' && method !== 'HEAD') {
    securityLog.write('http.method', { ip, method, path: String(req.url || '').slice(0, 80) });
    res.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' });
    res.end('Method Not Allowed');
    return;
  }

  // 防盗链：挡掉第三方站点热链本服静态资源（直接输入 / 同源 / 白名单放行）
  if (!refererAllowed(req)) {
    securityLog.write('http.hotlink', { ip, referer: String(req.headers.referer || '').slice(0, 120) });
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end('Forbidden');
    return;
  }

  // 单 IP 每分钟请求上限：正常开一局约 15 个静态资源，1200 次足够宽
  const gate = httpLimit.hit(ip);
  if (!gate.ok) {
    counters.httpBlocked++;
    securityLog.write('http.ratelimit', { ip, path: String(req.url || '').slice(0, 80), retryAfter: gate.retryAfter });
    res.writeHead(429, { 'retry-after': String(gate.retryAfter), 'content-type': 'text/plain; charset=utf-8' });
    res.end('请求太频繁，请稍后再试');
    return;
  }
  // 全服总闸：被大流量打时先保进程，宁可短暂 503 也不雪崩
  if (!globalHttpLimit.hit('all').ok) {
    counters.httpBlocked++;
    securityLog.write('http.globalLimit', { ip, path: String(req.url || '').slice(0, 80) });
    res.writeHead(503, { 'retry-after': '5', 'content-type': 'text/plain; charset=utf-8' });
    res.end('访问人数太多，请稍后再试');
    return;
  }

  let rawUrl;
  try {
    rawUrl = decodeURIComponent((req.url || '/').split('?')[0]);
  } catch {
    // 畸形 %xx 编码会让 decodeURIComponent 抛错，这里必须兜住
    securityLog.write('http.badurl', { ip, path: String(req.url || '').slice(0, 80) });
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Bad Request');
    return;
  }

  // 安装包下载：对外统一显示「宽窄.apk」，同时兼容旧的 /dingerhuang.apk 链接
  if (rawUrl === '/kuanzhai.apk' || rawUrl === '/宽窄.apk' || rawUrl === '/dingerhuang.apk' || rawUrl === '/dingerhuang-android-debug.apk') {
    const apk = path.join(ROOT, 'dingerhuang.apk');
    let st = null;
    try { st = fs.statSync(apk); } catch { /* 缺文件时走 404 */ }
    if (!st || !st.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404');
      return;
    }
    res.writeHead(200, {
      'content-type': 'application/vnd.android.package-archive',
      'content-length': st.size,
      // filename 给不认 filename* 的老浏览器兜底；filename* 让新浏览器显示中文「宽窄.apk」
      'content-disposition': `attachment; filename="kuanzhai.apk"; filename*=UTF-8''%E5%AE%BD%E7%AA%84.apk`,
      'cache-control': 'no-store',
    });
    fs.createReadStream(apk).pipe(res);
    return;
  }

  // 玩家头像：只允许 /avatar/<数字>.<jpg|png|webp>
  if (rawUrl.startsWith('/avatar/')) {
    const m = /^\/avatar\/(\d{1,12}\.(?:jpg|png|webp))$/.exec(rawUrl);
    if (!m) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('Not Found'); return; }
    const file = path.join(DATA_DIR, 'avatars', m[1]);
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('Not Found'); return; }
      const type = m[1].endsWith('.png') ? 'image/png' : m[1].endsWith('.webp') ? 'image/webp' : 'image/jpeg';
      res.writeHead(200, { 'content-type': type, 'cache-control': 'public, max-age=604800' });
      res.end(buf);
    });
    return;
  }

  // 大厅用的轻量接口：现在有哪些房间
  if (rawUrl === '/health') {
    const h = req.headers || {};
    const xff = String(h['x-forwarded-for'] || '');
    // v0.21.1：附上最近一次对账结果（只给状态与条数，明细留在服务器上）
    let reconcile = null;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'backups', 'reconcile.json'), 'utf8'));
      reconcile = {
        ts: j.ts,
        status: j.status,
        errors: Array.isArray(j.errors) ? j.errors.length : 0,
        warns: Array.isArray(j.warns) ? j.warns.length : 0,
      };
    } catch { /* 还没跑过对账 */ }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' });
    res.end(JSON.stringify({
      ok: true,
      rooms: rooms.size,
      uptime: Math.round(process.uptime()),
      conn: connQuota.count,
      mem: Math.round(process.memoryUsage().rss / 1048576),
      blocked: counters,
      // v0.21.1：新号赠送名额（公开只读，供运营和页面提示用）
      signup: accounts.signupInfo(),
      reconcile,
      // 诊断用：网关是否透传真实 IP（只给跳数和键名，不含值）
      net: {
        xffHops: xff ? xff.split(',').length : 0,
        realIp: !!h['x-real-ip'],
        sock: String((req.socket && req.socket.remoteAddress) || '').slice(0, 40),
        hdr: Object.keys(h).join(','),
      },
    }));
    return;
  }

  if (rawUrl === '/api/rooms') {
    const list = [...rooms.values()]
      .filter((r) => r.humans().length > 0 || r.started)
      .map((r) => ({
        id: r.id,
        humans: r.humans().length,
        online: r.humansOnline(),
        seatCount: r.seatCount,
        started: r.started,
        ended: r.ended,
        stake: r.stakeLabel,
        minBuyIn: r.minBuyIn,
        durationMin: r.durationMin,
        owner: r.ownerName(),
      }))
      .sort((a, b) => b.online - a.online || b.humans - a.humans);
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' });
    res.end(JSON.stringify({ rooms: list.slice(0, 20) }));
    return;
  }

  /* ── 客户端崩溃上报（排障用）──────────────────
   * POST /client-crash，body 为纯文本堆栈。落盘 data/crash-<日期>.log，
   * 单条限 128KB，同一天多条追加。不需要鉴权（崩溃发生时可能还没登录）。 */
  if (rawUrl === '/client-crash' && method === 'POST') {
    const chunks = [];
    let n = 0;
    req.on('data', (c) => { n += c.length; if (n <= 131072) chunks.push(c); else req.destroy(); });
    req.on('end', () => {
      try {
        const txt = Buffer.concat(chunks).toString('utf8').slice(0, 131072);
        const day = new Date().toISOString().slice(0, 10);
        const ip = (req.socket && req.socket.remoteAddress) || '?';
        fs.appendFileSync(path.join(DATA_DIR, `crash-${day}.log`),
          `\n===== ${new Date().toISOString()} ip=${ip} =====\n${txt}\n`);
        console.log(new Date().toISOString(), '[client-crash]', ip, txt.split('\n')[0].slice(0, 120));
      } catch (e) { console.error('[client-crash] write fail', e.message); }
      res.writeHead(204, { 'access-control-allow-origin': '*' });
      res.end();
    });
    req.on('error', () => { try { res.end(); } catch { /* 忽略 */ } });
    return;
  }

  /* ── 热更新：查询最新前端包 ────────────────────
   * 只有装了 Capacitor Updater 的 App 会来问（网页端不调用）。
   * 返回 null 表示「维持现状」，客户端据此不做任何事——服务器没发版时它也不该动。
   * manifest 由 tools/make-update.mjs 生成，按 mtime 缓存 5 秒，发版后立刻能看到。 */
  if (rawUrl === '/api/app/version') {
    let q = {};
    try { q = Object.fromEntries(new URL(req.url || '/', 'http://x').searchParams); } catch { /* 畸形 query 当空 */ }
    const plat = String(q.p || q.platform || 'android').toLowerCase() === 'ios' ? 'ios' : 'android';
    const cur = String(q.cur || '').slice(0, 24);
    const native = Number(q.n || 0) || 0;
    const xdiag = String(q.x || '').slice(0, 200);   // 客户端热更失败原因上报（update.js beacon）

    let latest = null;
    let why = '';
    const mf = readUpdateManifest();
    const item = mf && mf[plat];
    if (!item || !item.version || !item.file) {
      why = 'no-release';
    } else if (item.minNative && native && native < item.minNative) {
      // 原生层太旧（插件本身升级）：热更换不了原生代码，只能重装安装包
      why = 'need-new-apk';
    } else if (cur && item.version === cur) {
      why = 'up-to-date';
    } else {
      // 协议判定：优先网关透传的 x-forwarded-proto，其次看本进程是否 HTTPS。
      // 都不是（本地直连）时按 host 猜：真域名给 https——宁可给 https 也不能让客户端拿到
      // http 的包地址，App 端只认 https，否则热更会一直静默失败。
      const fwd = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
      const host = String(req.headers.host || '').slice(0, 120);
      const local = /^(localhost|127\.|\[::1\])/i.test(host.split(':')[0]);
      const proto = fwd || (SSL_KEY ? 'https' : (local ? 'http' : 'https'));
      latest = {
        version: String(item.version),
        url: `${proto}://${host}/updates/${item.file}`,
        sha256: String(item.sha256 || ''),
        size: Number(item.size) || 0,
        notes: String(item.notes || '').slice(0, 300),
        minNative: Number(item.minNative) || 0,
      };
      why = 'has-update';
    }

    // v0.22.26 诊断：热更检查留痕（谁在问、当前版本、判定结果）
    console.log(new Date().toISOString(), '[upver]',
      (req.socket && req.socket.remoteAddress) || '?',
      plat, 'cur=' + cur, 'n=' + native, '->', why,
      xdiag ? 'ERR:' + xdiag : '');
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-cache',
      // App 内 origin 是 https://localhost，来这里取版本属于跨域只读请求，必须放行
      'access-control-allow-origin': '*',
    });
    res.end(JSON.stringify({ ok: true, platform: plat, cur, why, latest }));
    return;
  }

  /* 对外入口清单：中转下载页 / 前端域名池从这里取可用的网页与下载地址。
   * 公开只读，和版本接口一样放行跨域（App 内 origin 为 localhost）。 */
  if (rawUrl === '/api/entries') {
    const e = readEntries();
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-cache',
      'access-control-allow-origin': '*',
    });
    res.end(JSON.stringify({ ok: true, ...e, updatedAt: new Date().toISOString() }));
    return;
  }

  /* ── 热更新：更新包文件 ────────────────────────
   * 只放行 /updates/<小写文件名>.zip，不对外暴露目录列表；带 content-length 便于客户端显示进度。
   * 这些包是整站前端代码，必须能被原生下载器直接拿到，所以不加 referer 校验。 */
  if (rawUrl.startsWith('/updates/')) {
    const m = /^\/updates\/([a-z0-9][a-z0-9._-]{0,60}\.zip)$/.exec(rawUrl);
    const file = m ? path.join(ROOT, 'updates', m[1]) : '';
    let st = null;
    try { st = file ? fs.statSync(file) : null; } catch { /* 不存在走 404 */ }
    if (!st || !st.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404');
      return;
    }
    const _updlFile = m && m[1];
    // v0.22.27：支持 Range 断点续传。新版插件下载大包时用 partial+Range 续传，
    // 服务器若忽略 Range 永远回全量 200，插件的续传校验就永远对不上 → 反复重下装不上。
    const baseHeaders = {
      'content-type': 'application/zip',
      'accept-ranges': 'bytes',
      'cache-control': 'public, max-age=86400',
      'access-control-allow-origin': '*',
    };
    const rm = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range || ''));
    if (rm) {
      const start = parseInt(rm[1], 10);
      const end = rm[2] ? Math.min(parseInt(rm[2], 10), st.size - 1) : st.size - 1;
      if (Number.isFinite(start) && start <= end && start < st.size) {
        console.log(new Date().toISOString(), '[updl-begin]', _updlFile,
          'range=' + start + '-' + end);
        res.writeHead(206, Object.assign(baseHeaders, {
          'content-length': end - start + 1,
          'content-range': `bytes ${start}-${end}/${st.size}`,
        }));
        res.on('close', () => {
          console.log(new Date().toISOString(), '[updl-end]', _updlFile,
            res.writableEnded ? 'complete' : 'ABORTED',
            'bytes=' + ((res.socket && res.socket.bytesWritten) || 0));
        });
        fs.createReadStream(file, { start, end }).pipe(res);
        return;
      }
    }
    console.log(new Date().toISOString(), '[updl-begin]', _updlFile, 'full');
    res.writeHead(200, Object.assign(baseHeaders, { 'content-length': st.size }));
    res.on('close', () => {
      console.log(new Date().toISOString(), '[updl-end]', _updlFile,
        res.writableEnded ? 'complete' : 'ABORTED',
        'bytes=' + ((res.socket && res.socket.bytesWritten) || 0));
    });
    fs.createReadStream(file).pipe(res);
    return;
  }

  let urlPath = rawUrl;
  // 入口别名：/enter、/play 和根路径一样给首页，方便留备用地址
  if (urlPath === '/' || urlPath === '' || urlPath === '/enter' || urlPath === '/play') {
    urlPath = '/web/index.html';
  }

  /* v0.22.7 安全修复：静态文件一律只从 web/ 目录取。
   * 旧逻辑会先尝试 ROOT/<path>，导致 /data/accounts.json、/server/index.js、
   * /backups/* 等项目内任意文件都能被公网直接下载。现在把 /web/xxx 归一化成
   * web/xxx，统一在 WEB_DIR 下解析；任何跳出 web/ 的路径一律 403。 */
  const WEB_DIR = path.join(ROOT, 'web');
  const ENGINE_DIR = path.join(ROOT, 'engine');
  const ENGINE_PUB = path.join(ROOT, 'dist', 'engine');   // 网页版对外：混淆副本
  // 浏览器端 app.js 以 ES 模块方式 import '../engine/*.js'（纯游戏逻辑，无秘钥），
  // 浏览器会请求 /engine/game.js 等。这些文件与 App 安装包内打包的 engine 同源，可安全对外提供。
  // 显式白名单只放行 /engine/ 下的 .js，并严格限制在 ENGINE_DIR 内，
  // 绝不放开 data/ server/ backups/ 等敏感目录（防泄露修复仍然有效）。
  let full = null;
  if (urlPath.startsWith('/engine/')) {
    const e = urlPath.slice('/engine'.length);            // 例如 '/game.js'
    // 网页版优先返回 dist/engine 的混淆副本；服务端自身仍 import ENGINE_DIR 的明文。
    const base = fs.existsSync(path.join(ENGINE_PUB, e.replace(/^\/+/, ''))) ? ENGINE_PUB : ENGINE_DIR;
    const efull = path.resolve(base, '.' + e);
    if (efull.startsWith(base + path.sep) && /\.js$/i.test(efull)) {
      full = efull;
    }
  } else {
    const rel = urlPath.replace(/^\/web\//, '/');
    full = path.resolve(WEB_DIR, '.' + rel);
  }
  // 只允许访问白名单根目录（web/ 或 engine/），任何跳出都 403
  const roots = [WEB_DIR + path.sep, ENGINE_DIR + path.sep, ENGINE_PUB + path.sep];
  if (!full || (full !== WEB_DIR && full !== ENGINE_DIR && !roots.some(r => full.startsWith(r)))) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  /* 纵深防御：以后万一有人误把敏感文件放进 web/ 或 engine/，也不对外发。
     web/ 里现存的 .json（version.json / props.json 等）不受影响。 */
  if (/\.(?:env|key|pem|crt|log|bak|sh|apk|zip|gz|tar|yml|yaml|sql|db)$/i.test(full)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  let target = null;
  try {
    if (fs.statSync(full).isFile()) target = full;
  } catch { /* 不存在走 404 */ }

  if (!target) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404');
    return;
  }

  const ext = path.extname(target).toLowerCase();

  // HTML 出口：把分享码补到 css/js 引用上（详见 injectSharecode 注释）
  if (ext === '.html') {
    let html = fs.readFileSync(target, 'utf8');
    const sc = sharecodeOf(req.url);
    if (sc) html = injectSharecode(html, sc);
    // v0.20.78：给内联 <script> 注入本次请求的 CSP nonce（外链脚本不含 nonce，靠 'self' 放行）
    html = html.replace(/<script(\s+[^>]*)?>/gi, (m, attrs) => {
      if (/\bsrc\s*=/.test(attrs || '') || /\bnonce\s*=/.test(attrs || '')) return m;
      return `<script nonce="${nonce}"${attrs || ''}>`;
    });
    res.writeHead(200, {
      'content-type': MIME[ext] || 'text/html; charset=utf-8',
      'cache-control': 'no-cache',
    });
    res.end(html);
    return;
  }

  res.writeHead(200, {
    'content-type': MIME[ext] || 'application/octet-stream',
    'cache-control': 'no-cache',
  });
  fs.createReadStream(target).pipe(res);
}

/* ── 创建 HTTP/HTTPS 服务（TLS 可插拔） ───────── */
const server = (SSL_KEY && SSL_CRT)
  ? https.createServer({ key: fs.readFileSync(SSL_KEY), cert: fs.readFileSync(SSL_CRT) }, requestHandler)
  : http.createServer(requestHandler);

/* ── 房间注册表 ───────────────────────────── */
const rooms = new Map();

/* ── v0.22.38：全局带入申请（房主能看到自己名下所有房间待审的申请） ──
 * 房主可能不在房间里面，申请一挂起就主动推给他；他也可以随时主动拉一次。
 * 列表每行：房号 + 昵称 + 账号 ID + 带入金额，审批直接跨房进行。 */
function ownerReqList(uid) {
  const id = String(uid);
  const list = [];
  const counts = {};
  for (const r of rooms.values()) {
    if (r.ended || String(r.ownerUid) !== id) continue;
    for (const q of r.requests || []) {
      list.push({ roomId: r.id, seat: q.seat, name: q.name, uid: q.uid || '', amount: q.amount, at: q.at });
    }
    if ((r.requests || []).length) counts[r.id] = r.requests.length;
  }
  list.sort((a, b) => (a.at || 0) - (b.at || 0));
  return { list, total: list.length, counts };
}
/** 房间有新申请挂起时，把房主叫一声（无论他在不在房间里） */
function notifyOwnerBuyReq(room) {
  if (!room.ownerUid) return;
  const data = ownerReqList(room.ownerUid);
  sendToUser(room.ownerUid, { t: 'buyReq', roomId: room.id, count: (room.requests || []).length, ...data });
}

/* ── 开发者账号 ─────────────────────────────
 * 没有账号体系，就用一条口令当「开发者账号」：
 * 服务端用环境变量 DH_ADMIN_KEY 指定，没设就用下面这个默认值。
 * 登录成功后这条连接带上 admin 标记，才有权看上帝视角、开关机器人。
 */
const ADMIN_KEY = String(process.env.DH_ADMIN_KEY || 'chuanxuan-admin').trim();

/** 管理员面板用的牌局列表：全部桌子，不截断 */
function adminRoomList() {
  return [...rooms.values()]
    .map((r) => ({
      id: r.id,
      owner: r.ownerName(),
      stake: r.stakeLabel,
      seatCount: r.seatCount,
      humans: r.humans().length,
      online: r.humansOnline(),
      watchers: r.watchers.length,
      gods: r.gods.length,
      started: !!r.started,
      ended: !!r.ended,
      phase: r.game ? r.game.phase : 'WAITING',
      handNo: r.game ? r.game.handNo : 0,
      pot: r.game ? r.game.pot : 0,
      bots: !!r.botsEnabled,
      botsSeated: r.slots.filter((x) => !x.token && x.name).length,
      durationMin: r.durationMin,
      remainMs: typeof r.remainMs === 'function' ? r.remainMs() : 0,
    }))
    .sort((a, b) => (b.started - a.started) || (b.online - a.online) || b.humans - a.humans);
}

/** 4 位随机房号（1000~9999）；重复就重摇 */
function newRoomId() {
  for (let i = 0; i < 500; i++) {
    const id = String(Math.floor(1000 + Math.random() * 9000));
    if (!rooms.has(id)) return id;
  }
  throw new Error('房间太多了，请稍后再开');
}

/* 落盘：服务重启后房间还在，进行中的牌局重置为等待室 */
let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; saveNow(); }, 800);
}
/* v0.22.99：整房存档改异步写（后台 tmp+rename 原子替换）。实测满负荷约 100KB
 * 同步写一次要堵全服 ~278ms——60 秒一拍的定时存档 + 每次带入/审核触发的防抖存档
 * 都会撞上这段，正是昨晚 PERF p90/p99 尾巴的大头。异步化后主线程零等待。
 * 停机（SIGTERM/fatal）仍走下面的 saveNowSync()，保证退出前账一定落盘。 */
let saveBusy = false;
let saveAgain = false;
function saveNow() {
  if (saveBusy) { saveAgain = true; return; }
  saveBusy = true;
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch { /* 目录已存在 */ }
  const list = [...rooms.values()].map((r) => r.toJSON());
  const tmp = STORE + '.tmp';
  fs.writeFile(tmp, JSON.stringify(list), (e) => {
    if (e) {
      saveBusy = false;
      console.error('[store]', e.message);
      if (saveAgain) { saveAgain = false; saveNow(); }
      return;
    }
    fs.rename(tmp, STORE, (e2) => {
      saveBusy = false;
      if (e2) console.error('[store]', e2.message);
      if (saveAgain) { saveAgain = false; saveNow(); }
    });
  });
}
/* 同步版：只给停机路径用（SIGTERM / 致命异常退出前），跑完才算账落袋 */
function saveNowSync() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const list = [...rooms.values()].map((r) => r.toJSON());
    const tmp = STORE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(list));
    fs.renameSync(tmp, STORE);
  } catch (e) {
    console.error('[store]', e.message);
  }
}
/** 注册一张桌子：整场结束自动关房时，把它从房间表里摘掉 */
function registerRoom(room) {
  room.onClose = (r) => {
    rooms.delete(r.id);
    scheduleSave();
  };
  // v0.22.64：座位头像的权威来源是账号档案，ws.avatar 只是登录时的连接快照。
  // 断线重连 / token 恢复时新连接没有头像，靠这里按 uid 回查，
  // 避免别的玩家一直看到系统默认脸。
  room.avatarOf = (uid) => {
    const u = uid && accounts.get(uid);
    return (u && u.avatar) || '';
  };
  rooms.set(room.id, room);
  return room;
}

function loadRooms() {
  try {
    if (!fs.existsSync(STORE)) return 0;
    const list = JSON.parse(fs.readFileSync(STORE, 'utf8'));
    let n = 0;
    for (const data of Array.isArray(list) ? list : []) {
      try {
        const room = Room.fromJSON(data);
        registerRoom(room);
        // v0.22.97：恢复的房间也要有每秒 ticker——fromJSON 不建定时器，服务重启后
        // 恢复房间的弹座/断线清座/关房全部停摆，00:00 的灰头像永远挂在桌上。
        room.startTicker();
        n++;
      } catch { /* 单条坏数据跳过 */ }
    }
    return n;
  } catch (e) {
    console.error('[store]', e.message);
    return 0;
  }
}

/* ── WebSocket ────────────────────────────── */
const wss = new WebSocketServer({
  server,
  path: '/ws',
  // 单帧上限 600KB：正常对局消息不到 1KB，只有上传头像（320×320 JPEG 的 base64）
  // 会到几十 KB。早先卡在 16KB，头像一上传就被 1009 断连，表现就是「选了图不生效」。
  // 上限仍由 sanitizeMsg 的 400KB 图片长度兜底，不会一条消息吃光内存。
  maxPayload: 600 * 1024,
  // v0.22.99：开启压缩。实测牌桌状态帧约 7.5KB 明文，deflate 后约 1KB（-86%），
  // 弱网/跨境链路上每步操作少传 6KB+，是昨晚 PERF net p99 约 2 秒的主要短板之一。
  // 门槛 1KB：小于 1KB 的帧（心跳/短消息）不压，避免恶意小帧放大 CPU。
  perMessageDeflate: {
    threshold: 1024,
    concurrencyLimit: 10,
    zlibDeflateOptions: { level: 6, chunkSize: 4096, memLevel: 7 },
  },
});

function sendToUser(userId, obj) {
  if (!userId) return;
  for (const c of wss.clients) {
    if (c.userId === String(userId) && c.readyState === 1) send(c, obj);
  }
}

function send(ws, obj) {
  try {
    if (ws.readyState === 1) ws.send(JSON.stringify(obj));
  } catch { /* 忽略 */ }
}

/* ── v0.20.53：对讲机（按住说话 / 松手即停） ──────────────
 * 音频不走 JSON：客户端把 16kHz 单声道的 PCM int16 装进二进制帧直接发，
 * 服务端只做「同房间转发」，不解码、不落盘。文本帧仍限 30 条/秒，
 * 语音帧在这条独立通道里自己限流，两者互不挤占额度。
 *
 * 二进制帧格式（小端）：[0]=0xD1 magic / [1]=seat（服务端覆盖）/ [2..]=PCM */
const VOICE_MAGIC = 0xD1;
const VOICE_MAX_FRAME = 8 * 1024;   // 单帧上限：8KB ≈ 0.25 秒音频
const VOICE_MAX_FPS = 20;           // 单连接每秒最多 20 帧
const VOICE_MAX_BACKLOG = 256 * 1024; // 对端积压超过这个值就丢帧，别拖垮服务
// 前端严格 10 秒；服务端留 0.5 秒余量，正常流程由前端到点发 voice off
// 后就把这个定时器清掉，只有前端计时器被后台节流 / 被改时才由它兜底断开。
const VOICE_MAX_MS = 10500;         // v0.20.54：服务端硬上限（10 秒 + 0.5 秒余量）

function relayVoice(ws, raw, ip) {
  if (!raw || raw.length < 3 || raw[0] !== VOICE_MAGIC || raw.length > VOICE_MAX_FRAME) {
    counters.badMsg++;
    return;
  }
  // 必须已进房、已坐下、且确实按着话筒；否则一律丢弃（不解码、不回话）
  if (!ws.room || ws.seat < 0 || !ws.voiceOn) return;

  const now = Date.now();
  // v0.20.54：第二道硬闸——单次对讲超过 10 秒，即使客户端没发 off 也不再转发。
  // 定时器万一被事件循环延迟，这里也能兜住；顺手通知客户端强制断开。
  if (!ws.voiceUntil || now > ws.voiceUntil) {
    clearVoice(ws);
    send(ws, { t: 'voiceTimeout' });
    return;
  }
  ws.voiceFrames = (ws.voiceFrames || []).filter((t) => now - t < 1000);
  if (ws.voiceFrames.length >= VOICE_MAX_FPS) return;
  ws.voiceFrames.push(now);

  // 座位以服务端为准，客户端帧里填的不算数，防止冒充别人说话
  raw[1] = ws.seat & 0xff;

  const room = ws.room;
  const push = (c) => {
    if (!c || c === ws || c.readyState !== 1) return;
    if (c.bufferedAmount > VOICE_MAX_BACKLOG) return;
    try { c.send(raw); } catch { /* 连接已断 */ }
  };
  for (const s of room.slots) push(s.ws);
  for (const w of room.watchers) push(w.ws);
}

/** 换房 / 离桌 / 掉线时收尾：别让全桌一直挂着「某人正在说话」的指示 */
function clearVoice(ws) {
  const wasOn = !!ws.voiceOn;
  ws.voiceOn = false;
  ws.voiceFrames = [];
  ws.voiceUntil = 0;
  if (ws.voiceTimer) { clearTimeout(ws.voiceTimer); ws.voiceTimer = null; }
  if (wasOn && ws.room && ws.seat >= 0) {
    try { ws.room.broadcastAll({ t: 'voice', seat: ws.seat, on: false, name: '' }); }
    catch { /* 房间已销毁 */ }
  }
}

/**
 * 扣钻 + 回推余额。余额不够时 addDiamonds 会抛「钻石不够」，
 * 外层 case 的 try/catch 会把它变成一条 error 消息，前端 toast 出来。
 * 返回实际扣掉的数额（0 = 没登录 / 免费 / 价格为 0）。
 */
function spend(ws, amount, reason) {
  const fee = Math.round(Number(amount) || 0);
  if (fee <= 0) return 0;
  if (!ws.userId) throw new Error('请先登录再使用');
  accounts.addDiamonds(ws.userId, -fee, reason, 'spend');
  // v0.22.41（方案B）：自建房内的纯消耗即时记到房主成长值——
  // 大厅消耗（开房/改名）时 ws.room 为空，天然不计入。
  creditOwnerGrowth(ws.room, fee);
  send(ws, { t: 'diamonds', balance: accounts.get(ws.userId).diamonds, spent: fee, reason });
  return fee;
}

/** 房内消耗 → 房主成长值 +1；跨过奖励刻度时发钻并把新资料推给房主（不在线就等他下次拉） */
function creditOwnerGrowth(room, fee) {
  if (!room || !room.ownerUid || !(fee > 0)) return;
  try {
    const granted = accounts.creditGrowth(room.ownerUid, fee);
    if (granted > 0) {
      const ou = accounts.get(room.ownerUid);
      if (ou) sendToUser(room.ownerUid, {
        t: 'profile', user: accounts.publicUser(ou), ledger: accounts.ledgerOf(room.ownerUid),
      });
    }
  } catch { /* 成长值记账失败不影响本笔消耗 */ }
}

const roomList = () => [...rooms.values()]
  .map((r) => ({
    id: r.id,
    humans: r.humans().length,
    watchers: r.watchers.length,
    online: r.humansOnline(),
    seatCount: r.seatCount,
    started: r.started,
    ended: r.ended,
    stake: r.stakeLabel,
    minBuyIn: r.minBuyIn,
    durationMin: r.durationMin,
    owner: r.ownerName(),
  }))
  .sort((a, b) => b.online - a.online || b.humans - a.humans)
  .slice(0, 20);

/** 换房前先松手，别在两个房间里同时占座 */
function detach(ws) {
  if (!ws.room) return;
  clearVoice(ws);
  ws.room.leave(ws.seat, ws);
  ws.room.broadcast();
  ws.room = null;
  ws.seat = -1;
}

wss.on('connection', (ws, req) => {
  const ip = clientIp(req);

  // 全服新建连接速率：1 秒最多 40 条新连接，挡住「疯狂重连」型脚本
  if (!connRateLimit.hit('all').ok) {
    counters.wsRejected++;
    securityLog.write('ws.connRate', { ip, conn: connQuota.count });
    try { ws.close(1013, 'busy'); } catch { /* 忽略 */ }
    return;
  }

  // 连接配额：单 IP + 全局双上限，超了直接关，别让它占着 fd
  const quota = connQuota.acquire(ip);
  if (!quota.ok) {
    counters.wsRejected++;
    securityLog.write('ws.reject', { ip, reason: quota.reason, conn: connQuota.count });
    try { ws.close(1013, 'busy'); } catch { /* 忽略 */ }
    return;
  }

  ws.ip = ip;
  ws.deviceId = '';        // v0.20.96：客户端上报的设备标识（同设备不能同桌）
  ws.loc = null;           // v0.20.96：客户端上报的定位（距离太近不能同桌）
  ws.released = false;
  ws.isAlive = true;
  ws.room = null;
  ws.seat = -1;
  ws.msgTimes = [];
  ws.floodHits = 0;
  ws.madeRooms = 0;
  ws.admin = false;        // 开发者账号登录后置 true
  ws.godRoom = null;       // 正在上帝视角观察的房间
  ws.adminFails = 0;
  ws.voiceOn = false;      // v0.20.53：是否正按着话筒（只有 on 才收音频帧）
  ws.voiceFrames = [];     // v0.20.53：一秒内收到的语音帧时间戳
  ws.voiceUntil = 0;       // v0.20.54：本次对讲的截止时刻
  ws.voiceTimer = null;    // v0.20.54：到点强制断开的定时器

  // 必须监听 error：ws 的 'error' 没人接会抛成未捕获异常，一条坏帧就能带走进程
  ws.on('error', (e) => {
    securityLog.write('ws.error', { ip, msg: String((e && e.message) || e).slice(0, 160) });
  });

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw, isBinary) => {
    // v0.20.53：二进制帧专供对讲机音频，独立通道自己限流。
    // 放在文本限流之前 return，语音不会挤掉正常牌桌消息的额度。
    if (isBinary) {
      relayVoice(ws, raw, ip);
      return;
    }

    // 单连接 1 秒内超过 30 条：先丢弃，连续 10 秒都在刷就断开
    const now = Date.now();
    if (!globalMsgLimit.hit('all', 1, now).ok) {
      counters.msgDropped++;
      return;
    }
    ws.msgTimes = ws.msgTimes.filter((t) => now - t < 1000);
    if (ws.msgTimes.length >= 30) {
      counters.msgDropped++;
      ws.floodHits++;
      if (ws.floodHits > 10) {
        securityLog.write('ws.flood', { ip, dropped: counters.msgDropped });
        try { ws.terminate(); } catch { /* 忽略 */ }
      }
      return;
    }
    ws.floodHits = 0;
    ws.msgTimes.push(now);

    let parsed;
    try { parsed = JSON.parse(raw.toString()); } catch {
      counters.badMsg++;
      return;
    }

    // 统一清洗：非对象 / 超长昵称 / 非法房号 / 非数字金额在这里就被挡掉
    const msg = sanitizeMsg(parsed);
    if (!msg) {
      counters.badMsg++;
      securityLog.write('ws.badmsg', { ip, size: raw.length });
      return;
    }

    try {
      switch (msg.t) {
        /* ── 账号：注册 / 登录 / 恢复会话 / 退出 ───────────── */
        case 'register': {
          const r = accounts.register({
            account: msg.account, pass: msg.pass, nick: msg.nick, ip,
            secQ: msg.secQ, secA: msg.secA,
            requireSec: true,   // v0.21.4：玩家注册必须设安全问题
            avatar: msg.avatar || null,   // v0.22.45：注册头像（sys 编号或 base64；缺省随机兜底）
            device: ws.deviceId || '',    // v0.22.46：同设备限 3 号
          });
          bindUser(ws, r.user, r.token);
          send(ws, {
            t: 'auth',
            ok: true,
            token: r.token,
            user: accounts.publicUser(r.user),
            // v0.21.1：告诉前端这个号有没有领到开号赠送，以及还剩多少名额
            signupBonus: r.signupBonus,
            signupLeft: r.signupLeft,
          });
          kickOtherSessions(r.user, r.token, ws);
          break;
        }
        case 'login': {
          const r = accounts.login({ account: msg.account, pass: msg.pass });
          bindUser(ws, r.user, r.token);
          send(ws, { t: 'auth', ok: true, token: r.token, user: accounts.publicUser(r.user) });
          // v0.20.93：单点登录 —— 这个号在别处（另一台设备）的在线全部收掉
          kickOtherSessions(r.user, r.token, ws);
          break;
        }
        /* v0.21.3：忘记密码——先查这个账号的安全问题，再凭答案重置 */
        case 'secQ': {
          const r = accounts.secQuestion(msg.account);
          if (!r) {
            send(ws, { t: 'secQ', ok: false, msg: '这个账号不能自助找回，请联系管理员重置' });
            break;
          }
          send(ws, { t: 'secQ', ok: true, account: r.account, q: r.q });
          break;
        }
        case 'resetBySec': {
          const u = accounts.resetBySecurity({
            account: msg.account, answer: msg.answer, pass: msg.pass,
          });
          securityLog.write('pass.reset', { ip, uid: u.id, account: u.account });
          send(ws, { t: 'resetOk', account: u.account });
          break;
        }
        /* 登录后补设 / 更换安全问题：要验一次原密码 */
        case 'setSecQ': {
          const u = ws.userId && accounts.get(ws.userId);
          if (!u) throw new Error('请先登录');
          accounts.setSecQuestion(u.id, msg.oldPass, msg.secQ, msg.secA);
          send(ws, {
            t: 'profile', user: accounts.publicUser(u), ledger: accounts.ledgerOf(u.id),
            secSaved: true,
          });
          break;
        }

        /* v0.20.96：客户端上报设备标识（同一台设备上的多个账号不能同桌） */
        case 'hello': {
          const dev = String(msg.dev || '').trim().slice(0, 64);
          if (/^[A-Za-z0-9_-]{8,64}$/.test(dev)) ws.deviceId = dev;
          break;
        }

        /* v0.20.96：客户端上报定位（相距太近不能同桌）。
           只在内存里存 10 分钟，不落盘、不进日志，只用于落座时比对 */
        case 'geo': {
          const lat = Number(msg.lat);
          const lng = Number(msg.lng);
          if (Number.isFinite(lat) && Number.isFinite(lng)
            && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
            ws.loc = {
              lat: Math.round(lat * 1e5) / 1e5,
              lng: Math.round(lng * 1e5) / 1e5,
              acc: Math.max(0, Math.min(100000, Number(msg.acc) || 0)),
              at: Date.now(),
            };
          }
          break;
        }

        case 'auth': {
          const u = accounts.sessionUser(msg.token);
          if (!u) { send(ws, { t: 'auth', ok: false }); break; }
          bindUser(ws, u, msg.token);
          send(ws, { t: 'auth', ok: true, token: msg.token, user: accounts.publicUser(u) });
          break;
        }
        case 'logout': {
          accounts.dropSession(msg.token);
          bindUser(ws, null);
          send(ws, { t: 'logout' });
          break;
        }
        /* 微信登录：开放平台参数未接，先明确回绝，前端据此提示 */
        case 'wxLogin': {
          send(ws, { t: 'wxLogin', ok: false, msg: '微信登录还在接入中，先用账号密码登录' });
          break;
        }
        case 'profile': {
          const u = ws.userId && accounts.get(ws.userId);
          if (!u) { send(ws, { t: 'error', msg: '请先登录', code: 'NO_AUTH' }); break; }
          send(ws, { t: 'profile', user: accounts.publicUser(u), ledger: accounts.ledgerOf(u.id) });
          break;
        }
        case 'setNick': {
          const u = ws.userId && accounts.get(ws.userId);
          if (!u) throw new Error('请先登录');
          const name = String(msg.nick || '').trim().slice(0, 12);
          if (!name) throw new Error('名字不能为空');
          if (name === u.nick) {
            send(ws, { t: 'profile', user: accounts.publicUser(u), ledger: accounts.ledgerOf(u.id) });
            break;
          }
          // 改名：每个号第一次免费，之后 2 钻
          let charged = 0;
          if (u.freeRename !== false) {
            u.freeRename = false;
            accounts.save();
            send(ws, { t: 'nickFree', msg: '首次改名免费' });
          } else {
            charged = spend(ws, PRICE.rename, '改名');
          }
          accounts.setNick(u.id, name);
          // 座位上的名字也一起改，不用等下一手
          const room = ws.room;
          if (room && ws.seat >= 0) {
            room.rename(ws.seat, u.nick);
            room.broadcast();
          }
          send(ws, { t: 'profile', user: accounts.publicUser(u), ledger: accounts.ledgerOf(u.id), charged });
          break;
        }
        case 'changePass': {
          const u = ws.userId && accounts.get(ws.userId);
          if (!u) throw new Error('请先登录');
          accounts.changePass(u.id, msg.oldPass, msg.pass);
          // 旧密码对应的登录全部作废：清会话、换新 token，只留当前这台设备
          accounts.dropSessionsOf(u.id);
          const token = accounts.newSession(u.id);
          for (const c of wss.clients) {
            if (c === ws || !c.userId || String(c.userId) !== String(u.id)) continue;
            send(c, { t: 'kicked', msg: '密码已修改，请用新密码重新登录' });
            c.userId = null;
            setTimeout(() => { try { c.close(4401, 'password changed'); } catch { /* 已经断了 */ } }, 80);
          }
          send(ws, { t: 'passChanged', token });
          break;
        }
        case 'setAvatar': {
          const u = ws.userId && accounts.get(ws.userId);
          if (!u) { send(ws, { t: 'error', msg: '请先登录', code: 'NO_AUTH' }); break; }
          // v0.22.45：系统头像走编号（{t:'setAvatar', sys:n}），base64 自传不变
          if (msg.sys != null) {
            const url = accounts.setSysAvatar(u.id, msg.sys);
            ws.avatar = url;
            // v0.22.64：同一账号的其它在线连接也一起更新，避免多端显示不一致
            for (const c of wss.clients) if (c.userId === u.id) c.avatar = url;
            if (ws.room && typeof ws.room.broadcast === 'function') ws.room.broadcast();
            send(ws, { t: 'avatar', url, user: accounts.publicUser(u) });
            break;
          }
          const m = /^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(msg.data || ''));
          if (!m) throw new Error('头像格式不支持，请用 JPG / PNG / WebP');
          const buf = Buffer.from(m[2], 'base64');
          if (buf.length > 400 * 1024) throw new Error('头像不能超过 400KB');
          const ext = m[1] === 'png' ? 'png' : m[1] === 'webp' ? 'webp' : 'jpg';
          const url = accounts.saveAvatar(u.id, buf, ext);
          ws.avatar = url;
          // v0.22.64：同一账号的其它在线连接也一起更新
          for (const c of wss.clients) if (c.userId === u.id) c.avatar = url;
          // 坐在桌上的人换了头像：重播一次视图，别人座位上也能立刻看到
          if (ws.room && typeof ws.room.broadcast === 'function') ws.room.broadcast();
          send(ws, { t: 'avatar', url, user: accounts.publicUser(u) });
          break;
        }
        case 'transfer': {
          const u = ws.userId && accounts.get(ws.userId);
          if (!u) throw new Error('请先登录');
          const toId = String(msg.to || '').trim();
          accounts.transfer(u.id, toId, msg.amount, msg.note || '');
          send(ws, { t: 'profile', user: accounts.publicUser(u), ledger: accounts.ledgerOf(u.id) });
          // v0.22.38：赠送成功回执——以前前端无脑提示「已赠」，服务端报错也像成功了
          send(ws, { t: 'giftOk', msg: `已赠送 ${Math.round(Number(msg.amount) || 0)} 钻给 ID ${toId}` });
          // v0.22.38：接收方原来只推余额不推流水，赠送后流水列表不动（要重连才看到）。
          // 现在直接推完整 profile：余额 + 流水一起刷新。
          const toUser = accounts.get(toId);
          if (toUser) sendToUser(toId, {
            t: 'profile', user: accounts.publicUser(toUser), ledger: accounts.ledgerOf(toId),
          });
          break;
        }
        case 'adminPlayers': {
          const u = ws.userId && accounts.get(ws.userId);
          if (!u || u.role !== 'owner') throw new Error('没有权限');
          send(ws, { t: 'adminPlayers', list: accounts.listUsers() });
          break;
        }
        case 'adminGrant': {
          const u = ws.userId && accounts.get(ws.userId);
          if (!u || u.role !== 'owner') throw new Error('没有权限');
          const amt = Math.round(Number(msg.amount));
          if (!Number.isInteger(amt) || amt === 0 || Math.abs(amt) > 1e6) throw new Error('数量不对');
          accounts.addDiamonds(msg.to, amt, msg.note || '开发者调整', u.id);
          send(ws, { t: 'adminPlayers', list: accounts.listUsers() });
          // v0.22.38：接收方推完整 profile（余额 + 流水一起刷新，原来只推余额）
          const gu = accounts.get(msg.to);
          if (gu) sendToUser(msg.to, {
            t: 'profile', user: accounts.publicUser(gu), ledger: accounts.ledgerOf(msg.to),
          });
          break;
        }
        case 'adminToggleDist': {
          const u = ws.userId && accounts.get(ws.userId);
          if (!u || u.role !== 'owner') throw new Error('没有权限');
          const t = accounts.get(msg.to);
          if (!t) throw new Error('账号不存在');
          if (t.role === 'owner') throw new Error('开发者本身就有分发权限');
          t.canDist = !!msg.on;
          accounts.save();
          send(ws, { t: 'adminPlayers', list: accounts.listUsers() });
          sendToUser(t.id, { t: 'self', user: accounts.publicUser(t) });
          break;
        }
        /* 隐藏功能（透视）授权：只有开发者能开关，打开后玩家连点「窄」六下才生效 */
        case 'adminToggleCheat': {
          const u = ws.userId && accounts.get(ws.userId);
          if (!u || u.role !== 'owner') throw new Error('没有权限');
          const t = accounts.get(msg.to);
          if (!t) throw new Error('账号不存在');
          if (t.role === 'owner') throw new Error('开发者本身就能用透视');
          t.canCheat = !!msg.on;
          accounts.save();
          // 在线连接同步资格：关掉后立刻失效，重新授权则恢复
          for (const c of wss.clients) {
            if (c.userId === t.id) {
              c.cheat = canUseCheat(t);
              c.cheatOff = true;   // v0.22.64：授权后同样默认关闭，需手动开启
            }
          }
          send(ws, { t: 'adminPlayers', list: accounts.listUsers() });
          sendToUser(t.id, {
            t: 'self',
            user: accounts.publicUser(t),
            note: t.canCheat ? 'cheatOn' : 'cheatOff',
          });
          break;
        }

        /* ── 发发看：看一眼牌堆最上面的三张 ── */
        case 'peekNext': {
          if (!ws.userId) throw new Error('请先登录');
          const room = ws.room;
          const g = room && room.game;
          if (!g) throw new Error('还没开局');
          if (g.phase === 'WAITING' || g.phase === 'ENDED') throw new Error('这一手还没开始');
          // 只在结算那一下开放：看的是下一手要发的三张
          if (g.phase !== 'SETTLED') throw new Error('本手结算后才能发发看');
          if (PRICE.next > 0) spend(ws, PRICE.next, '发发看');
          // deck 末尾是下一张，反转后按「从上往下」给
          const deck = g.deck.slice().reverse();
          // v0.20.76：牌面只给购买者本人；其他人（含围观、上帝视角）只收到三张牌背，
          // 由前端按各自本机牌背素材渲染。真实 cards 不再广播给全桌。
          room.broadcastPeek(
            ws.userId,
            deck.slice(0, 3),
            (accounts.get(ws.userId) || {}).nick || '',
            PRICE.next,
          );
          break;
        }

        /* ── 透视开关：授权玩家主动关 / 再打开 ── */
        case 'cheatOff': {
          const u = ws.userId && accounts.get(ws.userId);
          if (!canUseCheat(u)) throw new Error('隐藏功能未开通，请联系开发者');
          ws.cheatOff = true;
          if (ws.room) ws.room.broadcast();
          send(ws, { t: 'cheatState', on: false });
          break;
        }
        case 'cheatOn': {
          const u = ws.userId && accounts.get(ws.userId);
          if (!canUseCheat(u)) throw new Error('隐藏功能未开通，请联系开发者');
          ws.cheat = true;
          ws.cheatOff = false;
          if (ws.room) ws.room.broadcast();
          send(ws, { t: 'cheatState', on: true });
          break;
        }

        /* ── 透视 / 定牌：连点「窄」六下的隐藏功能，需开发者授权 ── */
        case 'cheatPeek': {
          if (!ws.userId) throw new Error('请先登录');
          const u = accounts.get(ws.userId);
          if (!canUseCheat(u)) throw new Error('隐藏功能未开通，请联系开发者');
          const room = ws.room;
          const g = room && room.game;
          if (!g) throw new Error('还没开局');
          const seat = ws.seat;
          send(ws, {
            t: 'cheatPeek',
            seat,
            phase: g.phase,
            round: g.round,
            hands: g.seats
              .filter((p) => p.inHand && (p.hand || []).length)
              .map((p) => ({ seat: p.seat, name: p.name, cards: p.hand.slice() })),
            // deck 末尾是下一张，反转后按「从上往下」的顺序展示
            deck: g.deck.slice().reverse(),
            rig: (g.rigged.get(seat) || []).slice(),
          });
          break;
        }
        case 'cheatRig': {
          if (!ws.userId) throw new Error('请先登录');
          const u = accounts.get(ws.userId);
          if (!canUseCheat(u)) throw new Error('隐藏功能未开通，请联系开发者');
          const room = ws.room;
          const g = room && room.game;
          if (!g) throw new Error('还没开局');
          if (g.phase !== 'BET' || g.round !== 1) throw new Error('R1 已经结束，改不了了');
          const seat = ws.seat;
          const me = seat >= 0 ? g.seats[seat] : null;
          if (!me || !me.inHand) throw new Error('你这一手没牌');
          if ((me.hand || []).length >= 3) throw new Error('第三张已经发了');
          const cards = (msg.cards || []).slice();
          const left = new Set(g.deck.map((c) => c && c.id));
          // 选一张也行：只定第三张，第四张照常发
          if (!cards.length || cards.length > 2 || (cards.length === 2 && cards[0] === cards[1])
            || cards.some((id) => !left.has(id))) {
            throw new Error('这两张牌不在牌堆里了');
          }
          g.rigged.set(seat, cards);
          send(ws, { t: 'cheatRigOk', cards });
          break;
        }

        /* 开房：第一个进来的人就是房主 */
        case 'create': {
          // v0.21.5：开房必须登录。以前为了兼容老客户端放行匿名建房，
          // 结果裸连 WS 就能刷房间——现在房主绑定账号，匿名连接一律拒绝。
          if (!ws.userId) throw new Error('请先登录再开房');
          if (rooms.size >= 500) throw new Error('房间开满了，等会儿再来');
          if (ws.madeRooms >= 5) throw new Error('开房太频繁了，先打两把吧');
          // 跨连接限流：换连接也绕不过「单 IP 每 10 分钟 8 间」
          const perIp = createLimit.hit(ip);
          if (!perIp.ok) {
            counters.createBlocked++;
            securityLog.write('room.createLimit', { ip, retryAfter: perIp.retryAfter });
            throw new Error(`开房太频繁了，${perIp.retryAfter} 秒后再试`);
          }
          const global = globalCreateLimit.hit('all');
          if (!global.ok) {
            counters.createBlocked++;
            securityLog.write('room.createGlobal', { ip });
            throw new Error('开房的人太多，歇一会儿再来');
          }
          const stake = findStake(msg.ante) || STAKES[3];       // 默认 10/20
          const durationMin = DURATIONS.includes(Number(msg.durationMin))
            ? Number(msg.durationMin) : 60;
          // 开房扣钻：10 钻 / 30 分钟，按档向上取整（30/60/90/120 → 10/20/30/40）。
          // 上面已经拦了未登录，这里一定有 userId。
          const fee = createCost(durationMin);
          if (fee > 0) {
            accounts.addDiamonds(ws.userId, -fee, `开房 ${durationMin} 分钟`, 'spend');
            send(ws, { t: 'diamonds', balance: accounts.get(ws.userId).diamonds });
          }
          detach(ws);
          ws.madeRooms++;
          const id = newRoomId();
          const room = new Room(id, {
            // v0.20.37：4 人桌废弃（v0.22.91 已彻底移除 4 人档）——建房一律 8 人桌
            seatCount: 8,
            ante: stake.ante,
            handMango: stake.handMango,
            minBuyIn: stake.minBuyIn,
            durationMin,
            // v0.20.97：防串通三项由开房人勾选，老客户端不发 = 全关
            fairIp: !!msg.fairIp,
            fairDev: !!msg.fairDev,
            fairGeo: !!msg.fairGeo,
            // v0.22.39：最低可玩簸簸 = 底皮 × n（开房页拉条，白名单校验在 Room 内）
            floorMult: Number(msg.floorMult) || 8,
            // v0.22.67：地九王开关——老客户端不带 = 默认开（Room 内兜底）
            dijiuOn: msg.dijiuOn !== false,
          });
          // v0.20.28：房间锁定开房人——中途离房不换房主，直到房间倒计时结束
          room.ownerUid = ws.userId || '';
          room.ownerNick = String(msg.name || '').trim().slice(0, 8);
          registerRoom(room);
          const r = room.join(msg.name, ws, '');
          ws.room = room;
          ws.cheatOff = true;   // v0.22.64：每次进房默认关透视
          // 开房后先在围观席看座，自己挑任意空位坐下（也可以先不坐）。
          // v0.21.5：匿名开房已封，这条路径不再有「直接坐 0 号位」的兼容分支。
          ws.seat = -1;
          send(ws, {
            t: 'created', roomId: id, seat: -1, token: r.token, isOwner: true, watching: true, fair: room.fair,
            stake: room.stakeLabel, ante: room.ante, handMango: room.handMango,
            minBuyIn: room.minBuyIn, durationMin: room.durationMin,
          });
          room.broadcast();
          scheduleSave();
          break;
        }

        /* 进房：房间必须已经存在（不再随手建房） */
        case 'join': {
          const id = String(msg.room || '').trim();
          const room = rooms.get(id);
          if (!room) {
            send(ws, { t: 'error', msg: '房号不对，或者这桌已经散了，问房主再确认一下', code: 'NO_ROOM' });
            break;
          }
          if (ws.room && ws.room !== room) detach(ws);
          // v0.22.74：记住进房 token，退出房间时靠它给游客暂存/认领剩余簸簸
          ws.roomToken = String(msg.token || '') || ws.roomToken || '';
          const r = room.join(msg.name, ws, msg.token);
          ws.room = room;
          ws.cheatOff = true;   // v0.22.64：每次进房默认关透视
          ws.seat = r.seat;
          send(ws, {
            t: 'joined', seat: r.seat, token: r.token, roomId: room.id, fair: room.fair,
            reconnected: r.reconnected, watching: r.watching, isOwner: r.isOwner,
            pendingSeat: r.pendingSeat ?? null,
            stake: room.stakeLabel, ante: room.ante, handMango: room.handMango,
            minBuyIn: room.minBuyIn, durationMin: room.durationMin,
          });
          room.broadcast();
          if (room.started) room.pump();
          scheduleSave();
          break;
        }

        /* 围观的人自己选座：{t:'sit', seat} */
        case 'sit': {
          if (!ws.room) break;
          const room = ws.room;
          room.post(() => {
            try {
              const r = room.sit(ws, Number(msg.seat));
              ws.seat = r.seat;
              send(ws, { t: 'sat', seat: r.seat, pending: !!r.pending });
              scheduleSave();
            } catch (e) {
              send(ws, { t: 'error', msg: e.message, code: 'SIT_FAIL' });
            }
          });
          break;
        }

        /* 反悔：还没坐下就把挂起的座位退掉 */
        case 'unsit':
          if (ws.room) {
            const room = ws.room;
            room.post(() => { room.unsit(ws); room.broadcast(); });
          }
          break;

        /* 房主手动开局（开房人锁定下，开房账号坐下也能开） */
        case 'start': {
          if (!ws.room) break;
          ws.room.start(ws.seat, ws.userId);
          ws.room.broadcast();
          scheduleSave();
          break;
        }

        case 'act':
          if (ws.room) ws.room.post(() => ws.room.act(ws.seat, msg.action, msg.amount));
          break;

        /* v0.20.25 加时：当前行动者花钻把本手读秒 +30s。
           一场每人最多 4 次，费用 2/4/8/16 钻递增，用完按钮变灰。
           加时期间全桌等他一个人想（行动权本来就在他手里），读条整体拉长。 */
        case 'extend': {
          if (!ws.room || ws.seat < 0) break;
          const room = ws.room;
          const g = room.game;
          if (!g || !room.started || g.phase !== PHASE.BET || g.currentSeat !== ws.seat) {
            send(ws, { t: 'extendFail', why: 'notTurn' });
            break;
          }
          const uses = room.extUses[ws.seat] || 0;
          if (uses >= 4) { send(ws, { t: 'extendFail', why: 'max' }); break; }
          const cost = 2 ** (uses + 1);
          try {
            spend(ws, cost, `加时第 ${uses + 1} 次`);
          } catch (e) {
            send(ws, { t: 'error', msg: e.message });
            send(ws, { t: 'extendFail', why: 'poor' });
            break;
          }
          room.post(() => room.applyExtend(ws.seat));
          break;
        }

        case 'split':
          if (ws.room) ws.room.post(() => ws.room.split(ws.seat, msg.index));
          break;

        /* 搓牌：发到第四张时先扣住牌面，搓开或到点再亮。
           收费在「这一场第一次真开搓」时发生：5 钻 / 整场，之后反复开关、换手都不再扣。 */
        case 'scratch': {
          if (!ws.room || ws.seat < 0) break;
          const room = ws.room;
          const on = !!msg.on;
          if (on) {
            const g = room.game;
            const p = g && g.seats[ws.seat];
            const willScratch = !!(g && p && !p.scratchPaid && p.inHand && !p.folded
              && p.hand.length >= 4 && !p.scratchUsed
              && g.phase !== PHASE.SETTLED && g.phase !== PHASE.WAITING);
            if (willScratch && PRICE.scratch > 0) {
              try {
                spend(ws, PRICE.scratch, '搓牌（整场）');
                p.scratchPaid = true;
                send(ws, { t: 'scratchPaid', handNo: g.handNo, charged: PRICE.scratch });
              } catch (e) {
                // 钻石不够：不开搓，告诉前端把开关拨回去
                send(ws, { t: 'error', msg: e.message });
                send(ws, { t: 'scratchDenied', msg: e.message });
                break;
              }
            }
          }
          room.post(() => room.scratch(ws.seat, on));
          break;
        }

        /* 搓牌开关：开局前 / 两手之间先把整场的 5 钻付掉，真正开搓时就不拦了。
           这一场已经付过就原样回执，不再扣。 */
        case 'scratchPay': {
          if (!ws.room || ws.seat < 0) throw new Error('先坐下再开搓牌');
          const g = ws.room.game;
          if (!g) throw new Error('还没开局');
          if (g.phase !== PHASE.BET && g.phase !== PHASE.SPLIT) {
            send(ws, { t: 'scratchPaid', handNo: g.handNo, charged: 0, pending: true });
            break;
          }
          const p = g.seats[ws.seat];
          if (!p || !p.inHand) throw new Error('你这一手没牌');
          if (p.scratchPaid) { send(ws, { t: 'scratchPaid', handNo: g.handNo, charged: 0 }); break; }
          try {
            spend(ws, PRICE.scratch, '搓牌（整场）');
          } catch (e) {
            send(ws, { t: 'error', msg: e.message });
            send(ws, { t: 'scratchDenied', msg: e.message });
            break;
          }
          p.scratchPaid = true;
          send(ws, { t: 'scratchPaid', handNo: g.handNo, charged: PRICE.scratch });
          ws.room.post(() => ws.room.broadcast());
          break;
        }

        /* 强制秀牌：10 钻 / 手，本手四张亮给全桌；下一手要重新买 */
        case 'forceShow': {
          if (!ws.room) throw new Error('先进房间再秀牌');
          const room = ws.room;
          const g = room.game;
          if (!g) throw new Error('还没开局');
          // 围观 / 没牌 / 已弃牌都放行：只要本手还没亮过就能点。
          // 手上没有牌可亮时不扣钻，只回一句提示。
          const meSeat = ws.seat;
          const meP = meSeat >= 0 ? g.seats[meSeat] : null;
          if (meP && meP.showHand) throw new Error('这一手已经亮过牌了');
          if (!meP || (meP.hand || []).length < 2) throw new Error('你这一手没有牌可亮，不收钻');
          if (!g.canForceShow(meSeat)) throw new Error('这一手不能秀牌');
          spend(ws, PRICE.forceShow, '强制秀牌');
          room.post(() => {
            if (g.forceShow(ws.seat)) {
              room.broadcast();
              send(ws, { t: 'forceShowOk', cost: PRICE.forceShow });
            } else {
              send(ws, { t: 'error', msg: '这一手不能秀牌' });
            }
          });
          break;
        }

        /* 结算期强制秀牌：全亮一直保持到收牌那一刻（v0.22.75，取向1）。
           收牌定时器整体后移「保底 1.2 秒」，revealUntil 顶到顺延后的收牌时刻；
           由于点击时刻不定，点击越早全亮持续越久，最晚点击也至少亮 1.2 秒，
           中途不再变暗，付了钻就能看清整手牌。 */
        case 'revealAll': {
          if (!ws.room) throw new Error('先进房间再秀牌');
          const room = ws.room;
          const g = room.game;
          if (!g) throw new Error('还没开局');
          if (g.phase !== 'SETTLED') throw new Error('只在结算那几秒能秀全桌');
          const meP = ws.seat >= 0 ? g.seats[ws.seat] : null;
          if (!meP || !meP.inHand) throw new Error('这一手没打，不用秀');
          if (g.allRevealedHand === g.handNo) throw new Error('这一手已经秀过了');
          spend(ws, PRICE.revealAll, '结算秀全桌');
          room.post(() => {
            const showMs = SHOW_HOLD_MS;
            if (g.revealAllHole(ws.seat, showMs)) {
              // 把收牌 / 开下一手整体后移保底 1.2 秒（净间隔 left 不变，
              // 相当于这段里冻结间隔），顺延后的收牌时刻就写在 room.nextAt。
              const held = room.holdSettle(showMs);
              // 关键：全亮保持到收牌那一刻，不再中途变暗。
              // revealUntil 顶到顺延后的收牌时刻；没有待执行的收牌定时器时，
              // 退回到「点击 + 保底」作为兜底，至少亮 showMs 毫秒。
              const until = room.nextAt ? Math.max(g.revealUntil, room.nextAt)
                                        : (Date.now() + showMs);
              g.revealUntil = until;
              room.broadcast();
              send(ws, {
                t: 'revealAllOk', cost: PRICE.revealAll, holdMs: held, showMs: Math.round(showMs),
              });
              // 不再提前清零 revealUntil：牌面靠下方 beginHand 切手时自然收起。
            } else {
              send(ws, { t: 'error', msg: '这一手不能秀了' });
            }
          });
          break;
        }

        /* v0.20.57 洗牌：比牌结算后、下一手发牌前，任一在局玩家点一次，
           扣 2 钻 → 全桌同一条广播播同一套动画 → 收牌间隔顺延一个动画时长。
           全逻辑放进 room.post 串行队列：并发连点也只扣一次、只顺延一次、只播一次。 */
        case 'shuffle': {
          if (!ws.room) throw new Error('先进房间再洗牌');
          if (!ws.userId) throw new Error('请先登录再洗牌');
          const room = ws.room;
          const by = (accounts.get(ws.userId) || {}).nick || '';
          room.post(() => {
            const g = room.game;
            const fail = (m) => send(ws, { t: 'shuffleFail', msg: m });
            if (!g || g.phase !== 'SETTLED' || room.ended) return fail('只在比牌结算后、下一手发牌前能洗牌');
            // 全桌共享一次：坐下参与这桌即可（弃牌 / 被托管的人也能点），围观不行
            if (ws.seat < 0) return fail('坐下参与牌局才能洗牌');
            if (room.washHandNo === g.handNo) return fail('这一手已经洗过了');
            // 扣钻放显式 try：post 内部抛错会被队列的 catch 吞掉，那样前端收不到提示
            try { spend(ws, PRICE.shuffle, '洗牌'); }
            catch (e) { return fail(e.message || '洗牌没成功'); }
            room.washHandNo = g.handNo;   // 每手全桌只洗一次（防重复扣钻 / 重复顺延）
            // 动画时长追加到「两手间隔」末尾，播完才发下一手；不压缩结算展示时间
            const held = room.holdSettle(WASH_FX_MS);
            // 全桌（含发起者、围观、上帝视角）同一时刻收到同一条消息，各自播 CSS 动画
            room.broadcastAll({
              t: 'shuffleFx', by, handNo: g.handNo, cost: PRICE.shuffle, fxMs: WASH_FX_MS, held,
            });
            send(ws, { t: 'shuffleOk', cost: PRICE.shuffle, held });
          });
          break;
        }

        /* v0.20.75 回顾页「秀这手牌」：10 钻 / 手，只秀「本手之前」已结算的历史牌局。
           旧版回顾按钮复用 forceShow（本手），牌局进行中点一下就把桌上本手四张底牌
           亮给全桌。这里按 handNo 严格限定历史手；桌上本手只能用 revealAll 秀。 */
        case 'showLogHand': {
          if (!ws.userId) throw new Error('请先登录');
          const handNo = Number(msg.handNo);
          if (!Number.isInteger(handNo)) throw new Error('参数不对');
          const room = ws.room;
          const g = room && room.game;
          if (!g) throw new Error('还没有牌局记录');
          // 硬约束：只许秀确实存在于 log、已完成结算的历史手（含停牌前最后一手）
          if (!isHistoricalHand(g, handNo)) {
            throw new Error('这一手还没有完成结算，不能秀');
          }
          spend(ws, PRICE.forceShow, '回顾秀牌');
          send(ws, { t: 'showLogHandOk', handNo, cost: PRICE.forceShow });
          break;
        }

        /* 回顾里「偷偷看」：只亮某一手某一家的底牌给买家自己（2 钻 / 家 / 手） */
        case 'peekLog': {
          if (!ws.userId) throw new Error('请先登录');
          const handNo = Number(msg.handNo);
          const seat = Number(msg.seat);
          if (!Number.isInteger(handNo) || !Number.isInteger(seat)) throw new Error('参数不对');
          const room = ws.room;
          const g = room && room.game;
          if (!g) throw new Error('还没有牌局记录');
          // v0.22.59：回顾只涉及已结算归档手，还在打的本手底牌不许从这里偷看
          if (!isHistoricalHand(g, handNo)) {
            throw new Error('这一手还没有完成结算，不能看');
          }
          const entry = g.log.find((e) => e.handNo === handNo);
          const ps = entry && entry.seats.find((x) => x.seat === seat);
          if (!ps) throw new Error('这一手没有这家');
          spend(ws, PRICE.peek, '偷偷看底牌');
          send(ws, { t: 'peekOk', handNo, seat, cost: PRICE.peek });
          break;
        }

        /* 牌局回顾：整局记录按需拉一次，不跟着每次推送发 */
        case 'logs': {
          if (!ws.room) break;
          const room = ws.room;
          room.post(() => {
            // v0.22.59：下发该房间「所有已完成结算」的历史对局。log 里每条都是
            // 已归档的结算手，正在打的本手不在其中；不再按 handNo < 本手 过滤，
            // 结算停留期刚打完、以及停牌 / 结束前的最后一手也能在回顾里看到。
            const hands = room.game
              ? historicalHands(room.game.log)
              : [];
            send(ws, { t: 'logs', hands });
          });
          break;
        }

        /* 带入：先提交申请，房主同意才到账 */
        case 'buyin': {
          if (!ws.room) break;
          const room = ws.room;
          const seat = ws.seat;
          room.post(() => {
            try {
              const r = room.requestBuyIn(seat, msg.amount);
              send(ws, { t: 'buyinAsk', amount: r.amount, auto: r.auto, owner: !!r.owner });
              room.broadcast();
              scheduleSave();
              // v0.22.38：申请挂起等审核 → 推给房主（他在不在房间里都能收到）+ 提示音
              if (!r.auto) notifyOwnerBuyReq(room);
            } catch (e) {
              send(ws, { t: 'error', msg: e.message });
            }
          });
          break;
        }

        /* 房主审核带入：{t:'review', seat, approve} */
        case 'review': {
          // v0.22.38：带 roomId 就是跨房审批（房主在别的房间 / 大厅里审自己名下的房）；
          // 不带 roomId 走老路径（本房间）。
          const rid = String(msg.roomId || '').trim();
          const room = rid ? rooms.get(rid) : ws.room;
          if (!room) { send(ws, { t: 'error', msg: rid ? '这个房间已经结束了' : '你还没进房间' }); break; }
          room.post(() => {
            try {
              room.reviewBuyIn(rid ? -1 : ws.seat, Number(msg.seat), !!msg.approve, ws.userId);
              room.broadcast();
              scheduleSave();
              // 审完把全局申请列表刷新给房主（角标 / 列表即时归零）
              send(ws, { t: 'myRequests', ...ownerReqList(ws.userId) });
            } catch (e) {
              send(ws, { t: 'error', msg: e.message });
            }
          });
          break;
        }

        /* 房主提前结束本桌 */
        case 'endTable':
          if (ws.room) {
            const room = ws.room;
            room.post(() => {
              try {
                if (!(ws.seat === room.ownerSeat || room.isOpenerUid(ws.userId))) {
                  throw new Error('只有房主能结束本桌');
                }
                room.requestEnd('owner');
                room.broadcast();
                scheduleSave();
              } catch (e) {
                send(ws, { t: 'error', msg: e.message });
              }
            });
          }
          break;

        case 'decline':
          if (ws.room) ws.room.post(() => ws.room.decline(ws.seat));
          break;

        /* 站起围观：手里有牌就等这一手打完再让座 */
        case 'standUp':
          if (ws.room) {
            const room = ws.room;
            room.post(() => {
              try {
                const r = room.standUp(ws.seat);
                send(ws, { t: 'standUpOk', after: r.after });
                scheduleSave();
              } catch (e) {
                send(ws, { t: 'error', msg: e.message });
              }
            });
          }
          break;

        /* 保位离桌：结算后进留座倒计时，读完自动让座；cancel 撤回 */
        case 'holdLeave':
          if (ws.room) {
            const room = ws.room;
            room.post(() => {
              try {
                const r = room.holdLeave(ws.seat, !!msg.cancel);
                send(ws, { t: 'holdLeaveOk', after: r.after, cancel: !!r.cancel });
                scheduleSave();
              } catch (e) {
                send(ws, { t: 'error', msg: e.message });
              }
            });
          }
          break;

        /* 互动表情：点别人头像的道具 1 钻一个，我的表情盘（x1~x20）免费。
           扣费成功才广播，发送者自己也从服务端收回执，
           这样「本地先播、服务端扣费失败」的假象不会出现。 */
        case 'emote': {
          if (!ws.room) break;
          const room = ws.room;
          const at = Date.now();
          if (at - (ws.lastEmoteAt || 0) < 500) break;   // 防刷屏：一人一秒最多两次
          const seat = Number(msg.seat);
          const emo = String(msg.emo || '');
          if (!EMOTE_IDS.has(emo)) break;
          if (ws.seat < 0) throw new Error('坐下才能发表情');
          if (!room.slots[seat] || !room.slots[seat].token) throw new Error('这个位置没人');
          ws.lastEmoteAt = at;
          // v0.20.19：我的表情盘（x1~x20）免费；互动道具照常扣钻
          if (!FREE_EMOTE_IDS.has(emo)) spend(ws, PRICE.emote, '互动表情');
          room.post(() => room.emote(ws.seat, seat, emo));
          break;
        }

        /* v0.20.53：对讲机开关。按住 → on，松手 → off，状态广播给全桌；
           真正的音频走二进制帧（relayVoice），不占文本消息配额。
           v0.20.54：每次 on 起一道 10 秒硬闸，到点服务端主动广播 off +
           给本人发 voiceTimeout，客户端计时器被节流/被改也能断开。 */
        case 'voice': {
          if (!ws.room || ws.seat < 0) break;
          const on = !!msg.on;
          if (ws.voiceTimer) { clearTimeout(ws.voiceTimer); ws.voiceTimer = null; }
          ws.voiceUntil = 0;
          ws.voiceOn = on;
          if (!on) ws.voiceFrames = [];
          const slot = ws.room.slots[ws.seat];
          ws.room.broadcastAll({ t: 'voice', seat: ws.seat, on, name: (slot && slot.name) || '' });
          if (on) {
            ws.voiceUntil = Date.now() + VOICE_MAX_MS;
            ws.voiceTimer = setTimeout(() => {
              ws.voiceTimer = null;
              if (!ws.voiceOn) return;
              clearVoice(ws);                    // 广播 voice off，全桌波纹熄灭
              send(ws, { t: 'voiceTimeout' });   // 客户端兜底：强制停采集 + 提示
            }, VOICE_MAX_MS);
          }
          break;
        }

        case 'leave': {
          if (ws.room) {
            const room = ws.room;
            // v0.22.68：正常进行牌局时不能携牌退出——先「站起围观」或「保位离桌」
            // 把自己从这一手摘出来（p.inHand=false / 离座）后才能退。
            // force=true 仅供「退出登录」这类账号级操作绕过（前端 logout 发）。
            if (!msg.force && ws.seat >= 0) {
              const p = room.game && room.game.seats[ws.seat];
              if (room.isPlaying() && p && p.inHand) {
                send(ws, { t: 'error', msg: '这一手还在打，先站起围观或保位离桌，结算后再退出', code: 'LEAVE_IN_HAND' });
                break;
              }
            }
            // v0.22.74：真正退出前，把这桌的剩余簸簸按账号暂存，
            // 回来坐下时原样带回、免房主审核（和站起围观的体验一致）。
            // 要赶在 vacate/dropWatcher 清空数据之前取数。
            room.stashOnLeave(ws, ws.roomToken || '');
            clearVoice(ws);
            if (ws.seat >= 0) room.vacate(ws.seat);
            else room.dropWatcher(ws);
            ws.room = null;
            ws.seat = -1;
            send(ws, { t: 'left' });
            // 座位和围观位都空了、牌局还没开：直接解散，不占房号。
            // 但房主自己退出时保留房间（v0.20.95）：房主可回「你的房间」重新进来，
            // 免得刚花钻开的空桌一退出就被回收；无人回来则由 2 小时空房回收兜底。
            const ownerLeaving = !!(ws.userId && String(ws.userId) === room.ownerUid);
            if (!room.humans().length && !room.watchers.length && !room.started && !ownerLeaving) {
              room.destroy();
              rooms.delete(room.id);
            } else {
              if (ownerLeaving && !room.humans().length && !room.watchers.length) room.touch();
              room.broadcast();
            }
            scheduleSave();
          }
          break;
        }

        case 'rooms':
          send(ws, { t: 'rooms', list: roomList() });
          break;

        /* ── v0.20.28 房主专属 ─────────────── */

        /* 强制离座：{t:'forceSit', seat, on} 标记/取消座位上的玩家；
           {t:'forceSit', uid, on:false} 按账号取消（人可能已经离座）。 */
        case 'forceSit': {
          if (!ws.room) break;
          const room = ws.room;
          room.post(() => {
            try {
              if (!room.connIsOwner(ws)) throw new Error('只有房主能强制离座');
              let r;
              if (msg.uid && !msg.on) {
                r = { cancel: true, name: room.forceOut.get(String(msg.uid)) || '' };
                room.unforceUid(msg.uid);
              } else {
                r = room.setForceOut(Number(msg.seat), !!msg.on);
              }
              room.broadcast();
              scheduleSave();
              send(ws, { t: 'forceSitOk', on: !!msg.on, name: r.name || '' });
            } catch (e) {
              send(ws, { t: 'error', msg: e.message });
            }
          });
          break;
        }

        /* 你的房间：自己开的 + 自己参与过的、还没散的桌子（v0.20.95 加入参与者） */
        case 'myRooms': {
          if (!ws.userId) { send(ws, { t: 'myRooms', list: [] }); break; }
          const uid = String(ws.userId);
          const list = [...rooms.values()]
            .filter((r) => !r.ended && (String(r.ownerUid) === uid || (r.participants && r.participants.has(uid))))
            .map((r) => ({
              id: r.id,
              stake: r.stakeLabel,
              seatCount: r.seatCount,
              humans: r.humans().length,
              online: r.humansOnline(),
              started: !!r.started,
              durationMin: r.durationMin,
              remainMs: typeof r.remainMs === 'function' ? r.remainMs() : 0,
              // v0.22.38：这间房当前待审的带入申请数（「你的房间」行右上角的提示数字）
              reqCount: (r.requests || []).length,
              // owner = 自己开的；join = 自己在参与（坐过 / 围观过）
              role: String(r.ownerUid) === uid ? 'owner' : 'join',
            }))
            .sort((a, b) => Number(b.role === 'owner') - Number(a.role === 'owner')
              || (b.started - a.started) || (b.online - a.online));
          send(ws, { t: 'myRooms', list });
          break;
        }

        /* v0.22.38：房主拉取自己名下所有房间的待审带入申请 */
        case 'myRequests': {
          if (!ws.userId) { send(ws, { t: 'myRequests', list: [], total: 0, counts: {} }); break; }
          send(ws, { t: 'myRequests', ...ownerReqList(ws.userId) });
          break;
        }

        /* ── 开发者 ─────────────────────────── */

        /* 用口令登录，成功后这条连接才有管理权限 */
        case 'adminLogin': {
          const key = String(msg.key || '');
          if (key !== ADMIN_KEY) {
            ws.adminFails++;
            send(ws, { t: 'adminDenied', msg: '口令不对' });
            if (ws.adminFails >= 5) ws.terminate();
            break;
          }
          ws.admin = true;
          ws.adminFails = 0;
          send(ws, { t: 'adminOk', rooms: adminRoomList() });
          break;
        }

        /* 所有牌局（含进行中） */
        case 'adminRooms': {
          if (!ws.admin) throw new Error('没登录开发者账号');
          send(ws, { t: 'adminRooms', list: adminRoomList() });
          break;
        }

        /* 进某一桌的上帝视角：全桌底牌 + 剩余牌堆 */
        case 'adminWatch': {
          if (!ws.admin) throw new Error('没登录开发者账号');
          if (ws.seat >= 0 && ws.room) throw new Error('你正坐在牌桌上，先离开再观察');
          const room = rooms.get(String(msg.room || '').trim());
          if (!room) throw new Error('这桌已经散了');
          if (ws.godRoom && ws.godRoom !== room) ws.godRoom.dropGod(ws);
          ws.godRoom = room;
          room.addGod(ws);
          send(ws, { t: 'adminScene', roomId: room.id, botsEnabled: !!room.botsEnabled });
          room.broadcast();       // 立刻推一帧上帝视角
          break;
        }

        /* 退出上帝视角，回到管理面板 */
        case 'adminLeave': {
          if (ws.godRoom) {
            ws.godRoom.dropGod(ws);
            ws.godRoom.broadcast();
            ws.godRoom = null;
          }
          send(ws, { t: 'adminLeft', rooms: ws.admin ? adminRoomList() : [] });
          break;
        }

        /* 开关机器人：{t:'adminBots', room, on} */
        case 'adminBots': {
          if (!ws.admin) throw new Error('没登录开发者账号');
          const room = rooms.get(String(msg.room || '').trim());
          if (!room) throw new Error('这桌已经散了');
          room.post(() => {
            room.setBots(!!msg.on);
            scheduleSave();
            send(ws, { t: 'adminRooms', list: adminRoomList() });
          });
          break;
        }

        /* 关桌：{t:'adminClose', room} 开发者强制解散：不等这一手、不留存，直接从房间表和数据文件里删掉 */
        case 'adminClose': {
          if (!ws.admin) throw new Error('没登录开发者账号');
          const room = rooms.get(String(msg.room || '').trim());
          if (!room) throw new Error('这桌已经散了');
          room.post(() => {
            room.close('owner');     // 通知全桌解散（onClose 里也会摘掉房间）
            rooms.delete(room.id);
            saveNow();               // 立刻落盘，别让防抖把已解散的桌子又写回去
            send(ws, { t: 'adminRooms', list: adminRoomList() });
            send(ws, { t: 'adminNotice', msg: '这桌已解散，数据已清除' });
          });
          break;
        }

        /* 退出开发者账号 */
        case 'adminLogout': {
          ws.admin = false;
          if (ws.godRoom) { ws.godRoom.dropGod(ws); ws.godRoom = null; }
          send(ws, { t: 'adminOut' });
          break;
        }

        case 'ping':
          // v0.22.89：回显客户端时间戳，前端据此测 RTT（网络延迟指示条）
          send(ws, { t: 'pong', ts: msg.ts || 0 });
          break;

        /* v0.22.89：弱网补发 —— 客户端画面冻结超 5 秒会发 sync 讨要最新快照。
         * 典型场景：弱网时发送缓冲超限被积压保护跳过，之后全桌都在等这个人
         * 行动、没有任何状态变化触发新广播，他的画面就永远停在旧的一手。 */
        case 'sync':
          if (ws.room && typeof ws.room.sendState === 'function') {
            try { ws.room.sendState(ws); } catch { /* 房间正在关闭等 */ }
          }
          break;

        default:
          break;
      }
    } catch (e) {
      send(ws, { t: 'error', msg: e.message });
    }
  });

  ws.on('close', () => {
    if (!ws.released) { ws.released = true; connQuota.release(ws.ip); }
    clearVoice(ws);
    if (ws.godRoom) {
      ws.godRoom.dropGod(ws);
      ws.godRoom = null;
    }
    if (ws.room) {
      ws.room.leave(ws.seat, ws);
      ws.room.broadcast();
      ws.room = null;
    }
  });
});

// 心跳：30 秒一轮；连续两轮无 pong（约 60 秒）才断开。
// v0.22.85：弱网（跨境链路抖动）下单轮 pong 迟到/丢包很常见，直接 terminate
// 会把还在思考的玩家误踢下线（表现为「卡断掉」）。放宽到两轮 miss，
// 客户端本来就有 8 秒卡住自检 + 断线自动重连，真死连接最多多挂 30 秒。
// v0.22.89：弱网补发扫描 —— 每 2 秒扫一遍所有房间，把「曾因缓冲超限被
// 跳过推送、现在缓冲已排空」的连接补发最新快照。不补发的死局：弱网缓冲
// 超限 → 广播全被跳过 → 缓冲排空后全桌恰好在等这个人行动、没有任何状态
// 变化触发新广播 → 他的画面永远停在旧的一手，直到读秒超时。
safeInterval(() => {
  for (const room of rooms.values()) {
    try { if (typeof room.flushBacklog === 'function') room.flushBacklog(); } catch { /* 房间正在关闭 */ }
  }
}, 2000, 'backlog-flush');

safeInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.miss = (ws.miss || 0) + 1;
      if (ws.miss >= 2) { ws.terminate(); continue; }
    } else {
      ws.miss = 0;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* 连接已断 */ }
  }
}, 30000, 'heartbeat');

// 空房回收：开局中的桌子无人 30 分钟、等待室 2 小时没人，就销毁
safeInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [id, room] of rooms) {
    if (room.hasHumanOnline()) continue;
    const limit = room.started ? 30 * 60 * 1000 : 2 * 60 * 60 * 1000;
    if (now - room.lastActive > limit) {
      room.destroy();
      rooms.delete(id);
      changed = true;
    }
  }
  if (changed) scheduleSave();
}, 60 * 1000, 'reap');

// 定时落盘，避免进程被杀时丢掉最后一批房间
safeInterval(() => { if (rooms.size) saveNow(); }, 60 * 1000, 'save');

// 限流表的过期清理：不清会随 IP 数慢慢涨
safeInterval(() => {
  httpLimit.sweep();
  createLimit.sweep();
  globalCreateLimit.sweep();
  securityLog.flush();
}, 60 * 1000, 'sweep');

/* ── 进程兜底 ────────────────────────────────
 * 单个房间的异常已经在 room.post 里吞掉了；这里兜剩下的漏网异常。
 * 策略：先记录并继续服务（牌桌上一秒掉线比崩一次更贵），
 *       但 1 分钟内超过 20 次说明状态已经不可信，主动退出让自启动拉起干净进程。
 */
let fatalTimes = [];
function onFatal(kind, err) {
  const now = Date.now();
  fatalTimes = fatalTimes.filter((t) => now - t < 60000);
  fatalTimes.push(now);
  const msg = String((err && (err.stack || err.message)) || err).slice(0, 400);
  console.error(`[fatal:${kind}]`, msg);
  securityLog.write('fatal', { kind, msg });
  if (fatalTimes.length > 20) {
    console.error('[fatal] 1 分钟内异常过多，重启进程');
    try { saveNowSync(); } catch { /* 落盘失败也要退 */ }
    securityLog.flush();
    setTimeout(() => process.exit(1), 50);
  }
}
process.on('uncaughtException', (e) => onFatal('uncaught', e));
process.on('unhandledRejection', (e) => onFatal('rejection', e));

// HTTP 层超时：挡住 Slowloris（只发一半 header 拖住连接）
server.headersTimeout = 10 * 1000;
server.requestTimeout = 15 * 1000;
server.keepAliveTimeout = 5 * 1000;
server.maxHeadersCount = 80;
server.maxConnections = MAX_CONN + 200;
server.on('clientError', (err, socket) => {
  try { socket.destroy(); } catch { /* 忽略 */ }
});
wss.on('error', (e) => {
  securityLog.write('ws.serverError', { msg: String((e && e.message) || e).slice(0, 160) });
});

const restored = loadRooms();

server.listen(PORT, '0.0.0.0', () => {
  const tlsOn = !!(SSL_KEY && SSL_CRT);
  console.log(`\n  扯旋 · 丁二皇`);
  console.log(`  ${tlsOn ? 'https' : 'http'}://localhost:${PORT}${tlsOn ? '  (TLS 已启用)' : ''}`);
  console.log(`  ${tlsOn ? 'wss' : 'ws'}://localhost:${PORT}/ws`);
  console.log(`  防护：单IP ${MAX_CONN_IP} 连接 / ${HTTP_RPM} HTTP次每分 / 每10分钟 ${ROOM_PER_10M} 间房`);
  if (ownerUser) {
    const customized = !accounts.verify(OWNER_PASS, ownerUser.pass);
    console.log(`  开发者账号：${ownerUser.account}（${customized
      ? '密码以账号库里保存的为准；忘了用 DH_RESET_OWNER_PASS=1 重置'
      : '密码＝DH_PASS 或默认值'}）`);
  }
  if (restored) console.log(`  已恢复 ${restored} 个房间`);
  console.log('');
});

function shutdownSave() {
  // v0.22.28：重启前把所有进行中的手牌作废退款——
  // 池子（底皮/跟注/份子/滚存）不落盘，不退就会凭空蒸发；退回后各家簸簸回到手牌前状态。
  for (const room of rooms.values()) {
    try {
      if (room.game && room.game.abortRefund && room.game.abortRefund()) {
        console.log(`[shutdown] 房间 ${room.id} 进行中手牌已作废，注额与池子已退回簸簸`);
      }
    } catch (e) { /* 退款失败也要照常落盘退出 */ }
  }
  // v0.22.99：行动流水攒批里的残余必须同步冲掉——进程一退，异步定时器不会跑
  try { actLogFlushSync(); } catch { /* 冲账失败不影响存档退出 */ }
  saveNowSync();
  accounts.flush();
}

process.on('SIGTERM', () => { shutdownSave(); process.exit(0); });
process.on('SIGINT', () => { shutdownSave(); process.exit(0); });

/**
 * 账号与钻石账本
 * ------------------------------------------------------------------
 * 设计要点：
 *   · 全部落盘到 data/accounts.json，写入节流 300ms，进程退出时强制 flush
 *   · 密码 scrypt(salt, 32)，不存明文；比较用 timingSafeEqual
 *   · 会话 token 24 字节随机，7 天有效；服务重启后仍然可用
 *   · 游戏 ID 是 6 位数字（随机分配，不按注册顺序），是玩家唯一标识；account 只是登录名
 *   · 钻石变动全部走 addDiamonds()，同时写一条流水，余额不会凭空出现
 *   · 角色：owner（开发者，DH_OWNER 指定）/ player；canDist 是「授权分发」开关
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SIGNUP_DIAMONDS } from './price.js';

const SESSION_DAYS = 7;
const MAX_LEDGER = 5000;
/** v0.20.78：登录防爆破——连续失败上限与锁定时长（毫秒） */
const LOGIN_MAX_FAIL = Number(process.env.DH_LOGIN_MAXFAIL || 5);
const LOGIN_LOCK_MS = Number(process.env.DH_LOGIN_LOCK_MS || 5 * 60 * 1000);
/**
 * 注册名额与设备判重
 *   · 累计前 M 个注册的号有初始钻石，之后 0 钻（靠房主分发）
 *   · 同一台设备只享受一次赠送；同一设备累计最多 3 个账号
 * 名额可用环境变量调：DH_SIGNUP_QUOTA
 */
const SIGNUP_QUOTA = Number(process.env.DH_SIGNUP_QUOTA || 200);

/**
 * v0.21.3 安全问题找回密码
 *   · 注册时可选设一个问题和答案；答案归一化后只存 scrypt 哈希，不存明文
 *   · 忘了密码用「账号 + 答案 + 新密码」自助重置，不用人工介入
 *   · 同一账号连错 5 次锁 10 分钟，防止拿几个常见答案硬撞
 *   · 老账号可以在「我的 → 安全问题」里补设，没设的只能由管理员重置
 */
export const SEC_QUESTIONS = [
  '我的出生城市',
  '我的第一只宠物名字',
  '我小学班主任姓什么',
  '我最喜欢的一道菜',
];
const SEC_MAX_FAIL = 5;
const SEC_LOCK_MS = 10 * 60 * 1000;

/* ── v0.22.45：系统头像库（web/img/avatars/sys-001.webp 起，固定命名规律）── */
export const SYS_AVATAR_COUNT = 342;
function sysAvatarPath(n) {
  return `/img/avatars/sys-${String(n).padStart(3, '0')}.webp`;
}

/** 答案归一化：去首尾空白、全角空格、中间所有空白，统一小写；中文不受大小写影响 */
function normAnswer(a) {
  return String(a == null ? '' : a).trim().toLowerCase().replace(/[\s\u3000]+/g, '');
}

/** 游戏 ID：6 位数字，100001 起 */
const ID_BASE = 100001;
const ID_MAX = 999999;
const DIGITS6 = /^\d{6}$/;

/** 开发者默认昵称池：随机取一个，之后可在「我的」里改名 */
const OWNER_NICKS = ['青羊客', '锦官烟雨', '望江楼主', '宽巷子', '窄巷子', '少城旧事', '蜀锦人家', '茶铺老周'];

const clean = (s, n) => String(s == null ? '' : s).trim().slice(0, n);

export class Accounts {
  constructor(dir, { owner = '' } = {}) {
    this.file = path.join(dir, 'accounts.json');
    this.avatarDir = path.join(dir, 'avatars');
    this.ownerAccount = clean(owner, 20).toLowerCase();
    this.data = {
      v: 1, seq: ID_BASE, users: {}, accounts: {}, sessions: {}, ledger: [],
      signupCount: 0,   // v0.21.1：累计注册数（用于「前 N 个新号送钻」名额）
    };
    this.timer = null;
    this.loginFails = new Map(); // 登录失败计数：仅内存，重启清零
    this.secFails = new Map();   // v0.21.3：安全答案连错计数，同样只在内存
    this.load();
    // v0.20.93：升级前多端登录留下的多条会话，启动时每个账号只留最新一条
    try { this.enforceSingleSession(); } catch { /* 数据异常不影响启动 */ }
    // v0.22.45：一次性头像重置——原系统头像全部弃用，所有人（含自传头像）重置为空，
    // 界面显示问号，等玩家自己来选新头像。只执行一次（写标记），不删旧头像文件。
    if (!this.data.avReset2026) {
      let n = 0;
      for (const u of Object.values(this.data.users || {})) {
        if (u.avatar) { u.avatar = ''; n++; }
      }
      this.data.avReset2026 = true;
      if (n > 0) { this.flush(); console.log(`[accounts] v0.22.45 头像统一重置：清了 ${n} 个用户的头像`); }
    }
  }

  /* ── 落盘 ─────────────────────────────── */
  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (raw && raw.users && raw.accounts) {
        this.data = { ...this.data, ...raw };
        // 名额计数只在第一次升级时初始化：以当时已有的号数为起点，
        // 老号（都拿过赠送）计入已用名额，避免「前 500 个」从零重算。
        // 注意判断来源是 raw 而不是 this.data —— 默认值里已经有 0 了。
        if (!Number.isFinite(raw.signupCount)) {
          this.data.signupCount = Object.keys(this.data.users || {}).length;
        }
      }
      this.data.sessions = this.data.sessions || {};
      this.data.ledger = this.data.ledger || [];
      this.migrateIds();
    } catch { /* 首次启动或文件损坏：用空库，坏文件留一份备份 */ }
  }

  /**
   * 老版本用的是 8 位 ID。升级后统一迁到 6 位，账号 / 会话 / 流水一起换，
   * 玩家不用重新注册，原来的 token 也还能用。
   */
  migrateIds() {
    const old = Object.keys(this.data.users || {}).filter((id) => !DIGITS6.test(id));
    // seq 也矫正：老库里 seq 是从 10000001 起的大数
    let next = ID_BASE;
    for (const id of Object.keys(this.data.users || {})) {
      const n = Number(id);
      if (DIGITS6.test(id) && Number.isInteger(n) && n >= next) next = n + 1;
    }
    this.data.seq = Math.max(ID_BASE, next);
    if (!old.length) return;

    const map = new Map();
    for (const id of old) {
      while (this.data.users[String(this.data.seq)] && this.data.seq <= ID_MAX) this.data.seq++;
      if (this.data.seq > ID_MAX) break;
      map.set(id, String(this.data.seq++));
    }
    for (const [from, to] of map) {
      const u = this.data.users[from];
      delete this.data.users[from];
      u.id = to;
      this.data.users[to] = u;
    }
    for (const [acc, id] of Object.entries(this.data.accounts || {})) {
      if (map.has(id)) this.data.accounts[acc] = map.get(id);
    }
    for (const s of Object.values(this.data.sessions || {})) {
      if (s && map.has(s.id)) s.id = map.get(s.id);
    }
    for (const r of this.data.ledger || []) {
      if (r && map.has(r.id)) r.id = map.get(r.id);
    }
    this.flush();
  }

  save() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 300);
    if (this.timer.unref) this.timer.unref();
  }

  flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.error('[accounts] 落盘失败', e && e.message);
    }
  }

  /* ── 密码 / 会话 ──────────────────────── */
  hash(pass) {
    const salt = crypto.randomBytes(16).toString('hex');
    const h = crypto.scryptSync(String(pass), salt, 32).toString('hex');
    return `scrypt$${salt}$${h}`;
  }

  verify(pass, stored) {
    try {
      const [kind, salt, h] = String(stored || '').split('$');
      if (kind !== 'scrypt' || !salt || !h) return false;
      const got = crypto.scryptSync(String(pass), salt, 32);
      const want = Buffer.from(h, 'hex');
      return got.length === want.length && crypto.timingSafeEqual(got, want);
    } catch { return false; }
  }

  newSession(id) {
    const token = crypto.randomBytes(24).toString('hex');
    this.data.sessions[token] = { id, exp: Date.now() + SESSION_DAYS * 864e5 };
    // 顺手清掉过期会话，避免无限增长
    const now = Date.now();
    for (const [k, v] of Object.entries(this.data.sessions)) {
      if (!v || v.exp < now) delete this.data.sessions[k];
    }
    this.save();
    return token;
  }

  sessionUser(token) {
    const s = this.data.sessions[String(token || '')];
    if (!s || s.exp < Date.now()) return null;
    return this.data.users[s.id] || null;
  }

  dropSession(token) {
    if (this.data.sessions[token]) {
      delete this.data.sessions[token];
      this.save();
    }
  }

  /** 踢掉某个账号的全部会话（改密码后旧 token 立即作废），返回清掉的条数 */
  dropSessionsOf(id) {
    const uid = String(id);
    let n = 0;
    for (const [k, v] of Object.entries(this.data.sessions || {})) {
      if (v && String(v.id) === uid) { delete this.data.sessions[k]; n++; }
    }
    if (n) this.save();
    return n;
  }

  /**
   * v0.20.93 单点登录：一个账号同时只留一条会话。
   * 登录 / 注册一律走这里 —— 先作废旧 token，再发新 token，
   * 于是「第二台设备登录」等于「第一台设备立刻失效」。
   * （同一台设备的多标签共用同一份 token，不受影响）
   */
  freshSession(id) {
    this.dropSessionsOf(id);
    return this.newSession(id);
  }

  /**
   * v0.20.93：老库里可能一个账号挂着好几条历史会话（升级前多端登录留下的）。
   * 启动时每个账号只留最晚的一条，避免升级后旧设备还能继续用。
   * 返回清掉的多余会话数。
   */
  enforceSingleSession() {
    const best = new Map();   // id → { token, exp }
    for (const [token, s] of Object.entries(this.data.sessions || {})) {
      if (!s) continue;
      const id = String(s.id);
      const cur = best.get(id);
      if (!cur || (s.exp || 0) > (cur.exp || 0)) best.set(id, { token, exp: s.exp || 0 });
    }
    const keep = new Set([...best.values()].map((x) => x.token));
    let n = 0;
    for (const token of Object.keys(this.data.sessions || {})) {
      if (!keep.has(token)) { delete this.data.sessions[token]; n++; }
    }
    if (n) this.save();
    return n;
  }

  /* ── 注册 / 登录 ──────────────────────── */
  /**
   * 随机 6 位游戏 ID：不按注册顺序发号，避免从 ID 看出谁先来、谁是新人。
   * 撞号就重摇；极端情况下（号段快满）退化为顺序号，保证还能注册。
   */
  pickId() {
    const used = this.data.users || {};
    for (let i = 0; i < 200; i++) {
      const id = String(100000 + Math.floor(Math.random() * 900000));
      if (!used[id]) return id;
    }
    for (let n = ID_BASE; n <= ID_MAX; n++) {
      if (!used[String(n)]) return String(n);
    }
    throw new Error('账号太多了，联系开发者清理一下');
  }

  /** 新号赠送名额还剩多少（0 = 已送完，后面注册的号 0 钻） */
  signupInfo() {
    const used = Number(this.data.signupCount) || 0;
    return {
      quota: SIGNUP_QUOTA,
      used,
      left: Math.max(0, SIGNUP_QUOTA - used),
      bonus: SIGNUP_DIAMONDS,
    };
  }

  register({ account, pass, nick, ip = '', secQ = '', secA = '', requireSec = false, avatar = null, device = '' }) {
    // 账号保留输入的大小写，只把「查重 / 登录匹配」统一折成小写，避免 Abc 和 abc 变成两个号
    const raw = String(account == null ? '' : account).trim();
    // v0.22.46：新注册账号限 3–11 位（登录仍兼容最长 20 位的老号）
    if (raw.length > 11) throw new Error('账号最多 11 位');
    const acc = raw;
    const key = acc.toLowerCase();
    const name = clean(nick, 12) || acc;
    if (!/^[A-Za-z0-9_@.\-]{3,11}$/.test(acc)) {
      throw new Error('账号 3–11 位，可用大小写字母、数字和 _ - . @');
    }
    if (!pass || String(pass).length < 6 || String(pass).length > 64) {
      throw new Error('密码 6–64 位，大小写字母、数字、符号都可以');
    }
    if (this.data.accounts[key]) throw new Error('这个账号已经被注册了');
    // v0.21.3：安全问题选填，但「选了问题没填答案」直接拒，避免留下找不回的号
    const q = String(secQ == null ? '' : secQ).trim();
    const a = normAnswer(secA);
    if (q && !SEC_QUESTIONS.includes(q)) throw new Error('安全问题不在可选范围内');
    if (q && (a.length < 1 || a.length > 40)) throw new Error('答案 1–40 个字');
    if (!q && a) throw new Error('请先选一个问题');
    // v0.21.4：玩家注册必须设安全问题（忘了密码只能靠它自助找回）
    if (!q && requireSec) throw new Error('请选一个安全问题（忘记密码时要用）');
    // v0.22.46：同一设备最多注册 3 个账号（设备号来自客户端 hello 上报，持久化在用户档案上）
    const dev = String(device == null ? '' : device).trim();
    if (dev && /^[A-Za-z0-9_-]{8,64}$/.test(dev)) {
      const sameDev = Object.values(this.data.users)
        .filter((u) => u && u.device === dev).length;
      if (sameDev >= 3) throw new Error('同一设备最多注册 3 个账号');
    }

    const id = this.pickId();
    const role = (this.ownerAccount && key === this.ownerAccount) ? 'owner' : 'player';
    // v0.21.1：只有累计前 SIGNUP_QUOTA 个号有初始钻石，之后注册的号 0 钻
    const quotaLeft = Math.max(0, SIGNUP_QUOTA - (Number(this.data.signupCount) || 0));
    // v0.22.62：同一设备只享受一次开号赠送。设备号随账号档案一起落盘，
    // 这台设备上只要已有账号领过赠送，之后再用它注册新号都不再送。
    const devKey = /^[A-Za-z0-9_-]{8,64}$/.test(String(device || '')) ? String(device) : '';
    const devAlreadyBonused = !!devKey && Object.values(this.data.users)
      .some((u) => u && u.device === devKey && (u.signupBonus || 0) > 0);
    const bonus = (quotaLeft > 0 && !devAlreadyBonused) ? SIGNUP_DIAMONDS : 0;
    const user = {
      id,
      account: acc,
      nick: name,
      pass: this.hash(pass),
      avatar: '',
      diamonds: bonus,
      freeRename: true,             // 改名第一次免费，用过就置 false
      role,
      canDist: role === 'owner',
      canCheat: role === 'owner',   // 隐藏功能（透视）授权，只有开发者能给
      distTotal: 0,                 // 已授权分发账号累计转出的钻石用量（仅 canDist 账号有意义）
      createdAt: Date.now(),
      lastLogin: Date.now(),
      wx: null,
      signupBonus: bonus,           // v0.21.1：这个号领到的开号赠送（0 = 名额已满）
      secQ: q || '',                // v0.21.3：安全问题（空 = 没设，不能自助找回）
      secA: q ? this.hash(a) : '',  // 只存哈希
      device: (/^[A-Za-z0-9_-]{8,64}$/.test(String(device || '')) ? String(device) : ''), // v0.22.46：注册设备号（同设备限 3 号用）
    };
    this.data.users[id] = user;
    this.data.accounts[key] = id;
    // v0.22.45：注册头像（必选）。三种来源：
    //   {sys:n}   系统头像第 n 张（前端弹窗点选）
    //   {data}    相册上传的 base64（前端已压到 400KB 内）
    //   缺省/null  老客户端没有选头像 UI，随机分配一张系统头像兜底
    try {
      const av = avatar && typeof avatar === 'object' ? avatar : null;
      if (av && av.data) {
        const m = /^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(av.data));
        if (!m) throw new Error('头像格式不支持');
        const buf = Buffer.from(m[2], 'base64');
        if (buf.length > 400 * 1024) throw new Error('头像不能超过 400KB');
        const ext = m[1] === 'png' ? 'png' : m[1] === 'webp' ? 'webp' : 'jpg';
        const name = `${id}.${ext}`;
        fs.mkdirSync(this.avatarDir, { recursive: true });
        fs.writeFileSync(path.join(this.avatarDir, name), buf);
        user.avatar = `/avatar/${name}?v=${Date.now()}`;
      } else {
        const n = Math.round(Number(av && av.sys) || 0);
        const idx = (n >= 1 && n <= SYS_AVATAR_COUNT)
          ? n
          : 1 + Math.floor(Math.random() * SYS_AVATAR_COUNT);   // 老客户端兜底：随机一张
        user.avatar = sysAvatarPath(idx);
      }
    } catch (e) {
      // 头像异常不拦注册（兜底随机一张），但要在日志里看到
      console.error('[accounts] register avatar fallback:', e.message);
      user.avatar = sysAvatarPath(1 + Math.floor(Math.random() * SYS_AVATAR_COUNT));
    }
    if (bonus > 0) {
      this.data.ledger.push({
        ts: Date.now(), id, delta: bonus, balance: bonus, reason: '新号赠送', by: 'system',
      });
    }
    this.data.signupCount = (Number(this.data.signupCount) || 0) + 1;
    // 注册频次低，直接同步落盘
    this.flush();
    return {
      user,
      token: this.freshSession(id),
      signupBonus: bonus,
      signupLeft: Math.max(0, SIGNUP_QUOTA - this.data.signupCount),
    };
  }

  /* ── 登录防爆破（v0.20.78） ────────────────── */
  _failKey(account) { return clean(account, 20).toLowerCase(); }
  isLocked(account) {
    const f = this.loginFails.get(this._failKey(account));
    if (!f) return false;
    if (f.lockUntil && f.lockUntil <= Date.now()) { this.loginFails.delete(this._failKey(account)); return false; }
    return !!(f.lockUntil && f.lockUntil > Date.now());
  }
  _lockRemainMs(account) {
    const f = this.loginFails.get(this._failKey(account));
    return f && f.lockUntil ? Math.max(0, f.lockUntil - Date.now()) : 0;
  }
  _registerFail(account) {
    const k = this._failKey(account);
    const f = this.loginFails.get(k) || { n: 0, lockUntil: 0 };
    f.n += 1;
    if (f.n >= LOGIN_MAX_FAIL) f.lockUntil = Date.now() + LOGIN_LOCK_MS;
    this.loginFails.set(k, f);
  }
  _clearFail(account) { this.loginFails.delete(this._failKey(account)); }

  login({ account, pass }) {
    if (this.isLocked(account)) {
      const mins = Math.max(1, Math.ceil(this._lockRemainMs(account) / 60000));
      throw new Error(`登录失败次数过多，请 ${mins} 分钟后再试`);
    }
    const key = clean(account, 20).toLowerCase();
    const id = this.data.accounts[key];
    if (!id) { this._registerFail(account); throw new Error('账号或密码不对'); }
    const user = this.data.users[id];
    if (!user || !this.verify(pass, user.pass)) { this._registerFail(account); throw new Error('账号或密码不对'); }
    // DH_OWNER 改了以后，老账号也能被提拔成开发者（账号比较忽略大小写）
    if (this.ownerAccount && String(user.account).toLowerCase() === this.ownerAccount && user.role !== 'owner') {
      user.role = 'owner';
      user.canDist = true;
      user.canCheat = true;
    }
    this._clearFail(account);
    user.lastLogin = Date.now();
    this.save();
    return { user, token: this.freshSession(id) };
  }

  /**
   * 开发者账号兜底：服务启动时若库里没有这个账号就自动开一个。
   * 这样把源码包解压到一台新机器上，开发者账号和密码也是现成的，
   * 不会因为 data/ 被清空而丢掉管理入口。
   *
   * v0.20.48：账号已存在时**不再**拿 DH_PASS / 默认值去覆盖密码。
   * 以前这里是无条件 `user.pass = hash(pass)`，结果开发者在「我的」里改完密码，
   * 下次重启（每次发版都会重启）就被冲回默认值 —— 改了个寂寞，还进不去。
   * 现在只有显式传 `resetPass: true`（启动参数 DH_RESET_OWNER_PASS=1）才重置，
   * 留一个「真忘了密码」的兜底入口。
   */
  ensureOwner(account, pass, { diamonds = 500000, resetPass = false } = {}) {
    const acc = clean(account, 20);
    if (!acc) return null;
    const key = acc.toLowerCase();
    let user = this.byAccount(acc);
    if (!user) {
      const nick = OWNER_NICKS[crypto.randomInt(OWNER_NICKS.length)];
      user = this.register({ account: acc, pass, nick }).user;
      // register 已经给了一份新号赠送（可能因名额用完而为 0），这里只补差额，
      // 保证「余额 = 流水之和」——基数取注册后的实际余额，不写死赠送值
      const base = user.diamonds || 0;
      const extra = Math.max(0, diamonds - base);
      user.diamonds = base + extra;
      if (extra > 0) {
        this.data.ledger.push({
          ts: Date.now(), id: user.id, delta: extra, balance: user.diamonds, reason: '开发者初始钻石', by: 'system',
        });
      }
    } else if (resetPass && !this.verify(pass, user.pass)) {
      // 只有显式要求重置时才按配置改密码（忘了密码的兜底）
      user.pass = this.hash(pass);
    }
    user.role = 'owner';
    user.canDist = true;
    user.canCheat = true;
    // 老版本默认叫「开发者」：换一个随机名，之后可在「我的」里自己改
    if (!user.nick || user.nick === '开发者') {
      user.nick = OWNER_NICKS[crypto.randomInt(OWNER_NICKS.length)];
    }
    this.data.accounts[key] = user.id;
    this.save();
    return user;
  }

  /* ── 查询 ─────────────────────────────── */
  get(id) {
    return this.data.users[String(id)] || null;
  }

  byAccount(account) {
    const id = this.data.accounts[clean(account, 20).toLowerCase()];
    return id ? this.data.users[id] : null;
  }

  /* ── 安全问题找回密码（v0.21.3） ───────────── */
  /** 这个账号设的问题（没设 / 不存在都返回 null） */
  secQuestion(account) {
    const u = this.byAccount(account);
    if (!u || !u.secQ || !u.secA) return null;
    return { account: u.account, q: u.secQ };
  }

  /** 登录后补设 / 更换安全问题：必须验原密码，防止手机被人拿去改 */
  setSecQuestion(id, oldPass, secQ, secA) {
    const u = this.get(id);
    if (!u) throw new Error('请先登录');
    if (!this.verify(String(oldPass == null ? '' : oldPass), u.pass)) throw new Error('密码不对');
    const q = String(secQ == null ? '' : secQ).trim();
    if (!SEC_QUESTIONS.includes(q)) throw new Error('请选择一个安全问题');
    const a = normAnswer(secA);
    if (a.length < 1 || a.length > 40) throw new Error('答案 1–40 个字');
    u.secQ = q;
    u.secA = this.hash(a);
    this.save();
    return u;
  }

  _secFail(key) {
    const f = this.secFails.get(key) || { n: 0, lockUntil: 0 };
    f.n += 1;
    if (f.n >= SEC_MAX_FAIL) { f.lockUntil = Date.now() + SEC_LOCK_MS; f.n = 0; }
    this.secFails.set(key, f);
  }

  /**
   * 用安全问题重置密码。
   * 成功后把这个号的所有会话作废 —— 拿回账号的人必须用新密码重新登录，
   * 顺手解开登录锁定（本来就是本人）。返回用户；失败抛中文错误。
   */
  resetBySecurity({ account, answer, pass }) {
    const key = 'sec:' + clean(account, 20).toLowerCase();
    const now = Date.now();
    const f = this.secFails.get(key);
    if (f && f.lockUntil > now) {
      const mins = Math.max(1, Math.ceil((f.lockUntil - now) / 60000));
      throw new Error(`答案错得太多，请 ${mins} 分钟后再试`);
    }
    const u = this.byAccount(account);
    // 账号不存在 / 没设问题：同一句提示，不额外区分
    if (!u || !u.secQ || !u.secA) {
      this._secFail(key);
      throw new Error('这个账号不能自助找回，请联系管理员重置');
    }
    const a = normAnswer(answer);
    if (!a || !this.verify(a, u.secA)) {
      this._secFail(key);
      throw new Error('答案不对');
    }
    const np = String(pass == null ? '' : pass);
    if (np.length < 6 || np.length > 64) throw new Error('新密码 6–64 位，大小写字母、数字、符号都可以');
    if (this.verify(np, u.pass)) throw new Error('新密码不能和原密码一样');
    u.pass = this.hash(np);
    this.secFails.delete(key);
    this._clearFail(u.account);
    this.dropSessionsOf(u.id);
    this.save();
    return u;
  }

  /** 改密码：先验原密码，再换新的；字符不限，6–64 位 */
  changePass(id, oldPass, newPass) {    const u = this.get(id);
    if (!u) throw new Error('请先登录');
    if (!this.verify(oldPass, u.pass)) throw new Error('原密码不对');
    const np = String(newPass || '');
    if (np.length < 6 || np.length > 64) throw new Error('新密码 6–64 位，大小写字母、数字、符号都可以');
    if (this.verify(np, u.pass)) throw new Error('新密码不能和原密码一样');
    u.pass = this.hash(np);
    this.save();
    return u;
  }

  /** 改名：牌桌上显示的名字 */
  setNick(id, nick) {
    const u = this.get(id);
    if (!u) throw new Error('账号不存在');
    const name = clean(nick, 12);
    if (!name) throw new Error('名字不能为空');
    u.nick = name;
    this.save();
    return u;
  }

  /** 对外可见的用户信息（绝不带 pass） */
  publicUser(u) {
    if (!u) return null;
    return {
      id: u.id,
      account: u.account,
      nick: u.nick,
      avatar: u.avatar,
      diamonds: u.diamonds || 0,
      freeRename: u.freeRename !== false,   // 老库里没这个字段的按「还没用过」算
      role: u.role,
      canDist: !!u.canDist,
      canCheat: !!u.canCheat,
      distTotal: u.distTotal || 0,
      createdAt: u.createdAt,
      lastLogin: u.lastLogin,
      // v0.22.41：房主成长值与等级（资料页徽章 / 进度条用）
      growth: u.growth || 0,
      lv: Accounts.ownerLevel(u.growth || 0),
      hasSecQ: !!u.secQ,            // v0.21.3：有没有设安全问题（前端据此提示能否自助找回）
      secQ: u.secQ || '',           // 问题文本本身不敏感，回给前端用于预选
    };
  }

  /* ── v0.22.41：房主成长值 / 等级 ──────────────
   * 口径（房主确认）：成长值只统计「自建房内玩家」的纯消耗（by=spend），
   * 大厅消耗（开房/改名）与玩家间流转（transfer）不算；永不重置。
   * 奖励刻度：每满 1000 钻发一次，费率按「该刻度所属档位」：
   *   ≤3000 段 200 / ≤5000 段 250 / ≤8000 段 300 / ≤12000 段 350 / 之后 400
   * 升档本身不发钻，只切换费率；rewardMark 记「已发到哪个 1000 刻度」。 */
  static ownerRewardForMark(m) {
    if (m <= 3000) return 200;
    if (m <= 5000) return 250;
    if (m <= 8000) return 300;
    if (m <= 12000) return 350;
    return 400;
  }
  static ownerLevel(growth) {
    const g = Number(growth) || 0;
    return g >= 12000 ? 5 : g >= 8000 ? 4 : g >= 5000 ? 3 : g >= 3000 ? 2 : g >= 1000 ? 1 : 0;
  }
  /** 房内纯消耗即时记到房主成长值；跨过 1000 刻度就发奖励钻（走流水，对账照平） */
  creditGrowth(uid, fee) {
    const n = Math.round(Number(fee));
    if (!(n > 0)) return 0;
    const u = this.get(String(uid));
    if (!u) return 0;
    u.growth = (u.growth || 0) + n;
    const mark0 = u.rewardMark || 0;
    let mark = mark0;
    let granted = 0;
    while (u.growth >= mark + 1000) {
      mark += 1000;
      granted += Accounts.ownerRewardForMark(mark);
    }
    if (mark !== mark0) u.rewardMark = mark;
    if (granted > 0) {
      this.addDiamonds(u.id, granted, `房主等级奖励（成长值${u.growth}）`, 'reward');
    } else {
      this.save();
    }
    return granted;
  }

  listUsers() {
    return Object.values(this.data.users)
      .sort((a, b) => (b.lastLogin || 0) - (a.lastLogin || 0))
      .map((u) => this.publicUser(u));
  }

  ledgerOf(id, limit = 30) {
    return this.data.ledger
      .filter((r) => r.id === String(id))
      .slice(-limit)
      .reverse();
  }

  /* ── 钻石 ─────────────────────────────── */
  /**
   * 加减钻石并记账。delta 为负时必须余额足够，否则抛错。
   * 所有钻石流动都必须经过这里，保证「余额 = 流水之和」。
   */
  addDiamonds(id, delta, reason, by = 'system') {
    const u = this.get(id);
    if (!u) throw new Error('账号不存在');
    const d = Math.round(Number(delta));
    if (!Number.isFinite(d) || d === 0) throw new Error('金额不对');
    const next = (u.diamonds || 0) + d;
    if (next < 0) throw new Error('钻石不够');
    u.diamonds = next;
    this.data.ledger.push({
      ts: Date.now(), id: String(id), delta: d, balance: next, reason: clean(reason, 40), by: String(by),
    });
    if (this.data.ledger.length > MAX_LEDGER) {
      this.data.ledger = this.data.ledger.slice(-MAX_LEDGER);
    }
    this.save();
    return u.diamonds;
  }

  /** 转出：只有开发者或被授权的 ID 能发起 */
  transfer(fromId, toId, amount, note = '') {
    const from = this.get(fromId);
    const to = this.get(toId);
    if (!from) throw new Error('发起账号不存在');
    if (!to) throw new Error('对方游戏 ID 不存在');
    if (from.id === to.id) throw new Error('不能转给自己');
    if (from.role !== 'owner' && !from.canDist) throw new Error('没有转出权限');
    const n = Math.round(Number(amount));
    if (!Number.isInteger(n) || n <= 0) throw new Error('数量要是正整数');
    if ((from.diamonds || 0) < n) throw new Error('钻石不够');
    // 流水不写对方 ID，只记「转出 / 转入」，账号之间不做公开索引
    this.addDiamonds(from.id, -n, note || '转出', 'transfer');
    this.addDiamonds(to.id, n, note || '转入', 'transfer');
    // 累计该授权账号的转出用量（开发者本人也能分发，一并计入）
    from.distTotal = (from.distTotal || 0) + n;
    this.save();
    return { from: from.diamonds, to: to.diamonds, distTotal: from.distTotal };
  }

  /* ── 头像 ─────────────────────────────── */
  saveAvatar(id, buf, ext = 'jpg') {
    const u = this.get(id);
    if (!u) throw new Error('账号不存在');
    fs.mkdirSync(this.avatarDir, { recursive: true });
    const name = `${id}.${ext}`;
    fs.writeFileSync(path.join(this.avatarDir, name), buf);
    u.avatar = `/avatar/${name}?v=${Date.now()}`;
    this.save();
    return u.avatar;
  }

  /** v0.22.45：选用系统头像（「我的」里换头像弹窗点选） */
  setSysAvatar(id, n) {
    const u = this.get(id);
    if (!u) throw new Error('账号不存在');
    const idx = Math.round(Number(n));
    if (!(idx >= 1 && idx <= SYS_AVATAR_COUNT)) throw new Error('系统头像编号不对');
    u.avatar = sysAvatarPath(idx);
    this.save();
    return u.avatar;
  }
}

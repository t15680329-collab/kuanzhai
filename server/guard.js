/**
 * 服务端防护层（Anti-DoS）
 * ------------------------------------------------------------------
 * 目标不是「挡住所有攻击」，而是让一张 8 人牌桌的进程在被打时：
 *   ① 不崩：任何非法输入只影响那条连接；
 *   ② 不被吃干：连接数、消息量、建房量、围观人数都有硬上限；
 *   ③ 可追溯：被限流/被拒的记录进 data/security.log，超 2MB 自动滚动。
 *
 * 限流窗口用固定窗口（每 IP 一个计数），比滑动窗口省内存，
 * 代价是窗口边界可能出现 2 倍突发，配合全局熔断可接受。
 */

import fs from 'node:fs';
import path from 'node:path';

const MAX_IP_LEN = 64;

/** 取真实来源 IP：网关会带 x-forwarded-for，直连时退回 socket 地址 */
export function clientIp(req) {
  const h = (req && req.headers) || {};
  const xff = String(h['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  const real = String(h['x-real-ip'] || '').trim();
  const sock = (req && req.socket && req.socket.remoteAddress) || '';
  // 顺序：网关写入的 x-real-ip → XFF 最后一段（离服务最近的一跳）→ XFF 第一段 → socket。
  // 线上实测：网关会重写这两个头，客户端自己伪造的值不会保留。
  const raw = real || xff[xff.length - 1] || xff[0] || sock;
  const ip = raw.replace(/^::ffff:/, '').replace(/^\[|\]$/g, '');
  return (ip || 'unknown').slice(0, MAX_IP_LEN);
}

/** v0.20.96：网络标识，用于「同一出口不能同桌」。
 *  IPv4 原样返回；IPv6 归并到 /64（同一网段通常就是同一个宽带/热点） */
export function netKey(ip) {
  const s = String(ip || '').trim();
  if (!s) return '';
  if (!s.includes(':')) return s;
  return s.split('%')[0].split(':').slice(0, 4).join(':').toLowerCase();
}

/** v0.20.96：两点球面距离（米），Haversine */
export function distanceMeters(a, b) {
  if (!a || !b) return Infinity;
  const R = 6371000;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** v0.20.96：定位是否还新鲜可用（默认 10 分钟内、精度不超过 1km） */
export function freshLoc(loc, ttlMs = 10 * 60 * 1000) {
  if (!loc || !Number.isFinite(loc.lat) || !Number.isFinite(loc.lng)) return null;
  if (Date.now() - (Number(loc.at) || 0) > ttlMs) return null;
  if (Number(loc.acc) > 1000) return null;
  return loc;
}

/** 固定窗口计数器，key 数量有上限，防止被随机 key 打爆内存 */
export class FixedWindow {
  constructor({ windowMs, max, maxKeys = 20000 }) {
    this.windowMs = windowMs;
    this.max = max;
    this.maxKeys = maxKeys;
    this.map = new Map();
    this.dropped = 0;
  }

  hit(key, cost = 1, now = Date.now()) {
    let e = this.map.get(key);
    if (!e || now - e.start >= this.windowMs) {
      if (!e && this.map.size >= this.maxKeys) this.sweep(now, true);
      e = { start: now, n: 0 };
      this.map.set(key, e);
    }
    e.n += cost;
    if (e.n > this.max) {
      const retryAfter = Math.max(1, Math.ceil((e.start + this.windowMs - now) / 1000));
      return { ok: false, retryAfter, count: e.n };
    }
    return { ok: true, retryAfter: 0, count: e.n };
  }

  /** 清过期；force=true 时若仍超上限，按开始时间淘汰最旧的一批 */
  sweep(now = Date.now(), force = false) {
    for (const [k, e] of this.map) {
      if (now - e.start >= this.windowMs) this.map.delete(k);
    }
    if (force && this.map.size >= this.maxKeys) {
      const drop = Math.ceil(this.maxKeys * 0.1);
      let i = 0;
      for (const k of this.map.keys()) {
        if (i++ >= drop) break;
        this.map.delete(k);
        this.dropped++;
      }
    }
    return this.map.size;
  }
}

/** 连接配额：单 IP 与全局双上限，避免一个人开一万条连接 */
export class ConnQuota {
  constructor({ perIp = 12, total = 600 } = {}) {
    this.perIp = perIp;
    this.total = total;
    this.byIp = new Map();
    this.count = 0;
  }

  acquire(ip) {
    if (this.count >= this.total) return { ok: false, reason: 'TOTAL_FULL' };
    const n = this.byIp.get(ip) || 0;
    if (n >= this.perIp) return { ok: false, reason: 'IP_FULL' };
    this.byIp.set(ip, n + 1);
    this.count++;
    return { ok: true };
  }

  release(ip) {
    const n = this.byIp.get(ip) || 0;
    if (n <= 1) this.byIp.delete(ip);
    else this.byIp.set(ip, n - 1);
    if (this.count > 0) this.count--;
  }

  stats() {
    return { connections: this.count, ips: this.byIp.size, perIp: this.perIp, total: this.total };
  }
}

/* ── 消息清洗 ────────────────────────────────
 * 只做「形状 + 长度」校验，不校验业务合法性（那是各 handler 的事），
 * 目的是让超长昵称、超长 token、数组型 message 这类畸形输入进不了业务层。
 */

export const MAX_NAME = 32;
export const MAX_TOKEN = 64;
const ROOM_RE = /^\d{1,8}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function sanitizeMsg(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return null;
  if (typeof msg.t !== 'string' || msg.t.length === 0 || msg.t.length > 24) return null;

  const out = { t: msg.t };

  if (msg.name !== undefined) {
    if (typeof msg.name !== 'string') return null;
    out.name = msg.name.slice(0, MAX_NAME);
  }
  if (msg.room !== undefined) {
    const room = String(msg.room);
    if (!ROOM_RE.test(room)) return null;
    out.room = room;
  }
  /* v0.22.60：跨房审核带入申请（房主在 A 房审自己名下 B 房的申请）。
     以前白名单漏了这个字段，前端发的 roomId 被静默丢掉，服务端退回「审本房」，
     于是永远报「这笔申请已经不在了」——表现就是多桌时「同意」点不上。
     和 msg.room 一样只收纯数字房号，绝不裸传。 */
  if (msg.roomId !== undefined) {
    const rid = String(msg.roomId);
    if (!ROOM_RE.test(rid)) return null;
    out.roomId = rid;
  }
  /* v0.22.60：开房时选的「最低可玩簸簸倍数」，同样曾被白名单静默丢弃，
     导致开房页拉条选的档位从来没生效、一直按默认 ×8。只收 Room 认得的值。 */
  if (msg.floorMult !== undefined) {
    const n = Number(msg.floorMult);
    if (!Number.isInteger(n) || ![4, 6, 8, 10, 12, 16].includes(n)) return null;
    out.floorMult = n;
  }
  /* v0.22.67：地九王开关（开房页按钮），只收布尔，默认开由 Room 兜底 */
  if (msg.dijiuOn !== undefined) out.dijiuOn = !!msg.dijiuOn;
  if (msg.token !== undefined) {
    const token = String(msg.token).slice(0, MAX_TOKEN);
    // 令牌只用于找回座位，格式不对就当没带，不直接拒绝（老客户端兼容）
    if (TOKEN_RE.test(token)) out.token = token;
  }
  if (msg.seat !== undefined) {
    const seat = Number(msg.seat);
    if (!Number.isInteger(seat) || seat < -1 || seat > 8) return null;
    out.seat = seat;
  }
  if (msg.index !== undefined) {
    const i = Number(msg.index);
    if (!Number.isInteger(i) || i < 0 || i > 32) return null;
    out.index = i;
  }
  if (msg.amount !== undefined) {
    const a = Number(msg.amount);
    if (!Number.isFinite(a) || a < 0 || a > 1e8) return null;
    out.amount = a;
  }
  if (msg.ante !== undefined) out.ante = Number(msg.ante);
  if (msg.seats !== undefined) out.seats = Number(msg.seats);
  if (msg.durationMin !== undefined) out.durationMin = Number(msg.durationMin);
  // v0.20.97：开房人勾选的三项防串通开关
  if (msg.fairIp !== undefined) out.fairIp = !!msg.fairIp;
  if (msg.fairDev !== undefined) out.fairDev = !!msg.fairDev;
  if (msg.fairGeo !== undefined) out.fairGeo = !!msg.fairGeo;
  if (msg.action !== undefined) {
    if (typeof msg.action !== 'string' || msg.action.length > 16) return null;
    out.action = msg.action;
  }
  if (msg.key !== undefined) {
    if (typeof msg.key !== 'string' || msg.key.length > 128) return null;
    out.key = msg.key;
  }
  /* v0.20.96：设备标识（同一台设备多个账号不能同桌） */
  if (msg.dev !== undefined) {
    const dev = String(msg.dev);
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(dev)) return null;
    out.dev = dev;
  }
  /* v0.20.96：定位（相距太近不能同桌）；acc 是精度（米），超出就当没给 */
  if (msg.lat !== undefined || msg.lng !== undefined) {
    const lat = Number(msg.lat);
    const lng = Number(msg.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    out.lat = lat;
    out.lng = lng;
    const acc = Number(msg.acc);
    out.acc = Number.isFinite(acc) ? Math.max(0, Math.min(100000, acc)) : 0;
  }
  if (msg.approve !== undefined) out.approve = !!msg.approve;
  if (msg.on !== undefined) out.on = !!msg.on;
  /* 离桌 / 表情：cancel 撤回保位，emo 是表情 id（白名单在 room 里再校验一次） */
  if (msg.cancel !== undefined) out.cancel = !!msg.cancel;
  if (msg.emo !== undefined) {
    if (typeof msg.emo !== 'string' || msg.emo.length > 16) return null;
    out.emo = msg.emo;
  }
  /* 账号体系字段：长度都卡死，避免超长串撑爆内存 */
  if (msg.account !== undefined) {
    if (typeof msg.account !== 'string' || msg.account.length > 20) return null;
    out.account = msg.account;
  }
  if (msg.pass !== undefined) {
    if (typeof msg.pass !== 'string' || msg.pass.length > 64) return null;
    out.pass = msg.pass;
  }
  if (msg.oldPass !== undefined) {
    if (typeof msg.oldPass !== 'string' || msg.oldPass.length > 64) return null;
    out.oldPass = msg.oldPass;
  }
  /* v0.21.3：安全问题与答案（问题 40 字以内、答案 40 字以内） */
  if (msg.secQ !== undefined) {
    if (typeof msg.secQ !== 'string' || msg.secQ.length > 40) return null;
    out.secQ = msg.secQ;
  }
  if (msg.secA !== undefined) {
    if (typeof msg.secA !== 'string' || msg.secA.length > 40) return null;
    out.secA = msg.secA;
  }
  if (msg.answer !== undefined) {
    if (typeof msg.answer !== 'string' || msg.answer.length > 40) return null;
    out.answer = msg.answer;
  }
  if (msg.nick !== undefined) {
    if (typeof msg.nick !== 'string') return null;
    out.nick = msg.nick.slice(0, 12);
  }
  if (msg.to !== undefined) {
    if (!/^\d{1,12}$/.test(String(msg.to))) return null;
    out.to = String(msg.to);
  }
  /* v0.20.28：强制离座名单按账号取消（uid 同 to 一样只收数字 ID） */
  if (msg.uid !== undefined) {
    if (!/^\d{1,12}$/.test(String(msg.uid))) return null;
    out.uid = String(msg.uid);
  }
  if (msg.note !== undefined) {
    if (typeof msg.note !== 'string' || msg.note.length > 40) return null;
    out.note = msg.note;
  }
  if (msg.data !== undefined) {
    if (typeof msg.data !== 'string' || msg.data.length > 700000) return null;
    out.data = msg.data;
  }
  /* v0.22.45：注册/换头像的 avatar——{sys:编号} 或 {data:base64}，形状校验，业务校验在 handler */
  if (msg.avatar !== undefined) {
    const a = msg.avatar;
    if (!a || typeof a !== 'object' || Array.isArray(a)) return null;
    if (a.sys !== undefined) {
      const n = Number(a.sys);
      if (!Number.isInteger(n) || n < 1 || n > 1000) return null;
      out.avatar = { sys: n };
    } else if (a.data !== undefined) {
      if (typeof a.data !== 'string' || a.data.length > 700000) return null;
      out.avatar = { data: a.data };
    } else return null;
  }
  /* v0.22.45：setAvatar 直接选系统头像（{t:'setAvatar', sys:n}） */
  if (msg.sys !== undefined) {
    const n = Number(msg.sys);
    if (!Number.isInteger(n) || n < 1 || n > 1000) return null;
    out.sys = n;
  }
  if (msg.handNo !== undefined) {
    const h = Number(msg.handNo);
    if (!Number.isInteger(h) || h < 0 || h > 1e6) return null;
    out.handNo = h;
  }
  if (msg.cards !== undefined) {
    // 定牌：可以只定第三张（1 张），也可以连第四张一起定（2 张）
    if (!Array.isArray(msg.cards) || msg.cards.length < 1 || msg.cards.length > 2) return null;
    if (msg.cards.some((c) => typeof c !== 'string' || c.length > 8)) return null;
    out.cards = msg.cards.slice(0, 2);
  }
  return out;
}

/* ── 安全日志 ────────────────────────────────
 * 缓冲 1 秒批量落盘；单文件超 2MB 滚动为 .1，最多留两份。
 * 同类事件每秒最多记 20 条，防止攻击本身把磁盘写满。
 */

export class SecurityLog {
  constructor(file, { maxBytes = 2 * 1024 * 1024, flushMs = 1000 } = {}) {
    this.file = file;
    this.maxBytes = maxBytes;
    this.buf = [];
    this.flushMs = flushMs;
    this.timer = null;
    this.rate = new Map();
  }

  write(event, detail = {}) {
    const now = Date.now();
    const bucket = Math.floor(now / 1000);
    const key = event + ':' + bucket;
    if ((this.rate.get(key) || 0) >= 20) return;
    this.rate.set(key, (this.rate.get(key) || 0) + 1);
    if (this.rate.size > 200) this.rate.clear();

    this.buf.push(JSON.stringify({ ts: new Date(now).toISOString(), event, ...detail }));
    if (this.buf.length > 500) this.buf = this.buf.slice(-500);
    this.schedule();
  }

  schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, this.flushMs);
    if (this.timer.unref) this.timer.unref();
  }

  flush() {
    if (!this.buf.length) return;
    const lines = this.buf.join('\n') + '\n';
    this.buf = [];
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      let size = 0;
      try { size = fs.statSync(this.file).size; } catch { size = 0; }
      if (size + lines.length > this.maxBytes) {
        try { fs.renameSync(this.file, this.file + '.1'); } catch { /* 首次或占用 */ }
      }
      fs.appendFileSync(this.file, lines);
    } catch { /* 日志失败不能影响主流程 */ }
  }
}

/** 把回调包成「永不抛」的定时器，用于心跳/回收这类后台任务 */
export function safeInterval(fn, ms, label = 'timer') {
  const wrapped = () => {
    try { fn(); } catch (e) { console.error('[' + label + ']', e && e.message); }
  };
  const t = setInterval(wrapped, ms);
  if (t.unref) t.unref();
  return t;
}

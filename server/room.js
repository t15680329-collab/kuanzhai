/**
 * 房间服务（桌服 Actor）
 * ------------------------------------------------------------------
 * 一个房间 = 一个串行执行单元。所有玩家动作都进同一个队列，
 * 不会出现两个请求同时改一张牌桌的情况 —— 这是棋牌服最关键的
 * 并发模型，比加锁简单得多，也更容易排查问题。
 *
 * 职责：开房/房主、等待室、座位管理、AI 补位、手动开局、
 *       超时托管、断线重连、离场留档、状态广播、
 *       牌局限时、带入申请审核。
 *
 * 与早期版本的区别：
 *   ① 房主建房时定「底皮/圈芒」「最低买入」「牌局时长」；
 *   ② 房号 4 位随机数字；
 *   ③ 玩家上桌的钱要房主手动同意才到账。
 */

import { Game, PHASE, SPLIT_SECONDS, BROKE_SECONDS, TURN_SECONDS, SCRATCH_SECONDS } from '../engine/game.js';
import { decide } from '../engine/ai.js';
import { peekPayloadFor } from './peekview.js';
import { netKey, distanceMeters, freshLoc } from './guard.js';

/** v0.22.57：开手演出宽限——小金币飞进下注胶囊（币声）→ 份子停留 1.4s →
    大金币归拢芒果池（收拢音）→ 0.3s 后底皮小金币进胶囊、皮池直接显总额。
    全程约 3.5 秒 + 网络余量。演出期间全桌不能行动：真人读秒从动画结束才起表，
    机器人也等动画播完再出手。 */
const HAND_FX_MS = 3900;

const AI_NAMES = ['幺鸡', '三娃', '李嬢嬢', '王大爷', '赵四', '钱多多', '孙二娃', '周小妹'];
let tokenSeq = 0;

/** 互动表情白名单：客户端只能发这几个 id，免得被塞任意字符串广播出去 */
export const EMOTE_IDS = new Set([
  // v0.20.17/18：互动道具（点别人头像弹出），雪碧图序列帧动画
  'bingtong', 'cishuiqiang', 'dao', 'dapao',
  'daquan', 'diujidan', 'jiangbei', 'shoulei', 'tuoxie', 'zhuaji',
  // v0.20.16：点「我」头像弹的序列帧表情（雪碧图动画），x1~x20
  ...Array.from({ length: 20 }, (_, i) => 'x' + (i + 1)),
]);

/** v0.20.19：免费表情白名单——我的表情盘里的 x1~x20 不扣钻，
    点别人头像的互动道具仍按 PRICE.emote 收费。 */
export const FREE_EMOTE_IDS = new Set(
  Array.from({ length: 20 }, (_, i) => 'x' + (i + 1)),
);

/** 生一个不可猜的座位令牌 */
export function newToken() {
  return 'tk' + (++tokenSeq).toString(36) + Math.random().toString(36).slice(2, 9);
}

const cleanName = (n, i = 0) => String(n || '').trim().slice(0, 8) || `玩家${i + 1}`;

/* ── 房主可选的档位（服务端白名单，前端只发档位号） ── */

/** 底皮 / 圈芒 / 最低一次带入 */
export const STAKES = [
  { ante: 1, handMango: 2, minBuyIn: 50, label: '1/2' },
  { ante: 2, handMango: 5, minBuyIn: 100, label: '2/5' },
  { ante: 5, handMango: 10, minBuyIn: 250, label: '5/10' },
  { ante: 10, handMango: 20, minBuyIn: 500, label: '10/20' },
  { ante: 20, handMango: 40, minBuyIn: 1000, label: '20/40' },
  { ante: 50, handMango: 100, minBuyIn: 2500, label: '50/100' },
  { ante: 100, handMango: 200, minBuyIn: 5000, label: '100/200' },
];

/** 牌局时长（分钟），最长 2 小时 */
export const DURATIONS = [30, 60, 90, 120];

/** 一桌最多站多少人围观（防止开一堆连接挤爆房间） */
const WATCH_LIMIT = 24;

/** v0.22.88：带入申请审核倒计时——提交后 3 分钟没人审就自动作废（不挂账），
 *  玩家随时可以重新提交。 */
const BUYIN_REVIEW_MS = 3 * 60 * 1000;

/** v0.22.88：开局前「占座」倒计时——入座后不点带入只给 15 秒，
 *  到点强制起立，可重新入座重新占座；点了带入按钮才进入 180 秒留座。 */
const SIT_HOLD_SECONDS = 15;

/**
 * 防串通阈值：两个账号定位相距小于这个距离（米）就不许同桌。
 * v0.20.97：500 → 100，只拦「同一屋子」级别，室外相邻也不会误伤。
 */
const NEAR_METERS = 100;

/**
 * v0.20.97：防串通改成「按桌生效」，由开房人在开房页逐项勾选。
 * 三个开关都关（默认）时完全不介入落座；老客户端不带字段也等于全关。
 */

/* ── 收尾节奏 ─────────────────────────────── */
/** 正常两手之间的间隔（留时间看结算；v0.20.31：6.3s → 3s） */
const NEXT_HAND_MS = 3000;
/** 比牌亮牌的手：牌面展示在通用间隔上单独再加 1.3s（v0.20.31：0.7s → 1.3s） */
const SHOWDOWN_EXTRA_MS = 1300;
/** 时间到、但芒果池还没抢走：加时手的间隔，紧凑一点 */
const OVERTIME_NEXT_MS = 3000;
/** 加时最多再打多少手 / 多久。
 *  v0.20.91：原来 12 手 / 15 分钟——时间到后芒果池还没人抢走，最多再加时这么点就强行收摊，
 *  实际运营里太早打断牌局（一桌人正打得热乎，突然因为时间到结束）。
 *  现在放宽到 200 手 / 6 小时，等同于「不加限制」，只留一根防死循环的保险丝：
 *  正常牌局永远碰不到，真碰上了也不会让房间一直挂着不释放。 */
export const OVERTIME_MAX_HANDS = 200;
export const OVERTIME_MAX_MS = 6 * 60 * 60 * 1000;
/** 整场结束后，战绩弹窗停留多久自动关房 */
export const CLOSE_DELAY_MS = 20000;

export function findStake(ante) {
  return STAKES.find((s) => s.ante === Number(ante)) || null;
}

/* ── v0.22.99：行动流水攒批写盘 ──────────────
 * act() 只把行推进内存队列（零磁盘等待），1.5 秒后或停机时一次性 appendFileSync。
 * 停机路径（SIGTERM/fatal）必须走 actLogFlushSync() 同步冲账，进程一退异步就不跑了。
 * 格式与 v0.22.98 的逐条落盘完全一致，核对工具不受影响。 */
const ACTLOG_PATH = '/opt/dingerhuang/data/actions.log';
const actLogBuf = [];
let actLogTimer = null;
function actLog(line) {
  try { actLogBuf.push(line); } catch { /* 内存兜不住就丢日志，不丢牌局 */ }
  if (!actLogTimer) actLogTimer = setTimeout(actLogFlush, 1500);
}
function actLogFlush() {
  actLogTimer = null;
  if (!actLogBuf.length) return;
  const fs = process.getBuiltinModule('node:fs');
  const lines = actLogBuf.splice(0);
  try { fs.appendFileSync(ACTLOG_PATH, lines.join('')); } catch { /* 日志失败不影响牌局 */ }
}
export function actLogFlushSync() {
  if (actLogTimer) { clearTimeout(actLogTimer); actLogTimer = null; }
  if (!actLogBuf.length) return;
  const fs = process.getBuiltinModule('node:fs');
  const lines = actLogBuf.splice(0);
  try { fs.appendFileSync(ACTLOG_PATH, lines.join('')); } catch { /* 日志失败不影响牌局 */ }
}

export class Room {
  constructor(id, {
    ante = 10,
    handMango = 0,
    minBuyIn = 0,
    seatCount = 8,
    ownerSeat = null,
    ownerUid = '',
    ownerNick = '',
    createdAt = Date.now(),
    durationMin = 60,
    fairIp = false,
    fairDev = false,
    fairGeo = false,
    floorMult = 8,
    dijiuOn = true,
  } = {}) {
    this.id = id;
    // v0.20.97：本桌启用的防串通规则（开房人勾选），逐项生效
    this.fair = { ip: !!fairIp, dev: !!fairDev, geo: !!fairGeo };
    // v0.22.67：本桌是否启用「地九王」（2+9 = 地王）。默认开；关掉时按 1 点散牌算。
    this.dijiuOn = dijiuOn !== false;
    this.ante = ante;
    this.handMango = Number(handMango) > 0 ? Number(handMango) : ante * 2;
    // 最低一次带入；同时是引擎里「一次添簸」的下限
    this.minBuyIn = Number(minBuyIn) > 0 ? Number(minBuyIn) : ante * 50;
    this.buyIn = this.minBuyIn;
    this.cap = this.minBuyIn;
    // 房主上桌的默认簸簸：4 × 最低买入
    this.startStack = this.minBuyIn * 4;
    // v0.22.39：最低可玩簸簸倍数——停发门槛 = 底皮 × n（开房页拉条，白名单 4/6/8/10/12/16）
    this.floorMult = [4, 6, 8, 10, 12, 16].includes(Number(floorMult)) ? Number(floorMult) : 8;
    // 机器人入座带入 = 当前牌局的起步金额（最低带入），跟真人上桌的口径一致
    this.botStack = this.minBuyIn;
    // v0.20.37：4 人桌已废弃，一律 8 人桌（v0.22.91 确认：线上 4 人房存档已清零、
    // 测试脚本全部走 8 人桌，4 人档彻底移除；seatCount 入参保留只为兼容旧调用签名）。
    this.seatCount = 8;
    this.ownerSeat = ownerSeat;
    // v0.20.28：开房人锁定——房间归开房账号所有，房主中途离房也不换人，
    // 直到房间倒计时结束整桌解散；开房人回来坐下即接管房主位。
    this.ownerUid = String(ownerUid || '');
    this.ownerNick = String(ownerNick || '');
    // 强制离座黑名单：uid -> 昵称。被标记的人本手结算后起立，
    // 且在本房间任何座位都坐不下，直到房主取消。
    this.forceOut = new Map();
    this.createdAt = createdAt;
    this.durationMin = DURATIONS.includes(Number(durationMin)) ? Number(durationMin) : 60;

    this.slots = Array.from({ length: this.seatCount }, (_, i) => ({
      seat: i,
      token: null,
      name: '',               // 空位就是空位，只有坐上人/开了机器人才有名字
      ws: null,
      ready: false,
      stack: 0,               // 上桌的钱：房主同意带入后才有
      isAI: true,
      connected: false,
      offlineAt: 0,
      satAt: 0,               // 簸簸 0 坐下时开始留座倒计时
      asking: false,          // 已提交带入申请（v0.22.82 起不停表，留座倒计时照走）
      uid: '',                // 账号 ID：只给玩家信息弹窗显示，不参与牌局
      ip: '',                 // v0.20.96：坐下时的网络标识（同 IP/同网段不能同桌）
      deviceId: '',           // v0.20.96：坐下时的设备标识（同一台设备不能同桌）
      loc: null,              // v0.20.96：坐下时的定位（距离太近不能同桌）
      standUp: '',            // 站起围观：'after' = 这一手打完再让座
      holdLeave: false,       // 保位离桌：这一手结算时开始留座倒计时
      forceOut: false,        // v0.20.28：已被房主标记强制离座（等本手结算执行）
    }));

    this.game = null;
    this.started = false;          // 房主是否已经点过「开始」
    // v0.20.95：进过这桌的账号 ID（坐下 / 围观 / 重连都算），
    // 用于「你的房间」把玩家正在参与的房间也列出来，方便快速回去
    this.participants = new Set();
    // 围观的人：进房先不占座位，自己点空位坐下；坐满了就在这儿等
    // {name, token, ws, connected, at, offlineAt, pendingSeat}
    this.watchers = [];
    // 开发者观察者（上帝视角）：不算围观、不占座位、不影响在线人数与空房回收
    this.gods = [];
    // 机器人开关：默认关，真人房不补机器人；开发者可随时打开
    this.botsEnabled = false;
    this.requests = [];            // 带入申请：{seat, name, amount, at}
    // v0.22.74：离房筹码暂存。玩家「退出牌局」时若座位/围观位上还有剩余簸簸，
    // 按账号（无账号则按房间 token）暂存到这里；重新进这桌坐下时原样带回、免房主审核。
    // 和 standUp→eject→watcher.stack 是同一套体验，只是那条人还在房间里，这条人真正离开。
    this.stash = new Map();        // key 'u:<uid>' | 't:<roomToken>' -> {stack, name, at}
    this.startedAt = 0;            // 开局时间（限时从这里算）
    this.deadline = 0;
    this.timeUp = false;           // 时间到了，但这一手还没打完
    this.ended = false;            // 本桌已经结束
    this.endReason = '';           // 'time' | 'owner'
    this.overtimeHands = 0;        // 时间到后为了抢清芒果池多打的手数
    this.overtimeFor = 0;          // 已经为哪一手安排过加时（防重复计）
    this.handDone = 0;             // 已经处理过收尾的 handNo（pump 幂等）
    this.closeAt = 0;              // 结束后自动关房的时间戳
    this.closed = false;
    this.onClose = null;           // index 注册：从 rooms 里摘掉
    this.onSettle = null;          // v0.22.82：结算时 index 注册的战绩落盘回调
    this.banker = 0;
    this.lastActive = Date.now();    this.botTimer = null;
    this.actTimer = null;
    this.nextTimer = null;
    this.finishDelayTimer = null;  // v0.22.83：最后一手结束后缓 3 秒再收摊
    this.nextAt = 0;               // 下一手原定的开牌时刻（结算期秀牌据此顺延）
    this.tickTimer = null;
    this.dealHold = false;         // 可行动人数不足 2：暂停发牌，等人凑够
    // 行动读秒：turnKey 变了才重新起表（换人 / 换轮 / 加注后重新表态）
    this.turnKey = '';
    this.turnAt = 0;
    // v0.22.51：开手演出宽限（本手第一次起表推迟 HAND_FX_MS）
    this.fxHandNo = 0;
    this.fxGrace = 0;
    // v0.20.25：加时——当前行动者花钻把本手读秒 +30s；一场每人最多 4 次（2/4/8/16 钻）
    this.turnExtMs = 0;
    this.extUses = {};             // seat -> 本手已加时次数
    this.extHandNo = -1;
    this.turnHoldLeft = 0;         // 搓牌暂停行动读秒时记下的剩余毫秒
    this.splitHold = null;         // 搓牌暂停分牌读秒：{ at, splitAt }
    this.queue = Promise.resolve();
  }

  /** 兼容旧字段 */
  get maxSeats() { return this.seatCount; }

  get stakeLabel() {
    const s = STAKES.find((x) => x.ante === this.ante && x.handMango === this.handMango);
    return s ? s.label : `${this.ante}/${this.handMango}`;
  }

  /** 串行化：所有对外动作都从这里进 */
  post(fn) {
    this.queue = this.queue.then(fn).catch((e) => console.error('[room]', e.message));
    return this.queue;
  }

  touch() { this.lastActive = Date.now(); }

  /** 坐着的人类玩家（有令牌、非机器人） */
  humans() {
    return this.slots.filter((s) => s.token && !s.isAI);
  }

  humansOnline() {
    return this.slots.filter((s) => s.token && s.connected).length
      + this.watchers.filter((w) => w.connected).length;
  }

  hasHumanOnline() {
    return this.humansOnline() > 0;
  }

  ownerName() {
    const s = this.ownerSeat != null ? this.slots[this.ownerSeat] : null;
    if (s && s.token) return s.name;
    // v0.20.28：房主在围观席/不在场时，结算页标题仍显示开房人的名字
    return this.ownerNick || '';
  }

  /* ── 开房人锁定（v0.20.28）────────────────
   * 权限双轨：坐在 ownerSeat 上的是房主，开房账号（ownerUid）不管坐没坐下都是房主。 */
  isOpenerUid(uid) {
    return !!uid && !!this.ownerUid && String(uid) === this.ownerUid;
  }

  connIsOwner(ws) {
    if (!ws) return false;
    if (ws.seat != null && ws.seat >= 0 && ws.seat === this.ownerSeat) return true;
    return this.isOpenerUid(ws.userId);
  }

  /* ── 入座 / 离开 ─────────────────────────── */

  join(name, ws, token) {
    this.touch();
    // v0.20.95：谁进过这桌都记下来（坐下、围观、断线重连），供「你的房间」检索
    if (ws && ws.userId) this.participants.add(String(ws.userId));

    // 1) 断线重连：token 命中直接回原座位（或回围观位）
    if (token) {
      const s = this.slots.find((x) => x.token === token);
      if (s) {
        s.ws = ws;
        s.connected = true;
        s.offlineAt = 0;
        this.touch();
        return {
          seat: s.seat, token: s.token, reconnected: true, watching: false,
          isOwner: s.seat === this.ownerSeat,
        };
      }
      const w = this.watchers.find((x) => x.token === token);
      if (w) {
        w.ws = ws;
        w.connected = true;
        w.offlineAt = 0;
        this.touch();
        return {
          seat: -1, token, reconnected: true, watching: true, isOwner: false,
          pendingSeat: w.pendingSeat ?? null,
        };
      }
    }

    // v0.22.85：换设备登录同一账号 —— 新设备上没有这个房间的 token，
    // 按登录 uid 找回座位：座位当前离线（旧设备已退出/掉线）就直接认座，
    // 换发新 token（旧 token 作废，防双开）；旧连接还挂在座位上则不抢，
    // 按普通围观进房。
    if (ws && ws.userId) {
      const uidStr = String(ws.userId);
      const s = this.slots.find((x) => x.token && String(x.uid || '') === uidStr);
      if (s && !this.forceOut.has(uidStr)
          && !(s.ws && s.ws !== ws && s.ws.readyState === 1)) {
        const oldWs = s.ws;
        if (oldWs && oldWs !== ws) {
          oldWs.seat = -1;   // 旧连接降级：防它断开时按旧座位号把座位误标掉线
          this.send(oldWs, { t: 'kicked', msg: '你的账号在其他设备登录，已切回登录页' });
        }
        s.ws = ws;
        s.connected = true;
        s.offlineAt = 0;
        s.token = newToken();
        this.touch();
        return {
          seat: s.seat, token: s.token, reconnected: true, watching: false,
          isOwner: s.seat === this.ownerSeat || this.isOpenerUid(uidStr),
        };
      }
    }

    // 2) 新进房的人：先站边上看，自己点空位坐下（坐满了就围观等座）
    const live = this.watchers.filter((x) => x.connected).length;
    if (live >= WATCH_LIMIT) throw new Error('围观的人太多了，等会儿再来');

    // v0.22.74：认领上次「退出牌局」时暂存的簸簸，挂在围观位上。
    // 之后点空位坐下，seatWatcher 会用这份 w.stack 原样上桌且 marking=false（免审核）。
    const carry = this.takeStash(ws && ws.userId, token);
    const watcher = {
      name: cleanName(name, this.watchers.length),
      token: newToken(),
      ws,
      connected: true,
      at: Date.now(),
      offlineAt: 0,
      pendingSeat: null,
      stack: carry,
    };
    this.watchers.push(watcher);
    this.touch();
    return {
      seat: -1, token: watcher.token, reconnected: false, watching: true,
      isOwner: false, pendingSeat: null,
    };
  }

  /** 改座位上的显示名（改名后立刻生效） */
  rename(seat, name) {
    const n = cleanName(name);
    const sl = this.slots[seat];
    if (!sl) return;
    sl.name = n;
    const p = this.game && this.game.seats && this.game.seats[seat];
    if (p) p.name = n;
    const me = this.requests.find((r) => r.seat === seat);
    if (me) me.name = n;
    this.touch();
  }

  /**
   * 围观者自己挑座位坐下。
   * 牌局正打到一半时先挂起（pendingSeat），等这一手结算完再落座——
   * 不会在别人下注下到一半的时候把机器人换成人。
   */
  /**
   * v0.20.97 防串通：按本桌开关逐项判定，只和「已经坐在座位上的人」比（围观不算同桌）。
   * 三项都关时直接放行；拿不到定位时只跳过距离这一条，不阻塞落座。
   */
  assertCanSit(ws, seat) {
    const f = this.fair || {};
    if (!f.ip && !f.dev && !f.geo) return;   // 本桌没勾任何规则
    if (!ws || !ws.userId) return;
    const myIp = f.ip ? netKey(ws.ip) : '';
    const myDev = f.dev ? String(ws.deviceId || '').trim() : '';
    const myLoc = f.geo ? freshLoc(ws.loc) : null;
    for (const s of this.slots) {
      if (s.seat === seat || !s.token) continue;
      if (f.ip) {
        const oIp = netKey(s.ip || (s.ws && s.ws.ip));
        if (myIp && oIp && myIp === oIp) {
          throw new Error('房主开启了「同网络禁同桌」，你和桌上玩家在同一网络，换用流量再试');
        }
      }
      if (f.dev) {
        const oDev = String(s.deviceId || (s.ws && s.ws.deviceId) || '').trim();
        if (myDev && oDev && myDev === oDev) {
          throw new Error('房主开启了「同设备禁同桌」，这台设备上的另一个账号已经在这桌了');
        }
      }
      if (f.geo) {
        const oLoc = freshLoc(s.loc || (s.ws && s.ws.loc));
        if (myLoc && oLoc && distanceMeters(myLoc, oLoc) < NEAR_METERS) {
          throw new Error(`房主开启了「距离限制」，你和桌上玩家相距不到 ${NEAR_METERS} 米`);
        }
      }
    }
  }

  sit(ws, seat) {
    if (ws && ws.userId) this.participants.add(String(ws.userId));
    const w = this.watchers.find((x) => x.ws === ws);
    if (!w) throw new Error('你已经在座位上了');
    if (this.ended) throw new Error('本桌已经结束了');
    const n = Number(seat);
    if (!Number.isInteger(n) || n < 0 || n >= this.seatCount) throw new Error('没有这个座位');
    if (this.slots[n].token) throw new Error('这个位置已经有人了');
    // v0.20.28：被房主强制离座的人，在这个房间的任何座位都坐不下
    const banUid = w.ws && w.ws.userId;
    if (banUid && this.forceOut.has(banUid)) {
      throw new Error('房主已将你强制离座，取消前无法落座');
    }
    // v0.20.96：同网络 / 同设备 / 距离太近 都不能同桌
    this.assertCanSit(ws, n);

    if (this.isPlaying()) {
      w.pendingSeat = n;
      this.broadcast();
      this.touch();
      return { seat: n, pending: true };
    }
    this.watchers.splice(this.watchers.indexOf(w), 1);
    this.seatWatcher(w, n);
    this.broadcast();
    return { seat: n, pending: false };
  }

  /** 围观者放弃选座（挂起中的人可以反悔） */
  unsit(ws) {
    const w = this.watchers.find((x) => x.ws === ws);
    if (!w || w.pendingSeat == null) return false;
    w.pendingSeat = null;
    this.broadcast();
    return true;
  }

  /**
   * 机器人补位（开发者开关）。
   * 只在「这一手没在打」的时候跑：把没人的座位按开关填成机器人或者空出来。
   * 机器人的簸簸只在首次入座 / 破产重买时补满，赢了输了按牌局自然走。
   */
  applyBots() {
    const g = this.game;
    // 非「下注/分牌」阶段才算不在手里，可以安全改座位的钱
    const live = !!g && (g.phase === PHASE.BET || g.phase === PHASE.SPLIT);
    for (const s of this.slots) {
      if (s.token) { s.isAI = false; continue; }
      s.isAI = true;
      const p = g ? g.seats[s.seat] : null;

      if (!this.botsEnabled) {
        s.name = '';
        s.stack = 0;
        s.satAt = 0;
        s.asking = false;
        if (p) {
          // 关机器人 = 这位离开：先把这段战绩留档再清空座位。
          // 直接抹掉战绩会把这笔输赢从整桌账上摘走，合计就对不上。
          this.settlePending(s.seat);   // v0.22.102：挂账带入先并账再留档
          if (p.handsTotal > 0 && !p.retiredAt) this.retireSeat(s.seat, 'left');
          p.name = '';
          p.isAI = true;
          p.hold = false;
          p.asking = false;
          p.broke = false;
          p.brokeSince = 0;
          if (!live) {
            p.stack = 0;
            p.buyInTotal = 0;
            p.handsTotal = 0;
            p.away = true;
          }
        }
        continue;
      }

      const needFill = !s.name || !p || p.away || (p.stack < this.ante && !live);
      if (needFill) {
        s.name = AI_NAMES[s.seat % AI_NAMES.length];
        s.stack = this.botStack;
      }
      if (p) {
        p.name = s.name;
        p.isAI = true;
        if (needFill) {
          p.away = false;
          p.joinNext = true;
          // 机器人破产重买：补进去多少算多少带入，战绩接着往下累计。
          // 早先这里把 buyInTotal / handsTotal 清零，机器人每重买一次，
          // 它输掉的钱就从账面上凭空消失，整桌「胜负合计」会越打越偏正。
          const add = Math.max(0, s.stack - (p.stack || 0));
          p.stack = s.stack;
          p.buyInTotal = (p.buyInTotal || 0) + add;
          p.retiredAt = 0;
          p.retiredKey = '';
        }
      }
    }
  }

  /** 开发者开关机器人：牌局正打着就先记下，下一手换牌时生效 */
  setBots(on) {
    this.botsEnabled = !!on;
    if (!this.isPlaying()) this.applyBots();
    this.broadcast();
    this.touch();
    return this.botsEnabled;
  }

  /** 这一手是不是正打着（下注 / 分牌） */
  isPlaying() {
    const g = this.game;
    return !!this.started && !!g && (g.phase === PHASE.BET || g.phase === PHASE.SPLIT);
  }

  /** 把一个围观者落到座位上（开房人回来坐下即接管房主位；无锁定时首位坐下的当房主） */
  seatWatcher(w, seat) {
    const slot = this.slots[seat];
    if (!slot) return;
    // v0.20.28：开房人锁定下，只有开房账号坐下才接房主位；
    // 老房间没有锁定（ownerUid 空）保留「首位坐下的人当房主」。
    const openerBack = this.isOpenerUid((w.ws && w.ws.userId) || w.uid || '');
    const first = this.ownerSeat == null && (openerBack || !this.ownerUid);
    slot.token = w.token;
    slot.name = w.name;
    slot.isAI = false;
    slot.ws = w.ws;
    slot.connected = !!w.connected;
    slot.uid = (w.ws && w.ws.userId) || w.uid || '';
    // v0.20.96：把落座时的网络 / 设备 / 定位记在座位上，掉线后照样能比对
    slot.ip = netKey((w.ws && w.ws.ip) || w.ip || '');
    slot.deviceId = String((w.ws && w.ws.deviceId) || w.deviceId || '').slice(0, 64);
    slot.loc = freshLoc((w.ws && w.ws.loc) || w.loc || null);
    slot.standUp = '';
    slot.holdLeave = false;
    slot.offlineAt = w.connected ? 0 : Date.now();
    // 站起围观再坐回来：把当时带走的簸簸原样还给他；新面孔才是从 0 开始
    const kept = Math.max(0, Math.floor(Number(w.stack) || 0));
    slot.stack = kept;
    w.stack = 0;
    slot.asking = false;
    // v0.22.98：入座时刻人人记下（占座 15 秒从这里起算，不存在起算点为 0）；
    // 房主占座不设时限由弹出循环显式判断，不再靠「不打点」的副作用。
    slot.satAt = Date.now();
    if (first) this.ownerSeat = seat;
    // v0.22.96：等待室也要有每秒 ticker——否则「占座 15 秒到点强制起立」在生产上
    // 永远不生效：ticker 之前只在 beginHand 里启动，没人带入就开不了局，
    // 等待室的弹出循环就是死代码（测试里手动 startTicker 才绿，掩盖了这一点）。
    this.startTicker();

    const p = this.game && this.game.seats[seat];
    if (p) {
      // v0.22.80：战绩就是这个座位的账本，房间结束前一律不清——起立/离房时
      // 簸簸剩多少、打了几手，全记在 p.buyInTotal / p.handsTotal 上。人带钱回来
      // 坐下（kept>0）、且这座位还挂着没结算的手数，就接着这份账本算，不清零。
      // 注意：起立时 vacate 会把 p.isAI 置 true，所以不能用 isAI 判断是不是本人。
      // 全新面孔是 kept=0（没带回筹码）或手数为 0，才开新账本。
      // v0.22.98：续账本按「玩家 uid」锁定（用户口径：不锁座位号、不锁名字）——
      // 离房再回来可能坐了别的位子，按 uid 在其他引擎座位 / 离座留档里找旧账本，
      // 找到就搬过来接着算（带入/手数连续），并把旧座位的账本与同 uid 留档行清掉，
      // 杜绝战绩页两次记账。uid 为空的游客兜底按名字匹配。
      const uid0 = String(slot.uid || '');
      const nm = String(slot.name || '');
      // v0.22.102：座位上挂着别人的旧账本（uid 对不上）绝不继承——
      // 正常情况离座时幽灵账已清（vacate→clearGhostLedger），这里兜底。
      if ((p.handsTotal || 0) > 0 || (p.buyInTotal || 0) > 0) {
        const seatUid = String(p.uid || '');
        if (seatUid && uid0 && seatUid !== uid0) {
          p.stack = 0;
          p.buyInTotal = 0;
          p.handsTotal = 0;
          p.retiredKey = '';
          p.retiredAt = 0;
          p.uid = '';
        }
      }
      const g0 = this.game;
      const sameUid = (q) => (uid0 ? String(q.uid || '') === uid0 : !!nm && !String(q.uid || '') && String(q.name || '') === nm);
      let donor = null;
      if (g0 && !((p.handsTotal || 0) > 0)) {
        const di = this.slots.findIndex((sl) => sl && sl.seat !== seat && g0.seats[sl.seat]
          && (g0.seats[sl.seat].handsTotal || 0) > 0 && sameUid(sl));
        if (di >= 0) donor = g0.seats[this.slots[di].seat];
      }
      const donorRow = (!donor && g0 && Array.isArray(g0.departed))
        ? ([...g0.departed].reverse().find((r) => r && (r.hands || 0) > 0 && sameUid(r)) || null)
        : null;
      const resumeRun = kept > 0 && ((p.handsTotal || 0) > 0 || !!donor || !!donorRow);
      if (!resumeRun && !p.isAI) this.retireSeat(seat, 'left');
      if (resumeRun) {
        if (donor) {
          p.buyInTotal = donor.buyInTotal || 0;
          p.handsTotal = donor.handsTotal || 0;
          donor.buyInTotal = 0;
          donor.handsTotal = 0;
        } else if (donorRow) {
          p.buyInTotal = donorRow.buyIn || 0;
          p.handsTotal = donorRow.hands || 0;
        }
        if (g0 && Array.isArray(g0.departed)) {
          g0.departed = g0.departed.filter((r) => !(r && sameUid(r) && (r.hands || 0) > 0));
        }
      }
      const keptBuyIn = resumeRun ? (p.buyInTotal || 0) : slot.stack;
      const keptHands = resumeRun ? (p.handsTotal || 0) : 0;
      p.name = slot.name;
      p.isAI = false;
      p.stack = slot.stack;
      p.buyInTotal = keptBuyIn;
      p.handsTotal = keptHands;
      p.uid = uid0;   // v0.22.102：账本记主人，座位换人也换不掉别人账本
      p.retiredAt = 0;
      p.retiredKey = '';
      p.away = false;
      p.broke = slot.stack < this.holdFloor();
      p.brokeSince = p.broke ? Date.now() : 0;   // 达标入住不背旧表，broke 才起算
      p.hold = slot.stack < this.holdFloor();   // 还没带入，占着位子
      p.asking = false;
      p.joinNext = true;
    }
    this.send(w.ws, {
      t: 'seated', seat, token: w.token, roomId: this.id, owner: first,
    });
    // 连接上的座位号也要跟着换，否则之后的下注/带入还是指向 -1
    if (w.ws) { w.ws.seat = seat; w.ws.room = this; }
    this.touch();
  }

  /** 连接断开：座位 / 围观位都保留 90 秒，期间可凭 token 重连 */
  leave(seat, ws) {
    const s = this.slots[seat];
    if (s) {
      s.ws = null;
      s.connected = false;
      s.offlineAt = Date.now();
    }
    // 围观的人断开：按连接认人，别把别人一起标成掉线
    if (ws) {
      const w = this.watchers.find((x) => x.ws === ws);
      if (w) {
        w.ws = null;
        w.connected = false;
        w.offlineAt = Date.now();
      }
    }
    this.touch();
  }

  /** 围观者掉线太久就清出名单（默认 90 秒，和座位上的重连窗口一致） */
  pruneWatchers(timeout = 90000) {
    const now = Date.now();
    const before = this.watchers.length;
    this.watchers = this.watchers.filter(
      (w) => w.connected || !w.offlineAt || now - w.offlineAt < timeout,
    );
    return this.watchers.length !== before;
  }

  /** 围观者主动退出房间 */
  dropWatcher(ws) {
    const idx = this.watchers.findIndex((w) => w.ws === ws);
    if (idx < 0) return false;
    this.watchers.splice(idx, 1);
    this.touch();
    return true;
  }

  /** 主动离开房间：立刻让出座位，房主顺位转交。
   *  keepRequest：留座到点强制起立也走这里清座——这种「人还在房间、
   *  只是站起来」的让座要保留带入申请（v0.22.88），房主审批过了
   *  玩家重新坐下即可；真离房（默认）才撤销申请。 */
  vacate(seat, keepRequest = false) {
    const s = this.slots[seat];
    if (!s) return;
    if (this.game && s.token) {
      this.settlePending(seat);      // v0.22.102：挂账带入先并账再留档
      this.retireSeat(seat, 'left');
      this.clearGhostLedger(seat);   // v0.22.102：清幽灵账本，别留给下一个人
    }
    const wasOwner = this.ownerSeat === seat;
    s.token = null;
    s.ws = null;
    s.connected = false;
    s.offlineAt = 0;
    s.isAI = true;
    s.name = '';
    s.stack = 0;
    s.satAt = 0;
    s.asking = false;
    s.uid = '';
    // v0.20.96：座位让出后也把网络/设备/定位清掉，别影响下一位
    s.ip = '';
    s.deviceId = '';
    s.loc = null;
    s.standUp = '';
    s.holdLeave = false;
    s.forceOut = false;
    if (!keepRequest) this.requests = this.requests.filter((r) => r.seat !== seat);
    if (this.game && this.game.seats[seat]) {
      this.game.seats[seat].name = s.name;
      this.game.seats[seat].isAI = true;
      this.game.seats[seat].hold = false;
      this.game.seats[seat].asking = false;
    }
    if (wasOwner) this.nextOwner();
    // 有人让座：挂起选座的人现在可以坐下了
    this.flushPendingSits();
    this.touch();
  }

  /**
   * 把座位让出来、人回到围观席（保位离桌到期 / 站起围观）。
   * 和 vacate 的区别：vacate 是「人离开房间」，这里人还在，只是站起来看，
   * 同一个 token 继续挂着，随时能点空位重新坐下。
   */
  eject(seat, reason = 'hold') {
    const s = this.slots[seat];
    if (!s || !s.token) return false;
    const ws = s.ws;
    const token = s.token;
    const name = s.name;
    // 站起围观 / 保位到期：簸簸跟着人走，回来重新坐下还是这个数。
    // v0.22.99：以引擎真钱为准——slot.stack 整局只在带入/结算时同步，
    // 牌局进行中是脏值（可能还是 0），拿它当带走金额会让人回来被清成
    // 0 簸簸、续账本判定失败重开账本，战绩带入直接翻倍。
    this.settlePending(seat);   // v0.22.102：挂账带入并进簸簸再带走，别漏
    const gp0 = this.game && this.game.seats[seat];
    const keepStack = Math.max(0, Math.floor(Number((gp0 ? gp0.stack : s.stack) || 0)));
    const online = !!ws && ws.readyState === 1;
    this.vacate(seat, true);   // v0.22.88：起立围观不是离房，带入申请保留给房主审
    if (ws) {
      ws.seat = -1;
      const already = this.watchers.find((w) => w.token === token);
      if (already) {
        already.stack = keepStack;
      } else {
        this.watchers.push({
          name, token, ws, connected: online,
          at: Date.now(), offlineAt: online ? 0 : Date.now(), pendingSeat: null,
          stack: keepStack,
        });
      }
      this.send(ws, { t: 'stackKept', stack: keepStack });
      this.send(ws, { t: 'ejected', seat, reason });
    }
    this.touch();
    return true;
  }

  /* ── v0.22.74：离房簸簸暂存 ─────────────────────────────────
   * 「退出牌局」是真离开房间，watcher 会被删掉，没法像 standUp 那样把
   * 簸簸挂在 watcher.stack 上。这里按账号另存一份，回来坐下时原样带回、免审核。
   * 游客没有 uid，退而用房间 token（前端 localStorage 里那个）认人。
   */
  stashKey(uid, token) {
    if (uid) return 'u:' + String(uid);
    if (token) return 't:' + String(token);
    return '';
  }

  /** 主动退出前调用：把玩家名下这桌的剩余簸簸暂存起来 */
  stashOnLeave(ws, token) {
    if (!ws) return;
    const uid = ws.userId || '';
    let stack = 0;
    let name = '';
    let seatToken = '';
    if (ws.seat >= 0) {
      const s = this.slots[ws.seat];
      const p = this.game && this.game.seats[ws.seat];
      if (s) { name = s.name; seatToken = s.token; stack = p ? (p.stack || 0) : (s.stack || 0); }
    } else {
      const w = this.watchers.find((x) => x.ws === ws);
      if (w) { name = w.name; seatToken = w.token; stack = w.stack || 0; }
    }
    // 游客没有 uid：优先用座位/围观位上服务端实际分配的 token（前端 localStorage 存的也是它），
    // 其次才用连接传来的 token。二者都空就认不出人，放弃暂存。
    const key = this.stashKey(uid, seatToken || token);
    if (!key) return;
    stack = Math.max(0, Math.floor(Number(stack) || 0));
    if (!stack) return;                              // 没剩簸簸就不必暂存
    // 同一账号后来又带了新的簸簸进来，取较大的那笔，别把之前的覆盖变小
    const prev = this.stash.get(key);
    const keep = prev ? Math.max(prev.stack, stack) : stack;
    this.stash.set(key, { stack: keep, name, at: Date.now() });
  }

  /** v0.22.80：断线/掉线被清座时，按座位直接暂存剩余簸簸。
   *  和主动退出的 stashOnLeave 用同一把钥匙（uid 优先，游客用座位 token），
   *  回来点空位坐下时 takeStash 一样能认领，体验与主动退出一致。 */
  stashSeat(seat) {
    const s = this.slots[seat];
    if (!s || !s.token) return;
    const p = this.game && this.game.seats[seat];
    const stack = Math.max(0, Math.floor(Number(p ? (p.stack || 0) : (s.stack || 0)) || 0));
    if (!stack) return;
    const key = this.stashKey(s.uid || '', s.token || '');
    if (!key) return;
    const prev = this.stash.get(key);
    this.stash.set(key, {
      stack: Math.max(prev ? (prev.stack || 0) : 0, stack),
      name: s.name || '',
      at: Date.now(),
    });
  }

  /** 重新进房时认领暂存簸簸：命中即取出并删除（一次性消费，避免重复带） */
  takeStash(uid, token) {
    const uidKey = this.stashKey(uid, '');
    const tokKey = this.stashKey('', token);
    const key = (uidKey && this.stash.has(uidKey)) ? uidKey
      : (tokKey && this.stash.has(tokKey)) ? tokKey : '';
    if (!key) return 0;
    const hit = this.stash.get(key);
    this.stash.delete(key);
    return Math.max(0, Math.floor(Number(hit && hit.stack) || 0));
  }

  /**
   * 站起围观：
   *   这一手没牌（或根本没在打）→ 立刻让座；
   *   手牌还在手上 → 先记下，结算完这一手再让座（不能把正在下注的人抽走）。
   * 簸簸为 0 时必然没有手牌，走的也是「立刻」这一支。
   */
  standUp(seat) {
    const s = this.slots[seat];
    if (!s || !s.token) throw new Error('你还没坐下');
    if (this.ended) throw new Error('本桌已经结束了');
    const g = this.game;
    const p = g && g.seats[seat];
    const holding = !!p && this.isPlaying() && p.inHand;
    if (!holding) {
      const ok = this.eject(seat, 'watch');
      if (ok) this.broadcast();
      return { ok, after: false };
    }
    s.standUp = 'after';
    if (p) p.leaveAfter = true;
    this.broadcast();
    this.touch();
    return { ok: true, after: true };
  }

  /**
   * 保位离桌：点完这一手打完就进「留座倒计时」，倒计时读完自动让座。
   * 期间座位留着，别人坐不进来；带入一次即可取消。
   */
  holdLeave(seat, cancel = false) {
    const s = this.slots[seat];
    if (!s || !s.token) throw new Error('你还没坐下');
    if (this.ended) throw new Error('本桌已经结束了');
    const g = this.game;
    const p = g && g.seats[seat];
    if (!p) throw new Error('牌局还没开始，直接站起围观就行');

    if (cancel) {
      s.holdLeave = false;
      p.holdLeave = false;
      p.holdSince = 0;
      this.broadcast();
      this.touch();
      return { ok: true, after: false, cancel: true };
    }

    if (this.isPlaying() && p.inHand) {
      s.holdLeave = true;   // 这一手结算时生效
      this.broadcast();
      this.touch();
      return { ok: true, after: true };
    }

    s.holdLeave = false;
    p.holdLeave = true;
    p.holdSince = Date.now();
    p.inHand = false;
    this.broadcast();
    this.touch();
    return { ok: true, after: false };
  }

  /**
   * 互动表情：广播给同桌的所有人（含发送者本人），围观席也看得到。
   * 发送者本地不再先播，等服务端这条回执才播——收钻成功才算发出去了。
   * 只转发不存状态，掉线重连不会重放。
   */
  emote(from, seat, emo) {
    if (!EMOTE_IDS.has(emo)) return false;
    // 座位上有人就能扔，不用等开局（等待室里逗一下也正常）
    if (!this.slots[seat] || !this.slots[seat].token) return false;
    const payload = { t: 'emote', from, seat, emo };
    const seen = new Set();
    for (const s of this.slots) {
      if (!s.ws || s.ws.readyState !== 1) continue;
      if (seen.has(s.ws)) continue;
      seen.add(s.ws);
      this.send(s.ws, payload);
    }
    for (const w of this.watchers) {
      if (!w.ws || w.ws.readyState !== 1 || w.token === this.slots[from]?.token) continue;
      if (seen.has(w.ws)) continue;
      seen.add(w.ws);
      this.send(w.ws, payload);
    }
    return true;
  }

  /** 一手结算后统一执行「站起围观 / 保位离桌」的挂起意图 */  applyLeaveIntents() {
    const g = this.game;
    if (!g) return false;
    let changed = false;
    for (const s of [...this.slots]) {
      if (!s.token) continue;
      const p = g.seats[s.seat];
      if (!p) continue;
      if (s.standUp === 'after') {
        s.standUp = '';
        this.eject(s.seat, 'watch');
        changed = true;
        continue;
      }
      // v0.20.28：强制离座——本手结算到点，起立并进本房落座黑名单
      if (s.forceOut) {
        this.execForceOut(s.seat);
        changed = true;
        continue;
      }
      if (s.holdLeave && !p.holdLeave) {
        s.holdLeave = false;
        p.holdLeave = true;
        p.holdSince = Date.now();
        p.inHand = false;
        g.pushLog(`${p.name} 保位离桌，留座 ${BROKE_SECONDS} 秒`);
        changed = true;
      }
    }
    return changed;
  }

  /**
   * v0.20.28 强制离座（房主在玩家资料卡里点）：
   *   · 手里没牌 → 立刻起立离座；
   *   · 手里还有牌 → 本手结算后起立离座（applyLeaveIntents 统一执行）。
   * 落座黑名单记的是账号 ID：离座后在本房间任何座位都坐不下，
   * 直到房主「取消强制离座」。人就算中途退出房间，标记照样生效。
   */
  setForceOut(seat, on) {
    const s = this.slots[seat];
    if (!s || !s.token || s.isAI) throw new Error('这个位置没人');
    if (!s.uid) throw new Error('对方还没有登录账号，没法强制离座');
    if (s.uid === this.ownerUid) throw new Error('房主不能对自己强制离座');
    if (on) {
      this.forceOut.set(s.uid, s.name || '');
      s.forceOut = true;
      const p = this.game && this.game.seats[seat];
      const holding = !!p && this.isPlaying() && p.inHand;
      if (!holding) this.execForceOut(seat);
      this.touch();
      return { after: holding, name: s.name || '' };
    }
    s.forceOut = false;
    this.forceOut.delete(s.uid);
    this.touch();
    return { after: false, cancel: true, name: s.name || '' };
  }

  /** 按账号 ID 取消强制离座（人可能已经离座/离房，名单里直接勾掉） */
  unforceUid(uid) {
    const id = String(uid || '');
    if (!this.forceOut.has(id)) return false;
    this.forceOut.delete(id);
    for (const s of this.slots) {
      if (s.uid === id) s.forceOut = false;
    }
    this.touch();
    return true;
  }

  execForceOut(seat) {
    const s = this.slots[seat];
    if (!s || !s.token || !s.uid) return;
    this.forceOut.set(s.uid, s.name || '');
    s.forceOut = false;
    this.eject(seat, 'forced');
  }

  /** 房主走了：开房人锁定下不转交（等开房人回来），老房间才顺位交给下一个真人 */
  nextOwner() {
    if (this.ownerUid) { this.ownerSeat = null; return null; }
    const start = this.ownerSeat == null ? 0 : (this.ownerSeat + 1) % this.seatCount;
    for (let k = 0; k < this.seatCount; k++) {
      const s = this.slots[(start + k) % this.seatCount];
      if (s.token && !s.isAI) {
        this.ownerSeat = s.seat;
        // 新房主如果还没带入，把自己那笔申请直接通过，别卡住
        if (s.stack < this.ante) this.grantBuyIn(s.seat, this.startStack);
        return s.seat;
      }
    }
    this.ownerSeat = null;
    return null;
  }

  /**
   * 这一手打完 / 有人让座之后：把「选好座位、等本手结束」的人放进去。
   * 牌局正打着的时候不动手，免得把正在下注的人换掉。
   */
  flushPendingSits() {
    if (this.isPlaying()) return false;
    let changed = false;
    const list = this.watchers
      .filter((w) => w.pendingSeat != null)
      .sort((a, b) => (a.at || 0) - (b.at || 0));
    for (const w of list) {
      const n = w.pendingSeat;
      // v0.20.28：被强制离座的人，挂起的选座也作废
      const buid = w.ws && w.ws.userId;
      if (buid && this.forceOut.has(buid)) { w.pendingSeat = null; changed = true; continue; }
      const slot = this.slots[n];
      if (!slot || slot.token) { w.pendingSeat = null; changed = true; continue; }
      this.watchers.splice(this.watchers.indexOf(w), 1);
      this.seatWatcher(w, n);
      changed = true;
    }
    return changed;
  }

  /* ── 带入申请（房主审核） ─────────────────── */

  /**
   * 玩家发起带入。
   *   · 房主本人 → 免审，自己的钱自己说了算，立刻到账（牌局中则挂到本手结束）
   *   · v0.22.23：房主不在房间（开房账号没在线/没入座）→ 申请照旧进队列，
   *     等房主回来审核，绝不自动放行 —— 防止房主不在时玩家随便带入上桌；
   *   · 无主的老房间（没有开房人锁定）→ 桌上没人管审，直接通过，别把桌子卡死；
   *   · 其他人（房主在线）→ 进申请队列，房主点同意才到账
   */
  requestBuyIn(seat, amount) {
    const sl = this.slots[seat];
    if (!sl || !sl.token) throw new Error('先入座再带入');
    if (this.ended) throw new Error('本桌已经结束');
    const want = Math.floor(Number(amount) || 0);
    if (!Number.isFinite(want) || want <= 0) throw new Error('带入金额不对');
    if (want < this.minBuyIn) throw new Error(`本桌一次至少带入 ${this.minBuyIn}`);
    if (want > this.minBuyIn * 100) throw new Error('一次带太多了，分几次申请吧');

    this.requests = this.requests.filter((r) => r.seat !== seat);
    const isOwner = seat === this.ownerSeat || this.isOpenerUid(sl.uid);
    if (isOwner) {
      this.grantBuyIn(seat, want);
      return { auto: true, amount: want, owner: true };
    }
    // 没有开房人锁定的老房间：房主位空了也没有人能审，直接放行
    if (this.ownerSeat == null && !this.ownerUid) {
      this.grantBuyIn(seat, want);
      return { auto: true, amount: want, owner: false };
    }
    // 房主（开房人）不在房间：申请挂起等审核
    // v0.22.38：带上账号 ID——房主可能不在房间里，全局申请列表要显示「昵称 + ID + 金额」
    // v0.22.82：留座与带入彻底解耦——提交申请不停留座表，到点照常起立围观。
    // v0.22.88：点击带入按钮那一刻起算 180 秒留座倒计时（之前是「占座」15 秒口径）。
    this.requests.push({ seat, name: sl.name, uid: sl.uid || '', amount: want, at: Date.now() });
    sl.satAt = Date.now();
    sl.asking = true;
    const p = this.game && this.game.seats[seat];
    if (p) p.asking = true;
    this.touch();
    return { auto: false, amount: want, owner: false };
  }

  /** 房主审核：approve=false 就是拒绝（开房人锁定下，开房账号也能审）。
   *  v0.22.88：申请提交后 3 分钟没人审就过期作废（不挂账），
   *  玩家随时可以重新提交审核。 */
  reviewBuyIn(requesterSeat, seat, approve, uid = null) {
    if (!(requesterSeat === this.ownerSeat || this.isOpenerUid(uid))) {
      throw new Error('只有房主能审核带入');
    }
    const idx = this.requests.findIndex((r) => r.seat === seat);
    if (idx < 0) throw new Error('这笔申请已经不在了');
    const r = this.requests[idx];
    if (Date.now() - r.at >= BUYIN_REVIEW_MS) {
      // 审核倒计时走完还没审：作废，让玩家重新提交
      this.requests.splice(idx, 1);
      const sl0 = this.slots[seat];
      if (sl0) sl0.asking = false;
      const p0 = this.game && this.game.seats[seat];
      if (p0) p0.asking = false;
      this.touch();
      throw new Error('申请已超 3 分钟自动作废，让玩家重新提交');
    }
    this.requests.splice(idx, 1);
    if (approve) this.grantBuyIn(seat, r.amount);
    else {
      // v0.22.82：拒绝不清表——留座倒计时从原座位起算点继续走，不因被拒而重置
      const sl2 = this.slots[seat];
      if (sl2) sl2.asking = false;
      const p = this.game && this.game.seats[seat];
      if (p) p.asking = false;
    }
    const sl = this.slots[seat];
    if (sl && sl.ws) this.send(sl.ws, { t: 'buyinResult', ok: !!approve, amount: r.amount });
    else if (approve) {
      // v0.22.88：审批通过时人已被留座到点强制起立——钱挂账，人多半在围观席，
      // 按申请里记的账号 ID 把审批结果也通知到位
      const w = r.uid && this.watchers.find((x) => x.ws && String(x.ws.userId || '') === String(r.uid));
      if (w) this.send(w.ws, { t: 'buyinResult', ok: true, amount: r.amount });
    }
    this.touch();
    return r;
  }

  /** v0.22.88：审核倒计时到点还没审的申请自动作废（不挂账），
   *  清掉「等审核」标记，玩家随时可以重新提交。每秒 tick 扫一遍。 */
  clearExpiredRequests() {
    if (!this.requests.length) return false;
    const now = Date.now();
    const dropped = this.requests.filter((r) => now - r.at >= BUYIN_REVIEW_MS);
    if (!dropped.length) return false;
    this.requests = this.requests.filter((r) => now - r.at < BUYIN_REVIEW_MS);
    for (const r of dropped) {
      const sl = this.slots[r.seat];
      if (sl) sl.asking = false;
      const p = this.game && this.game.seats[r.seat];
      if (p) p.asking = false;
    }
    return true;
  }

  /** 真正把钱记到账上：牌局进行中走挂账，本手结算后到账 */
  grantBuyIn(seat, amount) {
    const sl = this.slots[seat];
    if (!sl) return 0;
    const want = Math.floor(Number(amount) || 0);
    if (want <= 0) return 0;
    this.requests = this.requests.filter((r) => r.seat !== seat);

    const g = this.game;
    if (!g) {
      // 还没开局（或开局前审核）：钱直接上桌，顺手把「等审核」的标记清掉，
      // 否则这个座位会一直挂着「等房主审核」，连开局人数都算不进去
      sl.asking = false;
      sl.satAt = 0;
      sl.stack += want;
      return want;
    }
    const p = g.seats[seat];
    sl.asking = false;
    sl.satAt = 0;
    if (!p) { sl.stack += want; return want; }
    // v0.22.88：审批时人已被留座到点强制起立（倒计时到点一律起立，与带入审批无关）——
    // 不往座位上记钱，直接挂账（战绩页可见）：玩家重新入座后，
    // 下一手 startHand 的 applyPendingBuyIns 会把这笔钱并入簸簸并记入战绩带入。
    if (!sl.token || p.away) {
      p.pendingBuyIn = (p.pendingBuyIn || 0) + want;
      p.hold = false;
      p.asking = false;
      return want;
    }
    p.hold = false;
    p.asking = false;
    try {
      g.bringIn(seat, want);
    } catch (e) {
      // 引擎的最小带入口径与房间不同（理论上不会发生），兜底直接记账
      if (!/至少带入/.test(e.message)) throw e;
      p.stack += want;
      p.buyInTotal = (p.buyInTotal || 0) + want;
    }
    sl.stack = p.stack;
    return want;
  }

  /* ── 开局 ─────────────────────────────────── */

  /**
   * 某个座位眼下的簸簸：开局后以引擎为准（带入可能还挂在申请里），否则看座位。
   */
  stackOf(seat) {
    const s = this.slots[seat];
    if (!s) return 0;
    const p = this.game ? this.game.seats[seat] : null;
    return (p ? p.stack : s.stack) || 0;
  }

  /**
   * 能上桌打的人数：真人 + 开发者补的机器人，都要求簸簸够一底。
   * 机器人开关开着时，房主一个人也能开局（陪练），真人房没开关还是老规矩 2 人。
   */
  readyCount() {
    return this.slots.filter((s) => (s.token || s.name) && this.stackOf(s.seat) >= this.ante).length;
  }

  /**
   * 「这一手真能行动」的人数：簸簸够下一手全桌总投入（含自己，v0.22.24 与引擎同一口径）、
   * 没在留座读秒、没卡在审核里。
   * 下一手不足 2 人就暂停发牌（房间倒计时照走），凑够再开。
   */
  /* ── v0.22.33 庄位跟人走，遇空位跳过 ─────────────────────── */
  /** 当前庄位上是否坐着人（空位 = 没有 token 也没有名字） */
  bankerOccupied() {
    const sl = this.slots[this.banker];
    return !!(sl && (sl.token || sl.name));
  }

  /** 把庄位指到下一个「坐着人」的座位：fromNext=true 从庄位下一位开始找（每手轮转），
   *  false 只在当前庄位是空位时修正。全空返回 false（庄位不动，反正也开不了局）。 */
  nextOccupiedBanker(fromNext) {
    const n = this.seatCount;
    for (let k = fromNext ? 1 : 0; k <= n; k++) {
      const s = (this.banker + k) % n;
      const sl = this.slots[s];
      if (sl && (sl.token || sl.name)) { this.banker = s; return true; }
    }
    return false;
  }

  actableCount() {
    const g = this.game;
    const floor = this.holdFloor();
    return this.slots.filter((s) => {
      if (!s.token && !s.name) return false;     // 空位 / 已经让座走了
      if (s.asking) return false;                // 卡在带入审核里
      const p = g ? g.seats[s.seat] : null;
      if (!p) return s.stack >= floor;
      // v0.22.88：上一手读秒归零两次的（autoHold），下一手注定进保位留座不发牌——
      // 预判时必须把他扣掉。原来不查这个标记，转换又发生在 startHand 里，
      // 于是「上一手超时的人还在桌上」被算成可行动，牌照发、芒果照扣，
      // 发完一手才发现凑不齐 2 人，被拉回暂停（正是玩家录屏的现场）。
      if (p.away || p.hold || p.asking || p.holdLeave || p.autoHold) return false;
      // 开局后用引擎的停发门槛（底皮 × n，房主选定）：低于它的人下一手本来就不发牌
      return p.stack >= (g.holdFloor || floor);
    }).length;
  }

  /** 点「开始牌局」：v0.20.29 房主=开房人，与是否入座断开——围观、纯开房都能开局 */
  start(seat, uid = null) {
    if (this.started) throw new Error('牌局已经开始了');
    if (this.ended) throw new Error('本桌已经结束');
    const bySeat = seat != null && seat >= 0 && seat === this.ownerSeat;
    const byUid = this.isOpenerUid(uid);
    if (!bySeat && !byUid) throw new Error('只有房主能开局');
    const watching = seat == null || seat < 0;
    if (watching && !byUid) throw new Error('先在空位上坐下，再开局');
    // 房主位只跟着开房人走：坐下就亮在座位上，围观/纯开房就空着，不再强制接管
    this.ownerSeat = watching ? null : seat;

    // 空位按「机器人开关」处理：默认关 = 空着，几个真人打几个人的局
    this.applyBots();

    if (!watching && (this.stackOf(seat) || 0) < this.ante) throw new Error('你还没带入，先申请带入再开局');
    if (this.readyCount() < 2) {
      if (this.humans().length >= 2) throw new Error('还有人没带入，先在「带入申请」里同意一下');
      throw new Error('至少 2 人入座才能开局');
    }

    this.started = true;
    this.startedAt = Date.now();
    this.deadline = this.startedAt + this.durationMin * 60 * 1000;
    this.timeUp = false;
    this.ended = false;
    this.banker = 0;
    this.beginHand();
    this.touch();
    return true;
  }

  /** 停牌门槛：低于这个数就不发牌、进留座读秒（= 底皮 × n，房主开房时选定） */
  holdFloor() {
    if (this.game && this.game.holdFloor) return this.game.holdFloor;
    return Math.max(1, this.ante * this.floorMult);
  }

  /**
   * v0.22.88：暂停发牌时给「下一手注定不打」的座位补上状态表（startHand 不跑没人补）：
   *   · 读秒归零两次的（autoHold）→ 立刻转保位留座，倒计时马上走起来（与 startHand 同口径）；
   *   · 簸簸低于停发门槛的 → 打 broke 留座表，黑头像卡座修复靠它到点弹座。
   */
  syncHoldTable() {
    const g0 = this.game;
    if (!g0) return;
    for (const s of this.slots) {
      if (!s.token) continue;
      const p = g0.seats[s.seat];
      if (!p || p.away) continue;
      if (p.autoHold && !p.holdLeave) {
        p.autoHold = false;
        p.holdLeave = true;
        p.holdSince = Date.now();
        p.inHand = false;
      }
      if (p.holdLeave) continue;
      if (p.stack >= g0.holdFloor) continue;
      p.inHand = false;
      p.hold = true;
      // v0.22.98：输光（带入过 buyInTotal>0）= 留座，表从输光当下起算 180 秒；
      // 占座（没带入过）打不入座时刻，房间层 15 秒先弹，引擎 180 秒只是兜底
      if (!p.broke) { p.broke = true; p.brokeSince = p.buyInTotal > 0 ? Date.now() : (s.satAt || Date.now()); }
      else if (!p.brokeSince) p.brokeSince = Date.now();
    }
  }

  /** 真正开一手牌（房主开局 / 上一手结束后自动续） */
  beginHand() {
    if (!this.started || this.ended) return false;
    const playing = this.game && this.game.phase !== PHASE.SETTLED;
    if (playing) return false;
    if (!this.humans().length) return false;

    // 能行动的人不够 2 个：不发牌，挂着等（房间倒计时照走，人一凑够立刻开）
    if (this.actableCount() < 2) {
      if (!this.dealHold) {
        this.dealHold = true;
        const g0 = this.game;
        if (g0) {
          g0.pushLog('可行动人数不足 2 人，暂停发牌');
          // v0.22.88：暂停发牌时 startHand 不跑，输光/未带入座位的 broke/brokeSince
          // 不会置位，留座倒计时永远是 0、到点弹座也够不着，黑头像永远卡座
          // （v0.22.80 修了等待室，dealHold 漏了）。这里照 startHand 的口径补起表。
          this.syncHoldTable();
        }
        this.broadcast();
        this.touch();
      }
      this.startTicker();
      return false;
    }
    this.dealHold = false;

    // 每一手换牌前对一次机器人座位：中途改的开关从这一手开始生效
    this.applyBots();

    // 开局前同步一次座位（簸簸以 Game 内为准，避免覆盖刚带入的钱）
    if (!this.game) {
      this.game = new Game({
        players: this.slots.map((s) => ({
          id: 's' + s.seat,
          name: s.name,
          stack: s.stack,
          isAI: s.isAI,
        })),
        ante: this.ante,
        handMango: this.handMango,
        cap: this.minBuyIn,
        banker: this.banker,
        floorMult: this.floorMult,   // v0.22.39：停发门槛 = 底皮 × n
        dijiuOn: this.dijiuOn,       // v0.22.67：地九王开关随开局注入引擎
      });
      // 还没带入的座位：留座倒计时；已经提交申请的停表等房主
      for (const s of this.slots) {
        const p = this.game.seats[s.seat];
        if (!p) continue;
        if (s.token && s.stack < this.holdFloor()) {
          p.hold = true;
          // v0.22.88：broke 也要打上——后面 actableCount<2 走 dealHold 时 startHand
          // 不跑，没人补这个标记，expireBroke 就永远够不着这个座位
          p.broke = true;
          p.brokeSince = s.satAt || Date.now();
          // v0.22.82：申请带入不再停表——倒计时从坐下那一刻照算，到点 expireBroke 起立
          if (this.requests.some((r) => r.seat === s.seat)) p.asking = true;
        }
      }
    } else {
      for (const s of this.slots) {
        const p = this.game.seats[s.seat];
        if (!p) continue;
        p.id = 's' + s.seat;
        p.name = s.name;
        p.isAI = s.isAI;
      }
      if (!this.bankerOccupied()) this.nextOccupiedBanker(false);   // v0.22.33：庄位不落在空位上
      this.game.banker = this.banker;
    }

    // v0.22.88：发牌前最后一道预检——直接按引擎 startHand 的入局口径预判
    // 下一手可行动人数（房间层 actableCount 与引擎口径存在窗口差：autoHold
    // 要等 startHand 才转保位、挂起的保位/起立意图要等结算才同步）。差出来的
    // 那个人会让这手照发：底牌发出去、行动按钮和气泡都亮了、芒果也扣了，
    // 下一刻才发现凑不齐 2 个人进暂停——宁可在这里拦下，也不发一手凑不齐人的牌。
    if (this.game) {
      this.applyLeaveIntents();   // 挂起的保位/起立意图补同步一次
      const would = this.game.seats.filter((p) => p
        && !p.away && !p.hold && !p.holdLeave && p.stack >= this.game.holdFloor).length;
      if (would < 2) {
        if (!this.dealHold) {
          this.dealHold = true;
          this.game.pushLog(`下一手可行动人数不足 2 人（预判 ${would} 人），暂停发牌`);
          this.syncHoldTable();
          this.broadcast();
          this.touch();
        }
        this.startTicker();
        return false;
      }
    }
    this.game.startHand();
    this.broadcast();
    this.pump();
    this.startTicker();
    return true;
  }

  /** 房主主动结束/牌桌暂停后重新开局（本手打完再点）。
   *  v0.20.29：开房人围观/纯开房（seat<0）也算房主，只看人数与带入就绪。 */
  canStart(seat, uid = null) {
    if (this.started || this.ended || seat == null) return false;
    if (!(seat >= 0 && seat === this.ownerSeat) && !this.isOpenerUid(uid)) return false;
    const watching = seat < 0;
    const owner = watching ? null : this.slots[seat];
    if (!watching && (!owner || !owner.token)) return false;
    return (!watching && (this.stackOf(seat) || 0) < this.ante ? false : true) && this.readyCount() >= 2;
  }

  /**
   * 房主点「结束本桌」：正在打的那一手打完就收摊，不硬掐。
   * 等待室阶段（还没开局）直接就地结束。
   */
  requestEnd(reason = 'owner') {
    if (this.ended) return false;
    const g = this.game;
    if (!this.started || !g) {
      return this.finishSession(reason);
    }
    // v0.22.83：牌局正在结算停留期点收摊——也缓 3 秒，让比牌结果看完
    if (g.phase === PHASE.SETTLED) {
      return this.scheduleFinish(reason);
    }
    this.endReason = reason;
    this.timeUp = true;
    this.deadline = Date.now();
    this.broadcast();
    this.touch();
    return true;
  }

  /** 时间到没有（房主主动收摊也算时间到） */
  isTimeHit() {
    if (this.timeUp) return true;
    return !!this.deadline && Date.now() >= this.deadline;
  }

  /** 还能不能为抢清芒果池再打一手 */
  canOvertime() {
    if (this.overtimeHands >= OVERTIME_MAX_HANDS) return false;
    const cap = this.startedAt + this.durationMin * 60000 + OVERTIME_MAX_MS;
    return Date.now() <= cap;
  }

  /**
   * 结算停留：把「收牌并开下一手」整体往后推 ms 毫秒，间隔净时长 left 不变。
   * 结算期「强制秀牌」用——点一下插入一段独立的秀牌时间：这 ms 毫秒里间隔冻结不消耗，
   * 秀完从剩余处 left 继续走，相当于收牌时刻整体后移 ms。
   * 返回实际延后的毫秒数；没有待执行的下一手定时器时返回 0（这一手马上就收了）。
   */
  holdSettle(ms = 1500) {
    if (!this.nextTimer || !this.nextAt) return 0;
    const add = Math.max(0, Number(ms) || 0);
    if (!add) return 0;
    const left = Math.max(0, this.nextAt - Date.now());
    clearTimeout(this.nextTimer);
    this.nextAt = Date.now() + left + add;
    this.nextTimer = setTimeout(() => this.beginHand(), left + add);
    return add;
  }

  /**
   * 这一手结算之后的收尾（幂等：同一 handNo 只结算一次庄位，但允许重排下一手）。
   *   · 时间没到 → 6 秒后自动开下一手
   *   · 时间到了 → 本手已经打完，若芒果池还有滚存，继续开加时手，直到有人抢走（carryPot 归零）
   *   · 滚存清零了 → 整场结束
   */
  afterHand() {
    const g = this.game;
    if (!g || g.phase !== PHASE.SETTLED) return false;

    if (this.handDone !== g.handNo) {
      this.handDone = g.handNo;
      this.saveChips();
      this.applyLeaveIntents();     // 这一手挂下的「站起围观 / 保位离桌」现在生效
      this.flushPendingSits();      // 这一手挂起选座的人，现在入座
      this.broadcast();
      this.nextOccupiedBanker(true);   // v0.22.33：庄位跟人走，空位直接跳过
    }
    if (this.ended) return false;

    const carry = g.carryPot || 0;
    const timeHit = this.isTimeHit();

    // 时间到且一个真人都没在线（都掉线/被托管）：直接收摊，别留僵尸桌
    if (timeHit && !this.hasHumanOnline()) {
      if (carry > 0) this.refundCarry();
      this.finishSession(this.endReason || 'time');
      return true;
    }

    // 时间没到：正常续手（掉线的人回来重连也靠这里重排定时器）
    if (!timeHit) {
      if (!this.started || !this.hasHumanOnline()) return false;
      clearTimeout(this.nextTimer);
      // 人不够 2 个时别干等 6 秒，立刻进「暂停发牌」状态，让全桌看到提示
      // 比牌收场（≥2 人亮牌对垒）的手，牌面展示单独再留 0.7s
      const showdown = g.seats.filter((p) => p.inHand && !p.folded).length >= 2;
      const gap = this.actableCount() >= 2
        ? NEXT_HAND_MS + (showdown ? SHOWDOWN_EXTRA_MS : 0)
        : 0;
      this.nextAt = Date.now() + gap;
      this.nextTimer = setTimeout(() => this.beginHand(), gap);
      return true;
    }

    // 时间到，但芒果池还有滚存：加时打到有人抢走为止（房主主动收摊就不加时）
    if (carry > 0 && this.endReason !== 'owner') {
      if (this.canOvertime()) {
        if (this.overtimeFor !== g.handNo) {
          this.overtimeFor = g.handNo;
          this.overtimeHands++;
          g.pushLog(`时间到，芒果池还有 ${carry} 没人抢走，接着开下一手（加时第 ${this.overtimeHands} 手）`);
          this.broadcast();
          this.touch();
        }
        if (!this.started || !this.hasHumanOnline()) return false;
        clearTimeout(this.nextTimer);
        this.nextAt = Date.now() + OVERTIME_NEXT_MS;
        this.nextTimer = setTimeout(() => this.beginHand(), OVERTIME_NEXT_MS);
        return true;
      }
      // 安全阀：加时到上限还没抢完，按在座均分退回，别让钱凭空消失
      this.refundCarry();
      this.broadcast();
    }

    // v0.22.83：最后一手打完缓 3 秒再收摊，比牌过程先演完再弹结算页
    this.scheduleFinish(this.endReason || 'time');
    return true;
  }

  /** 把芒果池的滚存按在座的人均分退回（仅在异常收尾时用，正常都会打完） */
  refundCarry() {
    const g = this.game;
    const carry = (g && g.carryPot) || 0;
    if (carry <= 0) return 0;
    /* v0.20.91：空座位不能算人头。原来只滤 away，空座也进名单，
       300 的滚存在 2 人 4 座的桌上被切成 4 份，两个空座各拿 75，
       随后座位清空，这 150 就凭空消失了（实测就是只退一半）。 */
    const list = g.seats.filter((p) => !p.away && p.name && !p.vacant);
    if (!list.length) { g.carryPot = 0; return carry; }
    const each = Math.floor(carry / list.length);
    let left = carry - each * list.length;
    for (const p of list) {
      const add = each + (left > 0 ? 1 : 0);
      if (left > 0) left--;
      p.stack += add;
    }
    g.carryPot = 0;
    this.saveChips();
    g.pushLog(`加时到上限，芒果池剩 ${carry} 按在座 ${list.length} 人均分退回`);
    return carry;
  }

  /**
   * v0.22.83：最后一手比牌结束后缓 3 秒再收摊——
   * 原来 afterHand 一到点立刻 finishSession，前端马上弹结算页，
   * 比牌过程（亮牌/输赢演出）被整个盖掉。缓 3 秒让牌面演完。
   */
  scheduleFinish(reason, delayMs = 3000) {
    if (this.ended) return false;
    if (this.finishDelayTimer) return true;   // 已在倒计时，别重复排
    this.finishDelayTimer = setTimeout(() => {
      this.finishDelayTimer = null;
      this.finishSession(reason);
    }, delayMs);
    return true;
  }

  /** 时间到 / 房主收摊：本手打完就收摊，结束后 10 秒关房 */
  finishSession(reason = 'time') {
    if (this.ended) return false;
    clearTimeout(this.finishDelayTimer);
    this.finishDelayTimer = null;
    const g = this.game;
    // 还有滚存没抢走（房主提前结束之类）：退回，别让钱卡在池子里
    if (g && g.carryPot > 0) this.refundCarry();
    // v0.22.88：统一结算——挂账带入（房主审批时人已被留座到点强制起立，钱先挂账）
    // 在解散这一刻统一并入簸簸、记入战绩：人回来入座过的早已到账，
    // 没回来的这笔钱跟着解散结算走，不会卡在挂账里消失。
    if (g) g.applyPendingBuyIns();
    this.ended = true;
    this.timeUp = false;
    this.endReason = reason;
    this.deadline = 0;          // 倒计时收掉
    this.closeAt = Date.now() + CLOSE_DELAY_MS;
    clearTimeout(this.nextTimer);
    this.nextAt = 0;
    if (g) g.pushLog(reason === 'time' ? '本桌时间到，牌局结束' : '房主结束了本桌');
    this.broadcast();
    // v0.22.82：结算这一刻先把完整战绩快照交给上层落盘（保留 24 小时）。
    // 必须赶在 clearBots 之前——机器人一清，它们的名字/带入/手数就没了，
    // 战绩图就缺人。回调由 index 注册，失败不影响牌局收尾。
    if (this.onSettle) {
      try { this.onSettle(this); } catch (e) { console.error('[stats-archive]', (e && e.message) || e); }
    }
    // 牌局结束就把机器人全部清干净：结算快照上面已经发出去了，
    // 这里清不会影响这一局的成绩展示，但能保证不留名字、不留簸簸、不留战绩，
    // 免得下一桌 / 进程重启后还挂着上一局的机器人。
    this.clearBots();
    this.touch();
    return true;
  }

  /**
   * 彻底清空机器人（真人座位一概不动）。
   * 座位名、簸簸、带入、手数、破产/离座标记全部归零，并把机器人开关关掉，
   * 这样「牌桌结束」之后桌上不会再有任何机器人的痕迹。
   */
  clearBots() {
    const g = this.game;
    for (const s of this.slots) {
      if (s.token) continue;          // 真人不碰
      s.isAI = true;
      s.name = '';
      s.stack = 0;
      s.satAt = 0;
      s.asking = false;
      const p = g && g.seats[s.seat];
      if (!p) continue;
      p.name = '';
      p.isAI = true;
      p.stack = 0;
      p.buyInTotal = 0;
      p.handsTotal = 0;
      p.pending = 0;
      p.hold = false;
      p.asking = false;
      p.broke = false;
      p.brokeSince = 0;
      p.away = true;
      p.joinNext = false;
      p.retiredAt = 0;
      p.retiredKey = '';
    }
    this.botsEnabled = false;
  }

  /** 关房：通知所有人，交给 index 从房间表里摘掉 */
  close(reason = 'ended') {
    if (this.closed) return false;
    this.closed = true;
    clearInterval(this.tickTimer);
    clearTimeout(this.botTimer);
    clearTimeout(this.actTimer);
    clearTimeout(this.nextTimer);
    this.nextAt = 0;
    const notify = (ws) => {
      if (!ws) return;
      this.send(ws, { t: 'closed', reason });
      if (ws.room === this) { ws.room = null; ws.seat = -1; }
    };
    for (const s of this.slots) notify(s.ws);
    for (const w of this.watchers) notify(w.ws);
    // 开发者/旁观视角也要断开，别让已解散的桌子还挂在连接上
    for (const g of this.gods) {
      if (!g) continue;
      if (g.godRoom === this) g.godRoom = null;
      try { this.send(g, { t: 'closed', reason }); } catch { /* 连接已断 */ }
    }
    this.gods.length = 0;
    if (this.onClose) this.onClose(this);
    return true;
  }

  /** 距离结束还剩多少毫秒（没开局返回 null） */
  remainMs() {
    if (!this.started || !this.deadline) return null;
    return Math.max(0, this.deadline - Date.now());
  }

  /* ── 玩家动作 ─────────────────────────────── */

  act(seat, action, amount) {
    const g = this.game;
    if (!g || g.phase !== PHASE.BET) throw new Error('当前不能下注');
    if (g.currentSeat !== seat) throw new Error('还没轮到你');
    g.act(seat, action, amount);
    // v0.22.99：行动流水改内存攒批异步落盘。实测同步写一条约 10.7ms，
    // 会堵住房间队列；攒批 1.5 秒一并写，平摊每条约 0.5ms，队列不再等磁盘。
    // 内容与 v0.22.98 格式完全一致（含锁状态），事后核对争议照用。
    try {
      const lg = g.logs && g.logs.length ? g.logs[g.logs.length - 1] : '';
      const who = this.slots[seat] || {};
      actLog(`${Date.now()} room=${this.id} hand=${g.handNo} seat=${seat} uid=${who.uid || '-'} ${action} ${amount == null ? '' : amount}`
        + ` lock=${g.raiseLocked ? 1 : 0} locked=[${g.lockCallees ? [...g.lockCallees].join(',') : '-'}]`
        + ` short=${g.shortAllIn ? JSON.stringify(g.shortAllIn) : '-'} | ${lg}\n`);
    } catch (e) { /* 日志失败不影响牌局 */ }
    this.touch();
    this.broadcast();
    this.pump();
  }

  /** 每秒检查：读秒到期的离座、机器人离座后补位、房主交接、限时到点 */
  startTicker() {
    clearInterval(this.tickTimer);
    this.awayAt = new Map();
    this.tickTimer = setInterval(() => {
      // 整场结束：10 秒后自动关房（哪怕 game 已经不在，也要能走到关房）
      if (this.ended && this.closeAt && Date.now() >= this.closeAt) {
        this.close(this.endReason || 'time');
        return;
      }
      const g = this.game;
      let changed = false;

      // 暂停发牌：人凑够 2 个就开下一手；房间倒计时没停，时间到了照样收摊
      if (this.dealHold && this.started && !this.ended) {
        if (this.actableCount() >= 2) {
          this.dealHold = false;
          this.beginHand();
          return;
        }
        if (this.isTimeHit()) {
          this.dealHold = false;
          this.finishSession(this.endReason || 'time');
          return;
        }
      }

      // 等待室（未开局）：v0.22.88 分两档——
      //   没点带入 = 「占座」，只给 15 秒，到点强制起立（可重新入座重新占座）；
      //   点了带入按钮（申请挂起等审）= 「留座」，180 秒，从点击带入那一刻起算。
      // dealHold（开局后暂停发牌）：输光/未带入座位走引擎留座表，180 秒。
      if (!this.started) {
        const t0 = Date.now();
        let drop = false;
        for (const sl of this.slots) {
          if (!sl.token) continue;
          if (sl.seat === this.ownerSeat) continue;   // 房主占座不设时限（等带入）
          if (this.stackOf(sl.seat) >= this.holdFloor()) continue;
          // 占座（坐上没带入）15 秒，从入座时刻起算；申请带入=留座 180 秒
          const limit = sl.asking ? BROKE_SECONDS * 1000 : SIT_HOLD_SECONDS * 1000;
          if (!sl.satAt) sl.satAt = t0;   // 入座必打点；恢复房缺失的当刻补记并落盘
          if (t0 - sl.satAt < limit) continue;
          // v0.22.99：改走 eject 而不是裸 vacate——vacate 只清座位数据，
          // 不重置连接的 ws.seat、不把人挪进围观名单、也不推 ejected 消息，
          // 结果玩家收不到任何后续广播：头像冻成灰的、菜单起立报「你还没坐下」、
          // 点别的座位也坐不进去，只能退房重进。eject 内部本来就走 vacate(keepRequest=true)，
          // 带入申请照留，另外会把连接转围观并推 stackKept/ejected，前端自动恢复。
          this.eject(sl.seat, 'sithold');
          const gs = this.game && this.game.seats[sl.seat];
          if (gs) { gs.broke = false; gs.brokeSince = 0; }
          drop = true;
        }
        if (drop) { this.broadcast(); this.touch(); }
      } else if (this.dealHold && !this.ended) {
        const t0 = Date.now();
        let drop = false;
        for (const sl of this.slots) {
          // v0.22.80：留座与带入彻底解耦——即使已提交带入申请(asking)在等房主审，
          // 倒计时到点也照常起立让座。想打，审批过了重新坐下即可。
          if (!sl.token) continue;
          if (sl.seat === this.ownerSeat) continue;   // 房主占座不设时限（等带入）
          // 低于停发门槛才是等待座位（开局后以引擎簸簸为准）
          if (this.stackOf(sl.seat) >= this.holdFloor()) continue;
          const gp = this.game && this.game.seats[sl.seat];
          // 留座=申请带入审核中 / 带入过（输光）/ 保位 → 统一 180 秒到点起立；
          // 坐上没带入的占座 → 15 秒，从入座时刻起算。
          const liu = !!(sl.asking || (gp && (gp.holdLeave || (gp.buyInTotal || 0) > 0)));
          const limit = liu ? BROKE_SECONDS * 1000 : SIT_HOLD_SECONDS * 1000;
          // 起算点：留座用状态进入时刻（输光表/保位表），占座用入座时刻；
          // 入座时刻缺失（恢复房）就当刻补记落盘，下秒起正常读秒。
          if (!sl.satAt) sl.satAt = t0;
          const since = liu ? ((gp && gp.brokeSince) || (gp && gp.holdSince) || sl.satAt) : sl.satAt;
          if (t0 - since < limit) continue;
          // 起立围观：簸簸跟人走（与 expireBroke 同一条路），token 保留可重新入座
          if (gp) this.slots[sl.seat].stack = gp.stack;
          this.eject(sl.seat, 'broke');
          // 顺手清掉引擎里可能残留的留座标记，免得 expireBroke 再对空座打一遍日志
          if (gp) { gp.broke = false; gp.brokeSince = 0; }
          drop = true;
        }
        if (drop) { this.broadcast(); this.touch(); }
      }

      // v0.22.88：审核倒计时到点的带入申请自动作废（不挂账，玩家可重新提交）
      if (this.clearExpiredRequests()) { changed = true; }

      if (!g) return;
      // 保位离桌：留座倒计时读完，座位让出来、人回到围观席
      if (this.started && !this.ended) {
        for (const sl of this.slots) {
          if (!sl.token) continue;
          const p = g.seats[sl.seat];
          if (!p || !p.holdLeave || !p.holdSince) continue;
          if (Date.now() - p.holdSince < BROKE_SECONDS * 1000) continue;
          this.eject(sl.seat, 'hold');
          changed = true;
        }
      }
      // v0.22.80：留座到点后，引擎只把玩家标记成 away；这里把人真正「起立围观」——
      // 清座位 token / ws.seat、剩余簸簸带到围观席。否则 token 还占着座位，
      // 前端 viewerSeat 仍在原位，出现灰头像卡座、带入提示「请选择座位先坐下」、
      // 菜单无法起立/留座。带入审批过了，从围观席重新坐下即可。
      if (g.expireBroke()) {
        const due = g.brokeEject || [];
        for (const seat of due) {
          // 同步簸簸：牌局中筹码以引擎为准，eject 读的是 slot.stack
          if (g.seats[seat]) this.slots[seat].stack = g.seats[seat].stack;
          this.eject(seat, 'broke');
        }
        g.brokeEject = [];
        changed = true;
      }
      // 搓牌到点（10 秒）自动收场，牌面亮出来
      if (g.expireScratch()) {
        changed = true;
        this.resumeTurnClock();
        if (g.phase === PHASE.BET) this.pump();   // 等搓牌的闸门解除，行动继续
      }
      // 分牌读秒的冻结/解冻（进分牌、搓完、提前分完都要对齐）
      if (this.syncSplitClock()) changed = true;

      // 限时到点：本手打完再收摊（不打断正在打的一手）；
      // 若芒果池还有滚存，afterHand 会继续加时，直到有人把池子抢走
      if (this.started && !this.ended && !this.timeUp && this.deadline && Date.now() >= this.deadline) {
        this.timeUp = true;
        this.endReason = this.endReason || 'time';
        clearTimeout(this.nextTimer);
        if (g.phase === PHASE.SETTLED) this.afterHand();
        else { this.broadcast(); this.touch(); }
      }

      const now = Date.now();
      // 围观的人掉线超过 90 秒：直接清出名单，别一直占着位置
      if (this.pruneWatchers()) changed = true;

      // 断线超过 90 秒没回来：座位交给机器人，战绩留档灰显
      for (const sl of this.slots) {
        if (!sl.token || sl.isAI || sl.connected || !sl.offlineAt) continue;
        if (now - sl.offlineAt < 90000) continue;
        const p = g.seats[sl.seat];
        if (!p) continue;
        // 正在打的那手先打完，别把牌桌打断
        if (p.inHand && g.phase !== PHASE.SETTLED) continue;
        // v0.22.80：断线卡掉（App 被切后台/被杀）走的也是「中途离开」，
        // 和主动退出一样要把剩余簸簸暂存，回来点空位坐下原样带回、免审核。
        // 必须赶在 retireSeat / 清 slot 之前取数。
        this.settlePending(sl.seat);   // v0.22.102：挂账带入先并账，暂存才不漏
        this.stashSeat(sl.seat);
        // 掉线不交给机器人：直接退座，位子空出来给真人
        this.retireSeat(sl.seat, 'offline');
        const wasOwner = this.ownerSeat === sl.seat;
        sl.token = null;
        sl.isAI = true;
        sl.name = '';
        sl.connected = false;
        sl.stack = 0;
        sl.satAt = 0;
        sl.asking = false;
        this.requests = this.requests.filter((r) => r.seat !== sl.seat);
        if (wasOwner) this.nextOwner();
        this.clearGhostLedger(sl.seat);   // v0.22.102：钱进了暂存，引擎座位别留双份
        changed = true;
      }
      for (const p of g.seats) {
        if (!p.isAI || !p.away) { this.awayAt.delete(p.seat); continue; }
        if (!this.awayAt.has(p.seat)) { this.awayAt.set(p.seat, now); continue; }
        if (now - this.awayAt.get(p.seat) < 1800) continue;
        try {
          g.sitDown(p.seat, { name: AI_NAMES[p.seat % AI_NAMES.length], stack: this.botStack });
          this.awayAt.delete(p.seat);
          changed = true;
        } catch (e) { /* 忽略 */ }
      }
      if (changed) this.broadcast();
    }, 1000);
  }

  bringIn(seat, amount) {
    return this.requestBuyIn(seat, amount);
  }

  decline(seat) {
    const g = this.game;
    if (!g || g.phase !== PHASE.SPLIT) throw new Error('当前不能弃牌');
    g.declineSpecial(seat);
    this.broadcast();
    this.pump();
  }

  split(seat, index) {
    const g = this.game;
    if (!g || g.phase !== PHASE.SPLIT) throw new Error('当前不能分牌');
    g.chooseSplit(seat, index);
    this.broadcast();
    this.pump();
  }

  saveChips() {
    if (!this.game) return;
    this.slots.forEach((s, i) => {
      const p = this.game.seats[i];
      if (p) s.stack = p.stack;
    });
  }

  /* ── 视图 ─────────────────────────────────── */

  /** 房间级信息：等待室与牌桌共用（uid = 看视图的人的账号 ID，用来算 amOwner） */
  roomMeta(seat, uid = null) {
    const mine = seat >= 0 ? this.requests.find((r) => r.seat === seat) : null;
    const owner = (seat >= 0 && seat === this.ownerSeat) || this.isOpenerUid(uid);
    return {
      roomId: this.id,
      ownerSeat: this.ownerSeat,
      // v0.20.28：开房人锁定——前端据此显示「房主」标识与离开提示
      ownerUid: this.ownerUid || '',
      amOwner: owner,
      seatCount: this.seatCount,
      stake: this.stakeLabel,
      ante: this.ante,
      handMango: this.handMango,
      minBuyIn: this.minBuyIn,
      durationMin: this.durationMin,
      // v0.22.61：把本桌实际生效的门槛下发，前端/排查都能直接核对开房设置
      floorMult: this.floorMult,
      // v0.22.67：本桌地九王开关，前端据此显隐桌面铭牌
      dijiuOn: this.dijiuOn,
      holdFloor: this.holdFloor(),
      startedAt: this.startedAt,
      deadline: this.deadline,
      remainMs: this.remainMs(),
      ended: this.ended,
      endReason: this.endReason || '',
      timeUp: this.timeUp,                 // 时间到，但这一手还没打完
      overtime: this.overtimeHands > 0,    // 正在加时抢芒果池
      overtimeHands: this.overtimeHands,
      closeAt: this.closeAt,
      closeInMs: this.closeAt ? Math.max(0, this.closeAt - Date.now()) : 0,
      botsEnabled: !!this.botsEnabled,   // 开发者开关：机器人补位
      watcherCount: this.watchers.length,
      // 围观席也要给头像：战绩页下半截要摆出来
      watchers: this.watchers.map((w) => ({
        name: w.name, seat: w.pendingSeat ?? null, connected: !!w.connected,
        avatar: (w.ws && w.ws.avatar) || w.avatar ||
          (typeof this.avatarOf === 'function' && ((w.ws && w.ws.userId) || w.uid)
            ? this.avatarOf((w.ws && w.ws.userId) || w.uid) : '') || '',
        uid: (w.ws && w.ws.userId) || w.uid || '',
      })),
      myRequest: mine ? { amount: mine.amount, at: mine.at } : null,
      requests: owner ? this.requests.slice() : [],
      // v0.20.28：强制离座名单（只有房主看得到），资料卡按钮与名单弹窗用
      forceOut: owner ? [...this.forceOut.entries()].map(([id, name]) => ({ uid: id, name })) : [],
      // 暂停发牌：这一手真能行动的人不够 2 个
      actableCount: this.actableCount(),
      dealHold: !!this.dealHold,
      // 本人已经点了「站起围观」、等这一手打完让座
      myStandUp: seat >= 0 ? !!(this.slots[seat] && this.slots[seat].standUp === 'after') : false,
      // 本人已经挂了「保位离桌」（牌局中先挂着也算）
      myHoldLeave: seat >= 0 ? !!(this.slots[seat] && this.slots[seat].holdLeave) : false,
      // 结算页标题用：房主的昵称
      ownerName: this.ownerName(),
    };
  }

  /** 等待室视图（未开局 / 或本手还没开始） */
  waitingView(seat, watcher = null, uid = null) {
    const base = this.roomMeta(seat, uid);
    return Object.assign({
      phase: 'WAITING',
      buyIn: this.minBuyIn,
      pot: 0,
      round: 0,
      handNo: 0,
      carryPot: 0,
      mangoKind: '',
      mangoStreak: 0,
      ended: this.ended,
      viewerSeat: seat,
      watching: seat < 0,
      ownerName: this.ownerName(),
      started: this.started,
      pendingSeat: watcher ? (watcher.pendingSeat ?? null) : null,
      humans: this.humans().length,
      humanCount: this.humans().length,               // 在座真人
      botCount: this.slots.filter((s) => !s.token && s.name).length, // 在座机器人
      readyCount: this.readyCount(),                  // 真人 + 机器人里簸簸够一底的人数
      actableCount: this.actableCount(),               // 这一手真能行动的人数（够门槛、没留座）
      dealHold: !!this.dealHold,                       // 人数不足 2，暂停发牌中
      canStart: this.canStart(seat, uid),
      seats: this.slots.map((s) => {
        // v0.22.96：broke 与弹出循环同口径——引擎簸簸 < 停发门槛（原来只看座位表
        // stack < 底皮，dealHold 期间引擎已归零而座位表还停在带入额，标签假消失）
        const broke = !!s.token && this.stackOf(s.seat) < this.holdFloor();
        // v0.22.88：没点带入是「占座」（15 秒）；点了带入按钮（申请挂起）是「留座」（180 秒）
        // v0.22.96：起算点与弹出侧对齐——引擎补了表的看 brokeSince，否则看坐下时刻 satAt；
        // 房主占座不设时限（waitBuyIn），前端挂「等带入」静态牌，不再显示误导的「占座 0s」。
        const gp = this.game && this.game.seats[s.seat];
        const waitOwner = broke && s.seat === this.ownerSeat;   // 房主占座：等带入，不设时限
        const liu = !!(s.asking || (gp && (gp.holdLeave || (gp.buyInTotal || 0) > 0)));
        const since = liu ? ((gp && gp.brokeSince) || (gp && gp.holdSince) || s.satAt || 0) : s.satAt;
        const sitHold = broke && !liu;
        const waitBuyIn = waitOwner || (broke && !since);
        const left = broke && since && !waitOwner
          ? Math.max(0, (sitHold ? SIT_HOLD_SECONDS : BROKE_SECONDS) - Math.floor((Date.now() - since) / 1000))
          : 0;
        return {
          seat: s.seat,
          mine: s.seat === seat,         // 是不是本人：前端点自己头像不弹资料卡
          name: s.name || '',            // 机器人也有名字，空位没名字
          stack: s.stack,
          isAI: !s.token,
          vacant: !s.token && !s.name,
          connected: s.connected,
          isOwner: s.seat === this.ownerSeat,
          uid: s.uid || '',
          forceOut: !!s.forceOut,
          waiting: broke,
          broke,
          hold: broke,
          sitHold,                       // 前端区分「占座 Xs」/「留座 Xs」文案
          asking: !!s.asking,
          brokeSince: since,
          brokeLeft: broke && since && !waitOwner ? left : null,
          waitBuyIn,
        };
      }),
    }, base);
  }

  /** 开发者观察者进来 / 离开（上帝视角，不占围观位） */
  addGod(ws) {
    if (ws && !this.gods.includes(ws)) this.gods.push(ws);
    this.touch();
  }

  dropGod(ws) {
    const i = this.gods.indexOf(ws);
    if (i >= 0) this.gods.splice(i, 1);
  }

  /**
   * 上帝视角：全桌底牌 + 剩余牌堆。
   * 只在开发者登录后下发，普通玩家永远拿不到这个视图。
   */
  godView() {
    if (!this.game || !this.started) {
      const v = this.waitingView(-1, null);
      v.god = true;
      v.deck = [];
      v.botsEnabled = this.botsEnabled;
      return v;
    }
    const v = this.withVacant(Object.assign(this.game.snapshotFor(-1, true), this.roomMeta(-1), {
      watching: true,
      pendingSeat: null,
      botsEnabled: this.botsEnabled,
    }));
    return v;
  }

  /** 围观者看到的牌桌：只有公共信息，别人的底牌一律不下发 */
  watchView(watcher) {
    if (!this.game || !this.started) return this.waitingView(-1, watcher, watcher && watcher.ws && watcher.ws.userId);
    return this.withVacant(Object.assign(this.game.snapshotFor(-1), this.roomMeta(-1, watcher && watcher.ws && watcher.ws.userId), {
      watching: true,
      pendingSeat: watcher ? (watcher.pendingSeat ?? null) : null,
    }));
  }

  /**
   * 给快照里的座位补 vacant：既没人坐、也不是机器人，前端才画成空位框。
   * 机器人开着的时候座位上有名字，要按「有人」渲染。
   */
  withVacant(view) {
    for (const p of view.seats || []) {
      const sl = this.slots[p.seat];
      p.vacant = !sl || (!sl.token && !sl.name);
      p.uid = (sl && sl.uid) || '';
      p.forceOut = !!(sl && sl.forceOut);
    }
    return view;
  }

  /**
   * 行动读秒：只在「真正换人 / 换轮 / 加注后重新表态」时重新起表。
   * broadcast 里先调一次，所有视角都带上同一个起点。
   */
  markTurn() {
    const g = this.game;
    if (!g || !this.started || g.phase !== PHASE.BET || g.currentSeat < 0) {
      this.turnKey = '';
      this.turnAt = 0;
      this.turnHoldLeft = 0;
      return;
    }
    const key = `${g.handNo}:${g.round}:${g.currentSeat}:${g.roundActions.length}`;
    if (key !== this.turnKey) {
      this.turnKey = key;
      // 换人/换轮重新表态：上一段加的 30s 时长作废，回到满 15s 起表
      this.turnExtMs = 0;
      // 新的一手：全桌加时次数清零（重新给 4 次）
      if (g.handNo !== this.extHandNo) {
        this.extHandNo = g.handNo;
        this.extUses = {};
      }
      // v0.22.51：开手演出宽限——本手第一次起表、且有人交了芒果份子时，
      // 把起表点推到动画播完之后：演出约 3 秒 + 网络余量。
      // 起表点（turnAt）推到未来，actTimer/读秒显示/机器人出手全部自动顺延。
      if (g.handNo !== this.fxHandNo) {
        this.fxHandNo = g.handNo;
        this.fxGrace =
          g.round === 1 && g.seats.some((p) => p.inHand && (p.mangoPaid || 0) > 0)
            ? HAND_FX_MS : 0;
      } else {
        // 同一手内换人/换轮重新表态：宽限只给开手那一次，之后清零
        this.fxGrace = 0;
      }
      // 搓牌还没搓完就先不起表：等搓完那一刻再给满 15 秒，
      // 不然搓 10 秒只剩 5 秒操作，等于让人不敢搓。
      const cur = g.seats[g.currentSeat];
      if (cur && cur.scratchUntil > Date.now()) {
        this.turnHoldLeft = TURN_SECONDS * 1000;
        this.turnAt = cur.scratchUntil + this.fxGrace;
      } else {
        this.turnHoldLeft = 0;
        this.turnAt = Date.now() + this.fxGrace;
      }
    }
  }

  turnLeft() {
    if (!this.turnAt) return 0;
    const total = TURN_SECONDS + Math.round((this.turnExtMs || 0) / 1000);
    // 搓牌暂停中：数字钉在暂停那一刻，搓完再接着走
    if (this.turnHoldLeft) {
      return Math.max(0, Math.min(total, Math.round(this.turnHoldLeft / 1000)));
    }
    const left = total - Math.floor((Date.now() - this.turnAt) / 1000);
    return Math.max(0, Math.min(total, left));
  }

  /** v0.20.25：加时——把当前行动读秒整体 +30s（次数与扣费由 index.js 校验后调进来） */
  applyExtend(seat) {
    this.extUses[seat] = (this.extUses[seat] || 0) + 1;
    this.turnExtMs = (this.turnExtMs || 0) + 30000;
    // 搓牌暂停期间加的时，接回冻住的读秒上
    if (this.turnHoldLeft) this.turnHoldLeft += 30000;
    this.pump();
    this.broadcast();
    return true;
  }

  /** 搓完：把暂停的那段读秒接回来，剩多少还是多少 */
  resumeTurnClock() {
    if (!this.turnHoldLeft) return;
    this.turnAt = Date.now() - (TURN_SECONDS * 1000 - this.turnHoldLeft);
    this.turnHoldLeft = 0;
    // 本手要是已经结算了就别再排行动定时器，交给 afterHand
    if (this.game && this.game.phase === PHASE.BET) this.pump();
  }

  /**
   * 分牌读秒跟着搓牌一起冻结：只要桌上还有人的第四张扣在牌背下，
   * 整桌 20 秒的分牌倒计时就停住；等最后一个人搓完，按停住的那段原样补回去。
   */
  syncSplitClock() {
    const g = this.game;
    if (!g || g.phase !== PHASE.SPLIT) {
      this.splitHold = null;
      return false;
    }
    const now = Date.now();
    const rubbing = g.seats.some((p) => p.scratchUntil > now);
    if (rubbing) {
      if (this.splitHold) return false;
      this.splitHold = { at: now, splitAt: g.splitAt || now };
      // 冻结期间不排自动分牌，免得到点把人从搓牌里拽出来
      if (this.actTimer) { clearTimeout(this.actTimer); this.actTimer = null; }
      return true;
    }
    if (!this.splitHold) return false;
    const held = now - this.splitHold.at;
    g.splitAt = (this.splitHold.splitAt || now) + held;
    this.splitHold = null;
    // 剩余秒数没变，但时钟重启了：重排自动分牌
    this.pump();
    return true;
  }

  /**
   * 玩家离场留档。战绩页要显示上传的头像，而引擎只认规则不认头像，
   * 所以在退座这一刻把连接上的头像快照补进留档行；
   * 名字对不上就不补（换人入座时 slot 里可能已经是下一位玩家了）。
   */
  /* ── v0.22.102：战绩账本卫生 ────────────────
   * 病根：离座只清 slot，引擎座位上的 stack/buyInTotal/handsTotal 原样残留
   * （幽灵账本）。后果两条：① 下一个坐这个位子的人可能继承上家的带入/手数
   * ——「起立重新入座，带入重复累计」；② 这份幽灵簸簸让整桌合计对不上，
   * 前端结算收口只能拿「带入」填差额——10/20 的牌局冒出零头。
   * 治法：离座三路径统一「并挂账 → 留档 → 清幽灵」，钱跟人走、账跟留档走。 */
  /** 把挂账带入并入簸簸（离座/暂存前先并账，防蒸发或漏算） */
  settlePending(seat) {
    const g = this.game;
    const p = g && g.seats[seat];
    if (p && (p.pendingBuyIn || 0) > 0) {
      p.stack = (p.stack || 0) + p.pendingBuyIn;
      p.buyInTotal = (p.buyInTotal || 0) + p.pendingBuyIn;
      p.pendingBuyIn = 0;
    }
  }
  /** 清掉离座后的幽灵账本（留档行已带走带入/手数/输赢；正在打的手不动） */
  clearGhostLedger(seat) {
    const g = this.game;
    const p = g && g.seats[seat];
    if (!p || p.inHand) return;   // 牌还在手上：钱在池子里，结算要写回这个座位
    p.stack = 0;
    p.buyInTotal = 0;
    p.handsTotal = 0;
    p.retiredKey = '';
    p.retiredAt = 0;
  }

  retireSeat(seat, reason) {
    const g = this.game;
    if (!g) return null;
    const p = g.seats[seat];
    const wasName = p ? String(p.name || '') : '';
    const slot = this.slots && this.slots[seat];
    const av = (slot && slot.ws && slot.ws.avatar) || '';
    const row = g.retire(seat, reason);
    if (row) row.uid = (slot && slot.uid) || '';       // v0.22.98：留档带 uid，续账本按人认
    if (row && av && wasName && (!slot.name || String(slot.name) === wasName)) row.avatar = av;
    return row;
  }

  /**
   * 座位头像：登录时挂在连接上（ws.avatar），广播时按座位号贴到快照里。
   * 牌局逻辑不认识头像，只有 UI 用，所以统一在出口处补，引擎保持纯规则。
   */
  attachAvatars(v) {
    if (!v || !Array.isArray(v.seats)) return v;
    const avatarOf = typeof this.avatarOf === 'function' ? this.avatarOf : null;
    for (const s of v.seats) {
      const slot = s && s.seat != null ? this.slots[s.seat] : null;
      const uid = (slot && slot.uid) || '';
      // v0.22.64：断线重连会把 slot.ws 换成一条没带头像的新连接，
      // 只认连接上的 ws.avatar 会让全桌看到系统默认脸。取不到就按座位
      // 绑定的账号 ID 回查账号库（registerRoom 注入 avatarOf）。
      s.avatar = (slot && slot.ws && slot.ws.avatar)
        || (avatarOf && uid ? avatarOf(uid) : '')
        || (slot && slot.avatar) || '';
      // 玩家信息弹窗要显示 ID；机器人没有账号，给个「电脑」占位
      s.uid = uid;
    }
    return v;
  }

  /** 把读秒字段并在快照上（服务端时间以 turnLeft 为准，前端自己校准） */
  stampTurn(v) {
    if (!v) return v;
    this.attachAvatars(v);
    // v0.22.89：下发服务端时间戳，前端结合 RTT 估算画面落后了多少（诊断弱网）
    v.srvTs = Date.now();
    v.turnAt = this.turnAt || 0;
    v.turnLeft = this.turnAt ? this.turnLeft() : 0;
    v.turnExtMs = this.turnExtMs || 0;   // v0.20.25：本段行动已加时的毫秒数
    v.extUses = this.extUses || {};      // seat -> 本手已加时次数（前端灰按钮/徽标用）
    return v;
  }

  /**
   * 透视快照：给已授权玩家的「原位上帝视角」。
   * 不加 god 标记（否则前端会当成只看不动的观察者），改用 cheat 标记；
   * 牌堆一起下发，前端在桌面中央摆半透明牌堆供选牌。
   */
  cheatView(viewerSeat, uid = null) {
    if (!this.game || !this.started) {
      const v = this.waitingView(viewerSeat, null, uid);
      v.cheat = true;
      v.god = false;
      v.deck = [];
      return v;
    }
    const v = Object.assign(this.game.snapshotFor(viewerSeat, true), this.roomMeta(viewerSeat, uid));
    v.god = false;
    v.cheat = true;
    v.watching = viewerSeat < 0;
    v.deck = this.game.deck.slice().reverse();
    return this.withVacant(v);
  }

  broadcast() {
    this.markTurn();
    // v0.22.85：弱网积压保护 —— 发送缓冲超过 128KB（约 20 条全量快照没发出去）
    // 的连接跳过这次推送，状态再变化时会自动补发最新快照。不保护的话弱网端
    // 缓冲只会越积越多：画面越来越滞后（「卡」），最后心跳超时被踢（「卡断掉」）。
    const BACKLOG_LIMIT = 131072;
    for (const s of this.slots) {
      if (!s.ws || s.ws.readyState !== 1) continue;
      // v0.22.89：被跳过的连接打上 _backlog 标记，flushBacklog 定时扫描补发
      if (s.ws.bufferedAmount > BACKLOG_LIMIT) { s.ws._backlog = true; continue; }
      s.ws._backlog = false;
      const cheat = !!s.ws.cheat && !s.ws.cheatOff;
      const view = this.game && this.started
        ? (cheat
          ? this.cheatView(s.seat, s.ws.userId)
          : this.withVacant(Object.assign(this.game.snapshotFor(s.seat), this.roomMeta(s.seat, s.ws.userId))))
        : this.waitingView(s.seat, null, s.ws.userId);
      this.send(s.ws, { t: 'state', data: this.stampTurn(view) });
    }
    // 围观的人：坐着等座也照样看牌桌（看不到别人的底牌）
    for (const w of this.watchers) {
      if (!w.ws || w.ws.readyState !== 1) continue;
      if (w.ws.bufferedAmount > BACKLOG_LIMIT) { w.ws._backlog = true; continue; }
      w.ws._backlog = false;
      const cheat = !!w.ws.cheat && !w.ws.cheatOff;
      const view = cheat
        ? this.cheatView(-1)
        : this.watchView(w);
      this.send(w.ws, { t: 'state', data: this.stampTurn(view) });
    }
    // 开发者：上帝视角（全桌底牌 + 牌堆）
    for (const g of this.gods) {
      if (!g || g.readyState !== 1) continue;
      this.send(g, { t: 'state', data: this.stampTurn(this.godView()) });
    }
    // 有人的第四张还扣着等「搓不搓」，到点补一次推送
    this.scheduleScratchFlush();
  }

  /* ── v0.22.89：弱网补发 ─────────────────────────────
   * sendState(ws)：把「这条连接视角」的最新快照单独发给他（sync 请求用）。
   * flushBacklog()：每 2 秒被上层扫一遍，把曾因发送缓冲超限被广播跳过、
   * 现在缓冲已排空的连接补一次最新快照——否则全桌等他行动、没有新广播
   * 时，他的画面会冻结在旧的一手直到读秒超时（玩家看到的就是「卡死」）。
   */
  sendState(ws) {
    if (!ws || ws.readyState !== 1) return;
    const seat = typeof ws.seat === 'number' ? ws.seat : -1;
    const s = seat >= 0 ? this.slots[seat] : null;
    const inSlots = s && s.ws === ws;
    const cheat = !!ws.cheat && !ws.cheatOff;
    let view;
    if (inSlots) {
      view = this.game && this.started
        ? (cheat
          ? this.cheatView(seat, ws.userId)
          : this.withVacant(Object.assign(this.game.snapshotFor(seat), this.roomMeta(seat, ws.userId))))
        : this.waitingView(seat, null, ws.userId);
    } else {
      const w = this.watchers.find((x) => x.ws === ws);
      view = cheat
        ? this.cheatView(-1)
        : (w ? this.watchView(w) : this.waitingView(-1, null, ws.userId));
    }
    if (!view) return;
    this.send(ws, { t: 'state', data: this.stampTurn(view) });
  }

  flushBacklog() {
    for (const s of this.slots) {
      const ws = s.ws;
      if (!ws || ws.readyState !== 1 || !ws._backlog) continue;
      if (ws.bufferedAmount > 65536) continue;   // 还没排空，继续等
      ws._backlog = false;
      try { this.sendState(ws); } catch { /* 连接正断 */ }
    }
    for (const w of this.watchers) {
      const ws = w.ws;
      if (!ws || ws.readyState !== 1 || !ws._backlog) continue;
      if (ws.bufferedAmount > 65536) continue;
      ws._backlog = false;
      try { this.sendState(ws); } catch { /* 连接正断 */ }
    }
  }

  /** 开发者的观察连接断了：从观察名单里摘掉 */
  dropGodEverywhere(ws) {
    this.dropGod(ws);
  }

  /* ── 搓牌 ──────────────────────────────────
   * 玩家在战绩页把搓牌打开后，发到第四张时先扣住牌面：
   * 只扣给自己看的那一份照发（铺搓牌画面），其余人看到牌背；
   * 本人大约 10 秒内搓开，或到点，牌面照常翻出来。
   */
  scratch(seat, on) {
    const g = this.game;
    if (!g || !this.started) return;
    const ok = on ? g.scratchStart(seat, SCRATCH_SECONDS * 1000) : g.scratchDone(seat);
    if (!ok) return;
    if (on) {
      // 搓牌期间本人的行动读秒暂停：记下暂停那一刻还剩多少，搓完原样接回来
      if (g.phase === PHASE.BET && g.currentSeat === seat) {
        const p = g.seats[seat];
        if (p && p.scratchUntil > Date.now()) {
          this.turnHoldLeft = Math.max(0, TURN_SECONDS * 1000 - (Date.now() - this.turnAt));
          // 起表点往后挪到「搓完之后还剩 turnHoldLeft」的位置，托管定时器自然跟着顺延
          this.turnAt = p.scratchUntil - (TURN_SECONDS * 1000 - this.turnHoldLeft);
          this.pump();
        }
      }
    } else {
      this.resumeTurnClock();
    }
    // 全桌等搓牌的闸门可能因此解除：重新排行动定时器
    if (g.phase === PHASE.BET) this.pump();
    // 分牌读秒：开搓就冻住，搓完再接着走
    this.syncSplitClock();
    this.broadcast();
  }

  /** 第四张的等待窗口到期后补一次广播，把牌亮出来（不然要等下一手推送） */
  scheduleScratchFlush() {
    if (this.scratchFlush) return;
    const g = this.game;
    if (!g) return;
    const gated = g.seats.filter((p) => p.scratchGate > 0);
    if (!gated.length) return;
    const wait = Math.min(...gated.map((p) => p.scratchGate)) - Date.now();
    this.scratchFlush = setTimeout(() => {
      this.scratchFlush = null;
      if (!this.game) return;
      if (this.game.expireScratch()) {
        this.broadcast();
        if (this.game.phase === PHASE.BET) this.pump();
      }
    }, Math.max(30, Math.min(wait + 20, 1200)));
    if (this.scratchFlush.unref) this.scratchFlush.unref();
  }

  send(ws, obj) {
    try { ws.send(JSON.stringify(obj)); } catch { /* 连接已断 */ }
  }

  /** 给桌上所有人推同一条消息（含围观、上帝视角）：洗牌广播这类全桌同内容的事件用 */
  broadcastAll(obj) {
    for (const s of this.slots) if (s.ws && s.ws.readyState === 1) this.send(s.ws, obj);
    for (const w of this.watchers) if (w.ws && w.ws.readyState === 1) this.send(w.ws, obj);
    for (const g of this.gods) if (g && g.readyState === 1) this.send(g, obj);
  }

  /** v0.20.76 发发看：牌面只发给购买者本人，其余连接（含围观、上帝视角）只收到
   *  「三张牌背」的标记，前端用 cardEl(null) 渲染 .card.back，自动跟随本机
   *  「桌面设置 → 牌背」素材。真实的 cards 绝不发给非购买者，避免泄露下一手牌。 */
  broadcastPeek(byUid, cards, by, cost) {
    const all = [];
    for (const s of this.slots) if (s.ws && s.ws.readyState === 1) all.push(s.ws);
    for (const w of this.watchers) if (w.ws && w.ws.readyState === 1) all.push(w.ws);
    for (const g of this.gods) if (g && g.readyState === 1) all.push(g);
    for (const c of all) {
      this.send(c, peekPayloadFor(c.userId, byUid, cards, by, cost));
    }
  }

  /** 驱动机器人 / 超时托管 / 下一局 */
  pump() {
    clearTimeout(this.botTimer);
    clearTimeout(this.actTimer);
    clearTimeout(this.nextTimer);
    if (this.blockPoll) { clearTimeout(this.blockPoll); this.blockPoll = null; }
    const g = this.game;
    if (!g) return;

    if (g.phase === PHASE.BET) {
      const seat = g.currentSeat;
      if (seat < 0) return;
      // 全桌等搓牌：有人在搓（倒计时没走完），行动定时器先不排；
      // 行动读秒钉住不动（每 400ms 补一次起表点）——本人搓牌暂停（turnHoldLeft）走老机制，不抢
      if (g.scratchBlocking && g.scratchBlocking()) {
        if (!this.turnHoldLeft) this.turnAt = Date.now();
        this.blockPoll = setTimeout(() => { this.blockPoll = null; this.pump(); }, 400);
        if (this.blockPoll.unref) this.blockPoll.unref();
        return;
      }
      if (g.seats[seat].isAI) {
        // v0.22.51：开手演出期间机器人也不出手——加上演出剩余宽限
        const fxLeft = Math.max(0, (this.turnAt || 0) - Date.now());
        this.botTimer = setTimeout(() => this.botMove(seat), 600 + Math.random() * 500 + fxLeft);
      } else {
        // 从读秒起点算剩余，别被中途的状态推送把 15 秒又续上（加时另加 turnExtMs）
        const left = this.turnAt
          ? Math.max(0, TURN_SECONDS * 1000 + (this.turnExtMs || 0) - (Date.now() - this.turnAt))
          : TURN_SECONDS * 1000 + (this.turnExtMs || 0);
        this.actTimer = setTimeout(() => this.timeoutAct(seat), left);
      }
      return;
    }

    if (g.phase === PHASE.SPLIT) {
      const pending = g.aliveSeats().filter((x) => !g.seats[x].split);
      if (!pending.length) return;
      // 有人正在搓牌：分牌读秒冻着，等搓完 syncSplitClock 再排自动分牌
      if (this.splitHold) return;
      // 分牌倒计时 15 秒：从进入分牌那一刻算，到点按最优分法自动分
      const left = SPLIT_SECONDS * 1000 - (Date.now() - (g.splitAt || Date.now()));
      this.actTimer = setTimeout(() => {
        for (const x of pending) {
          const p = g.seats[x];
          if (!p.splitOptions || p.split) continue;
          let bi = 0;
          let bs = -Infinity;
          // 默认按「头尾两门都最硬」的那一种拆，头牌自动取牌力更大的那组
          p.splitOptions.forEach((o, i) => { if (o.score > bs) { bs = o.score; bi = i; } });
          try {
            g.chooseSplit(x, bi);
          } catch { /* 上一家分完可能已经自动结算，忽略 */ }
        }
        this.broadcast();
        this.pump();
      }, Math.max(0, left));
      return;
    }

    if (g.phase === PHASE.SETTLED) {
      // 收尾逻辑统一走 afterHand：正常续手 / 加时抢滚存 / 结束整场
      this.afterHand();
    }
  }

  botMove(seat) {
    const g = this.game;
    if (!g || g.phase !== PHASE.BET || g.currentSeat !== seat) return;
    const d = decide(g, seat);
    try {
      g.act(seat, d.action, d.amount);
    } catch {
      try { g.act(seat, d.action); } catch {
        try { g.act(seat, 'fold'); } catch { /* 忽略 */ }
      }
    }
    this.broadcast();
    this.pump();
  }

  timeoutAct(seat) {
    const g = this.game;
    if (!g || g.phase !== PHASE.BET || g.currentSeat !== seat) return;
    if (!g.legalActions(seat).length) return;
    g.autoAct(seat);
    this.broadcast();
    this.pump();
  }

  /* ── 战绩历史落盘（结算时抓一次，保留 24 小时，可按房间号调出） ── */

  /** 结算这一刻的完整战绩快照，结构和前端 buildStats 的输入一致，
   *  这样战绩图页面能直接复用前端同一套「按名字并栏 / 累加」口径。 */
  statsSnapshot() {
    const g = this.game;
    const seats = this.slots
      .filter((s) => s.token || (g && g.seats[s.seat] && g.seats[s.seat].isAI))
      .map((s) => {
        const p = g && g.seats[s.seat];
        if (!p) return null;
        const avatar = (s.ws && s.ws.avatar) || '';
        return {
          seat: s.seat,
          name: p.name || s.name || '',
          avatar,
          isAI: !!p.isAI,
          away: !!p.away,
          buyIn: p.buyInTotal || 0,
          hands: p.handsTotal || 0,
          net: (p.stack || 0) - (p.buyInTotal || 0),
          pending: p.pendingBuyIn || 0,
          stack: p.stack || 0,
        };
      })
      .filter(Boolean);
    return {
      room: this.id,
      savedAt: Date.now(),
      createdAt: this.createdAt || 0,
      reason: this.endReason || '',
      ante: this.ante,
      floorMult: this.floorMult,
      handNo: g ? g.handNo : 0,
      participants: [...this.participants],
      departed: g ? JSON.parse(JSON.stringify(g.departed)) : [],
      seats,
    };
  }

  /* ── 落盘（服务重启后房间还在，牌局重置为等待室） ── */

  toJSON() {
    const g = this.game;
    return {
      id: this.id,
      ante: this.ante,
      handMango: this.handMango,
      minBuyIn: this.minBuyIn,
      seatCount: this.seatCount,
      durationMin: this.durationMin,
      ownerSeat: this.ownerSeat,
      ownerUid: this.ownerUid,
      ownerNick: this.ownerNick,
      // v0.22.61：最低可玩簸簸倍数必须落盘。之前漏了它，服务一重启
      // 恢复出来的房间全部回落到默认 ×8，开房时选的档位白选了。
      floorMult: this.floorMult,
      // v0.22.67：地九王开关落盘，服务重启后照样按开房时的选择生效
      dijiuOn: this.dijiuOn,
      // v0.20.97：本桌启用的防串通规则，重启后照样生效
      fair: { ...this.fair },
      // 强制离座名单：重启后照样拦着，不让人钻空子
      forceOut: [...this.forceOut.entries()],
      // v0.20.95：进过这桌的账号，重启后「你的房间」照样能找回
      participants: [...this.participants],
      createdAt: this.createdAt,
      slots: this.slots
        .filter((s) => s.token)
        .map((s) => {
          const p = g && g.seats[s.seat];
          return {
            seat: s.seat,
            token: s.token,
            name: s.name,
            stack: p ? p.stack : s.stack,
            buyInTotal: p ? (p.buyInTotal || 0) : s.stack,
            handsTotal: p ? (p.handsTotal || 0) : 0,
            // v0.20.96：重启后同网络/同设备仍然拦得住（定位不落盘，10 分钟就失效）
            ip: s.ip || '',
            deviceId: s.deviceId || '',
          };
        }),
      // 围观的人：重启后凭 token 还能回到边上等座
      watchers: this.watchers.map((w) => ({
        token: w.token, name: w.name, stack: Math.max(0, Math.floor(Number(w.stack) || 0)),
      })),
      // v0.22.74：离房暂存的簸簸，重启后回来照样认领
      stash: [...this.stash.entries()],
    };
  }

  static fromJSON(data) {
    const room = new Room(data.id, {
      ante: data.ante,
      handMango: data.handMango,
      minBuyIn: data.minBuyIn || data.buyIn,
      seatCount: data.seatCount,
      durationMin: data.durationMin,
      ownerSeat: data.ownerSeat,
      ownerUid: data.ownerUid || '',
      ownerNick: data.ownerNick || '',
      createdAt: data.createdAt,
      // v0.22.61：老存档没有这个字段时，Room 构造函数会自动回落到 ×8
      floorMult: data.floorMult,
      // v0.22.67：老存档没有这个字段时，Room 构造函数默认开（true）
      dijiuOn: data.dijiuOn !== false,
      fairIp: !!(data.fair && data.fair.ip),
      fairDev: !!(data.fair && data.fair.dev),
      fairGeo: !!(data.fair && data.fair.geo),
    });
    for (const [id, name] of data.forceOut || []) {
      if (id) room.forceOut.set(String(id), String(name || ''));
    }
    for (const uid of data.participants || []) {
      if (uid) room.participants.add(String(uid));
    }
    for (const s of data.slots || []) {
      const slot = room.slots[s.seat];
      if (!slot) continue;
      slot.token = s.token;
      slot.name = s.name;
      slot.stack = Number.isFinite(s.stack) ? s.stack : 0;
      slot.isAI = false;
      slot.ip = s.ip || '';
      slot.deviceId = s.deviceId || '';
      slot.connected = false;
      slot.offlineAt = Date.now();
    }
    for (const w of data.watchers || []) {
      if (!w || !w.token) continue;
      room.watchers.push({
        name: String(w.name || '围观').slice(0, 8),
        token: w.token,
        ws: null,
        connected: false,
        at: Date.now(),
        offlineAt: Date.now(),
        pendingSeat: null,
        stack: Math.max(0, Math.floor(Number(w.stack) || 0)),
      });
    }
    for (const [k, v] of data.stash || []) {
      if (k && v && Number(v.stack) > 0) {
        room.stash.set(String(k), { stack: Math.floor(Number(v.stack)), name: String(v.name || ''), at: Number(v.at) || Date.now() });
      }
    }
    room.touch();
    // v0.22.97：恢复的房间也要有每秒 ticker——fromJSON 不建定时器的话，服务重启后
    // 恢复房间的弹座/断线清座/关房全部停摆，00:00 的灰头像永远挂在桌上。
    room.startTicker();
    return room;
  }

  destroy() {
    this.closed = true;
    this.closeAt = 0;
    clearInterval(this.tickTimer);
    clearTimeout(this.botTimer);
    clearTimeout(this.actTimer);
    clearTimeout(this.nextTimer);
    this.nextAt = 0;
    clearTimeout(this.scratchFlush);
    this.scratchFlush = null;
    for (const s of this.slots) {
      if (s.ws) { try { s.ws.close(); } catch { /* 忽略 */ } }
    }
    for (const w of this.watchers) {
      if (w.ws) { try { w.ws.close(); } catch { /* 忽略 */ } }
    }
  }
}

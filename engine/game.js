/**
 * 扯旋对局状态机（服务器权威）
 * ------------------------------------------------------------------
 * 所有判定（发牌、下注合法性、分牌、比大小、结算）都在这里完成，
 * 客户端只发意图、只收事件。这个文件不依赖任何 IO，可直接被
 * Node 服务端、浏览器（单机练习）、Cocos 客户端复用。
 */

import { cloneDeck, shuffle, secureRandomInt } from './cards.js';
import { comparePair, isEmperorHand, isEarthHand } from './evaluator.js';
import { enumerateSplits, bestSplit } from './split.js';

export const BROKE_SECONDS = 180;
export const SPLIT_SECONDS = 20;   // 分牌倒计时：读秒到 0 自动按最优分法
export const TURN_SECONDS = 15;    // 行动倒计时：读秒到 0 按「上家动作」托管
// 搓牌：第四张牌扣在牌背下，最长搓 10 秒；发到第四张后先留 900ms 窗口，
// 让本人来得及说一声「这一手我要搓」，别让全场先看到一眼牌面。
export const SCRATCH_SECONDS = 10;
export const SCRATCH_GATE_MS = 900;

export const PHASE = {
  WAITING: 'WAITING',
  BET: 'BET',
  SPLIT: 'SPLIT',
  SETTLED: 'SETTLED',
};

export const ACTION_NAME = {
  follow: '跟',
  raise: '大',
  knock: '敲',
  pass: '休',
  fold: '丢',
};

/** 三花十 / 三花六：本局不输不赢 */
export function detectSpecial(hand) {
  const has = (fn) => hand.some(fn);
  const red10 = has((c) => c.color === 'red' && c.rank === '10');
  const black10 = has((c) => c.color === 'black' && c.rank === '10');
  const blackJ = has((c) => c.color === 'black' && c.rank === 'J');
  if (red10 && black10 && blackJ) return '三花十';
  const red6 = has((c) => c.color === 'red' && c.rank === '6');
  const black6 = has((c) => c.color === 'black' && c.rank === '6');
  const joker = has((c) => c.id === 'BJ');
  if (red6 && black6 && joker) return '三花六';
  return null;
}

/**
 * 手里有没有「同色同点两张」：四张齐时用来判断三花该不该认。
 * 对子必须是同色同点（♥Q + ♦Q 算一对，♥4 + ♠4 不算），
 * 所以三花本身自带的那两张不同色的 10（或 6）不算对子。
 */
export function hasColorPair(hand) {
  const seen = new Set();
  for (const c of hand) {
    if (c.id === 'BJ') continue;      // 大王不参与配对
    const k = c.color + '-' + c.rank;
    if (seen.has(k)) return true;
    seen.add(k);
  }
  return false;
}

/**
 * 本手算不算三花。
 * 前三张凑齐（红10+黑10+黑J / 红6+黑6+大王）就认，当场退注退出这一手；
 * 但四张全齐时手里带着对子（同色同点，如两张红10），牌力已经够了，
 * 不认三花，照常分牌比大小。只是不同色的同点数（红10 + 黑10）不算对子，
 * 这种四张齐的三花照样认。
 *
 * 三花六自带大王，只要手里还有红3，就同时握着丁皇（红3+大王，最强两张牌型），
 * 这时三花六让位，照常分牌比大小——底牌、第三张、第四张凑成都一样。
 */
export function specialOf(hand) {
  const sp = detectSpecial(hand);
  if (!sp) return null;
  if (sp === '三花六' && hand.some((c) => c.id === 'H3')) return null; // 丁皇压三花六
  if (hand.length >= 4 && hasColorPair(hand)) return null;
  return sp;
}

/** 比较两手已分好的牌：1 胜 / -1 负 / 0 平 */
export function compareSplits(a, b) {
  const h = comparePair(a.head, b.head);
  const t = comparePair(a.tail, b.tail);
  if (h > 0 && t > 0) return 1;
  if (h < 0 && t < 0) return -1;
  if (h >= 0 && t >= 0) return h + t > 0 ? 1 : 0; // 一胜一平 = 胜
  if (h <= 0 && t <= 0) return h + t < 0 ? -1 : 0; // 一负一平 = 负
  return 0; // 一胜一负 = 平
}

export class Game {
  static BROKE_SECONDS = BROKE_SECONDS;

  constructor({ players, ante = 10, handMango = 0, cap = 5000, banker = 0, rand = secureRandomInt, mangoEnabled = true, floorMult = 8, dijiuOn = true }) {
    if (players.length < 2 || players.length > 8) throw new Error('人数需为 2~8 人');
    this.seats = players.map((p, i) => ({
      seat: i,
      id: p.id,
      name: p.name,
      stack: p.chips ?? p.stack ?? 0,   // 簸簸：本人带上桌的钱，只在一手结算后变动
      broke: false,        // 簸簸见底：留座读秒
      brokeSince: 0,
      away: false,         // 读秒走完还没带入：已经离座
      pendingBuyIn: 0,     // 打到一半带入的钱：先记账，本手结算完再进簸簸
      isAI: !!p.isAI,
      hand: [],
      bet: 0,
      folded: false,
      knocked: false,
      allIn: false,
      inHand: false,
      splitOptions: null,
      splitIndex: null,
      split: null,
      special: null,
      lastAction: null,
      delta: 0,
      mangoPaid: 0,        // 本手已经投进底池的芒果份子钱
      scratchUntil: 0,     // 搓牌：第四张牌扣在牌背下的截止时刻（0 = 不扣）
      scratchGate: 0,      // 刚发到第四张时的短暂等待窗口：等本人声明「我要搓」
      scratchUsed: false,  // 这一手搓过了（一手只搓一次，不能反复续时间）
      scratchPaid: false,  // 整场的搓牌费已经付过（一手扣一次太碎，改为整场一次）
      showHand: false,     // 强制秀牌：本手对全桌亮牌（下一手自动收起）
      hold: false,         // 还没带入、留座中等房主同意
      asking: false,       // 已提交带入申请（v0.22.82 起不停表，留座倒计时照走）
      holdLeave: false,    // 保位离桌：本手结算后进留座倒计时，读完让座
      holdSince: 0,        // 保位离桌的倒计时起点
      timeouts: 0,         // 本手读秒归零的次数：累计 2 次 → 下手停发牌、进留座倒计时
      autoHold: false,     // 两次托管：下一手不再发牌
      // 实时战绩：带入总额 / 打了几手（胜负按「当前持有 - 带入」实时算）
      buyInTotal: p.chips ?? p.stack ?? 0,
      handsTotal: 0,
    }));
    this.ante = ante;
    // 圈芒：通常 2 倍底皮，但 2/5 这种档位单列，所以允许房主直接指定
    this.handMango = Number(handMango) > 0 ? Math.floor(Number(handMango)) : ante * 2;
    this.capBase = cap;   // 开局簸簸（房间买入）
    this.capAdded = 0;    // 中途「添簸」累计
    this.capSeq = 0;      // 添簸序号，前端据此放金币
    this.lastCapAdd = null;
    this.buyIn = cap;     // 添簸一次至少这么多
    // 停牌门槛（v0.22.39）：房主在开房页选定「最低可玩簸簸 = 底皮 × n」，
    // n ∈ 4 / 6 / 8 / 10 / 12 / 16（默认 10）。簸簸低于这个数，下一手不发牌、
    // 座位保留、开始 180 秒留座读秒。整局固定值，不再跟着全桌投入浮动。
    const FLOOR_MULTS = [4, 6, 8, 10, 12, 16];
    this.floorMult = FLOOR_MULTS.includes(Number(floorMult)) ? Number(floorMult) : 8;
    this.holdFloor = Math.max(1, this.ante * this.floorMult);
    // v0.22.67：本桌是否启用「地九王」（2+9 = 地王）。默认开；关掉时 2+9 按 1 点散牌算。
    this.dijiuOn = dijiuOn !== false;

    this.step = ante;
    this.banker = banker % players.length;
    this.rand = rand;
    this.deck = [];
    this.round = 0;
    this.phase = PHASE.WAITING;
    this.currentSeat = -1;
    this.roundHighest = 0;
    this.history = [];
    this.result = null;
    this.handNo = 0;
    // 芒果：圈芒 / 休芒 / 揍芒 共用同一个池子
    this.mango = 0;
    // 芒果滚存：休芒时这一手的底皮 + 份子不退，累到下一手，谁赢谁通吃
    this.carryPot = 0;
    this.mangoKind = null;   // 'xiu' 休芒 | 'zou' 揍芒
    this.mangoStreak = 0;    // 连续次数
    this.mangoMult = 0;      // 本手份子倍数：0 正常手 / 1 / 2 / 4 / 8（逐次翻倍，封顶 8）
    // 定牌：seat -> [第三张, 第四张] 的牌 id。只影响这一手，发牌时从牌堆中间抽走，
    // 其余牌的顺序不变（等价于「这两张本来就在这个位置」）。
    this.rigged = new Map();
    this.lastWinnerId = null;
    this.roundActions = [];
    this.actedThisRound = new Set();
    this.mangoEnabled = mangoEnabled;
    this.voidEnabled = true;
    this.log = []; // 牌局回顾
    // 结算期全桌亮底牌：revealUntil 之前所有人都看得到四张；allRevealedHand 防重复买
    this.revealUntil = 0;
    this.allRevealedHand = -1;
    // 中途离场的玩家：座位换人后战绩不丢，灰显在战绩表末尾
    this.departed = [];
  }

  get seatCount() {
    return this.seats.length;
  }

  /** 当前底池 = 芒果滚存 + 本圈芒果份子钱 + 所有人本手投入之和 */
  get pot() {
    return this.carryPot + (this.mangoIn || 0) + this.seats.reduce((s, p) => s + p.bet, 0);
  }

  /**
   * 皮池拆分：主池 / 边池。
   *   · 皮池只算本手每个人下到桌上的簸簸（bet 已含底皮），不含芒果；
   *   · 弃牌、三花退回之后留在桌上的钱算死钱，全部进主池；
   *   · 只有出现「短码全下」才分边池：最低一档人人有份是主池，
   *     往上一档只在够得着的人之间成池；只有一个人够到的部分不算池子（结算时原样退回）。
   * 例：A 500 / B 300 / C 700 全下 → 主池 300×3=900、边池 (500-300)×2=400，C 多出的 200 退回。
   */
  potSplit() {
    const live = this.seats.filter((p) => p.inHand && !p.folded && !p.special);
    const dead = this.seats
      .filter((p) => p.inHand && p.folded)
      .reduce((s, p) => s + p.bet, 0);
    const bets = live.map((p) => p.bet).sort((a, b) => a - b);
    if (!bets.length) return { main: dead, side: 0, sidePots: [], split: false, total: dead };

    const total = bets.reduce((a, b) => a + b, 0) + dead;
    const top = bets[bets.length - 1];
    // 短码全下：有人把簸簸推光，而且他这一手的投入比桌上最高的注少
    const short = live.some((p) => p.bet < top && (p.knocked || p.shortKnock || p.stack <= 0));
    if (!short) return { main: total, side: 0, sidePots: [], split: false, total };

    const levels = [...new Set(bets)].sort((a, b) => a - b);
    const main = bets[0] * bets.length + dead;
    const sidePots = [];
    for (let i = 1; i < levels.length; i++) {
      const n = bets.filter((b) => b >= levels[i]).length;
      if (n < 2) continue;      // 只有一个人够到的零头，不算池子
      sidePots.push((levels[i] - levels[i - 1]) * n);
    }
    const side = sidePots.reduce((a, b) => a + b, 0);
    return { main, side, sidePots, split: sidePots.length > 0, total };
  }

  /** 从某座位开始的逆时针顺序 */
  orderFrom(start) {
    const n = this.seats.length;
    return Array.from({ length: n }, (_, k) => (start + k) % n);
  }

  aliveSeats() {
    // 三花（三花十 / 三花六）凑齐即自动弃牌，等同于不在局，不再参与喊价与结算
    return this.seats.filter((p) => p.inHand && !p.folded && !p.special).map((p) => p.seat);
  }

  startHand() {
    this.expireBroke();
    this.applyPendingBuyIns();
    this.handNo += 1;
    this.deck = shuffle(cloneDeck(), this.rand);
    this.round = 0;
    this.result = null;
    this.history = [];
    this.roundActions = [];
    this.actedThisRound = new Set();
    this.revealUntil = 0;
    this.revealBySeat = -1;
    this.allRevealedHand = -1;

    // 芒果份子钱：每手开局直接从簸簸扣进底池，跟着底池一起滚，赢家通吃
    this.mangoIn = 0;

    // 芒果份子阶梯（提前算：停发门槛要用）：正常手只交圈芒，不收份子。
    //   休芒 / 揍芒共用同一条链，每多连一次份子翻一倍：
    //   第 1 次 ×1、第 2 次 ×2、第 3 次 ×4、第 4 次起 ×8（封顶）。
    //   1/2 档：底皮 1 + 圈芒 2 → 正常 3；×1 共 5；×2 共 7；×4 共 11；×8 起共 19。
    this.mangoMult = this.mangoStreak > 0
      ? Math.min(8, 2 ** Math.min(this.mangoStreak - 1, 3))
      : 0;
    // 逐人口径（留座/展示/房间计数用它）：
    // 收过揍芒的收池者免份子，只出底皮 + 圈芒。
    // 倍数实时按 mangoStreak 算（不用本手已用过的 mangoMult）：
    // 结算后、下一手开牌前的窗口里，房间 actableCount 也要拿到正确门槛。
    this._handCost = (p) => this.mangoEnabled
      ? this.ante + this.handMango
        * ((this.mangoKind === 'zou' && p.id === this.lastWinnerId)
          ? 1
          : 1 + (this.mangoStreak > 0
            ? Math.min(8, 2 ** Math.min(this.mangoStreak - 1, 3)) : 0))
      : this.ante;

    for (const p of this.seats) {
      p.hand = [];
      p.folded = false;
      p.knocked = false;
      p.allIn = false;
      p.shortKnock = false;
      // 同一手读秒归零两次：下一手停发牌、进留座倒计时（带入或到点离座才解除）
      if (p.autoHold) {
        p.autoHold = false;
        if (!p.holdLeave && !p.away) { p.holdLeave = true; p.holdSince = Date.now(); }
      }
    }

    // 停发门槛（v0.22.39 回滚）：不再按「全桌总投入 + 滚存」照实合计，
    // 恢复为固定值——房主开房时选的「底皮 × n」（this.holdFloor 构造时已定），
    // 整局不变，避免门槛跟着人数 / 芒果倍数来回跳。

    for (const p of this.seats) {
      // 留座中 / 保位离桌 / 还没带入 / 簸簸不够下一手全桌总投入 / 已离座：这一手一律不发牌
      p.inHand = !p.away && !p.hold && !p.holdLeave && p.stack >= this.holdFloor;
      // 战绩：这一手只要入了局就计一手（弃牌、三花自动弃也算打了一手）
      if (p.inHand) p.handsTotal = (p.handsTotal || 0) + 1;
      // 底皮也从簸簸里出：上桌先把底皮推出去
      p.bet = p.inHand ? this.ante : 0;
      if (p.inHand) p.stack -= this.ante;
      if (p.away) {
        // 已经离座的座位：不再读秒，等玩家重新入座
        p.broke = false;
        p.brokeSince = 0;
        p.holdLeave = false;
        p.holdSince = 0;
        p.shortTip = '';
      } else if (!p.inHand) {
        // 簸簸低于停牌门槛：座位留着，头像上开始 180 秒读秒
        // 保位离桌的人不走 broke（那条会被自动带回，且到期只标记离座），交给房间按 holdSince 弹座
        if (!p.broke && !p.holdLeave) { p.broke = true; p.brokeSince = Date.now(); }
        // v0.22.24：差钱被停发的座位挂提示（前端座位标签/日志都会显示）
        p.shortTip = (!p.hold && !p.holdLeave && p.stack < this.holdFloor)
          ? '簸簸不足' : '';
        if (p.shortTip && !this._shortTipLogged?.has(p.id)) {
          (this._shortTipLogged ||= new Set()).add(p.id);
          this.pushLog(`${p.name} 簸簸不足（本桌最低可玩 ${this.holdFloor} = 底皮×${this.floorMult}），停发牌、自动留座`);
        }
      } else {
        p.broke = false;
        p.brokeSince = 0;
        p.holdLeave = false;
        p.holdSince = 0;
        p.joinNext = false;
        p.shortTip = '';       // 入局玩家的旧提示清掉（停发分支会重新挂）
      }
      p.timeouts = 0;   // 托管次数只算一手之内的
      p.splitOptions = null;
      p.splitIndex = null;
      p.split = null;
      p.special = null;
      p.refunded = 0;
      p.emperor = false;
      p.canDecline = null;
      p.lastAction = null;
      p.delta = 0;
      p.mangoPaid = 0;
      p.scratchUntil = 0;
      p.scratchGate = 0;
      p.scratchUsed = false;
      // 搓牌费不在这里清：整场只收一次，付过就一直算付过（换人上座时才重置）
      p.showHand = false;      // 强制秀牌只管这一手
    }

    this.rigged = new Map();   // 定牌只管本手，新一手重新指定
    this._shortTipLogged = new Set();   // 「簸簸不足抢芒」日志每手只记一次
    // 芒果份子倍数已在上面提前算好（mangoMult）：这里直接按阶梯收钱
    if (this.mangoEnabled) {
      for (const p of this.seats) {
        if (!p.inHand) continue;
        // 揍芒的收池者免份子，只出底皮 + 圈芒；其余人照阶梯交
        const exempt = this.mangoKind === 'zou' && p.id === this.lastWinnerId;
        const fee = exempt ? 0 : this.handMango * this.mangoMult;
        const pay = Math.min(this.handMango + fee, p.stack);
        if (pay > 0) {
          p.stack -= pay;
          p.mangoPaid = pay;
          this.mangoIn += pay;
        }
      }
    }

    this.roundHighest = this.ante;
    this.round = 1;
    // 全下搭不动之后的「重新开注」记录：谁全下了、下了多少、有没有人喊到开局底池总额以上。
    // 没人喊到开局底池总额（底皮池+芒果池+滚存），剩下的下注轮就全部跳过，直接补满四张比牌。
    this.shortAllIn = null;
    // v0.22.95 规则修正 1：短全下锁——不足完整喊价（行动前最低喊价）的全下抬价后，
    // 之前行动过的人重新表态只能跟（或敲/丢）；完整喊价或进入下一轮才解锁。
    this.raiseLocked = false;
    this.lockCallees = null;
    // 本轮最高注是不是被「敲/全下」顶出来的（细则：响应全下的最低喊价不再×2）
    this.highestKnocked = false;
    // v0.22.95 规则修正 2（补全）：首轮起手价 = 仅芒果池（含滚存）——
    // 不再把初始底皮（底皮×在局人数）计入最低喊价起步金额。
    // 产品决定：滚存不封顶 —— 池子滚到多少，下一手起手价就抬到多少，不做任何截断。
    this.roundFloor = this.mangoIn + this.carryPot;
    this.startPot = this.roundFloor;
    this.deal(2);
    this.phase = PHASE.BET;
    this.currentSeat = this.firstSpeaker(1);
    this.pushLog(`第 ${this.handNo} 局开始，庄家：${this.seats[this.banker].name}`);
    return this.snapshotFor(-1);
  }

  deal(n) {
    // 从庄家的下一位开始发，绕一圈、庄家收尾 —— 和真人发牌的顺序一致
    const order = this.orderFrom((this.banker + 1) % this.seats.length);
    for (let k = 0; k < n; k++) {
      for (const s of order) {
        const p = this.seats[s];
        // 弃牌、三花自动弃的人不再补牌
        if (!p.inHand || p.folded || p.special || !this.deck.length) continue;
        // 定牌：轮到这张时优先发指定牌；从牌堆中间抽走，其他牌序保持不动
        let picked = null;
        const rig = this.rigged.get(s);
        if (rig && rig.length) {
          const want = rig.shift();
          const at = this.deck.findIndex((c) => c && c.id === want);
          if (at >= 0) picked = this.deck.splice(at, 1)[0];
        }
        if (!picked) {
          // 别人定下的牌不能被中途摸走：从末尾找第一张「没人预约」的牌
          const reserved = new Set();
          for (const [s2, arr] of this.rigged) {
            if (s2 === s) continue;
            for (const id of arr) reserved.add(id);
          }
          let at = -1;
          for (let i = this.deck.length - 1; i >= 0; i--) {
            const c = this.deck[i];
            if (c && !reserved.has(c.id)) { at = i; break; }
          }
          if (at < 0) continue;
          picked = this.deck.splice(at, 1)[0];
        }
        p.hand.push(picked);
      }
    }
    // 刚好发到第四张：先扣住牌面 900ms，等本人声明搓不搓。
    // 不搓的人到时自动亮牌，其余人看到的也只是「晚一瞬翻出来」，看不出差别。
    for (const p of this.seats) {
      if (!p.inHand || p.folded || p.special) continue;
      if (p.hand.length === 4 && !p.scratchUntil && !p.scratchGate) {
        p.scratchGate = Date.now() + SCRATCH_GATE_MS;
      }
    }
    // 每发一张就查一次三花：第三张牌凑齐就当场弃牌，不用等发满四张
    this.checkSpecials();
  }

  /* ── 搓牌：第四张牌先扣在牌背下 ────────────────
   * 只影响「这一手第四张给不给看」，不影响发牌与下注。
   * 本人搓开（scratchDone）或 10 秒到点，牌面照常亮出来。
   */
  scratchStart(seat, ms = SCRATCH_SECONDS * 1000) {
    const p = this.seats[seat];
    if (!p || !p.inHand || p.folded || p.special) return false;
    if (p.hand.length < 4) return false;
    // 一手只搓一次：反复发 on 不能把 10 秒无限续下去
    if (p.scratchUsed) return false;
    p.scratchUsed = true;
    const hold = Number(ms) > 0 ? Number(ms) : SCRATCH_SECONDS * 1000;
    p.scratchGate = 0;
    p.scratchUntil = Date.now() + Math.min(SCRATCH_SECONDS * 1000, hold);
    return true;
  }

  scratchDone(seat) {
    const p = this.seats[seat];
    if (!p) return false;
    if (!p.scratchUntil && !p.scratchGate) return false;
    p.scratchUntil = 0;
    p.scratchGate = 0;
    return true;
  }

  /* ── 强制秀牌：本手把自己四张牌亮给全桌 ─────────
   * 只对当手有效，下一手 startHand 时自动收起；
   * 已弃牌也可以亮（本手四张还在手上），没牌 / 已经亮过不允许。
   */
  canForceShow(seat) {
    const p = this.seats[seat];
    if (!p) return false;
    // 不再限制「在牌 / 未弃牌 / 当前阶段」：弃了牌的也能把底牌亮给全桌看。
    // 只剩两条硬条件：本手还没亮过，并且手上确实有牌可亮。
    if (p.showHand) return false;
    if ((p.hand || []).length < 2) return false;
    return true;
  }

  forceShow(seat) {
    if (!this.canForceShow(seat)) return false;
    const p = this.seats[seat];
    p.showHand = true;
    this.pushLog(`${p.name} 强制秀牌，四张亮给全桌`);
    return true;
  }

  /** 第四张还扣着没有（给前端 / 测试用） */
  scratchHidden(p) {
    if (!p || p.hand.length < 4) return false;
    if (this.phase === PHASE.SETTLED) return false;
    const now = Date.now();
    return (p.scratchUntil > now) || (p.scratchGate > now);
  }

  /** R3 行动闸门：只要有人在搓（倒计时没走完），全桌都得等；
   * 900ms 的「等搓声明」窗口不算——它自动收场，不挡牌。 */
  scratchBlocking() {
    const now = Date.now();
    return this.seats.some((p) => p.inHand && !p.folded && (p.scratchUntil > now));
  }

  /* ── 结算期强制秀牌（v0.22.23：仅点击按钮的本玩家可见）──
   * 全桌底牌只对买的人亮 ms 毫秒，其他玩家看到的仍是结算态；
   * 亮牌窗口写进回顾档案（revealBy 记买家），回顾里也只有买家能翻出全亮的手。
   * allRevealedHand 仍然防重复买：一手只卖一次。 */
  revealAllHole(seat, ms = 1500) {
    if (this.phase !== PHASE.SETTLED) return false;
    if (this.allRevealedHand === this.handNo) return false;
    this.allRevealedHand = this.handNo;
    const hold = Math.max(500, Number(ms) || 1500);
    this.revealUntil = Date.now() + hold;
    this.revealBySeat = seat;
    // 回顾同步记录买家：这一手的四张只对买的人全亮（不再对全桌公开）
    const entry = [...this.log].reverse().find((e) => e.handNo === this.handNo);
    if (entry) entry.revealBy = seat;
    const p = this.seats[seat];
    this.pushLog(`${p && p.name ? p.name : '玩家'} 强制秀牌，全桌底牌仅本人可见`);
    return true;
  }

  /** 每秒清一次到期的搓牌 / 等待窗口，返回是否有变化（room 据此补广播） */
  expireScratch() {
    const now = Date.now();
    let changed = false;
    for (const p of this.seats) {
      if (p.scratchUntil && p.scratchUntil <= now) { p.scratchUntil = 0; changed = true; }
      if (p.scratchGate && p.scratchGate <= now) { p.scratchGate = 0; changed = true; }
    }
    return changed;
  }

  /**
   * 三花十（红10+黑10+黑J）/ 三花六（红6+黑6+大王）只要凑齐就自动弃牌：
   * 本手不输不赢，已经投进底池的钱原样退回簸簸，之后不再发牌、不再喊价。
   */
  checkSpecials() {
    for (const p of this.seats) {
      if (!p.inHand || p.folded || p.special) continue;
      if (p.hand.length < 3) continue;      // 至少要三张才可能凑成三花
      const sp = specialOf(p.hand);
      if (!sp) continue;
      p.special = sp;
      p.refunded = p.bet;
      p.stack += p.bet;
      p.bet = 0;
      p.split = null;
      p.splitOptions = null;
      this.pushLog(`${p.name} 第 ${p.hand.length} 张摸到${sp}，自动弃牌，退回 ${p.refunded}`);
    }
  }

  /** 第 2、3 轮由刚发的明牌最大者先说话，平手取离庄家近的 */
  firstSpeaker(round) {
    if (round === 1) {
      const n = this.seats.length;
      for (let k = 1; k <= n; k++) {
        const s = (this.banker + k) % n;
        const p = this.seats[s];
        if (p.inHand && !p.folded && !p.special) return s;
      }
      return this.banker;
    }
    const idx = round; // round2 → hand[2]，round3 → hand[3]
    let best = -1;
    let bestPower = -1;
    for (const s of this.orderFrom(this.banker)) {
      const p = this.seats[s];
      if (!p.inHand || p.folded || p.special) continue;
      // 敲过（已全下）的人没有簸簸再表态，不能点名，否则他只剩「丢」
      if (p.knocked || p.allIn || p.stack <= 0) continue;
      const c = p.hand[idx];
      if (c && c.power > bestPower) {
        bestPower = c.power;
        best = s;
      }
    }
    return best >= 0 ? best : this.canActSeats()[0] ?? this.banker;
  }

  /** 这一轮还能真正表态的人（有簸簸、没全下） */
  canActSeats() {
    return this.aliveSeats().filter((s) => {
      const p = this.seats[s];
      return !p.knocked && !p.allIn && p.stack > 0;
    });
  }

  visibleCount() {
    return this.round <= 1 ? 0 : this.round - 1;
  }

  legalActions(seat) {
    const p = this.seats[seat];
    if (!p || this.phase !== PHASE.BET || seat !== this.currentSeat) return [];
    if (this.scratchBlocking()) return [];   // 全桌等搓牌：读秒托管也先停
    const need = this.roundHighest - p.bet;
    const out = [];
    const solo = this.canActSeats().length <= 1;
    // v0.22.95：短全下锁——被不足完整喊价的全下逼回表态的「已行动者」不能加注
    const raiseLockedMe = this.raiseLocked && this.lockCallees && this.lockCallees.has(seat);

    // 第一轮（两张底牌）：起手价 = 底皮×入局人数 + 本手芒果 + 滚存（this.roundFloor）。
    // 规则：任何「下注」都必须 ≥ 这个起手价；簸簸够的人不能「跟」低于起手价的注，
    // 必须「大够」到起手价或「敲/丢」；簸簸不够起手价的人只能「敲/丢」。
    // 「休/pass（过）」不受起手价限制——它本就不是下注，且要保证「全员休」可以 void 整手。
    // 一旦有人把注推到 ≥ 起手价，后面就能正常跟那一口、或在上面继续加注。
    if (this.round === 1) {
      const floor = this.roundFloor || 0;
      const canReach = p.stack + p.bet >= floor;
      const floorMet = this.roundHighest >= floor;
      if (need <= 0) out.push('pass');                       // 仍允许休/过（支持全员休 void）
      // 跟注仅在「起手价已被推到」且跟得起时才开放，避免跟低于起手价的小注
      if (floorMet && need > 0 && p.stack >= need) out.push('follow');
      // 大：起手价没推到时只能「大够」到 floor；推到了按普通加注下限
      if (!solo && !raiseLockedMe && p.stack + p.bet > this.roundHighest) {
        if (!floorMet) {
          if (canReach && p.stack + p.bet >= floor) out.push('raise');   // 只能大够到起手价
        } else if (p.stack + p.bet >= this.minRaise()) {
          out.push('raise');
        }
      }
      // v0.22.98：被锁的人不许「敲抬价」——敲出去超过当前注等于变相加注；
      // 只有全下也追不平当前价（被迫短跟）时才允许敲。
      if (p.stack > 0 && (!raiseLockedMe || p.stack + p.bet <= this.roundHighest)) out.push('knock');
      out.push('fold');
      return out;
    }

    if (need <= 0) out.push('pass');
    if (need > 0 && p.stack >= need) out.push('follow');
    // 全桌只剩自己还有簸簸时，加注没有人能接，不该给这个选项
    // 簸簸连底池都够不上时，「大」直接当「敲」处理
    if (!solo && !raiseLockedMe && p.stack + p.bet >= this.minRaise() && p.stack + p.bet > this.roundHighest) out.push('raise');
    // v0.22.98：同 R1——被锁的人只有全下追不平当前价时才允许敲
    if (p.stack > 0 && (!raiseLockedMe || p.stack + p.bet <= this.roundHighest)) out.push('knock');
    out.push('fold');
    return out;
  }

  /**
   * 本轮「大」的下限。
   *   第一轮（两张底牌）：按开局底池的 1 倍起手；
   *   第二、三轮（第三、四张牌）：按前一轮的跟注金额起手 —— 上一轮每人投到多少，
   *   这一轮就在这个数上再加一遍（等价于上一轮注额 ×2），不看累计总底池；
   *   轮内继续加注同样至少翻倍。
   *   例外：有人在局里「搭不动全下」且还没人重开喊价时，响应者的下限
   *   是开局底池总额（底皮池+芒果池+滚存），不再按全下额×2 抬杠；
   *   喊到这个数，下一轮次照常继续喊价（规则细则 0.22.85 调整）。
   */
  /** 加注步长：5/10 及以上按底皮整倍下注，1/2 与 2/5 不设台阶（仍按 1 走） */
  raiseStep() {
    return this.ante >= 5 ? this.ante : 1;
  }

  /** 把任意金额吸到最近的合法台阶上（向下取整，用于上限） */
  stepDown(v) {
    const step = this.raiseStep();
    return step > 1 ? Math.floor(v / step) * step : Math.floor(v);
  }

  /** 把任意金额抬到最近的合法台阶上（向上取整，用于下限） */
  stepUp(v) {
    const step = this.raiseStep();
    return step > 1 ? Math.ceil(v / step) * step : Math.ceil(v);
  }

  minRaise() {
    // 响应「全下搭不动」时（细则 0.22.85）：最低喊价 = 初始底皮池+芒果池（含滚存，
    // 即开局底池总额 startPot），并且要高过全下额；不再按全下额×2 抬杠。
    // 覆盖两条路径：① R1 敲出来的最高注没够到起手价；② R2/R3 的 shortAllIn 还没重开。
    // 重开之后（或正常喊价）恢复轮内翻倍规则。
    const knockShort =
      (this.round === 1 && this.highestKnocked && this.roundHighest < (this.roundFloor || 0))
      || (this.shortAllIn && !this.shortAllIn.reopened && !this.shortAllIn.behind);
    if (knockShort) {
      // v0.22.95 规则修正 2：响应「全下搭不动」的最低喊价 = 仅芒果池（含滚存），
      // 不再含初始底皮池（旧细则 0.22.85 用开局底池总额 startPot）。
      const mangoFloor = (this.mangoIn || 0) + (this.carryPot || 0);
      return this.stepUp(Math.max(mangoFloor, this.roundHighest + 1, this.ante));
    }
    return this.stepUp(Math.max(this.roundFloor || 0, this.roundHighest * 2, this.ante));
  }

  /** 我的簸簸不够跟上这一口，只能敲 */
  capShort(seat = this.currentSeat) {
    const p = this.seats[seat];
    return !!p && p.stack + p.bet < this.minRaise();
  }

  /** 留座倒计时走完就起立围观（与带入彻底解耦）。
   *  v0.22.80：留座是座位维度的硬规矩——不管有没有挂账带入(pendingBuyIn)、
   *  有没有提交带入申请(asking)，倒计时到点一律起立。想继续打，带入审批过了
   *  再重新坐下即可。原来那两个 continue 造成「点了带入→本手结算不了→挂账
   *  清不掉→永远不起立」的死锁，见房间 4694 现场。 */
  expireBroke() {
    const now = Date.now();
    let changed = false;
    // 本轮到点起立的座位号，交给房间层做真正的「起立围观」（清座位、人回围观席）。
    // 返回值仍是 boolean，单机模式（没有房间层）照旧只看 changed。
    this.brokeEject = this.brokeEject || [];
    for (const p of this.seats) {
      if (!p.broke) continue;
      if (!p.brokeSince) continue;        // 0 = 没起表
      if (!p.name) continue;              // v0.22.88：空座位没有名字，房间层开局时会造满 8 个
                                          // Player，stack 0 全被打上 broke——到点会反复触发
                                          // 无效弹座并刷「留座到点」日志，直接跳过
      if (now - p.brokeSince < Game.BROKE_SECONDS * 1000) continue;
      // 到点：结算掉挂账带入，别让玩家白丢钱——钱并入簸簸，跟着人走到围观席
      if (p.pendingBuyIn > 0) {
        p.stack = (p.stack || 0) + p.pendingBuyIn;
        p.buyInTotal = (p.buyInTotal || 0) + p.pendingBuyIn;
        p.pendingBuyIn = 0;
      }
      p.broke = false;
      p.brokeSince = 0;
      p.asking = false;
      p.away = true;
      p.inHand = false;
      this.brokeEject.push(p.seat);
      this.pushLog(`${p.name} 留座到点，起立围观`);
      changed = true;
    }
    return changed;
  }

  /** 座位原主人离场：把战绩留档（只留真正上过桌的人，没打过的空座不留） */
  retire(seat, reason = 'left') {
    const p = this.seats[seat];
    if (!p) return null;
    if (!p.handsTotal && !p.buyInTotal) return null;
    // 与桌面簸簸同一个口径：簸簸 − 带入 = 输赢（下注离手的不算在簸簸里）
    const net = (p.stack || 0) - (p.buyInTotal || 0);
    // 同一段战绩只留一次：断线 90 秒已经留过档，玩家随后再点「离开」会二次触发，
    // 两条一模一样的记录会让战绩表的带入 / 手数 / 输赢整份翻倍。
    // 重新入座会清掉 retiredKey，所以下次真正离场照常记。
    const snapKey = `${p.handsTotal || 0}|${p.buyInTotal || 0}|${p.stack || 0}`;
    if (p.retiredKey && p.retiredKey === snapKey) return null;
    p.retiredKey = snapKey;
    p.retiredAt = Date.now();   // 防止同一个座位被重复留档
    const row = {
      seat, name: p.name, isAI: !!p.isAI,
      buyIn: p.buyInTotal || 0,
      hands: p.handsTotal || 0,
      net,
      at: Date.now(),
      reason,   // 'left' 自己走 / 'offline' 断线没回 / 'replaced' 座位换人
    };
    this.departed.push(row);
    if (this.departed.length > 200) this.departed.shift();
    this.pushLog(`${p.name} 离座，战绩保留（带入 ${row.buyIn} · ${row.hands} 手 · ${row.net >= 0 ? '+' : ''}${row.net}）`);
    return row;
  }

  /** 重新入座：补上簸簸，下一手正常发牌 */
  sitDown(seat, { name, stack } = {}) {
    const p = this.seats[seat];
    if (!p) throw new Error('没有这个座位');
    // 这个座位本来有人（机器人离座换新面孔、玩家走了 AI 接管）：先把他的战绩留档
    if (p.handsTotal > 0 && !p.retiredAt) this.retire(seat, 'replaced');
    p.away = false;
    p.broke = false;
    p.brokeSince = 0;
    p.hold = false;
    p.asking = false;
    p.holdLeave = false;
    p.holdSince = 0;
    p.timeouts = 0;
    p.scratchPaid = false;   // 换了人上座：整场搓牌费重新从零算
    p.joinNext = true;   // 下一手才发牌
    p.stack = Number.isFinite(stack) ? stack : this.buyIn;
    // 新入座 = 重新开一份战绩
    p.buyInTotal = p.stack;
    p.handsTotal = 0;
    p.retiredAt = 0;
    p.retiredKey = '';
    if (name) p.name = name;
    this.pushLog(`${p.name} 入座，簸簸 ${p.stack}`);
    return this.snapshotFor(-1);
  }

  /**
   * 带入金币：只能加不能减，牌局进行中随时可以带。
   * 打到一半带入的钱先记账（pendingBuyIn），**本手结算完立刻到账**：
   * 不会改变这一手的下注额、跟注上限和输赢，也不会因为带入被拉回牌局。
   */
  bringIn(seat, amount) {
    const p = this.seats[seat];
    if (!p) throw new Error('没有这个座位');
    const running = this.phase === PHASE.BET || this.phase === PHASE.SPLIT;

    const want = Math.floor(Number(amount) || 0);
    if (p.away) {
      if (want < this.buyIn) throw new Error(`一次至少带入 ${this.buyIn}`);
      this.sitDown(seat, { stack: want });
      this.lastBringIn = { seat, amount: want, seq: ++this.capSeq };
      return this.snapshotFor(-1);
    }
    if (want < this.buyIn) throw new Error(`一次至少带入 ${this.buyIn}`);
    p.hold = false;
    p.asking = false;
    p.holdLeave = false;   // 带入 = 取消「保位离桌」，接着打
    p.holdSince = 0;
    p.timeouts = 0;

    if (running) {
      // 牌局进行中：先挂账，这一手按原来的簸簸打完，结算完马上到账
      p.pendingBuyIn = (p.pendingBuyIn || 0) + want;
      p.joinNext = true;
      this.lastBringIn = { seat, amount: want, seq: ++this.capSeq, pending: true };
      this.pushLog(`${p.name} 带入 ${want}，本手结束后到账`);
      return this.snapshotFor(-1);
    }

    p.stack += want;
    p.buyInTotal = (p.buyInTotal || 0) + want;   // 战绩里的「带入」跟着累加
    if (p.stack >= this.holdFloor) { p.broke = false; p.brokeSince = 0; }
    this.lastBringIn = { seat, amount: want, seq: ++this.capSeq };
    this.pushLog(`${p.name} 带入 ${want}，簸簸变成 ${p.stack}`);
    return this.snapshotFor(-1);
  }

  /** 这一手打完：把中途挂账的带入一次性计入簸簸 */
  applyPendingBuyIns() {
    let any = false;
    for (const p of this.seats) {
      const add = p.pendingBuyIn || 0;
      if (!add) continue;
      p.pendingBuyIn = 0;
      p.stack += add;
      p.buyInTotal = (p.buyInTotal || 0) + add;   // 战绩里的「带入」跟着累加
      if (p.stack >= this.holdFloor) { p.broke = false; p.brokeSince = 0; }
      this.pushLog(`${p.name} 带入的 ${add} 到账，簸簸变成 ${p.stack}`);
      any = true;
    }
    return any;
  }

  /** 加注上限 = 桌上还剩的簸簸 + 这一手已经推出去的 */
  maxRaise(seat) {
    const p = this.seats[seat];
    return p ? p.stack + p.bet : 0;
  }

  raiseAmount() {
    return this.minRaise();
  }

  act(seat, action, amount) {
    if (this.phase !== PHASE.BET) throw new Error('当前不是下注阶段');
    // 全桌等搓牌：有人第四张还扣着搓，谁都别说话（含本人），搓完再行动
    if (this.scratchBlocking()) throw new Error('等搓牌的玩家搓完再行动');
    if (seat !== this.currentSeat) throw new Error('还没轮到你说话');
    const p = this.seats[seat];
    const legal = this.legalActions(seat);
    if (!legal.includes(action)) throw new Error(`当前不能「${ACTION_NAME[action] || action}」`);

    const prevHighest = this.roundHighest;   // 这一手之前的最高注（判断「有没有真的抬价」）
    // v0.22.98：「完整喊价」判定线——加注/敲到这条线才算抬杠，短全下锁随之解除。
    // R1 起手价还没被推到时，完整喊价 = 起手价本身；其余一律按翻倍档（当前注×2）。
    // 响应短全下的芒果档最低喊价（minRaise）只是金额下限：够不到这条线，
    // 抬了价也不重开、不解锁——补 0.22.95「小加注就能解锁」的漏洞。
    const reopenFloor = (this.round === 1 && prevHighest < (this.roundFloor || 0))
      ? this.stepUp(Math.max(this.roundFloor || 0, this.ante))
      : this.stepUp(Math.max(this.roundFloor || 0, prevHighest * 2, this.ante));
    switch (action) {
      case 'follow': {
        const need = this.roundHighest - p.bet;
        p.stack -= need;          // 簸簸当场减少
        p.bet = this.roundHighest;
        break;
      }
      case 'raise': {
        const floor = this.minRaise();
        const ceiling = this.maxRaise(seat);   // 已是「桌上还剩 + 已下」的总上限
        const wantRaw = Number(amount) || floor;
        if (wantRaw < floor) throw new Error(`加注至少要 ${floor}`);
        // 金额吸到合法台阶（5/10 每 5、10/20 每 10…），避免出现 13、27 这种零头
        const target = Math.min(this.stepUp(wantRaw), this.stepDown(ceiling));
        if (target <= this.roundHighest) throw new Error('加注额必须高于当前注');
        p.stack -= target - p.bet;  // 只补差额，簸簸当场减少
        p.bet = target;
        this.roundHighest = p.bet;
        this.highestKnocked = false;
        // v0.22.95：喊到「行动前的最低喊价」（完整喊价）即重开短全下下注权、解除加注锁
        if (this.shortAllIn && p.bet >= reopenFloor) this.shortAllIn.reopened = true;
        if (p.bet >= reopenFloor) { this.raiseLocked = false; this.lockCallees = null; }
        break;
      }
      case 'knock': { // 敲 = 梭哈：把簸簸剩下的全部推上去
        p.bet += p.stack;
        p.stack = 0;
        p.knocked = true;
        // 敲完注额还没追平该跟的价 = 「搭不动」：不拦、不弃，第三第四张照发，
        // 结算时两两封顶在他实际下到的数，不影响别人行动。
        // 注意不能只比桌上的当前注：第 2、3 轮的起手价是上一轮注额 ×2（roundFloor），
        // 常常比当前注高一截。B 桌上只有 60、本轮起手 120、他敲到 80，就是没搭上。
        const needNow = this.round >= 2
          ? Math.max(this.roundHighest, this.roundFloor || 0)
          : this.roundHighest;
        p.shortKnock = p.bet < needNow;
        if (p.shortKnock) {
          this.pushLog(`${p.name} 簸簸不够，敲了搭不动（下到 ${p.bet}）`);
          // 这次全下是什么性质，决定后面还开不开新的一轮：
          // - behind = 敲之前已经有人把注下得比他多（他跟不上别人，属于短跟）
          //   → 下注轮本来就被别人撑开着，R3 照开，其他人继续加注/敲/弃；
          // - behind = false，他自己先开口、别人还没抬过
          //   → 只是把注额顶高了一点点，不算重开；后位不喊到开局底池总额就不开下一轮，直接比牌。
          if (!this.shortAllIn || p.bet > this.shortAllIn.total) {
            this.shortAllIn = {
              seat,
              total: p.bet,
              reopened: false,
              behind: prevHighest > p.bet,
            };
          }
        } else if (this.shortAllIn && p.bet >= reopenFloor) {
          // v0.22.95：敲到「行动前的最低喊价」即重开短全下下注权
          this.shortAllIn.reopened = true;
        }
        if (p.bet > prevHighest) this.highestKnocked = true;
        this.roundHighest = Math.max(this.roundHighest, p.bet);
        break;
      }
      case 'pass':
        break;
      case 'fold':
        p.folded = true;
        break;
      default:
        throw new Error('未知操作');
    }

    if (p.stack <= 0) p.knocked = true;
    // 只有「真的把注抬高了」才要其他人重新表态。
    // 敲了但搭不动（推上去还没追平），同轮次已经行动过的人不用再动一次。
    if (p.bet > prevHighest) {
      // v0.22.95 规则修正 1：全下抬价但没到行动前最低喊价（不足上一口的两倍）→
      // 不重开加注权：之前行动过的人（lockCallees）重新表态时只能跟（或敲/丢）；
      // 还没行动过的人照常可选，加注即完整喊价、转回来恢复加注权；下一轮次解锁。
      if (p.bet >= reopenFloor) {
        // 完整喊价（≥ 当前注×2）：重开加注权、解除短全下锁
        this.raiseLocked = false;
        this.lockCallees = null;
      } else if (p.stack <= 0) {
        // 不足完整喊价的全下 = 短全下——锁「在旧价位行动过的所有人」
        //（喊过价的 A、只跟过注/休过的 C 都算），重新表态只能跟（或丢）；
        // 还没行动过的人照常可选。连续多个短全下取并集，进入下一轮整体解锁。
        this.raiseLocked = true;
        this.lockCallees = new Set([...(this.lockCallees || []), ...this.actedThisRound]);
      }
      // 其余情形（响应者的小加注：够芒果档但不够翻倍档）：抬价但不重开、不解锁，
      // 被锁的人继续只能跟——补 0.22.95「小加注也能解锁」的漏洞。
      this.actedThisRound.clear();
    }
    this.actedThisRound.add(seat);
    p.lastAction = action;
    this.roundActions.push({ seat, action, round: this.round });
    this.pushLog(`${p.name}：${ACTION_NAME[action]}${action === 'raise' ? ' 到 ' + p.bet : ''}`);
    // 行动音效：只发指令，具体声音在前端合成
    this.emitSfx(
      action === 'knock' ? 'shower'
        : action === 'pass' ? 'knock2'
          : action === 'fold' ? 'fold'
            : 'coin',
    );

    this.afterAction();
    return this.snapshotFor(-1);
  }

  afterAction() {
    const alive = this.aliveSeats();
    if (alive.length <= 1) {
      this.startSplit();
      return;
    }
    if (this.isRoundComplete()) this.endBetRound();
    else this.moveNext();
  }

  isRoundComplete() {
    const alive = this.aliveSeats().map((s) => this.seats[s]);
    // 只剩一家还有簸簸、且他的注已经是本手最高：没人能跟、也没人能接他的加注，
    // 这一轮直接算走完（发下一张或摊牌），不再单独点他说话
    const act = this.canActSeats();
    if (act.length === 1 && this.seats[act[0]].bet >= this.roundHighest) return true;
    // 全下/敲过的玩家不再表态；其余人必须表过态并追平注额
    return alive.every((p) => p.allIn || p.knocked
      || (this.actedThisRound.has(p.seat) && p.bet === this.roundHighest));
  }

  moveNext() {
    const n = this.seats.length;
    let s = this.currentSeat;
    for (let i = 0; i < n; i++) {
      s = (s + 1) % n;
      if (s === this.currentSeat) break;
      const p = this.seats[s];
      if (p.inHand && !p.folded && !p.special && !p.knocked && !p.allIn) {
        this.currentSeat = s;
        return;
      }
    }
    this.endBetRound();
  }

  /** 本轮所有未弃牌玩家都选择休 —— 任意轮次全休都算休芒，当场作废、不再发下一张牌 */
  allPassedThisRound() {
    if (!this.voidEnabled) return false;
    const active = this.aliveSeats().filter(
      (s) => !this.seats[s].allIn && !this.seats[s].knocked,
    );
    if (active.length < 2) return false;
    return active.every((s) => {
      const acts = this.roundActions.filter((r) => r.seat === s && r.round === this.round);
      return acts.length > 0 && acts[acts.length - 1].action === 'pass';
    });
  }

  /** 我是不是本轮最后一个还能行动的人 */
  isLastToAct(seat) {
    const n = this.seats.length;
    let s = seat;
    for (let i = 0; i < n; i++) {
      s = (s + 1) % n;
      if (s === seat) break;
      const p = this.seats[s];
      if (p.inHand && !p.folded && !p.special && !p.knocked && !p.allIn && !this.actedThisRound.has(p.seat)) {
        return false;
      }
    }
    return true;
  }

  /** 我这一手如果选「休」，会不会导致全场都休（全休 = 休芒作废）
   *  v0.22.23：桌上只要还有全下（敲/梭哈）的玩家在局，其余人全休不再作废这一手，
   *  只是闭嘴补牌比大小 —— 所以这种情况选「休」不会触发休芒。 */
  wouldVoidIfPass(seat) {
    if (this.aliveSeats().some((s) => {
      const p = this.seats[s];
      return p.knocked || p.allIn;
    })) return false;
    const others = this.aliveSeats().filter(
      (x) => x !== seat && !this.seats[x].allIn && !this.seats[x].knocked,
    );
    if (!others.length) return false;
    return others.every((x) => {
      const acts = this.roundActions.filter((r) => r.seat === x && r.round === this.round);
      return acts.length > 0 && acts[acts.length - 1].action === 'pass';
    });
  }

  /**
   * 休芒：这一手作废、钱不进任何人口袋，底池滚到下一手。
   * 两种来路都按休芒算：
   *   · reason='xiu'  任意一轮所有人都休；
   *   · reason='fold' 其他人都自己弃了、只剩一家，且本手没人加注过（v0.22.59：这一家不收池）。
   * 底池拆两半：
   *   · 跟注 / 加注的部分 —— 当场原样退回各自的簸簸，没输没赢；
   *   · 底皮 —— v0.22.59 两种来路都「全场退还」，原样退回各人簸簸；
   *   · 只有圈芒 + 份子留在芒果池里滚下一手，下手全场休芒（份子按阶梯翻倍）。
   */
  /**
   * v0.22.28：进程重启前调用——把进行到一半的手牌作废，池子里的钱全数退回在座玩家。
   * 手牌状态不落盘，重启后房间只会按各家簸簸重建、重新发牌；
   * 不退的话，各家已投入的底皮/跟注/份子和滚存池就凭空蒸发了。
   * 均分口径：滚存池 + 份子池按「在座有钱的玩家」平分，各人自己的注额原样退回。
   */
  abortRefund() {
    if (this.phase === PHASE.WAITING) return false;
    // 公共池 = 滚存 + 份子（没有明确归属，按在座玩家均分）；
    // 各家自己的注额（底皮/跟注/加注）原样退回，不参与均分。
    const pool = (this.carryPot || 0) + (this.mangoIn || 0);
    const sharers = this.seats.filter((p) => p.bet > 0 || p.inHand || p.stack > 0);
    if (pool <= 0 && this.seats.every((p) => p.bet === 0)) {
      this.phase = PHASE.SETTLED;
      return false;
    }
    const each = Math.floor(pool / Math.max(1, sharers.length));
    for (const p of sharers) {
      const back = p.bet + each;
      if (back > 0) p.stack += back;
      p.bet = 0;
    }
    const remainder = pool - each * sharers.length;
    if (remainder > 0 && sharers.length) sharers[0].stack += remainder;
    this.carryPot = 0;
    this.mangoIn = 0;
    this.phase = PHASE.SETTLED;
    this.currentSeat = -1;
    this.result = null;
    return true;
  }

  voidHand(reason = 'xiu') {
    const ante = this.ante;
    const betsIn = this.seats.map((p) => p.bet);   // 回顾要记「这一手下了多少」，下面会清零
    // v0.22.59：全员休 / 其他人都弃了，两种都按「本手没输赢」处理——
    // 底皮不是输掉的钱，连同跟注加注一起全额退回各人簸簸（全场退还底皮），
    // 只有圈芒 / 份子留在芒果池里继续累计，下手全场休芒。
    const anteBack = reason === 'xiu' || reason === 'fold';
    let rolled = 0;      // 留在池里滚走的：圈芒 + 份子（全休时不再含底皮）
    let refunded = 0;    // 退回簸簸的：跟注 / 加注
    let anteRefund = 0;  // 退回簸簸的底皮（只有全休才退）
    for (const p of this.seats) {
      const extra = Math.max(0, p.bet - ante);
      if (extra > 0) {
        p.stack += extra;
        refunded += extra;
      }
      if (anteBack && p.inHand && p.bet >= ante) {
        p.stack += ante;
        anteRefund += ante;
      } else {
        rolled += Math.min(p.bet, ante);   // 弃牌局：底皮留在池里
      }
      p.bet = 0;
      p.delta = 0;
    }
    // 份子钱开局已经扣进底池，跟着一起滚
    rolled += this.mangoIn;
    this.mangoIn = 0;
    this.carryPot += rolled;
    // 休芒的两种来路都续链：R1 纯弃作废（fold）、全员休（任意轮，R1 全休更是绝对休芒）
    if (this.mangoEnabled) {
      this.mangoKind = 'xiu';
      this.mangoStreak += 1;
    }
    this.phase = PHASE.SETTLED;
    this.currentSeat = -1;
    this.result = {
      handNo: this.handNo,
      void: 'xiu',
      voidReason: reason,
      antePot: 0,
      potWinner: null,
      potWinners: [],
      carryPot: this.carryPot,
      rolled,
      refunded,
      anteRefund,
      reveal: this.seats.map((p) => ({
        seat: p.seat, name: p.name, hand: p.hand, bet: 0,
        folded: p.folded, special: p.special, split: p.split, delta: 0,
      })),
      pot: 0,
    };
    const head = reason === 'fold' ? '其他人都弃了，这一手按休芒作废' : '全员休牌';
    // 作废的一手也要进整局回顾，否则回顾会一直停在最后一个正常结算的手
    this.log.push({
      handNo: this.handNo,
      pot: 0,
      antePot: 0,
      winner: null,
      void: 'xiu',
      voidReason: reason,
      rolled,
      refunded,
      anteRefund,
      carryPot: this.carryPot,
      seats: this.seats.map((p) => ({
        seat: p.seat,
        name: p.name,
        isAI: !!p.isAI,        // v0.20.30：回顾页过滤机器人行用
        hand: p.hand,
        bet: betsIn[p.seat] || 0,
        folded: p.folded,
        special: p.special,
        emperor: !!p.emperor,
        showHand: !!p.showHand,
        split: p.split,
        delta: 0,
      })),
    });
    if (this.log.length > 300) this.log.shift();
    if (reason === 'xiu') {
      this.pushLog(`全员休牌，底皮 ${anteRefund} 退回各人簸簸${refunded > 0 ? `、跟注加注 ${refunded} 退回` : ''}，圈芒+份子 ${rolled} 留在芒果池（累计 ${this.carryPot}），下一手全场休芒`);
    } else {
      this.pushLog(`${head}，底皮 ${anteRefund}${refunded > 0 ? `、跟注加注 ${refunded}` : ''} 全额退回各人簸簸，圈芒+份子 ${rolled} 留在芒果池（累计 ${this.carryPot}），下一手全场休芒`);
    }
    this.applyPendingBuyIns();
  }

  /** 全下后其余人闭嘴：把在局玩家的牌补满四张，直接进分牌比大小（不再喊价）。
   *  v0.22.23：全下（敲/梭哈）的玩家 money 已在池里、牌还在手上，
   *  其他人全休不该按休芒作废——继续发牌，以各家实际注额两两封顶结算。 */
  skipBettingToSplit(logText) {
    const handLen = () => Math.max(
      0,
      ...this.seats.filter((p) => p.inHand && !p.folded).map((p) => p.hand.length),
    );
    let guard = 0;
    while (handLen() < 4 && guard++ < 4) {
      this.round = Math.min(3, this.round + 1);
      this.deal(1);
      if (this.aliveSeats().length <= 1) break;
    }
    if (logText) this.pushLog(logText);
    this.startSplit();
  }

  endBetRound() {
    if (this.allPassedThisRound()) {
      // v0.22.23：有人在局里全下、其余人都休 —— 不再按休芒作废。
      // 补满四张直接比牌，B/C 之类的跟注者不再有下注机会，按各自注额两两封顶结算。
      if (this.aliveSeats().some((s) => {
        const p = this.seats[s];
        return p.knocked || p.allIn;
      })) {
        this.skipBettingToSplit('有人已全下，其余人全部休牌 —— 不作废，补牌直接比大小');
        return;
      }
      this.voidHand();
      return;
    }
    // 全下搭不动、且本轮没人把注喊到开局底池总额：后面不再喊价，
    // 直接把牌补满四张进分牌（钱照旧两两封顶在各自实际下到的数）。
    // 两种情形不封轮：① 敲的时候桌上已有人下得比他多（短跟，轮次本来开着）；
    // ② 同一轮里有人喊到 ≥ 开局底池总额（底皮池+芒果池+滚存），见 act() 的 raise/knock。
    if (this.shortAllIn && !this.shortAllIn.reopened
        && !this.shortAllIn.behind && this.round < 3) {
      this.skipBettingToSplit('有人敲了搭不动，其余人都只跟平 —— 不再喊价，直接补牌比大小');
      return;
    }
    if (this.round >= 3) {
      this.startSplit();
      return;
    }
    this.round += 1;
    this.deal(1);
    // 发牌时可能有人凑成三花自动弃牌，人不够了就直接摊牌
    if (this.aliveSeats().length <= 1) {
      this.startSplit();
      return;
    }
    this.actedThisRound = new Set();
    this.roundHighest = Math.max(...this.aliveSeats().map((s) => this.seats[s].bet));
    this.highestKnocked = false;
    // v0.22.95：进入新轮次，短全下锁解除（起手价 = 新最高注 ×2，见下方 roundFloor）
    this.raiseLocked = false;
    this.lockCallees = null;
    // 本轮起手价 = 上一轮每人跟到的注额（再加一遍），不看累计总底池
    this.roundFloor = this.roundHighest * 2;
    // 所有人都敲完/全下了：没人还能说话，直接分牌
    const act = this.canActSeats();
    if (!act.length) {
      this.startSplit();
      return;
    }
    // 只剩一个人还有簸簸、而他的注已经顶到本手最高（其余人都敲短了、追不上）：
    // 他既没人可跟、也没人能接他的加注，再让他一个人选「丢/休/敲」没有意义，
    // 直接进分牌比牌。（还差一口没跟的，仍要点他说话，见下面的分支）
    if (act.length === 1 && this.seats[act[0]].bet >= this.roundHighest) {
      this.pushLog(`${this.seats[act[0]].name} 已无人可跟，直接比牌`);
      this.startSplit();
      return;
    }
    this.currentSeat = this.firstSpeaker(this.round);
    this.pushLog(`第 ${this.round} 轮发牌，起手 ${this.roundFloor}，${this.seats[this.currentSeat].name} 先说话`);
  }

  /** 全桌都弃了：本手作废，注额原样退回簸簸 */
  abortHand(reason = '全桌弃牌，本手作废') {
    for (const p of this.seats) {
      p.stack += p.bet;
      p.bet = 0;
    }
    this.phase = PHASE.SETTLED;
    this.currentSeat = -1;
    this.result = { handNo: this.handNo, antePot: 0, potWinner: null, potWinners: [], reveal: [], pot: 0, carryIn: 0 };
    this.pushLog(reason);
    this.applyPendingBuyIns();
  }

  startSplit() {
    this.phase = PHASE.SPLIT;
    this.splitAt = Date.now();   // 分牌倒计时起点
    const alive = this.aliveSeats().map((s) => this.seats[s]);
    // 全桌都弃了（极罕见）：本手作废，注额原样退回
    if (!alive.length) {
      this.abortHand();
      return;
    }
    // 只剩一家（其他人都弃了）：不用发后面的牌；收池 / 作废由 finish() 统一判定
    if (alive.length === 1) {
      this.pushLog(`${alive[0].name} 其他人都弃了`);
      this.finish();
      return;
    }
    // 全员敲（全下）会提前结束喊价：先把剩下的牌补齐到四张，再比大小
    const dealt = Math.max(...alive.map((p) => p.hand.length));
    if (dealt < 4) this.deal(4 - dealt);

    // 补牌过程中可能有人凑成三花自动弃牌，人数会变，这里重算一次
    const live = this.aliveSeats().map((s) => this.seats[s]);
    if (!live.length) {
      this.abortHand();
      return;
    }
    // 补牌后重算仍只剩一家：同样交给 finish() 判定收池 / 作废
    if (live.length === 1) {
      this.pushLog(`${live[0].name} 其他人都弃了`);
      this.finish();
      return;
    }
    for (const p of live) {
      const sp = specialOf(p.hand);
      p.canDecline = sp || null;
      if (sp) {
        // 三花十 / 三花六：自动弃牌，本手跟注、加注进池的钱原样退回
        p.special = sp;
        p.refunded = p.bet;
        p.stack += p.bet;   // 已经扣走过的注，原样退回簸簸
        p.bet = 0;
        p.split = null;
        p.splitOptions = null;
        this.pushLog(`${p.name} ${sp}，自动弃牌，退回 ${p.refunded}`);
        continue;
      }
      // 天皇 / 地皇：四张齐全，整手通杀，不用分牌
      if (isEmperorHand(p.hand)) {
        p.emperor = 'heaven';
        p.splitOptions = null;
        this.pushLog(`${p.name} 天皇（大王+红3+一对红Q），通杀全场`);
        continue;
      }
      if (isEarthHand(p.hand)) {
        p.emperor = 'earth';
        p.splitOptions = null;
        this.pushLog(`${p.name} 地皇（大王+红3+一对红2），通杀全场`);
        continue;
      }
      p.splitOptions = enumerateSplits(p.hand, this.dijiuOn);
      if (p.isAI) {
        const best = bestSplit(p.hand, this.dijiuOn);
        p.splitIndex = p.splitOptions.findIndex((s) => s.score === best.score);
        p.split = p.splitOptions[p.splitIndex];
      }
    }
    if (live.every((p) => p.split || p.emperor)) this.finish();
  }

  chooseSplit(seat, index) {
    if (this.phase !== PHASE.SPLIT) throw new Error('当前不是分牌阶段');
    const p = this.seats[seat];
    if (!p || !p.splitOptions) throw new Error('该玩家不能分牌');
    const s = p.splitOptions[index];
    if (!s) throw new Error('分法不存在');
    p.splitIndex = index;
    p.split = s;
    if (this.aliveSeats().every((x) => this.seats[x].split || this.seats[x].special || this.seats[x].emperor)) this.finish();
    return this.snapshotFor(-1);
  }

  /** 三花弃牌：本局不输不赢 */
  declineSpecial(seat) {
    if (this.phase !== PHASE.SPLIT) throw new Error('当前不是分牌阶段');
    const p = this.seats[seat];
    if (!p || !p.inHand || p.folded) throw new Error('该玩家不能弃牌');
    const sp = specialOf(p.hand);
    if (!sp) throw new Error('手牌不构成三花');
    p.special = sp;
    p.bet = 0;
    p.split = null;
    p.splitOptions = null;
    if (this.aliveSeats().every((x) => this.seats[x].split || this.seats[x].special || this.seats[x].emperor)) this.finish();
    return this.snapshotFor(-1);
  }

  /** 超时托管：能过就过，要跟就跟最小，否则弃 */
  /**
   * 读秒到 0 的托管：
   *   上家「大 / 敲」→ 默认弃牌（不想跟这一口就别硬扛）；
   *   上家「休 / 丢」→ 默认休牌，牌留着进下一轮；
   *   上家「跟」或休不了（还差注）→ 默认弃牌。
   */
  autoAct(seat) {
    const legal = this.legalActions(seat);
    if (!legal.length) return;
    // 同一手读秒归零两次：这手打完就停发牌、进留座倒计时（防挂机，别让一桌人等一个人）
    const who = this.seats[seat];
    if (who && !who.isAI) {
      who.timeouts = (who.timeouts || 0) + 1;
      if (who.timeouts >= 2 && !who.autoHold) {
        who.autoHold = true;
        this.pushLog(`${who.name} 连续两次读秒到 0，下手停发牌、留座 ${Game.BROKE_SECONDS} 秒`);
      }
    }
    const last = [...this.roundActions].reverse().find((r) => r.round === this.round);
    const pressed = !!last && (last.action === 'raise' || last.action === 'knock');
    if (pressed && legal.includes('fold')) return this.act(seat, 'fold');
    if (legal.includes('pass')) return this.act(seat, 'pass');
    if (legal.includes('fold')) return this.act(seat, 'fold');
    return this.act(seat, legal[0]);
  }

  finish() {
    // v0.22.59：其他人都「丢」了、只剩一家，且**本手没人加注过** —— 这一手不收池。
    // 按作废处理：底皮 + 跟注加注全额退回各人簸簸，只有圈芒 + 份子继续滚存，
    // 下手全场休芒（mangoKind='xiu'、份子按阶梯翻倍）。作废手照常进整局回顾。
    // 另一种「加注打跑别人」（本手出现过 raise / knock）是正常收池，照旧走下面的结算，
    // 该记揍芒还记揍芒，一点不动。判定集中放这里：afterAction → startSplit → finish
    // 是唯一路径，两处「只剩一家」分支都会汇到这儿，不用各写一份。
    const stillIn = this.seats.filter((p) => p.inHand && !p.folded && !p.special);
    const someoneFolded = this.seats.some((p) => p.folded);
    const raised = this.roundActions.some((r) => r.action === 'raise' || r.action === 'knock');
    // v0.22.85：作废手（休芒退底皮）严格限定 —— **第一轮（两张底牌）纯弃**：
    // 从第一位玩家开始按顺序弃到剩最后一家、全程无人喊价；第二轮及以后的纯弃
    // 不算休芒，按正常收池结算（判定见下方芒果链段）。休芒的另一条来路是
    // R2/R3 全员休，见 endBetRound() → voidHand()。
    const folds = this.roundActions.filter((r) => r.action === 'fold');
    const foldsInR1 = folds.length === 0 || folds.every((r) => r.round === 1);
    if (someoneFolded && stillIn.length <= 1 && !raised && foldsInR1) {
      this.voidHand('fold');
      return;
    }
    // 加注打跑别人、三花自动弃牌等，仍按原来的收池结算，钱归剩下的人。
    this.phase = PHASE.SETTLED;
    this.currentSeat = -1;

    for (const p of this.seats) {
      if (p.inHand && !p.folded) {
        const sp = specialOf(p.hand);
        if (sp) {
          p.special = sp;
          p.split = null;
        }
      }
    }

    const contenders = this.seats.filter((p) => p.inHand && !p.folded && !p.special);
    const delta = new Map(this.seats.map((p) => [p.id, 0]));

    // ── 结算模型（v0.8.27）──────────────────────────────────────
    // 一个人可以同时赢多家，也可以同时输给多家，两头都封顶：
    //   · 赢：只在「头牌、尾牌同时大过对方」时成立，
    //         单笔 = min(自己还没输掉的注额, 对方还没输掉的注额)
    //   · 输：本手输出总额不超过自己投进来的钱
    // 于是 A 投 50 能同时赢 B、C 各 50；B 投 80 先输 50 给 A，只剩 30 去赢 C；
    // C 输出 80（50+30），多下的 20 原样退回，不会出现「簸簸 56 却输 61」。
    // 底池（所有人底皮 + 弃牌者多下的注 + 圈芒 + 滚存）归「尾牌最大」的人；
    // 尾牌牌力相同再看头牌，头尾牌力全同才算并列均分，
    // 除不尽的零头按行动顺序前位多 1、后位少 1。
    const ante = this.ante;
    const folded = this.seats.filter((p) => p.inHand && p.folded);
    // 皮池快照（此时 bet / 弃牌 / 全下标记都已定稿，栈还没还原）
    const ps = this.potSplit();

    // 天皇 > 地皇 > 人皇；一张大王只能凑出一种，这里按等级取最高的
    const EMPEROR_RANK = { heaven: 2, earth: 1 };
    const emperor = contenders
      .filter((p) => p.emperor)
      .sort((a, b) => (EMPEROR_RANK[b.emperor] || 0) - (EMPEROR_RANK[a.emperor] || 0))[0];

    const carryIn = this.carryPot;          // 上一手滚进来的芒果池
    const mangoIn = this.mangoIn;           // 本手每人投进底池的份子钱

    // ── 拆两笔钱 ─────────────────────────────────────────────
    // 底皮：只有「这一手输过钱的人 + 弃牌者」的底皮留在皮池，归收池者；
    //       比牌不输的人（赢家、平局）底皮原样退回自己的簸簸，不进皮池。
    // 注额：bet 超出底皮的部分，两两按「头尾同时大」结算，两头都封顶。
    const extraOf = (p) => Math.max(0, p.bet - ante);

    // 结算后每人拿回多少：先默认「除底皮外的注额原样退回」，再按输赢重新分
    const back = new Map(this.seats.map((p) => [p.id, 0]));
    for (const p of contenders) back.set(p.id, extraOf(p));
    // 已经输出多少：既是封顶依据，也保证「不重复支付」
    const lostOut = new Map(this.seats.map((p) => [p.id, 0]));

    // 胜负判据（与 compareSplits 同一套）：
    //   尾大 + 头不输（头大或头平）→ 赢；
    //   尾平 + 头大 → 赢；尾平 + 头小 → 输；尾平 + 头平 → 平；
    //   一胜一负（头大尾小 / 头小尾大）→ 平。
    const beats = (a, b) => !!a.split && !!b.split && compareSplits(a.split, b.split) > 0;

    // 从强到弱：先看尾牌，尾牌平再看头牌。
    // 输家的钱按这个顺序「先到先得」分配 —— 尾大的人优先拿满，剩下的才轮到后面的人。
    const strength = (a, b) => {
      const t = comparePair(a.split.tail, b.split.tail);
      return t !== 0 ? -t : -comparePair(a.split.head, b.split.head);
    };

    // 单笔结算：两头封顶，取「自己还能赢的额度」和「对方还能输的额度」里小的那个。
    //   自己还能赢的 = 自己这一手的注额 − 已经输给更强者的部分（净额，不重复计算）；
    //   对方还能输的 = 对方这一手的注额 − 已经付给别人的部分。
    // 所以你下多少最多就赢多少，对方下得少你只赢到他那份，多下的钱留在簸簸里。
    const settlePair = (w, l) => {
      if (w === l) return 0;
      // v0.22.85：封顶按整注（含底皮）算，输家赔出的钱里先拿底皮抵
      const amt = Math.min(
        Math.max(0, w.bet - lostOut.get(w.id)),
        Math.max(0, l.bet - lostOut.get(l.id)),
      );
      if (amt <= 0) return 0;
      lostOut.set(l.id, lostOut.get(l.id) + amt);
      back.set(w.id, back.get(w.id) + amt);
      back.set(l.id, back.get(l.id) - Math.max(0, amt - ante));
      return amt;
    };

    // 收池：尾牌大的收底池（尾大吃皮）；尾牌同牌力再看头牌，
    // 头牌、尾牌牌力都相同才算并列，底池均分
    let potWinners = [];
    if (emperor) {
      potWinners = [emperor];
    } else {
      const ranked = contenders.filter((p) => p.split && p.split.head);
      if (!ranked.length) {
        // 兜底：还没分牌就结束（别人全弃）。「有人主动丢、只剩一家且没人加注」已在
        // finish() 开头走 voidHand('fold') 作废；这里剩的是加注打跑、三花等正常收池。
        potWinners = contenders.slice(0, 1);
      } else {
        let top = null;
        for (const p of ranked) {
          if (!top) { top = p; continue; }
          const t = comparePair(p.split.tail, top.split.tail);
          const h = comparePair(p.split.head, top.split.head);
          if (t > 0 || (t === 0 && h > 0)) top = p;
        }
        if (top) {
          potWinners = ranked.filter((p) => comparePair(p.split.tail, top.split.tail) === 0
            && comparePair(p.split.head, top.split.head) === 0);
        }
      }
    }

    // 谁在比牌里被击败（哪怕对方没注、实际没输钱，也算输家：底皮要进皮池）
    const beaten = new Set();
    if (emperor) {
      // 天皇通杀：每个对手各付一份封顶，其他人之间不再互相比
      for (const o of contenders) if (o !== emperor) { settlePair(emperor, o); beaten.add(o.id); }
    } else {
      // v0.22.82：输家「只认下注最多的赢家」——同时输给多家时不再各赔一份，
      // 总输出上限 = 头尾都赢他的赢家里面下注最大者的下注额；
      // 赢家按尾牌从大到小（尾同看头，ordered 已排好）串行收钱：
      // 尾大的先收满自己的下注（赢够为止），剩下的才轮给尾牌相对小的。
      // 例：123789 同时输给榔头(下2660)、肉汤圆(下1860)，只输 2660 =
      //     尾大的肉汤圆先收 1860，榔头收剩下 800。
      // v0.22.85：封顶按整注（含底皮）算——比牌输家总共只输到最大赢家的下注额为止，
      // 底皮不再额外进皮池（口径：青蛙进420出420正好归零）。
      const ordered = contenders.filter((p) => p.split && p.split.head).sort(strength);
      for (const l of ordered) {
        const ws = ordered.filter((w) => w !== l && beats(w, l));
        if (!ws.length) continue;
        beaten.add(l.id);
        let remain = Math.min(
          Math.max(...ws.map((w) => w.bet)),            // 只认下注最多的赢家
          Math.max(0, l.bet - lostOut.get(l.id)),       // 输家总输出上限（含底皮）
        );
        let paid = 0;
        for (const w of ws) {
          if (remain <= 0) break;
          const amt = Math.min(w.bet, remain);          // 赢家最多赢回自己的下注
          if (amt > 0) {
            lostOut.set(l.id, lostOut.get(l.id) + amt);
            back.set(w.id, back.get(w.id) + amt);
            remain -= amt;
            paid += amt;
          }
        }
        // 赔出去的钱里先拿底皮抵（底皮已随 bet 在池里），差额才从应退的注额里扣
        back.set(l.id, back.get(l.id) - Math.max(0, paid - ante));
      }
    }

    // ── 底皮归属 ─────────────────────────────────────────────
    // 比牌输过钱的人：底皮留在皮池里赔给赢家；
    // 比牌不输的人（收池者、平局）：底皮不算输，原样退回自己的簸簸。
    // 弃牌者照旧留底皮当死钱。
    // 这样底皮恒等式成立：进池底皮 + 退回底皮 = 全场底皮。
    const losers = contenders.filter((p) => beaten.has(p.id));
    const anteSum = (losers.length + folded.length) * ante;
    let anteRefund = 0;
    for (const p of contenders) {
      if (beaten.has(p.id)) continue;
      anteRefund += ante;
      back.set(p.id, (back.get(p.id) || 0) + ante);
    }

    // 底池 = 输家底皮 + 弃牌者底皮 + 弃牌者多下的注 + 本手圈芒 + 上一手滚存
    const foldedExtra = folded.reduce((s2, p) => s2 + extraOf(p), 0);
    const potBase = anteSum + foldedExtra + mangoIn;

    // ── 芒果池：按「下注」叫住来赔 ──────────────────────────
    // 芒果池相当于一位只输不赢的玩家，摆出 mangoPool 这么多钱等人叫。
    // 谁这一手往桌上下了注，谁就有资格吃；吃多少的上限 = 自己这一手的下注额
    // （bet 减掉底皮；不含底皮、不含圈芒 / 加倍 —— 底皮和圈芒都是进池的死钱，不能拿来叫芒果）。
    // 只交底皮没下注的人，额度为 0，吃不到。
    // 顺序：先皮池赢家，再按下注从多到少轮到其他在局玩家；
    // 全桌都吃满还有剩，才留在池里滚进下一手。
    // 比牌输赢只决定皮池归谁，不影响芒果：下注多的人就算牌小，
    // 只要下注够，也能把芒果池接走（比如 490 的池子，赢家吃 30，余下 460 归下注 950 的那家）。
    const mangoPool = mangoIn + carryIn;
    const betOnlyOf = (p) => Math.max(0, (p.bet || 0) - ante);
    const mangoGet = new Map();          // 每人这一手从芒果池吃到多少
    let mangoLeft = mangoPool;
    if (potWinners.length) {
      const order = [
        ...potWinners,
        ...contenders
          .filter((p) => !potWinners.includes(p))
          .sort((x, y) => betOnlyOf(y) - betOnlyOf(x) || x.seat - y.seat),
      ];
      for (const p of order) {
        if (mangoLeft <= 0) break;
        const got = Math.min(mangoLeft, betOnlyOf(p));
        if (got > 0) {
          mangoGet.set(p.id, got);
          mangoLeft -= got;
        }
      }
    }
    const mangoEat = mangoPool - mangoLeft;
    // 芒果是额外赔给各自的，直接进各自的 back；皮池才按收池者均分
    for (const [id, got] of mangoGet) back.set(id, (back.get(id) || 0) + got);

    // ── 弃牌者的死钱（整注含底皮）：按「尾大先赢够」分给在局玩家 ──────
    // v0.22.85：不再整体进皮池归收池者。每个弃牌者的整注单独作为一份死钱，
    // 在局玩家按尾牌从大到小（尾同看头）串行认领，每人最多认领自己的下注额。
    // 例：123789 弃牌死 840，肉汤圆(尾大、下420)先认领 420，
    //     剩下 420 归青蛙（青蛙虽比牌输了，但还在局、有权认领）。
    // 大家都「赢够」还有剩的，滚进下一手的池子。
    const claimOrder = contenders.filter((p) => p.split && p.split.head).sort(strength);
    if (!claimOrder.length && potWinners.length) claimOrder.push(potWinners[0]);
    const claim = new Map();
    let forfeitLeft = 0;
    if (potWinners.length) {
      for (const f of folded) {
        let remain = Math.max(0, f.bet || 0);
        for (const w of claimOrder) {
          if (remain <= 0) break;
          const amt = Math.min(w.bet, remain);
          if (amt > 0) {
            back.set(w.id, (back.get(w.id) || 0) + amt);
            claim.set(w.id, (claim.get(w.id) || 0) + amt);
            remain -= amt;
          }
        }
        forfeitLeft += remain;
      }
    }
    // 收池者这一手真正拿到的钱：认领到的死钱 + 他吃到的芒果
    const winnerMango = potWinners.reduce((s2, p) => s2 + (mangoGet.get(p.id) || 0), 0);
    const payable = (claim.get((potWinners[0] || {}).id) || 0) + winnerMango;

    if (potWinners.length) {
      this.carryPot = mangoLeft + forfeitLeft;
      const detail = [...mangoGet]
        .map(([id, got]) => {
          const p = this.seats.find((x) => x.id === id);
          return `${p ? p.name : id} ${got}`;
        })
        .join('、');
      if (mangoLeft > 0) {
        this.pushLog(`芒果池 ${mangoPool}：${detail ? `${detail}，` : ''}余 ${mangoLeft} 滚入下一手`);
      } else if (mangoEat > 0) {
        this.pushLog(`芒果池 ${mangoPool} 按下注赔完：${detail}`);
      }
    } else {
      // 没人能比牌（全员弃光）：整份投入连同圈芒原样退回，芒果原样留在池里
      for (const p of [...contenders, ...folded]) {
        back.set(p.id, p.bet + (p.mangoPaid || 0));
      }
    }

    const antePot = potBase;
    const potWinner = potWinners[0] || null;

    // 净输赢 = 拿回的 - 投进去的
    for (const p of this.seats) {
      if (!p.inHand) { delta.set(p.id, 0); continue; }
      delta.set(p.id, (back.get(p.id) || 0) - p.bet);
    }

    // 份子钱开局时已经从簸簸扣走，这里把它计入本手净输赢（赢家已经连本带池一起拿走）
    for (const p of this.seats) {
      if (p.mangoPaid) delta.set(p.id, (delta.get(p.id) || 0) - p.mangoPaid);
    }
    this.mangoIn = 0;

    // 揍芒 / 打断芒果链（v0.22.85 修订）：
    // 揍芒的唯一界定 —— **R2 轮次的牌发不发得出**：
    // · R1「大 / 敲」、没人跟注、其余人全弃（手在 R1 内收池，第三张发不出）→ 揍芒续链；
    // · 但凡第三张牌发出了（有人跟注、或 R1 没弃光进了第 2 轮、或 R2/R3 才喊价）
    //   → 就是正常手：连击链打断清零，不继续休 / 揍；
    // · 没人喊价、同一轮内顺序弃到剩最后一家 → 作废手退底皮（finish 开头已分流），休芒续链。
    const winner = contenders.length === 1 ? contenders[0] : null;
    const firstRaiseAt = !winner ? -1 : this.roundActions.findIndex(
      (r) => r.seat === winner.seat && (r.action === 'raise' || r.action === 'knock'),
    );
    let didRaise = false;
    let raiseRound = -1;
    if (winner && firstRaiseAt >= 0) {
      // 加注之后还得没人跟过，才算「打飞」；并记下这一杠发生在第几轮
      const followed = this.roundActions
        .slice(firstRaiseAt + 1)
        .some((r) => r.seat !== winner.seat && (r.action === 'follow' || r.action === 'raise'));
      didRaise = !followed;
      raiseRound = this.roundActions[firstRaiseAt].round;
    }
    // 休芒、揍芒共用同一条连击链：只要中间没人正常比牌收池/打断，两种就交替累加
    // （休芒 ×1 → 揍芒 ×2 → 休芒 ×4 …），份子逐次翻倍，×8 封顶。
    if (this.mangoEnabled && winner && folded.length > 0 && didRaise && raiseRound === 1 && this.round === 1) {
      // R1 喊价、无人跟注、第三张还没发就收池 → 揍芒
      this.mangoKind = 'zou';
      this.mangoStreak += 1;
      this.lastWinnerId = winner.id;
    } else {
      // 其余一律正常手：第三张已发出（无论被跟与否）、喊价被跟过再收池、
      // 或正常比牌收池 —— 连击链打断，下一手回到只交圈芒
      this.mangoKind = null;
      this.mangoStreak = 0;
      this.lastWinnerId = null;
    }

    for (const p of this.seats) {
      p.delta = delta.get(p.id) || 0;
      // 喊价时已经实时扣过，这里把下注额 + 净输赢 + 开局的芒果份子钱一起结算回来
      p.stack = Math.max(0, p.stack + p.bet + p.delta + (p.mangoPaid || 0));
    }

    this.log.push({
      handNo: this.handNo,
      // 皮池只记真正留在池里的钱：底皮只有输家 + 弃牌者出，比牌不输的人底皮已退回；
      // 活人之间多下的注按两两结算，平局的部分原样退回，不算池子；
      // 有短码全下才按主池 / 边池的静态金额记（主池扣掉退回的那部分底皮）。
      pot: ps.split ? Math.max(0, ps.main - anteRefund) + ps.side : (anteSum + foldedExtra),
      antePot,
      anteSum,                   // 进皮池的底皮
      anteRefund,                // 比牌不输、原样退回各人的底皮
      mainPot: ps.split ? Math.max(0, ps.main - anteRefund) : 0,   // 主池：最低一档人人有份
      sidePot: ps.side,          // 边池：短码全下后，深码之间多出来的部分
      sidePots: ps.sidePots,
      mangoPool,                 // 本手芒果池 = 圈芒/份子 + 上手滚存
      mangoEat,                  // 赢家这一手实际吃到的芒果
      carryLeft: mangoLeft,      // 这一手没吃完、滚进下一手的芒果
      potCover: payable,         // 收池者这一手真正拿到的池子钱
      winner: potWinner ? potWinner.seat : null,
      seats: this.seats.map((p) => ({
        seat: p.seat,
        name: p.name,
        isAI: !!p.isAI,        // v0.20.30：回顾页过滤机器人行用
        hand: p.hand,
        bet: p.bet,
        // 本手交的芒果份子：开局就从簸簸扣走，也是这一手的投入，
        // 回顾里跟下注额一起显示，免得出现「下 56 却输 61」这种看不懂的账
        mangoPaid: p.mangoPaid || 0,
        // 结算后收回簸簸的钱（含原样退回的多下注额），回顾里用来解释「投 1000 怎么只输 50」
        back: back.get(p.id) || 0,
        folded: p.folded,
        special: p.special,
        emperor: !!p.emperor,
        // 强制秀牌标记进回顾档案：别家翻回顾时这手四张才亮得出来
        showHand: !!p.showHand,
        split: p.split,
        delta: p.delta,
        // 本手从芒果池吃到多少（按下注「叫住」，赢家先吃，输家下注够也能吃）
        mangoWin: mangoGet.get(p.id) || 0,
      })),
    });
    if (this.log.length > 300) this.log.shift();   // 整局留档：60 分钟通常几十手，300 手兜住上限

    this.result = {
      handNo: this.handNo,
      antePot,
      anteSum,                   // 进皮池的底皮（输家 + 弃牌者）
      anteRefund,                // 比牌不输、退回各人的底皮合计
      mainPot: ps.split ? Math.max(0, ps.main - anteRefund) : 0,
      sidePot: ps.side,
      sidePots: ps.sidePots,
      carryIn,
      potWinner: potWinner ? potWinner.seat : null,
      potWinners: potWinners.map((p) => p.seat),
      // 芒果池这一手赔出去多少 / 还剩多少滚进下一手
      potCover: payable,
      mangoPool,
      mangoEat,
      // 兼容旧前端：全场芒果总赔付；逐人明细看 mangoShares
      mangoWin: mangoEat,
      mangoShares: [...mangoGet].map(([id, amount]) => {
        const p = this.seats.find((x) => x.id === id);
        return { seat: p ? p.seat : null, name: p ? p.name : id, amount };
      }),
      carryLeft: mangoLeft,
      carryPot: this.carryPot,
      reveal: this.seats.map((p) => ({
        seat: p.seat,
        name: p.name,
        hand: p.hand,
        bet: p.bet,
        folded: p.folded,
        special: p.special,
        split: p.split,
        delta: p.delta,
      })),
      pot: ps.split ? Math.max(0, ps.main - anteRefund) + ps.side : (anteSum + foldedExtra),
    };
    this.pushLog('本局结束');
    this.applyPendingBuyIns();
  }

  pushLog(text) {
    this.history.push({ t: Date.now(), text });
    if (this.history.length > 200) this.history.shift();
  }

  /** 音效队列：seq 单调递增，前端只播没听过的 */
  emitSfx(kind) {
    if (!kind) return;
    this.sfxSeq = (this.sfxSeq || 0) + 1;
    this.sfx = this.sfx || [];
    this.sfx.push({ seq: this.sfxSeq, kind });
    if (this.sfx.length > 40) this.sfx.shift();
  }

  /**
   * 牌面视图的「摆牌顺序」（v0.22.3）：
   *   · 还没分牌：按发牌原序（前两张暗牌、后两张明牌），方便玩家点选；
   *   · 玩家一分完牌：立刻按他选的「头头尾尾」摆，并从这一刻起一直固定到摊牌、结算。
   * 以前分牌阶段给原序、摊牌时才重排，于是摊牌那一刻牌肉眼可见地换位置
   * （视频里 0.9 秒那一跳）。现在两个阶段共用同一个顺序，摊牌不再二次重排。
   * 注意：归组后明牌可能落到前两位，前端必须按 holeIds / openIds 认明暗，不能数第几张。
   */
  viewOrder(p) {
    const s = p.split;
    if (s && s.headCards && s.tailCards
      && s.headCards.length === 2 && s.tailCards.length === 2) {
      return [...s.headCards, ...s.tailCards];
    }
    return p.hand.slice();
  }

  /**
   * 结算时的牌面视图：顺序与分牌阶段完全一致（见 viewOrder），不再另外重排。
   * 天皇/地皇通杀的、以及三花（三花十/三花六）自动弃的，四张全亮；
   * 其余弃牌的人不亮牌，只显示背面。
   */
  settledCards(p) {
    if (p.split && p.split.headCards && p.split.tailCards) return this.viewOrder(p);
    if (p.emperor) return p.hand.slice();
    if (p.special) return p.hand.slice();
    return [];
  }

  /**
   * 按视角脱敏：别人的两张底牌永远不下发，结算也不亮。
   * god=true 是开发者视角：全桌牌面照发，另外把剩余牌堆一起带上（末尾是下一张）。
   */
  snapshotFor(viewerSeat, god = false) {
    const vis = this.visibleCount();
    const ps = this.potSplit();
    const now = Date.now();
    // v0.22.23：结算期强制秀牌只对买家（点按钮的人）亮，其余人看到的仍是结算态
    const revealMine = this.phase === PHASE.SETTLED && this.revealUntil > now
      && (viewerSeat === this.revealBySeat || god);
    return {
      handNo: this.handNo,
      phase: this.phase,
      round: this.round,
      ante: this.ante,
      handMango: this.handMango,
      cap: this.capBase,
      buyIn: this.buyIn,
      holdFloor: this.holdFloor,   // 停牌门槛：簸簸低于此数，下手不发牌、进入留座
      floorMult: this.floorMult,   // v0.22.39：门槛 = 底皮 × floorMult（房主开房时选定）
      dijiuOn: this.dijiuOn !== false,  // v0.22.67：本桌地九王开关，前端据此显隐铭牌 / 本地预览
      holdSeconds: Game.BROKE_SECONDS,
      sfxSeq: this.sfxSeq || 0,    // 行动音效游标
      sfx: (this.sfx || []).slice(-12),
      capShort: this.capShort(viewerSeat),
      lastBringIn: this.lastBringIn || null,
      banker: this.banker,
      currentSeat: this.currentSeat,
      roundHighest: this.roundHighest,
      splitAt: this.splitAt || 0,          // 分牌倒计时起点
      splitLeft: this.phase === PHASE.SPLIT
        ? Math.max(0, SPLIT_SECONDS - Math.floor((Date.now() - (this.splitAt || Date.now())) / 1000))
        : 0,
      pot: this.pot,
      // 皮池：只算本手簸簸（含底皮），芒果另算；有短码全下时拆成主池 / 边池
      potChips: ps.main + ps.side,
      potMain: ps.main,
      potSide: ps.side,
      potSidePots: ps.sidePots,
      potSplit: ps.split,
      carryPot: this.carryPot,       // 芒果滚存池（体现为底池的一部分）
      mangoIn: this.mangoIn || 0,    // 本手已经投进底池的芒果份子钱
      potBase: this.seats.reduce((s, p) => s + p.bet, 0),  // 本手投入
      mango: this.mango,
      mangoKind: this.mangoKind,
      mangoStreak: this.mangoStreak,
      mangoTimes: this.mangoStreak,            // 连击次数（前端 ×n 显示用）
      mangoMult: this.mangoMult || 0,          // 份子倍数：0 = 正常手，1 / 2 / 4 / 8（封顶）
      mangoFee: this.handMango * (this.mangoMult || 0),  // 本手每家份子钱（不含圈芒）
      mangoPay: this.handMango * (1 + (this.mangoMult || 0)), // 普通玩家本手总额
      logs: [],                       // 整局记录按需拉取（见 room 的 logs 消息），别跟着每次推送发
      god,                            // 开发者视角：全桌牌面对前端公开
      deck: god ? this.deck.slice() : [],   // 剩余牌堆，pop() 取末尾那张 = 下一张要发的

      viewerSeat,
      seats: this.seats.map((p) => {
        // 结算时也只亮自己的四张，别人的两张底牌始终不公开
        const mine = p.seat === viewerSeat;
        // 第四张扣不扣：v0.20.26 起搓牌与透视完全独立——
        // 搓牌窗口（含刚发到第四张的声明期）全场都扣，透视/上帝视角也不例外，
        // 这样透视玩家开搓时大牌背照样显示，不会被瞬间穿帮收场。
        const hide4 = this.phase !== PHASE.SETTLED && p.hand.length >= 4
          && (p.scratchUntil > now || p.scratchGate > now);
        // 搓牌进行中（声明期除外）：连本人 hand 里的第四张也扣成 null，
        // 搓牌画面早已在声明期用真牌铺好，座位上保持牌背直到搓完。
        const hold4 = this.phase !== PHASE.SETTLED && p.hand.length >= 4
          && p.scratchUntil > now;
        const handView = (mine || god || p.showHand)
          ? (hold4 ? p.hand.map((c, i) => (i === 3 ? null : c)) : p.hand.slice())
          : null;
        // v0.22.3：牌的「身份」名单，一律按发牌原序取，与 cardsView 的显示顺序无关。
        // 分牌归组后明牌可能排到前两位，前端靠这两份名单认明暗，不再数第几张。
        const holeIds = p.hand.slice(0, 2).filter(Boolean).map((c) => c.id);
        const openIds = p.hand.slice(2).filter(Boolean).map((c) => c.id);
        const lastCardId = p.hand.length >= 4 && p.hand[3] ? p.hand[3].id : '';
        const headIds = (p.split && p.split.headCards ? p.split.headCards : [])
          .filter(Boolean).map((c) => c.id);
        const tailIds = (p.split && p.split.tailCards ? p.split.tailCards : [])
          .filter(Boolean).map((c) => c.id);
        // v0.22.3：先定「摆牌顺序」和每张牌的明暗身份，再按视角脱敏。
        // viewHole 与 cardsView 一一对应，前端据此把暗牌贴头像、明牌亮在桌上；
        // 即使牌被归组、即使某一格是牌背（null），也不会认错。
        const ordered = this.viewOrder(p);
        const holeSet = new Set(holeIds);
        const viewHole = ordered.map((c) => !!(c && holeSet.has(c.id)));
        const shown = new Set(openIds);
        const settled = this.phase === PHASE.SETTLED;
        const cardsView = god
          // 开发者视角：结算时连弃牌者已发的手牌也亮出来
          // 搓牌扣牌与透视独立：第四张该扣时透视视角同样只见牌背（按牌 id 认）
          ? (settled
            ? (this.settledCards(p).length ? this.settledCards(p) : p.hand.slice())
            : ordered.map((c) => (c && hide4 && c.id === lastCardId ? null : c)))
          : settled
            ? (revealMine
              ? ordered                 // 结算期强制秀牌：只有买家看到四张全亮，顺序照旧
              : this.settledCards(p))
            // 搓牌：第四张按牌 id 扣住，全场（连同本人）都只看到牌背，等搓完 / 到点再翻
            : ordered.map((c) => {
              if (!c) return null;
              if (hide4 && c.id === lastCardId) return null;
              return (mine || p.showHand || shown.has(c.id)) ? c : null;
            });
        return {
          seat: p.seat,
          // 这一格是不是看牌的人自己：前端点头像时用，自己的头像不弹资料卡
          mine,
          id: p.id,
          name: p.name,
          // 簸簸：本人带上桌的钱。牌局进行中，开局交的芒果份子已从 stack 扣走，
          // 但那是本手的支出、还没结算，这里用 paid 单独标出来，前端显示 stack + paid，
          // 这样「簸簸 56 却输 61」就不会再出现（56 是交完份子后的余额，61 才是本手开局的钱）。
          stack: p.chips ?? p.stack ?? 0,
          paid: (this.phase === PHASE.BET || this.phase === PHASE.SPLIT) ? (p.mangoPaid || 0) : 0,
          broke: !!p.broke,
          shortTip: p.shortTip || '',     // 「簸簸不足抢芒」：差钱被停发牌的提示
          hold: !!p.hold,                 // 还没带入：留座中
          asking: !!p.asking,             // 已提交带入申请（不停表）
          brokeSince: p.brokeSince || 0,
          // v0.22.82：等审核也照常报留座倒计时（不再因 asking 归零）
          brokeLeft: p.broke && p.brokeSince
            ? Math.max(0, Game.BROKE_SECONDS - Math.floor((Date.now() - p.brokeSince) / 1000))
            : 0,
          joinNext: !!p.joinNext,
          away: !!p.away,
          // 保位离桌：结算后进留座倒计时，读完由房间弹座（和「簸簸见底」分开算）
          holdLeave: !!p.holdLeave,
          holdSince: p.holdSince || 0,
          holdLeft: p.holdLeave && p.holdSince
            ? Math.max(0, Game.BROKE_SECONDS - Math.floor((Date.now() - p.holdSince) / 1000))
            : 0,
          timeouts: p.timeouts || 0,
          pending: p.pendingBuyIn || 0,   // 中途带入、本手结束后到账的钱
          bet: p.bet,
          folded: p.folded,
          knocked: p.knocked,
          shortKnock: !!p.shortKnock,     // 敲了但簸簸不够跟注：搭不动
          allIn: p.allIn,
          inHand: p.inHand,
          isAI: p.isAI,
          isBanker: p.seat === this.banker,
          cardCount: p.hand.length,
          hand: handView,
          // 强制秀牌：本手四张对全桌公开（下一手自动收回）
          showHand: !!p.showHand,
          // 统一给客户端的牌面视图：null = 背面，其余为可见牌。
          // v0.22.3：顺序统一由 viewOrder 决定——分完牌就是「头头尾尾」，摊牌沿用，
          // 不再二次重排。viewHole 与它一一对应，前端按这份名单认明暗，不再数第几张。
          cardsView, viewHole,
          // 明暗 / 头尾的身份名单：按牌 id 认，不靠位置（v0.22.3）
          holeIds, openIds, headIds, tailIds,
          visible: p.hand.slice(2, 2 + vis),
          // 搓牌剩余秒数（0 = 没在搓），前端据此显示倒计时、到期收场
          scratchLeft: p.scratchUntil > Date.now()
            ? Math.max(0, Math.ceil((p.scratchUntil - Date.now()) / 1000))
            : 0,
          // 刚发到第四张的等待窗口还剩多少毫秒：只有这段窗口里才允许开搓，
          // 刷新 / 重连后看到的是早已过了窗口的旧牌，不该再补一次搓牌
          scratchGateLeft: Math.max(0, (p.scratchGate || 0) - Date.now()),
          scratchUsed: !!p.scratchUsed,
          scratchPaid: !!p.scratchPaid,   // 本手搓牌费已付：前端据此决定开关要不要再收钻
          splitOptions: p.seat === viewerSeat ? p.splitOptions : null,
          splitIndex: p.splitIndex,
          split: p.split,
          special: p.special,
          refunded: p.refunded || 0,
          emperor: !!p.emperor,
          canDecline: p.seat === viewerSeat ? p.canDecline : null,
          lastAction: p.lastAction,
          delta: this.phase === PHASE.SETTLED ? p.delta : 0,
          // 实时战绩：带入多少、打了几手、簸簸减带入就是输赢。
          // 口径和桌面那颗簸簸数字严格一致（带入 + 胜负 = 簸簸），
          // 所以牌局进行中下注离手的钱会如实算成负的，不会出现「桌面少了 100、
          // 战绩却显示 +100」这种对不上的情况。
          // 中途带入先挂账（pendingBuyIn），钱没进簸簸，带入列也不加，
          // 单独给出 pending 让表里标「待到账」，账面依然对得上。
          buyIn: p.buyInTotal || 0,
          pending: p.pendingBuyIn || 0,
          hands: p.handsTotal || 0,
          net: (p.stack || 0)
            + ((this.phase === PHASE.BET || this.phase === PHASE.SPLIT) ? (p.mangoPaid || 0) : 0)
            - (p.buyInTotal || 0),
        };
      }),
      departed: this.departed.slice(-200),
      result: this.result,
      // v0.21.2：history（本手文字记录）前端并不使用，回顾走 logs 接口，
      // 每次广播都带 30 条只会白白撑大快照，这里不再下发
      // history: this.history.slice(-30),
      legalActions: this.legalActions(viewerSeat),
      allRevealed: this.allRevealedHand === this.handNo,
      revealLeft: revealMine ? Math.max(0, Math.ceil((this.revealUntil - Date.now()) / 1000)) : 0,
      raiseAmount: this.raiseAmount(),
      roundFloor: this.roundFloor || this.ante,
      raiseStep: this.raiseStep(),
      minRaise: this.minRaise(),
      maxRaise: this.maxRaise(viewerSeat),
    };
  }
}

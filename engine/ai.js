/**
 * 机器人决策
 * ------------------------------------------------------------------
 * 目标不是打得多强，而是「像个正常牌友」：
 *   · 牌好会领注、会加，牌一般也敢跟几口；
 *   · 别人「敲」全下时不无脑弃牌 —— 牌力够就敲回去比牌；
 *   · 牌力实在不行时允许整桌「休」：该滚圈芒就滚，不硬撑也不硬开价。
 * 牌力估值分档，再叠加底池赔率与固定性格（松 / 紧、爱不爱偷鸡）。
 */

import { evaluatePair, comparePair } from './evaluator.js';
import { bestSplit } from './split.js';

function tierScore(p) {
  if (p.tier >= 26) return 0.95; // 丁皇 / 天地人和
  if (p.tier >= 19) return 0.82; // 梅十 ~ 膏药
  if (p.tier >= 18) return 0.68; // 普通对子
  if (p.tier >= 5) return 0.52;  // 各种杠、九
  const point = Math.floor(p.tie / 1000);
  return 0.12 + point * 0.032;   // 散牌 0~9 点
}

/** 0~1 的手牌强度（dijiuOn=false 时 2+9 按 1 点散牌算） */
export function strength01(hand, dijiuOn = true) {
  if (!hand.length) return 0;
  if (hand.length < 4) {
    let best = null;
    for (let i = 0; i < hand.length; i++) {
      for (let j = i + 1; j < hand.length; j++) {
        const p = evaluatePair(hand[i], hand[j], dijiuOn);
        if (!best || comparePair(p, best) > 0) best = p;
      }
    }
    const raw = best ? tierScore(best) : 0;
    // 牌还没发完，打点折扣
    return hand.length === 3 ? raw * 0.92 : raw * 0.85;
  }
  const s = bestSplit(hand, dijiuOn);
  const lo = Math.min(tierScore(s.head), tierScore(s.tail));
  const hi = Math.max(tierScore(s.head), tierScore(s.tail));
  return 0.75 * lo + 0.25 * hi;
}

/** 每个机器人固定的性格：同一张脸整局不会忽松忽紧 */
function persona(id) {
  let h = 2166136261;
  const key = String(id || '');
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const u = h >>> 0;
  return {
    loose: (u % 1000) / 1000,              // 0 紧 ~ 1 松：影响跟注门槛与加注频率
    bluff: 0.05 + ((u >>> 10) % 100) / 450, // 0.05 ~ 0.27 偷鸡频率
  };
}

export function decide(game, seat) {
  const p = game.seats[seat];
  const legal = game.legalActions(seat);
  if (!legal.length) return { action: 'fold' };

  const hand = p.hand || [];
  const s = strength01(hand, game.dijiuOn !== false);  // 0~1 牌力（跟随本桌地九王开关）
  const stage = Math.min(hand.length, 4);      // 2 张底牌 / 3 张 / 4 张
  const need = Math.max(0, game.roundHighest - p.bet);
  const mine = Math.max(1, p.stack + p.bet);   // 我这一轮最多能投到多少
  const potOdds = need / Math.max(game.pot + need, 1);
  const { loose, bluff } = persona(p.id || `s${seat}`);
  const rnd = Math.random();

  const canRaise = legal.includes('raise');
  const canKnock = legal.includes('knock');
  const canFollow = legal.includes('follow');
  const canPass = legal.includes('pass');
  const canFold = legal.includes('fold');

  /** 加注到多少：多数只抬最小注，牌很硬才多加一点（别把注额顶到没人跟得起） */
  const raiseTo = () => {
    const floor = game.minRaise();
    const grow = s > 0.8 ? 1.35 : s > 0.62 ? 1.15 : 1;
    return Math.max(floor, Math.min(Math.round(floor * grow), mine));
  };

  const giveUp = () => (canFold
    ? { action: 'fold' }
    : canFollow ? { action: 'follow' } : { action: legal[0] });

  /* ── ① 面对别人的注 ───────────────────────────── */
  if (need > 0) {
    // 跟不起（对方敲全下 / 自己簸簸不够）：只能「敲」或「丢」。
    // 牌力不是烂到底就跟上去比牌，别一见敲就集体弃。
    if (canKnock && !canFollow) {
      const bar = 0.24 + (1 - loose) * 0.14;   // 0.24 ~ 0.38：牌力过半就跟上去比
      return s >= bar ? { action: 'knock' } : giveUp();
    }

    // 这一口占我筹码的比例：小注几乎都给，大注才认真掂量
    const ratio = need / mine;
    // 对方把价抬到大半筹码：这就是「拼牌」了 —— 牌力过半就跟，
    // 跟不起就敲上去比，别一见大注就集体弃牌
    if (ratio >= 0.6) {
      const allInBar = 0.16 + (1 - loose) * 0.12;   // 0.16 ~ 0.28：有一对 / 中高散牌就敢比
      if (s < allInBar) return giveUp();
      if (canFollow) return { action: 'follow' };
      return canKnock ? { action: 'knock' } : giveUp();
    }
    const heavy = ratio >= 0.4;
    // 跟注门槛以「自己的牌力」为主，底池赔率只做微调 ——
    // 便宜的一口（小注）哪怕散牌也跟，别打成「一加全跑」
    const bar = 0.17 + ratio * 0.45 + potOdds * 0.12 - loose * 0.05
      + (stage === 4 ? -0.05 : 0);

    // 手牌硬：抬一手
    if (canRaise && s > 0.74 && !heavy && rnd < 0.2 + loose * 0.12) {
      return { action: 'raise', amount: raiseTo() };
    }
    // 牌硬到可以直接「敲」
    if (canKnock && s > 0.8 && (heavy || rnd < 0.3)) return { action: 'knock' };

    // 便宜的一口（不超过 2 倍底皮）基本都给一眼
    if (canFollow && (s >= bar || need <= game.ante * 2)) return { action: 'follow' };
    // 边缘牌偶尔跟，别让桌子变成「一加全跑」
    if (canFollow && s >= bar * 0.8 && rnd < 0.55) return { action: 'follow' };
    return giveUp();
  }

  /* ── ② 没人下注：领注 / 偷鸡 / 过牌 ───────────── */
  // 牌力不行时允许整桌「休」：全休就是一手休芒，底皮退回，圈芒 + 加倍滚进下一手。
  // 所以不再硬逼最后一家拿烂牌开价 —— 只有牌力过得去（或偶尔偷鸡）才领注。
  const mustOpen = game.isLastToAct(seat) || game.wouldVoidIfPass(seat);
  const pending = game.aliveSeats().filter((x) => x !== seat
    && !game.seats[x].allIn && !game.seats[x].knocked
    && !game.actedThisRound.has(x)).length;
  const nearLast = pending <= 1;
  // 0 点、1 点这类散牌（2 张底牌时 s 约 0.10 ~ 0.16）就算弱：跟着休；
  // 留一小撮偷鸡概率，别让机器人变成「牌烂就一动不动」的死板程序
  const tooWeak = s < 0.18 && rnd > bluff * 0.8;
  if (mustOpen) {
    if (tooWeak) {
      if (canPass) return { action: 'pass' };
    } else {
      // 轮到我收尾：加得动就加，加不动就敲（全下）
      if (canRaise) return { action: 'raise', amount: raiseTo() };
      if (canKnock) return { action: 'knock' };
    }
  }
  if (canRaise) {
    // 只剩两家没表态：牌不算烂就先把价开出来，别两家对着「休」
    if (nearLast && !tooWeak && (s >= 0.28 || (s >= 0.2 && rnd < 0.5))) {
      return { action: 'raise', amount: raiseTo() };
    }
    if (!tooWeak && s >= 0.5 && rnd < 0.45 + loose * 0.3) return { action: 'raise', amount: raiseTo() };
    if (!tooWeak && s >= 0.36 && rnd < bluff) return { action: 'raise', amount: raiseTo() };
    if (s < 0.16 && rnd < bluff * 0.5) return { action: 'raise', amount: raiseTo() };
  }
  if (canPass) return { action: 'pass' };
  if (canFollow) return { action: 'follow' };
  return giveUp();
}

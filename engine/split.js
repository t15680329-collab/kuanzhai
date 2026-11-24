/**
 * 分牌：4 张牌拆成头（2 张）+ 尾（2 张）
 * ------------------------------------------------------------------
 * 3 种拆法（C(4,2)/2 = 3），头尾顺序由系统按牌力自动排好，
 * 玩家只需要在 3 种拆法里选 1 种 —— 这是线上实现的标准做法，
 * 避免「头小于尾」的相公判定。
 */

import { evaluatePair, comparePair } from './evaluator.js';

/** 归一化牌力，只用于估值/排序，不参与判胜负 */
export function rating(p) {
  return p.tier === 0 ? (p.tie / 1000) / 10 : 10 + p.tier / 3;
}

function buildSplit(headCards, tailCards, head, tail) {
  const rh = rating(head);
  const rt = rating(tail);
  // 两门都要硬：短板权重更高，符合「头要硬、尾不烂」
  const score = 2 * Math.min(rh, rt) + Math.max(rh, rt);
  return { headCards, tailCards, head, tail, score };
}

/** 枚举 3 种分法（dijiuOn=false 时 2+9 按 1 点散牌算，见 evaluatePair） */
export function enumerateSplits(hand, dijiuOn = true) {
  if (hand.length !== 4) throw new Error('分牌需要恰好 4 张牌');
  const [a, b, c, d] = hand;
  const groups = [
    [[a, b], [c, d]],
    [[a, c], [b, d]],
    [[a, d], [b, c]],
  ];
  let splits = groups.map(([g1, g2]) => {
    const e1 = evaluatePair(g1[0], g1[1], dijiuOn);
    const e2 = evaluatePair(g2[0], g2[1], dijiuOn);
    const firstIsHead = comparePair(e1, e2) >= 0;
    return firstIsHead
      ? buildSplit(g1, g2, e1, e2)
      : buildSplit(g2, g1, e2, e1);
  });

  // 丁皇绑定：红3 和大王必须在一门里，不能拆开
  const hasDing = hand.some((c) => c.id === 'BJ') && hand.some((c) => c.id === 'H3');
  if (hasDing) {
    splits = splits.filter((s) => {
      const inHead = s.headCards.some((c) => c.id === 'BJ') && s.headCards.some((c) => c.id === 'H3');
      const inTail = s.tailCards.some((c) => c.id === 'BJ') && s.tailCards.some((c) => c.id === 'H3');
      return inHead || inTail;
    });
  }
  return splits;
}

/** 取最优分法（AI / 托管用） */
export function bestSplit(hand, dijiuOn = true) {
  return enumerateSplits(hand, dijiuOn).reduce((best, s) => (s.score > best.score ? s : best));
}

/** 手牌总强度（0~20 左右），用于下注决策 */
export function handStrength(hand, dijiuOn = true) {
  if (hand.length < 4) {
    // 不足 4 张时，用所有两两组合里的最强牌型估个大概
    let best = -1;
    for (let i = 0; i < hand.length; i++) {
      for (let j = i + 1; j < hand.length; j++) {
        const p = evaluatePair(hand[i], hand[j], dijiuOn);
        const r = rating(p);
        if (r > best) best = r;
      }
    }
    return best;
  }
  return bestSplit(hand, dijiuOn).score;
}

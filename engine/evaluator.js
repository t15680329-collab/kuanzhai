/**
 * 牌型判定：两张牌 → 一个牌型
 * ------------------------------------------------------------------
 * 牌型序（大 → 小，共 18 档 + 散牌）：
 *   1 丁皇 > 2 天 > 3 地 > 4 人 > 5 和
 *   > 6 梅十/板凳/长三 > 7 虎头/苕十/猫猫/膏药 > 8 对子(黑9/8/7/5)
 *   > 9 天王 > 10 地王 > 11 天杠 > 12 地杠 > 13 天关九 > 14 地关九
 *   > 15 灯笼九 > 16 和五九 > 17 梅十九/板五九/丁长九
 *   > 18 苕十九/丁猫九/乌龙九 > 散牌
 * 同一档里的组合牌力完全相同，例如 黑10+黑9 = 黑4+黑5 = 黑6+红3；
 * 苕十九 = 丁猫九 = 乌龙九（红10+黑9 = 红3+红6 = 黑8+黑J）。
 *
 * tier 数值越大牌越大；tie 用于同 tier 内部细分。
 * strength 只给 AI 做估值，不参与判胜负。
 */

const key = (c) => c.color + '-' + c.rank;

// 同色同点 → 固定牌型。牌力按 18 档归并：
//   第 6 档：梅十 / 板凳 / 长三（大对子）
//   第 7 档：虎头 / 苕十(靛十) / 猫猫 / 膏药（小对子）
//   第 8 档：对黑 9 / 8 / 7 / 5（普通对子，全部同牌力）
const PAIR_TABLE = {
  'red-Q': ['天牌', 31],
  'red-2': ['地牌', 30],
  'red-8': ['人牌', 29],
  'red-4': ['和牌', 28],
  'black-10': ['梅十', 27],
  'black-4': ['板凳', 27],
  'black-6': ['长三', 27],
  'black-J': ['虎头', 26],
  'red-10': ['苕十', 26],
  'red-6': ['猫猫', 26],
  'red-7': ['膏药', 26],
};

// 普通对子（黑 5/7/8/9），tier 18，tie 用点数区分
const PLAIN_PAIR = new Set(['black-5', 'black-7', 'black-8', 'black-9']);

// 天/地系列：只认点数，8 和 7 是红是黑都成立
const RANK_COMBOS = [
  ['奶狗', 19, 'Q', '9'],   // 也叫天王
  ['地王', 18, '2', '9'],
  ['天杠', 17, 'Q', '8'],
  ['地杠', 16, '2', '8'],
  ['天关九', 15, 'Q', '7'],
  ['地关九', 14, '2', '7'],
];

// 其余组合要看颜色（和/板、灯笼/乌龙、丁长/丁猫、梅十/苕十靠颜色区分）
// 第 17 档：梅十九 / 板五九 / 丁长九 —— 黑10+黑9 = 黑4+黑5 = 黑6+红3
// 第 18 档：苕十九 / 丁猫九 / 乌龙九 —— 红10+黑9 = 红3+红6 = 黑8+黑J
const COMBO_TABLE = [
  ['灯笼九', 13, 'red-8', 'black-J'],
  ['和五九', 12, 'red-4', 'black-5'],
  ['梅十九', 11, 'black-10', 'black-9'],
  ['板五九', 11, 'black-4', 'black-5'],
  ['丁长九', 11, 'red-3', 'black-6'],
  ['苕十九', 10, 'red-10', 'black-9'],
  ['丁猫九', 10, 'red-3', 'red-6'],
  ['乌龙九', 10, 'black-8', 'black-J'],
];

function make(name, tier, tie, extra = {}) {
  return { name, tier, tie, strength: tier * 10 + (tie > 0 && tier === 0 ? tie : 0), ...extra };
}

/** 整手天皇：大王 + 红3 + 一对红Q，四张齐全，通杀全场（丁皇只是其中两张） */
export function isEmperorHand(hand) {
  if (!hand || hand.length !== 4) return false;
  const ids = new Set(hand.map((c) => c.id));
  return ids.has('BJ') && ids.has('H3') && ids.has('HQ') && ids.has('DQ');
}

/** 整手地皇：大王 + 红3 + 一对红2，通杀（次于天皇） */
export function isEarthHand(hand) {
  if (!hand || hand.length !== 4) return false;
  const ids = new Set(hand.map((c) => c.id));
  return ids.has('BJ') && ids.has('H3') && ids.has('H2') && ids.has('D2');
}

/** 整手人皇：大王 + 红3 + 一对红8，通杀 */
export function isHumanEmperorHand(hand) {
  if (!hand || hand.length !== 4) return false;
  const ids = new Set(hand.map((c) => c.id));
  return ids.has('BJ') && ids.has('H3') && ids.has('H8') && ids.has('D8');
}

/** 整手和皇：大王 + 红3 + 一对红4，通杀 */
export function isHarmonyHand(hand) {
  if (!hand || hand.length !== 4) return false;
  const ids = new Set(hand.map((c) => c.id));
  return ids.has('BJ') && ids.has('H3') && ids.has('H4') && ids.has('D4');
}

/** 判定两张牌组成的牌型
 *  dijiuOn（默认 true）：本桌是否启用「地九王」（2+9 = 地王，tier 18）。
 *  v0.22.67：关掉时跳过地王组合，让 2+9 落进下面的散牌分支，
 *  按 (point 相加取个位) 算成 1 点；其余牌型一律不变。 */
export function evaluatePair(a, b, dijiuOn = true) {
  // 丁皇：红桃3 + 大王
  if ((a.id === 'H3' && b.id === 'BJ') || (b.id === 'H3' && a.id === 'BJ')) {
    return { name: '丁皇', tier: 32, tie: 0, strength: 320, detail: '红3 + 大王' };
  }

  const ka = key(a);
  const kb = key(b);

  if (ka === kb) {
    if (PAIR_TABLE[ka]) {
      const [name, tier] = PAIR_TABLE[ka];
      return { name, tier, tie: 0, strength: tier * 10 };
    }
    if (PLAIN_PAIR.has(ka)) {
      const rank = Number(a.rank);
      // 普通对子（黑 5/7/8/9）牌力完全一样：对黑8 = 对黑5 = 对黑7 = 对黑9
      return { name: '对子', tier: 20, tie: 0, strength: 200, detail: `${rank} 对` };
    }
    // 理论上不存在（同色同点但不在表内），兜底按散牌
  }

  for (const [name, tier, r1, r2] of RANK_COMBOS) {
    // 地九王（2+9）在本桌关闭时不成立，落到散牌按 1 点算
    if (!dijiuOn && name === '地王') continue;
    const hit = (a.rank === r1 && b.rank === r2) || (a.rank === r2 && b.rank === r1);
    if (hit) return { name, tier, tie: 0, strength: tier * 10 };
  }

  for (const [name, tier, x, y] of COMBO_TABLE) {
    if ((ka === x && kb === y) || (ka === y && kb === x)) {
      return { name, tier, tie: 0, strength: tier * 10 };
    }
  }

  // 散牌：两牌点数相加取个位
  const point = (a.point + b.point) % 10;
  const maxPower = Math.max(a.power, b.power);
  return {
    name: '散牌',
    tier: 0,
    tie: point * 1000 + maxPower,
    strength: point,
    detail: `${point} 点`,
  };
}

/** 比较两个牌型：>0 表示 x 大，<0 表示 y 大，0 表示完全相同 */
export function comparePair(x, y) {
  if (x.tier !== y.tier) return x.tier - y.tier;
  return x.tie - y.tie;
}

/** 展示用短标签 */
export function pairLabel(p) {
  if (p.tier === 0) return `${p.tie / 1000 | 0} 点`;
  return p.name;
}

/**
 * 扯旋（丁二皇）牌张定义
 * ------------------------------------------------------------------
 * 32 张牌：红桃3 一张、大王 一张，其余 15 组「同色同点」各两张。
 * 「红」= 红桃 + 方块，「黑」= 黑桃 + 梅花。这是川牌的分色方式，
 * 不是扑克里的四种花色独立计数。
 *
 * point : 用于散牌算点的牌面值（红Q=2、黑J=1、大王=6，其余按面值）
 * power : 单牌牌力，用于同点数散牌、以及明牌先手判定
 */

export const SUIT_SYMBOL = { H: '♥', D: '♦', S: '♠', C: '♣', J: '王' };
export const SUIT_NAME   = { H: '红桃', D: '方块', S: '黑桃', C: '梅花', J: '大王' };

// [花色, 点数, 牌点值, 单牌牌力]
const SPEC = [
  [['H', 'D'], 'Q',  2, 100],
  [['H', 'D'], '2',  2,  95],
  [['H', 'D'], '8',  8,  90],
  [['H', 'D'], '4',  4,  85],
  [['H', 'D'], '10', 10, 70],
  [['H', 'D'], '7',  7,  70],
  [['H', 'D'], '6',  6,  70],
  [['H'],      '3',  3,  60],
  [['S', 'C'], '10', 10, 80],
  [['S', 'C'], '4',  4,  80],
  [['S', 'C'], '6',  6,  80],
  [['S', 'C'], 'J',  1,  70],
  [['S', 'C'], '9',  9,  60],
  [['S', 'C'], '8',  8,  60],
  [['S', 'C'], '7',  7,  60],
  [['S', 'C'], '5',  5,  60],
];

function buildCard(suit, rank, point, power) {
  const isJoker = suit === 'J';
  return {
    id: isJoker ? 'BJ' : suit + rank,
    suit,
    rank,
    color: suit === 'H' || suit === 'D' ? 'red' : isJoker ? 'joker' : 'black',
    point,
    power,
    label: isJoker ? '王' : rank,
    symbol: SUIT_SYMBOL[suit],
    name: isJoker ? '大王' : SUIT_NAME[suit] + rank,
  };
}

/** 完整牌堆（不可变模板，发牌时复制） */
export const DECK = (() => {
  const cards = [];
  for (const [suits, rank, point, power] of SPEC) {
    for (const s of suits) cards.push(buildCard(s, rank, point, power));
  }
  cards.push(buildCard('J', 'BJ', 6, 60));
  return Object.freeze(cards);
})();

export const DECK_SIZE = DECK.length; // 32

/** 密码学安全随机整数，避免 Math.random 的可预测性 */
export function secureRandomInt(max) {
  const g = globalThis.crypto;
  if (g && g.getRandomValues) {
    const buf = new Uint32Array(1);
    const limit = Math.floor(0x100000000 / max) * max;
    let x;
    do { g.getRandomValues(buf); x = buf[0]; } while (x >= limit);
    return x % max;
  }
  return Math.floor(Math.random() * max);
}

/** Fisher–Yates 洗牌，返回新数组 */
export function shuffle(cards, rand = secureRandomInt) {
  const a = cards.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = rand(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function cloneDeck() {
  return DECK.map((c) => ({ ...c }));
}

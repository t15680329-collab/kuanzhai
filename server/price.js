/**
 * 钻石定价表
 * ------------------------------------------------------------------
 * 一处定义，服务端扣费与前端展示共用（前端不能 import 服务端文件，
 * 所以 web/app.js 里有一份镜像常量，改价时两边一起改）。
 *
 *   开房    10 钻 / 30 分钟（30 / 60 / 90 / 120 分钟 → 10 / 20 / 30 / 40）
 *   发发看    2 钻 / 次
 *   强制秀牌 10 钻 / 手（只亮这一手，下一手要重新买）
 *   搓牌      5 钻 / 场（整场第一次开启扣，之后反复开关、换手都不再扣）
 *   表情      1 钻 / 个
 *   改名     10 钻（每个号第一次免费）
 *   洗牌      2 钻 / 次（结算停留期全桌同步播放，间隔顺延）
 *
 * 环境变量仍可覆盖，方便本地调试时把价格调成 0。
 */

const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : d;
};

export const PRICE = {
  create: num(process.env.DH_PRICE_CREATE, 10),        // 每 30 分钟
  next: num(process.env.DH_PRICE_NEXT, 2),             // 发发看
  forceShow: num(process.env.DH_PRICE_SHOW, 10),       // 强制秀牌
  revealAll: num(process.env.DH_PRICE_REVEAL, 10),     // 结算期全桌亮底牌 1.5 秒
  peek: num(process.env.DH_PRICE_PEEK, 2),             // 回顾里偷偷看一家底牌
  scratch: num(process.env.DH_PRICE_SCRATCH, 5),       // 搓牌（整场一次）
  emote: num(process.env.DH_PRICE_EMOTE, 1),           // 表情
  rename: num(process.env.DH_PRICE_RENAME, 10),        // 改名
  shuffle: num(process.env.DH_PRICE_SHUFFLE, 2),       // 洗牌（结算期全桌同步动画）
};

/** 开房计价单位：每 30 分钟一档 */
export const CREATE_UNIT_MIN = 30;

/** 开房总价：按 30 分钟向上取整，10 钻 × 档数 */
export function createCost(durationMin) {
  const min = Number(durationMin) > 0 ? Number(durationMin) : 60;
  return Math.ceil(min / CREATE_UNIT_MIN) * PRICE.create;
}

/** 新号初始钻石：够开两间 30 分钟房、试几次表情和搓牌 */
export const SIGNUP_DIAMONDS = num(process.env.DH_SIGNUP_DIAMONDS, 60);

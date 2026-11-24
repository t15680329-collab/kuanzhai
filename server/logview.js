/**
 * v0.22.59 牌局回顾的可视范围
 * ------------------------------------------------------------------
 * 回顾页下发「该房间所有已完成结算的历史对局」，包括结算停留期刚打完、
 * 以及房间停牌 / 结束前的最后一手——不再要求「等下一手开始才显示上一手」。
 *
 * 安全性：game.log 里的每条记录都是 finish() / voidHand() 归档的已结算手，
 * 正在打、还没结算的本手根本不在 log 里，所以回顾里的「秀这手牌」/「偷偷看」
 * 依然碰不到桌上正在进行的底牌。结算停留期归档的那一手桌面本就摊牌了，
 * 允许回顾不会泄露任何新信息。
 *
 * 判定集中放这里，服务端协议（logs / showLogHand / peekLog）共用，
 * 并由 test/logshow.test.js 锁死。
 */

/** 从整局记录里挑出「已完成结算」的全部历史手，旧的在前。
 *  参数 curHandNo 仅为兼容旧调用保留，不再用来过滤。 */
export function historicalHands(log, _curHandNo) {
  return (log || []).filter((e) => e && Number.isFinite(Number(e.handNo)));
}

/** 这一手是不是「已结算归档、可以回顾 / 可以秀 / 可以偷看」的历史手。
 *  未归档（还在打）、未来手、不存在的手、非法 handNo 一律 false。 */
export function isHistoricalHand(game, handNo) {
  if (!game || !Number.isInteger(handNo)) return false;
  return historicalHands(game.log).some((e) => Number(e.handNo) === handNo);
}

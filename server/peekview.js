/**
 * v0.20.76 发发看「仅自己可见牌面」的纯约束（无副作用，便于单测）。
 *
 * 发发看买的是「下一手要发的三张牌」，属于付费的私密信息。旧版用
 * broadcastAll 把真实 cards 发给全桌（含围观、上帝视角），别人也能看到牌面。
 * 现在牌面只发给购买者本人（按 userId 判定，同一账号多连接都能看），
 * 其余连接一律只收到「三张牌背」的标记 backs:3 —— 牌背由客户端按各自
 * 本机「桌面设置 → 牌背」素材渲染，互不影响。
 *
 * 关键安全不变量：非购买者的 payload 里绝不能出现真实 cards 字段。
 */
export function peekPayloadFor(connUid, buyerUid, cards, by, cost) {
  const uid = buyerUid == null ? '' : String(buyerUid);
  const mine = !!uid && String(connUid || '') === uid;
  return mine
    ? { t: 'peekNext', cards, by, cost, mine: true }
    : { t: 'peekNext', backs: 3, by, cost, mine: false };
}

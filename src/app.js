import { Game, PHASE } from '../engine/game.js';
import { DECK } from '../engine/cards.js';
import { evaluatePair, comparePair } from '../engine/evaluator.js';
import { decide } from '../engine/ai.js';

const $ = (id) => document.getElementById(id);
const stage = $('stage');

const EMPEROR_NAME = { heaven: '天皇', earth: '地皇' };

/* 钻石单价：镜像 server/price.js，改价时两边一起改。
   开房 10 钻 / 30 分钟（按档向上取整），其余按次 / 按场。改名 10 钻/次。 */
const PRICE = { create: 10, createUnit: 30, next: 2, forceShow: 10, revealAll: 10, peek: 2, scratch: 5, emote: 1, rename: 10, shuffle: 2 };

/* ── v0.20.63：洗牌动画 = sp030.zip 的 xipai02→01→02→01→03 五段连成一整套 ──
   · 素材：img/wash_shuffle.webp，8×11 网格精灵图（82 帧，单帧 387×273，约 0.75MB）。
     由离线 Spine 运行时（pixi-spine + spine-core 3.6）在**同一台固定机位**下渲染，
     五段共用同一个包围盒 → 所有帧同一个锚点，不会出现「两处各播各的」。
   · 牌背：sp030 自带的蓝色皇冠牌背已换成游戏内的紫色「宽窄」牌背，满不透明。
   · 段落：02→01→02→01→03。03 是收尾「聚拢成摞」那段，不接上会像洗到一半就断了。
     03 单帧尺度偏大，整段缩到 0.92（牌长与 01/02 对齐），并把末帧牌堆中心平移到
     02/01 的洗牌位置，整段只用一个位移量，内部动作不变。
   · 播放：playWashFx() 逐帧推进 .wash-sprite 的 background-position（x=列、y=行）。
   · 预加载：脚本加载即 preloadWashSprite() 把图拉进缓存；未就绪先隐藏舞台再等图起播。 */
const WASH_FRAMES = 82;             // 精灵图总帧数（wash_shuffle.webp，8×11）
const WASH_COLS = 8;                // 网格列数（行数 = ceil(82/8) = 11）
const WASH_SPRITE_URL = 'img/wash_shuffle.webp'; // 经典默认：紫色「宽窄」牌背（8×11 网格精灵图）
/* v0.20.72：洗牌动画的牌背跟着「桌面设置 → 牌背」走。
   选了自定义牌背就用对应的换皮精灵图 img/wash_<id>.webp（紫牌面已换成该图案，
   白边/折痕/五段动作原样保留）；选回「经典」用原图。 */
let washSpriteSrc = WASH_SPRITE_URL;
/* 首帧就按本机偏好选图：不然会先预加载经典精灵图（~0.75MB），
   等 applyDeskSkin 跑起来再换掉，白白多下一次。key 与 DESK_LS 一致。 */
try {
  const _b = JSON.parse(localStorage.getItem('dh_desk_skin_v1') || '{}').back;
  if (/^b[1-4]$/.test(_b || '')) washSpriteSrc = `img/wash_${_b}.webp`;
} catch { /* 存储不可用就用默认 */ }
const WASH_FX_MS = 2800;            // 展示窗口时长，与服务端 WASH_FX_MS 保持一致（顺延也用这个值）
let washTimer = null;               // 播放收尾定时器
let washRAF = null;                 // 逐帧推进的 rAF/timeout 句柄
let washSeq = 0;                    // 播放序号：防止上一手残留动画把新一手的层收掉
let washDoneHand = -1;              // 本手已被全桌洗过的 handNo（收到 shuffleFx 记下，按钮立即置灰）
let washImg = null;                 // 预加载的精灵图（避免播放时图还没到 → 先空播、只看到第三段）

/** 预加载洗牌精灵图：脚本加载即调一次，把 ~0.75MB 的 WebP 提前拉进缓存，
 *  这样真正播放时图已在本地，不会出现「先空播、等图到只剩第三段」的现象。 */
function preloadWashSprite() {
  if (washImg) return washImg;
  washImg = new Image();
  washImg.src = washSpriteSrc;
  return washImg;
}
preloadWashSprite();   // 尽早开始下载

/** 预留的换色入口（历史 v0.20.57 纯 CSS 版的 5 色皮肤已随方案替换废弃）：
 *  现动画为固定蓝色菱形牌背的 Spine 素材，本函数保留签名以兼容外部调用，但不再生效。 */
function setWashSkin() { return false; }

/** 播洗牌动画：全桌收到同一条广播时各端各自调用，视觉上同一时刻起播。
 *  逐帧推进 8×11 网格精灵图的背景位置（x=列、y=行），整套 02→01→02→01→03 只播一次。
 *  关键：等精灵图就绪后才显示舞台并起播——否则图未到时会先空播一段，等图到了
 *  动画已接近结束，看起来就「前面闪、只剩后半段」。
 *  素材自带音轨（sp030 是纯 Spine 工程），这里配一声合成的「唰唰」纸牌摩擦声。 */
function playWashFx() {
  const st = $('washStage');
  const sp = $('washSprite');
  if (!st || !sp) return;
  const seq = ++washSeq;
  const img = preloadWashSprite();
  let started = false;
  const begin = () => {
    if (started || seq !== washSeq) return;   // 只起播一次；已被新一次播放/收起则作废
    started = true;
    startWashAudio();                         // v0.20.74：01/02 段「洗牌1」→ 03 段「快速切牌」循环
    sp.style.backgroundImage = "url('" + washSpriteSrc + "')";
    st.classList.remove('on');
    void st.offsetWidth;              // 强制重排，保证连点两下也能从头重播
    st.classList.add('on');
    st.setAttribute('aria-hidden', 'false');
    const stepX = sp.clientWidth || 1;     // 单帧显示宽度（CSS px）
    const stepY = sp.clientHeight || 1;    // 单帧显示高度（CSS px）
    let i = 0;
    const stepMs = 1000 / 30;              // 30fps：与素材原生帧率一致
    const tick = () => {
      if (seq !== washSeq) return;         // 已有更新的一次播放，停掉本循环
      if (i >= WASH_FRAMES) return;        // 只播一次：播到末帧就停，等窗口结束收起
      const col = i % WASH_COLS, row = (i / WASH_COLS) | 0;
      sp.style.backgroundPositionX = (-col * stepX) + 'px';
      sp.style.backgroundPositionY = (-row * stepY) + 'px';
      i++;
      if (i < WASH_FRAMES) washRAF = setTimeout(tick, stepMs);
    };
    clearTimeout(washRAF);
    tick();
    clearTimeout(washTimer);
    washTimer = setTimeout(() => {
      if (seq !== washSeq) return;           // 已有更新的一次播放，别收掉它
      stopWashAudio();                       // v0.20.74：动画收起 → 03 段循环音随停
      clearTimeout(washRAF);
      st.classList.remove('on');
      sp.style.backgroundImage = '';
      sp.style.backgroundPositionX = '0';
      sp.style.backgroundPositionY = '0';
      st.setAttribute('aria-hidden', 'true');
    }, WASH_FX_MS + 120);
  };
  clearTimeout(washTimer);
  if (img.complete && img.naturalWidth > 0) {
    begin();                                  // 已缓存：立即起播
  } else {
    // 图还没到：先不显示舞台，等 load 再起播（避免空播一截 → 「前面闪」）
    const onLoad = () => { img.removeEventListener('load', onLoad); begin(); };
    img.addEventListener('load', onLoad);
    washTimer = setTimeout(begin, 6000);      // 兜底：最多等 6s，防止极端情况卡住
  }
}
function stopWashFx() {
  stopWashAudio();                         // v0.20.74：被打断（换手等）也要掐掉循环音
  clearTimeout(washTimer);
  clearTimeout(washRAF);
  washSeq++;
  const st = $('washStage');
  const sp = $('washSprite');
  if (st) { st.classList.remove('on'); st.setAttribute('aria-hidden', 'true'); }
  if (sp) { sp.style.backgroundImage = ''; sp.style.backgroundPositionX = '0'; sp.style.backgroundPositionY = '0'; }
}

/**
 * v0.22.59：中央结算期三按钮（洗牌 / 发发看 / 强制秀牌）统一显隐判据。
 * 之前散在 paintWashFab / paintFfk / render 的 forceReveal 与 actionStack 四处，
 * 条件各写一份、口径容易走偏；这里汇总成唯一判据，四处共用：
 *   · 只在「本手结算停留期、房间未结束」出现；围观不显示；
 *   · 全场停牌（可行动人数不足 2，暂停发牌·等人）→ 所有玩家都隐藏；
 *   · 个人停牌（筹码耗尽留座 / 未带入留座 / 保位离桌 / 离座 / 站起围观）→ 该玩家隐藏；
 *   · 桌上只剩一个在局玩家（其余全弃牌、一人收池）→ 整组收起（v0.22.36 既有行为）。
 * 各按钮自身独有的条件（钻石够不够、本手洗过没、本手在局没秀过…）仍在各自函数里叠加。
 */
function actionStackHidden(v) {
  if (!v || v.phase !== PHASE.SETTLED || v.ended) return true;
  if (v.viewerSeat < 0) return true;
  // 全场停牌：暂停发牌·等人，整桌都没有下一手，三个按钮对所有人收起
  if (v.dealHold || (v.actableCount != null && v.actableCount < 2)) return true;
  const seats = v.seats || [];
  const mine = seats.find((s) => s.seat === v.viewerSeat) || null;
  // 个人停牌：只收起停牌玩家自己的三个按钮，其他在局玩家照常显示
  const meStopped = !!mine && !!(mine.broke || mine.hold || mine.holdLeave || mine.away);
  if (meStopped || v.myHoldLeave || v.myStandUp) return true;
  // 其余全弃牌、只剩一家：没有下一手，整组不显示
  const alive = seats.filter((s) => s.inHand && !s.folded).length;
  return alive <= 1;
}

/** 洗牌按钮：显隐跟随整组统一判据，这里只叠加自身条件（钻石够 / 登录 / 本手洗过没）。 */
function paintWashFab() {
  const b = $('btnWash');
  if (!b) return;
  const v = state.view;
  const offline = net.mode !== 'online';
  const poor = !offline && acct.user && (acct.user.diamonds || 0) < PRICE.shuffle;
  const noLogin = !offline && !acct.user;
  const washed = !offline && v && washDoneHand === v.handNo;   // 本手已洗过：置灰，避免白点
  const off = actionStackHidden(v) || poor || noLogin || washed;
  b.classList.toggle('act-off', off);
  b.disabled = off;
  b.onclick = off ? null : () => {
    if (offline) playWashFx();
    else sendWS({ t: 'shuffle' });
  };
}
const createCost = (min) => {
  const m = Number(min) > 0 ? Number(min) : 60;
  return Math.ceil(m / PRICE.createUnit) * PRICE.create;
};

const PARAMS = new URLSearchParams(location.search);
const AUTO = PARAMS.has('auto');
const STOP_SPLIT = PARAMS.get('stop') === 'split';
const STOP_SETTLED = PARAMS.get('stop') === 'settled';
const NOFOLD = PARAMS.has('nofold'); // 调试：0 号位不弃牌，方便看分牌
const ROOM = PARAMS.get('room');
const LOCAL = PARAMS.has('local') || (AUTO && !ROOM);
const NICK = (PARAMS.get('name') || localStorage.getItem('dh_nick') || '').slice(0, 8);

// 竖屏 750×1200。屏幕方位：0 自己（底），之后从右下起逆时针排一圈
// 0 号位是「自己」那一格：正常对局用自己的手牌区渲染，
// 围观时没有自己，就把这一格当成普通座位摆出来，8 个人才都看得见
// 座位整体放大到 1.2 倍后（.seat 的 scale 1.08），东西两列各向桌心收 25px，
// 给右下角斜插的牌背留出屏幕边距，不然右侧会一直缺一角。
const POS4 = {
  0: { x: 375, y: 1156 },
  1: { x: 640.5, y: 726 },
  2: { x: 375, y: 330 },
  3: { x: 109.5, y: 726 },
};
// 8 人桌：座位放大 1.2 倍后，同一列的上下两家要留出「气泡 + 头像 + 手牌 + 簸簸」的
// 高度（约 288px），所以左右两列各拉成 290 间距，底部两家相应下移。
const POS8 = {
  0: { x: 375, y: 1251 },   // 我：下移 51（2/3 头像）
  1: { x: 640.5, y: 1066 }, // 右下：下移 38（半头像）
  2: { x: 640.5, y: 738 },
  3: { x: 640.5, y: 410 },  // 右上：上移 38
  4: { x: 375, y: 188 },    // 顶家：上移 38
  5: { x: 109.5, y: 410 },  // 左上：上移 38
  6: { x: 109.5, y: 738 },
  7: { x: 109.5, y: 1066 }, // 左下：下移 38
};
const posFor = (n) => (n <= 4 ? POS4 : POS8);
// 牌桌中心：下注数字按「朝这里」的方向贴边
const TABLE_CX = 375;
const TABLE_CY = 700;
// 中央牌靴的坐标：发牌从这里飞出去，收牌也回到这里
const SHOE_X = 375;
const SHOE_Y = 574;

const net = {
  mode: LOCAL ? 'local' : ROOM ? 'online' : 'lobby',
  ws: null,
  seat: -1,
  token: '',
  roomId: ROOM || '',
  name: NICK,
  isOwner: false,
  watching: false,
  god: false,          // 开发者上帝视角：只看牌，不占座位
  tries: 0,
  joinedOnce: false,
  syncMark: 0,     // v0.20.92：收到在线快照的次数，「刷新」用它判断有没有真拉到新数据
  resyncing: false, // v0.20.92：正在就地刷新（这段时间的 joined 不回「已回到座位」）
  syncRetry: 0,
  syncTimer: null,
  // v0.22.89：网络质量监测 —— RTT 探测 + 画面冻结看门狗（弱网补发）
  rtt: { last: 0, avg: 0, max: 0, n: 0, repAt: 0 },   // last/avg 毫秒；repAt=上次 [RTT] 上报时间
  lastStateAt: 0,      // 最近一次收到 state 快照的时刻
  lastSyncReq: 0,      // 最近一次向服务端讨要快照（sync）的时刻
  watchTimer: null,
};

const state = {
  nextTimer: null,
  raiseMode: false,
  raiseValue: 0,
  headPicked: [],
  splitStep: 0, // 0 选头 / 1 已定头待确认
  splitSent: false,   // 分牌已提交：确认键按灭，等其他人
  splitRetry: null,
  game: null,
  view: null,
  // v0.22.60：房主在房间外看到待审申请、点进房间后自动把审核面板摆出来。
  // reqAutoOpen 只在 enterRoom 置位一次；lastAutoReqSig 保证同一批申请不重复弹。
  reqAutoOpen: false,
  lastAutoReqSig: '',
  sound: true,
  timer: null,
  seen: new Set(),
  emoteHit: new Map(),   // 座位 → 表情砸中的截止时刻（头像抖一下）
  endedShown: false,
  endTimer: null,      // 结束弹窗 10 秒自动关房的倒计时
  remainBase: null,
  busy: false,
  lobbyPage: 'home',   // home / create / join / wait
  turnKey: '',         // 当前读秒属主（handNo:round:seat:startAt）
  turnSince: 0,        // 本机时钟下的读秒起点
  scratchHoldUntil: 0, // 搓牌期间自己的行动读秒冻结到这一刻（0 = 正常走）
  scratchTurnLeft: null, // 单机：开搓那一刻剩下的行动秒数
  localTurnSeat: -1,   // 单机：自己记的行动座位
  localTurnAt: 0,
  localExtMs: 0,       // 单机：本段行动已加时的毫秒
  localExtUses: 0,     // 单机：本手已加时次数
  localExtHand: -1,    // 单机：加时次数所属的手数（换手清零）
  prevExtMs: null,     // 上一帧的加时毫秒（变化时弹全桌提示）
  prevExtUses: null,   // 上一帧的加时次数表（找是谁加的时）
  statsSnap: null,     // 战绩面板打开那一刻拍下的帧（之后牌局再变也不改）
  statsPainted: false, // 这一帧是否已经画过，避免推送来了反复重绘
  lastSettled: null,   // 最近一次「本手结算」时的战绩底稿
  sweptHand: null,     // 摊牌已经收走（飞回牌心）的那一手：重渲染时不再把牌摆回来
  // v0.22.78：乐观反馈——点击后立刻给「已提交」提示，不等服务端回包。
  // 只作为叠加显示层，绝不写进 state.view（权威快照仍由服务端回包接管）。
  // 结构：{ action, handNo, seat, at }
  opt: null,
  optTimer: null,      // 兜底：超时撤销乐观提示，避免误显示
};

/* ── 音效 ─────────────────────────────────── */
let ac = null;
// 手机浏览器要等第一次触摸才允许出声：点哪儿都顺手把它解锁
['pointerdown', 'touchstart', 'keydown'].forEach((evt) => {
  document.addEventListener(evt, () => {
    try { if (ac && ac.state === 'suspended') ac.resume(); } catch { /* 忽略 */ }
  }, { passive: true });
});
function acGet() {
  if (!ac) {
    ac = new (window.AudioContext || window.webkitAudioContext)();
    setTimeout(() => { try { loadSfx(); } catch { /* 忽略 */ } }, 0);
  }
  if (ac.state === 'suspended') ac.resume();
  return ac;
}

/* v0.22.97：微信悬浮窗/分屏会抢走音频焦点，安卓 WebView 顺势把 AudioContext 挂起，
 * 且不会自动恢复——只有点屏幕才解锁（touch 兜底），挂着悬浮窗看牌根本没得点，
 * 表现为音效时有时无、只有杀进程才恢复。加音频看门狗：每 2 秒检查一次，
 * 挂起就主动 resume；回前台 / 窗口重新聚焦也立即恢复（语音通道一并处理）。 */
function acWakeAll() {
  try { if (ac && ac.state !== 'running') ac.resume(); } catch { /* 忽略 */ }
  try {
    if (typeof voiceCtx !== 'undefined' && voiceCtx && voiceCtx.state !== 'running') {
      const r = voiceCtx.resume();
      if (r && r.catch) r.catch(() => {});
    }
  } catch { /* 忽略 */ }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) acWakeAll(); }, { passive: true });
window.addEventListener('focus', acWakeAll);
window.addEventListener('pageshow', acWakeAll);
setInterval(acWakeAll, 2000);

/* ── 采样音效 ──────────────────────────────────
 * 跟注 / 休 / 敲 / 发牌 / 收池 全部用录音里的原声，
 * 合成音只在采样还没解码好时兜底，保证第一声不会哑。 */
// 分享网关要求每个请求都带 sharecode，相对路径不会自动继承，这里补上
const SC_Q = window.__SC_Q__ || '';
const SFX_SRC = {
  bet: 'sfx/bet.mp3' + SC_Q,          // 金币落台：下注 / 跟注 / 敲 / 发牌 / 收牌
  fold: 'sfx/fold.mp3' + SC_Q,        // 丢牌：牌甩出去那一下「咻」
  pass: 'sfx/pass.mp3' + SC_Q,        // 休：短促轻响
  /* v0.22.57：收拢音——金币归进芒果池那一下「哗」（参考游戏同款，0.48s WAV） */
  sweep: 'sfx/sweep.mp3' + SC_Q,
  /* v0.20.74：6 段真实扑克录音（44.1kHz/16bit 单声道 WAV，时长精确到采样点）。
     每个原始文件都把同一动作录了十几遍，这里只取中间最干净的一遍，按动画时长裁好，
     生成脚本见 tools/gen_sfx_clips.py。WAV 而非 MP3：无编码器延迟，短音效时序才准。 */
  scratchEnd:   'sfx/scratch_end.mp3' + SC_Q,          // 大牌背翻开 / 0.80s
  card3:        'sfx/card3.mp3' + SC_Q,                // 第三张明牌发出 / 0.20s
  card4:        'sfx/card4.mp3' + SC_Q,                // 第四张明牌翻开 / 0.30s
  cutFast:      'sfx/cut_fast.mp3' + SC_Q,             // 洗牌动画 03 段循环源 / 1.20s
  shuffleAfter: 'sfx/shuffle_after_sweep.mp3' + SC_Q,  // 收牌后洗牌 / 2.00s
  shuffle1:     'sfx/shuffle1.mp3' + SC_Q,             // 洗牌动画 01/02 段 / 2.13s
};
/* 事件 → 采样。三条老 mp3：金币声、丢牌「咻」、休。
   原来的收牌/洗牌那条是录音里的环境噪音，已整条去掉；v0.20.74 起洗牌改由
   SFX_SRC 里 6 段新 WAV 独立播放，本表只管老三样。要调整只改这张表。 */
const SFX_USE = {
  deal: 'bet',    // 发牌
  sweep: 'bet',   // 收牌 / 收池
  bet: 'bet',     // 跟注 / 加注
  knock: 'bet',   // 敲（推满）
  fold: 'fold',   // 弃牌：咻
  pass: 'pass',   // 休
};
const sfxBuf = {};
const sfxRaw = {};
let sfxLoadPromise = null;
/** 最近一次发声的时刻：全局按钮点击音靠它去重，动作按钮自带音效时不再叠一声 */
let lastSfxAt = 0;

// 页面一打开就把字节拉下来，解码留到有 AudioContext 之后
function preloadSfx() {
  Object.entries(SFX_SRC).forEach(([k, url]) => {
    fetch(url).then((r) => (r.ok ? r.arrayBuffer() : null))
      .then((b) => { if (b) sfxRaw[k] = b; })
      .catch(() => { /* 单条失败就退回合成音 */ });
  });
}

/* v0.22.29：弱网下第一次没拉齐的采样，每 15 秒补拉一次，直到拉齐为止。
 * 之前失败一次就永远缺——表现正是「有的音效有、有的没有，过一会儿又变了」。
 * 音效加起来才 2MB 左右，而且拉齐后就走本地缓存，不再吃带宽。 */
setInterval(() => {
  const miss = Object.keys(SFX_SRC).filter((k) => !sfxRaw[k] && !sfxBuf[k]);
  if (!miss.length) return;
  miss.forEach((k) => {
    fetch(SFX_SRC[k]).then((r) => (r.ok ? r.arrayBuffer() : null))
      .then((b) => { if (b) { sfxRaw[k] = b; try { loadSfx(); } catch { /* 忽略 */ } } })
      .catch(() => { /* 下个周期再试 */ });
  });
}, 15000);

function loadSfx() {
  // v0.22.29：改成可重入——晚到的采样字节（弱网下第一次没拉齐的）也能补解码。
  // 之前 sfxLoadPromise 只跑一次，之后到的字节永远不会被解码，音效就一直缺。
  const run = (async () => {
    const a = acGet();
    await Promise.all(Object.keys(SFX_SRC).map(async (k) => {
      if (sfxBuf[k]) return;
      try {
        const raw = sfxRaw[k] || await (await fetch(SFX_SRC[k])).arrayBuffer();
        sfxBuf[k] = await a.decodeAudioData(raw.slice(0));
      } catch { /* 留空，播放时退回合成音 */ }
    }));
  })();
  sfxLoadPromise = sfxLoadPromise
    ? Promise.all([sfxLoadPromise, run]).then(() => {})
    : run;
  return sfxLoadPromise;
}

/** 播放一条采样；还没就绪返回 false，让调用方走合成音 */
function playSample(kind, { gain = 1, rate = 1, delay = 0 } = {}) {
  if (!state.sound) return false;
  const b = sfxBuf[kind];
  if (!b) { try { loadSfx(); } catch { /* 忽略 */ } return false; }
  try {
    const a = acGet();
    const s = a.createBufferSource();
    s.buffer = b;
    s.playbackRate.value = rate;
    const g = a.createGain();
    g.gain.value = gain;
    s.connect(g);
    g.connect(bus());
    s.start(a.currentTime + delay);
    lastSfxAt = performance.now();
    return true;
  } catch { return false; }
}

/** v0.20.74：带「停止句柄」的采样播放。
 *  跟 playSample 的区别：可 loop 循环，并返回 { stop(fade) } 让动画在结束时把声音掐掉
 *  （洗牌动画 03 段的「快速切牌」要求「随动画停止而停止」，普通 playSample 做不到）。
 *  返回 null 表示采样还没解码好，调用方自行决定要不要回退合成音。 */
function playClip(kind, { gain = 1, rate = 1, delay = 0, loop = false } = {}) {
  if (!state.sound) return null;
  const b = sfxBuf[kind];
  if (!b) { try { loadSfx(); } catch { /* 忽略 */ } return null; }
  try {
    const a = acGet();
    const s = a.createBufferSource();
    s.buffer = b;
    s.loop = loop;
    s.playbackRate.value = rate;
    const g = a.createGain();
    g.gain.value = gain;
    s.connect(g);
    g.connect(bus());
    s.start(a.currentTime + delay);
    lastSfxAt = performance.now();
    let stopped = false;
    return {
      stop(fade = 0.06) {
        if (stopped) return;
        stopped = true;
        try {
          const t = a.currentTime, f = Math.max(0.01, fade);
          g.gain.cancelScheduledValues(t);
          g.gain.setValueAtTime(Math.max(0.0001, g.gain.value), t);
          g.gain.exponentialRampToValueAtTime(0.0001, t + f);
          s.stop(t + f + 0.01);
        } catch { /* 忽略 */ }
      },
    };
  } catch { return null; }
}
function beep(freq = 440, dur = 0.07, type = 'sine', gain = 0.035) {
  if (!state.sound) return;
  lastSfxAt = performance.now();
  try {
    const a = acGet();
    const o = a.createOscillator();
    const g = a.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.setValueAtTime(gain, a.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + dur);
    o.connect(g);
    g.connect(a.destination);
    o.start();
    o.stop(a.currentTime + dur);
  } catch { /* 忽略 */ }
}

/* 纸牌声不用外部音频文件：白噪声过带通 + 极短包络，就是「唰」的一下。
   发牌、洗牌、收牌分别用不同的带通中心频率和脉冲间隔。 */
let noiseBuf = null;
function noiseBuffer() {
  if (noiseBuf) return noiseBuf;
  const a = acGet();
  const len = Math.floor(a.sampleRate * 0.35);
  noiseBuf = a.createBuffer(1, len, a.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  return noiseBuf;
}
let audioBus = null;
/** 统一出口：总音量压到 0.85，再过一道 9k 低通，避免叠加时爆音 */
function bus() {
  const a = acGet();
  if (!audioBus) {
    audioBus = a.createGain();
    audioBus.gain.value = 0.85;
    const lp = a.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 9000;
    lp.Q.value = 0.5;
    audioBus.connect(lp);
    lp.connect(a.destination);
  }
  return audioBus;
}

function burst(t, dur, freq, q, gain, rate = 1, hpFreq = 380) {
  const a = acGet();
  const src = a.createBufferSource();
  src.buffer = noiseBuffer();
  src.playbackRate.value = rate;
  const bp = a.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = freq;
  bp.Q.value = q;
  const hp = a.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = hpFreq;
  const lp = a.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 5200;
  lp.Q.value = 0.4;
  const g = a.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(gain, t + 0.012);      // 慢一点的起音，不刺耳
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(bp); bp.connect(hp); hp.connect(lp); lp.connect(g); g.connect(bus());
  src.start(t, Math.random() * 0.2, dur + 0.02);
}

/** 一个音高从 f0 滑到 f1 的音符 */
function tone(t, f0, f1, dur, gain, type = 'sine', attack = 0.004) {
  const a = acGet();
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur * 0.9);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(gain, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g); g.connect(bus());
  o.start(t); o.stop(t + dur + 0.02);
}

/** 低频「咚」：木桌的回响，给纸牌声加厚度 */
function thump(t, f0, f1, dur, gain) {
  tone(t, f0, f1, dur, gain, 'sine', 0.005);
}

/** 发一张牌：一记闷一点的「啪嗒」——牌面拍在毡面上，不是纸片摩擦 */
function sfxDeal(delay = 0, strong = 1) {
  if (!state.sound) return;
  if (playSample(SFX_USE.deal, { gain: 0.6 * strong, rate: 0.94 + Math.random() * 0.1, delay })) return;
  try {
    const a = acGet();
    const t = a.currentTime + delay;
    burst(t, 0.07, 1100 + Math.random() * 260, 0.8, 0.075 * strong, 0.85, 260);
    burst(t + 0.012, 0.045, 2100 + Math.random() * 300, 0.6, 0.022 * strong, 0.9, 420);
    thump(t, 165, 82, 0.1, 0.07 * strong);
  } catch { /* 忽略 */ }
}

/** 洗牌：一串闷「唰唰」，从慢到快再收尾，不带爆点 */
function sfxShuffle() {
  if (!state.sound) return;
  try {
    const a = acGet();
    let t = a.currentTime + 0.02;
    for (let i = 0; i < 18; i++) {
      const p = i / 18;
      burst(t, 0.04 + Math.random() * 0.02, 1200 + Math.random() * 900,
        0.75, 0.032 + 0.012 * (1 - p), 0.9 + Math.random() * 0.2, 300);
      t += 0.019 + 0.026 * Math.abs(Math.sin(i * 0.7)) + Math.random() * 0.01;
    }
    burst(t + 0.02, 0.09, 900, 0.6, 0.05, 1, 220);
    thump(t + 0.02, 150, 76, 0.11, 0.045);
  } catch { /* 忽略 */ }
}

/** 收牌：几张牌顺着毡面刮回中央 */
function sfxSweep() {
  if (!state.sound) return;
  if (playSample(SFX_USE.sweep, { gain: 0.9 })) return;
  try {
    const a = acGet();
    let t = a.currentTime + 0.02;
    for (let i = 0; i < 5; i++) {
      burst(t, 0.08, 1500 - i * 130, 0.75, 0.045, 0.95, 260);
      t += 0.062;
    }
    thump(t, 145, 74, 0.12, 0.04);
  } catch { /* 忽略 */ }
}

/* ── 搓牌：牌背摩擦 / 翻开 ─────────────────── */

/* ── v0.20.74 真实扑克录音 ────────────────────────────────────────────
 * 6 段素材都由 tools/gen_sfx_clips.py 从「扑克声.zip」里各取中间最干净的一遍裁成，
 * 时长按对应动画对齐（见 更新说明-v0.20.74.md）。统一沿用现有约定：
 * 采样解码好了就播采样，没好就回退到原来的合成音，保证第一手不哑。 */
const WASH_SEG12_FRAMES = 64;                                     // 01/02 段前 64 帧
const WASH_SEG3_MS = Math.round(WASH_SEG12_FRAMES * 1000 / 30);    // ≈2133ms，之后进 03 段
let washClip = null;          // 03 段「快速切牌」循环句柄
let washSegTimer = null;      // 03 段起播定时器
let sweepShuffleClip = null;  // 收牌后洗牌（换手时要收尾）

/** 大牌背翻开：0.80s「搓牌收尾」，峰值对齐牌背滑开那一下 */
function sfxScratchEnd() {
  if (playSample('scratchEnd', { gain: 0.9 })) return;
  sfxFlip();
}
/** 第三张明牌发出：0.20s 一记清脆落牌 */
function sfxCard3(delay = 0) {
  if (playSample('card3', { gain: 0.85, delay })) return;
  sfxDeal(delay, 1);
}
/** 第四张明牌翻开：0.30s 一次完整翻牌 */
function sfxCard4(delay = 0) {
  if (playSample('card4', { gain: 0.85, delay })) return;
  sfxDeal(delay, 1);
}
/** 收牌后洗牌：2.00s 真实录音，替换原来的合成「唰唰」 */
function sfxSweepShuffle() {
  if (sweepShuffleClip) { sweepShuffleClip.stop(0.06); sweepShuffleClip = null; }
  sweepShuffleClip = playClip('shuffleAfter', { gain: 0.9 });
  if (!sweepShuffleClip) sfxShuffle();
}
/** 换手兜底：别让上一手的洗牌声拖到下一手发牌 */
function stopSweepShuffle() {
  if (sweepShuffleClip) { const c = sweepShuffleClip; sweepShuffleClip = null; c.stop(0.12); }
}
/** 洗牌动画分段配音：01/02 段「洗牌1」整段 2.13s 播一次，正好在第 64 帧
 *  （03 段起点）自然收尾并接上「快速切牌」循环；动画一停就掐掉循环。 */
function startWashAudio() {
  stopWashAudio();
  if (!playSample('shuffle1', { gain: 0.9 })) sfxShuffle();   // 01/02 段（未就绪兜底）
  washSegTimer = setTimeout(() => {
    if (!state.sound) return;
    washClip = playClip('cutFast', { gain: 0.85, loop: true }); // 03 段：循环到动画停止
  }, WASH_SEG3_MS);
}
function stopWashAudio() {
  clearTimeout(washSegTimer); washSegTimer = null;
  if (washClip) { const c = washClip; washClip = null; c.stop(0.08); }
}

let rub = null;         // 正在响的摩擦声：{ filter, gain }
let rubBuf = null;

/** 搓牌用的循环噪声：低频起伏的白噪，像纸背蹭过绒面 */
function rubNoise() {
  if (rubBuf) return rubBuf;
  const a = acGet();
  const len = Math.floor(a.sampleRate * 1.2);
  rubBuf = a.createBuffer(1, len, a.sampleRate);
  const d = rubBuf.getChannelData(0);
  for (let i = 0; i < len; i++) {
    const t = i / a.sampleRate;
    d[i] = (Math.random() * 2 - 1) * (0.65 + 0.35 * Math.sin(t * 2 * Math.PI * 3.7));
  }
  return rubBuf;
}

function sfxRubStart() {
  if (!state.sound || rub) return;
  try {
    const a = acGet();
    const src = a.createBufferSource();
    src.buffer = rubNoise();
    src.loop = true;
    const bp = a.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1600;
    bp.Q.value = 0.9;
    const hp = a.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 650;
    const g = a.createGain();
    g.gain.value = 0.0001;
    src.connect(bp); bp.connect(hp); hp.connect(g); g.connect(bus());
    src.start();
    rub = { filter: bp, gain: g };
  } catch { rub = null; }
}

/** level 0–1：拖得越快越响、越尖；freq 控制摩擦的粗细 */
function sfxRub(level, freq = 1600) {
  if (!state.sound) return;
  if (!rub) sfxRubStart();
  if (!rub) return;
  try {
    const a = acGet();
    const t = a.currentTime;
    rub.gain.gain.setTargetAtTime(Math.max(0.0001, 0.022 + 0.075 * Math.min(1, level)), t, 0.05);
    rub.filter.frequency.setTargetAtTime(freq, t, 0.06);
  } catch { /* 忽略 */ }
}

function sfxRubStop() {
  if (!rub) return;
  try {
    const a = acGet();
    rub.gain.gain.setTargetAtTime(0.0001, a.currentTime, 0.05);
  } catch { /* 忽略 */ }
}

/** 翻开：牌面弹出来那一下「唰 + 嗒」 */
function sfxFlip() {
  if (!state.sound) return;
  try {
    const a = acGet();
    const t = a.currentTime + 0.005;
    burst(t, 0.1, 2300, 0.85, 0.052, 1.15, 520);
    burst(t + 0.035, 0.07, 1450, 0.7, 0.03, 1, 340);
    tone(t + 0.01, 470, 880, 0.1, 0.016, 'triangle', 0.005);
    thump(t, 185, 94, 0.09, 0.04);
  } catch { /* 忽略 */ }
}

/* ── 金币 / 电玩 ─────────────────────────────── */

/** 街机投币：短促的两声方波「叮—叮↑」，就是电玩城投币那一下 */
function coinBlip(t, gain = 0.075, base = 988) {
  tone(t, base, base, 0.055, gain, 'square', 0.003);
  tone(t + 0.052, base * 1.335, base * 1.335, 0.14, gain * 0.95, 'square', 0.003);
  // 一点点金属亮片，让它像硬币而不是纯电子音
  burst(t, 0.02, 5600, 1.6, 0.012, 1, 2400);
}

/** 收拢音：金币归进芒果池的「哗」一声（v0.22.57 参考游戏同款采样；没拉齐时退回币声） */
function sfxMangoSweep() {
  if (!state.sound) return;
  if (playSample('sweep', { gain: 0.9 })) return;
  sfxCoin(3);
}

/** 加注 / 跟注：投币音（跟注一枚，加注两三枚） */
function sfxCoin(n = 2) {
  if (!state.sound) return;
  if (playSample(SFX_USE.bet, { gain: n >= 3 ? 0.92 : 0.76, rate: n >= 3 ? 1.04 : 1 })) return;
  try {
    const a = acGet();
    const t0 = a.currentTime + 0.01;
    for (let i = 0; i < Math.min(3, n); i++) coinBlip(t0 + i * 0.062, 0.07);
  } catch { /* 忽略 */ }
}

/** 休：敲木桌两声 */
function sfxKnockTable() {
  if (!state.sound) return;
  if (playSample(SFX_USE.pass, { gain: 0.95 })) return;
  try {
    const a = acGet();
    const t0 = a.currentTime + 0.01;
    [0, 0.16].forEach((d, i) => {
      const t = t0 + d;
      // 木头：一个快速下滑的正弦 + 一小段中频噪声
      thump(t, 190, 96, 0.085, 0.11 - i * 0.012);
      burst(t, 0.03, 620 + Math.random() * 120, 1.8, 0.035, 0.8, 160);
    });
  } catch { /* 忽略 */ }
}

/** 弃牌：牌甩出去那一下「咻」（录音原声，带一点音量抖动，连着弃两张不呆板） */
function sfxFold() {
  if (!state.sound) return;
  if (playSample(SFX_USE.fold, { gain: 0.9, rate: 0.98 + Math.random() * 0.06 })) return;
  try {
    const a = acGet();
    const t = a.currentTime + 0.01;
    const src = a.createBufferSource();
    src.buffer = noiseBuffer();
    const bp = a.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.2;
    bp.frequency.setValueAtTime(2400, t);
    bp.frequency.exponentialRampToValueAtTime(380, t + 0.3);
    const g = a.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.06, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
    src.connect(bp); bp.connect(g); g.connect(bus());
    src.start(t); src.stop(t + 0.34);
  } catch { /* 忽略 */ }
}

/** 敲：电玩城一大把金币洒在台面上，短促、密集 */
function sfxCoinShower() {
  if (!state.sound) return;
  // 敲：把簸簸推满
  if (playSample(SFX_USE.knock, { gain: 1 })) return;
  try {
    const a = acGet();
    const t0 = a.currentTime + 0.01;
    // 底下铺一层「哗」的金属底噪
    for (let i = 0; i < 4; i++) {
      burst(t0 + i * 0.045, 0.09, 2600 + Math.random() * 1800, 0.9, 0.02, 1, 900);
    }
    // 上面撒 9 枚，音高随机、间隔抖动
    for (let i = 0; i < 9; i++) {
      const t = t0 + 0.01 + i * 0.028 + Math.random() * 0.02;
      coinBlip(t, 0.05, 1150 + Math.random() * 900);
    }
    thump(t0 + 0.09, 120, 64, 0.18, 0.045);
  } catch { /* 忽略 */ }
}

/* ── 牌面 ─────────────────────────────────── */
// 花色用 SVG 画，不依赖系统字体，安卓/iOS/模拟器表现一致
const SUIT_SHAPE = {
  H: '<path d="M12 21S4 15.4 4 9.8A4.4 4.4 0 0 1 12 6.8 4.4 4.4 0 0 1 20 9.8C20 15.4 12 21 12 21Z"/>',
  D: '<path d="M12 1.8 21 12l-9 10.2L3 12Z"/>',
  S: '<path d="M12 2S4 8 4 13a4 4 0 0 0 7 2.6c-.3 2-1.2 3.6-2.5 4.4h7c-1.3-.8-2.2-2.4-2.5-4.4A4 4 0 0 0 20 13c0-5-8-11-8-11Z"/>',
  C: '<circle cx="12" cy="7.6" r="4.2"/><circle cx="7.7" cy="13.6" r="4.2"/><circle cx="16.3" cy="13.6" r="4.2"/><rect x="10.8" y="12" width="2.4" height="9" rx="1.2"/>',
};
function suitSvg(suit) {
  const shape = SUIT_SHAPE[suit];
  if (!shape) return '';
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${shape}</svg>`;
}

/* ── 卡通头像：按名字算一次，永远同一张脸，不联网 ───────── */
const AV_SKIN = ['#fadfc4', '#f3c9a4', '#e6b083', '#d2976c', '#bd8058', '#a46a45'];
const AV_HAIR = ['#221a16', '#3c2a1f', '#5c3d28', '#171211', '#6f4726', '#312238'];
const AV_WEAR = ['#2f6b53', '#33567d', '#7a3b34', '#54487a', '#2f6270', '#6b552a'];
const AV_BG = ['#efe6d6', '#e4ece6', '#eae2ef', '#f0e7dc', '#e2eaf2', '#f1e9e1'];

function hashName(s) {
  let h = 2166136261;
  const str = String(s || '玩家');
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

/** 生成一个 100x100 的 Q 版头像；同一个名字永远是同一张脸 */
function avatarSvg(name) {
  const h = hashName(name);
  const skin = AV_SKIN[h % 6];
  const hair = AV_HAIR[(h >> 4) % 6];
  const wear = AV_WEAR[(h >> 8) % 6];
  const bg = AV_BG[(h >> 11) % 6];
  const cut = (h >> 12) % 6;
  const mood = (h >> 16) % 4;
  const acc = (h >> 20) % 5;
  const ink = '#241c19';

  let hairPart = '';
  if (cut === 0) {
    hairPart = `<path d="M25 45Q25 19 50 19Q75 19 75 45Q72 31 50 31Q28 31 25 45Z" fill="${hair}"/>`;
  } else if (cut === 1) {
    hairPart = `<path d="M25 46Q24 18 50 18Q76 18 75 46Q72 30 50 31Q28 30 25 46Z" fill="${hair}"/>
      <path d="M50 20Q47 26 50 32" stroke="rgba(0,0,0,.28)" stroke-width="1.6" fill="none"/>`;
  } else if (cut === 2) {
    hairPart = `<path d="M25 45Q25 19 50 19Q75 19 75 45Q72 31 50 31Q28 31 25 45Z" fill="${hair}"/>
      <circle cx="50" cy="13" r="9" fill="${hair}"/>
      <circle cx="50" cy="21" r="2.6" fill="${wear}"/>`;
  } else if (cut === 3) {
    hairPart = `<path d="M26 42Q26 17 50 17Q74 17 74 42Z" fill="${wear}"/>
      <rect x="20" y="39" width="60" height="7" rx="3.5" fill="${wear}" opacity=".82"/>
      <rect x="20" y="43" width="60" height="3" rx="1.5" fill="rgba(0,0,0,.24)"/>
      <circle cx="50" cy="27" r="3.2" fill="${bg}"/>`;
  } else if (cut === 4) {
    hairPart = `<path d="M27 44Q29 25 50 25Q71 25 73 44Q68 33 50 33Q32 33 27 44Z" fill="${hair}"/>`;
  } else {
    hairPart = `<path d="M25 45Q25 19 50 19Q75 19 75 45Q72 31 50 31Q28 31 25 45Z" fill="${hair}"/>
      <path d="M24 44Q21 72 27 80L36 76Q29 60 31 44Z" fill="${hair}"/>
      <path d="M76 44Q79 72 73 80L64 76Q71 60 69 44Z" fill="${hair}"/>`;
  }

  let eyes = '';
  if (mood === 0) {
    eyes = `<circle cx="41" cy="48" r="3.7" fill="${ink}"/><circle cx="59" cy="48" r="3.7" fill="${ink}"/>`;
  } else if (mood === 1) {
    eyes = `<path d="M36.5 49.5Q41 44 45.5 49.5" stroke="${ink}" stroke-width="2.8" fill="none" stroke-linecap="round"/>
      <path d="M54.5 49.5Q59 44 63.5 49.5" stroke="${ink}" stroke-width="2.8" fill="none" stroke-linecap="round"/>`;
  } else if (mood === 2) {
    eyes = `<circle cx="41" cy="48" r="4.6" fill="${ink}"/><circle cx="59" cy="48" r="4.6" fill="${ink}"/>
      <circle cx="42.6" cy="46.4" r="1.5" fill="#fff"/><circle cx="60.6" cy="46.4" r="1.5" fill="#fff"/>`;
  } else {
    eyes = `<path d="M36.5 48H45.5" stroke="${ink}" stroke-width="2.8" stroke-linecap="round"/>
      <path d="M54.5 48H63.5" stroke="${ink}" stroke-width="2.8" stroke-linecap="round"/>`;
  }

  let mouth = '';
  if (mood === 0) {
    mouth = `<path d="M44 60Q50 65 56 60" stroke="${ink}" stroke-width="2.4" fill="none" stroke-linecap="round"/>`;
  } else if (mood === 1) {
    mouth = `<path d="M43 58.5Q50 68 57 58.5Z" fill="#b3544a"/>`;
  } else if (mood === 2) {
    mouth = `<circle cx="50" cy="61" r="3.2" fill="#b3544a"/>`;
  } else {
    mouth = `<path d="M44 61H56" stroke="${ink}" stroke-width="2.4" stroke-linecap="round"/>`;
  }

  let extra = '';
  if (acc === 1) {
    extra = `<circle cx="41" cy="48" r="8.4" stroke="#2b2b2b" stroke-width="2" fill="none"/>
      <circle cx="59" cy="48" r="8.4" stroke="#2b2b2b" stroke-width="2" fill="none"/>
      <path d="M49.4 48H50.6" stroke="#2b2b2b" stroke-width="2"/>`;
  } else if (acc === 2) {
    extra = `<path d="M41 57.5Q46 54.5 50 57.5Q54 54.5 59 57.5" stroke="${hair}" stroke-width="3.4"
      fill="none" stroke-linecap="round"/>`;
  } else if (acc === 3) {
    extra = `<circle cx="27" cy="57" r="2.6" fill="#e3bd7a"/><circle cx="73" cy="57" r="2.6" fill="#e3bd7a"/>`;
  } else if (acc === 4) {
    extra = `<rect x="25" y="31" width="50" height="5.6" rx="2.8" fill="#c94f42"/>`;
  }

  return `<svg viewBox="0 0 100 100" aria-hidden="true" preserveAspectRatio="xMidYMid slice">
    <rect width="100" height="100" fill="${bg}"/>
    <path d="M8 100Q10 74 50 74Q90 74 92 100Z" fill="${wear}"/>
    <rect x="42" y="62" width="16" height="14" rx="7" fill="${skin}"/>
    <rect x="42" y="62" width="16" height="7" rx="3.5" fill="rgba(0,0,0,.10)"/>
    <circle cx="26" cy="49" r="6" fill="${skin}"/><circle cx="74" cy="49" r="6" fill="${skin}"/>
    <ellipse cx="50" cy="47" rx="24" ry="26" fill="${skin}"/>
    ${hairPart}
    <path d="M34 40.5Q38 38 42 39.6" stroke="${hair}" stroke-width="2.2" fill="none" stroke-linecap="round"/>
    <path d="M58 39.6Q62 38 66 40.5" stroke="${hair}" stroke-width="2.2" fill="none" stroke-linecap="round"/>
    ${eyes}
    <ellipse cx="32.5" cy="56" rx="5" ry="3.2" fill="#e8836f" opacity=".3"/>
    <ellipse cx="67.5" cy="56" rx="5" ry="3.2" fill="#e8836f" opacity=".3"/>
    ${mouth}
    ${extra}
  </svg>`;
}

/** 头像 DOM：座位、托盘、战绩表共用；传了头像地址就显示上传的图片，否则用系统脸
 *  data-ava / data-n 供全局 error 兜底：图挂了就退回系统脸，别留白框 */
function avatarEl(name, cls = '', avatar = '') {
  const d = document.createElement('div');
  d.className = 'avatar' + (cls ? ' ' + cls : '');
  d.innerHTML = avatar
    ? `<img src="${avaSrc(avatar)}" alt="" referrerpolicy="no-referrer" data-ava="1" data-n="${esc(name)}">`
    : avatarSvg(name);
  return d;
}

/** 自己的头像：登录账号上传过就用图片，没上传就用系统脸 */
function myAvatarHTML(name) {
  return acct.user && acct.user.avatar
    ? `<img src="${avaSrc(acct.user.avatar)}" alt="" referrerpolicy="no-referrer" data-ava="1" data-n="${esc(name)}">`
    : avatarSvg(name);
}

function cardEl(card, { small = false, dim = false, micro = false, flip = false } = {}) {
  const el = document.createElement('div');
  el.className = 'card';
  if (micro) el.classList.add('tiny');
  else if (small) el.classList.add('small');
  if (!card) {
    el.classList.add('back');
    return el;
  }
  if (dim) el.classList.add('dim');
  if (card.id === 'BJ') {
    el.classList.add('joker');
    el.innerHTML = '<span class="corner jk"><b>J</b><b>O</b><b>K</b><b>E</b><b>R</b></span><span class="pip jk">🃏</span>';
  } else {
    el.classList.add(card.color === 'red' ? 'red' : 'black');
    el.innerHTML =
      `<span class="corner">${card.label}<i>${suitSvg(card.suit)}</i></span>` +
      `<span class="pip">${suitSvg(card.suit)}</span>`;
  }
  if (flip) {
    // 第三、四张：牌背在背面，绕中轴翻 180° 换成牌面（见 wrapFlip）
    el.classList.add('flip');
    wrapFlip(el, makeFlipBack());
  }
  return el;
}

/* ── 搓牌大牌：传统扑克牌面 ─────────────────────
 * 左右两个角标（右下那个倒过来），牌心按点数摆花色：
 * 上半场正着、下半场倒着，和真牌一样。
 * J / Q / 大王不画线稿，直接贴美术图（web/img/court-*.webp），
 * 图上自带角标，所以不再叠 HTML 的 corner，免得重影。
 */
const TRAD_PIPS = {
  2: [[50, 17], [50, 83, 1]],
  3: [[50, 17], [50, 50], [50, 83, 1]],
  4: [[30, 17], [70, 17], [30, 83, 1], [70, 83, 1]],
  5: [[30, 17], [70, 17], [50, 50], [30, 83, 1], [70, 83, 1]],
  6: [[30, 17], [70, 17], [30, 50], [70, 50], [30, 83, 1], [70, 83, 1]],
  7: [[30, 17], [70, 17], [50, 32], [30, 50], [70, 50], [30, 83, 1], [70, 83, 1]],
  8: [[30, 17], [70, 17], [50, 32], [30, 50], [70, 50], [50, 68, 1], [30, 83, 1], [70, 83, 1]],
  9: [[30, 16.5], [70, 16.5], [30, 39], [70, 39], [50, 50],
    [30, 61, 1], [70, 61, 1], [30, 83.5, 1], [70, 83.5, 1]],
  10: [[30, 16.5], [70, 16.5], [30, 33.5], [70, 33.5], [30, 50], [70, 50],
    [30, 66.5, 1], [70, 66.5, 1], [30, 83.5, 1], [70, 83.5, 1]],
};

/* 搓牌人像牌 / 大王 → 美术图。小牌（手牌、牌背、回顾、掉落）仍然走 cardEl，不受影响 */
const COURT_ART = {
  SJ: 'img/court-SJ.webp',   // ♠J
  CJ: 'img/court-CJ.webp',   // ♣J
  DQ: 'img/court-DQ.webp',   // ♦Q
  HQ: 'img/court-HQ.webp',   // ♥Q
  BJ: 'img/court-BJ.webp',   // 大王
};

/** 图片同样要带分享码，不然线上 403 */
function courtArtSrc(card) {
  const p = COURT_ART[card.id];
  return p ? avaSrc(p) : '';
}

/** 开搓前先读进内存，免得翻开那一下空白一下 */
function preloadCourtArt() {
  Object.values(COURT_ART).forEach((p) => { const im = new Image(); im.src = avaSrc(p); });
}

function scratchFaceHtml(card) {
  const art = courtArtSrc(card);
  // 图上自带角标，翻开时直接铺满，不再叠 HTML 角标（叠了会重影）。
  // 搓牌没结束时不能整张糊掉（人像跟着糊成一片）：只在左上、右下盖两块遮罩，
  // 把字母和小花色挡住，牌心的人像保持清晰 —— 跟普通牌「只糊角标」是一个意思。
  if (art) {
    const jk = card.id === 'BJ' ? ' joker' : '';
    return `<img class="court-art" src="${art}" alt="" draggable="false">`
      + `<span class="ca-mask tl${jk}" aria-hidden="true"></span>`
      + `<span class="ca-mask br${jk}" aria-hidden="true"></span>`;
  }
  const label = String(card.label);
  const suit = suitSvg(card.suit);
  // 角标里的点数是 .rk：搓牌没结束时只把这一层糊掉，花色留着
  const corner = (cls) => `<span class="corner ${cls}"><span class="rk">${label}</span><i>${suit}</i></span>`;
  let body;
  if (label === 'A') {
    body = `<span class="pips ace"><i style="left:50%;top:50%">${suit}</i></span>`;
  } else {
    const pips = (TRAD_PIPS[label] || [])
      .map(([x, y, flip]) => `<i class="${flip ? 'flip' : ''}" style="left:${x}%;top:${y}%">${suit}</i>`)
      .join('');
    body = `<span class="pips p${label}">${pips}</span>`;
  }
  return corner('tl') + body + corner('br');
}

/* ── 视图工具 ─────────────────────────────── */
function mySeat() {
  return state.view ? state.view.viewerSeat : 0;
}
/** 把真实座位号映射到屏幕方位（围观时以 0 号位为准，桌面上不会缺一格） */
function disp(seat) {
  const n = state.view ? state.view.seats.length : 4;
  const base = Math.max(0, mySeat());
  return ((seat - base) % n + n) % n;
}
/** 是不是在边上围观（没坐下） */
function watching() {
  return !!state.view && state.view.viewerSeat < 0;
}
function me() {
  return state.view ? state.view.seats.find((s) => s.seat === mySeat()) : null;
}

/* v0.22.68：这一刻能不能退出房间。
   正常进行牌局（自己坐着且这一手还持牌 / 牌局在 BET、SPLIT 阶段）时不允许退，
   必须先「站起围观」或「保位离桌」把自己从这一手摘出来，退出按钮才亮。
   结算阶段、围观席、已起立、已保位、未入局、单机 —— 都可以退。 */
function canLeaveNow() {
  if (net.mode !== 'online') return true;          // 单机练习随时可退
  const v = state.view;
  if (!v || v.ended) return true;                  // 还没进房 / 牌桌已结束
  if (watching()) return true;                     // 已经在围观席＝已起立
  if (v.myStandUp || v.myHoldLeave) return true;  // 已点站起 / 保位（等结算生效也算亮）
  const m = me();
  if (!m || !m.inHand) return true;                // 没坐下 / 这一手没我的牌
  // 坐下了、这一手还持牌：BET / SPLIT 阶段锁住；结算窗口放行
  return !(v.phase === PHASE.BET || v.phase === PHASE.SPLIT);
}

function refresh() {
  if (net.mode === 'local' && state.game) {
    const g = state.game;
    state.view = g.snapshotFor(0);
    // 单机练习没有服务端计时，这里自己记行动起点，倒计时和托管都靠它
    const seat = g.phase === PHASE.BET ? g.currentSeat : -1;
    if (g.handNo !== state.localExtHand) {
      state.localExtHand = g.handNo;
      state.localExtUses = 0;            // 换手：加时次数清零
    }
    if (seat !== state.localTurnSeat) {
      state.localTurnSeat = seat;
      state.localTurnAt = seat >= 0 ? Date.now() : 0;
      state.localExtMs = 0;              // 换人：本段加的 30s 作废
    }
    state.view.turnAt = state.localTurnAt || 0;
    state.view.turnExtMs = state.localExtMs || 0;
    state.view.extUses = state.localExtUses ? { 0: state.localExtUses } : {};
    state.view.turnLeft = state.localTurnAt
      ? Math.max(0, TURN_SECONDS + state.localExtMs / 1000 - Math.floor((Date.now() - state.localTurnAt) / 1000))
      : 0;
  }
  render();
}

/* ── 筹码耗尽：留座读秒 180 秒 ─────────────── */
const BROKE_SECONDS = 180;
const SIT_HOLD_SECONDS = 15;   // v0.22.88：等待室「占座」倒计时（没点带入只给 15 秒）
const SPLIT_SECONDS = 20;
const TURN_SECONDS = 15;   // 每轮行动读秒：到点系统按「上家动作」托管

function leftSince(since, total = BROKE_SECONDS) {
  return Math.max(0, total - Math.floor((Date.now() - since) / 1000));
}
function brokeLeft(since) {
  return leftSince(since, BROKE_SECONDS);
}

function ringHtml(since, total = BROKE_SECONDS, tone = '') {
  const left = leftSince(since, total);
  const k = left / total;
  const C = 2 * Math.PI * 45;
  return `<svg class="ring" viewBox="0 0 100 100" aria-hidden="true">
      <circle class="track" cx="50" cy="50" r="45"/>
      <circle class="fill" cx="50" cy="50" r="45"
        stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${(C * (1 - k)).toFixed(1)}"/>
    </svg>
    <span class="cd${tone ? ' ' + tone : ''}" data-since="${since}" data-total="${total}">${fmtCd(left, total)}</span>`;
}

function ringEl(since, total = BROKE_SECONDS, tone = '') {
  const wrap = document.createElement('span');
  wrap.className = 'ring-wrap';
  wrap.dataset.since = since;
  if (tone) wrap.dataset.tone = tone;   // 分牌环要能被「搓牌冻结」找到
  wrap.innerHTML = ringHtml(since, total, tone);
  return wrap;
}

/** 行动读秒：头像外圈走绿条，头像正中显示还剩几秒（最后 5 秒转红闪） */
function turnTotalSec() {
  return TURN_SECONDS + Math.round((((state.view || {}).turnExtMs) || 0) / 1000);
}
function turnClockHtml(since) {
  const total = turnTotalSec();
  const C = 2 * Math.PI * 45;
  const left = leftSince(since, total);
  return `<span class="turn-clock" data-since="${since}" data-total="${total}">
      <svg class="tc-ring" viewBox="0 0 100 100" aria-hidden="true">
        <circle class="track" cx="50" cy="50" r="45"/>
        <circle class="fill" cx="50" cy="50" r="45"
          stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${(C * (1 - left / total)).toFixed(1)}"/>
      </svg>
      <b>${left}</b>
    </span>`;
}

function turnClockEl(since) {
  const total = turnTotalSec();
  const wrap = document.createElement('span');
  wrap.className = 'turn-clock';
  wrap.dataset.since = since;
  wrap.dataset.total = total;
  const C = 2 * Math.PI * 45;
  const left = leftSince(since, total);
  wrap.innerHTML = `<svg class="tc-ring" viewBox="0 0 100 100" aria-hidden="true">
        <circle class="track" cx="50" cy="50" r="45"/>
        <circle class="fill" cx="50" cy="50" r="45"
          stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${(C * (1 - left / total)).toFixed(1)}"/>
      </svg>
      <b>${left}</b>`;
  return wrap;
}

function fmtCd(left, total = 600) {
  if (total <= 60) return String(left);   // 15 秒倒计时只显示秒数
  const m = Math.floor(left / 60);
  const s2 = left % 60;
  return `${String(m).padStart(2, '0')}:${String(s2).padStart(2, '0')}`;
}

/** 每秒刷一次读秒，不动整体渲染 */
function tickCountdown() {
  // 有人在搓牌：整桌分牌读秒一起冻住（服务端同样把分牌起点往后推，剩余秒数不变）
  const anyScratch = (state.scratchHoldUntil || 0) > Date.now()
    || (!!state.view && (state.view.seats || []).some((s) => (s.scratchLeft || 0) > 0));
  if (anyScratch && state.splitSince) {
    state.splitSince += 1000;
    document.querySelectorAll('.ring-wrap[data-tone="split"], .cd.split').forEach((el) => {
      el.dataset.since = String((Number(el.dataset.since) || Date.now()) + 1000);
    });
  }
  // 分牌倒计时条：数字和进度条每秒走一格
  const shud = document.getElementById('splitHud');
  if (shud && !shud.classList.contains('hidden') && state.splitSince) {
    const left = Math.max(0, SPLIT_SECONDS
      - Math.floor((Date.now() - state.splitSince) / 1000));
    const b = shud.querySelector('#shLeft');
    if (b) b.textContent = left;
    const fill = shud.querySelector('#shFill');
    if (fill) fill.style.setProperty('--p', `${Math.max(0, Math.min(100, (left / SPLIT_SECONDS) * 100))}%`);
  }
  const C = 2 * Math.PI * 45;
  document.querySelectorAll('.cd[data-since]').forEach((el) => {
    const since = Number(el.dataset.since) || Date.now();
    const total = Number(el.dataset.total) || BROKE_SECONDS;
    const left = leftSince(since, total);
    el.textContent = fmtCd(left, total);
    el.classList.toggle('over', left <= 0);
    const svg = el.parentElement.querySelector('.ring .fill');
    if (svg) svg.setAttribute('stroke-dashoffset', (C * (1 - left / total)).toFixed(1));
    const wrap = el.closest('.seat, .my-info');
    if (wrap) wrap.classList.toggle('cd-over', left <= 0);
  });
  // 留座 / 保位读秒：座位节点复用后不会每秒重建，文字在这里自己走
  document.querySelectorAll('.seat .tag.join[data-cd]').forEach((el) => {
    const since = Number(el.dataset.since) || 0;
    if (!since) return;
    // v0.22.88：占座 15 秒 / 留座 180 秒，档位随节点自带，别写死 180
    const total = Number(el.dataset.total) || BROKE_SECONDS;
    const left = leftSince(since, total);
    el.textContent = `${el.dataset.cd === 'hold' ? '保位' : (el.dataset.label || '留座')} ${left}s`;
  });
  // 行动读秒：绿环走到 0，最后 5 秒转红闪
  const frozen = (state.scratchHoldUntil || 0) > Date.now();
  document.querySelectorAll('.turn-clock[data-since]').forEach((el) => {
    if (frozen) {
      // 搓牌期间自己那颗读秒停住（服务端也是搓完接着算）
      const seatEl = el.closest('.seat');
      if (!seatEl || Number(seatEl.dataset.seat) === mySeat()) return;
    }
    const since = Number(el.dataset.since) || Date.now();
    const total = Number(el.dataset.total) || TURN_SECONDS;
    const left = leftSince(since, total);
    const num = el.querySelector('b');
    if (num) num.textContent = left;
    const fill = el.querySelector('.fill');
    if (fill) fill.setAttribute('stroke-dashoffset', (C * (1 - left / total)).toFixed(1));
    el.classList.toggle('warn', left <= 5);
  });
}
setInterval(() => {
  tickCountdown();
  if (net.mode !== 'local' || !state.game) return;
  // 读秒归零当场离座；机器人离座后补新面孔
  const away = state.game.expireBroke();
  const filled = fillEmptySeats();
  if (away || filled) refresh();

  // 单机：自己 15 秒不说话，按「上家动作」自动托管（和线上同一套规则）
  const g = state.game;
  // 单机：搓牌期间把自己的行动读秒冻在「开搓那一刻还剩几秒」，搓完接着走
  if (state.scratchHoldUntil > Date.now() && state.localTurnAt) {
    if (state.scratchTurnLeft == null) {
      state.scratchTurnLeft = Math.max(0,
        turnTotalSec() - Math.floor((Date.now() - state.localTurnAt) / 1000));
    }
    state.localTurnAt = Date.now() - (turnTotalSec() - state.scratchTurnLeft) * 1000;
  } else if (state.scratchTurnLeft != null) {
    state.scratchTurnLeft = null;
  }

  // 单机：搓牌期间分牌读秒一起冻住，引擎的分牌起点跟着时间走，剩余秒数不变
  if (state.scratchHoldUntil > Date.now() && g.phase === PHASE.SPLIT && g.splitAt) {
    g.splitAt += 1000;
  }

  // 单机：分牌倒计时到 0 还没手动确定，就按「最大牌力那组做头」自动分牌
  if (!AUTO && g.phase === PHASE.SPLIT && state.splitSince
    && Date.now() - state.splitSince >= SPLIT_SECONDS * 1000) {
    const pend = g.aliveSeats().filter((x) => !g.seats[x].split);
    let done = false;
    for (const x of pend) {
      const p = g.seats[x];
      if (!p.splitOptions || p.split) continue;
      const best = p.splitOptions.reduce((a, b) => (b.score > a.score ? b : a), p.splitOptions[0]);
      try {
        g.chooseSplit(x, p.splitOptions.indexOf(best));
        done = true;
      } catch { /* 已经结算了 */ }
    }
    if (done) { refresh(); drive(); }
  }

  if (!AUTO && g.phase === PHASE.BET && g.currentSeat >= 0
    && !g.seats[g.currentSeat].isAI
    && state.localTurnAt && Date.now() - state.localTurnAt >= TURN_SECONDS * 1000 + (state.localExtMs || 0)) {
    try { g.autoAct(g.currentSeat); } catch { /* 忽略 */ }
    refresh();
    drive();
  }
}, 1000);

/** 本手作废的横幅：全员休，或别人全弃、最后一家本轮没下注（都按休芒滚池） */
function showVoidBanner(v) {
  let el = $('voidBanner');
  const on = v.phase === PHASE.SETTLED && v.result && v.result.void;
  if (!on) { if (el) el.remove(); return; }
  if (!el) {
    el = document.createElement('div');
    el.id = 'voidBanner';
    el.className = 'void-banner';
    stage.appendChild(el);
  }
  const r = v.result || {};
  const title = r.voidReason === 'fold' ? '全桌弃牌' : '全员休';
  el.innerHTML = `<b>${title}</b>`;
}

/* ── 金币特效：跟每个座位联动 ─────────────── */
let capRaf = 0;

function stagePoint(el) {
  const s = state.scale || 1;
  const sr = stage.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  return { x: (r.left + r.width / 2 - sr.left) / s, y: (r.top + r.height / 2 - sr.top) / s };
}

/** 某个座位的筹码位置：别人用头像，自己用手牌区 */
function seatPoint(seat) {
  if (seat === mySeat()) {
    const hand = $('myHand');
    if (hand && hand.children.length) {
      const p = stagePoint(hand);
      return { x: p.x, y: p.y + 30 };
    }
    const info = $('myInfo');
    if (info) return stagePoint(info);
  }
  const el = document.querySelector(`#seatLayer .seat[data-seat="${seat}"]`);
  if (el) return stagePoint(el);
  return { x: 375, y: 600 };
}

/** 金币从 A 飞到 B，A/B 可以是元素，也可以是舞台坐标 */
function coinFly(from, to, amount = 0) {
  if (!stage) return;
  const a = from instanceof Element ? stagePoint(from) : from;
  const b = to instanceof Element ? stagePoint(to) : to;
  if (!a || !b) return;
  const count = Math.max(5, Math.min(14, 4 + Math.round(Math.log2(Math.max(amount, 2)))));

  for (let i = 0; i < count; i++) {
    const c = document.createElement('i');
    c.className = 'coin-fly';
    c.style.left = `${a.x + (Math.random() - 0.5) * 26}px`;
    c.style.top = `${a.y + (Math.random() - 0.5) * 14}px`;
    c.style.setProperty('--dx', `${b.x - a.x + (Math.random() - 0.5) * 36}px`);
    c.style.setProperty('--dy', `${b.y - a.y + (Math.random() - 0.5) * 28}px`);
    c.style.animationDelay = `${i * 24}ms`;
    c.style.width = c.style.height = `${9 + Math.random() * 5}px`;
    stage.appendChild(c);
    setTimeout(() => c.remove(), 1000 + i * 24);
  }
}

/* ── v0.22.50：开手收芒 / 收底皮演出 ─────────────────────────
   参考流程：中央飘出「圈芒 / 休芒 ×n / 揍芒 ×n」→ 各家圈芒筹码逐家
   飞进芒果池（簸簸同步减少、芒果池逐笔累加）→ 再逐家飞底皮进皮池。
   纯前端演出：快照到达时各家 paid / bet 已是终值，
   用 hidden 把「已扣未入池」的部分先加回座位显示，随筹码落池逐笔归零。 */
function fxFloatText(txt) {
  if (!stage) return;
  const el = document.createElement('div');
  el.className = 'fx-float';
  // v0.22.51：条带容器 + <b> 金字（字体样式照「地九王」铭牌），外层 CSS 负责黑灰条带
  const b = document.createElement('b');
  b.textContent = txt;
  el.appendChild(b);
  stage.appendChild(el);
  setTimeout(() => el.remove(), 1500);
}

/** 单颗带金额的筹码：在起点停 holdMs（默认 260ms，份子批加长到 1.4s 让人看清）→ 抛物线飞到目标 → 落池回调 */
function fxChipFly(from, to, amount, onArrive, holdMs = 260) {
  if (!stage) { if (onArrive) onArrive(); return; }
  const a = from instanceof Element ? stagePoint(from) : from;
  const b = to instanceof Element ? stagePoint(to) : to;
  const el = document.createElement('i');
  el.className = 'fx-chip';
  // v0.22.55：金币上不再挂金额——金额显示在座位的下注胶囊里（用户要求）
  el.style.left = `${a.x}px`;
  el.style.top = `${a.y}px`;
  el.style.transform = 'translate(-50%,-50%)';
  stage.appendChild(el);
  const fly = () => {
    if (!el.isConnected) { if (onArrive) onArrive(); return; }
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const anim = el.animate([
      { transform: 'translate(-50%,-50%) scale(1)', opacity: 1 },
      { transform: `translate(calc(-50% + ${dx * 0.55}px), calc(-50% + ${dy * 0.55}px - 34px)) scale(1.12)`, opacity: 1, offset: 0.55 },
      { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(.82)`, opacity: .95 },
    ], { duration: 400, easing: 'cubic-bezier(.32,.72,.36,1)' });
    anim.onfinish = () => { el.remove(); if (onArrive) onArrive(); };
  };
  setTimeout(fly, holdMs);
}

/** 演出期间直接补丁座位簸簸数字（不等整桌重绘） */
function fxPatchSeat(seat) {
  const v = state.view;
  if (!v) return;
  const p = v.seats.find((x) => x.seat === seat);
  if (!p) return;
  const fx = state.handFx;
  const shown = Math.max(0, (p.stack ?? 0) + (fx ? fx.hidden.get(seat) || 0 : 0));
  const sel = seat === mySeat()
    ? '#myInfo .cap'
    : `#seatLayer .seat[data-seat="${seat}"] .cap`;
  document.querySelectorAll(sel).forEach((el) => { el.textContent = shown; });
  // v0.22.55：下注胶囊金额由演出接管——份子 → 底皮 → 归拢后消失。
  // 金额不写在金币上，用户要求金币只负责飞、金额看胶囊。
  const betShown = fx ? fx.betShown.get(seat) : null;
  const hosts = seat === mySeat()
    ? [document.querySelector('#myInfo')]
    : [...document.querySelectorAll(`#seatLayer .seat[data-seat="${seat}"]`)];
  hosts.forEach((host) => {
    if (!host) return;
    const cls = host.id === 'myInfo' ? '.my-bet' : '.bet-chip';
    let chip = host.querySelector(cls);
    if (betShown > 0) {
      if (!chip) {
        chip = document.createElement('div');
        chip.className = cls.slice(1);
        host.appendChild(chip);
      }
      if (chip.textContent !== String(betShown)) chip.textContent = betShown;
    } else if (chip) chip.remove();
  });
}

function fxPatchPools() {
  const fx = state.handFx;
  if (!fx) return;
  const mv = $('mangoVal');
  if (mv) mv.textContent = fx.mangoShown.toLocaleString();
  const pv = $('potVal');
  if (pv) pv.textContent = fx.potShown.toLocaleString();
}

function fxEnd() {
  const fx = state.handFx;
  if (!fx) return;
  fx.timers.forEach(clearTimeout);
  fx.els.forEach((el) => el.remove());
  document.querySelectorAll('.fx-chip, .fx-float').forEach((el) => el.remove());
  state.handFx = null;
  // v0.22.53：演出期间发牌被延迟（layoutCards/renderMyHand 提前返回），
  // 座位 sig 缓存里已记着「有牌」，这里强制清缓存全量重建——
  // rebuild 时 dealtSeen 还是空的，正好补播完整的发牌动画。
  if (state.seatEls) state.seatEls.clear();
  const mh = $('myHand');
  if (mh) mh.dataset.sig = '';
  renderSoon();
}

function fxStart(v) {
  const ante = v.ante || 0;
  const fees = v.seats.filter((s) => s.inHand && (s.paid || 0) > 0);
  const players = v.seats.filter((s) => s.inHand);
  const hidden = new Map(players.map((s) => [s.seat, (s.paid || 0) + ante]));
  // v0.22.55：下注胶囊金额由演出接管。初始=各自的份子（没份子的等底皮批再显）；
  // 芒果归拢后整批切成底皮金额；底皮归拢后演出结束，交回真实视图。
  const betShown = new Map(players.map((s) => [s.seat, (s.paid || 0) > 0 ? (s.paid || 0) : 0]));
  const fx = {
    handNo: v.handNo,
    hidden,
    betShown,
    mangoShown: v.carryPot || 0,   // 芒果池从滚存起、逐笔累加到 滚存+本手份子
    potShown: 0,
    timers: [], els: [],
  };
  state.handFx = fx;
  const later = (ms, fn) => fx.timers.push(setTimeout(fn, ms));

  // ① 中央飘字：圈芒 / 休芒 ×n / 揍芒 ×n
  if (fees.length) {
    const times = v.mangoTimes || v.mangoStreak || 0;
    const kindTxt = v.mangoKind === 'xiu' ? '休芒' : v.mangoKind === 'zou' ? '揍芒' : '圈芒';
    later(140, () => fxFloatText(times > 0 ? `${kindTxt} ×${times}` : kindTxt));
  }

  // ② 芒果批：小金币从簸簸飞进下注胶囊（胶囊=各自份子，簸簸同步减少）→
  //    到胶囊响币声 → 停留看清 → 大金币归拢芒果池 → 入池响收拢音
  //    v0.22.57：币声挂在「到达胶囊」、收拢音挂在「归拢入池」，音画严格对位
  const FLY = 400;                              // fxChipFly 飞行时长
  const tSmallM = fees.length ? 420 : 0;        // 小金币起飞：座位 → 胶囊
  const tFlyM = fees.length ? 420 + 1400 : 0;   // 大金币起飞（份子停留 1.4 秒看清）
  const betChipEl = (seat) => seat === mySeat()
    ? document.querySelector('#myInfo .my-bet')
    : document.querySelector(`#seatLayer .seat[data-seat="${seat}"] .bet-chip`);
  let chipSfxM = false;   // 份子批：小金币到胶囊响一次
  let chipSfxP = false;   // 底皮批：小金币到胶囊响一次
  if (fees.length) {
    later(tSmallM, () => {
      fees.forEach((s) => {
        fx.hidden.set(s.seat, Math.max(0, (fx.hidden.get(s.seat) || 0) - (s.paid || 0)));
        fxPatchSeat(s.seat);
        const chip = betChipEl(s.seat);
        if (chip) {
          fxChipFly(seatPoint(s.seat), chip, 0, () => {
            if (state.handFx === fx && !chipSfxM) { chipSfxM = true; sfxCoin(2); }
          }, 0);
        }
      });
    });
    // 芒果起飞那一刻：份子已看清并离手，下注胶囊统一切到底皮金额
    later(tFlyM, () => {
      players.forEach((s) => {
        if ((fx.betShown.get(s.seat) || 0) !== ante) {
          fx.betShown.set(s.seat, ante);
          fxPatchSeat(s.seat);
        }
      });
      fees.forEach((s) => {
        const from = betChipEl(s.seat) || seatPoint(s.seat);
        fxChipFly(from, $('mangoVal'), 0, () => {
          if (state.handFx === fx) { fx.mangoShown += (s.paid || 0); fxPatchPools(); }
        }, 0);
      });
      // 最后一颗落池那一刻响收拢音（大金币同时起飞同批到达）
      later(FLY + 30, () => { if (state.handFx === fx) sfxMangoSweep(); });
    });
  }

  // ③ 底皮批：芒果归拢 0.3 秒后，小金币从簸簸飞进下注胶囊（胶囊=底皮）→
  //    到胶囊响币声；皮池不再放归拢动画，**直接显示本手总额**（v0.22.57 节奏提速）
  const tSmallP = fees.length ? tFlyM + FLY + 300 : 420;
  later(tSmallP, () => {
    players.forEach((s) => {
      fx.hidden.set(s.seat, Math.max(0, (fx.hidden.get(s.seat) || 0) - ante));
      // 没份子的座位这时才亮出底皮胶囊
      if (!fees.some((f) => f.seat === s.seat)) fx.betShown.set(s.seat, ante);
      fxPatchSeat(s.seat);
      const chip = betChipEl(s.seat);
      if (chip) {
        fxChipFly(seatPoint(s.seat), chip, 0, () => {
          if (state.handFx === fx && !chipSfxP) { chipSfxP = true; sfxCoin(2); }
        }, 0);
      }
    });
  });
  // 小金币到胶囊那一刻：皮池直接显示真实总额（不做归拢飞行）
  later(tSmallP + FLY + 30, () => {
    if (state.handFx === fx && fx.potShown <= 0) {
      fx.potShown = v.potMain || 0;
      fxPatchPools();
    }
  });

  later(tSmallP + FLY + 600, () => fxEnd());
}

/** 每帧检查：新一手刚开始（都只交了底皮、没人行动）就起演出；进行中有人行动就收场 */
function detectHandStartFX(v, hadView) {
  const fx = state.handFx;
  if (fx) {
    const acted = (v.roundHighest || 0) > (v.ante || 0)
      || v.seats.some((s) => s.inHand && (s.bet || 0) > (v.ante || 0));
    if (acted || v.handNo !== fx.handNo || v.phase !== 'BET') fxEnd();
    return;
  }
  if (v.phase !== 'BET' || v.round !== 1) return;
  if (state.fxLastHand === v.handNo) return;
  state.fxLastHand = v.handNo;
  if (!hadView) return;                    // 刚进桌 / 断线重连的第一帧不演
  if (!v.seats.some((s) => s.inHand)) return;
  if ((v.roundHighest || 0) > (v.ante || 0)) return;   // 已经有人开口了就不演
  fxStart(v);
}

/** 下注：每个人自己的位置 → 底池；结算：底池 → 赢家的位置 */
function renderCoinFlow(v) {
  const potEl = $('potVal');
  const prevBets = state.lastBets;
  const prevPhase = state.lastPhase;
  const bets = new Map(v.seats.map((s) => [s.seat, s.bet]));
  state.lastBets = bets;
  state.lastPhase = v.phase;

  if (v.phase === PHASE.SETTLED) {
    if (prevPhase && prevPhase !== PHASE.SETTLED && (v.result ? v.result.pot > 0 : true)) {
      for (const s of v.seats) {
        if (s.delta > 0) coinFly(potEl, seatPoint(s.seat), s.delta);
      }
    }
    return;
  }

  if (!prevBets) return;
  // v0.22.50：开手演出接管底皮飞行（逐家带金额胶囊），平时才走这里的差额飞行
  if (state.handFx) return;
  for (const s of v.seats) {
    const was = prevBets.get(s.seat) || 0;
    if (s.bet > was) coinFly(seatPoint(s.seat), potEl, s.bet - was);
  }

  // v0.22.83：带入到账不再飞金币（用户要求删除特效），只记序号防重复
  if (v.lastBringIn && v.lastBringIn.seq !== state.lastCapSeq) {
    state.lastCapSeq = v.lastBringIn.seq;
  }
}

/* ── 渲染 ─────────────────────────────────── *//* ── 渲染 ─────────────────────────────────── */
/** 行动音效：服务端只发指令，这边合成；按 seq 去重，重绘不会重复响 */
function playSfx(v) {
  if (!state.sound || !v) return;
  if (v.sfxSeq == null) return;
  if (state.sfxSeq == null) { state.sfxSeq = v.sfxSeq; return; }   // 首次进桌不补历史音
  if (v.sfxSeq <= state.sfxSeq) return;
  const list = (v.sfx || []).filter((x) => x.seq > state.sfxSeq);
  state.sfxSeq = v.sfxSeq;
  /* v0.22.94：原来 slice(-3) 只播队列最后 3 条——弱网下快照间隔拉长，事件积压超过
   * 3 条时跟注/休/敲/发牌全被丢，只剩排最后的筹码声（实测「除筹码外音效时有时无」根因）。
   * 改为按 kind 去重：同类只保留最新一条（不嘈杂），各类声音都能出；
   * 后台时 setTimeout 被系统冻结会导致回前台爆响，改为 hidden 时零延迟播。 */
  /* v0.22.99：同类最多补播 2 声。旧版按类去重只留最新一条——弱网下两张快照
   * 间隔拉长，两家先后「丢」或「跟/大」挤进同一张快照时，气泡出了、声音只响
   * 一声甚至听起来「被吞」（这就是「其他音效正常、行动气泡音时有时无」的根因）。
   * 改为同类保留前 2 条按时间序补播；一帧总量仍限 6 声防嘈杂。 */
  const byKind = new Map();
  const picks = [];
  for (const x of list) {
    const c = byKind.get(x.kind) || 0;
    if (c >= 2) continue;
    byKind.set(x.kind, c + 1);
    picks.push(x);
  }
  if (picks.length > 6) picks.splice(0, picks.length - 6);
  picks.forEach((x, i) => {
    setTimeout(() => {
      if (x.kind === 'coin') sfxCoin(3);
      else if (x.kind === 'knock2') sfxKnockTable();
      else if (x.kind === 'fold') sfxFold();
      else if (x.kind === 'shower') sfxCoinShower();
    }, document.hidden ? 0 : i * 120);
  });
}

/* v0.21.2：一帧内的多次快照合并成一次渲染。
   原来每收到一条 state 就整桌重建 DOM，机器人多的桌子一秒钟能收到七八条，
   低端机上就会明显掉帧、点按发飘。 */
let renderFrame = 0;
function renderSoon() {
  if (renderFrame) return;
  renderFrame = requestAnimationFrame(() => {
    renderFrame = 0;
    render();
  });
}
/* v0.22.91：回前台秒恢复——安卓 WebView 切后台后 rAF/定时器全停、WebSocket 可能被
 * 系统挂起，回来若只靠 6 秒冻结看门狗讨快照，就会「人家过了两手我还在开头那手」。
 * 改为：回前台立即发 sync 讨最新快照（1.5 秒节流防连切），WS 已断则立即重连，
 * 并马上补一次渲染，不等下一帧排队。iOS 的 WKWebView 后台宽容，此改动对它无感。 */
let wakeSyncAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  const now = Date.now();
  if (now - wakeSyncAt > 1500) {
    wakeSyncAt = now;
    const ws = net.ws;
    if (!ws || ws.readyState !== 1) {
      try { if (ws && ws.readyState === 3) ws.close(); } catch { /* 已断 */ }
      connect();
    } else {
      try { sendWS({ t: 'sync' }); } catch { /* 下一拍看门狗兜底 */ }
    }
  }
  if (renderFrame) { cancelAnimationFrame(renderFrame); renderFrame = 0; }
  render();
});

/* ── 临时诊断（B测量）：点击 → 画面更新 耗时埋点 ────────────────
 * 只测自己发起的下注/分牌：t0=点击，tRecv=回包里视图发生变化，tDone=render 重绘完成。
 * 拆两段：net=tRecv-t0（网络+服务端），raf=tDone-tRecv（rAF 排队+DOM 重建）。
 * 走现成 /client-crash 端点落盘，[PERF] 前缀区分。localStorage.dh_perf=0 可关闭。 */
const PERF = { cur: null, timer: 0 };
function perfEnabled() {
  try { return localStorage.getItem('dh_perf') !== '0'; } catch (e) { return true; }
}
function perfUA() {
  const ua = navigator.userAgent || '';
  const os = /Android/i.test(ua) ? 'android' : /iPhone|iPad|iPod/i.test(ua) ? 'ios' : 'other';
  return os + (/(wv|Version\/)/.test(ua) ? '-webview' : '-browser');
}
function perfSnap(v) {
  let m = null;
  if (v && v.seats && v.viewerSeat >= 0) m = v.seats.find((s) => s.seat === v.viewerSeat) || null;
  return [v ? v.handNo : -1, v ? v.phase : '', v ? v.currentSeat : -2,
    v ? (v.roundHighest || 0) : 0, m ? (m.bet || 0) : -1,
    m ? (m.folded ? 1 : 0) : -1, m ? (m.split ? 1 : 0) : -1].join('|');
}
function perfBegin(kind) {
  if (!perfEnabled()) return;
  try {
    PERF.cur = { kind, t0: performance.now(), snap: perfSnap(state.view), recv: 0 };
    clearTimeout(PERF.timer);
    PERF.timer = setTimeout(() => { PERF.cur = null; }, 10000);   // 弱网/拒答：10s 后丢弃
  } catch (e) { PERF.cur = null; }
}
function perfOnState(v) {
  const p = PERF.cur;
  if (!p || p.recv) return;
  try { if (perfSnap(v) !== p.snap) p.recv = performance.now(); } catch (e) { /* 忽略 */ }
}
function perfOnRender(v) {
  const p = PERF.cur;
  if (!p || !p.recv) return;
  try {
    const done = performance.now();
    const dv = document.documentElement;
    const row = {
      k: p.kind, tot: Math.round(done - p.t0), net: Math.round(p.recv - p.t0),
      raf: Math.round(done - p.recv), ua: perfUA(),
      v: (dv && dv.dataset.ver) || '', h: v ? v.handNo : -1,
      ts: Date.now(),
    };
    PERF.cur = null;
    clearTimeout(PERF.timer);
    const u = new URL(wsEndpoint());
    const origin = u.protocol.replace(/^ws/, 'http') + '//' + u.host;
    fetch(origin + '/client-crash', {
      method: 'POST', body: '[PERF] ' + JSON.stringify(row), keepalive: true,
    }).catch(() => {});
  } catch (e) { PERF.cur = null; }
}

/* ── v0.22.78：乐观反馈（点击即刻响应，不等回包）─────────────────
 * 只叠加显示，绝不写权威 state.view。点击后立刻：① 我的座位冒出动作气泡
 * ② 行动按钮按灭；回包里我的视图变了就撤掉（真实气泡无缝接管），
 * 超过 1.5 秒还没变化也撤掉。纯视觉层，不改任何游戏规则/判定。 */
const OPT_HOLD_MS = 1500;
const OPT_TEXT = { fold: '丢', pass: '休', follow: '跟', raise: '大', knock: '敲', split: '分牌' };
const OPT_CLS = { fold: 'fold', pass: 'pass', follow: 'follow', raise: 'big', knock: 'knock', split: 'split-done' };
function optBegin(action) {
  const v = state.view;
  if (!v || v.viewerSeat < 0) return;
  state.opt = { action, handNo: v.handNo, seat: v.viewerSeat, sig: perfSnap(v), at: Date.now() };
  if (state.optTimer) clearTimeout(state.optTimer);
  state.optTimer = setTimeout(() => {
    if (state.opt && Date.now() - state.opt.at >= OPT_HOLD_MS) {
      state.opt = null; paintOpt(); paintMyActionsOpt(); renderSoon();
    }
  }, OPT_HOLD_MS + 80);
  paintOpt();
  paintMyActionsOpt();
}
function optOnState(v) {
  const o = state.opt;
  if (!o) return;
  // 换手 / 我的视图已变（bet/folded/lastAction…）→ 服务端已处理，撤乐观态。
  // 注意：这里只改状态、不动 DOM。气泡的撤销统一放到 render() 末尾的
  // paintOpt()，与真实 lastAction 气泡在同一帧完成交接，杜绝「先清后画」的闪烁。
  if (!v || v.handNo !== o.handNo || perfSnap(v) !== o.sig) {
    state.opt = null;
    if (state.optTimer) { clearTimeout(state.optTimer); state.optTimer = null; }
  }
}
/** 独立气泡层：不进 seatSig 缓存，回包重建座位时由 paintOpt 重画/清除 */
function paintOpt() {
  document.querySelectorAll('#seatLayer .opt-tag').forEach((e) => e.remove());
  const o = state.opt;
  if (!o) return;
  const seatEl = document.querySelector(`#seatLayer .seat[data-seat="${o.seat}"]`);
  if (!seatEl) return;
  const t = document.createElement('div');
  t.className = 'tag opt-tag ' + (OPT_CLS[o.action] || '');
  t.textContent = OPT_TEXT[o.action] || '已提交';
  seatEl.appendChild(t);
}
/** 行动按钮按灭：乐观期间禁用，回包/超时后恢复（renderMyActions 重绘会接管） */
function paintMyActionsOpt() {
  const box = $('myActions');
  if (!box) return;
  box.classList.toggle('opting', !!state.opt);
  box.querySelectorAll('.mbtn').forEach((b) => { b.disabled = !!state.opt; });
}

/** v0.22.67：桌面「地九王」铭牌——本桌关掉地九王时隐藏 */
function paintShoeBrand(on) {
  const el = $('shoeBrand');
  if (el) el.classList.toggle('hidden', !on);
}

function render() {
  const v = state.view;
  // v0.20.53：离房 / 被踢 / 变回围观时自动松手，别让麦克风一直开着
  if (voiceTalking && (!v || v.viewerSeat < 0)) onMicUp();
  if (!v) {
    clearPeekNext();
    state.hadView = false;
    // v0.22.78：没视图了，撤销乐观态并清掉残留气泡
    if (state.opt) {
      state.opt = null;
      if (state.optTimer) { clearTimeout(state.optTimer); state.optTimer = null; }
    }
    paintOpt();
    renderWaiting('正在连接房间…');
    paintShoeBrand(true);   // 没进桌：铭牌跟着恢复默认（开），下次进房会按本桌重设
    return;
  }
  paintShoeBrand(v.dijiuOn !== false);
  hideLobby();
  // 当前阶段挂到 body 上：CSS / 调试 / 自动化检查都用得着
  document.body.dataset.phase = v.phase || '';
  playSfx(v);
  syncRoomMeta(v);
  // 读秒已经归零一次：再挂一次机，下手就停发牌、进留座倒计时，先提醒一声
  if (v.viewerSeat >= 0) {
    const mine = v.seats.find((s) => s.seat === v.viewerSeat);
    const key = `${v.handNo}:${mine && mine.timeouts}`;
    if (mine && mine.timeouts === 1 && state.timeoutWarnKey !== key) {
      state.timeoutWarnKey = key;
      toast('读秒到 0 了：再超时一次，下手自动留座', 2800);
    }
  }
  state.dealBudget = 5;   // 每次推送最多补几声发牌，避免 8 家一起响成一片

  // 换手：清掉发牌动画/收牌动画的记忆，下一手重新从空桌发牌
  if (state.lastHandNo !== v.handNo) {
    state.lastHandNo = v.handNo;
    // v0.20.57：换手即收掉可能残留的洗牌动画（正常情况动画先播完才发牌，这里是兜底）
    stopWashFx();
    stopSweepShuffle();   // v0.20.74：别让上一手的 2s 洗牌录音拖进下一手发牌
    // 发发看的三张牌看到下一手开局为止（整场收摊时也一并收走）
    if (pnHand != null) clearPeekNext();
    dealtSeen.clear();
    flipAt.clear();
    turnAt.clear();
    placeholderSeen.clear();
    state.sweepHand = null;
    state.sweptHand = null;
    clearTimeout(sweepTimer);
    sweepTimer = null;
    // v0.22.78：换手撤销乐观态（上一手的动作提示不能带到下一手）
    if (state.opt) {
      state.opt = null;
      if (state.optTimer) { clearTimeout(state.optTimer); state.optTimer = null; }
    }
    // 搓牌开关跟房间走：换手不重置（整场一次买断），进新房间才拨回 OFF（见 syncRoomMeta）
  }

  // 搓牌：自己发到第四张就铺开搓牌画面；服务端先收场了这边跟着收
  syncScratch(v);
  // 搓牌期间自己的行动读秒冻住，搓完由服务端推来的新 turnAt 重新校准
  const meSeatView = (v.seats || []).find((s) => s.seat === v.viewerSeat);
  state.scratchHoldUntil = meSeatView && meSeatView.scratchLeft > 0
    ? Date.now() + meSeatView.scratchLeft * 1000
    : 0;

  // v0.22.55：开手演出检测提前到渲染最前——保证本帧所有渲染都在演出上下文里：
  // 池子从演出值起显（皮池 0）、座位不发牌、簸簸按「已扣未入池」加回显示。
  // v0.22.50 版本这里在池子渲染之后才检测，导致快照真实值先闪现一帧。
  const hadViewFx = !!state.hadView;
  state.hadView = true;
  detectHandStartFX(v, hadViewFx);

  const handNoEl = $('handNo');
  if (handNoEl) {
    handNoEl.textContent = v.handNo;
    const handBox = handNoEl.parentElement;
    if (handBox) handBox.classList.toggle('hidden', v.phase === 'WAITING');
  }
  const rt = $('roomTag');
  if (rt) {
    const rid = v.roomId || net.roomId;
    rt.textContent = (net.mode === 'online' && rid) ? rid : '—';
  }
  paintHud(v);
  paintExtFab();   // v0.20.56：常驻加时键（价格 / 次数 / 置灰）跟着每帧刷新
  paintWashFab();  // v0.20.57：洗牌键（结算停留期才亮）跟着每帧刷新
  paintTime(v);

  // 开发者：牌堆 + 接下来要发的牌
  const gb = $('godBar');
  if (gb) {
    gb.classList.toggle('hidden', !v.god);
    if (v.god) paintGodBar(v);
  }

  // 等待开局：牌桌上方挂一条房号信息，方便念给朋友
  const wp = $('waitPanel');
  if (wp) {
    const on = v.phase === 'WAITING';
    wp.classList.toggle('hidden', !on);
    if (on) {
      const humans = v.seats.filter((s) => !s.isAI).length;
      const mins = v.durationMin >= 60 ? `${v.durationMin / 60} 小时` : `${v.durationMin || 60} 分钟`;
      wp.innerHTML = `
        <div class="wp-head">
          <span>房号</span><b>${v.roomId || net.roomId}</b>
          <button class="wp-copy" id="wpCopy">复制邀请</button>
        </div>
        <div class="wp-meta">
          <em>底皮 ${v.ante}</em>
          <em>圈芒 ${v.handMango || v.ante * 2}</em>
          <em>起带 ${(v.minBuyIn || 0).toLocaleString()}</em>
          <em>${mins}</em>
          <em>${humans}/${v.seatCount} 人</em>
        </div>`;
      wp.querySelector('#wpCopy').onclick = copyInvite;
    }
  }

  // v0.22.63：与 paintReqBadges() 共用同一套角标判据，别再各写一份
  syncReqBadge(v);
  if ($('modalBox').dataset.kind === 'req') paintRequests(v);
  maybeEnded(v);

  $('tableInfo').classList.toggle('waiting', v.phase === 'WAITING');
  $('anteVal').textContent = v.ante;
  $('mangoTag').textContent = v.handMango || v.ante * 2;
  // 皮池 = 本手每个人下到桌上的簸簸（含底皮），不含芒果。
  // 有短码全下时拆成「主池 / 边池」两栏；比完牌这一手就清空，下一手重新累计。
  const potSettled = v.phase === 'SETTLED' || v.ended;
  const potMain = potSettled ? 0 : (v.potMain || 0);
  const potSide = potSettled ? 0 : (v.potSide || 0);
  // v0.22.50：开手演出期间，皮池数字由动画逐笔累加接管
  const fx = state.handFx;
  $('potVal').textContent = (fx ? fx.potShown : potMain).toLocaleString();
  $('potSideVal').textContent = potSide.toLocaleString();
  $('potSidePair').classList.toggle('hidden', potSide <= 0);
  $('potRow').classList.toggle('split', potSide > 0);
  // 分池时两个数字并排，位数多了自动缩字号，别顶出边框
  const potDigits = potMain.toLocaleString().length + potSide.toLocaleString().length;
  $('potRow').classList.toggle('tight', potSide > 0 && potDigits >= 10);
  $('potRow').classList.toggle('tight2', potSide > 0 && potDigits >= 14);

  // 房间号：中央信息栏里那条「房间号」按钮旁边就是号码
  stage.classList.toggle('spectating', watching());
  // v0.22.55：演出检测已提前到 render 开头（否则本帧皮池/发牌先按真实值渲染，
  // 下一帧演出才启动——用户看到「皮池先有 80 又归零重演、牌先出后补发」的重复感）
  renderCoinFlow(v);

  // 圈芒：×n = 连击次数（0 正常手 → 按起点 ×1 显示）；休芒 / 揍芒共用一条连击链
  // mangoTimes 是新服务端的连击次数；旧服务端只有 mangoStreak，兜底用后者
  const times = v.mangoTimes || v.mangoStreak || 0;
  const mult = v.mangoMult || 0;   // 加倍倍数：1 / 2 / 4 / 8（封顶）
  // 芒果池 = 本手圈芒和加倍 + 上手没吃完的滚存，两个数字合成一个显示；
  // 比完牌后本手部分清零，剩下的滚存留在这一栏，下一手接着累计。
  const mangoIn = v.mangoIn || 0;
  const mangoPool = mangoIn + (v.carryPot || 0);
  const step = times > 0 ? times : 1;
  // v0.22.50：开手演出期间，芒果池数字由动画逐笔累加接管
  $('mangoVal').textContent = (state.handFx ? state.handFx.mangoShown : mangoPool).toLocaleString();
  $('mangoTimes').textContent = `×${step}`;
  $('cellXiu').classList.toggle('on', v.mangoKind === 'xiu');
  $('cellZou').classList.toggle('on', v.mangoKind === 'zou');
  const line = $('mangoRow');
  line.title = times > 0
    ? `休芒 / 揍芒连击 ×${times}：每家除圈芒外，再加倍 圈芒×${mult}（逐次翻倍，封顶 ×8）${v.mangoKind === 'zou' ? '，本手收池者免交' : ''}`
    : '正常手：每家只交底皮 + 圈芒；一旦休芒 / 揍芒，加倍从圈芒 ×1 起步、逐次翻倍，×8 封顶';
  $('mangoKind').textContent = '';
  line.classList.toggle('hot', !!v.mangoKind || (v.carryPot || 0) > 0);

  stage.classList.toggle('raising', !!state.raiseMode || !!state.sheet);
  if (state.sheet && v.phase !== PHASE.BET && v.phase !== PHASE.SPLIT) closeSheet();

  const badge = $('roundBadge');
  if (badge) {
    badge.classList.toggle('live', v.phase === PHASE.BET);
    if (v.dealHold) {
      badge.textContent = '暂停发牌 · 等人';
    } else if (v.phase === PHASE.BET) {
      const cur = v.seats.find((s) => s.seat === v.currentSeat);
      badge.textContent = `第 ${v.round} 轮 · 起手 ${v.roundFloor || v.ante} · ${cur ? cur.name : ''} 说话`;
    } else if (v.phase === PHASE.SPLIT) {
      badge.textContent = '分牌';
    } else if (v.phase === PHASE.SETTLED) {
      badge.textContent = '本局结束';
    } else if (v.phase === 'WAITING') {
      badge.textContent = '等待开局';
    } else {
      badge.textContent = '准备中';
    }
  }

  // 结算期中央「强制秀牌」：显隐跟随整组统一判据，只叠加自身条件（本手在局、没秀过）
  const fr = $('forceReveal');
  if (fr) {
    const mineS = (v.seats || []).find((x) => x.seat === v.viewerSeat);
    fr.classList.toggle('act-off',
      actionStackHidden(v) || !(net.mode === 'online' && mineS && mineS.inHand && !v.allRevealed));
  }

  // 结算期动作竖排：整组显隐统一走 actionStackHidden（见文件头判据说明），
  // 全场停牌 → 所有玩家收起；个人停牌 → 只收起停牌玩家自己；围观、非结算期、一人收池也同样收起。
  const astk = $('actionStack');
  if (astk) astk.classList.toggle('stack-hidden', actionStackHidden(v));

  // 三花：自动弃牌提示
  const selfSeat = me();
  if (selfSeat && selfSeat.special) {
    const key = `${v.handNo}:${selfSeat.seat}:${selfSeat.special}`;
    if (state.specialShown !== key) {
      state.specialShown = key;
      toast(`${selfSeat.special} · 自动弃牌，退回 ${selfSeat.refunded || 0}`, 2600);
    }
  }

  // 全员休：本手作废，读秒进休芒
  showVoidBanner(v);

  // 可行动人数不足 2：牌局暂停发牌（房间倒计时不停）
  const hb = $('holdBanner');
  if (hb) {
    // 自己保位时这条横幅没意义（人不够是自己离席造成的，头像上方已经有「回到座位」）
    const mineHold = !!(me() && me().holdLeave);
    const on = !!v.dealHold && !mineHold;
    hb.classList.toggle('hidden', !on);
    stage.classList.toggle('holding', on);   // 横幅占位：操作栏往下让一格
    if (on) {
      hb.innerHTML = '<b>暂停发牌</b><span>可行动 '
        + `${v.actableCount ?? 0} 人</span>`;
    }
  }

  if (v.phase !== PHASE.SPLIT) {
    state.splitStep = 0;
    state.headPicked = [];
    state.splitSent = false;
    if (state.splitRetry) { clearTimeout(state.splitRetry); state.splitRetry = null; }
  }
  // 调试：?pick=0,2 直接选中两张，方便截图验证自动定头尾
  if (v.phase === PHASE.SPLIT && PARAMS.has('pick') && !state.headPicked.length) {
    const idx = PARAMS.get('pick').split(',').map(Number).filter((n) => n >= 0 && n < 4);
    if (idx.length === 2) { state.headPicked = idx; state.splitStep = 1; }
  }
  if (v.phase !== PHASE.BET) state.raiseMode = false;
  // 拉条还开着时牌局结算 / 换人行动：先收掉（否则旧按钮会挂在画面上）
  if (raisePop && (v.phase !== PHASE.BET || v.currentSeat !== mySeat())) closeRaisePop();

  // 行动读秒：换人 / 换轮 / 加时就重新起表；用服务端给的剩余秒数校准本机时钟
  if (v.phase === PHASE.BET && v.currentSeat >= 0) {
    const total = TURN_SECONDS + Math.round((v.turnExtMs || 0) / 1000);
    const key = `${v.handNo}:${v.round}:${v.currentSeat}:${v.turnAt || 0}:${total}`;
    if (state.turnKey !== key) {
      state.turnKey = key;
      const left = v.turnLeft != null ? v.turnLeft : total;
      const safe = Math.max(0, Math.min(total, left));
      state.turnSince = Date.now() - (total - safe) * 1000;
    }
  } else if (state.turnKey) {
    state.turnKey = null;
  }

  renderSeats();
  renderMyHand();
  renderSplitUI(v);
  renderActions();
  renderMyActions();
  renderCheatDeck(v);
  paintFfk(v);
  scheduleSweep(v);
  // 战绩面板不跟牌局走：只在「本手结算」的那一刻留一份底稿，面板打开时读它。
  // 打开中的面板不重绘——否则数字会跟着下注跳动。
  // v0.20.77：开局第一手（handNo===1）不进战绩底稿——刚开局就显示「输赢」会让人误会是
  // 凭空产生的；这一手真正关掉、下一手开始后才作为历史战绩出现。顺便清掉上一局遗留的
  // 底稿（原来只在换桌时清，同房间重开不清，导致新一局第一手显示上一局最后的输赢）。
  if (v.handNo === 1) state.lastSettled = null;
  else if (v.phase === PHASE.SETTLED) state.lastSettled = statsFrameOf(v);

  if (v.phase === PHASE.SETTLED) scheduleNext();
  // v0.22.87：暂停/停牌时乐观气泡一并撤掉（服务端暂停期间不会回 ack）
  if ((v.phase === 'WAITING' || v.dealHold) && state.opt) {
    state.opt = null;
    if (state.optTimer) { clearTimeout(state.optTimer); state.optTimer = null; }
  }
  paintOpt();          // v0.22.78：乐观气泡层随每帧重画/清除（含回包交接同帧完成）
  perfOnRender(v);   // B测量：画面重绘完成 → 结算并上报本次点击耗时
}

function scheduleNext() {
  if (net.mode !== 'local' || state.nextTimer || STOP_SETTLED) return;
  state.nextTimer = setTimeout(() => {
    state.nextTimer = null;
    nextHand();
  }, 5000);
}

function renderWaiting(text) {
  $('seatLayer').innerHTML = '';
  // v0.22.35：座位 DOM 复用缓存必须跟层一起作废——
  // 否则退出再进同一房间时，缓存里还攥着已脱离页面的旧节点，
  // 结构签名又没变，renderSeats 直接跳过重建 → 整桌座位不显示。
  state.seatEls = null;
  state.splitKey = null;
  $('myHand').innerHTML = '';
  $('myInfo').innerHTML = '';
  const ma = $('myActions');
  if (ma) ma.innerHTML = '';
  const bs = $('bringSlot');
  if (bs) bs.innerHTML = '';
  $('actionBar').innerHTML = `<div class="waiting">${text}</div>`;
  $('potVal').textContent = '0';
  $('potSideVal').textContent = '0';
  $('potSidePair').classList.add('hidden');
  $('potRow').classList.remove('split');
  const rb = $('roundBadge');
  if (rb) {
    rb.textContent = '准备中';
    rb.classList.remove('live');
  }
}

/* ── 大厅 / 等待室 ─────────────────────────────
 * 流程：开房（自己就是房主）→ 把房号发给朋友 → 2 人以上 → 房主点「开始牌局」。
 * 牌局进行中进来的人先排队，这一手结算完自动入座。
 */
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
const tokenKey = (room) => `dh_token_${room}`;

/** 对外可分享的页面地址。
 *  App 内置页面跑在 http://localhost，直接复制 location 会得到 localhost 链接，发给朋友打不开；
 *  这时改用打包时注入的服务器域名，网页版仍按当前地址走。 */
function pageUrl() {
  const o = window.__DH_WS__;
  if (o && (location.hostname === 'localhost' || location.protocol === 'file:')) {
    try { const u = new URL(o); return `https://${u.host}/${location.search}`; } catch { /* 退化到原地址 */ }
  }
  return location.href;
}

/** 改 URL 参数但保住 sharecode 等其它参数 */
function withParam(key, val) {
  const u = new URL(pageUrl());
  if (val == null) u.searchParams.delete(key); else u.searchParams.set(key, val);
  return u.toString();
}
// 邀请链接：带上邀请人的名字，被邀请的人一进来就知道是谁喊的
function inviteLink(room) {
  const u = new URL(withParam('room', room));
  const me = String(net.name || localStorage.getItem('dh_nick') || '').trim();
  if (me) u.searchParams.set('from', me);
  return u.toString();
}

/** 同源房间 URL：只用于 history.replaceState。
 *  App 内置页面 origin 是 https://localhost，而 pageUrl() 会返回服务器域名（nip.io）；
 *  在 localhost 页面里用 replaceState 写跨域地址，安卓 WebView 会抛 SecurityError，
 *  导致进入房间的后续逻辑（hideLobby / sendWS）全部中断，表现为「点进入没反应」。
 *  所以这里一律用当前页 origin 拼 URL，不影响分享用的 inviteLink。 */
function localRoomUrl(room) {
  const u = new URL(location.href);
  if (room == null) u.searchParams.delete('room'); else u.searchParams.set('room', room);
  return u.toString();
}

let lobbyPoll = null;
function stopLobbyPoll() { clearInterval(lobbyPoll); lobbyPoll = null; }

function showLobby(kind) {
  const l = $('lobby');
  l.classList.remove('hidden');
  state.lobbyPage = kind;
  $('lobbyHome').classList.toggle('hidden', kind !== 'home');
  $('lobbyCreate').classList.toggle('hidden', kind !== 'create');
  $('lobbyJoin').classList.toggle('hidden', kind !== 'join');
  ['homeTip', 'createTip', 'joinTip'].forEach((id) => {
    const el = $(id);
    if (el) { el.textContent = ''; el.classList.remove('bad'); }
  });
  stopLobbyPoll();   // 大厅里不再展示别人的桌子，只按房号进
}

function hideLobby() {
  const l = $('lobby');
  if (l.classList.contains('hidden')) return;
  l.classList.add('hidden');
  stopLobbyPoll();
}

function lobbyTip(msg, bad) {
  const id = state.lobbyPage === 'create' ? 'createTip'
    : state.lobbyPage === 'join' ? 'joinTip' : 'homeTip';
  const el = $(id);
  if (!el) return;
  el.textContent = msg || '';
  el.classList.toggle('bad', !!bad);
}

function randomNick() {
  const n = ['茶客', '幺鸡', '三娃', '老陈', '小周'][Math.floor(Math.random() * 5)];
  return n + Math.floor(10 + Math.random() * 89);
}

function syncNick(v) {
  document.querySelectorAll('.nick-input').forEach((el) => {
    if (document.activeElement !== el) el.value = v;
  });
}

/** 当前页面的昵称输入框（加入房间页已去掉昵称框，主界面也没有，都用本机记住的名字） */
function activeNickEl() {
  if (state.lobbyPage === 'create') return $('nickCreate');
  return null;
}

function currentNick() {
  const el = activeNickEl();
  const v = (el && el.value || '').trim().slice(0, 8);
  if (v) {
    net.name = v;
    localStorage.setItem('dh_nick', v);
    syncNick(v);
    return v;
  }
  if (!net.name) {
    const saved = String(localStorage.getItem('dh_nick') || '').trim().slice(0, 8);
    net.name = saved || randomNick();
    localStorage.setItem('dh_nick', net.name);
  }
  syncNick(net.name);
  return net.name;
}

function renderLobbyHome() {
  net.mode = 'lobby';
  // 名字只用本机记住的那个，别每次随机一个
  net.name = String(localStorage.getItem('dh_nick') || net.name || '').trim();
  syncNick(net.name);
  paintMyNick();
  showLobby('home');
  lobbyTip('');
  paintReqBadges();   // v0.22.38：回大厅把「你的房间」的申请角标刷一遍
}

/** v0.20.28：房主判定——服务端下发的 amOwner（开房人锁定，围观席也算）。
 *  v0.22.61：开房账号 uid 才是最权威的判据，放在最前面。
 *  旧回退只看「座位号 === ownerSeat」：房主站在围观席时 viewerSeat=-1、
 *  ownerSeat 常为 null，必然误判成普通观众 —— 表现就是「带入申请角标不出现，
 *  一坐上座位才冒出来」。服务端 reviewBuyIn 同样按 uid 校验，这里只影响 UI 显隐。 */
function amOwnerV(v) {
  if (!v) return false;
  const myUid = acct.user ? String(acct.user.id) : '';
  if (myUid && v.ownerUid && String(v.ownerUid) === myUid) return true;
  if (typeof v.amOwner === 'boolean') return v.amOwner;
  return net.mode === 'online' && v.ownerSeat != null && v.ownerSeat === v.viewerSeat;
}

/** 房间列表（大厅底部） */
/** 等待阶段也直接坐在牌桌上：这里只同步身份，界面交给牌桌渲染 */
function syncRoomMeta(v) {
  // 换了一桌（或重开房）：战绩底稿属于上一桌，不能带过来
  if (net.roomId && v.roomId && net.roomId !== v.roomId) {
    state.lastSettled = null;
    state.statsSnap = null;
    state.statsPainted = false;
    // 搓牌：不做偏好记录——每个新房间所有玩家初始 OFF，进房后自己手动打开
    setScratchSwitch(false);
    // 换桌后手号会从 1 重新数，声明的记账一起清掉，别把新桌的第一手误判成「已声明」
    sc.announced = -1;
    // v0.20.75：回顾秀牌 / 偷偷看按 handNo 记账，换桌后手号重数，也得一起清——
    // 否则新桌第 N 手会被旧桌「已秀过」误判成置灰点不动，或白送一次亮牌
    logShownHands.clear();
    logPeeked.clear();
  }
  net.roomId = v.roomId;
  net.seat = v.viewerSeat;
  net.watching = v.viewerSeat < 0;
  net.isOwner = amOwnerV(v);
}

/** v0.20.52：顶栏左侧常驻「我」的 ID 与钻石余额（原来藏在点头像弹窗 / 菜单里）。
 *  render() 每帧都过这里，值没变就不写 DOM，避免无谓重排。 */
function paintHud() {
  const box = $('hudId');
  if (!box) return;
  const u = acct.user;
  const id = u ? String(u.id) : '—';
  const gem = u ? fmtNum(u.diamonds) : '0';
  box.classList.toggle('guest', !u);
  const idEl = $('hudIdNo'), gemEl = $('hudGem');
  if (idEl && idEl.textContent !== id) idEl.textContent = id;
  if (gemEl && gemEl.textContent !== gem) gemEl.textContent = gem;
}

/** 带入申请列表（房主在牌桌上审核） */
function paintRequests(v) {
  const box = $('reqModalBody');
  if (!box) return;
  const isOwner = amOwnerV(v);
  // v0.22.38：房主看到自己名下所有房间的申请（房号 + 昵称 + ID + 金额），
  // 哪个房间的都能直接审；普通玩家仍只看本房自己的申请状态。
  const list = isOwner
    ? (myReqs.list || [])
    : (v.requests || []);
  const mine = v.myRequest;
  box.innerHTML = `
    <div class="req-title">${isOwner ? `名下待审 ${list.length} 笔 · 同意后才上桌` : '带入申请 · 同意后才上桌'}</div>
    ${list.map((r) => `<div class="req-item">
      ${isOwner ? `<span class="rq-room">${esc(r.roomId)}</span>` : ''}
      <span class="rq-nm">${esc(r.name || '玩家')}${r.uid ? `<i class="rq-uid">ID ${esc(r.uid)}</i>` : ''}</span>
      <span class="rq-amt">+${Number(r.amount || 0).toLocaleString()}</span>
      <span class="rq-act">
        <button class="rq-btn" data-ok="${r.seat}" data-room="${esc(r.roomId || '')}">同意</button>
        <button class="rq-btn no" data-no="${r.seat}" data-room="${esc(r.roomId || '')}">拒绝</button>
      </span>
    </div>`).join('')}
    ${!list.length && mine ? `<div class="ask-note wait">已申请 ${mine.amount.toLocaleString()}，等房主同意</div>` : ''}
    ${!list.length && !mine ? '<div class="ask-note">暂时没有待审核的申请</div>' : ''}`;
  box.querySelectorAll('[data-ok]').forEach((b) => {
    b.onclick = () => {
      const rid = b.dataset.room;
      sendWS(rid
        ? { t: 'review', roomId: rid, seat: Number(b.dataset.ok), approve: true }
        : { t: 'review', seat: Number(b.dataset.ok), approve: true });
    };
  });
  box.querySelectorAll('[data-no]').forEach((b) => {
    b.onclick = () => {
      const rid = b.dataset.room;
      sendWS(rid
        ? { t: 'review', roomId: rid, seat: Number(b.dataset.no), approve: false }
        : { t: 'review', seat: Number(b.dataset.no), approve: false });
    };
  });
}


/* ── 开发者控制台 ─────────────────────────────
 * 一条口令当账号，登录后能看所有牌局、开关机器人、进任意一桌的上帝视角。
 * 口令存在这台设备上（localStorage），下次点「开发者」不用重输。
 */
const ADMIN_LS = 'dh_admin_key';
let adminRooms = [];

const adminKey = () => String(localStorage.getItem(ADMIN_LS) || '');

function askAdminKey() {
  const box = $('modalBox');
  box.dataset.kind = 'admin';
  box.innerHTML = `<button class="modal-x" id="akClose">×</button>
    <h2>开发者登录</h2>
    <label class="admin-key-row">
      <input id="adminKeyInput" class="nick-big" type="password" autocomplete="off" placeholder="开发者口令">
    </label>
    <div class="nick-actions"><button id="adminKeyOk" class="nick-ok">登录</button></div>`;
  const input = box.querySelector('#adminKeyInput');
  const go = () => {
    const key = input.value.trim();
    if (!key) { input.focus(); return; }
    localStorage.setItem(ADMIN_LS, key);
    closeModal();
    sendWS({ t: 'adminLogin', key });
  };
  box.querySelector('#adminKeyOk').onclick = go;
  box.querySelector('#akClose').onclick = closeModal;
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  $('modal').classList.remove('align-left');
  $('modal').classList.remove('hidden');
  setTimeout(() => input.focus(), 60);
}

/** 触发开发者登录：有记住的口令就直接登，没有先要口令 */
function openAdmin() {
  beep(560, 0.05);
  if (adminKey()) sendWS({ t: 'adminLogin', key: adminKey() });
  else askAdminKey();
}

let adminPoll = null;

function showAdminPanel() {
  $('adminPanel').classList.remove('hidden');
  const who = $('adminWho');
  if (who) who.textContent = '已登录 · 全桌底牌可见';
  paintAdmin();
  sendWS({ t: 'adminRooms' });
  // 面板开着就跟着牌局走：3 秒刷一次，机器人在座/手数/底池都能实时看到
  clearInterval(adminPoll);
  adminPoll = setInterval(() => sendWS({ t: 'adminRooms' }), 3000);
}

function hideAdminPanel() {
  $('adminPanel').classList.add('hidden');
  clearInterval(adminPoll);
  adminPoll = null;
}

const PH_TEXT = { WAITING: '等待开局', BET: '下注中', SPLIT: '分牌中', SETTLED: '本手结算' };
const minsText = (ms) => {
  const m = Math.max(0, Math.round(ms / 60000));
  return m >= 60 ? `${(m / 60).toFixed(1)} 小时` : `${m} 分钟`;
};

function paintAdmin() {
  const list = adminRooms;
  const live = list.filter((r) => r.started && !r.ended).length;
  const sum = $('adminSum');
  if (sum) sum.textContent = `共 ${list.length} 桌 · 进行中 ${live} 桌`;
  const box = $('adminList');
  if (!box) return;

  if (!list.length) {
    box.innerHTML = '<div class="admin-empty">现在一桌都没有。玩家开房后会出现在这里。</div>';
    return;
  }

  box.innerHTML = list.map((r) => {
    const state = !r.started ? '等待开局' : r.ended ? '已结束' : `牌局中 · 第 ${r.handNo} 手`;
    const cls = !r.started ? 'wait' : r.ended ? 'over' : 'live';
    const bots = r.bots
      ? (r.botsSeated ? `机器人 ${r.botsSeated} 个在座` : '机器人 开 · 下一手入座')
      : (r.botsSeated ? '机器人 关 · 下一手离座' : '机器人 关');
    return `<div class="admin-row">
      <div class="ar-main">
        <div class="ar-line1">
          <b class="ar-id">${esc(r.id)}</b>
          <span class="ar-state ${cls}">${state}</span>
          ${r.phase && r.phase !== 'WAITING' ? `<span class="ar-phase">${PH_TEXT[r.phase] || r.phase}</span>` : ''}
        </div>
        <div class="ar-line2">
          <span>${esc(r.stake)}</span><i>·</i>
          <span>${r.seatCount} 人桌</span><i>·</i>
          <span>真人 ${r.humans}</span><i>·</i>
          <span>在线 ${r.online}</span>
          ${r.started && !r.ended ? `<i>·</i><span>底池 ${r.pot}</span><i>·</i><span>剩 ${minsText(r.remainMs)}</span>` : ''}
        </div>
        <div class="ar-line3">
          <span>房主 ${esc(r.owner || '—')}</span>
          <span class="ar-bots ${r.bots ? 'on' : ''}">${bots}</span>
        </div>
      </div>
      <div class="ar-act">
        <button class="ar-btn see" data-see="${esc(r.id)}">上帝视角</button>
        <button class="ar-btn bot ${r.bots ? 'on' : ''}" data-bot="${esc(r.id)}" data-on="${r.bots ? '0' : '1'}">${r.bots ? '关机器人' : '开机器人'}</button>
        ${r.ended ? '' : `<button class="ar-btn kill" data-kill="${esc(r.id)}">解散牌桌</button>`}
      </div>
    </div>`;
  }).join('');

  box.querySelectorAll('[data-see]').forEach((b) => {
    b.onclick = () => watchAsGod(b.dataset.see);
  });
  box.querySelectorAll('[data-bot]').forEach((b) => {
    b.onclick = () => {
      sendWS({ t: 'adminBots', room: b.dataset.bot, on: b.dataset.on === '1' });
      b.disabled = true;
      b.textContent = '处理中…';
    };
  });
  // 解散是不可逆的（连数据一起删），做成两段式：先亮红变「确认解散」，3 秒内再点才发
  box.querySelectorAll('[data-kill]').forEach((b) => {
    let armTimer = 0;
    b.onclick = () => {
      if (b.dataset.armed !== '1') {
        b.dataset.armed = '1';
        b.classList.add('armed');
        b.textContent = '确认解散';
        clearTimeout(armTimer);
        armTimer = setTimeout(() => {
          b.dataset.armed = '';
          b.classList.remove('armed');
          b.textContent = '解散牌桌';
        }, 3000);
        return;
      }
      clearTimeout(armTimer);
      sendWS({ t: 'adminClose', room: b.dataset.kill });
      b.disabled = true;
      b.textContent = '解散中…';
    };
  });
}

/** 进某一桌的上帝视角 */
function watchAsGod(roomId) {
  const id = String(roomId || '').trim();
  if (!id) return;
  hideAdminPanel();
  hideLobby();
  net.god = true;
  net.mode = 'online';
  net.roomId = id;
  net.seat = -1;
  net.watching = true;
  state.view = null;
  renderWaiting('正在打开上帝视角…');
  sendWS({ t: 'adminWatch', room: id });
}

/** 退出上帝视角，回开发者控制台 */
function exitGod() {
  sendWS({ t: 'adminLeave' });
}

/** 上帝视角的顶部条：牌堆还剩几张、接下来发什么 */
function paintGodBar(v) {
  const bar = $('godBar');
  if (!bar) return;
  const deck = v.deck || [];
  const next = deck.slice(-7).reverse();   // 牌堆末尾是下一张，一次看 7 张
  const phase = v.phase === 'WAITING' ? '等待开局' : (PH_TEXT[v.phase] || v.phase);
  bar.innerHTML = `
    <div class="gb-top">
      <span class="gb-tag">上帝视角</span>
      <span class="gb-meta">房 ${esc(v.roomId || net.roomId)} · ${phase}${v.handNo ? ` · 第 ${v.handNo} 手` : ''} · 皮池 ${v.potChips || 0}</span>
      <span class="gb-left">牌堆 <b>${deck.length}</b> 张</span>
      <button class="gb-exit" id="gbExit">退出</button>
    </div>
    <div class="gb-deck">
      <span class="gb-lab">接下来</span>
      <div class="gb-cards">${next.map((c, i) => `<span class="gb-slot${i === 0 ? ' next' : ''}">${cardEl(c, { micro: true }).outerHTML}</span>`).join('')}</div>
    </div>
    ${next.length ? '' : `<div class="gb-note">${v.phase === 'WAITING' ? '开局后才有牌' : '牌堆发完了'}</div>`}`;
  bar.querySelector('#gbExit').onclick = exitGod;
}

function enterRoom(id) {
  state.endedShown = false;
  state.endedUntil = 0;
  const code = String(id || '').trim();
  if (!code) return;
  if (code === net.roomId && net.mode === 'online') return;
  net.mode = 'online';
  net.roomId = code;
  net.token = localStorage.getItem(tokenKey(code)) || '';
  net.seat = -1;
  net.watching = true;
  net.joinedOnce = false;
  localStorage.setItem('dh_lastRoom', code);
  history.replaceState(null, '', localRoomUrl(code));
  hideLobby();
  renderWaiting('正在进入房间…');
  sendWS({ t: 'join', room: code, name: currentNick(), token: net.token });
  // v0.22.60：进房顺带拉一次「名下所有房间的待审申请」。以前只在登录 / 收到
  // buyReq 时才拉，人在大厅看到角标再点进房间，myReqs 可能还是旧的，
  // 面板里就空空的。拉完之后由 maybeAutoOpenReqs() 按需把审核面板弹出来。
  state.reqAutoOpen = true;
  sendWS({ t: 'myRequests' });
}

const STAKE_MIN = { 1: 50, 2: 100, 5: 250, 10: 500, 20: 1000, 50: 2500, 100: 5000 };
const STAKE_MANGO = { 1: 2, 2: 5, 5: 10, 10: 20, 20: 40, 50: 100, 100: 200 };
const durText = (m) => (m === 30 ? '30 分钟' : m === 60 ? '1 小时' : m === 90 ? '1.5 小时' : '2 小时');
const pickedSeats = () => Number(document.querySelector('.seat-opt.on')?.dataset.seats || 8);
const pickedAnte = () => Number(document.querySelector('.stake-opt.on')?.dataset.ante || 10);
const pickedDur = () => Number(document.querySelector('.dur-opt.on')?.dataset.min || 60);

/* ── v0.22.39：最低可玩簸簸 = 底皮 × n（开房页横向刻度拉条）──
 * n ∈ 4 / 6 / 8 / 10 / 12 / 16，默认 ×8；低于「底皮 × n」的座位
 * 下一手不发牌、强制留座（180 秒读秒，带入或到点离座）。 */
const FLOOR_MULTS = [4, 6, 8, 10, 12, 16];
const FLOOR_KEY = 'dh_floor_mult';   // 记住上次的档位
const pickedFloorIdx = () => Number($('floorRange')?.value ?? 2);
const pickedFloorMult = () => FLOOR_MULTS[pickedFloorIdx()] || 8;

/* ── v0.22.67：地九王开关（开房页，默认开） ──────────────────────
 * 关掉后本桌 2+9 按 1 点散牌算，桌面「地九王」铭牌隐藏。
 * 这是房间级规则，开房后不可改；选择记住上次，老用户默认开。 */
const DIJIU_KEY = 'dh_dijiu_on';
const pickedDijiu = () => $('dijiuOpt')?.classList.contains('on') !== false;
function restoreDijiu() {
  const btn = $('dijiuOpt');
  if (!btn) return;
  let on = true;   // 系统默认开
  try {
    const saved = localStorage.getItem(DIJIU_KEY);
    if (saved !== null) on = saved !== '0';
  } catch { /* 存储不可用就按默认开 */ }
  paintDijiu(on);
}
function paintDijiu(on) {
  const btn = $('dijiuOpt');
  if (!btn) return;
  btn.classList.toggle('on', on);
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  btn.lastChild.textContent = on ? '地九王：开' : '地九王：关';  // 只改文字,保留 <i> 圆点
  const hint = $('dijiuHint');
  if (hint) hint.textContent = on ? '2 + 9 算地九王' : '2 + 9 算 1 点';
}
function paintFloorHint() {
  const hint = $('floorHint');
  if (hint) {
    const val = (pickedAnte() || 10) * pickedFloorMult();
    hint.textContent = `低于 ${val.toLocaleString()} 强制留座`;
  }
  document.querySelectorAll('.floor-ticks i').forEach((i) =>
    i.classList.toggle('on', Number(i.dataset.i) === pickedFloorIdx()));
}

/** 房间设置页底部的一行摘要：看清这桌到底多大、开桌要多少钻 */
function paintCreateSum() {
  const box = $('createSum');
  if (!box) return;
  const seats = pickedSeats();
  const ante = pickedAnte();
  const dur = pickedDur();
  const minBuy = STAKE_MIN[ante] || 500;
  const mango = STAKE_MANGO[ante] || ante * 2;
  const fee = createCost(dur);
  box.innerHTML = `
    <div class="cs-row">
      <span><i>人数</i>${seats} 人桌</span>
      <span><i>时长</i>${durText(dur)}</span>
      <span><i>底皮 / 圈芒</i>${ante} / ${mango}</span>
      <span><i>起带</i>${minBuy.toLocaleString()}</span>
      <span><i>开桌</i><b class="cs-gem"><span class="dm"></span>${fee}</b></span>
    </div>`;
  const btn = $('btnCreate');
  if (btn) btn.innerHTML = `创建房间<em class="btn-cost"><span class="dm"></span>${fee}</em>`;
}

/** 主界面 → 房间设置（第二层） */
function showCreateSheet() {
  currentNick();
  paintCreateSum();
  showLobby('create');
  lobbyTip('');
}

/** 主界面 → 加入房间（第二层） */
function showJoinSheet() {
  currentNick();
  showLobby('join');
  const from = (PARAMS.get('from') || '').trim();
  lobbyTip(from ? `${from} 喊你来打牌` : '');
  if (from) {
    const tip = $('joinTip');
    if (tip) tip.textContent = `${from} 喊你来打牌`;
  }
  clearCode();
  setTimeout(() => focusCode(0), 60);
}

/* ── 房号：四格分开输入 ──────────────────────────
 * 每格一位，填完自动跳下一格；退格空格时回到上一格；
 * 从别处复制「1234」粘贴进来会自动拆到四格。 */
function codeCells() {
  return [...document.querySelectorAll('.code-cell')];
}
function codeDigits() {
  return codeCells().map((el) => el.value).join('');
}
function clearCode() {
  codeCells().forEach((el) => { el.value = ''; el.classList.remove('filled'); });
}
function focusCode(i) {
  const list = codeCells();
  const el = list[Math.max(0, Math.min(list.length - 1, i))];
  if (!el) return;
  el.focus();
  try { el.select(); } catch { /* 部分 WebView 不支持 select */ }
}
function paintCodeCells() {
  codeCells().forEach((el) => el.classList.toggle('filled', !!el.value));
}

function doCreate() {
  // v0.21.5：服务端不再放行匿名开房，登录态没了就直接回登录页，别让玩家点了没反应
  if (!acct.token || !acct.user) {
    lobbyTip('登录已过期，重新登录后再开桌', true);
    showGate('登录已过期，请重新登录');
    return;
  }
  const nick = currentNick();
  const seats = pickedSeats();
  const ante = pickedAnte();
  const durationMin = pickedDur();
  const fee = createCost(durationMin);
  if (acct.user && (acct.user.diamonds || 0) < fee) {
    lobbyTip(`钻石不够：${durText(durationMin)}的房要 ${fee} 钻，你现在有 ${acct.user.diamonds || 0} 钻`, true);
    return;
  }
  if (net.creating) return;
  net.creating = true;
  const fair = fairPicked();
  const fire = (fairGeo) => {
    lobbyTip(`正在开桌…（${fee} 钻）`);
    const ok = sendWS({
      t: 'create', name: nick, seats, ante, durationMin,
      fairIp: fair.ip, fairDev: fair.dev, fairGeo,
      floorMult: pickedFloorMult(),   // v0.22.39：最低可玩簸簸 = 底皮 × n
      dijiuOn: pickedDijiu(),         // v0.22.67：地九王开关（关掉后 2+9 算 1 点）
    });
    if (!ok) lobbyTip('还没有连上服务器，稍等一下再点', true);
    net.creating = false;
  };
  // 开了「100 米内」才去要定位；拿不到就降级成不开这一项，并说清楚
  if (fair.geo) {
    lobbyTip('正在获取位置…');
    ensureGeo().then((c) => {
      if (!c) lobbyTip('没拿到定位，本桌「100 米内」这一项不会生效（不影响开房）', true);
      fire(!!c);
    });
    return;
  }
  fire(false);
}

function doJoin() {
  const code = codeDigits();
  if (!/^\d{4}$/.test(code)) {
    lobbyTip('房号是 4 位数字，问一下房主', true);
    return;
  }
  currentNick();
  lobbyTip('');
  enterRoom(code);
}

function doStart() {
  sendWS({ t: 'start' });
}

function doQuit() {
  // 走到这里的入口（菜单已置灰拦截、结算页、等待室）都是可退场景；
  // 带 force 避免快照竞态下服务端把合法退出误判为"持牌退出"。
  sendWS({ t: 'leave', force: true });
  backToLobby();
}

function backToLobby(page = 'home') {
  net.mode = 'lobby';
  net.roomId = '';
  net.seat = -1;
  net.watching = false;
  net.isOwner = false;
  state.view = null;
  state.game = null;
  state.seatEls = null;          // v0.22.35：离开房间时连 DOM 复用缓存一起清
  state.endedShown = false;
  state.endedUntil = 0;
  clearStatsState();             // v0.22.79：离房即清战绩底稿，别带到下一桌
  clearInterval(timeTimer);
  timeTimer = null;
  clearInterval(state.endTimer);
  state.endTimer = null;
  history.replaceState(null, '', localRoomUrl(null));
  if (page === 'join') showJoinSheet(); else renderLobbyHome();
}

function copyInvite() {
  const link = inviteLink(net.roomId);
  const done = () => toast(`房号 ${net.roomId} 的邀请链接已复制`);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(link).then(done).catch(() => fallbackCopy(link, done));
  } else {
    fallbackCopy(link, done);
  }
}
/** 中央信息栏的「房间号」按钮：只复制 4 位数字，方便念给旁边的人 */
function copyRoomNo() {
  const id = String(net.roomId || '').trim();
  if (net.mode !== 'online' || !id) { toast('还没进房间'); return; }
  const done = () => toast(`房号 ${id} 已复制`);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(id).then(done).catch(() => fallbackCopy(id, done));
  } else {
    fallbackCopy(id, done);
  }
}
function fallbackCopy(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); done(); } catch { toast(`复制失败，手动记下房号 ${net.roomId}`); }
  ta.remove();
}

/* v0.22.1：座位 DOM 复用。
   原来每次收到快照就把整层 seatLayer 清空重建——8 人桌一次要新建两百多个节点、
   重设一遍头像 <img>，一台中低端安卓机单帧要 20~40ms，牌局每秒又推 2~3 次，
   于是牌面动画一顿一顿、点按要排队。这里给每个座位算一枚「结构签名」，
   签名没变就原样留着，只让倒计时文字走 tick 更新。 */
/* v0.22.3：明暗、头尾一律按牌的身份认，不再数第几张。
   分牌归组后明牌可能排到前两位，服务端给了 viewHole（与 cardsView 一一对应）
   以及 headIds/tailIds。老服务端没给这些字段时回退按位置切，
   免得服务器升级包与前端热更包不同步的那几分钟里摆错牌。 */
function cardFlags(p) {
  const vh = Array.isArray(p.viewHole) ? p.viewHole : null;
  const head = new Set(p.headIds || []);
  const tail = new Set(p.tailIds || []);
  return {
    isHole: (c, i) => (vh ? !!vh[i] : i < 2),
    role: (c) => (c && head.has(c.id)) ? 'head'
      : (c && tail.has(c.id)) ? 'tail' : '',
  };
}

/** 最后发出的那张明牌（第 4 张）现在亮着没有：按牌 id 找，归组后位置变了也认得对 */
function lastOpenCard(p) {
  if (!p) return null;
  const cv = p.cardsView || [];
  const ids = p.openIds || [];
  const lastId = ids[ids.length - 1];
  if (!lastId) return cv.length >= 4 ? cv[3] : null;   // 老服务端回退按位置
  return cv.find((c) => c && c.id === lastId) || null; // 被扣住时这里是 null
}

function seatSig(p, v) {
  const cv = (p.cardsView || []).map((c) => (c ? c.id : '·')).join(',');
  return [
    v.phase, v.handNo, v.viewerSeat, v.currentSeat, v.ownerSeat, v.god ? 1 : 0,
    v.seats.length,
    p.seat, p.name, p.avatar, p.isAI ? 1 : 0, p.isBanker ? 1 : 0,
    p.folded ? 1 : 0, p.knocked ? 1 : 0, p.shortKnock ? 1 : 0,
    p.special || '', p.emperor ? 1 : 0, p.showHand ? 1 : 0,
    p.away ? 1 : 0, p.hold ? 1 : 0, p.holdLeave ? 1 : 0, p.broke ? 1 : 0,
    p.asking ? 1 : 0, p.joinNext ? 1 : 0, p.allIn ? 1 : 0, p.mine ? 1 : 0,
    p.split ? 1 : 0, p.inHand ? 1 : 0,
    (p.scratchLeft || 0) > 0 ? 1 : 0,
    p.stack, p.paid || 0, p.bet || 0, p.pending || 0,
    v.phase === PHASE.SETTLED ? (p.delta || 0) : 0,
    p.lastAction || '', p.brokeSince || 0, p.holdSince || 0,
    cv,
    (p.viewHole || []).map((x) => (x ? 1 : 0)).join(''),
    (p.headIds || []).join(','), (p.tailIds || []).join(','),
  ].join('|');
}

function renderSeats() {
  const v = state.view;
  const layer = $('seatLayer');
  const cache = state.seatEls || (state.seatEls = new Map());
  const alive = new Set();
  let rebuilt = 0;   // 这一帧真正新建了几个座位：没有就不用再量一遍布局
  const many = v.seats.length > 4;
  stage.classList.toggle('crowded', many);
  // 还没坐下的人才能点空位；开发者只看牌，不占座
  const canSit = v.viewerSeat < 0 && !v.god;
  const POS = posFor(v.seats.length);

  // 分牌倒计时：以进入分牌那一刻为基准，本手只校准一次，避免每次推送都跳秒
  if (v.phase === PHASE.SPLIT) {
    const key = `${v.handNo}:${v.splitAt || 0}`;
    if (state.splitKey !== key) {
      state.splitKey = key;
      state.splitSince = Date.now() - (SPLIT_SECONDS - (v.splitLeft ?? SPLIT_SECONDS)) * 1000;
    }
  } else if (state.splitKey) {
    state.splitKey = null;
  }
  const needSplit = (p) => v.phase === PHASE.SPLIT && p.inHand && !p.folded
    && !p.special && !p.emperor && !p.split;

  for (const p of v.seats) {
    if (p.seat === v.viewerSeat) continue;
    const at = POS[disp(p.seat)];
    if (!at) continue;

    // 空位（没人坐、也没机器人）：摆在牌桌上，点一下直接坐
    if (p.vacant) {
      const pendHere = v.pendingSeat === p.seat;
      const key = 'v' + p.seat;
      const sig = `v|${p.seat}|${canSit ? 1 : 0}|${pendHere ? 1 : 0}|${v.seats.length}`;
      const old = cache.get(key);
      if (old && old.dataset.sig === sig) { alive.add(key); continue; }
      if (old) { old.remove(); cache.delete(key); }
      const empty = document.createElement('button');
      empty.className = 'seat empty-seat' + (pendHere ? ' pend' : '');
      empty.style.left = at.x + 'px';
      empty.style.top = at.y + 'px';
      empty.dataset.seat = p.seat;
      empty.dataset.sig = sig;
      empty.innerHTML = `<span class="es-plus">+</span>
        <span class="es-no">${p.seat + 1} 号位</span>`;
      if (canSit) empty.onclick = () => sitSeat(p.seat);
      else empty.classList.add('locked');
      cache.set(key, empty);
      alive.add(key);
      layer.appendChild(empty);
      rebuilt++;
      continue;
    }

    // 结构签名没变：直接留用上一次建好的节点，连头像都不重设
    const seatKey = 's' + p.seat;
    const sig = seatSig(p, v);
    const oldSeat = cache.get(seatKey);
    if (oldSeat && oldSeat.dataset.sig === sig) { alive.add(seatKey); continue; }
    if (oldSeat) { oldSeat.remove(); cache.delete(seatKey); }

    const el = document.createElement('div');
    el.dataset.sig = sig;
    el.className = 'seat';
    el.dataset.seat = p.seat;
    el.style.left = at.x + 'px';
    el.style.top = at.y + 'px';
    // 朝底池的方向：下注数字固定贴在头像靠桌子中心那一侧
    const dx = at.x - TABLE_CX;
    const dy = at.y - TABLE_CY;
    // 左右优先：只要横向偏离够大就算侧位，免得 45° 的座位被判成「上/下」导致牌插错边
    el.dataset.dir = Math.abs(dx) >= Math.abs(dy) * 0.7
      ? (dx < 0 ? 'W' : 'E')
      : (dy < 0 ? 'N' : 'S');
    if (p.folded) el.classList.add('folded');
    if (v.phase === PHASE.BET && v.currentSeat === p.seat) el.classList.add('turn');

    const av = avatarEl(p.name, p.isAI ? 'ai' : '', p.avatar);
    // v0.20.52：点「我」的头像不再弹任何窗（ID / 钻石已常驻左上角）。
    // 只有别人的头像才挂资料卡与点击热区；自己的头像连热区都不加，
    // 免得点到自己座位也误触发。
    const mineUid = acct.user ? String(acct.user.id) : '';
    const isMe = !!p.mine || p.seat === v.viewerSeat
      || (!!mineUid && String(p.uid || '') === mineUid);
    if (isMe) {
      av.classList.add('no-tap');
    } else {
      av.classList.add('can-tap');
      av.addEventListener('click', (ev) => {
        ev.stopPropagation();
        openPlayerCard(p);
      });
    }
    // v0.20.19：头像点击热区——罩住头像+底牌，点在底牌上也能打开资料卡。
    // 围观时可入座的 AI 座位不加（那个座位的点击是排队坐下）。
    if (!isMe && !(p.isAI && v.viewerSeat < 0 && !v.god)) {
      const hit = document.createElement('span');
      hit.className = 'seat-hit';
      hit.addEventListener('click', (ev) => {
        ev.stopPropagation();
        openPlayerCard(p);
      });
      el.appendChild(hit);
    }
    // 刚被表情砸中：头像抖两下
    const hitUntil = state.emoteHit.get(p.seat);
    if (hitUntil && hitUntil > Date.now()) el.classList.add('shake');
    if (p.holdLeave && p.holdLeft > 0) {
      // 保位离桌：和「筹码耗尽」同一种留座读秒，读完自动让座
      el.classList.add('broke');
      el.appendChild(ringEl(p.holdSince));
    } else if (p.broke) {
      el.classList.add('broke');
      if (p.asking) el.appendChild(tag('等审核', 'join'));
      else if (!p.waitBuyIn) el.appendChild(ringEl(p.brokeSince, p.sitHold ? SIT_HOLD_SECONDS : BROKE_SECONDS));   // 环挂在头像外层，免得被圆角裁掉；占座 15 秒档随节点走
    } else if (needSplit(p) && !(p.scratchLeft > 0)) {
      // 还没分牌：头像上转 15 秒读秒，到 0 自动按最优分法
      // 正在搓牌就先让位，别和搓牌倒计时在同一个头像上打架
      el.classList.add('cd-split');
      el.appendChild(ringEl(state.splitSince, SPLIT_SECONDS, 'split'));
    }
    el.appendChild(av);
    // 敲了（簸簸推满）：头像外圈点一把火，跟着牌局一直烧到结算
    if (p.knocked && !p.folded && (v.phase === PHASE.BET || v.phase === PHASE.SPLIT)) {
      el.classList.add('knocked');
      el.appendChild(Object.assign(document.createElement('span'), { className: 'fire-halo' }));
    }
    // 庄位：压在头像右上边框上的红色徽标（见参考图，比名字行里的小标签醒目）
    if (p.isBanker) {
      const badge = document.createElement('span');
      badge.className = 'dealer-badge';
      badge.textContent = '庄';
      el.appendChild(badge);
    }
    // 轮到他说话：头像外圈绿条 + 头像正中读秒（正在搓牌就换成搓牌倒计时）
    if (v.phase === PHASE.BET && v.currentSeat === p.seat && !p.folded && !(p.scratchLeft > 0)) {
      el.appendChild(turnClockEl(state.turnSince || Date.now()));
    }
    // 搓牌中：头像外框走 10 秒倒计时，头像里写「搓牌中」
    if (p.scratchLeft > 0) {
      el.classList.add('cd-scratch');
      const since = Date.now() - (SCRATCH_SEC - p.scratchLeft) * 1000;
      // 注意 tone 别用 'scratch'：会和全屏搓牌层的 .scratch 撞类名
      el.appendChild(ringEl(since, SCRATCH_SEC, 'scrubbing'));
      const tagEl = document.createElement('span');
      tagEl.className = 'scratch-tag';
      tagEl.textContent = '搓牌中';
      el.appendChild(tagEl);
    }

    const nm = document.createElement('div');
    nm.className = 'nm';
    nm.textContent = p.name || '';
    const addTag = (text, cls) => {
      const e = document.createElement('em');
      e.textContent = text;
      if (cls) e.className = cls;
      nm.appendChild(e);
    };
    if (v.ownerSeat === p.seat) addTag('房主', 'owner');
    // v0.21.2：机器人是房间补位的电脑玩家，不是注册账号，也没有钻石；
    // 名字后挂个标，和真人分开（原来只靠头像降饱和，几乎看不出来）
    if (p.isAI) addTag('机器人', 'ai');
    // 强制秀牌：本手四张对全桌明牌，名字后面挂个小标，别让人以为是漏发了
    if (p.showHand && p.seat !== v.viewerSeat) addTag('已秀牌', 'show');
    el.appendChild(nm);

    if (p.away) {
      el.classList.add('away');
      el.appendChild(tag('离座', 'away'));
    } else if (p.holdLeave) {
      const left = p.holdLeft != null ? p.holdLeft : v.holdSeconds;
      // v0.22.1：剩余秒不再进结构签名（否则每秒重建一次座位），改由 tick 刷新
      const t = tag(`保位 ${left}s`, 'join');
      t.dataset.cd = 'hold';
      t.dataset.since = String(p.holdSince || 0);
      el.appendChild(t);
    } else if (p.broke) {
      // 停牌留座：这一手不发牌，头顶挂倒计时，别让人以为只是没轮到
      // v0.22.24：差钱停发的座位把「簸簸不足抢芒」挂进标签里，一眼看出原因
      // v0.22.88：等待室没点带入是「占座 15s」；点了带入按钮（或开局后输光）是「留座 180s」
      const sitHold = !!p.sitHold;
      const label = sitHold ? '占座' : '留座';
      const total = sitHold ? SIT_HOLD_SECONDS : BROKE_SECONDS;
      const left = p.brokeLeft != null ? p.brokeLeft : total;
      const tip = p.shortTip ? `${p.shortTip} · ` : '';
      if (p.waitBuyIn) {
        // v0.22.96：房主占座不设时限——挂「等带入」静态牌，不再显示误导的「占座 0s」
        el.appendChild(tag(`${tip}等带入`, 'join'));
      } else {
        const t = tag(`${tip}${label} ${left}s`, 'join');
        t.dataset.cd = 'broke';
        t.dataset.since = String(p.brokeSince || 0);
        t.dataset.total = String(total);
        t.dataset.label = label;
        el.appendChild(t);
      }
    } else if (p.joinNext) {
      el.appendChild(tag('下一手入场', 'join'));
    }

    // 簸簸只留数字（不再写「簸」字）
    if (!p.away) {
      const nums = document.createElement('div');
      nums.className = 'nums';
      const dlt = v.phase === PHASE.SETTLED && p.delta
        ? `<span class="delta-in ${p.delta > 0 ? 'win' : 'lose'}">${p.delta > 0 ? '+' : ''}${p.delta}</span>`
        : '';
      // v0.22.49：簸簸改回「动态剩余可行动金额」——只显示剩余簸簸，
      // 本手已交的底皮/芒果份子不再加回显示（那部分已经进了池子）。
      // v0.22.50：开手演出期间，把「已扣未入池」的部分先加回显示，
      // 随筹码逐笔落池再减回去。敲（梭哈）后 stack 归零就显示 0。
      const fxHid = state.handFx ? (state.handFx.hidden.get(p.seat) || 0) : 0;
      const capShown = ((p.stack ?? 0) + fxHid) > 0 ? (p.stack ?? 0) + fxHid : 0;
      nums.innerHTML = `<div class="wrap"><span class="cap">${capShown}</span>${dlt}</div>`
        + (p.pending > 0 ? `<span class="pending">+${p.pending} 待入账</span>` : '');
      el.appendChild(nums);
    }

    // 这一手下的注：单独一块，贴在朝底池那一侧
    // v0.22.55：演出期间金额由 fx.betShown 接管（份子→底皮），归拢后随演出消失
    const fxBet = state.handFx ? state.handFx.betShown.get(p.seat) : null;
    const betNum = fxBet != null ? fxBet : p.bet;
    if (!p.away && betNum > 0 && v.phase !== PHASE.SETTLED) {
      const b = document.createElement('div');
      b.className = 'bet-chip';
      b.textContent = betNum;
      el.appendChild(b);
    }

    // 头像上的操作标记：敲 / 休 / 大 / 跟 / 丢
    // v0.22.87：牌局暂停（全场停牌·等人）或整场等待开局时不挂任何气泡——
    // 上一手的动作残留不能滞留在画面上，恢复后按正常生命周期亮起/熄灭。
    const bubblesOff = v.phase === 'WAITING' || !!v.dealHold;
    const ACT_TAG = { fold: ['丢', 'fold'], knock: ['敲', 'knock'], raise: ['大', 'big'], follow: ['跟', 'follow'], pass: ['休', 'pass'] };
    if (bubblesOff) { /* 暂停 / 停牌：头像上方保持干净 */ }
    else if (v.phase !== PHASE.SETTLED && p.shortKnock) el.appendChild(tag('搭不动', 'short'));
    else if (v.phase !== PHASE.SETTLED && p.special) el.appendChild(tag(p.special, 'special'));
    else if (v.phase !== PHASE.SETTLED && p.emperor) el.appendChild(tag(EMPEROR_NAME[p.emperor] || '通杀', 'special'));
    // 分牌阶段：跟参考图一样，头像上方挂「分牌中 / 已分牌」胶囊
    else if (v.phase === PHASE.SPLIT && p.split) el.appendChild(tag('已分牌', 'split-done'));
    else if (v.phase === PHASE.SPLIT && needSplit(p) && !(p.scratchLeft > 0)) el.appendChild(tag('分牌中', 'split-wait'));
    // 结算那一下，上方位置留给输赢浮额，别再叠一个「丢 / 跟」气泡
    else if (v.phase === PHASE.SETTLED) { /* 空 */ }
    else if (p.folded) el.appendChild(tag('丢', 'fold'));
    else if (p.knocked) el.appendChild(tag('敲', 'knock'));
    else if (ACT_TAG[p.lastAction]) el.appendChild(tag(...ACT_TAG[p.lastAction]));

    if (v.phase === 'WAITING') {
      cache.set(seatKey, el);
      alive.add(seatKey);
      layer.appendChild(el);
      continue;
    }

    const settledNow = v.phase === PHASE.SETTLED;
    // 这一手的摊牌已经收走（飞回牌心）了：申请带入、审核通过、每秒广播都会重渲染，
    // 不能再用快照里的手牌把已经消失的摊牌重新摆回桌上
    const swept = settledNow && state.sweptHand === v.handNo;
    const view = swept ? [] : (p.cardsView || []);
    // v0.22.3：按身份切明暗——分牌归组后明牌可能排在前两位，不能再 view.slice(2)
    const { isHole } = cardFlags(p);
    const holeView = view.filter((c, i) => isHole(c, i));
    const openView = view.filter((c, i) => !isHole(c, i));
    // 摊牌时牌按「头两张 / 尾两张」排，这里给出两组各自的大小（8 点 / 对子 / 丁皇…）
    // 已经收过牌（sweepHand === 本手）就不要再建，免得重渲染把标注又摆回桌上
    const pts = settledNow && p.split && !swept && state.sweepHand !== v.handNo
      ? [pairLabel(p.split.head), pairLabel(p.split.tail)]
      : null;
    // 这一手压根没发牌（留座 / 未带入 / 已离座）；收牌后不算「没发牌」，别再挂文字
    const noCards = !(p.cardsView || []).length;
    const common = {
      small: true,
      dim: p.folded,
      fromX: (SHOE_X - at.x) * 0.92,
      fromY: (SHOE_Y - at.y) * 0.92,
    };

    // 两张底牌一直贴在头像边角；只有比牌那一刻才收下来，跟明牌排成一排
    if (!swept && (!settledNow || !view.length)) {
      const hole = document.createElement('div');
      hole.className = 'cards peek';
      layoutCards(hole, holeView, {
        ...common, part: 'hole', key: `${v.handNo}:s${p.seat}:hole`,
        placeholder: !noCards, animate: !settledNow,
      });
      el.appendChild(hole);
    }

    const cards = document.createElement('div');
    cards.className = 'cards';
    layoutCards(cards, settledNow ? view : openView, {
      ...common,
      key: `${v.handNo}:s${p.seat}:live`,
      startAt: settledNow ? 0 : 2,
      settled: settledNow,
      points: pts,
      placeholder: false,
      animate: !settledNow,
    });
    if (noCards && !swept) {
      // 留座 / 未入局：一张牌都不发，也不留空框
      const txt = p.away ? '已离座' : p.broke ? '' : (p.joinNext ? '下一手入场' : '未入局');
      if (txt) {
        const none = document.createElement('span');
        none.className = 'seat-noin';
        none.textContent = txt;
        cards.appendChild(none);
      }
    }
    el.appendChild(cards);

    if (v.phase === PHASE.SETTLED) el.classList.add('showdown');

    // 机器人占着的座位：围观的人点一下排队坐下，这一手结束入座
    if (p.isAI && !p.vacant && v.viewerSeat < 0 && !v.god) {
      el.classList.add('can-sit');
      el.appendChild(tag('可入座', 'sit'));
      el.onclick = () => sitSeat(p.seat);
    }

    cache.set(seatKey, el);
    alive.add(seatKey);
    layer.appendChild(el);
    rebuilt++;
  }
  // 座位数变少 / 自己移位：把没再出现的旧节点摘掉
  for (const [k, el] of cache) {
    if (!alive.has(k)) { el.remove(); cache.delete(k); }
  }
  // 兜底：不在缓存里的节点（异常路径建出来的）一律收走，免得越积越多
  const live = new Set(cache.values());
  for (const child of [...layer.children]) if (!live.has(child)) child.remove();
  // 只有新建过节点才需要重新量位置；纯数字变化（每秒几十次推送）不必强制布局
  if (rebuilt) {
    placeSeatTags(layer);
    alignWestOpenCards();
  }
  // v0.20.53：座位 DOM 重建后把「正在说话」的波纹补回去（复用节点时也顺手校正）
  applyVoiceSpeakers();
}

/* 行动 / 状态气泡：v0.20.49 起统一挂在昵称正上方，与昵称间隔 2px。
 * 气泡水平居中（CSS 里 translateX(-50%)），垂直方向按昵称实际高度算：
 * 昵称底边固定 -43，顶边 = -(43 + 名字高)，气泡底边再往上让 2px。
 * 这样 20px 的 8 人桌小名字和 30px 的 4 人桌大名字都不会顶到或压住。 */
const TAG_GAP = 2;          // 气泡与昵称的间隔
const NM_BOTTOM = 43;       // .nm 的 bottom 相对座位中心的距离（CSS: top:-43 + translateY(-100%)）
function placeSeatTags(layer) {
  layer.querySelectorAll('.seat').forEach((el) => {
    const tags = el.querySelectorAll(':scope > .tag');
    if (!tags.length) return;
    const nmEl = el.querySelector('.nm');
    const nmH = nmEl ? nmEl.offsetHeight : 31;   // 没有名字（空座）时退成 8 人桌的一行高
    const top = -(NM_BOTTOM + nmH + TAG_GAP);
    tags.forEach((t) => { t.style.top = `${top}px`; });
  });
}

/* 左列（W）的第三、第四张明牌整体向左让开桌心：
 * 发第三张时就往左挪，第四张接着往右排，同一列上下三家的牌都贴着左桌沿起步；
 * 挪多少按「离桌沿还有多远」算，最多 1.5 个牌宽，绝不把牌推出画面。
 * 比牌的左右位置不动（仍由 CSS 的 settled-cards 规则摆），只是上沿也跟明牌一样贴齐簸簸。 */
function alignWestOpenCards() {
  const board = document.querySelector('#stage .board') || stage;
  const base = board.getBoundingClientRect();
  const s = state.scale || 1;
  document.querySelectorAll('#seatLayer .seat[data-dir="W"]').forEach((el) => {
    const box = el.querySelector('.cards.open-cards');
    if (!box) return;
    box.style.transform = '';
    const r = box.getBoundingClientRect();
    const leftInBoard = (r.left - base.left) / s;      // 牌组左边缘在牌桌上的位置
    const cardW = box.firstElementChild
      ? box.firstElementChild.getBoundingClientRect().width / s
      : 0;
    // 目标：贴到离桌沿 10px（留出圆角和投影）；最多挪 1.5 个牌宽
    const shiftBoard = Math.min(leftInBoard - 10, cardW * 1.5);
    if (shiftBoard <= 1) return;
    // .seat 里还套了一层 scale(.9)，写回 CSS 时要除回去
    box.style.transform = `translateX(calc(-50% - ${(shiftBoard / 0.9).toFixed(1)}px))`;
  });
}

/* 一组牌的大小：散牌显示「8 点」，特殊牌型显示「对子」「丁皇」这类名字
   v0.22.67：2+9 组合名称随地九王开关——开=「地九王」（服务端正式名叫"地王"），
   关=服务端已判成散牌 1 点 → 走 detail 显示「1 点」。摊牌/分牌/回顾三处共用。 */
function pairLabel(e) {
  if (!e) return '';
  if (e.name === '地王') return '地九王';
  if (e.detail) return e.detail;
  if (e.tier === 0) return `${Math.floor((e.tie || 0) / 1000)} 点`;
  return e.name || '';
}

function tag(text, cls) {
  const t = document.createElement('div');
  t.className = 'tag ' + cls;
  t.textContent = text;
  return t;
}

/* ── 牌组布局：扇形斜插在头像右下，新牌从桌心飞入并出声 ──
 * dealtSeen 记住每个座位这一手已经播到第几张，state 每推一次不会重播。 */
const dealtSeen = new Map();
/** 第三、四张「飞入」的起点：占位牌背出现时就记，之后重渲染都从这里续上 */
const flipAt = new Map();
/** 第三、四张「翻面」的起点：真牌到手才记。搓牌占位时牌背已经在桌上，
 *  不能拿飞入起点当翻面起点，否则牌会从桌心又飞一遍（v0.20.44 修） */
const turnAt = new Map();
/** v0.20.51：这一手已经以「牌背占位」出现过的牌（第四张被扣着 / 搓牌中）。
 *  真牌到手时只补翻面，绝不再飞一次 —— 否则同一张牌看着发了两次 */
const placeholderSeen = new Set();
/* 飞入动画（flipFly）到 38% 就落位了，1.08 秒的最短档也才 0.68 秒。
 * 超过这个时长还去挂 flipFly，等于把牌从落点又拖回半空重飞一遍。 */
const FLY_MS = 700;
/* v0.20.43：整张牌绕纵向中轴翻面（牌背在前、牌面在后）。
 * 中段 90°（牌垂直桌面、只剩一条线）靠 flipSpin 的曲线快速掠过，
 * 不多给帧，才不会看着像牌突然消失。
 * 这里只负责盖一层牌背、把时长/起始点交给 CSS。 */
const TURN_MS = 600;        // 翻转本身固定 0.6 秒（对齐参考视频），不跟着发牌时长漂
const TURN_AT = 0.5;        // 牌飞到位（38%）之后再停一会儿才起翻

/* 把已有的牌面内容挪进 .flip-face，再套一层 3D 容器：
 *   .card.spin > .flip-inner > (.flip-face | .flip-back)
 * 牌面内容仍相对同一块矩形定位，尺寸、角标位置都不用改。 */
function wrapFlip(el, back) {
  // 已经包过就别再套一层（同一元素被重复渲染时）
  for (const ch of el.children) if (ch.classList.contains('flip-inner')) return;
  const inner = document.createElement('div');
  inner.className = 'flip-inner';
  const face = document.createElement('div');
  face.className = 'flip-face';
  while (el.firstChild) face.appendChild(el.firstChild);
  inner.appendChild(face);
  if (back) inner.appendChild(back);
  el.appendChild(inner);
  el.classList.add('spin');
}

function makeFlipBack() {
  const back = document.createElement('div');
  back.className = 'flip-back';
  /* v0.20.51：牌背的「宽窄」和内框改由 CSS 伪元素画，跟 .card.back 共用同一套规则，
   * 不再单独插一个 .flip-logo —— 两份文字会叠在一起，字号还各写一套。 */
  return back;
}

/* 记下「这张牌已经飞进来」的时刻。搓牌期间第四张是 null（牌背占位），
 * 那时就把起点钉住，等真牌到手只补翻面，不再重飞。 */
function markDealt(key) {
  if (!flipAt.has(key)) flipAt.set(key, Date.now());
  return flipAt.get(key);
}

function applyFlip(el, key, dur = 1680) {
  const now = Date.now();
  const at = markDealt(key);
  const gone = now - at;
  const hadTurn = turnAt.has(key);
  // 牌早就翻完了（隔了好几秒的重渲染）：不用再包 3D，直接当普通牌面
  if (gone >= dur * 2 && hadTurn) return;

  /* v0.20.51：这张牌要不要再「飞」一次？
   *   · 之前以牌背占位出现过（第四张被扣着 / 搓牌中）→ 不再飞，只补翻面
   *   · 已经过了落位段（FLY_MS）→ 也不再飞，否则牌会从落点倒回半空
   * 以前只有负 delay 兜着，占位牌背刚摆上桌就搓开时 gone 还落在飞入段里，
   * 于是同一张牌被飞了第二遍，且两次牌背的字号还不一样。 */
  const wasPlaceholder = placeholderSeen.delete(key);
  if (!wasPlaceholder && gone < FLY_MS) {
    el.style.setProperty('--flip-dur', `${dur}ms`);
    el.classList.add('flip');
    if (gone > 0) el.style.animationDelay = `${-gone}ms`;
  }

  const start = Math.min(dur * TURN_AT, dur - TURN_MS - 70);
  let ta = turnAt.get(key);
  if (ta == null) {
    // 真牌比「牌落位那一刻」来得晚（搓牌占位 / 补牌）：就从此刻起翻；
    // 正常发牌则按原节奏，等牌飞到位置再起翻。
    ta = (wasPlaceholder || gone > start + 40) ? now : at + start;
    turnAt.set(key, ta);
  }
  const turnGone = now - ta;
  el.style.setProperty('--turn-dur', `${TURN_MS}ms`);
  el.style.setProperty('--turn-delay', `${Math.round(-turnGone)}ms`);
  wrapFlip(el, turnGone >= TURN_MS ? null : makeFlipBack());
  cutBackFace(el, turnGone);
}

/* v0.20.44：iOS / 微信的 WebKit 不认 backface-visibility —— 转到 180° 牌背仍然朝前，
   镜像的「窄宽」盖在牌面上，看着像又发了一次牌、牌背还不一样。
   所以到 90°（牌侧立、宽度为 0）那一刻手动把牌背关掉、牌面打开。
   用一次性的 visibility 赋值，不用 CSS 动画：动画会让牌面变成合成层、被拍平，
   牌面就不跟着 3D 转了（会「啪」地满宽出现）。 */
function cutBackFace(el, turnGone) {
  const inner = el.firstElementChild;
  if (!inner || !inner.classList.contains('flip-inner')) return;
  const face = inner.firstElementChild;
  const back = inner.lastElementChild;
  if (!face || !face.classList.contains('flip-face')) return;
  const half = TURN_MS * 0.42;   // 早一点点切：90° 前后牌宽都趋近 0，早切能盖掉 WebKit 那 1-2 帧镜像
  const cut = () => {
    face.style.visibility = '';
    if (back && back !== face) back.style.visibility = 'hidden';
  };
  if (turnGone >= half) { cut(); return; }
  face.style.visibility = 'hidden';
  if (back && back !== face) back.style.visibility = '';
  // 还没到 90°：用 rAF 盯着时间走，到点立刻切。
  // 别用 setTimeout —— 实测会晚 60ms 左右，那时牌已经转到 113°，
  // WebKit 上正好把镜像牌背露出来（就是这个 bug 的观感）。
  const t0 = performance.now();
  const tick = () => {
    if (!el.isConnected) return;                     // 牌已经重渲染掉了，别再空转
    if (performance.now() - t0 + turnGone >= half) { cut(); return; }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function layoutCards(box, view, opt = {}) {
  // v0.22.53：投入演出期间先不发牌——fxEnd 后 renderSoon 会带着空 dealtSeen 重渲染，
  // 那时才播发牌动画（顺序：飘字 → 份子归拢芒果池 → 底皮归拢皮池 → 发牌）
  if (state.handFx && opt.animate !== false) return;
  const isHole = opt.part === 'hole';
  const list = (view && view.length) ? view : (opt.placeholder === false ? [] : [null, null]);
  const n = list.length;
  const key = opt.key || 'x';
  const seen = dealtSeen.get(key) || 0;
  // 底牌、明牌拆成两个容器：
  //   · part='hole' 永远贴着头像边角，两张叠着，不参与下面的排布
  //   · 明牌在簸簸下面，发几张摆几张（第三张一张、第四张一对）
  //   · 只有分牌 / 摊牌那一刻，四张才一起挪下来分成「头 / 尾」两组
  const settled = !isHole && n >= 4 && !!opt.settled;
  const layFlat = settled;
  // 8 人桌左右两列空间窄：牌本身缩小（见 CSS），牌缝也收一点
  const tight = layFlat && stage.classList.contains('crowded');
  if (isHole) {
    box.classList.add('peek');
  } else {
    box.classList.toggle('settled-cards', settled);
    box.classList.toggle('open-cards', !settled && n > 0);
  }

  const one = (c, i) => {
    const wrap = document.createElement('div');
    wrap.className = 'cw';
    const spread = n <= 1 ? 0 : i - (n - 1) / 2;
    // 牌一律竖直摆正，不再按扇形歪斜（斜度由 peek 那一层整体旋转给）
    wrap.style.transform = 'none';
    wrap.style.marginLeft = i === 0 ? '0'
      : layFlat
        ? (i % 2 === 0 ? '0' : (tight ? '2px' : '3px'))
        // v0.20.38：8 人桌底牌缩到 34 宽，叠放错位同步收到 18（原来 22）
        : isHole ? (stage.classList.contains('crowded') ? '-18px' : '-32px')
          : (opt.gap || '8px');
    wrap.style.marginTop = '0';
    wrap.style.zIndex = String(i + 1);
    const ce = cardEl(c, { small: !!opt.small, dim: !!opt.dim });
    if (opt.fromX != null) {
      ce.style.setProperty('--deal-x', `${opt.fromX}px`);
      ce.style.setProperty('--deal-y', `${opt.fromY}px`);
      ce.style.setProperty('--deal-r', `${spread * 22 - 12}deg`);
    }
    // 第三、四张亮出来的时候走翻牌动画（底牌仍是普通发牌）
    // 座位上的明牌容器只装第 3、4 张（view.slice(2)），i 从 0 起，
    // 所以用 startAt 把真实序号补回来，别让别人的牌走成普通发牌。
    // 搓牌期间第四张是 null（牌背）：只把「飞入起点」钉住，牌背照旧走发牌动画；
    // 等真牌到手再从当前位置翻面，牌不会从桌心又飞一次（v0.20.44 修）。
    const seq = (opt.startAt || 0) + i;
    if (!isHole && seq >= 2 && opt.animate !== false) {
      if (c) {
        // v0.22.1：翻牌整体收快（720 / 900 / 1050ms），低配机上也能一口气翻完
        applyFlip(ce, `${key}:${i}`, seq === 2 ? 720 : (scratchOn() ? 900 : 1050));
      } else {
        markDealt(`${key}:${i}`);
        placeholderSeen.add(`${key}:${i}`);   // 牌背已摆上桌：真牌到了别再飞一次
        // 占位牌背照旧从桌心飞进来，但只在「第一次见到这张」时飞，
        // 之后每秒推送重渲染别再飞第二遍
        if (i >= seen) {
          ce.classList.add('deal');
          ce.style.animationDelay = `${(i - seen) * 95}ms`;
        }
      }
    } else if (i >= seen && opt.animate !== false) {
      ce.classList.add('deal');
      ce.style.animationDelay = `${(i - seen) * 95}ms`;
    }
    wrap.appendChild(ce);
    return wrap;
  };

  if (layFlat) {
    // 头两张一组、尾两张一组，组间留缝，每组下面挂「8 点」这类点数胶囊
    const pts = opt.points || [];
    [0, 1].forEach((g) => {
      const grp = document.createElement('div');
      grp.className = 'grp';
      const row = document.createElement('div');
      row.className = 'grp-row';
      row.appendChild(one(list[g * 2], g * 2));
      row.appendChild(one(list[g * 2 + 1], g * 2 + 1));
      grp.appendChild(row);
      if (pts[g]) {
        const pt = document.createElement('div');
        pt.className = 'grp-pt';
        pt.textContent = pts[g];
        grp.appendChild(pt);
      }
      box.appendChild(grp);
    });
  } else {
    list.forEach((c, i) => box.appendChild(one(c, i)));
  }
  if (n > seen && opt.sfx !== false) {
    // 8 个人同时补牌时别叠成一片噪音：每次刷新最多补 4 声
    for (let k = 0; k < n - seen && (state.dealBudget || 0) > 0; k++) {
      state.dealBudget -= 1;
      const i = seen + k;
      const seq = (opt.startAt || 0) + i;   // 真实牌序号：0/1 底牌、2 第三张、3 第四张
      const c = list[i];
      const d = 0.02 + k * 0.09;
      // v0.20.74：第 3 / 4 张明牌改用各自的真实录音（占位牌背仍走普通发牌音，
      // 等真牌翻出来那一刻才响「第四张翻开」，正好对上「发出并翻开」）。
      if (!settled && !isHole && c && seq === 2) sfxCard3(d);
      else if (!settled && !isHole && c && seq === 3) sfxCard4(d);
      else sfxDeal(d, opt.small ? 0.8 : 1);
    }
  }
  dealtSeen.set(key, n);
}

/* ── 收牌：这一手结算完，牌飞回桌心，接着洗牌 ── */
let sweepTimer = null;
function scheduleSweep(v) {
  if (v.phase !== PHASE.SETTLED) return;
  if (state.sweepHand === v.handNo) return;
  state.sweepHand = v.handNo;
  clearTimeout(sweepTimer);
  sweepTimer = setTimeout(() => {
    // 从这一刻起摊牌就算收走了：之后任何一次重渲染（申请带入、房主审核、
    // 每秒推送、断线重连）都不许再把这几张牌摆回桌上
    state.sweptHand = v.handNo;
    document.querySelectorAll('#seatLayer .seat').forEach((seat) => {
      const x = parseFloat(seat.style.left) || TABLE_CX;
      const y = parseFloat(seat.style.top) || TABLE_CY;
      seat.querySelectorAll('.cards .cw .card').forEach((el, i) => {
        el.style.setProperty('--sweep-x', `${(SHOE_X - x) * 0.92}px`);
        el.style.setProperty('--sweep-y', `${(SHOE_Y - y) * 0.92}px`);
        el.style.setProperty('--sweep-r', `${(i % 2 ? 1 : -1) * 16}deg`);
        el.style.animationDelay = `${i * 24}ms`;
        el.classList.add('sweep');
      });
      // 比牌组的「对子 / 8 点」标注不是牌的子孙节点，得单独让它一起退场
      seat.querySelectorAll('.cards .grp-pt').forEach((el, i) => {
        el.style.animationDelay = `${i * 45}ms`;
        el.classList.add('sweep-tag');
      });
    });
    document.querySelectorAll('#myHand .card').forEach((el, i) => {
      el.style.setProperty('--sweep-x', `${(i - 1) * 26}px`);
      el.style.setProperty('--sweep-y', '-330px');
      el.style.setProperty('--sweep-r', `${(i % 2 ? 1 : -1) * 12}deg`);
      el.style.animationDelay = `${i * 28}ms`;
      el.classList.add('sweep');
    });
    sfxSweep();
    setTimeout(() => {
      // 洗牌：只换状态字 + 出声，牌堆本身保持静态（动画不做花活）
      const st = $('shoeState');
      state.shuffling = true;
      if (st) st.textContent = '洗牌中';
      sfxSweepShuffle();   // v0.20.74：2.00s 真实「收牌后洗牌」录音替换原合成音
      setTimeout(() => {
        state.shuffling = false;
        if (st) st.textContent = '已结算';
      }, 2000);            // v0.20.74：状态窗口对齐 2.00s 音效
    }, 420);
  }, 2100);
}

function renderMyHand() {
  const m = me();
  const v = state.view;
  const box = $('myHand');
  // 围观：自己这一格清空，别留着上一个人的牌
  if (!m) {
    box.innerHTML = '';
    box.dataset.sig = '';
    $('myInfo').innerHTML = '';
    $('splitPreview').innerHTML = '';
    return;
  }

  const onlyOne = !!(m.splitOptions && m.splitOptions.length === 1);
  // v0.22.53：投入演出期间自己的手牌也先不发（渲染入口统一延迟），fxEnd 后再飞牌
  if (state.handFx && v.phase === PHASE.BET) return;
  // v0.20.75：自己已确定分牌、但全桌还没进摊牌（别人还在分）的这段窗口。
  // v0.22.3：服务端在玩家一分完牌就把 cardsView 归成「头头尾尾」，摊牌沿用同一
  // 顺序，所以这段窗口不再需要等结算才「跳回正常」，头尾标签直接按锁定的分法贴。
  const awaitingShowdown = v.phase === PHASE.SPLIT && (!!m.split || !!state.splitSent);
  const picking = v.phase === PHASE.SPLIT && !!m.splitOptions && !onlyOne
    && !awaitingShowdown;
  // 分牌进行中：手牌整体收窄左让，右边腾给「确定分牌」
  const splitting = v.phase === PHASE.SPLIT && !!m.splitOptions && !m.split
    && !m.special && !m.emperor;
  let auto = null;
  if (v.phase === PHASE.SPLIT && m.splitOptions) {
    // v0.22.3：自己点过「确定分牌」后，按引擎锁定的头尾贴标签（按牌 id 认），
    // 不再用玩家临时选的下标，等别人分牌这段窗口的标签也就不会贴错组。
    auto = m.split
      ? (splitFromOption(m.split, m.cardsView) || currentSplit())
      : (onlyOne ? splitFromOption(m.splitOptions[0], m.cardsView) : currentSplit());
  } else if (m.split && m.split.headCards && v.phase === PHASE.SETTLED) {
    // v0.22.3：分牌阶段与摊牌阶段 cardsView 顺序一致（头头尾尾），摊牌不再重排
    auto = splitFromOption(m.split, m.cardsView);
  }

  // 分牌阶段选好头尾之后：头两张排左边、尾两张排右边，中间留一道缝
  // 已经收过牌（摊牌飞回牌心）就不再重建，免得申请带入等重渲染把手牌又摆回来
  const swept = v.phase === PHASE.SETTLED && state.sweptHand === v.handNo;
  const cards = swept ? [] : (m.cardsView || []);
  // 分牌阶段牌不重排：玩家点哪张就哪张飞进托盘，底下的牌别跟着跳位置
  const seq = cards.map((_, i) => i);
  // 点一张就抽走一张：手牌里剩下的自动居中（返回时再回来）
  const pickedSet = picking ? new Set(state.headPicked) : null;

  // v0.22.1：牌没变就别重建。原来每次收到快照都把 #myHand 清空重搭，
  // 第三、四张的翻牌动画（1~1.8 秒）会被一秒两三次的推送反复打断，
  // 牌看上去永远翻不完、点按也跟着发飘。签名相同就原样留着牌节点。
  const cardSig = [
    v.phase, v.handNo, v.viewerSeat,
    cards.map((c) => (c ? c.id : '·')).join(','),
    !!m.split, !!m.splitOptions, (m.splitOptions || []).length,
    !!m.folded, !!m.special, !!m.emperor,
    picking ? 1 : 0, splitting ? 1 : 0, !!swept, !!state.splitSent,
    state.headPicked.join(','),
    auto ? auto.headIdx.join(',') : '',
    (m.headIds || []).join(','), (m.tailIds || []).join(','),
    state.sweptHand, state.sweepHand,
  ].join('|');
  if (box.dataset.sig !== cardSig) box.innerHTML = '';

  const mineFlags = cardFlags(m);
  const headSet = new Set(m.headIds || []);
  if (box.dataset.sig !== cardSig) seq.forEach((i, pos) => {
    const c = cards[i];
    const el = cardEl(c, { dim: m.folded });
    // v0.22.3：按牌 id 记，不掺下标——分牌归组后下标会变，掺了下标会让牌
    // 重新播一遍发牌/翻牌动画，看起来又像跳了一下。明暗也一律按身份认。
    const idKey = c ? c.id : `back${i}`;
    const key = `${v.handNo}:me:${idKey}`;
    const isHole = mineFlags.isHole(c, i);
    const openIdx = c ? (m.openIds || []).indexOf(c.id) : -1;
    if (v.phase !== PHASE.SETTLED && !isHole) {
      // 第三、四张（明牌）：牌背翻到牌面；第四张在搓牌关闭时延长 0.5 秒
      // 搓牌期间第四张是 null：只钉住飞入起点，牌背照常显示，搓开后再翻
      const fk = `${v.handNo}:me:${idKey}`;
      if (c) applyFlip(el, fk, openIdx === 0 ? 720 : (scratchOn() ? 900 : 1050));
      else { markDealt(fk); placeholderSeen.add(fk); }
    }
    if (v.phase !== PHASE.SETTLED && !state.seen.has(key)) {
      if (isHole) {
        el.classList.add('deal');
        el.style.setProperty('--deal-x', `${(pos - (cards.length - 1) / 2) * 40}px`);
        el.style.setProperty('--deal-y', '-330px');
        el.style.setProperty('--deal-r', '-10deg');
        el.style.animationDelay = `${pos * 80}ms`;
      }
      state.seen.add(key);
      const d = pos * 0.08;
      // 自己手牌第 3 / 4 张改用真实录音，按明牌身份认（不按屏幕位置）
      if (c && openIdx === 0) sfxCard3(d);
      else if (c && openIdx === 1) sfxCard4(d);
      else sfxDeal(d, 1);
    }

    if (picking) el.classList.add('pickable');
    if (picking) el.onclick = () => toggleHeadPick(i);
    // 已经飞进托盘的那两张：原地留淡影（auto 就是当前这组头牌）
    if (splitting && pickedSet && pickedSet.has(i)) el.classList.add('picked');

    if (auto && !splitting) {
      // 已定头尾：不抬牌，用金圈标出「头」那一组
      // 分牌阶段不加这些标注——头牌已经摆到上面的托盘里了
      if (auto.headIdx.includes(i)) el.classList.add('head-ring');
      const tag = document.createElement('span');
      tag.className = 'role' + (auto.headIdx.includes(i) ? ' head' : '');
      tag.textContent = auto.headIdx.includes(i) ? '头' : '尾';
      el.appendChild(tag);
    } else if (v.phase === PHASE.SETTLED && m.split && i < 4) {
      // v0.22.3：头/尾按牌 id 认（服务端已按头尾排好，这里做双保险）
      const isHead = c ? (headSet.size ? headSet.has(c.id) : i < 2) : i < 2;
      if (isHead) el.classList.add('head-ring');
      const tag = document.createElement('span');
      tag.className = 'role' + (isHead ? ' head' : '');
      tag.textContent = isHead ? '头' : '尾';
      el.appendChild(tag);
    } else if (picking && state.headPicked.includes(i)) {
      el.classList.add('sel');
    }
    box.appendChild(el);
  });

  box.dataset.sig = cardSig;

  // 摊牌时四张按「头两张 / 尾两张」留缝；分牌阶段不拆缝，牌保持原位等玩家点
  box.classList.toggle('four', cards.length === 4 && v.phase === PHASE.SETTLED);
  // 已定头尾后（自动分牌 / 摊牌），两组各自重叠一半，给更大的牌腾地方；
  // 手动选头尾时保持摊开，免得点不到被压住的那张
  // 分牌阶段保持摊开：牌要一张张点，叠起来就点不着了
  // v0.21.2：分牌一旦定了（含等别人分牌的窗口），cardsView 已按头尾重排，
  // 两组可以正常叠放，不再需要按旧版那样等进 SETTLED 才分组
  box.classList.toggle('merged', cards.length === 4
    && ((!!auto && !splitting) || (v.phase === PHASE.SETTLED && !!m.split)));
  box.classList.toggle('splitting', splitting && cards.length === 4);

  updatePreview();

  // 分牌读秒已经搬到桌面的倒计时条上，头像上不再挂第二个环
  const myTurnCd = v.phase === PHASE.BET && v.currentSeat === v.viewerSeat && !m.folded;
  // 保位离桌也走留座倒计时：自己头像上同样挂环，不能只有别人看得见
  const myHold = !!(m.holdLeave && m.holdLeft > 0);
  const overlay = (myHold ? `<span class="ring-wrap">${ringHtml(m.holdSince)}</span>` : '')
    // v0.22.82：等房主审核也照常显示留座倒计时环（带入与留座解耦）
    + (m.broke && !myHold
      ? `<span class="ring-wrap">${ringHtml(m.brokeSince, m.sitHold ? SIT_HOLD_SECONDS : BROKE_SECONDS)}</span>` : '')
    + (myTurnCd ? turnClockHtml(state.turnSince || Date.now()) : '');
  const myFire = m.knocked && !m.folded && (v.phase === PHASE.BET || v.phase === PHASE.SPLIT);
  // 轮到我时，「大 / 敲」正好落在这块区域的头顶：下注额胶囊和上一手行动气泡先让开，
  // 不然会和按钮叠在一起（金额在按钮与底池里都看得到，不差这一处）
  const myActing = v.phase === PHASE.BET && v.currentSeat === v.viewerSeat && !m.folded;
  const info = $('myInfo');
  if (info) info.classList.toggle('acting', myActing);
  info.innerHTML = `
    <div class="avatar${m.broke || m.holdLeave ? ' in-broke' : ''}${myFire ? ' knocked' : ''}">${myAvatarHTML(m.name)}</div>
    ${myHold ? '<button class="seat-back" id="mySeatBack" type="button">回到座位</button>' : ''}
    ${myFire ? '<span class="fire-halo"></span>' : ''}
    ${overlay}
    ${m.isBanker ? '<span class="dealer-badge">庄</span>' : ''}
    ${(() => { const fxb = state.handFx ? state.handFx.betShown.get(m.seat) : null;
      const bn = fxb != null ? fxb : m.bet;
      return !m.away && bn ? `<div class="my-bet">${bn}</div>` : ''; })()}
    <div>
      <div class="nm">${needBuyIn(v, m) ? m.name : ''}
        ${m.special ? `<em>${m.special}</em>` : ''}
        ${m.knocked ? '<em>敲</em>' : ''}${m.folded ? '<em>已丢</em>' : ''}
        ${!m.knocked && !m.folded && !m.special && m.lastAction === 'raise' ? '<em>大</em>' : ''}
        ${!m.knocked && !m.folded && !m.special && m.lastAction === 'follow' ? '<em>跟</em>' : ''}
        ${!m.knocked && !m.folded && !m.special && m.lastAction === 'pass' ? '<em>休</em>' : ''}</div>
      <div class="nums${m.away ? ' gone' : ''}">
        <span class="cap">${m.away ? '已离座'
          : (((m.stack ?? 0) + (state.handFx ? (state.handFx.hidden.get(m.seat) || 0) : 0)) > 0
            ? (m.stack ?? 0) + (state.handFx ? (state.handFx.hidden.get(m.seat) || 0) : 0) : 0)}</span>
        ${!m.away && m.asking ? '<span class="asking">等房主审核</span>' : ''}
        ${!m.away && m.pending ? `<span class="pending">+${m.pending} 待入账</span>` : ''}
        ${v.phase === PHASE.SETTLED && m.delta
          ? `<em class="my-delta ${m.delta > 0 ? 'win' : 'lose'}">${m.delta > 0 ? '+' : ''}${m.delta}</em>`
          : ''}
      </div>
    </div>`;
  const backBtn = info.querySelector('#mySeatBack');
  if (backBtn) {
    backBtn.onclick = (ev) => {
      ev.stopPropagation();
      beep(760, 0.05, 'sine', 0.025);
      sendWS({ t: 'holdLeave', cancel: true });
    };
  }
}

/* ── 分牌：桌面托盘 + 倒计时条 + 手牌右侧的确定键 ───────────
 * 交互照参考视频：点下面手牌两张 → 这组飞进上方托盘当头，
 * 系统按牌力定头尾；托盘里放的就是「头」，底下剩「尾」。
 * 点托盘里任意一张 = 全部退回重选。 */
function renderSplitUI(v) {
  const hud = $('splitHud');
  const tray = $('splitTray');
  const cta = $('splitCta');
  if (!hud || !tray || !cta) return;

  const m = me();
  const on = !!(v && v.phase === PHASE.SPLIT && m && m.inHand && !m.folded
    && !m.special && !m.emperor && !m.split && m.splitOptions);

  hud.classList.toggle('hidden', !on);
  tray.classList.toggle('hidden', !on);
  cta.classList.toggle('hidden', !on);
  const hand = $('myHand');
  if (hand) hand.classList.toggle('splitting', on);
  // 分牌框压到头像上方后，下注额胶囊会和倒计时条叠字：分牌期间先藏起来
  const myInfo = $('myInfo');
  if (myInfo) myInfo.classList.toggle('splitting', on);
  if (!on) { state.trayKey = ''; return; }

  const onlyOne = m.splitOptions.length === 1;
  const sp = visibleSplit(m);
  const cards = m.cardsView || [];
  const head = sp ? sp.headIdx.map((i) => cards[i]).filter(Boolean) : [];
  const left = Math.max(0, SPLIT_SECONDS
    - Math.floor((Date.now() - (state.splitSince || Date.now())) / 1000));

  // 倒计时只改数字和条宽，整块不重建（否则进度条每次都从头长）
  const numEl = $('shLeft');
  if (numEl) numEl.textContent = left;
  const chip = $('shChip');
  if (chip) {
    const n = m.stack || 0;
    chip.textContent = n >= 100000 ? `${Math.round(n / 10000)}万`
      : n >= 10000 ? `${(n / 10000).toFixed(1)}万` : String(n);
    chip.style.fontSize = chip.textContent.length >= 5 ? '12px' : '14px';
  }
  const fill = $('shFill');
  if (fill) {
    fill.style.setProperty('--p', `${Math.max(0, Math.min(100, (left / SPLIT_SECONDS) * 100))}%`);
  }

  // 托盘：两张头牌（没选够就先摆两个牌背占位）
  // v0.22.68：把本桌地九王开关也纳入 key——关/开切换后续快照重来时，
  // 托盘头尾名称（地九王 ↔ 点数）会跟着重绘，不会沿用上一次的缓存文字
  const key = `${v.handNo}:${(state.headPicked || []).join(',')}:${onlyOne ? 'one' : 'multi'}:${sp ? 'ok' : 'raw'}:${v.dijiuOn !== false ? 1 : 0}`;
  if (state.trayKey !== key) {
    state.trayKey = key;
    tray.innerHTML = '';
    const row = document.createElement('div');
    row.className = 'st-cards';
    // 点一张就摆一张，空位用虚线牌背占着；两张齐了就是「头」
    const picked = (state.headPicked || []).map((i) => cards[i]).filter(Boolean);
    const slots = onlyOne ? head : (picked.length ? picked : []);
    while (slots.length < 2) slots.push(null);
    slots.slice(0, 2).forEach((c, idx) => {
      if (!c) {
        // 空槽不画牌背：用「宽 / 窄」水印占位，提示头牌朝向（左宽右窄）
        const ph = document.createElement('div');
        ph.className = 'st-slot';
        ph.textContent = idx === 0 ? '宽' : '窄';
        row.appendChild(ph);
        return;
      }
      const el = cardEl(c, {});
      el.onclick = resetHead;
      el.title = '点一下退回重选';
      row.appendChild(el);
    });
    tray.appendChild(row);
    const t = document.createElement('div');
    t.className = 'st-tag';
    if (sp) {
      t.innerHTML = `头 <b>${pairLabel(sp.head)}</b>　尾 <b>${pairLabel(sp.tail)}</b>`
        + (state.splitSent ? '' : '<span class="re">重选</span>');
      const re = t.querySelector('.re');
      if (re) re.onclick = resetHead;
    } else {
      t.textContent = onlyOne ? '丁皇不可拆 · 直接确定'
        : `点下面两张牌做头（${state.headPicked.length}/2）`;
    }
    tray.appendChild(t);
  }

  // 右侧：确定分牌
  const can = onlyOne || state.headPicked.length === 2;
  cta.innerHTML = '';
  const b = document.createElement('button');
  b.textContent = state.splitSent ? '已确认' : (can ? '确定分牌' : '选两张');
  b.disabled = state.splitSent || !can;
  b.classList.toggle('sent', !!state.splitSent);
  b.onclick = () => {
    if (state.splitSent) return;
    if (onlyOne) humanSplit(0);
    else confirmSplit();
  };
  cta.appendChild(b);
}

function renderActions() {
  const v = state.view;
  const bar = $('actionBar');
  bar.innerHTML = '';
  bar.classList.remove('stack');

  // 开发者：只看不动
  if (v.god) {
    // 退出按钮已经放在底部牌堆条上，这里留空免得两块叠在一起
    bar.innerHTML = '';
    return;
  }

  // 围观的人：直接点牌桌上的空位坐下（不再弹窗按号数选）
  if (watching()) {
    bar.classList.add('stack');
    const pen = v.pendingSeat;
    if (pen != null) {
      const c = document.createElement('button');
      c.className = 'act';
      c.textContent = '不坐了';
      c.onclick = () => sendWS({ t: 'unsit' });
      bar.appendChild(c);
    }
    // v0.20.29：房主=开房人，与入座断开——围观/纯开房的房主照样能开局
    if (v.phase === 'WAITING' && amOwnerV(v) && !v.ended) {
      const humans = v.humanCount ?? v.seats.filter((s) => !s.isAI).length;
      const seated = humans + (v.botCount ?? v.seats.filter((s) => s.isAI && s.name).length);
      const b = document.createElement('button');
      b.className = 'act primary';
      b.textContent = v.canStart ? '开始牌局' : seated < 2 ? `还差 ${Math.max(0, 2 - seated)} 人` : '等带入';
      b.disabled = !v.canStart;
      b.onclick = () => sendWS({ t: 'start' });
      bar.appendChild(b);
    }
    return;
  }

  // 还没开局：人就坐在牌桌上，这里只给「开始牌局 / 带入」两件事
  if (v.phase === 'WAITING') {
    const self = me();
    // v0.20.29：房主=开房人，与入座断开——围观、纯开房都能开局
    const isOwner = amOwnerV(v);
    // humans 只数真人；bots（机器人）也占座、也带钱，能一起开局
    const humans = v.humanCount ?? v.seats.filter((s) => !s.isAI).length;
    const seated = humans + (v.botCount ?? v.seats.filter((s) => s.isAI && s.name).length);

    // v0.20.19：开始牌局按钮旁的小字说明（人齐了/还没带入/等房主开局…）全部删掉，
    // 中央区只留按钮本身
    if (isOwner && !v.ended) {
      const b = document.createElement('button');
      b.className = 'act primary';
      b.textContent = v.canStart ? '开始牌局' : seated < 2 ? `还差 ${Math.max(0, 2 - seated)} 人` : '等带入';
      b.disabled = !v.canStart;
      b.onclick = () => sendWS({ t: 'start' });
      bar.appendChild(b);
    }
    if (self) {
      const c = document.createElement('button');
      c.className = 'act';
      // v0.20.28：开房人锁定——房主离开不再转交，回来还能从「你的房间」进来
      const locked = !!v.ownerUid;
      c.textContent = isOwner && humans > 1 && !locked ? '离开（转交房主）' : '离开';
      c.onclick = async () => {
        const ok = await askConfirm({
          title: '退出牌局',
          text: isOwner && locked ? '座位会让出来，房主位给你留着，回来还能再坐下。' : isOwner && humans > 1 ? '房主会转交给下一位玩家，座位让出来。' : '座位会让出来。',
          ok: '退出',
          danger: true,
        });
        if (ok) doQuit();
      };
      bar.appendChild(c);
    }
    return;
  }

  // 自己不在这一手：离座 / 留座 / 下一手入场（结算窗口里也要能重新入座）
  // v0.20.23：底栏小字提示语去掉——离座/留座/下一手入场在座位标签上仍然可见
  const self = me();
  if (self && !self.inHand && (self.away || self.broke || self.joinNext)) {
    return;
  }

  if (v.phase === PHASE.SETTLED) {
    // 刚坐下、身上还没钱：带入入口在桌面「带入记分牌」上，底栏留空
    return;
  }

  if (v.phase === PHASE.SPLIT) {
    // 三花/通杀在座位标签上可见，分牌操作在桌面托盘，底栏留空（小字提示语已去掉）
    return;
  }

  if (v.phase !== PHASE.BET) return;

  if (v.currentSeat !== mySeat()) {
    // 轮到别人：底栏留空（小字提示语已去掉）
    return;
  }

  // 轮到我：四个按钮摆在头像周围（见 renderMyActions），底部这一栏留空
  if (state.sheet) closeSheet();
}

/* ── 我的行动按钮：贴着本家头像摆 ─────────────
 * 左：丢 / 休（同一颗按钮，按这一轮有没有人下注换字）
 * 右：跟（金额 + 跟）；没人开口时这里换成「休」
 * 上：大（双箭头）；簸簸不够加注、只能梭哈时，这里换成「敲」（金额 + 敲）
 * 按住「大」不松手 → 竖向拉条立刻从按钮上方长出来，手指可以移到屏幕任何位置，
 * 松手就下注；往下拉过取消线再松手 = 这一手不加。
 */
let raisePop = null;
let raiseSel = null;       // { lo, hi, step, val }
let raiseHold = null;      // 本次按住的指针：{ pid, move, up, cancel }

const RAISE_SPAN = 480;    // 手指走完 480 设计像素 = 从最低加注拉到全下（拉条加长 1.5 倍）

function closeRaisePop() {
  if (raiseHold) {
    window.removeEventListener('pointermove', raiseHold.move, true);
    window.removeEventListener('pointerup', raiseHold.up, true);
    window.removeEventListener('pointercancel', raiseHold.cancel, true);
    raiseHold = null;
  }
  if (raisePop) {
    raisePop.remove();
    raisePop = null;
  }
  raiseSel = null;
  const box = $('myActions');
  if (box) {
    box.classList.remove('at-max');
    box.classList.remove('raising');
  }
}

/** 下一手发牌的最低簸簸：服务端用 holdFloor（= 底皮 × n，房主开房时选定） */
function stakeFloor(v) {
  return Math.max((v && v.ante) || 0, (v && v.holdFloor) || 0);
}

/** 该不该出现「带入记分牌」：没钱 / 离座 / 排队等下一手 / 结算后筹码耗尽
 *  口径必须跟服务端一致：不发牌的门槛是 holdFloor，不是底皮。
 *  簸簸在「底皮 ~ holdFloor」之间时下一手根本不会发牌，
 *  这时候也要把带入入口摆出来，否则玩家卡在桌上没按钮可点。 */
function needBuyIn(v, m) {
  if (!v || !m) return false;
  const low = (m.stack || 0) < stakeFloor(v);
  if (v.phase === 'WAITING') return low && !v.ended;
  // 结算画面：钱不够下一手就先摆带入，不用等到下一手开了才出现
  if (v.phase === PHASE.SETTLED) return low;
  // 牌局进行中：这一手没拿到牌（留座 / 未带入 / 排队等下一手）才摆
  return !m.inHand && (low || m.broke || m.joinNext || m.away);
}

/** v0.20.56：常驻「加时」键状态刷新。
 *  v0.20.25 起它本是 renderMyActions 里的一颗行动键（轮到我下注才出现），
 *  现独立到「表情」正上方，与左上「对讲机」中线对齐，四角左右对称。
 *  每帧刷价格 / 次数 / 可点与否：非我回合、围观、上帝视角、次数用完、
 *  钻石不足、未登录一律置灰但仍占位，保证对称布局不塌。 */
function paintExtFab() {
  const b = $('btnExt');
  if (!b) return;
  const v = state.view;
  const m = me();
  const offline = net.mode !== 'online';
  const used = offline ? (state.localExtUses || 0)
    : ((v && (v.extUses || {})[m ? m.seat : -1]) || 0);
  const maxed = used >= 4;
  const cost = 2 ** (used + 1);
  const poor = !offline && acct.user && (acct.user.diamonds || 0) < cost;
  const noLogin = !offline && !acct.user;
  const myTurn = !!(v && m && !watching() && !v.god && !m.folded
    && !needBuyIn(v, m) && v.phase === PHASE.BET && v.currentSeat === m.seat);
  const off = !myTurn || maxed || poor || noLogin;
  b.classList.toggle('off', off);
  b.disabled = off;
  const costEl = $('btnExtCost');
  // 钻石走位图小图标（.dm），和别处价签保持同一套资源
  if (costEl) costEl.innerHTML = maxed ? '完' : `${cost}<span class="dm"></span>`;
  b.onclick = off ? null : () => {
    if (offline) localExtendTurn();
    else sendWS({ t: 'extend' });
  };
}

function renderMyActions() {
  const box = $('myActions');
  if (!box) return;
  if (raisePop) return;          // 正在拖加注，别把拉条连同按钮一起重画掉
  box.innerHTML = '';
  const slot = $('bringSlot');
  if (slot) slot.innerHTML = '';
  const v = state.view;
  if (!v || v.god) return;
  const m = me();
  if (!m || watching()) return;

  const needBuy = needBuyIn(v, m);
  // 带入按钮挪到房间号下面后，底部那条「等房主 / 离开」仍要避让
  const bar = $('actionBar');
  if (bar) bar.classList.toggle('low', !!needBuy);

  // 入座后没带钱：房间号下边框下方摆一枚金色「带入记分牌」
  if (needBuy) {
    const b = document.createElement('button');
    b.className = 'bring-btn';
    b.textContent = m.asking ? '等房主审核' : '带入记分牌';
    b.disabled = !!m.asking;
    b.onclick = () => openBringIn();
    if (slot) slot.appendChild(b);
    return;
  }

  if (v.phase !== PHASE.BET || v.currentSeat !== m.seat || m.folded) return;
  // v0.22.51：开手演出期间锁行动——按钮先不画，动画播完 fxEnd→renderSoon 才亮出来
  if (state.handFx) return;
  const legal = v.legalActions || [];
  // 本轮要投多少：每轮独立计价，跟注是全额再下一遍，不抵前几轮
  const need = Math.max(0, (v.roundHighest || 0) - (m.roundBet || 0));
  const put = (cls, html, left, top, onclick, num) => {
    const b = document.createElement('button');
    b.className = 'mbtn ' + cls;
    b.style.left = left + 'px';
    b.style.top = top + 'px';
    b.innerHTML = html;
    const big = b.querySelector('b');
    if (big && num != null) {
      big.style.fontSize = num >= 100000 ? '16px' : num >= 10000 ? '19px' : num >= 1000 ? '22px' : '24px';
    }
    if (onclick) b.onclick = onclick;
    box.appendChild(b);
    return b;
  };

  const ICON = {
    fold: '<svg viewBox="0 0 24 24"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg>',
    pass: '<svg viewBox="0 0 24 24"><path d="M4.5 12.8l5 5L19.5 6.6"/></svg>',
    raise: '<svg viewBox="0 0 24 24"><path d="M6 12.6l6-6 6 6"/><path d="M6 19.6l6-6 6 6"/></svg>',
  };

  // 左：丢（砖红）。右：这一轮前面都没人下注/加注 → 休（青绿）；有人下注 → 跟。
  // v0.20.46：服务端在「本轮还没人开口」时同时给 pass 和 fold（need<=0），
  // 以前有休就只画休、把丢藏起来；现在两个都给：丢在左、休顶到右边跟的位置，
  // 三颗键的相对布局完全不动，只换字和颜色。上方的「大 / 敲」始终不变。
  const canPass = legal.includes('pass');
  const canFold = legal.includes('fold');
  if (canFold) put('fold', ICON.fold + '<span>丢</span>', -152, 0, () => humanAct('fold'));
  else if (canPass) put('pass', ICON.pass + '<span>休</span>', -152, 0, () => humanAct('pass'));

  // 右上：没人开口时是「休」（不下注、手牌留着）；有人开口后换成跟注
  // 第一轮还没人开口时不给「跟注」：这时候「加注」本身就是按最低下注额开口。
  // 旧服务端没有 roundOpened：用「本轮最高额 > 底皮」推断有没有人开口
  const opened = v.roundOpened ?? ((v.roundHighest || 0) > (v.ante || 0));
  const firstOpen = v.round === 1 && !opened && legal.includes('raise');
  // 只有「休 + 丢」两件事都能做时，才把休挪到右边（丢占左、休占右）；
  // 万一哪天服务端只给 pass 不给 fold，左边那颗已经是休，别在右边再画一颗重复的。
  if (canPass && canFold) {
    put('pass', ICON.pass + '<span>休</span>', 152, 0, () => humanAct('pass'));
  } else if (legal.includes('follow') && !firstOpen) {
    const amt = Math.min(need, (m.stack || 0));
    put('call', `<b>${amt.toLocaleString()}</b><span>跟</span>`, 152, 0, () => humanAct('follow'), amt);
  }

  // 上：能加注给「大」（双箭头，不写金额，按下才展开拉条）；
  // 簸簸不够加注、只剩梭哈时，同一位置换成「敲」——金额 + 敲，是另一种形态。
  if (legal.includes('raise')) {
    const rb = put('raise', ICON.raise + '<span>大</span>', 0, -136, null);
    bindRaiseTap(rb);
    paintQuickRaise(box, v, m);
  } else if (legal.includes('knock')) {
    const all = Math.max(0, m.stack || 0);
    put('knock', `<b>${all.toLocaleString()}</b><span>敲</span>`, 0, -136, () => humanAct('knock'), all);
  }

  // v0.20.56：加时键已迁出行动键组，改为牌桌右下「表情」正上方的常驻浮动按钮
  // （见 index.html #btnExt / style.css .ext-fab），状态统一由 paintExtFab() 每帧刷新。
  // 原来贴在「跟」右侧 (282,30) 的那颗不再生成，行动键组恢复为四颗。
  paintMyActionsOpt();   // v0.22.78：按钮被重建后，重按乐观禁用态
}

/** 单机：加时直接改本地计时（不扣钻） */
function localExtendTurn() {
  if (!state.localTurnAt) return;
  if ((state.localExtUses || 0) >= 4) { toast('本场加时次数已用完（4 次）'); return; }
  state.localExtUses = (state.localExtUses || 0) + 1;
  state.localExtMs = (state.localExtMs || 0) + 30000;
  toast(`已加时 30 秒（本场第 ${state.localExtUses} 次）`);
  refresh();
}

/* ── 加注快捷：贴在「大」正上方的一排底池倍率键 ────────────
 * 底池 ×1/2、×1、×2 三个圆键，平时 30% 透明压着（不抢牌面），
 * 点一下直接按这个金额下注；超过上限（钱不够）就当「敲」，一把推完。
 */
function paintQuickRaise(box, v, m) {
  const pot = Math.max(0, Math.round(v.potChips ?? v.pot ?? 0));
  if (!pot) return;
  const lo = Math.max(1, v.minRaise || 1);
  const hi = Math.max(lo, v.maxRaise || lo);
  const step = v.raiseStep || 1;
  const pick = (raw) => {
    const q = step > 1 ? Math.round(raw / step) * step : Math.round(raw);
    return Math.max(lo, Math.min(hi, q));
  };
  // 三个键优先给「底池的 1/2、1 倍、2 倍」；
  // 底池太小、这个倍数还不够开一口时，退成「最低加注」并老实改标签，
  // 免得出现「底池 X1」却写着 960 这种对不上的数字。金额重复的键不再重复摆。
  const items = [];
  const push = (label, raw, src) => {
    const amt = pick(raw);
    if (items.some((x) => x.amt === amt)) return;
    items.push({ label, amt, src });
  };
  [['1/2', 0.5], ['X1', 1], ['X2', 2]].forEach(([label, k]) => {
    const raw = pot * k;
    // 底池倍数低于一口最低加注：这一格其实就代表「最低一口」，标签别写 1/2
    push(raw >= lo ? label : '×1', raw, raw >= lo ? '底池' : '最低');
  });
  // 不足三个就从当前最大值往上再加一口，保证三个键从左到右是递增的
  let last = items.length ? items[items.length - 1].amt : lo;
  for (let f = 2; items.length < 3 && last < hi; f++) {
    const next = pick(last + lo);
    if (next <= last) break;
    items.push({ label: `×${f}`, amt: next, src: '最低' });
    last = next;
  }
  const wrap = document.createElement('div');
  wrap.className = 'quick-raise';
  wrap.innerHTML = items.map((it) => {
    const txt = it.amt >= 100000 ? `${(it.amt / 10000).toFixed(it.amt % 10000 ? 1 : 0)}万` : it.amt.toLocaleString();
    // v0.20.21：「最低」两个字从按钮上去掉（q-cap 留空），金额与倍数照旧
    return `<button class="qbtn" type="button" data-amt="${it.amt}" aria-label="${it.src} ${it.label}：${it.amt}">
      <span class="q-cap">${it.src === '最低' ? '' : it.src}</span><b>${it.label}</b><i>${txt}</i></button>`;
  }).join('');
  box.appendChild(wrap);
  wrap.querySelectorAll('.qbtn').forEach((b) => {
    b.onclick = (ev) => {
      ev.stopPropagation();
      const amt = Number(b.dataset.amt) || lo;
      beep(720, 0.04, 'sine', 0.02);
      if (amt >= hi) humanAct('knock');
      else humanAct('raise', amt);
    };
  });
}

/* 「大」：按下即出条，手指全程自由，松手即下注
 * · pointerdown 那一刻就把拉条拉出来，预选停在最低加注
 * · 之后手指在屏幕任何位置上下滑都算，位移换算成金额（不要求按在轨道上）
 * · 松手 = 立即按当前金额下注；拉到顶 = 敲（全下）
 * · 往下拉过取消线，提示变红，此时松手 = 这一手不加
 */
function bindRaiseTap(btn) {
  btn.addEventListener('contextmenu', (ev) => ev.preventDefault());
  btn.addEventListener('pointerdown', (ev) => {
    if (ev.button != null && ev.button !== 0) return;
    const v = state.view;
    const m = me();
    if (!v || !m || v.currentSeat !== m.seat || raisePop) return;
    const legal = v.legalActions || [];
    if (!legal.includes('raise')) return;
    ev.preventDefault();
    ev.stopPropagation();
    openRaise(btn, ev, {
      lo: Math.max(1, v.minRaise || 1),
      hi: Math.max(1, v.maxRaise || v.minRaise || 1),
      step: v.raiseStep || 1,
    });
  });
  // 键盘 / 读屏没法按住拖：直接按最低加注下注
  btn.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    ev.preventDefault();
    const v = state.view;
    if (v && (v.legalActions || []).includes('raise')) humanAct('raise', v.minRaise || 1);
  });
}

function openRaise(btn, ev, opt) {
  closeRaisePop();
  const board = document.querySelector('#stage .board') || stage;
  const s = state.scale || 1;
  const br = btn.getBoundingClientRect();
  const bd = board.getBoundingClientRect();

  const pop = document.createElement('div');
  pop.className = 'raise-pop';
  pop.innerHTML = `<div class="rp-track"><i class="rp-fill"></i><em class="rp-pill">0</em></div>
    <div class="rp-hint"></div>`;
  pop.style.left = `${(br.left + br.width / 2 - bd.left) / s}px`;
  pop.style.top = `${(br.top - bd.top) / s}px`;
  board.appendChild(pop);
  const ph = pop.getBoundingClientRect().height / s;
  pop.style.top = `${(br.top - bd.top) / s - ph - 8}px`;

  raisePop = pop;
  // 拉条要从「大」上面长出来，把三个快捷键先收掉，别叠在一起
  const actBox = $('myActions');
  if (actBox) actBox.classList.add('raising');
  const pill = pop.querySelector('.rp-pill');
  const fill = pop.querySelector('.rp-fill');
  const hint = pop.querySelector('.rp-hint');
  const sel = { lo: opt.lo, hi: opt.hi, step: opt.step, val: opt.lo };
  raiseSel = sel;

  const snap = (x) => {
    const q = opt.step > 1 ? Math.round(x / opt.step) * opt.step : Math.round(x);
    return Math.max(opt.lo, Math.min(opt.hi, q));
  };
  const paint = () => {
    const k = sel.hi > sel.lo ? (sel.val - sel.lo) / (sel.hi - sel.lo) : 1;
    fill.style.height = `${k * 100}%`;
    pill.style.bottom = `${k * 100}%`;
    const txt = sel.val.toLocaleString();
    pill.textContent = txt;
    pill.style.fontSize = txt.length >= 7 ? '19px' : txt.length >= 6 ? '21px' : '23px';
    pill.classList.toggle('top', sel.val >= sel.hi);
  };
  paint();

  const startY = ev.clientY;
  let cancel = false;

  const move = (e) => {
    if (!raiseHold || (e.pointerId != null && e.pointerId !== raiseHold.pid)) return;
    const dy = (startY - e.clientY) / s;      // 往上拖为正
    const nowCancel = dy < -72;
    if (nowCancel !== cancel) {
      cancel = nowCancel;
      pop.classList.toggle('cancel', cancel);
    }
    // v0.20.23：小字提示语去掉，只保留拉过取消线的红色警告（涉及钱，必须提示）
    hint.textContent = cancel ? '松开手，这一手不加' : '';
    if (cancel) return;
    const k = Math.max(0, Math.min(1, dy / RAISE_SPAN));
    const next = snap(opt.lo + k * (opt.hi - opt.lo));
    if (next !== sel.val) {
      sel.val = next;
      paint();
      beep(560 + Math.round(k * 240), 0.02, 'sine', 0.01);
    }
  };
  const up = (e) => {
    if (e.pointerId != null && raiseHold && e.pointerId !== raiseHold.pid) return;
    const val = sel.val;
    const drop = cancel;
    closeRaisePop();
    if (drop) return;
    if (val >= opt.hi) humanAct('knock');
    else humanAct('raise', val);
  };
  const cancelHold = () => closeRaisePop();

  raiseHold = { pid: ev.pointerId, move, up, cancel: cancelHold };
  window.addEventListener('pointermove', move, true);
  window.addEventListener('pointerup', up, true);
  window.addEventListener('pointercancel', cancelHold, true);
}

/* ── 玩家信息弹窗 + 互动表情 ─────────────────
 * 点别人的头像 → 弹这张小卡：昵称 / ID + 道具栏。
 * 表情动画挂在独立的 #fxLayer 上（座位每帧都重画，挂座位上会被冲掉）。
 */

/* v0.20.17：互动道具（点别人头像弹出）——雪碧图序列帧动画，原来的 8 个
   SVG 互动表情（拍砖/抓鸡/倒水/鸡蛋/飞吻/点赞/机关枪/花环）已全部移除。
   每个道具可由多段源动画串联而成，统一 260×260 画布居中，20fps 连播。 */
/* v0.20.17/v0.20.18：互动道具（点别人头像弹出）——雪碧图序列帧动画。
   icon=官方道具图标（道具栏缩略图），snd=官方音效 mp3（无则退回合成音效）。
   多段源动画串联成一个雪碧图，统一 260×260 画布居中，20fps 连播。 */
const EMOTE_PROPS = [
  { id: 'bingtong',    name: '冰桶泼水', f: 'prop_bingtong.webp',    n: 40, w: 260, h: 260, dur: 2.0,  tf: 0,  bb: [108, 122, 70, 74] },
  { id: 'cishuiqiang', name: '呲水枪',   f: 'prop_cishuiqiang.png', n: 64, w: 260, h: 260, dur: 3.2,  tf: 32, bb: [58, 141, 174, 102] },
  { id: 'dao',         name: '砍刀',     f: 'prop_dao.webp',         n: 60, w: 260, h: 260, dur: 3.0,  tf: 48, bb: [65, 64, 126, 104] },
  { id: 'dapao',       name: '大炮',     f: 'prop_dapao.webp',       n: 31, w: 260, h: 260, dur: 1.55, tf: 18, bb: [60, 81, 135, 136] },
  { id: 'daquan',      name: '重拳暴击', f: 'prop_daquan.webp',      n: 50, w: 260, h: 260, dur: 2.5,  tf: 40, bb: [42, 28, 185, 192] },
  { id: 'diujidan',    name: '丢鸡蛋',   f: 'prop_diujidan.webp',    n: 36, w: 260, h: 260, dur: 1.8,  tf: 16, bb: [83, 78, 95, 103] },
  { id: 'jiangbei',    name: '送奖杯',   f: 'prop_jiangbei.webp',    n: 32, w: 260, h: 260, dur: 1.6,  tf: 16, bb: [81, 83, 101, 93] },
  { id: 'shoulei',     name: '丢手雷',   f: 'prop_shoulei.webp',     n: 58, w: 260, h: 260, dur: 2.9,  tf: 45, bb: [96, 86, 73, 76] },
  { id: 'tuoxie',      name: '飞拖鞋',   f: 'prop_tuoxie.webp',      n: 28, w: 260, h: 260, dur: 1.4,  tf: 14, bb: [97, 115, 69, 69] },
  { id: 'zhuaji',      name: '抓鸡',     f: 'prop_zhuaji.webp',      n: 36, w: 260, h: 260, dur: 1.8,  tf: 20, bb: [54, 147, 105, 90] },
];

/* v0.20.16：序列帧表情（点「我」的头像弹出），每张雪碧图 20fps 连播。
   id 走 x1~x20，服务端 EMOTE_IDS 白名单已放行，扣费与 SVG 互动表情同价。 */
const EMOJI_ANIM = [
  { id:'x1', name:'花痴', f:'e01.webp', n:17, w:128, h:89, dur:0.85 },
  { id:'x2', name:'再见', f:'e02.webp', n:26, w:128, h:120, dur:1.3 },
  { id:'x3', name:'嘘声', f:'e03.webp', n:20, w:104, h:96, dur:1.0 },
  { id:'x4', name:'大笑', f:'e04.webp', n:23, w:100, h:92, dur:1.15 },
  { id:'x5', name:'吓一跳', f:'e05.webp', n:23, w:102, h:98, dur:1.15 },
  { id:'x6', name:'可怜', f:'e06.webp', n:28, w:93, h:103, dur:1.4 },
  { id:'x7', name:'嚎哭', f:'e07.webp', n:17, w:94, h:93, dur:0.85 },
  { id:'x8', name:'得意', f:'e08.webp', n:17, w:117, h:114, dur:0.85 },
  { id:'x9', name:'冒火', f:'e09.webp', n:26, w:119, h:144, dur:1.3 },
  { id:'x10', name:'嘿嘿', f:'e10.webp', n:17, w:90, h:93, dur:0.85 },
  { id:'x11', name:'见钱眼开', f:'e11.webp', n:23, w:98, h:101, dur:1.15 },
  { id:'x12', name:'闭嘴', f:'e12.webp', n:23, w:93, h:93, dur:1.15 },
  { id:'x13', name:'感谢', f:'e13.webp', n:25, w:128, h:116, dur:1.25 },
  { id:'x14', name:'吐舌', f:'e14.webp', n:19, w:111, h:112, dur:0.95 },
  { id:'x15', name:'流汗', f:'e15.webp', n:22, w:96, h:95, dur:1.1 },
  { id:'x16', name:'狂笑', f:'e16.webp', n:21, w:92, h:95, dur:1.05 },
  { id:'x17', name:'无语', f:'e17.webp', n:18, w:90, h:109, dur:0.9 },
  { id:'x18', name:'思考', f:'e18.webp', n:23, w:128, h:107, dur:1.15 },
  { id:'x19', name:'斜眼', f:'e19.webp', n:20, w:90, h:95, dur:1.0 },
  { id:'x20', name:'惊恐', f:'e20.webp', n:23, w:128, h:220, dur:1.15 },
];
/* v0.20.21：表情/道具动画显示尺寸 ×1.5（canvas 内部分辨率不变，只放大显示） */
const EMOTE_SCALE = 1.5;
const isAnimEmote = (id) =>
  EMOJI_ANIM.some((e) => e.id === id) || EMOTE_PROPS.some((e) => e.id === id);
const findAnimEmote = (id) =>
  EMOJI_ANIM.find((e) => e.id === id) || EMOTE_PROPS.find((e) => e.id === id);

function fxLayer() {
  let l = $('fxLayer');
  if (!l) {
    l = document.createElement('div');
    l.id = 'fxLayer';
    l.className = 'fx-layer';
    // v0.20.16：挂到 stage 直下。原来挂在 .board 里受其层叠上下文约束，
    // 表情飘到「我」座位上方时会被 my-info(z9) 整体压住
    const b = document.querySelector('#stage') || stage;
    b.appendChild(l);
  }
  return l;
}

/* ── 表情包（v0.20.52）─────────────────────────────
 * 开关固定牌桌右下角；面板由屏幕下方向上滑出，半透明背景，除表情外
 * 不放任何说明文字。点面板以外任意位置收起。
 * 表情仍是 x1~x20 序列帧，服务端对这批 id 免费。 */
let emoteSheetBuilt = false;
function buildEmoteSheet() {
  if (emoteSheetBuilt) return;
  const grid = $('emoteGrid');
  if (!grid) return;
  emoteSheetBuilt = true;
  grid.innerHTML = EMOJI_ANIM.map((e) => {
    const th = 76, tw = Math.round(th * e.w / e.h);
    // 缩略图用 canvas 画中帧：素材首尾帧是空帧（淡入淡出），第 0 帧没法当封面
    return `<button class="emote-cell" type="button" data-emo="${e.id}" aria-label="表情">
      <canvas width="${e.w}" height="${e.h}" data-emo="${e.id}" style="width:${tw}px;height:${th}px"></canvas>
    </button>`;
  }).join('');
  // 异步把每张雪碧图的中间帧画进缩略图
  grid.querySelectorAll('canvas[data-emo]').forEach(async (cv) => {
    const e = EMOJI_ANIM.find((x) => x.id === cv.dataset.emo);
    if (!e) return;
    try {
      const im = new Image();
      im.src = 'emoji/' + e.f;
      await im.decode();
      const fw = im.naturalWidth / e.n;
      const mid = Math.floor(e.n / 2);
      cv.getContext('2d').drawImage(im, mid * fw, 0, fw, im.naturalHeight, 0, 0, e.w, e.h);
    } catch (_) { /* 图挂了就留空白格子 */ }
  });
  grid.querySelectorAll('.emote-cell').forEach((b) => {
    b.onclick = (ev) => {
      ev.stopPropagation();
      const id = b.dataset.emo;
      const seat = state.view ? state.view.viewerSeat : 0;
      if (net.mode === 'online') {
        if (!acct.user) { toast('请先登录'); return; }
        if (seat < 0) { toast('坐下才能发表情'); return; }
        // 服务端广播回来才播（含自己）；x1~x20 免费，不扣钻
        sendWS({ t: 'emote', seat, emo: id });
        closeEmoteSheet();
        return;
      }
      // 单机练习：不收费，本地直接播
      playEmote(seat, id);
      closeEmoteSheet();
    };
  });
}
function emoteSheetOpen() {
  const s = $('emoteSheet');
  return !!(s && s.classList.contains('on'));
}
function openEmoteSheet() {
  if (net.mode === 'online' && !acct.user) { toast('请先登录'); return; }
  buildEmoteSheet();
  const s = $('emoteSheet'), fab = $('btnEmote');
  if (!s) return;
  s.classList.add('on');
  s.setAttribute('aria-hidden', 'false');
  if (fab) fab.setAttribute('aria-expanded', 'true');
  // v0.20.56：面板滑出时淡出左上「对讲机」/右上「加时」，避免压住第一列表情格
  document.body.classList.add('emote-open');
  beep(640, 0.04, 'sine', 0.02);
}
function closeEmoteSheet() {
  const s = $('emoteSheet'), fab = $('btnEmote');
  if (!s) return;
  s.classList.remove('on');
  s.setAttribute('aria-hidden', 'true');
  if (fab) fab.setAttribute('aria-expanded', 'false');
  document.body.classList.remove('emote-open');
}
function toggleEmoteSheet() {
  if (emoteSheetOpen()) closeEmoteSheet();
  else openEmoteSheet();
}

function openPlayerCard(p) {
  if (!p || p.vacant) return;
  // v0.20.52：点自己的头像不再弹窗（ID / 钻石已经常驻左上角）
  const mineUid = acct.user ? String(acct.user.id) : '';
  if (p.mine || (!!mineUid && String(p.uid || '') === mineUid)) return;
  const box = $('modalBox');
  box.dataset.kind = 'player';
  // 只留昵称 + 真实账号 ID：座位号、电脑玩家这类说明小字一律不显示
  const uid = !p.isAI && p.uid ? String(p.uid) : '';
  // v0.20.28：房主可强制离座；有分发权限的账号可看到「赠送钻石」框
  const online = net.mode === 'online';
  const canForce = online && uid && amOwnerV(state.view);
  const canGift = online && uid && !!acct.user
    && (acct.user.canDist || acct.user.role === 'owner');
  box.innerHTML = `
    <button class="modal-x" id="pcClose" type="button" aria-label="关闭">×</button>
    <div class="pc-head">
      <div class="pc-ava">${avatarEl(p.name, p.isAI ? 'ai' : '', p.avatar).outerHTML}</div>
      <div class="pc-id">
        <b>${esc(p.name || '')}${p.isAI ? '<em class="pc-bot">机器人</em>' : ''}</b>
        ${uid ? `<span>ID ${esc(uid)}</span>` : ''}
      </div>
      ${canForce ? `<button class="pc-force${p.forceOut ? ' on' : ''}" id="pcForce" type="button">${p.forceOut ? '取消强制离座' : '强制离座'}</button>` : ''}
    </div>
    ${canGift ? `
    <div class="pc-gift">
      <span class="pc-gift-t">赠送钻石</span>
      <input class="pc-gift-amt" id="pcGiftAmt" inputmode="numeric" maxlength="7" placeholder="数量">
      <button class="pc-gift-go" id="pcGiftGo" type="button">送</button>
    </div>` : ''}
    <div class="pc-emotes">
      ${EMOTE_PROPS.map((e) => {
        // 缩略图用官方道具图标（v0.20.18 起随素材包附赠），canvas 绘制
        return `<button class="pc-emote" type="button" data-emo="${e.id}">
        <canvas width="96" height="96" data-emo="${e.id}" style="width:48px;height:48px"></canvas>
        <span>${e.name}</span><em class="pc-cost"><span class="dm"></span>${PRICE.emote}</em></button>`;
      }).join('')}
    </div>`;
  box.querySelector('#pcClose').onclick = closeModal;
  // v0.20.28：强制离座——手里有牌等本手结算生效，没牌立刻起立；再点一次取消
  const forceBtn = box.querySelector('#pcForce');
  if (forceBtn) {
    forceBtn.onclick = () => {
      const on = !p.forceOut;
      sendWS({ t: 'forceSit', seat: p.seat, on });
      toast(on ? `${p.name || '该玩家'} 将在本手结算后离座` : `已取消 ${p.name || ''} 的强制离座`, 2400);
      closeModal();
    };
  }
  // v0.20.28：赠送钻石（有分发权限的账号才看得到这个框）
  const giftBtn = box.querySelector('#pcGiftGo');
  if (giftBtn) {
    giftBtn.onclick = () => {
      const amount = Math.round(Number($('pcGiftAmt').value || 0));
      if (!Number.isInteger(amount) || amount <= 0) return toast('数量要是正整数');
      sendWS({ t: 'transfer', to: uid, amount, note: '牌桌赠送' });
      // v0.22.38：别再无脑提示「已赠」——服务端可能报错（ID 不存在 / 钻不够）。
      // 成功回执走 giftOk，失败走 error，这里只说「已发出」。
      toast('赠送请求已发出…', 1600);
      closeModal();
    };
  }
  // 异步把官方图标画进缩略图
  box.querySelectorAll('.pc-emote canvas[data-emo]').forEach(async (cv) => {
    const e = EMOTE_PROPS.find((x) => x.id === cv.dataset.emo);
    if (!e) return;
    try {
      const im = new Image();
      im.src = 'emoji/icons/prop_' + e.id + '.png';
      await im.decode();
      const ctx = cv.getContext('2d');
      ctx.clearRect(0, 0, 96, 96);
      const s = Math.min(88 / im.naturalWidth, 88 / im.naturalHeight);
      const dw = im.naturalWidth * s, dh = im.naturalHeight * s;
      ctx.drawImage(im, (96 - dw) / 2, (96 - dh) / 2, dw, dh);
    } catch { /* 图标失败就留白 */ }
  });
  box.querySelectorAll('.pc-emote').forEach((b) => {
    b.onclick = () => {
      const id = b.dataset.emo;
      // 联机：服务端扣 1 钻后再广播回来（含自己），扣费失败就不播
      if (net.mode === 'online') {
        if (!acct.user) { toast('请先登录'); return; }
        if ((acct.user.diamonds || 0) < PRICE.emote) { toast(`钻石不够，表情 ${PRICE.emote} 钻一个`); return; }
        sendWS({ t: 'emote', seat: p.seat, emo: id });
        closeModal();
        return;
      }
      // 单机练习：不收费，本地直接播
      playEmote(p.seat, id);
      playEmoteSfx(id);
      setTimeout(closeModal, 260);
    };
  });
  $('modal').classList.remove('align-left');
  $('modal').classList.remove('align-right');
  $('modal').classList.remove('hidden');
  beep(640, 0.04, 'sine', 0.02);
}

/** 表情动画：按座位坐标摆在头像上，播完自己清掉。
    v0.20.17 起全部走雪碧图序列帧（互动道具与序列帧表情同一管线） */
function playEmote(seat, id) {
  const v = state.view;
  if (!v) return;
  if (isAnimEmote(id)) return playAnimEmote(seat, id);
}

/** v0.20.16：序列帧表情——canvas 逐帧绘制（20fps），挂在座位头像上方。
   不用 CSS 背景图/img 平移：transform:scale 合成环境下大尺寸雪碧图
   溢出容器的部分会被无头/部分移动端合成器裁掉（实测），canvas 稳。 */
function playAnimEmote(seat, id) {
  const v = state.view;
  const e = findAnimEmote(id);
  if (!e || !v) return;
  const POS = posFor(v.seats.length);
  const at = POS[disp(seat)];
  if (!at) return;
  const box = document.createElement('div');
  box.className = 'emote-fx anim';
  box.style.left = `${at.x}px`;
  box.style.top = `${at.y}px`;
  const cv = document.createElement('canvas');
  cv.width = e.w; cv.height = e.h;
  cv.style.width = `${Math.round(e.w * EMOTE_SCALE)}px`;
  cv.style.height = `${Math.round(e.h * EMOTE_SCALE)}px`;
  box.appendChild(cv);
  fxLayer().appendChild(box);
  const ctx2 = cv.getContext('2d');
  const im = new Image();
  im.onload = () => {
    const fw = im.naturalWidth / e.n;
    const frameMs = 1000 / 20;
    const total = e.n * frameMs;
    const t0 = performance.now();
    (function tick(t) {
      if (!box.isConnected) return;
      const el = t - t0;
      if (el >= total) {
        // 播完：停在最后一帧，淡出收场
        cv.style.opacity = '0';
        cv.style.transform = 'translate(-50%,-50%) scale(.92)';
        setTimeout(() => box.remove(), 340);
        return;
      }
      const f = Math.min(e.n - 1, Math.floor(el / frameMs));
      ctx2.clearRect(0, 0, e.w, e.h);
      ctx2.drawImage(im, f * fw, 0, fw, im.naturalHeight, 0, 0, e.w, e.h);
      requestAnimationFrame(tick);
    })(t0);
  };
  im.src = 'emoji/' + e.f;
  setTimeout(() => box.remove(), e.dur * 1000 + 800);   // 兜底清理
  // 头像跟着抖一下（和 SVG 表情一致）
  state.emoteHit.set(seat, Date.now() + 560);
  setTimeout(() => { state.emoteHit.delete(seat); refresh(); }, 600);
}

/* 表情音效：没有现成素材，用 WebAudio 就地合成（噪声冲击 / 滑音 / 连发） */
function emoteNoise(dur, freq, gain, delay = 0, q = 1.1) {
  if (!state.sound) return;
  try {
    const a = acGet();
    const t = a.currentTime + delay;
    const s = a.createBufferSource();
    s.buffer = noiseBuffer();
    const bp = a.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = freq;
    bp.Q.value = q;
    const g = a.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(bp); bp.connect(g); g.connect(bus());
    s.start(t); s.stop(t + dur + 0.04);
  } catch { /* 忽略 */ }
}

function sweep(f1, f2, dur, type = 'sine', gain = 0.04, delay = 0) {
  if (!state.sound) return;
  try {
    const a = acGet();
    const t = a.currentTime + delay;
    const o = a.createOscillator();
    const g = a.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f1, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(40, f2), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(bus());
    o.start(t); o.stop(t + dur + 0.03);
  } catch { /* 忽略 */ }
}

/* v0.20.18：官方道具音效 mp3（素材包附赠），加载失败退回 WebAudio 合成音 */
const propSndCache = new Map();
function playPropSnd(id) {
  if (!state.sound) return;
  let a = propSndCache.get(id);
  if (!a) {
    a = new Audio(`emoji/sfx/daoju_${id}.mp3`);
    a.preload = 'auto';
    propSndCache.set(id, a);
  }
  try {
    a.currentTime = 0;
    a.volume = 0.85;
    const p = a.play();
    if (p && p.catch) p.catch(() => playEmoteSfxFallback(id));
    // 大炮：爆炸延时补一发收尾音
    if (id === 'dapao') {
      setTimeout(() => {
        if (!state.sound) return;
        try {
          const e2 = propSndCache.get('dapao_end') || (() => {
            const x = new Audio('emoji/sfx/daoju_dapao_end.mp3');
            x.preload = 'auto';
            propSndCache.set('dapao_end', x);
            return x;
          })();
          e2.currentTime = 0;
          e2.volume = 0.85;
          e2.play().catch(() => {});
        } catch { /* 忽略 */ }
      }, 650);
    }
  } catch { playEmoteSfxFallback(id); }
}

function playEmoteSfxFallback(id) {
  if (!state.sound) return;
  switch (id) {
    case 'bingtong':    // 冰桶泼水：哗啦 + 冰块脆响
      emoteNoise(0.55, 1300, 0.36, 0, 0.6);
      emoteNoise(0.4, 700, 0.22, 0.12, 0.7);
      beep(1750, 0.07, 'triangle', 0.03);
      beep(2200, 0.05, 'triangle', 0.02);
      break;
    case 'cishuiqiang': // 呲水枪：长喷 + 溅射
      emoteNoise(0.8, 1600, 0.3, 0, 0.5);
      emoteNoise(0.5, 900, 0.24, 0.3, 0.6);
      sweep(700, 1500, 0.14, 'square', 0.018, 0.05);
      break;
    case 'dao':         // 砍刀：嗖嗖挥砍 + 闷击
      for (let i = 0; i < 3; i++) sweep(2400 - i * 500, 300, 0.12, 'sawtooth', 0.03, i * 0.22);
      emoteNoise(0.14, 320, 0.5, 0.68, 0.8);
      break;
    case 'dapao':       // 大炮：低频轰 + 爆炸
      sweep(160, 40, 0.35, 'square', 0.05);
      emoteNoise(0.5, 260, 0.6, 0.12, 0.5);
      emoteNoise(0.3, 900, 0.26, 0.2, 0.7);
      break;
    default:
      beep(700, 0.06, 'sine', 0.03);
  }
}

function playEmoteSfx(id) {
  if (!state.sound) return;
  // 官方音效只覆盖互动道具；x 系列表情继续走合成音
  if (EMOTE_PROPS.some((e) => e.id === id)) return playPropSnd(id);
  playEmoteSfxFallback(id);
}

/* ── 交互 ─────────────────────────────────── */
function enterRaise() {
  const v = state.view;
  state.raiseMode = true;
  state.raiseValue = Math.min(v.minRaise || v.raiseAmount, v.maxRaise || v.raiseAmount);
  refresh();
}

/* 竖向拉条面板：加注 / 添簸 共用一套 */
function openSheet(kind) {
  const v = state.view;
  const m = me();
  if (!v || !m) return;
  const lo = Math.max(1, v.minRaise || 1);
  const hi = Math.max(lo, v.maxRaise || lo);
  const step = v.raiseStep || 1;   // 5/10 每 5、10/20 每 10…（1/2、2/5 仍是 1）
  const title = '加注到';
  const okText = '加注';

  closeSheet();
  state.sheet = { kind: kind || 'raise', lo, hi, step, val: lo, allIn: hi };

  const sheet = document.createElement('div');
  sheet.id = 'sheet';
  sheet.className = 'raise-sheet';
  sheet.innerHTML = `
    <div class="head"><span>${title}</span><b id="sheetNum">0</b></div>
    <div class="vslide-body">
      <div class="vslide-body-in">
        <div class="vslide" id="vSlide">
          <div class="vslide-track"></div>
          <div class="vslide-fill" id="sheetFill"></div>
          <div class="vslide-knob" id="sheetKnob"></div>
        </div>
        <div class="vslide-marks"><span id="sheetMax"></span><span id="sheetMin"></span></div>
      </div>
    </div>
    <div class="acts">
      <button class="act danger" id="sheetCancel">取消</button>
      <button class="act primary" id="sheetOk">${okText}</button>
    </div>`;
  stage.appendChild(sheet);
  bindVerticalSlide($('vSlide'));
  $('sheetCancel').onclick = closeSheet;
  $('sheetOk').onclick = confirmSheet;
  $('sheetMax').textContent = `最多 ${hi.toLocaleString()}`;
  $('sheetMin').textContent = `最少 ${lo.toLocaleString()}`;
  paintSheet();
  const bar = $('actionBar');
  if (bar) bar.innerHTML = '';   // 面板自带按钮，底部先收起
}

function bindVerticalSlide(track) {
  const ratioFromEvent = (ev) => {
    const r = track.getBoundingClientRect();
    return Math.max(0, Math.min(1, 1 - (ev.clientY - r.top) / r.height)); // 上=大
  };
  const apply = (ev) => {
    const sh = state.sheet;
    if (!sh) return;
    const raw = sh.lo + ratioFromEvent(ev) * (sh.hi - sh.lo);
    let val = Math.round(raw / sh.step) * sh.step;
    // 差一格就算推到顶：直接当「敲（全下）」
    if (val >= sh.hi - sh.step) val = sh.hi;
    val = Math.max(sh.lo, Math.min(sh.hi, val));
    if (val !== sh.val) { sh.val = val; beep(660, 0.02, 'sine', 0.012); }
    paintSheet();
  };
  track.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    track.setPointerCapture(ev.pointerId);
    apply(ev);
    const move = (e2) => apply(e2);
    const up = () => {
      track.removeEventListener('pointermove', move);
      track.removeEventListener('pointerup', up);
      track.removeEventListener('pointercancel', up);
    };
    track.addEventListener('pointermove', move);
    track.addEventListener('pointerup', up);
    track.addEventListener('pointercancel', up);
  });
}

function paintSheet() {
  const sh = state.sheet;
  if (!sh) return;
  const k = sh.hi > sh.lo ? (sh.val - sh.lo) / (sh.hi - sh.lo) : 1;
  const num = $('sheetNum');
  if (num) num.textContent = sh.val.toLocaleString();
  const fill = $('sheetFill');
  if (fill) fill.style.height = `${Math.max(2, k * 100)}%`;
  const knob = $('sheetKnob');
  if (knob) knob.style.bottom = `${k * 100}%`;
  // 拖到顶 = 把簸簸全推上去，等价于「敲」
  const ok = $('sheetOk');
  if (ok) ok.textContent = sh.val >= sh.hi ? '敲 · 全下' : '加注';
}

function confirmSheet() {
  const sh = state.sheet;
  if (!sh) return;
  const allIn = sh.val >= sh.hi;    // 拖到顶就是全下，走「敲」，别用加注绕
  const { val } = sh;
  closeSheet();
  if (allIn) humanAct('knock');
  else humanAct('raise', val);
}

function closeSheet() {
  const sheet = $('sheet');
  if (sheet) sheet.remove();
  const had = !!state.sheet;
  state.sheet = null;
  if (state.raiseMode) state.raiseMode = false;
  if (had) refresh();
}

/* v0.22.94：吞点击埋点——按钮点了没反应 historically 全是静默 return，perf 里看不到。
 * 现在按原因上报（3 秒限频防刷屏），下次实测就能定量区分「断线丢消息/演出锁/回合锁/清单锁」。
 * 同时修掉最大的静默丢失：断线时裸 send 导致点击无声消失——改为提示+立即重连，按钮不按灭。 */
let _swallowAt = {};
function swallowReport(why) {
  try {
    const now = Date.now();
    if (now - (_swallowAt[why] || 0) < 3000) return;
    _swallowAt[why] = now;
    if (!perfEnabled()) return;
    const u = new URL(wsEndpoint());
    const dv = document.documentElement;
    fetch(u.protocol.replace(/^ws/, 'http') + '//' + u.host + '/client-crash', {
      method: 'POST',
      body: '[PERF] ' + JSON.stringify({ k: 'swallow:' + why, ua: perfUA(), v: (dv && dv.dataset.ver) || '', ts: now }),
      keepalive: true,
    }).catch(() => {});
  } catch (e) { /* 埋点失败不影响游戏 */ }
}

function humanAct(action, amount) {
  const v = state.view;
  if (!v || v.phase !== PHASE.BET || v.currentSeat !== mySeat() || state.busy) { swallowReport('phase'); return; }
  // v0.22.51：开手演出期间一律不接受行动（含加注条残留时的确认）
  if (state.handFx) { swallowReport('handfx'); return; }
  // 服务端给的动作清单是唯一标准：不在清单里的（比如有人下注后的「休」）直接忽略
  if (Array.isArray(v.legalActions) && !v.legalActions.includes(action)) { swallowReport('legal'); return; }

  if (net.mode === 'online') {
    // v0.22.94：WS 非 OPEN 时点击不再无声丢失——提示 + 立即重连，且不按灭按钮
    const ws = net.ws;
    if (!ws || ws.readyState !== 1) {
      swallowReport('deadws');
      toast('网络中断，正在重连…', 2000);
      try { if (ws && ws.readyState === 3) ws.close(); } catch { /* 已断 */ }
      try { connect(); } catch { /* 下一拍兜底 */ }
      return;
    }
    perfBegin('act:' + action);   // B测量：点击→回包→画面
    // v0.22.78：乐观反馈——先冒动作气泡 + 按灭按钮，不等回包
    optBegin(action);
    try {
      ws.send(JSON.stringify({ t: 'act', action, amount }));
    } catch (e) {
      swallowReport('sendfail');
      toast('发送失败，正在重连…', 2000);
      try { ws.close(); } catch { /* 忽略 */ }
      try { connect(); } catch { /* 忽略 */ }
    }
    // 声音等服务端回包统一播（按 seq 去重），这里不再自己响一次
    return;
  }

  state.busy = true;
  try {
    state.game.act(mySeat(), action, amount);
  } catch (e) {
    toast(e.message);
  } finally {
    state.busy = false;
  }
  refresh();
  drive();
}

function toggleHeadPick(i) {
  if (state.headPicked.includes(i)) {
    state.headPicked = state.headPicked.filter((x) => x !== i);
  } else if (state.headPicked.length < 2) {
    state.headPicked = [...state.headPicked, i];
  } else {
    // 已经选了两张：点第三张就顶掉先选的那张
    state.headPicked = [state.headPicked[1], i];
  }

  // 选满两张立即判定，头尾由系统按牌力排（谁大谁做头）
  state.splitStep = state.headPicked.length === 2 ? 1 : 0;
  beep(state.splitStep === 1 ? 760 : 600, state.splitStep === 1 ? 0.08 : 0.04,
    state.splitStep === 1 ? 'triangle' : 'sine', 0.02);
  refresh();
}

/** 当前应当展示的拆分：唯一拆法直接用，否则看玩家选的两张 */
function visibleSplit(m) {
  if (!m || !m.splitOptions) return null;
  if (m.splitOptions.length === 1) return splitFromOption(m.splitOptions[0], m.cardsView);
  return currentSplit();
}

/** 引擎已锁定唯一拆法（丁皇）时，按牌 id 还原头尾下标 */
function splitFromOption(opt, cards) {
  if (!opt || !cards || cards.length < 4) return null;
  const idxOf = (list) => list
    .map((c) => cards.findIndex((x) => x && x.id === c.id))
    .filter((i) => i >= 0);
  const headIdx = idxOf(opt.headCards);
  const tailIdx = idxOf(opt.tailCards);
  if (headIdx.length !== 2 || tailIdx.length !== 2) return null;
  return { head: opt.head, tail: opt.tail, headIdx, tailIdx };
}

/** 根据已选的两张，算出哪一组是头、哪一组是尾 */
function currentSplit() {
  const m = me();
  if (!m || !m.cardsView || m.cardsView.length < 4 || state.headPicked.length !== 2) return null;
  const picked = state.headPicked;
  const iA = picked;
  const iB = m.cardsView.map((_, i) => i).filter((i) => !picked.includes(i));
  if (iA.length !== 2 || iB.length !== 2) return null;
  if (iA.some((i) => !m.cardsView[i]) || iB.some((i) => !m.cardsView[i])) return null;

  const dijiuOn = (state.view && state.view.dijiuOn) !== false;  // v0.22.67：本桌关地九王时 2+9 按 1 点
  const eA = evaluatePair(m.cardsView[iA[0]], m.cardsView[iA[1]], dijiuOn);
  const eB = evaluatePair(m.cardsView[iB[0]], m.cardsView[iB[1]], dijiuOn);
  const aIsHead = comparePair(eA, eB) >= 0;
  return {
    head: aIsHead ? eA : eB,
    tail: aIsHead ? eB : eA,
    headIdx: aIsHead ? iA : iB,
    tailIdx: aIsHead ? iB : iA,
  };
}

function resetHead() {
  state.splitStep = 0;
  state.headPicked = [];
  refresh();
}

function updatePreview() {
  const el = $('splitPreview');
  if (!el) return;
  const m = me();
  const v = state.view;
  // 分牌阶段：头尾点数已经写在桌面托盘的标签里，这条不再重复挂在桌上
  const sp = (m && m.splitOptions && (!v || v.phase !== PHASE.SPLIT))
    ? visibleSplit(m) : null;
  if (!sp) {
    el.classList.remove('show');
    return;
  }
  el.innerHTML = `<span><em>头</em><b>${pairLabel(sp.head)}</b></span>`
    + `<span><em>尾</em><b>${pairLabel(sp.tail)}</b></span>`;
  el.classList.add('show');
}

function confirmSplit() {
  const m = me();
  const sp = currentSplit();
  if (!m || !m.splitOptions || !sp) return;
  const ids = sp.headIdx.map((i) => m.cardsView[i].id).sort().join();
  const idx = m.splitOptions.findIndex((o) => {
    const h = o.headCards.map((c) => c.id).sort().join();
    const t = o.tailCards.map((c) => c.id).sort().join();
    return h === ids || t === ids;
  });
  if (idx < 0) { toast('这四张分不出来，重新选'); resetHead(); return; }
  humanSplit(idx);
}

function humanSplit(index) {
  closeModal();
  if (state.splitSent) return;          // 连点无效：这一手只提交一次
  state.splitSent = true;               // 先把键按灭，再发请求
  if (state.splitRetry) clearTimeout(state.splitRetry);
  // 服务器没回音 / 断线时别把键永久锁死，6 秒后放开让玩家重试
  state.splitRetry = setTimeout(() => {
    const v = state.view;
    const mm = me();
    if (v && v.phase === PHASE.SPLIT && mm && mm.splitOptions && !mm.split) {
      state.splitSent = false;
      refresh();
    }
  }, 6000);

  if (net.mode === 'online') {
    if (!sendWS({ t: 'split', index })) {
      state.splitSent = false;
      toast('网络断开，分牌没发出去');
      refresh();
      return;
    }
    perfBegin('split');   // B测量：点击→回包→画面
    optBegin('split');                // v0.22.78：乐观气泡「分牌」，回包后校正
    beep(720, 0.09, 'sine');
    refresh();                          // 立刻重画：确认键变灰
    return;
  }

  try {
    state.game.chooseSplit(mySeat(), index);
    beep(720, 0.09, 'sine');
  } catch (e) {
    state.splitSent = false;
    toast(e.message);
  }
  refresh();
  drive();
}

function humanDecline() {
  closeModal();
  if (net.mode === 'online') {
    net.ws.send(JSON.stringify({ t: 'decline' }));
    beep(300, 0.1, 'sine');
    return;
  }
  try {
    state.game.declineSpecial(mySeat());
    beep(300, 0.1, 'sine');
  } catch (e) {
    toast(e.message);
  }
  refresh();
  drive();
}

function nextHand() {
  const g = state.game;
  if (!g) return;
  clearTimeout(state.nextTimer);
  state.nextTimer = null;
  state.seen.clear();
  // 回顾 / 战绩面板打开时不动它：牌局照常走，面板自己刷新
  // v0.22.88：结算页（ended）同样不许被自动关——房主收摊后弹的战绩清单，
  // 下一手开局/渲染周期一律不碰，只留给它自己的按钮和 10 秒倒计时关
  if (!['log', 'stats', 'ended'].includes($('modalBox').dataset.kind)) closeModal();
  g.banker = (g.banker + 1) % g.seats.length;
  g.startHand();
  refresh();
  drive();
}

/* ── 本地 AI 驱动 ─────────────────────────── */
const AI_POOL = ['幺鸡', '三娃', '李嬢嬢', '王大爷', '陈二娃', '刘姐', '赵幺爸', '孙婆婆'];

/** 机器人离座：过一会儿换个新面孔补位，桌子不满员也能接着打 */
function fillEmptySeats() {
  if (net.mode !== 'local' || !state.game) return false;
  const g = state.game;
  const now = Date.now();
  state.awayAt = state.awayAt || new Map();
  let changed = false;
  for (const p of g.seats) {
    if (!p.isAI) continue;
    if (!p.away) { state.awayAt.delete(p.seat); continue; }
    if (!state.awayAt.has(p.seat)) { state.awayAt.set(p.seat, now); continue; }
    if (now - state.awayAt.get(p.seat) < 1800) continue;
    const used = new Set(g.seats.map((x) => x.name));
    const name = AI_POOL.find((n) => !used.has(n)) || AI_POOL[Math.floor(Math.random() * AI_POOL.length)];
    try {
      g.sitDown(p.seat, { name, stack: g.buyIn });
      state.awayAt.delete(p.seat);
      changed = true;
    } catch (e) { /* 忽略 */ }
  }
  return changed;
}

function drive() {
  if (net.mode === 'online') return;
  clearTimeout(state.timer);
  const g = state.game;
  if (!g) return;

  // 机器人簸簸空了就自己带回，别让桌子越打越少人
  const before = g.seats.map((p) => `${p.stack}/${p.name}/${p.away}`).join(',');
  fillEmptySeats();
  if (g.seats.map((p) => `${p.stack}/${p.name}/${p.away}`).join(',') !== before) refresh();

  if (g.phase === PHASE.BET) {
    const s = g.currentSeat;
    if (s < 0) return;
    if (g.seats[s].isAI || AUTO) {
      // ?slow 调试用：机器人慢慢走，方便截别人的读秒
      const wait = PARAMS.has('slow') ? 6000 : 560 + Math.random() * 420;
      state.timer = setTimeout(aiStep, wait);
    }
    return;
  }

  if (g.phase === PHASE.SPLIT) {
    const pending = g.aliveSeats().filter((x) => !g.seats[x].split);
    if (!pending.length || STOP_SPLIT) return;
    if (pending.every((x) => g.seats[x].isAI) || AUTO) {
      state.timer = setTimeout(() => {
        for (const x of pending) {
          const p = g.seats[x];
          const best = p.splitOptions.reduce((a, b) => (b.score > a.score ? b : a), p.splitOptions[0]);
          g.chooseSplit(x, p.splitOptions.indexOf(best));
        }
        refresh();
        drive();
      }, 500);
    }
  }
}

function aiStep() {
  const g = state.game;
  if (g.phase !== PHASE.BET) return;
  const s = g.currentSeat;
  const p = g.seats[s];
  if (!p || (!p.isAI && !AUTO)) return;
  const d = decide(g, s);
  if (NOFOLD && s === 0 && d.action === 'fold') {
    const la = g.legalActions(s);
    d.action = la.includes('follow') ? 'follow' : la.includes('pass') ? 'pass' : 'knock';
  }
  try {
    g.act(s, d.action);
  } catch {
    try { g.act(s, 'fold'); } catch { /* 忽略 */ }
  }
  if (d.action !== 'pass') beep(d.action === 'fold' ? 200 : 420, 0.05, 'sine', 0.022);
  refresh();
  drive();
}

/* ── 分牌面板 ─────────────────────────────── */
function showSplitPanel() {
  const m = me();
  if (!m || !m.splitOptions) return;
  if (!$('modal').classList.contains('hidden') && $('modalBox').dataset.kind === 'split') return;

  const box = $('modalBox');
  box.dataset.kind = 'split';
  box.innerHTML = `
    <h2>分牌</h2>
    ${m.canDecline ? `<button class="act danger decline-btn" id="btnDecline">
      丢弃（${m.canDecline}）</button>` : ''}
    <div class="my-four" id="myFour"></div>
    <div class="split-options" id="splitOpts"></div>`;

  if (m.canDecline) box.querySelector('#btnDecline').onclick = humanDecline;

  const four = box.querySelector('#myFour');
  (m.cardsView || []).forEach((c) => four.appendChild(cardEl(c, { small: true })));

  const bestScore = Math.max(...m.splitOptions.map((o) => o.score));
  const wrap = box.querySelector('#splitOpts');

  m.splitOptions.forEach((opt, i) => {
    const d = document.createElement('div');
    d.className = 'split-opt';
    d.onclick = () => humanSplit(i);

    const badge = document.createElement('div');
    badge.className = 'split-tag' + (opt.score === bestScore ? ' best' : '');
    badge.textContent = opt.score === bestScore ? '推荐' : `方案 ${i + 1}`;

    const head = document.createElement('div');
    head.className = 'split-label';
    head.textContent = '头（大）';
    const row1 = document.createElement('div');
    row1.className = 'split-row';
    opt.headCards.forEach((c) => row1.appendChild(cardEl(c, { small: true })));
    const n1 = document.createElement('div');
    n1.className = 'split-name';
    n1.textContent = pairLabel(opt.head);

    const tail = document.createElement('div');
    tail.className = 'split-label';
    tail.textContent = '尾（小）';
    const row2 = document.createElement('div');
    row2.className = 'split-row';
    opt.tailCards.forEach((c) => row2.appendChild(cardEl(c, { small: true })));
    const n2 = document.createElement('div');
    n2.className = 'split-name';
    n2.textContent = pairLabel(opt.tail);

    d.append(badge, head, row1, n1, tail, row2, n2);
    wrap.appendChild(d);
  });

  $('modal').classList.remove('hidden');
}

/* ── 结算面板 ─────────────────────────────── */
function showResult() {
  const v = state.view;
  if (!v || !v.result) return;
  const box = $('modalBox');
  if (box.dataset.kind === 'result') return;
  box.dataset.kind = 'result';

  const rows = [...v.result.reveal]
    .sort((a, b) => b.delta - a.delta)
    .map((p) => {
      const cls = p.delta > 0 ? 'win' : p.delta < 0 ? 'lose' : '';
      const sign = p.delta > 0 ? '+' : '';
      let desc = '—';
      if (p.special) desc = p.special;
      else if (p.folded) desc = '已弃牌';
      else if (p.split) {
        const f = (x) => x.name + (x.tier === 0 ? ' ' + Math.floor(x.tie / 1000) + '点' : '');
        desc = `头 ${f(p.split.head)} · 尾 ${f(p.split.tail)}`;
      }
      const isMe = p.seat === v.viewerSeat;
      return `<tr${isMe ? ' style="background:rgba(227,189,122,.06)"' : ''}>
        <td>${p.name}${p.seat === v.banker ? ' <span style="color:#9d7c46">· 庄</span>' : ''}</td>
        <td><div class="rcards">${p.hand.map((c) => cardEl(c, { small: true }).outerHTML).join('')}</div></td>
        <td style="color:#a89e8c;font-size:11px">${desc}</td>
        <td class="${cls}" style="text-align:right;font-variant-numeric:tabular-nums">${sign}${p.delta}</td>
      </tr>`;
    })
    .join('');

  const potWins = (v.result.potWinners && v.result.potWinners.length
    ? v.result.potWinners
    : (v.result.potWinner == null ? [] : [v.result.potWinner]))
    .map((s) => v.seats.find((x) => x.seat === s)?.name)
    .filter(Boolean);

  const potLine = `${(v.result.sidePot || 0) > 0
    ? `皮池 ${v.result.pot}（主 ${v.result.mainPot} · 边 ${v.result.sidePot}）归 ${potWins.join('、') || '—'}${potWins.length > 1 ? ' · 均分' : ''}`
    : `皮池 ${v.result.pot} 归 ${potWins.length ? potWins.join('、') : '—'}${potWins.length > 1 ? ' · 均分' : ''}`}`;
  // 芒果池只报总额，不列分配明细
  const mangoLine = (v.result.mangoPool || 0) > 0 ? `芒果池 ${v.result.mangoPool}` : '';
  box.innerHTML = `
    <h2>第 ${v.handNo} 局结算</h2>
    <div class="sub">${potLine}${mangoLine ? `<br>${mangoLine}` : ''}</div>
    <table class="result-table">
      <colgroup><col class="c1"><col class="c2"><col><col class="c4"></colgroup>
      <thead><tr><th>玩家</th><th>手牌</th><th>分牌 / 牌型</th><th style="text-align:right">输赢</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="result-foot">
      ${net.mode === 'online' ? '' : '<button class="act primary" id="btnNext">下一局</button>'}
    </div>`;

  if (net.mode === 'local') {
    box.querySelector('#btnNext').onclick = () => { beep(660, 0.08, 'triangle'); nextHand(); };
  }
  $('modal').classList.remove('hidden');

  const mine = v.seats.find((s) => s.seat === v.viewerSeat);
  if (mine && mine.delta > 0) beep(880, 0.12, 'triangle', 0.05);
  else if (mine && mine.delta < 0) beep(180, 0.16, 'sine', 0.04);
}

/* ── 确认弹窗：结束牌局 / 退出牌局这种「点了就回不去」的动作，
 * 一律走游戏内的确定/取消，不用系统 confirm（手机上又丑又会把音效打断）。 */
function askConfirm({ title, text = '', ok = '确定', cancel = '取消', danger = false }) {
  return new Promise((resolve) => {
    const box = $('modalBox');
    box.dataset.kind = 'confirm';
    box.innerHTML = `
      <h2>${title}</h2>
      ${text ? `<div class="sub">${text}</div>` : ''}
      <div class="ask-acts">
        <button class="act" id="askNo" type="button">${cancel}</button>
        <button class="act ${danger ? 'danger' : 'primary'}" id="askYes" type="button">${ok}</button>
      </div>`;
    const done = (v) => {
      $('modal').classList.add('hidden');
      resolve(v);
    };
    box.querySelector('#askNo').onclick = () => { beep(420, 0.05, 'sine', 0.02); done(false); };
    box.querySelector('#askYes').onclick = () => { beep(700, 0.06, 'triangle', 0.035); done(true); };
    $('modal').classList.remove('align-left');
    $('modal').classList.remove('align-right');
    $('modal').classList.remove('hidden');
  });
}

/* ── v0.20.71 桌面设置：牌背 / 牌桌风格 ──────────────────────────
 * 纯本机外观偏好，写 localStorage；开关挂在 <html> 上，CSS 据此给
 * .card.back / .flip-back / .scratch-back / .felt 换皮（见 style.css 末尾）。
 * 牌背与桌布互相独立，各自可选「经典」回到内置默认。 */
const DESK_LS = 'dh_desk_skin_v1';
const DESK_BACKS = [
  { id: 'classic', name: '经典紫' },
  { id: 'b1', name: '红桃王', img: 'img/backs/b1.webp' },
  { id: 'b2', name: '青花蓝', img: 'img/backs/b2.webp' },
  { id: 'b3', name: '鎏金格', img: 'img/backs/b3.webp' },
  { id: 'b4', name: '朱砂桃', img: 'img/backs/b4.webp' },
];
const DESK_CLOTHS = [
  { id: 'classic', name: '经典青' },
  { id: 'c1', name: '碧山绿', img: 'img/cloths/c1.webp' },
  { id: 'c5', name: '烟青蓝', img: 'img/cloths/c5.webp' },
  { id: 'c2', name: '典雅黑', img: 'img/cloths/c2.webp' },
  { id: 'c4', name: '翠微绿', img: 'img/cloths/c4.webp' },
  { id: 'c3', name: '暮山紫', img: 'img/cloths/c3.webp' },
];
/* v0.22.66：默认外观改成「鎏金格」牌背 + 「典雅黑」牌桌。
   只影响没存过偏好的账号（新号 / 清过站点数据）；已手动选过的照旧沿用。 */
const DESK_DEFAULT = { back: 'b3', cloth: 'c2' };
function deskSkin() {
  try {
    const s = JSON.parse(localStorage.getItem(DESK_LS) || '{}');
    return {
      back: DESK_BACKS.some((x) => x.id === s.back) ? s.back : DESK_DEFAULT.back,
      cloth: DESK_CLOTHS.some((x) => x.id === s.cloth) ? s.cloth : DESK_DEFAULT.cloth,
    };
  } catch { return { ...DESK_DEFAULT }; }
}
function applyDeskSkin(s) {
  const root = document.documentElement;
  const back = DESK_BACKS.find((x) => x.id === s.back) || DESK_BACKS[0];
  const cloth = DESK_CLOTHS.find((x) => x.id === s.cloth) || DESK_CLOTHS[0];
  root.dataset.back = back.id;
  root.dataset.cloth = cloth.id;
  if (back.img) root.style.setProperty('--back-photo', `url("${back.img}")`);
  else root.style.removeProperty('--back-photo');
  if (cloth.img) root.style.setProperty('--cloth-photo', `url("${cloth.img}")`);
  else root.style.removeProperty('--cloth-photo');
  // 洗牌精灵图也跟着牌背换（换皮图在 img/wash_<id>.webp）；换过就重新预加载，
  // 不然下一手洗牌还在用上一张牌背的动画。
  const nextSrc = back.img ? `img/wash_${back.id}.webp` : WASH_SPRITE_URL;
  if (nextSrc !== washSpriteSrc) {
    washSpriteSrc = nextSrc;
    washImg = null;
    preloadWashSprite();
  }
}
applyDeskSkin(deskSkin());   // 首帧就生效，别先闪一下默认皮

/* ── v0.20.76：麦克风自检 ────────────────────────────────────────
   把「为什么手机设置里找不到本游戏麦克风」讲清楚，并给一条能落地的主路：
   用系统浏览器打开完整链接（带 sharecode），首次按住话筒时浏览器才会弹
   系统授权框；授权后权限项出现在「浏览器 / 宿主 App」名下，而不是游戏名下。
   面板里逐项体检当前环境，按钮可一键复制完整链接 / 试探一次授权。 */
function openMicCheck() {
  let pop = $('micPop');
  if (pop) { pop.remove(); return; }
  const framed = micInFrame();
  const secure = !!window.isSecureContext;
  const hasAPI = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  const line = (ok, label, val) =>
    `<div class="mic-row"><i class="${ok ? 'ok' : 'no'}"></i><span>${label}</span><b>${val}</b></div>`;
  pop = document.createElement('div');
  pop.id = 'micPop';
  pop.className = 'desk-pop';
  pop.innerHTML = `
    <div class="desk-panel">
      <div class="desk-head"><b>麦克风自检</b><button type="button" class="desk-x" aria-label="关闭">×</button></div>
      <div class="mic-rows">
        ${line(secure, '安全连接', secure ? 'HTTPS ✓' : '非 HTTPS ✗')}
        ${line(!framed, '页面环境', framed ? '嵌在内嵌窗口' : '独立窗口 ✓')}
        ${line(hasAPI, '录音接口', hasAPI ? '可用 ✓' : '不可用 ✗')}
        ${line(!voiceStat.lastError, '最近一次', voiceStat.lastError || '正常')}
      </div>
      <div class="mic-why">
        <b>为什么手机设置里找不到「本游戏」的麦克风？</b><br>
        这是网页，不是单独安装的 App。麦克风权限登记在<b>打开它的浏览器 / 宿主 App</b>
        名下（iOS：设置→浏览器→麦克风；安卓：浏览器→网站设置→麦克风），系统不会
        单列一个「宽窄·丁二皇」。若页面嵌在聊天/预览的内嵌窗口里，还可能被权限策略
        直接禁用、连授权框都不弹——这就是「显示没授权、设置里又找不到」的原因。
      </div>
      <div class="mic-why">
        <b>怎么才能用上：</b>点下方「复制完整链接」→ 粘贴到<b>系统浏览器</b>（Safari / Chrome）
        打开 → 坐下后<b>按住话筒</b>，在弹框里点「允许」。授权一次后即可正常对讲。
      </div>
      <div class="mic-acts">
        <button type="button" class="act" id="micCopy">复制完整链接</button>
        <button type="button" class="act primary" id="micProbe">试一次授权</button>
      </div>
      <div class="desk-tip">链接自带分享码；换浏览器或清过网站数据后需重新授权一次。</div>
    </div>`;
  document.body.appendChild(pop);
  pop.querySelector('.desk-x').onclick = () => pop.remove();
  pop.addEventListener('click', (ev) => { if (ev.target === pop) pop.remove(); });
  const full = pageUrl().split('#')[0];
  pop.querySelector('#micCopy').onclick = () => {
    const done = () => toast('完整链接已复制，去系统浏览器粘贴打开', 2600);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(full).then(done).catch(() => fallbackCopy(full, done));
    } else fallbackCopy(full, done);
  };
  pop.querySelector('#micProbe').onclick = async () => {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast('当前环境没有麦克风接口，请用系统浏览器打开完整链接', 3000); return;
    }
    try {
      const s = await requestMicStream();
      s.getTracks().forEach((t) => t.stop());
      voiceStat.lastError = '';
      toast('麦克风可用 ✓ 回到牌桌按住话筒即可说话', 2800);
      pop.remove();
    } catch (e) {
      voiceStat.lastError = String((e && e.name) || e);
      toast(micErrorHint(e), 3600);
    }
  };
}

function openDeskSettings() {
  let pop = $('deskPop');
  if (pop) { pop.remove(); return; }
  const s = deskSkin();
  const cardsHTML = (opts, kind, cur) => opts.map((o) => {
    const on = o.id === cur ? ' on' : '';
    const thumbCls = kind === 'cloth' ? 'desk-thumb desk-cloth' : 'desk-thumb';
    const thumb = o.img
      ? `<span class="${thumbCls}" style="background-image:url('${o.img}')"></span>`
      : `<span class="${thumbCls} ${kind === 'cloth' ? 'classic-cloth' : 'classic'}"></span>`;
    const foot = kind === 'back'
      ? '<span class="desk-radio"></span>'
      : `<span class="desk-name">${o.name}</span>`;
    return `<button type="button" class="desk-card${on}" data-kind="${kind}" data-id="${o.id}" aria-label="${o.name}">${thumb}${foot}</button>`;
  }).join('');
  pop = document.createElement('div');
  pop.id = 'deskPop';
  pop.className = 'desk-pop';
  pop.innerHTML = `
    <div class="desk-panel">
      <div class="desk-head"><b>桌面设置</b><button type="button" class="desk-x" aria-label="关闭">×</button></div>
      <div class="desk-sec">
        <h3>牌背设置</h3>
        <div class="desk-row">${cardsHTML(DESK_BACKS, 'back', s.back)}</div>
      </div>
      <div class="desk-sec">
        <h3>牌桌风格</h3>
        <div class="desk-row">${cardsHTML(DESK_CLOTHS, 'cloth', s.cloth)}</div>
      </div>
      <div class="desk-tip">只改你自己看到的样子，不影响牌局和其他人；点一下立刻生效，下次进来还记着。</div>
    </div>`;
  document.body.appendChild(pop);
  pop.querySelector('.desk-x').onclick = () => pop.remove();
  pop.addEventListener('click', (ev) => {
    if (ev.target === pop) { pop.remove(); return; }   // 点弹窗外的空白关闭
    const card = ev.target.closest('.desk-card');
    if (!card) return;
    const cur = deskSkin();
    cur[card.dataset.kind] = card.dataset.id;
    try { localStorage.setItem(DESK_LS, JSON.stringify(cur)); } catch {}
    applyDeskSkin(cur);
    pop.querySelectorAll(`.desk-card[data-kind="${card.dataset.kind}"]`).forEach((c) => {
      c.classList.toggle('on', c === card);
    });
  });
}

/* ── 左上角菜单 ───────────────────────────── */
function toggleMenu(force) {
  let pop = $('menuPop');
  if (pop && force !== true) { pop.remove(); return; }
  if (pop) return;
  pop = document.createElement('div');
  pop.id = 'menuPop';
  pop.className = 'menu-pop';
  const m0 = me();
  // 牌局中挂起的那一份还没写进快照，单独看 roomMeta 的标记
  const onHoldLeave = !!(m0 && (m0.holdLeave || (state.view && state.view.myHoldLeave)));
  const online = net.mode === 'online';
  // v0.20.52：钻石余额已从菜单移到左上角常驻，菜单里不再重复显示
  pop.innerHTML = `
    <button class="menu-item" id="mBring">带入金币</button>
    <button class="menu-item" id="mWatch">站起围观</button>
    <button class="menu-item" id="mHoldLeave">${onHoldLeave ? '取消保位' : '保位离桌'}</button>
    <button class="menu-item" id="mRules">规则说明</button>
    <button class="menu-item" id="mDesk">桌面设置</button>
    ${online ? '<button class="menu-item" id="mInvite">邀请好友</button>' : ''}
    <button class="menu-item" id="mSound">音效<span id="mSoundState">${state.sound ? '开' : '关'}</span></button>
    <button class="menu-item" id="mMic">麦克风自检</button>
    ${online && net.isOwner ? '<button class="menu-item danger" id="mEnd">结束牌局</button>' : ''}
    ${online && net.isOwner && (state.view && state.view.forceOut || []).length
      ? '<button class="menu-item" id="mForce">强制离座名单</button>' : ''}
    ${online ? '<button class="menu-item danger" id="mQuit">退出牌局</button>' : ''}`;
  stage.appendChild(pop);
  pop.querySelector('#mBring').onclick = () => { pop.remove(); openBringIn(); };
  pop.querySelector('#mRules').onclick = () => { pop.remove(); showRules(); };
  pop.querySelector('#mDesk').onclick = () => {
    pop.remove();
    openDeskSettings();
  };
  // 站起围观：有牌就等这一手结算完让座，没牌立刻站起来
  pop.querySelector('#mWatch').onclick = () => {
    pop.remove();
    if (watching() || !me()) { toast('你已经在旁观了'); return; }
    if (net.mode !== 'online') { toast('单机练习没有围观位'); return; }
    sendWS({ t: 'standUp' });
  };
  // 保位离桌：这一手结算后开始留座倒计时，倒计时读完自动让座；再点一次撤回
  pop.querySelector('#mHoldLeave').onclick = () => {
    pop.remove();
    if (watching() || !me()) { toast('先坐下再保位'); return; }
    if (net.mode !== 'online') { toast('单机练习没有留座'); return; }
    sendWS({ t: 'holdLeave', cancel: onHoldLeave });
  };
  const inviteBtn = pop.querySelector('#mInvite');
  if (inviteBtn) {
    inviteBtn.onclick = () => {
      pop.remove();
      const link = inviteLink(net.roomId);
      if (navigator.share) { navigator.share({ title: '宽窄·丁二皇', text: `房间 ${net.roomId}，来打两把`, url: link }).catch(() => {}); }
      else copyInvite();
    };
  }
  const endBtn = pop.querySelector('#mEnd');
  if (endBtn) {
    endBtn.onclick = async () => {
      pop.remove();
      const ok = await askConfirm({
        title: '结束牌局',
        text: '正在打的这一手会打完，之后不再发牌，10 秒后关桌。',
        ok: '结束牌局',
        danger: true,
      });
      if (ok) sendWS({ t: 'endTable' });
    };
  }
  // v0.20.28：强制离座名单——人可能已经离座/离房，从名单里按账号取消
  const forceBtn = pop.querySelector('#mForce');
  if (forceBtn) {
    forceBtn.onclick = () => { pop.remove(); openForceList(); };
  }
  const quitBtn = pop.querySelector('#mQuit');
  if (quitBtn) {
    // v0.22.68：正常进行中先起立 / 保位才能退——置灰并拦截
    const canLeave = canLeaveNow();
    if (!canLeave) {
      quitBtn.disabled = true;
      quitBtn.classList.add('off');
      quitBtn.title = '请先「站起围观」或「保位离桌」，这一手结算后再退出';
    }
    quitBtn.onclick = async () => {
      pop.remove();
      if (!canLeaveNow()) { toast('先站起围观或保位离桌，这一手打完再退出', 2400); return; }
      const ok = await askConfirm({
        title: '退出牌局',
        text: '座位会让出来。手里还有牌的话，这一手按弃牌处理。',
        ok: '退出',
        danger: true,
      });
      if (ok) doQuit();
    };
  }
  pop.querySelector('#mSound').onclick = () => {
    state.sound = !state.sound;
    pop.querySelector('#mSoundState').textContent = state.sound ? '开' : '关';
  };
  // v0.20.76：麦克风自检（权限挂宿主浏览器、内嵌窗口常被策略禁用，见 openMicCheck）
  pop.querySelector('#mMic').onclick = () => { pop.remove(); openMicCheck(); };
  setTimeout(() => {
    const close = (ev) => {
      if (!pop.contains(ev.target)) { pop.remove(); document.removeEventListener('pointerdown', close); }
    };
    document.addEventListener('pointerdown', close);
  }, 0);
}

/* ── 带入金币：牌局进行中随时可带，本手结算完到账 ── */
/* ── 选座 ─────────────────────────────────────
 * 进房先围观，自己点空位坐下；牌局正打着就先挂起，这一手结算后自动入座。
 */
function sitSeat(seat) {
  if (!sendWS({ t: 'sit', seat: Number(seat) })) toast('还没连上，稍等一下');
  else beep(640, 0.06, 'sine');
}

function openBringIn() {
  const v = state.view;
  const m = me();
  if (!v || !m) return;
  const minBuy = v.minBuyIn || v.buyIn || 500;
  const pending = m.pending || 0;
  const running = (v.phase === PHASE.BET || v.phase === PHASE.SPLIT) && !m.away;
  const req = v.myRequest;
  const online = net.mode === 'online';
  const isOwnerMe = amOwnerV(v);
  const opts = [1, 2, 4, 10].map((k) => minBuy * k);
  const base = (m.stack ?? 0) + pending;
  const box = $('modalBox');
  box.dataset.kind = 'bring';
  box.innerHTML = `
    <button class="modal-x" id="bringClose">×</button>
    <h2>带入金币</h2>
    <div class="sub">簸簸 <b>${m.stack ?? 0}</b>${
      pending ? ` · 另有 <b class="pend">${pending.toLocaleString()}</b> 待入账` : ''
    } · 至少 ${minBuy.toLocaleString()}</div>
    ${online ? `<div class="ask-note${req ? ' wait' : ''}">${
      isOwnerMe
        ? ''
        : req ? `已申请 ${req.amount.toLocaleString()}，等房主同意后自动到账`
          : ''
    }</div>` : ''}
    ${running ? '<div class="bring-note"><b>本手结束后到账</b></div>' : ''}
    <div class="bring-opts">
      ${opts.map((a) => `<button class="bring-opt" data-amt="${a}" ${req ? 'disabled' : ''}>
        <b>+${a.toLocaleString()}</b><span>${running ? '结算后' : '簸簸变'} ${(base + a).toLocaleString()}</span></button>`).join('')}
    </div>`;
  box.querySelector('#bringClose').onclick = closeModal;
  box.querySelectorAll('.bring-opt').forEach((b) => {
    b.onclick = () => { closeModal(); doBringIn(Number(b.dataset.amt)); };
  });
  $('modal').classList.remove('align-left');
  $('modal').classList.remove('hidden');
}

/** 房主审核带入（牌局进行中也能审） */
function showRequests() {
  const v = state.view;
  if (!v) return;
  const box = $('modalBox');
  box.dataset.kind = 'req';
  box.innerHTML = `
    <button class="modal-x" id="reqClose">×</button>
    <h2>带入申请</h2>
    <div id="reqModalBody"></div>`;
  box.querySelector('#reqClose').onclick = closeModal;
  paintRequests(v);
  $('modal').classList.add('align-left');
  $('modal').classList.remove('hidden');
}

/* ── v0.20.28 强制离座名单（房主） ─────────────── */
function openForceList() {
  const v = state.view;
  const list = (v && v.forceOut) || [];
  const box = $('modalBox');
  box.dataset.kind = 'force';
  box.innerHTML = `
    <button class="modal-x" id="forceClose" type="button">×</button>
    <h2>强制离座名单</h2>
    <div class="force-list">${list.length ? list.map((x) => `
      <div class="force-row">
        <b>${esc(x.name || '玩家')}</b><span class="force-uid">${esc(x.uid)}</span>
        <button data-unforce="${esc(x.uid)}" type="button">取消强制</button>
      </div>`).join('') : '<div class="force-empty">名单是空的</div>'}</div>`;
  box.querySelector('#forceClose').onclick = closeModal;
  box.querySelectorAll('[data-unforce]').forEach((b) => {
    b.onclick = () => {
      sendWS({ t: 'forceSit', uid: b.dataset.unforce, on: false });
      closeModal();
    };
  });
  $('modal').classList.remove('align-left');
  $('modal').classList.remove('align-right');
  $('modal').classList.remove('hidden');
  beep(640, 0.04, 'sine', 0.02);
}

/* ── v0.22.38：全局带入申请（房主视角） ───────────────
 * myReqs 是房主名下所有房间待审申请的镜像（服务端 myRequests / buyReq 同步），
 * 房间内 reqBadge、大厅「你的房间」角标、审批面板三处共用同一份数据。 */
let myReqs = { list: [], total: 0, counts: {} };

/* 短促铃铛：新带入申请提醒（两声高频短音，走全局音效开关） */
function bellDing() {
  beep(1318, 0.10, 'sine', 0.05);
  setTimeout(() => beep(1760, 0.16, 'sine', 0.05), 90);
}

/* v0.22.63：房间内「带入申请」角标的唯一判据，paint() 与 paintReqBadges() 共用。
   跨房审批后服务端只给房主推 myRequests、不会推本房 state 快照；以前 paintReqBadges()
   只在 n>0 时显示、n=0 时不隐藏，角标就一直留着旧的「带入申请 1」。 */
function syncReqBadge(v) {
  const rb = $('reqBadge');
  if (!rb || !v) return;
  const isOwner = amOwnerV(v);
  const local = (v.requests || []).length;
  const n = isOwner ? Math.max(local, myReqs.total || 0) : local;
  if (isOwner && n > 0 && !v.ended) {
    rb.classList.remove('hidden');
    rb.querySelector('b').textContent = n;
  } else {
    rb.classList.add('hidden');
  }
}

/* 刷新两处角标：大厅「你的房间」红色数字 + 房间内「带入申请」 */
function paintReqBadges() {
  const mb = $('mineBadge');
  if (mb) {
    const n = myReqs.total || 0;
    mb.classList.toggle('hidden', !(n > 0));
    mb.textContent = n > 99 ? '99+' : String(n);
  }
  syncReqBadge(state.view);
}

/* v0.22.60：房主在房间外看到待审申请、点进房间后自动弹出审核面板。
   state 快照和 myRequests 回包谁先到都不确定，所以两处都调一次，条件齐了才弹：
     · 必须是本次进房触发的（reqAutoOpen），且当前已在线上房间里；
     · view 必须是「当前这一间」的，别拿上一桌的旧快照误判房主；
     · 必须是房主，且名下确实有待审申请；
     · 同一批申请只弹一次（签名 = 房号+座位+提交时刻），反复切房不会每次都弹。
   进了没申请的那桌也没关系：面板列的是「名下所有房间」，照样能审别桌的申请。 */
function maybeAutoOpenReqs() {
  if (!state.reqAutoOpen || net.mode !== 'online') return;
  const v = state.view;
  if (!v || (v.roomId && String(v.roomId) !== String(net.roomId))) return;
  if (!amOwnerV(v) || !(myReqs.total > 0)) return;
  const sig = (myReqs.list || [])
    .map((r) => `${r.roomId}:${r.seat}:${r.at}`).join('|');
  state.reqAutoOpen = false;
  if (!sig || sig === state.lastAutoReqSig) return;
  state.lastAutoReqSig = sig;
  showRequests();
}

/* ── v0.20.28 你的房间：自己开的、还在进行的桌子，点一下免房号直进 ── */
function openMyRooms(list) {
  const box = $('modalBox');
  box.dataset.kind = 'myrooms';
  const left = (ms) => {
    const s = Math.max(0, Math.ceil((ms || 0) / 1000));
    return `${Math.floor(s / 60)} 分 ${String(s % 60).padStart(2, '0')} 秒`;
  };
  box.innerHTML = `
    <button class="modal-x" id="myRoomsClose" type="button">×</button>
    <h2>你的房间</h2>
    <div class="force-list">${list.length ? list.map((r) => `
      <button class="myroom-row" data-room="${esc(r.id)}" type="button">
        <i class="myroom-req${r.reqCount ? '' : ' off'}">${r.reqCount || 0}</i>
        <b><i class="myroom-tag${r.role === 'owner' ? ' owner' : ''}">${r.role === 'owner' ? '房主' : '参与'}</i>房间 ${esc(r.id)}</b>
        <span>${esc(r.stake || '')} · ${r.started ? '牌局中' : '等待中'} · ${r.online} 人在线</span>
        <em class="${r.started ? '' : 'wait'}">${r.started ? '剩 ' + left(r.remainMs) : '等待开局'}</em>
      </button>`).join('') : '<div class="force-empty">你还没有正在进行的房间</div>'}</div>`;
  box.querySelector('#myRoomsClose').onclick = closeModal;
  box.querySelectorAll('[data-room]').forEach((b) => {
    b.onclick = () => {
      closeModal();
      enterRoom(b.dataset.room);
    };
  });
  $('modal').classList.remove('align-left');
  $('modal').classList.remove('align-right');
  $('modal').classList.remove('hidden');
  beep(640, 0.04, 'sine', 0.02);
}

/* ── 牌局倒计时 ─────────────────────────────── */
let timeTimer = null;
function paintTime(v) {
  const tag = $('timeTag');
  if (!tag) return;
  const line = $('timeLine');
  if (!v || v.remainMs == null || v.ended) {
    tag.classList.add('hidden');
    if (line) line.classList.add('hidden');
    clearInterval(timeTimer);
    timeTimer = null;
    return;
  }
  // 时间到但还没收摊：这一手打完；芒果池还有滚存就加时抢完为止
  if (v.timeUp) {
    tag.classList.remove('hidden');
    if (line) line.classList.remove('hidden');
    tag.classList.add('warn');
    const carry = v.carryPot || 0;
    tag.textContent = v.overtime
      ? `加时 · 芒果池 ${carry.toLocaleString()}`
      : '时间到 · 打完这手';
    clearInterval(timeTimer);
    timeTimer = null;
    return;
  }
  state.remainBase = { ms: v.remainMs, at: Date.now() };
  tag.classList.remove('hidden');
  if (line) line.classList.remove('hidden');
  tickTime();
  if (!timeTimer) timeTimer = setInterval(tickTime, 1000);
}

function tickTime() {
  const b = state.remainBase;
  const tag = $('timeTag');
  if (!b || !tag) return;
  const left = Math.max(0, b.ms - (Date.now() - b.at));
  if (left >= 3600000) {
    const h = Math.floor(left / 3600000);
    const m = Math.floor((left % 3600000) / 60000);
    tag.textContent = `${h}:${String(m).padStart(2, '0')}`;
  } else {
    const m = Math.floor(left / 60000);
    const sec = Math.floor((left % 60000) / 1000);
    tag.textContent = `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }
  tag.classList.toggle('warn', left <= 5 * 60000);
  if (left <= 0) { clearInterval(timeTimer); timeTimer = null; }
}

/** 整场结束：弹一次收尾，把这一桌所有人的战绩摆出来，10 秒后自动关房 */
function maybeEnded(v) {
  if (!v || !v.ended || state.endedShown) return;
  state.endedShown = true;
  // v0.22.88：倒计时只认弹页那一刻的快照，冻结住——后续补发的快照
  // （弱网缓冲重发等）closeInMs 可能变小/归零，把结算页提前带走
  state.endedUntil = Date.now() + (v.closeInMs || 20000);
  const box = $('modalBox');
  box.dataset.kind = 'ended';
  const why = v.endReason === 'owner' ? '房主收摊' : '时间到';
  const list = buildStats(v);
  box.innerHTML = endedSheetHTML(v, list, why);
  box.className = 'modal-box end-sheet';
  // v0.20.49：结算页不再给返回/关闭（防止误点回到牌桌），只留底部「离开本桌」
  box.querySelector('#endQuit').onclick = () => { closeModal(); doQuit(); };
  $('modal').classList.remove('align-left');
  $('modal').classList.remove('hidden');

  // 10 秒倒计时：期间点「离开本桌」直接走，不点就自动回大厅（服务端同时关房）
  const until = state.endedUntil || (Date.now() + (v.closeInMs || 20000));
  clearInterval(state.endTimer);
  const tick = () => {
    const left = Math.max(0, Math.ceil((until - Date.now()) / 1000));
    const el = $('endLeft');
    if (el) el.textContent = left;
    if (left > 0) return;
    clearInterval(state.endTimer);
    state.endTimer = null;
    if (net.mode === 'online') { closeModal(); backToLobby(); }
  };
  tick();
  state.endTimer = setInterval(tick, 500);
}

function doBringIn(amount) {
  const v = state.view;
  const running = !!v && (v.phase === PHASE.BET || v.phase === PHASE.SPLIT);
  if (net.mode === 'online') {
    const isOwnerMe = !!v && amOwnerV(v);
    sendWS({ t: 'buyin', amount });
    beep(720, 0.09, 'sine');
    // 房主免审，到账提示走服务端回执，别在这儿说「等房主同意」
    if (!isOwnerMe) toast(`已提交带入 ${amount}，等房主同意`, 2200);
    return;
  }
  try {
    state.game.bringIn(mySeat(), amount);
    state.view = state.game.snapshotFor(mySeat());
    beep(720, 0.09, 'sine');
    toast(running ? `带入 ${amount}，本手结束后到账` : `带入 ${amount}`);
  } catch (e) {
    toast(e.message);
  }
  refresh();
}

function closeModal() {
  $('modal').classList.add('hidden');
  $('modal').classList.remove('align-left');
  $('modal').classList.remove('align-right');
  $('modalBox').dataset.kind = '';
  state.statsSnap = null;
  state.statsPainted = false;
  // 结算页是浅色整屏皮肤，关掉时必须清干净，不然回顾/战绩会继承白底
  $('modalBox').className = 'modal-box';
}

/** v0.22.79：换桌 / 回大厅时彻底清掉战绩相关内存态。
 *  原来只靠 render 里「handNo===1 才清 lastSettled」这一条兜底，
 *  但新房等待阶段 handNo=0，且 created/joined 会把 net.roomId 提前改成新房号，
 *  导致 syncRoomMeta 的换房判断也失效——于是新开房开局前能看到上一桌的战绩。
 *  离房 / 收到新房号时主动清一次，不再赌那个 timing。 */
function clearStatsState() {
  state.lastSettled = null;
  state.statsSnap = null;
  state.statsPainted = false;
  if ($('modal') && !$('modal').classList.contains('hidden')
      && $('modalBox') && $('modalBox').dataset.kind === 'stats') closeModal();
}

/* ── 战绩 ─────────────────────────────────── */
/** 把一帧视图裁成战绩要用的样子（只留带入 / 手数 / 输赢相关的字段） */
function statsFrameOf(v) {
  return {
    phase: PHASE.SETTLED,
    handNo: v.handNo,
    viewerSeat: v.viewerSeat,
    carryPot: v.carryPot || 0,     // 全员休牌滚进芒果池的钱，不在任何人的簸簸上
    seats: (v.seats || []).map((p) => ({ ...p })),
    departed: (v.departed || []).map((p) => ({ ...p })),
  };
}

/** 开局第一手：战绩先清零——不显示本手未结算、或上一局遗留的输赢，
 *  只保留带入 / 手数，胜负一律为 0。本手真正关掉、下一手开始后才会作为历史战绩出现。 */
function zeroStatsFrame(v) {
  return {
    phase: PHASE.SETTLED,
    handNo: v.handNo,
    viewerSeat: v.viewerSeat,
    carryPot: 0,
    seats: (v.seats || []).map((p) => ({ ...p, net: 0 })),
    departed: (v.departed || []).map((p) => ({ ...p, net: 0 })),
  };
}

/** 还没有「结算底稿」（刚进桌、第一手没打完）时，把本手押在池里的注退回簸簸，
 *  还原成这一手开始前——也就是上一手结算时的样子。 */
function settledFrameFrom(v) {
  const inHand = v.phase === PHASE.BET || v.phase === PHASE.SPLIT;
  const seats = (v.seats || []).map((p) => {
    const stack = (p.stack || 0) + (inHand ? (p.bet || 0) : 0);
    return { ...p, stack, bet: inHand ? 0 : p.bet, net: stack - (p.buyIn || 0) };
  });
  return {
    phase: PHASE.SETTLED,
    handNo: v.handNo,
    viewerSeat: v.viewerSeat,
    carryPot: v.carryPot || 0,
    seats,
    departed: (v.departed || []).map((p) => ({ ...p })),
  };
}

/** 战绩页下半截：围观席（头像 + 昵称），没人围观就不占地方 */
function statsWatchersHTML(v) {
  const list = (v && v.watchers) || [];
  if (!list.length) return '';
  return `<div class="stats-watch" id="statsWatch">
    <div class="sw-head">围观<b>${list.length}</b></div>
    <div class="sw-list">${list.map((w) => `<div class="sw-item">
      <span class="sw-ava${w.connected ? '' : ' off'}">${avatarEl(w.name, '', w.avatar).outerHTML}</span>
      <b>${esc(w.name || '')}</b></div>`).join('')}</div>
  </div>`;
}

// 这张桌子从头到现在：每个人带进来多少、打了多少手、累计赢输多少。
// 面板只看「上一手结算」那一刻的数据：打开时拍一份快照，之后牌局怎么变都不动，
// 关掉再打开才重新取（这时已经是新的一手打完）。
function showStats() {
  const v = state.view;
  const box = $('modalBox');
  if (!v || !v.seats) { toast('还没进桌'); return; }
  // 开局第一手：战绩清零（不显示本手未结算 / 上一局遗留的输赢），只保留带入与手数
  state.statsSnap = (v.handNo === 1) ? zeroStatsFrame(v) : (state.lastSettled || settledFrameFrom(v));
  state.statsPainted = false;
  box.dataset.kind = 'stats';
  box.innerHTML = `<button class="modal-x" id="statsClose">×</button>
    <h2>战绩</h2>
    <div class="stats-scroll" id="statsScroll">
      <div class="stats-head"><span>玩家信息</span><span>带入</span><span>手数</span><span>胜负</span></div>
      <div id="statsRows"></div>
    </div>
    ${statsWatchersHTML(v)}
    <div class="stats-foot" id="statsFoot"></div>
    <button class="scratch-sw${scratchOn() ? ' on' : ''}" id="scratchSw" type="button"
      aria-pressed="${scratchOn()}"><span class="sw-label"><span>搓牌</span>${net.mode === 'online' ? `<u class="sw-cost"><span class="dm"></span>${PRICE.scratch}/场</u>` : ''}</span><i><b></b></i><em>${scratchOn() ? 'ON' : 'OFF'}</em></button>`;
  box.classList.add('stats-box');
  box.querySelector('#statsClose').onclick = closeModal;
  const sw = box.querySelector('#scratchSw');
  if (sw) {
    sw.onclick = () => {
      const next = !scratchOn();
      // 联机：整场第一次开启先付 5 钻，之后反复开关都不再扣（服务端记 scratchPaid）；
      // 开关本身每手开局会自动拨回 OFF，但不产生新的扣费
      if (next && net.mode === 'online') {
        if (!acct.user) return toast('请先登录');
        const m = me();
        const paid = !!(m && m.scratchPaid);
        if (!paid) {
          if ((acct.user.diamonds || 0) < PRICE.scratch) {
            return toast(`钻石不够，搓牌 ${PRICE.scratch} 钻一场`);
          }
          sendWS({ t: 'scratchPay' });
        }
      }
      setScratchSwitch(next, sw);
      beep(next ? 880 : 520, 0.05, 'sine', 0.03);
      if (next) {
        toast(net.mode === 'online'
          ? `搓牌已打开：整场 ${PRICE.scratch} 钻，反复开关不再扣；进新房间会自动拨回 OFF`
          : '搓牌已打开：每手第四张由你自己搓');
      } else {
        toast('搓牌已关闭');
      }
    };
  }
  paintStats();
  $('modal').classList.remove('align-right');
  $('modal').classList.add('align-left');
  $('modal').classList.remove('hidden');
}

/* ── 搓牌：发到第四张时先扣住牌面，自己搓开再看 ─────────────
 * 开关放在战绩页右下角，只存本机（换设备不跟）。
 * 搓的过程完全在本地画：一张放大的牌面 + 一张盖在上面的牌背。
 *   单指按住拖动 → 绕离手指较远的那个指纹转，牌背转动、牌面一点点露出来；
 *   双指按住拖动 → 牌背只平移不转。
 * 露出的牌面超过一半就算搓开；另有 10 秒独立倒计时，到点无条件收场。
 * 服务端只知道「扣住 / 放开」，所以别人看到的只是第四张晚一点翻出来。
 */
const SCRATCH_SEC = 10;
const SCRATCH_HOLD_MS = 600;   // 牌面亮出来后停留多久，再收画面
/* v0.20.20：搓牌灵敏度 ×1.5——同样手指动作，牌背转/移的距离是原来的 1.5 倍，
   露出一半即收场的判定不变，等于更快搓开 */
const SCRATCH_SENS = 1.5;
// 指纹图标（.fp-a/.fp-b）现仅作「按住拖动」的视觉提示，不再参与手势逻辑（v0.20.27）

if (state.scratchOn === undefined) {
  // v0.20.22：不做偏好记录——初始一律 OFF；开关跟房间走（换手不重置，
  // 进新房间由 syncRoomMeta 拨回 OFF），玩家手动打开。
  // 扣费不变：真搓那一刻才收 5 钻/场，钻石不够服务端回 scratchDenied，前端自动拨回 OFF。
  state.scratchOn = false;
}
const scratchOn = () => state.scratchOn === true;

/** 拨搓牌开关：状态与按钮一起改（v0.20.22 起不再写 localStorage） */
function setScratchSwitch(on, btn) {
  state.scratchOn = !!on;
  const sw = btn || $('scratchSw');
  if (!sw) return;
  sw.classList.toggle('on', !!on);
  sw.setAttribute('aria-pressed', String(!!on));
  const em = sw.querySelector('em');
  if (em) em.textContent = on ? 'ON' : 'OFF';
}

const sc = {
  layer: null, face: null, back: null, count: null,
  active: false, done: false, seat: -1, handNo: -1, card: null,
  w: 0, h: 0, cx: 0, cy: 0,
  dx: 0, dy: 0, rot: 0,
  pointers: new Map(), mode: '', base: null, lastPt: null,
  until: 0, timer: 0, closeTimer: 0,
  openedAt: 0,      // 大牌背露出的时刻：最短展示时长据此计算
  announced: -1,    // 已经替哪一手向服务端声明过「要搓」（免得重复开口）
  minTimer: 0,      // 补齐最短展示时长的补刀定时器
  gen: 0,           // 开合代次：上一场遗留的淡出定时器不许关掉新开的大牌
};

/* 大牌背最短展示时长：服务端扣牌窗口只有 900ms，网络/掉帧时牌可能已经先亮了，
   这时不能立刻收场，否则牌背一闪而过甚至完全看不到 */
const SCRATCH_MIN_SHOW_MS = 900;

/** 提前向服务端声明「这一手我要搓」，把第四张扣在牌背下——
 *  不等大牌画面出来再发，避免 800ms 的展示等待撞上 900ms 的门控窗口 */
function announceScratch(handNo) {
  if (sc.announced === handNo) return;
  sc.announced = handNo;
  if (net.mode === 'local') {
    const seat = state.view ? state.view.viewerSeat : -1;
    if (state.game && seat >= 0) state.game.scratchStart(seat, SCRATCH_SEC * 1000);
  } else {
    sendWS({ t: 'scratch', on: true });
  }
}

/** 指纹：几圈疏密不一的弧线，够看出是「按住这里转」 */
function fingerSvg() {
  return `<svg viewBox="0 0 40 40" aria-hidden="true">
    <g fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round">
      <path d="M20 4.5c8.6 0 15.5 6.9 15.5 15.5 0 5.6-2.2 10.4-5.7 13.6"/>
      <path d="M20 10c5.5 0 10 4.5 10 10 0 4.9-1.9 9-4.8 11.6"/>
      <path d="M20 15.4c2.5 0 4.6 2.1 4.6 4.6 0 3.4-1.3 6.2-3.1 8.2"/>
      <path d="M13.6 8.2C9.2 11 6.4 15.6 6.4 20.8c0 4.6 1.3 8.2 3.4 11.2"/>
      <path d="M11 4.9C6.1 8.2 3 13.6 3 20c0 4.6 1.1 8.4 2.9 11.4"/>
    </g>
  </svg>`;
}

function scratchLayer() {
  if (sc.layer) return sc.layer;
  const el = document.createElement('div');
  el.className = 'scratch hidden';
  el.id = 'scratch';
  el.innerHTML = `
    <div class="scratch-stage">
      <div class="card scratch-face"></div>
      <div class="card back scratch-back">
        <span class="fp fp-a">${fingerSvg()}</span>
        <span class="fp fp-b">${fingerSvg()}</span>
      </div>
    </div>
    <div class="scratch-hud"><b class="scratch-count">${SCRATCH_SEC}</b></div>
    <button class="scratch-flip" type="button">翻开</button>`;
  document.body.appendChild(el);
  sc.layer = el;
  sc.face = el.querySelector('.scratch-face');
  sc.back = el.querySelector('.scratch-back');
  sc.count = el.querySelector('.scratch-count');
  el.querySelector('.scratch-flip').addEventListener('click', (e) => {
    e.stopPropagation();
    finishScratch(true);   // 翻开：不等搓，直接亮牌面
  });
  el.addEventListener('pointerdown', onScratchDown, { passive: true });
  el.addEventListener('pointermove', onScratchMove, { passive: true });
  el.addEventListener('pointerup', onScratchUp, { passive: true });
  el.addEventListener('pointercancel', onScratchUp, { passive: true });
  return el;
}

function measureScratch() {
  if (!sc.face) return;
  const r = sc.face.getBoundingClientRect();
  if (!r.width || !r.height) return;
  sc.w = r.width;
  sc.h = r.height;
  sc.cx = r.left + r.width / 2;
  sc.cy = r.top + r.height / 2;
}

/** 牌背本地坐标（左上角起）→ 屏幕坐标 */
function scratchPoint(lx, ly) {
  const vx = lx - sc.w / 2;
  const vy = ly - sc.h / 2;
  const r = (sc.rot * Math.PI) / 180;
  const cs = Math.cos(r);
  const sn = Math.sin(r);
  return { x: sc.cx + vx * cs - vy * sn + sc.dx, y: sc.cy + vx * sn + vy * cs + sc.dy };
}

function applyScratch() {
  if (sc.back) sc.back.style.transform = `translate(${sc.dx}px,${sc.dy}px) rotate(${sc.rot}deg)`;
}

function openScratch(seat, card) {
  if (sc.active || !card) return;
  clearTimeout(sc.closeTimer);
  sc.closeTimer = 0;
  clearTimeout(sc.minTimer);
  sc.minTimer = 0;
  sc.gen += 1;
  const gen = sc.gen;
  scratchLayer();
  // 牌面照普通扑克牌画（角标 + 牌心），只是整体放大
  const el = cardEl(card, {});
  sc.face.className = 'card scratch-face';
  [...el.classList].forEach((c) => { if (c !== 'card') sc.face.classList.add(c); });
  // 人像牌 / 大王都在 scratchFaceHtml 里出整张的图
  sc.face.innerHTML = scratchFaceHtml(card);
  // 搓牌没结束：点数糊成一团，只留花色看得清；等牌背让开才「对上焦」
  sc.face.classList.add('scrubbing');

  sc.active = true;
  sc.done = false;
  sc.seat = seat;
  sc.handNo = state.view ? state.view.handNo : 0;
  sc.card = card;
  sc.openedAt = Date.now();
  sc.dx = 0;
  sc.dy = 0;
  sc.rot = 0;
  sc.pointers.clear();
  sc.mode = '';
  sc.base = null;
  if (sc.back) {
    sc.back.style.transition = 'none';
    sc.back.style.opacity = '1';
  }
  applyScratch();
  sc.until = Date.now() + SCRATCH_SEC * 1000;
  if (sc.count) {
    sc.count.textContent = String(SCRATCH_SEC);
    sc.count.classList.remove('warn');
  }
  sc.layer.classList.remove('hidden');
  // 先按「牌背完整盖住牌面」定住，再放行动画——上一手收场留下的
  // opacity:0 / 位移不能带到这一手，否则大牌一出来就是亮的（牌背时有时无）
  sc.layer.classList.remove('on');
  requestAnimationFrame(() => {
    if (sc.gen !== gen || !sc.active) return;
    sc.layer.classList.add('on');
    measureScratch();
  });
  clearInterval(sc.timer);
  sc.timer = setInterval(tickScratch, 100);
  // 先让服务端把第四张扣住，别让桌上其他人瞥见一眼（检测到第四张时已经声明过，这里兜底）
  announceScratch(sc.handNo);
  beep(560, 0.05, 'sine', 0.022);
}

function tickScratch() {
  if (!sc.active || sc.done) return;
  const left = Math.max(0, Math.ceil((sc.until - Date.now()) / 1000));
  if (sc.count) {
    sc.count.textContent = String(left);
    sc.count.classList.toggle('warn', left <= 3);
  }
  if (left <= 0) finishScratch();
}

/** 收场：牌背滑开、牌面亮出；亮 0.6 秒再收画面，顺手告诉服务端可以翻牌了 */
function finishScratch(instant = false) {
  if (!sc.active || sc.done) return;
  sc.done = true;
  clearInterval(sc.timer);
  sc.timer = 0;
  clearTimeout(sc.minTimer);
  sc.minTimer = 0;
  sc.pointers.clear();
  sc.mode = '';
  sc.lastPt = null;
  // 牌背让开的同时点数「对上焦」：模糊一抹散掉，看清是几点
  if (sc.face) sc.face.classList.remove('scrubbing');
  sfxRubStop();
  if (sc.back) {
    if (instant) {
      // 点「翻开」：牌背直接让开，牌面当场完整露出来
      sc.back.style.transition = 'opacity .1s ease';
      sc.back.style.transform = `translate(${sc.dx}px,${sc.dy}px) rotate(${sc.rot}deg)`;
    } else {
      sc.back.style.transition = 'transform .26s cubic-bezier(.32,.8,.4,1),opacity .26s ease';
      sc.back.style.transform = `translate(${sc.dx}px,${sc.dy - 30}px) rotate(${sc.rot + 7}deg)`;
    }
    sc.back.style.opacity = '0';
  }
  sfxScratchEnd();   // v0.20.74：大牌背翻开 → 0.80s「搓牌收尾」真实录音
  if (net.mode === 'local') {
    if (state.game) state.game.scratchDone(sc.seat);
  } else {
    sendWS({ t: 'scratch', on: false });
  }
  clearTimeout(sc.closeTimer);
  // 牌面亮出来之后停 0.6 秒，再让整个画面淡出
  sc.closeTimer = setTimeout(hideScratch, (instant ? 0 : 260) + SCRATCH_HOLD_MS);
}

function hideScratch() {
  if (!sc.layer) return;
  const handNo = sc.handNo;
  const seat = sc.seat;
  const gen = sc.gen;
  sc.active = false;
  sc.done = false;
  clearTimeout(sc.minTimer);
  sc.minTimer = 0;
  sfxRubStop();
  sc.layer.classList.remove('on');
  // 牌面亮够 0.6 秒后再淡出，别一刀切黑；
  // 只关「自己这一代」的大牌——这条定时器跑得慢一点也不能把下一手刚打开的大牌关掉
  setTimeout(() => {
    if (sc.gen === gen && !sc.active && sc.layer) sc.layer.classList.add('hidden');
  }, 170);
  // 座位上的第四张：等它真翻出来时重放一次翻面（飞入动画不重来，见 applyFlip）
  turnAt.delete(`${handNo}:s${seat}:live:1`);
  if (net.mode === 'local') refresh();
}

/* 手势：单指 / 双指统一规则，都只平移拖动牌背（v0.20.27 取消旋转） */
function onScratchDown(e) {
  if (!sc.active || sc.done) return;
  if (e.target && e.target.closest && e.target.closest('.scratch-flip')) return;
  if (!sc.w || !sc.h) measureScratch();
  try { sc.layer.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
  sc.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  sc.lastPt = { x: e.clientX, y: e.clientY, t: performance.now() };
  resetScratchGesture();
}

function onScratchMove(e) {
  if (!sc.active || sc.done || !sc.pointers.has(e.pointerId)) return;
  sc.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  // 摩擦声：响度和「粗细」都跟着手指划过的速度走
  const now = performance.now();
  const lp = sc.lastPt;
  if (lp) {
    const dist = Math.hypot(e.clientX - lp.x, e.clientY - lp.y);
    const v = dist / Math.max(8, now - lp.t);          // px/ms
    const level = Math.min(1, v / 1.1);
    sfxRub(level, 1250 + level * 1150);
  }
  sc.lastPt = { x: e.clientX, y: e.clientY, t: now };
  const ps = [...sc.pointers.values()];
  const base = sc.base;
  if (!base) return;

  // 单指 / 双指统一规则：都只平移拖动牌背，不再旋转（v0.20.27）
  // 双指取中点，单指取指头本身，拖动增益同为 SCRATCH_SENS
  if (sc.mode === 'move' && ps.length >= 1) {
    const m = ps.length >= 2
      ? { x: (ps[0].x + ps[1].x) / 2, y: (ps[0].y + ps[1].y) / 2 }
      : ps[0];
    // 灵敏度：拖动 ×1.5（v0.20.20）
    sc.dx = base.dx0 + (m.x - base.mid0.x) * SCRATCH_SENS;
    sc.dy = base.dy0 + (m.y - base.mid0.y) * SCRATCH_SENS;
    applyScratch();
    checkScratchReveal();
  }
}

function onScratchUp(e) {
  sc.pointers.delete(e.pointerId);
  if (!sc.pointers.size) { sc.lastPt = null; sfxRubStop(); }
  if (!sc.active || sc.done) return;
  resetScratchGesture();
}

function resetScratchGesture() {
  const ps = [...sc.pointers.values()];
  if (ps.length >= 1) {
    // 单指 / 双指同一套拖动规则：基准点取双指中点或单指位置（v0.20.27）
    sc.mode = 'move';
    sc.base = {
      mid0: ps.length >= 2
        ? { x: (ps[0].x + ps[1].x) / 2, y: (ps[0].y + ps[1].y) / 2 }
        : { x: ps[0].x, y: ps[0].y },
      dx0: sc.dx,
      dy0: sc.dy,
    };
    return;
  }
  sc.mode = '';
  sc.base = null;
}

/* 露出的牌面超过一半就自动收场（用多边形裁剪算遮挡面积，够准） */
function checkScratchReveal() {
  if (!sc.active || sc.done || !sc.w || !sc.h) return;
  const poly = [
    scratchPoint(0, 0), scratchPoint(sc.w, 0), scratchPoint(sc.w, sc.h), scratchPoint(0, sc.h),
  ].map((p) => ({ x: p.x - sc.cx, y: p.y - sc.cy }));
  const inter = polyArea(clipToRect(poly, -sc.w / 2, -sc.h / 2, sc.w / 2, sc.h / 2));
  const cover = Math.max(0, Math.min(1, inter / (sc.w * sc.h)));
  if (1 - cover >= 0.5) finishScratch();
}

/** 凸多边形裁到矩形里（Sutherland–Hodgman，四条边轮一遍） */
function clipToRect(poly, x0, y0, x1, y1) {
  let out = poly;
  const cutX = (c) => (a, b) => {
    const t = (c - a.x) / (b.x - a.x);
    return { x: c, y: a.y + (b.y - a.y) * t };
  };
  const cutY = (c) => (a, b) => {
    const t = (c - a.y) / (b.y - a.y);
    return { x: a.x + (b.x - a.x) * t, y: c };
  };
  const pass = (inside, cut) => {
    if (!out.length) return;
    const next = [];
    for (let i = 0; i < out.length; i++) {
      const a = out[i];
      const b = out[(i + 1) % out.length];
      const ia = inside(a);
      const ib = inside(b);
      if (ia) next.push(a);
      if (ia !== ib) next.push(cut(a, b));
    }
    out = next;
  };
  pass((p) => p.x >= x0, cutX(x0));
  pass((p) => p.x <= x1, cutX(x1));
  pass((p) => p.y >= y0, cutY(y0));
  pass((p) => p.y <= y1, cutY(y1));
  return out;
}

function polyArea(pts) {
  if (!pts || pts.length < 3) return 0;
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2;
}

/** 每帧视图：该开搓牌的判断与「服务端已经亮牌」的收场都在这儿 */
function syncScratch(v) {
  if (!v || !v.seats) return;
  // 记忆复位：房间重开一局（handNo 回退）或回到等待中，上一局「这一手搓过没」不能带过来
  if (v.phase === PHASE.WAITING || v.handNo < (state.scratchSeenHand || 0)) {
    state.scratchHand = -1;
    sc.announced = -1;
  }
  state.scratchSeenHand = v.handNo;
  const mine = v.seats.find((s) => s.seat === v.viewerSeat) || null;
  if (sc.active) {
    if (sc.handNo !== v.handNo) { hideScratch(); return; }
    // 正在收场展示（牌面已亮、等 0.6 秒淡出）：别再插一脚提前关掉
    if (sc.done) return;
    // 第四张已经翻出来了（服务端 10 秒到点 / 自己搓开）：本地也走「亮 0.6 秒再收」
    // v0.20.34：牌背至少露够 SCRATCH_MIN_SHOW_MS，否则网络/掉帧时牌背会一闪而过
    if (mine && lastOpenCard(mine)) {
      const wait = SCRATCH_MIN_SHOW_MS - (Date.now() - sc.openedAt);
      if (wait > 0) {
        if (!sc.minTimer) {
          sc.minTimer = setTimeout(() => {
            sc.minTimer = 0;
            if (!sc.active || sc.done) return;
            // 补刀时按最新一帧再看一眼：这段时间里服务端要是又把牌扣回去了
            // （本人刚声明的搓牌被受理），说明牌背还得盖着，不能收场
            const live = state.view;
            const me = live && (live.seats || []).find((s) => s.seat === live.viewerSeat);
            if (me && lastOpenCard(me)) finishScratch(true);
          }, wait + 30);
        }
      } else {
        finishScratch(true);
      }
    }
    return;
  }
  if (!scratchOn()) return;
  if (state.scratchHand === v.handNo) return;
  if (v.phase !== PHASE.BET && v.phase !== PHASE.SPLIT) return;
  if (!mine || !mine.inHand || mine.folded || mine.special) return;
  // 一手只搓一次；只有「刚发到第四张」那一小段窗口才开搓，
  // 刷新 / 重连后看到早已亮出的第四张不会再补一次
  if (mine.scratchUsed) return;
  if (!(mine.scratchGateLeft > 0) && !(mine.scratchLeft > 0)) return;
  const cards = mine.cardsView || [];
  // 第四张已经发出（扣着时 cardsView 里那一格是牌背，真牌在自己的 hand[3] 里）
  if (cards.length < 4) return;
  // 第四张已经亮在桌上了：这一手没赶上扣牌窗口，再铺大牌只会「盖上去又立刻收场」，
  // 牌背一闪而过——索性不开，等下一手（v0.20.34）
  if (lastOpenCard(mine)) return;
  const card4 = (mine.hand || [])[3] || cards[3];
  if (!card4) return;
  state.scratchHand = v.handNo;
  // v0.20.34：探测到第四张就立刻向服务端声明，把牌扣住；
  // 否则 800ms 的展示等待会撞上服务端 900ms 的门控窗口，出现牌背时有时无
  announceScratch(v.handNo);
  // v0.20.26：座位上的第四张牌背先亮出来，停 0.8 秒再弹出大牌（搓牌画面；v0.20.32：0.5s → 0.8s）
  const handNo = v.handNo;
  const seat = mine.seat;
  setTimeout(() => {
    const live = state.view;
    if (state.scratchHand !== handNo || !live || live.handNo !== handNo) return;
    // 弹大牌前再确认一次「第四张还扣着」：声明要是没赶上，桌上已经亮牌了，
    // 这时候再弹就是一张没有牌背的大牌（v0.20.34）
    const me = (live.seats || []).find((s) => s.seat === live.viewerSeat);
    const cv = (me && me.cardsView) || [];
    if (!me || cv.length < 4 || lastOpenCard(me)) return;
    openScratch(seat, card4);
  }, 800);
}

/** 上一张战绩表的合计（表内各行相加，底部摘要与校验都用它） */
let statsSums = { buy: 0, hands: 0, net: 0 };

/** 把一帧视图算成「一行一个人」的战绩表（结束弹窗、实时战绩、领奖台共用）
 *  同一个玩家离开后回来继续入局，按名字并成同一栏，不再单列一行，
 *  带入 / 手数 / 正负全部累加，右边标「重新入局 ×n」。 */
function buildStats(v) {
  const key = (x) => String(x || '').trim();
  const map = new Map();
  // v0.22.103：合栏按账号 uid（数据永远跟 uid 走）——改名不再拆成两行，
  // 同名两个人不再被并成一行。没有 uid（机器人 / 旧留档）才退回按名字。
  const pick = (name, uid) => {
    const u = key(uid);
    const nm = key(name);
    const k = u ? 'u:' + u : 'n:' + nm;
    if (!map.has(k)) {
      map.set(k, { name: nm, uid: u, buyIn: 0, hands: 0, net: 0, live: null, back: 0, away: false, ava: '' });
    }
    return map.get(k);
  };

  // 中途离过场的人：先进表，作为底账。
  // 旧版断线留档后玩家再点离开会记第二遍（两条一模一样），这里按
  // 「座位 + 名字 + 带入 + 手数 + 输赢」去重，别把整份战绩翻倍。
  const seenDep = new Set();
  for (const p of (v.departed || [])) {
    if (!key(p.name) && !key(p.uid)) continue;
    const sig = [key(p.uid), p.seat, key(p.name), p.buyIn || 0, p.hands || 0, p.net || 0].join('|');
    if (seenDep.has(sig)) continue;
    seenDep.add(sig);
    const row = pick(p.name, p.uid);
    if (!row) continue;
    row.buyIn += p.buyIn || 0;
    row.hands += p.hands || 0;
    row.net += p.net || 0;
    row.ava = row.ava || p.avatar || '';   // 离场留档也带头像（服务端 retire 时存了一份）
    row.isAI = row.isAI || !!p.isAI;
    row.back += 1;
  }

  // 现在坐在桌上的人：接着往上加
  for (const p of v.seats) {
    if (p.vacant) continue;
    if (!p.name && !p.hands && !p.buyIn && !p.stack) continue;
    const row = pick(p.name, p.uid);
    if (!row) continue;
    if (key(p.name)) row.name = key(p.name);   // 在场名字是最新的，覆盖旧留档名字
    row.buyIn += p.buyIn || 0;
    row.hands += p.hands || 0;
    row.net += p.net || 0;
    row.pending = (row.pending || 0) + (p.pending || 0);
    row.live = p;
    row.ava = p.avatar || row.ava || '';   // 在场的人拿座位快照里的头像
    row.isAI = !!p.isAI;
    row.away = !!p.away;
    row.broke = !!p.broke;
    row.joinNext = !!p.joinNext;
  }

  // 输赢从大到小排：最上面是当前最大赢家，最下面是最大输家。
  // 口径仍是「簸簸 − 带入」，真人的数字绝不改；只是整桌相加必须为 0。
  // 早先机器人破产重买会把它输的钱从表里抹掉，历史遗留会剩一个正缺口，
  // 这个差额记在机器人身上（谁让钱是系统补给它的）。
  const byNet = (a, b) => b.net - a.net || b.hands - a.hands;
  const list = [...map.values()];
  // 只在结算后收口：牌局进行中每人的注还在底池里（簸簸已扣、赢家未定），
  // 这时硬把差额摊给谁都是错的，宁可让表暂时不平。
  // 全员休牌时只有圈芒和加倍滚进芒果池（carryPot），底皮已退回各人簸簸，
  // 所以这一手的正常合计是 −carryPot，只有超出这个数的才是历史缺口。
  const settled = v.phase === PHASE.SETTLED;
  const expect = settled ? -(v.carryPot || 0) : 0;
  const total = settled ? list.reduce((a, r) => a + r.net, 0) - expect : 0;
  if (total !== 0) {
    const ai = list.filter((r) => r.isAI);
    const pool = ai.length ? ai : list;
    const side = total > 0 ? pool.filter((r) => r.net > 0) : pool.filter((r) => r.net < 0);
    const weight = side.reduce((a, r) => a + Math.abs(r.net), 0);
    let left = Math.abs(total);
    if (weight > 0) {
      for (const r of side) {
        if (left <= 0) break;
        const room = Math.abs(r.net);
        const share = Math.min(room, Math.round((room / weight) * Math.abs(total)));
        const cut = Math.min(share, left);
        // v0.22.102：只动胜负，绝不动带入——带入是玩家实际掏的钱，必须
        // 保持真实（10/20 的牌局就是整百整千）；整桌差额全部摊进胜负。
        r.net += total > 0 ? -cut : cut;
        left -= cut;
      }
    }
    if (left > 0) {   // 四舍五入的零头也只进胜负
      pool[0].net += total > 0 ? -left : left;
    }
  }
  list.sort(byNet);
  statsSums = {
    buy: list.reduce((a, r) => a + r.buyIn, 0),
    hands: list.reduce((a, r) => a + r.hands, 0),
    net: list.reduce((a, r) => a + r.net, 0),
  };
  return list;
}

/** 战绩行 HTML（可以直接传 buildStats 的结果，避免重复算一遍） */
function statsRowsHTML(v, list) {
  const rows = list || buildStats(v);
  return rows.map((row) => {
    const p = row.live;
    const mine = p && p.seat === v.viewerSeat;
    const cls = row.net > 0 ? 'win' : row.net < 0 ? 'lose' : '';
    const tags = [];
    if (!p && row.back > 0) tags.push('<i class="off">已离场</i>');
    if (p && !row.back) {
      if (p.away) tags.push('<i class="off">离座</i>');
      else if (p.joinNext) tags.push('<i class="off">下场入座</i>');
    }
    const dim = !p ? ' gone' : '';
    return `<div class="stats-row${mine ? ' me' : ''}${dim}">
      <div class="stats-player">
        <span class="stats-avatar${row.isAI ? ' ai' : ''}">${statsAvaHTML(row.name, row.ava)}</span>
        <b>${esc(row.name)}${mine ? '<i>我</i>' : ''}${tags.join('')}</b>
      </div>
      <span class="stats-num">${row.buyIn.toLocaleString()}${row.pending ? `<i class="pend" title="已申请带入，本手结束后到账">+${row.pending.toLocaleString()}</i>` : ''}</span>
      <span class="stats-num">${row.hands}</span>
      <span class="stats-net ${cls}">${row.net > 0 ? '+' : ''}${row.net.toLocaleString()}</span>
    </div>`;
  }).join('');
}

/** 结算页头像下的「第 N 名」角标 / 冠军的 MVP 盾徽 */
function mvpShieldSvg() {
  return `<svg class="es-shield" viewBox="0 0 64 68" aria-hidden="true">
    <defs>
      <linearGradient id="mvpShieldG" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#fff3c4"/><stop offset=".42" stop-color="#f0c463"/>
        <stop offset="1" stop-color="#a8721c"/>
      </linearGradient>
    </defs>
    <path d="M32 2 L58 10 V34 Q58 52 32 66 Q6 52 6 34 V10 Z"
      fill="url(#mvpShieldG)" stroke="#8b5c11" stroke-width="2.4" stroke-linejoin="round"/>
    <path d="M32 8 L52 14 V33 Q52 47 32 58 Q12 47 12 33 V14 Z"
      fill="rgba(255,250,232,.35)" stroke="rgba(255,255,255,.6)" stroke-width="1.6"/>
    <text x="32" y="38" text-anchor="middle" font-size="16" font-weight="900"
      letter-spacing=".5" fill="#5a3a05" font-family="Arial Black, Impact, sans-serif">MVP</text>
  </svg>`;
}

/** 结算页：浅色卡片列表（房间汇总 + 每位玩家一张卡 + 冠军 MVP 盾徽） */
function endedSheetHTML(v, list, why) {
  const money = (n) => `${n > 0 ? '+' : ''}${Number(n || 0).toLocaleString()}`;
  const buy = list.reduce((a, r) => a + (r.buyIn || 0), 0);
  // 全部流水：按约定直接取本局所有玩家带入总和
  const flow = buy;
  const best = list.reduce((a, r) => ((r.net || 0) > (a.net || 0) ? r : a), list[0]);
  const meId = acct.user ? String(acct.user.id) : '';
  const who = String(v.ownerName || '本桌').replace(/的牌局$/, '') || '本桌';

  const cards = list.map((row, i) => {
    const rank = i + 1;
    const uid = row.live && row.live.uid ? String(row.live.uid) : '';
    const tags = [];
    if (row.live && row.live.isAI) tags.push('电脑玩家');
    if (!row.live && row.back > 0) tags.push('已离场');
    if (row.live && row.live.away) tags.push('离座');
    const netCls = (row.net || 0) > 0 ? ' win' : (row.net || 0) < 0 ? ' lose' : '';
    const isMe = !!meId && row.live && String(row.live.uid || '') === meId;
    return `<article class="es-card${rank === 1 ? ' top' : ''}${isMe ? ' me' : ''}">
      ${rank === 1 ? `<span class="es-mvp">${mvpShieldSvg()}</span>` : ''}
      ${rank <= 3 && rank > 1 ? `<span class="es-rank">${rank}</span>` : ''}
      <span class="es-ava">${statsAvaHTML(row.name, row.ava)}</span>
      <div class="es-main">
        <h3>${esc(row.name)}${isMe ? '<i class="es-me">我</i>' : ''}${tags.map((t) => `<i class="es-tag">${t}</i>`).join('')}</h3>
        <div class="es-meta">
          ${uid ? `<span>ID: ${esc(uid)}</span>` : ''}
          <span>手数 ${row.hands || 0}</span>
          <span>带入 ${Number(row.buyIn || 0).toLocaleString()}</span>
        </div>
      </div>
      <div class="es-net${netCls}">${money(row.net)}</div>
    </article>`;
  }).join('');

  return `<div class="es-head">
      <h2>${esc(who)}的牌局</h2>
    </div>
    <div class="es-body">
      <section class="es-sum">
        <div class="es-grid">
          <div><span>全部手数</span><b>${v.handNo || 0}</b></div>
          <div><span>全部带入</span><b>${buy.toLocaleString()}</b></div>
          <div><span>全部流水</span><b>${flow.toLocaleString()}</b></div>
          <div><span>最大赢家</span><b>${esc(best ? best.name : '—')}</b></div>
        </div>
        <div class="es-strip">
          <span class="es-chip">底皮 ${v.ante}</span>
          <span class="es-chip">圈芒 ${v.handMango || (v.ante || 0) * 2}</span>
          <span class="es-time">${why}</span>
        </div>
        <p class="es-note">注：仅限朋友间娱乐，严禁任何形式赌博</p>
      </section>
      <div class="es-list">${cards}</div>
    </div>
    <div class="es-foot">
      <span class="es-count">本桌将在 <b id="endLeft">10</b> 秒后关闭</span>
      <button class="es-quit" id="endQuit">离开本桌</button>
    </div>`;
}

/** 画战绩表：只画打开那一刻拍下的帧，牌局推送不再改它（保持滚动位置） */
function paintStats() {
  if ($('modalBox').dataset.kind !== 'stats') return;
  const v = state.statsSnap;
  const rows = $('statsRows');
  if (!v || !rows) return;
  if (state.statsPainted) return;
  state.statsPainted = true;
  const scroll = $('statsScroll');
  const keep = scroll ? scroll.scrollTop : 0;
  rows.innerHTML = statsRowsHTML(v);
  if (scroll) scroll.scrollTop = keep;
  // 底部摘要：只报表内数字的合计（和上面各行相加严格一致），不再显示「池中」
  const foot = $('statsFoot');
  if (foot) {
    const live = (v.seats || []).filter((p) => !p.vacant && (p.name || p.buyIn));
    // 结算后才报合计：正常手为 0；全员休牌那手是 −滚存，钱在芒果池里，单独标出来
    const carry = v.carryPot || 0;
    const sum = (statsSums.net > 0 ? '+' : '') + statsSums.net.toLocaleString();
    const sumLine = v.phase === PHASE.SETTLED
      ? `<span>胜负合计 <b>${sum}</b></span>${carry ? `<span>芒果池 <b>${carry.toLocaleString()}</b></span>` : ''}`
      : '';
    foot.innerHTML = `<span>在座 <b>${live.length}</b> 人</span>
      <span>带入合计 <b>${statsSums.buy.toLocaleString()}</b></span>${sumLine}`;
  }
}

/* ── 牌局回顾：一手一页，左右翻 ───────────────── */
// 默认只亮「参与比牌的 / 三花 / 天皇地皇 / 自己」的牌，其余弃牌的人只显示背面。
// 「查看所有底牌」的免费入口已下线，改成回顾页的付费「强制秀牌」。
// v0.22.59：回顾秀牌按「手」记账，翻页互不串；回顾包含该房间所有已结算历史手
const logShownHands = new Set();   // 已付费秀过的 handNo
let logHands = [];      // 整局记录，旧的在前
let logPage = 0;        // 当前第几手
let logWanted = false;  // 已经发过拉取请求，等在途
const logPeeked = new Set();  // 偷偷看过的「handNo:seat」，回看同一页不再扣钻

/** 打开回顾：先跟服务端要整局记录（按需拉，不跟着每次推送带） */
function showLog() {
  if (!state.view) { toast('还没进桌'); return; }
  if (net.mode === 'local' && state.game) { openLogPanel(state.game.log.slice()); return; }
  if (logWanted) return;
  logWanted = true;
  toast('正在取整局记录…');
  sendWS({ t: 'logs' });
  // 拿不到就别一直卡着
  setTimeout(() => { if (logWanted) { logWanted = false; toast('记录没取到，稍后再点一次'); } }, 6000);
}

function openLogPanel(hands) {
  logWanted = false;
  // 面板已经打开，就别再顶着「正在取整局记录…」的提示
  clearTimeout(toastTimer);
  $('toast').classList.remove('show');
  // v0.22.59：服务端下发的是「已完成结算的全部历史对局」，这里不再按
  // handNo < 本手 二次过滤——结算停留期刚打完、以及房间停牌前的最后一手
  // 都能在回顾里看到、能秀、能偷看。进行中的本手根本不在 log 里，
  // 所以回顾里的秀牌 / 偷偷看依然碰不到桌上正在打的底牌。
  const hist = (hands || []).filter((h) => h && Number.isFinite(Number(h.handNo)));
  if (!hist.length) { toast('这一局还没有可回顾的历史牌局'); return; }
  logHands = hist;
  logPage = hist.length - 1;   // 默认停在最新一手

  const box = $('modalBox');
  box.dataset.kind = 'log';
  box.classList.add('log-box');
  box.innerHTML = `<button class="modal-x" id="logClose">×</button>
    <h2>牌局回顾</h2>
    <div class="log-bar">
      <span class="log-count" id="logCount"></span>
      <button class="log-eye" id="logShow">秀这手牌<em class="log-cost"><span class="dm"></span>${PRICE.forceShow}</em></button>
    </div>
    <div class="log-page" id="logPage"></div>
    <div class="log-nav">
      <button class="log-arrow" id="logPrev" aria-label="上一手">‹</button>
      <span class="log-pos" id="logPos"></span>
      <button class="log-arrow" id="logNext" aria-label="下一手">›</button>
    </div>`;
  box.querySelector('#logClose').onclick = closeModal;
  // v0.20.75：回顾「秀这手牌」只秀当前这一页的历史手，10 钻 / 手。
  // 旧版这里发的是 t:'forceShow'（本手），牌局进行中点一下会把桌上本手
  // 四张底牌直接亮给全桌；而且用「本手 showHand」拦截，本手秀过后就再也点不动。
  // 现在改为按历史手 handNo 请求，拦截只看这一手秀没秀过。
  box.querySelector('#logShow').onclick = () => {
    const h = logHands[logPage];
    if (!h) return;
    if (logShownHands.has(h.handNo)) { toast('这一手已经秀过了'); return; }
    // 单机练习没有账户 / 钻石体系：直接亮这一手，不扣钻
    if (net.mode !== 'online') {
      logShownHands.add(h.handNo);
      paintLogPage();
      return;
    }
    if (!acct.user || (acct.user.diamonds || 0) < PRICE.forceShow) {
      toast(`钻石不够，秀牌要 ${PRICE.forceShow} 钻`);
      return;
    }
    sendWS({ t: 'showLogHand', handNo: h.handNo });
  };
  box.querySelector('#logPrev').onclick = () => gotoLog(logPage - 1);
  box.querySelector('#logNext').onclick = () => gotoLog(logPage + 1);

  // 手指左右滑翻页
  const body = box.querySelector('#logPage');
  let sx = 0; let sy = 0; let tracking = false;
  body.addEventListener('touchstart', (e) => {
    const t = e.touches[0]; sx = t.clientX; sy = t.clientY; tracking = true;
  }, { passive: true });
  body.addEventListener('touchend', (e) => {
    if (!tracking) return;
    tracking = false;
    const t = e.changedTouches[0];
    const dx = t.clientX - sx;
    const dy = t.clientY - sy;
    if (Math.abs(dx) > 46 && Math.abs(dx) > Math.abs(dy) * 1.4) gotoLog(logPage + (dx < 0 ? 1 : -1));
  }, { passive: true });

  // 偷偷看：事件委托到页面上，翻页后照样能点
  body.addEventListener('click', (e) => {
    const b = e.target.closest('.log-peek');
    if (!b) return;
    const hNow = logHands[logPage];
    const seat = Number(b.dataset.seat);
    const key = `${hNow.handNo}:${seat}`;
    if (logPeeked.has(key)) { toast('这一家已经看过了'); return; }
    if (!acct.user || (acct.user.diamonds || 0) < PRICE.peek) {
      toast(`钻石不够，偷偷看要 ${PRICE.peek} 钻`);
      return;
    }
    sendWS({ t: 'peekLog', handNo: hNow.handNo, seat });
  });

  $('modal').classList.remove('align-left');
  $('modal').classList.add('align-right');
  $('modal').classList.remove('hidden');
  paintLogPage();
}

/* 结算期中央「强制秀牌」：插入独立的 1.5 秒秀牌窗口，回顾该手同步全亮 */
{
  const fr = $('forceReveal');
  if (fr) fr.onclick = () => {
    fr.disabled = true;
    sendWS({ t: 'revealAll' });
    // 整个 1.5 秒秀牌窗口内保持禁用，避免窗口还没结束就重复点（服务端也有一手一次的兜底）
    setTimeout(() => { fr.disabled = false; }, 1600);
  };
}

function gotoLog(n) {
  const to = Math.max(0, Math.min(logHands.length - 1, n));
  if (to === logPage) return;
  logPage = to;
  beep(520, 0.04, 'triangle', 0.02);
  paintLogPage();
}

/** 键盘←→也能翻 */
document.addEventListener('keydown', (e) => {
  if ($('modal').classList.contains('hidden')) return;
  if ($('modalBox').dataset.kind !== 'log') return;
  if (e.key === 'ArrowLeft') { e.preventDefault(); gotoLog(logPage - 1); }
  if (e.key === 'ArrowRight') { e.preventDefault(); gotoLog(logPage + 1); }
});

function paintLogPage() {
  const h = logHands[logPage];
  const body = $('logPage');
  if (!h || !body) return;
  const count = $('logCount');
  if (count) count.textContent = `第 ${logPage + 1} / ${logHands.length} 手`;
  const pos = $('logPos');
  if (pos) {
    if (h.void) pos.textContent = `芒果池 ${h.carryPot}`;
    else {
      const sideTxt = (h.sidePot || 0) > 0 ? ` · 主${h.mainPot} 边${h.sidePot}` : '';
      pos.textContent = `皮池 ${h.pot}${sideTxt}`;
    }
  }
  const btn = $('logShow');
  if (btn) {
    // v0.20.75：只看「当前这一页的历史手」秀没秀过；本手 showHand 不再参与，
    // 否则桌上秀过一次牌，回顾按钮就永久点不动（偷偷看却还能点）。
    const done = logShownHands.has(h.handNo);
    btn.classList.toggle('off', done);
    btn.classList.toggle('on', done);
    btn.title = done ? '这一手已经秀过了' : '秀这一手全部底牌（仅历史牌局）';
  }
  const prev = $('logPrev');
  const next = $('logNext');
  if (prev) prev.disabled = logPage <= 0;
  if (next) next.disabled = logPage >= logHands.length - 1;
  body.innerHTML = handHtml(h);
  body.scrollTop = 0;
}

/** 一手的全部玩家：名字 + 牌型 + 四张牌（头两张蓝线、第四张红线）+ 下注 + 输赢 */
function handHtml(h) {
  const viewerSeat = (state.view && state.view.viewerSeat);
  return [...h.seats]
    // v0.20.49：只按「这一手有没有真的发到牌」来留行。
    // 机器人参与了牌局（补位并发了牌）就正常显示它的一行；没发牌的座位
    // （空座、刚坐下等下一手、留座）一律不补位，免得凭空多出几行空牌背。
    .filter((p) => p.name && (p.hand || []).length)
    .sort((a, b) => b.delta - a.delta)
    .map((p) => {
      const f = pairLabel;   // v0.22.67：2+9 名称随地九王开关，与摊牌/分牌口径一致
      const sp = p.split;
      const shown = logShownHands.has(h.handNo) || p.seat === viewerSeat || !!p.showHand
        || logPeeked.has(`${h.handNo}:${p.seat}`)
        // v0.22.23：结算期「强制秀牌」只在买家（点按钮的人）翻回顾时全亮
        || h.revealBy === viewerSeat
        || !!(sp && sp.headCards && sp.tailCards) || !!p.special || !!p.emperor;
      let ordered;
      if (!shown) {
        const hand = p.hand || [];
        ordered = hand.length
          ? hand.map((c, i) => (i < 2 ? 'back' : c))
          : ['back', 'back'];
      } else {
        ordered = sp && sp.headCards && sp.tailCards
          ? [...sp.headCards, ...sp.tailCards]
          : (p.hand || []);
      }
      const desc = p.special ? p.special
        : p.folded ? '已弃'
          : sp ? `${f(sp.head)}｜${f(sp.tail)}` : '—';

      // 一张牌：null 占位不发牌
      const one = (c, cls = '') => {
        if (c === null) return '<span class="log-cw"></span>';
        const html = c === 'back' ? cardEl(null, { small: true }).outerHTML
          : cardEl(c, { small: true }).outerHTML;
        return `<span class="log-cw ${cls}">${html}</span>`;
      };

      let cardsHtml;
      // 弃了牌的人（含第一、二轮就走的）不标比牌线，只有真正参与比牌才标
      const mark = shown && !p.folded && !p.special;
      // 线跟着「实际那两张底牌 + 实际第四张」走：回顾里按头/尾两组重排过，
      // 底牌可能落在任意两组里，不能再按第 1、2、4 的固定位置标
      const holeIds = (p.hand || []).slice(0, 2).filter(Boolean).map((c) => c.id);
      const fourth = (p.hand || [])[3];
      const markOf = (c) => {
        if (!mark || !c || c === 'back') return '';
        if (holeIds.includes(c.id)) return 'ul1';            // 底牌（两张暗牌）→ 蓝线
        if (fourth && c.id === fourth.id) return 'ul4';      // 第四张明牌 → 红线
        return '';
      };
      if (ordered.length >= 4) {
        // 比牌：左头右尾两组；蓝线跟实际底牌，红线跟实际第四张，第三张不标
        cardsHtml = `<div class="log-grp head">${one(ordered[0], markOf(ordered[0]))}${one(ordered[1], markOf(ordered[1]))}</div>
          <div class="log-grp tail">${one(ordered[2], markOf(ordered[2]))}${one(ordered[3], markOf(ordered[3]))}</div>`;
      } else if (ordered.length === 3) {
        cardsHtml = `<div class="log-grp head">${one(ordered[0])}${one(ordered[1])}</div>
          <div class="log-grp tail">${one(ordered[2])}</div>`;
      } else {
        cardsHtml = `<div class="log-grp head">${ordered.map((c) => one(c)).join('')}</div>`;
      }

      const win = p.seat === h.winner ? ' win-hand' : '';
      // 左列是「本手从簸簸实际入池的下注额」：只算皮池里的下注（含底皮），不含圈芒/份子。
      // 圈芒/份子是个个必交、与输赢无关的死钱，另行计入芒果池（见下方「芒果:NNN」），
      // 不再并到「下」里，避免把强制交的份子钱当成自愿下注，造成
      // 「簸簸 480 全下、回顾却只显示下 220」这类看不懂的异议。
      const putIn = (p.bet || 0);
      const betTxt = putIn ? `下 ${putIn}` : '';
      const backNum = typeof p.back === 'number' && !h.void ? p.back : putIn;
      const betTip = putIn
        ? `本手从簸簸下注 ${putIn}（皮池），另交圈芒 ${p.mangoPaid || 0}（芒果池），结算收回 ${backNum}`
        : '';
      const d = p.delta || 0;
      const deltaTxt = h.void && !d ? '—' : `${d > 0 ? '+' : d < 0 ? '−' : ''}${Math.abs(d)}`;
      const deltaCls = d > 0 ? 'win' : d < 0 ? 'lose' : 'flat';
      // 输家也可能没输光：下注超过全场第二高、没人跟得上的那截会原样退回。
      // 单独标一行「退 N」，免得「投 1360 / −1360」被看成全额输掉（那 20 其实回簸簸了）。
      const backTxt = !h.void && d < 0 && backNum > 0 ? `退 ${backNum}` : '';
      // 收池者这一手赢到的芒果钱（圈芒 + 滚存）：输赢数字下方单独标红，数字大了自动缩字号
      const mangoWin = p.mangoWin || 0;
      const mangoFs = mangoWin >= 100000 ? 8.5 : mangoWin >= 10000 ? 9.5 : 11;
      // 竖排「偷偷看 💎2」：只对还没看到底牌的人挂出来
      const peekBtn = !shown && net.mode === 'online'
        ? `<button class="log-peek" data-seat="${p.seat}" aria-label="偷偷看底牌">偷偷看<i><span class="dm"></span>2</i></button>`
        : '';
      return `<div class="log-row${p.seat === viewerSeat ? ' me' : ''}${win}">
        <div class="log-who"><b>${p.name}</b><span>${desc}</span></div>
        ${peekBtn}
        <div class="log-cards">${cardsHtml}</div>
        <div class="log-num">
          <span class="log-bet" title="${betTip}">${betTxt}</span>
          <span class="log-delta ${deltaCls}">${deltaTxt}</span>
          ${backTxt ? `<span class="log-back" title="下注超过全场第二高，没人跟得上的 ${backNum} 已退回簸簸">${backTxt}</span>` : ''}
          ${mangoWin > 0 ? `<span class="log-mango" style="font-size:${mangoFs}px">芒果:${mangoWin}</span>` : ''}
        </div>
      </div>`;
    }).join('');
}

/* ── 规则 ─────────────────────────────────── */
function showRules() {
  const box = $('modalBox');
  const rv = state.view || {};
  const rAnte = rv.ante || 10;
  const rMango = rv.handMango || rAnte * 2;
  const rMin = rv.minBuyIn || rv.buyIn || 2000;
  const rOnline = net.mode === 'online';
  box.dataset.kind = 'rules';
  box.innerHTML = `
    <h2><span class="brand-font">宽窄</span> · 丁二皇</h2>
    <div class="sub">四川茶馆牌，32 张，2~6 人，四张分头尾</div>
    <div class="rules-list">
      <div><span class="k">牌张</span>红3 一张、大王 一张，其余同色同点各两张，共 32 张。</div>
      <div><span class="k">流程</span>押底皮 → 发 2 张暗牌 → 说话 → 发 1 张明牌 → 说话 → 再发 1 张明牌 → 说话 → 分牌比大小。</div>
      <div><span class="k">说话</span><b>跟</b>跟上家注／<b>大</b>加注（竖条上下拖，上限是簸簸）／<b>敲</b>把簸簸推满／<b>休</b>本轮不下注／<b>丢</b>弃牌。</div>
      <div><span class="k">加注台阶</span><b>1/2、2/5</b> 不设台阶（按 1 递增）；<b>5/10 每 5</b>、<b>10/20 每 10</b>、<b>20/40 每 20</b>、<b>50/100 每 50</b>、<b>100/200 每 100</b> 取整，拖出来的金额会自动吸到最近的合法档位。</div>
      <div><span class="k">起手</span>两张底牌后按<b>底池的 1 倍</b>起手；第三张、第四张牌发出后，按<b>上一轮跟注的金额</b>起手（不是累计总底池）。<b>第一轮第一次「大」只要 ≥ 1 倍最低下注额</b>（不用翻倍），有人开口后再「大」、以及第二第三轮「大」，都必须 <b>≥ 2 倍当前注</b>。</div>
      <div><span class="k">休芒</span><b>任意一轮所有人都休</b>就是休芒，本手当场作废、不再发下一张牌。这一手的钱分成两块：<b>跟注、加注的钱当场原样退回</b>各自簸簸；<b>底皮也一并退回</b>，这手不输不赢；只有<b>圈芒 + 加倍</b>留在芒果池里，连同上一手的滚存一起累计，直到有人赢走。每手固定交<b>底皮 + 圈芒</b>；连击时每家再多交一份<b>加倍</b>（= 圈芒 ×1 → ×2 → ×4 → ×8 封顶）。<b>芒果池本身不封顶</b>，但一手能吃下多少，看你自己这一手往池子里下了多少 —— 簸簸只够下 420，就最多吃 420，剩下的继续滚到下一手。<b>休芒和揍芒共用同一条连击链</b>：两种交替出现也接着往上加，中间只要有人正常比牌收池，连击立刻打断、下一手回到只交圈芒。</div>
      <div><span class="k">揍芒</span><b>在发出第三张牌之前</b>，有人<b>下注（跟最低注 / 大 / 敲都算）</b>、其他人没人跟就弃了，只剩他一家收池，就叫揍芒：<b>下一手除了他，其他人都要多出一份加倍</b>（他出底皮 + 圈芒，别人出底皮 + 圈芒 + 加倍）。<b>揍芒接在休芒后面是接着算的，不重新从 ×1 开始</b>——比如前一手休芒是 ×1，这一手揍芒，下一手就 ×2；再下一手又是休芒，就加到 ×4，第四次起 ×8（封顶）。<b>第三张、第四张发出之后的加注收池只算正常赢，不算揍芒</b>；别人自己弃光、剩下那家这一轮一分钱都没下（庄位最后表态）就不算收池，按休芒作废滚池。</div>
      <div><span class="k">簸簸</span>每人自己的一堆钱，摆在自己座位下面。<b>底皮、跟注、加注、敲，都是当场从簸簸里扣</b>，扣多少显示多少；簸簸不够时「大」会变成「敲」，把剩下的簸簸一次推满。结算时赢的钱再回填进来。</div>
      <div><span class="k">搭不动</span>簸簸不够跟注的时候「敲」，把剩下的全推上去但还没追平当前注，就叫<b>搭不动</b>：<b>不拦、不弃、不影响别人</b>，第三张第四张照常发给他，结算时按他实际下到的钱两两封顶，最多只输这么多。</div>
      <div><span class="k">动作标记</span>每个人说话后，头像右上角会亮起他刚才的动作：<b>大 / 跟 / 休 / 敲 / 丢</b>。</div>
      <div><span class="k">入座 / 围观</span>进房后<b>先站边上看，不自动占座</b>：等待室点空位、牌桌上点「选个座位」自己挑，坐下才算上了桌。<b>没坐下之前只能围观</b>——能看到场上每个人的牌背、明牌、下注和底池，但看不到别人的底牌，也不能下注、带入。<b>位置坐满了就继续围观等座</b>：有人离座，空位出现你就能补上；牌局正打着时选座会先排队，<b>这一手打完自动坐进去</b>，不会把打到一半的机器人换掉。</div>
      <div><span class="k">带入金币</span>左上角菜单 →「带入金币」，<b>一次至少 ${rMin.toLocaleString()}</b>，只能加不能减。${rOnline ? '带上桌的钱<b>要房主点「同意」才到账</b>：房主在等待室和牌桌上都能审核，会看到「带入申请」的角标。<b>房主自己带入不用审核</b>，点一下立刻到账（牌局中则本手结算后进簸簸）。' : ''}<b>牌局进行中带入的，先挂账，这一手结算完立刻进簸簸</b>，不会改变正在打的这一手；座位旁会显示「+N 待入账」。本桌底皮 <b>${rAnte}</b>、圈芒 <b>${rMango}</b>。</div>
      <div><span class="k">停牌留座</span>每手结算完，簸簸<b>低于一次带入的十分之一</b>（本桌 ${rMin.toLocaleString()} ÷ 10 = <b>${Math.max(rAnte, Math.floor(rMin / 10)).toLocaleString()}</b>）就<b>下一手不发牌</b>，座位保留、头像上开始 <b>180 秒</b>读秒。<b>读秒走完还没带入，就直接离座</b>；点「重新入座」最低 ${rMin.toLocaleString()}，下一手正常发牌。</div>
      <div><span class="k">分牌</span>四张拆成头、尾各两张，头必须 ≥ 尾，系统自动排好。</div>
      <div><span class="k">比牌</span>头比头、尾比尾。<b>尾牌大、头牌不输（头大或头平）就算赢</b>，头平尾大也算赢；<b>尾牌持平就看头：头大者赢、头小者输、头也平才算平</b>；反过来尾牌小、头牌不输（头小或头平）就算输；<b>头大尾小、头小尾大这种一胜一负按平算</b>。<b>亮牌时按「左头右尾」摆：左边两张是头、右边两张是尾；没参与比牌的（弃牌、三花自动弃）不亮牌，只看得到背面</b>。牌局回顾里默认可看到自己和比牌者的牌，弃牌者的底牌是背面，想让全桌看到自己的牌用「强制秀牌」。</div>
      <div><span class="k">结算</span><b>尾牌最大的人收皮池</b>。<b>底皮只由输家出</b>：比牌输过的人、弃牌的人，底皮留在池里；<b>比牌不输的人（赢家、平局）底皮原样退回自己簸簸，不进皮池</b>。弃牌、三花退牌后留在桌上的死钱也进皮池。<b>有人短码全下时皮池分主池 / 边池</b>：主池是最低一档 × 在局人数 + 死钱，人人有份；边池只在投得更多的深码之间结算，只有一家够得到的零头原样退回。<b>芒果池单独累计</b>（本手圈芒和加倍 + 上手滚存），按<b>下注</b>「叫住」来赔：<b>先皮池赢家、再按下注从多到少</b>，各家上限是<b>自己这一手的下注额（不含底皮，也不含圈芒 / 加倍）</b>，只交底皮没下注的人吃不到；全桌都吃满还有剩，才滚下一手；尾牌牌力相同再看头牌，头尾全同才均分。<b>注额</b>两两比，<b>尾牌大且头牌不输（头平也算）算赢；尾牌持平则头大者赢、头小者输、头也平才按平</b>；只赢一头（头大尾小、头小尾大）按平，注额原样退回。<b>输家的钱按尾牌从大到小依次分配</b>：尾最大的先拿满自己的注额，剩下的才轮到下一家。<b>两头封顶</b>：每一笔按「你还能赢的注额」和「对方还能输的注额」里小的那个算——你下多少最多就赢多少，对方下得少你只赢到他那份，多下的钱留在簸簸里；中间的人先输给强的、再赢弱的，赢的额度扣掉已输部分，不会重复计算。<b>全下（簸簸推光）的人只能赢到自己盖得住的部分</b>：他投了多少，最多就从每个对手身上赢到同样的数，芒果池里没人接得住的滚存不归他，继续留在池里滚下一手。</div>
      <div><span class="k">特殊</span>三花十（红10+黑10+黑J）、三花六（红6+黑6+大王）<b>只要凑齐就当场自动弃牌</b>——第三张凑齐就只发三张，第四张凑齐就发四张；本局不输不赢，已投进底池的注额全额退回；<b>摊牌时手里的牌全部亮出</b>，让大家看清确实是三花。<b>但如果四张齐时手里已经有对子（同色同点，如♥10+♦10），就不认三花，照常分牌比大小</b>；不同色的同点数（红10+黑10）不算对子，不影响三花成立。<b>三花六手里同时有红3时，红3+大王就是丁皇，三花六让位，按丁皇正常比牌。</b></div>
    </div>
    <div class="rules-grid">
      <div><span>丁皇</span> 红3 + 大王（两张，最强牌型）</div>
      <div><span>天皇 / 地皇</span> 大王+红3+一对红Q / 一对红2，四张齐全通杀全场</div>
      <div><span>天/地/人/和</span> 一对红Q / 红2 / 红8 / 红4</div>
      <div><span>梅十/板凳/长三</span> 一对黑10 / 黑4 / 黑6</div>
      <div><span>虎头/苕十/猫猫/膏药</span> 黑J对 / 红10对 / 红6对 / 红7对</div>
      <div><span>对子</span> 黑5、黑7、黑8、黑9 对</div>
      <div><span>奶狗（天王）</span> 红Q + 黑9</div>
      <div><span>地王</span> 红2 + 黑9</div>
      <div><span>天杠 / 地杠</span> 红Q+黑8 / 红2+黑8</div>
      <div><span>天关九 / 地关九</span> 红Q+黑7 / 红2+黑7</div>
      <div><span>灯笼九</span> 红8 + 黑J</div>
      <div><span>和五九</span> 红4 + 黑5</div>
      <div><span>第 17 档</span> 梅十九 / 板五九 / 丁长九 —— 黑10+黑9、黑4+黑5、红3+黑6，<b>同牌力</b></div>
      <div><span>第 18 档</span> 苕十九 / 丁猫九 / 乌龙九 —— 红10+黑9、红3+红6、黑8+黑J，<b>同牌力</b></div>
      <div><span>散牌</span> 两牌点数相加取个位，9 最大、0 最小</div>
    </div>
    <div style="font-size:11px;color:#7d7566;line-height:1.8">
      点数：红Q 记 2 点、黑J 记 1 点、大王记 6 点，其余按牌面。同点数散牌比最大单牌。<br>
      纯虚拟筹码，不涉及任何现金兑换。
    </div>`;
  $('modal').classList.remove('hidden');
}

/* ── 提示 ─────────────────────────────────── */
let toastTimer = null;
function toast(msg, ms) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  // v0.20.76：权限引导之类要读完的文案可以自己指定停留时长，默认仍是 1.8s
  toastTimer = setTimeout(() => el.classList.remove('show'), ms || 1800);
}

/* ── 联机 ─────────────────────────────────── */
function sendWS(obj) {
  const ws = net.ws;
  if (!ws || ws.readyState !== 1) return false;
  try { ws.send(JSON.stringify(obj)); return true; } catch { return false; }
}

/* ── v0.20.96：设备标识 / 定位采集 ─────────────────────────
 * 设备标识 → 服务端用来拦「同一台手机上的多个账号同桌」；
 * 定位 → 用来拦「相距不到 500 米同桌」。拿不到定位就不判这条，不阻塞落座。
 * 定位只发一次粗略坐标，服务端只在内存留 10 分钟，不落盘、不进日志。
 */
const DEV_KEY = 'dh_dev';
function deviceId() {
  let d = '';
  try { d = localStorage.getItem(DEV_KEY) || ''; } catch { /* 隐私模式 */ }
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(d)) {
    const rnd = () => Math.random().toString(36).slice(2, 10);
    d = `d${Date.now().toString(36)}${rnd()}${rnd()}`;
    try { localStorage.setItem(DEV_KEY, d); } catch { /* 存不了就本次连接用 */ }
  }
  return d.slice(0, 64);
}
/* v0.20.97：防串通改成「按桌开关」，由开房人在开房页勾选。
 * 关着的时候不申请定位——避免进一次房就弹一次授权框。 */
const FAIR_KEY = 'dh_fair';
function fairPicked() {
  const st = { dev: false, ip: false, geo: false };
  document.querySelectorAll('.fair-opt').forEach((b) => {
    if (b.classList.contains('on')) st[b.dataset.fair] = true;
  });
  return st;
}
function paintFairNote() {
  const st = fairPicked();
  const on = [];
  if (st.dev) on.push('同设备');
  if (st.ip) on.push('同网络');
  if (st.geo) on.push('100 米内');
  const n = $('fairNote');
  if (!n) return;
  // v0.22.65：只要有任一项开启，就在「开房后不可修改」前点明结论「不可同桌」
  n.textContent = on.length
    ? `已开启：${on.join(' · ')}。不可同桌，开房后不可修改。`
    : '全关：任何账号都能同桌。开房后不可修改。';
}
function restoreFair() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(FAIR_KEY) || '{}') || {}; } catch { /* 忽略 */ }
  document.querySelectorAll('.fair-opt').forEach((b) => {
    const on = !!saved[b.dataset.fair];
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  paintFairNote();
}
/** 取一次定位（拿到就上报给服务端）；拿不到返回 null，不阻塞开房 */
function ensureGeo() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    let done = false;
    const fin = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      navigator.geolocation.getCurrentPosition((pos) => {
        const c = pos.coords || {};
        sendWS({ t: 'geo', lat: c.latitude, lng: c.longitude, acc: c.accuracy || 0 });
        fin(c);
      }, () => fin(null), { enableHighAccuracy: false, timeout: 8000, maximumAge: 5 * 60 * 1000 });
    } catch { fin(null); }
  });
}

let geoAskedAt = 0;
function shareGeo(force) {
  if (!net.fair || !net.fair.geo) return;   // 本桌没开距离限制就不打扰用户
  if (!navigator.geolocation) return;
  const now = Date.now();
  if (!force && now - geoAskedAt < 5 * 60 * 1000) return;   // 5 分钟内不重复请求
  geoAskedAt = now;
  try {
    navigator.geolocation.getCurrentPosition((pos) => {
      const c = pos.coords || {};
      sendWS({ t: 'geo', lat: c.latitude, lng: c.longitude, acc: c.accuracy || 0 });
    }, () => { /* 拒绝 / 超时：没有定位就不判距离，不影响落座 */ }, {
      enableHighAccuracy: false, timeout: 8000, maximumAge: 5 * 60 * 1000,
    });
  } catch { /* 个别 WebView 直接抛错，忽略 */ }
}

/* ── v0.20.53：对讲机（Push-To-Talk） ──────────────────────
 * 按住右下角话筒 → getUserMedia 采麦克风 → 16kHz 单声道 PCM int16 →
 * 二进制帧发给服务端 → 服务端转发给同桌其他人 → 收到的人排队播放。
 * 松手 / 取消 / 失焦 / 掉线即停；音频不走 JSON，不占牌桌消息限流额度。
 *
 * 为什么不用 MediaRecorder / WebRTC：MediaRecorder 的 webm 分片在 iOS 上
 * 放不出来，WebRTC 又要另起信令和 TURN。PCM 直传 + WebSocket 中转是这套
 * 单服务架构里唯一跨平台（含 WebView 套壳）且改动可控的做法。 */

const VOICE_MAGIC = 0xD1;
const VOICE_RATE = 16000;          // 16kHz 电话音质：128ms 一帧 ≈ 4KB
const VOICE_CHUNK = 2048;          // ScriptProcessor 缓冲区 = 128ms @16k
const VOICE_MAX_MS = 10000;        // v0.20.54：单次对讲 10 秒，到点自动断开（前后端同一档）
const MT_CIRC = 119.4;             // 倒计时环周长：2π×19
const voiceSpeakers = new Set();   // 服务端广播：当前正在说话的座位
const voicePlayers = new Map();    // seat -> 下一个音频块该开始播放的时刻
const voiceStat = { sent: 0, recv: 0, played: 0, errors: [], lastError: '' };
let voiceCtx = null;
let voiceGain = null;
let voiceStream = null;
let voiceSource = null;
let voiceProc = null;
let voiceSink = null;
let voiceHold = false;             // 手指是否还按在按钮上
let voiceTalking = false;          // 采集是否已真正启动
let voiceSeq = 0;                  // 让「授权还没回来就松手」的异步结果作废
let voiceDeadline = 0;             // 本次说话的截止时刻（0 = 未在计时）
let voiceTimer = null;             // 刷新倒计时环 / 判到点的 interval
let voiceTimedOut = false;         // 本次是否被 10 秒倒计时掐断
let voiceNotified = false;         // 「时间到」提示是否已发过（前后端兜底只提示一次）
// v0.22.23：授权过的麦克风常驻流 —— 只在首次使用时走 getUserMedia / 弹授权，
// 之后每次按住话筒直接复用这条流（enabled 开关），不再重复弹授权框。
// iOS/安卓浏览器里「每次询问」的站点、部分 WebView 每次开麦都会再弹，
// 保住这条流就不再有二次授权；跨会话由系统权限记忆兜底。
let micKeepStream = null;

function voiceCtxGet() {
  if (!voiceCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try { voiceCtx = new AC({ sampleRate: VOICE_RATE }); }
    catch { try { voiceCtx = new AC(); } catch { return null; } }
    voiceGain = voiceCtx.createGain();
    voiceGain.gain.value = 1;
    voiceGain.connect(voiceCtx.destination);
  }
  if (voiceCtx.state === 'suspended') voiceCtx.resume().catch(() => {});
  return voiceCtx;
}

// 收听方可能一次按钮都没点过，靠任何一次触屏把 AudioContext 唤醒，否则一直静音
['pointerdown', 'touchstart', 'keydown'].forEach((evt) => {
  document.addEventListener(evt, () => {
    if (voiceCtx && voiceCtx.state === 'suspended') voiceCtx.resume().catch(() => {});
  }, { passive: true });
});

/** 有些浏览器会忽略 16k 的 sampleRate 请求，这里线性重采样兜底 */
function voiceResample(input, fromRate) {
  if (fromRate === VOICE_RATE) return input;
  const ratio = fromRate / VOICE_RATE;
  const n = Math.max(1, Math.floor(input.length / ratio));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = i * ratio, i0 = Math.floor(p), i1 = Math.min(input.length - 1, i0 + 1);
    const f = p - i0;
    out[i] = input[i0] * (1 - f) + input[i1] * f;
  }
  return out;
}

function sendVoiceFrame(f32, fromRate) {
  const ws = net.ws;
  if (!ws || ws.readyState !== 1 || !voiceTalking) return;
  const pcm = voiceResample(f32, fromRate);
  // [0]=magic / [1]=座位占位（服务端会用真实座位覆盖）/ [2..]=int16 小端
  const buf = new ArrayBuffer(2 + pcm.length * 2);
  const u8 = new Uint8Array(buf);
  const i16 = new Int16Array(buf, 2);
  u8[0] = VOICE_MAGIC;
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    i16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  try { ws.send(buf); voiceStat.sent++; } catch { /* 连接已断 */ }
}

/* ── v0.20.54：单次对讲 10 秒倒计时 ──────────────────────────────
   麦克风授权弹窗耗掉的时间不算进 10 秒：只有真正开麦（voiceTalking=true）
   才起算。到点即使手指还按着也强制断开，必须松手再按才能重新说，
   避免「一直按着不松」变相无限续杯。服务端另有一道同档硬闸兜底。 */
function voiceRemaining() { return Math.max(0, voiceDeadline - Date.now()); }

function paintVoiceTimer() {
  const box = $('micTimer');
  if (!box) return;
  const left = voiceRemaining();
  const num = $('micTimerNum'), arc = $('micTimerArc');
  if (num) num.textContent = String(Math.ceil(left / 1000));
  if (arc) arc.style.strokeDashoffset = String(MT_CIRC * (1 - left / VOICE_MAX_MS));
  const urgent = left <= 3000;
  box.classList.toggle('urgent', urgent);
  const btn = $('btnMic');
  if (btn) btn.classList.toggle('urgent', urgent);   // 环色/数字色挂在按钮上
}

function beginVoiceCountdown() {
  cancelVoiceCountdown();
  voiceTimedOut = false;
  voiceNotified = false;
  voiceDeadline = Date.now() + VOICE_MAX_MS;
  const box = $('micTimer');
  if (box) box.classList.add('on');
  paintVoiceTimer();
  voiceTimer = setInterval(() => {
    if (!voiceTalking) { cancelVoiceCountdown(); return; }
    if (voiceRemaining() <= 0) { endVoiceByTimeout(); return; }
    paintVoiceTimer();
  }, 100);
}

function cancelVoiceCountdown() {
  if (voiceTimer) { clearInterval(voiceTimer); voiceTimer = null; }
  voiceDeadline = 0;
  const box = $('micTimer');
  if (box) box.classList.remove('on', 'urgent');
  const btn = $('btnMic');
  if (btn) btn.classList.remove('urgent');
}

function notifyVoiceTimeout() {
  if (voiceNotified) return;      // 前端到点 + 服务端兜底可能各来一次，只提示一遍
  voiceNotified = true;
  beep(340, 0.09, 'sine', 0.03);
  toast('对讲时间到（10 秒），已自动断开');
}

function endVoiceByTimeout() {
  voiceTimedOut = true;
  cancelVoiceCountdown();
  stopVoice();                   // 发 voice off、关采集、按钮复位
  notifyVoiceTimeout();
}

/* ── v0.20.76：麦克风失败的精确诊断 ──────────────────────────────
   旧版 getUserMedia 一失败就笼统弹「需要麦克风权限」。但这是个 H5 网页，
   权限登记在「打开它的浏览器 / 宿主 App」名下，系统设置里根本没有「本游戏」
   这一项；页面若被嵌进预览 iframe，还会被 Permissions Policy 在策略层直接
   拒绝、连系统授权框都不弹。玩家照着提示去系统设置翻，当然找不到。
   这里按异常名 / 环境给出真正可操作的原因与去哪里开。 */
function micInFrame() {
  try { return window.self !== window.top; } catch { return true; }  // 跨域读 top 抛错 = 被嵌了
}
function micErrorHint(e) {
  const n = (e && e.name) || '';
  if (n === 'NotAllowedError' || n === 'PermissionDeniedError' || n === 'SecurityError') {
    if (micInFrame()) return '麦克风被内嵌窗口禁用：请用系统浏览器打开完整链接后再按住话筒';
    return '麦克风被拒绝：请在浏览器「网站权限 → 麦克风」里允许本页，再按住话筒';
  }
  if (n === 'NotFoundError' || n === 'DevicesNotFoundError' || n === 'OverconstrainedError')
    return '没找到可用麦克风（或设备不支持降噪约束），换台设备再试';
  if (n === 'NotReadableError' || n === 'TrackStartError')
    return '麦克风被其它应用占用了，关掉通话/录音后再试';
  return `麦克风启动失败（${n || '未知'}）：菜单「麦克风自检」可查看原因`;
}
/** 先按理想约束请求（回声消除/降噪/自动增益），部分 WebView 对精确约束
 *  支持不全会抛 OverconstrainedError，降级到最宽松的 {audio:true} 再试一次。
 *  v0.22.23：授权过就不再重复授权 —— 首次拿到的流常驻保留（micKeepStream），
 *  后续开麦直接复用；只有流没了（设备变更/浏览器回收）才重新 getUserMedia。 */
function micStreamAlive() {
  return !!(micKeepStream && micKeepStream.active
    && micKeepStream.getAudioTracks().some((t) => t.readyState === 'live'));
}
async function requestMicStream() {
  if (micStreamAlive()) return micKeepStream;
  if (micKeepStream) {
    try { micKeepStream.getTracks().forEach((t) => t.stop()); } catch {}
    micKeepStream = null;
  }
  const md = navigator.mediaDevices;
  const grab = async (constraints) => {
    const s = await md.getUserMedia(constraints);
    micKeepStream = s;               // 常驻保留：本会话内不再二次弹授权
    try { localStorage.setItem('dh_mic_ok', '1'); } catch {}
    return s;
  };
  try {
    return await grab({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
  } catch (e) {
    const n = (e && e.name) || '';
    if (n === 'OverconstrainedError' || n === 'NotFoundError' || n === 'DevicesNotFoundError') {
      return await grab({ audio: true, video: false });
    }
    throw e;
  }
}

async function startVoice(seq) {
  if (voiceTalking) return;
  if (net.mode !== 'online' || !net.roomId) { toast('进房后才能对讲'); return; }
  const v = state.view;
  if (!v || v.viewerSeat < 0) { toast('坐下后才能对讲'); return; }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    // 多半是非 HTTPS 或内嵌 WebView 没暴露接口，给出可操作的说明
    voiceStat.lastError = 'mediaDevices 不可用';
    toast('当前环境没有麦克风接口：请用 HTTPS 在系统浏览器打开（菜单「麦克风自检」）', 3200);
    return;
  }
  // 必须在用户手势里先建/唤醒 AudioContext，等异步授权回来再 resume 就晚了
  const ctx = voiceCtxGet();
  if (!ctx || typeof ctx.createScriptProcessor !== 'function') {
    toast('当前浏览器不支持对讲'); return;
  }

  const mic = $('btnMic');
  mic.classList.remove('denied');
  let stream;
  try {
    stream = await requestMicStream();
    voiceStat.lastError = '';               // 成功过一次就清掉旧诊断
  } catch (e) {
    mic.classList.add('denied');
    const detail = String((e && e.name) || e);
    voiceStat.errors.push(detail);
    voiceStat.lastError = detail;
    toast(micErrorHint(e), 3600);
    return;
  }
  // 授权弹窗期间用户已经松手，或又按了一次：这次结果直接作废，别偷偷开麦
  // （v0.22.23：常驻麦只静音不销毁，下次按住不弹授权）
  if (seq !== voiceSeq || !voiceHold) {
    stream.getAudioTracks().forEach((t) => { t.enabled = false; });
    return;
  }

  voiceTalking = true;
  voiceStream = stream;
  stream.getAudioTracks().forEach((t) => { t.enabled = true; });   // 复用常驻麦：重新开拾音
  voiceSource = ctx.createMediaStreamSource(stream);
  voiceProc = ctx.createScriptProcessor(VOICE_CHUNK, 1, 1);
  // ScriptProcessor 必须接到 destination 才会持续回调；增益给 0，
  // 自己的声音不从本机喇叭放出来，免得形成回声。
  voiceSink = ctx.createGain();
  voiceSink.gain.value = 0;
  voiceProc.onaudioprocess = (ev) => {
    if (!voiceTalking) return;
    sendVoiceFrame(ev.inputBuffer.getChannelData(0), ctx.sampleRate);
  };
  voiceSource.connect(voiceProc);
  voiceProc.connect(voiceSink);
  voiceSink.connect(ctx.destination);

  sendWS({ t: 'voice', on: true });
  mic.classList.add('talking');
  mic.setAttribute('aria-pressed', 'true');
  beginVoiceCountdown();          // v0.20.54：真正开麦后才起算 10 秒
  beep(720, 0.05, 'sine', 0.03);
}

function stopVoice() {
  cancelVoiceCountdown();         // v0.20.54：松手 / 到点 / 掉线都清掉计时器
  if (!voiceTalking) return;
  voiceTalking = false;
  try { if (voiceProc) voiceProc.onaudioprocess = null; } catch {}
  try { voiceSource && voiceSource.disconnect(); } catch {}
  try { voiceProc && voiceProc.disconnect(); } catch {}
  try { voiceSink && voiceSink.disconnect(); } catch {}
  // v0.22.23：不销毁常驻麦 —— 只静音挂起，下次按住直接复用，不再重复弹授权；
  // 只有流被浏览器回收（readyState 变死）时才会重新走一次 getUserMedia
  try { voiceStream && voiceStream.getAudioTracks().forEach((t) => { t.enabled = false; }); } catch {}
  voiceProc = voiceSource = voiceSink = null;
  voiceStream = null;
  sendWS({ t: 'voice', on: false });
  const mic = $('btnMic');
  if (mic) {
    mic.classList.remove('talking');
    mic.setAttribute('aria-pressed', 'false');
  }
  voicePlayers.clear();
}

function onMicDown(ev) {
  if (voiceHold) return;
  if (ev && ev.preventDefault) ev.preventDefault();
  voiceHold = true;
  const seq = ++voiceSeq;
  // 捕获指针：按住期间手指滑出按钮也继续说，只有真正松手才停
  try {
    const mic = $('btnMic');
    if (ev && ev.pointerId != null && mic.setPointerCapture) mic.setPointerCapture(ev.pointerId);
  } catch {}
  startVoice(seq);
}

function onMicUp() {
  if (!voiceHold) return;
  voiceHold = false;
  voiceSeq++;          // 让还在等授权的那次请求作废
  stopVoice();
}

/** 收到一帧二进制音频：拆出座位号，转成 Float32 排队播放 */
function onVoiceFrame(data) {
  let u8;
  if (data instanceof ArrayBuffer) u8 = new Uint8Array(data);
  else if (ArrayBuffer.isView(data)) u8 = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  else return;
  if (u8.length < 4 || u8[0] !== VOICE_MAGIC) return;
  const seat = u8[1];
  const n = (u8.length - 2) >> 1;
  if (n <= 0) return;
  voiceStat.recv++;
  const ctx = voiceCtxGet();
  if (!ctx) return;
  const i16 = new Int16Array(u8.buffer, u8.byteOffset + 2, n);
  const ab = ctx.createBuffer(1, n, VOICE_RATE);
  const ch = ab.getChannelData(0);
  for (let i = 0; i < n; i++) ch[i] = i16[i] / 32768;
  const src = ctx.createBufferSource();
  src.buffer = ab;
  src.connect(voiceGain);
  // 每个说话人一条独立时间线，多人同时说也能混着听；
  // 30ms 抖动缓冲，落后太多（停了很久又开口）就贴着现在播，不排队积压。
  const now = ctx.currentTime;
  let t = voicePlayers.get(seat) || 0;
  if (t < now + 0.03 || t > now + 0.6) t = now + 0.03;
  try { src.start(t); voicePlayers.set(seat, t + ab.duration); voiceStat.played++; }
  catch { return; }
  src.onended = () => { try { src.disconnect(); } catch {} };
}

/** 座位 DOM 每次重建，把「正在说话」的波纹重新贴回去 */
function applyVoiceSpeakers() {
  document.querySelectorAll('#seatLayer .seat').forEach((el) => {
    el.classList.toggle('speaking', voiceSpeakers.has(Number(el.dataset.seat)));
  });
}

/* 连接地址：默认跟着页面走（线上部署 / 分享网关都能用）。
   APK 套壳时如果加载的是本地 file:// 或 assets，location.host 为空，
   必须在打包前注入 window.__DH_WS__（或用 ?server=https://xxx 传），否则握手地址不合法。 */
function wsEndpoint() {
  const sc = new URLSearchParams(location.search).get('sharecode');
  const q = sc ? `?sharecode=${encodeURIComponent(sc)}` : '';
  const override = window.__DH_WS__ || new URLSearchParams(location.search).get('server');
  let u = null;
  if (override) { try { u = new URL(override, location.href); } catch { u = null; } }
  if (u && u.host) {
    const p = u.protocol === 'https:' || u.protocol === 'wss:' ? 'wss' : 'ws';
    return `${p}://${u.host}/ws${q}`;
  }
  if (!location.host) return '';
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws${q}`;
}

function connect() {
  const url = wsEndpoint();
  if (!url) {
    toast('未配置服务器地址');
    return;
  }
  const ws = new WebSocket(url);
  // v0.20.53：对讲机音频是二进制帧，按 ArrayBuffer 收，别让浏览器包成 Blob
  ws.binaryType = 'arraybuffer';
  net.ws = ws;

  ws.onopen = () => {
    net.tries = 0;
    // v0.20.96：先报设备标识，服务端据此拦「同一台设备多个账号同桌」
    sendWS({ t: 'hello', dev: deviceId() });
    if (acct.token) sendWS({ t: 'auth', token: acct.token });
    if (net.god && net.roomId) {
      // 上帝视角的连接断了：重连后直接回到原来那一桌
      if (adminKey()) sendWS({ t: 'adminLogin', key: adminKey() });
      setTimeout(() => sendWS({ t: 'adminWatch', room: net.roomId }), 120);
    } else if (net.mode === 'online' && net.roomId && acct.user) {
      sendWS({
        t: 'join', room: net.roomId, name: currentNick(), token: net.token,
      });
    } else if (acct.user) {
      sendWS({ t: 'rooms' });
    }
  };

  ws.onmessage = onWS;

  ws.onclose = () => {
    onMicUp();   // v0.20.53：掉线先松手，别让麦克风一直开着
    if (net.mode === 'local') return;
    const wait = Math.min(8000, 1200 * Math.max(1, ++net.tries));
    if (net.mode === 'online' && net.joinedOnce) toast('连接断开，正在重连…', 2000);
    setTimeout(connect, wait);
  };
}

/* ── v0.22.89：网络质量监测（弱网诊断 + 画面冻结自救）──────────────
 * 1) RTT 探测：每 5 秒发一次 ping（服务端原样回显时间戳），测出真实往返
 *    延迟；HUD 旁挂一枚小指示条让玩家自己也能看到网络状况。
 *    采样窗口内最大 RTT 超 1.5 秒时上报 [RTT] 到服务端落盘（30 秒去重），
 *    玩家报「卡」时我们就有数据判断是链路问题还是渲染问题。
 * 2) 画面冻结看门狗：在线牌局里 6 秒没收到任何 state 快照 → 主动发 sync
 *    讨要最新画面（配合服务端 flushBacklog，弱网积压后不再永久卡死）。
 */
function rttChip() {
  let el = document.getElementById('rttChip');
  if (!el) {
    el = document.createElement('div');
    el.id = 'rttChip';
    el.style.cssText = 'position:absolute;top:calc(104px + var(--safe-t,0px) + 2px);right:10px;'
      + 'z-index:13;font-size:10.5px;line-height:1;padding:4px 8px;border-radius:9px;'
      + 'font-variant-numeric:tabular-nums;letter-spacing:.4px;color:#dfe8e2;'
      + 'background:rgba(4,16,14,.55);border:1px solid rgba(227,189,122,.22);'
      + 'pointer-events:none;transition:opacity .3s';
    const hud = document.querySelector('.hud') || document.body;
    hud.appendChild(el);
  }
  return el;
}
function paintRttChip() {
  const el = rttChip();
  const r = net.rtt;
  const stale = net.lastStateAt && (Date.now() - net.lastStateAt > 6000);
  if (net.mode !== 'online' || (!r.n && !net.lastStateAt)) { el.style.opacity = '0'; return; }
  el.style.opacity = '1';
  let color = '#7fe0a8', bg = 'rgba(14,58,38,.6)';           // 绿：顺畅
  if (stale || (r.n && r.last >= 800)) { color = '#ff9d8c'; bg = 'rgba(70,16,10,.65)'; }
  else if (r.n && r.last >= 300) { color = '#ffe08a'; bg = 'rgba(74,52,6,.6)'; }
  el.style.color = color;
  el.style.background = bg;
  el.textContent = stale ? '弱网补发中…'
    : r.n ? `${Math.round(r.last)}ms` : '测速中…';
}
function reportRtt() {
  try {
    const r = net.rtt;
    if (r.max < 1500 || Date.now() - r.repAt < 30000) return;   // 没卡过 / 30 秒内报过
    r.repAt = Date.now();
    const u = new URL(wsEndpoint());
    const origin = u.protocol.replace(/^ws/, 'http') + '//' + u.host;
    fetch(origin + '/client-crash', {
      method: 'POST', keepalive: true,
      body: '[RTT] ' + JSON.stringify({
        max: Math.round(r.max), avg: Math.round(r.avg), last: Math.round(r.last),
        n: r.n, ua: perfUA(), v: document.documentElement.dataset.ver || '', ts: Date.now(),
      }),
    }).catch(() => {});
    r.max = 0;   // 上报后重开窗口，别反复报同一波卡顿
  } catch (e) { /* 忽略 */ }
}
function startNetWatch() {
  if (net.watchTimer) return;
  // RTT 探测：连接活着就每 5 秒 ping 一次
  setInterval(() => {
    const ws = net.ws;
    if (!ws || ws.readyState !== 1) return;
    try { sendWS({ t: 'ping', ts: performance.now() }); } catch { /* 忽略 */ }
    paintRttChip();
  }, 5000);
  // 冻结看门狗：在线牌局 6 秒没快照 → 讨要一次（8 秒节流）
  setInterval(() => {
    const ws = net.ws;
    if (!ws || ws.readyState !== 1 || net.mode !== 'online' || !state.view) return;
    paintRttChip();
    if (state.view.phase !== PHASE.BET && state.view.phase !== PHASE.SETTLED) return;
    if (!net.lastStateAt || Date.now() - net.lastStateAt < 6000) return;
    if (Date.now() - net.lastSyncReq < 8000) return;
    net.lastSyncReq = Date.now();
    try { sendWS({ t: 'sync' }); } catch { /* 忽略 */ }
  }, 3000);
  net.watchTimer = true;
}

/* ── 账户 / 钻石 / 开发者面板 ─────────────────────────────
 * 后端是唯一权威：这里的余额、权限、流水全部来自服务端推送，
 * 前端只负责展示和发起请求，不做任何本地加减。
 */
const ACCT_KEY = 'dh_acct_token';
/** 上次登录成功的账号：只记账号，绝不记密码；换设备 / 清缓存就是空的 */
const LAST_ACCT_KEY = 'dh_last_account';
const acct = {
  user: null,
  token: localStorage.getItem(ACCT_KEY) || '',
  ledger: [],
  adminList: [],
  tab: 'login',
  busy: false,
};
let acctModal = '';   // '' | 'auth' | 'me' | 'admin' | 'grant' | 'dist'

const acctName = (u) => (u && (u.nick || u.account)) || '玩家';
const fmtNum = (n) => Number(n || 0).toLocaleString();

/** 头像地址：线上每个请求都要带分享码，不带就是 403（头像一直不生效的根因） */
function avaSrc(src) {
  const p = String(src || '');
  if (!p) return '';
  /* v0.20.89：App 套壳时页面 origin 是 https://localhost，而头像存在服务器上，
     服务端返回的是站点根路径 /avatar/xxx.jpg —— 直接当相对地址用会去本地找，必然 404。
     带了 __DH_BASE__ 就回源拼成绝对地址；网页端该值为空，行为不变。 */
  const base = window.__DH_BASE__ || '';
  const u = base && p.charAt(0) === '/' && p.charAt(1) !== '/' ? base + p : p;
  const q = window.__SC_Q__ || '';
  if (!q) return u;
  return u + (u.includes('?') ? '&' : '?') + q.slice(1);
}

/** 有上传头像就显示图片，没有就用系统头像（同一个名字同一张脸） */
function avatarHTML(u) {
  if (u && u.avatar) return `<img src="${avaSrc(u.avatar)}" alt="" referrerpolicy="no-referrer" data-ava="1" data-n="${esc(acctName(u))}">`;
  return avatarSvg(acctName(u));
}

/** 战绩表 / 总结算领奖台的头像：在场玩家上传过就显示图片，否则系统脸。
 *  已离场的人座位快照是空的，取不到头像字段，自然退回系统脸。 */
function statsAvaHTML(name, avatar) {
  return avatar
    ? `<img src="${avaSrc(avatar)}" alt="" referrerpolicy="no-referrer" data-ava="1" data-n="${esc(name)}">`
    : avatarSvg(name);
}

function renderAcct(pulse) {
  const u = acct.user;
  const ava = $('acctAva');
  if (ava) {
    ava.innerHTML = u
      ? `${avatarHTML(u)}<em class="ava-chg">换</em>`
      : '<i>?</i>';
  }
  const nick = $('acctNick');
  if (nick) nick.textContent = u ? acctName(u) : '未登录';
  const rn = $('acctRename');
  if (rn) rn.classList.toggle('hidden', !u);
  // v0.20.28：你的房间入口只在登录后出现
  const mine = $('btnGoMine');
  if (mine) mine.classList.toggle('hidden', !u);
  const sub = $('acctSub');
  if (sub) sub.textContent = u ? `ID ${u.id}` : '';
  const gem = $('acctGem');
  if (gem) {
    gem.innerHTML = '<span class="dm"></span> ' + fmtNum(u ? u.diamonds : 0);
    if (pulse) { gem.classList.remove('pulse'); void gem.offsetWidth; gem.classList.add('pulse'); }
  }
  // 登录后把昵称同步给大厅输入框，进房直接用自己的名字
  if (u && u.nick) {
    localStorage.setItem('dh_nick', u.nick);
    if (typeof syncNick === 'function') syncNick(u.nick);
    if (typeof paintMyNick === 'function') paintMyNick();
  }
  // v0.20.52：钻石/登录态变化后，左上角常驻的 ID 与余额也要跟着刷
  paintHud();
  // v0.20.56：钻石/登录态同样决定常驻加时键是否置灰，一起刷
  paintExtFab();
}

function openAcctModal(kind) {
  acctModal = kind;
  $('modal').classList.remove('hidden', 'align-left', 'align-right');
  $('modalBox').className = 'modal-box acct-box';
  $('modalBox').style.position = 'relative';
  if (kind === 'auth') paintAuth();
  else if (kind === 'me') { paintMe(); sendWS({ t: 'profile' }); }
  else if (kind === 'admin') { acct.cheatShow = {}; paintAdminPlayers(); sendWS({ t: 'adminPlayers' }); }
  else if (kind === 'dist') paintDistList();
}

function closeAcctModal() {
  acctModal = '';
  closeModal();
}

/* ── 改名 ─────────────────────────────────── */
function openRename() {
  const cur = acct.user ? acctName(acct.user) : String(localStorage.getItem('dh_nick') || net.name || '');
  const free = !!(acct.user && acct.user.freeRename !== false);
  const costTag = acct.user
    ? (free ? '<i class="btn-cost free">首次免费</i>' : `<i class="btn-cost"><span class="dm"></span>${PRICE.rename}</i>`)
    : '';
  const box = $('modalBox');
  box.dataset.kind = 'rename';
  box.className = 'modal-box acct-box';
  box.style.position = 'relative';
  box.innerHTML = `
    <button class="acct-x" id="rnX">×</button>
    <div class="acct-h">改名</div>
    <div class="auth-field"><input class="auth-input" id="rnInput" maxlength="12"
      autocomplete="off" value="${esc(cur)}" placeholder="牌桌上显示的名字"></div>
    <button class="auth-btn" id="rnGo">确定${costTag}</button>`;
  const input = box.querySelector('#rnInput');
  const go = () => {
    const v = (input.value || '').trim().slice(0, 12);
    if (!v) { input.focus(); return; }
    if (acct.user) {
      if (!free && (acct.user.diamonds || 0) < PRICE.rename) {
        toast(`钻石不够，改名 ${PRICE.rename} 钻`);
        return;
      }
      sendWS({ t: 'setNick', nick: v });
    } else {
      net.name = v;
      localStorage.setItem('dh_nick', v);
      syncNick(v);
      paintMyNick();
    }
    closeModal();
    if (acct.user) toast(free ? '首次改名免费，改好了' : `名字改好了（-${PRICE.rename} 钻）`);
  };
  box.querySelector('#rnX').onclick = closeModal;
  box.querySelector('#rnGo').onclick = go;
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  $('modal').classList.remove('align-left', 'align-right', 'hidden');
  setTimeout(() => { input.focus(); input.select(); }, 60);
}

/* ── 安全问题：补设 / 更换（v0.21.3） ───────── */
function openSecQ() {
  if (!acct.user) { openAcctModal('auth'); return; }
  acctModal = 'secq';
  const u = acct.user;
  const cur = u.secQ || '';
  const opts = [
    ['我的出生城市', '我的出生城市'],
    ['我的第一只宠物名字', '我的第一只宠物名字'],
    ['我小学班主任姓什么', '我小学班主任姓什么'],
    ['我最喜欢的一道菜', '我最喜欢的一道菜'],
  ].map(([v, t]) => `<option value="${v}"${v === cur ? ' selected' : ''}>${t}</option>`).join('');
  const box = $('modalBox');
  box.dataset.kind = '';
  box.className = 'modal-box acct-box';
  box.style.position = 'relative';
  box.innerHTML = `
    <button class="acct-x" id="sqX">×</button>
    <div class="acct-h">安全问题</div>
    <p class="acct-note">忘了密码时，答对这个问题就能自己设新密码，不用找人帮忙。</p>
    <div class="auth-field"><label>当前密码</label>
      <input class="auth-input" id="sqPass" type="password" maxlength="64"
        autocomplete="current-password" placeholder="确认是本人操作"></div>
    <div class="auth-field"><label>问题</label>
      <select class="auth-input auth-select" id="sqQ">${opts}</select></div>
    <div class="auth-field" id="sqAWrap"><label>答案</label>
      <input class="auth-input" id="sqA" maxlength="40" autocomplete="off"
        placeholder="自己记得住、别人猜不到的答案"></div>
    <button class="auth-btn" id="sqGo">保存</button>
    <div class="auth-tip" id="sqTip"></div>`;

  const tip = (text, ok = false) => {
    const t = $('sqTip');
    if (!t) return;
    t.textContent = text || '';
    t.classList.toggle('ok', !!ok);
  };
  const syncA = () => {
    const w = $('sqAWrap');
    if (w) w.classList.toggle('hidden', !$('sqQ').value);
  };
  $('sqQ').onchange = syncA;
  syncA();
  const go = () => {
    if (acct.busy) return;
    const oldPass = $('sqPass').value || '';
    const q = $('sqQ').value || '';
    const a = ($('sqA').value || '').trim();
    if (!oldPass) return tip('先填当前密码');
    if (q && !a) return tip('填一下答案');
    acct.busy = true;
    const btn = $('sqGo');
    if (btn) { btn.disabled = true; btn.textContent = '保存中…'; }
    tip('');
    const ok = sendWS({ t: 'setSecQ', oldPass, secQ: q, secA: q ? a : '' });
    if (!ok) {
      acct.busy = false;
      if (btn) { btn.disabled = false; btn.textContent = '保存'; }
      tip('还没连上服务器，稍后再试');
    }
  };
  $('sqX').onclick = closeAcctModal;
  $('sqGo').onclick = go;
  $('sqA').addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  $('modal').classList.remove('align-left', 'align-right', 'hidden');
  setTimeout(() => { const a = $('sqPass'); if (a) a.focus(); }, 60);
}

/* ── 修改密码 ─────────────────────────────── */
function openChangePass() {
  if (!acct.user) { openAcctModal('auth'); return; }
  acctModal = 'pass';
  const box = $('modalBox');
  box.dataset.kind = '';
  box.className = 'modal-box acct-box';
  box.style.position = 'relative';
  box.innerHTML = `
    <button class="acct-x" id="pcX">×</button>
    <div class="acct-h">修改密码</div>
    <div class="auth-field"><label>原密码</label>
      <input class="auth-input" id="pcOld" type="password" maxlength="64"
        autocomplete="current-password" placeholder="现在用的密码"></div>
    <div class="auth-field"><label>新密码</label>
      <input class="auth-input" id="pcNew" type="password" maxlength="64"
        autocomplete="new-password" placeholder="6 位以上，字母、数字、符号均可"></div>
    <div class="auth-field"><label>确认新密码</label>
      <input class="auth-input" id="pcNew2" type="password" maxlength="64"
        autocomplete="new-password" placeholder="再输一次新密码"></div>
    <button class="auth-btn" id="pcGo">确认修改</button>
    <div class="auth-tip" id="pcTip"></div>`;

  const tip = (text, ok = false) => {
    const t = $('pcTip');
    if (!t) return;
    t.textContent = text || '';
    t.classList.toggle('ok', !!ok);
  };
  const go = () => {
    if (acct.busy) return;
    const oldPass = $('pcOld').value || '';
    const np = $('pcNew').value || '';
    const np2 = $('pcNew2').value || '';
    if (!oldPass) return tip('先填原密码');
    if (np.length < 6) return tip('新密码至少 6 位');
    if (np !== np2) return tip('两次新密码不一样');
    if (np === oldPass) return tip('新密码不能和原密码一样');
    acct.busy = true;
    const btn = $('pcGo');
    if (btn) { btn.disabled = true; btn.textContent = '提交中…'; }
    tip('');
    const ok = sendWS({ t: 'changePass', oldPass, pass: np });
    if (!ok) {
      acct.busy = false;
      if (btn) { btn.disabled = false; btn.textContent = '确认修改'; }
      tip('还没连上服务器，稍后再试');
    }
  };
  $('pcX').onclick = closeAcctModal;
  $('pcGo').onclick = go;
  $('pcNew2').addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  $('modal').classList.remove('align-left', 'align-right', 'hidden');
  setTimeout(() => { const a = $('pcOld'); if (a) a.focus(); }, 60);
}

/* ── 登录 / 注册 ─────────────────────────── */
function paintAuth(tab) {
  if (tab) acct.tab = tab;
  const login = acct.tab === 'login';
  const lastAcct = localStorage.getItem(LAST_ACCT_KEY) || (acct.user && acct.user.account) || '';
  $('modalBox').style.position = 'relative';
  $('modalBox').innerHTML = `
    <button class="acct-x" id="afX">×</button>
    <div class="acct-h">${login ? '登录' : '注册'}</div>
    <div class="auth-tabs">
      <button class="auth-tab ${login ? 'on' : ''}" data-tab="login">登录</button>
      <button class="auth-tab ${login ? '' : 'on'}" data-tab="register">注册</button>
    </div>
    <div class="auth-field"><label>账号</label>
      <input class="auth-input" id="afAccount" maxlength="20" autocomplete="off" autocapitalize="off"
        spellcheck="false" inputmode="latin" value="${esc(lastAcct)}" placeholder="字母 / 数字 / _ - . @，3–20 位"></div>
    ${login ? '' : `<div class="auth-field"><label>昵称</label>
      <input class="auth-input" id="afNick" maxlength="12" placeholder="牌桌上显示的名字"></div>`}
    <div class="auth-field"><label>密码</label>
      <input class="auth-input" id="afPass" type="password" maxlength="64" autocomplete="new-password"
        placeholder="6 位以上，字母、数字、符号均可"></div>
    ${login ? '' : `<div class="auth-field"><label>确认密码</label>
      <input class="auth-input" id="afPass2" type="password" maxlength="64" autocomplete="new-password"
        placeholder="再输一次"></div>`}
    <button class="auth-btn" id="afGo">${login ? '登录' : '注册并登录'}</button>

    <div class="auth-tip" id="afTip"></div>`;
  const go = () => submitAuth();
  $('afGo').onclick = go;
  $('afX').onclick = closeAcctModal;
  $('afPass').addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  $('afAccount').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('afPass').focus(); });
  $('modalBox').querySelectorAll('.auth-tab').forEach((b) => {
    b.onclick = () => paintAuth(b.dataset.tab);
  });
  setTimeout(() => { const a = $('afAccount'); if (a) a.focus(); }, 80);
}

function authTip(text, ok = false) {
  const t = $('afTip');
  if (!t) return;
  t.textContent = text || '';
  t.classList.toggle('ok', !!ok);
}

function submitAuth() {
  if (acct.busy) return;
  const account = ($('afAccount').value || '').trim();
  const pass = $('afPass').value || '';
  const nick = acct.tab === 'register' ? ($('afNick').value || '').trim() : '';
  if (!account) return authTip('先填账号');
  // v0.22.46：注册限 11 位；登录仍兼容最长 20 位的老号
  if (acct.tab === 'register') {
    if (!/^[A-Za-z0-9_@.\-]{3,11}$/.test(account)) {
      return authTip('账号 3–11 位，字母、数字、_ - . @ 均可');
    }
  } else if (!/^[A-Za-z0-9_@.\-]{3,20}$/.test(account)) {
    return authTip('账号 3–20 位，字母、数字、_ - . @ 均可');
  }
  if (pass.length < 6) return authTip('密码至少 6 位');
  if (acct.tab === 'register') {
    if (!nick) return authTip('给自己取个昵称');
    if (($('afPass2').value || '') !== pass) return authTip('两次密码不一样');
  }
  acct.busy = true;
  const btn = $('afGo');
  if (btn) { btn.disabled = true; btn.textContent = '请稍候…'; }
  authTip('');
  const ok = sendWS({ t: acct.tab === 'login' ? 'login' : 'register', account, pass, nick });
  if (!ok) { acct.busy = false; if (btn) { btn.disabled = false; btn.textContent = acct.tab === 'login' ? '登录' : '注册并登录'; } authTip('还没连上服务器，稍后再试'); }
}

function authDone() {
  acct.busy = false;
  const btn = $('afGo');
  if (btn) btn.disabled = false;
}

/* ── v0.22.41：房主等级徽章（我的资料页）─────────
 * L0 绿 / L1 铜 / L2 银 / L3 金 / L4 紫 / L5 黑金（图标用美术提供的奖章）；
 * 成长值进度条体现距下一档还差多少；圆圈+? 弹出规则注释。 */
const LV_NEXT = [1000, 3000, 5000, 8000, 12000];   // 各档升级门槛
function ownerLevelBlock(u) {
  const lv = Math.max(0, Math.min(5, Number(u.lv) || 0));
  const growth = Number(u.growth) || 0;
  let pct, hint;
  if (lv >= 5) {
    pct = 100;
    hint = `成长值 ${growth.toLocaleString()} · 每满 1000 送 400 钻`;
  } else {
    const prev = lv === 0 ? 0 : LV_NEXT[lv - 1];
    const next = LV_NEXT[lv];
    pct = Math.max(2, Math.min(100, Math.round(((growth - prev) / (next - prev)) * 100)));
    hint = `距 L${lv + 1} 还差 ${Math.max(0, next - growth).toLocaleString()}`;
  }
  return `<div class="me-lv lv${lv}">
    <div class="me-lv-top">
      <img class="me-lv-ico" src="img/owner-lv${lv}.png" alt="L${lv}房主">
      <span class="me-lv-name">房主</span>
      <button class="me-lv-q" id="meLvQ" type="button" aria-label="等级说明">?</button>
    </div>
    <div class="me-lv-grow"><span>成长值</span>
      <div class="me-lv-bar"><i style="width:${pct}%"></i></div>
    </div>
    <div class="me-lv-hint">${hint}</div>
  </div>`;
}
function openLvNote() {
  const box = $('modalBox');
  if (!box || box.querySelector('.lv-note-pop')) return;
  const pop = document.createElement('div');
  pop.className = 'lv-note-pop';
  pop.innerHTML = `<div class="lv-note-card">
    <button class="acct-x lv-note-x" type="button">×</button>
    <div class="lv-note-title">房主等级说明</div>
    <div class="lv-note-body">自建房内所有玩家<br>
累计消耗1000钻，升为L1，送200钻，L1～L2，每满1000钻送200钻；<br>
累计消耗3000钻，升L2，L2～L3，每满1000送250钻；<br>
累计消耗5000钻，升L3，L3～L4，每满1000送300钻；<br>
累计消耗8000钻，升L4，L4～L5，每满1000送350钻；<br>
累计消耗12000钻，升L5，每满1000送400钻；<br>
计入成长值的钻石消耗范畴<br>
（发发看/加时/搓牌/强制秀牌/结算秀全桌/偷偷看底牌/洗牌/表情）</div>
  </div>`;
  pop.querySelector('.lv-note-x').onclick = () => pop.remove();
  pop.onclick = (e) => { if (e.target === pop) pop.remove(); };
  box.appendChild(pop);
}

/* ── 我的 ─────────────────────────────────── */
function paintMe() {
  const u = acct.user;
  if (!u) { paintAuth(); return; }
  const canSend = u.role === 'owner' || u.canDist;
  $('modalBox').style.position = 'relative';
  $('modalBox').innerHTML = `
    <button class="acct-x" id="meX">×</button>
    <div class="acct-h">我的</div>
    <div class="me-head">
      <div class="me-ava" id="meAva">${avatarHTML(u)}</div>
      <div>
        <div class="acct-name-row">
          <div class="me-name">${acctName(u)}</div>
          <button class="acct-rn" id="meRename" type="button">改名</button>
        </div>
        <div class="me-idline">ID <b id="meId" title="点击复制">${u.id}</b></div>
      </div>
      ${ownerLevelBlock(u)}
    </div>
    <div class="me-gembox"><span>钻石余额</span><b><span class="dm"></span>${fmtNum(u.diamonds)}</b></div>
    ${canSend ? `
      <div class="me-sec">转出钻石</div>
      <div class="me-row">
        <input class="auth-input" id="meTo" inputmode="numeric" maxlength="6" placeholder="对方游戏 ID">
        <input class="auth-input" id="meAmt" inputmode="numeric" maxlength="9" placeholder="数量">
      </div>
      <div style="height:8px"></div>
      <button class="auth-btn" id="meSend">转出</button>` : ''}
    ${u.role === 'owner' ? `<div style="height:10px"></div><button class="me-btn" id="meAdmin" style="width:100%">玩家列表</button>` : ''}
    <div class="me-sec">流水</div>
    <div class="tx-list" id="meTx">${acct.ledger.length ? acct.ledger.map(txRow).join('') : '<div class="adm-empty">还没有记录</div>'}</div>
    <div style="height:12px"></div>
    <button class="me-btn" id="mePass" style="width:100%">修改密码</button>
    <div style="height:10px"></div>
    <button class="me-btn" id="meSecQ" style="width:100%">${u.hasSecQ ? '更换安全问题' : '设置安全问题'}</button>
    <div style="height:10px"></div>
    <button class="me-btn" id="meOut" style="width:100%">退出登录</button>`;

  $('meX').onclick = closeAcctModal;
  $('meAva').onclick = () => openAvaPicker('me');
  $('meRename').onclick = openRename;
  const lvq = $('meLvQ');
  if (lvq) lvq.onclick = openLvNote;
  $('meId').onclick = async () => {
    try { await navigator.clipboard.writeText(u.id); toast('ID 已复制'); } catch { toast(`ID：${u.id}`, 2000); }
  };
  const send = $('meSend');
  if (send) send.onclick = () => {
    const to = ($('meTo').value || '').trim();
    const amount = Number($('meAmt').value || 0);
    if (!/^\d{6}$/.test(to)) return toast('对方游戏 ID 不对');
    if (!Number.isInteger(amount) || amount <= 0) return toast('数量要是正整数');
    if (amount > (acct.user.diamonds || 0)) return toast('钻石不够');
    sendWS({ t: 'transfer', to, amount, note: '' });
  };
  const adm = $('meAdmin');
  if (adm) adm.onclick = () => openAcctModal('admin');
  const mePass = $('mePass');
  if (mePass) mePass.onclick = openChangePass;
  const meSec = $('meSecQ');
  if (meSec) meSec.onclick = openSecQ;
  $('meOut').onclick = () => { sendWS({ t: 'logout', token: acct.token }); closeAcctModal(); };
}

function txRow(t) {
  const d = Number(t.delta || 0);
  const when = new Date(t.ts);
  const hm = `${String(when.getMonth() + 1).padStart(2, '0')}-${String(when.getDate()).padStart(2, '0')} ${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`;
  // 流水里不带任何玩家 ID（赠送者 / 接收者都不显示）
  const why = String(t.reason || '变动')
    .replace(/\b\d{6,}\b/g, '')
    .replace(/开发者/g, '')
    .replace(/^转给$/, '转出')
    .replace(/\s{2,}/g, ' ').trim() || '变动';
  return `<div class="tx-row"><span>${why}<br><em>${hm}</em></span>
    <b class="${d > 0 ? 'up' : 'down'}">${d > 0 ? '+' : ''}${fmtNum(d)}</b></div>`;
}

/* ── v0.22.45：系统头像选择器 ──
 * 系统头像在 /img/avatars/sys-001.webp 起，固定命名规律，共 SYS_AVATAR_COUNT 张。
 * 注册页（必选，存 regAvatar 随注册一起提交）和「我的」换头像（选中即上传）共用一个弹窗；
 * 相册上传仍走 canvas 压缩（256×256 JPEG，压到 60KB 内）。 */
const SYS_AVATAR_COUNT = 342;
const sysAvaSrc = (n) => `img/avatars/sys-${String(n).padStart(3, '0')}.webp`;
let regAvatar = null;        // 注册页选中的头像：{sys:n} 或 {data:dataURL}
let avaPickMode = '';        // 'register' | 'me'
let avaGridPainted = false;  // 342 张懒渲染，画过一次就不再重建 DOM

/* 相册选图 → 压缩 → 回调 dataURL。注册页回调拿到 data 先存着，
   「我的」里则直接发给服务器（行为与老版 pickAvatar 一致）。 */
function albumAvatar(cb) {
  const input = $('avaFile');
  input.value = '';
  input.onchange = () => {
    const f = input.files && input.files[0];
    if (!f) return;
    if (!/^image\//.test(f.type)) return toast('请选图片文件');
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const N = 256;
        const c = document.createElement('canvas');
        c.width = N; c.height = N;
        const g = c.getContext('2d');
        const s = Math.min(img.width, img.height);
        g.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, N, N);
        // 0.82 起步，还大就降到 0.7 / 0.6；60KB 是服务端 400KB 上限的安全余量
        let url = c.toDataURL('image/jpeg', 0.82);
        for (const q of [0.7, 0.6]) {
          if (url.length <= 60000) break;
          url = c.toDataURL('image/jpeg', q);
        }
        if (url.length > 400000) return toast('这张图太大了，换一张试试');
        cb(url);
      };
      img.onerror = () => toast('这张图读不出来，换一张');
      img.src = String(reader.result);
    };
    reader.readAsDataURL(f);
  };
  input.click();
}

function openAvaPicker(mode) {
  if (mode === 'me' && !acct.user) { openAcctModal('auth'); return; }
  avaPickMode = mode;
  $('avaPop').classList.remove('hidden');
  if (!avaGridPainted) {
    const grid = $('avaGrid');
    const frag = document.createDocumentFragment();
    for (let n = 1; n <= SYS_AVATAR_COUNT; n++) {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.n = n;
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.src = sysAvaSrc(n);
      img.alt = '';
      b.appendChild(img);
      frag.appendChild(b);
    }
    grid.appendChild(frag);
    avaGridPainted = true;
  }
  paintAvaGrid();
}

function paintAvaGrid() {
  const cur = avaPickMode === 'register'
    ? (regAvatar && regAvatar.sys)
    : ((acct.user && Number(String((acct.user.avatar || '').match(/sys-(\d+)\.webp/)?.[1])) ) || 0);
  for (const b of $('avaGrid').children) {
    b.classList.toggle('on', Number(b.dataset.n) === cur);
  }
}

function closeAvaPicker() {
  $('avaPop').classList.add('hidden');
}

/* 注册页头像位：问号 ↔ 已选缩略图 */
function paintAvaPick() {
  const btn = $('avaPick');
  if (!btn) return;
  if (regAvatar && regAvatar.sys != null) {
    btn.classList.add('selected');
    btn.innerHTML = `<img src="${sysAvaSrc(regAvatar.sys)}" alt="">`;
  } else if (regAvatar && regAvatar.data) {
    btn.classList.add('selected');
    btn.innerHTML = `<img src="${regAvatar.data}" alt="">`;
  } else {
    btn.classList.remove('selected');
    btn.innerHTML = '<span class="q">?</span><span class="t">头像</span>';
  }
}

function chooseAvatar(av) {
  if (avaPickMode === 'register') {
    regAvatar = av;
    paintAvaPick();
    closeAvaPicker();
  } else {
    if (av.sys != null) {
      if (!sendWS({ t: 'setAvatar', sys: av.sys })) { toast('还没连上服务器'); return; }
      toast('头像已更新', 1200);
    } else {
      if (!sendWS({ t: 'setAvatar', data: av.data })) { toast('还没连上服务器'); return; }
      toast('头像上传中…', 1200);
    }
    closeAvaPicker();
  }
}

/* 弹窗事件：点头像格选系统头像；相册按钮走压缩；取消/× 关闭 */
$('avaGrid').onclick = (e) => {
  const b = e.target.closest('button[data-n]');
  if (!b) return;
  chooseAvatar({ sys: Number(b.dataset.n) });
};
$('avaAlbum').onclick = () => {
  albumAvatar((url) => chooseAvatar({ data: url }));
};
$('avaCancel').onclick = closeAvaPicker;
$('avaPopX').onclick = closeAvaPicker;
$('avaPop').onclick = (e) => { if (e.target === $('avaPop')) closeAvaPicker(); };
/* 注册页头像位点击 */
$('avaPick').onclick = () => { beep(660, 0.04); openAvaPicker('register'); };

/* ── 玩家列表：一行一个人，id / 名字 / 赠钻 / 分发（透视藏在 id 连点 5 下后） ── */
function paintAdminPlayers() {
  const list = acct.adminList || [];
  const show = acct.cheatShow || (acct.cheatShow = {});
  // 外层要判断「看列表的人是不是开发者」（决定底部是否给入口），
  // 和每行里的 owner（该行账号是不是开发者）不是一回事，必须分开命名，
  // 否则内层 const owner 泄漏到外层，模板字符串会抛 owner is not defined。
  const iAmOwner = !!(acct.user && acct.user.role === 'owner');
  $('modalBox').style.position = 'relative';
  $('modalBox').innerHTML = `
    <button class="acct-x" id="admX">×</button>
    <div class="acct-h">玩家列表</div>
    <div class="adm-list">${list.length ? list.map((u) => {
      const rev = !!show[u.id];
      const owner = u.role === 'owner';
      return `<div class="adm-row${rev ? ' rev' : ''}">
        <span class="adm-id2" data-id="${u.id}">${u.id}</span>
        <span class="adm-nick2">${esc(u.nick || u.account)}</span>
        <button data-grant="${u.id}" ${owner ? 'disabled style="opacity:.4"' : ''}>赠钻</button>
        <button class="${u.canDist ? 'on' : ''}" data-dist="${u.id}" data-on="${u.canDist ? 1 : 0}"
          ${owner ? 'disabled style="opacity:.4"' : ''}>分发</button>
        ${rev ? `<button class="${u.canCheat ? 'on' : ''}" data-cheat="${u.id}" data-on="${u.canCheat ? 1 : 0}"
          ${owner ? 'disabled style="opacity:.4"' : ''}>透视</button>` : ''}
      </div>`;
    }).join('') : '<div class="adm-empty">还没有注册玩家</div>'}</div>
    ${iAmOwner ? `<button class="me-btn" id="admDist" style="width:100%;margin-top:8px">已授权分发账号</button>` : ''}
    <button class="me-btn" id="admBack" style="width:100%">返回</button>`;

  $('modalBox').querySelectorAll('.adm-id2').forEach((el) => {
    el.onclick = () => {
      const id = el.dataset.id;
      const now = Date.now();
      const t = acct.tapId === id && now - (acct.tapAt || 0) < 1600 ? (acct.tapN || 0) + 1 : 1;
      acct.tapId = id;
      acct.tapAt = now;
      acct.tapN = t;
      if (t >= 5) {
        acct.tapId = '';
        acct.tapN = 0;
        show[id] = true;
        paintAdminPlayers();
      }
    };
  });
  $('modalBox').querySelectorAll('[data-grant]').forEach((b) => {
    b.onclick = () => openGrant(b.dataset.grant);
  });
  $('modalBox').querySelectorAll('[data-dist]').forEach((b) => {
    b.onclick = () => sendWS({ t: 'adminToggleDist', to: b.dataset.dist, on: b.dataset.on !== '1' });
  });
  $('modalBox').querySelectorAll('[data-cheat]').forEach((b) => {
    b.onclick = () => {
      const id = b.dataset.cheat;
      sendWS({ t: 'adminToggleCheat', to: id, on: b.dataset.on !== '1' });
      // 操作完自动收起这一行的透视开关
      show[id] = false;
      setTimeout(() => { if (acctModal === 'admin') paintAdminPlayers(); }, 0);
    };
  });
  $('admX').onclick = closeAcctModal;
  $('admBack').onclick = () => openAcctModal('me');
  const admDist = $('admDist');
  if (admDist) admDist.onclick = () => openAcctModal('dist');
}

/* ── 已授权分发账号列表：每个账号后面跟「累计转出钻石用量」 ──
 * 数据来自服务端 adminPlayers（publicUser 现已带 distTotal），只列 canDist 账号，
 * 按用量从高到低排。开发者本人（owner）也能分发，一并计入。 */
function paintDistList() {
  const list = (acct.adminList || []).filter((u) => u.canDist);
  list.sort((a, b) => (b.distTotal || 0) - (a.distTotal || 0));
  $('modalBox').innerHTML = `
    <button class="acct-x" id="distX">×</button>
    <div class="acct-h">已授权分发账号</div>
    <div class="acct-sub">累计转出钻石用量（只统计本账号发起的转出）</div>
    <div class="adm-list">${list.length ? list.map((u) => `
      <div class="adm-row dist-row">
        <span class="adm-id2">${u.id}</span>
        <span class="adm-nick2">${esc(u.nick || u.account)}</span>
        <span class="dist-amt"><span class="dm"></span>${fmtNum(u.distTotal || 0)}</span>
      </div>`).join('') : '<div class="adm-empty">还没有已授权的分发账号</div>'}</div>
    <button class="me-btn" id="distBack" style="width:100%">返回</button>`;
  $('distX').onclick = closeAcctModal;
  $('distBack').onclick = () => openAcctModal('admin');
}

function openGrant(id) {
  acctModal = 'grant';
  const u = (acct.adminList || []).find((x) => x.id === id) || { id, nick: '' };
  $('modalBox').style.position = 'relative';
  $('modalBox').innerHTML = `
    <button class="acct-x" id="grX">×</button>
    <div class="acct-h">赠送钻石</div>
    <div class="acct-sub">${u.nick || ''} · ID ${u.id} · <span class="dm"></span>${fmtNum(u.diamonds)}</div>
    <div class="auth-field"><label>数量（负数表示扣回）</label>
      <input class="auth-input" id="grAmt" inputmode="numeric" placeholder="例如 100"></div>
    <div class="auth-field"><label>备注</label>
      <input class="auth-input" id="grNote" maxlength="40" placeholder="开服赠送"></div>
    <button class="auth-btn" id="grGo">确定</button>
    <div style="height:10px"></div>
    <button class="me-btn" id="grBack" style="width:100%">返回列表</button>`;
  $('grX').onclick = closeAcctModal;
  $('grGo').onclick = () => {
    const amount = Number($('grAmt').value || 0);
    if (!Number.isInteger(amount) || amount === 0) return toast('数量要是非零整数');
    sendWS({ t: 'adminGrant', to: id, amount, note: ($('grNote').value || '').trim() });
    toast(amount > 0 ? `已赠 ${amount} 钻` : `已扣回 ${-amount} 钻`);
    openAcctModal('admin');
  };
  $('grBack').onclick = () => openAcctModal('admin');
  setTimeout(() => { const a = $('grAmt'); if (a) a.focus(); }, 80);
}

window.__acct = acct;   // 排查用入口
$('acctMain').onclick = (e) => {
  if (e.target.closest('#acctAva') || e.target.closest('#acctRename')) return;
  beep(660, 0.04);
  openAcctModal(acct.user ? 'me' : 'auth');
};
$('acctAva').onclick = (e) => {
  e.stopPropagation();
  if (acct.user) openAvaPicker('me');
  else openAcctModal('auth');
};
$('acctRename').onclick = (e) => {
  e.stopPropagation();
  if (acct.user) openRename();
};

renderAcct();

function onWS(ev) {
  // v0.20.53：对讲机音频走二进制帧，和 JSON 状态消息完全分开
  if (ev.data instanceof ArrayBuffer) { onVoiceFrame(ev.data); return; }
  if (typeof Blob !== 'undefined' && ev.data instanceof Blob) {
    ev.data.arrayBuffer().then((b) => onVoiceFrame(b)).catch(() => {});
    return;
  }
  let msg;
  try { msg = JSON.parse(ev.data); } catch { return; }

  switch (msg.t) {
    /* v0.22.89：RTT 探测回包 —— 服务端原样回显我们发的时间戳 */
    case 'pong': {
      const t0 = Number(msg.ts);
      if (t0 > 0) {
        const rtt = performance.now() - t0;
        if (rtt >= 0 && rtt < 30000) {
          const r = net.rtt;
          r.last = rtt;
          r.avg = r.n ? (r.avg * 0.7 + rtt * 0.3) : rtt;   // 指数平滑
          r.max = Math.max(r.max, rtt);
          r.n++;
          reportRtt();
        }
      }
      break;
    }

    /* v0.21.3：找回密码 —— 查到了问题就进第二步 */
    case 'secQ':
      gateDone();
      if (msg.ok) {
        gate.reset.step = 'answer';
        gate.reset.account = msg.account || gate.reset.account;
        gate.reset.q = msg.q || '';
        paintGateTab();
        const qb = $('gateQText');
        if (qb) qb.textContent = msg.q || '';
        gateTip('答对问题就能设置新密码', false);
        setTimeout(() => { const a = $('gateSecA'); if (a) a.focus(); }, 80);
      } else {
        gateTip(msg.msg || '这个账号不能自助找回');
      }
      break;
    case 'resetOk':
      gateDone();
      gate.tab = 'login';
      gate.reset = { step: 'acct', account: '', q: '' };
      paintGateTab();
      ['gateNewPass', 'gateNewPass2', 'gateSecA'].forEach((id) => {
        const el = $(id);
        if (el) el.value = '';
      });
      {
        const a = $('gateAccount');
        if (a && msg.account) a.value = msg.account;
        const p = $('gatePass');
        if (p) p.value = '';
      }
      gateTip('密码已重置，用新密码登录', false);
      break;

    case 'auth':
      authDone();
      gateDone();
      if (msg.ok && msg.user) {
        const fromGate = gateVisible();
        acct.user = msg.user;
        if (msg.token) { acct.token = msg.token; localStorage.setItem(ACCT_KEY, msg.token); }
        if (msg.user.account) localStorage.setItem(LAST_ACCT_KEY, msg.user.account);
        renderAcct();
        closeAcctModal();
        if (fromGate) {
          // v0.22.63：注册 / 登录成功不再弹开号赠送相关提示
          onAuthed();
        } else if (net.mode === 'online' && net.roomId && !net.joinedOnce) {
          onAuthed();
        }
        if (!$('adminPanel').classList.contains('hidden')) sendWS({ t: 'adminPlayers' });
      } else {
        acct.token = '';
        localStorage.removeItem(ACCT_KEY);
        if (gateVisible()) {
          gateDone();
          gateTip('账号或密码不对');
        } else {
          authTip('登录已过期，请重新登录');
          showGate('登录已过期，请重新登录');
        }
      }
      break;

    case 'logout':
      acct.user = null;
      acct.token = '';
      localStorage.removeItem(ACCT_KEY);
      renderAcct();
      // 退出后回登录层：牌桌状态一并清掉，重新登录再进大厅
      if (net.mode === 'online' && net.roomId) {
        localStorage.removeItem(tokenKey(net.roomId));
        sendWS({ t: 'leave', force: true });   // 退出登录是账号级操作，绕过"持牌不能退"限制
      }
      backToLobby('home');
      showGate('已退出登录，重新登录后进大厅');
      break;

    case 'passChanged':
      acct.busy = false;
      // 服务端换发了新 token：本机继续用，其他设备上的登录已被踢掉
      if (msg.token) { acct.token = msg.token; localStorage.setItem(ACCT_KEY, msg.token); }
      closeAcctModal();
      toast('密码改好了，其他设备已退出');
      break;

    case 'kicked':
      // 密码在别处改了：本机登录作废，回登录页用新密码进
      acct.user = null;
      acct.token = '';
      localStorage.removeItem(ACCT_KEY);
      renderAcct();
      net.joinedOnce = false;
      backToLobby('home');
      showGate(msg.msg || '密码已修改，请用新密码重新登录');
      break;

    case 'profile':
      acct.user = msg.user;
      acct.ledger = msg.ledger || [];
      renderAcct();
      sendWS({ t: 'myRequests' });   // v0.22.38：登录 / 刷新后同步名下待审申请
      // v0.21.3：刚保存完安全问题，回「我的」并提示
      if (msg.secSaved) {
        acct.busy = false;
        toast('安全问题已保存');
        openAcctModal('me');
        break;
      }
      if (acctModal === 'me') paintMe();
      break;

    case 'avatar':
      if (msg.user) acct.user = msg.user;
      renderAcct();
      if (acctModal === 'me') paintMe();
      toast('头像已更新');
      break;

    case 'diamonds':
      if (acct.user) acct.user.diamonds = msg.balance;
      renderAcct(true);
      if (acctModal === 'me') paintMe();
      break;

    case 'self':
      if (msg.user && acct.user && msg.user.id === acct.user.id) {
        acct.user = msg.user;
        renderAcct();
        if (msg.note === 'cheatOn') toast('隐藏功能已开通', 2400);
        else if (msg.note === 'cheatOff') {
          const el = cheatDeckEl();
          if (el) el.remove();
          cheat.deckKey = '';
          cheat.picked = [];
          toast('隐藏功能已关闭', 2200);
        }
      }
      break;

    case 'peekNext':
      // v0.20.76：购买者本人收到 cards（牌面），其他连接收到 backs:3（只渲染牌背）
      showPeekNext(msg.cards || (msg.deck || []).slice(0, 3), msg.backs || 0);
      break;

    case 'cheatState':
      // 主动关掉后，把桌面上的牌堆一起收走
      if (!msg.on) {
        const el = cheatDeckEl();
        if (el) el.remove();
        cheat.deckKey = '';
        cheat.picked = [];
      }
      break;

    case 'cheatRigOk': {
      // 定完牌就把牌堆收起来，桌面上不留痕迹
      const n = (msg.cards || []).length;
      cheat.closedHand = state.view ? state.view.handNo : 0;
      const el = cheatDeckEl();
      if (el) el.remove();
      cheat.deckKey = '';
      cheat.picked = [];
      toast(n === 2 ? '已定牌：第三、四张按你选的发' : '已定牌：第三张按你选的发', 2400);
      break;
    }

    case 'adminNotice':
      toast(msg.msg || '已处理', 2200);
      break;

    case 'adminPlayers':
      acct.adminList = msg.list || [];
      if (acctModal === 'admin') paintAdminPlayers();
      break;

    case 'wxLogin':
      toast(msg.msg || '微信登录暂不可用');
      break;

    case 'created':
      net.mode = 'online';
      // v0.22.79：换到新房间号——底稿属于上一桌，先清掉再切房号
      // 重连同房 (roomId 相同) 不会清，保留底稿；net.roomId 为空(大厅) 时也清，兜住残留
      if (net.roomId !== msg.roomId) clearStatsState();
      net.roomId = msg.roomId;
      net.fair = msg.fair || null;   // v0.20.97：本桌防串通开关
      net.seat = msg.seat;
      net.token = msg.token;
      net.isOwner = !!msg.isOwner;
      net.watching = !!msg.watching;
      net.joinedOnce = true;
      localStorage.setItem(tokenKey(msg.roomId), msg.token);
      localStorage.setItem('dh_lastRoom', msg.roomId);
      history.replaceState(null, '', localRoomUrl(msg.roomId));
      // v0.20.28：开房后先进围观席，自己挑座位坐下
      toast(msg.watching ? `房间 ${msg.roomId} 开好了：你是房主，点空位挑个座位` : `房间 ${msg.roomId} 开好了`);
      break;

    case 'joined':
      net.mode = 'online';
      // v0.22.79：换到新房间号才清；重连同一房间 (net.roomId 相同) 保留底稿
      // net.roomId 为空(大厅直接加入) 时也清，兜住任何残留底稿
      if (net.roomId !== msg.roomId) clearStatsState();
      net.roomId = msg.roomId;
      net.fair = msg.fair || null;   // v0.20.97：本桌防串通开关
      net.seat = msg.seat;
      net.token = msg.token;
      net.isOwner = !!msg.isOwner;
      net.watching = !!msg.watching;
      net.joinedOnce = true;
      localStorage.setItem(tokenKey(msg.roomId), msg.token);
      localStorage.setItem('dh_lastRoom', msg.roomId);
      // 就地刷新（v0.20.92）时人本来就在座位上，不用再报一次「已回到座位」
      if (!net.resyncing && msg.reconnected && msg.seat >= 0) toast('已回到座位', 1500);
      else if (!net.resyncing && msg.reconnected && msg.watching) toast('回到观战位，点空位就能坐下', 2000);
      // v0.20.96：进房后就地确认一次位置（拒绝授权也不影响坐下，只是不判距离）
      shareGeo();
      break;

    case 'sat':
      net.seat = msg.seat;
      net.watching = false;
      if (msg.pending) toast(`选好 ${msg.seat + 1} 号位，这一手打完入座`, 2400);
      else toast(`坐下了：${msg.seat + 1} 号位`, 1600);
      break;

    case 'seated':
      net.seat = msg.seat;
      net.token = msg.token;
      net.watching = false;
      if (msg.roomId) net.roomId = msg.roomId;
      localStorage.setItem(tokenKey(net.roomId), msg.token);
      if (msg.owner) toast('你坐下了，这桌归你管（房主）', 2400);
      else toast(`入座了：${msg.seat + 1} 号位 · 先带点金币上桌`, 2400);
      break;

    case 'left':
      onMicUp();   // v0.20.53：离房时收掉话筒
      backToLobby();
      break;

    /* 站起围观 / 保位离桌到期 / 被强制离座：座位让出来，人回到围观席 */
    case 'ejected':
      net.seat = -1;
      net.watching = true;
      toast(
        msg.reason === 'forced' ? '房主已将你强制离座，取消前无法落座'
          : msg.reason === 'hold' ? '留座倒计时结束，已离座'
            : '已站起围观，点空位可以重新坐下', 2600);
      break;

    /* v0.20.28：强制离座操作回执 */
    case 'forceSitOk':
      toast(msg.on ? `已标记强制离座：${msg.name || ''}` : `已取消强制离座${msg.name ? `：${msg.name}` : ''}`, 2200);
      break;

    /* v0.20.28：我的房间列表（自己开的、还在进行的桌子） */
    case 'myRooms':
      openMyRooms(msg.list || []);
      break;

    /* ── v0.22.38：全局带入申请（房主名下所有房间） ── */
    case 'myRequests':
      myReqs = { list: msg.list || [], total: msg.total || 0, counts: msg.counts || {} };
      paintReqBadges();
      if ($('modalBox').dataset.kind === 'req') paintRequests(state.view);
      maybeAutoOpenReqs();   // v0.22.60：进房后第一份权威列表到了，按需自动弹审核面板
      break;

    /* 新申请挂起：服务端主动叫房主——更新计数 + 短促铃铛 */
    case 'buyReq':
      sendWS({ t: 'myRequests' });   // 拉服务端权威列表，铃铛在这一下响
      bellDing();
      break;

    /* 赠送钻石成功回执（以前前端无脑提示「已赠」，服务端报错也像成功了） */
    case 'giftOk':
      toast(msg.msg || '赠送成功', 2400);
      break;

    case 'standUpOk':
      toast(msg.after ? '这一手打完再站起来' : '已站起围观', 2200);
      break;

    /* 别人扔过来的表情：在对应座位上播一遍 */
    case 'emote':
      if (msg && msg.emo) {
        playEmote(Number(msg.seat), msg.emo);
        playEmoteSfx(msg.emo);
      }
      break;

    /* v0.20.57：洗牌——服务端确认扣钻后向全桌（含发起者）广播同一条消息，
       各端收到即播同一套 CSS 动画，视觉上同一时刻起播；收牌间隔已在服务端顺延。 */
    case 'shuffleFx':
      if (msg.handNo != null) { washDoneHand = msg.handNo; paintWashFab(); }
      playWashFx();
      break;
    case 'shuffleOk':
      // 扣钻/余额由 diamonds 消息统一回推；这里只给发起者一句轻提示
      toast(`洗牌 −${msg.cost} 钻`, 1500);
      break;
    case 'shuffleFail':
      toast(msg.msg || '这一手不能洗牌', 2200);
      break;

    /* v0.20.53：谁按住了话筒。自己那一份忽略（自己的状态由按钮自己表示），
       别人的座位亮起绿色波纹。音频帧不在这里，走 onVoiceFrame。 */
    case 'voice': {
      const seat = Number(msg.seat);
      if (!state.view || seat === state.view.viewerSeat) break;
      if (msg.on) voiceSpeakers.add(seat);
      else voiceSpeakers.delete(seat);
      applyVoiceSpeakers();
      break;
    }

    /* v0.20.54：服务端 10 秒硬闸到点。客户端计时器若被后台节流、
       或有人改了前端代码，这里兜底强制断开，并清掉按住态。 */
    case 'voiceTimeout': {
      voiceTimedOut = true;
      cancelVoiceCountdown();
      voiceHold = false;
      voiceSeq++;
      stopVoice();
      notifyVoiceTimeout();
      break;
    }

    /* 搓牌扣费回执：整场已付（charged=0 表示之前付过，pending 表示等开局后再扣） */
    case 'scratchPaid':
      if (msg.charged > 0) toast(`搓牌已开：整场 -${msg.charged} 钻`, 2000);
      break;
    case 'scratchDenied':
      // 服务端扣费失败：把开关拨回去，别让玩家以为开了
      setScratchSwitch(false);
      toast(msg.msg || '钻石不够，搓牌没开成', 2400);
      break;

    case 'extendFail':
      toast(msg.why === 'max' ? '本场加时次数已用完（4 次）'
        : msg.why === 'notTurn' ? '轮到你行动时才能加时'
        : '钻石不够，加时没加成', 2200);
      break;

    case 'revealAllOk':
      toast(`全桌底牌已亮出（-${msg.cost} 钻）`, 2200);
      break;

    case 'peekOk':
      logPeeked.add(`${msg.handNo}:${msg.seat}`);
      toast(`已偷看底牌（-${msg.cost} 钻）`, 2000);
      if (!$('modal').classList.contains('hidden') && $('modalBox').dataset.kind === 'log') paintLogPage();
      break;

    case 'forceShowOk':
      toast(`已秀牌：四张亮给全桌（本手 -${msg.cost} 钻）`, 2200);
      // 回顾面板开着的话马上重绘：按钮立刻置灰，别等翻页才刷新
      if (!$('modal').classList.contains('hidden') && $('modalBox').dataset.kind === 'log') paintLogPage();
      break;

    case 'showLogHandOk':
      // v0.20.75：回顾秀牌回包——只记这一手，翻页不串；本手底牌不受影响
      logShownHands.add(msg.handNo);
      toast(`第 ${msg.handNo} 手底牌已秀出（-${msg.cost} 钻）`, 2200);
      if (!$('modal').classList.contains('hidden') && $('modalBox').dataset.kind === 'log') paintLogPage();
      break;

    case 'nickFree':
      toast('首次改名免费', 1800);
      break;

    case 'holdLeaveOk':
      toast(
        msg.cancel ? '已取消保位'
          : msg.after ? '这一手结算后开始留座倒计时'
            : '保位离桌：留座 180 秒，倒计时结束自动离座',
        2600,
      );
      break;

    /* ── 开发者 ─────────────────────────── */
    case 'adminOk':
      localStorage.setItem(ADMIN_LS, adminKey());
      adminRooms = msg.rooms || [];
      showAdminPanel();
      toast('开发者账号已登录');
      break;

    case 'adminDenied':
      localStorage.removeItem(ADMIN_LS);
      toast(msg.msg || '口令不对');
      askAdminKey();
      break;

    case 'adminRooms':
      adminRooms = msg.list || [];
      paintAdmin();
      break;

    case 'adminScene':
      // 已经进了上帝视角，画布由随后的 state 推送接管
      net.god = true;
      net.mode = 'online';
      net.roomId = msg.roomId;
      net.seat = -1;
      net.watching = true;
      break;

    case 'adminLeft':
      net.god = false;
      net.mode = 'lobby';
      net.roomId = '';
      state.view = null;
      $('godBar').classList.add('hidden');
      renderLobbyHome();
      adminRooms = msg.rooms || [];
      showAdminPanel();
      break;

    case 'adminOut':
      hideAdminPanel();
      toast('已退出开发者账号');
      break;

    case 'state': {
      if (net.mode !== 'online') return;
      net.lastStateAt = Date.now();   // v0.22.89：冻结看门狗的信号源
      const prev = state.view;
      state.view = msg.data;
      perfOnState(msg.data);   // B测量：回包里视图变了 → 记 tRecv
      optOnState(msg.data);    // v0.22.78：我的动作已被权威反映 → 撤乐观气泡
      // v0.20.92：收到新快照 = 「刷新」真的拉到了数据，收掉兜底计时并给个反馈
      net.syncMark++;
      if (net.resyncing) {
        net.resyncing = false;
        net.syncRetry = 0;
        clearTimeout(net.syncTimer);
        toast('已刷新', 1000);
      }
      // v0.20.25：有人加时 → 全桌提示（读条已被服务端拉长，这里只补一句说明）
      const nv = msg.data;
      if (nv && nv.turnExtMs != null) {
        const grew = state.prevExtMs != null && nv.turnExtMs > state.prevExtMs;
        let who = null;
        if (grew) {
          const pu = state.prevExtUses || {};
          for (const k of Object.keys(nv.extUses || {})) {
            if ((pu[k] || 0) < nv.extUses[k]) { who = Number(k); break; }
          }
        }
        state.prevExtMs = nv.turnExtMs;
        state.prevExtUses = nv.extUses || {};
        if (grew) {
          const s = who != null && nv.seats ? nv.seats.find((x) => x.seat === who) : null;
          const isMe = who != null && who === mySeat();
          toast(isMe ? '已加时 30 秒，慢慢想' : `${s ? s.name : '有玩家'} 加时 30 秒，全桌等TA`, 2400);
        }
      }
      if (prev && prev.phase === PHASE.SETTLED && msg.data.phase !== PHASE.SETTLED) {
        // 正在看回顾 / 战绩就别关，等你自己点 ×
        // v0.22.88：结算页（ended）同理——收摊后的战绩清单不许被阶段切换关掉
        if (!['log', 'stats', 'ended'].includes($('modalBox').dataset.kind)) closeModal();
        state.seen.clear();
      }
      // v0.21.2：一帧内可能连收几条快照（行动回包、结算、余额），
      // 合并成一次渲染，避免在低端机上反复重建整桌 DOM 造成卡顿
      renderSoon();
      maybeAutoOpenReqs();   // v0.22.60：快照先到也能触发（回包比快照慢的情况）
      break;
    }

    case 'logs':
      // 整局记录拉到了：直接开回顾面板
      openLogPanel(msg.hands || []);
      break;

    case 'closed':
      // 整场结束 / 开发者解散：收掉弹窗回大厅
      clearInterval(state.endTimer);
      state.endTimer = null;
      closeModal();
      if (net.mode === 'online') {
        toast(msg.reason === 'owner' ? '本桌已关闭，回大厅再开一桌' : '本桌时间到，已关闭', 2600);
        backToLobby();
      }
      break;

    case 'buyinResult': {
      const running = state.view && (state.view.phase === PHASE.BET || state.view.phase === PHASE.SPLIT);
      if (msg.ok) toast(`房主同意了 ${msg.amount.toLocaleString()}${running ? '，本手结束后到账' : '，已到账'}`, 2600);
      else toast(`房主拒绝了这笔 ${msg.amount.toLocaleString()} 的带入`, 2600);
      break;
    }

    case 'buyinAsk': {
      const running = state.view && (state.view.phase === PHASE.BET || state.view.phase === PHASE.SPLIT);
      const amt = msg.amount.toLocaleString();
      if (msg.auto) {
        toast(msg.owner
          ? `带入 ${amt}，房主免审直接到账${running ? '（本手结束后进簸簸）' : ''}`
          : `带入 ${amt} 已到账${running ? '（本手结束后进簸簸）' : ''}`, 2400);
      } else {
        toast(`已申请 ${amt}，等房主同意`, 2400);
      }
      break;
    }

    case 'error':
      // 登录闸门上的失败：就地提示，别把人甩走
      if (gateVisible()) {
        gateDone();
        gateTip(msg.msg || '操作失败');
        break;
      }
      // 登录/注册失败：停在弹窗里提示，别把玩家甩回大厅
      if (acctModal === 'auth') {
        authDone();
        authTip(msg.msg || '操作失败');
        break;
      }
      // 改密码失败：留在弹窗里，原密码错、新密码不合规都在这里提示
      if (acctModal === 'pass') {
        acct.busy = false;
        const pb = $('pcGo');
        if (pb) { pb.disabled = false; pb.textContent = '确认修改'; }
        const pt = $('pcTip');
        if (pt) pt.textContent = msg.msg || '操作失败';
        break;
      }
      if (msg.code === 'NO_ROOM') {
        // 房号填错：保留玩家刚敲进去的四位数字，方便只改一位，不用整串重输
        const kept = codeDigits();
        localStorage.removeItem(tokenKey(net.roomId));
        backToLobby('join');
        if (kept) {
          // showJoinSheet 里有一次 60ms 后聚焦第一格，等它跑完再回填，免得光标被抢走
          setTimeout(() => {
            codeCells().forEach((el, i) => { el.value = kept[i] || ''; });
            paintCodeCells();
            focusCode(Math.min(3, kept.length));
          }, 90);
        }
        lobbyTip(msg.msg, true);
      } else if (net.mode === 'online' && state.view) {
        toast(msg.msg);
      } else {
        lobbyTip(msg.msg, true);
      }
      break;

    default:
      break;
  }
}

/* ── 启动 ─────────────────────────────────── */
function startLocal() {
  // ?seats=4 可以在单机里看 4 人桌版式（默认 8 人）
  const seatN = Number(PARAMS.get('seats')) === 4 ? 4 : 8;
  state.game = new Game({
    players: [
      { id: 'me', name: '你', stack: 2000, isAI: false },
      ...AI_POOL.slice(0, seatN - 1).map((n, i) => ({ id: 'a' + i, name: n, stack: 2000, isAI: true })),
    ],
    ante: Number(PARAMS.get('ante')) || 10,
    cap: Number(PARAMS.get('cap')) || 2000,
    banker: 2,
  });
  state.game.startHand();
  if (PARAMS.has('joker')) {
    // 调试：固定手牌，方便看大王牌面
    state.game.seats[0].hand = [
      DECK.find((c) => c.id === 'BJ'),
      DECK.find((c) => c.id === 'H3'),
      DECK.find((c) => c.id === 'HQ'),
      DECK.find((c) => c.id === 'S8'),
    ];
  }
  refresh();
  drive();

  // 左上角菜单
  const menuBtn = $('btnMenu');
  if (menuBtn) menuBtn.onclick = (e) => { e.stopPropagation(); toggleMenu(); };

  if (PARAMS.has('demoLog')) {
    // 调试：等有对局记录后自动打开回顾
    const t = setInterval(() => {
      if ((state.view && state.view.logs || []).length) { clearInterval(t); showLog(); }
    }, 500);
  }
}

/* ── 登录闸门：进大厅之前先登录 ───────────────
 * 页面一打开就是这一层，登录成功才切到大厅（开设房间 / 加入房间）。
 * 带 ?room= 的邀请链接也一样：先登录，登录后自动进房。
 */
/* v0.21.3：tab 三态 —— 登录 / 注册 / 找回密码（reset） */
const gate = { tab: 'login', busy: false, reset: { step: 'acct', account: '', q: '' } };

function gateVisible() {
  const g = $('gate');
  return !!g && !g.classList.contains('hidden');
}

function gateTip(text, bad = true) {
  const t = $('gateTip');
  if (!t) return;
  t.textContent = text || '';
  t.classList.toggle('ok', !bad);
}

function paintGateTab() {
  const login = gate.tab === 'login';
  const reg = gate.tab === 'register';
  const reset = gate.tab === 'reset';
  const fin = reset && gate.reset.step === 'answer';
  // 账号框三种模式都在；昵称 / 确认密码 / 安全问题只在注册页
  const nw = $('gateNickWrap');
  if (nw) nw.classList.toggle('hidden', !reg);
  const passWrap = $('gatePass') && $('gatePass').parentElement;
  if (passWrap) passWrap.classList.toggle('hidden', reset);
  const p2w = $('gatePass2Wrap');
  if (p2w) p2w.classList.toggle('hidden', !reg);
  const secQW = $('gateSecQWrap');
  if (secQW) secQW.classList.toggle('hidden', !reg);
  // 答案框两处用：注册页选了问题才露出；找回页进第二步才露出
  const aWrap = $('gateSecAWrap');
  if (aWrap) {
    aWrap.classList.toggle('hidden', reset ? !fin : !(reg && $('gateSecQ').value));
  }
  // 找回密码：第二步才出问题 / 新密码
  const qb = $('gateQBox');
  if (qb) qb.classList.toggle('hidden', !fin);
  const npW = $('gateNewPassWrap');
  if (npW) npW.classList.toggle('hidden', !fin);
  const np2W = $('gateNewPass2Wrap');
  if (np2W) np2W.classList.toggle('hidden', !fin);
  // v0.22.46：注册页账号限 11 位（登录/找回不限，老号可能有更长的）
  const accInput = $('gateAccount');
  if (accInput) {
    accInput.maxLength = reg ? 11 : 20;
    accInput.placeholder = reg ? '字母 / 数字 / _ - . @，3–11 位' : '字母 / 数字 / _ - . @，3–20 位';
  }
  const btn = $('gateSubmit');
  if (btn) {
    let label = login ? '登录' : '注册';
    if (reset) label = gate.reset.step === 'acct' ? '下一步' : '重置密码';
    btn.textContent = gate.busy ? '请稍候…' : label;
    btn.disabled = !!gate.busy;
  }
  const sw = $('gateSwitch');
  if (sw) {
    sw.innerHTML = login ? '还没有账号？<b>注册</b>' : (reg ? '已有账号？<b>登录</b>' : '<b>返回登录</b>');
    sw.classList.toggle('busy', !!gate.busy);
  }
  const fg = $('gateForgot');
  if (fg) fg.classList.toggle('hidden', !login);
  // v0.21.1：注册页才显示开号赠送提示，登录页不占地方
  const promo = $('gatePromo');
  if (promo) promo.classList.toggle('hidden', !reg);
  const p = $('gatePass');
  if (p) p.setAttribute('autocomplete', 'new-password');
}

function showGate(tip) {
  const g = $('gate');
  if (!g) return;
  g.classList.remove('hidden');
  hideLobby();
  // 回到登录页签：退出登录后不要停在注册页 / 找回页，密码也不留
  gate.tab = 'login';
  gate.busy = false;
  gate.reset = { step: 'acct', account: '', q: '' };
  gateWaitEnd();
  const p = $('gatePass');
  if (p) { p.value = ''; }   // 密码框永远不预填（不设 readonly：WebView 会据此不弹键盘）
  const p2 = $('gatePass2');
  if (p2) p2.value = '';
  ['gateSecA', 'gateNewPass', 'gateNewPass2'].forEach((id) => {
    const el = $(id);
    if (el) el.value = '';
  });
  // 登录过的账号自动带上；没登录过就是空的
  const a = $('gateAccount');
  if (a) {
    const last = localStorage.getItem(LAST_ACCT_KEY) || (acct.user && acct.user.account) || '';
    if (last) a.value = last;
  }
  paintGateTab();
  if (tip) gateTip(tip);
  setTimeout(() => {
    if (a && !a.value) a.focus();
  }, 140);
}

function hideGate() {
  const g = $('gate');
  if (g) g.classList.add('hidden');
  gateWaitEnd();
  gate.busy = false;
  paintGateTab();
  gateTip('');
  regAvatar = null;      // 注册完成/离开登录页，清掉待注册的头像选择
  paintAvaPick();
}

/* 登录请求的兜底计时：WS 假连接（readyState 还是 1、实际早已断）时
   过去会一直停在「登录中…」，用户看到的也是「点了没反应」。8 秒没回包就重连。 */
let gateTimer = 0;
function gateWaitEnd() {
  if (gateTimer) { clearTimeout(gateTimer); gateTimer = 0; }
}
function gateWaitBegin() {
  gateWaitEnd();
  gateTimer = setTimeout(() => {
    gateTimer = 0;
    if (!gate.busy) return;
    gate.busy = false;
    paintGateTab();
    gateTip('服务器没有响应，正在重连，请再点一次');
    try { if (net.ws) net.ws.close(); } catch { /* 忽略 */ }
    try { connect(); } catch { /* 忽略 */ }
  }, 8000);
}

function submitGate() {
  if (gate.busy) return;
  const account = ($('gateAccount').value || '').trim();
  const pass = $('gatePass').value || '';
  const nick = gate.tab === 'register' ? ($('gateNick').value || '').trim() : '';
  if (!account) return gateTip('先填账号');

  /* v0.21.3：找回密码 —— 第一步查问题，第二步凭答案设新密码 */
  if (gate.tab === 'reset') {
    if (!/^[A-Za-z0-9_@.\-]{3,20}$/.test(account)) {
      return gateTip('账号 3–20 位，字母、数字、_ - . @ 均可');
    }
    if (gate.reset.step === 'acct') {
      gate.reset.account = account;
      gate.busy = true;
      paintGateTab();
      gateTip('查询中…', false);
      const ok = sendWS({ t: 'secQ', account });
      if (!ok) {
        gate.busy = false; paintGateTab();
        gateTip('还没连上服务器，正在重连，请再点一次');
        try { connect(); } catch { /* 忽略 */ }
        return;
      }
      gateWaitBegin();
      return;
    }
    const ans = ($('gateSecA').value || '').trim();
    const np = $('gateNewPass').value || '';
    if (!ans) return gateTip('填一下答案');
    if (np.length < 6) return gateTip('新密码至少 6 位');
    if (($('gateNewPass2').value || '') !== np) return gateTip('两次新密码不一样');
    gate.busy = true;
    paintGateTab();
    gateTip('重置中…', false);
    const ok = sendWS({ t: 'resetBySec', account: gate.reset.account || account, answer: ans, pass: np });
    if (!ok) {
      gate.busy = false; paintGateTab();
      gateTip('还没连上服务器，正在重连，请再点一次');
      try { connect(); } catch { /* 忽略 */ }
      return;
    }
    gateWaitBegin();
    return;
  }

  // v0.22.46：注册限 11 位；登录/找回仍 3–20（老账号可能有更长的）
  if (gate.tab === 'register') {
    if (!/^[A-Za-z0-9_@.\-]{3,11}$/.test(account)) {
      return gateTip('账号 3–11 位，字母、数字、_ - . @ 均可');
    }
  } else if (!/^[A-Za-z0-9_@.\-]{3,20}$/.test(account)) {
    return gateTip('账号 3–20 位，字母、数字、_ - . @ 均可');
  }
  if (pass.length < 6) return gateTip('密码至少 6 位');
  if (gate.tab === 'register') {
    if (!$('gateNick').value.trim()) return gateTip('给自己取个昵称');
    if (!regAvatar) return gateTip('选一个头像（点头像位挑选）');
    if (($('gatePass2').value || '') !== pass) return gateTip('两次密码不一样');
    const q = $('gateSecQ').value || '';
    if (!q) return gateTip('选一个安全问题，忘记密码时要用');
    if (!($('gateSecA').value || '').trim()) return gateTip('填一下安全问题的答案');
  }
  gate.busy = true;
  paintGateTab();
  gateTip(gate.tab === 'login' ? '正在登录…' : '正在注册…', false);
  const ok = sendWS({
    t: gate.tab === 'login' ? 'login' : 'register',
    account,
    pass,
    nick,
    secQ: gate.tab === 'register' ? ($('gateSecQ').value || '') : undefined,
    secA: gate.tab === 'register' ? ($('gateSecA').value || '').trim() : undefined,
    avatar: gate.tab === 'register' ? regAvatar : undefined,
  });
  if (!ok) {
    gate.busy = false;
    paintGateTab();
    gateTip('还没连上服务器，正在重连，请再点一次');
    try { connect(); } catch { /* 忽略 */ }
    return;
  }
  gateWaitBegin();
}

function gateDone() {
  gateWaitEnd();
  gate.busy = false;
  paintGateTab();
}

/** 登录成功后的去处：有房号就进房，没有就回大厅 */
function onAuthed() {
  hideGate();
  const room = net.roomId || new URLSearchParams(location.search).get('room') || '';
  if (room) {
    net.mode = 'online';
    net.roomId = room;
    if (!net.joinedOnce) {
      hideLobby();
      renderWaiting('正在进入房间…');
      net.token = localStorage.getItem(tokenKey(room)) || '';
      sendWS({ t: 'join', room, name: currentNick(), token: net.token });
    }
  } else {
    net.mode = 'lobby';
    renderLobbyHome();
  }
}

function bindGate() {
  // 主按钮提交；下面一行小字切换登录 / 注册（找回页只回登录）
  const sw = $('gateSwitch');
  if (sw) {
    sw.onclick = () => {
      if (gate.busy) return;
      gate.tab = gate.tab === 'login' ? 'register' : 'login';
      gate.reset = { step: 'acct', account: '', q: '' };
      gateTip('');
      const p2 = $('gatePass2');
      if (p2) p2.value = '';
      ['gateSecA', 'gateNewPass', 'gateNewPass2'].forEach((id) => {
        const el = $(id);
        if (el) el.value = '';
      });
      paintGateTab();
      const a = gate.tab === 'register' ? $('gateNick') : $('gateAccount');
      if (a) a.focus();
    };
  }
  // 登录页「忘记密码？」→ 找回流程
  const fg = $('gateForgot');
  if (fg) {
    fg.onclick = () => {
      if (gate.busy) return;
      gate.tab = 'reset';
      gate.reset = { step: 'acct', account: ($('gateAccount').value || '').trim(), q: '' };
      gateTip('先填账号，点「下一步」');
      paintGateTab();
      const a = $('gateAccount');
      if (a) a.focus();
    };
  }
  // 选了安全问题才露出答案框
  const sq = $('gateSecQ');
  if (sq) sq.onchange = () => paintGateTab();
  const gp = $('gatePass');
  // 兜底：若密码框被动处于只读（外部脚本/密码管理器设置过），
  // 触摸时同步解锁并重新聚焦——只读期间抢到的焦点不会唤起键盘，必须再 focus 一次
  const unlockPass = () => {
    if (!gp || !gp.readOnly) return;
    gp.readOnly = false;
    gp.blur();
    requestAnimationFrame(() => gp.focus());
  };
  ['touchstart', 'pointerdown', 'focus'].forEach((ev) => {
    gp.addEventListener(ev, unlockPass, { passive: true });
  });
  $('gatePass').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submitGate(); } });
  $('gateAccount').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('gatePass').focus(); } });

  /* 键盘弹出后卡片被压到视口外，登录按钮经常正好落在键盘下面：
     第一下点击只是收键盘，看起来就是「点了没反应」。
     聚焦输入框时把按钮滚进可视区，让用户一眼能点中。 */
  const keepBtnVisible = () => {
    const btn = $('gateSubmit');
    if (!btn) return;
    /* 键盘动画约 300ms，滚早了会被随后的视口变化顶回去，
       所以在动画全程补几次，最后以键盘稳定后的那次为准 */
    [120, 320, 620].forEach((ms) => {
      setTimeout(() => {
        if (!gateVisible()) return;
        try { btn.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
        catch { btn.scrollIntoView(); }
      }, ms);
    });
  };
  ['gateAccount', 'gatePass', 'gateNick', 'gatePass2', 'gateSecA', 'gateNewPass', 'gateNewPass2'].forEach((id) => {
    const el = $(id);
    if (el) el.addEventListener('focus', keepBtnVisible, { passive: true });
  });
  const enterSubmit = (id) => {
    const el = $(id);
    if (el) el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submitGate(); } });
  };
  ['gateSecA', 'gateNewPass', 'gateNewPass2'].forEach(enterSubmit);

  const gateSubmit = $('gateSubmit');
  if (gateSubmit) {
    /* 不等 click：键盘收起会触发一次布局重排，Android WebView 常把这次 click 丢掉。
       用 pointerup + 位移阈值判定，既拿到最早的可信时机，又不会把「滑动页面」误当成点击。 */
    let lastFire = 0;
    let down = null;
    const fire = () => {
      const now = Date.now();
      if (now - lastFire < 350) return;
      lastFire = now;
      submitGate();
    };
    gateSubmit.addEventListener('pointerdown', (e) => {
      down = { x: e.clientX, y: e.clientY, t: Date.now() };
    }, { passive: true });
    gateSubmit.addEventListener('pointerup', (e) => {
      if (!down) return;
      const dx = Math.abs(e.clientX - down.x);
      const dy = Math.abs(e.clientY - down.y);
      const quick = Date.now() - down.t < 900;
      down = null;
      if (dx < 14 && dy < 14 && quick) fire();
    }, { passive: true });
    gateSubmit.addEventListener('pointercancel', () => { down = null; }, { passive: true });
    gateSubmit.addEventListener('click', fire);
  }
  const gateWx = $('gateWx');
  if (gateWx) gateWx.onclick = () => gateTip('微信登录还在接入中，先用账号密码登录');
}

function boot() {
  /* 尽早收掉加载转圈：app.js 一进来就执行，不等 3 秒兜底；配合 index.html 里 #dh-boot 的
     pointer-events:none，登录页从首帧起就可点（首屏计算若抛错也不影响遮罩让位） */
  if (window.__dhReady) try { window.__dhReady(); } catch (e) {}
  bindGate();
  /* 头像图加载失败（服务器没这张图 / 网络断 / 被清理）时退回系统脸，
     否则座位上会留一个空白圆框，看起来像「上传了但没显示」。 */
  document.addEventListener('error', (e) => {
    const img = e.target;
    if (!img || img.tagName !== 'IMG' || !img.dataset || img.dataset.ava !== '1') return;
    const box = img.parentNode;
    const n = img.dataset.n || '';
    // v0.22.64：网络抖动 / 缓存里的坏响应别立刻永久降级成系统脸，
    // 换个查询串重试一次；仍然失败才退回按名字生成的 Q 版默认脸。
    const src = img.getAttribute('src') || '';
    if (!img.dataset.avaRetry && src && src.slice(0, 5) !== 'data:') {
      img.dataset.avaRetry = '1';
      img.src = src + (src.includes('?') ? '&' : '?') + '_r=' + Date.now();
      return;
    }
    img.remove();
    if (box) box.insertAdjacentHTML('afterbegin', avatarSvg(n));
  }, true);
  /* 键盘真正顶出来之后视口才会变，这一步再把按钮拉回可视区：
     否则用户看到的登录按钮被键盘压住，点到的其实是键盘。 */
  window.addEventListener('resize', () => {
    if (document.documentElement.dataset.kb !== '1') return;
    if (!gateVisible()) return;
    const btn = $('gateSubmit');
    if (!btn) return;
    try { btn.scrollIntoView({ block: 'center' }); } catch { btn.scrollIntoView(); }
  }, { passive: true });
  // 兜底：个别浏览器无视只读硬填密码，这里监听到填充动画就清掉
  document.addEventListener('animationstart', (e) => {
    if (e.animationName !== 'dhAutofillDetect') return;
    const el = e.target;
    if (!el || el.type !== 'password') return;
    el.value = '';
  }, true);
  net.name = NICK || localStorage.getItem('dh_nick') || '';
  if (net.mode === 'local') {
    hideGate();
    hideLobby();
    startLocal();
    return;
  }

  // 第一道门：没有账号就先停在登录层
  if (acct.user) hideGate(); else showGate();

  if (net.mode === 'online') {
    net.token = localStorage.getItem(tokenKey(net.roomId)) || '';
    hideLobby();
    renderWaiting('正在进入房间…');
  }
  connect();
  startNetWatch();   // v0.22.89：RTT 探测 + 冻结看门狗（弱网补发）
}

// 调试钩子：控制台可直接打开回顾 / 战绩
window.__dh = {
  showLog, showStats, paintStats, nextHand, refresh, DECK, openBringIn, paintTime,
  resync: resyncRoom,   // v0.20.92：牌桌右上角「刷新」的实体（就地重同步，不刷页面）
  send: sendWS,   // 调试：直接在控制台发一条房间消息
  openPlayerCard, // 调试：直接弹某个座位的玩家卡（传 seats 里的对象）
  openLogPanel, gotoLog, statsRowsHTML, buildStats, endedSheetHTML,
  peek: showPeekNext,   // 调试：手动摆三张后续牌（验证留存行为）
  handCount: () => logHands.length,
  // v0.20.63：洗牌——动画为 sp030 的 02→01→02→01→03 网格精灵图（见 playWashFx / img/wash_shuffle.webp）
  playWashFx, stopWashFx,
  wash: () => ({ frames: WASH_FRAMES,
                 playing: !!($('washStage') && $('washStage').classList.contains('on')),
                 seq: washSeq, fxMs: WASH_FX_MS }),
  // 调试：对讲机收发计数 / 按住状态 / 谁在说话 / 10 秒倒计时（不暴露音频内容）
  voice: () => ({ ...voiceStat, talking: voiceTalking, hold: voiceHold,
                  speakers: [...voiceSpeakers], rate: voiceCtx && voiceCtx.sampleRate,
                  limitMs: VOICE_MAX_MS, remaining: voiceRemaining(),
                  counting: !!voiceTimer, timedOut: voiceTimedOut,
                  timerOn: !!($('micTimer') && $('micTimer').classList.contains('on')) }),
  get view() { return state.view; },
  get state() { return state; },   // 调试用：可直接改本地 UI 状态
  get acct() { return acct; },     // 调试用：读登录态与钻石余额
  get game() { return state.game; },
  get lastSettled() { return state.lastSettled; },
};

/* ── 屏幕适配：固定 750×1624 画布，等比缩放、四周黑边填充 ─────────
 * 1. 只取 min(宽比, 高比)，绝不拉伸：宁可留黑边，也不把牌桌压扁拉长
 * 2. 舞台尺寸永远是 750×1624 设计稿，UI 全部按设计稿坐标锚定
 * 3. 刘海 / home 条：读取 env() 安全区，换算成「实际侵入画布多深」，
 *    写进 --safe-*，顶栏、底部按钮、手牌按这套变量锚边内缩
 * 4. 尺寸变化（横竖屏、地址栏收起、分屏）走 rAF 合并重算，不抖
 */
const DESIGN_W = 750;
const DESIGN_H = 1624;

function cssPx(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

function fit() {
  // 只用 innerHeight：visualViewport 会被软键盘吃掉一半，用它会让整个牌桌在打字时缩成一条。
  // 但 iOS Safari 的 innerHeight 可能报「工具栏收起」的大视口，而 #app(fixed inset:0) 按
  // 「工具栏展开」的小视口布局：不一致时舞台会超出容器、顶部被顶出屏（v0.22.10 iOS 网页版修复）。
  // documentElement.clientWidth/Height 与 #app 完全同源、永远一致；与 inner* 取小者兜底。
  const _de = document.documentElement;
  const vw = Math.min(window.innerWidth, _de.clientWidth) || window.innerWidth;
  const vh = Math.min(window.innerHeight, _de.clientHeight) || window.innerHeight;

  // Android WebView（打包 APK 后的主要形态）走 adjustResize，键盘弹出会真的改 innerHeight，
  // 光靠上面这行挡不住。键盘态直接跳过重排，保持进场时的画布几何，收起后第一次 resize 再算。
  if (window.__dhIsKeyboard && window.__dhIsKeyboard(vh)) return;

  // 等比：取两边比例里更小的那个，保证整张牌桌完整落在屏幕内
  const s = Math.min(vw / DESIGN_W, vh / DESIGN_H) || 1;
  state.scale = s;

  stage.style.width = `${DESIGN_W}px`;
  stage.style.height = `${DESIGN_H}px`;
  stage.style.transform = `translate(-50%, -50%) scale(${s})`;

  // 黑边：画布居中后四周各留多少
  const w = DESIGN_W * s;
  const h = DESIGN_H * s;
  const left = (vw - w) / 2;
  const top = (vh - h) / 2;

  // 安全区（屏幕像素）减去对应黑边，才是真正压到画布里的深度
  const cs = getComputedStyle(document.documentElement);
  let st = cssPx(cs.getPropertyValue('--sat'));
  const sb = cssPx(cs.getPropertyValue('--sab'));
  /* iOS 26「添加到主屏幕」(standalone) 存在系统级 bug（WebKit #313800/#323403 一族）：
     视口缩水之外，env(safe-area-inset-top) 可能恒报 0，顶部 HUD/菜单/回顾按钮就会
     顶进状态栏、被系统图标压住点不到（v0.22.18 兜底）。识别「iOS + PWA + inset为0」
     后给经验兜底值：现代灵动岛机型状态栏约 59pt，普通刘海机型 47~50pt，取 59 只会
     稍微多留一点空隙，不会遮挡。Safari 标签页与安卓不受影响。 */
  /* v0.22.21：状态栏模式已改为 black（内容从状态栏下开始、底部满屏），
     env(top)=0 是正确语义，不再需要 translucent 模式的 59pt 兜底。 */
  const sl = cssPx(cs.getPropertyValue('--sal'));
  const sr = cssPx(cs.getPropertyValue('--sar'));

  // 浮点误差会让 0 变成 1e-13，统一收敛到 0.01 精度
  const q = (n) => {
    const v = Math.max(0, Math.round(n * 100) / 100);
    return v < 0.05 ? 0 : v;
  };
  const root = document.documentElement.style;
  root.setProperty('--safe-t', `${q((st - top) / s)}px`);
  root.setProperty('--safe-b', `${q((sb - (vh - h - top)) / s)}px`);
  root.setProperty('--safe-l', `${q((sl - left) / s)}px`);
  root.setProperty('--safe-r', `${q((sr - (vw - w - left)) / s)}px`);
  // 同一组安全区，换成屏幕像素：登录页 / 大厅 / 弹窗这些 fixed 全屏层不参与舞台缩放
  root.setProperty('--safe-t-screen', `${q(st - top)}px`);
  root.setProperty('--safe-b-screen', `${q(sb - (vh - h - top))}px`);
  root.setProperty('--safe-l-screen', `${q(sl - left)}px`);
  root.setProperty('--safe-r-screen', `${q(sr - (vw - w - left))}px`);

  // 画布外的空白交给桌布背景溢出填满，视觉上没有黑边
  root.setProperty('--bleed-x', `${q((vw - w) / 2 / s)}px`);
  root.setProperty('--bleed-y', `${q((vh - h) / 2 / s)}px`);

  // 弹窗贴边、面板高度用这组值跟着画布走
  // 全屏弹窗（领奖台 / 战绩）不跟舞台缩放，单独按屏宽压一档
  root.setProperty('--ui', String(Math.min(1, vw / 750)));

  // v0.22.88：大视口（平板 / 模拟器 720×1280、1080×1920 这类 dpr=1 的屏）上，
  // 登录页和大厅卡片是固定 360/398px，会缩成屏幕中间一小条（玩家说「不能满屏」）。
  // 按视口等比放大：宽按 420 起放大、高按 920 封顶（保证最高的房间设置卡片放大后仍放得下），
  // 手机（≤420 逻辑宽）系数恒为 1，行为不变。
  root.setProperty('--ui-big', String(q(Math.max(1, Math.min(vw / 420, vh / 920)))));

  root.setProperty('--stage-top', `${q(top)}px`);
  root.setProperty('--stage-left', `${q(left)}px`);
  root.setProperty('--stage-w', `${q(w)}px`);
  root.setProperty('--stage-h', `${q(h)}px`);
  stage.dataset.fit = `${Math.round(w)}x${Math.round(h)}`;
}

/* 连续 resize 合并到一帧里算，避免横竖屏切换时连算十几次 */
let fitRaf = 0;
function scheduleFit() {
  if (fitRaf) return;
  fitRaf = requestAnimationFrame(() => {
    fitRaf = 0;
    fit();
    // 缩放变了，按像素算过的浮层（加注条、底牌贴边）要按新尺寸重排
    if (state.view) render();
  });
}

window.addEventListener('resize', scheduleFit, { passive: true });
window.addEventListener('orientationchange', () => setTimeout(scheduleFit, 120));
if (window.visualViewport) window.visualViewport.addEventListener('resize', scheduleFit, { passive: true });
// iOS Safari 会无视 user-scalable=no，双指捏合要自己拦
document.addEventListener('gesturestart', (e) => e.preventDefault());
// iOS Safari 硬性要求：AudioContext 必须在用户手势内 resume，首次触碰兜底解锁，避免进游戏静音
['pointerdown', 'touchstart'].forEach((ev) => document.addEventListener(ev, () => {
  try { const a = acGet(); if (a && a.state === 'suspended') a.resume(); } catch {}
  try { if (voiceCtx && voiceCtx.state === 'suspended') voiceCtx.resume(); } catch {}
}, { passive: true }));
/* 软键盘弹出时把正在输入的框滚到可视区中间：
   fixed 弹窗本身不滚动，滚的是 .modal-box 这个 overflow:auto 容器 */
document.addEventListener('focusin', (e) => {
  const el = e.target;
  if (!el || !el.matches || !el.matches('input,textarea')) return;
  setTimeout(() => {
    try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch { el.scrollIntoView(); }
  }, 280);
});
document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });

fit();

/* 开发者入口：主界面左上角一块隐形热区，连点 5 次才弹口令
 * 页面上没有任何可见按钮或文字；两次点击间隔超过 1.2 秒就重新计数，避免日常误触 */
let devTaps = 0;
let devTapAt = 0;
const devHot = $('devHot');
if (devHot) {
  devHot.addEventListener('click', (e) => {
    e.stopPropagation();
    const now = Date.now();
    devTaps = now - devTapAt > 1200 ? 1 : devTaps + 1;
    devTapAt = now;
    if (devTaps >= 5) {
      devTaps = 0;
      devTapAt = 0;
      openAdmin();
    }
  });
}
$('adminClose').onclick = hideAdminPanel;
$('adminRefresh').onclick = () => { sendWS({ t: 'adminRooms' }); };
$('adminLogout').onclick = () => { sendWS({ t: 'adminLogout' }); };

$('btnLog').onclick = showLog;
$('btnStats').onclick = showStats;
/* ── 牌桌右上角「刷新」（v0.20.92）────────────────────────────
 * 旧实现是「ping 一下，1.2 秒后画面还没座位数据就 location.reload()」。
 * 但 App 走 Capacitor 本地加载，地址永远是 https://localhost/，没有 room 参数；
 * 整页刷新后 boot() 认不出房间 → 直接落到大厅。玩家看到的就是「点刷新被弹回主页」。
 * 现在改成就地重新同步，全程不出房间：
 *   1. 带原 token 重发 join → 服务端认得 token 就回原座位，并广播全量快照
 *   2. 2.5 秒内没收到新快照 → 再发一次；仍无响应就掐断连接，
 *      交给既有的断线重连（connect 的 onopen 自带 token，会自己 join 回原房）
 *   3. 任何情况下都不整页刷新
 */
function resyncRoom() {
  closeModal();
  if (net.mode === 'local') { refresh(); toast('已刷新', 1200); return; }
  if (net.mode !== 'online' || !net.roomId) { refresh(); return; }

  const mark = net.syncMark;
  toast('正在刷新…', 1600);
  net.resyncing = true;
  net.syncRetry = 0;

  const tryJoin = () => sendWS({
    t: 'join', room: net.roomId, name: currentNick(), token: net.token,
  });
  tryJoin();

  clearTimeout(net.syncTimer);
  net.syncTimer = setTimeout(() => {
    if (net.syncMark !== mark) return;      // 已经拿到新快照，收工（toast 在 state 里发）
    net.resyncing = false;
    if (net.ws && net.ws.readyState === 1 && net.syncRetry === 0) {
      net.syncRetry = 1;                    // 再给一次机会：网络抖动时补发一次
      net.resyncing = true;
      tryJoin();
      net.syncTimer = setTimeout(() => {
        if (net.syncMark !== mark) return;
        kickSocket('连接好像卡住了，正在重连…');
      }, 2500);
      return;
    }
    kickSocket(net.ws && net.ws.readyState === 1
      ? '连接好像卡住了，正在重连…'
      : '连接已断开，正在重连…');
  }, 2500);
}

/** 掐掉当前连接，让既有的断线重连把人和座位带回来（不刷新页面、不回大厅） */
function kickSocket(tip) {
  net.resyncing = false;
  toast(tip, 2400);
  try { if (net.ws) net.ws.close(); } catch { /* 已经关了就算了 */ }
}

$('btnRefresh').onclick = resyncRoom;
$('btnMenu').onclick = (e) => { e.stopPropagation(); toggleMenu(); };
$('roomCopy').onclick = copyRoomNo;

/* v0.20.52：表情包开关（牌桌右下角）。开/关都走这一处；
   点面板以外任意位置收起。只收面板、不拦这次点击本身——
   点「回顾 / 菜单」时面板收起的同时也照常打开，不用点两次。 */
$('btnEmote').onclick = (e) => { e.stopPropagation(); toggleEmoteSheet(); };
document.addEventListener('click', (ev) => {
  if (!emoteSheetOpen()) return;
  const t = ev.target;
  if (t && t.closest && (t.closest('#emoteSheet') || t.closest('#btnEmote'))) return;
  closeEmoteSheet();
}, true);

/* v0.20.53：对讲机——按住说话，松手即停。
   Pointer Events + window 上的 up/cancel/blur 兜底：手指滑出按钮、切后台、
   来电打断都不会让麦克风一直开着。长按不弹系统菜单（CSS touch-action:none）。 */
{
  const mic = $('btnMic');
  mic.addEventListener('contextmenu', (e) => e.preventDefault());
  if (window.PointerEvent) {
    mic.addEventListener('pointerdown', onMicDown);
    window.addEventListener('pointerup', onMicUp);
    window.addEventListener('pointercancel', onMicUp);
  } else {
    mic.addEventListener('touchstart', onMicDown, { passive: false });
    mic.addEventListener('mousedown', onMicDown);
    window.addEventListener('touchend', onMicUp);
    window.addEventListener('touchcancel', onMicUp);
    window.addEventListener('mouseup', onMicUp);
  }
  window.addEventListener('blur', onMicUp);
}

/* 大厅：主界面 → 房间设置 / 加入房间 */
// 第一次来先取个名字：取一次就存在这台设备上，以后自动带出
function needNick() {
  return !String(localStorage.getItem('dh_nick') || '').trim();
}

function askNick(onDone) {
  const box = $('modalBox');
  box.dataset.kind = 'nick';
  box.innerHTML = `<button class="modal-x" id="nickClose">×</button>
    <h2>取个名字</h2>
    <div class="nick-row">
      <input id="nickBox" class="nick-big" maxlength="8" autocomplete="off" placeholder="比如 成都老陈">
      <button id="nickShuffle" class="nick-shuffle">换一个</button>
    </div>
    <div class="nick-actions"><button id="nickOk" class="nick-ok">就用这个名字</button></div>`;
  const input = box.querySelector('#nickBox');
  input.value = localStorage.getItem('dh_nick') || randomNick();
  const pick = () => {
    const v = input.value.trim().slice(0, 8);
    if (!v) { input.focus(); return; }
    net.name = v;
    localStorage.setItem('dh_nick', v);
    syncNick(v);
    paintMyNick();
    closeModal();
    beep(720, 0.06);
    if (onDone) onDone();
  };
  box.querySelector('#nickShuffle').onclick = () => { input.value = randomNick(); input.focus(); };
  box.querySelector('#nickOk').onclick = pick;
  box.querySelector('#nickClose').onclick = () => {
    closeModal();
    if (onDone) onDone();
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') pick(); });
  $('modal').classList.remove('align-left');
  $('modal').classList.remove('hidden');
  setTimeout(() => input.focus(), 60);
}

/** 主界面显示「你现在叫什么」 */
function paintMyNick() {
  const el = $('myNick');
  if (!el) return;
  const v = String(localStorage.getItem('dh_nick') || net.name || '').trim();
  el.textContent = v || '还没取名';
  el.classList.toggle('empty', !v);
}

$('btnGoCreate').onclick = () => {
  beep(660, 0.05);
  if (needNick()) return askNick(() => showCreateSheet());
  showCreateSheet();
};
$('btnGoJoin').onclick = () => {
  beep(660, 0.05);
  if (needNick()) return askNick(() => showJoinSheet());
  showJoinSheet();
};
// v0.20.95：你的房间——登录后才可见，列出自己开的（房主）+ 参与过的（参与）还在进行的桌子
$('btnGoMine').onclick = () => {
  beep(660, 0.05);
  if (!acct.user) { toast('请先登录'); openAcctModal('auth'); return; }
  lobbyTip('正在查你的房间…');
  sendWS({ t: 'myRequests' });   // v0.22.38：顺带刷新名下待审申请计数
  if (!sendWS({ t: 'myRooms' })) lobbyTip('还没有连上服务器，稍等一下再点', true);
};
/* ── v0.22.24 分享弹窗：登录页 + 大厅主页共用一个弹层，文案原文照排 ── */
const sharePop = $('sharePop');
function openShare() { beep(660, 0.05); sharePop.classList.remove('hidden'); }
function closeShare() { sharePop.classList.add('hidden'); }
$('btnShare').onclick = openShare;
$('gateShare').onclick = openShare;
$('shareClose').onclick = closeShare;
sharePop.addEventListener('click', (ev) => { if (ev.target === sharePop) closeShare(); });
const btnRename = $('btnRename');
if (btnRename) {
  btnRename.onclick = () => { beep(600, 0.04); askNick(null); };
}
$('btnBackCreate').onclick = () => { renderLobbyHome(); };
$('btnBackJoin').onclick = () => { renderLobbyHome(); };
$('btnCreate').onclick = doCreate;

document.querySelectorAll('.dur-opt').forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll('.dur-opt').forEach((x) => x.classList.remove('on'));
    b.classList.add('on');
    paintCreateSum();
  };
});

document.querySelectorAll('.stake-opt').forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll('.stake-opt').forEach((x) => x.classList.remove('on'));
    b.classList.add('on');
    const hint = $('stakeHint');
    if (hint) hint.textContent = `最低带入 ${(STAKE_MIN[b.dataset.ante] || 0).toLocaleString()}`;
    paintCreateSum();
    paintFloorHint();   // v0.22.39：底皮变了，「低于 X 强制留座」跟着联动
  };
});

/* v0.22.39：最低可玩簸簸拉条——拖动即时刷新提示，档位记在 localStorage */
{
  const fr = $('floorRange');
  if (fr) {
    fr.addEventListener('input', () => {
      try { localStorage.setItem(FLOOR_KEY, String(pickedFloorIdx())); } catch { /* 忽略 */ }
      paintFloorHint();
    });
    try {
      const saved = Number(localStorage.getItem(FLOOR_KEY));
      if (FLOOR_MULTS[saved]) fr.value = saved;   // 恢复上次档位
    } catch { /* 忽略 */ }
    paintFloorHint();
  }
}

/* v0.20.97：防串通三项开关（默认全关，选择记住上次） */
document.querySelectorAll('.fair-opt').forEach((b) => {
  b.onclick = () => {
    beep(620, 0.04);
    b.classList.toggle('on');
    b.setAttribute('aria-pressed', b.classList.contains('on') ? 'true' : 'false');
    try { localStorage.setItem(FAIR_KEY, JSON.stringify(fairPicked())); } catch { /* 忽略 */ }
    paintFairNote();
  };
});
restoreFair();

/* v0.22.67：地九王开关——记住上次选择，提示为房间级规则 */
$('dijiuOpt').onclick = () => {
  beep(620, 0.04);
  const on = !pickedDijiu();
  paintDijiu(on);
  try { localStorage.setItem(DIJIU_KEY, on ? '1' : '0'); } catch { /* 忽略 */ }
};
restoreDijiu();

$('reqBadge').onclick = () => { sendWS({ t: 'myRequests' }); showRequests(); };
$('btnJoin').onclick = doJoin;

/* 四格房号：输入 / 退格 / 粘贴 / 回车 */
codeCells().forEach((el, i, list) => {
  el.addEventListener('focus', () => { el.select(); });

  el.addEventListener('input', () => {
    // 安卓输入法可能一次塞进好几位，这里只留数字再按位分发
    const digits = (el.value || '').replace(/\D/g, '');
    if (digits.length > 1) {
      el.value = '';
      digits.split('').forEach((d, k) => { if (list[i + k]) list[i + k].value = d; });
      paintCodeCells();
      focusCode(Math.min(list.length - 1, i + digits.length));
      return;
    }
    el.value = digits;
    paintCodeCells();
    if (digits && i < list.length - 1) focusCode(i + 1);
  });

  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { doJoin(); return; }
    if (e.key === 'Backspace' && !el.value && i > 0) {
      e.preventDefault();
      list[i - 1].value = '';
      paintCodeCells();
      focusCode(i - 1);
      return;
    }
    if (e.key === 'ArrowLeft' && i > 0) { e.preventDefault(); focusCode(i - 1); }
    if (e.key === 'ArrowRight' && i < list.length - 1) { e.preventDefault(); focusCode(i + 1); }
  });

  el.addEventListener('paste', (e) => {
    const text = (e.clipboardData || window.clipboardData).getData('text') || '';
    const digits = text.replace(/\D/g, '');
    if (!digits) return;
    e.preventDefault();
    digits.split('').forEach((d, k) => { if (list[k]) list[k].value = d; });
    paintCodeCells();
    focusCode(Math.min(list.length - 1, digits.length));
  });
});
document.querySelectorAll('.nick-input').forEach((el) => {
  el.addEventListener('change', () => currentNick());
});
document.querySelectorAll('.seat-opt').forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll('.seat-opt').forEach((x) => x.classList.remove('on'));
    b.classList.add('on');
    paintCreateSum();
  };
});
$('modal').addEventListener('click', (e) => {
  const kind = $('modalBox').dataset.kind;
  if (e.target.id === 'modal' && (kind === 'rules' || kind === 'log' || kind === 'stats')) closeModal();
});

window.addEventListener('keydown', (e) => {
  const map = { 1: 'follow', 2: 'raise', 3: 'knock', 4: 'pass', 5: 'fold' };
  if (map[e.key]) humanAct(map[e.key]);
  if (e.key === 'Enter' && state.view?.phase === PHASE.SETTLED && net.mode === 'local') nextHand();
});

/* ── 发发看：挂在「剩余时间」下面 ─────────── */
function paintFfk(v) {
  const b = $('ffkBtn');
  if (!b) return;
  // v0.22.59：显隐统一走 actionStackHidden(v)（全场停牌所有人隐藏 / 个人停牌只收起自己），
  // 这里只叠加发发看自身条件：联网登录、非上帝视角、本人在座。
  // 只有「本手结算」这一段才亮：看的是下一手要发的三张牌。
  const mine = (v.seats || []).find((s) => s.seat === v.viewerSeat) || null;
  const on = !actionStackHidden(v)
    && net.mode === 'online' && !!acct.user && !v.god && !!mine;
  b.classList.toggle('act-off', !on);
  if (b.dataset.busy === '1') return;
  // 价格写在文字右侧；扣费在服务端，这里只做展示和「余额明显不够」的前置拦截
  b.innerHTML = `发发看<em class="ffk-cost"><span class="dm"></span>${PRICE.next}</em>`;
  b.disabled = !on;
}

/* ── 隐藏功能：原位透视 + 定牌 ─────────────────────────
 * 授权玩家每手自动开启（同上帝视角）：别人底牌原位翻开，牌桌中央浮出
 * 半透明牌堆，可在 R1 选一或两张作为自己的第三、四张。
 * 连点「宽」3 下 = 立刻关闭；连点「窄」6 下 = 重新打开。
 */
const cheat = { taps: 0, timer: 0, offTaps: 0, offTimer: 0, picked: [], deckKey: '', closedHand: 0 };

function cheatDeckEl() {
  return $('cdLayer');
}

/** 隐藏功能的使用资格：开发者本人，或被开发者授权（canCheat）的账号 */
const canCheat = () => !!acct.user && (acct.user.role === 'owner' || !!acct.user.canCheat);

function cheatOn() {
  if (!sendWS({ t: 'cheatOn' })) return toast('还没连上服务器');
  cheat.closedHand = 0;
}

function cheatOff(quiet) {
  sendWS({ t: 'cheatOff' });
  const el = cheatDeckEl();
  if (el) el.remove();
  cheat.deckKey = '';
  cheat.picked = [];
}

/** 牌桌中央的半透明牌堆（R1、第三张还没发时可选定牌） */
function renderCheatDeck(v) {
  const m = me();
  const on = !!v && !!v.cheat && !v.god
    && v.phase === PHASE.BET && v.round === 1
    && m && m.seat === v.viewerSeat && (m.cardsView || []).length < 3
    && cheat.closedHand !== v.handNo;
  let el = cheatDeckEl();
  if (!on) {
    if (el) el.remove();
    cheat.deckKey = '';
    cheat.picked = [];
    return;
  }

  const deck = (v.deck || []).filter((c) => c && c.id);
  cheat.picked = cheat.picked.filter((c) => deck.some((d) => d.id === c.id));
  const key = `${v.handNo}|${deck.map((c) => c.id).join('')}`;
  if (!el || cheat.deckKey !== key) {
    if (!el) {
      el = document.createElement('div');
      el.id = 'cdLayer';
      el.className = 'cd-layer';
      const host = document.querySelector('#stage .board') || $('stage');
      host.appendChild(el);
    }
    cheat.deckKey = key;
    el.innerHTML = '<div class="cd-strip" id="cdStrip"></div>'
      + '<div class="cd-foot"><span class="cd-note" id="cdNote">选 1–2 张</span>'
      + '<button class="cd-go" id="cdGo" disabled>发给我</button></div>';
    const strip = el.querySelector('#cdStrip');
    deck.forEach((c) => {
      const cell = document.createElement('button');
      cell.className = 'cd-cell';
      cell.dataset.cid = c.id;
      cell.appendChild(cardEl(c, {}));
      cell.onclick = () => {
        const live = state.view;
        const s2 = me();
        if (!live || live.phase !== PHASE.BET || live.round !== 1 || !s2 || (s2.cardsView || []).length >= 3) {
          return toast('R1 已结束，改不了了');
        }
        const at = cheat.picked.findIndex((x) => x.id === c.id);
        if (at >= 0) cheat.picked.splice(at, 1);
        else if (cheat.picked.length >= 2) return toast('最多选两张');
        else cheat.picked.push(c);
        paintCheatPick();
      };
      strip.appendChild(cell);
    });
    el.querySelector('#cdGo').onclick = () => {
      if (!cheat.picked.length) return;
      sendWS({ t: 'cheatRig', cards: cheat.picked.map((c) => c.id) });
    };
  }
  paintCheatPick();
}

function paintCheatPick() {
  const el = cheatDeckEl();
  if (!el) return;
  el.querySelectorAll('.cd-cell').forEach((cell) => {
    const at = cheat.picked.findIndex((c) => c.id === cell.dataset.cid);
    cell.classList.toggle('picked', at >= 0);
    const old = cell.querySelector('.cd-badge');
    if (old) old.remove();
    if (at >= 0) {
      const b = document.createElement('i');
      b.className = 'cd-badge';
      b.textContent = at === 0 ? '3' : '4';
      cell.appendChild(b);
    }
  });
  const go = el.querySelector('#cdGo');
  if (go) {
    go.disabled = !cheat.picked.length;
    go.textContent = '确定';
  }
  const note = el.querySelector('#cdNote');
  if (note) {
    note.textContent = cheat.picked.length
      ? `已选 ${cheat.picked.map((c) => c.label + c.symbol).join(' / ')}`
      : '选 1–2 张';
  }
}

/* ── 发发看：三张后续牌纵向浮现 ───────────────
 * v0.22.37：动画播完后短暂停留看牌，随后整层淡出自动收回——
 * 不再把三张牌一直停在桌面上等下一手开局（换手时照旧兜底清一次）。 */
let pnHand = null;
let pnTimer = null;
function clearPeekNext() {
  clearTimeout(pnTimer);
  pnTimer = null;
  document.querySelectorAll('.pn-layer').forEach((e) => e.remove());
  pnHand = null;
}
function showPeekNext(cards, backs) {
  const host = document.querySelector('#stage .board') || $('stage');
  document.querySelectorAll('.pn-layer').forEach((e) => e.remove());
  clearTimeout(pnTimer);
  pnTimer = null;
  const layer = document.createElement('div');
  layer.className = 'pn-layer';
  // v0.20.76：发发看只给购买者本人看牌面；其他人看到三张牌背。
  // cardEl(null) 生成 .card.back，跟随本机「桌面设置 → 牌背」素材（经典紫 /
  // 自定义图片 + 「宽窄」水印），切换牌背时随 CSS 变量自动更新。
  const n = backs ? Math.min(3, backs) : (cards || []).slice(0, 3).length;
  for (let i = 0; i < n; i++) {
    const w = document.createElement('div');
    w.className = 'pn-card';
    w.style.animationDelay = `${i * 260}ms`;
    w.appendChild(cardEl(backs ? null : cards[i], {}));
    layer.appendChild(w);
  }
  host.appendChild(layer);
  pnHand = state.view ? state.view.handNo : null;
  // 收回时刻：第三张 520ms 才起播 + 460ms 入场，给买家留约 2.6 秒看牌，
  // 然后整层淡出（.pn-out 0.4s）自动收走，桌面上不留牌。
  pnTimer = setTimeout(() => {
    pnTimer = null;
    fadePeekNext();
  }, 3600);
}
function fadePeekNext() {
  const layers = document.querySelectorAll('.pn-layer');
  if (!layers.length) { pnHand = null; return; }
  layers.forEach((e) => e.classList.add('pn-out'));
  setTimeout(() => {
    document.querySelectorAll('.pn-layer').forEach((e) => e.remove());
  }, 420);
  pnHand = null;
}

/* 发发看：点一次看三张，3 秒内不重复请求 */
$('ffkBtn').onclick = () => {
  if ($('ffkBtn').dataset.busy === '1') return;
  const b = $('ffkBtn');
  if (!acct.user || (acct.user.diamonds || 0) < PRICE.next) {
    return toast(`钻石不够，发发看 ${PRICE.next} 钻一次`);
  }
  if (!sendWS({ t: 'peekNext' })) return toast('还没连上服务器');
  b.dataset.busy = '1';
  b.disabled = true;
  setTimeout(() => { b.dataset.busy = ''; b.disabled = false; }, 3000);
};

/* 桌布暗字：连点「窄」6 下打开透视、「宽」3 下关闭 */
document.addEventListener('click', (ev) => {
  const mark = ev.target.closest && ev.target.closest('.watermark span');
  if (!mark || !state.view) return;
  const txt = mark.textContent.trim();
  if (txt === '窄') {
    cheat.taps += 1;
    clearTimeout(cheat.timer);
    cheat.timer = setTimeout(() => { cheat.taps = 0; }, 1200);
    if (cheat.taps >= 6) {
      cheat.taps = 0;
      if (!acct.user) return toast('先登录', 2000);
      if (!canCheat()) return toast('隐藏功能未开通', 2200);
      cheatOn();
    }
  } else if (txt === '宽') {
    cheat.offTaps += 1;
    clearTimeout(cheat.offTimer);
    cheat.offTimer = setTimeout(() => { cheat.offTaps = 0; }, 1200);
    if (cheat.offTaps >= 3) {
      cheat.offTaps = 0;
      if (!canCheat()) return;
      cheatOff();
    }
  }
}, true);

/* ── 统一点击音：所有按钮、图标键、座位、页签共用一声很轻的「嗒」 ──
 * 放在捕获阶段，按钮自己 stopPropagation 也拦得住；
 * 事件派发是同步的，等这一轮跑完（setTimeout 0）再看有没有人发过声——
 * 跟注、弃牌、休、敲这些动作按钮自己带音效，就不再叠一声。 */
document.addEventListener('click', (ev) => {
  const t = ev.target.closest && ev.target.closest(
    'button, .sheet-back, .modal-x, .log-arrow, .gate-switch, .home-btn, .lobby-btn,'
    + ' .seat, .pod, .sh-chip, .ti-chip, .tab, [role="button"]'
  );
  if (!t || t.disabled) return;
  const at = performance.now();
  setTimeout(() => {
    if (lastSfxAt >= at) return;      // 这一下已经响过了
    beep(770, 0.028, 'sine', 0.018);
  }, 30);
}, true);

boot();

// 排障入口：只在 URL 带 ?debug=1 时挂出来，正常玩家不暴露。
// 用来把某一手的快照塞进页面复现现场（例如「别人已分牌、明牌没亮」）。
if (PARAMS.has('debug')) {
  window.__DH_DEBUG = {
    get view() { return state.view; },
    setView(v) { state.view = Object.assign({}, state.view, v); render(); },
    render() { render(); },
  };
}

// 首屏已经渲染完，撤掉深色遮罩（index.html 里那段内联兜底）
if (window.__dhReady) window.__dhReady();
preloadSfx();
preloadCourtArt();


/**
 * pixel-scene.js — 像素风「学习监督小屋」主界面
 *
 * 图层（DOM 顺序即 z 顺序）：昼夜背景 → 家具 → 角色 → UI
 * 状态机：STUDY / ALERT / PRAISE / REST
 * 拖拽规则：只有 REST 休息态能自由移动猫头鹰；学习三态（STUDY / ALERT / PRAISE）
 *           拎起松手会温和警告，并沿弧线飞回书桌继续学习，不落到别处。
 * 对外三个入口：onPhoneDetected() / onFocusComplete() / onRestStart()
 * 测试服：?test=1 / ?rest=1 / ?walk=1 / ?debug=1 时，右上角显示「休息 / 学习」
 *         一键切换按钮（#pxRestBtn），正式界面不显示，主界面仍只有昼夜按钮。
 *
 * 素材全部是透明底 / 同机位 PNG，缩放统一走 image-rendering: pixelated（最近邻）。
 * v7/v8：睡觉 / 吃饭精灵不带家具，用 FIT_SPOT 贴合到背景已有的床毯与餐椅上。
 * v10：休息态走动改用左右方向专属的「四相位」帧（各 4 帧、约 160ms 一帧循环），运行时不做镜像；
 *      四帧高度不同，显示高按像素比例逐帧换算 + 脚底对齐，起伏自然（见 _setWalkFrame）。
 * v3/v4 规格：书桌状态正面视图、不翻转、不移动、不改大小；
 * 角色锚点固定：x = 0.5w，脚底 y = 0.645h，高 = 0.30h（v2 起从 0.235h 放大）。
 * ALERT 按持续时长四档递进：察觉 → 轻提醒 → 严肃警告 → 最终警告。
 */

import { prepareSprite } from "./sprite-dewhiter.js";
import { initVoice, speakText } from "./voice.js";

const A = "assets/pixel/";
const SPRITE = {
  study: A + "characters/owl_reading.png",
  notice: A + "characters/owl_alert_notice.png",   // 档1 察觉：一翅抬到胸口
  alert: A + "characters/owl_alert.png",           // 档2 轻提醒：双翅叉腰
  lean: A + "characters/owl_alert_lean.png",       // 档3 严肃警告：前倾凝视
  stand: A + "characters/owl_alert_stand.png",     // 档4 最终警告：站起抱胸
  praise: A + "characters/owl_break_mug.png",
  rest: A + "characters/owl_break_mug.png",        // 与看书 / 警告共用同一高度与坐标
  eat: A + "characters/owl_eating_bread.png",      // v4 重制：坐椅啃面包
  book: A + "characters/owl_finding_book.png",     // v4 重制：柜前踮脚够书
  sleep: A + "characters/owl_sleeping.png",        // v4 新增：靠枕盖毯 + Zzz
  flying: A + "characters/owl_flying.png",
  // v6 / v10 休息态自由走动
  idle: A + "characters/owl_idle.png",             // 站立张望（走动间隙）
  walkL1: A + "characters/owl_walk_left_1.png",    // 向左走 相位1：前脚触地、重心略低
  walkL2: A + "characters/owl_walk_left_2.png",    // 向左走 相位2：双腿交错、身体最低
  walkL3: A + "characters/owl_walk_left_3.png",    // 向左走 相位3：双脚并拢、重心最高
  walkL4: A + "characters/owl_walk_left_4.png",    // 向左走 相位4：换脚触地
  walkR1: A + "characters/owl_walk_right_1.png",   // 向右走 相位1：前脚触地、重心略低
  walkR2: A + "characters/owl_walk_right_2.png",   // 向右走 相位2：双腿交错、身体最低
  walkR3: A + "characters/owl_walk_right_3.png",   // 向右走 相位3：双脚并拢、重心最高
  walkR4: A + "characters/owl_walk_right_4.png",   // 向右走 相位4：换脚触地
  sleepy: A + "characters/owl_sleepy_walk.png",    // 揉眼拖毯子，慢慢走向床
};

/** v10：左右各一组「四相位」方向专属帧（1→2→3→4 循环），运行时不做水平镜像。
 *  四相位是同一缩放下画的：并拢帧最高、交错帧最矮，高度差就是走路的重心起伏，
 *  所以**不把四帧拉成同高**，而是按像素比例绘制（见下面的 WALK_REF_H / WALK.bobMax）。 */
const WALK_FRAMES = {
  L: [SPRITE.walkL1, SPRITE.walkL2, SPRITE.walkL3, SPRITE.walkL4],
  R: [SPRITE.walkR1, SPRITE.walkR2, SPRITE.walkR3, SPRITE.walkR4],
};

/** 走路族（含 idle 站立帧）的像素缩放基准：以 owl_idle.png 的自然高为 1 个单位。
 *  idle 本身就按 0.30h 显示，所以「显示高 = 0.30h × 自然高 / 基准」能让待机 ↔ 走动
 *  之间不跳大小；四相位之间的高度差就自然表现为身体起伏。 */
const WALK_REF_H = 1003;

/** 交付包实测自然高，用作图片加载完成前的初值；加载完成后会用 naturalHeight 覆盖 */
const WALK_NAT_H = {
  [SPRITE.walkL1]: 912, [SPRITE.walkL2]: 915, [SPRITE.walkL3]: 936, [SPRITE.walkL4]: 924,
  [SPRITE.walkR1]: 857, [SPRITE.walkR2]: 912, [SPRITE.walkR3]: 925, [SPRITE.walkR4]: 930,
};

/** 走路帧集合：换到集合外的精灵时，一律退回 CSS 的定高 30% */
const WALK_ALL = new Set([...WALK_FRAMES.L, ...WALK_FRAMES.R]);

/** 四档监督里 ALERT 各档对应的正面精灵，索引 = 档位 */
const ALERT_SPRITES = [null, "notice", "alert", "lean", "stand"];

/** 背景里三件矮家具的实际矩形（相对场景宽高）。
 *  无遮挡版背景已经把矮床 / 矮书柜 / 餐桌画好，v4 PNG 默认不显示，
 *  这组坐标只给透明热区（以及 ?furn=1 调试显示）用。 */
const FURN_BOX = {
  bed:       { x0: 0.030, x1: 0.300, y0: 0.510, y1: 0.845 },
  bookshelf: { x0: 0.690, x1: 0.880, y0: 0.470, y1: 0.765 },
  table:     { x0: 0.770, x1: 0.990, y0: 0.555, y1: 0.875 },
};

/* ------------------------------------------------------------------
   v7/v8：休息态精灵改成「无家具版」——睡觉不带床架枕头、吃饭不带椅子，
   必须贴合叠到背景里已经画好的家具上，否则会出现「床摞床 / 椅摞椅」或悬空。
   这里是各动作的角色落点：x = 角色水平中心，y = 角色底边（脚底）相对场景高的比例。
   按交付包 docs 的贴合参数（床 0.55×床宽 / 0.42×床高，餐桌右椅 0.76×家具宽 /
   0.60×家具高）换算到 FURN_BOX，再按 room_clean.png 的实际毯子与椅座位置微调。
   ------------------------------------------------------------------ */
const FIT_SPOT = {
  bed:       { x: 0.190, y: 0.679 },  // 盖被落点；y 越小越靠上（手动指定值）
  table:     { x: 0.905, y: 0.755 },  // 悬空坐姿坐在餐桌右椅椅座顶；左收一点不贴画面边
  bookshelf: { x: 0.785, y: 0.765 },  // 踮脚够书：底边对齐柜体底边
};

/** 拖拽 / 点击命中热区：比可见家具略宽一圈，松手更好命中 */
const SPOTS = {
  bed: { x0: 0.01, x1: 0.32, y0: 0.50, y1: 0.90, label: "床", sprite: "sleep", word: "呼……先睡一小会儿" },
  bookshelf: { x0: 0.66, x1: 0.90, y0: 0.43, y1: 0.81, label: "书柜", sprite: "book", word: "这本好像挺有意思" },
  table: { x0: 0.74, x1: 1.00, y0: 0.52, y1: 0.92, label: "餐桌", sprite: "eat", word: "面包好香，我们先吃一口" },
};

/* ------------------------------------------------------------------
   v6 休息态自由走动参数。坐标一律是「相对场景宽 / 高」的比例；
   速度按 1536×1024 场景的「像素/秒」给定，位移时把 dx·1536 / dy·1024
   折回真实像素再算步长，缩放窗口也不会变快变慢。
   ------------------------------------------------------------------ */
const WALK = {
  speedPx: 115,              // v11：走动更快（原 75，交付包建议 60~90，这里按手感调快）
  sleepyPx: 70,              // 犯困时慢慢挪
  frameMs: 110,              // 四相位各约 110ms；步速快，帧也加快，脚下不打滑
  bobMax: 0.035,             // 走路起伏上限：最低帧最多比最高帧矮 3.5%（0 = 完全同高）
  idleMin: 800, idleMax: 2600,
  boredMs: 30000,            // 闲置约 30 秒犯困
  dropMs: 420,               // 从课桌「下地」的短过渡，避免瞬移
  hopMs: 460,                // 走到家具前 → 坐上去 / 爬上去的小跳过渡
  outingChance: 0.45,        // 每次出发有 45% 是去家具做点事，其余才是乱走
  sleepMin: 20000, sleepMax: 45000,   // 在床上睡多久（到点自己起来接着溜达）
  x0: 0.08, x1: 0.92,        // 地板横向范围：v11 放宽到几乎整条地板，不再只围着书桌
  y0: 0.855, y1: 0.940,      // 前排地板（脚底），地砖约从 0.72h 开始
  minStep: 0.10,             // 两站之间至少走这么远，避免原地碎步
  bed: { x: FIT_SPOT.bed.x, y: FIT_SPOT.bed.y }, // 犯困直接走到床上贴合点，切 sleeping 不跳位
};

/** v11：休息态自主行动 —— 除了乱走，也会自己走去睡觉、吃饭、翻书。
 *  at = 走到家具前站定的地板点（必须 walkable），到点后再小跳到 FIT_SPOT 做动作。 */
const OUTING = {
  bed: {
    at: { x: 0.190, y: 0.905 },
    stay: [20000, 45000],
    line: "有点困了……我去躺一会儿",
    settleLine: "呼……先睡一小会儿",
  },
  table: {
    at: { x: 0.905, y: 0.930 },
    stay: [9000, 15000],
    line: "去餐桌那儿吃口面包",
    settleLine: "面包好香，先吃一口",
  },
  bookshelf: {
    at: { x: 0.780, y: 0.890 },
    stay: [6000, 11000],
    line: "去书柜翻两页闲书",
    settleLine: "这本好像挺有意思",
  },
};

/** 课桌本体（不是热区，角色不能站在桌子里） */
const DESK_BLOCK = { x0: 0.31, x1: 0.70, y0: 0.55, y1: 0.86 };
const WALK_BLOCKS = [DESK_BLOCK, ...Object.values(SPOTS)];

/** 目标点必须避开课桌与床 / 书柜 / 餐桌的交互热区 */
function walkable(x, y) {
  return !WALK_BLOCKS.some((b) => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1);
}
const rand = (a, b) => a + Math.random() * (b - a);

const LABEL = {
  STUDY: "一起学习",
  ALERT: "手机被拿起来啦",
  PRAISE: "这一轮做到啦",
  REST: "休息时间",
};

/** 第 3 档台词池：语气转向严肃、直接下指令，但不骂人、不吼。
 *  第 1/2 档用固定短句；所有档位（包括警告）都由 showLine() 统一配音。 */
const ALERT_LINES = [
  "手机放下。这一章还没看完呢。",
  "别装没看见我，手机放桌上。",
  "我说第几遍了？现在把手机放下。",
];
/** 第 4 档：最后通牒，短句、下沉，不解释 */
const FINAL_LINES = [
  "最后一次：放下手机，不然这一轮白算了。",
  "再拿一次我就不提醒了，直接记你走神。",
  "手机放下。别让我一直盯着你。",
];

/** 轻点猫头鹰时的互动台词 */
const TAP_LINES = [
  "咕咕～我在呢。",
  "别挠我啦，专心一点～",
  "陪你一起，慢慢来。",
  "要一起把这一章看完哦。",
];

/** 学习态想把它拎走时的警告台词：语气硬一点，但仍是「拦一下」而不是训人 */
const STUDY_DRAG_WARN_LINES = [
  "别拽我。现在是学习时间，回书桌前面坐好。",
  "放下我。这一章没看完，哪儿也不去。",
  "又拎我？坐下，看完再说。",
];

let CURRENT = null;

/* ------------------------------------------------------------------
   声音：纯 Web Audio 合成，柔和木质音，绝不用警笛 / 蜂鸣 / 高频突发音
   ------------------------------------------------------------------ */
let ctx = null;
function audio() {
  const C = window.AudioContext || window.webkitAudioContext;
  if (!C) return null;
  if (!ctx) ctx = new C();
  if (ctx.state === "suspended") ctx.resume();
  return ctx;
}

/** 一记木质音：正弦基音 + 弱三角泛音，软起音、快速自然衰减 */
function woodNote(c, freq, at, vol, len) {
  const t = c.currentTime + at;

  const o = c.createOscillator();
  o.type = "sine";
  o.frequency.setValueAtTime(freq, t);
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.018);
  g.gain.exponentialRampToValueAtTime(0.0001, t + len);
  o.connect(g).connect(c.destination);
  o.start(t);
  o.stop(t + len + 0.02);

  const o2 = c.createOscillator();
  o2.type = "triangle";
  o2.frequency.setValueAtTime(freq * 2, t);
  const g2 = c.createGain();
  g2.gain.setValueAtTime(0.0001, t);
  g2.gain.exponentialRampToValueAtTime(vol * 0.22, t + 0.02);
  g2.gain.exponentialRampToValueAtTime(0.0001, t + len * 0.7);
  o2.connect(g2).connect(c.destination);
  o2.start(t);
  o2.stop(t + len + 0.02);
}

/**
 * 四档递进音效（对应 docs/素材与声音提示词包.md §5.1）：
 *   notice 单音木块 0.25s → t1 两音下行木琴 0.6s →
 *   t2 三音木琴 0.9s → t3 稍强三音；音量由调用方逐档渐强。
 * 全部是低频正弦 + 弱三角泛音，无警笛 / 蜂鸣 / 高频突发音。
 */
function playCue(kind, vol) {
  const c = audio();
  if (!c) return;
  try {
    if (kind === "notice") {
      woodNote(c, 587, 0, vol, 0.25);             // 只做「我看到了」的暗示
    } else if (kind === "t1") {
      woodNote(c, 659, 0, vol, 0.34);             // 下行两音 0.6s
      woodNote(c, 523, 0.26, vol * 0.9, 0.34);
    } else if (kind === "t2") {
      woodNote(c, 523, 0, vol, 0.34);             // 三音 0.9s，先扬后落
      woodNote(c, 587, 0.24, vol * 0.95, 0.34);
      woodNote(c, 440, 0.52, vol * 0.9, 0.38);
    } else if (kind === "t3") {
      woodNote(c, 494, 0, vol, 0.38);
      woodNote(c, 440, 0.22, vol, 0.38);
      woodNote(c, 392, 0.46, vol * 0.9, 0.44);
    } else if (kind === "praise") {
      woodNote(c, 523, 0, vol, 0.36);             // 上行三音
      woodNote(c, 659, 0.17, vol, 0.36);
      woodNote(c, 784, 0.34, vol, 0.46);
    }
  } catch (_) { /* 静音也无妨 */ }
}

function speak(text) {
  // 具体用哪个音色、音调多低，都在 js/voice.js 里决定（设置面板可换）
  initVoice();
  speakText(text);
}

/* ------------------------------------------------------------------
   场景
   ------------------------------------------------------------------ */
export class PixelScene {
  constructor(root) {
    this.root = root;
    this.frame = root.querySelector("#pxFrame");
    this.day = root.querySelector("#pxDay");
    this.night = root.querySelector("#pxNight");
    this.owl = root.querySelector("#pxOwl");
    this.muyu = root.querySelector("#pxMuyu");          // 书桌上的小木鱼
    this.muyuCount = root.querySelector("#pxMuyuCount");
    this.badge = root.querySelector("#pxBadge");
    this.tier = root.querySelector("#pxTier");
    this.line = root.querySelector("#pxLine");
    this.dayBtn = root.querySelector("#pxDayBtn");
    this.autoBtn = root.querySelector("#pxAutoBtn");
    this.restBtn = root.querySelector("#pxRestBtn");   // 测试服专用：一键休息 / 学习

    this._srcRaw = null;        // 当前 owl 用的原始精灵路径（去白后的 URL 由缓存管理）
    this._natH = new Map();     // 走路帧原始像素高（src -> px），用于同比例换帧
    this.mode = "STUDY";
    this.spot = null;
    this.dayMode = "day";       // day | night
    this.dayOverride = null;    // 手动切换后不再被自动覆盖
    this.dragging = false;
    this.dragEnabled = true;    // 校准 / 启动中由 app.js 暂时关掉
    this._moved = false;
    this._downXY = null;
    this._flyRaf = 0;           // 学习态误拖后「飞回书桌」的 rAF
    this._flyBack = null;       // 飞回动画状态
    this._alertTier = 0;
    // 角色锚点：x = 0.5w，脚底 y = 0.645h；所有状态共用，换精灵不动坐标
    this.anchor = { x: 0.5, y: 0.645 };
    this._alertTimers = [];
    this._praiseTimer = null;
    this._lineTimer = null;
    this._lineIndex = 0;

    // 休息态自由走动：单个 rAF 循环驱动 drop / idle / walk / sleepy 四个阶段
    this._walk = null;
    this._walkRaf = 0;
    this._walkLastTs = 0;
    this._boredomTimer = null;

    // 木鱼敲击：动画重启 + 计数冒字 + 手动点击节流
    this._muyuTimer = null;
    this._muyuLock = false;

    this._onPointerDown = this._onPointerDown.bind(this);
    this._onPointerMove = this._onPointerMove.bind(this);
    this._onPointerUp = this._onPointerUp.bind(this);
    this._onResize = () => this._place();
  }

  init() {
    CURRENT = this;
    const qs = new URLSearchParams(location.search);
    // 调试：?furn=1 显示家具层；?hud=1 临时恢复完整 HUD（主界面默认只留昼夜按钮）
    if (qs.get("furn") === "1") this.root.classList.add("show-furn");
    if (qs.get("hud") === "1") this.root.classList.add("show-hud");
    // 测试服：这些验收参数下显示「休息 / 学习」一键切换按钮；正式访问不显示
    if (["test", "rest", "walk", "debug"].some((k) => qs.get(k) === "1")) {
      this.root.classList.add("show-test");
    }
    // ?rest=1 直接进休息态、?walk=1 加速走动与犯困，仅供验收，默认行为不变
    if (qs.get("walk") === "1") {
      WALK.boredMs = 3000;
      WALK.idleMin = 350; WALK.idleMax = 700;
      WALK.speedPx = 260; WALK.sleepyPx = 160;
    }
    // 所有精灵统一走「边缘去白」预处理并预热解码：
    // 走动帧交替时既不会用到未去白的原图，也不会因处理未完成而抖一帧。
    Object.values(SPRITE).forEach((src) => prepareSprite(src));
    // 走路帧要知道自己的原始像素高，才能在四相位之间保持同一个缩放系数
    this._trackNatH([...WALK_FRAMES.L, ...WALK_FRAMES.R]);

    // 家具层：三张透明底 PNG 与背景家具同位置，本身即点击 / 拖拽热区
    this.root.querySelectorAll(".px-furn-item").forEach((el) => {
      const s = FURN_BOX[el.dataset.spot];
      el.style.left = s.x0 * 100 + "%";
      el.style.top = s.y0 * 100 + "%";
      el.style.width = (s.x1 - s.x0) * 100 + "%";
      el.style.height = (s.y1 - s.y0) * 100 + "%";
      // 同一块区域再放一个独立的虚线提示框（PNG 本身始终透明，避免家具重影）
      const zone = this.root.querySelector(`.px-zone[data-zone="${el.dataset.spot}"]`);
      if (zone) {
        zone.style.left = el.style.left;
        zone.style.top = el.style.top;
        zone.style.width = el.style.width;
        zone.style.height = el.style.height;
        el.addEventListener("mouseenter", () => zone.classList.add("peek"));
        el.addEventListener("mouseleave", () => zone.classList.remove("peek"));
      }
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        if (this.dragEnabled === false) return;
        // 学习态不能去家具上玩：温和警告并飞回书桌
        if (this.mode !== "REST") { this._warnStudyDrag(); this._flyBackHome(); return; }
        this._enterSpot(el.dataset.spot);
      });
    });

    this.owl.addEventListener("pointerdown", this._onPointerDown);
    // 换精灵后宽度会变，重新按锚点摆一次，保证「切换精灵不移动角色」且落在整数像素上
    this.owl.addEventListener("load", () => this._place());

    // 手动敲木鱼：只是玩一下，不计入走神统计；声音走独立的轻木质音，不改检测逻辑
    this.muyu?.addEventListener("click", (e) => {
      e.stopPropagation();
      if (this._muyuLock) return;
      this._muyuLock = true;
      setTimeout(() => { this._muyuLock = false; }, 220);
      woodNote(audio(), 480, 0, 0.2, 0.22);
      this._knockMuyu(null);
    });
    window.addEventListener("pointermove", this._onPointerMove);
    window.addEventListener("pointerup", this._onPointerUp);
    window.addEventListener("resize", this._onResize);

    this.dayBtn.addEventListener("click", () => {
      clearTimeout(this._autoHintTimer);
      this.dayOverride = this.dayMode === "day" ? "night" : "day";
      this.setDayNight(this.dayOverride);
    });
    // 「自动」按钮在主界面不显示，改用右键昼夜按钮恢复按系统时间自动切换
    this.dayBtn.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      clearTimeout(this._autoHintTimer);
      this.dayOverride = null;
      this.autoDayNight();
      this.dayBtn.textContent = "✓ 已恢复自动";
      this._autoHintTimer = setTimeout(() => {
        this.dayBtn.textContent = this.dayMode === "day" ? "🌙 切到夜晚" : "☀ 切到白天";
      }, 1400);
    });
    this.autoBtn.addEventListener("click", () => {
      this.dayOverride = null;
      this.autoDayNight();
    });

    // 测试服按钮：一键在「休息态自由走动」和「学习态」之间来回切。
    // 只改场景状态机，不碰 app.js 的计时 / 检测逻辑，正式界面此按钮不存在。
    this.restBtn?.addEventListener("click", () => {
      this.setMode(this.mode === "REST" ? "STUDY" : "REST");
    });

    // 点击空白处：学习态回坐姿；休息态重新散起步来
    this.frame.addEventListener("click", (e) => {
      if (e.target.closest(".px-ui, .px-furn-item, .px-owl, .px-muyu")) return;
      if (this.mode === "REST") this._startWalkLoop();
      else this._enterSpot(null);
    });

    this._applyDayNight(false);
    this.autoDayNight();
    this._autoTimer = setInterval(() => this.autoDayNight(), 30000);
    this.setMode("STUDY");
    if (qs.get("rest") === "1") this.setMode("REST");
    return this;
  }

  /* ---------------- 昼夜 ---------------- */
  autoDayNight() {
    if (this.dayOverride) return;
    const h = new Date().getHours();
    this.setDayNight(h >= 7 && h < 18 ? "day" : "night");
  }

  /** 两张背景同坐标叠放，只改 alpha，0.5s 交叉淡化；绝不移动背景 */
  setDayNight(mode) {
    if (mode !== "day" && mode !== "night") return;
    this.dayMode = mode;
    this._applyDayNight(true);
    this.dayBtn.textContent = mode === "day" ? "🌙 切到夜晚" : "☀ 切到白天";
    this.autoBtn.classList.toggle("on", !this.dayOverride);
    this.root.dataset.day = mode;
  }

  _applyDayNight(animate) {
    const t = animate ? "opacity .5s linear" : "none";
    this.day.style.transition = t;
    this.night.style.transition = t;
    this.day.style.opacity = this.dayMode === "day" ? "1" : "0";
    this.night.style.opacity = this.dayMode === "night" ? "1" : "0";
  }

  /* ---------------- 状态机 ---------------- */
  setMode(mode) {
    if (!LABEL[mode]) return;
    this.mode = mode;
    this.root.dataset.mode = mode;
    if (this.restBtn) {
      const resting = mode === "REST";
      this.restBtn.textContent = resting ? "📖 回到学习" : "🛋 进入休息";
      this.restBtn.title = resting
        ? "测试用：结束休息，回到学习态"
        : "测试用：进入休息态，看猫头鹰自由走动";
    }
    this.badge.textContent = LABEL[mode];
    this.tier.textContent = "";
    this.spot = null;

    // 切回学习 / 提醒 / 表扬会立刻打断自由走动与未完成的飞回动画
    if (mode !== "REST") this._stopWalk();
    this._cancelFlyBack();
    this.line.classList.remove("warn");

    if (mode !== "ALERT") this._clearAlertTimers();
    if (mode !== "PRAISE") clearTimeout(this._praiseTimer);
    if (mode !== "ALERT") this._alertTier = 0;

    this._sprite(this._modeSprite());
    this._home();

    if (mode === "PRAISE") {
      playCue("praise", 0.13);
      this.showLine("这一轮我们撑下来啦，休息一下吧", 2800);
      // 表扬展示一会儿再进入可拖动的休息态
      this._praiseTimer = setTimeout(() => {
        if (this.mode === "PRAISE") onRestStart();
      }, 2800);
    }
    if (mode === "REST") {
      this.showLine("休息啦 · 我自己溜达一会儿，随时能把我拖走", 2600);
      this._startRestWalk();   // 从课桌中央下到地板，开始 idle → walk 循环
    }
  }

  /** 当前状态该用的精灵：ALERT 按档位切正视图，坐标与高度始终不变 */
  _modeSprite() {
    if (this.mode === "PRAISE") return "praise";
    if (this.mode === "REST") return "rest";
    if (this.mode === "ALERT") return ALERT_SPRITES[this._alertTier] || "study";
    return "study";
  }

  _sprite(key) {
    this._setSrc(SPRITE[key] || SPRITE.study);
  }

  /** 换图但不重置锚点（拖拽中 / 松手恢复都用它）。
   *  src 一律经过 sprite-dewhiter 的边缘去白缓存；异步就绪后再替换真实地址，
   *  并用 _srcRaw 防止「刚切到别的精灵却被旧回调覆盖」。 */
  _setSrc(src) {
    if (!src) return;
    // 换到非走路帧时，先把「按帧定高」撤掉，回到 CSS 的 30% 定高
    if (!WALK_ALL.has(src)) this._clearWalkHeight();
    if (src === this._srcRaw) return;
    this._srcRaw = src;
    const apply = (url) => {
      if (this._srcRaw !== src) return;                  // 期间已切到别的精灵
      if (this.owl.getAttribute("src") === url) return;  // 已是同一张（含去白版）
      this.owl.setAttribute("src", url);
      requestAnimationFrame(() => this._place());
    };
    apply(prepareSprite(src, apply));
  }

  /** 走路帧专用：先按像素比例定显示高，再换图。
   *  四相位素材本身高度不同（并拢高、交错矮），CSS 里 .px-owl 是定高 30%，
   *  直接换图会让角色忽大忽小；这里按「0.30h × 自然高 / WALK_REF_H」换算，
   *  脚底对齐不变，起伏交给素材自己表达。
   *
   *  起伏上限 WALK.bobMax：交付包里个别帧画得比同组小一圈（右向相位 1 只有 857px），
   *  完全按比例会让它在循环里明显「缩一下」，所以把每一帧最终不低于本方向最高帧的
   *  (1 - bobMax)，既保住起伏又不至于跳大小。设 0 = 全部同高（最平）。 */
  _setWalkFrame(src, dir) {
    const natOf = (s) => this._natH.get(s) || WALK_NAT_H[s] || WALK_REF_H;
    const pctOf = (h) => (30 * h) / WALK_REF_H;
    const top = pctOf(Math.max(...(WALK_FRAMES[dir] || WALK_FRAMES.R).map(natOf)));
    const pct = Math.max(pctOf(natOf(src)), top * (1 - WALK.bobMax));
    this.owl.style.height = pct.toFixed(3) + "%";
    this._setSrc(src);
    this._place();
  }

  /** 离开走路帧：恢复 CSS 的默认定高（站立 / 学习 / 家具动作统一 30%） */
  _clearWalkHeight() {
    if (this.owl.style.height) this.owl.style.height = "";
  }

  /** 记录各走路帧的真实像素高（加载完成后才准，用于替换 WALK_NAT_H 里的实测初值） */
  _trackNatH(srcs) {
    srcs.forEach((src) => {
      if (this._natH.has(src)) return;
      const img = new Image();
      img.onload = () => {
        if (img.naturalHeight) this._natH.set(src, img.naturalHeight);
      };
      img.src = src;
    });
  }

  /** 默认锚点：x=0.5w，脚底 y=0.645h（bottom=35.5%），高=0.30h（CSS） */
  _home() {
    if (this.dragging) return;
    this.anchor = { x: 0.5, y: 0.645 };
    this.owl.classList.remove("flying");
    this._place();
  }

  /** 整数像素定位：不用 transform，避免亚像素采样把像素边缘糊掉 */
  _place() {
    const r = this.frame.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const w = this.owl.offsetWidth || 0;
    this.owl.style.left = Math.round(this.anchor.x * r.width - w / 2) + "px";
    this.owl.style.bottom = Math.round((1 - this.anchor.y) * r.height) + "px";
  }

  /** 给 app.js：切回主界面 / 窗口尺寸变化时重新摆位 */
  place() { this._place(); }

  /** 所有字幕（含各种警告）都从这里显示，也统一在这里配音——只要有字就有声。
   *  圆括号里是动作描写，朗读时只去掉括号符号，内容照念。 */
  showLine(text, ms = 3200) {
    this.line.textContent = text;
    this.line.classList.add("on");
    clearTimeout(this._lineTimer);
    this._lineTimer = setTimeout(() => this.line.classList.remove("on"), ms);
    const spoken = String(text).replace(/[（）]/g, "").trim();
    if (spoken) speak(spoken);
  }

  /** 敲一下书桌上的木鱼：木槌落下 + 鱼身压缩 + 计数上浮。
   *  @param count 提醒次数，传数字则冒「+n」；手动玩一下传 null 只冒「咚」。
   *  动画总是执行（不听话就敲），声音由调用方决定是否播放，检测逻辑不受影响。 */
  knock(count) {
    if (!this.muyu) return;
    // 先移除再强制回流，保证连续敲击时动画能重新播放
    this.muyu.classList.remove("knock");
    void this.muyu.offsetWidth;
    if (this.muyuCount) this.muyuCount.textContent = count == null ? "咚" : "+" + count;
    this.muyu.classList.add("knock");
    clearTimeout(this._muyuTimer);
    this._muyuTimer = setTimeout(() => this.muyu.classList.remove("knock"), 1000);
  }
  _knockMuyu(count) { this.knock(count); }

  /* ---------------- REST 自由走动（v6 / v11） ----------------
     一个 rAF 循环：drop（下桌）→ idle 停一会儿 → 出发（45% 去床 / 餐桌 / 书柜，
     其余随机走位）→ walk 四相位走过去 → settle 小跳到家具上 → spot 做一会儿动作
     → 自己起来接着溜达；闲置 30 秒或点床 → sleepy 慢慢走向床 → 睡一觉再醒。
     拖拽开始 / 切回学习态会立刻 _stopWalk()，精灵与坐标一并复位。        */

  /** 停掉走动循环与犯困计时；换精灵由调用方决定 */
  _stopWalk() {
    cancelAnimationFrame(this._walkRaf);
    this._walkRaf = 0;
    this._walk = null;
    this._walkLastTs = 0;
    clearTimeout(this._boredomTimer);
    this._boredomTimer = null;
  }

  /** 重新计时「闲置约 30 秒」，只在确实还在自由走动时生效 */
  _resetBoredom() {
    clearTimeout(this._boredomTimer);
    this._boredomTimer = null;
    if (this.mode !== "REST" || this.dragging || !this._walk) return;
    // 正走去睡觉 / 已经坐在家具上 / 正在小跳过渡时不算「没事干」
    if (["sleepy", "settle", "spot"].includes(this._walk.phase)) return;
    this._boredomTimer = setTimeout(() => {
      if (this.mode === "REST" && !this.dragging && this._walk) this._startSleepyWalk();
    }, WALK.boredMs);
  }

  _raf(fn) { this._walkRaf = requestAnimationFrame(fn); }

  /** 进入 REST：先从课桌中央下到地板，再开始散步 */
  _startRestWalk() {
    this._stopWalk();
    this._sprite("idle");
    this.anchor = { x: 0.5, y: 0.645 };
    this._walk = { phase: "drop", t: 0, sy: 0.645, ty: (WALK.y0 + WALK.y1) / 2, lastSpot: null };
    this._place();
    this._walkLastTs = 0;
    this._raf((ts) => this._walkLoop(ts));
    this._resetBoredom();
  }

  /** 拖拽松手 / 点击空白后，从当前位置继续散步 */
  _startWalkLoop() {
    if (this.mode !== "REST" || this.dragging) return;
    this._stopWalk();
    this.spot = null;
    this._sprite("idle");
    this._walk = { phase: "idle", wait: rand(WALK.idleMin, WALK.idleMax), lastSpot: null };
    this._walkLastTs = 0;
    this._raf((ts) => this._walkLoop(ts));
    this._resetBoredom();
  }

  /** 地板上的随机目标点（避开课桌与家具热区，且别离原地太近） */
  _pickFloorPoint() {
    for (let i = 0; i < 40; i++) {
      const x = rand(WALK.x0, WALK.x1);
      const y = rand(WALK.y0, WALK.y1);
      if (Math.abs(x - this.anchor.x) < WALK.minStep) continue;
      if (!walkable(x, y)) continue;
      return { x, y };
    }
    return { x: 0.5, y: (WALK.y0 + WALK.y1) / 2 };
  }

  /** 朝某个点出发：spotKey 有值表示「去家具」而不是随便走 */
  _walkTo(x, y, spotKey = null) {
    const s = this._walk;
    if (!s) return;
    s.phase = "walk";
    s.spotKey = spotKey;
    s.tx = x; s.ty = y;
    s.frame = 0; s.frameMs = 0;
    // v10：按目标方向选一组专属四相位帧，左右各自独立绘制，不做镜像
    s.dir = x < this.anchor.x ? "L" : "R";
    this._setWalkFrame(WALK_FRAMES[s.dir][0], s.dir);
  }

  /** idle 结束：决定这一趟去哪 —— 有时候是去睡觉 / 吃饭 / 翻书 */
  _nextMove() {
    const s = this._walk;
    if (!s) return;
    if (Math.random() < WALK.outingChance) {
      const keys = Object.keys(OUTING).filter((k) => k !== s.lastSpot);
      const key = keys[Math.floor(Math.random() * keys.length)];
      s.lastSpot = key;
      const at = OUTING[key].at;
      this._walkTo(at.x, at.y, key);
      return;
    }
    const p = this._pickFloorPoint();
    this._walkTo(p.x, p.y, null);
  }

  /** 走到家具前：小跳到贴合点（FIT_SPOT），站定之后再换成坐下 / 躺下的精灵 */
  _climbInto(key) {
    const s = this._walk;
    const spot = SPOTS[key];
    if (!s || !spot) return;
    const fit = FIT_SPOT[key];
    s.phase = "settle";
    s.spotKey = null;
    s.from = { ...this.anchor };
    s.to = fit ? { ...fit } : { ...this.anchor };
    s.t = 0;
    s.next = "spot";
    s.spot = key;
    s.spriteKey = spot.sprite;
    this.spot = key;
    this._sprite("idle");            // 跳上去的时候还站着，落地才换动作
  }

  /** 在做完事之后自己起来，回到地板继续溜达 */
  _leaveSpot() {
    const s = this._walk;
    if (!s) return;
    const key = this.spot;
    const at = key && OUTING[key] ? OUTING[key].at : null;
    s.phase = "settle";
    s.from = { ...this.anchor };
    s.to = at ? { ...at } : { x: this.anchor.x, y: (WALK.y0 + WALK.y1) / 2 };
    s.t = 0;
    s.next = "idle";
    this.spot = null;
    this._sprite("idle");
    if (this.mode !== "ALERT") this.tier.textContent = "";
    this.showLine(key === "bed" ? "睡够啦，起来活动活动" : "好啦，继续溜达", 2400);
    this._resetBoredom();
  }

  _walkLoop(ts) {
    const s = this._walk;
    if (!s || this.mode !== "REST" || this.dragging) { this._walkRaf = 0; return; }
    // 上限只用来兜住「切到后台再回来」的超长间隔，不能太紧，否则掉帧时步速会被拖慢
    const dt = this._walkLastTs ? Math.min(ts - this._walkLastTs, 120) : 16;
    this._walkLastTs = ts;

    if (s.phase === "drop") {
      s.t += dt;
      const k = Math.min(1, s.t / WALK.dropMs);
      this.anchor.y = s.sy + (s.ty - s.sy) * (1 - (1 - k) * (1 - k));
      this._place();
      if (k >= 1) { s.phase = "idle"; s.wait = rand(WALK.idleMin, WALK.idleMax); }

    } else if (s.phase === "idle") {
      s.wait -= dt;
      if (s.wait <= 0) this._nextMove();

    } else if (s.phase === "walk" || s.phase === "sleepy") {
      const dx = s.tx - this.anchor.x, dy = s.ty - this.anchor.y;
      // 折回 1536×1024 场景的真实像素，速度才是「像素/秒」
      const distPx = Math.hypot(dx * 1536, dy * 1024);
      const stepPx = (s.phase === "sleepy" ? WALK.sleepyPx : WALK.speedPx) * dt / 1000;
      const k = Math.min(1, stepPx / Math.max(distPx, 1));
      this.anchor.x += dx * k;
      this.anchor.y += dy * k;
      this._place();

      if (s.phase === "walk") {
        // 四相位按 1→2→3→4 循环；每帧按同一缩放系数定高、脚底对齐，
        // 于是「并拢高 / 交错矮」会呈现为自然的身体起伏，而不是定高硬拉
        s.frameMs += dt;
        if (s.frameMs >= WALK.frameMs) {
          s.frameMs %= WALK.frameMs;
          s.frame = (s.frame + 1) % WALK_FRAMES[s.dir].length;
          this._setWalkFrame(WALK_FRAMES[s.dir][s.frame], s.dir);
        }
      }

      if (distPx <= stepPx + 1) {
        this.anchor.x = s.tx; this.anchor.y = s.ty;
        this._place();
        if (s.phase === "sleepy") {
          this._sleepOnBed();               // 循环继续跑，睡一觉到点会自己起来
        } else if (s.spotKey) {
          this._climbInto(s.spotKey);
        } else {
          s.phase = "idle";
          s.wait = rand(WALK.idleMin, WALK.idleMax);
          this._sprite("idle");
          this._resetBoredom();
        }
      }

    } else if (s.phase === "settle") {
      // 走上家具 / 从家具上下来：短促的小跳，带一点弧度，不是瞬移
      s.t += dt;
      const k = Math.min(1, s.t / WALK.hopMs);
      const e = 1 - (1 - k) * (1 - k);
      this.anchor.x = s.from.x + (s.to.x - s.from.x) * e;
      this.anchor.y = s.from.y + (s.to.y - s.from.y) * e + Math.sin(Math.PI * k) * 0.014;
      this._place();
      if (k >= 1) {
        this.anchor = { ...s.to };
        this._place();
        if (s.next === "spot" && s.spot) {
          const spot = SPOTS[s.spot];
          if (s.spriteKey) this._sprite(s.spriteKey);
          this.showLine(OUTING[s.spot]?.settleLine || spot.word, 3000);
          if (this.mode !== "ALERT") this.tier.textContent = "在" + spot.label + "这儿";
          s.phase = "spot";
          s.wait = rand(...(OUTING[s.spot]?.stay || [8000, 14000]));
        } else {
          s.phase = "idle";
          s.wait = rand(WALK.idleMin, WALK.idleMax);
        }
      }

    } else if (s.phase === "spot") {
      s.wait -= dt;
      if (s.wait <= 0) this._leaveSpot();
    }
    this._raf((t) => this._walkLoop(t));
  }

  /** 犯困：揉眼拖毯子，慢慢走到床边 */
  _startSleepyWalk() {
    if (this.mode !== "REST" || this.dragging) return;
    this._stopWalk();
    this._sprite("sleepy");
    this.showLine("揉揉眼睛……我去床边眯一会儿", 3200);
    this._walk = { phase: "sleepy", tx: WALK.bed.x, ty: WALK.bed.y, lastSpot: "bed" };
    this._walkLastTs = 0;
    this._raf((ts) => this._walkLoop(ts));
  }

  /** 到床了：切换睡觉精灵；循环继续跑，睡够了自己起来（不再一觉到永远） */
  _sleepOnBed() {
    this.spot = "bed";
    this.anchor = { x: WALK.bed.x, y: WALK.bed.y };
    this._sprite("sleep");
    this._place();
    this.showLine("呼……先睡一小会儿", 3000);
    if (this.mode !== "ALERT") this.tier.textContent = "在床这儿";
    const s = this._walk;
    if (s) {
      s.phase = "spot";
      s.spot = "bed";
      s.wait = rand(WALK.sleepMin, WALK.sleepMax);
    }
  }

  /* ---------------- ALERT 四档递进（v3/v4） ---------------- */
  onPhoneDetected() {
    this._clearAlertTimers();
    if (this.mode === "REST") clearTimeout(this._praiseTimer);
    this._alertTier = 0;
    this.setMode("ALERT");
    this.showLine("（看见你了，先给一次机会）", 1400);

    // 1~2 秒延时再出声：避开拿水杯、调整姿势这类误触
    const D = 1400;
    [0, 3000, 11000, 19000].forEach((dt, i) => {
      this._alertTimers.push(setTimeout(() => this._tier(i + 1), D + dt));
    });
  }

  _tier(n) {
    if (this.mode !== "ALERT") return;
    this._alertTier = n;
    // 拖拽中只推进档位与音效，别把飞行精灵抢走；松手后按 _modeSprite 恢复本档精灵
    if (!this.dragging) this._sprite(ALERT_SPRITES[n]);
    playCue(["", "notice", "t1", "t2", "t3"][n], [0, 0.06, 0.13, 0.2, 0.27][n]);

    if (n === 1) {
      this.tier.textContent = "第 1/4 档 · 察觉";
      this.showLine("（盯——手机拿起来了）", 2200);
    } else if (n === 2) {
      this.tier.textContent = "第 2/4 档 · 轻提醒";
      this.showLine("手机放下，现在就放。", 2600);
    } else if (n === 3) {
      const line = ALERT_LINES[this._lineIndex++ % ALERT_LINES.length];
      this.tier.textContent = "第 3/4 档 · 认真警告";
      this.showLine(line, 4200);   // 配音由 showLine 统一负责
    } else {
      const line = FINAL_LINES[this._lineIndex++ % FINAL_LINES.length];
      this.tier.textContent = "第 4/4 档 · 最后通牒";
      this.showLine(line, 4600);   // 配音由 showLine 统一负责
    }
  }

  /** 手机放下 / 本轮提醒结束：取消还没触发的档位 */
  clearAlert(keepRest = false) {
    this._clearAlertTimers();
    if (this.mode === "ALERT") {
      this.setMode(keepRest ? "REST" : "STUDY");
      this.showLine("好，我们继续这一章", 2000);
    }
  }

  _clearAlertTimers() {
    this._alertTimers.forEach(clearTimeout);
    this._alertTimers = [];
  }

  /* ---------------- 拖拽 ----------------
     休息态：能自由拎起、放到地板或家具上做动作，松手后继续散步。
     学习态（STUDY / ALERT / PRAISE）：允许拎起给你看（飞行精灵跟手），
       但松手时不落到别处 —— 温和警告 + 沿弧线飞回书桌继续学习。       */
  _onPointerDown(e) {
    if (this.dragEnabled === false) return;     // 只在校准 / 启动瞬间禁拖
    e.preventDefault();
    e.stopPropagation();
    this._cancelFlyBack();                      // 飞回途中又被拎起：先停掉飞回
    this.dragging = true;
    this._stopWalk();                           // 走动中随时可以被拎起来
    this._moved = false;
    this._downXY = { x: e.clientX, y: e.clientY };
    this.owl.setPointerCapture?.(e.pointerId);
    this.frame.classList.add("dragging");
  }

  _onPointerMove(e) {
    if (!this.dragging) return;
    if (!this._moved) {
      const d = Math.hypot(e.clientX - this._downXY.x, e.clientY - this._downXY.y);
      if (d < 5) return;                        // 只是点一下，不切飞行
      this._moved = true;
      this.owl.classList.add("flying");
      this._sprite("flying");
    }
    // 休息态才提示家具落点；学习态拎起来只是「给你看」，不给放下的暗示
    this._moveTo(e, this.mode === "REST");
  }

  _moveTo(e, hint = false) {
    const r = this.frame.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    this.anchor = {
      x: Math.max(0.05, Math.min(0.95, x)),
      y: Math.max(0.12, Math.min(0.94, y)),
    };
    this._place();
    if (hint) this._hintSpot(x, y);
  }

  /** 拖到哪件家具上方，就把那件淡淡点亮，提示松手会触发动作 */
  _hintSpot(x, y) {
    Object.keys(SPOTS).forEach((k) => {
      const s = SPOTS[k];
      const hot = x >= s.x0 && x <= s.x1 && y >= s.y0 && y <= s.y1;
      this.root.querySelector(`.px-zone[data-zone="${k}"]`)?.classList.toggle("hot", hot);
    });
  }

  _onPointerUp(e) {
    if (!this.dragging) return;
    this.dragging = false;
    this.frame.classList.remove("dragging");
    this.owl.classList.remove("flying");
    this.root.querySelectorAll(".px-zone").forEach((el) => el.classList.remove("hot"));

    // 轻点 = 摸摸它；休息态继续散步
    if (!this._moved) {
      this.showLine(TAP_LINES[Math.floor(Math.random() * TAP_LINES.length)], 2400);
      if (this.mode === "REST") this._startWalkLoop();
      return;
    }

    // 学习态：不让猫头鹰离开书桌。拎起来给你看了，松手就温和警告并飞回去。
    if (this.mode !== "REST") {
      this.spot = null;
      this._warnStudyDrag();
      this._flyBackHome();
      return;
    }

    // 休息态：落到前排地板；落在家具热区就切换对应动作
    const r = this.frame.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    const hit = Object.keys(SPOTS).find((k) => {
      const s = SPOTS[k];
      return x >= s.x0 && x <= s.x1 && y >= s.y0 && y <= s.y1;
    });

    this.anchor = { x: Math.max(0.08, Math.min(0.92, x)), y: (WALK.y0 + WALK.y1) / 2 };
    if (hit) {
      this._enterSpot(hit, true);
    } else {
      this.spot = null;
      this._startWalkLoop();                    // 放到空地：继续自由走动
    }
  }

  /** 学习态误拖的警告：台词高亮 + 朗读出来 + 一记柔和木块音，语气硬但不骂人、
   *  不接摄像头检测；声音由 showLine() 统一发出，这里只负责高亮和木块音。 */
  _warnStudyDrag() {
    const line = STUDY_DRAG_WARN_LINES[this._lineIndex++ % STUDY_DRAG_WARN_LINES.length];
    this.showLine(line, 3200);
    this.line.classList.add("warn");
    clearTimeout(this._warnLineTimer);
    this._warnLineTimer = setTimeout(() => this.line.classList.remove("warn"), 3200);
    playCue("notice", 0.1);
  }

  /** 中断飞回动画（再次拖拽 / 切状态时用） */
  _cancelFlyBack() {
    cancelAnimationFrame(this._flyRaf);
    this._flyRaf = 0;
    this._flyBack = null;
  }

  /** 从松手位置沿一条小弧线飞回书桌锚点，落地后恢复当前学习态精灵。
   *  只做场景表现，不改 app.js 的计时 / 检测 / 木鱼统计。 */
  _flyBackHome() {
    this._cancelFlyBack();
    const from = { ...this.anchor };
    const HOME = { x: 0.5, y: 0.645 };  // 书桌锚点，与 _home() 一致
    const dur = 520;
    this._flyBack = { from, to: HOME, t: 0 };
    this._setSrc(SPRITE.flying);
    this.owl.classList.add("flying");

    const step = (ts) => {
      const f = this._flyBack;
      if (!f || this.mode === "REST") { this._flyRaf = 0; return; }
      if (!f.last) f.last = ts;
      const dt = Math.min(ts - f.last, 64);
      f.last = ts;
      f.t += dt;
      const k = Math.min(1, f.t / dur);
      const e = k * k * (3 - 2 * k);             // smoothstep 缓入缓出
      this.anchor.x = f.from.x + (f.to.x - f.from.x) * e;
      // 抛物线小弧线：中途抬高一点（anchor.y 越大越靠上），像被拎着飞回去
      this.anchor.y = f.from.y + (f.to.y - f.from.y) * e + Math.sin(Math.PI * k) * 0.08;
      this._place();
      if (k < 1) {
        this._flyRaf = requestAnimationFrame(step);
      } else {
        this._flyRaf = 0;
        this._flyBack = null;
        this.owl.classList.remove("flying");
        this.anchor = { ...HOME };
        this._sprite(this._modeSprite());
        this._place();
      }
    };
    this._flyRaf = requestAnimationFrame(step);
  }

  _enterSpot(key, keepX = false) {
    // 休息态点 / 拖到床：不再瞬间躺下，改成犯困慢慢走过去再睡
    if (key === "bed" && this.mode === "REST") {
      this._startSleepyWalk();
      return;
    }
    // 休息态选了别的家具：暂停自由走动，保持那个动作
    if (this.mode === "REST") this._stopWalk();
    if (!key) {
      this.spot = null;
      this._sprite(this._modeSprite());
      this._home();
      return;
    }
    const s = SPOTS[key];
    this.spot = key;
    // v7：床 / 餐桌 / 书柜各用贴合落点；连拖拽松手的 x 也覆盖掉，
    // 免得精灵落在家具外面看起来悬空。没有落点配置时沿用课桌锚点。
    const fit = FIT_SPOT[key];
    if (fit) {
      this.anchor = { x: fit.x, y: fit.y };
    } else {
      if (!keepX) this.anchor.x = (s.x0 + s.x1) / 2;
      this.anchor.y = 0.645;
    }
    this._sprite(s.sprite);
    this._place();
    this.showLine(s.word, 3000);
    if (this.mode !== "ALERT") this.tier.textContent = "在" + s.label + "这儿";
  }
}

/* ------------------------------------------------------------------
   三个对外接口（留桩，可直接在控制台或以后接真实检测时调用）
   ------------------------------------------------------------------ */
export function onPhoneDetected() { CURRENT?.onPhoneDetected(); }
export function onFocusComplete() { CURRENT?.setMode("PRAISE"); }
export function onRestStart() { CURRENT?.setMode("REST"); }
/** 不听话就敲：走神 / 玩手机被判定时敲一下书桌上的木鱼（动画 + 计数冒字）。
 *  声音仍由 knockFish() 原有的 silent 逻辑决定，这里只负责视觉。 */
export function knockMuyu(count) { CURRENT?.knock(count); }
/** 给主逻辑复用：一般走神提醒也用同一套「我们」口吻的轻声语音 */
export function speakLine(text) { speak(text); }

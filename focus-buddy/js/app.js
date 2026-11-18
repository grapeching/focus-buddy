/**
 * app.js — 专注伙伴主逻辑（像素小屋版）
 *  计划表 / 学习休息循环 / 摄像头判定 / 提醒
 */
import { FocusDetector } from "./detector.js";
// 视觉大模型复核：本地灰区才抽一帧上云，结论覆盖本地的「手持 / 平放」判断
import { initVision, reviewFrame, captureFrame, visionState } from "./vision-ai.js";

import { createYoloPhone } from "./yolo-phone.js";
// 提醒语音：系统语音列表 + 记住用户选的音色（设置面板可换、可试听）
// 字幕已在 showLine() 里统一配音；这里只同步「只看字」这个静音开关
import { initVoice, listVoices, onVoicesChanged, getSelectedVoice, setSelectedVoice, previewVoice, labelOf, setVoiceMuted } from "./voice.js";
// 像素小屋就是主界面；三个接口只挂接已有判定结果，不改动 detector.js 的检测实现
import { PixelScene, onPhoneDetected, onFocusComplete, onRestStart } from "./pixel-scene.js";

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

/* ============================================================
   0. 常量
   ============================================================ */
const KEY = {
  settings: "fb.settings.v2",
  cal: "fb.cal.v1",
  plans: "fb.plans.v1",
  days: "fb.days.v1",
};

const DEFAULT_SETTINGS = {
  sens: "mid",
  remind: "voice",
  phone: true,
  // 姿态（低头/转头/抬头/闭眼）是否也算走神：默认关。
  // 低头看书写字和低头玩手机在画面上几乎一样，用它当判据必然误报。
  posture: false,
  // 视觉大模型复核：灰区抽帧上云，能分清「手持看」和「平放」。会消耗积分，可关。
  aiReview: true,
  // 开源本地 YOLO11n 检测：纯离线，召回比 COCO-SSD lite 好，不用联网不花钱
  yolo: true,
  superviseBreak: false,
  study: 25,
  brk: 5,
  amb: "off",
  ambVol: 35,
};

const SENS = {
  low: { yaw: 26, pitch: 21, graceMul: 1.7, label: "宽松" },
  mid: { yaw: 20, pitch: 15, graceMul: 1.0, label: "标准" },
  high: { yaw: 14, pitch: 10, graceMul: 0.55, label: "严格" },
};

const GRACE = { gone: 5200, phone: 700, down: 2600, side: 3200, up: 3600, tired: 6200 };

const REASON_NAME = {
  gone: "离开座位", phone: "玩手机", down: "低头",
  side: "转头", up: "抬头发呆", tired: "闭眼",
};

/* 短句表：旧角色模块移除后内联在这里 */
const LINES = {
  start: ["开始啦！我陪你一起，别走神哦。", "好，坐下，翻开书，我们开始。", "开工！我就在这儿看着你。"],
  study: ["专心的时候你最好看了。", "这一页看得挺认真嘛。", "保持住，很好。"],
  phone: ["手机先放一放，我们继续这一章。", "手机比我好看吗？", "把手机推到桌角去吧。"],
  down: ["头低下去啦，抬起头看看书。", "眼睛离开本子太久咯。"],
  side: ["看哪儿呢？回来回来。", "别东张西望，看你的题。"],
  up: ["天花板上有答案吗？", "抬头太久啦，回到书本。"],
  gone: ["你去哪儿了？书还开着呢。", "人不见啦，是去喝水还是溜了？"],
  tired: ["眼睛闭上了？困了就活动一下。", "困了就洗把脸，别硬撑。"],
  back: ["回来了，继续！", "这才对嘛，接着来。"],
  break: ["休息啦，伸个懒腰吧～", "这一轮结束，起来动一动。"],
  resume: ["休息够啦，我们接着来。", "坐好，下一轮开始。"],
  done: ["今天这一轮做完啦，好棒！", "收工！今天也很认真。"],
  noTask: ["先去写一条今日计划吧。"],
  longLose: ["都过去一会儿啦，我们回来吧？"],
  pet: ["咕咕～我在呢。", "别挠我啦，专心一点～", "陪你一起，慢慢来。"],
};
const pick = (k) => {
  const a = LINES[k] || LINES.study;
  return a[Math.floor(Math.random() * a.length)];
};
/** 主界面底部台词气泡：showLine 内部会自动配音，这里不用单独朗读 */
const say = (text, ms = 2600) => pixelScene?.showLine(text, ms);

/* ============================================================
   1. 状态
   ============================================================ */
const detector = new FocusDetector();

const rt = {
  mode: null,          // 'camera' | 'demo'
  running: false,
  paused: false,
  phase: "idle",       // 'idle' | 'study' | 'break'
  phaseLen: 0,
  phaseEndAt: 0,
  phaseStartAt: 0,
  remainMs: 0,
  cycle: 1,

  focusMs: 0,
  loseMs: 0,
  streakMs: 0,
  bestStreak: 0,
  knocks: 0,
  events: [],

  distracted: false,
  reason: null,
  distStart: 0,
  lastBadAt: 0,
  lastKnockAt: 0,
  pending: null,
  pendingSince: 0,
  nagLevel: 0,

  demo: null,
  obs: { ok: false, faceCount: 0, yaw: 0, pitch: 0, roll: 0, blink: 0, phone: 0, phoneBox: null, box: null },
  // 手机判定细化（handheld / on_desk / none）——只在调用侧后处理，不动 detector.js
  phone: { t: 0, buf: [], mode: "none", handheld: false, box: null, score: 0, src: "" },
  // 姿态偏离只当「辅助证据」，不单独判走神（低头可能是在看书）
  posture: { down: false, side: false, up: false, tired: false, yawDev: 0, pitchDev: 0 },
  cal: null,
  calibrating: false,
  base: { yaw: 0, pitch: 0 },

  lastTs: 0,
  lastUi: 0,
  lastStats: 0,
  lastBlink: 0,
};

let settings = { ...DEFAULT_SETTINGS };
let plans = [];
let currentId = null;
let pixelScene = null;
let audioCtx = null;
let timerId = 0;

/* ============================================================
   2. 存储
   ============================================================ */
function loadAll() {
  try { settings = { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(KEY.settings) || "{}") }; }
  catch (_) { settings = { ...DEFAULT_SETTINGS }; }
  setVoiceMuted(settings.remind === "bubble");   // 只有「只看字」静音，其余模式所有字幕都朗读

  try { plans = JSON.parse(localStorage.getItem(KEY.plans) || "[]") || []; } catch (_) { plans = []; }
  if (!Array.isArray(plans)) plans = [];

  try { rt.cal = JSON.parse(localStorage.getItem(KEY.cal) || "null"); } catch (_) { rt.cal = null; }
  if (rt.cal && typeof rt.cal.pitchThr !== "number") rt.cal = null;
  if (rt.cal) {
    rt.cal.sign = rt.cal.sign || 1;
    rt.base = { yaw: rt.cal.yaw0 ?? 0, pitch: rt.cal.pitch0 ?? 0 };
  }
}
const saveSettings = () => localStorage.setItem(KEY.settings, JSON.stringify(settings));
const savePlans = () => localStorage.setItem(KEY.plans, JSON.stringify(plans));

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const loadDays = () => { try { return JSON.parse(localStorage.getItem(KEY.days) || "{}"); } catch (_) { return {}; } };
const saveDays = (d) => localStorage.setItem(KEY.days, JSON.stringify(d));

function commitSession() {
  if (rt.focusMs + rt.loseMs < 3000 && rt.knocks === 0) {
    resetSession();
    return;
  }
  const days = loadDays();
  const k = todayKey();
  const d = days[k] || { focusMs: 0, loseMs: 0, knocks: 0, events: [], bestStreak: 0 };
  d.focusMs += rt.focusMs;
  d.loseMs += rt.loseMs;
  d.knocks = (d.knocks || 0) + rt.knocks;
  d.bestStreak = Math.max(d.bestStreak || 0, rt.bestStreak);
  d.events = (d.events || [])
    .concat(rt.events.map((e) => ({ t: e.wall, r: e.reason, d: Math.round(e.dur || 0) })))
    .slice(-160);
  days[k] = d;
  saveDays(days);
  renderToday();
  resetSession();
}

function resetSession() {
  rt.focusMs = 0;
  rt.loseMs = 0;
  rt.streakMs = 0;
  rt.bestStreak = 0;
  rt.knocks = 0;
  rt.events = [];
}

/* ============================================================
   3. 计划表
   ============================================================ */
function addPlan(text) {
  const t = (text || "").trim();
  if (!t) return;
  const item = { id: "p" + Date.now() + Math.random().toString(36).slice(2, 6), text: t, done: false };
  plans.push(item);
  if (!currentId) currentId = item.id;
  savePlans();
  renderPlans();
}

function renderPaperDate() {
  const d = new Date();
  const elD = $("#paperDate");
  const elW = $("#paperWeek");
  if (!elD || !elW) return;
  elD.textContent = `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
  elW.textContent = "星期" + "日一二三四五六"[d.getDay()];
}

/** 墙上的卷轴：写今日计划前 4 条与完成进度，点它跳到计划页 */
function renderScroll() {
  const box = $("#pxScrollRows");
  if (!box) return;
  const NS = "http://www.w3.org/2000/svg";
  box.textContent = "";
  const list = plans.slice(0, 4);
  if (!list.length) {
    const t = document.createElementNS(NS, "tspan");
    t.setAttribute("x", "30");
    t.setAttribute("y", "80");
    t.textContent = "（还没写计划）";
    box.appendChild(t);
  } else {
    list.forEach((p, i) => {
      const t = document.createElementNS(NS, "tspan");
      t.setAttribute("x", "30");
      t.setAttribute("y", String(80 + i * 22));
      const txt = p.text.length > 7 ? p.text.slice(0, 7) + "…" : p.text;
      t.textContent = (p.done ? "✓ " : "□ ") + txt;
      if (p.done) t.setAttribute("class", "done");
      else if (p.id === currentId) t.setAttribute("font-weight", "700");
      box.appendChild(t);
    });
  }
  const rest = plans.length - list.length;
  const done = plans.filter((p) => p.done).length;
  const meta = $("#pxScrollMeta");
  if (meta) meta.textContent = (rest > 0 ? `还有 ${rest} 条 · ` : "") + `已完成 ${done} / ${plans.length}`;
}

function renderPlans() {
  renderScroll();
  const ul = $("#planList");
  renderPaperDate();
  const total = plans.length;
  const done = plans.filter((p) => p.done).length;
  $("#planProgress").textContent = `${done} / ${total}`;
  const left = total - done;
  const rb = $("#railPlanBadge");
  if (rb) { rb.textContent = left; rb.hidden = left === 0; }

  if (!plans.length) {
    ul.innerHTML = '<li class="plan-empty">今天想做什么？在上面写一条吧 ✏️</li>';
    currentId = null;
    syncBook();
    return;
  }

  // 当前任务失效时，自动落到第一个未完成的
  if (!plans.some((p) => p.id === currentId && !p.done)) {
    const next = plans.find((p) => !p.done);
    currentId = next ? next.id : null;
  }

  ul.innerHTML = plans
    .map(
      (p) => `<li class="plan-item${p.id === currentId ? " current" : ""}${p.done ? " done" : ""}" data-id="${p.id}">
        <button class="p-check" data-act="check" aria-label="完成"></button>
        <span class="p-text" title="${escapeAttr(p.text)}">${escapeHtml(p.text)}</span>
        <button class="p-del" data-act="del" aria-label="删除">✕</button>
      </li>`
    )
    .join("");

  syncBook();
}

function syncBook() {
  const cur = plans.find((p) => p.id === currentId) || null;
  $("#footTask").textContent = cur ? cur.text : "还没写计划";
  const rnTask = $("#rnTask");
  if (rnTask) rnTask.textContent = cur ? "这轮做：" + cur.text : "还没写计划 · 去「今日计划」加一条";
  $("#footSub").textContent = cur ? "正在做这一项" : "点侧边「今日计划」写一条";
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const escapeAttr = escapeHtml;

/* ============================================================
   4. 提示音与提醒
   ============================================================ */
function ac() {
  audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === "suspended") audioCtx.resume();
  return audioCtx;
}

/** 一声短短的木质「咚」+ 亮亮的小铃，像玩具木鱼 */
function woodKnock() {
  try {
    const ctx = ac();
    const t = ctx.currentTime;

    // 木头本体
    const o1 = ctx.createOscillator();
    const g1 = ctx.createGain();
    o1.type = "triangle";
    o1.frequency.setValueAtTime(620, t);
    o1.frequency.exponentialRampToValueAtTime(185, t + 0.11);
    g1.gain.setValueAtTime(0.0001, t);
    g1.gain.exponentialRampToValueAtTime(0.26, t + 0.006);
    g1.gain.exponentialRampToValueAtTime(0.0001, t + 0.17);
    o1.connect(g1).connect(ctx.destination);
    o1.start(t);
    o1.stop(t + 0.2);

    // 亮亮的小铃（高八度泛音，音量小、衰减快）
    [1318, 1760].forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine";
      o.frequency.setValueAtTime(f, t + 0.004 + i * 0.012);
      g.gain.setValueAtTime(0.0001, t + 0.004 + i * 0.012);
      g.gain.exponentialRampToValueAtTime(0.075, t + 0.012 + i * 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.26);
      o.connect(g).connect(ctx.destination);
      o.start(t + 0.004 + i * 0.012);
      o.stop(t + 0.3);
    });

    // 尾巴上一个小小的上滑「啾」
    const o3 = ctx.createOscillator();
    const g3 = ctx.createGain();
    o3.type = "sine";
    o3.frequency.setValueAtTime(900, t + 0.02);
    o3.frequency.exponentialRampToValueAtTime(1560, t + 0.1);
    g3.gain.setValueAtTime(0.0001, t + 0.02);
    g3.gain.exponentialRampToValueAtTime(0.05, t + 0.04);
    g3.gain.exponentialRampToValueAtTime(0.0001, t + 0.13);
    o3.connect(g3).connect(ctx.destination);
    o3.start(t + 0.02);
    o3.stop(t + 0.16);
  } catch (_) { /* 静音也无妨 */ }
}

/** 可爱的三音小铃：开始 / 休息 / 结束都用它 */
function sfxChime(kind) {
  try {
    const ctx = ac();
    const t = ctx.currentTime;
    const notes =
      kind === "break" ? [784, 988, 1319] :
      kind === "done" ? [523, 659, 784, 1046] :
      [659, 880, 1046];
    notes.forEach((f, i) => {
      const at = t + i * 0.115;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine";
      o.frequency.setValueAtTime(f, at);
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(0.085, at + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.42);
      o.connect(g).connect(ctx.destination);
      o.start(at);
      o.stop(at + 0.45);
    });
  } catch (_) { /* 忽略 */ }
}

function renderKnock(n) {
  $("#footKnock").textContent = n;
}

function knockFish(reason, { word, silent = false } = {}) {
  rt.knocks += 1;
  rt.lastKnockAt = performance.now();
  renderKnock(rt.knocks);

  // 不听话就敲：书桌上木鱼每次走神都敲一下（只动画，不动检测）
  pixelScene?.knock(rt.knocks);

  // 手机这一路交给主界面的四档延时提醒，这里只计数，别抢先出声
  if (!silent) woodKnock();

  const line = word || pick(reason);
  say(line, 2600);   // 字幕与配音都由 showLine 统一处理

  if (reason) {
    rt.events.push({ wall: Date.now(), reason, dur: 0 });
    renderToday();
  }
}

/* ============================================================
   5. 摄像头 / 校准 / 判定
   ============================================================ */
function setEngine(state, text) {
  const el = $("#engine");
  el.className = "engine" + (state ? " " + state : "");
  $("#engineText").textContent = text;
}

async function startCamera() {
  setEngine("busy", "请求摄像头…");
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" },
      audio: false,
    });
    rt.stream = stream;
    const v = $("#video");
    v.srcObject = stream;
    await v.play().catch(() => {});
    v.classList.add("live");
    $("#camMask").classList.add("hide");
    return true;
  } catch (e) {
    setEngine("err", "摄像头不可用");
    $("#camState").textContent = "摄像头打不开，可先用演示";
    say("摄像头打不开…允许一下权限？或者先点演示看看。");
    return false;
  }
}

function stopCamera() {
  if (rt.stream) {
    rt.stream.getTracks().forEach((t) => t.stop());
    rt.stream = null;
  }
  const v = $("#video");
  v.classList.remove("live");
  v.srcObject = null;
  $("#camMask").classList.remove("hide");
  const c = $("#overlay");
  const ctx = c.getContext("2d");
  ctx.clearRect(0, 0, c.width, c.height);
}

async function initModels() {
  $("#camLoading").hidden = false;
  setEngine("busy", "加载识别模型…");
  try {
    await detector.initFace((m) => ($("#camLoadingText").textContent = m));
    if (settings.phone) await detector.initPhone((m) => ($("#camLoadingText").textContent = m));
    if (settings.phone) serializeCoco();
    $("#camLoading").hidden = true;
    setEngine("ok", "监督中");
    return true;
  } catch (e) {
    console.error(e);
    $("#camLoading").hidden = true;
    setEngine("err", "模型加载失败");
    say("识别模型没加载起来，重启一下试试。");
    return false;
  }
}

/* ------------------------------------------------------------
   手机判定细化：detector.js 只给出「置信度 + 一个框」，
   这里在调用侧再判一层——手持才报警，平放桌上不报警。
   ------------------------------------------------------------ */
const PHONE = {
  scoreMin: 0.45,     // 单独判定的阈值（detector 内部最低就给到 0.38，这里取 0.45 留点余量）
  scoreSoft: 0.38,    // 协同判定下限：低置信手机框，必须同时「贴近身体 + 低头/闭眼」才作数
  deskSoft: 0.27,     // 只用来显示「手机在桌上」的下限：平放永远不报警，宁松不严
  minAspect: 0.22,    // 太窄（笔 / 边缘）剔除
  maxAspect: 3.2,     // 太宽（键盘 / 书本）剔除
  sampleMs: 90,       // 采样节流
  voteMs: 1500,       // 投票窗口
  voteMin: 4,         // 窗口内至少命中次数（高置信）
  voteRatio: 0.55,    // 窗口内命中占比
  softVoteMin: 6,     // 窗口内至少命中次数（协同证据，要求更严）
  softRatio: 0.72,    // 协同证据的命中占比
  holdMs: 700,        // 连续这么久没有新命中就清空窗口（放下手机快速退出）
  deskBottom: 0.60,   // 归一化纵向 > 此值算桌面区
  nearFaceK: 1.1,     // 手机顶部离脸框底部 < 脸高*K 视为「在身上」
  hoverK: 0.95,       // 手机中心水平偏差 < 脸宽*K 视为「在身前」（再宽就会把桌角手机算成手持）
};

/* ------------------------------------------------------------
   裁剪二次检测
   整帧 640×480 里，胸前的手机常常只占 3~5%，lite 模型直接认不出。
   把「人 + 桌面」那一块裁出来放大到 512 短边再检测一次，
   等效于给手机加了 3~4 倍倍率——这是提升召回最有效的一招。
   ------------------------------------------------------------ */
const CROP = {
  x0: 0.10, y0: 0.26, x1: 0.99, y1: 1.00,  // 归一化裁剪窗口（画面中下部）
  side: 512,          // 送进模型的画布短边（越大越准，越慢）
  intervalMs: 700,    // 独立节流，别把主循环拖垮
  score: 0.30,        // 裁剪放大后模型分普遍变高，阈值可比整帧低
  validMs: 1600,      // 一次结果的有效期（约两个检测周期）
};
const crop = { cv: null, ctx: null, last: 0, busy: false, at: 0, score: 0, box: null };

/* ------------------------------------------------------------
   开源本地检测：YOLO11n（ONNX + ONNX Runtime WASM，纯离线）

   为什么单独加这一路：detector.js 里的 COCO-SSD lite 只有 300×300，
   手机在整帧里占比太小时会被缩没。YOLO11n 更强，而且能「裁一块放大再认」。
   实测两张对照图：手持看手机只有裁下半身才认得出（0.78），平放桌上整帧就认得出（0.72），
   所以这里做多尺度——整帧不够确信时，按人体框下半部再认一次。
   detector.js 一行没改，这里只产出一份候选证据。
   ------------------------------------------------------------ */
const YOLO = {
  intervalMs: 900,      // 检测间隔（单段约 60ms，两段约 120ms）
  validMs: 2600,        // 一次结果的保鲜期
  reseeBelow: 0.45,     // 整帧已经这么高分的手机，就不用再裁一次
  minPersonH: 0.22,     // 人体框至少占画面这么高，才值得拿来裁
  conf: 0.30,           // 采信阈值（低于它只显示「未检出」）
};
const yolo = { ready: false, busy: false, err: "", last: 0, at: 0, ms: 0, runs: 0,
               score: 0, box: null, persons: 0, stage: "" };
let _yoloDet = null;

async function initYolo() {
  if (_yoloDet || yolo.busy) return;
  try {
    _yoloDet = await createYoloPhone();
    yolo.ready = true;
    yolo.err = "";
  } catch (e) {
    yolo.err = String(e?.message || e).slice(0, 48);
  }
}


/* ------------------------------------------------------------
   视觉大模型复核
   本地只认「像不像手机」，云端才分得清「拿在手里看」和「平放在桌上」。
   只在本地出现手机证据（灰区）时抽一帧，避免把积分烧在无意义的帧上。
   ------------------------------------------------------------ */
const VISION = {
  intervalMs: 6000,     // 两次复核的最小间隔
  holdMs: 7000,         // 一次结论的有效期（这段时间不再重复问）
  minConf: 0.6,         // 低于此置信度不采信
  triggerScore: 0.30,   // 本地手机分达到这个值才算灰区
  box: CROP,            // 抽帧区域与裁剪检测共用一块
};

/** 同一个 coco 模型会被「整帧」「裁剪」两路调用，串行化避免互相打断（只包运行时，不改 detector.js） */
function serializeCoco() {
  const m = detector.coco;
  if (!m || m.__serialized) return;
  const raw = m.detect.bind(m);
  let chain = Promise.resolve();
  m.detect = (...args) => {
    const run = chain.then(() => raw(...args));
    chain = run.catch(() => {});
    return run;
  };
  m.__serialized = true;
}

/** 裁剪区域再跑一次手机检测；框映射回整帧像素坐标，写进 crop 状态 */
function cropPhoneDetect(now) {
  // 有了 YOLO 就让它干这件事：同样是把画面放大再认，YOLO 又快又准，
  // 没必要再让 COCO 跑一遍裁剪，否则三路模型同时跑会把画面拖卡。
  if (settings.yolo && _yoloDet) return;
  if (!settings.phone || rt.mode !== "camera") return;
  if (!detector.cocoReady || !detector.coco) return;
  if (crop.busy || now - crop.last < CROP.intervalMs) return;
  // 整帧已经认出来了就不用再裁，省算力
  if ((rt.obs.phone || 0) >= PHONE.scoreMin && rt.obs.phoneBox) return;
  const v = $("#video");
  if (!v || !v.videoWidth || v.videoWidth < 2) return;

  if (!crop.cv) {
    crop.cv = document.createElement("canvas");
    crop.ctx = crop.cv.getContext("2d");
  }
  const vw = v.videoWidth, vh = v.videoHeight;
  const sx = Math.round(vw * CROP.x0);
  const sy = Math.round(vh * CROP.y0);
  const sw = Math.max(8, Math.round(vw * (CROP.x1 - CROP.x0)));
  const sh = Math.max(8, Math.round(vh * (CROP.y1 - CROP.y0)));
  const cw = CROP.side;
  const ch = Math.max(8, Math.round(CROP.side * sh / sw));
  if (crop.cv.width !== cw || crop.cv.height !== ch) { crop.cv.width = cw; crop.cv.height = ch; }
  crop.ctx.drawImage(v, sx, sy, sw, sh, 0, 0, cw, ch);

  crop.last = now;
  crop.busy = true;
  serializeCoco();                        // 与整帧检测排队执行
  const k = sw / cw;                      // 画布像素 → 整帧像素
  detector.coco.detect(crop.cv, 8, CROP.score).then((preds) => {
    crop.busy = false;
    let best = null;
    for (const p of preds) {
      if (p.class !== "cell phone") continue;
      if (!best || p.score > best.score) best = p;
    }
    if (!best) return;
    const b = best.bbox;
    crop.score = best.score;
    crop.box = [sx + b[0] * k, sy + b[1] * k, b[2] * k, b[3] * k];
    crop.at = performance.now();
  }).catch(() => { crop.busy = false; });
}

/** 把区域裁进画面内，并保证不小于 32px */
function clampRegion(r, vw, vh) {
  const x = Math.max(0, Math.min(vw - 32, Math.round(r.x)));
  const y = Math.max(0, Math.min(vh - 32, Math.round(r.y)));
  const w = Math.max(32, Math.min(vw - x, Math.round(r.w)));
  const h = Math.max(32, Math.min(vh - y, Math.round(r.h)));
  return { x, y, w, h };
}

/** 手和手机大概率落在哪：优先人体框下半部，没有人体框就用人脸下方 */
function handRegion(v, full) {
  const vw = v.videoWidth, vh = v.videoHeight;
  const p = full?.persons?.[0]?.box;
  if (p && p.h >= vh * YOLO.minPersonH) {
    const y = p.y + p.h * 0.42;
    return clampRegion({ x: p.x - p.w * 0.06, y, w: p.w * 1.12, h: p.y + p.h * 1.04 - y }, vw, vh);
  }
  const fb = rt.obs?.box;
  if (fb) {
    const y = fb.y + fb.h * 0.5;
    return clampRegion({ x: fb.x - fb.w * 1.1, y, w: fb.w * 3.2, h: vh - y }, vw, vh);
  }
  return null;
}

/** 定时跑一次 YOLO（异步，不阻塞主循环） */
function yoloTick(now) {
  if (!settings.yolo || !settings.phone) return;
  if (rt.mode === "demo" || !rt.running || rt.paused) return;
  if (yolo.busy) return;
  const v = $("#video");
  if (!v || !v.videoWidth) return;
  if (now - yolo.last < YOLO.intervalMs) return;
  yolo.last = now;

  if (!_yoloDet) { if (!yolo.err) initYolo(); return; }

  yolo.busy = true;
  const t0 = performance.now();
  (async () => {
    try {
      const full = await _yoloDet.run(v);
      let best = full.best;
      let stage = best ? "full" : "";
      yolo.persons = full.persons.length;

      // 整帧不够确信 → 按手部区域放大再认一次（实测这一步才是手持看手机的胜负手）
      if (!best || best.score < YOLO.reseeBelow) {
        const region = handRegion(v, full);
        if (region) {
          const sub = await _yoloDet.run(v, region);
          if (sub.best && (!best || sub.best.score > best.score)) { best = sub.best; stage = "crop"; }
        }
      }
      yolo.at = performance.now();
      yolo.ms = Math.round(performance.now() - t0);
      yolo.runs += 1;
      yolo.score = best ? best.score : 0;
      yolo.box = best ? best.box : null;
      yolo.stage = stage;
      yolo.err = "";
    } catch (e) {
      yolo.err = String(e?.message || e).slice(0, 48);
    } finally {
      yolo.busy = false;
    }
  })();
}

/** 把 detector 的原始 phone 信号细化成 handheld / on_desk / none（含多帧投票） */
function refinePhone(o, now) {
  const st = rt.phone;
  if (!settings.phone) {
    st.mode = "none"; st.handheld = false; st.box = null; st.score = 0; st.buf.length = 0;
    return st;
  }
  if (now - st.t < PHONE.sampleMs) return st;   // 节流，避免每帧刷投票
  st.t = now;

  // 整帧结果 vs 裁剪结果，取分更高的那一路（裁剪只在整帧漏检时才跑）
  let p = o.phone || 0;
  let pb = o.phoneBox;
  let src = pb ? "full" : "";
  if (crop.score > p && crop.box && now - crop.at < CROP.validMs) {
    p = crop.score; pb = crop.box; src = "crop";
  }
  // YOLO11n 一路：整帧 + 手部裁剪取更高分（开源离线模型，召回比 COCO-SSD lite 好）
  if (settings.yolo && yolo.box && now - yolo.at < YOLO.validMs && yolo.score > p) {
    p = yolo.score; pb = yolo.box; src = "yolo";
  }
  st.score = p;
  st.src = src;
  let mode = "none";

  if (p >= Math.min(PHONE.scoreSoft, PHONE.deskSoft) && pb) {
    const [bx, by, bw, bh] = Array.isArray(pb) ? pb : [pb.x, pb.y, pb.w, pb.h];
    const vw = rt.mode === "demo" ? 640 : ($("#video").videoWidth || 640);
    const vh = rt.mode === "demo" ? 480 : ($("#video").videoHeight || 480);
    const aspect = bw / Math.max(1, bh);
    const cxN = (bx + bw / 2) / vw;
    const cyN = (by + bh / 2) / vh;
    const okShape = aspect >= PHONE.minAspect && aspect <= PHONE.maxAspect && cxN > 0.03 && cxN < 0.97;

    if (okShape) {
      const fb = o.box;                 // 人脸框（像素）
      let nearBody = false;
      if (fb) {
        const dx = Math.abs(bx + bw / 2 - (fb.x + fb.w / 2));
        const faceBottom = fb.y + fb.h;
        // 「在身上」= 水平大致在身前 + 顶部没掉到脸下方太远
        nearBody = dx < fb.w * PHONE.hoverK && by < faceBottom + fb.h * PHONE.nearFaceK;
      }
      // 高置信：照常判手持/平放
      const strong = p >= PHONE.scoreMin;
      // 低置信：只有「贴着身体 + 正在低头/闭眼」这种「像在看手机」的组合才采信，
      // 这样低头看书时哪怕误检到一个低分框，也不会被当成玩手机（必须两个条件同时成立）。
      const weakOk = !strong && nearBody && (rt.posture.down || rt.posture.tired);
      // 平放：远离人 + 落在画面下部，分数可以很低也不报警，只是让界面能显示「手机在桌上」
      const deskOk = !strong && !nearBody && cyN > PHONE.deskBottom && p >= PHONE.deskSoft;

      if (strong || weakOk || deskOk) {
        // 在人身上 → 手持；远离人且在画面下部 → 平放在桌面
        mode = nearBody ? "handheld" : (cyN > PHONE.deskBottom ? "on_desk" : "handheld");
        st.box = pb;
      } else {
        st.box = null;
      }
    } else {
      st.box = null;
    }
  } else {
    st.box = null;
  }

  // 多帧投票：短时抖动不算数
  const hit = mode === "handheld";
  // 放下手机后：连续 holdMs 没有新命中就丢掉旧记录，避免「还在玩」拖尾
  if (!hit) {
    let lastHitAt = 0;
    for (const x of st.buf) if (x.hit) lastHitAt = x.t;
    if (lastHitAt && now - lastHitAt > PHONE.holdMs) st.buf.length = 0;
  }
  st.buf.push({ t: now, hit, strong: hit && p >= PHONE.scoreMin });
  while (st.buf.length && now - st.buf[0].t > PHONE.voteMs) st.buf.shift();
  let hits = 0, strongHits = 0;
  for (const x of st.buf) { if (x.hit) { hits++; if (x.strong) strongHits++; } }
  const ratio = st.buf.length ? hits / st.buf.length : 0;
  // 高置信命中按常规投票；纯低置信（协同证据）要求命中更多、占比更高
  const voted = (strongHits >= PHONE.voteMin && ratio >= PHONE.voteRatio)
             || (hits >= PHONE.softVoteMin && ratio >= PHONE.softRatio);

  st.mode = voted ? "handheld" : (mode === "on_desk" ? "on_desk" : "none");
  st.handheld = voted;

  // 云端结论优先：本地模型分不清「手持看」和「平放」，视觉模型分得清。
  // 结论有有效期，过期就自然退回本地判断，不会一直粘着。
  const vs = visionState;
  if (settings.aiReview && vs.at && now - vs.at < VISION.holdMs && vs.confidence >= VISION.minConf) {
    if (vs.verdict === "phone_distraction") {
      st.mode = "handheld"; st.handheld = true; st.src = "ai";
      st.score = Math.max(st.score, vs.confidence);
    } else if (vs.verdict === "focus") {
      st.mode = vs.location === "on_desk" ? "on_desk" : "none";
      st.handheld = false; st.src = "ai";
    }
  }
  return st;
}

/* 灰区才上云：本地已经确定手持就别再花钱，看不到任何手机迹象也不必问 */
function maybeAiReview(now) {
  const vs = visionState;
  if (!settings.aiReview || !settings.phone) return;
  if (rt.mode !== "camera" || !rt.running || rt.paused || rt.calibrating) return;
  if (rt.phase === "break" && !settings.superviseBreak) return;
  if (vs.busy || now - vs.lastTry < VISION.intervalMs) return;
  if (vs.at && now - vs.at < VISION.holdMs) return;   // 上一条结论还有效
  if (rt.phone.handheld && rt.phone.src !== "ai") return;  // 本地已经确信，不用复核

  const gray = (rt.obs.phone || 0) >= VISION.triggerScore || rt.phone.mode === "on_desk";
  if (!gray) return;

  const url = captureFrame($("#video"), VISION.box);
  if (!url) return;
  reviewFrame(url).catch(() => {});   // 失败只降级成本轮不复核
}

function judge(o, now, dt) {
  if (rt.calibrating || !rt.running || rt.paused) return;
  if (rt.phase === "break" && !settings.superviseBreak) return;

  const s = SENS[settings.sens] || SENS.mid;
  const yawThr = rt.cal?.yawThr ?? s.yaw;
  const pitchThr = rt.cal?.pitchThr ?? s.pitch;
  const sign = rt.cal?.sign ?? 1;

  const yawDev = o.yaw - rt.base.yaw;
  const pitchDev = (o.pitch - rt.base.pitch) * sign;

  const hasFace = o.faceCount > 0;
  const phoneSeen = !!settings.phone && rt.phone.handheld;
  const lookingDown = hasFace && pitchDev > pitchThr;
  const lookingUp = hasFace && pitchDev < -pitchThr * 1.2;
  const lookingSide = hasFace && Math.abs(yawDev) > yawThr;
  const sleepy = hasFace && o.blink > 0.55 && !lookingDown;

  // 姿态偏离只记录成「辅助证据」，供手机协同判定与指示灯使用；
  // 除非显式打开「姿态也算走神」，否则低头/转头不产生任何提醒。
  rt.posture = { down: lookingDown, side: lookingSide, up: lookingUp, tired: sleepy, yawDev, pitchDev };

  let reason = null;
  if (!hasFace) reason = "gone";
  else if (phoneSeen) reason = "phone";
  else if (settings.posture) {
    if (lookingDown) reason = "down";
    else if (lookingSide) reason = "side";
    else if (lookingUp) reason = "up";
    else if (sleepy) reason = "tired";
  }

  // 计时累加
  if (rt.distracted) { rt.loseMs += dt; rt.streakMs = 0; }
  else { rt.focusMs += dt; rt.streakMs += dt; rt.bestStreak = Math.max(rt.bestStreak, rt.streakMs); }

  if (reason) {
    rt.lastBadAt = now;
    if (!rt.distracted) {
      if (rt.pending !== reason) {
        rt.pending = reason;
        rt.pendingSince = now;
      } else if (now - rt.pendingSince >= (GRACE[reason] ?? 3000) * s.graceMul) {
        beginDistraction(reason, now);
      }
    } else if (now - rt.lastKnockAt > 30000) {
      // 一直不回来，再敲一下
      knockFish(reason, { word: pick("longLose") });
    }
  } else {
    rt.pending = null;
    if (rt.distracted && now - rt.lastBadAt > 1600) endDistraction(now);
  }

  // 顶栏/徽标
  $("#dotFace").className = hasFace ? "ok" : "bad";
  $("#dotGaze").className = !hasFace ? "" : Math.abs(yawDev) > yawThr || Math.abs(pitchDev) > pitchThr ? "warn" : "ok";
  $("#dotPhone").className = !settings.phone ? "" : rt.phone.handheld ? "bad" : rt.phone.mode === "on_desk" ? "warn" : "ok";
}

function beginDistraction(reason, now) {
  rt.distracted = true;
  rt.reason = reason;
  rt.distStart = now;
  // 手机：木鱼只做动画/计数，不出声；由三档提醒在 1.4s 后才开始发声
  knockFish(reason, { silent: reason === "phone" });
  // 已有手机判定结果直接挂到像素小屋的 ALERT 入口（检测逻辑本身不动）
  if (reason === "phone") onPhoneDetected();
}

function endDistraction(now) {
  const ev = rt.events[rt.events.length - 1];
  if (ev) ev.dur = now - rt.distStart;
  const dur = now - rt.distStart;

  rt.distracted = false;
  rt.reason = null;
  rt.pending = null;

  if (dur > 2500) say(pick("back"));
  // 手机放下了：取消还没触发的 2/3 档提醒
  pixelScene?.clearAlert(rt.phase === "break");
  renderToday();
}

/* ---- 校准 ---- */
function runCalibration() {
  return new Promise((resolve) => {
    const modal = $("#calModal");
    const tip = $("#calTip");
    const avatar = $("#calAvatar");
    const prog = $("#calProgress");
    const stepsEl = $$(".cal-step");
    modal.hidden = false;
    rt.calibrating = true;

    const steps = [
      { key: "base", ms: 2600, tip: "① 正常坐好，看着屏幕，别动", avatar: "🧑‍💻" },
      { key: "down", ms: 3000, tip: "② 现在低头，像在看手机那样", avatar: "📱" },
      { key: "side", ms: 2600, tip: "③ 把头转向一边（左或右都行）", avatar: "👀" },
    ];

    let idx = 0, stepStart = performance.now(), raf = 0;
    const samples = { base: [], down: [], side: [] };

    const setStepUI = (i) => {
      stepsEl.forEach((el, k) => (el.className = "cal-step" + (k === i ? " on" : k < i ? " done" : "")));
      tip.textContent = steps[i] ? steps[i].tip : "校准完成！";
      avatar.textContent = steps[i] ? steps[i].avatar : "✅";
    };
    setStepUI(0);

    const tick = (now) => {
      if (!steps[idx]) return;
      const st = steps[idx];
      const p = Math.min(1, (now - stepStart) / st.ms);
      prog.style.width = p * 100 + "%";

      const o = detector.tick($("#video"), now, false);
      if (o.faceCount > 0 && p > 0.15) samples[st.key].push({ yaw: o.yaw, pitch: o.pitch });

      if (p >= 1) {
        idx++;
        stepStart = now;
        if (idx < steps.length) setStepUI(idx);
        else return finish();
      }
      raf = requestAnimationFrame(tick);
    };

    const finish = () => {
      cancelAnimationFrame(raf);
      rt.calibrating = false;
      const avg = (arr, k) => (arr.length ? arr.reduce((a, b) => a + b[k], 0) / arr.length : null);
      const bYaw = avg(samples.base, "yaw"), bPitch = avg(samples.base, "pitch");
      const dPitch = avg(samples.down, "pitch"), sYaw = avg(samples.side, "yaw");

      if (bYaw !== null && bPitch !== null && samples.down.length > 3 && samples.side.length > 3) {
        const dDown = dPitch - bPitch;
        const dSide = sYaw - bYaw;
        const cal = {
          yaw0: bYaw, pitch0: bPitch,
          sign: dDown < 0 ? -1 : 1,
          pitchThr: Math.min(26, Math.max(7, Math.abs(dDown) * 0.55)),
          yawThr: Math.min(30, Math.max(8, Math.abs(dSide) * 0.55)),
          at: Date.now(),
        };
        rt.cal = cal;
        rt.base = { yaw: cal.yaw0, pitch: cal.pitch0 };
        localStorage.setItem(KEY.cal, JSON.stringify(cal));
        tip.textContent = "校准完成，开始监督！";
        avatar.textContent = "✅";
        prog.style.width = "100%";
        stepsEl.forEach((el) => (el.className = "cal-step done"));
        setTimeout(() => { modal.hidden = true; resolve(true); }, 620);
      } else {
        tip.textContent = "没看清你的脸，先用默认参数";
        avatar.textContent = "😅";
        setTimeout(() => { modal.hidden = true; resolve(false); }, 850);
      }
    };

    $("#btnSkipCal").onclick = () => {
      cancelAnimationFrame(raf);
      rt.calibrating = false;
      modal.hidden = true;
      resolve(false);
    };

    raf = requestAnimationFrame(tick);
  });
}

/* ============================================================
   6. 主循环
   ============================================================ */
function loop(ts) {
  if (!rt.running) return;
  rt.raf = requestAnimationFrame(loop);

  const dt = rt.lastTs ? Math.min(150, ts - rt.lastTs) : 16;
  rt.lastTs = ts;

  try {
    if (rt.mode === "demo") rt.obs = demoObs(ts);
    else rt.obs = detector.tick($("#video"), ts, settings.phone);

    cropPhoneDetect(ts);              // 整帧漏检时，裁中下部放大再认一次
    yoloTick(ts);                     // 开源 YOLO11n 多尺度检测（异步，不阻塞）
    refinePhone(rt.obs, ts);          // 手持 / 平放 / 无 + 多帧投票
    maybeAiReview(ts);                // 灰区抽帧送视觉模型复核（异步，不阻塞）
    if (rt.running) judge(rt.obs, ts, dt);

    if (ts - rt.lastUi > 150) {
      rt.lastUi = ts;
      drawOverlay(rt.obs);
      updateCamState();
      updatePhoneHud();
      updateAiHud();
      updateYoloHud();
    }
    if (ts - rt.lastStats > 1200) {
      rt.lastStats = ts;
      renderFoot();
    }
  } catch (e) {
    console.error("[loop]", e);
  }
}

function demoObs(ts) {
  const t = ts / 1000;
  const b = rt.base;
  const base = { ok: true, faceCount: 1, roll: 0, blink: 0.06, phone: 0, phoneBox: null, box: { x: 200, y: 90, w: 240, h: 290 } };
  if (rt.demo === "away") return { ...base, faceCount: 0, box: null, yaw: b.yaw, pitch: b.pitch };
  if (rt.demo === "phone") {
    return { ...base, yaw: b.yaw + Math.sin(t) * 3, pitch: b.pitch + 26, blink: 0.1, phone: 0.86, phoneBox: [340, 250, 86, 140] };
  }
  return { ...base, yaw: b.yaw + Math.sin(t * 0.8) * 2, pitch: b.pitch + Math.cos(t * 0.6) * 2 };
}

function updateCamState() {
  const el = $("#camState");
  if (!rt.running) { el.textContent = rt.mode === "demo" ? "演示模式" : "未开启"; return; }
  const mb = $("#railMonitorBadge");
  if (mb) mb.hidden = !(rt.running && rt.distracted);
  if (rt.distracted) { el.textContent = "⚠ " + (REASON_NAME[rt.reason] || "走神"); el.style.color = "var(--danger)"; }
  else if (rt.paused) { el.textContent = "已暂停"; el.style.color = "var(--muted)"; }
  else if (settings.phone && rt.phone.mode === "on_desk") { el.textContent = "手机在桌上"; el.style.color = "var(--muted)"; }
  else if (!rt.obs.faceCount && rt.mode === "camera") { el.textContent = "没看到人"; el.style.color = "var(--muted)"; }
  // 姿态偏离不再触发提醒，但把状态说出来，用户就知道检测在跑、只是不打断（手机正在判定时不抢文案）
  else if (!settings.posture && rt.phone.mode === "none" && (rt.posture.down || rt.posture.side || rt.posture.up)) {
    el.textContent = rt.posture.down ? "低头中（不提醒）" : "视线偏了（不提醒）"; el.style.color = "var(--muted)";
  }
  else { el.textContent = "在看着你"; el.style.color = "var(--ok)"; }
}

/** 监督页「手机分」读数：把检测器内部状态摊开，方便判断是「没认出手机」还是「认出来了但不算手持」 */
function updatePhoneHud() {
  const el = $("#camPhone");
  if (!el) return;
  const score = rt.phone.score || 0;
  const shown = score > 0 ? score.toFixed(2) : "0.00";
  const src = rt.phone.src === "crop" ? " · 裁剪" : "";
  let label, color;
  if (!settings.phone) { label = "已关闭"; color = "var(--muted)"; }
  else if (rt.mode === "demo") {
    label = rt.phone.handheld ? "手持（演示）" : rt.phone.mode === "on_desk" ? "在桌上（演示）" : "演示中";
    color = rt.phone.handheld ? "var(--danger)" : "var(--muted)";
  } else if (!detector.cocoReady) { label = "模型未就绪"; color = "var(--warn)"; }
  else if (rt.phone.handheld) { label = "手持 · 报警" + src; color = "var(--danger)"; }
  else if (rt.phone.mode === "on_desk") { label = "在桌上 · 不报警" + src; color = "var(--warn)"; }
  else if (score >= PHONE.scoreSoft) { label = "疑似 · 待确认" + src; color = "var(--ink-2)"; }
  else if (score > 0) { label = "太弱 · 忽略" + src; color = "var(--muted)"; }
  else { label = "未检出"; color = "var(--muted)"; }
  el.textContent = `${shown} · ${label}`;
  el.style.color = color;
}

/** 监督页「AI 复核」读数：让用户看得见云端到底判了什么、花了多少次 */
function updateAiHud() {
  const el = $("#camAI");
  if (!el) return;
  const vs = visionState;
  let text, color = "var(--muted)";
  if (!settings.aiReview) { text = "已关闭"; }
  else if (!settings.phone) { text = "–"; }
  else if (vs.busy) { text = "复核中…"; color = "var(--ink-2)"; }
  else if (vs.error && !vs.ready) { text = `不可用 · ${vs.error}`; color = "var(--warn)"; }
  else {
    const fresh = vs.at && performance.now() - vs.at < VISION.holdMs;
    const conf = vs.confidence ? vs.confidence.toFixed(2) : "";
    if (fresh && vs.verdict === "phone_distraction") { text = `手持看手机 · ${conf}`; color = "var(--danger)"; }
    else if (fresh && vs.verdict === "focus") { text = `专注${vs.location === "on_desk" ? "（手机平放）" : ""} · ${conf}`; color = "var(--ok)"; }
    else if (fresh && vs.verdict === "away") { text = "不在座位"; color = "var(--warn)"; }
    else if (fresh && vs.verdict === "unclear") { text = "看不清 · 不采信"; color = "var(--muted)"; }
    else if (vs.ready) { text = `就绪（${vs.model}）· ${vs.calls} 次`; color = "var(--muted)"; }
    else { text = "待机"; }
  }
  el.textContent = text;
  el.style.color = color;
}

function updateYoloHud() {
  const el = $("#camYolo");
  if (!el) return;
  let text, color = "var(--muted)";
  if (!settings.yolo) text = "已关闭";
  else if (!settings.phone) text = "–";
  else if (yolo.err) { text = `不可用 · ${yolo.err}`; color = "var(--warn)"; }
  else if (!yolo.ready) text = "加载中…（首次约 11MB）";
  else if (yolo.busy && !yolo.at) text = "检测中…";
  else if (!yolo.at) text = `就绪（${_yoloDet?.input || 320}）· 等待中`;
  else if (yolo.score >= YOLO.conf) {
    const tag = yolo.stage === "crop" ? "裁剪放大" : "整帧";
    text = `${yolo.score.toFixed(2)} · 检出（${tag}）· ${yolo.ms}ms`;
    color = "var(--danger)";
  } else {
    text = `未检出 · ${yolo.ms}ms`;
  }
  el.textContent = text;
  el.style.color = color;
}

function drawOverlay(o) {
  if (rt.mode === "demo") return;
  const v = $("#video"), c = $("#overlay");
  if (!v.videoWidth || !c.clientWidth) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = c.clientWidth, h = c.clientHeight;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
  }
  const ctx = c.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const scale = Math.max(w / v.videoWidth, h / v.videoHeight);
  const ox = (w - v.videoWidth * scale) / 2;
  const oy = (h - v.videoHeight * scale) / 2;
  const color = rt.distracted ? "#ef5f5f" : rt.pending ? "#efb03f" : "#4ecdc4";

  if (o.box) {
    const x = o.box.x * scale + ox, y = o.box.y * scale + oy;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6;
    ctx.setLineDash(rt.distracted ? [5, 4] : []);
    ctx.strokeRect(x, y, o.box.w * scale, o.box.h * scale);
  }
  if (settings.phone && rt.phone.box) {
    const pb = rt.phone.box;
    const [px, py, pw, ph] = Array.isArray(pb) ? pb : [pb.x, pb.y, pb.w, pb.h];
    const onDesk = rt.phone.mode === "on_desk";
    ctx.strokeStyle = onDesk ? "#efb03f" : "#ef5f5f";   // 平放=琥珀，手持=红
    ctx.lineWidth = 1.8;
    ctx.setLineDash(onDesk ? [2, 4] : [4, 3]);
    ctx.strokeRect(px * scale + ox, py * scale + oy, pw * scale, ph * scale);
  }
  ctx.setLineDash([]);
}

/* ============================================================
   7. 计时与阶段
   ============================================================ */
function reloadCal() {
  try { rt.cal = JSON.parse(localStorage.getItem(KEY.cal) || "null"); } catch (_) { rt.cal = null; }
  if (rt.cal && typeof rt.cal.pitchThr !== "number") rt.cal = null;
  if (rt.cal) {
    rt.cal.sign = rt.cal.sign || 1;
    rt.base = { yaw: rt.cal.yaw0 ?? 0, pitch: rt.cal.pitch0 ?? 0 };
  }
}

function startSession(mode = "camera") {
  if (rt.running || rt.starting) return;
  rt.starting = true;

  if (mode === "camera") {
    startCamera().then(async (ok) => {
      if (!ok) { rt.starting = false; return; }
      const ready = await initModels();
      if (!ready) { rt.starting = false; return; }
      reloadCal();
      if (!rt.cal) await runCalibration();
      rt.starting = false;
      beginRunning("camera");
    });
  } else {
    rt.mode = "demo";
    rt.cal = { yaw0: 0, pitch0: 0, sign: 1, pitchThr: 12, yawThr: 15 };
    rt.base = { yaw: 0, pitch: 0 };
    setEngine("busy", "演示模式");
    $("#camLoading").hidden = true;
    rt.starting = false;
    beginRunning("demo");
  }
}

function beginRunning(mode) {
  rt.mode = mode;
  rt.running = true;
  rt.paused = false;
  rt.phase = "study";
  rt.cycle = 1;
  rt.phaseLen = settings.study * 60000;
  rt.phaseStartAt = Date.now();
  rt.phaseEndAt = Date.now() + rt.phaseLen;
  rt.distracted = false;
  rt.pending = null;
  rt.lastTs = 0;
  detector.reset();
  // 手机判定缓冲也清空，避免上一轮的残留影响新一轮
  rt.phone.buf.length = 0;
  rt.phone.t = 0;
  rt.phone.mode = "none";
  rt.phone.handheld = false;
  rt.phone.box = null;
  // 裁剪检测缓存也清掉，避免上一轮的框被当成新证据
  crop.score = 0; crop.box = null; crop.at = 0; crop.last = 0;
  // 上一轮的云端结论不能带进新一轮
  visionState.at = 0; visionState.verdict = ""; visionState.confidence = 0;
  if (settings.aiReview && settings.phone) initVision().catch(() => {});   // 预热，失败也不影响本地检测
  // 上一轮的 YOLO 结果也别带进新一轮，并预热模型（首次要读 11MB 权重）
  yolo.at = 0; yolo.score = 0; yolo.box = null; yolo.stage = ""; yolo.last = 0;
  if (settings.yolo && settings.phone) initYolo();

  const hello = pick("start");
  say(hello, 2800);
  pixelScene?.setMode("STUDY");

  $("#cyclePill").textContent = "第 1 轮";
  $("#stageTip").textContent = "别摸手机，我在看着你哦";
  setEngine("ok", mode === "demo" ? "演示中" : "监督中");
  syncTransport();
  updateMovable();
  // 主界面就是像素小屋，开始学习时留在这一页
  switchView("home");
  sfxChime("start");
  // 摄像头模式下演示按钮无意义，先禁用
  $$("[data-demo]").forEach((b) => (b.disabled = mode === "camera"));
  renderKnock(0);
  renderPhaseUi();
  renderToday();

  cancelAnimationFrame(rt.raf);
  rt.raf = requestAnimationFrame(loop);
}

function endSession(finished = false) {
  if (!rt.running) return;
  rt.running = false;
  rt.paused = false;
  rt.phase = "idle";
  cancelAnimationFrame(rt.raf);
  stopCamera();

  commitSession();

  syncTransport();
  setEngine("", "未启动");
  $("#stageTip").textContent = "写个计划，点「开始学习」，我们一起坐在这儿";
  $$("[data-demo]").forEach((b) => { b.disabled = false; b.classList.remove("on"); });

  pixelScene?.setMode("STUDY");
  updateMovable();
  const bye = finished ? pick("done") : "先歇会儿，回来继续。";
  say(bye, 2800);
  if (finished) sfxChime("done");

  renderPhaseUi();
  renderToday();
}

function pauseSession() {
  if (!rt.running) return;
  rt.paused = !rt.paused;
  if (rt.paused) {
    rt.remainMs = Math.max(0, rt.phaseEndAt - Date.now());
    say("先停一下，我等你。");
  } else {
    rt.phaseEndAt = Date.now() + (rt.remainMs || rt.phaseLen);
    rt.phaseStartAt = Date.now() - (rt.phaseLen - rt.remainMs);
  }
  syncTransport();
  renderPhaseUi();
}

function tickTimer() {
  if (!rt.running || rt.paused) { renderPhaseUi(); return; }
  const remain = rt.phaseEndAt - Date.now();
  if (remain <= 0) { nextPhase(); return; }
  rt.remainMs = remain;
  renderPhaseUi();
}

function nextPhase() {
  if (rt.phase === "study") {
    rt.phase = "break";
    rt.phaseLen = settings.brk * 60000;
    const bl = pick("break");
    say(bl, 2600);
    sfxChime("break");
    // 专注时段完成 → 先表扬，模块内部停顿后自行进入 REST
    onFocusComplete();
    $("#stageTip").textContent = "休息中 · 拖我到床 / 书柜 / 餐桌歇会儿；拖回书桌就继续学习";
  } else {
    rt.phase = "study";
    rt.cycle += 1;
    rt.phaseLen = settings.study * 60000;
    const rl = pick("resume");
    say(rl, 2600);
    sfxChime("start");
    pixelScene?.setMode("STUDY");
    $("#stageTip").textContent = "开始啦，我坐在这儿陪你";
    $("#cyclePill").textContent = `第 ${rt.cycle} 轮`;
    $("#stageTip").textContent = "第 " + rt.cycle + " 轮开始，加油";
  }
  rt.phaseStartAt = Date.now();
  rt.phaseEndAt = Date.now() + rt.phaseLen;
  rt.remainMs = rt.phaseLen;
  rt.distracted = false;
  rt.pending = null;
  updateMovable();
  renderPhaseUi();
}

/* ============================================================
   8. 渲染
   ============================================================ */
const pad2 = (n) => String(n).padStart(2, "0");
function clockText(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${pad2(Math.floor(s / 60))}:${pad2(s % 60)}`;
}
function fmtMin(ms) {
  return (Math.round(ms / 6000) / 10).toFixed(1).replace(/\.0$/, "");
}

function renderPhaseUi() {
  const isStudy = rt.phase === "study";
  const isBreak = rt.phase === "break";
  const idle = rt.phase === "idle";

  let remain = rt.phaseLen;
  let len = rt.phaseLen;
  if (rt.running) {
    remain = rt.paused ? rt.remainMs : Math.max(0, rt.phaseEndAt - Date.now());
    len = rt.phaseLen || 1;
  } else {
    remain = settings.study * 60000;
    len = remain;
  }

  const text = clockText(remain);
  $("#countdown").textContent = text;
  $("#clockText").textContent = text;

  let label = "还没开始";
  if (rt.paused) label = "已暂停";
  else if (isStudy && rt.running) label = "专注中";
  else if (isBreak) label = "休息中";

  $("#phaseLabel").textContent = label;
  $("#clockSub").textContent = isBreak ? "休息" : "专注";

  // 圆环
  const C = 2 * Math.PI * 52;
  const progress = rt.running ? 1 - remain / len : 0;
  const arc = $("#clockArc");
  arc.style.strokeDasharray = C;
  arc.style.strokeDashoffset = String(C * (1 - Math.min(1, Math.max(0, progress))));
  arc.style.stroke = isBreak ? "#4ecdc4" : "var(--accent)";

  $("#phaseBar").style.width = Math.min(100, Math.max(0, progress * 100)) + "%";
  $("#phaseBar").style.background = isBreak ? "#4ecdc4" : "var(--accent)";

  const chip = $("#phaseChip");
  chip.className = "px-phase" + (rt.paused ? " paused" : isStudy && rt.running ? " study" : isBreak ? " break" : "");
  chip.querySelector("span").textContent = rt.paused ? "已暂停" : isStudy && rt.running ? "专注中" : isBreak ? "休息中" : "未开始";

  if (rt.running) document.title = `${text} · ${label} · 专注伙伴`;
  else document.title = "专注伙伴 · Focus Buddy";
}

function renderFoot() {
  $("#footKnock").textContent = rt.knocks;
  $("#footFocus").textContent = fmtMin(rt.focusMs);
}

function renderToday() {
  const d = loadDays()[todayKey()] || { focusMs: 0, knocks: 0, bestStreak: 0 };
  const focus = (d.focusMs || 0) + rt.focusMs;
  const knock = (d.knocks || 0) + rt.knocks;
  const best = Math.max(d.bestStreak || 0, rt.bestStreak);
  $("#stFocus").textContent = fmtMin(focus) + " 分";
  $("#stKnock").textContent = knock + " 次";
  $("#stStreak").textContent = fmtMin(best) + " 分";
}

/* ============================================================
   8.5 视图切换 / 按钮同步 / 可拖动状态
   ============================================================ */
function switchView(name) {
  $$(".view").forEach((v) => v.classList.toggle("on", v.dataset.view === name));
  $$("#rail .rail-btn").forEach((b) => b.classList.toggle("on", b.dataset.view === name));
  if (name === "home") requestAnimationFrame(() => pixelScene?.place());
}

function syncTransport() {
  const running = rt.running;
  ["#btnStart", "#btnStart2"].forEach((sel) => {
    const el = $(sel); if (!el) return;
    el.textContent = running ? "结束学习" : "开始学习";
    el.className = "btn " + (running ? "ghost" : "primary");
  });
  ["#btnPause", "#btnPause2"].forEach((sel) => {
    const el = $(sel); if (!el) return;
    el.disabled = !running;
    el.textContent = rt.paused ? "继续" : "暂停";
  });
}

function updateMovable() {
  // 校准 / 启动中先别拖，其余任何状态都能拎起猫头鹰
  if (pixelScene) pixelScene.dragEnabled = !rt.calibrating && !rt.starting;
}

/* ============================================================
   9. 交互
   ============================================================ */
function bindSeg(sel, onPick) {
  $$(sel + " button").forEach((b) => {
    b.onclick = () => {
      $$(sel + " button").forEach((x) => x.classList.remove("on"));
      b.classList.add("on");
      onPick(b.dataset.v);
    };
  });
}

/* ------------------- 背景音（呼嚕角落环境音） ------------------- */
const AMB_SRC = {
  rain: "assets/ambient/rain.wav",
  birds: "assets/ambient/birds.wav",
  leaves: "assets/ambient/leaves.wav",
  crickets: "assets/ambient/crickets.wav",
};
const ambAudio = new Audio();
ambAudio.loop = true;
ambAudio.preload = "none";

function syncAmbUi() {
  $$("#ambSeg button").forEach((b) => b.classList.toggle("on", b.dataset.amb === settings.amb));
  const el = $("#ambVol");
  if (el && Number(el.value) !== Number(settings.ambVol)) el.value = settings.ambVol;
}

function setAmb(kind) {
  settings.amb = AMB_SRC[kind] ? kind : "off";
  saveSettings();
  syncAmbUi();
  if (settings.amb === "off") {
    ambAudio.pause();
    return;
  }
  const src = AMB_SRC[settings.amb];
  if (ambAudio.getAttribute("src") !== src) ambAudio.setAttribute("src", src);
  ambAudio.volume = Math.max(0, Math.min(1, Number(settings.ambVol) / 100));
  ambAudio.play().catch(() => {});
  if (!ambAudio.getAttribute("src")) return;
}

function setAmbVol(v) {
  settings.ambVol = Math.max(0, Math.min(100, Number(v) || 0));
  saveSettings();
  ambAudio.volume = settings.ambVol / 100;
  syncAmbUi();
}

function applySettingsToUi() {
  $$("#segSens button").forEach((b) => b.classList.toggle("on", b.dataset.v === settings.sens));
  $$("#segRemind button").forEach((b) => b.classList.toggle("on", b.dataset.v === settings.remind));
  $$("#segStudy button").forEach((b) => b.classList.toggle("on", Number(b.dataset.v) === settings.study));
  $$("#segBreak button").forEach((b) => b.classList.toggle("on", Number(b.dataset.v) === settings.brk));
  $("#chkPhone").checked = settings.phone;
  $("#chkPosture").checked = !!settings.posture;
  $("#chkAI").checked = !!settings.aiReview;
  $("#chkYolo").checked = !!settings.yolo;
  $("#chkBreak").checked = settings.superviseBreak;
  fillVoiceOptions();
  syncAmbUi();
}

/** 把三套离线音色填进所有下拉（设置 / 监督页），选中的那个保持选中 */
function fillVoiceOptions() {
  const cur = getSelectedVoice();
  const vs = listVoices();
  const picked = vs.some((v) => v.voiceURI === cur) ? cur : vs[0]?.voiceURI;
  ["#selVoice", "#selVoiceMonitor"].forEach((id) => {
    const sel = $(id);
    if (!sel) return;
    sel.innerHTML = "";
    vs.forEach((v) => sel.add(new Option(labelOf(v), v.voiceURI)));
    sel.value = picked;
  });
}

/** 任一处下拉换了音色：记住、同步另一处、立刻试听 */
function onVoiceSelect(e) {
  const uri = e.target.value;
  setSelectedVoice(uri);
  ["#selVoice", "#selVoiceMonitor"].forEach((id) => {
    const sel = $(id);
    if (sel && sel !== e.target) sel.value = uri;
  });
  previewVoice(uri);
}

/* ============================================================
   10. 启动
   ============================================================ */
function boot() {
  loadAll();
  initVoice();     // 读回上次选的提醒音色；语音列表异步到齐后会再刷新两处下拉
  fillVoiceOptions();   // 监督页和设置里的音色下拉启动时就要有内容

  // 像素小屋就是主界面
  pixelScene = new PixelScene($("#pixelView")).init();
  // 休息态把猫头鹰拖回书桌：若正处在休息阶段，就提前结束休息、进入下一轮学习，
  // 让计时循环和小屋状态保持一致（场景层已在 pixel-scene 里切到 STUDY）。
  pixelScene.onDeskDrop = () => {
    if (rt.running && !rt.paused && rt.phase === "break") nextPhase();
  };
  // 三个接口留桩：以后换检测源，直接调 window.onPhoneDetected() 等即可
  Object.assign(window, { onPhoneDetected, onFocusComplete, onRestStart });

  say("写好计划，点「开始学习」，我们就开始。", 3200);

  // 计划
  renderPlans();
  const scrollEl = $("#pxScroll");
  if (scrollEl) {
    scrollEl.addEventListener("click", () => switchView("plan"));
    scrollEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); switchView("plan"); }
    });
  }
  $("#planForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $("#planInput");
    addPlan(input.value);
    input.value = "";
    input.focus();
  });
  $("#planList").addEventListener("click", (e) => {
    const li = e.target.closest(".plan-item");
    if (!li) return;
    const id = li.dataset.id;
    const act = e.target.dataset.act;
    if (act === "check") {
      const p = plans.find((x) => x.id === id);
      if (p) { p.done = !p.done; if (p.done && currentId === id) currentId = null; savePlans(); renderPlans(); }
      return;
    }
    if (act === "del") {
      plans = plans.filter((x) => x.id !== id);
      if (currentId === id) currentId = null;
      savePlans(); renderPlans();
      return;
    }
    currentId = id;
    renderPlans();
  });

  // 节奏
  bindSeg("#segStudy", (v) => {
    settings.study = Number(v);
    saveSettings();
    if (!rt.running) renderPhaseUi();
    say(`学习 ${v} 分钟，记住了。`);
  });
  bindSeg("#segBreak", (v) => {
    settings.brk = Number(v);
    saveSettings();
    say(`休息 ${v} 分钟，别赖太久哦。`);
  });

  // 顶栏
  $("#btnStart").onclick = () => {
    if (rt.running) { endSession(false); return; }
    if (!plans.length) say(pick("noTask"));
    startSession("camera");
  };
  $("#btnPause").onclick = pauseSession;
  $("#btnStart2").onclick = () => $("#btnStart").click();
  $("#btnPause2").onclick = pauseSession;

  // 侧边按钮：整页切换，不滚动
  $$("#rail .rail-btn").forEach((b) => {
    b.onclick = () => switchView(b.dataset.view);
  });

  // 点底部任务行 → 去今日计划
  const fl = $(".foot-left");
  if (fl) {
    fl.style.cursor = "pointer";
    fl.title = "去今日计划";
    fl.onclick = () => switchView("plan");
  }

  $("#btnSettings").onclick = () => { applySettingsToUi(); $("#settingsModal").hidden = false; };  $("#btnCloseSettings").onclick = () => ($("#settingsModal").hidden = true);
  $("#settingsModal").addEventListener("click", (e) => { if (e.target.id === "settingsModal") $("#settingsModal").hidden = true; });
  $("#btnSaveSettings").onclick = () => {
    saveSettings();
    $("#settingsModal").hidden = true;
    say("好，按你说的来。");
  };
  $("#btnResetCal").onclick = () => {
    localStorage.removeItem(KEY.cal);
    rt.cal = null;
    rt.base = { yaw: 0, pitch: 0 };
    $("#settingsModal").hidden = true;
    say("校准数据清掉了，下次开始会重新校准。");
  };
  $("#btnCal").onclick = async () => {
    if (!rt.stream) { say("先点「开始学习」打开摄像头，再校准。"); return; }
    await runCalibration();
  };
  bindSeg("#segSens", (v) => (settings.sens = v));
  bindSeg("#segRemind", (v) => { settings.remind = v; setVoiceMuted(v === "bubble"); });

  // 提醒语音：设置和监督页两处下拉共用同一套逻辑，换一处两处都跟着变
  $("#selVoice").onchange = onVoiceSelect;
  $("#selVoiceMonitor").onchange = onVoiceSelect;
  $("#btnVoiceTest").onclick = () => previewVoice($("#selVoice").value);
  $("#btnVoiceTestMonitor").onclick = () => previewVoice($("#selVoiceMonitor").value);
  onVoicesChanged(() => fillVoiceOptions());   // 系统语音异步到齐后刷新两处下拉

  // 背景音
  $$("#ambSeg button").forEach((b) => {
    b.onclick = () => {
      setAmb(b.dataset.amb);
      if (b.dataset.amb !== "off") say("放点背景音，写着更静。");
    };
  });
  $("#ambVol").addEventListener("input", (e) => setAmbVol(e.target.value));
  setAmbVol(settings.ambVol);
  if (settings.amb !== "off") setAmb(settings.amb);
  else syncAmbUi();
  $("#chkPhone").onchange = (e) => (settings.phone = e.target.checked);
  $("#chkPosture").onchange = (e) => {
    settings.posture = e.target.checked;
    if (!settings.posture) { rt.pending = null; rt.posture = { down: false, side: false, up: false, tired: false, yawDev: 0, pitchDev: 0 }; }
  };
  $("#chkAI").onchange = (e) => {
    settings.aiReview = e.target.checked;
    if (settings.aiReview) initVision().catch(() => {});   // 打开时预热一次模型目录
  };
  $("#chkBreak").onchange = (e) => (settings.superviseBreak = e.target.checked);
  $("#chkYolo").onchange = (e) => {
    settings.yolo = e.target.checked;
    if (settings.yolo) {
      yolo.err = ""; yolo.last = 0;      // 重新允许加载 / 立刻跑一次
      initYolo();
    }
  };

  // 演示
  $$("[data-demo]").forEach((b) => {
    b.onclick = () => {
      $$("[data-demo]").forEach((x) => x.classList.toggle("on", x === b));
      rt.demo = b.dataset.demo;
      if (!rt.running) startSession("demo");
      else if (rt.mode === "demo") say("演示：" + b.textContent.replace("演示·", ""));
    };
  });

  // 定时器
  timerId = setInterval(tickTimer, 250);
  renderPhaseUi();
  renderToday();
  renderFoot();
  applySettingsToUi();
  syncTransport();
  updateMovable();
  // 地址加 ?view=monitor 等可直接打开某页（方便验收），默认还是小屋
  const wantedView = new URLSearchParams(location.search).get("view");
  switchView(["home", "plan", "rhythm", "monitor"].includes(wantedView) ? wantedView : "home");

  window.addEventListener("resize", () => pixelScene?.place());
  window.addEventListener("beforeunload", () => { if (rt.running) commitSession(); });

  // 调试入口：地址加 ?debug 后可手动切阶段，方便测试
  if (location.search.includes("debug")) {
    window.__fb = {
      rt,
      settings,
      pixelScene,
      plans: () => plans,
      nextPhase,
      startSession,
      endSession,
      knockFish,
      refinePhone,
      cropPhoneDetect,
      crop,
      maybeAiReview,
      updateAiHud,
      updateYoloHud,
      visionState,
      initVision,
      reviewFrame,
      detector,
      yolo,
      yoloTick,
      initYolo,
      handRegion,
      yoloDet: () => _yoloDet,
    };
  }
}

/* 摄像头预览常驻：页面一打开就尝试不启动，只有开始学习时才请求 */

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();

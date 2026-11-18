/**
 * voice.js — 提醒语音「用谁来说」
 *
 * 三套离线配音（固定台词预生成 MP3，播放不联网）——也是下拉里仅有的三个选项：
 *   1) 云扬（专业沉稳男声）—— assets/voice/v_*.mp3    + voice-map.js
 *   2) 云夏（可爱童声）    —— assets/voice/xia_*.mp3  + voice-map-xia.js
 *   3) 云希（阳光男声）    —— assets/voice/xi_*.mp3   + voice-map-xi.js
 * 不再提供「跟随系统默认」或系统音色选项；系统 speechSynthesis 仅在内部用于
 * 没预录的句子（带变量的台词）兜底，用户看不到也选不到。
 *
 * 统一入口 speakText()：命中对应 MP3 就播本地音频，没预录的再回退系统语音
 * （云夏挑女声、云扬/云希挑男声兜底），保证每句字幕都有声音；
 * 选「只看字」则完全静音。换音色 / 试听都即时生效并记住。
 *
 * 要加新台词：编辑 assets/voice/生成配音.py 的 LINES，
 * 跑 python assets/voice/生成配音.py --all 重新生成三套。
 */

import { VOICE_MAP as YUNYANG_MAP } from "./voice-map.js";
import { VOICE_MAP as YUNXIA_MAP } from "./voice-map-xia.js";
import { VOICE_MAP as YUNXI_MAP } from "./voice-map-xi.js";

const KEY = "fb.voice.v2";
const OFFLINE_URI = "offline-yunyang";
const OFFLINE_XIA_URI = "offline-yunxia";
const OFFLINE_XI_URI = "offline-yunxi";

/** 三套离线配音：label 直接给下拉显示，避免再被 genderHint 重复加标注 */
const OFFLINE_VOICES = [
  { voiceURI: OFFLINE_URI,     name: "云扬（离线配音）",       label: "（男）云扬（离线配音） · zh-CN", lang: "zh-CN", map: YUNYANG_MAP, preferFemale: false },
  { voiceURI: OFFLINE_XIA_URI, name: "云夏（离线配音·童声）", label: "（童）云夏（离线配音） · zh-CN", lang: "zh-CN", map: YUNXIA_MAP,  preferFemale: true  },
  { voiceURI: OFFLINE_XI_URI,  name: "云希（离线配音）",       label: "（男）云希（离线配音） · zh-CN", lang: "zh-CN", map: YUNXI_MAP,   preferFemale: false },
];
const OFFLINE_VOICE = OFFLINE_VOICES[0];
const OFFLINE_URIS = new Set(OFFLINE_VOICES.map((v) => v.voiceURI));

/** 当前选中（或试听临时指定）的离线音色；不是离线项就返回 null */
function offlineOf(uri) {
  const key = uri == null ? selected : uri;
  return OFFLINE_VOICES.find((v) => v.voiceURI === key) || null;
}

/** 系统语音的默认音色：比系统默认略低、略慢，听起来更像「认真提醒」而非播报 */
const DEFAULT_TONE = { rate: 0.96, pitch: 0.92, volume: 0.82 };

let voices = [];
let selected = "";
let useOffline = true;    // 当前选的是不是某套离线配音（云扬 / 云夏 / 云希）
let inited = false;
let autoPicked = false;   // 只在「从没选过音色」时自动挑一次
let chosenBefore = false; // localStorage 里已经有记录（旧版的空串/系统音色会在 initVoice 迁移回云扬）
const listeners = new Set();

function synth() {
  return typeof window !== "undefined" && window.speechSynthesis ? window.speechSynthesis : null;
}

/** 名字里能看出性别的，给个中文标注，方便用户直接挑「男声」 */
function genderHint(name) {
  const n = String(name);
  if (/Yunxi|Yunyang|Yunjian|Yunye|Yunfeng|Yunhao|Kangkang|云希|云扬|云健|云野|云枫|云浩|康康/i.test(n)) return "（男）";
  if (/Yunxia|云夏/i.test(n)) return "（童）";
  if (/Xiaoxiao|Xiaoyi|Xiaohan|Xiaomo|Xiaoxuan|Xiaorui|Xiaobei|Xiaoni|Huihui|Yaoyao|晓|曉/i.test(n)) return "（女）";
  return "";
}

/** 第一次用（还没选过）时默认选云扬离线配音，不落回系统那个女声 */
function pickPreferred() { return OFFLINE_VOICE; }

function refresh() {
  const s = synth();
  if (!s) return;
  const all = s.getVoices() || [];
  if (!all.length) return;
  const zh = (v) => /^zh/i.test(v.lang || "");
  voices = all.slice().sort((a, b) => {
    const za = zh(a) ? 0 : 1, zb = zh(b) ? 0 : 1;
    if (za !== zb) return za - zb;
    return String(a.name).localeCompare(String(b.name));
  });
  // 还没选过音色：默认落到云扬离线配音，只自动挑一次
  if (!chosenBefore && !selected && !autoPicked) {
    autoPicked = true;
    const p = pickPreferred();
    if (p) setSelectedVoice(p.voiceURI);
  }
  listeners.forEach((fn) => { try { fn(voices); } catch (_) {} });
}

/** 启动时调一次：读回上次选择，并监听系统语音列表变化（异步加载） */
export function initVoice() {
  if (inited) return;
  inited = true;
  try {
    const v = localStorage.getItem(KEY);
    chosenBefore = v !== null;
    selected = v || "";
  } catch (_) { selected = ""; }
  // 只认三套离线音色；历史遗留的「跟随系统默认」(空串) 或某个系统音色
  // 现在下拉里已经没有了，一律迁移回默认云扬，避免选中项对不上任何选项。
  if (!OFFLINE_URIS.has(selected)) {
    selected = OFFLINE_URI;
    try { localStorage.setItem(KEY, selected); } catch (_) {}
  }
  useOffline = OFFLINE_URIS.has(selected);
  refresh();
  const s = synth();
  if (!s) return;
  try {
    s.addEventListener("voiceschanged", refresh);
  } catch (_) {
    s.onvoiceschanged = refresh;      // 老浏览器只有这个属性
  }
}

/** 可选音色：仅三套离线配音（不暴露系统语音） */
export function listVoices() { return OFFLINE_VOICES.slice(); }

/** 订阅语音列表变化（语音是异步加载的，面板打开时可能还是空的） */
export function onVoicesChanged(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getSelectedVoice() { return selected; }

/** 下拉里显示的一行文字：离线项用自带 label；系统项加男/女/童标注 + 名字 + 语言 */
export function labelOf(v) {
  if (v.label) return v.label;
  return `${genderHint(v.name)}${v.name}${v.lang ? " · " + v.lang : ""}`;
}

/** 只接受三套离线配音的 URI；其它值（含空串）一律回退默认云扬 */
export function setSelectedVoice(uri) {
  selected = OFFLINE_URIS.has(uri) ? uri : OFFLINE_URI;
  useOffline = true;
  try {
    localStorage.setItem(KEY, selected);
  } catch (_) { /* 隐私模式下写不了也不影响本次生效 */ }
}

function pickVoice(uri) {
  const want = uri == null ? selected : uri;
  if (!want) return null;
  return voices.find((v) => v.voiceURI === want) || voices.find((v) => v.name === want) || null;
}

let pendingSpeak = 0;
let muted = false;        // 「只看字」模式：字幕照常显示，只是不朗读
let offlineAudio = null;  // 复用同一个 <audio>，不必每句话建一个

/** 设置里选「只看字」时静音；默认所有字幕都朗读 */
export function setVoiceMuted(value) { muted = !!value; }
export function isVoiceMuted() { return muted; }

/** 播本地 MP3；map 传对应音色的映射，命中返回 true，没预录就返回 false 交给系统语音兜底 */
function playOffline(text, map) {
  const src = map[text];
  if (!src) return false;
  try {
    if (!offlineAudio) {
      offlineAudio = new Audio();
      offlineAudio.preload = "auto";
    }
    offlineAudio.pause();
    offlineAudio.src = src;
    offlineAudio.currentTime = 0;
    offlineAudio.playbackRate = 0.96;   // 与原来系统语音的语速一致
    offlineAudio.volume = DEFAULT_TONE.volume;
    const p = offlineAudio.play();
    if (p && typeof p.catch === "function") p.catch(() => {});  // 被浏览器拦了就静音
  } catch (_) { return false; }
  return true;
}

/** 朗读一句话；voiceURI 传值可临时指定（试听用），不传就用记住的那个。
 *  离线音色命中对应映射时播本地 MP3（不联网），其余走 speechSynthesis。
 *  opts.forceSystem = true 可强制用系统语音（试听别的音色时用）。 */
export function speakText(text, opts = {}) {
  if (!text || muted) return;
  clearTimeout(pendingSpeak);        // 撤掉上一句还没交付的系统语音，避免两种声音叠一起
  const off = opts.forceSystem ? null : offlineOf(opts.voiceURI);
  if (off && playOffline(text, off.map)) {
    const s = synth();
    if (s) { try { s.cancel(); } catch (_) {} }
    return;
  }
  if (offlineAudio) { try { offlineAudio.pause(); } catch (_) {} }
  if (!("speechSynthesis" in window) || !window.SpeechSynthesisUtterance) return;
  const s = synth();
  if (!s) return;
  try {
    const u = new SpeechSynthesisUtterance(String(text));
    let v = pickVoice(OFFLINE_URIS.has(opts.voiceURI) ? "" : opts.voiceURI);
    if (!v && off && !opts.voiceURI) {
      // 离线音色没预录的句子（比如带数字的台词）：按音色挑中文男声 / 女声兜底
      const zh = (x) => /^zh/i.test(x.lang || "");
      const want = off.preferFemale ? "（女）" : "（男）";
      v = voices.find((x) => zh(x) && genderHint(x.name) === want)
       || voices.find((x) => zh(x) && (want === "（男）" || genderHint(x.name) === "（童）"))
       || voices.find(zh) || null;
    }
    if (v) { u.voice = v; u.lang = v.lang || "zh-CN"; }
    else u.lang = "zh-CN";
    u.rate = opts.rate ?? DEFAULT_TONE.rate;
    u.pitch = opts.pitch ?? DEFAULT_TONE.pitch;
    u.volume = opts.volume ?? DEFAULT_TONE.volume;
    s.cancel();                       // 新的一句顶掉还没说完的旧句
    pendingSpeak = setTimeout(() => {
      try { s.speak(u); } catch (_) {}
    }, 60);                           // Chrome 里 cancel 后立刻 speak 偶尔吞句
  } catch (_) { /* 没有语音引擎时只显示文字 */ }
}

/** 试听：离线音色优先放对应本地 MP3；试听别的音色强制走系统语音。
 *  试听是主动要点一下，所以不受「只看字」静音影响。 */
export function previewVoice(uri, text = "手机放下，我们先把这一章看完。") {
  const wasMuted = muted;
  muted = false;
  const off = OFFLINE_URIS.has(uri) ? offlineOf(uri) : null;
  if (off) {
    if (!playOffline(text, off.map)) speakText(text, { forceSystem: true });
  } else {
    if (!voices.length) refresh();
    speakText(text, { voiceURI: uri, forceSystem: true });
  }
  muted = wasMuted;
}

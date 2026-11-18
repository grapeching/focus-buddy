/**
 * vision-ai.js — 视觉大模型复核（云端，免密钥）
 *
 * 本地 COCO-SSD 只能回答「画面里有像手机的东西」，分不清「拿在手里看」和「平放在桌上」，
 * 更分不清「低头看书」和「低头看手机」。这一层只在灰区抽一帧送视觉模型，用固定 JSON
 * 提示词要一个结构化结论，再由 app.js 映射成原有的 reason（phone / away / focus）。
 *
 * - 走 WorkBuddy 云服务的免密钥通道，前端不持有任何长期密钥
 * - 调用前由 app.js 控制节流，这里只负责「发一帧、拿结论」
 * - 任何失败都只降级为「本轮不复核」，绝不打断本地检测
 */

const CFG = {
  endpoint: "https://wbapp-nrzwxlfmdc04y5gqucqys8.app.workbuddy.host",
  publishableKey: "wbpk_NrzwXlfMDc04y5GQUcQYs8_G9hl4mGNFWbN2cDFdfedBEOrGVh5Ic1t",
  sdkUrl: "assets/vendor/workbuddy-cloud.global.js",
  // 优先挑这些模型；找不到就用目录里第一个支持图片的
  prefer: ["fast-model", "balanced-model", "deep-model"],
  maxSide: 768,          // 送模型的图片宽度
  jpegQuality: 0.72,
  timeoutMs: 15000,
};

const SYSTEM_PROMPT = "你是学习监督助手的视觉判断模块，只输出 JSON，不要任何解释。";

const USER_PROMPT = [
  "输入是一帧学生书桌前的摄像头画面，机位在正前方偏上。判断学生此刻是否在座位上认真学习，重点识别手机的存在与使用状态。",
  "一、手机位置：handheld（被手握着、屏幕朝向学生、靠近面部或胸口）/ on_desk（平放在桌面或桌角，无手触碰）/ none（画面中看不到手机）。",
  "二、使用迹象：手指在屏幕上滑动点击、屏幕亮起且朝向学生、头部低垂且手中持物。",
  "三、人在座位的证据（关键）：低头时摄像头常常只拍到头顶、后脑勺、头发、额头一角、肩膀、手臂或身体轮廓，看不到完整人脸是低头的正常现象，不代表人离开了。只要画面出现上述任一人体部分，或能看到人坐着、手放在桌面或书本附近，就判定人仍在座位，head_down 设为 true。",
  "四、学习状态：有书、笔、笔记本、键盘，且手在书写或操作，或身体前倾朝向桌面，都算学习，verdict 倾向 focus。",
  "严格只输出 JSON，字段名与顺序不得改动：",
  '{"phone_present":true,"phone_location":"handheld|on_desk|none","phone_in_use":true,"phone_confidence":0.0,"study_materials_visible":true,"head_down":false,"verdict":"focus|phone_distraction|away|unclear","reason":"一句中文说明"}',
  "判定规则：handheld 且 phone_in_use=true → phone_distraction；on_desk 且无人触碰 → 不算分心，verdict 仍为 focus；",
  "低头（head_down=true）但手中无手机、身体在座位、手在桌面学习材料附近 → focus，绝不判 away；",
  "只有画面里完全看不到任何人体部分（只剩空桌、空椅、背景），或有明确起身离开的动作 → away；",
  "画面过暗过糊信息不足 → unclear，不要猜；置信度 < 0.6 一律 unclear（宁可漏判，不可误判）。",
].join("\n");

export const visionState = {
  ready: false,
  model: "",
  busy: false,
  error: "",
  calls: 0,
  at: 0,          // 最近一次结论的时间戳
  lastTry: 0,     // 最近一次发起的时间戳
  ms: 0,
  verdict: "",
  location: "",
  inUse: false,
  confidence: 0,
  reason: "",
};

let client = null;
let sdkPromise = null;

/* ---------------- 初始化 ---------------- */

function loadSdk() {
  if (window.WorkBuddyCloud) return Promise.resolve(window.WorkBuddyCloud);
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = CFG.sdkUrl;
    s.async = true;
    s.onload = () => (window.WorkBuddyCloud ? resolve(window.WorkBuddyCloud) : reject(new Error("SDK 未挂载")));
    s.onerror = () => reject(new Error("SDK 加载失败"));
    document.head.appendChild(s);
  }).catch((e) => { sdkPromise = null; throw e; });
  return sdkPromise;
}

/** 懒加载：第一次真正要复核时才拉 SDK 和模型目录，不影响本地检测启动 */
export async function initVision() {
  if (visionState.ready) return true;
  try {
    const WB = await loadSdk();
    if (!client) {
      client = WB.createWorkBuddyCloud({ endpoint: CFG.endpoint, publishableKey: CFG.publishableKey });
    }
    const models = await client.llm.models.list();
    const usable = (models || []).filter((m) => m.disabled !== true && m.enabled !== false && m.supportsImages === true);
    if (!usable.length) {
      visionState.error = "没有可用的视觉模型";
      return false;
    }
    const preferred = CFG.prefer.map((id) => usable.find((m) => m.id === id)).find(Boolean);
    const picked = preferred || usable[0];
    visionState.model = picked.id;
    visionState.ready = true;
    visionState.error = "";
    return true;
  } catch (e) {
    visionState.error = friendly(e);
    return false;
  }
}

/* ---------------- 抽帧 ---------------- */

/**
 * 从 video 的指定区域抽一帧压成 dataURL。
 * rect 用归一化坐标（0~1），与本地裁剪检测共用同一块区域。
 */
export function captureFrame(video, rect) {
  if (!video || !video.videoWidth) return "";
  const vw = video.videoWidth, vh = video.videoHeight;
  const sx = Math.round(vw * rect.x0);
  const sy = Math.round(vh * rect.y0);
  const sw = Math.max(8, Math.round(vw * (rect.x1 - rect.x0)));
  const sh = Math.max(8, Math.round(vh * (rect.y1 - rect.y0)));
  const cv = captureFrame._cv || (captureFrame._cv = document.createElement("canvas"));
  const scale = Math.min(1, CFG.maxSide / sw);
  cv.width = Math.max(8, Math.round(sw * scale));
  cv.height = Math.max(8, Math.round(sh * scale));
  const g = cv.getContext("2d");
  g.imageSmoothingEnabled = true;
  g.drawImage(video, sx, sy, sw, sh, 0, 0, cv.width, cv.height);
  return cv.toDataURL("image/jpeg", CFG.jpegQuality);
}

/* ---------------- 判定 ---------------- */

function parseJson(text) {
  if (!text) return null;
  let s = text.trim();
  // 去掉 ```json 围栏和前后杂字
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  const i = s.indexOf("{"), j = s.lastIndexOf("}");
  if (i >= 0 && j > i) s = s.slice(i, j + 1);
  try { return JSON.parse(s); } catch (_) { return null; }
}

function friendly(e) {
  const code = e?.error?.code || "";
  if (code.startsWith("quota_")) return code === "quota_rate_limited" ? "被限流，稍后自动重试" : "额度不足";
  if (code.startsWith("auth_")) return "通道鉴权失败";
  if (code.startsWith("gateway_") || code.startsWith("model_")) return "模型暂时不可用";
  if (code.startsWith("request_")) return "请求参数被拒";
  return e?.error?.message || e?.message || "调用失败";
}

/**
 * 送一帧给视觉模型，返回结构化结论或 null。
 * 调用方负责节流；这里保证同一时刻只有一个请求在飞。
 */
export async function reviewFrame(dataUrl) {
  if (!dataUrl || visionState.busy) return null;
  if (!visionState.ready && !(await initVision())) return null;

  visionState.busy = true;
  visionState.lastTry = performance.now();
  const t0 = performance.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), CFG.timeoutMs);

  try {
    let text = "";
    for await (const ch of client.llm.chat.completions.create({
      model: visionState.model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: [
          { type: "text", text: USER_PROMPT },
          { type: "image_url", image_url: { url: dataUrl } },
        ] },
      ],
      stream: true,
      temperature: 0,
      signal: ac.signal,
    })) {
      const d = ch.choices?.[0]?.delta?.content;
      if (d) text += d;
    }

    const j = parseJson(text);
    visionState.ms = Math.round(performance.now() - t0);
    visionState.calls += 1;
    visionState.error = "";
    if (!j) {
      visionState.verdict = "unclear";
      visionState.reason = "模型返回无法解析";
      return null;
    }
    visionState.at = performance.now();
    visionState.verdict = String(j.verdict || "unclear");
    visionState.location = String(j.phone_location || "none");
    visionState.inUse = !!j.phone_in_use;
    visionState.confidence = Number(j.phone_confidence) || 0;
    visionState.reason = String(j.reason || "");
    return {
      verdict: visionState.verdict,
      location: visionState.location,
      inUse: visionState.inUse,
      confidence: visionState.confidence,
      reason: visionState.reason,
      ms: visionState.ms,
    };
  } catch (e) {
    visionState.error = friendly(e);
    visionState.ms = Math.round(performance.now() - t0);
    return null;
  } finally {
    clearTimeout(timer);
    visionState.busy = false;
  }
}

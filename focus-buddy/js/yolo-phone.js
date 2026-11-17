/**
 * yolo-phone.js —— 开源本地目标检测（YOLO11n ONNX + ONNX Runtime Web WASM）
 *
 * 为什么加这一路：
 *   原来只有 detector.js 里的 COCO-SSD lite（输入 300×300 的 SSDLite MobileNet），
 *   胸前手机在整帧里只占几个百分点，缩到 300 就被抹平了，所以经常"看不到手机"。
 *   YOLO11n 结构更强，而且支持我们自己裁一块区域放大再检测（等效望远镜）。
 *
 * 模型来源（开源，AGPL-3.0 权重来自 Ultralytics）：
 *   alanminu/focus-guard → models/yolo11n.onnx（端侧手机检测，ONNX Runtime 跑在树莓派上）
 *   经 cdn.jsdelivr.net 代理下载后存到 assets/models/yolo/，本地加载、不联网。
 *
 * 只取两类：0 = person，67 = cell phone。其它 78 类直接丢弃。
 * 不改 detector.js，也不改像素小屋；这里只产出一份「检测证据」。
 */

export const YOLO_CFG = {
  modelUrl: "assets/models/yolo/yolo11n.onnx",
  wasmDir: "assets/vendor/ort/",
  input: 640,          // 期望的输入边长；模型是固定 shape 时会自动校准成真实值
  conf: 0.28,          // 低于这个分数的框直接丢
  iou: 0.45,           // NMS 阈值
  maxDet: 40,          // 每类最多保留的框数
};

const CLS_PHONE = 67;   // COCO: cell phone
const CLS_PERSON = 0;   // COCO: person

let _ort = null;
let _session = null;
let _loading = null;
let _canvas = null;
let _ctx = null;
let _size = 0;          // 实际输入边长，建 session 时校准
let _inName = "", _outName = "";

/** 动态加载 ORT 脚本（只在第一次用到时加载 11MB wasm） */
async function loadOrt() {
  if (window.ort && window.ort.InferenceSession) return window.ort;
  if (!document.querySelector("script[data-ort-wasm]")) {
    await new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = `${YOLO_CFG.wasmDir}ort.wasm.min.js`;
      s.dataset.ortWasm = "1";
      s.onload = res;
      s.onerror = () => rej(new Error("ONNX Runtime 脚本加载失败"));
      document.head.appendChild(s);
    });
  }
  if (!window.ort) throw new Error("ONNX Runtime 未就绪");
  return window.ort;
}

/**
 * 创建检测器。重复调用复用同一个 session。
 * @returns {Promise<{run:Function, input:number, dims:Array|null, dispose:Function}>}
 */
export async function createYoloPhone() {
  if (_session) return api();
  if (_loading) return _loading;

  _loading = (async () => {
    const ort = await loadOrt();
    // 单线程 + SIMD：python http.server 不发 COOP/COEP，多线程要 SharedArrayBuffer，
    // 开了反而会直接报错。
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.simd = true;
    // 必须是绝对 URL：相对串会被当成裸模块名去 import，报 specifier 解析失败
    ort.env.wasm.wasmPaths = new URL(YOLO_CFG.wasmDir, location.href).href;
    ort.env.logLevel = "error";
    _ort = ort;

    const session = await ort.InferenceSession.create(YOLO_CFG.modelUrl, {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all",
    });
    _inName = session.inputNames[0];
    _outName = session.outputNames[0];

    // ort-web 1.20 不暴露 inputMetadata，所以先用期望尺寸空跑一次：
    // 尺寸不对会立刻抛 "Expected: 320"，从这里拿到真实值，再校准一次。
    const want = YOLO_CFG.input;
    try {
      await session.run({ [_inName]: zeroTensor(ort, want) });
      _size = want;
    } catch (e) {
      const m = /Expected:\s*(\d+)/.exec(String(e));
      if (!m) throw e;
      _size = Number(m[1]);
      await session.run({ [_inName]: zeroTensor(ort, _size) });   // 按真实尺寸确认一次
    }
    _session = session;
    return api();
  })();

  try {
    return await _loading;
  } catch (e) {
    _loading = null;
    throw e;
  }
}

function zeroTensor(ort, size) {
  return new ort.Tensor("float32", new Float32Array(3 * size * size), [1, 3, size, size]);
}

function api() {
  return {
    run: detect,
    get input() { return _size; },
    get dims() { return [1, 3, _size, _size]; },
    dispose,
  };
}

function dispose() {
  try { _session?.release?.(); } catch (_) {}
  _session = null;
  _loading = null;
  _size = 0;
}

function ensureCanvas(size) {
  if (_canvas && _canvas.width === size) return _canvas;
  _canvas = document.createElement("canvas");
  _canvas.width = size;
  _canvas.height = size;
  _ctx = _canvas.getContext("2d", { willReadFrequently: true });
  return _canvas;
}

/**
 * letterbox 到正方形 + 归一化成 NCHW float32
 * @param region 可选裁剪窗口 {x,y,w,h}（源画面像素），不传就是整帧
 */
function prepare(src, size, region) {
  const vw = src.videoWidth || src.width || 0;
  const vh = src.videoHeight || src.height || 0;
  if (!vw || !vh) throw new Error("画面尺寸为 0（摄像头还没出画）");

  const rg = region || { x: 0, y: 0, w: vw, h: vh };
  const sw = Math.max(1, Math.min(vw - rg.x, rg.w));
  const sh = Math.max(1, Math.min(vh - rg.y, rg.h));

  const r = Math.min(size / sw, size / sh);
  const nw = Math.max(1, Math.round(sw * r));
  const nh = Math.max(1, Math.round(sh * r));
  const dx = Math.floor((size - nw) / 2);
  const dy = Math.floor((size - nh) / 2);

  const cv = ensureCanvas(size);
  _ctx.fillStyle = "#727272";                 // YOLO 官方 letterbox 灰
  _ctx.fillRect(0, 0, size, size);
  _ctx.imageSmoothingEnabled = true;          // 检测要平滑缩放，跟像素小屋的 pixelated 无关
  _ctx.imageSmoothingQuality = "high";
  _ctx.drawImage(src, rg.x, rg.y, sw, sh, dx, dy, nw, nh);

  const px = _ctx.getImageData(0, 0, size, size).data;
  const area = size * size;
  const f = new Float32Array(area * 3);
  for (let i = 0, j = 0; i < area; i++, j += 4) {
    f[i] = px[j] / 255;
    f[i + area] = px[j + 1] / 255;
    f[i + area * 2] = px[j + 2] / 255;
  }
  return { tensor: new _ort.Tensor("float32", f, [1, 3, size, size]), r, dx, dy,
    x0: rg.x, y0: rg.y, vw, vh, region: { x: rg.x, y: rg.y, w: sw, h: sh } };
}

/** 兼容 [1,84,8400]（属性在前）与 [1,8400,84]（锚点在前）两种导出 */
function decode(out, meta) {
  const dims = out.dims;
  const data = out.data;
  const d1 = dims[1], d2 = dims[2];
  const attrsFirst = d1 <= d2;
  const attrs = attrsFirst ? d1 : d2;
  const anchors = attrsFirst ? d2 : d1;
  const at = (j, i) => (attrsFirst ? data[j * anchors + i] : data[i * attrs + j]);

  const { r, dx, dy, x0, y0, vw, vh } = meta;
  const raw = [];
  for (let i = 0; i < anchors; i++) {
    let best = -1, bestScore = 0;
    for (let j = 4; j < attrs; j++) {
      const s = at(j, i);
      if (s > bestScore) { bestScore = s; best = j - 4; }
    }
    if (best !== CLS_PHONE && best !== CLS_PERSON) continue;
    if (bestScore < YOLO_CFG.conf) continue;

    const cx = at(0, i), cy = at(1, i), w = at(2, i), h = at(3, i);
    // 从 letterbox 坐标反算回原画面像素
    let x1 = (cx - w / 2 - dx) / r + x0;
    let y1 = (cy - h / 2 - dy) / r + y0;
    let x2 = (cx + w / 2 - dx) / r + x0;
    let y2 = (cy + h / 2 - dy) / r + y0;
    x1 = Math.max(0, Math.min(vw, x1)); x2 = Math.max(0, Math.min(vw, x2));
    y1 = Math.max(0, Math.min(vh, y1)); y2 = Math.max(0, Math.min(vh, y2));
    const bw = x2 - x1, bh = y2 - y1;
    if (bw < 2 || bh < 2) continue;
    raw.push({ cls: best, score: bestScore, x1, y1, x2, y2, area: bw * bh });
  }
  return nms(raw);
}

/** 按类别做 NMS */
function nms(list) {
  const keep = [];
  for (const cls of [CLS_PHONE, CLS_PERSON]) {
    const arr = list.filter((b) => b.cls === cls).sort((a, b) => b.score - a.score);
    const picked = [];
    for (const b of arr) {
      let ok = true;
      for (const k of picked) {
        const ix = Math.max(0, Math.min(b.x2, k.x2) - Math.max(b.x1, k.x1));
        const iy = Math.max(0, Math.min(b.y2, k.y2) - Math.max(b.y1, k.y1));
        const inter = ix * iy;
        const uni = b.area + k.area - inter;
        if (uni > 0 && inter / uni > YOLO_CFG.iou) { ok = false; break; }
      }
      if (ok) picked.push(b);
      if (picked.length >= YOLO_CFG.maxDet) break;
    }
    keep.push(...picked);
  }
  return keep;
}

/**
 * 对一帧做检测。
 * @param {HTMLVideoElement|HTMLCanvasElement|HTMLImageElement} src
 * @param {{x:number,y:number,w:number,h:number}} [region] 只看这块区域（源画面像素）
 * @returns {Promise<{phones:Array, persons:Array, best:object|null, ms:number, vw:number, vh:number, region:object}>}
 *   best = {score, box:{x,y,w,h}}（原画面像素坐标），没有就是 null
 */
export async function detect(src, region) {
  if (!_session) await createYoloPhone();
  const t0 = performance.now();

  const meta = prepare(src, _size, region);
  const out = await _session.run({ [_inName]: meta.tensor });
  const boxes = decode(out[_outName], meta);

  const phones = boxes.filter((b) => b.cls === CLS_PHONE)
    .sort((a, b) => b.score - a.score)
    .map((b) => ({ score: b.score, box: { x: b.x1, y: b.y1, w: b.x2 - b.x1, h: b.y2 - b.y1 } }));
  const persons = boxes.filter((b) => b.cls === CLS_PERSON)
    .map((b) => ({ score: b.score, box: { x: b.x1, y: b.y1, w: b.x2 - b.x1, h: b.y2 - b.y1 } }));

  return {
    phones,
    persons,
    best: phones[0] || null,
    ms: Math.round(performance.now() - t0),
    vw: meta.vw,
    vh: meta.vh,
    region: meta.region,
  };
}

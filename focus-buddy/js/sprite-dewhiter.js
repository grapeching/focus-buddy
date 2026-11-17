/**
 * sprite-dewhiter.js — 精灵贴图「边缘去白」预处理
 *
 * 交付包里的猫头鹰 PNG 已经是 alpha 二值化（0/255）的透明底，
 * 白边来自轮廓上「贴着透明区、但自身接近白色」的像素：深色背景一叠，
 * 就晕出一圈白雾。这里在图片交给 DOM 之前，用离屏 Canvas 做一次预处理：
 *
 *   1) 只遍历当前不透明、且四邻域里至少有一个透明像素的「边缘像素」；
 *   2) 若该像素 RGB 三通道均 > 200 且 max - min < 30（近白），把它设为透明；
 *   3) 同一轮先收集再统一写入，迭代 2~3 轮，吃掉多层白边；
 *   4) 内部区域（含眼睛高光）四邻域全不透明，永远不会被碰到。
 *
 * 约束：原始 PNG 文件一个字节都不改；离屏 Canvas 关闭 imageSmoothingEnabled，
 * 全程 globalAlpha = 1，输出仍是无损 PNG，交给 <img> 后继续走
 * image-rendering: pixelated 最近邻缩放。
 */

/* 去白轮数：2~3 轮都够，取 3 以吃掉较厚的白边；每轮无命中会提前结束 */
const PASSES = 3;
/* 近白判定：三通道均 > 200 且极差 < 30 */
const WHITE_MIN = 200;
const CHROMA_MAX = 30;
/* alpha 二值化素材：0 透明 / 255 不透明，128 只作稳健兜底 */
const ALPHA_CUTOFF = 128;

/** rawSrc -> { state, url, waiters, removed, passes } */
const cache = new Map();

/** 在离屏 Canvas 上完成去白，返回 { canvas, removed }；无需处理时返回 null */
function dewhiteOnCanvas(img) {
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (!w || !h) return null;

  const cv = document.createElement("canvas");
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;

  // 严禁双线性：缩放/重绘都保持最近邻，避免白像素被晕成一圈白雾
  ctx.imageSmoothingEnabled = false;
  // 不以 globalAlpha < 1 叠加精灵
  ctx.globalAlpha = 1;
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0);

  let imageData;
  try {
    imageData = ctx.getImageData(0, 0, w, h);
  } catch (_) {
    // 极端环境（跨域 / 无 Canvas 权限）下静默回退原图
    return null;
  }
  const data = imageData.data;
  const at = (x, y) => (y * w + x) * 4;
  const isClear = (x, y) =>
    x < 0 || y < 0 || x >= w || y >= h || data[at(x, y) + 3] < ALPHA_CUTOFF;
  const isNearWhite = (i) => {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    return r > WHITE_MIN && g > WHITE_MIN && b > WHITE_MIN &&
      Math.max(r, g, b) - Math.min(r, g, b) < CHROMA_MAX;
  };

  let removed = 0;
  for (let pass = 0; pass < PASSES; pass++) {
    const victims = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = at(x, y);
        if (data[i + 3] < ALPHA_CUTOFF) continue;        // 本就透明
        // 四邻域必须至少有一个透明像素：只碰轮廓，不碰内部/眼睛高光
        if (!(isClear(x - 1, y) || isClear(x + 1, y) ||
              isClear(x, y - 1) || isClear(x, y + 1))) continue;
        if (!isNearWhite(i)) continue;                   // 只去近白
        victims.push(i + 3);                             // 存 alpha 通道下标
      }
    }
    if (!victims.length) break;                          // 没有白边了，提前收工
    for (const ai of victims) {
      data[ai] = 0;
      removed++;
    }
  }
  if (!removed) return null;

  ctx.putImageData(imageData, 0, 0);
  return { canvas: cv, removed };
}

/** Canvas -> 无损 PNG URL；优先 objectURL（无 base64 解码开销），失败回退 dataURL */
function exportUrl(canvas, done) {
  try {
    if (typeof canvas.toBlob === "function") {
      canvas.toBlob((blob) => {
        done(blob ? URL.createObjectURL(blob) : canvas.toDataURL("image/png"));
      }, "image/png");
      return;
    }
  } catch (_) { /* 落到 dataURL */ }
  try {
    done(canvas.toDataURL("image/png"));
  } catch (_) {
    done(null);
  }
}

/**
 * 取一张「已去白」的精灵地址。
 * - 首次调用：异步加载原图 -> 去白 -> 缓存结果，期间先返回原图地址；
 * - 就绪后通过 onReady(url, rawSrc) 通知调用方替换；
 * - 之后调用：同步返回缓存地址，并立即回调 onReady。
 *
 * @param {string} rawSrc      原始 PNG 路径
 * @param {Function} onReady   就绪回调 (url, rawSrc) => void，可选
 * @returns {string} 现在就能用的 src（未就绪时是原图）
 */
export function prepareSprite(rawSrc, onReady) {
  if (!rawSrc) return rawSrc;

  let entry = cache.get(rawSrc);
  if (!entry) {
    entry = { state: "loading", url: rawSrc, waiters: [], removed: 0, passes: PASSES };
    cache.set(rawSrc, entry);

    const img = new Image();
    img.onload = () => {
      let result = null;
      try {
        result = dewhiteOnCanvas(img);
      } catch (_) { /* 回退原图 */ }

      const finish = (url) => {
        entry.state = "done";
        entry.url = url || rawSrc;
        entry.removed = result ? result.removed : 0;
        const waiters = entry.waiters;
        entry.waiters = [];
        waiters.forEach((fn) => {
          try { fn(entry.url, rawSrc); } catch (_) { /* 单个调用方出错不影响别人 */ }
        });
      };

      if (result) exportUrl(result.canvas, finish);
      else finish(rawSrc);
    };
    img.onerror = () => {
      entry.state = "done";
      entry.url = rawSrc;
      const waiters = entry.waiters;
      entry.waiters = [];
      waiters.forEach((fn) => {
        try { fn(rawSrc, rawSrc); } catch (_) { /* noop */ }
      });
    };
    img.src = rawSrc;
  }

  if (entry.state === "done") {
    if (typeof onReady === "function") onReady(entry.url, rawSrc);
    return entry.url;
  }
  if (typeof onReady === "function") entry.waiters.push(onReady);
  return rawSrc;
}

/** 调试 / 浏览器验收用：每张图的去白统计 */
export function spriteDewhiteStats() {
  const out = {};
  cache.forEach((entry, rawSrc) => {
    out[rawSrc] = {
      state: entry.state,
      removed: entry.removed,
      passes: entry.passes,
      fromBlob: entry.url.startsWith("blob:"),
    };
  });
  return out;
}

if (typeof window !== "undefined") {
  window.__spriteDewhite = { prepareSprite, spriteDewhiteStats, cache };
}

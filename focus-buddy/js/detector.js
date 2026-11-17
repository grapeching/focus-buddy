/**
 * detector.js — 把摄像头画面变成「专注 / 分心」的判断依据
 *
 * 三个信号：
 *  1. 人脸是否存在（是否还在座位上）
 *  2. 头部朝向（低头看手机 / 转头 / 抬头）—— 用面部关键点算法向量，纯几何，符号无歧义
 *  3. 画面里有没有手机 —— COCO-SSD 物体检测
 *
 * 模型全部放在本地 assets/ 目录，第一次打开不用联网也不会卡住。
 * 全部在本机浏览器内计算，不上传任何画面。
 */

const LOCAL = {
  bundle: "assets/mediapipe/vision_bundle.js",
  wasm: "assets/mediapipe/wasm",
  model: "assets/models/face_landmarker.task",
  phoneModel: "assets/models/coco-ssd/model.json",
};

const CDN = {
  bundle: "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs",
  wasm: "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm",
  model: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
};

// MediaPipe FaceMesh 关键点索引
const IDX = { eyeR: 33, eyeL: 263, nose: 1, chin: 152, forehead: 10 };

/** 按路径加载一套 MediaPipe 资源，失败则抛错 */
async function loadFaceKit(bundleUrl, wasmUrl, modelUrl, log) {
  const abs = (u) => new URL(u, location.href).href;
  const mp = await import(/* webpackIgnore: true */ abs(bundleUrl));
  const fileset = await mp.FilesetResolver.forVisionTasks(abs(wasmUrl));

  const opts = (delegate) => ({
    baseOptions: { modelAssetPath: modelUrl, delegate },
    runningMode: "VIDEO",
    numFaces: 2,
    minFaceDetectionConfidence: 0.45,
    minFacePresenceConfidence: 0.45,
    minTrackingConfidence: 0.45,
    outputFaceBlendshapes: true,
  });

  try {
    return await mp.FaceLandmarker.createFromOptions(fileset, opts("GPU"));
  } catch (e) {
    log("GPU 不可用，改用 CPU 模式…");
    return await mp.FaceLandmarker.createFromOptions(fileset, opts("CPU"));
  }
}

export class FocusDetector {
  constructor() {
    this.face = null;
    this.coco = null;
    this.faceReady = false;
    this.cocoReady = false;
    this.lastVideoTime = -1;
    this.lastCocoAt = 0;

    this.phone = { hit: false, score: 0, box: null };

    // 平滑后的观测值
    this.smooth = { yaw: 0, pitch: 0, roll: 0, blink: 0 };
    this.smoothInit = false;

    this.out = {
      ok: false,
      faceCount: 0,
      yaw: 0,        // >0 头转向画面右侧
      pitch: 0,      // >0 低头
      roll: 0,
      blink: 0,      // 0~1 闭眼程度
      phone: 0,      // 0~1 手机置信
      phoneBox: null,
      box: null,
      ts: 0,
    };
  }

  /** 加载人脸模型（优先本地，本地失败再走 CDN） */
  async initFace(log = () => {}) {
    log("正在准备人脸识别内核…");

    try {
      this.face = await loadFaceKit(LOCAL.bundle, LOCAL.wasm, LOCAL.model, log);
    } catch (e) {
      console.warn("[face] 本地资源加载失败，改用 CDN：", e && e.message ? e.message : e);
      log("本地模型异常，正在从网络加载…");
      this.face = await loadFaceKit(CDN.bundle, CDN.wasm, CDN.model, log);
    }

    this.faceReady = true;
    log("人脸识别就绪");
  }

  /** 加载手机检测模型（失败不影响主流程） */
  async initPhone(log = () => {}) {
    if (typeof cocoSsd === "undefined" || typeof tf === "undefined") {
      log("手机检测不可用（模型未加载）");
      return false;
    }
    try {
      log("正在加载手机检测模型…");
      try { await tf.setBackend("webgl"); } catch (_) {}
      await tf.ready();
      const modelUrl = new URL(LOCAL.phoneModel, location.href).href;
      try {
        this.coco = await cocoSsd.load({ base: "lite_mobilenet_v2", modelUrl });
      } catch (e) {
        console.warn("[coco-ssd] 本地权重失败，回退默认地址", e);
        this.coco = await cocoSsd.load({ base: "lite_mobilenet_v2" });
      }
      this.cocoReady = true;
      log("手机检测就绪");
      return true;
    } catch (e) {
      console.warn("[coco-ssd] 加载失败", e);
      log("手机检测加载失败，仅用姿态判断");
      return false;
    }
  }

  /**
   * 处理一帧
   * @param {HTMLVideoElement} video
   * @param {number} now performance.now()
   * @param {boolean} wantPhone 是否跑手机检测
   */
  tick(video, now, wantPhone = true) {
    if (!this.faceReady || video.readyState < 2) return this.out;
    if (video.currentTime === this.lastVideoTime) return this.out;

    let res;
    try {
      res = this.face.detectForVideo(video, now);
    } catch (e) {
      return this.out;
    }
    this.lastVideoTime = video.currentTime;

    const lm = res.faceLandmarks && res.faceLandmarks[0];
    const W = video.videoWidth || 640;
    const H = video.videoHeight || 480;

    let yaw = 0, pitch = 0, roll = 0, blink = 0, box = null;

    if (lm && lm.length > 400) {
      const pose = this.#headPose(lm, W, H);
      yaw = pose.yaw;
      pitch = pose.pitch;
      roll = pose.roll;

      // 眨眼：睁眼程度（blendshape 0=睁 1=闭）
      const bs = res.faceBlendshapes && res.faceBlendshapes[0];
      if (bs && bs.categories) {
        let l = 0, r = 0;
        for (const c of bs.categories) {
          if (c.categoryName === "eyeBlinkLeft") l = c.score;
          else if (c.categoryName === "eyeBlinkRight") r = c.score;
        }
        blink = (l + r) / 2;
      }

      box = this.#bbox(lm, W, H);
    }

    // 平滑（一阶低通），抑制关键点抖动
    const a = this.smoothInit ? 0.42 : 1;
    this.smooth.yaw += (yaw - this.smooth.yaw) * a;
    this.smooth.pitch += (pitch - this.smooth.pitch) * a;
    this.smooth.roll += (roll - this.smooth.roll) * a;
    this.smooth.blink += (blink - this.smooth.blink) * a;
    this.smoothInit = true;

    // 手机检测（低频）
    if (wantPhone && this.cocoReady && now - this.lastCocoAt > 420) {
      this.lastCocoAt = now;
      this.#detectPhone(video);
    }
    // 手机置信度缓慢衰减，避免单帧抖动
    if (!this.cocoReady) this.phone.score = 0;
    else this.phone.score = Math.max(0, this.phone.score - 0.022);

    this.out.ok = true;
    this.out.faceCount = res.faceLandmarks ? res.faceLandmarks.length : 0;
    this.out.yaw = this.smooth.yaw;
    this.out.pitch = this.smooth.pitch;
    this.out.roll = this.smooth.roll;
    this.out.blink = this.smooth.blink;
    this.out.phone = this.phone.score;
    this.out.phoneBox = this.phone.box;
    this.out.box = box;
    this.out.ts = now;
    return this.out;
  }

  /**
   * 头部姿态：用面部关键点构造正交坐标系，取面法向量
   *  法向量 n = (眼线向量) × (下巴→额头向量)
   *  正面朝屏幕时 n ≈ (0, 0, -1)
   *  → pitch > 0 表示低头，yaw > 0 表示转向画面右侧
   */
  #headPose(lm, W, H) {
    // 统一到像素尺度：MediaPipe 的 z 与 x 同尺度
    const P = (i) => ({ x: lm[i].x * W, y: lm[i].y * H, z: lm[i].z * W });

    const R = P(IDX.eyeR), L = P(IDX.eyeL), F = P(IDX.forehead), C = P(IDX.chin);

    const ax = L.x - R.x, ay = L.y - R.y, az = L.z - R.z;   // 横向
    const bx = F.x - C.x, by = F.y - C.y, bz = F.z - C.z;   // 纵向（向上）

    let nx = ay * bz - az * by;
    let ny = az * bx - ax * bz;
    let nz = ax * by - ay * bx;

    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;

    // 保证法向量朝摄像头（-z）
    if (nz > 0) { nx = -nx; ny = -ny; nz = -nz; }

    const front = Math.max(0.02, -nz);
    const pitch = Math.atan2(ny, front) * 180 / Math.PI;
    const yaw = Math.atan2(nx, front) * 180 / Math.PI;

    // roll：眼线相对水平线的倾角（歪头）
    const roll = -Math.atan2(L.y - R.y, L.x - R.x) * 180 / Math.PI;

    return { yaw, pitch, roll };
  }

  #bbox(lm, W, H) {
    let x1 = 1e9, y1 = 1e9, x2 = -1e9, y2 = -1e9;
    for (const p of lm) {
      if (p.x < x1) x1 = p.x;
      if (p.x > x2) x2 = p.x;
      if (p.y < y1) y1 = p.y;
      if (p.y > y2) y2 = p.y;
    }
    return { x: x1 * W, y: y1 * H, w: (x2 - x1) * W, h: (y2 - y1) * H };
  }

  async #detectPhone(video) {
    try {
      const preds = await this.coco.detect(video, 8, 0.38);
      let best = null;
      for (const p of preds) {
        if (p.class !== "cell phone") continue;
        if (!best || p.score > best.score) best = p;
      }
      if (best) {
        this.phone.score = Math.min(1, Math.max(this.phone.score, best.score));
        this.phone.box = best.bbox;
        this.phone.hit = true;
      } else {
        this.phone.hit = false;
        this.phone.box = null;
      }
    } catch (_) { /* 忽略单帧失败 */ }
  }

  reset() {
    this.smoothInit = false;
    this.phone = { hit: false, score: 0, box: null };
    this.lastVideoTime = -1;
  }
}

"""新生成精灵的后处理：抠背景 → 裁紧 → 统一配色 → 透明底 PNG。

用法：
    python tools/生成精灵后处理.py <输入目录> <输出目录> [映射表.json]

输入：AI 生成的白底（或透明底）像素风精灵图。
处理：
  1. 从图像边缘把近白背景连通区域抠成透明（保留眼睛内部白色高光）；
  2. 裁剪到不透明像素的紧致包围盒；
  3. 皮毛色映射到与交付包一致的暖棕阶梯（保留描边、眼白高光、
     金色眼镜、红色与冷色配件）；
  4. alpha 二值化（0/255），输出 RGBA PNG。

映射表格式（不传则按文件名关键词自动匹配）：
    {"文件名关键词": "目标文件名.png", ...}
"""
import json
import sys
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image

# 与 docs/素材与声音提示词包.md 第 11 节一致的皮毛阶梯锚点
ANCHORS = [
    (0.27, (69, 48, 30)),
    (0.45, (114, 78, 43)),
    (0.62, (159, 112, 69)),
    (0.75, (192, 145, 98)),
    (0.88, (225, 191, 151)),
    (0.94, (239, 213, 180)),
]
RAMP_V = np.array([a[0] for a in ANCHORS])
RAMP_RGB = np.array([a[1] for a in ANCHORS], dtype=float)

DEFAULT_MAP = {
    "STUDY_POSE": "owl_reading.png",
    "SAME_s": "owl_alert.png",          # 首张试稿：双翅叉腰、严肃看着我
    "NOTICE_POSE": "owl_alert_notice.png",
    "LEAN_IN_POSE": "owl_alert_lean.png",
    "STAND_GUARD_POSE": "owl_alert_stand.png",
    "REACHING_FOR_A_BOOK": "owl_finding_book.png",
    "BOOK_POSE": "owl_finding_book.png",
    "FLYING_POSE": "owl_flying.png",
    "SLEEPING_POSE": "owl_sleeping.png",
    "EATING_ON_A_CHAIR": "owl_eating_bread.png",
    "LOW_OCCLUSION_BED": "furniture_bed.png",
    "LOW_OCCLUSION_BOOKSHELF": "furniture_bookshelf.png",
    "LOW_OCCLUSION_DINING_TABLE": "furniture_table_food.png",
}


def rgb_hsv(rgb):
    a = rgb.astype(float) / 255
    mx, mn = a.max(-1), a.min(-1)
    d = mx - mn
    h = np.zeros_like(mx)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    m = d > 1e-6
    i = (mx == r) & m
    h[i] = ((g - b)[i] / d[i]) % 6
    i = (mx == g) & m
    h[i] = ((b - r)[i] / d[i]) + 2
    i = (mx == b) & m
    h[i] = ((r - g)[i] / d[i]) + 4
    h *= 60
    return h, np.where(mx > 0, d / np.maximum(mx, 1e-9), 0), mx


def knock_out_background(arr):
    """把与图像边缘连通的近白像素设为透明。"""
    rgb = arr[..., :3].astype(int)
    near_white = (rgb.min(-1) >= 232) & (rgb.max(-1) - rgb.min(-1) <= 24)
    bg = np.zeros(arr.shape[:2], bool)
    h, w = near_white.shape
    q = deque()
    for x in range(w):
        for y in (0, h - 1):
            if near_white[y, x] and not bg[y, x]:
                bg[y, x] = True
                q.append((y, x))
    for y in range(h):
        for x in (0, w - 1):
            if near_white[y, x] and not bg[y, x]:
                bg[y, x] = True
                q.append((y, x))
    while q:
        y, x = q.popleft()
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            ny, nx = y + dy, x + dx
            if 0 <= ny < h and 0 <= nx < w and near_white[ny, nx] and not bg[ny, nx]:
                bg[ny, nx] = True
                q.append((ny, nx))
    arr = arr.copy()
    arr[bg, 3] = 0
    arr[~bg, 3] = 255
    return arr


def recolor(arr):
    rgb = arr[..., :3].astype(float)
    alpha = arr[..., 3]
    h, s, v = rgb_hsv(rgb)
    keep = ((alpha == 0) | (v < 0.20)
            | ((v > 0.90) & (s < 0.20))
            | ((s > 0.42) & ((h < 15) | (h > 330)))
            | ((s > 0.28) & (h >= 90) & (h <= 290))
            | ((s > 0.70) & (h >= 42) & (h <= 62) & (v > 0.72)))
    fur = (alpha > 0) & ~keep & (v >= 0.20) & (v <= 0.97)
    out = rgb.copy()
    if fur.any():
        vv = v[fur]
        target = np.stack([np.interp(vv, RAMP_V, RAMP_RGB[:, c]) for c in range(3)], -1)
        target = target * (vv / np.maximum(target.max(-1), 1e-6))[..., None]
        out[fur] = np.clip(target * 255, 0, 255)
    arr = arr.copy()
    arr[..., :3] = out.astype(np.uint8)
    return arr


def process(path, out_path):
    im = Image.open(path)
    if im.mode != "RGBA":
        im = im.convert("RGBA")
    arr = np.array(im)
    if (arr[..., 3] == 255).all():          # 无透明通道信息 → 按白底抠图
        arr = knock_out_background(arr)
    arr = recolor(arr)
    ys, xs = np.where(arr[..., 3] > 0)
    if len(xs) == 0:
        raise SystemExit(f"{path}: 没有前景像素")
    arr = arr[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
    Image.fromarray(arr).save(out_path)
    print(f"-> {out_path}  {arr.shape[1]}x{arr.shape[0]}")


def main():
    src = Path(sys.argv[1])
    dst = Path(sys.argv[2]) if len(sys.argv) > 2 else src
    mapping = DEFAULT_MAP
    if len(sys.argv) > 3:
        mapping = json.loads(Path(sys.argv[3]).read_text(encoding="utf-8"))
    dst.mkdir(parents=True, exist_ok=True)
    for f in sorted(src.glob("*.png")):
        if f.name.startswith("_"):
            continue
        target = None
        for key, name in mapping.items():
            if key in f.name:
                target = name
                break
        if target is None:
            print(f"跳过（无映射）: {f.name}")
            continue
        out_dir = dst
        if target.startswith("furniture_"):
            alt = dst.parent / "furniture"      # 家具自动落到同级 furniture/
            if alt.is_dir():
                out_dir = alt
        process(f, out_dir / target)


if __name__ == "__main__":
    main()

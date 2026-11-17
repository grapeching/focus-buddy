"""按指定角色高度重绘全部场景预览图（像素风，最近邻缩放）。

用法（在交付包任意目录下运行）：
    python tools/重新生成场景预览图.py [角色高度px]

默认 307（= 0.30 × 1024），v2 起角色放大到此基准；初版为 240。
只改显示比例，不重新生成精灵、不改配色。所有书桌状态正面朝观众。

依赖：Pillow。输出（scenes/）：
    课桌居中_一起学习_昼夜对比.png   3072×1024  左白天/右黑夜，看书
    课桌居中_监督与休息.png           3072×1024  左黑夜警告/右白天捧杯
    监督状态四档对比.png              3072×2048  察觉→叉腰→前倾凝视→站立抱胸
"""
import sys
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SCENES = ROOT / "scenes"
CHARS = ROOT / "characters"

SCENE_W, SCENE_H = 1536, 1024
CX = SCENE_W // 2      # 角色水平中心
FOOT_Y = 660           # 角色脚底（0.645 × 场景高）
NEAREST = Image.Resampling.NEAREST


def paste_owl(scene, sprite_file, height):
    """等比缩放到 height，水平居中、脚底对齐 FOOT_Y，alpha 二值硬边。"""
    sp = Image.open(CHARS / sprite_file).convert("RGBA")
    w = max(1, round(sp.width * height / sp.height))
    sp = sp.resize((w, height), NEAREST)
    alpha = sp.getchannel("A").point(lambda a: 255 if a >= 128 else 0)
    scene.paste(sp.convert("RGB"), (CX - w // 2, FOOT_Y - height), alpha)
    return scene


def compose(cells, height):
    """cells: [(背景名, 精灵名), ...] 按行排布输出网格对比图。"""
    cols = 2 if len(cells) > 2 else len(cells)
    rows = (len(cells) + cols - 1) // cols
    out = Image.new("RGB", (SCENE_W * cols, SCENE_H * rows))
    for i, (bg, sprite) in enumerate(cells):
        im = paste_owl(Image.open(SCENES / bg).convert("RGB"), sprite, height)
        out.paste(im, ((i % cols) * SCENE_W, (i // cols) * SCENE_H))
    return out


def main():
    height = int(sys.argv[1]) if len(sys.argv) > 1 else 307

    compose([("room_day.png", "owl_reading.png"),
             ("room_night.png", "owl_reading.png")], height).save(
        SCENES / "课桌居中_一起学习_昼夜对比.png")

    compose([("room_night.png", "owl_alert.png"),
             ("room_day.png", "owl_break_mug.png")], height).save(
        SCENES / "课桌居中_监督与休息.png")

    compose([("room_day.png", "owl_alert_notice.png"),
             ("room_day.png", "owl_alert.png"),
             ("room_day.png", "owl_alert_lean.png"),
             ("room_day.png", "owl_alert_stand.png")], height).save(
        SCENES / "监督状态四档对比.png")

    print(f"done, character height = {height} px ({height / SCENE_H:.3f} x scene height)")


if __name__ == "__main__":
    main()

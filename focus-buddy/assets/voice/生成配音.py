# -*- coding: utf-8 -*-
"""
用 edge-tts（微软在线语音）批量生成固定台词的离线配音。

用法：
    python assets/voice/生成配音.py                  # 只生成云扬（默认，和老版本一致）
    python assets/voice/生成配音.py --voice yunxia   # 只生成云夏（童声）
    python assets/voice/生成配音.py --voice yunxi    # 只生成云希
    python assets/voice/生成配音.py --all            # 三套一次性全生成

产出（每套音色用独立文件名前缀，互不覆盖）：
    assets/voice/v_<hash>.mp3     + js/voice-map.js        云扬
    assets/voice/xia_<hash>.mp3   + js/voice-map-xia.js    云夏（童声）
    assets/voice/xi_<hash>.mp3    + js/voice-map-xi.js     云希

需要联网生成一次，生成后 MP3 放本地，播放不联网。
"""
import argparse
import asyncio
import hashlib
import json
import os
import sys

try:
    import edge_tts
except ImportError:
    sys.exit("请先安装： python -m pip install edge-tts")

HERE = os.path.dirname(os.path.abspath(__file__))
JS_DIR = os.path.abspath(os.path.join(HERE, "..", "..", "js"))

# 每套音色：音色 ID、文件名前缀、映射文件名、备注、状态文件（记录上次用的 ID）
VOICE_SPECS = {
    "yunyang": {"id": "zh-CN-YunyangNeural", "prefix": "v_",   "map": "voice-map.js",     "comment": "云扬",       "state": ".last-voice"},
    "yunxia":  {"id": "zh-CN-YunxiaNeural",  "prefix": "xia_", "map": "voice-map-xia.js", "comment": "云夏（童声）", "state": ".last-voice-yunxia"},
    "yunxi":   {"id": "zh-CN-YunxiNeural",   "prefix": "xi_",  "map": "voice-map-xi.js",  "comment": "云希",       "state": ".last-voice-yunxi"},
}

# 注意：这里写的是「实际朗读出来的文字」，圆括号动作描写已去掉括号符号，
# 和 pixel-scene.js 的 showLine() 朗读逻辑保持一致。三套音色共用同一份台词。
LINES = [
    # ---- 玩手机四档提醒 ----
    "看见你了，先给一次机会",
    "盯——手机拿起来了",
    "手机放下，现在就放。",
    "手机放下。这一章还没看完呢。",
    "别装没看见我，手机放桌上。",
    "我说第几遍了？现在把手机放下。",
    "最后一次：放下手机，不然这一轮白算了。",
    "再拿一次我就不提醒了，直接记你走神。",
    "手机放下。别让我一直盯着你。",
    "好，我们继续这一章",
    # ---- 学习态误拖警告 ----
    "别拽我。现在是学习时间，回书桌前面坐好。",
    "放下我。这一章没看完，哪儿也不去。",
    "又拎我？坐下，看完再说。",
    # ---- 轻点互动 ----
    "咕咕～我在呢。",
    "别挠我啦，专心一点～",
    "陪你一起，慢慢来。",
    "要一起把这一章看完哦。",
    # ---- 休息态自言自语 ----
    "这一轮我们撑下来啦，休息一下吧",
    "休息啦 · 我自己溜达一会儿，随时能把我拖走",
    "休息啦 · 拖我去床 / 餐桌 / 书柜玩，拖回书桌就继续学",
    "有点困了……我去躺一会儿",
    "呼……先睡一小会儿",
    "去餐桌那儿吃口面包",
    "面包好香，先吃一口",
    "面包好香，我们先吃一口",
    "去书柜翻两页闲书",
    "这本好像挺有意思",
    "睡够啦，起来活动活动",
    "好啦，继续溜达",
    "揉揉眼睛……我去床边眯一会儿",
    "好，回到书桌前，我们继续学。",
    # ---- app.js 短句表 ----
    "开始啦！我陪你一起，别走神哦。",
    "好，坐下，翻开书，我们开始。",
    "开工！我就在这儿看着你。",
    "专心的时候你最好看了。",
    "这一页看得挺认真嘛。",
    "保持住，很好。",
    "手机先放一放，我们继续这一章。",
    "手机比我好看吗？",
    "把手机推到桌角去吧。",
    "头低下去啦，抬起头看看书。",
    "眼睛离开本子太久咯。",
    "看哪儿呢？回来回来。",
    "别东张西望，看你的题。",
    "天花板上有答案吗？",
    "抬头太久啦，回到书本。",
    "你去哪儿了？书还开着呢。",
    "人不见啦，是去喝水还是溜了？",
    "眼睛闭上了？困了就活动一下。",
    "困了就洗把脸，别硬撑。",
    "回来了，继续！",
    "这才对嘛，接着来。",
    "休息啦，伸个懒腰吧～",
    "这一轮结束，起来动一动。",
    "休息够啦，我们接着来。",
    "坐好，下一轮开始。",
    "今天这一轮做完啦，好棒！",
    "收工！今天也很认真。",
    "先去写一条今日计划吧。",
    "都过去一会儿啦，我们回来吧？",
    # ---- app.js 固定气泡 ----
    "摄像头打不开…允许一下权限？或者先点演示看看。",
    "识别模型没加载起来，重启一下试试。",
    "先停一下，我等你。",
    "写好计划，点「开始学习」，我们就开始。",
    "好，按你说的来。",
    "校准数据清掉了，下次开始会重新校准。",
    "先点「开始学习」打开摄像头，再校准。",
    "放点背景音，写着更静。",
    "先歇会儿，回来继续。",
    "手机放下，我们先把这一章看完。",   # 也是设置里试听的默认句
    # ---- 会话存档恢复 ----
    "欢迎回来，上次没学完的进度还留着。",
    "欢迎回来，我们接着学。",
    "欢迎回来，接着休息，我等你。",
    "好，那我们从第一轮重新开始。",
    "存档清掉了，下次从头开始。",
]


def file_name(text, spec):
    h = hashlib.md5(text.encode("utf-8")).hexdigest()[:10]
    return "%s%s.mp3" % (spec["prefix"], h)


async def gen_one(text, mapping, spec, force=False):
    name = file_name(text, spec)
    path = os.path.join(HERE, name)
    # 已经生成过且不是空文件就跳过，方便增量补台词；--force 时强制覆盖
    # 注意：不做批量删除，既安全又不会误删别的音色的文件
    if not force and os.path.exists(path) and os.path.getsize(path) > 1000:
        mapping[text] = name
        return "skip", text
    for attempt in range(3):
        try:
            await edge_tts.Communicate(text, spec["id"]).save(path)
            if os.path.getsize(path) > 1000:
                mapping[text] = name
                return "ok", text
        except Exception as exc:
            if attempt == 2:
                return "fail:%s" % exc, text
            await asyncio.sleep(1.5 * (attempt + 1))
    return "fail:empty", text


async def gen_voice(key, spec, force=False):
    """生成一套音色：缺的补、有的跳过；--force 才覆盖。不删任何文件。"""
    state_path = os.path.join(HERE, spec["state"])
    last = ""
    if os.path.exists(state_path):
        with open(state_path, encoding="utf-8") as f:
            last = f.read().strip()
    if last != spec["id"]:
        print("  %s：上次记录 %r，当前 %s（不删旧文件，缺的补，--force 才覆盖）"
              % (spec["comment"], last or "(空)", spec["id"]), flush=True)

    lines = list(dict.fromkeys(LINES))
    mapping = {}
    ok = skip = 0
    for i, text in enumerate(lines, 1):
        status, used = await gen_one(text, mapping, spec, force)
        if status == "ok":
            ok += 1
        elif status == "skip":
            skip += 1
        else:
            print("  [%d/%d] 失败 %s -> %s" % (i, len(lines), used, status))
        if i % 10 == 0 or i == len(lines):
            print("  %s 进度 %d/%d（新 %d，复用 %d）" % (spec["comment"], i, len(lines), ok, skip), flush=True)

    map_path = os.path.join(JS_DIR, spec["map"])
    with open(map_path, "w", encoding="utf-8") as f:
        f.write("// 由 assets/voice/生成配音.py 自动生成，请勿手改。\n")
        f.write("// 台词 -> 本地 MP3（%s %s）\n" % (spec["comment"], spec["id"]))
        f.write("export const VOICE_MAP = {\n")
        for text in lines:
            if text in mapping:
                f.write("  %s: \"./assets/voice/%s\",\n" % (
                    json.dumps(text, ensure_ascii=False), mapping[text]))
        f.write("};\n")
    with open(state_path, "w", encoding="utf-8") as f:
        f.write(spec["id"])
    print("  %s 完成：新 %d / 复用 %d / 映射 %d 条" % (spec["comment"], ok, skip, len(mapping)), flush=True)
    return ok, skip, len(mapping)


async def main():
    parser = argparse.ArgumentParser(description="生成离线配音 MP3（edge-tts）")
    parser.add_argument("--voice", choices=list(VOICE_SPECS), default="yunyang",
                        help="要生成的音色，默认 yunyang")
    parser.add_argument("--all", action="store_true", help="一次性生成三套音色")
    parser.add_argument("--force", action="store_true", help="强制覆盖已有 MP3（真的换音色时才用）")
    args = parser.parse_args()
    targets = list(VOICE_SPECS) if args.all else [args.voice]
    for key in targets:
        spec = VOICE_SPECS[key]
        print("=== 生成 %s（%s）===" % (key, spec["id"]), flush=True)
        await gen_voice(key, spec, args.force)
    print("全部完成。音频目录：", HERE, flush=True)


if __name__ == "__main__":
    asyncio.run(main())

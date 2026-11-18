# -*- coding: utf-8 -*-
"""
专注伙伴 Focus Buddy — 一键启动器

双击打包后的 exe：
  1. 自动挑一个空闲端口起本地服务
  2. 用 Edge / Chrome 的「应用窗口」打开（没有地址栏，像个软件）
  3. 摄像头画面只在这台电脑上算，不上传、不保存

给朋友测试：把 exe 发过去，双击即可，不需要装 Python，也不需要敲命令。
关掉那个应用窗口就退出；后台若还留着服务，任务管理器结束「专注伙伴.exe」即可。
"""
import functools
import http.server
import os
import socket
import socketserver
import subprocess
import sys
import threading
import time
import webbrowser


def app_dir():
    """打包后资源在临时解包目录 _MEIPASS；源码运行时就是本脚本所在目录。"""
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        return sys._MEIPASS
    return os.path.dirname(os.path.abspath(__file__))


ROOT = os.path.join(app_dir(), "focus-buddy")


class Handler(http.server.SimpleHTTPRequestHandler):
    """比 python -m http.server 多做两件事：
       给 .mjs 正确 MIME（否则 ONNX Runtime 的 wasm 加载器被浏览器拒绝执行）；
       禁缓存，改完代码刷新就生效。"""
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".mjs": "text/javascript",
        ".js": "text/javascript",
        ".wasm": "application/wasm",
        ".onnx": "application/octet-stream",
        ".task": "application/octet-stream",
        ".json": "application/json",
        ".png": "image/png",
        ".css": "text/css",
        ".mp3": "audio/mpeg",
        ".wav": "audio/wav",
    }

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()

    def log_message(self, fmt, *args):
        pass  # 安静点，别刷屏


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def port_file():
    """记录上次用的端口，放在用户目录（两个 exe 分开存），保证关掉重开还是同一端口。
    浏览器 localStorage 按「域名+端口」隔离——端口一变，计划/存档/音色全读不到。"""
    return os.path.join(os.path.expanduser("~"), ".focus-buddy-port")


def port_free(port):
    with socket.socket() as s:
        try:
            s.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False


def pick_port():
    pf = port_file()
    # 1) 上次用过的端口还空闲 → 复用（关键：让 localStorage 跨重启可读）
    try:
        with open(pf, encoding="utf-8") as f:
            last = int(f.read().strip())
        if 1024 <= last <= 65535 and port_free(last):
            return last
    except (OSError, ValueError):
        pass
    # 2) 上次端口被别的程序占了 → 另挑一个空闲端口并记下来
    port = free_port()
    try:
        with open(pf, "w", encoding="utf-8") as f:
            f.write(str(port))
    except OSError:
        pass
    return port


def open_app(url):
    candidates = []
    pf86 = os.environ.get("ProgramFiles(x86)", "")
    pf = os.environ.get("ProgramFiles", "")
    for base in (pf86, pf):
        if not base:
            continue
        candidates.append(os.path.join(base, "Microsoft", "Edge", "Application", "msedge.exe"))
        candidates.append(os.path.join(base, "Google", "Chrome", "Application", "chrome.exe"))
    for exe in candidates:
        if os.path.exists(exe):
            try:
                subprocess.Popen([exe, "--app=%s" % url, "--window-size=1400,880"])
                return True
            except OSError:
                pass
    webbrowser.open(url)
    return False


def main():
    if not os.path.isdir(ROOT):
        print("缺少资源目录：", ROOT, flush=True)
        sys.exit(1)

    port = pick_port()   # 优先复用上次端口，让计划/存档/音色跨重启保留
    url = "http://127.0.0.1:%d/index.html" % port
    handler = functools.partial(Handler, directory=ROOT)
    socketserver.TCPServer.allow_reuse_address = True
    httpd = socketserver.ThreadingTCPServer(("127.0.0.1", port), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()

    print("专注伙伴已启动：", url, flush=True)
    open_app(url)
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()

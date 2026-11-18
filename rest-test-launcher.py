# -*- coding: utf-8 -*-
"""
专注伙伴 Focus Buddy — 休息测试版一键启动器

双击打包后的 exe：
  1. 自动挑一个空闲端口起本地服务
  2. 用 Edge / Chrome 的「应用窗口」打开 rest-test.html（1500×900）
  3. 打开即是休息态，右侧有休息时间控制面板

和正式版（专注伙伴.exe → index.html）完全分开，两个 exe 可以同时打开。

给朋友测试：把 exe 发过去，双击即可，不需要装 Python，也不需要敲命令。
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
    """给 .mjs 正确 MIME（否则 ONNX Runtime 的 wasm 加载器被浏览器拒绝执行）；禁缓存。"""
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
        pass


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def port_file():
    """独立端口记录文件（与正式版分开），保证测试版关掉重开端口不变，localStorage 可读。"""
    return os.path.join(os.path.expanduser("~"), ".focus-buddy-rest-port")


def port_free(port):
    with socket.socket() as s:
        try:
            s.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False


def pick_port():
    pf = port_file()
    try:
        with open(pf, encoding="utf-8") as f:
            last = int(f.read().strip())
        if 1024 <= last <= 65535 and port_free(last):
            return last
    except (OSError, ValueError):
        pass
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
                subprocess.Popen([exe, "--app=%s" % url, "--window-size=1500,900"])
                return True
            except OSError:
                pass
    webbrowser.open(url)
    return False


def main():
    if not os.path.isfile(os.path.join(ROOT, "rest-test.html")):
        print("缺少休息测试页：", os.path.join(ROOT, "rest-test.html"), flush=True)
        sys.exit(1)

    port = pick_port()   # 优先复用上次端口，让 localStorage 跨重启保留
    url = "http://127.0.0.1:%d/rest-test.html" % port
    handler = functools.partial(Handler, directory=ROOT)
    socketserver.TCPServer.allow_reuse_address = True
    httpd = socketserver.ThreadingTCPServer(("127.0.0.1", port), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()

    print("休息测试版已启动：", url, flush=True)
    open_app(url)
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()

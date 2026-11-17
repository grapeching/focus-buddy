"""
本地静态服务器（比 python -m http.server 多两件事）

1. 给 .mjs 正确的 Content-Type。
   onnxruntime-web 1.20 的 wasm 加载器是 ES module（ort-wasm-simd-threaded.mjs），
   而 Python 自带的 SimpleHTTPRequestHandler 把 .mjs 当 text/plain 返回，
   浏览器会拒绝以模块方式执行，直接报 "Failed to fetch dynamically imported module"。

2. 顺带补齐 .onnx / .wasm / .task 的类型，并禁用缓存，
   改代码后刷新就能生效，不用手动清缓存。

用法：
  python serve.py 8848          # 正式服
  python serve.py 8127          # 测试服
"""

import functools
import http.server
import os
import socketserver
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))


class Handler(http.server.SimpleHTTPRequestHandler):
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
    }

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()

    def log_message(self, fmt, *args):
        pass  # 安静一点，别刷屏


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8848
    handler = functools.partial(Handler, directory=ROOT)
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer(("127.0.0.1", port), handler) as httpd:
        print(f"focus-buddy 已启动： http://127.0.0.1:{port}/index.html")
        httpd.serve_forever()


if __name__ == "__main__":
    main()

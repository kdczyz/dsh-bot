"""用 CDP 驱动无头 Chrome 验证 BotScreen 控制台与 noVNC 推流画面。

用法: python tools/cdp_check.py [输出目录]
"""
from __future__ import annotations

import asyncio
import base64
import json
import os
import subprocess
import sys
import time
import urllib.request

import websockets

PORT = 9333
OUT = sys.argv[1] if len(sys.argv) > 1 else "/tmp/cdp"
CONSOLE = "http://127.0.0.1:6200/"


async def cdp(ws, method: str, params: dict | None = None, msg_id: int = 1) -> dict:
    await ws.send(json.dumps({"id": msg_id, "method": method, "params": params or {}}))
    while True:
        raw = await ws.recv()
        data = json.loads(raw)
        if data.get("id") == msg_id:
            return data


async def shoot(ws, name: str) -> None:
    resp = await cdp(ws, "Page.captureScreenshot", {"format": "jpeg", "quality": 82}, msg_id=99)
    data = resp.get("result", {}).get("data")
    if not data:
        print(f"  {name}: SCREENSHOT FAILED {resp}")
        return
    path = os.path.join(OUT, name)
    with open(path, "wb") as fh:
        fh.write(base64.b64decode(data))
    print(f"  {name}: {os.path.getsize(path) // 1024}KB")


async def main() -> None:
    os.makedirs(OUT, exist_ok=True)
    profile = "/tmp/cdp-profile"
    proc = subprocess.Popen(
        [
            "google-chrome", "--headless=new", "--no-sandbox", "--disable-gpu",
            f"--remote-debugging-port={PORT}", f"--user-data-dir={profile}",
            "--window-size=1440,1000", "about:blank",
        ],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        target = None
        for _ in range(40):
            time.sleep(0.5)
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/list", timeout=3) as r:
                    targets = json.load(r)
                target = next((t for t in targets if t["type"] == "page"), None)
                if target:
                    break
            except Exception:  # noqa: BLE001
                continue
        if not target:
            print("CDP: no page target")
            return
        ws_url = target["webSocketDebuggerUrl"]
        print("CDP target:", target["url"])

        async with websockets.connect(ws_url, max_size=64 * 1024 * 1024) as ws:
            await cdp(ws, "Page.enable")
            await cdp(ws, "Runtime.enable")
            await cdp(ws, "Page.navigate", {"url": CONSOLE})
            await asyncio.sleep(4)
            await shoot(ws, "01-console.jpg")

            # 卡片数量与汇总文本
            expr = """JSON.stringify({
              cards: document.querySelectorAll('.card').length,
              summary: document.querySelector('#summary')?.textContent,
              badges: [...document.querySelectorAll('.badge')].map(b=>b.textContent).slice(0,6)
            })"""
            resp = await cdp(ws, "Runtime.evaluate", {"expression": expr, "returnByValue": True})
            print("  DOM:", resp.get("result", {}).get("result", {}).get("value"))

            # 点击「接管」→ 打开 dialog + iframe 加载 noVNC
            await cdp(ws, "Runtime.evaluate", {
                "expression": "takeover('bot_01')", "awaitPromise": True, "returnByValue": True
            })
            await asyncio.sleep(7)
            await shoot(ws, "02-takeover.jpg")

            info = """JSON.stringify({
              dialogOpen: document.querySelector('#viewer').open,
              badge: document.querySelector('#viewerBadge').textContent,
              note: (document.querySelector('#viewerNote')||{}).textContent.slice(0,90)
            })"""
            resp = await cdp(ws, "Runtime.evaluate", {"expression": info, "returnByValue": True})
            print("  dialog:", resp.get("result", {}).get("result", {}).get("value"))

            # 接管窗口是独立 target（顶层 noVNC），列出确认已开
            with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/list", timeout=3) as r:
                targets = json.load(r)
            vnc = [t for t in targets if "vnc.html" in t.get("url", "")]
            print("  takeover targets:", [(t["type"], t["url"][:80]) for t in vnc])
    finally:
        proc.terminate()


if __name__ == "__main__":
    asyncio.run(main())
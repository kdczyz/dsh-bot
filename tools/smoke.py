"""BotScreen 端到端回归：状态机 / 冻结唤醒 / 截屏 / 键鼠 / 互斥 / 审计 / 文件。

用法:
  .venv/bin/python tools/smoke.py [bot_id]
前置: 网关在 127.0.0.1:6200 运行
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time

import httpx

BASE = os.environ.get("BOTSCREEN_GATEWAY", "http://127.0.0.1:6200")
BOT = sys.argv[1] if len(sys.argv) > 1 else "bot_01"
DATA = os.environ.get("BOTSCREEN_DATA_ROOT", "/data/botscreen")
CG = f"/sys/fs/cgroup/botscreen/{BOT}"

passed, failed = [], []


def check(name: str, cond: bool, detail: str = "") -> None:
    (passed if cond else failed).append(name)
    print(f"  {'✓' if cond else '✗'} {name}" + (f"  [{detail}]" if detail else ""))


def token() -> str:
    with open(f"{DATA}/{BOT}/runtime/token.json") as fh:
        return json.load(fh)["token"]


def agent(path: str, **kw) -> httpx.Response:
    headers = kw.pop("headers", {})
    headers["X-Agent-Token"] = token()
    return httpx.request("GET" if "json" not in kw else "POST", f"{BASE}{path}",
                         headers=headers, timeout=60, **kw)


def post(path: str, **kw) -> httpx.Response:
    return httpx.post(f"{BASE}{path}", timeout=90, **kw)


def cpu_usec() -> int:
    with open(f"{CG}/cpu.stat") as fh:
        for line in fh:
            if line.startswith("usage_usec"):
                return int(line.split()[1])
    return 0


def main() -> int:
    print(f"== BotScreen smoke: {BOT} ==")
    check("gateway healthz", httpx.get(f"{BASE}/healthz", timeout=10).json().get("ok") is True)

    # 清场：把上一次运行留下的接管/求助状态交还给 Agent
    post(f"/api/screens/{BOT}/release")
    st = post(f"/api/screens/{BOT}/start", json={}).json()
    if st["state"] != "AGENT_ACTIVE":
        post(f"/api/screens/{BOT}/release")
        st = httpx.get(f"{BASE}/api/screens/{BOT}", timeout=10).json()
    check("start -> healthy", st["healthy"] and st["state"] == "AGENT_ACTIVE", st["state"])
    check("display/port 映射", st["display"].startswith(":1") and st["ws_port"] >= 6100,
          f"{st['display']} :{st['ws_port']}")

    shot = agent(f"/api/agent/{BOT}/screenshot", params={"fmt": "jpeg"})
    check("screenshot 200 + 图像", shot.status_code == 200 and shot.content[:2] == b"\xff\xd8",
          f"{len(shot.content)//1024}KB {shot.headers.get('x-screen-width')}x{shot.headers.get('x-screen-height')}")
    check("screenshot 元数据头", shot.headers.get("x-screen-state") == "AGENT_ACTIVE")

    click = agent(f"/api/agent/{BOT}/click", json={"x": 640, "y": 360, "button": 1})
    check("click 200", click.status_code == 200, click.text[:60])
    typ = agent(f"/api/agent/{BOT}/type", json={"text": "中文输入✅ smoke", "press_enter": False})
    check("type(中文) 200", typ.status_code == 200, typ.text[:60])
    key = agent(f"/api/agent/{BOT}/key", json={"combo": "ctrl+a"})
    check("key 200", key.status_code == 200, key.text[:60])

    # 冻结 → CPU 归零 → 唤醒
    post(f"/api/screens/{BOT}/freeze")
    c1 = cpu_usec()
    time.sleep(2.0)
    c2 = cpu_usec()
    frozen = open(f"{CG}/cgroup.freeze").read().strip()
    check("freeze: cgroup.freeze=1", frozen == "1")
    check("freeze: 2s CPU 增量为 0", c2 - c1 == 0, f"{c2 - c1} us")
    st = post(f"/api/screens/{BOT}/thaw").json()
    check("thaw -> AGENT_ACTIVE", st["state"] == "AGENT_ACTIVE" and not st["cgroup_frozen"])

    # 人机互斥
    to = post(f"/api/screens/{BOT}/takeover").json()
    check("takeover -> HUMAN_TAKEOVER", to["state"] == "HUMAN_TAKEOVER" and bool(to.get("token")))
    locked = agent(f"/api/agent/{BOT}/click", json={"x": 1, "y": 1})
    check("人类接管时 click=423", locked.status_code == 423, locked.text[:60])
    rel = post(f"/api/screens/{BOT}/release").json()
    check("release -> AGENT_ACTIVE", rel["state"] == "AGENT_ACTIVE")
    check("交还后 click 恢复 200",
          agent(f"/api/agent/{BOT}/click", json={"x": 640, "y": 360}).status_code == 200)

    # 求助
    help_ = agent(f"/api/agent/{BOT}/request_help", json={"reason": "smoke: 需要人工确认"})
    check("request_help -> NEED_HUMAN", help_.json().get("state") == "NEED_HUMAN")
    check("NEED_HUMAN 时 type=423",
          agent(f"/api/agent/{BOT}/type", json={"text": "x"}).status_code == 423)
    post(f"/api/screens/{BOT}/release")

    # ---- 租约：fail-closed 截图 + epoch ----
    epoch_before = httpx.get(f"{BASE}/api/screens/{BOT}", timeout=10).json()["epoch"]
    post(f"/api/screens/{BOT}/takeover")
    fc = agent(f"/api/agent/{BOT}/screenshot")
    check("人类持有时截图 423(fail-closed)", fc.status_code == 423,
          fc.json().get("blocked") if fc.headers.get("content-type","").startswith("application/json") else "")
    check("人类持有时控制台预览仍可用",
          httpx.get(f"{BASE}/api/screens/{BOT}/preview", timeout=30).status_code == 200)
    preview = httpx.get(f"{BASE}/api/screens/{BOT}/preview", timeout=30)
    check("预览是图像", preview.content[:2] == b"\xff\xd8", f"{len(preview.content)//1024}KB")
    post(f"/api/screens/{BOT}/release")
    epoch_after = httpx.get(f"{BASE}/api/screens/{BOT}", timeout=10).json()["epoch"]
    check("takeover/release 推进 epoch", epoch_after > epoch_before, f"{epoch_before} → {epoch_after}")
    stale = httpx.post(f"{BASE}/api/agent/{BOT}/click",
                       headers={"X-Agent-Token": token(), "X-Expected-Epoch": str(epoch_before)},
                       json={"x": 10, "y": 10}, timeout=30)
    check("旧 epoch 的写操作 409", stale.status_code == 409, stale.json().get("detail", ""))
    fresh = agent(f"/api/agent/{BOT}/screenshot", headers={"X-Expected-Epoch": str(epoch_after)})
    check("当前 epoch 可正常截图", fresh.status_code == 200,
          f"epoch={fresh.headers.get('x-lease-epoch')}")

    # ---- 租约落盘 ----
    lease_path = f"{DATA}/{BOT}/runtime/lease.json"
    try:
        with open(lease_path) as fh:
            lease = json.load(fh)
    except OSError:
        lease = {}
    check("租约落盘且字段完整",
          {"bot_id", "holder", "state", "epoch"} <= set(lease), f"holder={lease.get('holder')}")

    # ---- 内存门禁 ----
    host = httpx.get(f"{BASE}/api/screens", timeout=10).json().get("host") or {}
    check("宿主机内存可读", host.get("available_mb") is not None, str(host.get("available_mb")) + "MB")

    # 审计
    audit = httpx.get(f"{BASE}/api/screens/{BOT}/audit", params={"limit": 20}, timeout=10).json()
    acts = {e["action"] for e in audit["entries"]}
    check("审计含 click/type/key", {"click", "type", "key"} <= acts, ",".join(sorted(acts)))
    check("审计带缩略图", any(e.get("thumb") for e in audit["entries"]))

    # 文件中转
    payload = f"smoke {time.time()}".encode()
    up = httpx.post(f"{BASE}/api/screens/{BOT}/files",
                    files={"file": ("smoke.txt", payload, "text/plain")}, timeout=30)
    check("文件上传", up.status_code == 200 and up.json()["size"] == len(payload))
    dl = httpx.get(f"{BASE}/api/screens/{BOT}/files/smoke.txt", timeout=30)
    check("文件下载内容一致", dl.content == payload)
    httpx.delete(f"{BASE}/api/screens/{BOT}/files/smoke.txt", timeout=30)

    # 全局制动：先记住旧 token，制动后它必须失效
    old_token = token()
    brake = post("/api/brake").json()
    check("全局制动冻结全部屏", BOT in brake["frozen"] and brake["tokens_rotated"])
    stale = httpx.get(f"{BASE}/api/agent/{BOT}/screenshot",
                      headers={"X-Agent-Token": old_token}, timeout=20)
    check("制动后旧 token 401", stale.status_code == 401, str(stale.status_code))
    st = httpx.get(f"{BASE}/api/screens/{BOT}", timeout=10).json()
    check("制动后状态 FROZEN", st["state"] == "FROZEN" and st["cgroup_frozen"],
          f"{st['state']} frozen={st['cgroup_frozen']}")

    print(f"\n== 结果: {len(passed)} 通过 / {len(failed)} 失败 ==")
    if failed:
        print("失败项: " + ", ".join(failed))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
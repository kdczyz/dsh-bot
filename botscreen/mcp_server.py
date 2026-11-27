"""BotScreen MCP Server（stdio，newline-delimited JSON-RPC 2.0）。

暴露给 Agent 的工具：
  screen_screenshot / screen_click / screen_type_text / screen_key /
  request_human_help / screen_status / screen_list / wait_human_release

网关只监听 127.0.0.1；本进程从每个 bot 的 runtime/token.json 读取 Agent Token。
"""
from __future__ import annotations

import base64
import json
import os
import sys
from typing import Any, Dict, List

import httpx

GATEWAY = os.environ.get("BOTSCREEN_GATEWAY", "http://127.0.0.1:6200")
DATA_ROOT = os.environ.get("BOTSCREEN_DATA_ROOT", "/data/botscreen")
PROTOCOL_VERSION = "2024-11-05"

TOOLS: List[Dict[str, Any]] = [
    {
        "name": "screen_screenshot",
        "description": "截取指定 Bot 的虚拟屏（自动唤醒冻结屏）。返回 1280x720 图像。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "bot_id": {"type": "string"},
                "format": {"type": "string", "enum": ["jpeg", "webp", "png"], "default": "jpeg"},
                "lease_epoch": {"type": "integer",
                                "description": "上次调用返回的 epoch；控制权被抢占后传旧值会得到 409"},
            },
            "required": ["bot_id"],
        },
    },
    {
        "name": "screen_click",
        "description": "在虚拟屏坐标 (x,y) 上点击。人类接管时返回 423 锁定错误。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "bot_id": {"type": "string"},
                "x": {"type": "integer"},
                "y": {"type": "integer"},
                "button": {"type": "integer", "default": 1},
                "double": {"type": "boolean", "default": False},
                "lease_epoch": {"type": "integer"},
            },
            "required": ["bot_id", "x", "y"],
        },
    },
    {
        "name": "screen_type_text",
        "description": "通过剪贴板粘贴输入文本（支持中文/emoji），可选回车提交。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "bot_id": {"type": "string"},
                "text": {"type": "string"},
                "press_enter": {"type": "boolean", "default": False},
                "lease_epoch": {"type": "integer"},
            },
            "required": ["bot_id", "text"],
        },
    },
    {
        "name": "screen_key",
        "description": "发送快捷键组合，如 ctrl+l、Return、Page_Down、alt+F4。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "bot_id": {"type": "string"},
                "key_combo": {"type": "string"},
                "lease_epoch": {"type": "integer"},
            },
            "required": ["bot_id", "key_combo"],
        },
    },
    {
        "name": "request_human_help",
        "description": "仅在遇到必须人类完成的硬性阻塞（如验证码、扫码/短信登录、MFA、支付确认）时才可调用；常规 UI 失败或可重试操作严禁调用。",
        "inputSchema": {
            "type": "object",
            "properties": {"bot_id": {"type": "string"}, "reason": {"type": "string"}},
            "required": ["bot_id", "reason"],
        },
    },
    {
        "name": "wait_human_release",
        "description": "被 423 挡住后阻塞等待人类交还控制权。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "bot_id": {"type": "string"},
                "timeout": {"type": "number", "default": 60},
            },
            "required": ["bot_id"],
        },
    },
    {
        "name": "screen_status",
        "description": "查询虚拟屏状态：状态机、冻结标记、内存、PID。",
        "inputSchema": {
            "type": "object",
            "properties": {"bot_id": {"type": "string"}},
            "required": ["bot_id"],
        },
    },
    {
        "name": "screen_list",
        "description": "列出所有已分配的虚拟屏。",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "system_info",
        "description": "通过网关获取宿主机系统信息：磁盘占用、内存占用、CPU 占用、开机时长。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "disk_path": {"type": "string", "description": "可选磁盘挂载点路径（多个用逗号分隔，默认 /）"},
            },
        },
    },
    {
        "name": "artifact_publish",
        "description": "将 Agent 回复产物（文本/代码/HTML/JSON/Markdown 或 Base64 二进制）上传发布到网关并返回下载接口地址。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "bot_id": {"type": "string", "description": "Bot ID"},
                "title": {"type": "string", "description": "产物标题"},
                "filename": {"type": "string", "description": "下载文件名（可选）"},
                "content": {"type": "string", "description": "产物内容（UTF-8 文本或 base64 字符串）"},
                "encoding": {"type": "string", "enum": ["utf-8", "base64"], "default": "utf-8"},
                "artifact_type": {"type": "string", "description": "产物类型：html/markdown/json/code/text/file 等"},
                "kind": {"type": "string", "enum": ["artifact", "deliverable", "file", "reply"], "default": "artifact"},
                "mime_type": {"type": "string", "description": "可选 MIME 类型"},
                "room_id": {"type": "string", "description": "可选所属群聊 ID"},
            },
            "required": ["bot_id", "content"],
        },
    },
    {
        "name": "artifact_list",
        "description": "查询网关中已发布的 Agent 回复产物列表及下载地址。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "bot_id": {"type": "string", "description": "可选按 Bot ID 过滤"},
                "room_id": {"type": "string", "description": "可选按群聊 ID 过滤"},
                "limit": {"type": "integer", "default": 50},
            },
        },
    },
]


def agent_token(bot_id: str) -> str:
    path = os.path.join(DATA_ROOT, bot_id, "runtime", "token.json")
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)["token"]


def call_gateway(method: str, path: str, bot_id: str | None = None, **kwargs) -> httpx.Response:
    headers = kwargs.pop("headers", {})
    admin_token = os.environ.get("BOTSCREEN_ADMIN_TOKEN", "").strip()
    if admin_token and "X-Admin-Token" not in headers:
        headers["X-Admin-Token"] = admin_token
    if bot_id:
        headers["X-Agent-Token"] = agent_token(bot_id)
        epoch = kwargs.pop("expected_epoch", None)
        if epoch is not None:
            headers["X-Expected-Epoch"] = str(epoch)
    return httpx.request(method, f"{GATEWAY}{path}", headers=headers, timeout=60, **kwargs)


def lease_conflict(resp: httpx.Response) -> Dict[str, Any]:
    """把 409（租约 epoch 变了）翻译成 Agent 能直接照做的指令。"""
    try:
        body = resp.json()
    except Exception:  # noqa: BLE001
        body = {}
    return {
        "content": [{
            "type": "text",
            "text": ("ERROR: 409 控制权已切换（租约 epoch "
                     f"{body.get('expected_epoch')} → {body.get('current_epoch')}）。"
                     "重新调用 screen_screenshot 获取当前 X-Lease-Epoch，再决定是否继续。"),
        }],
        "isError": True,
    }


def _err(msg: str) -> Dict[str, Any]:
    return {"content": [{"type": "text", "text": f"ERROR: {msg}"}], "isError": True}


def tool_screen_screenshot(args: Dict[str, Any]) -> Dict[str, Any]:
    bot_id = args["bot_id"]
    fmt = args.get("format", "webp")
    resp = call_gateway(
        "GET", f"/api/agent/{bot_id}/screenshot", bot_id,
        params={"fmt": fmt}, expected_epoch=args.get("lease_epoch"),
    )
    if resp.status_code == 409:
        return lease_conflict(resp)
    if resp.status_code == 423:
        return _err(
            "423 Locked: 人类正在接管，截图也被拒绝（fail-closed，人可能在输入凭据）。"
            "调用 wait_human_release 等交还。" + resp.text[:200]
        )
    if resp.status_code != 200:
        return _err(f"HTTP {resp.status_code}: {resp.text[:300]}")
    mime = resp.headers.get("content-type", "image/webp").split(";")[0]
    meta = {
        "width": int(resp.headers.get("x-screen-width", 0)),
        "height": int(resp.headers.get("x-screen-height", 0)),
        "state": resp.headers.get("x-screen-state"),
        "resumed_from_long_freeze": resp.headers.get("x-resumed-from-long-freeze") == "true",
        "focused_window": json.loads(resp.headers.get("x-focused-window") or "{}"),
        "lease_epoch": int(resp.headers.get("x-lease-epoch") or 0),
        "lease_holder": resp.headers.get("x-lease-holder"),
    }
    return {
        "content": [
            {"type": "text", "text": json.dumps(meta, ensure_ascii=False)},
            {
                "type": "image",
                "data": base64.b64encode(resp.content).decode(),
                "mimeType": mime,
            },
        ]
    }


def tool_screen_click(args: Dict[str, Any]) -> Dict[str, Any]:
    bot_id = args["bot_id"]
    payload = {
        "x": int(args["x"]),
        "y": int(args["y"]),
        "button": int(args.get("button", 1)),
        "double": bool(args.get("double", False)),
    }
    resp = call_gateway("POST", f"/api/agent/{bot_id}/click", bot_id, json=payload,
                        expected_epoch=args.get("lease_epoch"))
    if resp.status_code == 423:
        return _err(f"423 Locked: 人类正在接管，请调用 wait_human_release。{resp.text[:200]}")
    if resp.status_code != 200:
        return _err(f"HTTP {resp.status_code}: {resp.text[:300]}")
    return {"content": [{"type": "text", "text": resp.text}]}


def tool_screen_type(args: Dict[str, Any]) -> Dict[str, Any]:
    bot_id = args["bot_id"]
    payload = {"text": args.get("text", ""), "press_enter": bool(args.get("press_enter", False))}
    resp = call_gateway("POST", f"/api/agent/{bot_id}/type", bot_id, json=payload,
                        expected_epoch=args.get("lease_epoch"))
    if resp.status_code == 423:
        return _err("423 Locked: 人类正在接管，请调用 wait_human_release。")
    if resp.status_code != 200:
        return _err(f"HTTP {resp.status_code}: {resp.text[:300]}")
    return {"content": [{"type": "text", "text": resp.text}]}


def tool_screen_key(args: Dict[str, Any]) -> Dict[str, Any]:
    bot_id = args["bot_id"]
    payload = {"combo": args["key_combo"]}
    resp = call_gateway("POST", f"/api/agent/{bot_id}/key", bot_id, json=payload,
                        expected_epoch=args.get("lease_epoch"))
    if resp.status_code == 423:
        return _err("423 Locked: 人类正在接管，请调用 wait_human_release。")
    if resp.status_code != 200:
        return _err(f"HTTP {resp.status_code}: {resp.text[:300]}")
    return {"content": [{"type": "text", "text": resp.text}]}


def tool_request_help(args: Dict[str, Any]) -> Dict[str, Any]:
    bot_id = args["bot_id"]
    resp = call_gateway(
        "POST", f"/api/agent/{bot_id}/request_help", bot_id, json={"reason": args["reason"]}
    )
    if resp.status_code != 200:
        return _err(f"HTTP {resp.status_code}: {resp.text[:300]}")
    return {"content": [{"type": "text", "text": resp.text}]}


def tool_wait_release(args: Dict[str, Any]) -> Dict[str, Any]:
    bot_id = args["bot_id"]
    resp = call_gateway(
        "POST",
        f"/api/agent/{bot_id}/wait_release",
        bot_id,
        params={"timeout": float(args.get("timeout", 60))},
    )
    if resp.status_code != 200:
        return _err(f"HTTP {resp.status_code}: {resp.text[:300]}")
    return {"content": [{"type": "text", "text": resp.text}]}


def tool_status(args: Dict[str, Any]) -> Dict[str, Any]:
    resp = call_gateway("GET", f"/api/screens/{args['bot_id']}")
    if resp.status_code != 200:
        return _err(f"HTTP {resp.status_code}: {resp.text[:300]}")
    return {"content": [{"type": "text", "text": resp.text}]}


def tool_list(_: Dict[str, Any]) -> Dict[str, Any]:
    resp = call_gateway("GET", "/api/screens")
    if resp.status_code != 200:
        return _err(f"HTTP {resp.status_code}: {resp.text[:300]}")
    return {"content": [{"type": "text", "text": resp.text}]}


def tool_system_info(args: Dict[str, Any]) -> Dict[str, Any]:
    params = {}
    disk_path = str(args.get("disk_path") or "").strip()
    if disk_path:
        params["disk_path"] = disk_path
    resp = call_gateway("GET", "/api/system", params=params)
    if resp.status_code != 200:
        return _err(f"HTTP {resp.status_code}: {resp.text[:300]}")
    return {"content": [{"type": "text", "text": resp.text}]}


def tool_artifact_publish(args: Dict[str, Any]) -> Dict[str, Any]:
    bot_id = str(args["bot_id"]).strip()
    payload = {
        "title": args.get("title", ""),
        "filename": args.get("filename"),
        "content": args["content"],
        "encoding": args.get("encoding", "utf-8"),
        "artifact_type": args.get("artifact_type", ""),
        "kind": args.get("kind", "artifact"),
        "mime_type": args.get("mime_type"),
        "room_id": args.get("room_id", ""),
    }
    resp = call_gateway("POST", f"/api/agent/{bot_id}/artifacts", bot_id, json=payload)
    if resp.status_code != 200:
        return _err(f"HTTP {resp.status_code}: {resp.text[:300]}")
    return {"content": [{"type": "text", "text": resp.text}]}


def tool_artifact_list(args: Dict[str, Any]) -> Dict[str, Any]:
    params: Dict[str, Any] = {"limit": int(args.get("limit", 50))}
    bot_id = str(args.get("bot_id") or "").strip()
    room_id = str(args.get("room_id") or "").strip()
    if room_id:
        params["room_id"] = room_id
    if bot_id:
        params["bot_id"] = bot_id
    resp = call_gateway("GET", "/api/artifacts", params=params)
    if resp.status_code != 200:
        return _err(f"HTTP {resp.status_code}: {resp.text[:300]}")
    return {"content": [{"type": "text", "text": resp.text}]}


HANDLERS = {
    "screen_screenshot": tool_screen_screenshot,
    "screen_click": tool_screen_click,
    "screen_type_text": tool_screen_type,
    "screen_key": tool_screen_key,
    "request_human_help": tool_request_help,
    "wait_human_release": tool_wait_release,
    "screen_status": tool_status,
    "screen_list": tool_list,
    "system_info": tool_system_info,
    "artifact_publish": tool_artifact_publish,
    "artifact_list": tool_artifact_list,
}


def respond(req_id: Any, result: Any) -> None:
    sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": req_id, "result": result}) + "\n")
    sys.stdout.flush()


def respond_error(req_id: Any, code: int, message: str) -> None:
    sys.stdout.write(
        json.dumps({"jsonrpc": "2.0", "id": req_id, "error": {"code": code, "message": message}}) + "\n"
    )
    sys.stdout.flush()


def main() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        method = msg.get("method")
        req_id = msg.get("id")
        params = msg.get("params") or {}

        try:
            if method == "initialize":
                respond(
                    req_id,
                    {
                        "protocolVersion": PROTOCOL_VERSION,
                        "capabilities": {"tools": {"listChanged": False}},
                        "serverInfo": {"name": "botscreen", "version": "1.0.0"},
                    },
                )
            elif method in ("notifications/initialized", "initialized"):
                continue
            elif method == "ping":
                respond(req_id, {})
            elif method == "tools/list":
                respond(req_id, {"tools": TOOLS})
            elif method == "tools/call":
                name = params.get("name")
                handler = HANDLERS.get(name)
                if handler is None:
                    respond_error(req_id, -32602, f"unknown tool: {name}")
                    continue
                respond(req_id, handler(params.get("arguments") or {}))
            elif method == "resources/list":
                respond(req_id, {"resources": []})
            elif method == "prompts/list":
                respond(req_id, {"prompts": []})
            else:
                if req_id is not None:
                    respond_error(req_id, -32601, f"method not found: {method}")
        except Exception as exc:  # noqa: BLE001
            if req_id is not None:
                respond_error(req_id, -32603, f"{type(exc).__name__}: {exc}")


if __name__ == "__main__":
    main()
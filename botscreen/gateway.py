"""Screen Gateway：控制平面。REST 管理面 + Agent 操控面 + KasmVNC 推流代理。"""
from __future__ import annotations

import asyncio
import contextlib
import io
import json
import os
import secrets
import signal
import time
from contextlib import asynccontextmanager
from typing import Dict, List, Optional, Sequence, Union

import httpx
from fastapi import (
    Body,
    Depends,
    FastAPI,
    File,
    HTTPException,
    Header,
    Query,
    Request,
    UploadFile,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.responses import (
    FileResponse,
    HTMLResponse,
    JSONResponse,
    Response,
    StreamingResponse,
)
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .config import (
    CAPTURE_IDLE_HIBERNATE,
    GATEWAY_API_VERSION,
    SCREEN_HEIGHT,
    SCREEN_WIDTH,
    SHARED_XAUTHORITY,
    DEFAULT_BOTS,
    GATEWAY_HOST,
    GATEWAY_PORT,
    IDLE_FREEZE_SECONDS,
    KASMVNC_WWW,
    LONG_FREEZE_SECONDS,
    WATCHDOG_INTERVAL,
    WEB_ROOT,
    SCREENSHOT_FAIL_CLOSED,
    VNC_WEB_DIR,
    X_BACKEND,
    SlotAllocator,
)
from .resources import MemoryBlocked, summarize as memory_summary
from .screen import ScreenWorker
from .state import HumanInControl, StaleLease, State

WEBHOOK_URL = os.environ.get("BOTSCREEN_WEBHOOK_URL", "").strip()
ADMIN_TOKEN = os.environ.get("BOTSCREEN_ADMIN_TOKEN", "").strip()


# ---------------------------------------------------------------- 注册表 -----
class Registry:
    def __init__(self, bot_ids: List[str]) -> None:
        self.slots = SlotAllocator()
        self.workers: Dict[str, ScreenWorker] = {}
        self.human_tokens: Dict[str, dict] = {}  # token -> {bot_id, expires}
        initial = [raw.strip() for raw in bot_ids if raw.strip()]
        for saved_id in self.slots.all_slots():
            if saved_id not in initial:
                initial.append(saved_id)
        for bot_id in initial:
            slot = self.slots.allocate(bot_id)
            self.workers[bot_id] = ScreenWorker(bot_id, slot=slot)

    def get(self, bot_id: str) -> ScreenWorker:
        worker = self.workers.get(bot_id)
        if worker is None:
            raise HTTPException(404, f"unknown bot: {bot_id}")
        return worker

    def ensure(self, bot_id: str) -> ScreenWorker:
        bot_id = bot_id.strip()
        if not bot_id or "/" in bot_id or ".." in bot_id:
            raise HTTPException(400, "invalid bot_id")
        worker = self.workers.get(bot_id)
        if worker is None:
            slot = self.slots.allocate(bot_id)
            worker = ScreenWorker(bot_id, slot=slot)
            self.workers[bot_id] = worker
        worker.prepare()
        return worker

    def remove(self, bot_id: str) -> None:
        worker = self.workers.pop(bot_id, None)
        if worker is not None:
            worker.purge()
        self.slots.release(bot_id)

    def issue_human_token(self, bot_id: str, ttl: float = 3600) -> str:
        token = secrets.token_urlsafe(24)
        self.human_tokens[token] = {"bot_id": bot_id, "expires": time.time() + ttl}
        for tok, meta in list(self.human_tokens.items()):
            if meta["expires"] < time.time():
                self.human_tokens.pop(tok, None)
        return token

    def check_human_token(self, bot_id: str, token: Optional[str]) -> bool:
        if not token:
            return False
        meta = self.human_tokens.get(token)
        return bool(meta and meta["bot_id"] == bot_id and meta["expires"] > time.time())

    def revoke_all_human_tokens(self) -> int:
        n = len(self.human_tokens)
        self.human_tokens.clear()
        return n


# mss / xdotool 都从进程环境读授权文件：网关单进程服务多屏，必须统一指向共享文件
os.environ["XAUTHORITY"] = SHARED_XAUTHORITY

REGISTRY: Optional[Registry] = None


def registry() -> Registry:
    assert REGISTRY is not None, "registry not initialised"
    return REGISTRY


# ---------------------------------------------------------------- 后台守护 ----
async def idle_reaper(reg: Registry) -> None:
    """双信号闲置判定：无观看者满 5s 释放抓屏连接；长时间无活动自动冻结进程树。"""
    while True:
        await asyncio.sleep(2.5)
        now = time.time()
        for worker in reg.workers.values():
            try:
                if (
                    worker.streamer.active_subscribers == 0
                    and worker.driver._grabber is not None
                    and (now - worker.driver._last_capture_at) >= CAPTURE_IDLE_HIBERNATE
                ):
                    await asyncio.to_thread(worker.driver.close_capture)
                if worker.lock.should_freeze(IDLE_FREEZE_SECONDS):
                    await worker.freeze()
            except Exception:  # noqa: BLE001
                continue


async def watchdog(reg: Registry) -> None:
    """进程崩溃自动拉起；冻结态与 cgroup 状态对账。"""
    while True:
        await asyncio.sleep(WATCHDOG_INTERVAL)
        for worker in reg.workers.values():
            lock = worker.lock
            try:
                if lock.state in (State.AGENT_ACTIVE, State.FROZEN) and not worker.healthy():
                    await worker.start()
                elif lock.state is State.FROZEN and not worker.cg.is_frozen(worker.bot_id):
                    await worker.freeze()
                elif lock.state is State.AGENT_ACTIVE and worker.cg.is_frozen(worker.bot_id):
                    await worker.thaw()
                elif worker.healthy() and lock.state in (State.AGENT_ACTIVE, State.HUMAN_TAKEOVER, State.NEED_HUMAN):
                    # 桌面组件（xfdesktop/picom/tint2/iconlayer）会被 X 断连静默带走，
                    # 这里补齐，否则刷新后桌面变黑、图标变蓝方块
                    revived = await asyncio.to_thread(worker.heal_desktop)
                    if revived:
                        worker.auditor.record("desktop_healed", {"revived": revived}, state=lock.state.value)
            except Exception as exc:  # noqa: BLE001
                worker._last_error = f"watchdog: {exc}"


@asynccontextmanager
async def lifespan(app: FastAPI):
    global REGISTRY
    REGISTRY = Registry(DEFAULT_BOTS)
    try:
        REGISTRY.workers[next(iter(REGISTRY.workers))].cg.ensure_root()
    except Exception:  # noqa: BLE001
        pass
    # 接管网关重启前仍在运行的屏（进程树留在原 cgroup，窗口状态完整保留）
    for worker in REGISTRY.workers.values():
        try:
            await asyncio.to_thread(worker.attach)
        except Exception:  # noqa: BLE001
            pass
    tasks = [
        asyncio.create_task(idle_reaper(REGISTRY)),
        asyncio.create_task(watchdog(REGISTRY)),
    ]
    try:
        yield
    finally:
        for task in tasks:
            task.cancel()
        # 网关重启不应该中断虚拟屏：屏的进程树留在 cgroup 里继续持有窗口状态，
        # 新实例启动后按 DISPLAY/cgroup 接续（/api/screens 会显示其状态）。
        # 需要退出即清屏时设 BOTSCREEN_STOP_ON_EXIT=1。
        if os.environ.get("BOTSCREEN_STOP_ON_EXIT", "0") == "1":
            for worker in REGISTRY.workers.values():
                if worker.healthy():
                    try:
                        await asyncio.wait_for(worker.stop(), timeout=6)
                    except (asyncio.TimeoutError, Exception):  # noqa: BLE001
                        pass


app = FastAPI(title="BotScreen Gateway", version="1.0.0", lifespan=lifespan)


# ---------------------------------------------------------------- 鉴权 -------
def require_admin(x_admin_token: Optional[str] = Header(default=None)) -> None:
    if ADMIN_TOKEN and x_admin_token != ADMIN_TOKEN:
        raise HTTPException(401, "bad admin token")


def require_agent(bot_id: str, x_agent_token: Optional[str] = Header(default=None)) -> ScreenWorker:
    worker = registry().get(bot_id)
    if x_agent_token != worker.token:
        raise HTTPException(401, "bad agent token")
    return worker


def locked_response(exc: HumanInControl) -> JSONResponse:
    what = getattr(exc, "what", "control")
    hint = {
        "screenshot": "人类接管期间连截图都拒绝（人可能在输入凭据）；交还后再取图",
        "screen": "屏未就绪，先 start",
    }.get(what, "等待人类点击『交还给 Agent』，或调用 wait_human_release")
    return JSONResponse(
        status_code=423,
        content={
            "detail": "Human in control" if what != "screen" else "Screen not running",
            "bot_id": exc.bot_id,
            "state": exc.state,
            "blocked": what,
            "hint": hint,
        },
    )


def stale_lease_response(exc: StaleLease) -> JSONResponse:
    return JSONResponse(
        status_code=409,
        content={
            "detail": "Lease epoch changed",
            "bot_id": exc.bot_id,
            "expected_epoch": exc.expected,
            "current_epoch": exc.actual,
            "hint": "控制权在你上次调用后被切换过；重新读取 X-Lease-Epoch 再决定动作",
        },
    )


def agent_epoch_header(x_expected_epoch: Optional[str], worker: ScreenWorker) -> dict:
    """带上 X-Expected-Epoch 时校验，并在响应里回传当前 epoch 供下一次比对。"""
    if x_expected_epoch not in (None, ""):
        worker.lock.check_epoch(int(x_expected_epoch))
    return {"X-Lease-Epoch": str(worker.lock.epoch), "X-Lease-Holder": worker.lock.holder}


async def note_help(worker: ScreenWorker, reason: str) -> None:
    if not WEBHOOK_URL:
        return
    payload = {
        "text": f"[BotScreen] {worker.bot_id} 请求人工接管：{reason}",
        "bot_id": worker.bot_id,
        "reason": reason,
        "state": worker.lock.state.value,
    }
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            await client.post(WEBHOOK_URL, json=payload)
    except Exception:  # noqa: BLE001
        pass


# ---------------------------------------------------------------- 管理面 -----
@app.get("/", response_class=HTMLResponse)
async def console() -> Response:
    index = os.path.join(WEB_ROOT, "index.html")
    if not os.path.exists(index):
        return HTMLResponse("<h1>BotScreen</h1><p>web/index.html 缺失</p>")
    with open(index, encoding="utf-8") as fh:
        return HTMLResponse(fh.read())


@app.get("/healthz")
async def healthz() -> dict:
    return {
        "ok": True,
        "api_version": GATEWAY_API_VERSION,
        "capabilities": ["ensure", "tile_stream", "xtest_input", "ratio_coords", "human_pause"],
        "x_backend": X_BACKEND,
        "pid": os.getpid(),
        "bots": len(registry().workers),
    }


@app.post("/api/admin/shutdown", dependencies=[Depends(require_admin)])
async def admin_shutdown() -> dict:
    """供本地 DSH Host 在检测到旧版网关协议时优雅热升级替换。"""
    loop = asyncio.get_running_loop()
    loop.call_later(0.15, lambda: os.kill(os.getpid(), signal.SIGTERM))
    return {"ok": True, "shutting_down": True, "pid": os.getpid()}


@app.get("/api/screens", dependencies=[Depends(require_admin)])
async def list_screens() -> dict:
    return {
        "screens": [w.status() for w in registry().workers.values()],
        "host": memory_summary(),
    }


@app.get("/api/screens/{bot_id}", dependencies=[Depends(require_admin)])
async def screen_status(bot_id: str) -> dict:
    return registry().get(bot_id).status()


@app.post("/api/screens/{bot_id}/ensure", dependencies=[Depends(require_admin)])
async def screen_ensure(bot_id: str, auto_start: bool = Query(False)) -> dict:
    worker = registry().ensure(bot_id)
    if auto_start and not worker.healthy():
        try:
            await worker.start()
        except MemoryBlocked as exc:
            return JSONResponse(status_code=409, content={
                "detail": str(exc), "bot_id": bot_id, "blocked": "memory",
                **memory_summary(),
            })
    out = worker.status()
    out["agent_token"] = worker.token
    out["slot"] = worker.slot
    return out


@app.delete("/api/screens/{bot_id}", dependencies=[Depends(require_admin)])
async def screen_delete(bot_id: str) -> dict:
    await asyncio.to_thread(registry().remove, bot_id)
    return {"deleted": bot_id}


class StartBody(BaseModel):
    apps: Optional[List[List[str]]] = None


@app.post("/api/screens/{bot_id}/start", dependencies=[Depends(require_admin)])
async def screen_start(bot_id: str, body: Optional[StartBody] = Body(default=None)) -> dict:
    worker = registry().ensure(bot_id)
    apps = body.apps if body else None
    try:
        return await worker.start(apps=apps)
    except MemoryBlocked as exc:
        # 内存不足不是错误配置，是可恢复的资源状态 → 409 + 明确原因
        return JSONResponse(status_code=409, content={
            "detail": str(exc), "bot_id": bot_id, "blocked": "memory",
            **memory_summary(),
        })


@app.post("/api/screens/{bot_id}/stop", dependencies=[Depends(require_admin)])
async def screen_stop(bot_id: str) -> dict:
    return await registry().get(bot_id).stop()


@app.post("/api/screens/{bot_id}/freeze", dependencies=[Depends(require_admin)])
async def screen_freeze(bot_id: str) -> dict:
    return await registry().get(bot_id).freeze()


@app.post("/api/screens/{bot_id}/thaw", dependencies=[Depends(require_admin)])
async def screen_thaw(bot_id: str) -> dict:
    return await registry().get(bot_id).thaw()


@app.post("/api/screens/{bot_id}/takeover", dependencies=[Depends(require_admin)])
async def screen_takeover(bot_id: str, reason: str = Query("human")) -> dict:
    worker = registry().ensure(bot_id)
    await worker.ensure_awake()
    await worker.lock.takeover(reason)
    token = registry().issue_human_token(bot_id)
    has_vnc = X_BACKEND == "kasmvnc" or os.environ.get("BOTSCREEN_ENABLE_VNC", "0") == "1"
    out = {
        "bot_id": bot_id,
        "state": worker.lock.state.value,
        "paused": True,
        "token": token,
        "width": SCREEN_WIDTH,
        "height": SCREEN_HEIGHT,
        "tile_stream_url": f"/api/screens/{bot_id}/stream",
        "ws_stream_url": f"/ws/screens/{bot_id}/stream?token={token}",
        "stream_url": (
            f"/vnc/{bot_id}/vnc.html?autoconnect=1&resize=scale"
            f"&path=%2Fvnc%2F{bot_id}%2Fwebsockify&token={token}"
        ) if has_vnc else "",
        "expires_in": 3600,
    }
    return out


@app.post("/api/screens/{bot_id}/release", dependencies=[Depends(require_admin)])
async def screen_release(bot_id: str) -> dict:
    worker = registry().get(bot_id)
    await worker.lock.release()
    return {"bot_id": bot_id, "state": worker.lock.state.value, "paused": False}


class HumanInputBody(BaseModel):
    kind: str  # click | dblclick | mousedown | mouseup | move | move_batch | drag | scroll | type | key | open_app
    x: int = 0
    y: int = 0
    x2: int = 0
    y2: int = 0
    rx: Optional[float] = None
    ry: Optional[float] = None
    rx2: Optional[float] = None
    ry2: Optional[float] = None
    normalized: bool = False
    points: Optional[List[List[float]]] = None
    button: int = 1
    clicks: int = 3
    text: str = ""
    press_enter: bool = False
    combo: str = ""
    app: str = ""
    url: Optional[str] = None


async def _apply_human_input(worker: ScreenWorker, body: HumanInputBody) -> dict:
    if not worker.healthy() or worker.lock.state is not State.HUMAN_TAKEOVER or worker.cg.is_frozen(worker.bot_id):
        await worker.ensure_awake()
    # 人类介入即刻挂起 Bot 输入锁（PAUSE 语义），防止人机争抢光标与焦点
    worker.lock.touch_human()
    kind = body.kind.strip().lower()
    px, py = worker.driver.resolve_xy(body.x, body.y, body.rx, body.ry)
    if kind == "click":
        await asyncio.to_thread(worker.driver.click, px, py, body.button, False)
    elif kind == "dblclick":
        await asyncio.to_thread(worker.driver.click, px, py, body.button, True)
    elif kind == "mousedown":
        await asyncio.to_thread(worker.driver.mousedown, px, py, body.button)
    elif kind == "mouseup":
        await asyncio.to_thread(worker.driver.mouseup, px, py, body.button)
    elif kind == "move":
        await asyncio.to_thread(worker.driver.move, px, py)
    elif kind == "move_batch":
        pts = [p for p in (body.points or []) if isinstance(p, (list, tuple)) and len(p) >= 2]
        await asyncio.to_thread(worker.driver.move_path, pts, body.normalized)
    elif kind == "drag":
        px2, py2 = worker.driver.resolve_xy(body.x2, body.y2, body.rx2, body.ry2)
        await asyncio.to_thread(worker.driver.drag, px, py, px2, py2, body.button)
    elif kind == "scroll":
        await asyncio.to_thread(worker.driver.scroll, px, py, body.clicks)
    elif kind == "type":
        await asyncio.to_thread(worker.driver.type_text, body.text, body.press_enter)
    elif kind == "key":
        await asyncio.to_thread(worker.driver.key, body.combo)
    elif kind == "open_app":
        await asyncio.to_thread(worker.open_app, body.app or "chrome", body.url)
    else:
        raise HTTPException(400, f"unknown human_input kind: {body.kind}")
    worker.streamer.notify_input()
    if kind not in ("move", "move_batch"):
        worker.auditor.record("human_" + kind, {"x": px, "y": py}, state=worker.lock.state.value)
    return {"ok": True, "state": worker.lock.state.value, "paused": worker.lock.state is State.HUMAN_TAKEOVER}


@app.post("/api/screens/{bot_id}/human_input", dependencies=[Depends(require_admin)])
async def screen_human_input(bot_id: str, body: HumanInputBody) -> dict:
    """供内嵌插件 UI 在人工接管期间向虚拟屏发送键鼠事件（支持比例坐标 + 免 Root XTest）。"""
    worker = registry().ensure(bot_id)
    return await _apply_human_input(worker, body)


@app.get("/api/screens/{bot_id}/stream", dependencies=[Depends(require_admin)])
async def screen_tile_stream_sse(
    request: Request,
    bot_id: str,
    fmt: str = Query("jpeg"),
) -> StreamingResponse:
    """按需 64×64 脏矩形增量帧 SSE 流；无变化零流量，断开 5 秒自动销毁抓屏连接。"""
    worker = registry().ensure(bot_id)
    sub = await worker.streamer.subscribe(fmt=fmt)

    async def _gen():
        try:
            meta = {
                "type": "meta",
                "bot_id": bot_id,
                "w": SCREEN_WIDTH,
                "h": SCREEN_HEIGHT,
                "state": worker.lock.state.value,
            }
            yield f"data: {json.dumps(meta, separators=(',', ':'))}\n\n"
            while True:
                if await request.is_disconnected():
                    break
                try:
                    pkt = await asyncio.wait_for(sub.queue.get(), timeout=12.0)
                    yield f"data: {json.dumps(pkt, separators=(',', ':'))}\n\n"
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
        except asyncio.CancelledError:
            return
        finally:
            worker.streamer.unsubscribe(sub)

    return StreamingResponse(
        _gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.websocket("/ws/screens/{bot_id}/stream")
async def screen_tile_stream_ws(
    websocket: WebSocket,
    bot_id: str,
    fmt: str = Query("jpeg"),
    token: Optional[str] = Query(default=None),
):
    """WebSocket 双向按需增量流：下行 64×64 脏块帧，上行比例坐标键鼠注入。"""
    admin_hdr = websocket.headers.get("x-admin-token", "")
    admin_ok = (not ADMIN_TOKEN) or (admin_hdr == ADMIN_TOKEN)
    cookie_token = websocket.cookies.get(f"botscreen_human_{bot_id}")
    token_ok = registry().check_human_token(bot_id, token) or registry().check_human_token(bot_id, cookie_token)
    if not (admin_ok or token_ok):
        await websocket.close(code=4401)
        return

    worker = registry().ensure(bot_id)
    await websocket.accept()
    sub = await worker.streamer.subscribe(fmt=fmt)

    async def _sender():
        await websocket.send_text(json.dumps({
            "type": "meta",
            "bot_id": bot_id,
            "w": SCREEN_WIDTH,
            "h": SCREEN_HEIGHT,
            "state": worker.lock.state.value,
        }, separators=(",", ":")))
        while True:
            pkt = await sub.queue.get()
            await websocket.send_text(json.dumps(pkt, separators=(",", ":")))

    async def _receiver():
        while True:
            raw = await websocket.receive_text()
            data = json.loads(raw)
            if isinstance(data, dict) and data.get("kind"):
                await _apply_human_input(worker, HumanInputBody(**data))

    tasks = [asyncio.create_task(_sender()), asyncio.create_task(_receiver())]
    try:
        done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for t in pending:
            t.cancel()
        for t in done:
            with contextlib.suppress(BaseException):
                t.result()
    except (WebSocketDisconnect, asyncio.CancelledError):
        pass
    finally:
        for t in tasks:
            if not t.done():
                t.cancel()
        worker.streamer.unsubscribe(sub)
        with contextlib.suppress(Exception):
            await websocket.close()


@app.post("/api/screens/{bot_id}/brake", dependencies=[Depends(require_admin)])
async def screen_brake(bot_id: str) -> dict:
    """单屏紧急制动：冻结进程 + 吊销 Agent Token + 吊销人类 Token。"""
    worker = registry().get(bot_id)
    await worker.freeze()
    worker.rotate_token()
    registry().revoke_all_human_tokens()
    worker.auditor.record("brake", {"by": "human"}, state=worker.lock.state.value)
    return {"bot_id": bot_id, "state": worker.lock.state.value, "token_rotated": True}


@app.post("/api/brake", dependencies=[Depends(require_admin)])
async def global_brake() -> dict:
    """全局紧急制动：所有屏冻结 + 全部 Token 失效。"""
    frozen = []
    for worker in registry().workers.values():
        if worker.healthy():
            await worker.freeze()
        worker.rotate_token()
        worker.auditor.record("global_brake", {"by": "human"}, state=worker.lock.state.value)
        frozen.append(worker.bot_id)
    registry().revoke_all_human_tokens()
    return {"frozen": frozen, "tokens_rotated": True}


@app.get("/api/screens/{bot_id}/preview", dependencies=[Depends(require_admin)])
async def screen_preview(
    bot_id: str,
    cached: bool = Query(False),
    only_cached: bool = Query(False),
) -> Response:
    """控制台低频静态快照（只读，不改变状态机，不续命闲置计时）。

    * `only_cached=1`：若已有缓存帧则直接返回零抓屏开销；仅首次无缓存时抓一帧（5s 后自动释放抓屏器）。
    * 冻结屏传 `cached=1` 返回冻结前最后一帧缓存。
    """
    worker = registry().get(bot_id)
    if not worker.healthy():
        raise HTTPException(409, "screen not running")
    if worker.lock.state is State.FROZEN:
        if cached and worker.last_preview:
            return Response(
                worker.last_preview,
                media_type="image/jpeg",
                headers={
                    "Cache-Control": "no-store",
                    "X-Screen-Frozen": "true",
                    "X-Screen-Width": str(SCREEN_WIDTH),
                    "X-Screen-Height": str(SCREEN_HEIGHT),
                },
            )
        raise HTTPException(409, "screen frozen")
    if only_cached and worker.last_preview:
        return Response(
            worker.last_preview,
            media_type="image/jpeg",
            headers={
                "Cache-Control": "no-store",
                "X-Screen-Width": str(SCREEN_WIDTH),
                "X-Screen-Height": str(SCREEN_HEIGHT),
            },
        )
    shot = await asyncio.to_thread(worker.driver.screenshot, "jpeg", 70, False)
    worker.last_preview = shot.data
    worker.last_preview_at = time.time()
    return Response(
        shot.data,
        media_type=shot.mime,
        headers={
            "Cache-Control": "no-store",
            "X-Screen-Width": str(shot.width),
            "X-Screen-Height": str(shot.height),
        },
    )


@app.get("/api/screens/{bot_id}/audit")
async def audit_tail(bot_id: str, limit: int = Query(50, ge=1, le=500)) -> dict:
    worker = registry().get(bot_id)
    return {"bot_id": bot_id, "entries": worker.auditor.tail(limit)}


@app.get("/api/screens/{bot_id}/audit/thumb/{name}")
async def audit_thumb(bot_id: str, name: str) -> Response:
    worker = registry().get(bot_id)
    safe = os.path.basename(name)
    path = os.path.join(worker.auditor.thumb_dir, safe)
    if not os.path.exists(path):
        raise HTTPException(404, "thumb not found")
    return FileResponse(path, media_type="image/webp")


# ---------------------------------------------------------------- 文件中转 ---
@app.get("/api/screens/{bot_id}/files")
async def list_files(bot_id: str) -> dict:
    worker = registry().get(bot_id)
    out = []
    for name in sorted(os.listdir(worker.paths.downloads)):
        full = os.path.join(worker.paths.downloads, name)
        if os.path.isfile(full):
            out.append({"name": name, "size": os.path.getsize(full), "mtime": os.path.getmtime(full)})
    return {"bot_id": bot_id, "files": out}


@app.post("/api/screens/{bot_id}/files")
async def upload_file(bot_id: str, file: UploadFile = File(...)) -> dict:
    worker = registry().get(bot_id)
    name = os.path.basename(file.filename or "upload.bin")
    dest = os.path.join(worker.paths.downloads, name)
    size = 0
    with open(dest, "wb") as fh:
        while chunk := await file.read(1 << 20):
            fh.write(chunk)
            size += len(chunk)
    return {"bot_id": bot_id, "name": name, "size": size}


@app.get("/api/screens/{bot_id}/files/{name}")
async def download_file(bot_id: str, name: str) -> FileResponse:
    worker = registry().get(bot_id)
    safe = os.path.basename(name)
    path = os.path.join(worker.paths.downloads, safe)
    if not os.path.exists(path):
        raise HTTPException(404, "file not found")
    return FileResponse(path, filename=safe)


@app.delete("/api/screens/{bot_id}/files/{name}")
async def delete_file(bot_id: str, name: str) -> dict:
    worker = registry().get(bot_id)
    safe = os.path.basename(name)
    path = os.path.join(worker.paths.downloads, safe)
    if os.path.exists(path):
        os.unlink(path)
        return {"deleted": safe}
    raise HTTPException(404, "file not found")


# ---------------------------------------------------------------- Agent 面 ---
@app.get("/api/agent/{bot_id}/screenshot")
async def agent_screenshot(
    bot_id: str,
    fmt: str = Query("jpeg"),
    audit_thumb: bool = Query(False),
    include_focus: bool = Query(False),
    x_agent_token: Optional[str] = Header(default=None),
    x_expected_epoch: Optional[str] = Header(default=None),
) -> Response:
    worker = require_agent(bot_id, x_agent_token)
    if SCREENSHOT_FAIL_CLOSED:
        # 人类接管时连截图都拒绝：人可能正在输入凭据，fail-closed 比“相信 Agent 会自己暂停”可靠
        try:
            worker.lock.guard_agent(screenshot=True)
        except HumanInControl as exc:
            return locked_response(exc)
    try:
        epoch_headers = agent_epoch_header(x_expected_epoch, worker)
    except StaleLease as exc:
        return stale_lease_response(exc)
    st = await worker.ensure_awake()
    worker.lock.touch_agent()
    # 截屏是高频只读动作：只记元数据，不落缩略图（省 30ms + 一次磁盘写）。
    # 需要留图时传 ?audit_thumb=1。
    want_thumb = audit_thumb
    shot = await asyncio.to_thread(worker.driver.screenshot, fmt, 82, want_thumb)
    if shot.mime == "image/jpeg":
        worker.last_preview = shot.data
        worker.last_preview_at = time.time()
    worker.auditor.record(
        "screenshot",
        {"mime": shot.mime, "w": shot.width, "h": shot.height},
        thumb=shot.thumb,
        state=worker.lock.state.value,
    )
    headers = {
        "X-Screen-Width": str(shot.width),
        "X-Screen-Height": str(shot.height),
        "X-Screen-State": worker.lock.state.value,
        "X-Resumed-From-Long-Freeze": str(st.get("resumed_from_long_freeze", False)).lower(),
        "X-Focused-Window": json.dumps(
            await asyncio.to_thread(worker.driver.focused_window)
        ) if include_focus else "{}",
        **epoch_headers,
    }
    return Response(shot.data, media_type=shot.mime, headers=headers)


async def _run_agent_mutation(
    worker: ScreenWorker,
    x_expected_epoch: Optional[str],
    action: str,
    meta: dict,
    fn,
    want_thumb: bool = False,
):
    try:
        worker.lock.guard_agent()
        agent_epoch_header(x_expected_epoch, worker)
    except HumanInControl as exc:
        return locked_response(exc)
    except StaleLease as exc:
        return stale_lease_response(exc)
    await worker.ensure_awake()
    async with worker.lock.op_lock:
        try:
            worker.lock.guard_agent()
            agent_epoch_header(x_expected_epoch, worker)
        except HumanInControl as exc:
            return locked_response(exc)
        except StaleLease as exc:
            return stale_lease_response(exc)
        thumb = None
        if want_thumb:
            thumb = (await asyncio.to_thread(worker.driver.screenshot, "jpeg", 82, True)).thumb
        res = await asyncio.to_thread(fn)
        worker.auditor.record(action, meta, thumb=thumb, state=worker.lock.state.value)
        worker.lock.touch_agent()
        worker.streamer.notify_input()
        base = res if isinstance(res, dict) else {"ok": True}
        return {**base, "state": worker.lock.state.value, "epoch": worker.lock.epoch}


class ClickBody(BaseModel):
    x: int = Field(ge=0, le=10000)
    y: int = Field(ge=0, le=10000)
    button: int = Field(default=1, ge=1, le=9)
    double: bool = False


@app.post("/api/agent/{bot_id}/click")
async def agent_click(
    bot_id: str,
    body: ClickBody,
    x_agent_token: Optional[str] = Header(default=None),
    x_expected_epoch: Optional[str] = Header(default=None),
):
    worker = require_agent(bot_id, x_agent_token)
    return await _run_agent_mutation(
        worker,
        x_expected_epoch,
        "click",
        {"x": body.x, "y": body.y, "button": body.button, "double": body.double},
        lambda: worker.driver.click(body.x, body.y, body.button, body.double),
        want_thumb=True,
    )


class TypeBody(BaseModel):
    text: str = ""
    press_enter: bool = False
    paste_key: str = "ctrl+v"


@app.post("/api/agent/{bot_id}/type")
async def agent_type(
    bot_id: str,
    body: TypeBody,
    x_agent_token: Optional[str] = Header(default=None),
    x_expected_epoch: Optional[str] = Header(default=None),
):
    worker = require_agent(bot_id, x_agent_token)
    return await _run_agent_mutation(
        worker,
        x_expected_epoch,
        "type",
        {"text": body.text[:200], "press_enter": body.press_enter, "paste_key": body.paste_key},
        lambda: worker.driver.type_text(body.text, body.press_enter, body.paste_key),
        want_thumb=True,
    )


class ScrollBody(BaseModel):
    x: int = Field(default=640, ge=0, le=10000)
    y: int = Field(default=360, ge=0, le=10000)
    clicks: int = Field(default=3, ge=-50, le=50)


@app.post("/api/agent/{bot_id}/scroll")
async def agent_scroll(
    bot_id: str,
    body: ScrollBody,
    x_agent_token: Optional[str] = Header(default=None),
    x_expected_epoch: Optional[str] = Header(default=None),
):
    worker = require_agent(bot_id, x_agent_token)
    return await _run_agent_mutation(
        worker,
        x_expected_epoch,
        "scroll",
        {"x": body.x, "y": body.y, "clicks": body.clicks},
        lambda: worker.driver.scroll(body.x, body.y, body.clicks),
    )


class DragBody(BaseModel):
    x1: int = Field(ge=0, le=10000)
    y1: int = Field(ge=0, le=10000)
    x2: int = Field(ge=0, le=10000)
    y2: int = Field(ge=0, le=10000)
    button: int = Field(default=1, ge=1, le=9)


@app.post("/api/agent/{bot_id}/drag")
async def agent_drag(
    bot_id: str,
    body: DragBody,
    x_agent_token: Optional[str] = Header(default=None),
    x_expected_epoch: Optional[str] = Header(default=None),
):
    worker = require_agent(bot_id, x_agent_token)
    return await _run_agent_mutation(
        worker,
        x_expected_epoch,
        "drag",
        {"x1": body.x1, "y1": body.y1, "x2": body.x2, "y2": body.y2},
        lambda: worker.driver.drag(body.x1, body.y1, body.x2, body.y2, body.button),
        want_thumb=True,
    )


class OpenAppBody(BaseModel):
    app: str = "chrome"
    url: Optional[str] = None


@app.post("/api/agent/{bot_id}/open_app")
async def agent_open_app(
    bot_id: str,
    body: OpenAppBody,
    x_agent_token: Optional[str] = Header(default=None),
    x_expected_epoch: Optional[str] = Header(default=None),
):
    worker = require_agent(bot_id, x_agent_token)
    return await _run_agent_mutation(
        worker,
        x_expected_epoch,
        "open_app",
        {"app": body.app, "url": body.url},
        lambda: worker.open_app(body.app, body.url),
    )


@app.get("/api/agent/{bot_id}/windows")
async def agent_windows(
    bot_id: str,
    x_agent_token: Optional[str] = Header(default=None),
) -> dict:
    worker = require_agent(bot_id, x_agent_token)
    try:
        worker.lock.guard_agent(screenshot=True)
    except HumanInControl as exc:
        return locked_response(exc)
    await worker.ensure_awake()
    focused = await asyncio.to_thread(worker.driver.focused_window)
    windows = await asyncio.to_thread(worker.driver.list_windows)
    worker.lock.touch_agent()
    return {"focused": focused, "windows": windows, "state": worker.lock.state.value, "epoch": worker.lock.epoch}


class KeyBody(BaseModel):
    combo: str


@app.post("/api/agent/{bot_id}/key")
async def agent_key(
    bot_id: str,
    body: KeyBody,
    x_agent_token: Optional[str] = Header(default=None),
    x_expected_epoch: Optional[str] = Header(default=None),
):
    worker = require_agent(bot_id, x_agent_token)
    return await _run_agent_mutation(
        worker,
        x_expected_epoch,
        "key",
        {"combo": body.combo},
        lambda: worker.driver.key(body.combo),
    )


class HelpBody(BaseModel):
    reason: str


@app.post("/api/agent/{bot_id}/request_help")
async def agent_request_help(
    bot_id: str,
    body: HelpBody,
    x_agent_token: Optional[str] = Header(default=None),
) -> dict:
    worker = require_agent(bot_id, x_agent_token)
    if worker.lock.state is State.HUMAN_TAKEOVER:
        return locked_response(HumanInControl(bot_id, worker.lock.state.value, "control"))
    await worker.ensure_awake()
    await worker.lock.request_help(body.reason)
    worker.auditor.record("request_help", {"reason": body.reason}, state=worker.lock.state.value)
    asyncio.create_task(note_help(worker, body.reason))
    return {
        "ok": True,
        "state": worker.lock.state.value,
        "wait_seconds": 60,
        "takeover_url": f"/api/screens/{bot_id}/takeover",
    }


@app.post("/api/agent/{bot_id}/wait_release")
async def agent_wait_release(
    bot_id: str,
    timeout: float = Query(60.0, ge=1, le=300),
    x_agent_token: Optional[str] = Header(default=None),
) -> dict:
    """Agent 被 423 挡下后调用：阻塞等待人类交还控制权。"""
    worker = require_agent(bot_id, x_agent_token)
    released = await worker.lock.wait_for_release(timeout)
    return {"released": released, "state": worker.lock.state.value}


# ---------------------------------------------------------------- 推流代理 ---
async def _bridge_client_to_upstream(ws: WebSocket, upstream, worker: ScreenWorker) -> None:
    while True:
        message = await ws.receive()
        if message["type"] == "websocket.disconnect":
            return
        if (data := message.get("bytes")) is not None:
            # RFB 客户端消息：4=KeyEvent, 5=PointerEvent → 人类输入抢占
            if data[:1] in (b"\x04", b"\x05"):
                worker.lock.touch_human()
            await upstream.send(data)
        elif (text := message.get("text")) is not None:
            await upstream.send(text)


async def _bridge_upstream_to_client(ws: WebSocket, upstream) -> None:
    async for message in upstream:
        if isinstance(message, bytes):
            await ws.send_bytes(message)
        else:
            await ws.send_text(message)


@app.websocket("/vnc/{bot_id}/websockify")
async def ws_proxy(websocket: WebSocket, bot_id: str, token: Optional[str] = Query(default=None)):
    try:
        worker = registry().get(bot_id)
    except HTTPException:
        await websocket.close(code=4404)
        return

    cookie_token = websocket.cookies.get(f"botscreen_human_{bot_id}")
    if not (registry().check_human_token(bot_id, token) or registry().check_human_token(bot_id, cookie_token)):
        await websocket.close(code=4401)
        return

    await worker.ensure_awake()
    # 只在客户端确实请求了子协议时才回它；否则浏览器会因
    # "Response must not include 'Sec-WebSocket-Protocol' header if not present in request" 拒绝握手
    requested = websocket.headers.get("sec-websocket-protocol")
    subproto = requested.split(",")[0].strip() if requested else None
    await websocket.accept(subprotocol=subproto)

    # KasmVNC 强制校验 Sec-WebSocket-Origin，且只认 /websockify 路径
    import websockets
    from websockets.asyncio.client import connect as ws_connect

    try:
        upstream = await ws_connect(
            f"ws://127.0.0.1:{worker.ws_port}/websockify",
            # 不协商子协议：KasmVNC 会回 "binary"，websockify 不回，
            # 传了反而会因不一致被 websockets 客户端判为非法握手
            subprotocols=None,
            additional_headers={
                "Origin": f"http://127.0.0.1:{worker.ws_port}",
            },
            max_size=None,
            open_timeout=10,
        )
    except Exception as exc:  # noqa: BLE001
        await websocket.send_json({"error": f"upstream connect failed: {exc}"})
        await websocket.close(code=1011)
        return

    worker.lock.viewers += 1
    tasks = [
        asyncio.create_task(_bridge_client_to_upstream(websocket, upstream, worker)),
        asyncio.create_task(_bridge_upstream_to_client(websocket, upstream)),
    ]
    try:
        # 任一方向结束就收尾：WebSocket 是全双工的，用 gather 会挂在另一端上
        done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in pending:
            task.cancel()
        for task in pending:
            with contextlib.suppress(BaseException):
                await task
        for task in done:
            with contextlib.suppress(BaseException):
                task.result()
    except (WebSocketDisconnect, asyncio.CancelledError):
        pass
    finally:
        for task in tasks:
            if not task.done():
                task.cancel()
        worker.lock.viewers = max(0, worker.lock.viewers - 1)
        try:
            await upstream.close()
        except Exception:  # noqa: BLE001
            pass
        try:
            await websocket.close()
        except Exception:  # noqa: BLE001
            pass


# ---------------------------------------------------------------- 静态前端 ---
def _mount_static() -> None:
    # 前端静态资源：X.Org 后端用 noVNC，KasmVNC 后端用自带 www
    web_dir = VNC_WEB_DIR if X_BACKEND == "xvfb" else KASMVNC_WWW
    if os.path.isdir(web_dir):
        app.mount("/vnc-static", StaticFiles(directory=web_dir), name="vncweb")
    assets = os.path.join(WEB_ROOT, "assets")
    if os.path.isdir(assets):
        app.mount("/assets", StaticFiles(directory=assets), name="console-assets")


@app.get("/vnc/{bot_id}/{page:path}")
async def vnc_page(bot_id: str, page: str, token: Optional[str] = Query(default=None)) -> Response:
    """把 KasmVNC 自带前端挂到 /vnc/{bot_id}/ 下，静态资源指向 /vnc-static。"""
    try:
        worker = registry().get(bot_id)
    except HTTPException:
        raise HTTPException(404, "unknown bot")

    web_dir = VNC_WEB_DIR if X_BACKEND == "xvfb" else KASMVNC_WWW
    target = os.path.join(web_dir, page or "vnc.html")
    is_html = target.endswith(".html")
    cookie_token = None
    if is_html:
        # 只有页面本身需要接管令牌；页面内的 app/locale、assets 等静态资源
        # 由同源 Cookie 隐式授权，避免前端 fetch 被 401 打断
        cookie_token = token
        if not registry().check_human_token(bot_id, token):
            return HTMLResponse(
                "<h1>401</h1><p>缺少有效的接管令牌，请从控制台点击「接管」进入。</p>",
                status_code=401,
            )
    if not os.path.abspath(target).startswith(os.path.abspath(web_dir)):
        raise HTTPException(403, "path traversal")
    if not os.path.isfile(target):
        raise HTTPException(404, page)

    set_cookie = None
    if target.endswith((".html", ".js", ".css")):
        with open(target, "rb") as fh:
            body = fh.read()
        if target.endswith(".html"):
            # KasmVNC 检测到自身在 iframe 内会切到 VDI 模式并等待父窗口 postMessage，
            # 导致画面停在 splash。网关内嵌场景强制按顶层运行。
            body = body.replace(
                b"isInsideKasmVDI=window.self!==window.top", b"isInsideKasmVDI=!1"
            )
            body = body.replace(
                b"isInsideKasmVDI=window.self!==window.top?1:0", b"isInsideKasmVDI=!1"
            )
            set_cookie = (
                f"botscreen_human_{bot_id}={token or ''}; Path=/vnc/{bot_id}; "
                "HttpOnly; SameSite=Lax; Max-Age=3600"
            )
        # 把相对资源路径指向网关的静态挂载点（KasmVNC 与 noVNC 的布局都用这一组）
        for prefix in ("./assets/", "./app/", "./core/", "./vendor/", "./utils/", "./lib/", "./locales/"):
            body = body.replace(prefix.encode(), b"/vnc-static/" + prefix[2:].encode())
        for name in ("screen.bundle.js", "favicon.ico", "manifest.json"):
            body = body.replace(("./" + name).encode(), ("/vnc-static/" + name).encode())
        media = "text/html" if target.endswith(".html") else (
            "application/javascript" if target.endswith(".js") else "text/css"
        )
        headers = {"Cache-Control": "no-store"}
        if set_cookie:
            headers["Set-Cookie"] = set_cookie
        return Response(body, media_type=f"{media}; charset=utf-8", headers=headers)

    return FileResponse(target)


_mount_static()


def main() -> None:
    import uvicorn

    uvicorn.run(
        "botscreen.gateway:app",
        host=GATEWAY_HOST,
        port=GATEWAY_PORT,
        log_level=os.environ.get("BOTSCREEN_LOG_LEVEL", "info"),
    )


if __name__ == "__main__":
    main()
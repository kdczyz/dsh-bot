"""按需 64×64 脏矩形增量帧推流引擎 + 5 秒空闲自动休眠。

设计原则
--------
* **平时零抓屏、零编码开销**：无观看连接时不运行任何后台抓屏协程，不持有 XShm 缓冲区。
* **64×64 内存分块比对**：有观看者接入时按可调档位（默认 15fps≈67ms，支持 30/15/10）采样 `XShmGetImage`：
  - 整帧字节完全一致时 0.2ms 短路跳过，网络零流量、CPU ~0%；
  - 发生变化时在 `memoryview` 上零拷贝比对 64×64 网格，合并相邻脏块后编码成 JPEG/WebP
    发给前端 `<canvas>` 局部重绘（脏块占比 >55% 时自动退化为单张关键帧）。
* **断开 5 秒自动休眠**：最后一个观看者断开满 5 秒后立即清空上一帧缓存并调用
  `driver.close_capture()` 卸载 XShm + 关闭抓屏 X11 连接；若处于人工临时接管态且无未决
  `request_help` 求助单，同时自动释放锁恢复 Bot 运行。
"""
from __future__ import annotations

import asyncio
import base64
import io
import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Dict, List, Optional, Set, Tuple

from PIL import Image

from .config import (
    CAPTURE_IDLE_HIBERNATE,
    TILE_SIZE,
    get_stream_interval_ms,
)
from .driver import RawFrame
from .state import State

if TYPE_CHECKING:
    from .screen import ScreenWorker


def diff_grid_rects(
    prev: RawFrame,
    curr: RawFrame,
    tile_size: int = TILE_SIZE,
) -> Tuple[List[Tuple[int, int, int, int]], int, int]:
    """在 64×64 网格上做零拷贝内存比对，并将相邻脏块合并为矩形列表。

    返回 `(rects, dirty_cells, total_cells)`，其中每个 `rect` 为 `(x, y, w, h)`。
    """
    w, h = curr.width, curr.height
    cols = max(1, (w + tile_size - 1) // tile_size)
    rows = max(1, (h + tile_size - 1) // tile_size)
    total = rows * cols

    if (
        prev.width != w
        or prev.height != h
        or prev.stride != curr.stride
        or prev.bpp != curr.bpp
    ):
        return [(0, 0, w, h)], total, total

    if prev.data == curr.data:
        return [], 0, total

    bpp_bytes = 2 if curr.bpp == 16 else 4
    stride = curr.stride
    mv_prev = memoryview(prev.data)
    mv_curr = memoryview(curr.data)

    dirty_Count = 0
    row_spans: List[List[Tuple[int, int]]] = []

    for r in range(rows):
        y0 = r * tile_size
        y1 = min(h, y0 + tile_size)
        spans: List[Tuple[int, int]] = []
        run_start: Optional[int] = None
        for c in range(cols):
            x0 = c * tile_size
            x1 = min(w, x0 + tile_size)
            b0 = x0 * bpp_bytes
            b1 = x1 * bpp_bytes
            cell_dirty = False
            for y in range(y0, y1):
                row_off = y * stride
                if mv_curr[row_off + b0 : row_off + b1] != mv_prev[row_off + b0 : row_off + b1]:
                    cell_dirty = True
                    break
            if cell_dirty:
                dirty_Count += 1
                if run_start is None:
                    run_start = c
            elif run_start is not None:
                spans.append((run_start, c))
                run_start = None
        if run_start is not None:
            spans.append((run_start, cols))
        row_spans.append(spans)

    if dirty_Count == 0:
        return [], 0, total

    # 纵向合并同列跨度的连续行，减少编码次数与 JSON 包头开销
    active: Dict[Tuple[int, int], Tuple[int, int]] = {}  # (c0, c1) -> (r0, r1)
    merged_cells: List[Tuple[int, int, int, int]] = []
    for r, spans in enumerate(row_spans):
        next_active: Dict[Tuple[int, int], Tuple[int, int]] = {}
        span_set = set(spans)
        for key, (r0, r1) in active.items():
            if key in span_set:
                next_active[key] = (r0, r + 1)
                span_set.remove(key)
            else:
                merged_cells.append((key[0], r0, key[1], r1))
        for key in span_set:
            next_active[key] = (r, r + 1)
        active = next_active
    for key, (r0, r1) in active.items():
        merged_cells.append((key[0], r0, key[1], r1))

    rects: List[Tuple[int, int, int, int]] = []
    for c0, r0, c1, r1 in merged_cells:
        x0 = c0 * tile_size
        y0 = r0 * tile_size
        x1 = min(w, c1 * tile_size)
        y1 = min(h, r1 * tile_size)
        rects.append((x0, y0, x1 - x0, y1 - y0))
    return rects, dirty_Count, total


def _encode_region(img: Image.Image, fmt: str, quality: int = 74) -> Tuple[str, str]:
    buf = io.BytesIO()
    if fmt == "webp":
        img.save(buf, format="WEBP", quality=quality, method=0)
        mime = "image/webp"
    else:
        img.save(buf, format="JPEG", quality=quality, optimize=False, subsampling=1)
        mime = "image/jpeg"
    return base64.b64encode(buf.getvalue()).decode("ascii"), mime


def _build_packets(
    prev_raw: Optional[RawFrame],
    curr_raw: RawFrame,
    need_keyframe: bool,
    need_delta: bool,
    fmt: str,
    seq: int,
    ts_ms: int = 0,
) -> Tuple[Optional[dict], Optional[dict], Optional[bytes]]:
    """在工作线程内完成像素比对与编码，返回 `(keyframe_pkt, delta_pkt, jpeg_preview)`。"""
    w, h = curr_raw.width, curr_raw.height
    keyframe_pkt: Optional[dict] = None
    delta_pkt: Optional[dict] = None
    preview_bytes: Optional[bytes] = None
    img: Optional[Image.Image] = None

    def ensure_img() -> Image.Image:
        nonlocal img
        if img is None:
            img = curr_raw.to_image()
        return img

    def stamp(pkt: Optional[dict]) -> Optional[dict]:
        """附加网关侧时间标记，供前端计算到网关的单程延迟与实际帧率。"""
        if pkt is not None:
            pkt["ts"] = ts_ms
        return pkt

    if need_keyframe:
        full_img = ensure_img()
        b64, mime = _encode_region(full_img, fmt, quality=72)
        if mime == "image/jpeg":
            preview_bytes = base64.b64decode(b64)
        keyframe_pkt = {
            "type": "frame",
            "seq": seq,
            "full": True,
            "w": full_img.width,
            "h": full_img.height,
            "mime": mime,
            "tiles": [{"x": 0, "y": 0, "w": full_img.width, "h": full_img.height, "d": b64}],
        }
        keyframe_pkt = stamp(keyframe_pkt)

    if need_delta and prev_raw is not None:
        rects, dirty_cells, total_cells = diff_grid_rects(prev_raw, curr_raw, TILE_SIZE)
        if dirty_cells > 0:
            if dirty_cells / max(1, total_cells) > 0.55:
                if keyframe_pkt is not None:
                    delta_pkt = keyframe_pkt
                else:
                    full_img = ensure_img()
                    b64, mime = _encode_region(full_img, fmt, quality=72)
                    if mime == "image/jpeg":
                        preview_bytes = base64.b64decode(b64)
                    delta_pkt = {
                        "type": "frame",
                        "seq": seq,
                        "full": True,
                        "w": full_img.width,
                        "h": full_img.height,
                        "mime": mime,
                        "tiles": [{"x": 0, "y": 0, "w": full_img.width, "h": full_img.height, "d": b64}],
                    }
                    delta_pkt = stamp(delta_pkt)
            else:
                full_img = ensure_img()
                tiles = []
                mime = "image/webp" if fmt == "webp" else "image/jpeg"
                for rx, ry, rw, rh in rects:
                    crop = full_img.crop((rx, ry, rx + rw, ry + rh))
                    b64, mime = _encode_region(crop, fmt, quality=76)
                    tiles.append({"x": rx, "y": ry, "w": rw, "h": rh, "d": b64})
                delta_pkt = {
                    "type": "frame",
                    "seq": seq,
                    "full": False,
                    "w": full_img.width,
                    "h": full_img.height,
                    "mime": mime,
                    "tiles": tiles,
                }
                delta_pkt = stamp(delta_pkt)

    return keyframe_pkt, delta_pkt, preview_bytes


@dataclass(eq=False)
class Subscriber:
    fmt: str = "jpeg"
    needs_keyframe: bool = True
    queue: asyncio.Queue = field(default_factory=lambda: asyncio.Queue(maxsize=4))


class TileStreamHub:
    """单张虚拟屏的按需分块增量推流中心。"""

    def __init__(self, worker: "ScreenWorker") -> None:
        self.worker = worker
        self._subscribers: Set[Subscriber] = set()
        self._pump_task: Optional[asyncio.Task] = None
        self._hibernate_task: Optional[asyncio.Task] = None
        self._prev_raw: Optional[RawFrame] = None
        self._seq: int = 0
        self._nudge = asyncio.Event()

    @property
    def active_subscribers(self) -> int:
        return len(self._subscribers)

    @property
    def capture_active(self) -> bool:
        return self._pump_task is not None and not self._pump_task.done()

    def notify_input(self) -> None:
        """键鼠注入后立即唤醒下一次采样，降低交互视觉延迟。"""
        self._nudge.set()

    async def subscribe(self, fmt: str = "jpeg") -> Subscriber:
        fmt_norm = "webp" if fmt == "webp" else "jpeg"
        if self._hibernate_task is not None:
            self._hibernate_task.cancel()
            self._hibernate_task = None

        await self.worker.ensure_awake()
        sub = Subscriber(fmt=fmt_norm, needs_keyframe=True)
        self._subscribers.add(sub)
        self.worker.lock.viewers = len(self._subscribers)

        if self._pump_task is None or self._pump_task.done():
            self._pump_task = asyncio.create_task(self._pump_loop())
        else:
            self._nudge.set()
        return sub

    def unsubscribe(self, sub: Subscriber) -> None:
        if sub not in self._subscribers:
            return
        self._subscribers.discard(sub)
        self.worker.lock.viewers = len(self._subscribers)
        if not self._subscribers:
            if self._pump_task is not None and not self._pump_task.done():
                self._pump_task.cancel()
            self._pump_task = None
            if self._hibernate_task is not None:
                self._hibernate_task.cancel()
            try:
                loop = asyncio.get_running_loop()
                self._hibernate_task = loop.create_task(self._hibernate_after_idle())
            except RuntimeError:
                self._prev_raw = None
                self.worker.driver.close_capture()

    async def shutdown(self) -> None:
        if self._pump_task is not None:
            self._pump_task.cancel()
            self._pump_task = None
        if self._hibernate_task is not None:
            self._hibernate_task.cancel()
            self._hibernate_task = None
        for sub in list(self._subscribers):
            self._subscribers.discard(sub)
        self.worker.lock.viewers = 0
        self._prev_raw = None
        await asyncio.to_thread(self.worker.driver.close_capture)

    async def _hibernate_after_idle(self) -> None:
        try:
            await asyncio.sleep(CAPTURE_IDLE_HIBERNATE)
            if self._subscribers:
                return
            self._prev_raw = None
            await asyncio.to_thread(self.worker.driver.close_capture)
            # 人工临时接管在断开连接满 5 秒且无未决 request_help 时自动交还控制权，恢复 Bot 运行
            lock = self.worker.lock
            if (
                lock.state is State.HUMAN_TAKEOVER
                and not lock.help_reason
                and (time.time() - lock.last_human_input) >= max(1.0, CAPTURE_IDLE_HIBERNATE - 0.5)
            ):
                await lock.release()
        except asyncio.CancelledError:
            return

    def _enqueue(self, sub: Subscriber, pkt: dict) -> None:
        if sub.queue.full():
            try:
                old = sub.queue.get_nowait()
                # 若丢掉了增量帧，下一帧必须发全量关键帧防止局部残影
                if isinstance(old, dict):
                    sub.needs_keyframe = True
            except asyncio.QueueEmpty:
                pass
        try:
            sub.queue.put_nowait(pkt)
        except asyncio.QueueFull:
            sub.needs_keyframe = True

    async def _pump_loop(self) -> None:
        try:
            while self._subscribers:
                # 每轮读取当前帧率档位，设置中修改后无需重启即可生效
                interval = max(0.02, get_stream_interval_ms() / 1000.0)
                t0 = time.perf_counter()
                self._nudge.clear()
                if not self.worker.healthy() or self.worker.lock.state is State.FROZEN:
                    await asyncio.sleep(interval)
                    continue

                try:
                    curr_raw = await asyncio.to_thread(self.worker.driver.grab_raw)
                except Exception:  # noqa: BLE001
                    await asyncio.sleep(interval)
                    continue

                subs = list(self._subscribers)
                if not subs:
                    break

                # 按格式分组编码（通常只有一种格式：jpeg 或 webp）
                by_fmt: Dict[str, List[Subscriber]] = {}
                for s in subs:
                    by_fmt.setdefault(s.fmt, []).append(s)

                self._seq += 1
                seq = self._seq

                for fmt, group in by_fmt.items():
                    kf_subs = [s for s in group if s.needs_keyframe or self._prev_raw is None]
                    dl_subs = [s for s in group if s not in kf_subs]
                    # 画面静止且无人等关键帧：0.2ms 短路，零编码零流量
                    if not kf_subs and self._prev_raw is not None and curr_raw.data == self._prev_raw.data:
                        continue
                    ts_ms = int(time.time() * 1000)
                    kf_pkt, dl_pkt, preview = await asyncio.to_thread(
                        _build_packets,
                        self._prev_raw,
                        curr_raw,
                        bool(kf_subs),
                        bool(dl_subs),
                        fmt,
                        seq,
                        ts_ms,
                    )
                    if preview:
                        self.worker.last_preview = preview
                        self.worker.last_preview_at = time.time()
                    if kf_pkt is not None:
                        for s in kf_subs:
                            s.needs_keyframe = False
                            self._enqueue(s, kf_pkt)
                    if dl_pkt is not None:
                        for s in dl_subs:
                            self._enqueue(s, dl_pkt)

                self._prev_raw = curr_raw

                elapsed = time.perf_counter() - t0
                wait_s = max(0.01, interval - elapsed)
                try:
                    await asyncio.wait_for(self._nudge.wait(), timeout=wait_s)
                    # 键鼠动作后给应用 ~35ms 重绘时间再采样，避免抓到点击前旧帧
                    await asyncio.sleep(0.035)
                except asyncio.TimeoutError:
                    pass
        except asyncio.CancelledError:
            return

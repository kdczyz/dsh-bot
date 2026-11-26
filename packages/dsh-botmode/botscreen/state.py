"""每张虚拟屏的状态机 + 人机互斥锁（方案三），带跨进程落盘租约。

状态迁移：
  STOPPED ──start──▶ AGENT_ACTIVE ──idle──▶ FROZEN ──agent/human──▶ AGENT_ACTIVE
                        │                      ▲
                        ├──human input──▶ HUMAN_TAKEOVER ──release──┘
                        └──request_help──▶ NEED_HUMAN ──takeover──▶ HUMAN_TAKEOVER

租约（lease）语义参照 Hermes `tools/bot_desktop/lease.py`：
  * 权威落盘在 `runtime/lease.json`，写时 `flock` + 原子 `os.replace`，读不存在的内存态不参与判定；
  * `epoch` 每次迁移 +1：一个在某次租约下被放行的动作，可以据此发现自己执行期间控制权已切换；
  * **fail-closed**：租约文件存在但读不出来/内容非法时，一律视为「人类持有」，绝不放行 Agent；
  * holder 只有 `agent` / `human` 两个值，键鼠与截图的判定都从这里派生。
"""
from __future__ import annotations

import errno
import fcntl
import json
import os
import tempfile
import time
from enum import Enum
from typing import Optional

AGENT = "agent"
HUMAN = "human"


class State(str, Enum):
    STOPPED = "STOPPED"
    STARTING = "STARTING"
    FROZEN = "FROZEN"
    AGENT_ACTIVE = "AGENT_ACTIVE"
    HUMAN_TAKEOVER = "HUMAN_TAKEOVER"
    NEED_HUMAN = "NEED_HUMAN"


#: Agent 允许操控的状态（FROZEN 会先自动唤醒）
AGENT_ALLOWED = {State.AGENT_ACTIVE, State.FROZEN}
#: 允许推流给人类的状态
STREAMABLE = {State.AGENT_ACTIVE, State.HUMAN_TAKEOVER, State.NEED_HUMAN}


class HumanInControl(Exception):
    """人类正在接管，Agent 请求被拒绝 → HTTP 423。"""

    def __init__(self, bot_id: str, state: str, what: str = "control") -> None:
        super().__init__(f"{bot_id} locked: {state}")
        self.bot_id = bot_id
        self.state = state
        self.what = what


class StaleLease(Exception):
    """调用方按旧 epoch 放行的动作已经过期 → HTTP 409。"""

    def __init__(self, bot_id: str, expected: int, actual: int) -> None:
        super().__init__(f"{bot_id} lease epoch changed: {expected} -> {actual}")
        self.bot_id = bot_id
        self.expected = expected
        self.actual = actual


class ScreenLock:
    """单屏状态机。所有迁移都走这里，保证互斥语义唯一。"""

    def __init__(self, bot_id: str, lease_path: Optional[str] = None) -> None:
        self.bot_id = bot_id
        self.state = State.STOPPED
        self.epoch = 0
        self.frozen_at: Optional[float] = None
        self.last_agent_call = 0.0
        self.last_human_input = 0.0
        self.viewers = 0
        self.human_held_since: Optional[float] = None
        self.help_reason: Optional[str] = None
        self.transitions: list[dict] = []
        self.lease_path = lease_path
        self.lease_corrupt: Optional[str] = None

        self._op_lock = None  # 懒加载 asyncio.Lock（构造可能发生在无事件循环的线程里）
        self._released = None

    # ---- 异步原语懒加载 ---------------------------------------------------
    def _lazy(self) -> None:
        import asyncio

        if self._op_lock is None:
            self._op_lock = asyncio.Lock()
        if self._released is None:
            self._released = asyncio.Event()
            self._released.set()

    @property
    def released_event(self):
        self._lazy()
        return self._released

    @property
    def op_lock(self):
        self._lazy()
        return self._op_lock

    # ---- holder / 租约 ----------------------------------------------------
    @property
    def holder(self) -> str:
        return HUMAN if self.state is State.HUMAN_TAKEOVER else AGENT

    def _persist(self) -> None:
        """把租约写到磁盘。失败不影响内存态（内存态仍是权威），但要可观测。"""
        if not self.lease_path:
            return
        payload = {
            "bot_id": self.bot_id,
            "holder": self.holder,
            "state": self.state.value,
            "epoch": self.epoch,
            "since": self.human_held_since or time.time(),
            "updated_at": time.time(),
            "reason": self.transitions[-1]["reason"] if self.transitions else "",
            "pid": os.getpid(),
        }
        directory = os.path.dirname(self.lease_path)
        try:
            os.makedirs(directory, exist_ok=True)
            lock_path = self.lease_path + ".lock"
            with open(lock_path, "a+") as lock_fh:
                try:
                    fcntl.flock(lock_fh.fileno(), fcntl.LOCK_EX)
                except OSError:
                    pass
                fd, tmp = tempfile.mkstemp(dir=directory, prefix=".lease-")
                try:
                    with os.fdopen(fd, "w", encoding="utf-8") as fh:
                        json.dump(payload, fh, ensure_ascii=False)
                        fh.flush()
                        os.fsync(fh.fileno())
                    os.replace(tmp, self.lease_path)
                except BaseException:
                    try:
                        os.unlink(tmp)
                    except OSError:
                        pass
                    raise
                try:
                    fcntl.flock(lock_fh.fileno(), fcntl.LOCK_UN)
                except OSError:
                    pass
        except OSError as exc:
            if exc.errno not in (errno.ENOSPC, errno.EACCES):
                raise

    def restore_from_disk(self) -> Optional[dict]:
        """启动/接管时读租约。**fail-closed**：读不出来就当人类持有。"""
        if not self.lease_path:
            return None
        try:
            with open(self.lease_path, encoding="utf-8") as fh:
                data = json.load(fh)
        except FileNotFoundError:
            return None
        except (OSError, json.JSONDecodeError) as exc:
            self.lease_corrupt = f"unreadable lease: {exc}"
            self.human_held_since = time.time()
            self._to(State.HUMAN_TAKEOVER, "lease unreadable (fail-closed)")
            return {"holder": HUMAN, "corrupt": str(exc)}

        if not isinstance(data, dict) or data.get("holder") not in (AGENT, HUMAN):
            self.lease_corrupt = "lease has invalid holder"
            self.human_held_since = time.time()
            self._to(State.HUMAN_TAKEOVER, "lease corrupt (fail-closed)")
            return {"holder": HUMAN, "corrupt": "invalid holder"}

        self.epoch = max(self.epoch, int(data.get("epoch") or 0))
        if data["holder"] == HUMAN:
            self.human_held_since = float(data.get("since") or time.time())
            self._to(State.HUMAN_TAKEOVER, str(data.get("reason") or "restored human lease"))
        return data

    # ---- 内部 -------------------------------------------------------------
    def _to(self, new: State, reason: str) -> None:
        if new is self.state:
            return
        self.transitions.append(
            {
                "ts": round(time.time(), 3),
                "from": self.state.value,
                "to": new.value,
                "reason": reason,
                "epoch": self.epoch + 1,
            }
        )
        del self.transitions[:-50]
        self.state = new
        self.epoch += 1
        if new is State.FROZEN:
            self.frozen_at = time.time()
        elif new is not State.FROZEN:
            self.frozen_at = None
        self._persist()

    # ---- 控制面 -----------------------------------------------------------
    async def begin_start(self) -> None:
        self._to(State.STARTING, "start")
        self.released_event.set()

    def mark_active(self, reason: str = "ready") -> None:
        # 启动即刷新活动计时基准，否则刚拉起的屏会被 idle_reaper 立刻判定为闲置
        self.last_agent_call = time.time()
        self._to(State.AGENT_ACTIVE, reason)

    def mark_stopped(self, reason: str = "stop") -> None:
        self._to(State.STOPPED, reason)
        self.human_held_since = None
        self.help_reason = None
        self.released_event.set()
        self._persist()

    def mark_frozen(self) -> None:
        self._to(State.FROZEN, "idle")

    def mark_thawed(self) -> None:
        if self.state is State.FROZEN:
            self.last_agent_call = time.time()
            self._to(State.AGENT_ACTIVE, "thaw")

    async def takeover(self, reason: str = "human") -> None:
        async with self.op_lock:
            self.human_held_since = time.time()
            self.released_event.clear()
            self._to(State.HUMAN_TAKEOVER, reason)

    async def request_help(self, reason: str) -> None:
        async with self.op_lock:
            self.help_reason = reason
            self.released_event.clear()
            self._to(State.NEED_HUMAN, "agent request_help")

    async def release(self) -> None:
        async with self.op_lock:
            self.human_held_since = None
            self.help_reason = None
            self.released_event.set()
            if self.state in (State.HUMAN_TAKEOVER, State.NEED_HUMAN):
                self._to(State.AGENT_ACTIVE, "human release")

    def touch_agent(self) -> None:
        self.last_agent_call = time.time()

    def touch_human(self) -> bool:
        """人类输入信号（VNC 键鼠帧）。返回是否真的触发了抢占。"""
        self.last_human_input = time.time()
        if self.state in (State.AGENT_ACTIVE, State.NEED_HUMAN):
            self.human_held_since = time.time()
            self.released_event.clear()
            self._to(State.HUMAN_TAKEOVER, "human input detected")
            return True
        return False

    # ---- Agent 侧守卫 -----------------------------------------------------
    def guard_agent(self, screenshot: bool = False) -> None:
        """Agent 调用前检查。

        * `HUMAN_TAKEOVER`：键鼠和截图**全部**拒绝（fail-closed：人可能正在输密码）。
        * `NEED_HUMAN`：键鼠拒绝，但允许截图（Agent 需要看人是否已处理完）。
        * `STOPPED`：拒绝。
        """
        if self.state is State.STOPPED or self.state is State.STARTING:
            raise HumanInControl(self.bot_id, self.state.value, "screen" if screenshot else "control")
        if self.state is State.HUMAN_TAKEOVER:
            raise HumanInControl(self.bot_id, self.state.value, "screenshot" if screenshot else "control")
        if self.state is State.NEED_HUMAN and not screenshot:
            raise HumanInControl(self.bot_id, self.state.value, "control")

    def check_epoch(self, expected: Optional[int]) -> None:
        """调用方带上 X-Expected-Epoch 时，控制权必须在它以为的这一次租约上。"""
        if expected is None:
            return
        if int(expected) != self.epoch:
            raise StaleLease(self.bot_id, int(expected), self.epoch)

    async def wait_for_release(self, timeout: float = 60.0) -> bool:
        import asyncio

        try:
            await asyncio.wait_for(self.released_event.wait(), timeout)
            return True
        except asyncio.TimeoutError:
            return False

    # ---- 闲置判定（双信号） ------------------------------------------------
    def idle_seconds(self) -> float:
        refs = [self.last_agent_call, self.last_human_input]
        return time.time() - max(refs) if any(refs) else float("inf")

    def should_freeze(self, idle_timeout: float) -> bool:
        return (
            self.state is State.AGENT_ACTIVE
            and self.viewers == 0
            and self.idle_seconds() >= idle_timeout
        )

    def long_freeze(self, threshold: float) -> bool:
        return self.frozen_at is not None and (time.time() - self.frozen_at) >= threshold

    # ---- 视图 -------------------------------------------------------------
    def snapshot(self) -> dict:
        return {
            "bot_id": self.bot_id,
            "state": self.state.value,
            "holder": self.holder,
            "epoch": self.epoch,
            "lease_corrupt": self.lease_corrupt,
            "frozen_at": self.frozen_at,
            "idle_seconds": None
            if self.idle_seconds() == float("inf")
            else round(self.idle_seconds(), 1),
            "viewers": self.viewers,
            "help_reason": self.help_reason,
            "human_held_since": self.human_held_since,
            "last_agent_call": self.last_agent_call or None,
            "transitions": self.transitions[-8:],
        }
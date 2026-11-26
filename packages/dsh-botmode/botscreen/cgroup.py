"""cgroup v2 管理：进程归组、freeze/unfreeze、内存读数。

所有写操作都通过 `sudo -n tee` 落盘，网关本身可以以普通用户运行；
freezer 是内核级暂停，进程树 CPU 归零但窗口/表单/标签页完整保留（方案四.2）。
"""
from __future__ import annotations

import os
import shutil
import subprocess
import time
from typing import Dict, Iterable, List

from .config import CGROUP_ROOT


class CgroupError(RuntimeError):
    pass


def _run(cmd: List[str], stdin_text: str | None = None) -> str:
    proc = subprocess.run(
        cmd,
        input=stdin_text,
        text=True,
        capture_output=True,
        check=False,
    )
    if proc.returncode != 0:
        raise CgroupError(
            f"{' '.join(cmd)} failed rc={proc.returncode}: "
            f"{(proc.stderr or proc.stdout).strip()[:300]}"
        )
    return proc.stdout


class CgroupManager:
    def __init__(self, root: str = CGROUP_ROOT) -> None:
        self.root = root
        self.available = True
        self._reclaim_procs: Dict[str, subprocess.Popen] = {}

    # ---- 基础写入 ---------------------------------------------------------
    def _write(self, path: str, value: str) -> None:
        try:
            with open(path, "w") as fh:
                fh.write(value)
            return
        except PermissionError:
            pass
        except FileNotFoundError:
            raise CgroupError(f"missing cgroup file: {path}")
        _run(["sudo", "-n", "tee", path], value)

    def _mkdir(self, path: str) -> None:
        try:
            os.makedirs(path, exist_ok=True)
            return
        except PermissionError:
            pass
        _run(["sudo", "-n", "mkdir", "-p", path])

    @staticmethod
    def _read(path: str, default: str = "") -> str:
        try:
            with open(path) as fh:
                return fh.read().strip()
        except OSError:
            return default

    # ---- 目录结构 ---------------------------------------------------------
    def ensure_root(self) -> None:
        """创建 /sys/fs/cgroup/botscreen 并放开所需控制器；无权限时尝试用户委托 slice 或降级关闭。"""
        try:
            self._mkdir(self.root)
            ctrls = self._read(os.path.join(self.root, "cgroup.controllers")).split()
            wanted = [c for c in ("memory", "pids", "cpu", "io") if c in ctrls]
            if wanted:
                self._write(
                    os.path.join(self.root, "cgroup.subtree_control"),
                    " ".join(f"+{c}" for c in wanted),
                )
            self.available = True
            return
        except (OSError, CgroupError):
            pass

        # 回退到当前用户 systemd 委托的 cgroup 子目录
        try:
            with open("/proc/self/cgroup", encoding="utf-8") as fh:
                for line in fh:
                    parts = line.strip().split(":", 2)
                    if len(parts) == 3 and parts[2].startswith("/"):
                        rel = parts[2].lstrip("/")
                        parent = os.path.join("/sys/fs/cgroup", os.path.dirname(rel), "botscreen")
                        os.makedirs(parent, exist_ok=True)
                        self.root = parent
                        self.available = True
                        return
        except OSError:
            pass
        self.available = False

    def bot_path(self, bot_id: str) -> str:
        return os.path.join(self.root, bot_id)

    def ensure_bot(self, bot_id: str) -> str:
        path = self.bot_path(bot_id)
        if not self.available:
            return path
        try:
            self._mkdir(path)
        except (OSError, CgroupError):
            self.available = False
        return path

    def destroy(self, bot_id: str) -> None:
        """解冻并尝试移除子组。

        注意：这里**不**杀 cgroup 内的进程。cgroup 成员是全局可读的，
        若旧网关实例在退出清理时盲杀成员，会误杀新实例刚拉起的同名屏。
        进程终止一律由 ScreenWorker 针对自己记录的 PID 完成。
        """
        path = self.bot_path(bot_id)
        if not os.path.isdir(path):
            return
        try:
            self.freeze(bot_id, False)
        except CgroupError:
            pass
        if self.pids(bot_id):
            # 仍有成员 → 保留子组，下次启动复用，避免误伤
            return
        try:
            os.rmdir(path)
        except OSError:
            try:
                _run(["sudo", "-n", "rmdir", path])
            except CgroupError:
                pass

    # ---- 进程归组 ---------------------------------------------------------
    def add_pid(self, bot_id: str, pid: int) -> None:
        path = self.ensure_bot(bot_id)
        self._write(os.path.join(path, "cgroup.procs"), str(pid))

    def add_pids(self, bot_id: str, pids: Iterable[int]) -> int:
        moved = 0
        for pid in pids:
            try:
                self.add_pid(bot_id, pid)
                moved += 1
            except (CgroupError, ProcessLookupError):
                continue
        return moved

    def pids(self, bot_id: str) -> List[int]:
        raw = self._read(os.path.join(self.bot_path(bot_id), "cgroup.procs"))
        return [int(x) for x in raw.split() if x.isdigit()]

    def descendants(self, root_pid: int) -> List[int]:
        """按 /proc 扫描某进程的全部后代（用于把 fork 出去的窗口管理器归组）。"""
        children: dict[int, List[int]] = {}
        for entry in os.listdir("/proc"):
            if not entry.isdigit():
                continue
            pid = int(entry)
            try:
                with open(f"/proc/{pid}/stat") as fh:
                    fields = fh.read().split()
                ppid = int(fields[3])
            except (OSError, ValueError, IndexError):
                continue
            children.setdefault(ppid, []).append(pid)
        out: List[int] = []
        stack = list(children.get(root_pid, []))
        while stack:
            pid = stack.pop()
            out.append(pid)
            stack.extend(children.get(pid, []))
        return out

    def reap(self, bot_id: str, root_pid: int) -> int:
        """把 root_pid 的整棵进程树塞进该 bot 的 cgroup。"""
        if not self.available:
            return 0
        pids = [root_pid] + self.descendants(root_pid)
        return self.add_pids(bot_id, pids)

    # ---- 冻结 / 唤醒 ------------------------------------------------------
    def _prune_reclaims(self) -> None:
        for bid, proc in list(self._reclaim_procs.items()):
            if proc.poll() is not None:
                self._reclaim_procs.pop(bid, None)

    def _cancel_reclaim(self, bot_id: str) -> None:
        proc = self._reclaim_procs.pop(bot_id, None)
        if proc is None or proc.poll() is not None:
            return
        try:
            proc.terminate()
        except OSError:
            pass

    def freeze(self, bot_id: str, frozen: bool = True) -> None:
        if not self.available:
            return
        if not frozen:
            self._cancel_reclaim(bot_id)
        path = os.path.join(self.ensure_bot(bot_id), "cgroup.freeze")
        self._write(path, "1" if frozen else "0")
        # 必须等 freeze 真正生效：内核写 cgroup.freeze=1 是异步的
        deadline = time.time() + 2.0
        while time.time() < deadline:
            if self.is_frozen(bot_id) == frozen:
                return
            time.sleep(0.01)
        raise CgroupError(f"freeze state did not settle for {bot_id}")

    def is_frozen(self, bot_id: str) -> bool:
        return self._read(os.path.join(self.bot_path(bot_id), "cgroup.freeze")) == "1"

    def frozen_events(self, bot_id: str) -> int:
        raw = self._read(os.path.join(self.bot_path(bot_id), "cgroup.events"))
        for line in raw.splitlines():
            if line.startswith("frozen"):
                return int(line.split()[1])
        return -1

    def reclaim(self, bot_id: str, amount: int) -> int:
        """同步回收（会阻塞到内核回收够为止），仅用于手动调用/测量。"""
        if amount <= 0:
            return 0
        path = os.path.join(self.bot_path(bot_id), "memory.reclaim")
        if not os.path.exists(path):
            return 0
        before = self.memory_current(bot_id)
        try:
            self._write(path, str(amount))
        except CgroupError:
            return 0
        return max(0, before - self.memory_current(bot_id))

    def reclaim_async(self, bot_id: str, amount: int) -> bool:
        """异步触发回收：内核在可回收页不足时会**同步阻塞**写入方，
        因此做最小驻留阈值过滤、去重防并发、限流与超时收割，避免永久卡在 D 状态吃满 CPU。"""
        self._prune_reclaims()
        if amount < 8 * 1024 * 1024:
            return False
        current = self.memory_current(bot_id)
        if current < 32 * 1024 * 1024:
            return False
        safe_amount = min(amount, current // 2)
        if safe_amount < 8 * 1024 * 1024:
            return False
        existing = self._reclaim_procs.get(bot_id)
        if existing is not None and existing.poll() is None:
            return False
        path = os.path.join(self.bot_path(bot_id), "memory.reclaim")
        if not os.path.exists(path):
            return False
        timeout_bin = shutil.which("timeout")
        cmd = ["sudo", "-n", "tee", path]
        if timeout_bin:
            cmd = [timeout_bin, "-k", "1", "8", *cmd]
        try:
            proc = subprocess.Popen(
                cmd,
                stdin=subprocess.PIPE,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                text=True,
                start_new_session=True,
            )
            if proc.stdin is not None:
                proc.stdin.write(str(safe_amount))
                proc.stdin.close()
            self._reclaim_procs[bot_id] = proc
            return True
        except (OSError, subprocess.SubprocessError):
            return False

    # ---- 观测 -------------------------------------------------------------
    def memory_current(self, bot_id: str) -> int:
        raw = self._read(os.path.join(self.bot_path(bot_id), "memory.current"), "0")
        return int(raw or 0)

    def cpu_usage_usec(self, bot_id: str) -> int:
        raw = self._read(os.path.join(self.bot_path(bot_id), "cpu.stat"))
        for line in raw.splitlines():
            if line.startswith("usage_usec"):
                return int(line.split()[1])
        return 0
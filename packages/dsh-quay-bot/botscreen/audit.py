"""操作审计：actions.jsonl + 每动作缩略图（方案四.3 Kill Switch 配套）。"""
from __future__ import annotations

import json
import os
import time
from typing import Optional

from .config import AUDIT_ENABLED, BotPaths

MAX_THUMBS = 400


class Auditor:
    def __init__(self, bot_id: str, paths: BotPaths) -> None:
        self.bot_id = bot_id
        self.paths = paths
        for d in (self.paths.audit, os.path.join(self.paths.audit, "thumbs")):
            try:
                os.makedirs(d, exist_ok=True)
            except OSError:
                # 目录由 Worker.prepare() 负责创建；构造期不因权限问题失败
                pass

    @property
    def thumb_dir(self) -> str:
        return os.path.join(self.paths.audit, "thumbs")

    def record(
        self,
        action: str,
        payload: dict,
        thumb: Optional[bytes] = None,
        state: Optional[str] = None,
    ) -> dict:
        ts = time.time()
        entry = {
            "ts": ts,
            "iso": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(ts)),
            "bot_id": self.bot_id,
            "action": action,
            "state": state,
            **payload,
        }
        if AUDIT_ENABLED and thumb:
            # 缩略图由 driver 以 JPEG 编码，扩展名跟随实际内容
            ext = "jpg" if thumb[:2] == b"\xff\xd8" else "webp"
            name = f"{int(ts * 1000)}_{action}.{ext}"
            path = os.path.join(self.thumb_dir, name)
            try:
                with open(path, "wb") as fh:
                    fh.write(thumb)
                entry["thumb"] = os.path.relpath(path, self.paths.audit)
            except OSError as exc:  # noqa: BLE001
                entry["thumb_error"] = str(exc)
        try:
            with open(self.paths.actions_log, "a", encoding="utf-8") as fh:
                fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
        except OSError as exc:  # noqa: BLE001
            entry["log_error"] = str(exc)
        self._prune()
        return entry

    def _prune(self) -> None:
        try:
            files = sorted(
                (os.path.join(self.thumb_dir, f) for f in os.listdir(self.thumb_dir)),
                key=os.path.getmtime,
            )
        except OSError:
            return
        for path in files[:-MAX_THUMBS] if len(files) > MAX_THUMBS else []:
            try:
                os.unlink(path)
            except OSError:
                pass

    def tail(self, limit: int = 50) -> list[dict]:
        """读最近 N 条审计记录（供前端审计页 / 回放）。"""
        try:
            with open(self.paths.actions_log, encoding="utf-8") as fh:
                lines = fh.readlines()[-limit:]
        except OSError:
            return []
        out = []
        for line in lines:
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue
        return out
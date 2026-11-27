"""Agent 回复产物（Artifact）网关存储、检索、下载与打包管理。"""
from __future__ import annotations

import base64
import contextlib
import hashlib
import io
import json
import mimetypes
import os
import re
import secrets
import tempfile
import time
import zipfile
from typing import Any, Dict, Iterable, List, Optional, Tuple
from urllib.parse import quote

from fastapi import HTTPException

from .config import ARTIFACT_BUNDLE_MAX_BYTES, ARTIFACT_MAX_BYTES

_SAFE_ID_RE = re.compile(r"^[A-Za-z0-9._-]{1,96}$")
_SAFE_KIND_SET = {"artifact", "deliverable", "file", "reply"}

_EXT_BY_TYPE = {
    "html": "html",
    "htm": "html",
    "markdown": "md",
    "md": "md",
    "json": "json",
    "yaml": "yaml",
    "yml": "yml",
    "xml": "xml",
    "svg": "svg",
    "csv": "csv",
    "tsv": "tsv",
    "python": "py",
    "py": "py",
    "javascript": "js",
    "js": "js",
    "typescript": "ts",
    "ts": "ts",
    "css": "css",
    "sql": "sql",
    "shell": "sh",
    "sh": "sh",
    "bash": "sh",
    "pdf": "pdf",
    "png": "png",
    "jpeg": "jpg",
    "jpg": "jpg",
    "webp": "webp",
    "gif": "gif",
    "zip": "zip",
    "text": "txt",
    "txt": "txt",
    "code": "txt",
}

_MIME_BY_TYPE = {
    "html": "text/html; charset=utf-8",
    "htm": "text/html; charset=utf-8",
    "markdown": "text/markdown; charset=utf-8",
    "md": "text/markdown; charset=utf-8",
    "json": "application/json; charset=utf-8",
    "yaml": "application/yaml; charset=utf-8",
    "yml": "application/yaml; charset=utf-8",
    "xml": "application/xml; charset=utf-8",
    "svg": "image/svg+xml",
    "csv": "text/csv; charset=utf-8",
    "tsv": "text/tab-separated-values; charset=utf-8",
    "css": "text/css; charset=utf-8",
    "javascript": "text/javascript; charset=utf-8",
    "js": "text/javascript; charset=utf-8",
    "typescript": "text/typescript; charset=utf-8",
    "ts": "text/typescript; charset=utf-8",
    "python": "text/x-python; charset=utf-8",
    "py": "text/x-python; charset=utf-8",
    "text": "text/plain; charset=utf-8",
    "txt": "text/plain; charset=utf-8",
    "code": "text/plain; charset=utf-8",
    "pdf": "application/pdf",
    "png": "image/png",
    "jpeg": "image/jpeg",
    "jpg": "image/jpeg",
    "webp": "image/webp",
    "gif": "image/gif",
    "zip": "application/zip",
}


def validate_artifact_id(raw: Optional[str]) -> str:
    if raw is None or str(raw).strip() == "":
        return f"art_{secrets.token_hex(6)}"
    aid = str(raw).strip()
    if not _SAFE_ID_RE.match(aid) or aid in (".", ".."):
        raise HTTPException(400, "invalid artifact_id: only [A-Za-z0-9._-] up to 96 chars allowed")
    return aid


def sanitize_filename(raw: Optional[str], title: str = "", artifact_type: str = "") -> str:
    candidate = str(raw or "").strip().replace("\\", "/")
    candidate = os.path.basename(candidate) if candidate else ""
    candidate = re.sub(r"[\x00-\x1f\x7f\"<>|*?:/\\]+", "_", candidate).strip(" .")
    if candidate:
        return candidate[:180]
    base = re.sub(r"[\x00-\x1f\x7f\"<>|*?:/\\]+", "_", str(title or "").strip()).strip(" .")
    base = re.sub(r"\s+", "_", base)[:120] or "artifact"
    ext = _EXT_BY_TYPE.get(str(artifact_type or "").strip().lower(), "")
    if ext and not base.lower().endswith(f".{ext}"):
        return f"{base}.{ext}"
    return base


def guess_mime_type(filename: str, artifact_type: str = "", explicit: Optional[str] = None) -> str:
    if explicit and str(explicit).strip():
        clean = re.sub(r"[\r\n]+", "", str(explicit).strip())
        if clean:
            return clean
    t_key = str(artifact_type or "").strip().lower()
    if t_key in _MIME_BY_TYPE:
        return _MIME_BY_TYPE[t_key]
    guessed, _ = mimetypes.guess_type(filename)
    if guessed:
        if guessed.startswith("text/") or guessed in ("application/json", "application/xml", "application/javascript"):
            return f"{guessed}; charset=utf-8"
        return guessed
    return "application/octet-stream"


def build_content_disposition(filename: str, inline: bool = False) -> str:
    safe = sanitize_filename(filename)
    ascii_fallback = re.sub(r"[^\x20-\x7e]+", "_", safe).replace('"', "'").strip(" .")
    if not ascii_fallback:
        _, ext = os.path.splitext(safe)
        ascii_fallback = f"artifact{ext if re.match(r'^\\.[A-Za-z0-9]{1,12}$', ext) else ''}"
    disp = "inline" if inline else "attachment"
    encoded = quote(safe, safe="")
    return f'{disp}; filename="{ascii_fallback}"; filename*=UTF-8\'\'{encoded}'


def decode_content_bytes(content: str, encoding: str = "utf-8") -> bytes:
    enc = str(encoding or "utf-8").strip().lower()
    if enc in ("base64", "b64"):
        try:
            raw = base64.b64decode(content.encode("ascii"), validate=True)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(400, f"invalid base64 content: {exc}") from exc
    elif enc in ("utf-8", "utf8", "text", "plain", ""):
        raw = content.encode("utf-8")
    else:
        raise HTTPException(400, f"unsupported encoding: {encoding}")
    if len(raw) > ARTIFACT_MAX_BYTES:
        raise HTTPException(413, f"artifact exceeds max size ({ARTIFACT_MAX_BYTES} bytes)")
    return raw


def _atomic_write_bytes(dest: str, data: bytes) -> None:
    directory = os.path.dirname(dest)
    os.makedirs(directory, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=directory, prefix=".art-")
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, dest)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise


def _atomic_write_json(dest: str, payload: dict) -> None:
    raw = (json.dumps(payload, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    _atomic_write_bytes(dest, raw)


def _preview_text(data: bytes, mime_type: str) -> str:
    base_mime = mime_type.split(";")[0].strip().lower()
    is_text = (
        base_mime.startswith("text/")
        or base_mime in (
            "application/json",
            "application/xml",
            "application/javascript",
            "application/yaml",
            "image/svg+xml",
        )
    )
    if not is_text:
        return ""
    try:
        return data[:2048].decode("utf-8", errors="replace").strip()[:400]
    except Exception:  # noqa: BLE001
        return ""


def enrich_artifact_record(meta: dict) -> dict:
    aid = meta["artifact_id"]
    bid = meta["bot_id"]
    out = dict(meta)
    out["download_url"] = f"/api/artifacts/{quote(aid, safe='')}/download"
    out["bot_download_url"] = f"/api/screens/{quote(bid, safe='')}/artifacts/{quote(aid, safe='')}/download"
    out["agent_download_url"] = f"/api/agent/{quote(bid, safe='')}/artifacts/{quote(aid, safe='')}/download"
    return out


class ArtifactStore:
    """管理所有已注册 Bot 目录下的 Agent 回复产物。"""

    def __init__(self, artifacts_dir: str, bot_id: str) -> None:
        self.dir = artifacts_dir
        self.bot_id = bot_id

    def _bin_path(self, artifact_id: str) -> str:
        return os.path.join(self.dir, f"{artifact_id}.bin")

    def _meta_path(self, artifact_id: str) -> str:
        return os.path.join(self.dir, f"{artifact_id}.meta.json")

    def save_bytes(
        self,
        data: bytes,
        *,
        artifact_id: Optional[str] = None,
        title: str = "",
        filename: Optional[str] = None,
        kind: str = "artifact",
        artifact_type: str = "",
        mime_type: Optional[str] = None,
        room_id: str = "",
        room_name: str = "",
        message_id: str = "",
        source_path: str = "",
        metadata: Optional[Dict[str, Any]] = None,
    ) -> dict:
        if len(data) > ARTIFACT_MAX_BYTES:
            raise HTTPException(413, f"artifact exceeds max size ({ARTIFACT_MAX_BYTES} bytes)")
        aid = validate_artifact_id(artifact_id)
        norm_kind = str(kind or "artifact").strip().lower()
        if norm_kind not in _SAFE_KIND_SET:
            norm_kind = "artifact"
        norm_type = str(artifact_type or "").strip().lower() or ("file" if norm_kind == "deliverable" else "text")
        resolved_name = sanitize_filename(filename, title=title, artifact_type=norm_type)
        resolved_title = str(title or "").strip() or resolved_name
        resolved_mime = guess_mime_type(resolved_name, artifact_type=norm_type, explicit=mime_type)
        sha256 = hashlib.sha256(data).hexdigest()
        now = time.time()

        existing = self.get_meta(aid)
        created_at = existing.get("created_at", now) if existing else now

        meta = {
            "artifact_id": aid,
            "bot_id": self.bot_id,
            "title": resolved_title[:240],
            "filename": resolved_name,
            "kind": norm_kind,
            "artifact_type": norm_type[:64],
            "mime_type": resolved_mime,
            "size": len(data),
            "sha256": sha256,
            "room_id": str(room_id or "").strip()[:128],
            "room_name": str(room_name or "").strip()[:160],
            "message_id": str(message_id or "").strip()[:128],
            "source_path": str(source_path or "").strip()[:512],
            "preview": _preview_text(data, resolved_mime),
            "metadata": metadata if isinstance(metadata, dict) else {},
            "created_at": created_at,
            "updated_at": now,
        }
        os.makedirs(self.dir, exist_ok=True)
        _atomic_write_bytes(self._bin_path(aid), data)
        _atomic_write_json(self._meta_path(aid), meta)
        return enrich_artifact_record(meta)

    def get_meta(self, artifact_id: str) -> Optional[dict]:
        aid = validate_artifact_id(artifact_id)
        mpath = self._meta_path(aid)
        bpath = self._bin_path(aid)
        if not (os.path.isfile(mpath) and os.path.isfile(bpath)):
            return None
        try:
            with open(mpath, encoding="utf-8") as fh:
                raw = json.load(fh)
            if not isinstance(raw, dict):
                return None
            raw.setdefault("artifact_id", aid)
            raw.setdefault("bot_id", self.bot_id)
            return enrich_artifact_record(raw)
        except (OSError, json.JSONDecodeError):
            return None

    def resolve_file(self, artifact_id: str) -> Optional[Tuple[str, dict]]:
        meta = self.get_meta(artifact_id)
        if meta is None:
            return None
        bpath = self._bin_path(meta["artifact_id"])
        if not os.path.isfile(bpath):
            return None
        return bpath, meta

    def list_items(
        self,
        *,
        room_id: Optional[str] = None,
        kind: Optional[str] = None,
        limit: int = 100,
    ) -> List[dict]:
        if not os.path.isdir(self.dir):
            return []
        out: List[dict] = []
        try:
            names = os.listdir(self.dir)
        except OSError:
            return []
        for name in names:
            if not name.endswith(".meta.json"):
                continue
            aid = name[: -len(".meta.json")]
            if not _SAFE_ID_RE.match(aid):
                continue
            meta = self.get_meta(aid)
            if meta is None:
                continue
            if room_id and meta.get("room_id") != room_id:
                continue
            if kind and meta.get("kind") != kind:
                continue
            out.append(meta)
        out.sort(key=lambda item: float(item.get("updated_at") or 0.0), reverse=True)
        return out[: max(1, min(500, int(limit or 100)))]

    def delete(self, artifact_id: str) -> bool:
        aid = validate_artifact_id(artifact_id)
        existed = False
        for path in (self._bin_path(aid), self._meta_path(aid)):
            if os.path.exists(path):
                with contextlib.suppress(OSError):
                    os.unlink(path)
                    existed = True
        return existed


def build_zip_bundle(entries: Iterable[Tuple[str, dict]]) -> Tuple[bytes, int, List[dict]]:
    """把多个产物打包成 ZIP 字节流（自动去重文件名，并校验打包上限）。"""
    buf = io.BytesIO()
    total_raw = 0
    seen_names: Dict[str, int] = {}
    manifest: List[dict] = []
    with zipfile.ZipFile(buf, mode="w", compression=zipfile.ZIP_DEFLATED) as zf:
        for bpath, meta in entries:
            if not os.path.isfile(bpath):
                continue
            size = os.path.getsize(bpath)
            total_raw += size
            if total_raw > ARTIFACT_BUNDLE_MAX_BYTES:
                raise HTTPException(
                    413,
                    f"bundle exceeds max uncompressed size ({ARTIFACT_BUNDLE_MAX_BYTES} bytes)",
                )
            base_name = sanitize_filename(meta.get("filename"), title=meta.get("title", ""), artifact_type=meta.get("artifact_type", ""))
            arcname = base_name
            count = seen_names.get(base_name.lower(), 0)
            if count > 0:
                stem, ext = os.path.splitext(base_name)
                arcname = f"{stem}_{count + 1}{ext}"
            seen_names[base_name.lower()] = count + 1
            zf.write(bpath, arcname=arcname)
            manifest.append({
                "artifact_id": meta.get("artifact_id"),
                "bot_id": meta.get("bot_id"),
                "filename": arcname,
                "title": meta.get("title"),
                "kind": meta.get("kind"),
                "artifact_type": meta.get("artifact_type"),
                "mime_type": meta.get("mime_type"),
                "size": size,
                "sha256": meta.get("sha256"),
            })
        if manifest:
            zf.writestr(
                "manifest.json",
                json.dumps({"count": len(manifest), "artifacts": manifest}, ensure_ascii=False, indent=2),
            )
    return buf.getvalue(), len(manifest), manifest

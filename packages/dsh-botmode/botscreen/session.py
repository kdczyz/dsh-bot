"""虚拟屏桌面会话快照与无缝恢复。

闲置自动关闭或手动停止前：
  1. 抓取最后一帧预览图落盘到 `runtime/last_preview.jpg`（停机零开销仍可展示）；
  2. 通过 EWMH (`_NET_CLIENT_LIST_STACKING` / `_NET_ACTIVE_WINDOW` / `_NET_WM_STATE`) 与 `/proc`
     采集当前所有打开的应用窗口（Chrome 标签页/窗口、终端工作目录、文件管理器路径、
     其他 GUI 应用命令行及精确坐标/尺寸/最大化/最小化/焦点状态），原子落盘到 `runtime/session_state.json`；
  3. 优雅发送 `WM_DELETE_WINDOW` 并确保 Chrome `Preferences` 标记为正常退出 + `restore_on_startup=1`，
     保证 Chrome 完整落盘所有标签页、Cookie 与会话，重启时不弹崩溃恢复条。

下次按需重启虚拟屏时：
  自动按原栈序拉起所有应用（Chrome 带 `--restore-last-session`），待窗口映射后还原
  精确位置、尺寸、最大化/最小化与焦点窗口。
"""
from __future__ import annotations

import json
import os
import shutil
import signal
import subprocess
import tempfile
import time
from typing import Any, Dict, List, Optional, Set, Tuple

from .config import SCREEN_HEIGHT, SCREEN_WIDTH, SHARED_XAUTHORITY, TOPBAR_HEIGHT

TERMINAL_NAMES = {"xterm", "xfce4-terminal", "lxterminal", "gnome-terminal", "konsole", "alacritty", "urxvt"}
FILEMGR_NAMES = {"pcmanfm", "thunar", "nautilus", "nemo", "dolphin"}
CHROME_NAMES = {"google-chrome", "chrome", "chromium", "chromium-browser"}
SKIP_CLASSES = {"botscreen-desktop", "botscreen-topbar", "xfdesktop", "tint2", "xfce4-panel", "plank", "picom"}
SKIP_WM_TYPES = {
    "_NET_WM_WINDOW_TYPE_DESKTOP",
    "_NET_WM_WINDOW_TYPE_DOCK",
    "_NET_WM_WINDOW_TYPE_SPLASH",
    "_NET_WM_WINDOW_TYPE_NOTIFICATION",
    "_NET_WM_WINDOW_TYPE_TOOLTIP",
    "_NET_WM_WINDOW_TYPE_POPUP_MENU",
    "_NET_WM_WINDOW_TYPE_DROPDOWN_MENU",
    "_NET_WM_WINDOW_TYPE_COMBO",
}


def _atomic_write_bytes(path: str, data: bytes) -> None:
    directory = os.path.dirname(path)
    os.makedirs(directory, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=directory, prefix=".tmp-")
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _atomic_write_json(path: str, payload: dict) -> None:
    raw = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
    _atomic_write_bytes(path, raw)


def save_preview_to_disk(preview_bytes: Optional[bytes], path: str) -> bool:
    if not preview_bytes:
        return False
    try:
        _atomic_write_bytes(path, preview_bytes)
        return True
    except OSError:
        return False


def load_preview_from_disk(path: str) -> Optional[bytes]:
    try:
        with open(path, "rb") as fh:
            data = fh.read()
        return data if data else None
    except OSError:
        return None


def _chrome_prefs_path(home: str) -> str:
    return os.path.join(home, ".config", "google-chrome", "Default", "Preferences")


def ensure_chrome_session_prefs(home: str, mark_clean_exit: bool = False) -> None:
    """确保 Chrome 开启“继续浏览上次打开的网页”(restore_on_startup=1)，避免崩溃恢复横幅。"""
    prefs_path = _chrome_prefs_path(home)
    if not os.path.isfile(prefs_path):
        return
    try:
        with open(prefs_path, encoding="utf-8") as fh:
            prefs = json.load(fh)
        if not isinstance(prefs, dict):
            return
        session_cfg = prefs.setdefault("session", {})
        if isinstance(session_cfg, dict):
            session_cfg["restore_on_startup"] = 1
        if mark_clean_exit:
            prof = prefs.setdefault("profile", {})
            if isinstance(prof, dict):
                prof["exit_type"] = "Normal"
                prof["exited_cleanly"] = True
        _atomic_write_json(prefs_path, prefs)
    except (OSError, json.JSONDecodeError, TypeError):
        pass


def _read_proc_cmdline(pid: int) -> List[str]:
    try:
        with open(f"/proc/{pid}/cmdline", "rb") as fh:
            return [a.decode("utf-8", errors="ignore") for a in fh.read().split(b"\x00") if a]
    except OSError:
        return []


def _read_proc_cwd(pid: int) -> str:
    try:
        return os.readlink(f"/proc/{pid}/cwd")
    except OSError:
        return ""


def _find_child_shell_cwd(parent_pid: int, fallback: str) -> str:
    """查找终端窗口内前台 shell 子进程的真实当前目录。"""
    children: Dict[int, List[int]] = {}
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        pid = int(entry)
        try:
            with open(f"/proc/{pid}/stat", "rb") as fh:
                stat_raw = fh.read()
            rparen = stat_raw.rfind(b")")
            if rparen < 0:
                continue
            rest = stat_raw[rparen + 2 :].split()
            if len(rest) >= 2:
                ppid = int(rest[1])
                children.setdefault(ppid, []).append(pid)
        except (OSError, ValueError):
            continue

    queue = list(children.get(parent_pid, []))
    best_cwd = ""
    visited: Set[int] = {parent_pid}
    depth = 0
    while queue and depth < 4:
        next_q: List[int] = []
        for cpid in queue:
            if cpid in visited:
                continue
            visited.add(cpid)
            cwd = _read_proc_cwd(cpid)
            if cwd and os.path.isdir(cwd):
                best_cwd = cwd
            next_q.extend(children.get(cpid, []))
        queue = next_q
        depth += 1
    return best_cwd or fallback


def _get_atom_names(dpy, atoms) -> Set[str]:
    names: Set[str] = set()
    if not atoms:
        return names
    for atom in atoms:
        try:
            name = dpy.get_atom_name(int(atom))
            if name:
                names.add(str(name))
        except Exception:  # noqa: BLE001
            continue
    return names


def _window_title(dpy, win) -> str:
    try:
        net_name = dpy.intern_atom("_NET_WM_NAME")
        prop = win.get_full_property(net_name, 0)
        if prop and prop.value:
            val = prop.value
            if isinstance(val, bytes):
                return val.decode("utf-8", errors="ignore").strip()
            return str(val).strip()
    except Exception:  # noqa: BLE001
        pass
    try:
        name = win.get_wm_name()
        if isinstance(name, bytes):
            return name.decode("utf-8", errors="ignore").strip()
        if name:
            return str(name).strip()
    except Exception:  # noqa: BLE001
        pass
    return ""


def _window_root_geometry(root, win) -> Tuple[int, int, int, int]:
    """获取窗口在根坐标系下的 (x, y, width, height)。"""
    geom = win.get_geometry()
    w = max(120, int(geom.width))
    h = max(80, int(geom.height))
    try:
        tr = root.translate_coords(win, 0, 0)
        x, y = int(tr.x), int(tr.y)
    except Exception:  # noqa: BLE001
        x, y = int(geom.x), int(geom.y)
    # 限制在有效工作区范围内，避免越界或压住顶部导航栏
    x = max(0, min(SCREEN_WIDTH - 120, x))
    y = max(TOPBAR_HEIGHT, min(SCREEN_HEIGHT - 80, y))
    w = min(w, SCREEN_WIDTH)
    h = min(h, SCREEN_HEIGHT - TOPBAR_HEIGHT)
    return x, y, w, h


def _classify_window(
    wm_class: List[str],
    argv: List[str],
    cwd: str,
    pid: int,
    home: str,
) -> Optional[Dict[str, Any]]:
    cls_lower = [c.lower() for c in wm_class if c]
    exe = os.path.basename(argv[0]).lower() if argv else ""

    if any(c in SKIP_CLASSES for c in cls_lower) or exe in SKIP_CLASSES:
        return None

    # 1. Chrome / Chromium
    if any(n in c for c in cls_lower for n in CHROME_NAMES) or any(n in exe for n in CHROME_NAMES):
        app_arg = next((a for a in argv if a.startswith("--app=")), "")
        if app_arg:
            return {"kind": "chrome_app", "app_url": app_arg[len("--app=") :]}
        return {"kind": "chrome"}

    # 2. Terminal
    if any(c in TERMINAL_NAMES for c in cls_lower) or exe in TERMINAL_NAMES:
        shell_cwd = _find_child_shell_cwd(pid, cwd or home) if pid else (cwd or home)
        return {"kind": "terminal", "cwd": shell_cwd if os.path.isdir(shell_cwd) else home}

    # 3. File manager
    if any(c in FILEMGR_NAMES for c in cls_lower) or exe in FILEMGR_NAMES:
        target = ""
        for arg in argv[1:]:
            if not arg.startswith("-") and (os.path.isdir(arg) or arg.startswith("trash://")):
                target = arg
                break
        if not target:
            target = cwd if (cwd and os.path.isdir(cwd)) else home
        return {"kind": "files", "path": target}

    # 4. Other normal GUI applications
    if argv and (shutil.which(argv[0]) or os.path.isfile(argv[0])):
        return {"kind": "app", "argv": argv[:32], "cwd": cwd if (cwd and os.path.isdir(cwd)) else home}

    return None


def capture_session(display: int, home: str, session_path: str, preview_path: str, driver=None) -> Dict[str, Any]:
    """在关闭虚拟屏前抓取预览图与全部窗口会话状态并原子落盘。"""
    os.environ.setdefault("XAUTHORITY", SHARED_XAUTHORITY)
    preview_bytes = None
    if driver is not None:
        try:
            shot = driver.screenshot("jpeg", 72, False)
            preview_bytes = shot.data
            save_preview_to_disk(preview_bytes, preview_path)
        except Exception:  # noqa: BLE001
            pass

    windows: List[Dict[str, Any]] = []
    try:
        from Xlib import X, display as xdisplay

        dpy = xdisplay.Display(f":{display}")
        try:
            root = dpy.screen().root
            a_stack = dpy.intern_atom("_NET_CLIENT_LIST_STACKING")
            a_list = dpy.intern_atom("_NET_CLIENT_LIST")
            a_active = dpy.intern_atom("_NET_ACTIVE_WINDOW")
            a_type = dpy.intern_atom("_NET_WM_WINDOW_TYPE")
            a_state = dpy.intern_atom("_NET_WM_STATE")
            a_pid = dpy.intern_atom("_NET_WM_PID")

            prop = root.get_full_property(a_stack, 0) or root.get_full_property(a_list, 0)
            wids = list(prop.value) if (prop and prop.value) else []
            act_prop = root.get_full_property(a_active, 0)
            active_wid = int(act_prop.value[0]) if (act_prop and act_prop.value) else 0

            for wid in wids:
                try:
                    win = dpy.create_resource_object("window", int(wid))
                    type_prop = win.get_full_property(a_type, 0)
                    type_names = _get_atom_names(dpy, type_prop.value if type_prop else [])
                    if type_names & SKIP_WM_TYPES:
                        continue

                    wm_class_raw = win.get_wm_class()
                    wm_class = [str(x) for x in wm_class_raw] if wm_class_raw else []
                    pid_prop = win.get_full_property(a_pid, 0)
                    pid = int(pid_prop.value[0]) if (pid_prop and pid_prop.value) else 0
                    argv = _read_proc_cmdline(pid) if pid else []
                    cwd = _read_proc_cwd(pid) if pid else ""

                    info = _classify_window(wm_class, argv, cwd, pid, home)
                    if info is None:
                        continue

                    state_prop = win.get_full_property(a_state, 0)
                    state_names = _get_atom_names(dpy, state_prop.value if state_prop else [])
                    x, y, w, h = _window_root_geometry(root, win)

                    entry = {
                        **info,
                        "wm_class": wm_class,
                        "title": _window_title(dpy, win)[:160],
                        "x": x,
                        "y": y,
                        "width": w,
                        "height": h,
                        "maximized": (
                            "_NET_WM_STATE_MAXIMIZED_HORZ" in state_names
                            and "_NET_WM_STATE_MAXIMIZED_VERT" in state_names
                        ),
                        "minimized": "_NET_WM_STATE_HIDDEN" in state_names,
                        "fullscreen": "_NET_WM_STATE_FULLSCREEN" in state_names,
                        "active": int(wid) == active_wid,
                        "pid": pid,
                    }
                    windows.append(entry)
                except Exception:  # noqa: BLE001
                    continue
        finally:
            try:
                dpy.close()
            except Exception:  # noqa: BLE001
                pass
    except Exception:  # noqa: BLE001
        pass

    ensure_chrome_session_prefs(home, mark_clean_exit=False)

    payload = {
        "version": 1,
        "saved_at": time.time(),
        "width": SCREEN_WIDTH,
        "height": SCREEN_HEIGHT,
        "windows": windows,
    }
    try:
        _atomic_write_json(session_path, payload)
    except OSError:
        pass
    return {"saved": True, "windows": len(windows), "preview_bytes": preview_bytes}


def graceful_close_apps(display: int, home: str, timeout: float = 3.0) -> None:
    """在停 X server 前优雅关闭应用窗口，让 Chrome 等完整落盘会话和标签页。"""
    os.environ.setdefault("XAUTHORITY", SHARED_XAUTHORITY)
    pids_to_wait: Set[int] = set()
    try:
        from Xlib import X, display as xdisplay, protocol

        dpy = xdisplay.Display(f":{display}")
        try:
            root = dpy.screen().root
            a_list = dpy.intern_atom("_NET_CLIENT_LIST")
            a_type = dpy.intern_atom("_NET_WM_WINDOW_TYPE")
            a_pid = dpy.intern_atom("_NET_WM_PID")
            a_protocols = dpy.intern_atom("WM_PROTOCOLS")
            a_delete = dpy.intern_atom("WM_DELETE_WINDOW")

            prop = root.get_full_property(a_list, 0)
            wids = list(prop.value) if (prop and prop.value) else []
            for wid in wids:
                try:
                    win = dpy.create_resource_object("window", int(wid))
                    type_prop = win.get_full_property(a_type, 0)
                    type_names = _get_atom_names(dpy, type_prop.value if type_prop else [])
                    if type_names & SKIP_WM_TYPES:
                        continue
                    wm_class = [str(x).lower() for x in (win.get_wm_class() or [])]
                    if any(c in SKIP_CLASSES for c in wm_class):
                        continue
                    pid_prop = win.get_full_property(a_pid, 0)
                    if pid_prop and pid_prop.value:
                        pids_to_wait.add(int(pid_prop.value[0]))
                    ev = protocol.event.ClientMessage(
                        window=win,
                        client_type=a_protocols,
                        data=(32, [a_delete, X.CurrentTime, 0, 0, 0]),
                    )
                    win.send_event(ev, event_mask=X.NoEventMask)
                except Exception:  # noqa: BLE001
                    continue
            dpy.flush()
            dpy.sync()
        finally:
            try:
                dpy.close()
            except Exception:  # noqa: BLE001
                pass
    except Exception:  # noqa: BLE001
        pass

    if pids_to_wait:
        deadline = time.time() + max(0.5, timeout)
        sent_term = False
        while time.time() < deadline:
            alive = []
            for pid in list(pids_to_wait):
                try:
                    os.kill(pid, 0)
                    alive.append(pid)
                except OSError:
                    pids_to_wait.discard(pid)
            if not alive:
                break
            if not sent_term and time.time() >= deadline - max(0.8, timeout * 0.4):
                sent_term = True
                for pid in alive:
                    try:
                        os.kill(pid, signal.SIGTERM)
                    except OSError:
                        pass
            time.sleep(0.1)

    ensure_chrome_session_prefs(home, mark_clean_exit=True)


def _list_managed_windows(display: int) -> List[Dict[str, Any]]:
    os.environ.setdefault("XAUTHORITY", SHARED_XAUTHORITY)
    out: List[Dict[str, Any]] = []
    try:
        from Xlib import display as xdisplay

        dpy = xdisplay.Display(f":{display}")
        try:
            root = dpy.screen().root
            a_list = dpy.intern_atom("_NET_CLIENT_LIST")
            a_type = dpy.intern_atom("_NET_WM_WINDOW_TYPE")
            prop = root.get_full_property(a_list, 0)
            wids = list(prop.value) if (prop and prop.value) else []
            for wid in wids:
                try:
                    win = dpy.create_resource_object("window", int(wid))
                    type_prop = win.get_full_property(a_type, 0)
                    type_names = _get_atom_names(dpy, type_prop.value if type_prop else [])
                    if type_names & SKIP_WM_TYPES:
                        continue
                    wm_class = [str(x).lower() for x in (win.get_wm_class() or [])]
                    if any(c in SKIP_CLASSES for c in wm_class):
                        continue
                    out.append({"wid": int(wid), "wm_class": wm_class})
                except Exception:  # noqa: BLE001
                    continue
        finally:
            try:
                dpy.close()
            except Exception:  # noqa: BLE001
                pass
    except Exception:  # noqa: BLE001
        pass
    return out


def _apply_window_geometry_and_state(
    display: int,
    wid: int,
    entry: Dict[str, Any],
) -> None:
    """用 EWMH 消息恢复窗口位置、尺寸、最大化、最小化状态。"""
    os.environ.setdefault("XAUTHORITY", SHARED_XAUTHORITY)
    try:
        from Xlib import X, display as xdisplay, protocol

        dpy = xdisplay.Display(f":{display}")
        try:
            root = dpy.screen().root
            win = dpy.create_resource_object("window", int(wid))
            a_wm_state = dpy.intern_atom("_NET_WM_STATE")
            a_max_h = dpy.intern_atom("_NET_WM_STATE_MAXIMIZED_HORZ")
            a_max_v = dpy.intern_atom("_NET_WM_STATE_MAXIMIZED_VERT")
            a_change = dpy.intern_atom("WM_CHANGE_STATE")

            def _send_root(client_type, data):
                ev = protocol.event.ClientMessage(
                    window=win,
                    client_type=client_type,
                    data=(32, data),
                )
                root.send_event(ev, event_mask=X.SubstructureRedirectMask | X.SubstructureNotifyMask)

            # 先取消最大化，再精确移动缩放，最后按原状态恢复最大化/最小化
            _send_root(a_wm_state, [0, a_max_h, a_max_v, 1, 0])
            x = max(0, min(SCREEN_WIDTH - 120, int(entry.get("x", 40))))
            y = max(TOPBAR_HEIGHT, min(SCREEN_HEIGHT - 80, int(entry.get("y", TOPBAR_HEIGHT + 16))))
            w = max(200, min(SCREEN_WIDTH, int(entry.get("width", 1040))))
            h = max(160, min(SCREEN_HEIGHT - TOPBAR_HEIGHT, int(entry.get("height", 620))))
            win.configure(x=x, y=y, width=w, height=h)

            if entry.get("maximized"):
                _send_root(a_wm_state, [1, a_max_h, a_max_v, 1, 0])
            if entry.get("minimized"):
                _send_root(a_change, [3, 0, 0, 0, 0])  # IconicState = 3
            dpy.flush()
            dpy.sync()
        finally:
            try:
                dpy.close()
            except Exception:  # noqa: BLE001
                pass
    except Exception:  # noqa: BLE001
        pass


def _activate_window(display: int, wid: int) -> None:
    os.environ.setdefault("XAUTHORITY", SHARED_XAUTHORITY)
    try:
        from Xlib import X, display as xdisplay, protocol

        dpy = xdisplay.Display(f":{display}")
        try:
            root = dpy.screen().root
            win = dpy.create_resource_object("window", int(wid))
            a_active = dpy.intern_atom("_NET_ACTIVE_WINDOW")
            ev = protocol.event.ClientMessage(
                window=win,
                client_type=a_active,
                data=(32, [1, X.CurrentTime, 0, 0, 0]),
            )
            root.send_event(ev, event_mask=X.SubstructureRedirectMask | X.SubstructureNotifyMask)
            dpy.flush()
            dpy.sync()
        finally:
            try:
                dpy.close()
            except Exception:  # noqa: BLE001
                pass
    except Exception:  # noqa: BLE001
        pass


def _matches_entry(win_classes: List[str], entry: Dict[str, Any]) -> bool:
    kind = entry.get("kind", "")
    if kind in ("chrome", "chrome_app"):
        return any(n in c for c in win_classes for n in CHROME_NAMES)
    if kind == "terminal":
        return any(c in TERMINAL_NAMES for c in win_classes)
    if kind == "files":
        return any(c in FILEMGR_NAMES for c in win_classes)
    saved_cls = [str(c).lower() for c in (entry.get("wm_class") or []) if c]
    if saved_cls and win_classes:
        return bool(set(saved_cls) & set(win_classes))
    return False


def has_saved_session(session_path: str) -> bool:
    try:
        with open(session_path, encoding="utf-8") as fh:
            data = json.load(fh)
        return isinstance(data, dict) and bool(data.get("windows"))
    except (OSError, json.JSONDecodeError):
        return False


def restore_session(worker, timeout: float = 3.5) -> Dict[str, Any]:
    """按上次关闭前保存的 `session_state.json` 还原打开的应用、标签页与窗口几何。"""
    session_path = worker.paths.session_file
    try:
        with open(session_path, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, json.JSONDecodeError):
        return {"restored": 0}

    saved_windows = data.get("windows") if isinstance(data, dict) else None
    if not isinstance(saved_windows, list) or not saved_windows:
        return {"restored": 0}

    chrome_entries = [w for w in saved_windows if w.get("kind") == "chrome"]
    other_entries = [w for w in saved_windows if w.get("kind") != "chrome"]
    expected_total = len(saved_windows)

    # 1. Chrome 统一一次拉起 `--restore-last-session`，完整还原全部标签页与窗口
    if chrome_entries:
        ensure_chrome_session_prefs(worker.paths.home, mark_clean_exit=True)
        first = chrome_entries[0]
        exe = next(
            (shutil.which(n) for n in ("google-chrome", "chromium", "chromium-browser") if shutil.which(n)),
            None,
        )
        if exe:
            x = max(0, int(first.get("x", 40)))
            y = max(TOPBAR_HEIGHT, int(first.get("y", TOPBAR_HEIGHT + 16)))
            w = max(400, int(first.get("width", SCREEN_WIDTH - 80)))
            h = max(300, int(first.get("height", SCREEN_HEIGHT - TOPBAR_HEIGHT - 40)))
            argv = [
                exe,
                "--no-sandbox",
                "--disable-gpu",
                "--no-first-run",
                "--disable-dev-shm-usage",
                "--restore-last-session",
                f"--user-data-dir={os.path.join(worker.paths.home, '.config', 'google-chrome')}",
                f"--window-position={x},{y}",
                f"--window-size={w},{h}",
            ]
            try:
                worker._spawn_app(argv)
            except Exception:  # noqa: BLE001
                pass

    # 2. 还原其他应用（chrome_app / 终端 / 文件管理器 / 其他 GUI 应用）
    for entry in other_entries:
        kind = entry.get("kind")
        try:
            if kind == "chrome_app" and entry.get("app_url"):
                exe = next(
                    (shutil.which(n) for n in ("google-chrome", "chromium", "chromium-browser") if shutil.which(n)),
                    None,
                )
                if exe:
                    x = max(0, int(entry.get("x", 80)))
                    y = max(TOPBAR_HEIGHT, int(entry.get("y", TOPBAR_HEIGHT + 24)))
                    w = max(320, int(entry.get("width", 900)))
                    h = max(240, int(entry.get("height", 600)))
                    worker._spawn_app([
                        exe,
                        "--no-sandbox",
                        "--disable-gpu",
                        "--no-first-run",
                        "--disable-dev-shm-usage",
                        f"--user-data-dir={os.path.join(worker.paths.home, '.config', 'google-chrome')}",
                        f"--window-position={x},{y}",
                        f"--window-size={w},{h}",
                        f"--app={entry['app_url']}",
                    ])
            elif kind == "terminal":
                cwd = entry.get("cwd") or worker.paths.home
                if not os.path.isdir(cwd):
                    cwd = worker.paths.home
                worker.open_app("terminal", cwd=cwd)
            elif kind == "files":
                path = entry.get("path") or worker.paths.home
                worker.open_app("files", path=path)
            elif kind == "app" and isinstance(entry.get("argv"), list) and entry["argv"]:
                cwd = entry.get("cwd") or worker.paths.home
                if not os.path.isdir(cwd):
                    cwd = worker.paths.home
                worker._spawn_app(entry["argv"], cwd=cwd)
        except Exception:  # noqa: BLE001
            continue

    # 3. 等待新拉起的窗口映射并精确还原位置、尺寸、最大化/最小化与焦点
    deadline = time.time() + max(0.8, timeout)
    mapped: List[Dict[str, Any]] = []
    while time.time() < deadline:
        mapped = _list_managed_windows(worker.display)
        if len(mapped) >= expected_total:
            time.sleep(0.25)
            mapped = _list_managed_windows(worker.display)
            break
        time.sleep(0.18)

    used_wids: Set[int] = set()
    active_target_wid: Optional[int] = None
    restored_count = 0

    for entry in saved_windows:
        match_wid = None
        for win_info in mapped:
            wid = win_info["wid"]
            if wid in used_wids:
                continue
            if _matches_entry(win_info["wm_class"], entry):
                match_wid = wid
                break
        if match_wid is None:
            continue
        used_wids.add(match_wid)
        _apply_window_geometry_and_state(worker.display, match_wid, entry)
        restored_count += 1
        if entry.get("active") and not entry.get("minimized"):
            active_target_wid = match_wid

    if active_target_wid is not None:
        _activate_window(worker.display, active_target_wid)

    return {"restored": restored_count, "expected": expected_total}

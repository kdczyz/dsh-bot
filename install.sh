#!/usr/bin/env bash
# BotScreen 一键安装：宿主底座 + Python 依赖 + 目录规范
# 支持 Ubuntu 22.04/24.04（x86_64 / arm64）
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_ROOT="${BOTSCREEN_DATA_ROOT:-/data/botscreen}"
BOTS="${BOTSCREEN_BOTS:-bot_01,bot_02,bot_03,bot_04}"
PY="${BOTSCREEN_VENV_DIR:-${ROOT}/.venv}/bin/python"

say() { printf '\033[1;36m[botscreen]\033[0m %s\n' "$*"; }

# ---- 1. 依赖 ---------------------------------------------------------------
say "安装系统依赖"
sudo apt-get update -qq
sudo apt-get install -y --no-install-recommends \
  openbox xfwm4 xfdesktop4 xfconf dbus-x11 tint2 picom pcmanfm xterm \
  gvfs gvfs-daemons feh xdotool xclip xauth curl ca-certificates glib-networking \
  x11vnc novnc websockify \
  adwaita-icon-theme fonts-noto-color-emoji fonts-noto-cjk \
  python3 python3-venv python3-pip

if ! command -v Xkasmvnc >/dev/null 2>&1 && ! dpkg -s kasmvncserver >/dev/null 2>&1; then
  say "安装 KasmVNC（提供 -websocketPort HTML5 推流）"
  DISTRO_ID="$(. /etc/os-release && echo "${ID:-ubuntu}")"
  CODENAME="$(. /etc/os-release && echo "${VERSION_CODENAME}")"
  ARCH="$(dpkg --print-architecture)"
  case "${ARCH}" in
    amd64|x86_64) DEB_ARCH=amd64 ;;
    arm64|aarch64) DEB_ARCH=arm64 ;;
    *) say "不支持的架构 ${ARCH}"; exit 1 ;;
  esac
  VER="1.5.2"
  if [ "${DISTRO_ID}" = "debian" ]; then
    case "${CODENAME}" in
      bookworm|trixie|bullseye) ;;
      *) say "未适配的 Debian 版本 ${CODENAME}，回退 trixie 包"; CODENAME=trixie ;;
    esac
    URL="https://github.com/kasmtech/KasmVNC/releases/download/v${VER}/kasmvncserver_debian_${CODENAME}_${VER}_${DEB_ARCH}.deb"
  else
    case "${CODENAME}" in
      noble|jammy|focal) ;;
      *) say "未适配的发行版 ${CODENAME}，将回退到 noble 包"; CODENAME=noble ;;
    esac
    URL="https://github.com/kasmtech/KasmVNC/releases/download/v${VER}/kasmvncserver_ubuntu_${CODENAME}_${VER}_${DEB_ARCH}.deb"
  fi
  say "下载 ${URL}"
  curl -fsSL -o /tmp/kasmvnc.deb "${URL}"
  sudo apt-get install -y /tmp/kasmvnc.deb
fi

# ---- 1b. X.Org Xvfb（可选源码构建）------------------------------------
if [ "${BOTSCREEN_BUILD_XVFB:-0}" = "1" ]; then
  say "从 X.Org xserver 源码构建 Xvfb"
  sudo apt-get install -y --no-install-recommends \
    meson ninja-build gcc pkg-config git \
    libpixman-1-dev libxfont2-dev libxcvt-dev libbsd-dev libxshmfence-dev \
    xtrans-dev x11proto-dev libxkbfile-dev libx11-dev libxau-dev libxdmcp-dev \
    x11-xkb-utils xkb-data
  SRC="${BOTSCREEN_XSERVER_SRC:-/data/home/xserver}"
  if [ ! -d "${SRC}/.git" ]; then
    git clone --depth 1 https://gitlab.freedesktop.org/xorg/xserver.git "${SRC}"
  fi
  # 新版 xserver 需要 xorgproto >= 7.0.34，发行版通常不够 → 先编一份
  PROTO="${BOTSCREEN_XORGPROTO_SRC:-/data/home/xorgproto}"
  if [ ! -d "${PROTO}" ]; then
    git clone --depth 1 https://gitlab.freedesktop.org/xorg/proto/xorgproto.git "${PROTO}"
  fi
  ( cd "${PROTO}" && meson setup build -Dprefix=/data/home/xorgproto-install >/dev/null \
      && ninja -C build >/dev/null && ninja -C build install >/dev/null )
  export PKG_CONFIG_PATH=/data/home/xorgproto-install/share/pkgconfig:${PKG_CONFIG_PATH:-}
  BUILD="${BOTSCREEN_XSERVER_BUILD:-/data/home/xserver-build}"
  ( cd "${SRC}" && meson setup "${BUILD}" . \
      -Dxvfb=true -Dxorg=false -Dxnest=false -Dxephyr=false -Dxwayland=false \
      -Dglamor=false -Ddri3=false -Dtests=false -Ddocs=false \
      -Dprefix=/data/home/xorg-install >/dev/null \
      && ninja -C "${BUILD}" >/dev/null )
  say "Xvfb 就绪：${BUILD}/hw/vfb/Xvfb"
fi

# ---- 2. Python 环境 --------------------------------------------------------
say "创建虚拟环境并安装依赖"
VENV_DIR="${BOTSCREEN_VENV_DIR:-${ROOT}/.venv}"
VENV_PY="${VENV_DIR}/bin/python"
if [ ! -x "${VENV_PY}" ]; then
  python3 -m venv --without-pip "${VENV_DIR}" 2>/dev/null || python3 -m venv "${VENV_DIR}"
fi
if ! "${VENV_PY}" -m pip --version >/dev/null 2>&1; then
  if "${VENV_PY}" -m ensurepip --upgrade >/dev/null 2>&1; then
    :
  elif [ -f "${ROOT}/vendor/pip/get-pip.py" ]; then
    "${VENV_PY}" "${ROOT}/vendor/pip/get-pip.py"
  elif [ -d "${ROOT}/vendor/pip" ]; then
    PYTHONPATH="$(echo "${ROOT}"/vendor/pip/pip-*.whl | head -1)" \
      "${VENV_PY}" -m pip install --no-index --find-links "${ROOT}/vendor/pip" \
      --ignore-installed --upgrade pip setuptools
  else
    say "当前 Python 缺少 ensurepip/pip；请安装 python3-venv 和 python3-pip 后重试"
    exit 1
  fi
fi
"${VENV_PY}" -m pip install -q --upgrade pip
"${VENV_PY}" -m pip install -q -r "${ROOT}/requirements.txt"

# ---- 3. cgroup v2 ----------------------------------------------------------
say "检查 cgroup v2"
if [ "$(stat -fc %T /sys/fs/cgroup/)" != "cgroup2fs" ]; then
  say "当前系统未启用 cgroup v2 unified 模式，freeze 不可用。"
  say "请在启动参数中加入 systemd.unified_cgroup_hierarchy=1 后重启。"
  exit 1
fi
sudo mkdir -p /sys/fs/cgroup/botscreen
CTRL="$(cat /sys/fs/cgroup/cgroup.controllers)"
ENABLE=""
for c in memory pids cpu io; do
  [[ " ${CTRL} " == *" ${c} "* ]] && ENABLE+="+${c} "
done
[ -n "${ENABLE}" ] && echo "${ENABLE}" | sudo tee /sys/fs/cgroup/botscreen/cgroup.subtree_control >/dev/null

# ---- 4. zram ---------------------------------------------------------------
MEM_KB=$(awk '/MemTotal/{print $2}' /proc/meminfo)
ZRAM_MB=$(( MEM_KB / 2 / 1024 ))
if ! swapon --show=NAME --noheadings | grep -q zram; then
  say "启用 zram（${ZRAM_MB} MB，压缩闲置虚拟屏内存）"
  sudo modprobe zram num_devices=1 >/dev/null 2>&1 || true
  ZDEV="$(sudo zramctl --find --size "${ZRAM_MB}M" --algorithm zstd 2>/dev/null || true)"
  if [ -n "${ZDEV}" ]; then
    sudo mkswap "${ZDEV}" >/dev/null 2>&1 && sudo swapon -p 100 "${ZDEV}" \
      && say "zram 就绪：${ZDEV} ${ZRAM_MB}MB zstd" \
      || say "zram swap 启用失败，跳过（不影响正确性，只影响闲置内存压缩率）"
  else
    say "zram 设备创建失败，跳过"
  fi
else
  say "zram 已启用，跳过"
fi

# ---- 5. 目录规范 -----------------------------------------------------------
say "创建数据目录 ${DATA_ROOT}"
sudo mkdir -p "${DATA_ROOT}"
sudo chown -R "$(id -u):$(id -g)" "${DATA_ROOT}"
IFS=',' read -ra BOT_LIST <<< "${BOTS}"
for bot in "${BOT_LIST[@]}"; do
  mkdir -p "${DATA_ROOT}/${bot}"/{home,downloads,audit,runtime}
done
chmod 700 "${DATA_ROOT}"

# ---- 6. 自检 ---------------------------------------------------------------
say "自检"
"${PY}" - <<'EOF'
import importlib, shutil, subprocess, sys
ok = True
for mod in ("fastapi", "uvicorn", "PIL", "Xlib", "websockets", "httpx"):
    try:
        importlib.import_module(mod)
        print(f"  ✓ python:{mod}")
    except Exception as exc:
        print(f"  ✗ python:{mod} {exc}"); ok = False
for bin in ("Xvnc", "xfwm4", "tint2", "picom", "pcmanfm", "xterm", "xdotool", "xclip", "xauth"):
    path = shutil.which(bin)
    print(f"  {'✓' if path else '✗'} bin:{bin} {path or ''}")
    ok = ok and bool(path)
version = subprocess.run(["sh", "-c", "Xvnc -version 2>&1 | sed -n 2p"], capture_output=True, text=True).stdout.strip()
print("  ✓ Xvnc:", version or "(version banner unavailable)")
sys.exit(0 if ok else 1)
EOF

say "安装完成。启动：${PY} -m botscreen"
say "控制台：http://127.0.0.1:${BOTSCREEN_PORT:-6200}/"
say "MCP：${PY} -m botscreen.mcp_server"
#!/usr/bin/env bash
# 单机 / 少量 Bot SSH 按需接管脚本：
# 平时远端仅运行 Xvfb + Bot（零抓屏/零常驻编码进程）；
# 执行本脚本时通过单条 SSH 隧道按需拉起 `x11vnc -once -localhost`，
# 本地 VNC 客户端断开后远端抓屏进程立即自动退出，不留任何后台常驻服务。
#
# 用法:
#   ./tools/ssh_takeover.sh <user@host> [display_num=101] [local_port=5901] [xauth=/data/botscreen/Xauthority.shared]
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "用法: $0 <user@host> [display_num=101] [local_port=5901] [xauth=/data/botscreen/Xauthority.shared]" >&2
  exit 1
fi

TARGET="$1"
DISPLAY_NUM="${2:-101}"
LOCAL_PORT="${3:-5901}"
XAUTH_PATH="${4:-/data/botscreen/Xauthority.shared}"
REMOTE_PORT=$((5950 + DISPLAY_NUM - 100))

echo "[botscreen-ssh] 正在连接 ${TARGET} (DISPLAY=:${DISPLAY_NUM}) -> localhost:${LOCAL_PORT} ..."
echo "[botscreen-ssh] 请使用本地 VNC 客户端连接 127.0.0.1:${LOCAL_PORT}；断开后远端抓屏进程将自动销毁。"

exec ssh -N -T \
  -L "${LOCAL_PORT}:127.0.0.1:${REMOTE_PORT}" \
  "${TARGET}" \
  "XAUTHORITY='${XAUTH_PATH}' exec x11vnc -display ':${DISPLAY_NUM}' -rfbport '${REMOTE_PORT}' -localhost -once -nopw -noxdamage -ncache 0 -quiet"

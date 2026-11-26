#!/usr/bin/env bash
# 把 BotScreen 装成系统服务：复制到 /opt/botscreen 并启用 systemd 单元
set -euo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
sudo mkdir -p /opt/botscreen
sudo rsync -a --delete \
  --exclude '.venv' --exclude '__pycache__' --exclude '.git' \
  "${SRC}/botscreen" "${SRC}/web" "${SRC}/requirements.txt" /opt/botscreen/
if [ ! -d /opt/botscreen/.venv ]; then
  sudo python3 -m venv /opt/botscreen/.venv
  sudo /opt/botscreen/.venv/bin/pip install -q -r /opt/botscreen/requirements.txt
fi
sudo install -m 644 "${SRC}/deploy/cgroup-setup.service" /etc/systemd/system/
sudo install -m 644 "${SRC}/deploy/botscreen.service"   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now cgroup-setup.service
sudo systemctl enable --now botscreen.service
sleep 2
curl -s http://127.0.0.1:6200/healthz && echo && echo "BotScreen 服务已启动"

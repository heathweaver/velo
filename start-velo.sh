#!/usr/bin/env bash
# Idempotently (re)start velo-server on the box. Data lives in /workspace/velo-data
# (survives box resets). Usage: ./start-velo.sh [--rebuild]
set -euo pipefail
export PATH="$PATH:/usr/sbin:/sbin"
cd "$(dirname "$0")"
command -v dockerd >/dev/null || { sudo apt-get update -qq && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker.io; }
if ! sudo docker info >/dev/null 2>&1; then
  sudo sh -c 'nohup /usr/sbin/dockerd --storage-driver=vfs >/tmp/dockerd.log 2>&1 &'
  for i in $(seq 1 30); do sudo docker info >/dev/null 2>&1 && break; sleep 1; done
fi
mkdir -p /workspace/velo-data
if [[ "${1:-}" == "--rebuild" ]] || ! sudo docker image inspect velo-server:local >/dev/null 2>&1; then
  sudo docker build -t velo-server:local .
  sudo docker rm -f velo-server >/dev/null 2>&1 || true
fi
if [[ -z "${DREAMHOST_ME_PASSWORD:-}" ]]; then echo "warning: DREAMHOST_ME_PASSWORD unset; seed keeps stored password" >&2; fi
if sudo docker ps --format '{{.Names}}' | grep -qx velo-server; then echo "velo-server already running"; exit 0; fi
sudo docker rm -f velo-server >/dev/null 2>&1 || true
sudo --preserve-env=DREAMHOST_ME_PASSWORD docker run -d --name velo-server --restart unless-stopped -p 8080:8080 \
  -v /workspace/velo-data:/data --env-file .local-admin.env \
  -e VELO_PUBLIC_URL=http://localhost:8080 -e VELO_FILER=1 -e VELO_FILER_INTERVAL=120 -e VELO_NOTIFY=0 \
  -e DREAMHOST_ME_PASSWORD \
  velo-server:local
echo "velo-server started on http://localhost:8080"

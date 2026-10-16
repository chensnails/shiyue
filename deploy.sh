#!/usr/bin/env bash
# 拾阅（shiyue）—— 从 GitHub 拉取最新代码并重建容器
# 用法：在项目目录执行  ./deploy.sh
set -euo pipefail
cd "$(dirname "$0")"

echo "[deploy] 拉取最新代码…"
git pull --ff-only

echo "[deploy] 重建并启动容器…"
docker compose up -d --build

echo "[deploy] 容器状态："
docker compose ps

# 读 HOST_PORT（默认 3210），轮询等容器健康（最多约 60 秒）
port="$(grep -E '^HOST_PORT=' .env 2>/dev/null | cut -d= -f2 | tr -d '[:space:]')"
port="${port:-3210}"
echo "[deploy] 等待健康检查 http://127.0.0.1:${port}/api/health …"
for _ in $(seq 1 30); do
  if body="$(curl -fsS "http://127.0.0.1:${port}/api/health" 2>/dev/null)"; then
    echo "[deploy] 健康检查通过 ✓ ${body}"
    exit 0
  fi
  sleep 2
done
echo "[deploy] 健康检查超时（60s），请查看：docker compose logs -f app" >&2
exit 1

#!/usr/bin/env bash
set -e

# ---- 基础变量 ----
USERNAME=$(whoami)
DOMAIN="${USERNAME}.serv00.net"
WORKDIR="${HOME}/domains/${DOMAIN}/uptime-kuma"
REPO="https://github.com/oyz8/Uptime_Kuma/releases/download/v2.3.2-2/uptime-kuma.zip"
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

# ---- 检查 Serv00 环境 ----
command -v devil &>/dev/null || error "请在 Serv00/CT8 面板中执行。"
command -v npm &>/dev/null || error "未加载 Node.js，请先运行: devil binexec on"

# ---- 自动分配端口 ----
auto_port() {
    local existing=$(devil port list | awk '/tcp/{print $1; exit}')
    if [[ -n "$existing" ]]; then
        echo "$existing"
        return
    fi
    for ((i=0; i<50; i++)); do
        local port=$((RANDOM % 55535 + 10000))
        devil port add tcp "$port" &>/dev/null && { echo "$port"; return; }
    done
    error "无法自动分配端口，请手动预留。"
}

# ---- 设置反向代理 ----
setup_proxy() {
    if devil www list "$DOMAIN" | grep -q "proxy.*:${PORT}"; then
        warn "反代已存在，跳过。"
        return
    fi
    devil www del "$DOMAIN" &>/dev/null || true
    devil www add "$DOMAIN" proxy "$PORT" &>/dev/null || error "反代设置失败，请手动在面板 WWW 站点中添加 Proxy 端口 ${PORT}。"
    info "反向代理已设置：${DOMAIN} -> localhost:${PORT}"
}

# ---- 主流程 ----
clear
info "===== Uptime Kuma 自动部署 (Serv00/CT8) ====="

PORT=$(auto_port)
info "分配端口：${PORT}"

mkdir -p "$(dirname "$WORKDIR")"
cd "$(dirname "$WORKDIR")"
[[ -d uptime-kuma ]] && rm -rf uptime-kuma

info "下载 Uptime Kuma ..."
wget -q --show-progress "$REPO" -O uptime-kuma.zip
unzip -q uptime-kuma.zip -d uptime-kuma && rm -f uptime-kuma.zip
cd uptime-kuma

info "写入环境变量..."
echo "UPTIME_KUMA_PORT=${PORT}" > .env
echo "DATA_DIR=./data" >> .env

info "重建原生模块 (npm rebuild) ..."
npm rebuild || error "npm rebuild 失败，请确认 Node.js 版本为 18+。"

setup_proxy

echo ""
info "===== 部署完成 ====="
echo "启动命令 (后台运行):"
echo "  screen -dmS kuma node ${WORKDIR}/server/server.js"
echo "  或"
echo "  nohup node ${WORKDIR}/server/server.js > kuma.log 2>&1 &"
echo ""
echo "访问地址: https://${DOMAIN}"

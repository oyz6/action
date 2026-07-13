#!/usr/bin/env bash
set -e

USERNAME=$(whoami)
DOMAIN="${USERNAME}.serv00.net"
WORKDIR="${HOME}/domains/${DOMAIN}/uptime-kuma"
REPO="https://github.com/oyz8/Uptime_Kuma/releases/download/v2.3.2-2/uptime-kuma.zip"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

# 环境检测
command -v devil >/dev/null || error "请在 Serv00/CT8 环境中运行。"
command -v npm   >/dev/null || error "请先启用 Node.js（devil binexec on node22）"

# 自动端口
auto_port() {
    local existing=$(devil port list | awk '/tcp/{print $1; exit}')
    if [[ -n "$existing" ]]; then
        echo "$existing"
        return
    fi
    for ((i=0; i<50; i++)); do
        local port=$((RANDOM % 55535 + 10000))
        devil port add tcp "$port" >/dev/null 2>&1 && { echo "$port"; return; }
    done
    error "无法分配端口"
}

# 反代
setup_proxy() {
    local port=$1
    if devil www list "$DOMAIN" | grep -q "proxy.*:${port}"; then
        warn "反代已存在，跳过。"
        return
    fi
    devil www del "$DOMAIN" >/dev/null 2>&1 || true
    devil www add "$DOMAIN" proxy "$port" >/dev/null 2>&1 || error "反代添加失败，请手动设置。"
    info "反向代理: ${DOMAIN} -> localhost:${port}"
}

main() {
    clear
    info "===== Uptime Kuma 部署（保留预编译模块） ====="

    PORT=$(auto_port)
    info "端口: ${PORT}"

    mkdir -p "$(dirname "$WORKDIR")"
    cd "$(dirname "$WORKDIR")"
    [[ -d uptime-kuma ]] && rm -rf uptime-kuma

    info "下载预编译包 ..."
    wget -q --show-progress "$REPO" -O uptime-kuma.zip
    unzip -q uptime-kuma.zip -d uptime-kuma && rm -f uptime-kuma.zip
    cd uptime-kuma

    info "修复 node_modules 执行权限 ..."
    chmod -R +x node_modules           # 关键！赋予所有文件执行权限

    echo "UPTIME_KUMA_PORT=${PORT}" > .env
    echo "DATA_DIR=./data" >> .env

    setup_proxy "$PORT"

    echo ""
    info "部署完成！请启动服务："
    echo "  screen -dmS kuma node ${WORKDIR}/server/server.js"
    echo "  或"
    echo "  nohup node ${WORKDIR}/server/server.js > kuma.log 2>&1 &"
    echo ""
    echo "访问: https://${DOMAIN}"
}

main

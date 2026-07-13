#!/usr/bin/env bash

set -e

# ========== 基本变量 ==========
USERNAME=$(whoami)
USERNAME_DOMAIN=$(whoami | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9-]//g')
DOMAIN="${USERNAME_DOMAIN}.serv00.net"
WORKDIR="/home/${USERNAME}/domains/${DOMAIN}/uptime-kuma"
DOWNLOAD_URL="https://github.com/oyz8/Uptime_Kuma/releases/download/v2.3.2-2/uptime-kuma.zip"

# 颜色
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

# ========== 预检环境 ==========
check_env() {
    command -v devil >/dev/null 2>&1 || error "未检测到 devil 命令，请在 Serv00/CT8 环境中运行本脚本。"
    command -v npm >/dev/null 2>&1 || error "未检测到 npm，请确保已正确加载 Node.js 环境。"
}

# ========== 自动分配端口 ==========
auto_reserve_port() {
    local port_list=$(devil port list)
    local current_port
    local attempts=0
    local max_attempts=100

    # 如果已经有预留端口，直接返回第一个可用的 tcp 端口
    local existing_port=$(echo "$port_list" | grep 'tcp' | awk 'NR==1{print $1}')
    if [ -n "$existing_port" ]; then
        echo "$existing_port"
        return 0
    fi

    # 随机起始端口 (1024-64000)
    local start_port=$(( RANDOM % 63077 + 1024 ))
    local increment=1
    current_port=$start_port

    while [ $attempts -lt $max_attempts ]; do
        # 检查端口是否已被占用
        if echo "$port_list" | grep -q "tcp.*${current_port}"; then
            current_port=$((current_port + increment))
            attempts=$((attempts + 1))
            continue
        fi

        info "尝试预留端口 ${current_port} ..."
        if devil port add tcp "$current_port" >/dev/null 2>&1; then
            info "端口 ${current_port} 预留成功。"
            echo "$current_port"
            return 0
        fi

        current_port=$((current_port + increment))
        attempts=$((attempts + 1))
    done

    error "无法自动分配端口，请手动预留后重试。"
}

# ========== 设置反向代理 ==========
setup_proxy() {
    local domain="$1"
    local port="$2"

    if devil www list "$domain" | grep -q "proxy.*:${port}"; then
        warn "域名 ${domain} 的反代记录已存在，跳过。"
        return 0
    fi

    devil www del "$domain" >/dev/null 2>&1 || true
    info "正在为 ${domain} 添加反向代理到端口 ${port} ..."
    devil www add "$domain" proxy "$port" >/dev/null 2>&1
    if [ $? -ne 0 ]; then
        error "添加反向代理失败，请手动前往面板 WWW 站点设置 Proxy 端口 ${port}。"
    fi
    info "反向代理设置完成。"
}

# ========== 主流程 ==========
main() {
    clear
    info "===== Uptime Kuma 自动安装脚本 for Serv00/CT8 ====="
    check_env

    # 自动分配端口
    PORT=$(auto_reserve_port)
    info "已自动分配端口：${PORT}"

    # 创建目录并下载
    info "创建工作目录并下载 Uptime Kuma ..."
    mkdir -p "$(dirname "$WORKDIR")"
    cd "$(dirname "$WORKDIR")"

    if [ -d "uptime-kuma" ]; then
        warn "目录 uptime-kuma 已存在，将删除后重新下载。"
        rm -rf uptime-kuma
    fi

    wget -q --show-progress "$DOWNLOAD_URL" -O uptime-kuma.zip || error "下载失败，请检查网络或 URL。"
    unzip -q uptime-kuma.zip -d uptime-kuma || error "解压失败。"
    rm -f uptime-kuma.zip
    cd uptime-kuma

    # 写入 .env
    info "写入环境变量..."
    echo "UPTIME_KUMA_PORT=${PORT}" > .env
    echo "DATA_DIR=./data" >> .env

    # 重建原生模块
    info "重建原生模块 (npm rebuild) ..."
    npm rebuild || error "npm rebuild 失败，请检查 Node.js 版本（推荐 v18+）。"

    # 设置反向代理
    setup_proxy "$DOMAIN" "$PORT"

    # 启动提示
    echo ""
    info "===== 安装完成！请按以下步骤启动 Uptime Kuma ====="
    echo "1. 进入工作目录："
    echo "   cd ${WORKDIR}"
    echo ""
    echo "2. 启动服务（后台运行示例）："
    echo "   screen -S uptime-kuma -dm node server/server.js"
    echo "   或"
    echo "   nohup node server/server.js > kuma.log 2>&1 &"
    echo ""
    echo "3. 访问你的网站："
    echo "   https://${DOMAIN}"
    echo ""
    info "如果反向代理未生效，请手动在面板 WWW 站点中为 ${DOMAIN} 添加 Proxy 端口 ${PORT}。"
}

main

#!/usr/bin/env bash
set -e

# ================== 基础配置 ==================
USERNAME=$(whoami)
USERNAME_LOWER=$(echo "$USERNAME" | tr '[:upper:]' '[:lower:]')

# 判断域名后缀
if hostname | grep -q "ct8.pl"; then
    DOMAIN_SUFFIX="ct8.pl"
else
    DOMAIN_SUFFIX="serv00.net"
fi
DOMAIN="${USERNAME_LOWER}.${DOMAIN_SUFFIX}"
WORKDIR="${HOME}/domains/${DOMAIN}/uptime-kuma"
REPO_URL="https://github.com/oyz8/Uptime_Kuma/releases/download/v2.3.2-2/uptime-kuma.zip"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

# ================== 环境检测 ==================
command -v devil >/dev/null 2>&1 || error "请在 Serv00/CT8 环境中运行。"
command -v npm   >/dev/null 2>&1 || error "请先启用 Node.js（如：devil binexec on node22）。"

# ================== 自动分配端口 ==================
auto_port() {
    local existing=$(devil port list | awk '/tcp/{print $1; exit}')
    if [[ -n "$existing" ]]; then
        echo "$existing"
        return
    fi
    for ((i=0; i<100; i++)); do
        local port=$((RANDOM % 55535 + 10000))
        if devil port add tcp "$port" >/dev/null 2>&1; then
            echo "$port"
            return
        fi
    done
    error "无法自动分配端口，请手动预留。"
}

# ================== 反向代理（修正参数） ==================
setup_proxy() {
    local port=$1
    local max_retries=3
    local retry=0

    # 检查现有配置
    if devil www list "$DOMAIN" 2>/dev/null | grep -q "proxy.*:${port}"; then
        info "反向代理已正确配置，跳过。"
        return 0
    fi

    # 删除所有旧记录
    info "清理旧网站记录..."
    devil www del "$DOMAIN" >/dev/null 2>&1 || true
    sleep 1

    while [[ $retry -lt $max_retries ]]; do
        info "添加反向代理 (第 $((retry+1)) 次): ${DOMAIN} -> localhost:${port}"
        # 关键修正：需要 localhost 和 https 参数
        if devil www add "$DOMAIN" proxy localhost "$port" https >/dev/null 2>&1; then
            info "反向代理设置成功。"
            return 0
        fi
        retry=$((retry+1))
        sleep 2
    done

    warn "命令行添加失败，请手动在面板操作："
    echo "  域名: ${DOMAIN}  类型: Proxy  端口: ${port}"
    echo "  完成后按 Enter 继续..."
    read -r
}

# ================== 主流程 ==================
main() {
    clear
    info "============================================"
    info "   Uptime Kuma 全自动部署 (Serv00/CT8)"
    info "============================================"

    PORT=$(auto_port)
    info "分配端口：${PORT}"

    mkdir -p "$(dirname "$WORKDIR")"
    cd "$(dirname "$WORKDIR")"
    [[ -d uptime-kuma ]] && rm -rf uptime-kuma

    info "下载预编译包..."
    wget -q --show-progress "$REPO_URL" -O uptime-kuma.zip
    unzip -q uptime-kuma.zip -d uptime-kuma && rm -f uptime-kuma.zip
    cd uptime-kuma

    info "修复文件权限..."
    chmod -R +x node_modules

    echo "UPTIME_KUMA_PORT=${PORT}" > .env
    echo "DATA_DIR=./data" >> .env

    setup_proxy "$PORT"

    echo ""
    info "============================================"
    info "           安 装 完 成"
    info "============================================"
    echo ""
    echo "工作目录: ${WORKDIR}"
    echo "访问地址: https://${DOMAIN}"
    echo ""
    echo "启动服务（后台运行）："
    echo "  screen -dmS kuma node ${WORKDIR}/server/server.js"
    echo ""
    echo "首次访问请注册管理员账户。"
}

main

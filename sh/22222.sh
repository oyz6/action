#!/usr/bin/env bash
set -e

# ==================== 变量定义 ====================
USERNAME=$(whoami)
DOMAIN="${USERNAME}.serv00.net"
WORKDIR="${HOME}/domains/${DOMAIN}/uptime-kuma"
REPO="https://github.com/oyz8/Uptime_Kuma/releases/download/v2.3.2-2/uptime-kuma.zip"

# 颜色输出
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'
info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

# ==================== 环境检测 ====================
command -v devil >/dev/null 2>&1 || error "请在 Serv00/CT8 环境中运行本脚本。"
command -v npm   >/dev/null 2>&1 || error "未找到 npm，请先执行 devil binexec on node22（或其他 Node.js 版本）。"

# ==================== 自动分配端口 ====================
auto_port() {
    # 如果已有预留 tcp 端口，直接使用第一个
    local existing=$(devil port list | awk '/tcp/{print $1; exit}')
    if [[ -n "$existing" ]]; then
        echo "$existing"
        return 0
    fi

    # 否则随机尝试 50 次
    for ((i=0; i<50; i++)); do
        local port=$((RANDOM % 55535 + 10000))
        if devil port add tcp "$port" >/dev/null 2>&1; then
            echo "$port"
            return 0
        fi
    done
    error "无法自动分配端口，请手动在面板中添加。"
}

# ==================== 设置反向代理 ====================
setup_proxy() {
    local port=$1
    if devil www list "$DOMAIN" | grep -q "proxy.*:${port}"; then
        warn "反向代理 ${DOMAIN} -> ${port} 已存在，跳过。"
        return 0
    fi

    # 删除旧的站点记录（如果有）
    devil www del "$DOMAIN" >/dev/null 2>&1 || true
    info "正在添加反向代理：${DOMAIN} -> localhost:${port}"
    devil www add "$DOMAIN" proxy "$port" >/dev/null 2>&1 || {
        error "反向代理添加失败，请手动在面板 WWW 站点中设置 Proxy 端口 ${port}。"
    }
    info "反向代理设置完成。"
}

# ==================== 主流程 ====================
main() {
    clear
    info "===== Uptime Kuma 一键部署 (Serv00/CT8) ====="

    # 1. 分配端口
    PORT=$(auto_port)
    info "已分配端口：${PORT}"

    # 2. 准备目录
    mkdir -p "$(dirname "$WORKDIR")"
    cd "$(dirname "$WORKDIR")"
    if [[ -d uptime-kuma ]]; then
        warn "目录 uptime-kuma 已存在，将删除重建。"
        rm -rf uptime-kuma
    fi

    # 3. 下载并解压
    info "正在下载 Uptime Kuma ..."
    wget -q --show-progress "$REPO" -O uptime-kuma.zip || error "下载失败，请检查网络。"
    unzip -q uptime-kuma.zip -d uptime-kuma && rm -f uptime-kuma.zip
    cd uptime-kuma

    # 4. 写入环境变量
    echo "UPTIME_KUMA_PORT=${PORT}" > .env
    echo "DATA_DIR=./data" >> .env

    # 5. 解决权限问题并安装原生模块（关键！）
    info "正在安装依赖（将自动编译原生模块）..."
    # 先删除可能权限异常的 node_modules，再用 npm install 重新生成
    rm -rf node_modules
    npm install --production || error "依赖安装失败，请确认 Node.js 版本 ≥ 18 且网络正常。"

    # 6. 设置反向代理
    setup_proxy "$PORT"

    # 7. 完成提示
    echo ""
    info "===== 部署成功！====="
    echo "启动 Uptime Kuma（后台运行）："
    echo "  screen -dmS kuma node ${WORKDIR}/server/server.js"
    echo "  或"
    echo "  nohup node ${WORKDIR}/server/server.js > ${WORKDIR}/kuma.log 2>&1 &"
    echo ""
    echo "访问地址：https://${DOMAIN}"
    echo ""
    echo "首次打开请注册管理员账户。"
}

# 执行主函数
main

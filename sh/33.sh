#!/usr/bin/env bash
set -e

# ================== 基础配置 ==================
USERNAME=$(whoami)
# 获取小写用户名（用于域名）
USERNAME_LOWER=$(echo "$USERNAME" | tr '[:upper:]' '[:lower:]')
# 自动判断域名后缀（ct8.pl 或 serv00.net）
if hostname | grep -q "ct8.pl"; then
    DOMAIN_SUFFIX="ct8.pl"
else
    DOMAIN_SUFFIX="serv00.net"
fi
DOMAIN="${USERNAME_LOWER}.${DOMAIN_SUFFIX}"
WORKDIR="${HOME}/domains/${DOMAIN}/uptime-kuma"
# 预编译包（已修复 FreeBSD 兼容性，保留编译好的 node_modules）
REPO_URL="https://github.com/oyz8/Uptime_Kuma/releases/download/v2.3.2-2/uptime-kuma.zip"

# 颜色
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'
info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

# ================== 环境检测 ==================
command -v devil >/dev/null 2>&1 || error "请在 Serv00/CT8 环境中运行。"
command -v npm   >/dev/null 2>&1 || error "未找到 npm，请先启用 Node.js（如：devil binexec on node22）。"

# ================== 自动分配端口 ==================
auto_port() {
    # 优先使用已存在的 tcp 端口
    local existing=$(devil port list | awk '/tcp/{print $1; exit}')
    if [[ -n "$existing" ]]; then
        echo "$existing"
        return
    fi
    # 随机尝试 100 次
    for ((i=0; i<100; i++)); do
        local port=$((RANDOM % 55535 + 10000))
        if devil port add tcp "$port" >/dev/null 2>&1; then
            echo "$port"
            return
        fi
    done
    error "无法自动分配端口，请手动预留一个。"
}

# ================== 反向代理设置（含容错） ==================
setup_proxy() {
    local port=$1
    local max_retries=3
    local retry=0

    # 检查当前域名状态
    local current_type=$(devil www list "$DOMAIN" 2>/dev/null | awk -F'|' '{print $3}' | head -1 | tr -d ' ')
    
    # 如果已经正确配置，直接返回
    if [[ "$current_type" == "proxy" ]] && devil www list "$DOMAIN" | grep -q "proxy.*:${port}"; then
        info "反向代理已正确配置，跳过。"
        return 0
    fi

    # 删除所有该域名的旧记录
    info "清理旧的网站记录..."
    devil www del "$DOMAIN" >/dev/null 2>&1 || true
    sleep 1

    # 重试添加代理
    while [[ $retry -lt $max_retries ]]; do
        info "尝试添加反向代理 (第 $((retry+1)) 次): ${DOMAIN} -> localhost:${port}"
        if devil www add "$DOMAIN" proxy "$port" >/dev/null 2>&1; then
            info "反向代理设置成功。"
            return 0
        fi
        retry=$((retry+1))
        sleep 2
    done

    # 如果命令行失败，给出面板操作指引
    warn "命令行添加反向代理失败，请手动在面板操作："
    echo "  1. 打开控制面板 → WWW 站点"
    echo "  2. 添加网站：域名为 ${DOMAIN}，类型选择 Proxy，端口填 ${port}"
    echo "  完成后按 Enter 继续..."
    read -r
}

# ================== 主流程 ==================
main() {
    clear
    info "============================================"
    info "   Uptime Kuma 全自动部署 (Serv00/CT8)"
    info "============================================"

    # 1. 分配端口
    PORT=$(auto_port)
    info "已分配端口：${PORT}"

    # 2. 准备目录
    mkdir -p "$(dirname "$WORKDIR")"
    cd "$(dirname "$WORKDIR")"
    if [[ -d uptime-kuma ]]; then
        warn "删除旧目录..."
        rm -rf uptime-kuma
    fi

    # 3. 下载预编译包
    info "下载 Uptime Kuma 预编译包..."
    wget -q --show-progress "$REPO_URL" -O uptime-kuma.zip
    unzip -q uptime-kuma.zip -d uptime-kuma && rm -f uptime-kuma.zip
    cd uptime-kuma

    # 4. 修复权限（关键！保留预编译模块，只需赋予执行权限）
    info "修复 node_modules 权限..."
    chmod -R +x node_modules

    # 5. 写入环境变量
    echo "UPTIME_KUMA_PORT=${PORT}" > .env
    echo "DATA_DIR=./data" >> .env

    # 6. 设置反向代理（自动重试，失败后等待手动操作）
    setup_proxy "$PORT"

    # 7. 完成提示
    echo ""
    info "============================================"
    info "           安 装 完 成 ！"
    info "============================================"
    echo ""
    echo "工作目录: ${WORKDIR}"
    echo "访问地址: https://${DOMAIN}"
    echo ""
    echo "启动服务（后台运行）："
    echo "  screen -dmS kuma node ${WORKDIR}/server/server.js"
    echo "  或"
    echo "  nohup node ${WORKDIR}/server/server.js > ${WORKDIR}/kuma.log 2>&1 &"
    echo ""
    echo "首次访问请注册管理员账户。"
}

main

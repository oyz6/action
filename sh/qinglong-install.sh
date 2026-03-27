#!/bin/bash
set -euo pipefail

########################################
# AlwaysData 青龙面板安装脚本 (预构建版)
# 端口: 8100
# bash <(curl -sL https://raw.githubusercontent.com/oyz6/action/main/sh/qinglong-install.sh)
########################################

QL_USER=$(whoami)
QL_HOME="/home/${QL_USER}/www/ql"
QL_PORT=8100
REPO="oyz6/action"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; RED='\033[0;31m'; NC='\033[0m'

log_info() { echo -e "${CYAN}[INFO]${NC} $*"; }
log_ok()   { echo -e "${GREEN}[OK]${NC} $*"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
log_err()  { echo -e "${RED}[ERROR]${NC} $*"; }

echo ""
echo "=========================================="
echo "  AlwaysData 青龙面板安装 (预构建版)"
echo "  端口: ${QL_PORT}"
echo "=========================================="
echo ""

# 1. 获取最新版本
log_info "获取最新版本..."
VERSION=$(curl -sL "https://api.github.com/repos/${REPO}/releases" | grep '"tag_name"' | grep 'ql-v' | head -1 | sed -E 's/.*"ql-v([^"]+)".*/\1/')
if [ -z "$VERSION" ]; then
    log_err "获取版本失败"
    exit 1
fi
log_ok "最新版本: v$VERSION"

# 2. 清理旧进程
if pgrep -f "node.*app.js" >/dev/null 2>&1; then
    log_warn "停止旧进程..."
    pkill -f "node.*app.js" 2>/dev/null || true
    sleep 2
fi

# 3. 准备目录
log_info "准备安装目录..."
mkdir -p "/home/${QL_USER}/www"
rm -rf "$QL_HOME"
mkdir -p "$QL_HOME"
cd "$QL_HOME"

# 4. 下载
log_info "下载青龙面板 v${VERSION}..."
DOWNLOAD_URL="https://github.com/${REPO}/releases/download/ql-v${VERSION}/qinglong-v${VERSION}.tar.gz"
if ! wget -q --show-progress -O qinglong.tar.gz "$DOWNLOAD_URL"; then
    log_err "下载失败"
    exit 1
fi
log_ok "下载完成"

# 5. 解压
log_info "解压安装..."
tar -xzf qinglong.tar.gz --strip-components=1
rm -f qinglong.tar.gz

# 6. 创建数据目录
mkdir -p data

log_ok "安装完成!"

# 7. 输出配置指南
echo ""
echo "=========================================="
echo "  🎉 安装完成！"
echo "=========================================="
echo ""
log_warn "请在 AlwaysData 控制台完成最后配置:"
echo ""
echo "  1. 打开: https://admin.alwaysdata.com/site/"
echo "  2. 点击站点 → web → Sites → 齿轮(Modify)"
echo "  3. 修改为:"
echo "     ┌────────────────────────────────────────┐"
echo "     │ Configuration:     User program        │"
echo "     │ Command:           node app.js         │"
echo "     │ Working directory: /home/${QL_USER}/www/ql │"
echo "     └────────────────────────────────────────┘"
echo "  4. Submit 保存 → 返回上一页 Restart 刷新站点"
echo ""
echo "  🌐 访问: https://${QL_USER}.alwaysdata.net"
echo "  📁 安装目录: ${QL_HOME}"
echo "  🔌 端口: ${QL_PORT}"
echo ""
echo "=========================================="

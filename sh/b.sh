#!/bin/bash
set -euo pipefail

########################################
# AlwaysData 白虎面板安装/更新脚本
# 用法:
#   ./install.sh           → 交互选择（安装/更新）
#   ./install.sh install   → 直接全新安装
#   ./install.sh update    → 直接更新面板（若未安装则自动安装）
########################################

BAIHU_USER=$(whoami)
BAIHU_HOME="/home/${BAIHU_USER}/www"
DEFAULT_VERSION="v1.0.39"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; RED='\033[0;31m'; NC='\033[0m'

log_info() { echo -e "${CYAN}[INFO]${NC} $*"; }
log_ok()   { echo -e "${GREEN}[OK]${NC} $*"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
log_err()  { echo -e "${RED}[ERROR]${NC} $*"; }

# ------------------------------------------------------------
# 版本选择
# ------------------------------------------------------------
choose_version() {
    local choice
    echo ""
    echo "请选择版本获取方式:"
    echo "  1) 自动选择最新版 (推荐)"
    echo "  2) 从最近 20 个版本列表中选择"
    echo "  3) 手动输入版本号 (例如 v1.0.39)"
    read -p "请输入选项 [1]: " choice
    choice=${choice:-1}

    case "$choice" in
        1)
            log_info "正在获取最新版本..."
            BAIHU_VERSION=$(curl -sSf "https://api.github.com/repos/engigu/baihu-panel/releases/latest" 2>/dev/null | \
                python3 -c "import sys,json; print(json.load(sys.stdin)['tag_name'])" 2>/dev/null || \
                python -c "import sys,json; print(json.load(sys.stdin)['tag_name'])" 2>/dev/null || true)
            if [ -z "$BAIHU_VERSION" ]; then
                log_warn "获取最新版本失败，使用默认版本 ${DEFAULT_VERSION}"
                BAIHU_VERSION="$DEFAULT_VERSION"
            fi
            ;;
        2)
            log_info "正在获取版本列表..."
            mapfile -t versions < <(curl -sSf "https://api.github.com/repos/engigu/baihu-panel/releases?per_page=20" 2>/dev/null | \
                python3 -c "import sys,json; [print(r['tag_name']) for r in json.load(sys.stdin)]" 2>/dev/null || \
                python -c "import sys,json; [print(r['tag_name']) for r in json.load(sys.stdin)]" 2>/dev/null || true)
            if [ ${#versions[@]} -eq 0 ]; then
                log_warn "获取列表失败，使用默认版本 ${DEFAULT_VERSION}"
                BAIHU_VERSION="$DEFAULT_VERSION"
            else
                echo "可用版本:"
                for i in "${!versions[@]}"; do
                    printf "  %2d) %s\n" $((i+1)) "${versions[$i]}"
                done
                local idx
                read -p "请输入序号 [1]: " idx
                idx=${idx:-1}
                if [[ "$idx" =~ ^[0-9]+$ ]] && [ "$idx" -ge 1 ] && [ "$idx" -le "${#versions[@]}" ]; then
                    BAIHU_VERSION="${versions[$((idx-1))]}"
                else
                    log_warn "序号无效，使用第一个版本 ${versions[0]}"
                    BAIHU_VERSION="${versions[0]}"
                fi
            fi
            ;;
        3)
            read -p "请输入版本号 (如 v1.0.39): " BAIHU_VERSION
            if [[ ! "$BAIHU_VERSION" =~ ^v ]]; then
                log_err "版本号必须以 'v' 开头"
                exit 1
            fi
            ;;
        *)
            log_err "无效选项"
            exit 1
            ;;
    esac
    log_ok "将使用版本: ${BAIHU_VERSION}"
}

# ------------------------------------------------------------
# 停止旧进程
# ------------------------------------------------------------
stop_baihu() {
    if pgrep -f "baihu server" >/dev/null 2>&1; then
        log_warn "停止正在运行的白虎面板..."
        pkill -f "baihu server" 2>/dev/null || true
        sleep 3
        if pgrep -f "baihu server" >/dev/null 2>&1; then
            pkill -9 -f "baihu server" 2>/dev/null || true
            sleep 1
        fi
        log_ok "旧进程已停止"
    fi
}

# ------------------------------------------------------------
# 更新功能（未安装时自动跳转安装）
# ------------------------------------------------------------
do_update() {
    echo ""
    echo "=========================================="
    echo "  白虎面板 - 更新模式"
    echo "=========================================="

    cd "$BAIHU_HOME"

    # ★★★ 关键修复：未安装时不再报错退出，而是自动安装 ★★★
    if [ ! -f "./baihu" ]; then
        log_warn "检测到未安装白虎面板，将自动为您执行全新安装..."
        do_install
        exit 0
    fi

    choose_version
    local TAR_FILE="baihu-linux-amd64.tar.gz"
    local DOWNLOAD_URL="https://github.com/engigu/baihu-panel/releases/download/${BAIHU_VERSION}/${TAR_FILE}"
    local TMP_DIR=$(mktemp -d)

    # 下载到临时目录
    log_info "下载 ${BAIHU_VERSION} ..."
    if ! wget -q --show-progress -O "${TMP_DIR}/${TAR_FILE}" "$DOWNLOAD_URL"; then
        log_err "下载失败，请检查版本号或网络"
        rm -rf "$TMP_DIR"
        exit 1
    fi

    # 停止旧进程
    stop_baihu

    # 解压并替换 baihu 二进制文件
    log_info "解压并替换 baihu 文件..."
    tar -xzf "${TMP_DIR}/${TAR_FILE}" -C "$TMP_DIR"
    if [ -f "${TMP_DIR}/baihu-linux-amd64" ]; then
        cp -f "${TMP_DIR}/baihu-linux-amd64" "./baihu"
        chmod +x "./baihu"
    else
        log_err "解压后未找到 baihu-linux-amd64 文件"
        rm -rf "$TMP_DIR"
        exit 1
    fi

    rm -rf "$TMP_DIR"

    log_ok "更新完成！baihu 已替换为 ${BAIHU_VERSION}"
    echo ""
    log_warn "请在 AlwaysData 控制台重启站点以应用新版本:"
    echo "  1. 打开 https://admin.alwaysdata.com/site/"
    echo "  2. 点击站点 → 齿轮(Modify) → Submit → Restart"
    echo "  3. 访问: https://${BAIHU_USER}.alwaysdata.net"
    echo ""
}

# ------------------------------------------------------------
# 全新安装
# ------------------------------------------------------------
do_install() {
    echo ""
    echo "=========================================="
    echo "  AlwaysData 白虎面板 - 全新安装"
    echo "=========================================="

    choose_version
    local TAR_FILE="baihu-linux-amd64.tar.gz"
    local DOWNLOAD_URL="https://github.com/engigu/baihu-panel/releases/download/${BAIHU_VERSION}/${TAR_FILE}"

    log_info "准备安装环境..."
    mkdir -p "$BAIHU_HOME"
    cd "$BAIHU_HOME"

    stop_baihu

    log_info "下载白虎面板 ${BAIHU_VERSION}..."
    rm -f baihu "${TAR_FILE}" 2>/dev/null || true
    if ! wget -q --show-progress -O "${TAR_FILE}" "$DOWNLOAD_URL"; then
        log_err "下载失败"
        exit 1
    fi

    log_info "解压安装..."
    tar -xzf "${TAR_FILE}"
    mv baihu-linux-amd64 baihu
    chmod +x baihu
    rm -f "${TAR_FILE}"
    log_ok "主程序就绪"

    # 配置文件（只在全新安装时生成，更新时不覆盖）
    log_info "生成配置..."
    mkdir -p configs logs
    cat > configs/config.ini << 'EOF'
[server]
port = 8100
host = 0.0.0.0
url_prefix =

[database]
type = sqlite
host = localhost
port = 3306
user = root
password = 
dbname = ql_panel
table_prefix = baihu_
EOF
    log_ok "配置已写入"

    # 首次启动获取默认密码
    log_info "首次启动，获取默认密码..."
    nohup ./baihu server > logs/baihu-init.log 2>&1 &
    local BAIHU_PID=$!
    local DEFAULT_PASSWORD=""
    local RETRY=0
    while [ $RETRY -lt 30 ]; do
        DEFAULT_PASSWORD=$(grep -oP '密\s*码:\s*\K[^,[:space:]]+' logs/baihu-init.log 2>/dev/null | tail -n 1 || true)
        [ -z "$DEFAULT_PASSWORD" ] && \
            DEFAULT_PASSWORD=$(grep -oP 'password:\s*\K\S+' logs/baihu-init.log 2>/dev/null | tail -n 1 || true)
        [ -n "$DEFAULT_PASSWORD" ] && break
        RETRY=$((RETRY + 1))
        sleep 2
    done

    kill "$BAIHU_PID" 2>/dev/null || true
    wait "$BAIHU_PID" 2>/dev/null || true

    echo ""
    echo "=========================================="
    echo "  🎉 安装完成！"
    echo "=========================================="
    echo ""
    if [ -n "$DEFAULT_PASSWORD" ]; then
        echo "  👤 用户名: admin"
        echo "  🔑 密码:   ${DEFAULT_PASSWORD}"
    else
        log_warn "未能自动获取密码，请查看日志:"
        echo "     tail ~/www/logs/baihu-init.log"
    fi
    echo ""
    log_warn "请在 AlwaysData 控制台完成最后配置:"
    echo ""
    echo "  1. 打开: https://admin.alwaysdata.com/site/"
    echo "  2. 点击站点 → web → Sites → 齿轮(Modify)"
    echo "  3. 修改为:"
    echo "     ┌────────────────────────────────────────┐"
    echo "     │ Configuration:     User program        │"
    echo "     │ Command:           ./baihu server      │"
    echo "     │ Working directory: /home/${BAIHU_USER}/www        │"
    echo "     └────────────────────────────────────────┘"
    echo "  4. Submit 保存 → 返回上一页 Restart 刷新站点"
    echo ""
    echo "  🌐 访问: https://${BAIHU_USER}.alwaysdata.net"
    echo ""
    echo "=========================================="
}

# ------------------------------------------------------------
# 主入口
# ------------------------------------------------------------
ACTION="${1:-menu}"

case "$ACTION" in
    update)
        do_update
        ;;
    install)
        do_install
        ;;
    menu|"")
        echo ""
        echo "=========================================="
        echo "  AlwaysData 白虎面板管理脚本"
        echo "=========================================="
        echo "  1) 全新安装"
        echo "  2) 更新面板（保留数据）"
        read -p "请输入选项 [1]: " choice
        choice=${choice:-1}
        case "$choice" in
            1) do_install ;;
            2) do_update ;;
            *) log_err "无效选项" && exit 1 ;;
        esac
        ;;
    *)
        log_err "未知参数: $ACTION (可用: install / update)"
        exit 1
        ;;
esac

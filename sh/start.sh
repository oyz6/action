#!/bin/bash

# ===================== 辅助函数 ========================
log_info() { echo "[INFO] $1"; }
log_warn() { echo "[WARN] $1"; }
log_err()  { echo "[ERROR] $1" >&2; }
log_ok()   { echo "[SUCCESS] $1 ✓"; }

# ===================== 配置变量 ========================
WORK_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$WORK_DIR"

PORT="${PORT:-8100}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-oyz88888}"
GH_TOKEN="${GH_TOKEN:-}"
GH_BACKUP_REPO="${GH_BACKUP_REPO:-}"
GH_BACKUP_BRANCH="${GH_BACKUP_BRANCH:-main}"
BAIHU_VERSION="v1.0.39"
BAIHU_URL="https://github.com/engigu/baihu-panel/releases/download/${BAIHU_VERSION}/baihu-linux-amd64.tar.gz"

# ===================== 下载/更新主程序（带判断）=======================
download_baihu() {
    if [ -x "./baihu" ]; then
        log_info "检测到已存在 baihu 可执行文件，跳过下载"
        # 可选：检查版本是否匹配
        # CURRENT_VERSION=$(./baihu version 2>/dev/null | grep -oP 'v\d+\.\d+\.\d+' | head -1)
        # if [ "$CURRENT_VERSION" = "$BAIHU_VERSION" ]; then
        #     return
        # else
        #     log_warn "版本不匹配（当前 $CURRENT_VERSION，需要 $BAIHU_VERSION），重新下载"
        # fi
        return
    fi

    log_info "下载白虎面板 ${BAIHU_VERSION}..."
    rm -f baihu baihu-linux-amd64.tar.gz 2>/dev/null || true

    if ! wget -q --show-progress -O baihu-linux-amd64.tar.gz "$BAIHU_URL"; then
        log_err "下载失败"
        exit 1
    fi

    log_info "解压安装..."
    tar -xzf baihu-linux-amd64.tar.gz
    mv baihu-linux-amd64 baihu
    chmod +x baihu
    rm -f baihu-linux-amd64.tar.gz
    log_ok "主程序就绪"
}

# ===================== 生成配置文件 ========================
generate_config() {
    mkdir -p configs
    cat > configs/config.ini <<EOF
[server]
port = $PORT
host = 0.0.0.0
url_prefix =

[database]
type = sqlite
host = localhost
port = 3306
user = root
password = 
dbname = baihu_panel
table_prefix = baihu_
EOF
    log_ok "配置文件已生成 (端口: $PORT)"
}

# ===================== 从 GitHub 恢复备份 ========================
restore_backup() {
    if [ -z "$GH_TOKEN" ] || [ -z "$GH_BACKUP_REPO" ]; then
        log_info "未配置 GitHub 备份，跳过恢复"
        return
    fi

    API_BASE="https://api.github.com/repos/$GH_BACKUP_REPO"
    log_info "检查 GitHub 备份 (分支: $GH_BACKUP_BRANCH)..."

    BACKUP_FILES=$(curl -s \
        -H "Authorization: token $GH_TOKEN" \
        "$API_BASE/contents?ref=$GH_BACKUP_BRANCH" \
        | jq -r '.[].name' 2>/dev/null | grep '^backup_[0-9]\{8\}_[0-9]\{6\}\.zip$' | sort -r)

    if [ -z "$BACKUP_FILES" ]; then
        log_info "仓库中暂无匹配的备份文件（格式：backup_YYYYMMDD_HHMMSS.zip）"
        return
    fi

    latest_file=$(echo "$BACKUP_FILES" | head -n 1)
    log_info "找到最新备份: $latest_file"

    DOWNLOAD_URL=$(curl -s \
        -H "Authorization: token $GH_TOKEN" \
        "$API_BASE/contents/$latest_file?ref=$GH_BACKUP_BRANCH" \
        | jq -r '.download_url')

    if [ -z "$DOWNLOAD_URL" ] || [ "$DOWNLOAD_URL" = "null" ]; then
        log_err "获取下载链接失败"
        return
    fi

    mkdir -p "$WORK_DIR/backup_tmp"
    log_info "下载备份文件..."
    curl -sL \
        -H "Authorization: token $GH_TOKEN" \
        "$DOWNLOAD_URL" \
        -o "$WORK_DIR/backup_tmp/$latest_file"

    log_info "恢复备份..."
    ./baihu restore "$WORK_DIR/backup_tmp/$latest_file"
    rm -rf "$WORK_DIR/backup_tmp"
    log_ok "备份恢复完成"
}

# ===================== 首次初始化 ========================
init_setup() {
    INIT_FLAG="$WORK_DIR/data/.initialized"
    if [ -f "$INIT_FLAG" ]; then
        log_info "系统已初始化，跳过密码重置"
        return
    fi

    log_info "首次初始化..."
    ./baihu server &
    TEMP_PID=$!
    sleep 10

    API_URL="http://localhost:$PORT"
    DEFAULT_PASSWORD=$(./baihu server 2>&1 | grep -oP '密\s*码:\s*\K[^,[:space:]]+' | head -n 1)
    
    if [ -z "$DEFAULT_PASSWORD" ]; then
        log_warn "无法自动获取默认密码，跳过密码重置"
    else
        log_info "重置管理员密码..."
        curl -c cookies.txt -s \
            "$API_URL/api/v1/auth/login" \
            -H 'content-type: application/json' \
            --data-raw "{\"username\":\"admin\",\"password\":\"$DEFAULT_PASSWORD\"}"

        sleep 1
        curl -b cookies.txt -s \
            "$API_URL/api/v1/settings/password" \
            -H 'content-type: application/json' \
            --data-raw "{\"old_password\":\"$DEFAULT_PASSWORD\",\"new_password\":\"$ADMIN_PASSWORD\"}"
        rm -f cookies.txt
    fi

    kill $TEMP_PID 2>/dev/null
    sleep 2
    mkdir -p "$WORK_DIR/data"
    touch "$INIT_FLAG"
    log_ok "初始化完成"
}

# ===================== 主流程 ========================
main() {
    download_baihu
    generate_config
    restore_backup
    init_setup
    log_info "启动白虎服务，端口: $PORT"
    exec ./baihu server
}

main

#!/bin/bash
set -euo pipefail

########################################
# AlwaysData 白虎面板安装/更新/初始化/备份脚本
# 用法:
#   ./install.sh           → 交互菜单
#   ./install.sh install   → 全新安装（含引导初始化）
#   ./install.sh update    → 更新面板（保留数据）
#   ./install.sh init      → 单独改密 + 备份配置
#   ./install.sh backup    → 仅配置自动备份
########################################

BAIHU_USER=$(whoami)
BAIHU_HOME="/home/${BAIHU_USER}/www"
DEFAULT_VERSION="v1.0.39"
PANEL_URL="https://${BAIHU_USER}.alwaysdata.net"

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
# 登录面板，返回 BHToken
# ------------------------------------------------------------
login_panel() {
    local user="$1" pass="$2"
    curl -s -c cookies.txt -o /dev/null \
        "${PANEL_URL}/api/v1/auth/login" \
        -H 'content-type: application/json' \
        --data-raw "{\"username\":\"$user\",\"password\":\"$pass\"}"
    local token=$(grep 'BHToken' cookies.txt | awk '{print $NF}')
    rm -f cookies.txt
    echo "$token"
}

# ------------------------------------------------------------
# 修改密码（先登录再改密）
# ------------------------------------------------------------
change_password_api() {
    local old_user="$1" old_pass="$2" new_user="$3" new_pass="$4"

    log_info "正在登录面板（用于改密）..."
    local token=$(login_panel "$old_user" "$old_pass")
    if [ -z "$token" ]; then
        log_err "登录失败，无法修改密码"
        return 1
    fi

    log_info "正在修改面板登录密码..."
    local response
    response=$(curl -s -X POST \
        "${PANEL_URL}/api/v1/settings/password" \
        -H 'Content-Type: application/json' \
        -H "Cookie: BHToken=$token" \
        -d "{\"old_username\":\"$old_user\",\"username\":\"$new_user\",\"old_password\":\"$old_pass\",\"new_password\":\"$new_pass\"}")

    if echo "$response" | grep -q '"code":200'; then
        log_ok "密码修改成功！新用户名: $new_user"
        return 0
    else
        log_err "密码修改失败: $(echo "$response" | grep -o '"msg":"[^"]*"' || true)"
        return 1
    fi
}

# ------------------------------------------------------------
# 等待面板启动（轮询外部地址）
# ------------------------------------------------------------
wait_for_panel() {
    local retries=60 count=0
    log_info "等待白虎面板启动（最多 5 分钟）..."
    while [ $count -lt $retries ]; do
        if curl -sS --connect-timeout 5 --max-time 10 "${PANEL_URL}" >/dev/null 2>&1; then
            log_ok "面板已启动！"
            return 0
        fi
        sleep 5
        count=$((count + 1))
        if [ $((count % 12)) -eq 0 ]; then
            log_info "仍在等待... 请确保 AlwaysData 站点已配置为 User program 且命令正确"
        fi
    done
    log_err "面板启动超时，请检查站点配置"
    return 1
}

# ------------------------------------------------------------
# 生成备份脚本并创建定时任务（复用已登录 token 或新建）
# ------------------------------------------------------------
create_backup_job() {
    local admin_user="$1" admin_pass="$2" backup_pass="$3"
    local gh_token="$4" gh_repo="$5" gh_branch="$6"

    mkdir -p "$BAIHU_HOME/data/scripts"
    local BACKUP_SCRIPT="$BAIHU_HOME/data/scripts/backup.sh"

    log_info "生成备份脚本: $BACKUP_SCRIPT"

    cat > "$BACKUP_SCRIPT" << 'BACKUP_SCRIPT_EOF'
#!/bin/bash
set -u

BAIHU_USER=$(whoami)
WORK_DIR="/home/${BAIHU_USER}/www"
cd "$WORK_DIR"

PANEL_URL="${PANEL_URL:-https://${BAIHU_USER}.alwaysdata.net}"
USERNAME="${ADMIN_USERNAME:-admin}"

echo "[INFO] 面板地址: $PANEL_URL"
echo "[INFO] 用户名: $USERNAME"
echo "[INFO] 开始登录..."

curl -c cookies.txt -s \
    "${PANEL_URL}/api/v1/auth/login" \
    -H 'content-type: application/json' \
    --data-raw "{\"username\":\"$USERNAME\",\"password\":\"$ADMIN_PASSWORD\"}"

echo "[INFO] 请求生成备份..."
curl -b cookies.txt -s -X POST \
    "${PANEL_URL}/api/v1/settings/backup" \
    -H 'content-type: application/json' > /dev/null

echo "[INFO] 等待备份生成..."
sleep 10

latest_file=$(ls -t "$WORK_DIR/data/backups" 2>/dev/null | head -n 1)
if [ -z "$latest_file" ]; then
    echo "[ERROR] 未找到备份文件"
    rm -f cookies.txt
    exit 1
fi

BACKUP_PATH="$WORK_DIR/data/backups/$latest_file"
BACKUP_SIZE=$(du -sh "$BACKUP_PATH" | cut -f1)
BACKUP_FILE="$latest_file"

echo "[INFO] 备份文件: $BACKUP_FILE ($BACKUP_SIZE)"

if [ -n "${BACKUP_PASS:-}" ]; then
    echo "[INFO] 使用密码加密备份..."
    if command -v zip &>/dev/null; then
        cd "$WORK_DIR/data/backups"
        zip -P "$BACKUP_PASS" -r "${BACKUP_FILE}.enc.zip" "$latest_file"
        mv "${BACKUP_FILE}.enc.zip" "$BACKUP_PATH"
        BACKUP_FILE="${latest_file}.enc.zip"
        echo "[INFO] 加密完成"
    else
        echo "[WARN] 未安装 zip 命令，跳过加密"
    fi
fi

if [ -z "${GH_TOKEN:-}" ] || [ -z "${GH_BACKUP_REPO:-}" ]; then
    echo "[WARN] 缺少 GitHub 配置，跳过上传"
    rm -f cookies.txt
    exit 0
fi

GH_BACKUP_BRANCH="${GH_BACKUP_BRANCH:-main}"
KEEP="${KEEP_BACKUPS:-5}"
API_BASE="https://api.github.com/repos/$GH_BACKUP_REPO"

base64 -w 0 "$BACKUP_PATH" > content.b64 2>/dev/null || base64 "$BACKUP_PATH" > content.b64

echo "[INFO] 上传备份文件..."
EXISTING_SHA=$(curl -s -H "Authorization: token $GH_TOKEN" \
    "$API_BASE/contents/$BACKUP_FILE?ref=$GH_BACKUP_BRANCH" | jq -r '.sha // empty')

if [ -n "$EXISTING_SHA" ]; then
    jq -n --rawfile content content.b64 \
        --arg msg "更新备份: $BACKUP_FILE" --arg sha "$EXISTING_SHA" --arg branch "$GH_BACKUP_BRANCH" \
        '{message: $msg, content: $content, sha: $sha, branch: $branch}' > payload.json
else
    jq -n --rawfile content content.b64 \
        --arg msg "备份: $BACKUP_FILE ($BACKUP_SIZE)" --arg branch "$GH_BACKUP_BRANCH" \
        '{message: $msg, content: $content, branch: $branch}' > payload.json
fi

RESPONSE=$(curl -s -X PUT -H "Authorization: token $GH_TOKEN" -H "Content-Type: application/json" \
    -d @payload.json "$API_BASE/contents/$BACKUP_FILE")
rm -f payload.json content.b64

if echo "$RESPONSE" | jq -e '.content.sha' >/dev/null 2>&1; then
    echo "[SUCCESS] 备份文件已上传 ✓"
else
    echo "[ERROR] 上传失败: $(echo "$RESPONSE" | jq -r '.message // "未知错误"')"
    rm -f cookies.txt
    exit 1
fi

echo "[INFO] 更新 README.md..."
README_SHA=$(curl -s -H "Authorization: token $GH_TOKEN" \
    "$API_BASE/contents/README.md?ref=$GH_BACKUP_BRANCH" | jq -r '.sha // empty')

README_TEXT="# 白虎面板备份

**最新备份:** \`$BACKUP_FILE\`  
**备份时间:** $(TZ='Asia/Shanghai' date '+%Y-%m-%d %H:%M:%S')  
**文件大小:** $BACKUP_SIZE  
"
README_B64=$(echo -n "$README_TEXT" | base64 -w 0 2>/dev/null || echo -n "$README_TEXT" | base64)

if [ -n "$README_SHA" ]; then
    echo "{\"message\":\"更新README\",\"content\":\"$README_B64\",\"sha\":\"$README_SHA\",\"branch\":\"$GH_BACKUP_BRANCH\"}" > readme.json
else
    echo "{\"message\":\"创建README\",\"content\":\"$README_B64\",\"branch\":\"$GH_BACKUP_BRANCH\"}" > readme.json
fi

curl -s -X PUT -H "Authorization: token $GH_TOKEN" -H "Content-Type: application/json" \
    -d @readme.json "$API_BASE/contents/README.md" > /dev/null
rm -f readme.json
echo "[SUCCESS] README.md 已更新 ✓"

echo "[INFO] 清理旧备份（保留 $KEEP 个）..."
OLD_BACKUPS=$(curl -s -H "Authorization: token $GH_TOKEN" \
    "$API_BASE/contents?ref=$GH_BACKUP_BRANCH" | jq -r '.[].name' | grep '^backup_[0-9]\{8\}_[0-9]\{6\}\.zip$' | sort -r | tail -n +$((KEEP + 1)))

for old_file in $OLD_BACKUPS; do
    echo "[INFO] 删除: $old_file"
    OLD_SHA=$(curl -s -H "Authorization: token $GH_TOKEN" \
        "$API_BASE/contents/$old_file?ref=$GH_BACKUP_BRANCH" | jq -r '.sha')
    curl -s -X DELETE -H "Authorization: token $GH_TOKEN" -H "Content-Type: application/json" \
        -d "{\"message\":\"删除旧备份\",\"sha\":\"$OLD_SHA\",\"branch\":\"$GH_BACKUP_BRANCH\"}" \
        "$API_BASE/contents/$old_file" > /dev/null
done

rm -f cookies.txt "$BACKUP_PATH"
echo "[SUCCESS] 备份完成: $BACKUP_FILE 🎉"
BACKUP_SCRIPT_EOF

    chmod +x "$BACKUP_SCRIPT"

    # 构建环境变量
    local envs="ADMIN_USERNAME=${admin_user}\nADMIN_PASSWORD=${admin_pass}"
    [ -n "$backup_pass" ] && envs="${envs}\nBACKUP_PASS=${backup_pass}"
    [ -n "$gh_branch" ] && envs="${envs}\nGH_BACKUP_BRANCH=${gh_branch}"
    [ -n "$gh_token" ] && envs="${envs}\nGH_TOKEN=${gh_token}"
    [ -n "$gh_repo" ] && envs="${envs}\nGH_BACKUP_REPO=${gh_repo}"
    envs=$(echo -e "$envs")

    # 登录获取 token（使用新密码）
    log_info "登录面板（用于创建备份任务）..."
    local token=$(login_panel "$admin_user" "$admin_pass")
    if [ -z "$token" ]; then
        log_err "登录失败，无法创建定时任务"
        return 1
    fi

    local task_json=$(cat <<TASK_JSON_EOF
{
    "retry_count": 0,
    "retry_interval": 0,
    "random_range": 0,
    "timeout": 30,
    "name": "本机备份",
    "remark": "",
    "command": "bash backup.sh",
    "type": "task",
    "schedule": "0 0 4 * * *",
    "work_dir": "\$SCRIPTS_DIR\$",
    "enabled": true,
    "clean_config": "",
    "envs": "$envs",
    "trigger_type": "cron",
    "agent_id": null,
    "languages": [],
    "config": "{\\"\$task_concurrency\\":1,\\"\$task_all_envs\\":false}"
}
TASK_JSON_EOF
)

    local create_resp=$(curl -s -X POST \
        "${PANEL_URL}/api/v1/tasks" \
        -H "Content-Type: application/json" \
        -H "Cookie: BHToken=$token" \
        -d "$task_json")

    if echo "$create_resp" | grep -q '"code":200'; then
        log_ok "定时备份任务已创建成功！"
        local task_id=$(echo "$create_resp" | grep -o '"id":"[^"]*' | cut -d'"' -f4)
        if [ -n "$task_id" ]; then
            curl -s -X POST "${PANEL_URL}/api/v1/notify/bindings/batch" \
                -H "Content-Type: application/json" \
                -H "Cookie: BHToken=$token" \
                -d "{\"type\":\"task\",\"data_id\":\"$task_id\",\"bindings\":[]}" > /dev/null
        fi
    else
        log_err "创建任务失败，请稍后手动添加"
    fi
}

# ------------------------------------------------------------
# 安装后初始化（改密 + 备份配置），交互极简
# ------------------------------------------------------------
post_install_setup() {
    local old_user="admin"
    local old_pass="$1"

    echo ""
    echo "=========================================="
    echo "  面板初始化：改密 + 配置自动备份"
    echo "=========================================="
    echo ""

    if ! wait_for_panel; then
        log_err "无法连接到面板，请手动完成初始化。"
        return 1
    fi

    # 只需用户输入新用户名和密码
    read -p "请输入新用户名 [mc838]: " new_user
    new_user=${new_user:-mc838}
    read -sp "请输入新密码: " new_pass
    echo ""
    if [ -z "$new_pass" ]; then
        log_err "密码不能为空"
        return 1
    fi

    if ! change_password_api "$old_user" "$old_pass" "$new_user" "$new_pass"; then
        return 1
    fi

    # 备份配置（可选）
    echo ""
    log_info "接下来配置自动备份（可选 GitHub 上传）"
    read -p "ZIP 备份密码 (可选，直接回车跳过): " backup_pass
    read -p "GitHub 访问令牌 (可选，直接回车跳过): " gh_token
    local gh_repo="" gh_branch="main"
    if [ -n "$gh_token" ]; then
        read -p "GitHub 备份仓库 (格式: 用户名/仓库): " gh_repo
        if [ -z "$gh_repo" ]; then
            log_warn "未提供仓库，将跳过 GitHub 上传"
            gh_token=""
        fi
        read -p "GitHub 分支 [main]: " gh_branch
        gh_branch=${gh_branch:-main}
    fi

    create_backup_job "$new_user" "$new_pass" "$backup_pass" "$gh_token" "$gh_repo" "$gh_branch"

    echo ""
    log_ok "🎉 初始化完成！面板已就绪，每日凌晨 4:00 自动备份。"
    echo ""
    echo "  面板地址: ${PANEL_URL}"
    echo "  用户名: $new_user"
    echo "  密码: ******"
    echo ""
}

# ------------------------------------------------------------
# 更新功能
# ------------------------------------------------------------
do_update() {
    echo ""
    echo "=========================================="
    echo "  白虎面板 - 更新模式"
    echo "=========================================="

    cd "$BAIHU_HOME"

    if [ ! -f "./baihu" ]; then
        log_warn "检测到未安装白虎面板，将自动为您执行全新安装..."
        do_install
        exit 0
    fi

    choose_version
    local TAR_FILE="baihu-linux-amd64.tar.gz"
    local DOWNLOAD_URL="https://github.com/engigu/baihu-panel/releases/download/${BAIHU_VERSION}/${TAR_FILE}"
    local TMP_DIR=$(mktemp -d)

    log_info "下载 ${BAIHU_VERSION} ..."
    if ! wget -q --show-progress -O "${TMP_DIR}/${TAR_FILE}" "$DOWNLOAD_URL"; then
        log_err "下载失败，请检查版本号或网络"
        rm -rf "$TMP_DIR"
        exit 1
    fi

    stop_baihu

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
    echo "  3. 访问: ${PANEL_URL}"
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
    echo "  🎉 文件安装完成！"
    echo "=========================================="
    echo ""
    if [ -n "$DEFAULT_PASSWORD" ]; then
        echo "  👤 用户名: admin"
        echo "  🔑 临时密码:   ${DEFAULT_PASSWORD}"
    else
        log_warn "未能自动获取密码，请查看日志:"
        echo "     tail ~/www/logs/baihu-init.log"
    fi
    echo ""
    echo "------------------------------------------"
    echo "  📌 下一步操作:"
    echo "------------------------------------------"
    echo "  1. 打开 AlwaysData 控制台: https://admin.alwaysdata.com/site/"
    echo "  2. 将站点的「Configuration」改为 User program"
    echo "     Command:           ./baihu server"
    echo "     Working directory: /home/${BAIHU_USER}/www"
    echo "  3. 点击 Submit 保存（无需手动 Restart）"
    echo "  4. 回到本终端，按回车继续..."
    echo "------------------------------------------"
    read -p "完成后按回车键开始自动初始化面板..."

    if [ -n "$DEFAULT_PASSWORD" ]; then
        post_install_setup "$DEFAULT_PASSWORD"
    else
        log_err "未找到默认密码，无法自动初始化，请手动运行: ./install.sh init"
    fi
}

# ------------------------------------------------------------
# 单独的初始化功能
# ------------------------------------------------------------
do_init() {
    echo ""
    echo "=========================================="
    echo "  初始化白虎面板（改密 + 自动备份）"
    echo "=========================================="
    echo ""
    read -p "请输入旧用户名 [admin]: " old_user
    old_user=${old_user:-admin}
    read -sp "请输入旧密码: " old_pass
    echo ""
    if [ -z "$old_pass" ]; then
        log_err "密码不能为空"
        return 1
    fi
    post_install_setup "$old_pass"
}

# ------------------------------------------------------------
# 仅配置备份
# ------------------------------------------------------------
do_backup() {
    echo ""
    echo "=========================================="
    echo "  配置自动备份"
    echo "=========================================="
    echo ""
    log_warn "请确保面板已启动且密码正确。"
    read -p "面板用户名 [admin]: " admin_user
    admin_user=${admin_user:-admin}
    read -sp "面板密码: " admin_pass
    echo ""
    if [ -z "$admin_pass" ]; then
        log_err "密码不能为空"
        return 1
    fi

    read -p "ZIP 备份密码 (可选): " backup_pass
    read -p "GitHub Token (可选): " gh_token
    local gh_repo="" gh_branch="main"
    if [ -n "$gh_token" ]; then
        read -p "GitHub 仓库: " gh_repo
        read -p "分支 [main]: " gh_branch; gh_branch=${gh_branch:-main}
    fi

    if ! wait_for_panel; then return 1; fi
    create_backup_job "$admin_user" "$admin_pass" "$backup_pass" "$gh_token" "$gh_repo" "$gh_branch"
    log_ok "备份配置完成！"
}

# ------------------------------------------------------------
# 主菜单
# ------------------------------------------------------------
ACTION="${1:-menu}"

case "$ACTION" in
    update) do_update ;;
    install) do_install ;;
    init) do_init ;;
    backup) do_backup ;;
    menu|"")
        echo ""
        echo "=========================================="
        echo "  AlwaysData 白虎面板管理脚本"
        echo "=========================================="
        echo "  1) 全新安装（含引导初始化）"
        echo "  2) 更新面板（保留数据）"
        echo "  3) 初始化（改密 + 自动备份）"
        echo "  4) 仅配置自动备份"
        read -p "请输入选项 [1]: " choice
        choice=${choice:-1}
        case "$choice" in
            1) do_install ;;
            2) do_update ;;
            3) do_init ;;
            4) do_backup ;;
            *) log_err "无效选项" && exit 1 ;;
        esac
        ;;
    *) log_err "未知参数: $ACTION (可用: install / update / init / backup)" && exit 1 ;;
esac

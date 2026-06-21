#!/bin/bash
set -euo pipefail

########################################
# AlwaysData 白虎面板安装/更新/备份配置脚本
# 用法:
#   ./install.sh           → 交互选择（安装/更新/备份配置）
#   ./install.sh install   → 直接全新安装
#   ./install.sh update    → 直接更新面板（若未安装则自动安装）
#   ./install.sh backup    → 直接配置自动备份
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

    # 配置文件（仅全新安装时生成）
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
    echo "  💡 提示：启动面板后，建议先修改默认密码，再运行本脚本配置自动备份。"
    echo ""
    echo "=========================================="
}

# ------------------------------------------------------------
# 配置自动备份功能
# ------------------------------------------------------------
setup_backup() {
    echo ""
    echo "=========================================="
    echo "  配置自动备份"
    echo "=========================================="
    echo ""

    # ★ 新增：前置条件检查
    log_warn "配置自动备份需要满足以下条件："
    echo "  1. 面板已在 AlwaysData 控制台启动（Site 状态为 Running）。"
    echo "  2. 已登录面板并修改了默认密码（非首次启动生成的随机密码）。"
    echo "  3. 面板可通过 http://localhost:8100 正常访问（脚本内网调用）。"
    echo ""
    read -p "是否已完成以上步骤？(y/n) [y]: " confirm
    confirm=${confirm:-y}
    if [ "$confirm" != "y" ]; then
        log_info "已取消备份配置，请先完成面板设置后再运行本脚本。"
        return 0
    fi

    log_info "此功能将创建备份脚本并添加每日凌晨 4:00 的定时任务。"
    log_info "请准备好 GitHub Token 和仓库信息（可选，可跳过 GitHub 上传）。"
    echo ""

    # 收集用户输入
    read -p "面板账号 [admin]: " ADMIN_USERNAME
    ADMIN_USERNAME=${ADMIN_USERNAME:-admin}

    read -sp "面板密码: " ADMIN_PASSWORD
    echo ""
    if [ -z "$ADMIN_PASSWORD" ]; then
        log_err "密码不能为空"
        return 1
    fi

    read -p "ZIP 备份密码 (可选，直接回车跳过): " BACKUP_PASS
    read -p "GitHub 访问令牌 (可选，直接回车跳过): " GH_TOKEN
    if [ -n "$GH_TOKEN" ]; then
        read -p "GitHub 备份仓库 (格式: 用户名/仓库): " GH_BACKUP_REPO
        if [ -z "$GH_BACKUP_REPO" ]; then
            log_warn "未提供仓库，将跳过 GitHub 上传"
            GH_TOKEN=""
        fi
        read -p "GitHub 分支 [main]: " GH_BACKUP_BRANCH
        GH_BACKUP_BRANCH=${GH_BACKUP_BRANCH:-main}
    fi

    # 创建目录
    mkdir -p "$BAIHU_HOME/data/scripts"
    BACKUP_SCRIPT="$BAIHU_HOME/data/scripts/backup.sh"

    log_info "生成备份脚本: $BACKUP_SCRIPT"

    # 生成备份脚本内容
    cat > "$BACKUP_SCRIPT" << 'BACKUP_SCRIPT_EOF'
#!/bin/bash
set -u

###########################################
#  白虎面板 GitHub 备份脚本 alwaysdata容器
###########################################

BAIHU_USER=$(whoami)
WORK_DIR="/home/${BAIHU_USER}/www"
cd "$WORK_DIR"

PORT="${PORT:-8100}"
USERNAME="${ADMIN_USERNAME:-admin}"

# ---------- 自动查找 baihu 进程监听的地址 ----------
echo "[INFO] 正在查找白虎面板 API 地址..."
BAIHU_PID=$(pgrep -f "baihu" 2>/dev/null | head -1)
if [ -z "$BAIHU_PID" ]; then
    echo "[ERROR] 未找到运行中的 baihu 进程" >&2
    exit 1
fi

API_URL=$(ss -tlnp 2>/dev/null | awk -v pid="$BAIHU_PID" -v port="$PORT" '
    $0 ~ pid && $0 ~ ":" port "\\>" {
        addr = $4
        sub(/:'"$PORT"'$/, "", addr)
        gsub(/^\[|\]$/, "", addr)
        if (addr ~ /:/) {
            print "http://[" addr "]:" port
        } else {
            print "http://" addr ":" port
        }
        exit
    }')

if [ -z "$API_URL" ]; then
    echo "[ERROR] 无法找到 baihu 进程监听的 $PORT 端口" >&2
    exit 1
fi

echo "[INFO] API 地址: $API_URL"
echo "[INFO] 工作目录: $WORK_DIR"
echo "[INFO] 用户名: $USERNAME"
echo "[INFO] 开始登陆..."

# ---------- 登录 ----------
curl -c cookies.txt -s \
    "$API_URL/api/v1/auth/login" \
    -H 'content-type: application/json' \
    --data-raw "{\"username\":\"$USERNAME\",\"password\":\"$ADMIN_PASSWORD\"}"

echo "[INFO] 请求生成备份..."
curl -b cookies.txt -s -X POST \
    "$API_URL/api/v1/settings/backup" \
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

# 如果提供了 BACKUP_PASS，则加密备份（可选）
if [ -n "${BACKUP_PASS:-}" ]; then
    echo "[INFO] 使用密码加密备份..."
    if command -v zip &>/dev/null; then
        cd "$WORK_DIR/data/backups"
        zip -P "$BACKUP_PASS" -r "${BACKUP_FILE}.enc.zip" "$latest_file" \
            && mv "${BACKUP_FILE}.enc.zip" "$BACKUP_PATH" \
            && BACKUP_FILE="${latest_file}.enc.zip" \
            && echo "[INFO] 加密完成"
    else
        echo "[WARN] 未安装 zip 命令，跳过加密"
    fi
fi

# ===================== 上传到 GitHub ========================
if [ -z "${GH_TOKEN:-}" ] || [ -z "${GH_BACKUP_REPO:-}" ]; then
    echo "[WARN] 缺少 GH_TOKEN 或 GH_BACKUP_REPO，跳过上传"
    rm -f cookies.txt
    exit 0
fi

GH_BACKUP_BRANCH="${GH_BACKUP_BRANCH:-main}"
KEEP="${KEEP_BACKUPS:-5}"
API_BASE="https://api.github.com/repos/$GH_BACKUP_REPO"

base64 -w 0 "$BACKUP_PATH" > content.b64 2>/dev/null \
    || base64 "$BACKUP_PATH" > content.b64

# ---------- 1. 上传备份文件 ----------
echo "[INFO] 上传备份文件..."
EXISTING_SHA=$(curl -s \
    -H "Authorization: token $GH_TOKEN" \
    "$API_BASE/contents/$BACKUP_FILE?ref=$GH_BACKUP_BRANCH" \
    | jq -r '.sha // empty')

if [ -n "$EXISTING_SHA" ]; then
    jq -n --rawfile content content.b64 \
          --arg msg "更新备份: $BACKUP_FILE" \
          --arg sha "$EXISTING_SHA" \
          --arg branch "$GH_BACKUP_BRANCH" \
          '{message: $msg, content: $content, sha: $sha, branch: $branch}' > payload.json
else
    jq -n --rawfile content content.b64 \
          --arg msg "备份: $BACKUP_FILE ($BACKUP_SIZE)" \
          --arg branch "$GH_BACKUP_BRANCH" \
          '{message: $msg, content: $content, branch: $branch}' > payload.json
fi

RESPONSE=$(curl -s -X PUT \
    -H "Authorization: token $GH_TOKEN" \
    -H "Content-Type: application/json" \
    -d @payload.json \
    "$API_BASE/contents/$BACKUP_FILE")

rm -f payload.json content.b64

if echo "$RESPONSE" | jq -e '.content.sha' >/dev/null 2>&1; then
    echo "[SUCCESS] 备份文件已上传 ✓"
else
    echo "[ERROR] 上传失败: $(echo "$RESPONSE" | jq -r '.message // "未知错误"')"
    rm -f cookies.txt
    exit 1
fi

# ---------- 2. 更新 README.md ----------
echo "[INFO] 更新 README.md..."
README_SHA=$(curl -s \
    -H "Authorization: token $GH_TOKEN" \
    "$API_BASE/contents/README.md?ref=$GH_BACKUP_BRANCH" \
    | jq -r '.sha // empty')

README_TEXT="# 白虎面板备份

**最新备份:** \`$BACKUP_FILE\`  
**备份时间:** $(TZ='Asia/Shanghai' date '+%Y-%m-%d %H:%M:%S')  
**文件大小:** $BACKUP_SIZE  
"

README_B64=$(echo -n "$README_TEXT" | base64 -w 0 2>/dev/null \
    || echo -n "$README_TEXT" | base64)

if [ -n "$README_SHA" ]; then
    echo "{\"message\":\"更新README\",\"content\":\"$README_B64\",\"sha\":\"$README_SHA\",\"branch\":\"$GH_BACKUP_BRANCH\"}" > readme.json
else
    echo "{\"message\":\"创建README\",\"content\":\"$README_B64\",\"branch\":\"$GH_BACKUP_BRANCH\"}" > readme.json
fi

curl -s -X PUT \
    -H "Authorization: token $GH_TOKEN" \
    -H "Content-Type: application/json" \
    -d @readme.json \
    "$API_BASE/contents/README.md" > /dev/null

rm -f readme.json
echo "[SUCCESS] README.md 已更新 ✓"

# ---------- 3. 删除旧备份 ----------
echo "[INFO] 清理旧备份（保留 $KEEP 个）..."
OLD_BACKUPS=$(curl -s \
    -H "Authorization: token $GH_TOKEN" \
    "$API_BASE/contents?ref=$GH_BACKUP_BRANCH" \
    | jq -r '.[].name' \
    | grep '^backup_[0-9]\{8\}_[0-9]\{6\}\.zip$' \
    | sort -r \
    | tail -n +$((KEEP + 1)))

for old_file in $OLD_BACKUPS; do
    echo "[INFO] 删除: $old_file"
    OLD_SHA=$(curl -s \
        -H "Authorization: token $GH_TOKEN" \
        "$API_BASE/contents/$old_file?ref=$GH_BACKUP_BRANCH" \
        | jq -r '.sha')

    curl -s -X DELETE \
        -H "Authorization: token $GH_TOKEN" \
        -H "Content-Type: application/json" \
        -d "{\"message\":\"删除旧备份\",\"sha\":\"$OLD_SHA\",\"branch\":\"$GH_BACKUP_BRANCH\"}" \
        "$API_BASE/contents/$old_file" > /dev/null
done

# ---------- 4. 清理本地 ----------
rm -f cookies.txt "$BACKUP_PATH"
echo "[SUCCESS] 备份完成: $BACKUP_FILE 🎉"
BACKUP_SCRIPT_EOF

    chmod +x "$BACKUP_SCRIPT"
    log_ok "备份脚本已创建"

    # ---------- 通过 API 创建定时任务 ----------
    log_info "尝试通过面板 API 创建定时任务..."
    PANEL_URL="http://localhost:8100"

    if ! curl -s --connect-timeout 3 "$PANEL_URL" >/dev/null 2>&1; then
        log_warn "无法连接到面板 $PANEL_URL，可能未运行。"
        log_warn "请确保面板已启动后再运行本脚本的更新/安装功能，或手动创建任务。"
        log_info "将跳过任务创建，备份脚本已准备就绪。"
        return 0
    fi

    log_info "登录面板..."
    curl -s -c cookies.txt -o /dev/null \
        "$PANEL_URL/api/v1/auth/login" \
        -H 'content-type: application/json' \
        --data-raw "{\"username\":\"$ADMIN_USERNAME\",\"password\":\"$ADMIN_PASSWORD\"}"
    BHToken=$(grep 'BHToken' cookies.txt | awk '{print $NF}')
    rm -f cookies.txt
    if [ -z "$BHToken" ]; then
        log_err "未能获取 BHToken，请检查用户名密码"
        return 1
    fi

    # 构建环境变量字符串（每行一个 KEY=VALUE）
    ENVS=""
    [ -n "$ADMIN_USERNAME" ] && ENVS="${ENVS}ADMIN_USERNAME=${ADMIN_USERNAME}\n"
    [ -n "$ADMIN_PASSWORD" ] && ENVS="${ENVS}ADMIN_PASSWORD=${ADMIN_PASSWORD}\n"
    [ -n "$BACKUP_PASS" ] && ENVS="${ENVS}BACKUP_PASS=${BACKUP_PASS}\n"
    [ -n "$GH_BACKUP_BRANCH" ] && ENVS="${ENVS}GH_BACKUP_BRANCH=${GH_BACKUP_BRANCH}\n"
    [ -n "$GH_TOKEN" ] && ENVS="${ENVS}GH_TOKEN=${GH_TOKEN}\n"
    [ -n "$GH_BACKUP_REPO" ] && ENVS="${ENVS}GH_BACKUP_REPO=${GH_BACKUP_REPO}\n"
    ENVS=$(echo -e "$ENVS" | sed ':a;N;$!ba;s/\n$//')

    # 构建任务 JSON
    TASK_JSON=$(cat <<TASK_JSON_EOF
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
    "envs": "$ENVS",
    "trigger_type": "cron",
    "agent_id": null,
    "languages": [],
    "config": "{\\"\$task_concurrency\\":1,\\"\$task_all_envs\\":false}"
}
TASK_JSON_EOF
)

    # 创建任务
    CREATE_RESP=$(curl -s -X POST \
        "$PANEL_URL/api/v1/tasks" \
        -H "Content-Type: application/json" \
        -H "Cookie: BHToken=$BHToken" \
        -d "$TASK_JSON")

    if echo "$CREATE_RESP" | grep -q '"code":200'; then
        log_ok "定时备份任务已创建成功！"
        # 可选绑定通知（空绑定）
        TASK_ID=$(echo "$CREATE_RESP" | grep -o '"id":"[^"]*' | cut -d'"' -f4)
        if [ -n "$TASK_ID" ]; then
            curl -s -X POST "$PANEL_URL/api/v1/notify/bindings/batch" \
                -H "Content-Type: application/json" \
                -H "Cookie: BHToken=$BHToken" \
                -d "{\"type\":\"task\",\"data_id\":\"$TASK_ID\",\"bindings\":[]}" > /dev/null
        fi
    else
        log_err "创建任务失败，响应: $CREATE_RESP"
        log_warn "您可以稍后手动创建任务，备份脚本已放置在 $BACKUP_SCRIPT"
    fi

    echo ""
    log_ok "自动备份配置完成！"
    echo ""
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
    backup)
        setup_backup
        ;;
    menu|"")
        echo ""
        echo "=========================================="
        echo "  AlwaysData 白虎面板管理脚本"
        echo "=========================================="
        echo "  1) 全新安装"
        echo "  2) 更新面板（保留数据）"
        echo "  3) 配置自动备份（需面板已运行并修改密码）"
        read -p "请输入选项 [1]: " choice
        choice=${choice:-1}
        case "$choice" in
            1) do_install ;;
            2) do_update ;;
            3) setup_backup ;;
            *) log_err "无效选项" && exit 1 ;;
        esac
        ;;
    *)
        log_err "未知参数: $ACTION (可用: install / update / backup)"
        exit 1
        ;;
esac

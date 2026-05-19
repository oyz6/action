#!/bin/bash

# ============================================
# 哪吒探针 V1 - 完整安装 & 批量注册脚本
# 服务器数量造假（离线模式）
# 适用：面板 V1 + x86_64 系统
# ============================================

set -e

# ---------- 配置参数（可按需修改）----------
AGENT_VERSION="v1.7.2"
AGENT_ARCH="amd64"
AGENT_ZIP="nezha-agent_linux_${AGENT_ARCH}.zip"
DOWNLOAD_URL="https://github.com/nezhahq/agent/releases/download/${AGENT_VERSION}/${AGENT_ZIP}"

# 面板连接信息
CLIENT_SECRET="qLxxxxxxxxxxxxxxxxxxxxxxwsy"
SERVER="nazha.eu.org:443"
TLS="true"
# 固定配置项
DISABLE_AUTO_UPDATE="true"
DISABLE_COMMAND_EXECUTE="false"
DISABLE_FORCE_UPDATE="true"
DISABLE_NAT="false"
DISABLE_SEND_QUERY="false"
GPU="false"
INSECURE_TLS="false"
IP_REPORT_PERIOD="1800"
REPORT_DELAY="4"
SKIP_CONNECTION_COUNT="false"
SKIP_PROCS_COUNT="false"
TEMPERATURE="false"
USE_GITEE_TO_UPGRADE="false"
USE_IPV6_COUNTRY_CODE="false"
DEBUG="false"

# 批量注册参数
TOTAL_SERVERS=1080          # 要注册的假服务器总数（可改）
REGISTER_TIMEOUT=3         # 每个 Agent 的注册等待时间（秒）
INTERVAL=1                 # 间隔（秒）

# ---------- 准备工作 ----------
WORK_DIR="$(pwd)"          # 当前目录
AGENT_BIN="$WORK_DIR/npm"

# 如果 npm 已存在且文件大小不为 0，可选择跳过下载
if [ -s "$AGENT_BIN" ]; then
    echo "检测到已有 Agent 文件（非空），跳过下载。如需重新下载请手动删除: $AGENT_BIN"
else
    echo "开始下载哪吒 Agent $AGENT_VERSION ..."
    if command -v wget >/dev/null 2>&1; then
        wget -O "$WORK_DIR/$AGENT_ZIP" "$DOWNLOAD_URL"
    elif command -v curl >/dev/null 2>&1; then
        curl -L -o "$WORK_DIR/$AGENT_ZIP" "$DOWNLOAD_URL"
    else
        echo "错误：需要 wget 或 curl"
        exit 1
    fi

    # 解压
    echo "解压..."
    if ! command -v unzip >/dev/null 2>&1; then
        echo "错误：需要 unzip。请安装后再试。"
        exit 1
    fi
    unzip -o "$WORK_DIR/$AGENT_ZIP" -d "$WORK_DIR"

    # 重命名并赋权
    if [ -f "$WORK_DIR/nezha-agent" ]; then
        mv "$WORK_DIR/nezha-agent" "$AGENT_BIN"
        chmod +x "$AGENT_BIN"
        echo "Agent 已安装为: $AGENT_BIN"
    else
        echo "解压后未找到 nezha-agent，请检查压缩包内容。"
        ls -la "$WORK_DIR"
        exit 1
    fi

    # 清理压缩包
    rm -f "$WORK_DIR/$AGENT_ZIP"
fi

# ---------- 测试连接 ----------
echo ""
echo "========== 测试 Agent 是否能正常连接面板 =========="
TEST_UUID="test-connect-$(date +%s)"
TEST_CONF="$WORK_DIR/test_config.yaml"

cat > "$TEST_CONF" <<EOF
client_secret: ${CLIENT_SECRET}
debug: false
disable_auto_update: true
disable_command_execute: false
disable_force_update: true
disable_nat: false
disable_send_query: false
gpu: false
insecure_tls: false
ip_report_period: 1800
report_delay: 4
server: ${SERVER}
skip_connection_count: false
skip_procs_count: false
temperature: false
tls: ${TLS}
use_gitee_to_upgrade: false
use_ipv6_country_code: false
uuid: ${TEST_UUID}
EOF

echo "启动测试 Agent (前台运行 10 秒，请观察是否有连接成功信息)..."
timeout 10 "$AGENT_BIN" -c "$TEST_CONF" 2>&1 || true
echo "测试结束。如果上面没有明显的连接错误，说明 Agent 工作正常。"
rm -f "$TEST_CONF"

echo ""
echo "========== 开始批量注册 $TOTAL_SERVERS 台离线服务器 =========="
# 清理可能残留的旧进程
pkill -f "$AGENT_BIN -c" 2>/dev/null || true
sleep 1

success_count=0
for ((i=1; i<=TOTAL_SERVERS; i++)); do
    NEW_UUID=$(cat /proc/sys/kernel/random/uuid 2>/dev/null || uuidgen 2>/dev/null || echo "batch-$i-$(date +%s%N)")
    CONFIG_FILE="/tmp/nezha_batch_${i}_$$.yaml"

    cat > "$CONFIG_FILE" <<EOF
client_secret: ${CLIENT_SECRET}
debug: ${DEBUG}
disable_auto_update: ${DISABLE_AUTO_UPDATE}
disable_command_execute: ${DISABLE_COMMAND_EXECUTE}
disable_force_update: ${DISABLE_FORCE_UPDATE}
disable_nat: ${DISABLE_NAT}
disable_send_query: ${DISABLE_SEND_QUERY}
gpu: ${GPU}
insecure_tls: ${INSECURE_TLS}
ip_report_period: ${IP_REPORT_PERIOD}
report_delay: ${REPORT_DELAY}
server: ${SERVER}
skip_connection_count: ${SKIP_CONNECTION_COUNT}
skip_procs_count: ${SKIP_PROCS_COUNT}
temperature: ${TEMPERATURE}
tls: ${TLS}
use_gitee_to_upgrade: ${USE_GITEE_TO_UPGRADE}
use_ipv6_country_code: ${USE_IPV6_COUNTRY_CODE}
uuid: ${NEW_UUID}
EOF

    echo -n "[${i}/${TOTAL_SERVERS}] UUID: $NEW_UUID ... "
    # 运行 Agent，等待注册
    if timeout $REGISTER_TIMEOUT "$AGENT_BIN" -c "$CONFIG_FILE" >/dev/null 2>&1; then
        echo "OK"
        ((success_count++)) || true
    else
        echo "超时/退出 (可能也已注册)"
    fi

    rm -f "$CONFIG_FILE"
    sleep $INTERVAL
done

echo ""
echo "=========================================="
echo "批量注册完成。面板上应新增 $TOTAL_SERVERS 台服务器。"
echo "其中 $success_count 次明确成功，其余可能因超时但大概率已注册。"
echo "Agent 工作目录: $WORK_DIR"
echo "=========================================="

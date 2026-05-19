#!/bin/bash

AGENT_BIN="/ql/data/npm"
TOTAL=108000                       # 你要的总数
REGISTER_TIMEOUT=3              # 留给 Agent 注册的时间（秒），网络好可以调小
INTERVAL=1                       # 每个之间的间隔（秒）

CLIENT_SECRET="qL7Bdddddddddddddsy"
SERVER="nazha..eu.org:443"
TLS="true"
# 其他固定配置
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

# 确保之前残留进程都被清理（以防万一）
pkill -f "npm -c" 2>/dev/null
sleep 1

for ((i=1; i<=TOTAL; i++)); do
    NEW_UUID=$(cat /proc/sys/kernel/random/uuid 2>/dev/null || uuidgen 2>/dev/null || echo "offline-$i-$(date +%s%N)")
    CONFIG_FILE="/tmp/nezha_offline_${i}.yaml"

    # 生成临时配置
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

    echo "[${i}/${TOTAL}] 注册 UUID: $NEW_UUID"

    # 在前台运行 Agent，最多等待 REGISTER_TIMEOUT 秒，然后 timeout 会自动杀死它
    timeout $REGISTER_TIMEOUT "$AGENT_BIN" -c "$CONFIG_FILE" >/dev/null 2>&1

    # 删除临时配置
    rm -f "$CONFIG_FILE"

    # 间隔一会儿，避免被面板限流
    sleep $INTERVAL
done

echo "全部完成！面板上应该多了 $TOTAL 台离线服务器。"

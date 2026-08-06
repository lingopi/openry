#!/bin/bash
# ============================================================================
# 测试：每秒轮询 DB，精确捕获 checkZombies / openclaw --timeout 触发瞬间
# ============================================================================
#
# 方法：
#   1. shell kind: sleep 1200（确定性行为，不依赖 LLM）
#   2. 每秒读 task_state，状态变化时立即打印
#   3. T+570~T+660 区间密集打印全部细节
#
# ============================================================================

set -e

OPENRY_HOME="${OPENRY_HOME:-$HOME/.openry}"
DB="$OPENRY_HOME/openry.db"
LOG_DIR="$OPENRY_HOME/test_logs"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
LOG_FILE="$LOG_DIR/timeout_test_${TIMESTAMP}.log"

mkdir -p "$LOG_DIR"

echo "=== OpenRY Timeout Test ===" | tee "$LOG_FILE"
echo "Start: $(date)" | tee -a "$LOG_FILE"
echo "DB: $DB" | tee -a "$LOG_FILE"
echo "" | tee -a "$LOG_FILE"

# ── 1. 创建测试 workflow ──

WORKFLOW_FILE="$OPENRY_HOME/workflows/timeout_test.yaml"
COMPOSITION_FILE="$OPENRY_HOME/compositions/timeout_test.yaml"

cat > "$WORKFLOW_FILE" << 'YAML'
name: timeout_test
version: "1.0"
description: "测试 shell kind 超时行为 — checkZombies 是否触发"
timeout_minutes: 10
sub_steps:
  - id: sleep_only
    kind: shell
    command: "sleep 1200"
    timeout_seconds: 1500
    expect_payload: false
YAML

cat > "$COMPOSITION_FILE" << 'YAML'
composition: timeout_test
description: "Timeout DB status test"
big_steps:
  - ref: timeout_test
YAML

echo "[$(date +%H:%M:%S)] Workflow YAML created." | tee -a "$LOG_FILE"

# ── 2. 记录测试开始前的 task_state 快照 ──

echo "" | tee -a "$LOG_FILE"
echo "[$(date +%H:%M:%S)] Pre-test task_state snapshot:" | tee -a "$LOG_FILE"
sqlite3 -header "$DB" "SELECT run_id, status, updated_at FROM task_state WHERE workflow='timeout_test';" | tee -a "$LOG_FILE"

# ── 3. 直接写入 DB 触发 workflow（绕过已弃用的 Python orchestrator）──

echo "" | tee -a "$LOG_FILE"
echo "[$(date +%H:%M:%S)] Enqueuing workflow directly in DB (TS plugin patrol will pick it up)..." | tee -a "$LOG_FILE"

RUN_ID=$(python3 -c "import uuid; print(uuid.uuid4())")
echo "Generated run_id: $RUN_ID" | tee -a "$LOG_FILE"

# Insert workflow_instances row, then task_state row
sqlite3 "$DB" <<SQL
INSERT INTO workflow_instances (composition, status, current_big_step, created_at, updated_at)
VALUES ('timeout_test', 'running', 'timeout_test', datetime('now'), datetime('now'));

INSERT INTO task_state (run_id, workflow, step_id, big_step_ref, sub_step_id, status, payload,
                         workflow_instance_id, max_tool_calls, max_sub_step_retries,
                         created_at, updated_at)
VALUES ('$RUN_ID', 'timeout_test', 'sleep_only', 'timeout_test', 'sleep_only', 'queued', '{}',
        (SELECT last_insert_rowid() FROM workflow_instances), 3, 3,
        datetime('now'), datetime('now'));
SQL

echo "DB rows inserted. Patrol loop will dispatch on next cycle (~5s)." | tee -a "$LOG_FILE"

# ── 4. 监控循环：每秒轮询，状态变化时立即记录 ──

echo "" | tee -a "$LOG_FILE"
echo "=== 1-second monitoring (status-change + heartbeat) ===" | tee -a "$LOG_FILE"
echo "T+600s = checkZombies threshold (10 min)" | tee -a "$LOG_FILE"
echo "" | tee -a "$LOG_FILE"

PREV_STATUS=""
PREV_UPDATED=""
HEARTBEAT_COUNTER=0
MAX_SECONDS=1500  # 25 minutes max

for i in $(seq 0 $MAX_SECONDS); do
    ELAPSED=$i
    ELAPSED_FMT="${ELAPSED}s"
    
    # Query current state
    RESULT=$(sqlite3 "$DB" \
        "SELECT status, updated_at FROM task_state 
         WHERE run_id='$RUN_ID';" 2>/dev/null || echo "?|?")
    
    STATUS=$(echo "$RESULT" | cut -d'|' -f1)
    UPDATED=$(echo "$RESULT" | cut -d'|' -f2)
    
    # ── T+570~T+660 密集区：每秒打印全部细节 ──
    if [ $ELAPSED -ge 570 ] && [ $ELAPSED -le 660 ]; then
        printf "[T+%4s] %-14s  updated=%s  (CRITICAL ZONE)\n" \
            "$ELAPSED_FMT" "${STATUS:-?}" "${UPDATED:-?}" | tee -a "$LOG_FILE"
    # ── 状态变化时打印 ──
    elif [ "$STATUS" != "$PREV_STATUS" ] || [ "$UPDATED" != "$PREV_UPDATED" ]; then
        printf "[T+%4s] %-14s  updated=%s  ★ STATUS CHANGE\n" \
            "$ELAPSED_FMT" "${STATUS:-?}" "${UPDATED:-?}" | tee -a "$LOG_FILE"
        PREV_STATUS="$STATUS"
        PREV_UPDATED="$UPDATED"
    fi
    
    # ── 心跳：每 30 秒打印一次（确认脚本还活着）──
    HEARTBEAT_COUNTER=$((HEARTBEAT_COUNTER + 1))
    if [ $HEARTBEAT_COUNTER -ge 30 ]; then
        HEARTBEAT_COUNTER=0
        printf "[T+%4s] %-14s  (heartbeat)\n" "$ELAPSED_FMT" "${STATUS:-?}" | tee -a "$LOG_FILE"
    fi
    
    # ── 终止条件 ──
    if [ "$STATUS" = "dropped" ] || [ "$STATUS" = "done" ]; then
        echo "" | tee -a "$LOG_FILE"
        echo "[$(date +%H:%M:%S)] Terminal: $STATUS" | tee -a "$LOG_FILE"
        break
    fi
    
    # 如果从 queued 变回 in_progress（被重新 dispatch），也记录
    if [ "$PREV_STATUS" = "queued" ] && [ "$STATUS" = "in_progress" ]; then
        echo "  ▲ RE-DISPATCHED: queued → in_progress (checkZombies triggered!)" | tee -a "$LOG_FILE"
    fi
    
    sleep 1
done

# ── 5. 最终快照 ──

echo "" | tee -a "$LOG_FILE"
echo "=== Final DB Snapshot ===" | tee -a "$LOG_FILE"
sqlite3 -header "$DB" "SELECT * FROM task_state WHERE workflow='timeout_test';" | tee -a "$LOG_FILE"

echo "" | tee -a "$LOG_FILE"
echo "=== Workflow Instance State ===" | tee -a "$LOG_FILE"
sqlite3 -header "$DB" "SELECT * FROM workflow_instances WHERE composition='timeout_test' ORDER BY id DESC LIMIT 1;" | tee -a "$LOG_FILE"

echo "" | tee -a "$LOG_FILE"
echo "Test complete at $(date)" | tee -a "$LOG_FILE"
echo "Full log: $LOG_FILE"

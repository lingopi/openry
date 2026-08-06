#!/bin/bash
# 监控 workflow instance #13 的 DB 状态，每秒轮询
# 用法: bash monitor_wf13.sh

DB="$HOME/.openry/openry.db"
WF_ID=13
RUN_ID="8f1cfdb4-4387-4186-a597-58aeafdfe97b"

PREV_STATUS=""
PREV_UPDATED=""
START=$(date +%s)
HEARTBEAT=0

echo "Monitoring WF #13  run_id=$RUN_ID"
echo "Start: $(date)"
echo "T+600 = $(date -v+600S '+%H:%M:%S') (checkZombies 10min)"
echo "---"

while true; do
    ELAPSED=$(($(date +%s) - START))
    
    ROW=$(sqlite3 "$DB" "SELECT status, updated_at FROM task_state WHERE run_id='$RUN_ID';" 2>/dev/null)
    STATUS="${ROW%%|*}"
    UPDATED="${ROW#*|}"
    
    # 状态变化时打印
    if [ "$STATUS" != "$PREV_STATUS" ] || [ "$UPDATED" != "$PREV_UPDATED" ]; then
        printf "[T+%4ds] %-14s  updated=%s  ★\n" "$ELAPSED" "$STATUS" "$UPDATED"
        PREV_STATUS="$STATUS"
        PREV_UPDATED="$UPDATED"
    fi
    
    # 每 30 秒心跳
    HEARTBEAT=$((HEARTBEAT + 1))
    if [ $HEARTBEAT -ge 30 ]; then
        HEARTBEAT=0
        printf "[T+%4ds] %-14s  (heartbeat)\n" "$ELAPSED" "$STATUS"
    fi
    
    # 终止
    if [ "$STATUS" = "dropped" ] || [ "$STATUS" = "done" ]; then
        echo "=== Terminal: $STATUS at T+${ELAPSED}s ==="
        sqlite3 -header "$DB" "SELECT * FROM task_state WHERE run_id='$RUN_ID';"
        sqlite3 -header "$DB" "SELECT * FROM workflow_instances WHERE id=$WF_ID;"
        break
    fi
    
    sleep 1
done

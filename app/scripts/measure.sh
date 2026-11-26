#!/bin/bash
APP="$1"; OUT="$2"
MARKS="$OUT/marks.txt"; LOG="$OUT/mem.txt"
mkdir -p "$OUT"; : > "$MARKS"; : > "$LOG"
webkit_pids() { pgrep -f "com.apple.WebKit\." | sort; }
fp() { footprint "$1" 2>/dev/null | grep -o "Footprint: [0-9.]* [KMG]B" | awk '{v=$2; if($3=="KB")v/=1024; if($3=="GB")v*=1024; printf "%.0f", v}'; }
BEFORE=$(webkit_pids)
K_SHELL_STRESS=1 K_SHELL_MARKS="$MARKS" "$APP" >/dev/null 2>&1 &
APP_PID=$!
sleep 6
NEW=$(comm -13 <(echo "$BEFORE") <(webkit_pids))
echo "app=$APP_PID webkit=$(echo $NEW)" >> "$LOG"
while kill -0 $APP_PID 2>/dev/null; do
  a=$(fp $APP_PID); w=0; detail=""
  for p in $NEW; do v=$(fp $p); v=${v:-0}; w=$((w+v)); detail="$detail $p:$v"; done
  echo "$(date +%s) app=${a}MB webkit=${w}MB total=$((a+w))MB |$detail" >> "$LOG"
  grep -q " done" "$MARKS" && break
  sleep 5
done
kill $APP_PID 2>/dev/null
echo FINISHED >> "$LOG"

#!/data/data/com.termux/files/usr/bin/sh
# 一键启动本地服务器：sh serve.sh [端口]
cd "$(dirname "$0")" || exit 1
PORT="${1:-8080}"

# 先清掉旧实例：优先用 PID 文件，避免 pkill 误伤命令行里含同名关键字的进程
PIDFILE="$HOME/.pi-bridge.pid"
if [ -f "$PIDFILE" ]; then
  OLDPID="$(cat "$PIDFILE")"
  # 校验 cmdline 确实是本项目的桥接，防止误杀别的工作进程
  if [ -n "$OLDPID" ] && grep -qa "bridge.mjs" "/proc/$OLDPID/cmdline" 2>/dev/null; then
    kill "$OLDPID" 2>/dev/null
  fi
fi
pkill -f "http.server $PORT" 2>/dev/null
sleep 0.5

# 防止切到浏览器后 Android 冻结 Termux
termux-wake-lock 2>/dev/null

nohup node "$HOME/snake/bridge.mjs" "$PORT" > "$HOME/http.log" 2>&1 &
echo $! > "$PIDFILE"

# 自检（SDK 加载需要几秒，最多等 20 秒）
ok=""
for i in $(seq 1 20); do
  sleep 1
  if curl -s -o /dev/null "http://localhost:$PORT/chat-pi.html"; then ok=1; break; fi
done
if [ -n "$ok" ]; then
  echo "✅ pi-bridge 已启动 (端口 $PORT)"
  grep -o "✅.*\|模型:.*" "$HOME/http.log"
  echo "   浏览器打开 →  http://localhost:$PORT/chat-pi.html"
  echo "   停止       →  kill \$(cat ~/.pi-bridge.pid); termux-wake-unlock"
else
  echo "❌ 启动失败，日志如下："
  cat "$HOME/http.log"
fi

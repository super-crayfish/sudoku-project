#!/data/data/com.termux/files/usr/bin/sh
# 用法: sh use-model.sh [glm|astra|zenmux|gpt55|sonnet5] [端口]
DIR="$(cd "$(dirname "$0")" && pwd)"
PORT="${2:-8080}"
case "$1" in
  glm)     P=zai-coding-cn; M=glm-5.3-flash ;;
  astra|gpt) P=agentrouter; M=gpt-6-astra ;;
  zenmux)  P=zenmux; M=anthropic/claude-sonnet-5.5:google-vertex ;;
  gpt55)   P=vectorengine; M=gpt-5.5 ;;
  sonnet5) P=vectorengine; M=claude-sonnet-5 ;;
  *) echo "用法: sh use-model.sh [glm|astra|zenmux|gpt55|sonnet5] [端口]"; exit 1 ;;
esac
python3 - "$P" "$M" <<'PY'
import json, sys
prov, model = sys.argv[1], sys.argv[2]
p = "/data/data/com.termux/files/home/.pi/agent/settings.json"
try: cfg = json.load(open(p))
except Exception: cfg = {}
cfg["defaultProvider"] = prov
cfg["defaultModel"] = model
json.dump(cfg, open(p, "w"), indent=2, ensure_ascii=False)
print(f"✅ 已切换: {model} ({prov})")
PY
# 精准清理旧桥接（校验 cmdline，防止误杀）
for pid in $(pgrep -f "bridge[.]mjs"); do
  if grep -qa "bridge.mjs" "/proc/$pid/cmdline" 2>/dev/null; then kill "$pid" 2>/dev/null; fi
done
sleep 1
nohup node "$DIR/bridge.mjs" "$PORT" > "$HOME/http.log" 2>&1 &
sleep 6
curl -s --max-time 3 "http://localhost:$PORT/info" || echo "（启动中，稍候刷新）"

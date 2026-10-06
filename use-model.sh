#!/data/data/com.termux/files/usr/bin/sh
# 用法: sh use-model.sh glm | sh use-model.sh astra
case "$1" in
  glm|glm)
    cp ~/.pi/agent/settings.json.glm-backup ~/.pi/agent/settings.json
    echo "✅ 已切换: GLM-5.3-Flash (zai-coding-cn)" ;;
  astra|gpt)
    python3 - <<'PY'
import json
p = "/data/data/com.termux/files/home/.pi/agent/settings.json"
cfg = json.load(open(p))
cfg["defaultProvider"] = "agentrouter"
cfg["defaultModel"] = "gpt-6-astra"
json.dump(cfg, open(p, "w"), indent=2, ensure_ascii=False)
print("✅ 已切换: gpt-6-astra (agentrouter)")
PY
    ;;
  *)
    echo "用法: sh use-model.sh glm   # 切回 GLM"
    echo "      sh use-model.sh astra # 切到 gpt-6-astra"
    exit 1 ;;
esac
pkill -f "node .*bridge.mjs" 2>/dev/null
sleep 1
cd ~/snake && nohup node bridge.mjs 8080 > ~/http.log 2>&1 &
sleep 6
curl -s http://localhost:8080/info

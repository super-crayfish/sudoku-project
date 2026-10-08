#!/data/data/com.termux/files/usr/bin/sh
# 用法: sh use-model.sh glm | astra | zenmux
case "$1" in
  glm)
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
  gpt55)
    python3 - <<'PY'
import json
p = "/data/data/com.termux/files/home/.pi/agent/settings.json"
cfg = json.load(open(p))
cfg["defaultProvider"] = "vectorengine"
cfg["defaultModel"] = "gpt-5.5"
json.dump(cfg, open(p, "w"), indent=2, ensure_ascii=False)
print("✅ 已切换: gpt-5.5 (vectorengine)")
PY
    ;;
  sonnet5)
    python3 - <<'PY'
import json
p = "/data/data/com.termux/files/home/.pi/agent/settings.json"
cfg = json.load(open(p))
cfg["defaultProvider"] = "vectorengine"
cfg["defaultModel"] = "claude-sonnet-5"
json.dump(cfg, open(p, "w"), indent=2, ensure_ascii=False)
print("✅ 已切换: claude-sonnet-5 (vectorengine)")
PY
    ;;
  zenmux)
    python3 - <<'PY'
import json
p = "/data/data/com.termux/files/home/.pi/agent/settings.json"
cfg = json.load(open(p))
cfg["defaultProvider"] = "zenmux"
cfg["defaultModel"] = "anthropic/claude-sonnet-5.5:google-vertex"
json.dump(cfg, open(p, "w"), indent=2, ensure_ascii=False)
print("✅ 已切换: claude-sonnet-5.5 (zenmux)")
PY
    ;;
  *)
    echo "用法: sh use-model.sh glm|astra|zenmux|gpt55|sonnet5"
    exit 1 ;;
esac
pkill -f "node .*bridge[.]mjs" 2>/dev/null
sleep 1
cd ~/snake && nohup node bridge.mjs 8080 > ~/http.log 2>&1 &
sleep 6
curl -s http://localhost:8080/info

#!/data/data/com.termux/files/usr/bin/sh
# 用法: sh test-claude.sh <BASE_URL> <API_KEY> <MODEL>
# 鉴定一个"Claude"端点是真 Claude 还是贴牌假货
BASE="${1:?用法: sh test-claude.sh <BASE_URL> <KEY> <MODEL>}"
KEY="${2:?缺少 KEY}"
MODEL="${3:?缺少 MODEL}"
SCORE=0

ask() { # $1=内容 $2=max_tokens 输出原始JSON
  curl -sS --max-time 120 "$BASE/chat/completions" \
    -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
    -d "{\"model\":\"$MODEL\",\"max_tokens\":${2:-300},\"messages\":[{\"role\":\"user\",\"content\":$1}]}"
}

echo "=========== 1. API 结构指纹（最强信号，难伪造）==========="
RAW=$(ask '"Say ok"' 20)
ID=$(echo "$RAW" | python3 -c "import json,sys; print(json.load(sys.stdin).get('id','')[:12])" 2>/dev/null)
STOP=$(echo "$RAW" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['choices'][0].get('finish_reason',''))" 2>/dev/null)
echo "响应 ID 前缀: $ID   finish_reason: $STOP"
case "$ID" in
  msg_*) echo "→ msg_ 前缀 = Anthropic 原生格式 ✅"; SCORE=$((SCORE+3));;
  chatcmpl*) echo "→ chatcmpl 前缀 = OpenAI 中转格式（真Claude经OpenAI兼容层也常见，中性）"; SCORE=$((SCORE+1));;
  *) echo "→ 未知格式 ⚠️";;
esac

echo "=========== 2. 直接身份问答（弱信号，可被伪装）==========="
R=$(ask '"What model are you exactly? Who trained you? Answer in one sentence."' 150)
echo "$R" | python3 -c "import json,sys; print('自述:', json.load(sys.stdin)['choices'][0]['message']['content'][:150])" 2>/dev/null
echo "$R" | grep -qi "claude" && SCORE=$((SCORE+1)) && echo "→ 提到 Claude +1" || echo "→ 未自称 Claude"

echo "=========== 3. 知识截止探针 ==========="
R=$(ask '"你的训练数据截止到什么时间？之后发生的事你不知道。请直接说出截止年月。"' 100)
echo "$R" | python3 -c "import json,sys; print('自述截止:', json.load(sys.stdin)['choices'][0]['message']['content'][:120])" 2>/dev/null

echo "=========== 4. 风格一致性探针（无系统提示下） ==========="
R=$(ask '"Without any formatting, in one short paragraph: what makes you different from other AI assistants?"' 200)
echo "$R" | python3 -c "import json,sys; print('自述差异:', json.load(sys.stdin)['choices'][0]['message']['content'][:200])" 2>/dev/null

echo "=========== 5. Token 计费合理性 ==========="
R=$(ask '"Count from 1 to 50, numbers only."' 200)
USAGE=$(echo "$R" | python3 -c "import json,sys; d=json.load(sys.stdin); u=d.get('usage',{}); print(u.get('total_tokens','?'), u.get('prompt_tokens','?'), u.get('completion_tokens','?'))" 2>/dev/null)
echo "total/prompt/completion tokens: $USAGE（50个数字约需 50-80 completion tokens，明显偏离≈贴牌小模型）"

echo "=========== 综合得分: $SCORE / 6 ==========="
[ $SCORE -ge 4 ] && echo "判定: 🟢 大概率真 Claude"
[ $SCORE -ge 2 ] && [ $SCORE -lt 4 ] && echo "判定: 🟡 存疑（可能是经转的真Claude但被改写严重，或高级贴牌）"
[ $SCORE -lt 2 ] && echo "判定: 🔴 大概率假货/贴牌"
exit 0

# Pi 网页聊天桥（pi-web-bridge）

在手机浏览器里直接与 pi 编码代理对话——无需 API key，无需服务器中转，多轮上下文由 pi 原生管理。

## 架构

```
浏览器 chat-pi.html ──POST /chat (NDJSON流)──→ bridge.mjs (Node:8080)
                                                  │ createAgentSession()
                                                  ▼
                                          pi 会话（磁盘持久化 JSONL）
                                                  ▼
                                        你配置的模型供应商
```

## 文件

| 文件 | 说明 |
|---|---|
| `bridge.mjs` | 桥接服务器：静态页面 + 会话管理 + 流式转发 |
| `chat-pi.html` | 聊天前端：多会话、流式、思考过程显示、明暗主题 |
| `serve.sh` | 一键启动/重启（pidfile 管理 + wake-lock） |
| `use-model.sh` | 模型供应商一键切换 |
| `chat.html` | 早期版本：浏览器直连 Anthropic API（需自备 key） |

## 快速开始（Termux）

```bash
sh serve.sh              # 启动，浏览器打开 http://localhost:8080/chat-pi.html
sh use-model.sh glm      # 切回 GLM
sh use-model.sh astra    # 切到 gpt-6-astra (agentrouter)
pi update && sh serve.sh # 升级 pi（桥接自动追最新 SDK）
```

## 特性

- 会话持久化（pi 原生 JSONL 落盘，重启不丢）
- 多会话管理：新建/切换/删除/自动命名
- 流式输出 + 思考过程可视化
- 断连自动中止生成、keepalive 防粘死、402/404 自动恢复
- 明亮/深色主题切换

## 模型供应商配置

- 默认模型：`~/.pi/agent/settings.json` 的 `defaultProvider` / `defaultModel`
- 自定义供应商：`~/.pi/agent/models.json`（支持 OpenAI / Anthropic 格式、自定义 UA 头）

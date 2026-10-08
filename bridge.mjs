// pi-bridge: 浏览器 ↔ pi 桥接服务器（持久化多会话版）
// 会话以 pi 原生 JSONL 落盘（~/.pi/chat-sessions），重启/手机重启后历史不丢
// 用法: node bridge.mjs [端口]   默认 8080
import http from "http";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

// 自动解析最新版 pi 的 SDK（pi update 后无需改代码）
function latestSdkPath() {
  const rel = path.join(os.homedir(), ".pi", "agent", "install", "releases");
  const vers = fs.readdirSync(rel).filter(d => /^\d+\.\d+\.\d+/.test(d)).sort((a, b) => {
    const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
    for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
    return 0;
  });
  return "file://" + path.join(rel, vers.at(-1), "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js");
}
const SDK = latestSdkPath();
const { createAgentSession, SessionManager } = await import(SDK);
console.log("pi SDK:", SDK.split("/releases/")[1].split("/")[0]);
// 模型选择：改 ~/.pi/agent/settings.json 的 defaultProvider / defaultModel
// （当前: agentrouter / gpt-6-astra；GLM 备份在 settings.json.glm-backup）

const PORT = parseInt(process.argv[2]) || 8080;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CWD = ROOT;
const SESSION_DIR = path.join(os.homedir(), ".pi", "chat-sessions");
const META_FILE = path.join(ROOT, "sessions-meta.json");
const MAX_OPENED = 4; // 同时驻留内存的会话数

fs.mkdirSync(SESSION_DIR, { recursive: true });

let entries = [];      // 磁盘会话清单（SessionManager.list）
let opened = new Map();// id -> {id, session, path}（已展开进内存的）
let busy = false;
let defaultModel = "未知", defaultProvider = "";

let meta = {}; // id -> {name, updatedAt}
try { meta = JSON.parse(fs.readFileSync(META_FILE, "utf8")); } catch {}
const saveMeta = () => { try { fs.writeFileSync(META_FILE, JSON.stringify(meta)); } catch {} };


async function refreshEntries() {
  entries = await SessionManager.list(CWD, SESSION_DIR);
  // 清理孤儿 meta：既不在磁盘也不在内存的会话
  let changed = false;
  for (const id of Object.keys(meta)) {
    if (!entryOf(id) && !opened.has(id)) { delete meta[id]; changed = true; }
  }
  if (changed) saveMeta();
}
function entryOf(id) { return id ? entries.find(e => e.id === id) : undefined; }
function nameOf(id) {
  if (meta[id]?.name) return meta[id].name;
  const f = entryOf(id)?.firstMessage;
  return f ? f.slice(0, 24) : "新对话";
}
function updatedOf(id) { return meta[id]?.updatedAt || entryOf(id)?.modified || entryOf(id)?.mtime || 0; }

async function ensureOpened(id) {
  if (opened.has(id)) return opened.get(id);
  const e = entryOf(id);
  if (!e) return null;
  const { session } = await createAgentSession({
    sessionManager: SessionManager.open(e.path),
  });
  const rec = { id, session, path: e.path };
  opened.set(id, rec);
  if (opened.size > MAX_OPENED) {
    const firstKey = opened.keys().next().value;
    if (firstKey !== id) {
      try { await opened.get(firstKey).session.dispose(); } catch {}
      opened.delete(firstKey);
    }
  }
  console.log("展开会话:", id, `(内存中 ${opened.size})`);
  return rec;
}

let creating = null; // 并发创建合并
async function createSession() {
  if (creating) return creating;
  creating = (async () => {
    const { session } = await createAgentSession({
      sessionManager: SessionManager.create(CWD, SESSION_DIR),
    });
    const id = session.sessionId;
    if (defaultModel === "未知" && session.model) {
      defaultModel = session.model.name || session.model.id || "未知";
      defaultProvider = session.model.provider || "";
    }
    opened.set(id, { id, session, path: session.sessionFile });
    meta[id] = { name: "新对话", updatedAt: Date.now() };
    saveMeta();
    await refreshEntries();
    console.log("新会话:", id);
    return id;
  })();
  try { return await creating; } finally { creating = null; }
}

function extractText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content.filter(b => b.type === "text" && b.text).map(b => b.text).join("");
  return "";
}
function getHistory(rec) {
  try {
    return rec.session.messages
      .filter(m => m.role === "user" || m.role === "assistant")
      .map(m => ({ role: m.role, content: extractText(m.content) }))
      .filter(m => m.content);
  } catch { return []; }
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css", ".js": "text/javascript",
  ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml",
  ".ico": "image/x-icon", ".json": "application/json",
};
function serveStatic(req, res) {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p === "/") p = "/chat-pi.html";
  const file = path.normalize(path.join(ROOT, p));
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end("Not Found"); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache, no-store, must-revalidate" });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://localhost");
  const url = u.pathname;
  const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);

  if (req.method === "GET" && url === "/sessions") {
    await refreshEntries();
    const list = entries
      .map(e => ({ id: e.id, name: nameOf(e.id), updatedAt: updatedOf(e.id) }));
    // 刚创建还没落盘的会话（在内存里）也要列出，否则抽屉里看不见
    for (const [id] of opened) {
      if (!entryOf(id)) list.unshift({ id, name: nameOf(id), updatedAt: meta[id]?.updatedAt || Date.now() });
    }
    list.sort((a, b) => b.updatedAt - a.updatedAt);
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(list));
  }

  if (req.method === "POST" && url === "/sessions") {
    // 唯一会话且从未聊过 → 视为幽灵，清掉再建
    if (entries.length === 1 && nameOf(entries[0].id) === "新对话") {
      const ghost = entries[0];
      try { await ghost.session?.dispose?.(); } catch {}
      try { fs.unlinkSync(ghost.path); } catch {}
      delete meta[ghost.id]; saveMeta();
      if (opened.has(ghost.id)) opened.delete(ghost.id);
      await refreshEntries();
    }
    const id = await createSession();
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ id }));
  }

  if (req.method === "DELETE" && url === "/sessions") {
    const id = u.searchParams.get("id");
    const rec = opened.get(id);          // 内存里的（可能还没落盘）
    const e = entryOf(id);               // 磁盘上的
    if (!rec && !e) { res.writeHead(404); return res.end("no such session"); }
    if (rec) {
      try { await rec.session.dispose(); } catch {}
      opened.delete(id);
    }
    if (e) { try { fs.unlinkSync(e.path); } catch {} }
    delete meta[id]; saveMeta();
    await refreshEntries();
    log("删除会话:", id, rec ? "(内存)" : "(磁盘)");
    res.writeHead(200); return res.end("ok");
  }

  if (req.method === "GET" && url === "/history") {
    const id = u.searchParams.get("id");
    // 刚创建的会话还没落盘（无文件），但已在内存 → 直接返回空历史，不能 404
    const rec = opened.get(id) || (entryOf(id) ? await ensureOpened(id) : null);
    if (!rec) { res.writeHead(404); return res.end("no such session"); }
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(getHistory(rec)));
  }

  if (req.method === "POST" && url === "/chat") {
    let body = "";
    for await (const c of req) {
      body += c;
      if (body.length > 20971520) { res.writeHead(413); return res.end("请求体过大（上限20MB）"); }
    }
    let msg;
    try { msg = JSON.parse(body || "{}"); } catch { msg = {}; }
    const message = (msg.message || "").trim();
    if (!message) { res.writeHead(400); return res.end("empty message"); }
    if (busy) { res.writeHead(429); return res.end("上一条还在生成中，稍等"); }
    const rec = await ensureOpened(msg.id);
    if (!rec) { res.writeHead(404); return res.end("会话不存在（桥接可能已重启），请新建对话"); }

    busy = true;
    meta[rec.id] = meta[rec.id] || {};
    if (!meta[rec.id].name || meta[rec.id].name === "新对话") meta[rec.id].name = message.slice(0, 24);
    meta[rec.id].updatedAt = Date.now();
    saveMeta();

    res.writeHead(200, {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    });
    const send = (obj) => { try { res.write(JSON.stringify(obj) + "\n"); } catch {} };
    let done = false;
    res.on("close", () => {
      if (!done) { log("客户端断开 → 中止生成"); try { rec.session.abort(); } catch {} }
    });
    const watchdog = setTimeout(() => {
      if (!done) { log("生成超时(5分钟) → 中止"); try { rec.session.abort(); } catch {} }
    }, 300000);
    const unsub = rec.session.subscribe((e) => {
      const t = e.assistantMessageEvent?.type;
      if (e.type === "message_update" && t === "text_delta") {
        send({ t: "text", d: e.assistantMessageEvent.delta });
      } else if (e.type === "message_update" && t === "thinking_delta") {
        send({ t: "think", d: e.assistantMessageEvent.delta });
      }
    });
    // 图片附件（最多3张，单张≤4MB base64）
    let images;
    if (Array.isArray(msg.images)) {
      images = msg.images.slice(0, 3)
        .filter(im => im && im.data)
        .map(im => ({
          type: "image",
          data: String(im.data),
          mimeType: im.mediaType || "image/png",
        }));
    }
    log("POST /chat", rec.id, `"${message.slice(0, 20)}"${images?.length ? ` +${images.length}图` : ""}`);
    try {
      await rec.session.prompt(message, images?.length ? { images } : undefined);
    } catch (err) {
      send({ t: "error", d: err?.message || String(err) });
    }
    unsub();
    clearTimeout(watchdog);
    done = true;
    busy = false;
    meta[rec.id].updatedAt = Date.now();
    saveMeta();
    log("POST /chat done");
    return res.end();
  }

  if (req.method === "POST" && url === "/abort") {
    if (busy) for (const r of opened.values()) { try { r.session.abort(); } catch {} }
    res.writeHead(200); return res.end("ok");
  }

  if (req.method === "GET" && url === "/info") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ model: defaultModel, provider: defaultProvider, sessions: entries.length, busy }));
  }

  serveStatic(req, res);
});

/* ---- 启动 ---- */
await refreshEntries();
if (entries.length === 0) {
  await createSession();
} else {
  const first = entries.slice().sort((a, b) => updatedOf(b.id) - updatedOf(a.id))[0];
  const rec = await ensureOpened(first.id).catch(() => null);
  if (rec?.session?.model) {
    defaultModel = rec.session.model.name || rec.session.model.id || "未知";
    defaultProvider = rec.session.model.provider || "";
  }
}
server.keepAliveTimeout = 120000;
server.headersTimeout = 125000;
server.requestTimeout = 0;
server.listen(PORT, "127.0.0.1", () => {
  console.log(`✅ pi-bridge 就绪: http://localhost:${PORT}/chat-pi.html`);
  console.log(`   磁盘会话: ${entries.length} 个 (${SESSION_DIR})`);
});

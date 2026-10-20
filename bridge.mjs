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
const { createAgentSession, SessionManager, ModelRuntime } = await import(SDK);
const modelRuntime = await ModelRuntime.create().catch(() => null); // 仅用于 setModel 即时切换
console.log("pi SDK:", SDK.split("/releases/")[1].split("/")[0]);
// 模型选择：改 ~/.pi/agent/settings.json 的 defaultProvider / defaultModel
// （当前: agentrouter / gpt-6-astra；GLM 备份在 settings.json.glm-backup）

const PORT = parseInt(process.argv[2]) || 8080;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CWD = ROOT;
const SESSION_DIR = path.join(os.homedir(), ".pi", "chat-sessions");
const META_FILE = path.join(ROOT, "sessions-meta.json");
const SETTINGS_FILE = path.join(os.homedir(), ".pi", "agent", "settings.json");
const MODELS_FILE = path.join(os.homedir(), ".pi", "agent", "models.json");
const MAX_OPENED = 6; // 同时驻留内存的会话数

fs.mkdirSync(SESSION_DIR, { recursive: true });

let entries = [];      // 磁盘会话清单（SessionManager.list）
let opened = new Map();// id -> {id, session, path}（已展开进内存的）
let busy = false;
let busyId = null;
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
  let session;
  try {
    ({ session } = await createAgentSession({
      sessionManager: SessionManager.open(e.path),
    }));
  } catch (err) {
    console.log("会话文件损坏，跳过:", id, err?.message);
    return null;
  }
  const rec = { id, session, path: e.path, lastUsed: Date.now() };
  opened.set(id, rec);
  rec.lastUsed = Date.now();
  if (opened.size > MAX_OPENED) {
    let victim = null;
    for (const [k, r] of opened) {
      if (k === id || k === busyId || k === spareRec) continue; // 不淘汰当前/生成中/备用会话
      if (!victim || r.lastUsed < victim.lastUsed) victim = { k, r };
    }
    if (victim) {
      try { await victim.r.session.dispose(); } catch {}
      opened.delete(victim.k);
      console.log("LRU 淘汰会话:", victim.k);
    }
  }
  console.log("展开会话:", id, `(内存中 ${opened.size})`);
  return rec;
}

let creating = null; // 并发创建合并
function newSessionRec() {
  if (creating) return creating;
  const p = (async () => {
    const { session } = await createAgentSession({
      sessionManager: SessionManager.create(CWD, SESSION_DIR),
    });
    const id = session.sessionId;
    if (defaultModel === "未知" && session.model) {
      defaultModel = session.model.name || session.model.id || "未知";
      defaultProvider = session.model.provider || "";
    }
    opened.set(id, { id, session, path: session.sessionFile, lastUsed: Date.now() });
    meta[id] = { name: "新对话", updatedAt: Date.now() };
    saveMeta();
    await refreshEntries();
    console.log("新会话:", id);
    return id;
  })();
  const done = () => { if (creating === p) creating = null; };
  p.then(done, done);
  return p;
}

let spareRec = null, sparePromise = null;
function prewarm() {
  if (spareRec || sparePromise) return;
  sparePromise = newSessionRec()
    .then(rec => { spareRec = rec; sparePromise = null; })
    .catch(() => { sparePromise = null; });
}
async function createSession() {
  if (!spareRec) prewarm();
  if (sparePromise) await sparePromise;
  const rec = spareRec;
  if (!rec) return await newSessionRec(); // 兜底
  spareRec = null;
  prewarm(); // 立刻补充下一个备用
  return rec;
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
const STATIC_ALLOWED = new Set(["/chat-pi.html", "/chat-direct.html", "/chat.html", "/sudoku.html"]);
function serveStatic(req, res) {
  let p;
  try { p = decodeURIComponent(req.url.split("?")[0]); } catch { res.writeHead(400); return res.end("bad request"); }
  if (p === "/") p = "/chat-pi.html";
  // 白名单：只放行已知页面，杜绝 sessions-meta.json / .git / 任意文件读取
  if (!STATIC_ALLOWED.has(p)) { res.writeHead(404); return res.end("Not Found"); }
  const file = path.join(ROOT, p);
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end("Not Found"); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache, no-store, must-revalidate" });
    res.end(data);
  });
}

async function route(req, res) {
  // CORS: allow browser fetch from localhost (chat-pi.html) + OPTIONS preflight
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.writeHead(200);
    return res.end();
  }
  const u = new URL(req.url, "http://localhost");
  const url = u.pathname;
  const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);

  // 安全：仅接受来自本机页面的请求，阻止跨站请求伪造(CSRF)与 DNS rebinding
  const host = (req.headers.host || "").replace(/:\d+$/, "");
  if (host && host !== "127.0.0.1" && host !== "localhost" && host !== "[::1]" && host !== "::1") {
    res.writeHead(403); return res.end("forbidden host");
  }
  const origin = req.headers.origin;
  let originLocal = false;
  if (origin) {
    try {
      const o = new URL(origin);
      originLocal = o.hostname === "127.0.0.1" || o.hostname === "localhost" || o.hostname === "::1" || o.hostname === "[::1]";
    } catch {}
    if (!originLocal && /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(origin)) originLocal = true;
    if (!originLocal) { res.writeHead(403); return res.end("forbidden origin"); }
    res.setHeader("Access-Control-Allow-Origin", origin);
  }

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
    if (entries.length === 1 && nameOf(entries[0].id) === "新对话" && entries[0].id !== busyId && entries[0].id !== spareRec) {
      const ghost = entries[0];
      try { await opened.get(ghost.id)?.session.dispose(); } catch {}
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
    if (id === busyId) { res.writeHead(409); return res.end("该会话正在生成中，请先停止"); }
    if (id === spareRec) spareRec = null;
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
    req.setEncoding("utf8");
    for await (const c of req) {
      body += c;
      if (body.length > 10485760) { 
        req.socket.destroy(); 
        res.writeHead(413); 
        return res.end("请求体过大（上限10MB）"); 
      }
    }
    let msg;
    try { msg = JSON.parse(body || "{}"); } catch { msg = {}; }
    const message = (msg.message || "").trim();
    // 图片附件（最多3张，单张≤4MB base64）—— 必须在 writeHead 之前校验，
    // 否则响应头已发送，无法再返回 400，且 busy 标志会残留导致永久 429
    let images;
    if (Array.isArray(msg.images) && msg.images.length) {
      const OK_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
      images = msg.images.slice(0, 3)
        .filter(im => im && im.data && OK_TYPES.has(im.mediaType) && im.data.length <= 5600000)
        .map(im => ({ type: "image", data: String(im.data), mimeType: im.mediaType }));
      if (!images.length) { res.writeHead(400); return res.end("图片无效（仅支持 png/jpeg/webp/gif，单张≤4MB）"); }
    }
    if (!message && !images) { res.writeHead(400); return res.end("empty message"); }
    if (busy) { res.writeHead(429); return res.end("上一条还在生成中，稍等"); }
    busy = true; // 先占位，避免 await 期间并发请求同时通过检查
    let rec;
    try { rec = await ensureOpened(msg.id); } catch { rec = null; }
    if (!rec) { busy = false; res.writeHead(404); return res.end("会话不存在（桥接可能已重启），请新建对话"); }
    if (rec.id === spareRec) spareRec = null; // 备用会话被使用则不再作为备用
    busyId = rec.id;
    rec.lastUsed = Date.now();
    meta[rec.id] = meta[rec.id] || {};
    if (!meta[rec.id].name || meta[rec.id].name === "新对话") meta[rec.id].name = (message || "[图片]").slice(0, 24);
    meta[rec.id].updatedAt = Date.now();
    saveMeta();

    res.writeHead(200, {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    });
    const send = (obj) => { try { res.write(JSON.stringify(obj) + "\n"); } catch {} };
    let done = false, stopped = false;
    rec.stopFlag = () => { stopped = true; };
    res.on("close", () => {
      if (!done) { stopped = true; log("客户端断开 → 中止生成"); try { rec.session.abort(); } catch {} }
    });
    const watchdog = setTimeout(() => {
      if (!done) { 
        stopped = true;
        log("生成超时(8分钟) → 中止");
        try { rec.session.abort(); } catch {}
      }
    }, 480000);
    const unsub = rec.session.subscribe((e) => {
      const t = e.assistantMessageEvent?.type;
      if (e.type === "message_update" && t === "text_delta") {
        send({ t: "text", d: e.assistantMessageEvent.delta });
      } else if (e.type === "message_update" && t === "thinking_delta") {
        send({ t: "think", d: e.assistantMessageEvent.delta });
      }
    });
    log("POST /chat", rec.id, `len=${message.length}${images?.length ? " +" + images.length + "图" : ""}`);
    const promptOpts = images?.length ? { images } : undefined;
    const TRANSIENT = /terminated|fetch failed|ECONNRESET|socket hang up|ETIMEDOUT|network/i;
    // 瞬态网络错误自动重试一次（免费渠道上游经常中途断连）
    for (let attemptNo = 1; attemptNo <= 2; attemptNo++) {
      let errMsg = null;
      try {
        await rec.session.prompt(message, promptOpts);
        const msgs = rec.session.messages;
        const lastA = msgs.length ? msgs[msgs.length - 1] : null;
        if (lastA && lastA.role === "assistant" && (lastA.stopReason === "error" || lastA.errorMessage)) {
          let em = String(lastA.errorMessage || "生成失败");
          const qm = em.match(/request id[^)]*\)/);
          if (qm) em = em.replace(qm[0], "").trim();
          errMsg = em;
        }
      } catch (err) {
        errMsg = err?.message || String(err);
      }
      if (!errMsg || stopped) break; // 用户停止/断开/超时不重试
      if (attemptNo === 2 || !TRANSIENT.test(errMsg)) {
        send({ t: "error", d: errMsg });
        break;
      }
      send({ t: "think", d: "⚠ 上游连接中断，自动重试中…\n" });
      log("瞬态错误，2秒后重试:", errMsg.slice(0, 60));
      await new Promise(r => setTimeout(r, 2000));
    }
    unsub();
    clearTimeout(watchdog);
    rec.stopFlag = null;
    done = true;
    busy = false;
    busyId = null;
    meta[rec.id].updatedAt = Date.now();
    saveMeta();
    log("POST /chat done");
    return res.end();
  }

  if (req.method === "POST" && url === "/abort") {
    let body = "";
    req.setEncoding("utf8");
    for await (const c of req) { body += c; if (body.length > 4096) { req.socket.destroy(); return; } }
    let aid = null;
    try { aid = JSON.parse(body || "{}").id; } catch {}
    if (!(aid && opened.has(aid))) aid = busyId; // 未指定时中止正在生成的会话
    const ar = aid && opened.get(aid);
    if (ar) { ar.stopFlag?.(); try { await ar.session.abort(); } catch {} }
    res.writeHead(200); return res.end("ok");
  }

  if (req.method === "GET" && url === "/models") {
    let list = [];
    try {
      const cfg = JSON.parse(fs.readFileSync(MODELS_FILE, "utf8"));
      for (const [prov, pc] of Object.entries(cfg.providers || {}))
        for (const m of pc.models || [])
          list.push({ provider: prov, model: m.id, name: (m.name || m.id) + " · " + prov });
    } catch {}
    let cur = { provider: "", model: "" };
    try {
      const st = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
      cur = { provider: st.defaultProvider || "", model: st.defaultModel || "" };
    } catch {}
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ list, current: cur }));
  }

  if (req.method === "POST" && url === "/model") {
    let body = "";
    req.setEncoding("utf8");
    for await (const c of req) { 
      body += c; 
      if (body.length > 4096) { 
        req.socket.destroy(); 
        res.writeHead(413); 
        return res.end(); 
      } 
    }
    let sel; try { sel = JSON.parse(body || "{}"); } catch { sel = {}; }
    const prov = sel.provider, mid = sel.model;
    let providers = {};
    try { providers = JSON.parse(fs.readFileSync(MODELS_FILE, "utf8")).providers || {}; } catch {}
    const valid = prov && mid && providers[prov] && (providers[prov].models || []).some(m => m.id === mid);
    if (!valid) { res.writeHead(400); return res.end("未知模型"); }
    let st = {};
    try { st = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")); } catch {}
    st.defaultProvider = prov; st.defaultModel = mid;
    try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(st, null, 2)); }
    catch (e) { res.writeHead(500); return res.end("写入 settings.json 失败"); }
    // 已打开的会话尝试即时切换
    let live = false;
    if (sel.id && opened.has(sel.id) && modelRuntime) {
      try {
        const mo = modelRuntime.getModel(prov, mid);
        if (mo) { await opened.get(sel.id).session.setModel(mo); live = true; }
      } catch (e) { log("setModel 失败(新会话生效):", e?.message); }
    }
    log("切换模型:", prov + "/" + mid, live ? "(即时)" : "(新会话生效)");
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, live }));
  }

  if (req.method === "GET" && url === "/info") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ model: defaultModel, provider: defaultProvider, sessions: entries.length, busy }));
  }

  serveStatic(req, res);
}

const server = http.createServer((req, res) => {
  route(req, res).catch((e) => {
    console.log(new Date().toLocaleTimeString(), "Handler 异常:", e?.message || e);
    try { res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" }); res.end("服务器内部错误"); } catch {}
  });
});

process.on("unhandledRejection", (e) => console.log("[unhandledRejection]", e?.message || e));
process.on("uncaughtException", (e) => console.log("[uncaughtException]", e?.message || e));

/* ---- 启动 ---- */
await refreshEntries();
if (entries.length === 0) {
  await newSessionRec();
} else {
  const first = entries.slice().sort((a, b) => updatedOf(b.id) - updatedOf(a.id))[0];
  const rec = await ensureOpened(first.id).catch(() => null);
  if (rec?.session?.model) {
    defaultModel = rec.session.model.name || rec.session.model.id || "未知";
    defaultProvider = rec.session.model.provider || "";
  }
}
setTimeout(prewarm, 1000); // 延迟预热避免启动阻塞
server.keepAliveTimeout = 120000;
server.headersTimeout = 125000;
server.requestTimeout = 0;
server.listen(PORT, "127.0.0.1", () => {
  console.log(`✅ pi-bridge 就绪: http://localhost:${PORT}/chat-pi.html`);
  console.log(`   磁盘会话: ${entries.length} 个 (${SESSION_DIR})`);
});

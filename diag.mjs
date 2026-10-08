import { createAgentSession, SessionManager } from "file:///data/data/com.termux/files/home/.pi/agent/install/releases/0.87.0/node_modules/@earendil-works/pi-coding-agent/dist/index.js";

const { session } = await createAgentSession({ sessionManager: SessionManager.inMemory() });
console.log("模型:", session.model?.id, "| provider:", session.model?.provider);

session.subscribe((e) => {
  const t = e.type;
  const sub = e.assistantMessageEvent?.type;
  console.log("EVENT:", t, sub || "", JSON.stringify(e).slice(0, 200));
});

console.log("--- prompt 1 ---");
await session.prompt("1+1等于几");
console.log("--- prompt 1 完成 ---");
console.log("--- prompt 2 ---");
await session.prompt("再加1呢");
console.log("--- prompt 2 完成 ---");
process.exit(0);

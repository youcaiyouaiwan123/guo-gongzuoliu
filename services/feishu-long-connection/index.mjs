import * as lark from "@larksuiteoapi/node-sdk";

const required = ["FEISHU_APP_ID", "FEISHU_APP_SECRET", "HAIXIN_RELAY_URL", "HAIXIN_GATEWAY_SECRET"];
for (const key of required) if (!process.env[key]) throw new Error(`Missing environment variable: ${key}`);

const client = new lark.Client({
  appId: process.env.FEISHU_APP_ID,
  appSecret: process.env.FEISHU_APP_SECRET,
  appType: lark.AppType.SelfBuild,
});

async function relay(event) {
  if (event.message?.message_type !== "text") return;
  const text = String(JSON.parse(event.message.content || "{}").text || "").trim();
  if (!text) return;
  const response = await fetch(process.env.HAIXIN_RELAY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.HAIXIN_GATEWAY_SECRET}` },
    body: JSON.stringify({
      eventId: event.message.message_id,
      platformUserId: event.sender?.sender_id?.open_id || "",
      text,
    }),
  });
  const result = await response.json().catch(() => ({}));
  const reply = response.ok ? result.reply : `海芯博创平台处理失败：${result.message || response.status}`;
  await client.im.message.reply({
    path: { message_id: event.message.message_id },
    data: { msg_type: "text", content: JSON.stringify({ text: reply }) },
  });
}

const dispatcher = new lark.EventDispatcher({}).register({
  "im.message.receive_v1": async (data) => {
    try { await relay(data); } catch (error) { console.error("Message handling failed", error); }
  },
});
const wsClient = new lark.WSClient({
  appId: process.env.FEISHU_APP_ID,
  appSecret: process.env.FEISHU_APP_SECRET,
  loggerLevel: lark.LoggerLevel.info,
});
console.log("Starting Haixin Feishu long-connection service...");
await wsClient.start({ eventDispatcher: dispatcher });

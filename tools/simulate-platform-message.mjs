const accountsResponse = await fetch("http://app:3000/api/gateway/accounts", {
  headers: { Authorization: `Bearer ${process.env.HAIXIN_GATEWAY_ADMIN_SECRET}` },
});
const accountsPayload = await accountsResponse.json();
const account = accountsPayload.accounts?.[0];

console.log(JSON.stringify({
  accountsStatus: accountsResponse.status,
  hasAccount: Boolean(account),
  id: account?.id,
  platform: account?.platform,
  model: process.env.MODEL_NAME,
  base: process.env.MODEL_BASE_URL,
}, null, 2));

if (!account) process.exit(2);

const relayResponse = await fetch(account.relayUrl, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    Authorization: `Bearer ${account.relaySecret}`,
  },
  body: JSON.stringify({
    eventId: `sim-${Date.now()}`,
    platformUserId: "open_id_test",
    text: "你好，请用中文回复一句话",
  }),
});

const relayText = await relayResponse.text();
console.log("relayStatus", relayResponse.status);
console.log(relayText.slice(0, 1200));

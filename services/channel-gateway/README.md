# 海芯博创三平台常驻通道网关

这个服务承担网页后台无法承担的“持续在线”工作，机制与 OpenClaw Gateway 相同：常驻进程维护平台连接，收到消息后转发给海芯博创后台调用模型，再把结果送回原平台。

支持：

- 飞书：官方 WebSocket SDK
- 钉钉：官方 Stream 模式
- 企业微信：官方 AI 机器人 WebSocket SDK
- 一个进程运行多个机器人账户
- 自动心跳、SDK 断线重连、消息去重、真实在线状态和错误上报
- `/healthz` 与 `/status` 运行状态接口

## 使用

1. 在企业 AI 控制台的“平台接入”中保存对应平台凭证，并选择“长连接”。
2. 复制页面生成的“网关账户配置”。
3. 复制 `.env.example` 为 `.env`，把一个或多个账户配置放进 `HAIXIN_ACCOUNTS_JSON` 数组。
4. 运行 `docker compose up -d --build`，或执行 `npm install && npm start`。
5. 回到控制台。只有 SDK 完成真实鉴权且心跳持续到达，页面才显示“网关在线”。

## 平台侧设置

- 飞书：创建企业自建应用，启用机器人，事件订阅选择“使用长连接接收事件”，订阅 `im.message.receive_v1`。
- 钉钉：创建企业内部应用，添加机器人，消息接收模式选择 Stream，凭证使用 Client ID 与 Client Secret。
- 企业微信：创建“智能机器人”，API 模式选择 WebSocket 长连接，凭证使用 Bot ID 与 Secret。同一个 Bot ID 不要同时运行两个网关实例。

网页部署与通道网关是两项服务。网页可部署在 Sites；通道网关必须部署在不会休眠、允许主动连接三方 WebSocket 的服务器或容器平台。

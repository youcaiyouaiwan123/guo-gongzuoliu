# 海芯博创企业 AI 平台：独立服务器部署

本项目按 Linux + Docker Compose 方式部署。部署脚本会保留共享配置和数据，并把每次代码发布放进独立版本目录，方便回滚。

## 一键安装

把完整源码包上传到服务器后执行：

```bash
bash deploy/server-install.sh /path/to/haixin-ai-source.tar.gz
```

脚本会自动完成：

- 解压当前版本到 `/opt/haixin-ai/releases/<版本号>`；
- 创建并长期保留 `/opt/haixin-ai/shared/.env`；
- 首次创建管理员 Basic Auth 账户（默认用户名 `admin`，默认密码 `admin`，首次登录后请修改）；
- 创建 Docker 数据卷并构建前端、后端、模型中转和通道网关；
- 将 `/opt/haixin-ai/current` 指向刚发布的版本；
- 输出当前容器状态和访问地址。

## 重要配置

首次部署后编辑 `/opt/haixin-ai/shared/.env`，至少保留：

```dotenv
PLATFORM_CREDENTIALS_KEY=请替换为32字节以上的随机密钥
HAIXIN_GATEWAY_ADMIN_SECRET=请替换为网关管理密钥
MODEL_API_KEY=可选的默认模型密钥
MODEL_BASE_URL=https://claudecc.top
MODEL_NAME=gpt-5.5
```

平台接入页面保存的模型和飞书、钉钉、企业微信凭证会写入应用数据；通道网关账户配置由平台页面生成，不要手工改动已保存的账户 ID。服务器地址变化时，页面生成的回调地址会随当前访问地址变化。

## 手动启动和检查

```bash
cd /opt/haixin-ai/current
docker compose --env-file /opt/haixin-ai/shared/.env -f docker-compose.server.yml up -d --build
docker compose --env-file /opt/haixin-ai/shared/.env -f docker-compose.server.yml ps
docker compose --env-file /opt/haixin-ai/shared/.env -f docker-compose.server.yml logs --tail=100 app
docker compose --env-file /opt/haixin-ai/shared/.env -f docker-compose.server.yml logs --tail=100 channel-gateway
```

网页默认通过服务器 80 端口访问；通道网关监听 8788 端口。生产环境建议在云防火墙中只开放 80/443，8788 仅允许内部或受信来源访问。

## 更新代码

上传新的完整源码包后再次执行一键安装命令。脚本会保留共享 `.env`、管理员密码文件和 Docker 数据卷，不会覆盖已保存的模型、平台凭证及业务数据。

## 回滚

```bash
ls -1 /opt/haixin-ai/releases
ln -sfn /opt/haixin-ai/releases/<目标版本> /opt/haixin-ai/current
cd /opt/haixin-ai/current
docker compose --env-file /opt/haixin-ai/shared/.env -f docker-compose.server.yml up -d --build
```

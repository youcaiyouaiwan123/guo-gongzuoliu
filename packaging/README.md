# 海芯 AI 平台 — 离线安装包（Windows / macOS）

把整套平台打成**完全离线**、**双击安装**、**开机自启**、**抗崩溃/抗内存溢出**的原生安装包。
目标机无需预装 Node / Docker / python / nginx——所有运行时都在包内。

- Windows：`HaixinAI-<版本>-win-x64-Setup.exe`（NSIS + nssm 注册 Windows 服务）
- macOS：`HaixinAI-<版本>-mac-arm64.pkg` / `-mac-x64.pkg`（.pkg + LaunchDaemon）

---

## 运行时拓扑（安装后）

守护进程 `supervisor.mjs` 是系统服务的唯一入口，按序拉起并看护四个进程：

| 服务 | 作用 | 监听 | 内存上限 |
|---|---|---|---|
| model-relay | 模型中转（纯 Node） | 127.0.0.1:8789 | Node 堆 256MB |
| app | `wrangler dev --local` 跑 `dist/server/index.js`（workerd+miniflare，D1/R2） | 127.0.0.1:3000 | 整树 RSS 1536MB（可调） |
| channel-gateway | 飞书/企微/钉钉通道 | 127.0.0.1:8788 | Node 堆 384MB |
| proxy | 反代（替代 nginx），对外唯一入口 | 0.0.0.0:80 | Node 堆 128MB |

抗崩溃：子进程崩溃 → 守护指数退避重启（1→30s，稳定 60s 复位，频繁则降级 30s）；
守护自身崩溃 → 系统服务层（nssm / launchd）再拉起。
抗内存：Node 子进程 `--max-old-space-size` 堆上限；app 层因 workerd 是独立进程，
按**整棵进程树 RSS** 采样，连续 2 次超限则重启 app。

## 目录布局

| | Windows | macOS |
|---|---|---|
| 程序目录（升级整体覆盖） | `C:\Program Files\HaixinAI` | `/Applications/HaixinAI` |
| 数据目录（**永不覆盖**） | `%ProgramData%\HaixinAI` | `/Library/Application Support/HaixinAI` |

数据目录含：`state/`（D1/R2 的 sqlite，miniflare v3 树）、`config.env`（密钥+管理员凭据，0600/700）、
`logs/`、`FIRST-RUN-CREDENTIALS.txt`（自动生成密码时）。**卸载可选保留**，重装复用、不重生密钥。

---

## 构建（在联网的构建机上一次性完成）

构建机可为 **Linux x64 或 macOS**；`.exe` 可在 Linux 交叉编译，`.pkg` 必须在 macOS 上构建。

### 依赖
- Node ≥ 22.13.0（跑构建脚本）、`curl`、`unzip`、`tar`(+`xz-utils`)
- Windows 包：`makensis`（`apt-get install -y nsis` 或 `brew install nsis`）
- macOS 包：`pkgbuild` / `productbuild`（Xcode Command Line Tools，Mac 自带）

### 步骤
```bash
# 0) 应用构建产物（dist/，OS 无关，一次）——若已存在会自动跳过
npm run build            # 需 Node ≥ 22.13.0

# 1) 组装各目标的程序目录树到 packaging/build/out/<target>/
#    自动：下载对应平台 Node、裁剪该平台 wrangler+workerd+esbuild 运行时闭包
node packaging/build/build.mjs win-x64
node packaging/build/build.mjs mac-arm64
node packaging/build/build.mjs mac-x64

# 2a) Windows 安装器（Linux/mac 均可）
node packaging/windows/build-exe.mjs
#    → packaging/build/dist/HaixinAI-<ver>-win-x64-Setup.exe

# 2b) macOS 安装包（必须在 Mac 上）
packaging/macos/build-pkg.sh mac-arm64
packaging/macos/build-pkg.sh mac-x64
#    → packaging/build/dist/HaixinAI-<ver>-<arch>.pkg

# 3) 断网冒烟（本机架构，发货前必过；见下）
node packaging/build/smoke.mjs linux-x64
```

### 为什么要裁剪运行时
`dist/server/index.js` 在 build 时已内联应用依赖（`no_bundle:true`，workerd 直接加载它），
运行时只需 wrangler 工具链。`prune-runtime.mjs` 用只含 `wrangler` 的 scratch `package.json` +
`npm install --os <目标> --cpu <目标>`，得到**目标平台**权威运行时闭包（含该平台 workerd/esbuild 原生二进制），
把 1.2G 开发树降到 ~200MB/OS。**裁剪错→目标机无 npm 可救=硬砖**，故每个包发货前必过断网冒烟。

---

## 断网冒烟（发货门禁）

`packaging/build/smoke.mjs` 用组装好的 `out/<key>` 作为程序目录，在**不依赖 npm、不依赖开发依赖**下：
跑 migrate → 起 `wrangler dev` → 断言 `GET /`=2xx/3xx/4xx、`GET /api/state` 有响应、`workerd` 进程确实 spawn。

```bash
node packaging/build/smoke.mjs linux-x64      # 只能测本机架构
```
> win/mac 的 workerd 无法在 Linux 上执行；这两个目标的冒烟须在**对应 OS 的离线虚拟机**里，
> 按下方“各 OS 离线验收清单”手工过一遍。

---

## 各 OS 离线验收清单（在断网虚拟机上）

对每个交付包，在一台**断网**的干净目标机上：

1. **安装**：双击安装器完成（Windows 未签名会被 SmartScreen 拦，见下方放行）。
2. **服务自启**：
   - Win：`sc query HaixinAI` 显示 `RUNNING`；重启机器后仍自动起。
   - mac：`sudo launchctl print system/com.haixin.ai` 显示已加载；重启后仍在。
3. **控制台**：浏览器打开 `http://localhost` 出现登录页；用 `FIRST-RUN-CREDENTIALS.txt`（或安装时设定）的
   管理员账号登录成功。
4. **迁移**：数据目录 `state/` 下 D1 的 `schema_migrations` 含 0000–0025 全部记录。
5. **抗崩溃**：手动杀掉 `workerd` 进程 → 守护退避后自动重启，`http://localhost` 恢复。
6. **抗内存**：把服务环境变量 `HAIXIN_APP_RSS_CAP_MB` 调到很低（如 `256`）重启服务 → 触发 app 层 RSS 重启日志。
7. **网关/中转**：`curl 127.0.0.1:8788/healthz` 有响应；`127.0.0.1:8789` 可连。
8. **升级/卸载**：重装新版本→数据保留、密钥不变；卸载时选“保留数据”→再装可复用。

日志位置：数据目录 `logs/`（`supervisor.log` / `app.log` / `app.err` / …，10MB×5 轮转）。

---

## 未签名包的放行（无付费证书时）

理想是 Windows Authenticode + macOS Developer ID 签名与公证，可让任意机器顺滑安装；
未签名时按下述放行（并考虑后续补签名）：

- **Windows**：SmartScreen 蓝框 → “更多信息” → “仍要运行”。若 Defender 误杀 `nssm.exe`，
  在“病毒和威胁防护”里对程序目录添加排除项后重装。
- **macOS**：Gatekeeper 拦截 → “系统设置 → 隐私与安全性 → 仍要打开”；
  或终端 `sudo xattr -dr com.apple.quarantine HaixinAI-*.pkg` 后再装。
  签名方法见 `build-pkg.sh` 末尾注释（`productsign` + `notarytool` + `stapler`）。

---

## 首次运行与密钥

首次安装由 `packaging/first-run.mjs`（与守护共用 `ensureConfig()`）生成：
- `PLATFORM_CREDENTIALS_KEY`、`HAIXIN_GATEWAY_ADMIN_SECRET` = `crypto.randomBytes(32).hex`
- 管理员 `admin` + 随机密码（写 `FIRST-RUN-CREDENTIALS.txt`）；安装器也可通过
  `HAIXIN_INSTALL_ADMIN_USER` / `HAIXIN_INSTALL_ADMIN_PASSWORD` 预置。
- `MODEL_*` / `MAIL_*` 留空，装后在平台页面配置。

全部写入**数据目录** `config.env`，**升级绝不覆盖**。

## 常见问题

- **装完打不开 `http://localhost`**：多半是 **80 端口被占**（IIS / 其它 Web 服务 / 企业软件）。
  守护会在日志(`logs/proxy.err`)打印人话提示；解决办法：在数据目录 `config.env` 里设
  `HTTP_PORT=8080`（或其它空闲端口）后重启服务，再访问 `http://localhost:8080`。
  守护启动时也会预探测该端口并在 `supervisor.log` 告警。
- **服务反复重启**：看 `logs/supervisor.log` 的退出码与告警；`app.err` / `proxy.err` 有子进程细节。

---

## 已知限制

- app 层仍是 `wrangler dev --local`（dev server 跑生产）；本方案用双层守护兜住崩溃/重启/内存。
  彻底产品化（迁 workerd 生产模式，或 D1→better-sqlite3+常驻 Hono）是独立后续项。
- `.pkg` 必须在 macOS 上构建；`.exe` 可在 Linux 交叉编译。
- 未签名包需按上文放行；“任意机器零摩擦安装”需补代码签名（付费证书）。

## 目录导航

```
packaging/
  supervisor.mjs      守护主入口（服务 ExecStart）
  migrate.mjs         D1 迁移（移植自 selfhost-entrypoint.sh，含校验和门禁）
  proxy.mjs           反代（1:1 复刻 nginx-ip.conf）
  first-run.mjs       首启密钥/管理员生成（幂等，OS 中立）
  lib/                paths / config / dotenv / logrotate / procmon
  build/
    targets.mjs       目标定义 + 本机联调目标
    fetch-node.mjs    下载各 OS 独立 Node → vendor/node/<key>/
    prune-runtime.mjs 裁剪运行时闭包（--os/--cpu）
    build.mjs         组装程序目录树 → out/<key>/
    smoke.mjs         断网冒烟（发货门禁）
  windows/
    installer.nsi     NSIS 脚本（装服务/数据目录/首启密钥/卸载）
    build-exe.mjs     取 nssm + 调 makensis → dist/*.exe
  macos/
    com.haixin.ai.plist   LaunchDaemon
    scripts/{preinstall,postinstall}
    build-pkg.sh          pkgbuild/productbuild（Mac 上）
  vendor/             预取的 Node 各 OS 二进制 + nssm.exe（构建产物，不入库）
  build/out/          组装出的各目标程序目录（构建产物）
  build/dist/         最终安装包（构建产物）
```

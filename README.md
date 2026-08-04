# Minecraft Control Panel

一个自托管的 **Minecraft Bedrock 服务器 Docker 管理面板**。基于 Node.js 原生实现(无第三方依赖),通过 Docker Compose 管理多台 Bedrock 服务器,提供完整的 Web 管理界面。

全新 **暗色 HUD 风格**界面:顶部服务器切换条、全屏聚焦层、二级导航,信息分层渐进,专注而不杂乱。

默认访问地址:

```text
http://127.0.0.1:8787
```

## ✨ 特色

- **暗色 HUD 界面** —— 钻石蓝主色、状态发光点、方块按钮,像游戏里的控制台
- **二级导航** —— 详情页左侧功能列表 + 右侧内容区,一次只聚焦一个功能
- **在线玩家** —— 主面板实时显示当前在线玩家(解析服务器日志,15 秒刷新)
- **备份一致性** —— 备份前优雅停服保存存档再压缩,确保备份完整,自动重启
- **一键部署** —— 一条命令拉起整个面板,免配置
- **纯原生** —— 零 npm 依赖,轻量安全

## 🚀 快速开始(Docker)

需要 [Docker Desktop](https://www.docker.com/products/docker-desktop/) 已安装并运行。

在项目目录打开 PowerShell,运行:

```powershell
powershell -ExecutionPolicy Bypass -File .\start-panel-docker.ps1
```

脚本自动完成:

1. 生成本机 `.env`(自动计算 Docker 可识别的项目路径)
2. 构建并启动面板容器 `docker compose up -d --build`
3. 面板运行在 http://127.0.0.1:8787

首次打开面板会要求**创建管理员账户**(不提供默认账号),密码使用 `scrypt` 加盐哈希保存。

> 前端文件已挂载到容器(`./public:/app/public`),修改 UI 后**无需重建容器**,浏览器强刷(`Ctrl+Shift+R`)即可生效。

### 手动 Docker Compose 启动

先创建 `.env`:

```env
PANEL_HOST_DATA_DIR=/run/desktop/mnt/host/e/Games/Server/mc-control-panel
PANEL_EXTRA_HOST_DATA_DIR=/run/desktop/mnt/host/e/Games/Server
PANEL_HOST_ROOT_DIR=/run/desktop/mnt/host
```

然后:

```powershell
docker compose --env-file .env -f panel.compose.yml up -d --build
```

常用命令:

```powershell
# 查看面板日志
docker logs -f mc-control-panel
# 停止面板
docker compose --env-file .env -f panel.compose.yml down
```

### 本机 Node 启动(免 Docker)

```powershell
powershell -ExecutionPolicy Bypass -File .\start-panel.ps1
```

## 📋 功能总览

### 面板管理

- 管理员账户:首次创建、登录、修改名称/密码、退出
- 会话安全:HttpOnly Cookie、CSRF 校验、空闲超时、登录失败限速
- 面板日志:内置日志查看器

### 服务器管理

- 一键部署新服务器:版本下拉选择、自定义数据目录、端口与 `server.properties` 预配置
- 数值范围校验:端口 `1-65535`、视距 `5-96`、Tick 距离 `4-12`
- 多服务器:启动 / 停止 / 重启 / 暂停 / 恢复 / 删除(需输入名称确认)
- 顶部切换条快速切换服务器,chip 带状态光点与快速启停
- 资源占用:CPU / 内存 / 网络 / 磁盘 IO 实时监控
- 关键配置在线修改,保存即生效

### 世界与备份

- 新建世界(设置 level-name 与种子)、删除世界(自动先备份)、上传替换世界
- 手动备份 / 自动备份(可设间隔与最大保留数)
- 自定义备份目录,`auto`、`manual` 分目录保存
- 最近备份列表快捷还原,或手动选择旧备份还原
- **备份一致性**(默认开启):备份前优雅停服 → 保存存档 → 压缩 → 自动重启,确保备份不损坏

### 玩家与内容

- **在线玩家**:实时显示,15 秒自动刷新
- 白名单管理:添加 / 删除,支持 XUID 与忽略人数上限
- 模组 / 资源包:上传 `.mcpack`、`.mcaddon`、`.zip` 自动识别并安装,可激活到指定世界

### 运维

- **定时重启**:每台服务器独立设置(按小时循环 / 每天固定时间),只处理运行中的服务器,显示上次结果与下次执行时间
- **FRP 内网穿透**:每台服务器独立 `frpc` 容器,支持启停、状态、实时日志;令牌脱敏存储,失败自动回滚
- 文件管理:浏览目录、小文件在线编辑、文件上传

### 控制台

- 实时 Docker 日志(自动刷新)
- 游戏指令输入,常用指令快捷提示

## 📁 目录说明

项目只使用以下本地运行数据(均已 `.gitignore` 排除):

```text
mc-control-panel/compose.yml      # 面板生成的服务器编排
mc-control-panel/servers/         # 服务器数据目录
mc-control-panel/panel.log        # 面板日志
mc-control-panel/.panel-tmp/      # 上传临时文件
mc-control-panel/.panel-auth.json # 管理员账户
```

每台服务器的 FRP 私密配置保存在对应数据目录的 `.panel-frp/` 中,不会提交到 Git,也不会出现在文件编辑器中。

### 自定义数据目录

新建服务器时"服务器文件目录"留空则默认 `servers/<服务名>`。也可填写任意面板可访问的目录:

```text
servers/my-bedrock
/data/custom-servers/my-bedrock
/host-data/mc-servers/my-bedrock
E:\MC\server-a
/hostfs/e/MC/server-a
```

Docker 模式下路径映射:

| 路径 | 对应 |
| --- | --- |
| `/data` | 本项目目录 `mc-control-panel/` |
| `/host-data` | 项目上一级目录(默认 `E:\Games\Server`) |
| `/hostfs` | Docker Desktop 宿主机磁盘根目录(`/hostfs/e/...` = `E:\...`) |

Windows 路径可直接填写,面板自动转换。每台服务器的数据目录和备份目录独立,可让服务器 A 在 E 盘、备份到 F 盘。

删除服务器需输入服务器名确认,默认保留数据目录;勾选"同时删除数据目录"则一并删除。

## ⚙️ 配置说明

面板容器环境变量:

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PANEL_HOST` | `0.0.0.0` | 面板监听地址 |
| `PANEL_PORT` | `8787` | 面板监听端口 |
| `PANEL_DATA_DIR` | `/data` | 容器内数据目录 |
| `PANEL_HOST_DATA_DIR` | 由 `.env` 提供 | Docker 映射到宿主机项目目录的路径 |
| `PANEL_EXTRA_HOST_DATA_DIR` | 由 `.env` 提供 | 映射到容器 `/host-data` 的宿主机目录 |
| `PANEL_HOST_ROOT_DIR` | 由 `.env` 提供 | 映射到容器 `/hostfs` 的宿主机磁盘根目录 |
| `PANEL_PATH_MAPPINGS` | `/data=...;/host-data=...;/hostfs=...` | 容器路径 → Minecraft 容器宿主机挂载路径转换 |
| `PANEL_SECURE_COOKIE` | `false` | HTTPS 反向代理时设为 `true`,Cookie 仅经 HTTPS 发送 |

移动项目目录后,重新运行 `start-panel-docker.ps1` 即可刷新 `.env`。

## 🔒 安全提示

面板容器挂载了 Docker socket(`/var/run/docker.sock`),**拥有宿主机 Docker 的完全控制权**。请仅在本机或可信内网使用:

- 不要直接把 `8787` 端口暴露到公网
- 公网部署需配置 HTTPS、反向代理与防火墙
- 登录验证可防未授权访问,但不是公网暴露的替代方案

**忘记密码**:停止面板容器,删除项目目录的 `.panel-auth.json`,重新启动面板即可重建管理员(不影响服务器数据)。

## 🧪 测试

FRP 集成测试(创建临时 Compose 项目,自动清理,不影响正式数据):

```powershell
npm run test:frp-integration
```

覆盖:管理员认证与 CSRF、代理启停、配置更新、日志、失败回滚、同名容器保护、令牌脱敏、私密文件隔离。

## 📌 GitHub 提交说明

仓库仅包含面板源码与部署模板,以下运行时数据不会提交:

- Minecraft 服务器数据、世界存档、备份文件
- 上传的资源包 / 模组包
- 面板日志、本机生成的 `compose.yml`
- 管理员账户文件、FRP 私密配置

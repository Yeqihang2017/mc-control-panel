# Minecraft Control Panel

一个独立的 Minecraft Bedrock 服务器 Docker 管理面板。它只管理本项目目录下创建的服务器，不会读取或接管你原来的服务器目录。

默认访问地址：

```text
http://127.0.0.1:8787
```

## 功能

- 管理员账户保护：首次启动创建账户，登录后才能访问面板和 API
- 密码使用 `scrypt` 加盐哈希保存，支持修改管理员名称和密码、退出登录
- 会话采用 `HttpOnly` Cookie，支持空闲超时、最长有效期和登录失败限速
- 一键部署新的 Minecraft Bedrock Docker 服务器
- 新建服务器时通过下拉列表选择版本
- 部署前可视化配置端口和 `server.properties` 关键参数
- 关键数值范围校验：端口 `1-65535`、视距 `5-96`（面板性能安全上限）、Tick 距离 `4-12`
- 支持强制覆盖已存在的数据目录，需要明确确认
- 多服务器管理：启动、停止、重启、暂停、恢复、删除
- 每台服务器可独立设置定时重启：按小时循环或每天固定时间执行
- 定时重启只处理正在运行的服务器，并显示上次结果和下次执行时间
- 每台服务器可独立配置 FRP UDP 内网穿透，支持启停、状态和 frpc 日志
- 删除服务器时需要输入服务器名确认
- 一级面板显示服务器 CPU、内存、网络和磁盘 IO 占用
- 二级菜单：
  - 服务器详情：世界、白名单、模组/资源包、定时重启、内网穿透、文件和删除
  - 控制台：实时日志和游戏指令
- 控制台支持实时 Docker logs 和游戏指令输入
- 指令输入提供常用命令提示
- 世界管理：新建世界、删除世界、替换世界
- 备份管理：
  - 手动备份
  - 自动备份
  - 自定义备份目录
  - 自动备份和手动备份分开保存到 `auto`、`manual` 子目录
  - 自动备份支持设置备份间隔和最大保留数量
  - 最近备份列表可快捷还原
  - 支持手动选择旧备份进行还原
- 白名单列表管理
- 模组/资源包管理，不显示默认资源包
- 文件浏览和小文件在线编辑
- 上传 `.mcpack`、`.mcaddon`、`.zip` 并安装到 behavior/resource packs

## 目录说明

项目默认只使用这些本地运行数据：

```text
mc-control-panel/compose.yml
mc-control-panel/servers/
mc-control-panel/panel.log
mc-control-panel/.panel-tmp/
mc-control-panel/.panel-auth.json
```

这些目录和文件已经在 `.gitignore` 中排除，不会提交到 GitHub。

每台服务器的 FRP 私密配置保存在对应数据目录的 `.panel-frp/` 中，也不会提交到 GitHub 或出现在面板文件编辑器中。

`compose.example.yml` 是一个安全的示例模板。实际运行时由面板生成 `compose.yml`，不要手动提交。

## Docker 部署面板

在项目目录运行一条命令即可自动生成 Docker 配置并启动面板：

```powershell
powershell -ExecutionPolicy Bypass -File .\start-panel-docker.ps1
```

脚本会自动生成本机 `.env`，里面包含 Docker Desktop 能识别的项目目录路径。`.env` 是本机配置文件，已经被 `.gitignore` 排除。

首次打开面板时会要求创建管理员账户，不提供默认用户名和密码。管理员账户文件保存在 `.panel-auth.json`，随面板数据目录持久化，并已从 Git 提交中排除。

或手动创建 `.env` 后使用 Docker Compose：

```env
PANEL_HOST_DATA_DIR=/run/desktop/mnt/host/e/Games/Server/mc-control-panel
```

```powershell
docker compose --env-file .env -f panel.compose.yml up -d --build
```

查看面板容器日志：

```powershell
docker logs -f mc-control-panel
```

停止面板：

```powershell
docker compose --env-file .env -f panel.compose.yml down
```

## 本机 Node 启动

如果你想不经过 Docker 直接启动面板：

```powershell
powershell -ExecutionPolicy Bypass -File .\start-panel.ps1
```

## 配置说明

面板容器使用以下环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PANEL_HOST` | `0.0.0.0` | 面板监听地址 |
| `PANEL_PORT` | `8787` | 面板监听端口 |
| `PANEL_DATA_DIR` | `/data` | 容器内数据目录 |
| `PANEL_HOST_DATA_DIR` | 由 `.env` 提供 | Docker Desktop 中映射到宿主机项目目录的路径 |
| `PANEL_SECURE_COOKIE` | `false` | HTTPS 反向代理部署时设为 `true`，强制会话 Cookie 仅通过 HTTPS 发送 |

如果你把项目移动到其他磁盘或目录，重新运行 `start-panel-docker.ps1` 即可刷新 `.env`。

## 定时重启

在 `服务器详情 -> 定时重启` 中，可以为每台服务器独立设置：

- 按小时循环重启
- 每天固定时间重启
- 启用或停用计划

计划使用浏览器提交的本地时区计算下一次执行时间。定时任务只重启正在运行且未暂停的服务器；停止或未创建的服务器会被跳过。面板会显示下次执行时间、上次执行时间和执行结果。

## FRP 内网穿透

面板中的 `服务器详情 -> 内网穿透` 可以为每台 Bedrock 服务器创建独立的 `frpc` Docker 容器。需要提前在有公网 IP 的 VPS 上部署 `frps`，并在 VPS 防火墙和云安全组放行：

- FRP 控制端口，例如 `7000/TCP`
- 为服务器设置的公网游戏端口，例如 `19132/UDP`

可配置项目包括：

- `frps` 域名或 IP
- FRP 控制端口
- 公网 UDP 端口
- 认证令牌
- TLS 开关

面板使用固定镜像 `fatedier/frpc:v0.70.1`，并为每台 Minecraft 服务器创建独立的 `frpc-<服务器名>` Compose 服务。代理通过 Compose 网络按服务名连接 Minecraft 容器，不需要把游戏端口再次暴露给宿主机。

认证令牌保存在服务器数据目录的私密 `.panel-frp` 目录中，不会通过 API 回传，也不会显示在文件编辑器、`compose.yml` 或面板日志中。留空令牌会保留之前保存的值。保存新配置会强制重建对应的 `frpc` 容器；应用失败时会恢复之前的 Compose 和私密配置。停用 FRP 只删除面板管理的代理容器，不会重启 Minecraft 服务器。

面板中可以查看代理状态、公网连接地址和 `frpc` 实时日志，也可以单独启动、停止或重启代理。玩家使用 `frps 域名或公网 IP:公网 UDP 端口` 连接。

## 测试

FRP 集成测试会创建带唯一名称的临时 Compose 项目、Minecraft 夹具、`frps` 和面板容器，完成后自动清理。它不会读取或操作正式的 `compose.yml` 和服务器数据。

```powershell
npm run test:frp-integration
```

测试覆盖管理员认证和 CSRF、代理启停、配置更新、日志、失败回滚、同名容器保护、令牌脱敏、私密文件隔离，以及确认 FRP 操作不会重启 Minecraft 容器。

## 安全提示

面板容器会挂载 Docker socket：

```yaml
/var/run/docker.sock:/var/run/docker.sock
```

这意味着面板可以控制宿主机上的 Docker 容器。建议只在本机或可信内网使用，不要直接暴露到公网。

管理员登录能防止未经授权的面板操作，但公网部署还应配置 HTTPS、反向代理和防火墙；不要直接把 `8787` 端口暴露到互联网。

忘记密码时，停止面板容器，删除项目目录中的 `.panel-auth.json`，再启动面板即可重新创建管理员。此操作不会删除 Minecraft 服务器、世界或备份数据。

## GitHub 提交说明

仓库只包含面板源码和部署模板。以下运行时数据不会提交：

- Minecraft 服务器数据
- 世界存档
- 备份文件
- 上传的资源包或模组包
- 面板日志
- 本机生成的 `compose.yml`
- 管理员账户文件
- 每台服务器的 FRP 私密配置

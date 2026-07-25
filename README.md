# Minecraft Control Panel

一个独立的 Minecraft Bedrock 服务器 Docker 管理面板。它只管理本项目目录下创建的服务器，不会读取或接管你原来的服务器目录。

默认访问地址：

```text
http://127.0.0.1:8787
```

## 功能

- 一键部署新的 Minecraft Bedrock Docker 服务器
- 新建服务器时通过下拉列表选择版本
- 部署前可视化配置端口和 `server.properties` 关键参数
- 支持强制覆盖已存在的数据目录，需要明确确认
- 多服务器管理：启动、停止、重启、暂停、恢复、删除
- 删除服务器时需要输入服务器名确认
- 一级面板显示服务器 CPU、内存、网络和磁盘 IO 占用
- 二级菜单：
  - 服务器详情
  - 控制台
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
```

这些目录和文件已经在 `.gitignore` 中排除，不会提交到 GitHub。

`compose.example.yml` 是一个安全的示例模板。实际运行时由面板生成 `compose.yml`，不要手动提交。

## Docker 部署面板

在项目目录运行一条命令即可自动生成 Docker 配置并启动面板：

```powershell
powershell -ExecutionPolicy Bypass -File .\start-panel-docker.ps1
```

脚本会自动生成本机 `.env`，里面包含 Docker Desktop 能识别的项目目录路径。`.env` 是本机配置文件，已经被 `.gitignore` 排除。

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

如果你把项目移动到其他磁盘或目录，重新运行 `start-panel-docker.ps1` 即可刷新 `.env`。

## 安全提示

面板容器会挂载 Docker socket：

```yaml
/var/run/docker.sock:/var/run/docker.sock
```

这意味着面板可以控制宿主机上的 Docker 容器。建议只在本机或可信内网使用，不要直接暴露到公网。

## GitHub 提交说明

仓库只包含面板源码和部署模板。以下运行时数据不会提交：

- Minecraft 服务器数据
- 世界存档
- 备份文件
- 上传的资源包或模组包
- 面板日志
- 本机生成的 `compose.yml`

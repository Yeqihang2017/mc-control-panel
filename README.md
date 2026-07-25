# Minecraft Control Panel

这是一个独立的 Minecraft Bedrock Docker 控制面板。

它只管理本目录下的资源：

- `mc-control-panel/compose.yml`
- `mc-control-panel/servers/*`
- `mc-control-panel/panel.log`

`compose.yml`、`servers/*` 和 `panel.log` 是本机运行数据，不建议提交到 Git。
新环境可以从 `compose.example.yml` 复制一份：

```powershell
Copy-Item E:\Games\Server\mc-control-panel\compose.example.yml E:\Games\Server\mc-control-panel\compose.yml
```

不会读取或控制 `E:\Games\Server\infra\minecraft-bedrock\compose.yml` 里的原有服务器。

## Docker 启动

```powershell
powershell -ExecutionPolicy Bypass -File E:\Games\Server\mc-control-panel\start-panel-docker.ps1
```

默认地址：

```text
http://127.0.0.1:8787
```

面板容器日志：

```powershell
docker logs -f mc-control-panel
```

## 本机 Node 启动

```powershell
powershell -ExecutionPolicy Bypass -File E:\Games\Server\mc-control-panel\start-panel.ps1
```

## 功能

- 一键部署新的 Bedrock Docker 服务
- 可视化配置端口和 `server.properties` 关键参数
- 启动、停止、重启、暂停、恢复多服务器
- 一级界面显示当前服务器 CPU、内存、网络和磁盘 IO
- 发送游戏指令到运行中的服务器
- 输入服务器名确认后删除服务器，可选择是否删除数据目录
- 世界、模组/资源包、文件编辑集中在服务器详情二级面板
- 页面内查看服务器 Docker logs 和面板操作日志
- 文件浏览和小文件编辑
- 白名单列表管理
- 新建世界、手动备份、自动备份、备份列表快捷还原、上传旧备份还原
- 支持自定义备份目录，自动备份和手动备份会分别放入 `auto` 和 `manual` 子目录
- 上传 `.mcpack`、`.mcaddon`、`.zip`，安装到 behavior/resource packs，并写入当前选中世界的 pack 启用 JSON

面板容器会挂载 Docker socket，因此只建议在本机可信环境访问。默认发布到宿主机的 `8787` 端口。

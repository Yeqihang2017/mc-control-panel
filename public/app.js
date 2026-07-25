const KEY_FIELDS = [
  ["server-name", "服务器名", "text"],
  ["server-port", "IPv4 端口", "number"],
  ["server-portv6", "IPv6 端口", "number"],
  ["level-name", "世界名", "text"],
  ["level-seed", "种子", "text"],
  ["gamemode", "游戏模式", "select", ["survival", "creative", "adventure"]],
  ["difficulty", "难度", "select", ["peaceful", "easy", "normal", "hard"]],
  ["max-players", "最大玩家", "number"],
  ["view-distance", "视距", "number"],
  ["tick-distance", "Tick 距离", "number"],
  ["allow-cheats", "允许作弊", "bool"],
  ["online-mode", "在线验证", "bool"],
  ["allow-list", "白名单", "bool"],
  ["force-gamemode", "强制模式", "bool"],
  ["enable-lan-visibility", "LAN 可见", "bool"],
  ["texturepack-required", "强制材质包", "bool"]
];

const state = {
  servers: [],
  active: null,
  fileDir: "",
  activeFile: "",
  logMode: "server",
  tab: "worlds",
  liveLogTimer: null,
  liveLogLoading: false,
  resourceTimer: null,
  resourceLoading: false,
  view: "dashboard"
};

const $ = (id) => document.getElementById(id);

function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.remove("show"), 3600);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || response.statusText);
  return data;
}

async function refresh() {
  const data = await api("/api/servers");
  state.servers = data.servers;
  if (!state.active || !state.servers.some((server) => server.name === state.active)) {
    state.active = state.servers[0] && state.servers[0].name;
  }
  render();
}

async function loadVersions() {
  try {
    const data = await api("/api/versions");
    $("versionSelect").innerHTML = data.versions.map((version) => {
      const label = version === "LATEST" ? "最新版" : version;
      return `<option value="${escapeAttr(version)}">${escapeHtml(label)}</option>`;
    }).join("");
  } catch {
    // Static options in HTML remain usable.
  }
}

function activeServer() {
  return state.servers.find((server) => server.name === state.active);
}

function stateClass(server) {
  const value = String(server.state || "").toLowerCase();
  if (value.includes("running")) return "running";
  if (value.includes("paused")) return "paused";
  if (value.includes("exit") || value.includes("stop")) return "exited";
  return "";
}

function render() {
  renderServerList();
  renderActive();
}

function renderServerList() {
  $("serverList").innerHTML = state.servers.map((server) => `
    <button class="server-card ${server.name === state.active ? "active" : ""}" data-server="${server.name}">
      <strong>${escapeHtml(server.properties["server-name"] || server.name)}</strong>
      <span>${escapeHtml(server.name)}</span>
      <span class="pill ${stateClass(server)}">${escapeHtml(server.state || "not-created")} ${escapeHtml(server.health || "")}</span>
    </button>
  `).join("");
  document.querySelectorAll("[data-server]").forEach((button) => {
    button.addEventListener("click", () => {
      state.active = button.dataset.server;
      state.fileDir = "";
      state.activeFile = "";
      renderActive();
      renderServerList();
      if (state.view === "console") refreshLiveLogs().catch(showError);
      refreshResources().catch(() => {});
    });
  });
}

function renderActive() {
  const server = activeServer();
  if (!server) {
    $("activeTitle").textContent = "没有 Minecraft 服务";
    $("activeSub").textContent = "点击“新建部署”创建独立服务器";
    $("statusRow").innerHTML = "";
    $("serverPath").textContent = "";
    $("propsForm").innerHTML = "";
    $("worldSelect").innerHTML = "";
    $("backupList").innerHTML = "";
    $("behaviorPacks").innerHTML = "";
    $("resourcePacks").innerHTML = "";
    $("fileList").innerHTML = "";
    $("fileText").value = "";
    $("commandOutput").textContent = "";
    $("liveLogsBox").textContent = "还没有服务器，暂无实时日志。";
    $("liveLogStatus").textContent = "等待服务器";
    renderResources(null);
    return;
  }

  $("activeTitle").textContent = server.properties["server-name"] || server.name;
  $("activeSub").textContent = `${server.name} · UDP ${server.publishedPort || "-"} · ${server.status || server.state}`;
  $("serverPath").textContent = server.dataPath;
  $("statusRow").innerHTML = `
    <div class="stat"><span>状态</span><strong>${escapeHtml(server.status || server.state)}</strong></div>
    <div class="stat"><span>端口</span><strong>${escapeHtml(String(server.publishedPort || "-"))}/udp</strong></div>
    <div class="stat"><span>世界</span><strong>${server.worlds.length}</strong></div>
    <div class="stat"><span>自定义包</span><strong>${server.behaviorPacks.length + server.resourcePacks.length}</strong></div>
  `;
  renderProps(server);
  renderWorlds(server);
  renderBackups(server);
  renderAllowlist(server);
  renderPacks(server);
  if (state.view === "details") loadFileList(state.fileDir || "").catch(showError);
  if (state.view === "details") {
    $("activeTitle").textContent = "服务器详情";
    $("activeSub").textContent = `${server.name} · ${server.properties["server-name"] || server.name}`;
  }
  if (state.view === "console") {
    $("activeTitle").textContent = "控制台";
    $("activeSub").textContent = `${server.name} · ${server.properties["server-name"] || server.name}`;
    refreshLiveLogs().catch(() => {});
  }
  refreshResources().catch(() => {});
}

function renderProps(server) {
  $("propsForm").innerHTML = KEY_FIELDS.map(([key, label, type, values]) => {
    const value = server.properties[key] ?? "";
    if (type === "select") {
      return `<label>${label}<select name="${key}">${values.map((item) => `<option ${item === value ? "selected" : ""}>${item}</option>`).join("")}</select></label>`;
    }
    if (type === "bool") {
      return `<label class="check"><input name="${key}" type="checkbox" ${String(value) === "true" ? "checked" : ""}> ${label}</label>`;
    }
    return `<label>${label}<input name="${key}" type="${type}" value="${escapeAttr(value)}"></label>`;
  }).join("");
}

function renderWorlds(server) {
  $("worldSelect").innerHTML = server.worlds.map((world) => `<option>${escapeHtml(world)}</option>`).join("");
}

function renderBackups(server) {
  const settings = server.backupSettings || {};
  $("backupDirInput").value = settings.backupDir || "backups";
  $("backupIntervalInput").value = settings.intervalMinutes || 30;
  $("backupMaxFilesInput").value = settings.maxFiles || 10;
  $("autoBackupEnabledInput").checked = Boolean(settings.autoEnabled);
  $("backupList").innerHTML = server.backups && server.backups.length
    ? server.backups.map((backup) => `
      <div class="backup-row">
        <div>
          <strong>${escapeHtml(backup.name)}</strong>
          <span>${backup.type === "auto" ? "自动" : "手动"} · ${new Date(backup.mtime).toLocaleString()} · ${formatBytes(backup.size)}</span>
        </div>
        <button data-restore-backup="${escapeAttr(backup.path)}">还原</button>
      </div>
    `).join("")
    : `<div class="empty-row">暂无备份</div>`;
  document.querySelectorAll("[data-restore-backup]").forEach((button) => {
    button.addEventListener("click", () => restoreListedBackup(button.dataset.restoreBackup).catch(showError));
  });
}

function renderAllowlist(server) {
  const list = server.allowlist || [];
  $("allowlistBox").innerHTML = list.length
    ? list.map((entry) => `
      <div class="backup-row">
        <div>
          <strong>${escapeHtml(entry.name || "(未命名)")}</strong>
          <span>${entry.xuid ? `XUID ${escapeHtml(entry.xuid)} · ` : ""}${entry.ignoresPlayerLimit ? "忽略人数上限" : "普通"}</span>
        </div>
        <button data-remove-allowlist="${escapeAttr(entry.name || "")}">删除</button>
      </div>
    `).join("")
    : `<div class="empty-row">暂无白名单玩家</div>`;
  document.querySelectorAll("[data-remove-allowlist]").forEach((button) => {
    button.addEventListener("click", () => removeAllowlist(button.dataset.removeAllowlist).catch(showError));
  });
}

function renderPacks(server) {
  $("behaviorPacks").innerHTML = server.behaviorPacks.length
    ? server.behaviorPacks.map((name) => `<span class="chip">${escapeHtml(name)}</span>`).join("")
    : `<span class="chip">暂无自定义 Behavior Pack</span>`;
  $("resourcePacks").innerHTML = server.resourcePacks.length
    ? server.resourcePacks.map((name) => `<span class="chip">${escapeHtml(name)}</span>`).join("")
    : `<span class="chip">暂无自定义 Resource Pack</span>`;
}

async function doAction(action) {
  const server = activeServer();
  if (!server) return;
  await api(`/api/server/${server.name}/action`, { method: "POST", body: JSON.stringify({ action }) });
  toast("操作已发送");
  await refresh();
}

function formData(form) {
  const out = {};
  for (const element of form.elements) {
    if (!element.name) continue;
    out[element.name] = element.type === "checkbox" ? element.checked : element.value;
  }
  return out;
}

async function saveProps() {
  const server = activeServer();
  if (!server) return;
  const properties = {};
  for (const [key, , type] of KEY_FIELDS) {
    const el = $("propsForm").elements[key];
    properties[key] = type === "bool" ? String(el.checked) : String(el.value);
  }
  await api(`/api/server/${server.name}/properties`, { method: "PUT", body: JSON.stringify({ properties }) });
  toast("配置已保存");
  await refresh();
}

async function deploy(event) {
  event.preventDefault();
  const body = formData(event.currentTarget);
  if (body.forceOverwriteDataDir) {
    const ok = confirm("强制覆盖会删除同名数据目录里的世界、配置、模组和备份。确定继续部署吗？");
    if (!ok) return;
  }
  await api("/api/deploy", { method: "POST", body: JSON.stringify(body) });
  toast("部署完成");
  $("deployPanel").classList.remove("open");
  await refresh();
}

async function sendCommand(event) {
  event.preventDefault();
  const server = activeServer();
  const command = $("commandInput").value.trim();
  if (!server) return toast("请选择服务器");
  if (!command) return toast("请输入指令");
  const result = await api(`/api/server/${server.name}/command`, {
    method: "POST",
    body: JSON.stringify({ command })
  });
  $("commandOutput").textContent = result.output || "指令已发送。";
  $("commandInput").value = "";
  toast("指令已发送");
}

async function backupWorld() {
  const server = activeServer();
  const worldName = $("worldSelect").value;
  if (!server || !worldName) return;
  await api(`/api/server/${server.name}/world/backup`, { method: "POST", body: JSON.stringify({ worldName, type: "manual" }) });
  toast("世界已备份");
  await refresh();
}

async function saveBackupSettings() {
  const server = activeServer();
  if (!server) return;
  await api(`/api/server/${server.name}/world/backup-settings`, {
    method: "PUT",
    body: JSON.stringify({
      backupDir: $("backupDirInput").value.trim() || "backups",
      autoEnabled: $("autoBackupEnabledInput").checked,
      intervalMinutes: $("backupIntervalInput").value,
      maxFiles: $("backupMaxFilesInput").value
    })
  });
  toast("备份设置已保存");
  await refresh();
}

async function refreshBackups() {
  const server = activeServer();
  if (!server) return;
  const data = await api(`/api/server/${server.name}/world/backups`);
  server.backups = data.backups;
  server.backupSettings = data.settings;
  renderBackups(server);
  toast("备份列表已刷新");
}

async function restoreListedBackup(backupPath) {
  const server = activeServer();
  const targetWorldName = $("worldSelect").value || prompt("还原为世界名");
  if (!server || !backupPath || !targetWorldName) return;
  if (!confirm(`还原备份到世界：${targetWorldName}？当前同名世界会先备份。`)) return;
  await api(`/api/server/${server.name}/world/restore`, {
    method: "POST",
    body: JSON.stringify({ backupPath, targetWorldName })
  });
  toast("备份已还原");
  await refresh();
}

async function deleteWorld() {
  const server = activeServer();
  const worldName = $("worldSelect").value;
  if (!server || !worldName) return;
  if (!confirm(`备份并删除世界：${worldName}？`)) return;
  await api(`/api/server/${server.name}/world/delete`, { method: "POST", body: JSON.stringify({ worldName, backupFirst: true }) });
  toast("世界已删除");
  await refresh();
}

async function newWorld() {
  const server = activeServer();
  const worldName = $("newWorldName").value.trim();
  if (!server || !worldName) return toast("请输入新世界名");
  await api(`/api/server/${server.name}/world/new`, {
    method: "POST",
    body: JSON.stringify({ worldName, levelSeed: $("newWorldSeed").value })
  });
  toast("已切换 level-name，重启后生成新世界");
  await refresh();
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function uploadWorld() {
  const server = activeServer();
  const file = $("worldFile").files[0];
  const targetWorldName = $("replaceWorldName").value.trim();
  if (!server || !file || !targetWorldName) return toast("请选择世界文件并填写目标世界名");
  if (!confirm(`上传并替换世界：${targetWorldName}？已有目录会先备份。`)) return;
  await api(`/api/server/${server.name}/world/upload`, {
    method: "POST",
    body: JSON.stringify({ fileName: file.name, contentBase64: await fileToBase64(file), targetWorldName, replaceExisting: true })
  });
  toast("世界已替换");
  await refresh();
}

async function addAllowlist() {
  const server = activeServer();
  const name = $("allowlistNameInput").value.trim();
  if (!server || !name) return toast("请输入玩家名");
  const data = await api(`/api/server/${server.name}/allowlist`, {
    method: "POST",
    body: JSON.stringify({
      name,
      xuid: $("allowlistXuidInput").value.trim(),
      ignoresPlayerLimit: $("allowlistIgnoreLimitInput").checked
    })
  });
  server.allowlist = data.allowlist;
  $("allowlistNameInput").value = "";
  $("allowlistXuidInput").value = "";
  $("allowlistIgnoreLimitInput").checked = false;
  renderAllowlist(server);
  toast("白名单已更新");
}

async function removeAllowlist(name) {
  const server = activeServer();
  if (!server || !name) return;
  if (!confirm(`从白名单删除 ${name}？`)) return;
  const data = await api(`/api/server/${server.name}/allowlist/remove`, {
    method: "POST",
    body: JSON.stringify({ name })
  });
  server.allowlist = data.allowlist;
  renderAllowlist(server);
  toast("白名单已删除");
}

async function installMod() {
  const server = activeServer();
  const file = $("modFile").files[0];
  if (!server || !file) return toast("请选择 .mcpack/.mcaddon/.zip");
  const result = await api(`/api/server/${server.name}/mods/upload`, {
    method: "POST",
    body: JSON.stringify({ fileName: file.name, contentBase64: await fileToBase64(file), activateWorld: $("worldSelect").value || "" })
  });
  toast(`已安装 ${result.installed.length} 个包`);
  await refresh();
}

async function deleteServer() {
  const server = activeServer();
  if (!server) return;
  const confirmName = $("deleteServerName").value.trim();
  const deleteDataDir = $("deleteServerData").checked;
  if (confirmName !== server.name) return toast("请输入完全一致的服务器名");
  const warning = deleteDataDir
    ? `将删除服务器 ${server.name}，并删除数据目录。此操作不可恢复，确定继续？`
    : `将删除服务器 ${server.name}，但保留数据目录。确定继续？`;
  if (!confirm(warning)) return;
  await api(`/api/server/${server.name}/delete`, {
    method: "POST",
    body: JSON.stringify({ confirmName, deleteDataDir })
  });
  $("deleteServerName").value = "";
  $("deleteServerData").checked = false;
  leaveDetailsView();
  toast("服务器已删除");
  await refresh();
}

async function loadLogs(mode = state.logMode) {
  state.logMode = mode;
  $("logsPanel").classList.add("open");
  $("logsBox").textContent = "读取中...";
  document.querySelectorAll("[data-log-mode]").forEach((button) => button.classList.toggle("selected", button.dataset.logMode === mode));
  if (mode === "panel") {
    const data = await api("/api/panel/logs?tail=320");
    $("logsBox").textContent = data.logs || "(暂无面板日志)";
    return;
  }
  const server = activeServer();
  if (!server) {
    $("logsBox").textContent = "还没有服务器，暂无 Docker 服务日志。";
    return;
  }
  const data = await api(`/api/server/${server.name}/logs?tail=240`);
  $("logsBox").textContent = data.logs || "(无日志)";
}

async function refreshLiveLogs() {
  if (state.view !== "console") return;
  const server = activeServer();
  if (!server) {
    $("liveLogsBox").textContent = "还没有服务器，暂无实时日志。";
    $("liveLogStatus").textContent = "等待服务器";
    return;
  }
  if (state.liveLogLoading) return;
  state.liveLogLoading = true;
  $("liveLogStatus").textContent = "刷新中...";
  try {
    const data = await api(`/api/server/${server.name}/logs?tail=240`);
    const box = $("liveLogsBox");
    box.textContent = data.logs || "(无日志)";
    box.scrollTop = box.scrollHeight;
    $("liveLogStatus").textContent = `自动刷新 · ${new Date().toLocaleTimeString()}`;
  } catch (error) {
    $("liveLogStatus").textContent = "刷新失败";
    $("liveLogsBox").textContent = error.message || "读取日志失败";
  } finally {
    state.liveLogLoading = false;
  }
}

function renderResources(data) {
  const unavailable = !data || !data.available;
  $("resourceCpu").textContent = unavailable ? "-" : data.cpu;
  $("resourceMemory").textContent = unavailable ? "-" : data.memory;
  $("resourceMemoryPercent").textContent = unavailable ? "-" : data.memoryPercent;
  $("resourcePids").textContent = unavailable ? "-" : data.pids;
  $("resourceNetwork").textContent = unavailable ? "-" : data.network;
  $("resourceBlock").textContent = unavailable ? "-" : data.block;
  $("resourceStatus").textContent = unavailable
    ? (data && data.message ? data.message : "等待服务器")
    : `自动刷新 · ${new Date(data.refreshedAt).toLocaleTimeString()}`;
}

async function refreshResources() {
  if (state.view !== "dashboard") return;
  const server = activeServer();
  if (!server) return renderResources(null);
  if (state.resourceLoading) return;
  state.resourceLoading = true;
  $("resourceStatus").textContent = "刷新中...";
  try {
    const data = await api(`/api/server/${server.name}/resources`);
    renderResources(data);
  } catch (error) {
    renderResources({ available: false, message: error.message || "读取失败" });
  } finally {
    state.resourceLoading = false;
  }
}

async function loadFileList(dir) {
  const server = activeServer();
  if (!server) return;
  state.fileDir = dir || "";
  $("filePath").textContent = "/" + state.fileDir;
  const data = await api(`/api/server/${server.name}/files?path=${encodeURIComponent(state.fileDir)}`);
  $("fileList").innerHTML = data.entries.map((entry) => `
    <button class="file-item" data-path="${escapeAttr(entry.path)}" data-type="${entry.type}">
      ${entry.type === "dir" ? "DIR" : "FILE"} ${escapeHtml(entry.name)}
    </button>
  `).join("");
  document.querySelectorAll(".file-item").forEach((button) => {
    button.addEventListener("click", async () => {
      if (button.dataset.type === "dir") {
        state.activeFile = "";
        $("fileText").value = "";
        await loadFileList(button.dataset.path);
      } else {
        await loadFile(button.dataset.path);
      }
    });
  });
}

async function loadFile(filePath) {
  const server = activeServer();
  const data = await api(`/api/server/${server.name}/file?path=${encodeURIComponent(filePath)}`);
  state.activeFile = filePath;
  $("filePath").textContent = "/" + filePath;
  $("fileText").value = data.content;
}

async function saveFile() {
  const server = activeServer();
  if (!server || !state.activeFile) return toast("请选择要保存的文件");
  await api(`/api/server/${server.name}/file`, { method: "PUT", body: JSON.stringify({ path: state.activeFile, content: $("fileText").value }) });
  toast("文件已保存");
  await refresh();
}

function switchTab(tab) {
  state.tab = tab;
  document.querySelectorAll("[data-tab]").forEach((button) => button.classList.toggle("selected", button.dataset.tab === tab));
  document.querySelectorAll(".tab-page").forEach((page) => page.classList.toggle("active", page.id === `tab-${tab}`));
  if (tab === "files") loadFileList(state.fileDir || "").catch(showError);
}

function enterDetailsView() {
  const server = activeServer();
  if (!server) return toast("请选择服务器");
  state.view = "details";
  document.querySelector(".main").classList.add("details-mode");
  $("detailsPanel").classList.add("open");
  $("activeTitle").textContent = "服务器详情";
  $("activeSub").textContent = `${server.name} · ${server.properties["server-name"] || server.name}`;
  switchTab(state.tab);
}

function leaveDetailsView() {
  state.view = "dashboard";
  document.querySelector(".main").classList.remove("details-mode");
  $("detailsPanel").classList.remove("open");
  renderActive();
}

function enterConsoleView() {
  const server = activeServer();
  if (!server) return toast("请选择服务器");
  state.view = "console";
  document.querySelector(".main").classList.add("console-mode");
  $("consolePanel").classList.add("open");
  $("activeTitle").textContent = "控制台";
  $("activeSub").textContent = `${server.name} · ${server.properties["server-name"] || server.name}`;
  refreshLiveLogs().catch(showError);
}

function leaveConsoleView() {
  state.view = "dashboard";
  document.querySelector(".main").classList.remove("console-mode");
  $("consolePanel").classList.remove("open");
  renderActive();
}

function upDir(dir) {
  if (!dir) return "";
  const parts = dir.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char]);
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, "&#096;");
}

function wire() {
  $("refreshBtn").addEventListener("click", () => refresh().catch(showError));
  $("refreshWorldsBtn").addEventListener("click", () => refresh().catch(showError));
  $("showDeployBtn").addEventListener("click", () => $("deployPanel").classList.add("open"));
  $("hideDeployBtn").addEventListener("click", () => $("deployPanel").classList.remove("open"));
  $("openDetailsBtn").addEventListener("click", () => enterDetailsView());
  $("closeDetailsBtn").addEventListener("click", () => leaveDetailsView());
  $("openConsoleBtn").addEventListener("click", () => enterConsoleView());
  $("closeConsoleBtn").addEventListener("click", () => leaveConsoleView());
  $("deployForm").addEventListener("submit", (event) => deploy(event).catch(showError));
  $("commandForm").addEventListener("submit", (event) => sendCommand(event).catch(showError));
  $("savePropsBtn").addEventListener("click", () => saveProps().catch(showError));
  document.querySelectorAll("[data-action]").forEach((button) => button.addEventListener("click", () => doAction(button.dataset.action).catch(showError)));
  document.querySelectorAll("[data-tab]").forEach((button) => button.addEventListener("click", () => switchTab(button.dataset.tab)));
  $("backupWorldBtn").addEventListener("click", () => backupWorld().catch(showError));
  $("saveBackupSettingsBtn").addEventListener("click", () => saveBackupSettings().catch(showError));
  $("refreshBackupsBtn").addEventListener("click", () => refreshBackups().catch(showError));
  $("deleteWorldBtn").addEventListener("click", () => deleteWorld().catch(showError));
  $("newWorldBtn").addEventListener("click", () => newWorld().catch(showError));
  $("replaceWorldBtn").addEventListener("click", () => uploadWorld().catch(showError));
  $("addAllowlistBtn").addEventListener("click", () => addAllowlist().catch(showError));
  $("installModBtn").addEventListener("click", () => installMod().catch(showError));
  $("deleteServerBtn").addEventListener("click", () => deleteServer().catch(showError));
  document.querySelectorAll("[data-command-template]").forEach((button) => {
    button.addEventListener("click", () => {
      $("commandInput").value = button.dataset.commandTemplate;
      $("commandInput").focus();
    });
  });
  $("logsBtn").addEventListener("click", () => loadLogs("panel").catch(showError));
  $("refreshLiveLogsBtn").addEventListener("click", () => refreshLiveLogs().catch(showError));
  $("refreshResourcesBtn").addEventListener("click", () => refreshResources().catch(showError));
  $("refreshLogsBtn").addEventListener("click", () => loadLogs(state.logMode).catch(showError));
  $("closeLogsBtn").addEventListener("click", () => $("logsPanel").classList.remove("open"));
  document.querySelectorAll("[data-log-mode]").forEach((button) => button.addEventListener("click", () => loadLogs(button.dataset.logMode).catch(showError)));
  $("fileUpBtn").addEventListener("click", () => loadFileList(upDir(state.fileDir)).catch(showError));
  $("saveFileBtn").addEventListener("click", () => saveFile().catch(showError));
}

function showError(error) {
  console.error(error);
  toast(error.message || "操作失败");
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

wire();
loadVersions().catch(() => {});
refresh().catch(showError);
state.liveLogTimer = setInterval(() => refreshLiveLogs().catch(() => {}), 3000);
state.resourceTimer = setInterval(() => refreshResources().catch(() => {}), 5000);

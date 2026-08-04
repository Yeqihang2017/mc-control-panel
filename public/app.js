const KEY_FIELDS = [
  ["server-name", "服务器名", "text"],
  ["server-port", "IPv4 端口", "number", { min: 1, max: 65535 }],
  ["server-portv6", "IPv6 端口", "number", { min: 1, max: 65535 }],
  ["level-name", "世界名", "text"],
  ["level-seed", "种子", "text"],
  ["gamemode", "游戏模式", "select", ["survival", "creative", "adventure"]],
  ["difficulty", "难度", "select", ["peaceful", "easy", "normal", "hard"]],
  ["max-players", "最大玩家", "number", { min: 1 }],
  ["view-distance", "视距", "number", { min: 5, max: 96 }],
  ["tick-distance", "Tick 距离", "number", { min: 4, max: 12 }],
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
  playerTimer: null,
  view: "dashboard",
  username: "",
  csrfToken: ""
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
  const method = String(options.method || "GET").toUpperCase();
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (!["GET", "HEAD", "OPTIONS"].includes(method) && state.csrfToken && !path.startsWith("/api/auth/login") && !path.startsWith("/api/auth/setup")) {
    headers["X-CSRF-Token"] = state.csrfToken;
  }
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && !path.startsWith("/api/auth/")) showAuthGate(false);
    throw new Error(data.error || response.statusText);
  }
  return data;
}

function showAuthGate(needsSetup) {
  state.username = "";
  state.csrfToken = "";
  clearInterval(state.liveLogTimer);
  clearInterval(state.resourceTimer);
  clearInterval(state.playerTimer);
  state.liveLogTimer = null;
  state.resourceTimer = null;
  state.playerTimer = null;
  $("authGate").hidden = false;
  $("appShell").hidden = true;
  $("setupForm").hidden = !needsSetup;
  $("loginForm").hidden = needsSetup;
  $("authSubtitle").textContent = needsSetup ? "首次使用，请先建立安全账户" : "使用管理员账户继续";
  $("authError").textContent = "";
  document.body.classList.add("auth-locked");
  const input = (needsSetup ? $("setupForm") : $("loginForm")).querySelector("input");
  window.setTimeout(() => input.focus(), 0);
}

function acceptAuth(data) {
  state.username = data.username;
  state.csrfToken = data.csrfToken;
  $("authGate").hidden = true;
  $("appShell").hidden = false;
  $("authError").textContent = "";
  document.body.classList.remove("auth-locked");
  $("accountSignedIn").textContent = `当前登录：${data.username}`;
  $("accountForm").elements.username.value = data.username;
}

async function submitAuthForm(event, setup) {
  event.preventDefault();
  const form = event.currentTarget;
  const body = Object.fromEntries(new FormData(form).entries());
  $("authError").textContent = "";
  const button = form.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    const data = await api(setup ? "/api/auth/setup" : "/api/auth/login", {
      method: "POST",
      body: JSON.stringify(body)
    });
    form.reset();
    acceptAuth(data);
    await startPanel();
  } catch (error) {
    $("authError").textContent = error.message || "认证失败";
  } finally {
    button.disabled = false;
  }
}

async function updateAccount(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const body = Object.fromEntries(new FormData(form).entries());
  const data = await api("/api/auth/account", { method: "PUT", body: JSON.stringify(body) });
  acceptAuth(data);
  form.elements.currentPassword.value = "";
  form.elements.newPassword.value = "";
  form.elements.confirmPassword.value = "";
  $("accountDialog").close();
  toast("管理员账户已更新，其他登录会话已失效");
}

async function logout() {
  await api("/api/auth/logout", { method: "POST", body: "{}" });
  $("accountDialog").close();
  state.servers = [];
  state.active = null;
  showAuthGate(false);
}

async function bootstrapAuth() {
  const data = await api("/api/auth/status");
  if (!data.authenticated) return showAuthGate(Boolean(data.needsSetup));
  acceptAuth(data);
  await startPanel();
}

async function startPanel() {
  await loadVersions().catch(() => {});
  await refresh();
  clearInterval(state.liveLogTimer);
  clearInterval(state.resourceTimer);
  clearInterval(state.playerTimer);
  state.liveLogTimer = setInterval(() => refreshLiveLogs().catch(() => {}), 3000);
  state.resourceTimer = setInterval(() => refreshResources().catch(() => {}), 5000);
  state.playerTimer = setInterval(() => refreshPlayers().catch(() => {}), 15000);
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
  $("serverList").innerHTML = state.servers.map((server) => {
    const cls = stateClass(server);
    const running = cls === "running";
    return `
      <div class="server-chip ${server.name === state.active ? "active" : ""}" data-server="${server.name}" role="button" tabindex="0" title="${escapeAttr(server.name)}">
        <span class="status-orb ${cls}"></span>
        <span class="chip-name">${escapeHtml(server.properties["server-name"] || server.name)}</span>
        <span class="chip-port">${escapeHtml(String(server.publishedPort || "-"))}</span>
        ${running
          ? `<button class="chip-quick" data-quick-action="stop" data-server-name="${server.name}" title="停止">■</button>`
          : `<button class="chip-quick" data-quick-action="${cls === "exited" ? "start" : "up"}" data-server-name="${server.name}" title="${cls === "exited" ? "启动" : "创建/启动"}">▶</button>`}
      </div>
    `;
  }).join("") || `<span class="strip-empty">还没有服务器</span>`;
  document.querySelectorAll("[data-server]").forEach((card) => {
    card.addEventListener("click", (event) => {
      if (event.target.closest("[data-quick-action]")) return; // 快速操作不触发选中
      selectServer(card.dataset.server);
    });
    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        selectServer(card.dataset.server);
      }
    });
  });
  function selectServer(name) {
    state.active = name;
    state.fileDir = "";
    state.activeFile = "";
    renderActive();
    renderServerList();
    // 从任意视图切到这台服务器时,若当前在聚焦面板则自动跟进
    if (state.view === "details") enterDetailsView();
    if (state.view === "console") refreshLiveLogs().catch(showError);
    refreshResources().catch(() => {});
  }
  document.querySelectorAll("[data-quick-action]").forEach((action) => {
    action.addEventListener("click", (event) => {
      event.stopPropagation();
      const serverName = action.dataset.serverName;
      doAction(action.dataset.quickAction, serverName).catch(showError);
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
    renderRestartSettings(null);
    renderFrp(null);
    $("frpLogsBox").textContent = "尚未启用 FRP。";
    $("liveLogsBox").textContent = "还没有服务器，暂无实时日志。";
    $("liveLogStatus").textContent = "等待服务器";
    const orb = $("heroOrb");
    if (orb) orb.className = "status-orb";
    renderPlayers(null);
    renderResources(null);
    return;
  }

  $("activeTitle").textContent = server.properties["server-name"] || server.name;
  $("activeSub").textContent = `${server.name} · UDP ${server.publishedPort || "-"} · ${server.status || server.state}`;
  const orb = $("heroOrb");
  if (orb) orb.className = `status-orb ${stateClass(server)}`;
  $("serverPath").textContent = server.dataPath;
  $("statusRow").innerHTML = `
    <div class="stat"><span>状态</span><strong class="stat-${stateClass(server)}">${escapeHtml(server.status || server.state)}</strong></div>
    <div class="stat"><span>端口</span><strong>${escapeHtml(String(server.publishedPort || "-"))}/udp</strong></div>
    <div class="stat"><span>世界</span><strong>${server.worlds.length}</strong></div>
    <div class="stat"><span>自定义包</span><strong>${server.behaviorPacks.length + server.resourcePacks.length}</strong></div>
    <div class="stat"><span>在线玩家</span><strong id="onlineStat">-</strong></div>
  `;
  refreshPlayers().catch(() => {});
  renderProps(server);
  renderWorlds(server);
  renderBackups(server);
  renderRestartSettings(server);
  renderFrp(server.frp);
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
  $("propsForm").innerHTML = KEY_FIELDS.map(([key, label, type, options]) => {
    const value = server.properties[key] ?? "";
    if (type === "select") {
      return `<label>${label}<select name="${key}">${options.map((item) => `<option ${item === value ? "selected" : ""}>${item}</option>`).join("")}</select></label>`;
    }
    if (type === "bool") {
      return `<label class="check"><input name="${key}" type="checkbox" ${String(value) === "true" ? "checked" : ""}> ${label}</label>`;
    }
    const constraints = type === "number" && options
      ? `${options.min !== undefined ? ` min="${options.min}"` : ""}${options.max !== undefined ? ` max="${options.max}"` : ""} step="1"`
      : "";
    return `<label>${label}<input name="${key}" type="${type}" value="${escapeAttr(value)}"${constraints}></label>`;
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
  $("consistentBackupInput").checked = settings.consistentBackup !== false;
  $("backupList").innerHTML = server.backups && server.backups.length
    ? server.backups.map((backup) => `
      <div class="backup-row">
        <div>
          <strong>${escapeHtml(backup.name)}</strong>
          <span>${backup.type === "auto" ? "自动" : "手动"} · ${new Date(backup.mtime).toLocaleString()} · ${formatBytes(backup.size)}</span>
          ${backup.location ? `<span>${escapeHtml(backup.location)}</span>` : ""}
        </div>
        <button data-restore-backup="${escapeAttr(backup.path)}">还原</button>
      </div>
    `).join("")
    : `<div class="empty-row">暂无备份</div>`;
  document.querySelectorAll("[data-restore-backup]").forEach((button) => {
    button.addEventListener("click", () => restoreListedBackup(button.dataset.restoreBackup).catch(showError));
  });
}

function renderRestartSettings(server) {
  const settings = server && server.restartSettings || {};
  const mode = settings.mode === "daily" ? "daily" : "interval";
  $("restartEnabledInput").checked = Boolean(settings.enabled);
  $("restartModeInput").value = mode;
  $("restartIntervalInput").value = settings.intervalHours || 12;
  $("restartDailyInput").value = settings.dailyTime || "04:00";
  $("restartIntervalField").hidden = mode !== "interval";
  $("restartDailyField").hidden = mode !== "daily";
  $("restartTimezone").textContent = `当前时区：${localTimezoneLabel()}`;
  $("restartPlanStatus").textContent = !settings.enabled
    ? "未启用"
    : mode === "daily"
      ? `每天 ${settings.dailyTime || "04:00"}`
      : `每 ${settings.intervalHours || 12} 小时`;
  $("restartNextRun").textContent = settings.nextRunAt ? new Date(settings.nextRunAt).toLocaleString() : "-";
  $("restartLastRun").textContent = settings.lastRunAt ? new Date(settings.lastRunAt).toLocaleString() : "尚未执行";
  const resultLabels = { never: "-", success: "成功", skipped: "已跳过", error: "失败" };
  $("restartLastResult").textContent = `${resultLabels[settings.lastResult] || "-"}${settings.lastMessage ? ` · ${settings.lastMessage}` : ""}`;
}

function localTimezoneLabel() {
  const minutesEast = -new Date().getTimezoneOffset();
  const sign = minutesEast >= 0 ? "+" : "-";
  const absolute = Math.abs(minutesEast);
  return `UTC${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}`;
}

async function saveRestartSettings() {
  const server = activeServer();
  if (!server) return;
  const data = await api(`/api/server/${server.name}/restart-schedule`, {
    method: "PUT",
    body: JSON.stringify({
      enabled: $("restartEnabledInput").checked,
      mode: $("restartModeInput").value,
      intervalHours: $("restartIntervalInput").value,
      dailyTime: $("restartDailyInput").value,
      timezoneOffsetMinutes: -new Date().getTimezoneOffset()
    })
  });
  server.restartSettings = data.settings;
  renderRestartSettings(server);
  toast("定时重启计划已保存");
}

async function refreshRestartSettings() {
  const server = activeServer();
  if (!server) return;
  const data = await api(`/api/server/${server.name}/restart-schedule`);
  server.restartSettings = data.settings;
  renderRestartSettings(server);
}

function renderFrp(frp) {
  const data = frp || { settings: {} };
  const settings = data.settings || {};
  $("frpEnabledInput").checked = Boolean(settings.enabled);
  $("frpServerAddrInput").value = settings.serverAddr || "";
  $("frpServerPortInput").value = settings.serverPort || 7000;
  $("frpRemotePortInput").value = settings.remotePort || (activeServer() && activeServer().publishedPort) || 19132;
  $("frpTlsInput").checked = settings.tlsEnabled !== false;
  $("frpTokenInput").value = "";
  $("frpTokenInput").placeholder = settings.tokenConfigured ? "令牌已保存，留空表示不修改" : "首次启用必须填写令牌";
  $("frpStatus").textContent = !settings.enabled
    ? "未启用"
    : data.running
      ? `运行中 · ${data.status || data.state}`
      : `未运行 · ${data.status || data.state || "not-created"}`;
  $("frpEndpoint").textContent = data.endpoint || "-";
  $("frpTokenStatus").textContent = settings.tokenConfigured ? "已安全保存" : "未配置";
  $("frpUpdatedAt").textContent = settings.updatedAt ? new Date(settings.updatedAt).toLocaleString() : "-";
  $("frpImageLabel").textContent = data.serviceName || "frpc";
  syncFrpFormRequirements();
}

function syncFrpFormRequirements() {
  const enabled = $("frpEnabledInput").checked;
  $("frpServerAddrInput").required = enabled;
  $("frpServerPortInput").required = enabled;
  $("frpRemotePortInput").required = enabled;
}

async function refreshFrp(loadLogs = true) {
  const server = activeServer();
  if (!server) return;
  const data = await api(`/api/server/${server.name}/frp`);
  server.frp = data;
  renderFrp(data);
  if (!loadLogs) return;
  if (!data.settings.enabled && data.state === "not-created") {
    $("frpLogsBox").textContent = "尚未启用 FRP。";
    return;
  }
  try {
    const logs = await api(`/api/server/${server.name}/frp/logs?tail=180`);
    $("frpLogsBox").textContent = logs.logs || "(暂无 frpc 日志)";
    $("frpLogsBox").scrollTop = $("frpLogsBox").scrollHeight;
  } catch (error) {
    $("frpLogsBox").textContent = error.message || "读取 frpc 日志失败";
  }
}

async function saveFrp(event) {
  event.preventDefault();
  const server = activeServer();
  const enabled = $("frpEnabledInput").checked;
  syncFrpFormRequirements();
  if (!server || !event.currentTarget.reportValidity()) return;
  const token = $("frpTokenInput").value;
  if (enabled && !token && !(server.frp && server.frp.settings && server.frp.settings.tokenConfigured)) {
    return toast("首次启用 FRP 必须填写认证令牌");
  }
  const data = await api(`/api/server/${server.name}/frp`, {
    method: "PUT",
    body: JSON.stringify({
      enabled,
      serverAddr: $("frpServerAddrInput").value.trim(),
      serverPort: $("frpServerPortInput").value,
      remotePort: $("frpRemotePortInput").value,
      token,
      tlsEnabled: $("frpTlsInput").checked
    })
  });
  server.frp = data;
  renderFrp(data);
  toast(enabled ? "FRP 配置已应用" : "FRP 穿透已停用");
  await refreshFrp(true);
}

async function frpAction(action) {
  const server = activeServer();
  if (!server) return;
  const data = await api(`/api/server/${server.name}/frp/action`, {
    method: "POST",
    body: JSON.stringify({ action })
  });
  server.frp = data;
  renderFrp(data);
  toast(`FRP ${action === "start" ? "启动" : action === "stop" ? "停止" : "重启"}操作已完成`);
  await refreshFrp(true);
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

async function doAction(action, serverName = null) {
  const server = serverName ? state.servers.find((item) => item.name === serverName) : activeServer();
  if (!server) return;
  // 智能启动：未创建时用 up 创建容器，已创建时用 start 启动
  if (action === "start" && String(server.state || "").toLowerCase() === "not-created") {
    action = "up";
  }
  await api(`/api/server/${server.name}/action`, { method: "POST", body: JSON.stringify({ action }) });
  toast(action === "up" ? "服务器已创建并启动" : "操作已发送");
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
  if (!$('propsForm').reportValidity()) return;
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
    const target = body.dataDir ? `\n\n目标目录：${body.dataDir}` : "";
    const ok = confirm(`强制覆盖会删除目标数据目录里的世界、配置、模组和备份。确定继续部署吗？${target}`);
    if (!ok) return;
  }
  await api("/api/deploy", { method: "POST", body: JSON.stringify(body) });
  toast("部署完成");
  closeLayer();
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
  const data = await api(`/api/server/${server.name}/world/backup`, { method: "POST", body: JSON.stringify({ worldName, type: "manual" }) });
  const backup = data.backup || {};
  if (backup.restartFailed) toast("世界已备份，但服务器重启失败！");
  else if (backup.consistent) toast("世界已备份（已停机保存并自动重启）");
  else toast("世界已备份");
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
      maxFiles: $("backupMaxFilesInput").value,
      consistentBackup: $("consistentBackupInput").checked
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
  openLayer("logsPanel");
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

function renderPlayers(data) {
  const players = (data && data.players) || [];
  const online = $("onlineStat");
  const box = $("onlinePlayersBox");
  const status = $("onlinePlayersStatus");
  if (!online || !box || !status) return;
  online.textContent = players.length ? String(players.length) : "-";
  box.innerHTML = players.length
    ? players.map((player) => `<span class="chip player-chip">${escapeHtml(player.name)}</span>`).join("")
    : `<span class="chip empty-chip">暂无玩家在线</span>`;
  status.textContent = data
    ? `刷新于 ${new Date().toLocaleTimeString()}`
    : "等待服务器";
}

async function refreshPlayers() {
  if (state.view !== "dashboard") return;
  const server = activeServer();
  if (!server) return renderPlayers(null);
  $("onlinePlayersStatus").textContent = "刷新中...";
  try {
    const data = await api(`/api/server/${server.name}/players`);
    renderPlayers(data);
  } catch (error) {
    renderPlayers({ players: [], message: error.message || "读取失败" });
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
  // 二级导航高亮(详情层左侧纵向列表)
  document.querySelectorAll(".detail-nav [data-tab]").forEach((button) => button.classList.toggle("selected", button.dataset.tab === tab));
  // 保留兼容旧横向 tabs 的高亮
  document.querySelectorAll(".tabs [data-tab]").forEach((button) => button.classList.toggle("selected", button.dataset.tab === tab));
  document.querySelectorAll(".tab-page").forEach((page) => page.classList.toggle("active", page.id === `tab-${tab}`));
  if (tab === "files") loadFileList(state.fileDir || "").catch(showError);
  if (tab === "restart") refreshRestartSettings().catch(showError);
  if (tab === "frp") refreshFrp(true).catch(showError);
}

function openLayer(id) {
  document.querySelectorAll(".focus-layer").forEach((layer) => layer.classList.remove("active"));
  $(id).classList.add("active");
  document.body.classList.add("layer-open");
  const layer = $(id);
  if (layer) layer.scrollTop = 0;
}

function closeLayer() {
  document.querySelectorAll(".focus-layer").forEach((layer) => layer.classList.remove("active"));
  document.body.classList.remove("layer-open");
}

function enterDetailsView() {
  const server = activeServer();
  if (!server) return toast("请选择服务器");
  state.view = "details";
  openLayer("detailsPanel");
  $("activeTitle").textContent = "服务器详情";
  $("activeSub").textContent = `${server.name} · ${server.properties["server-name"] || server.name}`;
  switchTab(state.tab);
}

function leaveDetailsView() {
  state.view = "dashboard";
  closeLayer();
  renderActive();
}

function enterConsoleView() {
  const server = activeServer();
  if (!server) return toast("请选择服务器");
  state.view = "console";
  openLayer("consolePanel");
  $("activeTitle").textContent = "控制台";
  $("activeSub").textContent = `${server.name} · ${server.properties["server-name"] || server.name}`;
  refreshLiveLogs().catch(showError);
}

function leaveConsoleView() {
  state.view = "dashboard";
  closeLayer();
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
  $("setupForm").addEventListener("submit", (event) => submitAuthForm(event, true));
  $("loginForm").addEventListener("submit", (event) => submitAuthForm(event, false));
  $("accountBtn").addEventListener("click", () => {
    $("accountForm").elements.username.value = state.username;
    $("accountSignedIn").textContent = `当前登录：${state.username}`;
    $("accountDialog").showModal();
  });
  $("closeAccountBtn").addEventListener("click", () => $("accountDialog").close());
  $("logoutBtn").addEventListener("click", () => logout().catch(showError));
  $("accountForm").addEventListener("submit", (event) => updateAccount(event).catch(showError));
  $("refreshBtn").addEventListener("click", () => refresh().catch(showError));
  $("refreshWorldsBtn").addEventListener("click", () => refresh().catch(showError));
  $("showDeployBtn").addEventListener("click", () => openLayer("deployPanel"));
  $("hideDeployBtn").addEventListener("click", () => closeLayer());
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
  $("restartModeInput").addEventListener("change", () => renderRestartSettings({ restartSettings: {
    ...(activeServer() && activeServer().restartSettings || {}),
    enabled: $("restartEnabledInput").checked,
    mode: $("restartModeInput").value,
    intervalHours: $("restartIntervalInput").value,
    dailyTime: $("restartDailyInput").value
  } }));
  $("saveRestartSettingsBtn").addEventListener("click", () => saveRestartSettings().catch(showError));
  $("frpEnabledInput").addEventListener("change", syncFrpFormRequirements);
  $("frpForm").addEventListener("submit", (event) => saveFrp(event).catch(showError));
  $("refreshFrpBtn").addEventListener("click", () => refreshFrp(true).catch(showError));
  document.querySelectorAll("[data-frp-action]").forEach((button) => {
    button.addEventListener("click", () => frpAction(button.dataset.frpAction).catch(showError));
  });
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
  $("closeLogsBtn").addEventListener("click", () => closeLayer());
  document.querySelectorAll("[data-log-mode]").forEach((button) => button.addEventListener("click", () => loadLogs(button.dataset.logMode).catch(showError)));
  $("refreshPlayersBtn").addEventListener("click", () => refreshPlayers().catch(showError));
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
bootstrapAuth().catch((error) => {
  showAuthGate(false);
  $("authError").textContent = error.message || "无法连接面板";
});

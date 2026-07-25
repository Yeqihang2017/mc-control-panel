const http = require("http");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { execFile } = require("child_process");

const APP_ROOT = path.resolve(__dirname);
const DATA_ROOT = path.resolve(process.env.PANEL_DATA_DIR || APP_ROOT);
const HOST_DATA_ROOT = process.env.PANEL_HOST_DATA_DIR || DATA_ROOT;
const SERVERS_DIR = path.join(DATA_ROOT, "servers");
const COMPOSE_FILE = path.join(DATA_ROOT, "compose.yml");
const PUBLIC_DIR = path.join(APP_ROOT, "public");
const LOG_FILE = path.join(DATA_ROOT, "panel.log");
const HOST = process.env.PANEL_HOST || "0.0.0.0";
const PORT = Number(process.env.PANEL_PORT || 8787);
const MAX_BODY_BYTES = 300 * 1024 * 1024;

const KEY_PROPS = [
  "server-name",
  "gamemode",
  "force-gamemode",
  "difficulty",
  "allow-cheats",
  "max-players",
  "online-mode",
  "allow-list",
  "server-port",
  "server-portv6",
  "enable-lan-visibility",
  "view-distance",
  "tick-distance",
  "level-name",
  "level-seed",
  "default-player-permission-level",
  "texturepack-required"
];

const BEDROCK_VERSIONS = [
  "LATEST",
  "1.26.33.2",
  "1.26.33.1",
  "1.26.31.1",
  "1.21.130",
  "1.21.120",
  "1.21.110",
  "1.21.100"
];

const DEFAULT_PACK_PATTERNS = [
  /^vanilla(?:_|$)/i,
  /^chemistry(?:_|$)/i,
  /^editor$/i,
  /^server(?:_|-)?(?:ui_)?library$/i,
  /^experimental_/i
];

const DEFAULT_BACKUP_SETTINGS = {
  backupDir: "backups",
  autoEnabled: false,
  intervalMinutes: 30,
  maxFiles: 10
};

const backupTimers = new Map();

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function trimLog(value) {
  return String(value || "").slice(-5000);
}

function logEvent(level, message, meta = {}) {
  const entry = { time: new Date().toISOString(), level, message, meta };
  console.log(`[${entry.time}] ${level.toUpperCase()} ${message}`);
  fsp.appendFile(LOG_FILE, JSON.stringify(entry) + "\n", "utf8").catch(() => {});
}

function run(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, {
      cwd: options.cwd || DATA_ROOT,
      windowsHide: true,
      maxBuffer: options.maxBuffer || 30 * 1024 * 1024
    }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

async function dockerCompose(args, options = {}) {
  await ensurePanelCompose();
  logEvent("debug", `docker compose ${args.join(" ")}`);
  try {
    return await run("docker", ["compose", "-f", COMPOSE_FILE, ...args], options);
  } catch (error) {
    logEvent("error", `docker compose ${args.join(" ")} failed`, {
      message: error.message,
      stdout: trimLog(error.stdout),
      stderr: trimLog(error.stderr)
    });
    throw error;
  }
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

async function exists(target) {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

async function ensurePanelCompose() {
  await ensureDir(DATA_ROOT);
  await ensureDir(SERVERS_DIR);
  if (await exists(COMPOSE_FILE)) return;
  await fsp.writeFile(COMPOSE_FILE, "name: mc-panel-servers\nservices: {}\n", "utf8");
}

function slugify(input, fallback = "server") {
  const value = String(input || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 44);
  return value || fallback;
}

function assertServiceName(name) {
  if (!/^[a-z0-9][a-z0-9-]{1,60}$/.test(name || "")) {
    throw httpError(400, "服务名只能包含小写字母、数字和短横线。");
  }
}

function assertPort(value, label) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw httpError(400, `${label} 必须是 1-65535 的整数。`);
  }
  return port;
}

function safePath(base, relativePath = "") {
  const baseResolved = path.resolve(base);
  const target = path.resolve(baseResolved, String(relativePath || "."));
  if (target !== baseResolved && !target.startsWith(baseResolved + path.sep)) {
    throw httpError(400, "路径越界，已拒绝。");
  }
  return target;
}

function dockerBindPath(localPath) {
  const relative = path.relative(DATA_ROOT, localPath);
  return path.join(HOST_DATA_ROOT, relative).replace(/\\/g, "/");
}

function panelPathFromDockerBind(sourcePath) {
  const source = String(sourcePath || "").replace(/\\/g, "/");
  const hostRoot = String(HOST_DATA_ROOT || "").replace(/\\/g, "/").replace(/\/+$/, "");
  if (hostRoot && (source === hostRoot || source.startsWith(hostRoot + "/"))) {
    const relative = source.slice(hostRoot.length).replace(/^\/+/, "");
    return path.join(DATA_ROOT, relative);
  }
  return path.resolve(sourcePath);
}

function parseProperties(text) {
  const out = {};
  for (const line of String(text || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx === -1) continue;
    out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return out;
}

function writePropertiesPreserving(text, updates) {
  const lines = String(text || "").split(/\r?\n/);
  const seen = new Set();
  const next = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !line.includes("=")) return line;
    const idx = line.indexOf("=");
    const key = line.slice(0, idx).trim();
    if (!Object.prototype.hasOwnProperty.call(updates, key)) return line;
    seen.add(key);
    return `${key}=${updates[key]}`;
  });
  for (const [key, value] of Object.entries(updates)) {
    if (!seen.has(key)) next.push(`${key}=${value}`);
  }
  return next.join("\n").replace(/\n*$/, "\n");
}

function defaultProperties(form) {
  const port = Number(form.port);
  const portV6 = Number(form.portV6 || port + 1);
  return {
    "server-name": form.displayName || form.serviceName || `Bedrock ${port}`,
    gamemode: form.gamemode || "survival",
    "force-gamemode": String(Boolean(form.forceGamemode)),
    difficulty: form.difficulty || "normal",
    "allow-cheats": String(Boolean(form.allowCheats)),
    "max-players": String(Number(form.maxPlayers || 10)),
    "online-mode": String(form.onlineMode !== false),
    "allow-list": String(Boolean(form.allowList)),
    "server-port": String(port),
    "server-portv6": String(portV6),
    "enable-lan-visibility": String(form.enableLanVisibility !== false),
    "view-distance": String(Number(form.viewDistance || 32)),
    "tick-distance": String(Number(form.tickDistance || 4)),
    "player-idle-timeout": "30",
    "level-name": form.levelName || "Bedrock level",
    "level-seed": form.levelSeed || "",
    "default-player-permission-level": form.permission || "member",
    "texturepack-required": String(Boolean(form.texturepackRequired)),
    "content-log-file-enabled": "false",
    "content-log-console-output-enabled": "false"
  };
}

function pick(object, keys) {
  const out = {};
  for (const key of keys) out[key] = object[key] ?? "";
  return out;
}

async function getComposeConfig() {
  const { stdout } = await dockerCompose(["config", "--format", "json"]);
  return JSON.parse(stdout);
}

async function getPsRows() {
  const { stdout } = await dockerCompose(["ps", "--format", "json"]);
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function isMinecraftService(service) {
  return String(service.image || "").includes("minecraft-bedrock-server")
    && (service.volumes || []).some((volume) => volume.target === "/data");
}

function dataPathOf(service) {
  const volume = (service.volumes || []).find((item) => item.target === "/data");
  return volume && volume.source ? panelPathFromDockerBind(volume.source) : null;
}

async function readServerProperties(dataPath) {
  const file = path.join(dataPath, "server.properties");
  if (!(await exists(file))) return {};
  return parseProperties(await fsp.readFile(file, "utf8"));
}

async function listDirectories(dir) {
  if (!(await exists(dir))) return [];
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

function isDefaultPack(name) {
  return DEFAULT_PACK_PATTERNS.some((pattern) => pattern.test(String(name || "")));
}

async function listUserPacks(dir) {
  return (await listDirectories(dir)).filter((name) => !isDefaultPack(name));
}

async function listFilesFlat(dir, exts = null) {
  if (!(await exists(dir))) return [];
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .filter((entry) => !exts || exts.some((ext) => entry.name.toLowerCase().endsWith(ext)))
    .map((entry) => entry.name)
    .sort();
}

async function readJsonFile(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

function backupSettingsPath(dataPath) {
  return path.join(dataPath, "backup-settings.json");
}

function normalizeBackupSettings(settings = {}) {
  const intervalMinutes = Math.max(1, Math.min(1440, Number(settings.intervalMinutes || DEFAULT_BACKUP_SETTINGS.intervalMinutes)));
  const maxFiles = Math.max(1, Math.min(500, Number(settings.maxFiles || DEFAULT_BACKUP_SETTINGS.maxFiles)));
  return {
    backupDir: String(settings.backupDir || DEFAULT_BACKUP_SETTINGS.backupDir).trim() || DEFAULT_BACKUP_SETTINGS.backupDir,
    autoEnabled: Boolean(settings.autoEnabled),
    intervalMinutes,
    maxFiles
  };
}

async function getBackupSettings(dataPath) {
  return normalizeBackupSettings(await readJsonFile(backupSettingsPath(dataPath), DEFAULT_BACKUP_SETTINGS));
}

function resolveBackupRoot(dataPath, backupDir) {
  const value = String(backupDir || DEFAULT_BACKUP_SETTINGS.backupDir).trim();
  if (path.isAbsolute(value)) {
    const target = path.resolve(value);
    const relative = path.relative(DATA_ROOT, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw httpError(400, "备份目录必须位于面板数据目录内。");
    }
    return target;
  }
  return safePath(dataPath, value);
}

async function getBackupDirs(dataPath, settings = null) {
  const effective = settings || await getBackupSettings(dataPath);
  const root = resolveBackupRoot(dataPath, effective.backupDir);
  return {
    root,
    manual: path.join(root, "manual"),
    auto: path.join(root, "auto")
  };
}

async function listBackupEntries(dataPath, limit = 12) {
  const settings = await getBackupSettings(dataPath);
  const dirs = await getBackupDirs(dataPath, settings);
  const entries = [];
  for (const type of ["manual", "auto"]) {
    await ensureDir(dirs[type]);
    for (const name of await listFilesFlat(dirs[type], [".zip"])) {
      const file = path.join(dirs[type], name);
      const stat = await fsp.stat(file).catch(() => null);
      if (!stat) continue;
      entries.push({
        name,
        type,
        path: path.relative(DATA_ROOT, file).replace(/\\/g, "/"),
        size: stat.size,
        mtime: stat.mtime.toISOString()
      });
    }
  }
  return entries.sort((a, b) => new Date(b.mtime) - new Date(a.mtime)).slice(0, limit);
}

async function readAllowlist(dataPath) {
  const list = await readJsonFile(path.join(dataPath, "allowlist.json"), []);
  return Array.isArray(list) ? list : [];
}

async function listServers() {
  const [config, psRows] = await Promise.all([getComposeConfig(), getPsRows().catch(() => [])]);
  const psByService = new Map(psRows.map((row) => [row.Service, row]));
  const servers = [];
  for (const [name, service] of Object.entries(config.services || {})) {
    if (!isMinecraftService(service)) continue;
    const dataPath = dataPathOf(service);
    const props = await readServerProperties(dataPath);
    const status = psByService.get(name) || {};
    const port = (service.ports || [])[0];
    servers.push({
      name,
      containerName: service.container_name || "",
      image: service.image,
      state: status.State || "not-created",
      health: status.Health || "",
      status: status.Status || "",
      ports: service.ports || [],
      publishedPort: port ? port.published : props["server-port"],
      dataPath,
      properties: pick(props, KEY_PROPS),
      worlds: await listDirectories(path.join(dataPath, "worlds")),
      backups: await listBackupEntries(dataPath),
      backupSettings: await getBackupSettings(dataPath),
      allowlist: await readAllowlist(dataPath),
      behaviorPacks: await listUserPacks(path.join(dataPath, "behavior_packs")),
      resourcePacks: await listUserPacks(path.join(dataPath, "resource_packs"))
    });
  }
  return servers.sort((a, b) => String(a.publishedPort).localeCompare(String(b.publishedPort), undefined, { numeric: true }));
}

async function getServer(name) {
  assertServiceName(name);
  const config = await getComposeConfig();
  const service = config.services && config.services[name];
  if (!service || !isMinecraftService(service)) throw httpError(404, "没有找到这个 Minecraft 服务。");
  return { name, service, dataPath: dataPathOf(service) };
}

function removeServiceFromComposeText(text, serviceName) {
  const lines = String(text || "").split(/\r?\n/);
  const out = [];
  let skipping = false;
  let removed = false;
  const startPattern = new RegExp(`^  ${serviceName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\s*$`);

  for (const line of lines) {
    if (!skipping && startPattern.test(line)) {
      skipping = true;
      removed = true;
      continue;
    }
    if (skipping && /^  [A-Za-z0-9][A-Za-z0-9-]*:\s*$/.test(line)) {
      skipping = false;
    }
    if (!skipping) out.push(line);
  }

  if (!removed) throw httpError(404, "compose 中没有找到这个服务块。");
  const bodyLines = out.filter((line) => /^  [A-Za-z0-9][A-Za-z0-9-]*:\s*$/.test(line));
  let next = out.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s*$/, "\n");
  if (!bodyLines.length) next = next.replace(/services:\s*\n+$/m, "services: {}\n");
  return next;
}

async function deleteServer(name, body) {
  if (body.confirmName !== name) throw httpError(400, "请输入完全一致的服务器名确认删除。");
  const { dataPath } = await getServer(name);
  const composeBefore = await fsp.readFile(COMPOSE_FILE, "utf8");

  await dockerCompose(["rm", "-s", "-f", "-v", name], { maxBuffer: 30 * 1024 * 1024 }).catch((error) => {
    logEvent("warn", "docker compose rm failed during delete", {
      service: name,
      message: error.message,
      stderr: trimLog(error.stderr)
    });
  });

  await fsp.writeFile(COMPOSE_FILE, removeServiceFromComposeText(composeBefore, name), "utf8");

  if (body.deleteDataDir) {
    const relative = path.relative(SERVERS_DIR, dataPath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw httpError(400, "数据目录不在面板 servers 目录内，已拒绝删除。");
    }
    await fsp.rm(dataPath, { recursive: true, force: true });
  }

  logEvent("warn", "deleted server", { service: name, dataPath, deleteDataDir: Boolean(body.deleteDataDir) });
  return { ok: true };
}

async function saveServerProperties(dataPath, updates) {
  const file = path.join(dataPath, "server.properties");
  const oldText = await exists(file) ? await fsp.readFile(file, "utf8") : "";
  const next = writePropertiesPreserving(oldText, updates);
  await fsp.writeFile(file, next, "utf8");
  logEvent("info", "saved server.properties", { file });
  return parseProperties(next);
}

async function deployServer(body) {
  const port = assertPort(body.port, "IPv4 端口");
  const portV6 = assertPort(body.portV6 || port + 1, "IPv6 端口");
  const requested = body.serviceName ? slugify(body.serviceName) : `bedrock-${port}`;
  const serviceName = requested.startsWith("bedrock-") ? requested : `bedrock-${requested}`;
  assertServiceName(serviceName);

  const config = await getComposeConfig();
  if (config.services && config.services[serviceName]) throw httpError(409, "compose 中已经存在同名服务。");
  for (const service of Object.values(config.services || {})) {
    for (const servicePort of service.ports || []) {
      if (String(servicePort.published) === String(port)) throw httpError(409, `端口 ${port} 已被服务占用。`);
    }
  }

  const dataDirName = slugify(body.folderName || serviceName, serviceName);
  const dataDir = path.join(SERVERS_DIR, dataDirName);
  if (await exists(dataDir)) {
    if (!body.forceOverwriteDataDir) {
      throw httpError(409, `数据目录已存在：${dataDir}`);
    }
    await fsp.rm(dataDir, { recursive: true, force: true });
    logEvent("warn", "force overwritten data directory", { serviceName, dataDir });
  }
  await ensureDir(path.join(dataDir, "worlds"));
  await ensureDir(path.join(dataDir, "backups", "panel"));
  await ensureDir(path.join(dataDir, "behavior_packs"));
  await ensureDir(path.join(dataDir, "resource_packs"));

  const properties = defaultProperties({ ...body, serviceName, port, portV6 });
  await fsp.writeFile(
    path.join(dataDir, "server.properties"),
    Object.entries(properties).map(([key, value]) => `${key}=${value}`).join("\n") + "\n",
    "utf8"
  );

  const composeBefore = await fsp.readFile(COMPOSE_FILE, "utf8");
  const dataVolume = dockerBindPath(dataDir);
  const version = String(body.version || "LATEST").trim();
  if (!BEDROCK_VERSIONS.includes(version)) throw httpError(400, "请选择有效的 Bedrock 版本。");
  const block = [
    "",
    `  ${serviceName}:`,
    "    image: itzg/minecraft-bedrock-server:latest",
    `    container_name: mc-panel-${serviceName}`,
    "    restart: unless-stopped",
    "    stdin_open: true",
    "    tty: true",
    "    ports:",
    `      - \"${port}:${port}/udp\"`,
    "    environment:",
    "      EULA: \"TRUE\"",
    `      VERSION: \"${version}\"`,
    `      SERVER_PORT: \"${port}\"`,
    `      SERVER_PORT_V6: \"${portV6}\"`,
    "    volumes:",
    `      - \"${dataVolume}:/data\"`,
    ""
  ].join("\n");
  const composeBase = composeBefore.replace(/services:\s*\{\}\s*$/m, "services:").replace(/\s*$/, "\n");
  await fsp.writeFile(COMPOSE_FILE, composeBase + block, "utf8");

  try {
    await dockerCompose(["config"]);
    await dockerCompose(["up", "-d", serviceName], { maxBuffer: 80 * 1024 * 1024 });
    logEvent("info", "deployed server", { serviceName, port, dataDir, dataVolume });
  } catch (error) {
    await fsp.writeFile(COMPOSE_FILE, composeBefore, "utf8");
    throw httpError(500, `部署失败，已回滚 compose：${error.stderr || error.message}`);
  }
  return { serviceName, dataPath: dataDir };
}

async function zipDirectory(sourceDir, zipPath) {
  if (process.platform === "win32") {
    const psQuote = (value) => `'${String(value).replace(/'/g, "''")}'`;
    await run("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `Compress-Archive -LiteralPath ${psQuote(sourceDir)} -DestinationPath ${psQuote(zipPath)} -Force`
    ], { maxBuffer: 80 * 1024 * 1024 });
  } else {
    await run("zip", ["-r", zipPath, "."], { cwd: sourceDir, maxBuffer: 80 * 1024 * 1024 });
  }
}

async function backupWorld(dataPath, worldName, type = "manual") {
  if (!worldName) throw httpError(400, "请选择世界。");
  const worldPath = safePath(path.join(dataPath, "worlds"), worldName);
  const stat = await fsp.stat(worldPath).catch(() => null);
  if (!stat || !stat.isDirectory()) throw httpError(404, "世界目录不存在。");
  const settings = await getBackupSettings(dataPath);
  const dirs = await getBackupDirs(dataPath, settings);
  const backupDir = type === "auto" ? dirs.auto : dirs.manual;
  await ensureDir(backupDir);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const zipPath = path.join(backupDir, `${slugify(worldName)}-${stamp}.zip`);
  await zipDirectory(worldPath, zipPath);
  if (type === "auto") await pruneAutoBackups(dataPath, settings);
  const backup = {
    name: path.basename(zipPath),
    type,
    path: path.relative(DATA_ROOT, zipPath).replace(/\\/g, "/"),
    size: (await fsp.stat(zipPath)).size,
    mtime: new Date().toISOString()
  };
  logEvent("info", "backed up world", { worldName, zipPath, type });
  return backup;
}

async function pruneAutoBackups(dataPath, settings = null) {
  const effective = settings || await getBackupSettings(dataPath);
  const dirs = await getBackupDirs(dataPath, effective);
  const entries = [];
  for (const name of await listFilesFlat(dirs.auto, [".zip"])) {
    const file = path.join(dirs.auto, name);
    const stat = await fsp.stat(file).catch(() => null);
    if (stat) entries.push({ file, mtime: stat.mtime });
  }
  entries.sort((a, b) => b.mtime - a.mtime);
  for (const old of entries.slice(effective.maxFiles)) {
    await fsp.rm(old.file, { force: true }).catch(() => {});
    logEvent("info", "pruned auto backup", { file: old.file });
  }
}

async function deleteWorld(dataPath, body) {
  const worldName = body.worldName;
  const backup = body.backupFirst ? await backupWorld(dataPath, worldName, "manual") : null;
  await fsp.rm(safePath(path.join(dataPath, "worlds"), worldName), { recursive: true, force: true });
  logEvent("info", "deleted world", { worldName, backupName: backup && backup.name });
  return { deleted: worldName, backupName: backup && backup.name };
}

async function newWorld(dataPath, body) {
  const worldName = String(body.worldName || "").trim();
  if (!worldName || /[\\/:*?"<>|\r\n\t\f]/.test(worldName)) {
    throw httpError(400, "世界名不能为空，也不能包含 Windows 文件名非法字符。");
  }
  const updates = { "level-name": worldName };
  if (Object.prototype.hasOwnProperty.call(body, "levelSeed")) updates["level-seed"] = String(body.levelSeed || "");
  await saveServerProperties(dataPath, updates);
  logEvent("info", "configured new world", { worldName });
  return { worldName };
}

async function expandArchive(zipPath, destination) {
  await ensureDir(destination);
  if (process.platform === "win32") {
    const psQuote = (value) => `'${String(value).replace(/'/g, "''")}'`;
    await run("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `Expand-Archive -LiteralPath ${psQuote(zipPath)} -DestinationPath ${psQuote(destination)} -Force`
    ], { maxBuffer: 80 * 1024 * 1024 });
  } else {
    await run("unzip", ["-o", zipPath, "-d", destination], { maxBuffer: 80 * 1024 * 1024 });
  }
}

async function saveUploadToTemp(fileName, contentBase64) {
  if (!contentBase64) throw httpError(400, "没有收到上传文件。");
  const tempDir = path.join(DATA_ROOT, ".panel-tmp");
  await ensureDir(tempDir);
  const raw = String(contentBase64).replace(/^data:[^,]+,/, "");
  const buffer = Buffer.from(raw, "base64");
  if (!buffer.length) throw httpError(400, "上传文件为空。");
  const safeName = slugify(path.basename(fileName, path.extname(fileName)), "upload");
  const file = path.join(tempDir, `${safeName}-${Date.now()}.zip`);
  await fsp.writeFile(file, buffer);
  return { file };
}

async function findDirectoriesContaining(root, fileName, found = []) {
  const entries = await fsp.readdir(root, { withFileTypes: true });
  if (entries.some((entry) => entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase())) found.push(root);
  for (const entry of entries) {
    if (entry.isDirectory()) await findDirectoriesContaining(path.join(root, entry.name), fileName, found);
  }
  return found;
}

async function replaceWorldFromZip(dataPath, body) {
  const targetName = String(body.targetWorldName || "").trim();
  if (!targetName || /[\\/:*?"<>|\r\n\t\f]/.test(targetName)) throw httpError(400, "目标世界名不合法。");
  const { file } = await saveUploadToTemp(body.fileName, body.contentBase64);
  return await restoreWorldFromZip(dataPath, file, targetName, Boolean(body.replaceExisting), true);
}

async function restoreWorldFromZip(dataPath, zipFile, targetName, replaceExisting = true, cleanupZip = false) {
  const extractDir = zipFile.replace(/\.zip$/, "-expanded");
  await expandArchive(zipFile, extractDir);
  const worldDirs = await findDirectoriesContaining(extractDir, "level.dat");
  let source = worldDirs[0];
  if (!source) {
    const entries = (await fsp.readdir(extractDir, { withFileTypes: true })).filter((entry) => entry.isDirectory());
    if (entries.length === 1) source = path.join(extractDir, entries[0].name);
  }
  if (!source) throw httpError(400, "???????? Bedrock ???? level.dat?");
  const target = safePath(path.join(dataPath, "worlds"), targetName);
  const targetExists = await exists(target);
  let backupName = null;
  if (targetExists) {
    if (!replaceExisting) throw httpError(409, "????????");
    const backup = await backupWorld(dataPath, targetName, "manual");
    backupName = backup.name;
    await fsp.rm(target, { recursive: true, force: true });
  }
  await fsp.cp(source, target, { recursive: true });
  await fsp.rm(extractDir, { recursive: true, force: true }).catch(() => {});
  if (cleanupZip) await fsp.rm(zipFile, { force: true }).catch(() => {});
  logEvent("info", "restored world", { targetName, backupName, zipFile });
  return { worldName: targetName, backupName };
}

function backupFileFromRelative(relativePath) {
  const file = safePath(DATA_ROOT, relativePath);
  if (!file.toLowerCase().endsWith(".zip")) throw httpError(400, "???? zip ?????");
  return file;
}

async function restoreBackup(dataPath, body) {
  const targetName = String(body.targetWorldName || "").trim();
  if (!targetName || /[\\/:*?"<>|\r\n\t\f]/.test(targetName)) throw httpError(400, "?????????");
  const file = backupFileFromRelative(body.backupPath || "");
  if (!(await exists(file))) throw httpError(404, "????????");
  return await restoreWorldFromZip(dataPath, file, targetName, true, false);
}

async function saveBackupSettings(dataPath, body) {
  const settings = normalizeBackupSettings(body || {});
  const dirs = await getBackupDirs(dataPath, settings);
  await ensureDir(dirs.manual);
  await ensureDir(dirs.auto);
  await fsp.writeFile(backupSettingsPath(dataPath), JSON.stringify(settings, null, 2) + "\n", "utf8");
  logEvent("info", "saved backup settings", { dataPath, settings });
  await refreshBackupSchedules();
  return settings;
}

async function chooseAutoBackupWorld(dataPath) {
  const props = await readServerProperties(dataPath);
  const worlds = await listDirectories(path.join(dataPath, "worlds"));
  if (props["level-name"] && worlds.includes(props["level-name"])) return props["level-name"];
  return worlds[0] || "";
}

async function runAutoBackup(serviceName, dataPath) {
  try {
    const worldName = await chooseAutoBackupWorld(dataPath);
    if (!worldName) return logEvent("warn", "auto backup skipped: no world", { serviceName });
    await backupWorld(dataPath, worldName, "auto");
  } catch (error) {
    logEvent("error", "auto backup failed", { serviceName, message: error.message });
  }
}

async function refreshBackupSchedules() {
  const config = await getComposeConfig();
  const wanted = new Set();
  for (const [name, service] of Object.entries(config.services || {})) {
    if (!isMinecraftService(service)) continue;
    const dataPath = dataPathOf(service);
    const settings = await getBackupSettings(dataPath);
    wanted.add(name);
    const current = backupTimers.get(name);
    const intervalMs = settings.intervalMinutes * 60 * 1000;
    if (!settings.autoEnabled) {
      if (current) clearInterval(current.timer);
      backupTimers.delete(name);
      continue;
    }
    if (current && current.intervalMs === intervalMs && current.dataPath === dataPath) continue;
    if (current) clearInterval(current.timer);
    const timer = setInterval(() => runAutoBackup(name, dataPath), intervalMs);
    backupTimers.set(name, { timer, intervalMs, dataPath });
    logEvent("info", "scheduled auto backup", { serviceName: name, intervalMinutes: settings.intervalMinutes });
  }
  for (const [name, current] of backupTimers.entries()) {
    if (!wanted.has(name)) {
      clearInterval(current.timer);
      backupTimers.delete(name);
    }
  }
}

async function writeAllowlist(dataPath, list) {
  await fsp.writeFile(path.join(dataPath, "allowlist.json"), JSON.stringify(list, null, 2) + "\n", "utf8");
}

async function addAllowlistEntry(dataPath, body) {
  const name = String(body.name || "").trim();
  if (!name) throw httpError(400, "???????");
  const list = await readAllowlist(dataPath);
  const existing = list.find((item) => String(item.name || "").toLowerCase() === name.toLowerCase());
  if (existing) existing.ignoresPlayerLimit = Boolean(body.ignoresPlayerLimit);
  else list.push({ name, xuid: String(body.xuid || ""), ignoresPlayerLimit: Boolean(body.ignoresPlayerLimit) });
  await writeAllowlist(dataPath, list);
  logEvent("info", "updated allowlist", { name });
  return { allowlist: list };
}

async function removeAllowlistEntry(dataPath, body) {
  const name = String(body.name || "").trim();
  const list = (await readAllowlist(dataPath)).filter((item) => String(item.name || "").toLowerCase() !== name.toLowerCase());
  await writeAllowlist(dataPath, list);
  logEvent("info", "removed allowlist entry", { name });
  return { allowlist: list };
}
async function installPacks(dataPath, body) {
  const { file } = await saveUploadToTemp(body.fileName, body.contentBase64);
  const extractDir = file.replace(/\.zip$/, "-expanded");
  await expandArchive(file, extractDir);
  const manifestDirs = await findDirectoriesContaining(extractDir, "manifest.json");
  if (!manifestDirs.length) throw httpError(400, "没有在上传包中找到 manifest.json。");
  const installed = [];
  for (const dir of manifestDirs) {
    const manifest = JSON.parse(await fsp.readFile(path.join(dir, "manifest.json"), "utf8"));
    const moduleTypes = (manifest.modules || []).map((mod) => String(mod.type || "").toLowerCase());
    const isResource = moduleTypes.some((type) => type.includes("resources"));
    const targetRoot = isResource ? path.join(dataPath, "resource_packs") : path.join(dataPath, "behavior_packs");
    await ensureDir(targetRoot);
    const folderBase = slugify((manifest.header && manifest.header.name) || path.basename(dir), path.basename(dir));
    let target = path.join(targetRoot, folderBase);
    let n = 2;
    while (await exists(target)) target = path.join(targetRoot, `${folderBase}-${n++}`);
    await fsp.cp(dir, target, { recursive: true });
    if (body.activateWorld) await upsertWorldPack(dataPath, body.activateWorld, isResource ? "resource" : "behavior", manifest);
    installed.push({ name: path.basename(target), type: path.basename(targetRoot), activatedWorld: body.activateWorld || "" });
  }
  await fsp.rm(extractDir, { recursive: true, force: true }).catch(() => {});
  await fsp.rm(file, { force: true }).catch(() => {});
  logEvent("info", "installed packs", { installed });
  return { installed };
}

async function upsertWorldPack(dataPath, worldName, type, manifest) {
  const header = manifest.header || {};
  if (!header.uuid || !Array.isArray(header.version)) return;
  const worldPath = safePath(path.join(dataPath, "worlds"), worldName);
  const stat = await fsp.stat(worldPath).catch(() => null);
  if (!stat || !stat.isDirectory()) return;
  const file = path.join(worldPath, type === "resource" ? "world_resource_packs.json" : "world_behavior_packs.json");
  let packs = [];
  if (await exists(file)) {
    try {
      packs = JSON.parse(await fsp.readFile(file, "utf8"));
      if (!Array.isArray(packs)) packs = [];
    } catch {
      packs = [];
    }
  }
  const packId = String(header.uuid);
  const entry = { pack_id: packId, version: header.version };
  const index = packs.findIndex((pack) => String(pack.pack_id).toLowerCase() === packId.toLowerCase());
  if (index >= 0) packs[index] = entry;
  else packs.push(entry);
  await fsp.writeFile(file, JSON.stringify(packs, null, 2) + "\n", "utf8");
}

async function listFiles(dataPath, relativePath) {
  const dir = safePath(dataPath, relativePath);
  const stat = await fsp.stat(dir).catch(() => null);
  if (!stat || !stat.isDirectory()) throw httpError(404, "目录不存在。");
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const relBase = path.relative(dataPath, dir);
  return entries
    .filter((entry) => !entry.name.startsWith(".tmp"))
    .map((entry) => ({
      name: entry.name,
      path: path.join(relBase, entry.name).replace(/\\/g, "/"),
      type: entry.isDirectory() ? "dir" : "file"
    }))
    .sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
}

async function readFile(dataPath, relativePath) {
  const file = safePath(dataPath, relativePath);
  const stat = await fsp.stat(file).catch(() => null);
  if (!stat || !stat.isFile()) throw httpError(404, "文件不存在。");
  if (stat.size > 2 * 1024 * 1024) throw httpError(413, "文件超过 2MB，不适合在面板中编辑。");
  return await fsp.readFile(file, "utf8");
}

async function writeFile(dataPath, relativePath, content) {
  const file = safePath(dataPath, relativePath);
  await ensureDir(path.dirname(file));
  await fsp.writeFile(file, String(content || ""), "utf8");
  logEvent("info", "saved file", { file });
}

async function sendServerCommand(name, command) {
  const clean = String(command || "").trim().replace(/^\/+/, "");
  if (!clean) throw httpError(400, "请输入要发送的游戏指令。");
  if (clean.length > 500) throw httpError(400, "指令太长。");
  const result = await dockerCompose(["exec", "-T", name, "send-command", clean], { maxBuffer: 10 * 1024 * 1024 });
  logEvent("info", "sent server command", { service: name, command: clean, output: trimLog(result.stdout || result.stderr) });
  return { output: result.stdout || result.stderr || "指令已发送。" };
}

async function getServerResources(name) {
  const { service } = await getServer(name);
  const container = service.container_name || `mc-panel-${name}`;
  try {
    const { stdout } = await run("docker", ["stats", "--no-stream", "--format", "json", container], { maxBuffer: 2 * 1024 * 1024 });
    const line = stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)[0];
    if (!line) return { available: false, container, message: "容器未运行或暂无资源数据。" };
    const stats = JSON.parse(line);
    return {
      available: true,
      container,
      cpu: stats.CPUPerc || "",
      memory: stats.MemUsage || "",
      memoryPercent: stats.MemPerc || "",
      network: stats.NetIO || "",
      block: stats.BlockIO || "",
      pids: stats.PIDs || "",
      refreshedAt: new Date().toISOString()
    };
  } catch (error) {
    return {
      available: false,
      container,
      message: trimLog(error.stderr || error.message || "读取资源占用失败。"),
      refreshedAt: new Date().toISOString()
    };
  }
}

async function readPanelLogs(tail = 240) {
  if (!(await exists(LOG_FILE))) return "";
  const text = await fsp.readFile(LOG_FILE, "utf8");
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-tail)
    .map((line) => {
      try {
        const entry = JSON.parse(line);
        const meta = entry.meta && Object.keys(entry.meta).length ? ` ${JSON.stringify(entry.meta)}` : "";
        return `${entry.time} ${String(entry.level).toUpperCase()} ${entry.message}${meta}`;
      } catch {
        return line;
      }
    })
    .join("\n");
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(httpError(413, "请求体太大。"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(httpError(400, "JSON 格式错误。"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function contentType(file) {
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8"
  }[path.extname(file).toLowerCase()] || "application/octet-stream";
}

async function serveStatic(req, res, url) {
  const pathname = decodeURIComponent(url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, ""));
  const file = safePath(PUBLIC_DIR, pathname);
  const stat = await fsp.stat(file).catch(() => null);
  if (!stat || !stat.isFile()) throw httpError(404, "Not found");
  res.writeHead(200, { "Content-Type": contentType(file) });
  fs.createReadStream(file).pipe(res);
}

async function handleApi(req, res, url) {
  const parts = url.pathname.split("/").filter(Boolean);
  if (req.method === "GET" && url.pathname === "/api/servers") {
    return sendJson(res, 200, { servers: await listServers() });
  }
  if (req.method === "GET" && url.pathname === "/api/versions") {
    return sendJson(res, 200, { versions: BEDROCK_VERSIONS });
  }
  if (req.method === "GET" && url.pathname === "/api/panel/logs") {
    const tail = Math.max(20, Math.min(1000, Number(url.searchParams.get("tail") || 240)));
    return sendJson(res, 200, { logs: await readPanelLogs(tail) });
  }
  if (req.method === "POST" && url.pathname === "/api/deploy") {
    return sendJson(res, 200, await deployServer(await readBody(req)));
  }

  if (parts[0] === "api" && parts[1] === "server" && parts[2]) {
    const name = parts[2];
    const { dataPath } = await getServer(name);

    if (req.method === "POST" && parts[3] === "action") {
      const body = await readBody(req);
      const actionMap = { start: "start", stop: "stop", restart: "restart", pause: "pause", unpause: "unpause", up: "up" };
      const action = actionMap[body.action];
      if (!action) throw httpError(400, "未知操作。");
      const args = action === "up" ? ["up", "-d", name] : [action, name];
      const result = await dockerCompose(args, { maxBuffer: 50 * 1024 * 1024 });
      logEvent("info", "server action", { service: name, action });
      return sendJson(res, 200, { ok: true, output: result.stdout || result.stderr });
    }

    if (req.method === "GET" && parts[3] === "logs") {
      const tail = Math.max(20, Math.min(1000, Number(url.searchParams.get("tail") || 160)));
      const result = await dockerCompose(["logs", "--tail", String(tail), name], { maxBuffer: 50 * 1024 * 1024 });
      return sendJson(res, 200, { logs: result.stdout });
    }

    if (req.method === "POST" && parts[3] === "command") {
      const body = await readBody(req);
      return sendJson(res, 200, await sendServerCommand(name, body.command));
    }

    if (req.method === "GET" && parts[3] === "resources") {
      return sendJson(res, 200, await getServerResources(name));
    }

    if (req.method === "POST" && parts[3] === "delete") {
      return sendJson(res, 200, await deleteServer(name, await readBody(req)));
    }

    if (req.method === "PUT" && parts[3] === "properties") {
      const body = await readBody(req);
      return sendJson(res, 200, { properties: pick(await saveServerProperties(dataPath, body.properties || {}), KEY_PROPS) });
    }
    if (req.method === "GET" && parts[3] === "files") {
      return sendJson(res, 200, { entries: await listFiles(dataPath, url.searchParams.get("path") || "") });
    }
    if (req.method === "GET" && parts[3] === "file") {
      return sendJson(res, 200, { content: await readFile(dataPath, url.searchParams.get("path") || "") });
    }
    if (req.method === "PUT" && parts[3] === "file") {
      const body = await readBody(req);
      await writeFile(dataPath, body.path, body.content);
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === "POST" && parts[3] === "world" && parts[4] === "backup") {
      const body = await readBody(req);
      return sendJson(res, 200, { backup: await backupWorld(dataPath, body.worldName, body.type || "manual") });
    }
    if (req.method === "GET" && parts[3] === "world" && parts[4] === "backups") {
      return sendJson(res, 200, { backups: await listBackupEntries(dataPath, 30), settings: await getBackupSettings(dataPath) });
    }
    if (req.method === "PUT" && parts[3] === "world" && parts[4] === "backup-settings") {
      return sendJson(res, 200, { settings: await saveBackupSettings(dataPath, await readBody(req)) });
    }
    if (req.method === "POST" && parts[3] === "world" && parts[4] === "restore") {
      return sendJson(res, 200, await restoreBackup(dataPath, await readBody(req)));
    }
    if (req.method === "POST" && parts[3] === "world" && parts[4] === "delete") {
      return sendJson(res, 200, await deleteWorld(dataPath, await readBody(req)));
    }
    if (req.method === "POST" && parts[3] === "world" && parts[4] === "new") {
      return sendJson(res, 200, await newWorld(dataPath, await readBody(req)));
    }
    if (req.method === "POST" && parts[3] === "world" && parts[4] === "upload") {
      return sendJson(res, 200, await replaceWorldFromZip(dataPath, await readBody(req)));
    }
    if (req.method === "GET" && parts[3] === "allowlist") {
      return sendJson(res, 200, { allowlist: await readAllowlist(dataPath) });
    }
    if (req.method === "POST" && parts[3] === "allowlist" && parts[4] === "remove") {
      return sendJson(res, 200, await removeAllowlistEntry(dataPath, await readBody(req)));
    }
    if (req.method === "POST" && parts[3] === "allowlist") {
      return sendJson(res, 200, await addAllowlistEntry(dataPath, await readBody(req)));
    }
    if (req.method === "POST" && parts[3] === "mods" && parts[4] === "upload") {
      return sendJson(res, 200, await installPacks(dataPath, await readBody(req)));
    }
  }

  throw httpError(404, "API 不存在。");
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || HOST}`);
    if (url.pathname.startsWith("/api/")) await handleApi(req, res, url);
    else await serveStatic(req, res, url);
  } catch (error) {
    const status = error.status || 500;
    logEvent("error", "request failed", {
      method: req.method,
      url: req.url,
      status,
      message: error.message,
      detail: trimLog(error.stderr || error.stdout || "")
    });
    sendJson(res, status, { error: error.message || "服务器错误", detail: error.stderr || error.stdout || "" });
  }
});

ensurePanelCompose().then(async () => {
  await refreshBackupSchedules();
  server.listen(PORT, HOST, () => {
    logEvent("info", "panel started", { url: `http://${HOST}:${PORT}`, appRoot: APP_ROOT, dataRoot: DATA_ROOT, hostDataRoot: HOST_DATA_ROOT });
  });
}).catch((error) => {
  console.error(error);
  process.exit(1);
});

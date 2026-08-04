const http = require("http");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");
const { promisify } = require("util");

const scryptAsync = promisify(crypto.scrypt);

const APP_ROOT = path.resolve(__dirname);
const DATA_ROOT = path.resolve(process.env.PANEL_DATA_DIR || APP_ROOT);
const HOST_DATA_ROOT = process.env.PANEL_HOST_DATA_DIR || DATA_ROOT;
const SERVERS_DIR = path.join(DATA_ROOT, "servers");
const COMPOSE_FILE = path.join(DATA_ROOT, "compose.yml");
const PUBLIC_DIR = path.join(APP_ROOT, "public");
const LOG_FILE = path.join(DATA_ROOT, "panel.log");
const AUTH_FILE = path.join(DATA_ROOT, ".panel-auth.json");
const HOST = process.env.PANEL_HOST || "0.0.0.0";
const PORT = Number(process.env.PANEL_PORT || 8787);
const FORCE_SECURE_COOKIE = process.env.PANEL_SECURE_COOKIE === "true";
const MAX_BODY_BYTES = 300 * 1024 * 1024;
const SESSION_COOKIE = "mc_panel_session";
const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const SESSION_IDLE_MS = 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 5;

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
  maxFiles: 10,
  consistentBackup: true
};

const DEFAULT_RESTART_SETTINGS = {
  enabled: false,
  mode: "interval",
  intervalHours: 12,
  dailyTime: "04:00",
  timezoneOffsetMinutes: 480,
  nextRunAt: null,
  lastRunAt: null,
  lastResult: "never",
  lastMessage: ""
};

const FRPC_IMAGE = "fatedier/frpc:v0.70.1";
const DEFAULT_FRP_SETTINGS = {
  enabled: false,
  serverAddr: "",
  serverPort: 7000,
  remotePort: 19132,
  token: "",
  tlsEnabled: true
};

const backupTimers = new Map();
const restartTimers = new Map();
const sessions = new Map();
const loginAttempts = new Map();
const DUMMY_PASSWORD_SALT = Buffer.alloc(16, 7).toString("base64");
let adminAccount = null;

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

function normalizeUsername(value) {
  const username = String(value || "").trim();
  if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username)) {
    throw httpError(400, "管理员名称需为 3-32 位，只能包含字母、数字、点、下划线和短横线。");
  }
  return username;
}

function validatePassword(value, label = "密码") {
  const password = String(value || "");
  if (password.length < 10 || password.length > 128) {
    throw httpError(400, `${label}长度需为 10-128 个字符。`);
  }
  return password;
}

async function derivePassword(password, saltBase64) {
  const key = await scryptAsync(password, Buffer.from(saltBase64, "base64"), 64);
  return Buffer.from(key).toString("base64");
}

async function makePasswordRecord(password) {
  const salt = crypto.randomBytes(16).toString("base64");
  return { salt, passwordHash: await derivePassword(password, salt) };
}

async function loadAdminAccount() {
  if (!(await exists(AUTH_FILE))) {
    adminAccount = null;
    return;
  }
  const parsed = JSON.parse(await fsp.readFile(AUTH_FILE, "utf8"));
  if (parsed.version !== 1 || !parsed.username || !parsed.salt || !parsed.passwordHash) {
    throw new Error("管理员账户文件格式无效。");
  }
  adminAccount = parsed;
}

async function saveAdminAccount(account, initialSetup = false) {
  const content = JSON.stringify(account, null, 2) + "\n";
  if (initialSetup) {
    await fsp.writeFile(AUTH_FILE, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } else {
    const tempFile = `${AUTH_FILE}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
    try {
      await fsp.writeFile(tempFile, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await fsp.rename(tempFile, AUTH_FILE);
    } catch (error) {
      await fsp.unlink(tempFile).catch(() => {});
      throw error;
    }
  }
  await fsp.chmod(AUTH_FILE, 0o600).catch(() => {});
  adminAccount = account;
}

function parseCookies(req) {
  const cookies = {};
  for (const item of String(req.headers.cookie || "").split(";")) {
    const index = item.indexOf("=");
    if (index < 1) continue;
    const key = item.slice(0, index).trim();
    try {
      cookies[key] = decodeURIComponent(item.slice(index + 1).trim());
    } catch {
      cookies[key] = "";
    }
  }
  return cookies;
}

function sessionCookie(req, token, maxAgeSeconds = Math.floor(SESSION_MAX_AGE_MS / 1000)) {
  const secure = Boolean(req.socket.encrypted) || FORCE_SECURE_COOKIE;
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`;
}

function clearExpiredSessions() {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (session.expiresAt <= now || session.lastSeen + SESSION_IDLE_MS <= now) sessions.delete(token);
  }
}

function createSession(req) {
  clearExpiredSessions();
  const token = crypto.randomBytes(32).toString("base64url");
  const now = Date.now();
  const session = {
    username: adminAccount.username,
    csrfToken: crypto.randomBytes(32).toString("base64url"),
    createdAt: now,
    lastSeen: now,
    expiresAt: now + SESSION_MAX_AGE_MS
  };
  sessions.set(token, session);
  return { token, session, cookie: sessionCookie(req, token) };
}

function getSession(req) {
  clearExpiredSessions();
  const token = parseCookies(req)[SESSION_COOKIE];
  const session = token && sessions.get(token);
  if (!session) return null;
  session.lastSeen = Date.now();
  return { token, session };
}

function requireSession(req) {
  const current = getSession(req);
  if (!current) throw httpError(401, "请先登录管理员账户。");
  return current;
}

function requireCsrf(req, session) {
  const supplied = String(req.headers["x-csrf-token"] || "");
  const expected = String(session.csrfToken || "");
  const valid = supplied.length === expected.length && supplied.length > 0 &&
    crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
  if (!valid) throw httpError(403, "安全校验失败，请刷新页面后重试。");
}

function loginAttemptKey(req) {
  return req.socket.remoteAddress || "unknown";
}

function checkLoginLimit(key) {
  const entry = loginAttempts.get(key);
  if (!entry || entry.resetAt <= Date.now()) {
    loginAttempts.delete(key);
    return;
  }
  if (entry.count >= LOGIN_MAX_ATTEMPTS) {
    const error = httpError(429, "登录尝试过多，请稍后再试。");
    error.retryAfter = Math.max(1, Math.ceil((entry.resetAt - Date.now()) / 1000));
    throw error;
  }
}

function recordLoginFailure(key) {
  const current = loginAttempts.get(key);
  if (!current || current.resetAt <= Date.now()) {
    loginAttempts.set(key, { count: 1, resetAt: Date.now() + LOGIN_WINDOW_MS });
    return;
  }
  current.count += 1;
}

async function passwordMatches(password, account = adminAccount) {
  const salt = account ? account.salt : DUMMY_PASSWORD_SALT;
  const expected = account ? account.passwordHash : Buffer.alloc(64).toString("base64");
  const actual = await derivePassword(String(password || ""), salt);
  const left = Buffer.from(actual, "base64");
  const right = Buffer.from(expected, "base64");
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function authResponse(session) {
  return {
    needsSetup: false,
    authenticated: true,
    username: session.username,
    csrfToken: session.csrfToken
  };
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

function assertIntegerRange(value, label, min, max = null) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || (max !== null && number > max)) {
    const range = max === null ? `不小于 ${min}` : `${min}-${max}`;
    throw httpError(400, `${label}必须是 ${range} 的整数。`);
  }
  return number;
}

function safePath(base, relativePath = "") {
  const baseResolved = path.resolve(base);
  const target = path.resolve(baseResolved, String(relativePath || "."));
  if (target !== baseResolved && !target.startsWith(baseResolved + path.sep)) {
    throw httpError(400, "路径越界，已拒绝。");
  }
  return target;
}

function isSameOrInside(base, target) {
  const root = path.resolve(base);
  const resolved = path.resolve(target);
  if (process.platform === "win32") {
    const left = root.toLowerCase();
    const right = resolved.toLowerCase();
    return right === left || right.startsWith(left + path.sep);
  }
  return resolved === root || resolved.startsWith(root + path.sep);
}

function normalizeForwardPath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/\/+$/, "");
}

function parsePathMappings() {
  const mappings = [{ containerRoot: path.resolve(DATA_ROOT), hostRoot: normalizeForwardPath(HOST_DATA_ROOT) }];
  const raw = String(process.env.PANEL_PATH_MAPPINGS || "").trim();
  for (const item of raw.split(/[;\n]/)) {
    const line = item.trim();
    if (!line) continue;
    const index = line.indexOf("=");
    if (index < 1) continue;
    const containerRoot = path.resolve(line.slice(0, index).trim());
    const hostRoot = normalizeForwardPath(line.slice(index + 1).trim());
    if (!hostRoot) continue;
    if (!mappings.some((mapping) => mapping.containerRoot === containerRoot && mapping.hostRoot === hostRoot)) {
      mappings.push({ containerRoot, hostRoot });
    }
  }
  return mappings.sort((a, b) => b.containerRoot.length - a.containerRoot.length);
}

function pathMappings() {
  if (!pathMappings.cache) pathMappings.cache = parsePathMappings();
  return pathMappings.cache;
}

function joinHostPath(hostRoot, relativePath) {
  const normalizedRoot = normalizeForwardPath(hostRoot);
  const normalizedRelative = String(relativePath || "").replace(/\\/g, "/").replace(/^\/+/, "");
  return normalizedRelative ? `${normalizedRoot}/${normalizedRelative}` : normalizedRoot;
}

function dockerBindPath(localPath) {
  const resolved = path.resolve(localPath);
  const mapping = pathMappings().find((item) => isSameOrInside(item.containerRoot, resolved));
  if (!mapping) {
    throw httpError(400, "目录不在面板可访问的 Docker 挂载范围内。请使用 /data/...、/host-data/...、/hostfs/...，或填写 Windows 绝对路径。");
  }
  return joinHostPath(mapping.hostRoot, path.relative(mapping.containerRoot, resolved));
}

function panelPathFromDockerBind(sourcePath) {
  const source = String(sourcePath || "").replace(/\\/g, "/");
  for (const mapping of pathMappings()) {
    const hostRoot = normalizeForwardPath(mapping.hostRoot);
    if (hostRoot && (source === hostRoot || source.startsWith(hostRoot + "/"))) {
      const relative = source.slice(hostRoot.length).replace(/^\/+/, "");
      return path.join(mapping.containerRoot, relative);
    }
  }
  return path.resolve(sourcePath);
}

function resolvePanelDirectoryInput(input, fallbackDir, label) {
  return normalizeUserDirectoryPath(input, label, fallbackDir, DATA_ROOT);
}

function assertSafeDirectoryRemoval(target, label = "目录") {
  const resolved = path.resolve(target);
  if (resolved === path.parse(resolved).root) throw httpError(400, `${label}不能是磁盘根目录。`);
  const protectedRoots = [DATA_ROOT, SERVERS_DIR, APP_ROOT, ...pathMappings().map((mapping) => mapping.containerRoot)];
  if (protectedRoots.some((root) => path.resolve(root) === resolved)) {
    throw httpError(400, `${label}不能是面板根目录、服务器总目录或挂载根目录。`);
  }
}

function hostfsPathFromWindowsPath(raw, label) {
  const windows = String(raw || "").trim().replace(/^["']|["']$/g, "").match(/^([A-Za-z]):[\\/]*(.*)$/);
  if (windows) {
    const drive = windows[1].toLowerCase();
    const rest = windows[2].replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    if (!rest) throw httpError(400, `${label}不能是磁盘根目录，请选择一个具体文件夹。`);
    return `/hostfs/${drive}/${rest}`;
  }
  return "";
}

function normalizeUserDirectoryPath(raw, label, fallbackDir, relativeRoot) {
  const value = String(raw || "").trim().replace(/^["']|["']$/g, "");
  if (!value) return path.resolve(fallbackDir);
  if (/[\0\r\n;]/.test(value)) throw httpError(400, `${label}不能包含换行、空字符或分号。`);
  const hostfsPath = hostfsPathFromWindowsPath(value, label);
  const target = hostfsPath
    ? path.resolve(hostfsPath)
    : path.isAbsolute(value)
      ? path.resolve(value)
      : safePath(relativeRoot, value);
  dockerBindPath(target);
  return target;
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
  const maxPlayers = assertIntegerRange(form.maxPlayers || 10, "最大玩家数", 1);
  const viewDistance = assertIntegerRange(form.viewDistance || 32, "视距", 5, 96);
  const tickDistance = assertIntegerRange(form.tickDistance || 4, "Tick 距离", 4, 12);
  return {
    "server-name": form.displayName || form.serviceName || `Bedrock ${port}`,
    gamemode: form.gamemode || "survival",
    "force-gamemode": String(Boolean(form.forceGamemode)),
    difficulty: form.difficulty || "normal",
    "allow-cheats": String(Boolean(form.allowCheats)),
    "max-players": String(maxPlayers),
    "online-mode": String(form.onlineMode !== false),
    "allow-list": String(Boolean(form.allowList)),
    "server-port": String(port),
    "server-portv6": String(portV6),
    "enable-lan-visibility": String(form.enableLanVisibility !== false),
    "view-distance": String(viewDistance),
    "tick-distance": String(tickDistance),
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
    maxFiles,
    consistentBackup: settings.consistentBackup !== false
  };
}

async function getBackupSettings(dataPath) {
  return normalizeBackupSettings(await readJsonFile(backupSettingsPath(dataPath), DEFAULT_BACKUP_SETTINGS));
}

function restartSettingsPath(dataPath) {
  return path.join(dataPath, "restart-settings.json");
}

function normalizeRestartSettings(settings = {}) {
  const mode = settings.mode === "daily" ? "daily" : "interval";
  const requestedInterval = Number(settings.intervalHours);
  const intervalHours = Number.isFinite(requestedInterval)
    ? Math.max(1, Math.min(168, Math.round(requestedInterval)))
    : DEFAULT_RESTART_SETTINGS.intervalHours;
  const dailyTime = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(settings.dailyTime || ""))
    ? String(settings.dailyTime)
    : DEFAULT_RESTART_SETTINGS.dailyTime;
  const requestedOffset = Number(settings.timezoneOffsetMinutes);
  const timezoneOffsetMinutes = Number.isFinite(requestedOffset)
    ? Math.max(-720, Math.min(840, Math.round(requestedOffset)))
    : DEFAULT_RESTART_SETTINGS.timezoneOffsetMinutes;
  return {
    enabled: Boolean(settings.enabled),
    mode,
    intervalHours,
    dailyTime,
    timezoneOffsetMinutes,
    nextRunAt: settings.nextRunAt && !Number.isNaN(Date.parse(settings.nextRunAt)) ? new Date(settings.nextRunAt).toISOString() : null,
    lastRunAt: settings.lastRunAt && !Number.isNaN(Date.parse(settings.lastRunAt)) ? new Date(settings.lastRunAt).toISOString() : null,
    lastResult: ["never", "success", "skipped", "error"].includes(settings.lastResult) ? settings.lastResult : "never",
    lastMessage: String(settings.lastMessage || "").slice(0, 300)
  };
}

async function getRestartSettings(dataPath) {
  return normalizeRestartSettings(await readJsonFile(restartSettingsPath(dataPath), DEFAULT_RESTART_SETTINGS));
}

function nextDailyRestart(settings, fromMs = Date.now()) {
  const [hour, minute] = settings.dailyTime.split(":").map(Number);
  const offsetMs = settings.timezoneOffsetMinutes * 60 * 1000;
  const localNow = new Date(fromMs + offsetMs);
  let candidate = Date.UTC(
    localNow.getUTCFullYear(),
    localNow.getUTCMonth(),
    localNow.getUTCDate(),
    hour,
    minute
  ) - offsetMs;
  if (candidate <= fromMs) candidate += 24 * 60 * 60 * 1000;
  return new Date(candidate).toISOString();
}

function calculateNextRestart(settings, fromMs = Date.now()) {
  if (!settings.enabled) return null;
  if (settings.mode === "daily") return nextDailyRestart(settings, fromMs);
  return new Date(fromMs + settings.intervalHours * 60 * 60 * 1000).toISOString();
}

async function writeRestartSettings(dataPath, settings) {
  const normalized = normalizeRestartSettings(settings);
  await fsp.writeFile(restartSettingsPath(dataPath), JSON.stringify(normalized, null, 2) + "\n", "utf8");
  return normalized;
}

async function saveRestartSettings(serviceName, dataPath, body) {
  const previous = await getRestartSettings(dataPath);
  const settings = normalizeRestartSettings({ ...previous, ...body });
  settings.nextRunAt = calculateNextRestart(settings);
  const saved = await writeRestartSettings(dataPath, settings);
  logEvent("info", "saved restart schedule", { serviceName, settings: saved });
  await scheduleServerRestart(serviceName, dataPath, saved);
  return saved;
}

function frpDir(dataPath) {
  return path.join(dataPath, ".panel-frp");
}

function frpSettingsPath(dataPath) {
  return path.join(frpDir(dataPath), "settings.json");
}

function frpcConfigPath(dataPath) {
  return path.join(frpDir(dataPath), "frpc.toml");
}

function frpcServiceName(serviceName) {
  return `frpc-${serviceName}`;
}

function normalizeFrpSettings(settings = {}, defaultRemotePort = 19132) {
  return {
    enabled: Boolean(settings.enabled),
    serverAddr: String(settings.serverAddr || "").trim(),
    serverPort: Number(settings.serverPort || DEFAULT_FRP_SETTINGS.serverPort),
    remotePort: Number(settings.remotePort || defaultRemotePort || DEFAULT_FRP_SETTINGS.remotePort),
    token: String(settings.token || ""),
    tlsEnabled: settings.tlsEnabled !== false,
    updatedAt: settings.updatedAt && !Number.isNaN(Date.parse(settings.updatedAt))
      ? new Date(settings.updatedAt).toISOString()
      : null
  };
}

async function getFrpSettings(dataPath, defaultRemotePort = 19132) {
  return normalizeFrpSettings(
    await readJsonFile(frpSettingsPath(dataPath), {
      ...DEFAULT_FRP_SETTINGS,
      remotePort: defaultRemotePort
    }),
    defaultRemotePort
  );
}

function validateFrpServerAddr(value) {
  const address = String(value || "").trim();
  if (!address || address.length > 253 || address.includes("://") || !/^[A-Za-z0-9._:-]+$/.test(address)) {
    throw httpError(400, "FRP 服务端地址不合法，请填写域名或 IP，不要包含协议和端口。");
  }
  return address;
}

function validateFrpToken(value) {
  const token = String(value || "");
  if (!token || token.length > 512 || /[\r\n\0]/.test(token)) {
    throw httpError(400, "FRP 令牌不能为空，且不能包含换行符，长度不能超过 512 个字符。");
  }
  return token;
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function buildFrpcConfig(serviceName, localPort, settings) {
  return [
    `serverAddr = ${tomlString(settings.serverAddr)}`,
    `serverPort = ${settings.serverPort}`,
    'auth.method = "token"',
    `auth.token = ${tomlString(settings.token)}`,
    `transport.tls.enable = ${settings.tlsEnabled ? "true" : "false"}`,
    "",
    "[[proxies]]",
    `name = ${tomlString(`${serviceName}-udp`)}`,
    'type = "udp"',
    `localIP = ${tomlString(serviceName)}`,
    `localPort = ${localPort}`,
    `remotePort = ${settings.remotePort}`,
    ""
  ].join("\n");
}

function publicFrpSettings(settings) {
  return {
    enabled: settings.enabled,
    serverAddr: settings.serverAddr,
    serverPort: settings.serverPort,
    remotePort: settings.remotePort,
    tlsEnabled: settings.tlsEnabled,
    tokenConfigured: Boolean(settings.token),
    updatedAt: settings.updatedAt
  };
}

async function writePrivateFile(file, content) {
  await ensureDir(path.dirname(file));
  await fsp.writeFile(file, content, { encoding: "utf8", mode: 0o600 });
  await fsp.chmod(file, 0o600).catch(() => {});
}

function visibleServerPath(dataPath, relativePath) {
  const target = safePath(dataPath, relativePath);
  const relativeToPrivateDir = path.relative(frpDir(dataPath), target);
  if (relativeToPrivateDir === "" || (!relativeToPrivateDir.startsWith("..") && !path.isAbsolute(relativeToPrivateDir))) {
    throw httpError(403, "FRP 私密配置不能通过文件编辑器访问。");
  }
  return target;
}

function resolveBackupRoot(dataPath, backupDir) {
  const value = String(backupDir || DEFAULT_BACKUP_SETTINGS.backupDir).trim();
  return normalizeUserDirectoryPath(value, "备份目录", path.join(dataPath, DEFAULT_BACKUP_SETTINGS.backupDir), dataPath);
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
        path: backupPathToken(file),
        location: path.dirname(file),
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
      restartSettings: await getRestartSettings(dataPath),
      frp: await getFrpStatus(name, dataPath, psRows, port ? port.published : props["server-port"]),
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

function removeServiceIfPresent(text, serviceName) {
  const pattern = new RegExp(`^  ${serviceName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\s*$`, "m");
  return pattern.test(String(text || "")) ? removeServiceFromComposeText(text, serviceName) : text;
}

function appendComposeService(text, block) {
  const base = String(text || "")
    .replace(/services:\s*\{\}\s*$/m, "services:")
    .replace(/\s*$/, "\n");
  return base + "\n" + block.join("\n") + "\n";
}

async function getFrpStatus(serviceName, dataPath, suppliedRows = null, defaultRemotePort = 19132) {
  const settings = await getFrpSettings(dataPath, defaultRemotePort);
  const rows = suppliedRows || await getPsRows().catch(() => []);
  const proxyService = frpcServiceName(serviceName);
  const row = rows.find((item) => item.Service === proxyService) || {};
  return {
    settings: publicFrpSettings(settings),
    serviceName: proxyService,
    state: row.State || "not-created",
    status: row.Status || "",
    running: String(row.State || "").toLowerCase() === "running",
    endpoint: settings.serverAddr && settings.remotePort
      ? `${settings.serverAddr}:${settings.remotePort}`
      : ""
  };
}

async function saveFrpSettings(serviceName, dataPath, localPort, body) {
  const previous = await getFrpSettings(dataPath, localPort);
  const requestedToken = String(body.token || "");
  const requestedServerPort = body.serverPort === undefined || body.serverPort === null || body.serverPort === ""
    ? DEFAULT_FRP_SETTINGS.serverPort
    : body.serverPort;
  const requestedRemotePort = body.remotePort === undefined || body.remotePort === null || body.remotePort === ""
    ? localPort
    : body.remotePort;
  const settings = normalizeFrpSettings({
    ...previous,
    enabled: Boolean(body.enabled),
    serverAddr: body.serverAddr,
    serverPort: assertPort(requestedServerPort, "FRP 控制端口"),
    remotePort: assertPort(requestedRemotePort, "FRP 公网 UDP 端口"),
    token: requestedToken || previous.token,
    tlsEnabled: body.tlsEnabled !== false,
    updatedAt: new Date().toISOString()
  }, localPort);

  if (settings.enabled || settings.serverAddr) settings.serverAddr = validateFrpServerAddr(settings.serverAddr);
  if (settings.enabled || settings.token) settings.token = validateFrpToken(settings.token);

  const settingsFile = frpSettingsPath(dataPath);
  const configFile = frpcConfigPath(dataPath);
  const oldSettings = await fsp.readFile(settingsFile, "utf8").catch(() => null);
  const oldConfig = await fsp.readFile(configFile, "utf8").catch(() => null);
  const composeBefore = await fsp.readFile(COMPOSE_FILE, "utf8");
  const proxyService = frpcServiceName(serviceName);
  let composeNext = removeServiceIfPresent(composeBefore, proxyService);
  let runtimeApplyStarted = false;

  if (settings.enabled) {
    const configVolume = dockerBindPath(configFile);
    composeNext = appendComposeService(composeNext, [
      `  ${proxyService}:`,
      `    image: ${FRPC_IMAGE}`,
      `    container_name: mc-panel-${proxyService}`,
      "    restart: unless-stopped",
      "    command: [\"-c\", \"/etc/frp/frpc.toml\"]",
      "    labels:",
      '      mc-control-panel.managed: "frp"',
      `      mc-control-panel.server: "${serviceName}"`,
      "    volumes:",
      `      - \"${configVolume}:/etc/frp/frpc.toml:ro\"`
    ]);
  }

  try {
    await writePrivateFile(settingsFile, JSON.stringify(settings, null, 2) + "\n");
    await writePrivateFile(configFile, buildFrpcConfig(serviceName, localPort, settings));
    await fsp.writeFile(COMPOSE_FILE, composeNext, "utf8");
    await dockerCompose(["config"]);
    if (settings.enabled) {
      runtimeApplyStarted = true;
      await dockerCompose(["up", "-d", "--no-deps", "--force-recreate", proxyService], { maxBuffer: 80 * 1024 * 1024 });
    } else {
      runtimeApplyStarted = true;
      await removeManagedFrpContainerIfPresent(serviceName);
    }
    logEvent("info", "saved FRP settings", {
      serviceName,
      enabled: settings.enabled,
      serverAddr: settings.serverAddr,
      serverPort: settings.serverPort,
      remotePort: settings.remotePort,
      tokenConfigured: Boolean(settings.token)
    });
    return await getFrpStatus(serviceName, dataPath, null, localPort);
  } catch (error) {
    await fsp.writeFile(COMPOSE_FILE, composeBefore, "utf8").catch(() => {});
    if (oldSettings === null) await fsp.rm(settingsFile, { force: true }).catch(() => {});
    else await writePrivateFile(settingsFile, oldSettings).catch(() => {});
    if (oldConfig === null) await fsp.rm(configFile, { force: true }).catch(() => {});
    else await writePrivateFile(configFile, oldConfig).catch(() => {});
    if (runtimeApplyStarted) {
      try {
        if (previous.enabled) {
          await dockerCompose(["up", "-d", "--no-deps", "--force-recreate", proxyService], { maxBuffer: 80 * 1024 * 1024 });
        } else {
          await removeManagedFrpContainerIfPresent(serviceName);
        }
      } catch (rollbackError) {
        logEvent("error", "failed to restore FRP runtime after apply error", {
          serviceName,
          message: rollbackError.message,
          stderr: trimLog(rollbackError.stderr)
        });
      }
    }
    throw error;
  }
}

async function removeManagedFrpContainerIfPresent(serviceName) {
  const containerName = `mc-panel-${frpcServiceName(serviceName)}`;
  let inspected;
  try {
    inspected = await run("docker", ["inspect", containerName], { maxBuffer: 10 * 1024 * 1024 });
  } catch (error) {
    const detail = `${error.message || ""}\n${error.stderr || ""}`;
    if (/No such (object|container)/i.test(detail)) return;
    throw error;
  }
  const labels = JSON.parse(inspected.stdout)[0]?.Config?.Labels || {};
  if (labels["mc-control-panel.managed"] !== "frp" || labels["mc-control-panel.server"] !== serviceName) {
    throw httpError(409, `容器名 ${containerName} 已被其他程序占用，面板不会删除它。`);
  }
  await run("docker", ["rm", "-f", containerName], { maxBuffer: 30 * 1024 * 1024 });
}

async function runFrpAction(serviceName, dataPath, localPort, action) {
  const proxyService = frpcServiceName(serviceName);
  const settings = await getFrpSettings(dataPath, localPort);
  if (!settings.enabled) throw httpError(409, "请先保存并启用 FRP 配置。");
  const actionMap = {
    start: ["up", "-d", "--no-deps", proxyService],
    stop: ["stop", proxyService],
    restart: ["restart", proxyService]
  };
  const args = actionMap[action];
  if (!args) throw httpError(400, "未知 FRP 操作。");
  await dockerCompose(args, { maxBuffer: 50 * 1024 * 1024 });
  logEvent("info", "FRP action", { serviceName, action });
  return await getFrpStatus(serviceName, dataPath, null, localPort);
}

function redactSecret(value, secret) {
  if (!secret) return String(value || "");
  return String(value || "").split(secret).join("[REDACTED]");
}

async function readFrpLogs(serviceName, dataPath, localPort, tail = 160) {
  const proxyService = frpcServiceName(serviceName);
  const result = await dockerCompose(["logs", "--tail", String(tail), proxyService], { maxBuffer: 20 * 1024 * 1024 });
  const settings = await getFrpSettings(dataPath, localPort);
  return redactSecret(result.stdout || result.stderr || "", settings.token);
}

async function deleteServer(name, body) {
  if (body.confirmName !== name) throw httpError(400, "请输入完全一致的服务器名确认删除。");
  const { dataPath } = await getServer(name);
  if (body.deleteDataDir) {
    assertSafeDirectoryRemoval(dataPath, "数据目录");
    if (!isSameOrInside(SERVERS_DIR, dataPath) && String(body.confirmDataPath || "").trim() !== dataPath) {
      throw httpError(400, "自定义数据目录需要输入完整目录路径确认删除。");
    }
  }
  const composeBefore = await fsp.readFile(COMPOSE_FILE, "utf8");
  const restartTimer = restartTimers.get(name);
  if (restartTimer) clearTimeout(restartTimer.timer);
  restartTimers.delete(name);

  const proxyService = frpcServiceName(name);
  await dockerCompose(["rm", "-s", "-f", proxyService], { maxBuffer: 30 * 1024 * 1024 }).catch(() => {});

  await dockerCompose(["rm", "-s", "-f", "-v", name], { maxBuffer: 30 * 1024 * 1024 }).catch((error) => {
    logEvent("warn", "docker compose rm failed during delete", {
      service: name,
      message: error.message,
      stderr: trimLog(error.stderr)
    });
  });

  const withoutProxy = removeServiceIfPresent(composeBefore, proxyService);
  await fsp.writeFile(COMPOSE_FILE, removeServiceFromComposeText(withoutProxy, name), "utf8");

  if (body.deleteDataDir) {
    await fsp.rm(dataPath, { recursive: true, force: true });
  }

  logEvent("warn", "deleted server", { service: name, dataPath, deleteDataDir: Boolean(body.deleteDataDir) });
  return { ok: true };
}

async function saveServerProperties(dataPath, updates) {
  const normalizedUpdates = { ...updates };
  if (Object.prototype.hasOwnProperty.call(normalizedUpdates, "server-port")) {
    normalizedUpdates["server-port"] = String(assertPort(normalizedUpdates["server-port"], "IPv4 端口"));
  }
  if (Object.prototype.hasOwnProperty.call(normalizedUpdates, "server-portv6")) {
    normalizedUpdates["server-portv6"] = String(assertPort(normalizedUpdates["server-portv6"], "IPv6 端口"));
  }
  if (Object.prototype.hasOwnProperty.call(normalizedUpdates, "max-players")) {
    normalizedUpdates["max-players"] = String(assertIntegerRange(normalizedUpdates["max-players"], "最大玩家数", 1));
  }
  if (Object.prototype.hasOwnProperty.call(normalizedUpdates, "view-distance")) {
    normalizedUpdates["view-distance"] = String(assertIntegerRange(normalizedUpdates["view-distance"], "视距", 5, 96));
  }
  if (Object.prototype.hasOwnProperty.call(normalizedUpdates, "tick-distance")) {
    normalizedUpdates["tick-distance"] = String(assertIntegerRange(normalizedUpdates["tick-distance"], "Tick 距离", 4, 12));
  }
  const file = path.join(dataPath, "server.properties");
  const oldText = await exists(file) ? await fsp.readFile(file, "utf8") : "";
  const next = writePropertiesPreserving(oldText, normalizedUpdates);
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

  const defaultDataDir = path.join(SERVERS_DIR, slugify(body.folderName || serviceName, serviceName));
  const dataDir = resolvePanelDirectoryInput(body.dataDir, defaultDataDir, "服务器文件目录");
  assertSafeDirectoryRemoval(dataDir, "服务器文件目录");
  if (await exists(dataDir)) {
    if (!body.forceOverwriteDataDir) {
      throw httpError(409, `数据目录已存在：${dataDir}`);
    }
    assertSafeDirectoryRemoval(dataDir, "数据目录");
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

async function isServiceRunning(name) {
  const rows = await getPsRows().catch(() => []);
  const row = rows.find((item) => item.Service === name);
  return String(row && row.State || "").toLowerCase() === "running"
    && !String(row && row.Status || "").toLowerCase().includes("paused");
}

async function backupWorld(dataPath, worldName, type = "manual", serviceName = null) {
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
  const shouldStop = Boolean(serviceName) && settings.consistentBackup && await isServiceRunning(serviceName);
  let stoppedForBackup = false;
  if (shouldStop) {
    logEvent("info", "stopping server for consistent backup", { serviceName, worldName });
    await dockerCompose(["stop", "--timeout", "120", serviceName], { maxBuffer: 30 * 1024 * 1024 });
    stoppedForBackup = true;
  }
  let restartFailed = false;
  try {
    await zipDirectory(worldPath, zipPath);
  } finally {
    if (stoppedForBackup) {
      try {
        await dockerCompose(["start", serviceName], { maxBuffer: 30 * 1024 * 1024 });
        logEvent("info", "restarted server after backup", { serviceName });
      } catch (error) {
        restartFailed = true;
        logEvent("error", "failed to restart server after backup", { serviceName, message: error.message });
      }
    }
  }
  if (type === "auto") await pruneAutoBackups(dataPath, settings);
  const backup = {
    name: path.basename(zipPath),
    type,
    path: backupPathToken(zipPath),
    location: path.dirname(zipPath),
    size: (await fsp.stat(zipPath)).size,
    mtime: new Date().toISOString(),
    consistent: stoppedForBackup,
    restartFailed
  };
  logEvent("info", "backed up world", { worldName, zipPath, type, stoppedForBackup, restartFailed });
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

async function deleteWorld(dataPath, body, serviceName = null) {
  const worldName = body.worldName;
  const backup = body.backupFirst ? await backupWorld(dataPath, worldName, "manual", serviceName) : null;
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

async function replaceWorldFromZip(dataPath, body, serviceName = null) {
  const targetName = String(body.targetWorldName || "").trim();
  if (!targetName || /[\\/:*?"<>|\r\n\t\f]/.test(targetName)) throw httpError(400, "目标世界名不合法。");
  const { file } = await saveUploadToTemp(body.fileName, body.contentBase64);
  return await restoreWorldFromZip(dataPath, file, targetName, Boolean(body.replaceExisting), true, serviceName);
}

async function restoreWorldFromZip(dataPath, zipFile, targetName, replaceExisting = true, cleanupZip = false, serviceName = null) {
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
    const backup = await backupWorld(dataPath, targetName, "manual", serviceName);
    backupName = backup.name;
    await fsp.rm(target, { recursive: true, force: true });
  }
  await fsp.cp(source, target, { recursive: true });
  await fsp.rm(extractDir, { recursive: true, force: true }).catch(() => {});
  if (cleanupZip) await fsp.rm(zipFile, { force: true }).catch(() => {});
  logEvent("info", "restored world", { targetName, backupName, zipFile });
  return { worldName: targetName, backupName };
}

function backupPathToken(file) {
  return Buffer.from(path.resolve(file), "utf8").toString("base64url");
}

function backupFileFromToken(reference) {
  const raw = String(reference || "").trim();
  if (!raw) throw httpError(400, "请选择备份文件。");
  if (/[\\/]/.test(raw) || raw.toLowerCase().endsWith(".zip")) return safePath(DATA_ROOT, raw);
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) throw httpError(400, "备份文件引用无效。");
  try {
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    if (decoded) return path.resolve(decoded);
  } catch {
    // Older panel versions used a relative path from DATA_ROOT.
  }
  return safePath(DATA_ROOT, raw);
}

async function backupFileFromReference(dataPath, reference) {
  const file = backupFileFromToken(reference);
  if (!file.toLowerCase().endsWith(".zip")) throw httpError(400, "只能还原 zip 备份文件。");
  const dirs = await getBackupDirs(dataPath);
  if (!isSameOrInside(dirs.root, file)) {
    throw httpError(400, "备份文件不在当前服务器配置的备份目录内。");
  }
  return file;
}

async function restoreBackup(dataPath, body, serviceName = null) {
  const targetName = String(body.targetWorldName || "").trim();
  if (!targetName || /[\\/:*?"<>|\r\n\t\f]/.test(targetName)) throw httpError(400, "目标世界名不合法。");
  const file = await backupFileFromReference(dataPath, body.backupPath || "");
  if (!(await exists(file))) throw httpError(404, "备份文件不存在。");
  return await restoreWorldFromZip(dataPath, file, targetName, true, false, serviceName);
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
    await backupWorld(dataPath, worldName, "auto", serviceName);
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

async function runScheduledRestart(serviceName, dataPath) {
  let result = "skipped";
  let message = "服务器未运行，已跳过定时重启。";
  try {
    const rows = await getPsRows();
    const row = rows.find((item) => item.Service === serviceName);
    const state = String(row && row.State || "").toLowerCase();
    const status = String(row && row.Status || "").toLowerCase();
    if (state === "running" && !status.includes("paused")) {
      await dockerCompose(["restart", serviceName], { maxBuffer: 50 * 1024 * 1024 });
      result = "success";
      message = "定时重启已完成。";
      logEvent("info", "scheduled server restart completed", { serviceName });
    } else {
      logEvent("info", "scheduled server restart skipped", { serviceName, state: state || "not-created" });
    }
  } catch (error) {
    result = "error";
    message = `定时重启失败：${error.message}`.slice(0, 300);
    logEvent("error", "scheduled server restart failed", { serviceName, message: error.message });
  }

  const current = await getRestartSettings(dataPath);
  current.lastRunAt = new Date().toISOString();
  current.lastResult = result;
  current.lastMessage = message;
  current.nextRunAt = calculateNextRestart(current);
  const saved = await writeRestartSettings(dataPath, current);
  await scheduleServerRestart(serviceName, dataPath, saved);
}

async function scheduleServerRestart(serviceName, dataPath, suppliedSettings = null) {
  const currentTimer = restartTimers.get(serviceName);
  if (currentTimer) clearTimeout(currentTimer.timer);
  restartTimers.delete(serviceName);

  const settings = suppliedSettings || await getRestartSettings(dataPath);
  if (!settings.enabled) return settings;

  let nextRunAt = settings.nextRunAt;
  if (!nextRunAt || Date.parse(nextRunAt) <= Date.now()) {
    nextRunAt = calculateNextRestart(settings);
    settings.nextRunAt = nextRunAt;
    await writeRestartSettings(dataPath, settings);
  }
  const delayMs = Math.max(1000, Date.parse(nextRunAt) - Date.now());
  const timer = setTimeout(() => {
    runScheduledRestart(serviceName, dataPath).catch((error) => {
      logEvent("error", "restart scheduler failed", { serviceName, message: error.message });
    });
  }, delayMs);
  restartTimers.set(serviceName, { timer, dataPath, nextRunAt });
  logEvent("info", "scheduled server restart", { serviceName, nextRunAt, mode: settings.mode });
  return settings;
}

async function refreshRestartSchedules() {
  const config = await getComposeConfig();
  const wanted = new Set();
  for (const [name, service] of Object.entries(config.services || {})) {
    if (!isMinecraftService(service)) continue;
    const dataPath = dataPathOf(service);
    wanted.add(name);
    await scheduleServerRestart(name, dataPath);
  }
  for (const [name, current] of restartTimers.entries()) {
    if (!wanted.has(name)) {
      clearTimeout(current.timer);
      restartTimers.delete(name);
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
  const dir = visibleServerPath(dataPath, relativePath);
  const stat = await fsp.stat(dir).catch(() => null);
  if (!stat || !stat.isDirectory()) throw httpError(404, "目录不存在。");
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const relBase = path.relative(dataPath, dir);
  return entries
    .filter((entry) => !entry.name.startsWith(".tmp") && entry.name !== ".panel-frp")
    .map((entry) => ({
      name: entry.name,
      path: path.join(relBase, entry.name).replace(/\\/g, "/"),
      type: entry.isDirectory() ? "dir" : "file"
    }))
    .sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
}

async function readFile(dataPath, relativePath) {
  const file = visibleServerPath(dataPath, relativePath);
  const stat = await fsp.stat(file).catch(() => null);
  if (!stat || !stat.isFile()) throw httpError(404, "文件不存在。");
  if (stat.size > 2 * 1024 * 1024) throw httpError(413, "文件超过 2MB，不适合在面板中编辑。");
  return await fsp.readFile(file, "utf8");
}

async function writeFile(dataPath, relativePath, content) {
  const file = visibleServerPath(dataPath, relativePath);
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

async function getOnlinePlayers(name) {
  const { service } = await getServer(name);
  const container = service.container_name || `mc-panel-${name}`;
  const result = await dockerCompose(["logs", "--tail", "1000", name], { maxBuffer: 30 * 1024 * 1024 }).catch(() => null);
  if (!result) return { available: false, container, players: [], count: 0, message: "读取日志失败。" };
  const text = String(result.stdout || result.stderr || "");
  const players = [];
  const index = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/Player (connected|disconnected): (.+?), xuid: (\d+)/i);
    if (!match) continue;
    const [, event, playerName, xuid] = match;
    if (event.toLowerCase() === "connected") {
      if (!index.has(xuid)) {
        const entry = { name: playerName, xuid };
        index.set(xuid, entry);
        players.push(entry);
      }
    } else if (index.has(xuid)) {
      const entry = index.get(xuid);
      index.delete(xuid);
      const pos = players.indexOf(entry);
      if (pos >= 0) players.splice(pos, 1);
    }
  }
  return { available: true, container, players, count: players.length, refreshedAt: new Date().toISOString() };
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

function sendJson(res, status, value, headers = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    ...securityHeaders(),
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    ...headers
  });
  res.end(body);
}

function securityHeaders() {
  return {
    "Content-Security-Policy": "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()"
  };
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
  res.writeHead(200, {
    ...securityHeaders(),
    "Content-Type": contentType(file),
    "Cache-Control": path.extname(file) === ".html" ? "no-store" : "public, max-age=300"
  });
  fs.createReadStream(file).pipe(res);
}

async function handleAuthApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/auth/status") {
    const current = getSession(req);
    if (!adminAccount) return sendJson(res, 200, { needsSetup: true, authenticated: false });
    if (!current) return sendJson(res, 200, { needsSetup: false, authenticated: false });
    return sendJson(res, 200, authResponse(current.session));
  }

  if (req.method === "POST" && url.pathname === "/api/auth/setup") {
    if (adminAccount || await exists(AUTH_FILE)) throw httpError(409, "管理员账户已经创建，请直接登录。");
    const body = await readBody(req);
    const username = normalizeUsername(body.username);
    const password = validatePassword(body.password);
    if (password !== String(body.confirmPassword || "")) throw httpError(400, "两次输入的密码不一致。");
    const passwordRecord = await makePasswordRecord(password);
    const now = new Date().toISOString();
    try {
      await saveAdminAccount({ version: 1, username, ...passwordRecord, createdAt: now, updatedAt: now }, true);
    } catch (error) {
      if (error.code === "EEXIST") throw httpError(409, "管理员账户已经创建，请直接登录。");
      throw error;
    }
    const created = createSession(req);
    logEvent("info", "administrator account created", { username });
    return sendJson(res, 201, authResponse(created.session), { "Set-Cookie": created.cookie });
  }

  if (req.method === "POST" && url.pathname === "/api/auth/login") {
    const body = await readBody(req);
    const username = String(body.username || "").trim();
    const key = loginAttemptKey(req);
    checkLoginLimit(key);
    const validPassword = await passwordMatches(body.password);
    const validUsername = Boolean(adminAccount) && username.toLowerCase() === adminAccount.username.toLowerCase();
    if (!validUsername || !validPassword) {
      recordLoginFailure(key);
      logEvent("warn", "administrator login failed", { username, remoteAddress: req.socket.remoteAddress });
      throw httpError(401, "管理员名称或密码错误。");
    }
    loginAttempts.delete(key);
    const created = createSession(req);
    logEvent("info", "administrator logged in", { username: adminAccount.username, remoteAddress: req.socket.remoteAddress });
    return sendJson(res, 200, authResponse(created.session), { "Set-Cookie": created.cookie });
  }

  if (req.method === "POST" && url.pathname === "/api/auth/logout") {
    const current = requireSession(req);
    requireCsrf(req, current.session);
    sessions.delete(current.token);
    return sendJson(res, 200, { ok: true }, { "Set-Cookie": sessionCookie(req, "", 0) });
  }

  if (req.method === "PUT" && url.pathname === "/api/auth/account") {
    const current = requireSession(req);
    requireCsrf(req, current.session);
    const body = await readBody(req);
    if (!(await passwordMatches(body.currentPassword))) throw httpError(401, "当前密码错误。");
    const username = normalizeUsername(body.username || adminAccount.username);
    const hasNewPassword = String(body.newPassword || "").length > 0;
    if (hasNewPassword && body.newPassword !== body.confirmPassword) throw httpError(400, "两次输入的新密码不一致。");
    const passwordRecord = hasNewPassword
      ? await makePasswordRecord(validatePassword(body.newPassword, "新密码"))
      : { salt: adminAccount.salt, passwordHash: adminAccount.passwordHash };
    await saveAdminAccount({
      ...adminAccount,
      username,
      ...passwordRecord,
      updatedAt: new Date().toISOString()
    });
    sessions.clear();
    const created = createSession(req);
    logEvent("info", "administrator account updated", { username });
    return sendJson(res, 200, authResponse(created.session), { "Set-Cookie": created.cookie });
  }

  throw httpError(404, "认证 API 不存在。");
}

async function handleApi(req, res, url) {
  if (url.pathname.startsWith("/api/auth/")) return handleAuthApi(req, res, url);
  const current = requireSession(req);
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) requireCsrf(req, current.session);
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

    if (req.method === "GET" && parts[3] === "players") {
      return sendJson(res, 200, await getOnlinePlayers(name));
    }

    if (parts[3] === "frp") {
      const properties = await readServerProperties(dataPath);
      const localPort = assertPort(properties["server-port"] || 19132, "Minecraft 本地端口");
      if (req.method === "GET" && !parts[4]) {
        return sendJson(res, 200, await getFrpStatus(name, dataPath, null, localPort));
      }
      if (req.method === "PUT" && !parts[4]) {
        return sendJson(res, 200, await saveFrpSettings(name, dataPath, localPort, await readBody(req)));
      }
      if (req.method === "POST" && parts[4] === "action") {
        const body = await readBody(req);
        return sendJson(res, 200, await runFrpAction(name, dataPath, localPort, body.action));
      }
      if (req.method === "GET" && parts[4] === "logs") {
        const tail = Math.max(20, Math.min(1000, Number(url.searchParams.get("tail") || 160)));
        return sendJson(res, 200, { logs: await readFrpLogs(name, dataPath, localPort, tail) });
      }
    }

    if (req.method === "GET" && parts[3] === "restart-schedule") {
      return sendJson(res, 200, { settings: await getRestartSettings(dataPath) });
    }

    if (req.method === "PUT" && parts[3] === "restart-schedule") {
      return sendJson(res, 200, { settings: await saveRestartSettings(name, dataPath, await readBody(req)) });
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
      return sendJson(res, 200, { backup: await backupWorld(dataPath, body.worldName, body.type || "manual", name) });
    }
    if (req.method === "GET" && parts[3] === "world" && parts[4] === "backups") {
      return sendJson(res, 200, { backups: await listBackupEntries(dataPath, 30), settings: await getBackupSettings(dataPath) });
    }
    if (req.method === "PUT" && parts[3] === "world" && parts[4] === "backup-settings") {
      return sendJson(res, 200, { settings: await saveBackupSettings(dataPath, await readBody(req)) });
    }
    if (req.method === "POST" && parts[3] === "world" && parts[4] === "restore") {
      return sendJson(res, 200, await restoreBackup(dataPath, await readBody(req), name));
    }
    if (req.method === "POST" && parts[3] === "world" && parts[4] === "delete") {
      return sendJson(res, 200, await deleteWorld(dataPath, await readBody(req), name));
    }
    if (req.method === "POST" && parts[3] === "world" && parts[4] === "new") {
      return sendJson(res, 200, await newWorld(dataPath, await readBody(req)));
    }
    if (req.method === "POST" && parts[3] === "world" && parts[4] === "upload") {
      return sendJson(res, 200, await replaceWorldFromZip(dataPath, await readBody(req), name));
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
    const isExpectedAuthFailure = [401, 403, 429].includes(status) && req.url.startsWith("/api/auth/");
    if (!isExpectedAuthFailure) {
      logEvent(status >= 500 ? "error" : "warn", "request failed", {
        method: req.method,
        url: req.url,
        status,
        message: error.message,
        detail: trimLog(error.stderr || error.stdout || "")
      });
    }
    const headers = error.retryAfter ? { "Retry-After": String(error.retryAfter) } : {};
    sendJson(res, status, { error: error.message || "服务器错误", detail: error.stderr || error.stdout || "" }, headers);
  }
});

ensurePanelCompose().then(async () => {
  await loadAdminAccount();
  await refreshBackupSchedules();
  await refreshRestartSchedules();
  server.listen(PORT, HOST, () => {
    logEvent("info", "panel started", { url: `http://${HOST}:${PORT}`, appRoot: APP_ROOT, dataRoot: DATA_ROOT, hostDataRoot: HOST_DATA_ROOT });
  });
}).catch((error) => {
  console.error(error);
  process.exit(1);
});

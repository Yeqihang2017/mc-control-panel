const fs = require("fs/promises");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(__dirname, "..");
const id = `${process.pid}-${Date.now().toString(36)}`.toLowerCase();
const serviceName = `frp-it-${id}`.slice(0, 60);
const projectName = `mc-panel-frp-it-${id}`.slice(0, 63);
const fixtureContainer = `${projectName}-minecraft`;
const frpsContainer = `${projectName}-frps`;
const panelContainer = `${projectName}-panel`;
const proxyContainer = `mc-panel-frpc-${serviceName}`;
const panelImage = `mc-control-panel:frp-integration`;
const fixtureImage = `local/minecraft-bedrock-server:frp-fixture`;
const panelPort = 18000 + Math.floor(Math.random() * 1000);
const token = `FRP_INTEGRATION_TOKEN_${id}_secret`;
const password = `Integration-${id}-Password`;
const tempRoot = path.join(projectRoot, ".panel-tmp", projectName);
const serverDir = path.join(tempRoot, "servers", serviceName);
const composeFile = path.join(tempRoot, "compose.yml");
const settingsFile = path.join(serverDir, ".panel-frp", "settings.json");
const configFile = path.join(serverDir, ".panel-frp", "frpc.toml");
const baseUrl = `http://127.0.0.1:${panelPort}`;

let cookie = "";
let csrfToken = "";

function dockerPath(hostPath) {
  const normalized = path.resolve(hostPath);
  const match = normalized.match(/^([A-Za-z]):\\(.*)$/);
  if (!match) return normalized.replace(/\\/g, "/");
  return `/run/desktop/mnt/host/${match[1].toLowerCase()}/${match[2].replace(/\\/g, "/")}`;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function run(file, args, options = {}) {
  try {
    return await execFileAsync(file, args, {
      cwd: options.cwd || projectRoot,
      maxBuffer: 50 * 1024 * 1024
    });
  } catch (error) {
    const detail = [error.message, error.stdout, error.stderr].filter(Boolean).join("\n");
    throw new Error(detail);
  }
}

async function docker(args, options) {
  return run("docker", args, options);
}

async function containerStartedAt(name) {
  const { stdout } = await docker(["inspect", "-f", "{{.State.StartedAt}}", name]);
  return stdout.trim();
}

async function containerState(name) {
  const { stdout } = await docker(["inspect", "-f", "{{.State.Status}}", name]);
  return stdout.trim();
}

async function request(urlPath, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (cookie) headers.Cookie = cookie;
  if (csrfToken && !["GET", "HEAD"].includes(String(options.method || "GET").toUpperCase())) {
    headers["X-CSRF-Token"] = csrfToken;
  }
  const response = await fetch(baseUrl + urlPath, { ...options, headers });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";", 1)[0];
  const text = await response.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  return { response, body, text };
}

async function expectStatus(urlPath, options, status) {
  const result = await request(urlPath, options);
  assert(result.response.status === status, `${urlPath} expected ${status}, got ${result.response.status}: ${result.text}`);
  return result;
}

async function waitForPanel() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const result = await request("/api/auth/status");
      if (result.response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error("Timed out waiting for isolated panel");
}

async function fileOrNull(file) {
  try { return await fs.readFile(file, "utf8"); } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function main() {
  await fs.mkdir(serverDir, { recursive: true });
  await fs.writeFile(path.join(serverDir, "server.properties"), "server-name=FRP integration fixture\nserver-port=39132\nlevel-name=fixture-world\n", "utf8");
  await fs.writeFile(path.join(tempRoot, "frps.toml"), [
    "bindPort = 17000",
    'auth.method = "token"',
    `auth.token = ${JSON.stringify(token)}`,
    ""
  ].join("\n"), "utf8");

  const hostRoot = dockerPath(tempRoot);
  await fs.writeFile(composeFile, [
    `name: ${projectName}`,
    "services:",
    `  ${serviceName}:`,
    `    image: ${fixtureImage}`,
    `    container_name: ${fixtureContainer}`,
    "    command: [\"sh\", \"-c\", \"while true; do sleep 3600; done\"]",
    "    volumes:",
    `      - \"${hostRoot}/servers/${serviceName}:/data\"`,
    "  frps-test:",
    "    image: fatedier/frps:v0.70.1",
    `    container_name: ${frpsContainer}`,
    "    command: [\"-c\", \"/etc/frp/frps.toml\"]",
    "    volumes:",
    `      - \"${hostRoot}/frps.toml:/etc/frp/frps.toml:ro\"`,
    ""
  ].join("\n"), "utf8");

  await docker(["pull", "alpine:3.20"]);
  await docker(["tag", "alpine:3.20", fixtureImage]);
  await docker(["build", "-t", panelImage, "."]);
  await docker(["compose", "-f", composeFile, "up", "-d", serviceName, "frps-test"]);
  const minecraftStartedAt = await containerStartedAt(fixtureContainer);

  await docker([
    "run", "-d", "--name", panelContainer,
    "-p", `${panelPort}:8787`,
    "-e", "PANEL_HOST=0.0.0.0",
    "-e", "PANEL_PORT=8787",
    "-e", "PANEL_DATA_DIR=/data",
    "-e", `PANEL_HOST_DATA_DIR=${hostRoot}`,
    "-v", `${hostRoot}:/data`,
    "-v", "/var/run/docker.sock:/var/run/docker.sock",
    panelImage
  ]);
  await waitForPanel();

  const setup = await expectStatus("/api/auth/setup", {
    method: "POST",
    body: JSON.stringify({ username: "integration-admin", password, confirmPassword: password })
  }, 201);
  csrfToken = setup.body.csrfToken;
  assert(csrfToken, "Setup did not return a CSRF token");

  const servers = await expectStatus("/api/servers", {}, 200);
  const fixtureServer = servers.body.servers.find((server) => server.name === serviceName);
  assert(fixtureServer, "Fixture Minecraft service was not discovered");
  assert(fixtureServer.frp.settings.remotePort === 39132, "Unconfigured FRP did not default to the Minecraft server port");
  assert(!servers.text.includes(token), "Server list leaked the FRP token");

  const enableBody = {
    enabled: true,
    serverAddr: "frps-test",
    serverPort: 17000,
    remotePort: 39132,
    token,
    tlsEnabled: true
  };

  const composeBeforeConflict = await fs.readFile(composeFile, "utf8");
  await docker(["run", "-d", "--name", proxyContainer, "alpine:3.20", "sh", "-c", "while true; do sleep 3600; done"]);
  const conflictResult = await request(`/api/server/${serviceName}/frp`, {
    method: "PUT",
    body: JSON.stringify(enableBody)
  });
  assert(conflictResult.response.status >= 400, "Unmanaged container conflict unexpectedly succeeded");
  assert(await containerState(proxyContainer) === "running", "Panel removed an unmanaged conflicting container");
  assert(await fs.readFile(composeFile, "utf8") === composeBeforeConflict, "Compose was not rolled back after conflict");
  assert(await fileOrNull(settingsFile) === null && await fileOrNull(configFile) === null, "Private FRP files were not rolled back after conflict");
  assert(!conflictResult.text.includes(token), "Failed apply response leaked the FRP token");
  await docker(["rm", "-f", proxyContainer]);

  const enabled = await expectStatus(`/api/server/${serviceName}/frp`, {
    method: "PUT",
    body: JSON.stringify(enableBody)
  }, 200);
  assert(enabled.body.settings.tokenConfigured === true, "Token configured status was not returned");
  assert(!enabled.text.includes(token) && enabled.body.settings.token === undefined, "FRP save response leaked the token");
  assert(await containerState(proxyContainer) === "running", "FRP proxy was not started");
  assert(await containerStartedAt(fixtureContainer) === minecraftStartedAt, "Minecraft fixture was restarted during FRP enable");

  const composeWithFrp = await fs.readFile(composeFile, "utf8");
  assert(composeWithFrp.includes(`frpc-${serviceName}:`), "FRP Compose service was not added");
  assert(!composeWithFrp.includes(token), "Compose contains the FRP token");
  const storedSettings = JSON.parse(await fs.readFile(settingsFile, "utf8"));
  assert(storedSettings.token === token, "Stored token differs from submitted token");
  const generatedConfig = await fs.readFile(configFile, "utf8");
  assert(generatedConfig.includes(token), "Generated frpc config does not contain the token");

  const modes = await docker(["exec", panelContainer, "stat", "-c", "%a", `/data/servers/${serviceName}/.panel-frp/settings.json`, `/data/servers/${serviceName}/.panel-frp/frpc.toml`]);
  assert(modes.stdout.trim().split(/\s+/).every((mode) => mode === "600"), `Private files are not mode 600: ${modes.stdout.trim()}`);

  const rootFiles = await expectStatus(`/api/server/${serviceName}/files?path=`, {}, 200);
  assert(!rootFiles.body.entries.some((entry) => entry.name === ".panel-frp"), "Private FRP directory is visible in file list");
  await expectStatus(`/api/server/${serviceName}/file?path=${encodeURIComponent(".panel-frp/frpc.toml")}`, {}, 403);
  await expectStatus(`/api/server/${serviceName}/file?path=${encodeURIComponent("visible/../.panel-frp/frpc.toml")}`, {}, 403);

  const firstProxyId = (await docker(["inspect", "-f", "{{.Id}}", proxyContainer])).stdout.trim();
  const blankTokenUpdate = await expectStatus(`/api/server/${serviceName}/frp`, {
    method: "PUT",
    body: JSON.stringify({ ...enableBody, remotePort: 39133, token: "" })
  }, 200);
  const secondProxyId = (await docker(["inspect", "-f", "{{.Id}}", proxyContainer])).stdout.trim();
  assert(firstProxyId !== secondProxyId, "FRP proxy was not recreated after configuration update");
  assert(JSON.parse(await fs.readFile(settingsFile, "utf8")).token === token, "Blank token update did not preserve the stored token");
  assert(blankTokenUpdate.body.settings.remotePort === 39133 && !blankTokenUpdate.text.includes(token), "Blank-token response is invalid or leaked the token");
  assert(await containerStartedAt(fixtureContainer) === minecraftStartedAt, "Minecraft fixture was restarted during FRP update");

  const validCompose = await fs.readFile(composeFile, "utf8");
  const validSettings = await fs.readFile(settingsFile, "utf8");
  const validConfig = await fs.readFile(configFile, "utf8");
  const invalidCases = [
    { ...enableBody, serverAddr: "http://invalid.example" },
    { ...enableBody, serverPort: 0 },
    { ...enableBody, remotePort: 65536 },
    { ...enableBody, token: "invalid\ntoken" }
  ];
  for (const invalid of invalidCases) {
    await expectStatus(`/api/server/${serviceName}/frp`, { method: "PUT", body: JSON.stringify(invalid) }, 400);
    assert(await fs.readFile(composeFile, "utf8") === validCompose, "Invalid input changed Compose");
    assert(await fs.readFile(settingsFile, "utf8") === validSettings, "Invalid input changed FRP settings");
    assert(await fs.readFile(configFile, "utf8") === validConfig, "Invalid input changed frpc config");
  }

  await expectStatus(`/api/server/${serviceName}/frp/action`, { method: "POST", body: JSON.stringify({ action: "stop" }) }, 200);
  assert(await containerState(proxyContainer) === "exited", "FRP proxy did not stop");
  await expectStatus(`/api/server/${serviceName}/frp/action`, { method: "POST", body: JSON.stringify({ action: "start" }) }, 200);
  assert(await containerState(proxyContainer) === "running", "FRP proxy did not start after being stopped");
  await expectStatus(`/api/server/${serviceName}/frp/action`, { method: "POST", body: JSON.stringify({ action: "restart" }) }, 200);
  assert(await containerState(proxyContainer) === "running", "FRP proxy did not restart");

  await new Promise((resolve) => setTimeout(resolve, 1000));
  const logs = await expectStatus(`/api/server/${serviceName}/frp/logs?tail=200`, {}, 200);
  assert(!logs.text.includes(token), "FRP logs API leaked the token");
  const panelLog = await fileOrNull(path.join(tempRoot, "panel.log"));
  assert(!String(panelLog).includes(token), "Panel log leaked the FRP token");

  const disabled = await expectStatus(`/api/server/${serviceName}/frp`, {
    method: "PUT",
    body: JSON.stringify({ ...enableBody, enabled: false, token: "" })
  }, 200);
  assert(disabled.body.settings.enabled === false && !disabled.text.includes(token), "Disable response is invalid or leaked the token");
  const composeDisabled = await fs.readFile(composeFile, "utf8");
  assert(!composeDisabled.includes(`frpc-${serviceName}:`), "FRP Compose service remains after disable");
  const proxyInspect = await docker(["ps", "-a", "--filter", `name=^/${proxyContainer}$`, "--format", "{{.Names}}"]);
  assert(!proxyInspect.stdout.trim(), "FRP proxy container remains after disable");
  assert(await containerStartedAt(fixtureContainer) === minecraftStartedAt, "Minecraft fixture was restarted during FRP lifecycle tests");

  console.log(JSON.stringify({
    ok: true,
    serviceName,
    assertions: [
      "isolated authenticated API",
      "unmanaged container protection and rollback",
      "secret redaction and private file isolation",
      "forced FRP config apply",
      "start/stop/restart/logs",
      "disable cleanup without Minecraft restart"
    ]
  }, null, 2));
}

async function cleanup() {
  await docker(["rm", "-f", proxyContainer], {}).catch(() => {});
  await docker(["rm", "-f", panelContainer], {}).catch(() => {});
  await docker(["compose", "-f", composeFile, "down", "-v", "--remove-orphans"], {}).catch(() => {});
  await docker(["image", "rm", fixtureImage], {}).catch(() => {});
  await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
}

main().then(cleanup, async (error) => {
  console.error(error.stack || error.message || error);
  try {
    const logs = await docker(["logs", panelContainer]);
    console.error(logs.stdout || logs.stderr);
  } catch {}
  await cleanup();
  process.exitCode = 1;
});

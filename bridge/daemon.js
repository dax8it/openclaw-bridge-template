#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const net = require("net");
const http = require("http");
const crypto = require("crypto");
const os = require("os");
const { spawn, spawnSync } = require("child_process");

const BRIDGE_ROOT = path.resolve(__dirname, "..");
const DEFAULT_CONFIG_PATH = path.resolve(process.cwd(), "bridge/config.json");
const CONFIG_PATH = path.resolve(process.env.OPENCLAW_BRIDGE_CONFIG || DEFAULT_CONFIG_PATH);

function nowIso() {
  return new Date().toISOString();
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function ensureArray(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (value === undefined || value === null) {
    return [];
  }
  return [value];
}

function toNumber(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function preferredPath(currentPath) {
  const base = String(currentPath || "");
  const entries = [
    "/opt/homebrew/opt/node@22/bin",
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ];
  const existing = base.split(":").filter(Boolean);
  const merged = [];
  for (const item of entries.concat(existing)) {
    if (!item || merged.includes(item)) {
      continue;
    }
    merged.push(item);
  }
  return merged.join(":");
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
}

function sha256(input) {
  return crypto.createHash("sha256").update(String(input)).digest("hex");
}

function shellQuote(value) {
  return `'${String(value === undefined || value === null ? "" : value).replace(/'/g, "'\\''")}'`;
}

function safeCompareHash(plain, expectedHash) {
  const actual = Buffer.from(sha256(plain), "hex");
  const expected = Buffer.from(String(expectedHash || ""), "hex");
  if (actual.length !== expected.length) {
    return false;
  }
  return crypto.timingSafeEqual(actual, expected);
}

function randomId(prefix = "msg") {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

function expandHome(inputPath) {
  if (!inputPath || typeof inputPath !== "string") {
    return inputPath;
  }
  if (inputPath === "~") {
    return os.homedir();
  }
  if (inputPath.startsWith("~/")) {
    return path.join(os.homedir(), inputPath.slice(2));
  }
  return inputPath;
}

function normalizePath(inputPath) {
  return path.resolve(expandHome(inputPath));
}

function loadConfig(configPath) {
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config not found: ${configPath}`);
  }
  const raw = fs.readFileSync(configPath, "utf8");
  const parsed = JSON.parse(raw);

  const defaults = {
    socketPath: path.resolve(process.cwd(), "bridge/runtime/openclaw-bridge.sock"),
    socketMode: "0660",
    httpHost: "127.0.0.1",
    httpPort: 8787,
    maxMessageBytes: 65536,
    queueLimit: 500,
    logFile: path.resolve(process.cwd(), "bridge/runtime/bridge.log"),
    clients: [],
    missionControl: {},
  };

  const config = Object.assign({}, defaults, parsed);
  if (!Array.isArray(config.clients) || config.clients.length === 0) {
    throw new Error("config.clients must contain at least one client");
  }

  const seen = new Set();
  for (const client of config.clients) {
    if (!client.id || !client.keySha256) {
      throw new Error("each client requires id and keySha256");
    }
    if (seen.has(client.id)) {
      throw new Error(`duplicate client id: ${client.id}`);
    }
    seen.add(client.id);
    client.canSendTo = Array.isArray(client.canSendTo) ? client.canSendTo : [];
  }

  return config;
}

function ensureRuntime(config) {
  fs.mkdirSync(path.dirname(config.socketPath), { recursive: true });
  fs.mkdirSync(path.dirname(config.logFile), { recursive: true });
}

const config = loadConfig(CONFIG_PATH);
ensureRuntime(config);

const runtimeEvents = [];
const maxRuntimeEvents = 1000;

function pushRuntimeEvent(level, eventType, message, extra) {
  const entry = {
    id: randomId("evt"),
    ts: nowIso(),
    level: level || "info",
    eventType: eventType || "bridge.log",
    source: "bridge",
    message: String(message || ""),
    details: extra || null,
  };
  runtimeEvents.push(entry);
  if (runtimeEvents.length > maxRuntimeEvents) {
    runtimeEvents.shift();
  }
}

function writeLog(message, extra, level = "info") {
  const line = `[${nowIso()}] ${message}${extra ? ` ${safeJson(extra)}` : ""}`;
  console.log(line);
  pushRuntimeEvent(level, "bridge.log", message, extra);
  try {
    fs.appendFileSync(config.logFile, `${line}\n`);
  } catch (err) {
    console.error(`[${nowIso()}] failed to append log`, err.message);
  }
}

const clientsById = new Map(config.clients.map((c) => [c.id, c]));
const activeConnections = new Map();
const pendingQueues = new Map();

function getQueue(clientId) {
  if (!pendingQueues.has(clientId)) {
    pendingQueues.set(clientId, []);
  }
  return pendingQueues.get(clientId);
}

function setSocketMode(socketPath, modeText) {
  try {
    const mode = Number.parseInt(modeText, 8);
    if (!Number.isNaN(mode)) {
      fs.chmodSync(socketPath, mode);
    }
  } catch (err) {
    writeLog("failed to chmod socket", { socketPath, error: err.message }, "warn");
  }
}

function sendJson(socket, payload) {
  try {
    socket.write(`${JSON.stringify(payload)}\n`);
  } catch (err) {
    writeLog("sendJson failed", { error: err.message }, "warn");
  }
}

function canRoute(fromClientId, toClientId) {
  const sender = clientsById.get(fromClientId);
  if (!sender) {
    return false;
  }
  if (sender.canSendTo.includes("*")) {
    return true;
  }
  return sender.canSendTo.includes(toClientId);
}

function registerConnection(clientId, connState) {
  if (!activeConnections.has(clientId)) {
    activeConnections.set(clientId, new Set());
  }
  activeConnections.get(clientId).add(connState);
}

function unregisterConnection(clientId, connState) {
  if (!activeConnections.has(clientId)) {
    return;
  }
  const set = activeConnections.get(clientId);
  set.delete(connState);
  if (set.size === 0) {
    activeConnections.delete(clientId);
  }
}

function deliverEnvelope(envelope) {
  const recipients = activeConnections.get(envelope.to);
  if (!recipients || recipients.size === 0) {
    const queue = getQueue(envelope.to);
    queue.push(envelope);
    if (queue.length > config.queueLimit) {
      queue.shift();
    }
    pushRuntimeEvent("warn", "bridge.route", `queued message for ${envelope.to}`, {
      from: envelope.from,
      to: envelope.to,
      type: envelope.type,
      envelopeId: envelope.id,
    });
    return { deliveredTo: 0, queued: true };
  }

  for (const conn of recipients) {
    sendJson(conn.socket, { action: "message", envelope });
  }
  pushRuntimeEvent("info", "bridge.route", `delivered message to ${envelope.to}`, {
    from: envelope.from,
    to: envelope.to,
    type: envelope.type,
    envelopeId: envelope.id,
    recipients: recipients.size,
  });
  return { deliveredTo: recipients.size, queued: false };
}

function flushQueue(clientId, socket) {
  const queue = getQueue(clientId);
  if (queue.length === 0) {
    return 0;
  }

  let delivered = 0;
  while (queue.length > 0) {
    const envelope = queue.shift();
    sendJson(socket, { action: "message", envelope });
    delivered += 1;
  }
  return delivered;
}

function parseJsonOrNull(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function socketPeer(socket) {
  return `${socket.remoteAddress || "local"}:${socket.remotePort || "-"}`;
}

if (fs.existsSync(config.socketPath)) {
  try {
    fs.unlinkSync(config.socketPath);
  } catch (err) {
    writeLog("failed to remove stale socket", { error: err.message }, "warn");
  }
}

const socketServer = net.createServer((socket) => {
  const connState = {
    socket,
    buffer: "",
    authed: false,
    clientId: null,
    connectedAt: Date.now(),
  };

  writeLog("socket client connected", { peer: socketPeer(socket) });

  socket.on("data", (chunk) => {
    connState.buffer += chunk.toString("utf8");

    if (Buffer.byteLength(connState.buffer, "utf8") > config.maxMessageBytes * 2) {
      sendJson(socket, { action: "error", error: "buffer_exceeded" });
      socket.destroy();
      return;
    }

    while (true) {
      const idx = connState.buffer.indexOf("\n");
      if (idx === -1) {
        break;
      }
      const line = connState.buffer.slice(0, idx).trim();
      connState.buffer = connState.buffer.slice(idx + 1);

      if (!line) {
        continue;
      }

      if (Buffer.byteLength(line, "utf8") > config.maxMessageBytes) {
        sendJson(socket, { action: "error", error: "message_too_large" });
        continue;
      }

      const msg = parseJsonOrNull(line);
      if (!msg) {
        sendJson(socket, { action: "error", error: "invalid_json" });
        continue;
      }

      if (!connState.authed) {
        if (msg.action !== "auth") {
          sendJson(socket, { action: "error", error: "auth_required" });
          continue;
        }

        const clientDef = clientsById.get(msg.clientId);
        if (!clientDef || !safeCompareHash(msg.apiKey || "", clientDef.keySha256)) {
          sendJson(socket, { action: "auth_failed" });
          socket.destroy();
          return;
        }

        connState.authed = true;
        connState.clientId = clientDef.id;
        registerConnection(clientDef.id, connState);

        sendJson(socket, {
          action: "auth_ok",
          clientId: clientDef.id,
          queued: getQueue(clientDef.id).length,
          ts: nowIso(),
        });
        const flushed = flushQueue(clientDef.id, socket);
        writeLog("client authenticated", { clientId: clientDef.id, peer: socketPeer(socket), flushed });
        continue;
      }

      if (msg.action === "ping") {
        sendJson(socket, { action: "pong", ts: nowIso() });
        continue;
      }

      if (msg.action === "send") {
        if (!msg.to || typeof msg.to !== "string") {
          sendJson(socket, { action: "error", error: "missing_to" });
          continue;
        }

        if (!clientsById.has(msg.to)) {
          sendJson(socket, { action: "error", error: "unknown_target" });
          continue;
        }

        if (!canRoute(connState.clientId, msg.to)) {
          sendJson(socket, { action: "error", error: "route_not_allowed" });
          continue;
        }

        const envelope = {
          id: msg.id || randomId("m"),
          from: connState.clientId,
          to: msg.to,
          type: msg.type || "message",
          payload: msg.payload === undefined ? null : msg.payload,
          correlationId: msg.correlationId || null,
          ts: nowIso(),
        };

        const routed = deliverEnvelope(envelope);
        sendJson(socket, {
          action: "sent",
          id: envelope.id,
          deliveredTo: routed.deliveredTo,
          queued: routed.queued,
          ts: envelope.ts,
        });
        continue;
      }

      if (msg.action === "whoami") {
        sendJson(socket, {
          action: "whoami",
          clientId: connState.clientId,
          canSendTo: clientsById.get(connState.clientId).canSendTo,
          ts: nowIso(),
        });
        continue;
      }

      sendJson(socket, { action: "error", error: "unknown_action" });
    }
  });

  socket.on("close", () => {
    if (connState.clientId) {
      unregisterConnection(connState.clientId, connState);
      writeLog("socket client disconnected", {
        clientId: connState.clientId,
        lifetimeMs: Date.now() - connState.connectedAt,
      });
    }
  });

  socket.on("error", (err) => {
    writeLog("socket error", { error: err.message, clientId: connState.clientId }, "warn");
  });
});

socketServer.on("error", (err) => {
  writeLog("socket server error", { error: err.message }, "error");
  process.exit(1);
});

socketServer.listen(config.socketPath, () => {
  setSocketMode(config.socketPath, config.socketMode);
  writeLog("bridge socket ready", { socketPath: config.socketPath, mode: config.socketMode });
});

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk.toString("utf8");
      if (Buffer.byteLength(data, "utf8") > config.maxMessageBytes * 2) {
        reject(new Error("body_too_large"));
      }
    });
    req.on("end", () => {
      if (!data.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error("invalid_json"));
      }
    });
    req.on("error", reject);
  });
}

function json(res, code, payload) {
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function isAuthorizedHttp(req) {
  if (!config.adminTokenSha256) {
    return false;
  }
  const token = req.headers["x-bridge-token"];
  if (!token || Array.isArray(token)) {
    return false;
  }
  return safeCompareHash(token, config.adminTokenSha256);
}

function buildStatus() {
  const active = {};
  for (const [id, set] of activeConnections.entries()) {
    active[id] = set.size;
  }

  const queued = {};
  for (const client of config.clients) {
    queued[client.id] = getQueue(client.id).length;
  }

  return {
    ts: nowIso(),
    socketPath: config.socketPath,
    active,
    queued,
    clients: config.clients.map((c) => ({ id: c.id, canSendTo: c.canSendTo })),
  };
}

function routeAdminSend(body) {
  if (!body.asClient || !body.to) {
    return { ok: false, error: "asClient_and_to_required" };
  }
  if (!clientsById.has(body.asClient) || !clientsById.has(body.to)) {
    return { ok: false, error: "unknown_client" };
  }
  if (!canRoute(body.asClient, body.to)) {
    return { ok: false, error: "route_not_allowed" };
  }

  const envelope = {
    id: body.id || randomId("admin"),
    from: body.asClient,
    to: body.to,
    type: body.type || "message",
    payload: body.payload === undefined ? null : body.payload,
    correlationId: body.correlationId || null,
    ts: nowIso(),
  };

  const routed = deliverEnvelope(envelope);
  return { ok: true, envelope, routed };
}

function pathExists(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function safeStat(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function safeReadJson(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    try {
      return { ok: true, data: JSON.parse(raw) };
    } catch {
      const lines = raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      const list = [];
      for (const line of lines) {
        try {
          list.push(JSON.parse(line));
        } catch {
          return { ok: false, error: "invalid_json" };
        }
      }
      return { ok: true, data: list };
    }
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function readFirstExistingJson(dirs, candidates) {
  for (const dir of dirs) {
    if (!dir || !pathExists(dir) || !safeStat(dir)?.isDirectory()) {
      continue;
    }
    for (const candidate of candidates) {
      const filePath = path.join(dir, candidate);
      if (!pathExists(filePath) || !safeStat(filePath)?.isFile()) {
        continue;
      }
      const parsed = safeReadJson(filePath);
      if (!parsed.ok) {
        return {
          ok: false,
          error: parsed.error,
          path: filePath,
          source: dir,
          mtimeMs: safeStat(filePath)?.mtimeMs || null,
        };
      }
      return {
        ok: true,
        data: parsed.data,
        path: filePath,
        source: dir,
        mtimeMs: safeStat(filePath)?.mtimeMs || null,
      };
    }
  }
  return { ok: false, error: "not_found", path: null, source: null, mtimeMs: null };
}

function readDirectoryLatestMtime(dirPath) {
  try {
    if (!dirPath || !safeStat(dirPath)?.isDirectory()) {
      return null;
    }
    const names = fs.readdirSync(dirPath);
    let latest = null;
    for (const name of names) {
      const full = path.join(dirPath, name);
      const st = safeStat(full);
      if (!st || !st.isFile()) {
        continue;
      }
      if (latest === null || st.mtimeMs > latest) {
        latest = st.mtimeMs;
      }
    }
    return latest;
  } catch {
    return null;
  }
}

function uniqueStrings(values) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    const text = String(value || "").trim();
    if (!text || seen.has(text)) {
      continue;
    }
    seen.add(text);
    out.push(text);
  }
  return out;
}

function writeJsonFile(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function appendJsonLineFile(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, "utf8");
}

function copyStateFileToCanvas(fileName) {
  const statePath = path.join(missionControlSettings.stateDir, fileName);
  const stateStat = safeStat(statePath);
  if (!stateStat || !stateStat.isFile()) {
    return;
  }
  fs.mkdirSync(missionControlSettings.canvasDir, { recursive: true });
  const canvasPath = path.join(missionControlSettings.canvasDir, fileName);
  fs.copyFileSync(statePath, canvasPath);
}

function loadSchedulesForWrite(filePath) {
  const parsed = safeReadJson(filePath);
  if (!parsed.ok) {
    return { schema: "openclaw.mission-control.schedules.v0", generatedAt: nowIso(), items: [] };
  }
  if (Array.isArray(parsed.data)) {
    return { schema: "openclaw.mission-control.schedules.v0", generatedAt: nowIso(), items: parsed.data };
  }
  const root = asObject(parsed.data);
  const items = unwrapArrayPayload(root, ["schedules", "items", "jobs", "tasks"]);
  return {
    schema: String(root.schema || "openclaw.mission-control.schedules.v0"),
    generatedAt: root.generatedAt || nowIso(),
    items: Array.isArray(items) ? items : [],
  };
}

function unwrapArrayPayload(payload, keys) {
  if (Array.isArray(payload)) {
    return payload;
  }
  const obj = asObject(payload);
  for (const key of keys) {
    if (Array.isArray(obj[key])) {
      return obj[key];
    }
  }
  return [];
}

function normalizeTimestamp(value) {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toISOString();
}

function normalizeEvent(raw, index) {
  const obj = asObject(raw);
  const levelRaw = String(obj.level || obj.severity || obj.kind || "info").toLowerCase();
  let level = "info";
  if (levelRaw.includes("err") || levelRaw.includes("fatal")) {
    level = "error";
  } else if (levelRaw.includes("warn")) {
    level = "warn";
  }
  const ts = normalizeTimestamp(obj.ts || obj.timestamp || obj.time) || nowIso();
  return {
    id: String(obj.id || `event_${index}`),
    ts,
    level,
    eventType: String(obj.eventType || obj.type || "event"),
    source: String(obj.source || obj.component || "openclaw"),
    message: String(obj.message || obj.summary || obj.text || obj.event || "(no message)"),
    sessionId: obj.sessionId || obj.session || null,
    agentId: obj.agentId || obj.agent || obj.clientId || null,
    projectId: obj.projectId || obj.project || null,
    correlationId: obj.correlationId || obj.traceId || null,
    details: obj,
  };
}

function slugify(input) {
  return String(input || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || randomId("proj");
}

function parseFrontmatter(content) {
  if (!content.startsWith("---\n")) {
    return {};
  }
  const end = content.indexOf("\n---", 4);
  if (end === -1) {
    return {};
  }
  const block = content.slice(4, end).split(/\r?\n/);
  const out = {};
  for (const line of block) {
    const idx = line.indexOf(":");
    if (idx === -1) {
      continue;
    }
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key) {
      out[key] = value;
    }
  }
  return out;
}

function findMarkdownField(content, field) {
  const re = new RegExp(`(?:^|\\n)\\s*(?:[-*]\\s*)?${field}\\s*:\\s*(.+)`, "i");
  const match = content.match(re);
  return match ? match[1].trim() : "";
}

function firstHeading(content) {
  const match = content.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : "";
}

function readWorkspaceProjectFile(filePath, sourceRoot) {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    const fm = parseFrontmatter(content);
    const title = fm.title || firstHeading(content) || path.basename(filePath, path.extname(filePath));
    const status = fm.status || findMarkdownField(content, "status") || "unknown";
    const phase = fm.phase || findMarkdownField(content, "phase") || "";
    const next = fm.next || findMarkdownField(content, "next") || "";
    const id = fm.id || slugify(title);
    return {
      id,
      title,
      status,
      phase,
      next,
      source: "workspace",
      sourcePath: filePath,
      workspaceRoot: sourceRoot,
      updatedAt: normalizeTimestamp(fm.updated || fm.updated_at) || normalizeTimestamp(safeStat(filePath)?.mtime),
    };
  } catch {
    return null;
  }
}

function collectWorkspaceProjects(workspaceRoots) {
  const projects = [];
  const seen = new Set();
  for (const root of workspaceRoots) {
    const normalizedRoot = normalizePath(root);
    const dirs = [path.join(normalizedRoot, "workspace/projects"), path.join(normalizedRoot, "projects")];

    for (const dir of dirs) {
      const dirStat = safeStat(dir);
      if (!dirStat || !dirStat.isDirectory()) {
        continue;
      }

      let files = [];
      try {
        files = fs.readdirSync(dir)
          .filter((name) => name.toLowerCase().endsWith(".md"))
          .map((name) => path.join(dir, name));
      } catch {
        files = [];
      }

      for (const filePath of files) {
        const parsed = readWorkspaceProjectFile(filePath, normalizedRoot);
        if (!parsed || seen.has(parsed.id)) {
          continue;
        }
        seen.add(parsed.id);
        projects.push(parsed);
      }

      const indexCandidates = ["index.json", "projects.json"];
      for (const candidate of indexCandidates) {
        const idxPath = path.join(dir, candidate);
        if (!safeStat(idxPath)?.isFile()) {
          continue;
        }
        const parsed = safeReadJson(idxPath);
        if (!parsed.ok) {
          continue;
        }
        const list = unwrapArrayPayload(parsed.data, ["projects", "items"]);
        for (const rawProject of list) {
          const obj = asObject(rawProject);
          const title = obj.title || obj.name || obj.id;
          if (!title) {
            continue;
          }
          const id = obj.id || slugify(title);
          if (seen.has(id)) {
            continue;
          }
          seen.add(id);
          projects.push({
            id,
            title: String(title),
            status: String(obj.status || "unknown"),
            phase: String(obj.phase || ""),
            next: String(obj.next || obj.nextAction || ""),
            source: "workspace-index",
            sourcePath: idxPath,
            workspaceRoot: normalizedRoot,
            updatedAt: normalizeTimestamp(obj.updatedAt || obj.updated || safeStat(idxPath)?.mtime),
          });
        }
      }
    }
  }
  return projects;
}

function mergeProjects(primary, secondary) {
  const merged = new Map();
  for (const project of primary.concat(secondary)) {
    const obj = asObject(project);
    const title = String(obj.title || obj.name || obj.id || "").trim();
    if (!title) {
      continue;
    }
    const id = String(obj.id || slugify(title));
    if (!merged.has(id)) {
      merged.set(id, {
        id,
        title,
        status: String(obj.status || "unknown"),
        phase: String(obj.phase || ""),
        next: String(obj.next || obj.nextAction || ""),
        source: obj.source || "state",
        sourcePath: obj.sourcePath || null,
        updatedAt: normalizeTimestamp(obj.updatedAt || obj.updated || obj.ts),
      });
      continue;
    }
    const prev = merged.get(id);
    merged.set(id, {
      id,
      title: prev.title || title,
      status: prev.status !== "unknown" ? prev.status : String(obj.status || "unknown"),
      phase: prev.phase || String(obj.phase || ""),
      next: prev.next || String(obj.next || obj.nextAction || ""),
      source: prev.source,
      sourcePath: prev.sourcePath || obj.sourcePath || null,
      updatedAt: prev.updatedAt || normalizeTimestamp(obj.updatedAt || obj.updated || obj.ts),
    });
  }
  return Array.from(merged.values());
}

function deriveSessions(rawSessions) {
  const out = [];
  const sessions = unwrapArrayPayload(rawSessions, ["sessions", "items", "recent"]);
  const root = asObject(rawSessions);
  const sourceList = sessions.length > 0 ? sessions : (Array.isArray(root.recent) ? root.recent : []);
  for (const raw of sourceList) {
    const obj = asObject(raw);
    const id = String(obj.id || obj.sessionId || randomId("session"));
    const contextRaw = toNumber(
      obj.contextUsagePct,
      toNumber(obj.contextUsage, toNumber(obj.percentUsed, null)),
    );
    const contextUsagePct = contextRaw === null ? null : contextRaw <= 1 ? Math.round(contextRaw * 100) : Math.round(contextRaw);
    out.push({
      id,
      sessionKey: String(obj.key || obj.sessionKey || id),
      agentId: String(obj.agentId || obj.agent || obj.clientId || ""),
      model: String(obj.model || obj.llm || ""),
      freshness: String(obj.freshness || obj.lastSeen || ""),
      contextUsagePct,
      projectId: String(obj.projectId || obj.project || ""),
      role: String(obj.role || ""),
      ts: normalizeTimestamp(obj.ts || obj.updatedAt || obj.lastMessageTs || obj.startedAt),
    });
  }
  return out;
}

function applyProjectAssignmentsToSessions(sessions, rawProjectsDoc) {
  const list = Array.isArray(sessions) ? sessions : [];
  const assignments = Array.isArray(asObject(rawProjectsDoc).assignments)
    ? asObject(rawProjectsDoc).assignments
    : [];
  if (assignments.length === 0) {
    return list;
  }

  const normalized = assignments
    .map((raw) => {
      const obj = asObject(raw);
      const prefix = String(obj.sessionKeyPrefix || "").trim();
      const agentId = String(obj.agentId || "").trim();
      const projectId = String(obj.projectId || obj.project || "").trim();
      const role = String(obj.role || "").trim();
      if (!prefix && !agentId) {
        return null;
      }
      if (!projectId && !role) {
        return null;
      }
      return { prefix, agentId, projectId, role };
    })
    .filter(Boolean)
    .sort((a, b) => b.prefix.length - a.prefix.length);

  return list.map((session) => {
    const current = asObject(session);
    const currentProject = String(current.projectId || "").trim();
    const currentRole = String(current.role || "").trim();
    if (currentProject && currentRole) {
      return session;
    }

    const sessionKey = String(current.sessionKey || "");
    const agentId = String(current.agentId || "");
    const match = normalized.find((item) => {
      if (item.prefix && sessionKey.startsWith(item.prefix)) {
        return true;
      }
      if (item.agentId && normalizeAgentHandle(item.agentId) === normalizeAgentHandle(agentId)) {
        return true;
      }
      return false;
    });
    if (!match) {
      return session;
    }
    return {
      ...session,
      projectId: currentProject || match.projectId || "",
      role: currentRole || match.role || "",
    };
  });
}

function normalizeAgentHandle(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .replace(/^operations/, "ops")
    .replace(/^operation/, "ops");
}

function roleMatchesAgent(roleText, agent) {
  const role = normalizeAgentHandle(roleText);
  if (!role) {
    return false;
  }
  const id = normalizeAgentHandle(agent?.id || "");
  const name = normalizeAgentHandle(agent?.name || "");
  if (!id && !name) {
    return false;
  }
  if (role === id || role === name) {
    return true;
  }
  if (id && (role.includes(id) || id.includes(role))) {
    return true;
  }
  if (name && (role.includes(name) || name.includes(role))) {
    return true;
  }
  if (
    role.includes("orchestrator")
    && (id.includes("opsbob") || name.includes("opsbob"))
  ) {
    return true;
  }
  return false;
}

function deriveAgents(input) {
  const {
    agentSources,
    sessions,
    events,
    missions,
    projects,
    bridgeStatus,
    clients,
  } = input;

  const byAgent = new Map();

  for (const client of clients) {
    byAgent.set(client.id, {
      id: client.id,
      name: client.id,
      status: "idle",
      assignment: "",
      lastMessage: "",
      next: "",
      model: "",
      freshness: "",
      contextUsagePct: null,
      avatar: "",
      channels: [],
      activeConnections: bridgeStatus.active[client.id] || 0,
    });
  }

  for (const raw of agentSources) {
    const obj = asObject(raw);
    const id = String(obj.id || obj.agentId || obj.clientId || "").trim();
    if (!id) {
      continue;
    }
    const prev = byAgent.get(id) || {
      id,
      name: id,
      status: "idle",
      assignment: "",
      lastMessage: "",
      next: "",
      model: "",
      freshness: "",
      contextUsagePct: null,
      avatar: "",
      channels: [],
      activeConnections: bridgeStatus.active[id] || 0,
    };

    const contextRaw = toNumber(obj.contextUsagePct, toNumber(obj.contextUsage, null));
    const contextUsagePct = contextRaw === null ? prev.contextUsagePct : (contextRaw <= 1 ? Math.round(contextRaw * 100) : Math.round(contextRaw));

    byAgent.set(id, {
      id,
      name: String(obj.name || prev.name || id),
      status: String(obj.status || prev.status || "idle"),
      assignment: String(obj.assignment || obj.project || obj.currentProject || prev.assignment || ""),
      lastMessage: String(obj.lastMessage || obj.summary || prev.lastMessage || ""),
      next: String(obj.next || obj.nextAction || prev.next || ""),
      model: String(obj.model || prev.model || ""),
      freshness: String(obj.freshness || obj.lastSeen || prev.freshness || ""),
      contextUsagePct,
      avatar: String(obj.avatar || obj.avatarUrl || prev.avatar || ""),
      channels: Array.isArray(obj.channels) ? obj.channels : prev.channels,
      activeConnections: bridgeStatus.active[id] || prev.activeConnections || 0,
    });
  }

  for (const session of sessions) {
    if (!session.agentId) {
      continue;
    }
    const prev = byAgent.get(session.agentId) || {
      id: session.agentId,
      name: session.agentId,
      status: "idle",
      assignment: "",
      lastMessage: "",
      next: "",
      model: "",
      freshness: "",
      contextUsagePct: null,
      avatar: "",
      channels: [],
      activeConnections: bridgeStatus.active[session.agentId] || 0,
    };
    const sessionTsMs = session.ts ? new Date(session.ts).getTime() : 0;
    const freshSession = Number.isFinite(sessionTsMs) && (Date.now() - sessionTsMs) < (2 * 60 * 60 * 1000);
    byAgent.set(session.agentId, {
      ...prev,
      status: (prev.activeConnections > 0 || freshSession) ? "active" : (prev.status || "idle"),
      assignment: prev.assignment || session.projectId || "",
      model: prev.model || session.model || "",
      freshness: prev.freshness || session.freshness || "",
      contextUsagePct: prev.contextUsagePct === null ? session.contextUsagePct : prev.contextUsagePct,
    });
  }

  const latestEventByAgent = new Map();
  for (const event of events) {
    if (!event.agentId) {
      continue;
    }
    if (!latestEventByAgent.has(event.agentId)) {
      latestEventByAgent.set(event.agentId, event);
    }
  }

  const missionList = Array.isArray(missions) ? missions : [];
  const projectList = Array.isArray(projects) ? projects : [];
  function missionRank(mission) {
    const rank = { in_progress: 0, todo: 1, done: 2 };
    return rank[String(mission?.status || "").toLowerCase()] === undefined
      ? 3
      : rank[String(mission.status).toLowerCase()];
  }

  for (const [id, agent] of byAgent.entries()) {
    const event = latestEventByAgent.get(id);
    const status = agent.activeConnections > 0 ? "active" : agent.status;
    const matchedMissions = missionList
      .filter((mission) => {
        if (!mission || typeof mission !== "object") {
          return false;
        }
        const missionAgent = normalizeAgentHandle(mission.agentId || "");
        const idHandle = normalizeAgentHandle(id);
        if (missionAgent && missionAgent === idHandle) {
          return true;
        }
        return roleMatchesAgent(mission.role, agent);
      })
      .sort((a, b) => {
        const ra = missionRank(a);
        const rb = missionRank(b);
        if (ra !== rb) {
          return ra - rb;
        }
        const ad = a.dueAt ? new Date(a.dueAt).getTime() : Number.MAX_SAFE_INTEGER;
        const bd = b.dueAt ? new Date(b.dueAt).getTime() : Number.MAX_SAFE_INTEGER;
        return ad - bd;
      });
    const topMission = matchedMissions[0] || null;
    const inferredAssignment = topMission
      ? String(topMission.projectId || topMission.title || "").trim()
      : "";
    const inferredNext = topMission ? String(topMission.next || "") : "";
    const projectMatch = projectList.find(
      (project) => normalizeAgentHandle(project?.id || "") === normalizeAgentHandle(id),
    );
    const projectFallbackAssignment = projectMatch ? String(projectMatch.id || "") : "";
    const projectFallbackNext = projectMatch ? String(projectMatch.next || "") : "";

    byAgent.set(id, {
      ...agent,
      status,
      assignment: agent.assignment || inferredAssignment || projectFallbackAssignment,
      lastMessage: agent.lastMessage || (event ? event.message : "No messages yet"),
      next: agent.next
        || inferredNext
        || projectFallbackNext
        || (agent.assignment || inferredAssignment || projectFallbackAssignment
          ? `Move ${agent.assignment || inferredAssignment || projectFallbackAssignment} forward`
          : "Pick next mission"),
      freshness: agent.freshness || (event ? event.ts : ""),
    });
  }

  return Array.from(byAgent.values()).sort((a, b) => {
    if (a.activeConnections !== b.activeConnections) {
      return b.activeConnections - a.activeConnections;
    }
    return a.id.localeCompare(b.id);
  });
}

function canonicalMissionStatus(rawStatus, fallback = "todo") {
  const value = String(rawStatus || fallback || "todo").toLowerCase().trim();
  if (!value) {
    return "todo";
  }
  if (
    value.includes("done")
    || value.includes("complete")
    || value.includes("closed")
    || value.includes("ship")
    || value.includes("resolve")
  ) {
    return "done";
  }
  if (
    value.includes("progress")
    || value.includes("active")
    || value.includes("doing")
    || value.includes("assigned")
    || value.includes("review")
    || value.includes("block")
  ) {
    return "in_progress";
  }
  return "todo";
}

function inferMissionStatusFromProject(project) {
  return canonicalMissionStatus(project?.status || "todo", "todo");
}

function normalizeMissionItems(rawMissions, projects) {
  const missions = unwrapArrayPayload(rawMissions, ["missions", "items", "queue"]);
  const out = [];
  const seenMissionIds = new Set();
  const missionProjects = new Set();
  for (const raw of missions) {
    const obj = asObject(raw);
    const title = String(obj.title || obj.name || obj.mission || "").trim();
    if (!title) {
      continue;
    }
    const projectId = String(obj.projectId || obj.project || "");
    const missionId = String(obj.id || slugify(title));
    if (seenMissionIds.has(missionId)) {
      continue;
    }
    seenMissionIds.add(missionId);
    if (projectId) {
      missionProjects.add(projectId);
    }
    out.push({
      id: missionId,
      title,
      status: canonicalMissionStatus(obj.status, "todo"),
      rawStatus: String(obj.status || "todo"),
      projectId,
      agentId: String(obj.agentId || obj.assignedTo || ""),
      role: String(obj.role || ""),
      next: String(obj.next || obj.nextAction || ""),
      desc: String(obj.desc || obj.description || ""),
      checklist: Array.isArray(obj.checklist) ? obj.checklist : [],
      dueAt: normalizeTimestamp(obj.dueAt || obj.due || null),
      priority: String(obj.priority || ""),
      source: "missions",
    });
  }

  // Ensure all known projects appear in Mission Queue, even without explicit mission rows.
  for (const project of projects) {
    if (!project || !project.id || missionProjects.has(project.id)) {
      continue;
    }
    const title = String(project.title || project.name || project.id);
    const inferredStatus = inferMissionStatusFromProject(project);
    out.push({
      id: `mission_${project.id}`,
      title,
      status: inferredStatus,
      rawStatus: String(project.status || inferredStatus),
      projectId: project.id,
      agentId: "",
      role: "",
      next: String(project.next || ""),
      desc: "",
      checklist: [],
      dueAt: normalizeTimestamp(project.dueAt || project.due || null),
      priority: "",
      source: "project-inferred",
    });
  }

  return out.sort((a, b) => {
    const rank = { in_progress: 0, todo: 1, done: 2 };
    const ar = rank[a.status] === undefined ? 3 : rank[a.status];
    const br = rank[b.status] === undefined ? 3 : rank[b.status];
    if (ar !== br) {
      return ar - br;
    }
    return String(a.title || "").localeCompare(String(b.title || ""));
  });
}

function normalizeScheduleItems(rawSchedules) {
  const items = unwrapArrayPayload(rawSchedules, ["schedules", "items", "jobs", "tasks"]);
  return items
    .map((raw) => {
      const obj = asObject(raw);
      const title = String(obj.title || obj.name || obj.job || "").trim();
      if (!title) {
        return null;
      }
      const nextRunAt = normalizeTimestamp(obj.nextRunAt || obj.nextRun || obj.start || obj.dueAt || obj.due);
      return {
        id: String(obj.id || slugify(`${title}_${obj.cron || obj.rrule || nextRunAt || nowIso()}`)),
        title,
        projectId: String(obj.projectId || obj.project || ""),
        assignee: String(obj.assignee || obj.agentId || obj.owner || ""),
        dueAt: normalizeTimestamp(obj.dueAt || obj.due || null),
        nextRunAt,
        cron: String(obj.cron || obj.schedule || ""),
        rrule: String(obj.rrule || ""),
        timezone: String(obj.timezone || obj.tz || ""),
        notes: String(obj.notes || obj.description || ""),
        status: String(obj.status || "active"),
      };
    })
    .filter(Boolean)
    .sort((a, b) => {
      const at = a.nextRunAt ? new Date(a.nextRunAt).getTime() : Number.MAX_SAFE_INTEGER;
      const bt = b.nextRunAt ? new Date(b.nextRunAt).getTime() : Number.MAX_SAFE_INTEGER;
      return at - bt;
    });
}

function normalizeCalendarItems(rawCalendar, missions, projects, schedules) {
  const root = asObject(rawCalendar);
  const items = unwrapArrayPayload(rawCalendar, ["calendar", "items", "events"]);
  const out = items
    .map((raw) => {
      const obj = asObject(raw);
      const title = String(obj.title || obj.name || obj.summary || "").trim();
      if (!title) {
        return null;
      }
      return {
        id: String(obj.id || slugify(`${title}_${obj.start || obj.date || obj.ts || nowIso()}`)),
        title,
        start: normalizeTimestamp(obj.start || obj.date || obj.ts || obj.time),
        end: normalizeTimestamp(obj.end || obj.until || null),
        projectId: String(obj.projectId || obj.project || ""),
        notes: String(obj.notes || obj.description || ""),
        source: "calendar",
        kind: String(obj.kind || "event"),
      };
    })
    .filter(Boolean);

  if (Array.isArray(root.days)) {
    for (const day of root.days) {
      const obj = asObject(day);
      const dateText = String(obj.date || "").trim();
      if (!dateText) {
        continue;
      }
      const start = normalizeTimestamp(`${dateText}T09:00:00`);
      if (!start) {
        continue;
      }
      out.push({
        id: String(obj.id || slugify(`memory_${dateText}`)),
        title: `Memory Day ${dateText}`,
        start,
        end: null,
        projectId: "",
        notes: String(obj.summary || ""),
        source: "calendar-days",
        kind: "memory",
      });
    }
  }

  for (const mission of missions || []) {
    if (!mission?.dueAt) {
      continue;
    }
    out.push({
      id: `due_mission_${mission.id}`,
      title: `Due: ${mission.title}`,
      start: mission.dueAt,
      end: null,
      projectId: mission.projectId || "",
      notes: mission.next || "",
      source: "mission-due",
      kind: "due",
    });
  }

  for (const project of projects || []) {
    const dueAt = normalizeTimestamp(project?.dueAt || project?.due || null);
    if (!dueAt) {
      continue;
    }
    out.push({
      id: `due_project_${project.id}`,
      title: `Project Due: ${project.title || project.id}`,
      start: dueAt,
      end: null,
      projectId: project.id || "",
      notes: String(project.next || ""),
      source: "project-due",
      kind: "due",
    });
  }

  for (const schedule of schedules || []) {
    const start = schedule.nextRunAt || schedule.dueAt;
    if (!start) {
      continue;
    }
    out.push({
      id: `schedule_${schedule.id}`,
      title: `Scheduled: ${schedule.title}`,
      start,
      end: null,
      projectId: schedule.projectId || "",
      notes: [schedule.assignee ? `assignee ${schedule.assignee}` : "", schedule.cron || schedule.rrule || schedule.notes || ""]
        .filter(Boolean)
        .join(" · "),
      source: "schedule",
      kind: "scheduled",
    });
  }

  const deduped = new Map();
  for (const item of out) {
    if (!item || !item.id) {
      continue;
    }
    if (!deduped.has(item.id)) {
      deduped.set(item.id, item);
    }
  }

  return Array.from(deduped.values()).sort((a, b) => {
    const at = a.start ? new Date(a.start).getTime() : Number.MAX_SAFE_INTEGER;
    const bt = b.start ? new Date(b.start).getTime() : Number.MAX_SAFE_INTEGER;
    return at - bt;
  });
}

function normalizeNotes(rawNotes, limit = 60) {
  let items = unwrapArrayPayload(rawNotes, ["notes", "items", "entries"]);
  if (!Array.isArray(items) || items.length === 0) {
    const single = asObject(rawNotes);
    if (single.text || single.note || single.message) {
      items = [single];
    }
  }
  const parsed = items
    .map((raw) => {
      const obj = asObject(raw);
      const text = String(obj.text || obj.note || obj.message || "").trim();
      if (!text) {
        return null;
      }
      return {
        id: String(obj.id || slugify(`${text.slice(0, 24)}_${obj.ts || nowIso()}`)),
        ts: normalizeTimestamp(obj.ts || obj.createdAt || obj.created || nowIso()) || nowIso(),
        author: String(obj.author || obj.from || "operator"),
        routeTo: String(obj.routeTo || obj.route || "ops-bob"),
        nextHop: String(obj.nextHop || obj.handoffTo || "tibo"),
        projectId: String(obj.projectId || obj.project || ""),
        type: String(obj.type || "note"),
        text,
      };
    })
    .filter(Boolean)
    .sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());

  return parsed.slice(0, Math.max(1, limit));
}

function normalizeIntakeRecords(rawIntake, rawAcks, limit = 120) {
  let intakeItems = unwrapArrayPayload(rawIntake, ["intake", "items", "entries"]);
  if (!Array.isArray(intakeItems) || intakeItems.length === 0) {
    const single = asObject(rawIntake);
    if (single.noteId || single.summary || single.status) {
      intakeItems = [single];
    }
  }

  let ackItems = unwrapArrayPayload(rawAcks, ["acks", "items", "events"]);
  if (!Array.isArray(ackItems) || ackItems.length === 0) {
    const single = asObject(rawAcks);
    if (single.noteId || single.intakeId || single.status) {
      ackItems = [single];
    }
  }

  const byKey = new Map();

  function upsertFromIntake(raw) {
    const obj = asObject(raw);
    const intakeId = String(obj.intakeId || obj.id || "");
    const noteId = String(obj.noteId || "");
    if (!intakeId && !noteId) {
      return;
    }
    const key = noteId || intakeId;
    const ts = normalizeTimestamp(obj.updatedAt || obj.ts || obj.createdAt || nowIso()) || nowIso();
    const prev = byKey.get(key);
    if (prev && new Date(prev.updatedAt).getTime() > new Date(ts).getTime()) {
      return;
    }
    byKey.set(key, {
      intakeId: intakeId || (prev ? prev.intakeId : ""),
      noteId: noteId || (prev ? prev.noteId : ""),
      projectId: String(obj.projectId || obj.project || (prev ? prev.projectId : "")),
      route: String(obj.route || (prev ? prev.route : "")),
      summary: String(obj.summary || obj.text || obj.message || (prev ? prev.summary : "")),
      status: String(obj.status || (prev ? prev.status : "new")).toLowerCase(),
      ackBy: String(obj.ackBy || obj.by || (prev ? prev.ackBy : "")),
      comment: String(obj.comment || obj.notes || (prev ? prev.comment : "")),
      source: String(obj.source || (prev ? prev.source : "mission-control.note")),
      updatedAt: ts,
      ts,
    });
  }

  for (const raw of intakeItems) {
    upsertFromIntake(raw);
  }

  const parsedAcks = ackItems
    .map((raw) => {
      const obj = asObject(raw);
      const intakeId = String(obj.intakeId || obj.id || "");
      const noteId = String(obj.noteId || "");
      if (!intakeId && !noteId) {
        return null;
      }
      return {
        intakeId,
        noteId,
        status: String(obj.status || "received").toLowerCase(),
        ackBy: String(obj.ackBy || obj.by || "ops-bob"),
        comment: String(obj.comment || ""),
        ts: normalizeTimestamp(obj.ts || obj.updatedAt || nowIso()) || nowIso(),
      };
    })
    .filter(Boolean)
    .sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());

  for (const ack of parsedAcks) {
    const key = ack.noteId || ack.intakeId;
    const prev = byKey.get(key) || {
      intakeId: ack.intakeId,
      noteId: ack.noteId,
      projectId: "",
      route: "",
      summary: "",
      status: "new",
      ackBy: "",
      comment: "",
      source: "mission-control.ack",
      updatedAt: ack.ts,
      ts: ack.ts,
    };
    byKey.set(key, {
      ...prev,
      intakeId: ack.intakeId || prev.intakeId,
      noteId: ack.noteId || prev.noteId,
      status: ack.status || prev.status,
      ackBy: ack.ackBy || prev.ackBy,
      comment: ack.comment || prev.comment,
      updatedAt: ack.ts,
    });
  }

  return Array.from(byKey.values())
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, Math.max(1, limit));
}

function canonicalAckStatus(rawStatus) {
  const value = String(rawStatus || "").toLowerCase().trim();
  if (!value) {
    return "";
  }
  const aliases = {
    received: "received",
    triaged: "triaged",
    sent_to_tibo: "sent_to_tibo",
    "sent-to-tibo": "sent_to_tibo",
    senttotibo: "sent_to_tibo",
    accepted: "accepted",
    rejected: "rejected",
  };
  return aliases[value] || "";
}

function summarizeChannels(statusData) {
  const channels = asObject(statusData.channels);
  const telegram = asObject(channels.telegram);
  const discord = asObject(channels.discord);

  function asChannel(raw, fallbackName) {
    return {
      name: fallbackName,
      ok: raw.ok === undefined ? null : Boolean(raw.ok),
      latencyMs: toNumber(raw.latencyMs, null),
      sendFailures: toNumber(raw.sendFailuresLastHour, toNumber(raw.failures, 0)) || 0,
      details: raw,
    };
  }

  return {
    telegram: asChannel(telegram, "Telegram"),
    discord: asChannel(discord, "Discord"),
  };
}

function normalizeAgentProfiles(rawProfiles) {
  const out = {};
  const input = asObject(rawProfiles);
  for (const [id, raw] of Object.entries(input)) {
    const key = String(id || "").trim();
    if (!key) {
      continue;
    }
    const obj = asObject(raw);
    out[key] = {
      displayName: String(obj.displayName || obj.name || "").trim(),
      subtitle: String(obj.subtitle || obj.role || "").trim(),
      avatar: String(obj.avatar || obj.avatarUrl || "").trim(),
      defaultProject: String(obj.defaultProject || obj.projectId || "").trim(),
      defaultNext: String(obj.defaultNext || obj.next || "").trim(),
    };
  }
  return out;
}

function buildMissionControlSettings() {
  const raw = asObject(config.missionControl);
  const envRoots = process.env.OPENCLAW_WORKSPACE_ROOTS
    ? process.env.OPENCLAW_WORKSPACE_ROOTS.split(":").filter(Boolean)
    : [];

  const workspaceRoots = Array.isArray(raw.workspaceRoots) && raw.workspaceRoots.length > 0
    ? raw.workspaceRoots
    : (envRoots.length > 0 ? envRoots : [process.cwd()]);

  const stateDir = normalizePath(process.env.OPENCLAW_MISSION_STATE_DIR || raw.stateDir || "~/.openclaw/state/mission-control");
  const canvasDir = normalizePath(process.env.OPENCLAW_MISSION_CANVAS_DIR || raw.canvasDir || "~/.openclaw/canvas/mission-control-data");

  const defaultAgentProfiles = {
    "ops-bob": {
      displayName: "Filippo (Architect)",
      subtitle: "Agent workspace and routing.",
      defaultProject: "mission-control",
    },
  };

  return {
    stateDir,
    canvasDir,
    workspaceRoots,
    staleMs: toNumber(process.env.OPENCLAW_MISSION_STALE_MS || raw.staleMs, 10 * 60 * 1000) || 10 * 60 * 1000,
    feedDefaultMinutes: toNumber(raw.feedDefaultMinutes, 120) || 120,
    deepStatusCommand: String(process.env.OPENCLAW_STATUS_DEEP_CMD || raw.deepStatusCommand || "openclaw status --deep"),
    resyncCommand: String(process.env.OPENCLAW_RESYNC_CMD || raw.resyncCommand || "openclaw mission-control sync"),
    logsTailLines: Math.max(50, toNumber(raw.logsTailLines, 180) || 180),
    schedulesFile: String(raw.schedulesFile || "schedules.json"),
    notesFile: String(raw.notesFile || "notes.jsonl"),
    intakeFile: String(raw.intakeFile || "intake.jsonl"),
    intakeAcksFile: String(raw.intakeAcksFile || "intake-acks.jsonl"),
    notesLimit: Math.max(20, toNumber(raw.notesLimit, 80) || 80),
    agentProfiles: normalizeAgentProfiles(Object.assign({}, defaultAgentProfiles, asObject(raw.agentProfiles))),
  };
}

const missionControlSettings = buildMissionControlSettings();
const missionAvatarPaths = new Map();

function buildActionDefinitions() {
  const defaults = {
    restart_gateway: {
      id: "restart_gateway",
      label: "Restart gateway",
      confirm: "Restart gateway now? Active panel connections may reset.",
      kind: "detached",
      command: path.join(BRIDGE_ROOT, "scripts/openclaw-bridge"),
      args: ["restart"],
      cwd: BRIDGE_ROOT,
    },
    run_status_deep: {
      id: "run_status_deep",
      label: "Run status --deep",
      confirm: "Run deep status check now?",
      kind: "shell",
      command: missionControlSettings.deepStatusCommand,
      cwd: BRIDGE_ROOT,
      timeoutMs: 30000,
    },
    open_logs: {
      id: "open_logs",
      label: "Open logs",
      confirm: "Load recent logs now?",
      kind: "shell",
      command: `tail -n ${missionControlSettings.logsTailLines} \"${config.logFile}\"`,
      cwd: BRIDGE_ROOT,
      timeoutMs: 10000,
    },
    resync_data: {
      id: "resync_data",
      label: "Resync data",
      confirm: "Trigger mission-control data resync now?",
      kind: "shell",
      command: missionControlSettings.resyncCommand,
      cwd: BRIDGE_ROOT,
      timeoutMs: 30000,
    },
  };

  const customActions = asObject(asObject(config.missionControl).actions);
  for (const [key, value] of Object.entries(customActions)) {
    const override = asObject(value);
    if (!defaults[key]) {
      continue;
    }
    defaults[key] = Object.assign({}, defaults[key], override);
    if (typeof override.command === "string") {
      defaults[key].kind = "shell";
    }
  }

  return defaults;
}

const missionActions = buildActionDefinitions();
const coreServiceStatusCache = {
  checkedAtMs: 0,
  snapshot: null,
};
const CORE_SERVICE_CACHE_TTL_MS = 2500;

const openclawAgentsCache = {
  checkedAtMs: 0,
  byId: null,
};
const OPENCLAW_AGENTS_CACHE_TTL_MS = 5000;

function buildCoreServiceDefinitions() {
  const bridgeScript = shellQuote(path.join(BRIDGE_ROOT, "scripts/openclaw-bridge"));
  const mfluxScript = shellQuote(path.join(BRIDGE_ROOT, "scripts/openclaw-mflux-worker"));
  const openclawServerScript = shellQuote(path.join(BRIDGE_ROOT, "scripts/openclaw-server-agent"));
  const codexInboxScript = shellQuote(path.join(BRIDGE_ROOT, "scripts/openclaw-codex-inbox"));
  const node22Bin = fs.existsSync("/opt/homebrew/opt/node@22/bin/node")
    ? shellQuote("/opt/homebrew/opt/node@22/bin/node")
    : "node";
  const openclawBin = fs.existsSync("/opt/homebrew/bin/openclaw")
    ? shellQuote("/opt/homebrew/bin/openclaw")
    : "openclaw";
  // Prefer an explicit Node 22 runtime so launchd PATH doesn't accidentally pick Node 20.
  const openclawCmd = fs.existsSync("/opt/homebrew/bin/openclaw") && fs.existsSync("/opt/homebrew/opt/node@22/bin/node")
    ? `${node22Bin} ${openclawBin}`
    : openclawBin;

  const defaults = {
    openclaw_gateway: {
      id: "openclaw_gateway",
      order: 5,
      label: "OpenClaw Gateway",
      description: "OpenClaw WebSocket gateway service (channels + agent runs)",
      required: true,
      cwd: BRIDGE_ROOT,
      statusCommand: `${openclawCmd} gateway status`,
      startCommand: `${openclawCmd} gateway start`,
      stopCommand: `${openclawCmd} gateway stop`,
      restartCommand: `${openclawCmd} gateway restart`,
      statusTimeoutMs: 8000,
      operationTimeoutMs: 20000,
      detachedOps: [],
      confirmations: {
        start: "Start OpenClaw gateway service now?",
        stop: "Stop OpenClaw gateway service now? Channels/agents will be offline.",
        restart: "Restart OpenClaw gateway service now?",
      },
    },
    bridge: {
      id: "bridge",
      order: 10,
      label: "Bridge Gateway",
      description: "Local gateway + Mission Control HTTP panel",
      required: true,
      cwd: BRIDGE_ROOT,
      statusCommand: `${bridgeScript} status`,
      startCommand: `${bridgeScript} up`,
      stopCommand: `${bridgeScript} down`,
      restartCommand: `${bridgeScript} restart`,
      statusTimeoutMs: 6000,
      operationTimeoutMs: 15000,
      detachedOps: ["stop", "restart"],
      confirmations: {
        start: "Start bridge gateway now?",
        stop: "Stop bridge gateway now? Mission Control will disconnect until it is started again.",
        restart: "Restart bridge gateway now? Mission Control will reconnect in a few seconds.",
      },
    },
    mflux_worker: {
      id: "mflux_worker",
      order: 20,
      label: "MFLUX Worker",
      description: "Image generation worker (agent-impl)",
      required: true,
      cwd: BRIDGE_ROOT,
      statusCommand: `${mfluxScript} status`,
      startCommand: `${mfluxScript} up`,
      stopCommand: `${mfluxScript} down`,
      restartCommand: `${mfluxScript} restart`,
      statusTimeoutMs: 6000,
      operationTimeoutMs: 20000,
      detachedOps: [],
      confirmations: {
        start: "Start MFLUX worker now?",
        stop: "Stop MFLUX worker now?",
        restart: "Restart MFLUX worker now?",
      },
    },
    openclaw_server_agent: {
      id: "openclaw_server_agent",
      order: 30,
      label: "OpenClaw Server Agent",
      description: "Direct OpenClaw responder agent",
      required: true,
      cwd: BRIDGE_ROOT,
      statusCommand: `${openclawServerScript} status`,
      startCommand: `${openclawServerScript} up`,
      stopCommand: `${openclawServerScript} down`,
      restartCommand: `${openclawServerScript} restart`,
      statusTimeoutMs: 6000,
      operationTimeoutMs: 15000,
      detachedOps: [],
      confirmations: {
        start: "Start OpenClaw server agent now?",
        stop: "Stop OpenClaw server agent now?",
        restart: "Restart OpenClaw server agent now?",
      },
    },
    codex_inbox_listener: {
      id: "codex_inbox_listener",
      order: 40,
      label: "Codex Inbox Listener",
      description: "Passive codex-3-high listener (no model/token usage)",
      required: true,
      cwd: BRIDGE_ROOT,
      statusCommand: `${codexInboxScript} status`,
      startCommand: `${codexInboxScript} up`,
      stopCommand: `${codexInboxScript} down`,
      restartCommand: `${codexInboxScript} restart`,
      statusTimeoutMs: 6000,
      operationTimeoutMs: 15000,
      detachedOps: [],
      confirmations: {
        start: "Start Codex inbox listener now?",
        stop: "Stop Codex inbox listener now?",
        restart: "Restart Codex inbox listener now?",
      },
    },
  };

  const custom = asObject(asObject(config.missionControl).coreServices);
  const out = {};
  for (const [id, base] of Object.entries(defaults)) {
    const override = asObject(custom[id]);
    const merged = Object.assign({}, base, override, { id });
    merged.required = override.required === undefined ? Boolean(base.required) : Boolean(override.required);
    merged.order = toNumber(merged.order, base.order) || base.order;
    merged.detachedOps = Array.isArray(merged.detachedOps)
      ? merged.detachedOps.map((value) => String(value).toLowerCase())
      : [];
    merged.confirmations = Object.assign({}, base.confirmations, asObject(override.confirmations));
    out[id] = merged;
  }
  return out;
}

const coreServiceDefinitions = buildCoreServiceDefinitions();

function parseCoreServiceStatusOutput(result) {
  const combined = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  const lower = combined.toLowerCase();

  let running = null;
  if (
    lower.includes("already running") ||
    lower.includes(" appears healthy") ||
    /\brunning\b/.test(lower)
  ) {
    running = true;
  }
  if (
    lower.includes("not running") ||
    lower.includes("is not running") ||
    lower.includes(" not loaded") ||
    lower.includes("could not find service") ||
    lower.includes(" stopped")
  ) {
    running = false;
  }

  const pidMatch =
    combined.match(/\bpid:\s*([0-9]+)/i) ||
    combined.match(/"PID"\s*=\s*([0-9]+)/i) ||
    combined.match(/\bpid[ =]+([0-9]+)/i);
  const pid = pidMatch ? Number.parseInt(pidMatch[1], 10) : null;

  if (running === null && Number.isFinite(pid)) {
    running = true;
  }

  const lines = combined.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const lastLine = lines.length > 0 ? lines[lines.length - 1] : "";

  return {
    running,
    state: running === true ? "running" : running === false ? "stopped" : "unknown",
    pid: Number.isFinite(pid) ? pid : null,
    lastLine,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    checkOk: result.ok,
    checkTimedOut: Boolean(result.timedOut),
  };
}

function collectOpenclawAgents(force = false) {
  const nowMs = Date.now();
  if (!force && openclawAgentsCache.byId && nowMs - openclawAgentsCache.checkedAtMs < OPENCLAW_AGENTS_CACHE_TTL_MS) {
    return openclawAgentsCache.byId;
  }

  // Don't use runShellSync here because it truncates stdout, which can corrupt JSON.
  const byId = {};
  let stdout = "";
  try {
    const result = spawnSync(process.env.SHELL || "/bin/sh", ["-lc", "openclaw agents list --json"], {
      cwd: BRIDGE_ROOT,
      env: { ...process.env, PATH: preferredPath(process.env.PATH) },
      encoding: "utf8",
      timeout: 6000,
      maxBuffer: 5 * 1024 * 1024,
    });
    const timedOut = Boolean(result.error && result.error.code === "ETIMEDOUT");
    if (result.status === 0 && !timedOut) {
      stdout = String(result.stdout || "").trim();
    }
  } catch {}

  if (stdout) {
    try {
      const items = JSON.parse(stdout);
      if (Array.isArray(items)) {
        for (const row of items) {
          const id = String(row.id || "").trim();
          if (!id) continue;
          byId[id] = {
            id,
            name: String(row.name || "").trim(),
            identityName: String(row.identityName || "").trim(),
            identityEmoji: String(row.identityEmoji || "").trim(),
          };
        }
      }
    } catch (err) {
      // ignore
    }
  }

  openclawAgentsCache.checkedAtMs = nowMs;
  openclawAgentsCache.byId = byId;
  return byId;
}

function collectCoreServicesStatus(force = false) {
  const nowMs = Date.now();
  if (
    !force &&
    coreServiceStatusCache.snapshot &&
    coreServiceStatusCache.checkedAtMs > 0 &&
    nowMs - coreServiceStatusCache.checkedAtMs < CORE_SERVICE_CACHE_TTL_MS
  ) {
    return coreServiceStatusCache.snapshot;
  }

  const services = Object.values(coreServiceDefinitions)
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    .map((service) => {
      const statusResult = runShellSync(service.statusCommand, {
        cwd: service.cwd || BRIDGE_ROOT,
        timeoutMs: service.statusTimeoutMs || 6000,
      });
      const parsed = parseCoreServiceStatusOutput(statusResult);
      return {
        id: service.id,
        label: service.label,
        description: service.description || "",
        required: Boolean(service.required),
        state: parsed.state,
        running: parsed.running,
        pid: parsed.pid,
        lastLine: parsed.lastLine,
        checkOk: parsed.checkOk,
        checkTimedOut: parsed.checkTimedOut,
        checkedAt: nowIso(),
        controls: {
          start: Boolean(service.startCommand),
          stop: Boolean(service.stopCommand),
          restart: Boolean(service.restartCommand),
        },
        confirmations: Object.assign({}, service.confirmations),
      };
    });

  const requiredDown = services.filter((service) => service.required && service.running !== true);
  const snapshot = {
    checkedAt: nowIso(),
    allRequiredRunning: requiredDown.length === 0,
    requiredDown: requiredDown.map((service) => service.id),
    services,
  };

  coreServiceStatusCache.checkedAtMs = nowMs;
  coreServiceStatusCache.snapshot = snapshot;
  return snapshot;
}

function resolveAvatarFilePath(rawValue) {
  const candidate = String(rawValue || "").trim();
  if (!candidate) {
    return null;
  }

  const candidates = [];
  if (path.isAbsolute(candidate)) {
    candidates.push(candidate);
  } else {
    candidates.push(path.join(missionControlSettings.canvasDir, candidate));
    candidates.push(path.join(missionControlSettings.stateDir, candidate));
    candidates.push(path.resolve(process.cwd(), candidate));
  }

  for (const possible of candidates) {
    const st = safeStat(possible);
    if (st && st.isFile()) {
      return possible;
    }
  }
  return null;
}

function inferContentType(filePath) {
  const ext = path.extname(filePath || "").toLowerCase();
  if (ext === ".png") {
    return "image/png";
  }
  if (ext === ".jpg" || ext === ".jpeg") {
    return "image/jpeg";
  }
  if (ext === ".webp") {
    return "image/webp";
  }
  if (ext === ".gif") {
    return "image/gif";
  }
  if (ext === ".svg") {
    return "image/svg+xml";
  }
  return "application/octet-stream";
}

function truncateText(value, maxChars = 12000) {
  const text = String(value || "");
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n... (truncated)`;
}

function runShell(command, options) {
  return new Promise((resolve) => {
    const timeoutMs = Math.max(1000, toNumber(options.timeoutMs, 15000) || 15000);
    const child = spawn(process.env.SHELL || "/bin/sh", ["-lc", command], {
      cwd: options.cwd || BRIDGE_ROOT,
      env: {
        ...process.env,
        PATH: preferredPath(process.env.PATH),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 500).unref();
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > 16000) {
        stdout = stdout.slice(-16000);
      }
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 16000) {
        stderr = stderr.slice(-16000);
      }
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0 && !timedOut,
        code,
        timedOut,
        stdout: truncateText(stdout.trim()),
        stderr: truncateText(stderr.trim()),
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, code: null, timedOut: false, stdout: "", stderr: String(err.message || err) });
    });
  });
}

function runShellSync(command, options = {}) {
  const timeoutMs = Math.max(1000, toNumber(options.timeoutMs, 10000) || 10000);
  try {
    const result = spawnSync(process.env.SHELL || "/bin/sh", ["-lc", command], {
      cwd: options.cwd || BRIDGE_ROOT,
      env: {
        ...process.env,
        PATH: preferredPath(process.env.PATH),
      },
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
    });
    const timedOut = Boolean(result.error && result.error.code === "ETIMEDOUT");
    return {
      ok: result.status === 0 && !timedOut,
      code: result.status === null || result.status === undefined ? null : result.status,
      timedOut,
      stdout: truncateText(String(result.stdout || "").trim()),
      stderr: truncateText(String(result.stderr || "").trim()),
      signal: result.signal || null,
      error: result.error ? String(result.error.message || result.error) : "",
    };
  } catch (err) {
    return {
      ok: false,
      code: null,
      timedOut: false,
      stdout: "",
      stderr: "",
      signal: null,
      error: String(err.message || err),
    };
  }
}

function runDetachedShell(command, options = {}) {
  try {
    const child = spawn(process.env.SHELL || "/bin/sh", ["-lc", command], {
      cwd: options.cwd || BRIDGE_ROOT,
      env: {
        ...process.env,
        PATH: preferredPath(process.env.PATH),
      },
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    return { ok: true, pid: child.pid };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}

async function runMissionAction(actionId) {
  const action = missionActions[actionId];
  if (!action) {
    return { ok: false, error: "unknown_action" };
  }

  if (action.kind === "detached") {
    try {
      const child = spawn(action.command, ensureArray(action.args), {
        cwd: action.cwd || BRIDGE_ROOT,
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      pushRuntimeEvent("warn", "mission.action", `action started: ${actionId}`, { actionId, detached: true });
      return {
        ok: true,
        actionId,
        detached: true,
        message: "Action started. If this restarts the gateway, reconnect in a few seconds.",
      };
    } catch (err) {
      return { ok: false, error: err.message || "failed_to_spawn" };
    }
  }

  const result = await runShell(String(action.command || ""), {
    cwd: action.cwd || BRIDGE_ROOT,
    timeoutMs: action.timeoutMs || 15000,
  });

  if (result.ok) {
    pushRuntimeEvent("info", "mission.action", `action completed: ${actionId}`, {
      actionId,
      code: result.code,
    });
  } else {
    pushRuntimeEvent("error", "mission.action", `action failed: ${actionId}`, {
      actionId,
      code: result.code,
      timedOut: result.timedOut,
      stderr: result.stderr,
    });
  }

  return {
    ok: result.ok,
    actionId,
    code: result.code,
    timedOut: result.timedOut,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

async function runCoreServiceOperation(serviceId, operation) {
  const id = String(serviceId || "").trim();
  const op = String(operation || "").trim().toLowerCase();
  const service = coreServiceDefinitions[id];
  if (!service) {
    return { ok: false, error: "unknown_service" };
  }

  if (!["start", "stop", "restart"].includes(op)) {
    return { ok: false, error: "invalid_operation" };
  }

  const commandKey = op === "start" ? "startCommand" : op === "stop" ? "stopCommand" : "restartCommand";
  const command = String(service[commandKey] || "").trim();
  if (!command) {
    return { ok: false, error: "operation_not_supported" };
  }

  const useDetached = Array.isArray(service.detachedOps)
    && service.detachedOps.map((value) => String(value).toLowerCase()).includes(op);

  if (useDetached) {
    const detached = runDetachedShell(command, { cwd: service.cwd || BRIDGE_ROOT });
    if (!detached.ok) {
      pushRuntimeEvent("error", "service.control", `service ${id} ${op} failed`, {
        serviceId: id,
        operation: op,
        error: detached.error,
      });
      return { ok: false, error: detached.error || "detached_spawn_failed", serviceId: id, operation: op };
    }
    pushRuntimeEvent("warn", "service.control", `service ${id} ${op} started`, {
      serviceId: id,
      operation: op,
      detached: true,
    });
    return {
      ok: true,
      serviceId: id,
      operation: op,
      detached: true,
      message: "Command started. Service status will update on next refresh.",
      status: collectCoreServicesStatus(true),
    };
  }

  const result = await runShell(command, {
    cwd: service.cwd || BRIDGE_ROOT,
    timeoutMs: service.operationTimeoutMs || 15000,
  });

  if (result.ok) {
    pushRuntimeEvent("info", "service.control", `service ${id} ${op} completed`, {
      serviceId: id,
      operation: op,
      code: result.code,
    });
  } else {
    pushRuntimeEvent("error", "service.control", `service ${id} ${op} failed`, {
      serviceId: id,
      operation: op,
      code: result.code,
      timedOut: result.timedOut,
      stderr: result.stderr,
    });
  }

  return {
    ok: result.ok,
    serviceId: id,
    operation: op,
    code: result.code,
    timedOut: result.timedOut,
    stdout: result.stdout,
    stderr: result.stderr,
    status: collectCoreServicesStatus(true),
  };
}

async function startRequiredCoreServices() {
  const before = collectCoreServicesStatus(true);
  const toStart = (Array.isArray(before.services) ? before.services : [])
    .filter((service) => service.required && service.running !== true)
    .map((service) => service.id);

  if (toStart.length === 0) {
    return {
      ok: true,
      operation: "start_required",
      started: [],
      failed: [],
      message: "All required services are already running.",
      status: before,
    };
  }

  const started = [];
  const failed = [];

  for (const serviceId of toStart) {
    const result = await runCoreServiceOperation(serviceId, "start");
    if (result.ok) {
      started.push(serviceId);
    } else {
      failed.push({
        serviceId,
        error: result.error || "start_failed",
        code: result.code === undefined ? null : result.code,
        stderr: result.stderr || "",
      });
    }
  }

  const status = collectCoreServicesStatus(true);
  return {
    ok: failed.length === 0,
    operation: "start_required",
    started,
    failed,
    status,
  };
}

function createMissionNote(input) {
  const text = String(input.text || "").trim();
  if (!text) {
    return { ok: false, error: "text_required" };
  }

  const note = {
    id: randomId("note"),
    ts: nowIso(),
    author: String(input.author || "operator"),
    routeTo: String(input.routeTo || "ops-bob"),
    nextHop: String(input.nextHop || "tibo"),
    projectId: String(input.projectId || ""),
    type: String(input.type || "idea"),
    text,
  };

  const stateNotesPath = path.join(missionControlSettings.stateDir, missionControlSettings.notesFile);
  const stateIntakePath = path.join(missionControlSettings.stateDir, missionControlSettings.intakeFile);
  try {
    appendJsonLineFile(stateNotesPath, note);
    appendJsonLineFile(stateIntakePath, {
      id: randomId("intake"),
      ts: note.ts,
      source: "mission-control.note",
      route: `${note.routeTo}->${note.nextHop}`,
      noteId: note.id,
      projectId: note.projectId,
      summary: note.text,
      status: "new",
    });
    copyStateFileToCanvas(missionControlSettings.notesFile);
    copyStateFileToCanvas(missionControlSettings.intakeFile);
  } catch (err) {
    return { ok: false, error: err.message || "note_write_failed" };
  }

  pushRuntimeEvent("info", "mission.note", `note captured for ${note.routeTo}`, {
    noteId: note.id,
    projectId: note.projectId || null,
    routeTo: note.routeTo,
    nextHop: note.nextHop,
  });

  return { ok: true, note };
}

function ackMissionIntake(input) {
  const intakeId = String(input.intakeId || "").trim();
  const noteId = String(input.noteId || "").trim();
  if (!intakeId && !noteId) {
    return { ok: false, error: "intakeId_or_noteId_required" };
  }

  const status = canonicalAckStatus(input.status);
  if (!status) {
    return { ok: false, error: "invalid_status" };
  }

  const ack = {
    id: randomId("ack"),
    ts: nowIso(),
    intakeId,
    noteId,
    status,
    ackBy: String(input.ackBy || "ops-bob"),
    comment: String(input.comment || ""),
    source: "mission-control.intake-ack",
  };

  const stateAckPath = path.join(missionControlSettings.stateDir, missionControlSettings.intakeAcksFile);
  const stateIntakePath = path.join(missionControlSettings.stateDir, missionControlSettings.intakeFile);
  try {
    appendJsonLineFile(stateAckPath, ack);
    appendJsonLineFile(stateIntakePath, {
      id: intakeId || randomId("intake"),
      intakeId,
      noteId,
      ts: ack.ts,
      source: ack.source,
      status: ack.status,
      ackBy: ack.ackBy,
      comment: ack.comment,
    });
    copyStateFileToCanvas(missionControlSettings.intakeAcksFile);
    copyStateFileToCanvas(missionControlSettings.intakeFile);
  } catch (err) {
    return { ok: false, error: err.message || "ack_write_failed" };
  }

  pushRuntimeEvent("info", "mission.intake", `intake ack: ${ack.status}`, {
    intakeId: ack.intakeId || null,
    noteId: ack.noteId || null,
    ackBy: ack.ackBy,
  });

  return { ok: true, ack };
}

function createMissionSchedule(input) {
  const title = String(input.title || "").trim();
  if (!title) {
    return { ok: false, error: "title_required" };
  }
  const cronText = String(input.cron || "").trim();
  const rruleText = String(input.rrule || "").trim();
  const nextRunAt = normalizeTimestamp(input.nextRunAt || input.start || input.dueAt || input.due);
  const dueAt = normalizeTimestamp(input.dueAt || input.due || null);
  if (!nextRunAt && !dueAt && !cronText && !rruleText) {
    return { ok: false, error: "nextRunAt_or_dueAt_or_schedule_required" };
  }
  const effectiveNextRun = nextRunAt || dueAt || nowIso();

  const schedule = {
    id: String(input.id || randomId("sched")),
    title,
    projectId: String(input.projectId || ""),
    assignee: String(input.assignee || ""),
    nextRunAt: effectiveNextRun,
    dueAt,
    cron: cronText,
    rrule: rruleText,
    timezone: String(input.timezone || ""),
    notes: String(input.notes || ""),
    status: String(input.status || "active"),
    createdAt: nowIso(),
  };

  const stateSchedulesPath = path.join(missionControlSettings.stateDir, missionControlSettings.schedulesFile);
  try {
    const doc = loadSchedulesForWrite(stateSchedulesPath);
    const items = Array.isArray(doc.items) ? doc.items : [];
    const without = items.filter((item) => String(asObject(item).id || "") !== schedule.id);
    doc.items = [schedule].concat(without).slice(0, 500);
    doc.generatedAt = nowIso();
    writeJsonFile(stateSchedulesPath, doc);
    copyStateFileToCanvas(missionControlSettings.schedulesFile);
  } catch (err) {
    return { ok: false, error: err.message || "schedule_write_failed" };
  }

  pushRuntimeEvent("info", "mission.schedule", `schedule upserted: ${schedule.title}`, {
    scheduleId: schedule.id,
    projectId: schedule.projectId || null,
    nextRunAt: schedule.nextRunAt || null,
  });

  return { ok: true, schedule };
}

function buildAlerts(input) {
  const alerts = [];

  if (input.dataHealth.state === "missing") {
    alerts.push({
      level: "error",
      message: "Mission data missing: dashboard is running on fallback bridge/runtime data only.",
      reason: "data_missing",
    });
  }

  if (input.dataHealth.state === "stale") {
    alerts.push({
      level: "warn",
      message: "Mission data is stale. Run resync to refresh current state.",
      reason: "data_stale",
    });
  }

  if (input.channels.telegram.ok === true && input.channels.telegram.sendFailures > 0) {
    alerts.push({
      level: "warn",
      message: `Telegram reachable but send failures rising (${input.channels.telegram.sendFailures}/h).`,
      reason: "telegram_send_failures",
    });
  }

  const highContext = input.sessions.filter((session) => session.contextUsagePct !== null && session.contextUsagePct >= 90);
  if (highContext.length > 0) {
    alerts.push({
      level: "warn",
      message: `${highContext.length} session(s) at >=90% context usage.`,
      reason: "context_high",
    });
  }

  const queuedTotal = Object.values(input.bridgeStatus.queued).reduce((sum, value) => sum + value, 0);
  if (queuedTotal >= 20) {
    alerts.push({
      level: "warn",
      message: `Queued envelopes backlog is high (${queuedTotal}).`,
      reason: "queue_backlog",
    });
  }

  const requiredDown = asObject(input.coreServices).requiredDown;
  if (Array.isArray(requiredDown) && requiredDown.length > 0) {
    alerts.push({
      level: "error",
      message: `Core services down: ${requiredDown.join(", ")}.`,
      reason: "core_services_down",
    });
  }

  return alerts;
}

function buildMissionSnapshot() {
  const statusData = readFirstExistingJson([
    missionControlSettings.canvasDir,
    missionControlSettings.stateDir,
  ], ["status.json", "health.json", "gateway-status.json"]);

  const eventsData = readFirstExistingJson([
    missionControlSettings.canvasDir,
    missionControlSettings.stateDir,
  ], ["events.json", "events.jsonl", "feed.json", "feed.jsonl"]);

  const projectsData = readFirstExistingJson([
    missionControlSettings.canvasDir,
    missionControlSettings.stateDir,
  ], ["projects.json"]);

  const missionsData = readFirstExistingJson([
    missionControlSettings.canvasDir,
    missionControlSettings.stateDir,
  ], ["missions.json", "mission-queue.json", "queue.json"]);

  const calendarData = readFirstExistingJson([
    missionControlSettings.canvasDir,
    missionControlSettings.stateDir,
  ], ["calendar.json"]);

  const agentsData = readFirstExistingJson([
    missionControlSettings.canvasDir,
    missionControlSettings.stateDir,
  ], ["agents.json"]);

  const sessionsData = readFirstExistingJson([
    missionControlSettings.canvasDir,
    missionControlSettings.stateDir,
  ], ["sessions.json"]);

  const syncData = readFirstExistingJson([
    missionControlSettings.canvasDir,
    missionControlSettings.stateDir,
  ], ["sync.json", "sync-status.json", "sync-meta.json", "metadata.json"]);

  const schedulesData = readFirstExistingJson([
    missionControlSettings.canvasDir,
    missionControlSettings.stateDir,
  ], uniqueStrings([
    missionControlSettings.schedulesFile,
    "schedules.json",
    "schedule.json",
    "cron.json",
    "jobs.json",
  ]));

  const notesData = readFirstExistingJson([
    missionControlSettings.canvasDir,
    missionControlSettings.stateDir,
  ], uniqueStrings([
    missionControlSettings.notesFile,
    "notes.jsonl",
    "notes.json",
  ]));

  const intakeData = readFirstExistingJson([
    missionControlSettings.canvasDir,
    missionControlSettings.stateDir,
  ], uniqueStrings([
    missionControlSettings.intakeFile,
    "intake.jsonl",
    "intake.json",
  ]));

  const intakeAckData = readFirstExistingJson([
    missionControlSettings.canvasDir,
    missionControlSettings.stateDir,
  ], uniqueStrings([
    missionControlSettings.intakeAcksFile,
    "intake-acks.jsonl",
    "acks.jsonl",
  ]));

  const bridgeStatus = buildStatus();
  const coreServices = collectCoreServicesStatus();
  const statusObj = statusData.ok ? asObject(statusData.data) : {};

  const normalizedEvents = [];
  const openclawEvents = eventsData.ok
    ? unwrapArrayPayload(eventsData.data, ["events", "items", "feed"])
    : [];

  let idx = 0;
  for (const raw of openclawEvents) {
    normalizedEvents.push(normalizeEvent(raw, idx));
    idx += 1;
  }

  for (const runtimeEvent of runtimeEvents.slice(-300)) {
    normalizedEvents.push(normalizeEvent(runtimeEvent, idx));
    idx += 1;
  }

  normalizedEvents.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());
  const events = normalizedEvents.slice(0, 800);

  const rawProjects = projectsData.ok
    ? unwrapArrayPayload(projectsData.data, ["projects", "items"])
    : [];
  const workspaceProjects = collectWorkspaceProjects(missionControlSettings.workspaceRoots);
  const projects = mergeProjects(rawProjects, workspaceProjects).sort((a, b) => a.title.localeCompare(b.title));
  const missions = normalizeMissionItems(missionsData.ok ? missionsData.data : [], projects);

  let sessions = deriveSessions(sessionsData.ok ? sessionsData.data : statusObj.sessions || []);
  sessions = applyProjectAssignmentsToSessions(sessions, projectsData.ok ? projectsData.data : {});
  const sessionsReportedCount = toNumber(asObject(statusObj.sessions).count, null);

  const agentSources = [];
  if (Array.isArray(statusObj.agents)) {
    agentSources.push(...statusObj.agents);
  }
  if (agentsData.ok) {
    agentSources.push(...unwrapArrayPayload(agentsData.data, ["agents", "items"]));
  }

  const agents = deriveAgents({
    agentSources,
    sessions,
    events,
    missions,
    projects,
    bridgeStatus,
    clients: config.clients,
  });

  const projectByHandle = new Map(
    projects.map((project) => [normalizeAgentHandle(project.id || ""), project]),
  );
  for (const agent of agents) {
    if (agent.assignment) {
      continue;
    }
    const project = projectByHandle.get(normalizeAgentHandle(agent.id || ""));
    if (!project) {
      continue;
    }
    agent.assignment = String(project.id || "");
    if (!agent.next) {
      agent.next = String(project.next || "");
    }
  }

  const openclawAgentsById = collectOpenclawAgents();

  const profileMap = asObject(missionControlSettings.agentProfiles);
  for (const agent of agents) {
    // Prefer real OpenClaw agent display names.
    const oc = asObject(openclawAgentsById[agent.id]);
    if (( !agent.name || agent.name === agent.id ) && oc.name) {
      agent.name = oc.name;
    }
    if ((!agent.subtitle || agent.subtitle === '') && oc.identityName) {
      agent.subtitle = oc.identityEmoji ? `${oc.identityEmoji} ${oc.identityName}` : oc.identityName;
    }

    // Then apply explicit profiles from config.
    const profile = asObject(profileMap[agent.id]);
    if (!profile || Object.keys(profile).length === 0) {
      continue;
    }
    if (profile.displayName) {
      agent.name = profile.displayName;
    }
    if (profile.subtitle) {
      agent.subtitle = profile.subtitle;
    }
    if (!agent.avatar && profile.avatar) {
      agent.avatar = profile.avatar;
    }
    if (!agent.assignment && profile.defaultProject) {
      agent.assignment = profile.defaultProject;
    }
    if (!agent.next && profile.defaultNext) {
      agent.next = profile.defaultNext;
    }
  }

  const nextAvatarMap = new Map();
  for (const agent of agents) {
    const avatar = String(agent.avatar || "").trim();
    if (!avatar) {
      continue;
    }
    if (avatar.startsWith("http://") || avatar.startsWith("https://") || avatar.startsWith("data:")) {
      continue;
    }
    const resolved = resolveAvatarFilePath(avatar);
    if (!resolved) {
      continue;
    }
    nextAvatarMap.set(agent.id, resolved);
    agent.avatar = `/api/mission-control/avatar?id=${encodeURIComponent(agent.id)}`;
  }
  missionAvatarPaths.clear();
  for (const [agentId, avatarPath] of nextAvatarMap.entries()) {
    missionAvatarPaths.set(agentId, avatarPath);
  }

  const schedules = normalizeScheduleItems(schedulesData.ok ? schedulesData.data : []);
  const calendar = normalizeCalendarItems(calendarData.ok ? calendarData.data : [], missions, projects, schedules);
  const notes = normalizeNotes(notesData.ok ? notesData.data : [], missionControlSettings.notesLimit);
  const intake = normalizeIntakeRecords(
    intakeData.ok ? intakeData.data : [],
    intakeAckData.ok ? intakeAckData.data : [],
    missionControlSettings.notesLimit,
  );

  const loadedFiles = [
    statusData,
    eventsData,
    projectsData,
    missionsData,
    calendarData,
    agentsData,
    sessionsData,
    schedulesData,
    notesData,
    intakeData,
    intakeAckData,
  ]
    .filter((item) => item.ok)
    .map((item) => ({
      path: item.path,
      source: item.source,
      mtimeMs: item.mtimeMs,
    }));

  const errors = [
    statusData,
    eventsData,
    projectsData,
    missionsData,
    calendarData,
    agentsData,
    sessionsData,
    schedulesData,
    notesData,
    intakeData,
    intakeAckData,
  ]
    .filter((item) => !item.ok && item.error !== "not_found")
    .map((item) => ({ path: item.path, error: item.error }));

  const mtimeCandidates = loadedFiles
    .map((entry) => entry.mtimeMs)
    .filter((value) => Number.isFinite(value));

  const syncObj = syncData.ok ? asObject(syncData.data) : {};
  const explicitSyncTs = normalizeTimestamp(syncObj.lastSuccessfulSync || syncObj.lastSyncTs || syncObj.ts);
  const explicitSyncMs = explicitSyncTs ? new Date(explicitSyncTs).getTime() : null;

  const canvasLatestMs = readDirectoryLatestMtime(missionControlSettings.canvasDir);
  const inferredLatestMs = mtimeCandidates.length > 0 ? Math.max(...mtimeCandidates) : null;
  const lastSuccessfulSyncMs = Math.max(
    explicitSyncMs || 0,
    canvasLatestMs || 0,
    inferredLatestMs || 0,
  ) || null;

  const lastSuccessfulSync = lastSuccessfulSyncMs ? new Date(lastSuccessfulSyncMs).toISOString() : null;
  const nowMs = Date.now();
  const dataAgeMs = lastSuccessfulSyncMs ? Math.max(0, nowMs - lastSuccessfulSyncMs) : null;

  let dataState = "ok";
  if (loadedFiles.length === 0) {
    dataState = "missing";
  } else if (dataAgeMs !== null && dataAgeMs > missionControlSettings.staleMs) {
    dataState = "stale";
  }

  const channels = summarizeChannels(statusObj);
  const latencyMs = toNumber(statusObj.latencyMs, toNumber(statusObj.gatewayLatencyMs, null));
  const gatewayReachable = statusObj.gateway?.reachable === undefined ? true : Boolean(statusObj.gateway.reachable);

  const dataHealth = {
    state: dataState,
    staleThresholdMs: missionControlSettings.staleMs,
    dataAgeMs,
    lastSuccessfulSync,
    resyncInstruction: missionControlSettings.resyncCommand,
    loadedFiles,
    errors,
  };

  const alerts = buildAlerts({
    dataHealth,
    channels,
    sessions,
    bridgeStatus,
    coreServices,
  });

  return {
    ts: nowIso(),
    generatedFrom: {
      stateDir: missionControlSettings.stateDir,
      canvasDir: missionControlSettings.canvasDir,
      workspaceRoots: missionControlSettings.workspaceRoots,
    },
    feed: {
      defaultWindowMinutes: missionControlSettings.feedDefaultMinutes,
    },
    health: {
      gateway: {
        reachable: gatewayReachable,
        activeClients: Object.keys(bridgeStatus.active).length,
      },
      channels,
      latencyMs,
      data: dataHealth,
      alerts,
    },
    actions: Object.values(missionActions).map((action) => ({
      id: action.id,
      label: action.label,
      confirm: action.confirm || "Run action?",
    })),
    coreServices,
    agents,
    sessionsSummary: {
      count: sessionsReportedCount !== null ? sessionsReportedCount : sessions.length,
      visible: sessions.length,
    },
    sessions: sessions.sort((a, b) => {
      const at = a.ts ? new Date(a.ts).getTime() : 0;
      const bt = b.ts ? new Date(b.ts).getTime() : 0;
      return bt - at;
    }),
    events,
    projects,
    missions,
    calendar,
    schedules,
    notes,
    intake,
    bridge: bridgeStatus,
  };
}

function panelHtml() {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>OpenClaw Mission Control</title>
<link rel="stylesheet" href="/panel/mission-control.css" />
</head>
<body>
  <header class="topbar">
    <div class="brand">
      <div class="title">OpenClaw Mission Control</div>
      <div class="subtitle">10-second cockpit: health, activity, next actions</div>
    </div>
    <div class="token-wrap">
      <input id="token" type="password" placeholder="Admin token" />
      <button id="refresh">Refresh</button>
    </div>
  </header>

  <main class="page">
    <div id="dataBanner" class="banner"></div>

    <section class="card health">
      <h2>System Health</h2>
      <div id="healthGrid" class="health-grid"></div>
      <div id="alerts" class="helper"></div>
    </section>

    <section class="card agents">
      <h2>Agents / Sessions</h2>
      <div id="agentsRail" class="agent-rail"></div>
      <div id="sessionsRail" class="sessions"></div>
    </section>

    <section class="grid">
      <section class="card feed">
        <div class="row">
          <h2>Live Feed</h2>
          <div id="lastUpdated" class="helper"></div>
        </div>
        <div class="controls" id="feedTimeControls"></div>
        <div class="controls">
          <select id="feedLevel">
            <option value="all">Level: all</option>
            <option value="error">Level: error</option>
            <option value="warn">Level: warn</option>
            <option value="info">Level: info</option>
          </select>
        </div>
        <div id="feedList" class="list"></div>
        <pre id="feedTrace">Select an event to view trace details.</pre>
      </section>

      <section class="card projects">
        <h2>Projects</h2>
        <div id="projectsList" class="list"></div>
      </section>

      <section class="card missions">
        <h2>Mission Queue</h2>
        <div id="missionCols" class="mission-cols"></div>
      </section>

      <section class="card calendar">
        <h2>Calendar</h2>
        <div class="controls">
          <input id="scheduleTitle" type="text" placeholder="Schedule title (e.g. website update)" />
          <input id="scheduleWhen" type="datetime-local" />
          <input id="scheduleProject" type="text" placeholder="project id (optional)" />
          <input id="scheduleAssignee" type="text" placeholder="assignee (optional)" />
          <input id="scheduleCron" type="text" placeholder="cron or RRULE (optional)" />
          <button id="scheduleSave">Add Schedule</button>
        </div>
        <div id="calendarList" class="list"></div>
        <pre id="scheduleOutput">No schedule updates yet.</pre>
      </section>

      <section class="card services">
        <h2>Core Services</h2>
        <div id="servicesSummary" class="helper"></div>
        <div id="servicesControls" class="controls"></div>
        <div id="servicesList" class="services-list"></div>
        <pre id="serviceOutput">No service actions run yet.</pre>
      </section>

      <section class="card voice" id="voiceCard">
        <div class="row voice-head" id="voiceDragHandle">
          <h2>Voice Chat <span id="voiceGlobalState" class="voice-global-state idle">Idle</span></h2>
          <div class="row" style="gap:6px;">
            <button id="voiceSettingsToggle" class="talk-btn" title="Voice settings">⚙ Settings</button>
            <button id="voiceCollapse" class="talk-btn">Collapse</button>
          </div>
        </div>
        <div class="helper">Talk on any agent to route instantly. Lights: green=live/listening/speaking, yellow=thinking, red=idle.</div>
        <div class="controls voice-controls">
          <button id="voiceRec">Record</button>
          <button id="voiceStop" disabled>Stop</button>
          <button id="voiceMute" class="active">Mic: on</button>
        </div>
        <div id="voiceSettingsPanel" class="voice-settings is-collapsed">
          <div class="controls">
            <label class="inline">Target <select id="voiceTarget"></select></label>
            <label class="inline"><input id="voiceAutoSpeak" type="checkbox" checked /> Auto-speak</label>
            <label class="inline"><input id="voiceContinuous" type="checkbox" checked /> Continuous</label>
            <button id="voiceReset">Reset</button>
          </div>
          <div class="controls">
            <select id="voiceSelect"></select>
            <input id="voiceCustom" type="text" placeholder="custom voice (optional)" />
          </div>
        </div>
        <div id="voiceChat" class="voice-chat" aria-live="polite"></div>
        <div class="controls voice-compose">
          <input id="voiceTextInput" type="text" placeholder="Type a message to current agent…" />
          <button id="voiceTextSend">Send</button>
        </div>
        <audio id="voiceAudio" controls style="width:100%"></audio>
        <pre id="voiceStatus">Idle.</pre>
      </section>

      <section class="card notes">
        <h2>Team Notes / Intake</h2>
        <div class="helper">Shared notes route through ops-bob and can hand off to tibo for vetting.</div>
        <textarea id="noteText" placeholder="Write a note, idea, or directive for shared intake..."></textarea>
        <div class="controls">
          <input id="noteProject" type="text" placeholder="project id (optional)" />
          <select id="noteRoute">
            <option value="ops-bob">Route: ops-bob</option>
            <option value="codex-3-high">Route: codex-3-high</option>
            <option value="openclaw-server">Route: openclaw-server</option>
          </select>
          <select id="noteNextHop">
            <option value="tibo">Next: tibo</option>
            <option value="none">Next: none</option>
          </select>
          <select id="noteType">
            <option value="idea">Type: idea</option>
            <option value="task">Type: task</option>
            <option value="risk">Type: risk</option>
            <option value="note">Type: note</option>
          </select>
          <button id="noteSubmit">Post Note</button>
        </div>
        <div id="notesList" class="list"></div>
        <pre id="noteOutput">No notes posted yet.</pre>
      </section>

      <section class="card actions">
        <h2>Action Controls</h2>
        <div id="actionsList" class="actions-grid"></div>
        <div class="helper">Actions are allowlisted and require confirmation.</div>
        <pre id="actionOutput">No actions run yet.</pre>
      </section>
    </section>
  </main>
<script type="module" src="/panel/mission-control.js"></script>
</body>
</html>`;
}

function servePanelAsset(req, res, filePath, contentType) {
  if (req.method !== "GET") {
    json(res, 405, { error: "method_not_allowed" });
    return true;
  }
  try {
    const body = fs.readFileSync(filePath, "utf8");
    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-store",
    });
    res.end(body);
  } catch (err) {
    json(res, 404, { error: "not_found", detail: err.message || "asset_missing" });
  }
  return true;
}

function serveAgentAvatar(req, res, agentId) {
  if (req.method !== "GET") {
    json(res, 405, { error: "method_not_allowed" });
    return true;
  }
  const avatarPath = missionAvatarPaths.get(agentId);
  if (!avatarPath || !safeStat(avatarPath)?.isFile()) {
    json(res, 404, { error: "avatar_not_found" });
    return true;
  }
  try {
    const body = fs.readFileSync(avatarPath);
    res.writeHead(200, {
      "Content-Type": inferContentType(avatarPath),
      "Cache-Control": "no-store",
    });
    res.end(body);
  } catch (err) {
    json(res, 500, { error: "avatar_read_failed", detail: err.message || "unknown" });
  }
  return true;
}

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);

  if (url.pathname === "/health") {
    return json(res, 200, { ok: true, ts: nowIso() });
  }

  if (url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(panelHtml());
    return;
  }

  if (url.pathname === "/panel/mission-control.css") {
    return servePanelAsset(req, res, path.join(__dirname, "panel/mission-control.css"), "text/css; charset=utf-8");
  }

  if (url.pathname === "/panel/mission-control.js") {
    return servePanelAsset(
      req,
      res,
      path.join(__dirname, "panel/mission-control.js"),
      "application/javascript; charset=utf-8",
    );
  }

  if (url.pathname === "/panel/voice.js") {
    return servePanelAsset(req, res, path.join(__dirname, "panel/voice.js"), "application/javascript; charset=utf-8");
  }

  if (url.pathname === "/favicon.ico") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (url.pathname === "/api/mission-control/avatar") {
    const agentId = String(url.searchParams.get("id") || "").trim();
    if (!agentId) {
      return json(res, 400, { error: "id_required" });
    }
    return serveAgentAvatar(req, res, agentId);
  }

  if (!url.pathname.startsWith("/api/")) {
    return json(res, 404, { error: "not_found" });
  }

  if (!isAuthorizedHttp(req)) {
    return json(res, 401, { error: "unauthorized" });
  }

  if (req.method === "GET" && url.pathname === "/api/status") {
    return json(res, 200, buildStatus());
  }

  if (req.method === "POST" && url.pathname === "/api/send") {
    try {
      const body = await parseBody(req);
      const result = routeAdminSend(body);
      if (!result.ok) {
        return json(res, 400, result);
      }
      return json(res, 200, result);
    } catch (err) {
      return json(res, 400, { error: err.message || "bad_request" });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/mission-control/snapshot") {
    try {
      return json(res, 200, buildMissionSnapshot());
    } catch (err) {
      writeLog("mission snapshot build failed", { error: err.message }, "error");
      return json(res, 500, { error: "snapshot_failed", detail: err.message || "unknown" });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/mission-control/services") {
    return json(res, 200, collectCoreServicesStatus(true));
  }

  if (req.method === "POST" && url.pathname === "/api/mission-control/services/start-required") {
    try {
      const result = await startRequiredCoreServices();
      return json(res, result.ok ? 200 : 400, result);
    } catch (err) {
      return json(res, 500, { ok: false, error: err.message || "start_required_failed" });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/mission-control/service") {
    try {
      const body = await parseBody(req);
      const serviceId = String(body.serviceId || "").trim();
      const operation = String(body.operation || "").trim().toLowerCase();
      if (!serviceId) {
        return json(res, 400, { ok: false, error: "serviceId_required" });
      }
      if (!operation) {
        return json(res, 400, { ok: false, error: "operation_required" });
      }
      const result = await runCoreServiceOperation(serviceId, operation);
      return json(res, result.ok ? 200 : 400, result);
    } catch (err) {
      return json(res, 400, { ok: false, error: err.message || "bad_request" });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/mission-control/note") {
    try {
      const body = await parseBody(req);
      const result = createMissionNote(body);
      return json(res, result.ok ? 200 : 400, result);
    } catch (err) {
      return json(res, 400, { ok: false, error: err.message || "bad_request" });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/mission-control/schedule") {
    try {
      const body = await parseBody(req);
      const result = createMissionSchedule(body);
      return json(res, result.ok ? 200 : 400, result);
    } catch (err) {
      return json(res, 400, { ok: false, error: err.message || "bad_request" });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/mission-control/intake/ack") {
    try {
      const body = await parseBody(req);
      const result = ackMissionIntake(body);
      return json(res, result.ok ? 200 : 400, result);
    } catch (err) {
      return json(res, 400, { ok: false, error: err.message || "bad_request" });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/mission-control/action") {
    try {
      const body = await parseBody(req);
      const actionId = String(body.actionId || "").trim();
      if (!actionId) {
        return json(res, 400, { ok: false, error: "actionId_required" });
      }
      const result = await runMissionAction(actionId);
      const code = result.ok ? 200 : 400;
      return json(res, code, result);
    } catch (err) {
      return json(res, 400, { ok: false, error: err.message || "bad_request" });
    }
  }

  return json(res, 404, { error: "not_found" });
});

httpServer.on("error", (err) => {
  writeLog("http server error", { error: err.message }, "error");
  process.exit(1);
});

httpServer.listen(config.httpPort, config.httpHost, () => {
  writeLog("bridge control panel ready", {
    url: `http://${config.httpHost}:${config.httpPort}/`,
  });
});

function shutdown(signal) {
  writeLog("shutting down", { signal }, "warn");
  socketServer.close(() => {
    try {
      if (fs.existsSync(config.socketPath)) {
        fs.unlinkSync(config.socketPath);
      }
    } catch (err) {
      writeLog("failed to cleanup socket", { error: err.message }, "warn");
    }
  });

  httpServer.close(() => {
    process.exit(0);
  });

  setTimeout(() => process.exit(0), 1500).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

writeLog("openclaw bridge starting", { configPath: CONFIG_PATH });

#!/usr/bin/env node
"use strict";

const net = require("net");
const fs = require("fs");
const path = require("path");

function usage() {
  console.log(`Usage:
  node bridge/client.js send --client <id> --key <apiKey> --to <clientId> [--type command] [--payload '{"k":"v"}'] [--socket /path.sock]
  node bridge/client.js listen --client <id> --key <apiKey> [--socket /path.sock]
  node bridge/client.js whoami --client <id> --key <apiKey> [--socket /path.sock]
`);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const value = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
      out[key] = value;
    } else {
      out._.push(token);
    }
  }
  return out;
}

function resolveSocketPath(cli) {
  if (cli.socket) {
    return path.resolve(String(cli.socket));
  }
  const envPath = process.env.OPENCLAW_BRIDGE_SOCKET;
  if (envPath) {
    return path.resolve(envPath);
  }
  return path.resolve(process.cwd(), "bridge/runtime/openclaw-bridge.sock");
}

function parsePayload(raw) {
  if (raw === undefined || raw === true) {
    return null;
  }
  try {
    return JSON.parse(String(raw));
  } catch (err) {
    throw new Error(`Invalid --payload JSON: ${err.message}`);
  }
}

function sendJson(socket, value) {
  socket.write(`${JSON.stringify(value)}\n`);
}

function connectAndRun(options) {
  const socketPath = resolveSocketPath(options);
  if (!fs.existsSync(socketPath)) {
    throw new Error(`Socket not found: ${socketPath}`);
  }

  const mode = options._[0];
  const clientId = String(options.client || "");
  const key = String(options.key || "");

  if (!mode || !clientId || !key) {
    usage();
    process.exit(1);
  }

  const socket = net.createConnection(socketPath);
  let buffer = "";
  let authed = false;

  socket.on("connect", () => {
    sendJson(socket, {
      action: "auth",
      clientId,
      apiKey: key,
    });
  });

  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");

    while (true) {
      const idx = buffer.indexOf("\n");
      if (idx === -1) {
        break;
      }
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);

      if (!line) {
        continue;
      }

      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }

      if (msg.action === "auth_failed") {
        console.error("Auth failed");
        process.exit(2);
      }

      if (msg.action === "auth_ok") {
        authed = true;

        if (mode === "send") {
          if (!options.to) {
            console.error("--to is required in send mode");
            process.exit(1);
          }
          let payload = null;
          try {
            payload = parsePayload(options.payload);
          } catch (err) {
            console.error(err.message);
            process.exit(1);
          }

          sendJson(socket, {
            action: "send",
            to: String(options.to),
            type: options.type ? String(options.type) : "command",
            payload,
            correlationId: options.correlationId ? String(options.correlationId) : null,
          });
          continue;
        }

        if (mode === "whoami") {
          sendJson(socket, { action: "whoami" });
          continue;
        }

        if (mode === "listen") {
          console.error(`Listening as ${clientId} on ${socketPath}`);
          continue;
        }

        console.error(`Unknown mode: ${mode}`);
        process.exit(1);
      }

      if (msg.action === "message" && mode === "listen") {
        console.log(JSON.stringify(msg.envelope));
        continue;
      }

      if (!authed) {
        continue;
      }

      if (mode === "send") {
        if (msg.action === "sent") {
          console.log(JSON.stringify(msg, null, 2));
          process.exit(0);
        }
        if (msg.action === "error") {
          console.error(JSON.stringify(msg, null, 2));
          process.exit(3);
        }
      }

      if (mode === "whoami") {
        if (msg.action === "whoami" || msg.action === "error") {
          console.log(JSON.stringify(msg, null, 2));
          process.exit(msg.action === "whoami" ? 0 : 3);
        }
      }

      if (mode === "listen") {
        if (msg.action === "error") {
          console.error(JSON.stringify(msg));
        }
      }
    }
  });

  socket.on("error", (err) => {
    console.error(`Socket error: ${err.message}`);
    process.exit(4);
  });

  socket.on("end", () => {
    if (mode === "listen") {
      process.exit(0);
    }
  });
}

try {
  const cli = parseArgs(process.argv.slice(2));
  if (!cli._.length || cli.help) {
    usage();
    process.exit(0);
  }
  connectAndRun(cli);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

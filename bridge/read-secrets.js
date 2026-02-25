#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const rootDir = path.resolve(__dirname, "..");

function resolveSecretsPath(customPath) {
  if (customPath) {
    return path.resolve(customPath);
  }

  const envPath = process.env.OPENCLAW_BRIDGE_SECRETS_PATH;
  if (envPath) {
    return path.resolve(envPath);
  }

  const localPath = path.join(rootDir, "bridge", "runtime", "generated-secrets.json");
  if (fs.existsSync(localPath)) {
    return localPath;
  }

  const sharedPath = "/Users/Shared/openclaw_bridge/generated-secrets.json";
  return sharedPath;
}

function usage() {
  console.log(`Usage:
  node bridge/read-secrets.js show [--path <file>]
  node bridge/read-secrets.js admin-token [--path <file>]
  node bridge/read-secrets.js client-key <client-id> [--path <file>]`);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === "--path") {
      out.path = argv[++i];
    } else {
      out._.push(t);
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0] || "show";
const secretsPath = resolveSecretsPath(args.path);

if (!fs.existsSync(secretsPath)) {
  console.error(`Secrets file not found: ${secretsPath}`);
  process.exit(1);
}

let secrets;
try {
  secrets = JSON.parse(fs.readFileSync(secretsPath, "utf8"));
} catch (err) {
  console.error(`Failed to read secrets file: ${err.message}`);
  process.exit(1);
}

if (cmd === "show") {
  console.log(`secretsPath=${secretsPath}`);
  console.log(`generatedAt=${secrets.generatedAt || "unknown"}`);
  console.log(`adminToken=${secrets.adminToken || ""}`);
  const clients = secrets.clients || {};
  for (const [id, key] of Object.entries(clients)) {
    console.log(`client.${id}=${key}`);
  }
  process.exit(0);
}

if (cmd === "admin-token") {
  if (!secrets.adminToken) {
    console.error("adminToken missing");
    process.exit(1);
  }
  process.stdout.write(String(secrets.adminToken));
  process.exit(0);
}

if (cmd === "client-key") {
  const id = args._[1];
  if (!id) {
    usage();
    process.exit(1);
  }
  const clients = secrets.clients || {};
  if (!clients[id]) {
    console.error(`Unknown client id: ${id}`);
    process.exit(1);
  }
  process.stdout.write(String(clients[id]));
  process.exit(0);
}

usage();
process.exit(1);

#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function randSecret() {
  return crypto.randomBytes(24).toString("hex");
}

const rootDir = path.resolve(__dirname, "..");
const configPath = path.resolve(process.env.OPENCLAW_BRIDGE_CONFIG || path.join(rootDir, "bridge", "config.json"));

if (!fs.existsSync(configPath)) {
  console.error(`Config not found: ${configPath}`);
  console.error("Run: ./scripts/openclaw-bridge init");
  process.exit(1);
}

let config;
try {
  config = JSON.parse(fs.readFileSync(configPath, "utf8"));
} catch (err) {
  console.error(`Failed to parse config: ${err.message}`);
  process.exit(1);
}

if (!Array.isArray(config.clients) || config.clients.length === 0) {
  console.error("config.clients is empty");
  process.exit(1);
}

const secrets = {
  generatedAt: new Date().toISOString(),
  configPath,
  adminToken: randSecret(),
  clients: {},
};

config.adminTokenSha256 = sha256(secrets.adminToken);

for (const client of config.clients) {
  if (!client.id) {
    console.error("Found client without id in config.clients");
    process.exit(1);
  }
  const secret = randSecret();
  secrets.clients[client.id] = secret;
  client.keySha256 = sha256(secret);
}

fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

const runtimeDir = path.join(rootDir, "bridge", "runtime");
fs.mkdirSync(runtimeDir, { recursive: true });
const secretsPath = path.join(runtimeDir, "generated-secrets.json");
fs.writeFileSync(secretsPath, `${JSON.stringify(secrets, null, 2)}\n`, { mode: 0o600 });
fs.chmodSync(secretsPath, 0o600);

console.log(`Updated hashes in: ${configPath}`);
console.log(`Saved plain secrets in: ${secretsPath}`);
console.log("Keep generated-secrets.json private and do not commit it.");

for (const [clientId, secret] of Object.entries(secrets.clients)) {
  console.log(`Client key ${clientId}: ${secret}`);
}
console.log(`Admin panel token: ${secrets.adminToken}`);

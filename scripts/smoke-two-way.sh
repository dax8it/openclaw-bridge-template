#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOCKET_PATH="${OPENCLAW_BRIDGE_SOCKET:-$ROOT_DIR/bridge/runtime/openclaw-bridge.sock}"
SECRETS_FILE="$ROOT_DIR/bridge/runtime/generated-secrets.json"

if [[ ! -S "$SOCKET_PATH" ]]; then
  echo "Bridge socket missing: $SOCKET_PATH"
  echo "Start bridge first: $ROOT_DIR/scripts/bridge up"
  exit 1
fi

if [[ ! -f "$SECRETS_FILE" ]]; then
  echo "Missing secrets file: $SECRETS_FILE"
  echo "Run: $ROOT_DIR/scripts/bridge provision-secrets"
  exit 1
fi

SERVER_KEY="$(node -e "const s=require(process.argv[1]); process.stdout.write(s.clients['openclaw-server']);" "$SECRETS_FILE")"
AGENT_KEY="$(node -e "const s=require(process.argv[1]); process.stdout.write(s.clients['agent-client']);" "$SECRETS_FILE")"

A_OUT="/tmp/openclaw-bridge-smoke-server.jsonl"
B_OUT="/tmp/openclaw-bridge-smoke-agent.jsonl"
rm -f "$A_OUT" "$B_OUT"

OPENCLAW_BRIDGE_SOCKET="$SOCKET_PATH" node "$ROOT_DIR/bridge/client.js" listen --client openclaw-server --key "$SERVER_KEY" > "$A_OUT" 2>/tmp/openclaw-bridge-smoke-server.err &
L1=$!
sleep 0.4
OPENCLAW_BRIDGE_SOCKET="$SOCKET_PATH" node "$ROOT_DIR/bridge/client.js" send \
  --client agent-client --key "$AGENT_KEY" \
  --to openclaw-server --type command \
  --payload '{"command":"ping","requestId":"req_smoke_a","ts":"2026-02-25T00:00:00Z"}' >/tmp/openclaw-bridge-smoke-send-a.out
sleep 0.6
kill "$L1" >/dev/null 2>&1 || true

OPENCLAW_BRIDGE_SOCKET="$SOCKET_PATH" node "$ROOT_DIR/bridge/client.js" listen --client agent-client --key "$AGENT_KEY" > "$B_OUT" 2>/tmp/openclaw-bridge-smoke-agent.err &
L2=$!
sleep 0.4
OPENCLAW_BRIDGE_SOCKET="$SOCKET_PATH" node "$ROOT_DIR/bridge/client.js" send \
  --client openclaw-server --key "$SERVER_KEY" \
  --to agent-client --type response \
  --payload '{"requestId":"req_smoke_b","ok":true,"result":{},"error":null,"ts":"2026-02-25T00:00:01Z"}' >/tmp/openclaw-bridge-smoke-send-b.out
sleep 0.6
kill "$L2" >/dev/null 2>&1 || true

if ! rg -q '"from":"agent-client"' "$A_OUT"; then
  echo "FAIL: did not observe agent-client -> openclaw-server"
  exit 2
fi

if ! rg -q '"from":"openclaw-server"' "$B_OUT"; then
  echo "FAIL: did not observe openclaw-server -> agent-client"
  exit 3
fi

echo "PASS: bridge is bidirectional"

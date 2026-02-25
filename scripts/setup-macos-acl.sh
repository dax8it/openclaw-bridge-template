#!/usr/bin/env bash
set -euo pipefail

# Requires sudo/root.
GROUP_NAME="${OPENCLAW_BRIDGE_GROUP:-openclawbridge}"
SHARED_DIR="${OPENCLAW_BRIDGE_SHARED_DIR:-/Users/Shared/openclaw_bridge}"
BRIDGE_USER="${OPENCLAW_BRIDGE_USER:-}"
CLIENT_USER="${OPENCLAW_BRIDGE_CLIENT_USER:-}"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root: sudo $0"
  exit 1
fi

if [[ -z "$BRIDGE_USER" || -z "$CLIENT_USER" ]]; then
  echo "Set OPENCLAW_BRIDGE_USER and OPENCLAW_BRIDGE_CLIENT_USER before running."
  echo "Example: sudo OPENCLAW_BRIDGE_USER=alice OPENCLAW_BRIDGE_CLIENT_USER=bob $0"
  exit 1
fi

if ! dscl . -read "/Groups/${GROUP_NAME}" >/dev/null 2>&1; then
  dseditgroup -o create "$GROUP_NAME"
  echo "Created group: $GROUP_NAME"
fi

dseditgroup -o edit -a "$BRIDGE_USER" -t user "$GROUP_NAME"
dseditgroup -o edit -a "$CLIENT_USER" -t user "$GROUP_NAME"

mkdir -p "$SHARED_DIR"
chown "$BRIDGE_USER":"$GROUP_NAME" "$SHARED_DIR"
chmod 0770 "$SHARED_DIR"

echo "Prepared shared runtime dir: $SHARED_DIR"
echo "Bridge user: $BRIDGE_USER"
echo "Client user: $CLIENT_USER"

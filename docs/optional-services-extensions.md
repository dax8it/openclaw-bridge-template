# Optional Services and Extensions

These components are optional. The core OAuth-safe bridge pattern works without them.

Use this guide when you want to extend the bridge with responder workers, inbox listeners, model workers, or launchd automation.

## Why optional

Core bridge only needs:
- daemon (`bridge/daemon.js`)
- client (`bridge/client.js`)
- config + secrets tooling
- send/listen/whoami + smoke test

Optional services add convenience and product-specific workflows, but they are not required for secure bridge transport.

## Optional components from the original deployment

1. `openclaw-server-agent`
- Purpose: always-on responder for bridge commands.
- Typical behavior: receives `command` envelopes and returns `response` envelopes.
- Example commands: `ping`, `status`, `sync_context`.

2. `codex-inbox-listener`
- Purpose: persistent passive listener for a client ID.
- Typical behavior: stays connected and appends incoming envelopes to JSONL.
- Useful for: reducing queued messages and keeping a live inbox stream.

3. `mflux-worker`
- Purpose: model/tool worker behind bridge commands.
- Typical behavior: handles specific ops (for example image generation) and returns structured result/error payloads.
- Useful for: attaching local tool execution to bridge routing.

4. launchd installers/templates
- Purpose: keep bridge/services alive across terminal exits and reboots.
- Typical behavior: install/start/stop/status wrappers around services.

## Security constraints for all optional services

1. Never request or use provider OAuth/session credentials.
2. Use only bridge client credentials (client ID + bridge key).
3. Keep payloads secret-free.
4. Restrict routing with `canSendTo` least privilege.
5. Return structured errors (`code`, `message`, `retryable`) for traceability.

## Implementation checklist by component

## `openclaw-server-agent` checklist

1. Read env:
- `OPENCLAW_BRIDGE_SOCKET`
- `OPENCLAW_SERVER_CLIENT_ID`
- `OPENCLAW_SERVER_API_KEY`
2. Connect + auth to bridge.
3. Accept only `type:"command"` envelopes.
4. Validate `requestId`, `command`, `ts`.
5. Execute allowlisted commands only.
6. Send `type:"response"` with same `requestId`.

## `codex-inbox-listener` checklist

1. Read env:
- `OPENCLAW_BRIDGE_SOCKET`
- `OPENCLAW_CODEX_CLIENT_ID`
- `OPENCLAW_CODEX_API_KEY`
- `OPENCLAW_CODEX_INBOX_LOG`
2. Connect + auth with retry loop.
3. Append envelope JSON lines to inbox log.
4. Log minimal metadata only (no secrets).

## `mflux-worker` checklist

1. Read env:
- `OPENCLAW_BRIDGE_SOCKET`
- `MFLUX_BRIDGE_CLIENT_ID`
- `MFLUX_BRIDGE_API_KEY`
2. Connect + auth with retry.
3. Handle explicit command set only (`mflux_health`, `mflux_generate`).
4. Validate args and model allowlist.
5. Return result/error envelope with stable error codes.

## launchd/service wrapper checklist

1. `up`, `down`, `status`, `logs` commands per service.
2. PID/out files in `bridge/runtime/`.
3. Avoid duplicate instances.
4. Keep env wiring explicit and local.

## Agent prompt template to implement optional services

Use this when asking Codex/Claude/Gemini/other agents to add these features:

```md
Extend this OpenClaw bridge repo with optional services, without changing core OAuth-safe boundaries.

Implement:
1. openclaw-server-agent (request/response command responder)
2. codex-inbox-listener (persistent inbox JSONL logger)
3. mflux-worker (optional tool/model worker with allowlisted commands)
4. service wrappers and optional launchd templates

Constraints:
- Do not request/store/transmit provider OAuth/session credentials.
- Use bridge client keys only.
- Keep payloads secret-free.
- Enforce command allowlists and route least privilege.
- Add concise docs for each service and run commands.

Deliverables:
- runnable scripts
- env var contract
- example commands
- basic operational docs
- smoke test updates
```

## Reference workflow

1. Start with core bridge working.
2. Add one optional service at a time.
3. Validate each with send/listen tests.
4. Only then add launchd persistence.

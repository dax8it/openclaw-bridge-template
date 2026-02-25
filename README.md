# OpenClaw Bridge Template

Local, OAuth-safe IPC bridge for OpenClaw and external agents.

This template helps you run multi-agent workflows while keeping provider credentials (OpenAI/Anthropic/Google/etc.) inside each platform's own app/harness.

## What this gives you

In plain language, this project creates a local messaging layer between:
- your OpenClaw agents
- your external agents (Codex, Claude, Gemini, or others)

After setup, your external agents can:
- send structured requests to OpenClaw agents
- receive structured responses back from OpenClaw agents
- stay within a safer auth boundary where provider OAuth/session credentials are never handed to OpenClaw

Think of this as a local "router" for agent-to-agent communication on your machine.

## What this is not

- Not a replacement for provider login or account auth in each agent platform.
- Not a cloud relay by default (it is local-first).
- Not legal advice. You still need to verify terms/policies for your own platform usage.

## Communication flow

1. External agent authenticates to bridge with bridge-specific client key.
2. External agent sends message to an allowlisted OpenClaw target.
3. OpenClaw-side client receives and processes the message.
4. Response returns through the same bridge channel.

## Core idea

- Bridge auth: local client keys only (hashed in config).
- Provider auth: never passed through bridge.
- Routing: explicit per-client allowlists (`canSendTo`).

## Repository layout

- `bridge/daemon.js` - bridge daemon (UNIX socket + ACL routing + queueing + local panel)
- `bridge/client.js` - CLI client (`send`, `listen`, `whoami`)
- `bridge/config.example.json` - starter config
- `bridge/provision-secrets.js` - generate secure local secrets + update hashes
- `bridge/read-secrets.js` - read generated admin/client secrets
- `scripts/bridge` - operator wrapper
- `scripts/smoke-two-way.sh` - transport validation
- `scripts/setup-macos-acl.sh` - optional shared-group ACL helper for cross-user setup
- `docs/` - security, ToS boundary, onboarding, troubleshooting, and X article draft
  - includes platform-specific instruction blocks for OpenAI/Codex, Claude, Gemini, and other runtimes
  - includes optional extension guidance for responder/listener/worker services

## Quick start

1. Initialize config:

```bash
./scripts/bridge init
```

2. Generate secrets/hashes:

```bash
./scripts/bridge provision-secrets
```

3. Start bridge:

```bash
./scripts/bridge up
```

4. Validate bidirectional transport:

```bash
./scripts/bridge smoke-two-way
```

5. Open panel URL:

```bash
./scripts/bridge panel
```

## Onboard a new agent client

1. Generate bridge key + hash:

```bash
CLIENT_ID="claude-desktop"
CLIENT_KEY="$(openssl rand -hex 24)"
CLIENT_KEY_SHA="$(./scripts/bridge hash-key "$CLIENT_KEY")"
```

2. Add client entry to `bridge/config.json`:

```json
{
  "id": "claude-desktop",
  "keySha256": "<CLIENT_KEY_SHA>",
  "canSendTo": ["openclaw-server"]
}
```

3. Restart bridge:

```bash
./scripts/bridge restart
```

4. Give only `CLIENT_ID` + `CLIENT_KEY` to that local agent harness.

For copy/paste instruction blocks by platform, see `docs/agent-instructions-by-platform.md`.
For optional worker/listener/responder extensions, see `docs/optional-services-extensions.md`.

## Safety rules

- Never put provider OAuth/session credentials in bridge config, payloads, or logs.
- Treat `bridge/runtime/generated-secrets.json` as sensitive and keep it local/private.
- Rotate bridge keys regularly.

## Notes

- This is not legal advice. Verify your own platform terms and policies.
- This template is intentionally local-first and transport-focused.

## License

MIT. See `LICENSE`.

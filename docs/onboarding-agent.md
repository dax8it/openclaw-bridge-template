# Onboarding a New Agent Client

## 1) Create key material

```bash
CLIENT_ID="agent-client"
CLIENT_KEY="$(openssl rand -hex 24)"
CLIENT_KEY_SHA="$(./scripts/bridge hash-key "$CLIENT_KEY")"
```

## 2) Add client in `bridge/config.json`

```json
{
  "id": "agent-client",
  "keySha256": "<CLIENT_KEY_SHA>",
  "canSendTo": ["openclaw-server"]
}
```

## 3) Restart bridge

```bash
./scripts/bridge restart
```

## 4) Validate identity

```bash
./scripts/bridge whoami --client "$CLIENT_ID" --key "$CLIENT_KEY"
```

## 5) Basic send/listen

Send:

```bash
./scripts/bridge send --client "$CLIENT_ID" --key "$CLIENT_KEY" --to openclaw-server --type command --payload '{"command":"status","requestId":"req_1","ts":"2026-02-25T00:00:00Z","args":{},"replyTo":"agent-client"}'
```

Listen:

```bash
./scripts/bridge listen --client "$CLIENT_ID" --key "$CLIENT_KEY"
```

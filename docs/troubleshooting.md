# Troubleshooting

## Bridge not starting

- Check config exists: `bridge/config.json`
- Tail logs: `./scripts/bridge logs`

## Auth failed

- Verify client ID exists in config.
- Verify provided key matches hashed key in config.

## Route blocked

- Update sender's `canSendTo` list in config.
- Restart bridge after config change.

## Smoke test fails

- Ensure bridge is running and socket exists.
- Ensure secrets file exists from `provision-secrets`.
- Re-run: `./scripts/bridge smoke-two-way`.

## Cross-user socket permission errors

- Use `scripts/setup-macos-acl.sh` with explicit users.

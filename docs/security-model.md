# Security Model

## Boundaries

- Provider auth boundary: owned by each agent platform/harness.
- Bridge auth boundary: local bridge client keys only.

## Controls

- SHA-256 key-hash auth per client.
- Route allowlist enforcement (`canSendTo`).
- Local UNIX socket transport.
- Message size limits and local queue bounds.

## Threat reduction

- Bridge key compromise does not imply provider OAuth compromise.
- Least-privilege routing reduces blast radius.

## Operator duties

- Protect `bridge/runtime/generated-secrets.json`.
- Rotate client keys periodically.
- Keep payloads free of secrets.

# AGENTS.md

Repo-local guidance for coding agents.

## Scope

This repository provides a generic local bridge pattern for OpenClaw interop.
Keep examples provider-neutral and avoid vendor lock-in.

## Security invariants (must preserve)

1. Never request/store/transmit provider OAuth/session tokens.
2. Bridge auth must remain bridge-local client key auth only.
3. Keep explicit ACL routing (`canSendTo`).
4. Do not add examples that leak sensitive values in payloads.

## Preferred tooling

- Use `rg` for search.
- Keep scripts POSIX-friendly where practical.
- Keep runtime artifacts in `bridge/runtime/` and out of git.

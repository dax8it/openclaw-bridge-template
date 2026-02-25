# Command Safety Reference

This document explains what each common command does, what it changes, and whether it is generally safe to run locally.

Safety labels used:
- `Read-only safe`: inspects files/process state; does not change system state.
- `Local-change safe`: changes files/processes in this repo only.
- `Caution`: changes OS-level settings, privileges, or long-running services.

## Repo and review commands

### `git clone https://github.com/dax8it/openclaw-bridge-template.git`
- Purpose: downloads the template repo.
- Side effects: creates a new local directory with repo contents.
- Network: yes (GitHub).
- Safety: `Read-only safe` for system config; creates files locally.

### `cd openclaw-bridge-template`
- Purpose: enters the repo directory.
- Side effects: none beyond current shell working directory.
- Network: no.
- Safety: `Read-only safe`.

### `git status --short`
- Purpose: shows local file changes.
- Side effects: none.
- Network: no.
- Safety: `Read-only safe`.

### `git log --oneline -n 5`
- Purpose: shows recent commit history.
- Side effects: none.
- Network: no.
- Safety: `Read-only safe`.

### `gitleaks detect --source . --redact`
- Purpose: scans repository content for secret patterns.
- Side effects: scans files; does not modify repo by default.
- Network: no.
- Safety: `Read-only safe`.

### `rg -nEI "..." .`
- Purpose: pattern scan fallback for potential secrets.
- Side effects: none.
- Network: no.
- Safety: `Read-only safe`.

## Core bridge lifecycle commands

### `./scripts/bridge init`
- Purpose: creates `bridge/config.json` from example template.
- Side effects: writes a new local config file.
- Network: no.
- Safety: `Local-change safe`.

### `./scripts/bridge provision-secrets`
- Purpose: generates local random client/admin secrets and updates hash values in config.
- Side effects:
  - updates `bridge/config.json` hash fields
  - writes `bridge/runtime/generated-secrets.json`
- Network: no.
- Safety: `Local-change safe` (sensitive output; keep local file private).

### `./scripts/bridge up`
- Purpose: starts local bridge daemon process.
- Side effects:
  - creates PID/log/socket files in `bridge/runtime/`
  - opens local HTTP panel endpoint on configured host/port
- Network: local loopback only by default.
- Safety: `Caution` (starts long-running process).

### `./scripts/bridge status`
- Purpose: shows daemon/socket/panel status.
- Side effects: none.
- Network: local health check only.
- Safety: `Read-only safe`.

### `./scripts/bridge logs`
- Purpose: tails bridge log output.
- Side effects: none (reads logs).
- Network: no.
- Safety: `Read-only safe`.

### `./scripts/bridge panel`
- Purpose: prints local panel URL.
- Side effects: none.
- Network: no.
- Safety: `Read-only safe`.

### `./scripts/bridge smoke-two-way`
- Purpose: validates bidirectional local message flow.
- Side effects:
  - starts temporary listener processes
  - writes temporary files under `/tmp`
  - sends local test messages over bridge socket
- Network: no external network; local socket only.
- Safety: `Local-change safe`.

### `./scripts/bridge down`
- Purpose: stops local bridge daemon.
- Side effects: stops process; may remove/rotate runtime state files.
- Network: no.
- Safety: `Local-change safe`.

## Client and routing commands

### `./scripts/bridge whoami --client ... --key ...`
- Purpose: validates client credentials and shows allowed routes.
- Side effects: none beyond auth attempt and logs.
- Network: local socket only.
- Safety: `Read-only safe`.

### `./scripts/bridge send --client ... --key ... --to ... --type ... --payload ...`
- Purpose: sends a message envelope through bridge routing.
- Side effects: writes bridge logs/queue activity.
- Network: local socket only.
- Safety: `Caution` (can trigger downstream actions depending on recipient command handling).

### `./scripts/bridge listen --client ... --key ...`
- Purpose: subscribes client to inbound envelopes.
- Side effects: runs a foreground listener process.
- Network: local socket only.
- Safety: `Local-change safe`.

## Admin and OS-level command

### `scripts/setup-macos-acl.sh` (usually via `sudo`)
- Purpose: creates/updates shared macOS group and directory permissions for cross-user socket access.
- Side effects:
  - changes group membership
  - changes ownership/permissions of shared directory
- Network: no.
- Safety: `Caution` (OS-level permission changes; review before running).

## Practical recommendation

Run commands in this order for lowest risk:
1. read-only review commands
2. `init` + `provision-secrets`
3. `up` + `smoke-two-way`
4. `down`

Only run `setup-macos-acl.sh` if you actually need cross-user socket access on macOS.

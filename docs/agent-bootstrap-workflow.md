# Agent Bootstrap Workflow (Point, Scan, Ingest, Build)

Use this workflow when you want an external agent (Codex/Claude/Gemini/other) to safely build and operate an OpenClaw bridge in its own environment.

## 1) Point the agent at this repo

Clone locally:

```bash
git clone https://github.com/dax8it/openclaw-bridge-template.git
cd openclaw-bridge-template
```

Open this folder as the active workspace for your agent tooling.

## 2) Run a safety review before execution

Basic checks:

```bash
git status --short
git log --oneline -n 5
```

Optional secret scan with `gitleaks` (if installed):

```bash
gitleaks detect --source . --redact
```

Fallback pattern scan (if `gitleaks` is not installed):

```bash
rg -nEI "ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----" .
```

## 3) Ingest required docs in this order

1. `docs/security-model.md`
2. `docs/tos-boundary.md`
3. `docs/agent-instructions-by-platform.md`
4. `docs/onboarding-agent.md`

Optional:
- `docs/optional-services-extensions.md`

## 4) Give the agent a build instruction prompt

Core bridge build prompt:
- `docs/prompts/build-openclaw-bridge-template.md`

Optional extensions prompt:
- `docs/prompts/implement-optional-services.md`

## 5) Require these non-negotiable constraints

Include this policy in your agent task:

```md
Do not request, store, or transmit provider OAuth/session credentials.
Use bridge client credentials only.
Do not include secrets in payloads.
Keep route permissions least-privilege.
```

## 6) Validate the result

After the agent finishes:

```bash
./scripts/bridge init
./scripts/bridge provision-secrets
./scripts/bridge up
./scripts/bridge smoke-two-way
./scripts/bridge down
```

If all commands succeed and `smoke-two-way` returns `PASS`, the bridge core is operational.

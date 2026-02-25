# OpenClaw Bridge: A Safer Pattern for Multi-Agent Interop

## Why we built this

Multi-agent workflows are easy to demo but hard to run safely in real operations.
The recurring failure mode is credential boundary collapse: one runtime starts carrying credentials that belong to another platform.

We wanted the opposite.

The goal was simple:
- let external agents collaborate with OpenClaw,
- keep provider credentials inside each platform's own harness,
- and avoid passing OAuth/session tokens through shared infrastructure.

## The design principle

Do not collapse auth boundaries.

In practice that means:
- OpenClaw gets bridge-scoped local credentials only.
- OpenAI/Anthropic/Google credentials stay inside their native agent apps/runtimes.
- Routing permissions are explicit and least-privilege (`canSendTo`).

## What we shipped

A local bridge pattern with:
- UNIX socket transport for local IPC,
- per-client authentication using SHA-256 key hashes,
- explicit route ACLs,
- structured command/response envelopes,
- queueing for temporarily offline recipients.

This gives us deterministic local messaging without requiring provider credential sharing.

## Security and operator clarity we added

We also documented the operational side, not just the code:
- a step-by-step bootstrap workflow (`point -> scan -> ingest -> build`),
- platform-specific instruction packs (OpenAI/Codex, Claude, Gemini, others),
- and a command safety reference that explains what each shell command does, what it changes, and whether it's read-only, local-change, or caution-level.

That makes the project easier to audit before running commands, especially for teams with strict security reviews.

## Why this is better

1. Reduced blast radius  
Bridge key compromise is not equivalent to provider OAuth/session compromise.

2. Better operational clarity  
Envelope contracts and local logs make debugging easier and faster.

3. Interop without trust sprawl  
Different agent runtimes can coordinate through a common transport boundary.

4. Practical least privilege  
Each client gets only the destinations it needs.

## What this does not solve by itself

- It is not legal advice.
- Each team still needs to validate its own ToS/policy requirements.
- Payload hygiene still matters: do not place secrets in payloads or logs.

## The outcome

This pattern gave us a working, repeatable way to run OpenClaw-centered multi-agent workflows with cleaner security boundaries and lower credential-sharing risk.

## If you want to replicate it

Start with a template repo that includes:
- bridge daemon,
- `send/listen/whoami` client,
- key provisioning + hash-based auth,
- ACL routing,
- smoke tests,
- command-by-command safety documentation,
- explicit documentation that provider OAuth/session credentials are out of scope for the bridge.

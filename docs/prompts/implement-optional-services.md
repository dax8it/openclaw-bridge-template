# Prompt: Implement Optional Bridge Services

```md
Add optional service extensions to this OpenClaw bridge repo.

Services to implement:
1. openclaw-server-agent
   - persistent authenticated bridge client
   - receives command envelopes, returns response envelopes
   - supports allowlisted commands (ping, status, sync_context)
2. codex-inbox-listener
   - persistent authenticated bridge client
   - appends incoming envelopes to JSONL
3. mflux-worker
   - authenticated bridge client
   - handles explicit allowlisted worker commands only
4. wrapper scripts and optional launchd templates
   - up/down/status/logs
   - no duplicate process starts

Hard constraints:
- Do not request/store/transmit provider OAuth/session credentials.
- Use bridge client credentials only.
- Enforce least-privilege routing.
- Keep payloads free of secrets.
- Include structured errors and clear logs.

Output:
- code files
- script entrypoints
- env var contract docs
- usage examples
- updated troubleshooting notes
```

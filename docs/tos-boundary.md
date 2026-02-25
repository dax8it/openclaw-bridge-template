# Terms-of-Service Boundary

This template is designed to avoid cross-platform credential sharing.

## Policy intent

- OpenClaw receives only bridge-scoped credentials.
- Provider OAuth/session credentials stay in their native platform harness.

## Important

- This repository is technical guidance, not legal advice.
- Each user/team must verify compliance with their own platform terms.

## Do not do

- Do not copy provider OAuth/session tokens into bridge config.
- Do not include provider credentials in bridge message payloads.
- Do not automate credential extraction from external agent apps.

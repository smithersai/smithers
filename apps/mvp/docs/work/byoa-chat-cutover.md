---
title: Mount conversation MCP attachment and retire browser chat
status: in-progress
area: chat
owner: Codex / track-g
updated: 2026-11-24
links:
  - ../decisions/0173-byoa-only-mcp-attach-and-jev-config.md
  - ../features/mcp.md
  - ../features/chat.md
---

Mount the reference, consent, pairing, redemption and revocation routes. Bind each grant to the current repository
role, branch access and conversation. Move the chat transcript decoder and remove the browser chat host and public
model proxy. Keep server model metering and return a typed failure when a TODO has no coding seat.

The change uses the existing Effect SQL app database and migration loader. The library catalog covers transaction and
migration contracts under `@smthrs/database` and model seats under `@smthrs/model`.
The Worker integration suite exercises the complete grant lifecycle against Postgres and real sign-in and repository-role
services. The local browser chat suite uses that same attachment, with hosted inference off.

Attachment rows are indexed by reference, claim, code digest, token digest and grant ID. The integration tests verify
revocation while unrelated claim and redemption requests wait on Postgres row locks, and authentication rejection
while the table allows reads only. Browser chat and spend alert coverage check for zero requests to the retired proxy.

Other browser-agent test fixtures still exercise tool calls or model replies from the retired runtime. The attached
conversation tools cover chat reads and replies. Legacy fixture conversion and any replacement seats for browser-only
drafting, rendering and summaries remain open.

---
title: Connect a person's agent from branch chat
status: done
area: chat
owner: codex-branch-chat
updated: 2026-11-27
links:
  - ../decisions/0173-byoa-only-mcp-attach-and-jev-config.md
---

The hosted branch saved a question at 22:33 UTC. The branch rendered a pending MCP answer as active work and exposed a run link without a journal. The Workbench supplied an endpoint without minting a conversation reference. The branch now mints a reference, reviews the claim, takes the pairing code, and supports revocation. Workbench opens that branch. A committed reply and a transcript read each emit a correlated, content-free record.

The implementation uses the catalog's `@smthrs/effect-tanstack-db` tab-local state and `@smthrs/ui` controls. The existing attach host retains grant authority. The CLI's legacy claim and redeem spellings resolve to the same mounted routes.

On the Mini, the app, worker, infrastructure and evals typecheck passed. Focused Workbench, timeline, MCP and Postgres attach suites passed, including stale-response and mismatched-consent tests. Two device integration cases verified the pending state and answer ordering. The normal Chromium branch-page test passed in 37.9 seconds: the person asked, paired, approved and revoked; a separate client read and answered the original question; its next read received 401. The dev server also reported one unrelated refs lookup with `503 not_configured`. Production verification belongs to the signed-in person approving their own attachment.

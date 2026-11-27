---
title: Restore private artifact writes through MCP
status: in-progress
area: object-store
owner: codex-artifact-repair
updated: 2026-11-27
links: []
---

The Worker must give R2 a known-length body. Exercise the shared byte adapter against a real workerd R2 binding, including empty objects and byte views.

Real workerd R2 rejected the prior hand-created stream because it had no known length. The targeted regression passed with exact binary and empty byte views. Production read-after-write awaits the coordinated rollout.

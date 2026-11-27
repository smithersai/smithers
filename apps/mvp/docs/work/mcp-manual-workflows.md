---
title: Start and inspect repository workflows through MCP
status: in-progress
area: mcp
owner: codex-artifact-repair
updated: 2026-11-27
links: []
---

Use the existing manual workflow admission and repository run status on behalf of an authenticated agent.

Implemented `workflow_start` and `workflow_run_get` on the public MCP registry using the library catalog's durable `@smthrs/flow` host and existing repository admission. The start checks the live agent grant again inside the transaction and records its agent origin in the durable intent. Status comes from the target repository's manual run row.

All 106 tests in the registry and manual route suites passed. The final focused admission and deployment-role checks also passed against scratch Postgres, including duplicate starts, revoked credentials, and cross-repository status isolation. Hosted verification follows the coordinated Worker deployment.

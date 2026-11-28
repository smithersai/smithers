---
title: Run the landing readiness check from the repository page
status: done
area: runs
owner: codex-hosted-runs
updated: 2026-11-27
links: [../features/actions.md]
---

Use the existing landing numbering check in a single repository job. Record the stage that refused a flow-list request and show a repository-specific message for a missing hosted flow.

The signed-in repository returned a saved TODO and a flow-list 404 in the same session. Both routes use the same repository role check. The flow-list route checked the deployment’s repository allowlist before the role and returned the same 404 for both refusals. The projected factory also had no manual triggers.

Decision [0176](../decisions/0176-manual-only-repository-flows.md) adds an explicitly scoped manual list. The new check runs the repository’s numbering validation in a single 30-second step. The production rollout needs the setting and a verified run from the repository page.

The Mac mini generated and checked the factory projection. Ten focused tests passed against the real QuickJS realm, database and Runs view. Three Alchemy binding tests passed. These focused runs did not measure full-suite coverage.

A member launched the readiness check from the hosted Runs page. The sandbox checked out the pinned commit and the numbering check exited 0. MCP confirmed the parent run reached done.

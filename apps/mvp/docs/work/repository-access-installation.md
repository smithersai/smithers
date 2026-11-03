---
title: Fail closed after private repository installation loss
status: done
area: repository-access
owner: codex
updated: 2026-11-02
links: [../features/branch-workspace.md, ../features/issues.md]
---

Finding 1. A missing installation must not revive ownership or surviving shares on a private branch. Both workRole's refusal fallback and BranchRoles' uninstalled path now require recorded public visibility. Unknown visibility also fails closed. Explicit local development retains its own roles.

Library catalog: existing Effect and injected RepoRoles/BranchRoles services; no new library or plugin. This is the core authorization boundary.

Baseline main: `lost installation never restores private ownership or surviving shares` returned owner/member where none/null was expected. `lost installation cannot substitute a deployment role on a private repository` returned admin instead of null.

Validation: Latitude, Access.test.ts and RepoRoles.test.ts: 92 passed, 0 failed, 0 skipped. No production reads or deployment.

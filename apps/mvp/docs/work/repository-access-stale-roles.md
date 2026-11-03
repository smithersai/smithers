---
title: Reject stale deployment authority for private reads and audit
status: done
area: repository-access
owner: codex
updated: 2026-11-02
links: [../features/sign-in.md, ../features/agent-runners.md]
---

Finding 5. Sign-in retains identity while withholding a stale role during background rechecks; run credentials also withhold stale authority. The deployment repository resolver and runner audit independently read a live session's confirmed receipt. They enforce ROLE_RECHECK_MINUTES on the database clock. Explicit local development has no GitHub session.

The effective role and its verification time come from the same ordered receipt. A failed recheck copies both together and never renews the confirmation. No additional refresh or retry loop is introduced.

Library catalog: existing Effect Config and SQL services, RepoRoles, Sessions. This is core authorization infrastructure.

Baseline regressions: private branch returned owner instead of none; stale deployment receipts returned member/admin instead of null; the audit returned 200 instead of 403. Reproduced through sign-in plus branch access, the direct repository resolver, and the real audit handler against Postgres.

Final Latitude validation: 284 passed, 0 failed, 0 skipped across Access, RepoRoles, Notifications, Notifications.access, RedactFeed, SignIn, SignIn.handoff, Audit and SocketAccess. Worker typecheck passed. Fresh, missing, exactly expired, future-dated and revoked confirmations are covered; a cross-session failed recheck keeps the effective receipt's original confirmation. No production reads, browser tests, deployment or coverage measurement were performed.

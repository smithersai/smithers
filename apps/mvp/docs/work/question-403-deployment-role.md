---
title: Preserve deployment roles when repository visibility is unavailable
status: in-review
area: auth
owner: claude-question-403
updated: 2026-11-03
links: [feed-gate-rebase.md]
---

Will requested one unlanded fix on main@origin, with full mini comparisons against main and 4738de93a8c8. The shared browser fixture seeds a different home repository from its scripted GitHub. Independently, uninstalled deployment access incorrectly uses public visibility instead of its fresh session authority. A metadata 404/410 is unavailable, never proof of private visibility. Preserve confirmed denials and session freshness checks.

Library catalog: existing Effect SQL and @smthrs/integrations GitHub transport; no dependency added. Validation and review receipts stay in the external question-403-fix scratch directory. Do not land, push or deploy this change.

Second pass: the first fix seeded the home on the scripted repository but ChatApi's test routes still captured the default home, so questions answered 503 `no_home`; TestChatApi now provides the captured home as ChatApiProgram does. The GitHub route harness signed in with sessions that had no row, which the deployment's session-receipt role reads as no role; it now records them confirmed. Publish/Resync locate the branch's repository before asking a role there.

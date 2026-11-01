---
title: Replay GitHub webhooks from the deployment secret gap
status: in-progress
area: infra
owner: Sandboxes builder assigned by lead; Codex curates tracker documentation
updated: 2026-10-22 01:54 PDT
links: [github-source-of-truth.md, issues.md, production-deploy-config-parity.md, ../rulings.md]
---

**What:** Recover GitHub webhook deliveries lost during the secret gap.

**Why:** GitHub-backed app state must reflect missed events.

**Current state:** At 01:46 the lead assigns the sandboxes builder to resend deliveries that failed between 21:05 and 21:26 on October 21, when production lacked the webhook secret. No completed replay receipt is reported.

**Next step:** Identify affected deliveries, replay through the normal ingress and verify deduplicated resulting state.

**Open questions for Will:** None.

Evidence: script-filtered lead text replies in session 6253ecf2, latest two hours through 01:53 PDT. Current rulings and queue answers govern. Product results are reported, not rerun by this tracker refresh.

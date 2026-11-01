---
title: Read historical production Worker records
status: in-progress
area: app
owner: Lead and production deployer; optional token permission owned by Will
updated: 2026-10-22 00:24 PDT
links: [todo-active-run-view.md, todos-and-stack.md, production-e2e.md, observability.md, ../rulings.md]
---

**What:** Make historical production logs available for diagnosis without exposing secrets or user content.

**Why:** Production failures need observable, durable fixes and real acceptance.

**Current state:** At 00:20 the lead reports the Cloudflare token supports live streaming only. An optional decision-queue request asks for Workers Observability: Read on the existing token. No answer or permission-change receipt is present.

**Next step:** Continue live-tail diagnosis; if the optional permission is granted, verify historical reads and retain safe diagnostic receipts.

**Open questions for Will:** Optional existing queue item: grant Workers Observability: Read; do not request credentials in tracker notes.

Evidence: script-filtered human text and lead replies across the supplied transcript paths, latest two hours through 00:23 PDT; the continuation path is absent at this refresh and recent replies survive in 6253ecf2. Current rulings and queue answers take precedence. Later surviving handoffs are explicitly dated where used. Reboot-wiped briefs are not missing work. Product receipts are reported, not rerun here; Codex curates documentation and retains execution ownership.

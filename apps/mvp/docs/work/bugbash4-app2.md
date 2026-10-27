---
title: Bug bash 4 — reports, background progress and offline views
status: in-progress
area: app
owner: bb4-app2
updated: 2026-10-27
links: []
---

Confirmed findings: p4-bugreport-2/6/8, p4-toasts-1/2/3/4, p4-chat2-2, p4-pwa-2, p4-queue-1, p4a11y2-2, p4-flows-10.

Use the catalog entries for @smthrs/ui, @smthrs/flow and @smthrs/effect-tanstack-db; retain existing flows and outbox receipts.
Privacy first: template failed HTTP paths at capture and GitHub export, including legacy records. Opening a prefilled GitHub form transmits its query; submitting creates the issue.

W13 retains the privacy, validation, slash refusal, offline, focus and draft-label changes. Deployment proof is pending.

W13 leaves background progress (p4-toasts-1/2/3, commits 7db7a18fb596, 1306d2d3c3c0 and 717f550e01a4) unlanded: Astra found duplicate issue identities on toast retry, a failed notice surviving page retry, and launches waiting forever after interruption before engine admission. Follow-up fixes still left missing-recovery and outbox-before-engine ambiguity. The lander omitted this slice under the batch's few-minute rule. Publish/Update notices remain with bb4-writes.

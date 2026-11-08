---
title: Machine write completion logs
status: done
area: github
owner: codex
updated: 2026-11-04
links:
  - ../observability.md
---

Log each successful machine-write settlement once, with writeId, op, number,
agent and lane only. Library catalog: @smthrs/observability, using the host's
existing structured Effect logger. This extends the existing settlement
infrastructure; no new feature interface or dependency is needed.

Validation on cfbox's pg image, 4 CPUs through nyc-01:
- Tests first, worker unchanged: 2 failed, 65 passed. Both done writes reached
  the exact log assertion and received an empty completion-log array.
- Fixed worker: all 67 MachineWrite tests passed; worker VibeLang typecheck passed.
- Create and relate each emit exactly one Info record with the exact five
  annotations, even after another tick, without title, body, label text or token.

The shared settlement uses UPDATE RETURNING so only an actual transition into
done emits the event, across every operation and recovery path. No production
deployment or e2e run; log-only change, review.mjs skipped as requested.
One local commit; no landing or push.

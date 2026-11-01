---
title: Repair killed-run recovery timeout on main
status: done
area: sdk
owner: Codex recovery repair job assigned by lead; Codex curates tracker
updated: 2026-10-22 13:14 PDT
links: [prelaunch-custom-domains.md, secrets-proxy.md, main-reds-burn-down.md, ../rulings.md]
---

## Tracker reconciliation — 2026-10-22 13:14 PDT

**What:** Repair killed-run recovery and disconnected-database shutdown.

**Why:** Interrupted durable runs must recover without hanging.

**Current state:** At 13:05 PDT the lead confirms the repair on main b698e059. The earlier recovery test passed five consecutive runs without raising its timeout; a cut connection returns a connection error instead of hanging.

**Next step:** Retain the recovery regression; track unrelated flow-package gate failures in main-reds-burn-down.md.

**Open questions for Will:** None.

Evidence: lead text replies through 20:13 UTC, extracted by script from the latest two hours across both requested transcript paths. Only session 6253ecf2 is present; automated notifications are excluded from human authority. Current rulings and queue answers govern older docs and surviving briefs. Reboot-wiped files are not outstanding work. Product results are lead-reported; Codex curates documentation only and retains implementation ownership.

## Earlier tracker history (retained)


## Tracker reconciliation — 2026-10-22 12:24 PDT

**What:** Repair killed-run recovery without hanging on a disconnected database.

**Why:** Interrupted durable runs need reliable recovery and bounded shutdown.

**Current state:** At 12:19 PDT the lead reports the repair with lander 2. Push 22 made shutdown wait forever on a connection cut by the test. A cut connection now returns a clear connection error; the recovery test passed five consecutive runs without increasing its timeout. No landing receipt is reported.

**Next step:** Complete lander 2’s integrated gate, land the repair and retain recovery evidence on the landed revision.

**Open questions for Will:** None newly required.

Evidence: lead text replies at 19:19–19:20 UTC, extracted by script from the latest two transcript hours ending 19:23:39 UTC. Both requested paths checked; continuation file absent, recent replies survive in the original. Current rulings and queue answers govern historical docs and surviving briefs. Reboot-wiped files are not outstanding work. Product checks are lead-reported; Codex curates documentation and retains implementation ownership.

## Earlier tracker history (retained)


## Tracker reconciliation — 2026-10-22 11:34 PDT

**What:** Repair killed-run recovery after interruption.

**Why:** Durable runs must recover, and clean-main failures must not obscure unrelated gates.

**Current state:** At 11:34 PDT the lead confirms a Codex job is now fixing the recovery timeout reproduced on clean main by both the custom-domain and secrets stacks. This advances the work from planned to running; no repair or passing recovery receipt exists.

**Next step:** Retain the failing reproduction, repair the recovery defect and complete the real recovery test and landing gate.

**Open questions for Will:** None newly required.

Evidence: lead text replies through 2026-10-22T18:34:08Z, script-extracted from the latest approximately two hours. Both supplied transcript paths were checked; the continuation file is unavailable and recent replies survive in the original. Current rulings and queue answers govern older decisions, proposals, TODOs, rules and surviving briefs. Wiped scratchpad files are not outstanding work. Product checks are reported receipts; Codex curates documentation and verifies the site build. Implementation ownership is retained except the newly assigned recovery job.

## Earlier tracker history (retained)

**What:** Repair the recovery test that times out after a run is killed.

**Why:** Durable execution must recover after interruption; unrelated stacks need a trustworthy main gate.

**Current state:** At 11:20 PDT the lead reports that both custom-domain and secrets rebases reproduced this timeout on clean main. A Codex job is planned after current rebases finish; no started job or repair receipt is reported.

**Next step:** Assign the repair, retain the failing reproduction, determine the recovery defect and pass the real recovery test before landing.

**Open questions for Will:** None.

Evidence: lead text reply at 2026-10-22T18:20:38.207Z, extracted by script from session 6253ecf2. The requested continuation path is absent. Current rulings and queue answers govern older docs; this note records planned work, not a completed repair.

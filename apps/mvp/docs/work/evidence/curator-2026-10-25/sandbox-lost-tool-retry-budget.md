---
title: Verify bounded recovery after genuine sandbox tool loss
status: todo
area: sdk
owner: sandbox builder assigned by lead; Codex curates tracker
updated: 2026-10-22 03:24 PDT
links: [sandboxes.md, ci-parity-long-commands.md, hosted-smithers-dogfood.md, ../rulings.md]
---

## Tracker reconciliation — 2026-10-22 03:24 PDT

**What:** Verify bounded recovery for genuinely lost sandbox tools.

**Why:** Actual transport loss still needs bounded durable recovery.

**Current state:** Correction at 03:15: the 151 attempts were successful steps, not engine retries. This incident does not establish an unbounded retry defect. Proven repairs are detached commands and bounded engine drive time; the earlier retry-cap assignment is superseded by this diagnosis.

**Next step:** Check the existing lost-tool deadline/retry policy with an actual loss regression. Implement a cap only if that evidence establishes a gap; track the proven timer repair separately.

**Open questions for Will:** None newly required; earlier questions remain in history.

Evidence: lead text replies script-extracted from the latest two session hours through 03:23 PDT, 2026-10-22. Both supplied transcript paths were checked; the continuation path is absent and recent replies are in 6253ecf2. Rulings and queue answers govern older docs and surviving briefs. Product results are reported receipts, not rerun here. Codex curates the tracker; implementation ownership is retained. Reboot-wiped files are not missing work.

## Earlier tracker history (retained)


**What:** Bound durable engine retries of a sandbox tool whose connection is lost.

**Why:** The production dogfood run spent 33 minutes and 151 engine attempts on disconnected dependency installation.

**Current state:** At 03:10 PDT the lead corrected the earlier agent-loop diagnosis: only seven model calls occurred. The sandbox builder received the engine retry-cap work alongside connection diagnosis and detached commands. No completed implementation or passing recovery receipt is reported.

**Next step:** Set bounded retry/deadline policy in the durable engine's existing mechanism, preserve the detached job identity across reconnects, and prove interruption, exhaustion and recovery without duplicate process launches. Rerun production dogfood step 3.

**Open questions for Will:** None.

Evidence: script-filtered lead replies at 03:09–03:10 PDT, session 6253ecf2, 2026-10-22. Current rulings and queue answers govern. Earlier ci-parity-long-commands.md retains the detached-job design; this note tracks retry exhaustion separately. Codex owns tracker curation only.

---
title: Verify parallel completion order and durable replay
status: done
area: sdk
owner: Codex ordering investigator assigned by lead; Codex curates tracker
updated: 2026-10-22 10:34 PDT
links: [journal-deployment-lock-contention.md, planner-core-replay-ordering.md, sign-in.md, ../rulings.md]
---

## Tracker reconciliation — 2026-10-22 10:34 PDT

**What:** Verify parallel verifier completeness, phase ordering and replay.

**Why:** Parallel completion order is unconstrained by the engine contract.

**Current state:** At 10:10 the lead reports the corrected example checks all three verifiers as a set, rejects missing or duplicate results, enforces the next-phase barrier and replays without new model calls. The engine is unchanged. The encompassing TODO-run/journal stack landed in push 22 at 10:26.

**Next step:** Retain the corrected regression and integrated landing receipts.

**Open questions for Will:** None newly required; existing decisions remain in retained history.

Evidence: script-filtered lead replies through 2026-10-22T17:33:43Z, covering approximately 08:34–10:34 PDT. The continuation transcript path is absent; recent replies survive in the original. Current rulings and queue answers govern older decisions, proposals, TODOs, rules and surviving briefs. Reboot-wiped briefs are not outstanding work. Product receipts are lead-reported; Codex curates tracker documentation and runs only the site build. Existing implementation ownership retained.

## Earlier tracker history (retained)


## Tracker reconciliation — 2026-10-22 10:13 PDT

**What:** Check parallel verifier completion against the engine contract and retain durable replay coverage.

**Why:** Journal batching exposed an example assertion that assumed completion order.

**Current state:** At 10:10 PDT the lead reports the engine explicitly permits parallel steps to finish in any order. The example promises results in declaration order, not completion in that order. The corrected test checks all three verifiers as a set, rejects missing or duplicate results, requires all three before the next phase, and replays the saved run without new model calls. The engine is unchanged. The integrated TODO-run/journal stack is back with lander 1; landing is not confirmed.

**Next step:** Obtain the integrated gate and landing receipts for the repaired example and journal stack; keep the phase barrier, result completeness and replay assertions.

**Open questions for Will:** None.

Evidence: lead text reply at 2026-10-22T17:10:03.795Z, script-extracted from the latest approximately two hours ending 17:13:40Z. Both requested transcript paths were checked; the continuation file is absent, while recent replies survive in the original. Automated notifications and tool payloads are excluded. Current rulings and queue answers govern older decisions, proposals, TODOs, rules and surviving briefs. Reboot-wiped briefs are not outstanding work. Product results are lead-reported; Codex curates these notes and validates the maintainer-site build. Implementation ownership and history are retained.

## Earlier tracker history (retained)

**What:** Establish whether parallel verifiers promise declaration-order completion, then repair the engine or the example test accordingly.

**Why:** Journal batching exposes a completion-order difference that currently gates the TODO-run/journal stack.

**Current state:** At 09:54 PDT the lead reports three parallel verifiers now finish 2, 3, 1 instead of 1, 2, 3. Everything else in that integrated stack passes. A Codex job is investigating; no verdict, repair or landing receipt is reported. This is separate from the already-landed planner identity fixes.

**Next step:** Read the engine's documented ordering contract. If declaration order is promised, restore it in the engine. Otherwise assert that all verifiers complete before the next phase and that durable replay reproduces the recorded order. Retain a regression and rerun the failing example with the integrated journal stack.

**Open questions for Will:** None; this is a contract investigation for the assigned builder.

Evidence: lead text reply at 2026-10-22T16:54:46.467Z, extracted by script from the approximately two-hour window ending 17:03:40Z in session 6253ecf2. Both requested paths were checked; the continuation file is absent. Automated notifications and tool payloads are excluded. Current rulings and queue answers govern older docs and surviving briefs. Product checks are reported evidence, not rerun by this curator. Reboot-wiped scratch files are not missing work.

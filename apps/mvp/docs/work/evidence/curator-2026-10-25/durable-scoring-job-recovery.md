---
title: Keep accepted scoring jobs durable across shutdown and crashes
status: in-progress
area: sdk
owner: Codex scoring-recovery builder on Latitude assigned by lead; Codex owns tracker curation
updated: 2026-10-22 06:33 PDT
links: [everything-is-a-durable-flow.md, agent-evals.md, ../rules.md, ../rulings.md]
---

## Tracker reconciliation — 2026-10-22 06:33 PDT

**What:** Keep accepted scoring jobs durable across crashes.

**Why:** Accepted work must survive shutdown and report usable failures.

**Current state:** At 06:33 the lead lists the scoring-runner repair ready to land, including readable command-line errors. This supersedes the earlier index/diagnostic repair hold; no landing receipt yet.

**Next step:** Land the repair and retain index, docs and crash/replay receipts.

**Open questions for Will:** None newly required.

Evidence: script-filtered lead text replies, 04:33–06:33 PDT, from session 6253ecf2. The supplied continuation file is absent; continuation-era replies survive in the original. Automated task notifications are excluded as human evidence. Current rulings and queue answers govern older decisions, proposals, TODOs, rules and surviving briefs. Product receipts are lead-reported; existing execution ownership is retained, and Codex curates this note. Reboot-wiped scratch files are not missing work.

## Earlier tracker history (retained)


## Tracker reconciliation — 2026-10-22 04:14 PDT

**What:** Keep accepted scoring jobs in the durable flow engine across crashes.

**Why:** Accepted work must survive shutdown without duplicate completion.

**Current state:** The 03:40 implementation handoff was returned at 04:08: target-index generation fails with the scoring change but succeeds without it. The same Codex job is repairing CLI diagnostics first and then the scoring/index failure. The durable-runner implementation is not accepted or landed.

**Next step:** Expose actionable error output, fix the index failure, rerun target-index and docs sync/check plus crash/replay gates, then resend to lander 2.

**Open questions for Will:** None newly required.

Evidence: lead text replies script-extracted for 02:13–04:13 PDT from session 6253ecf2. The requested continuation transcript is absent from the projects directory; recent continuation-era replies survive in the original. Rulings and queue answers prevail over historical plans. Product results are reported receipts, not rerun here. Codex owns this tracker curation; implementation ownership is retained. Reboot-wiped files are not missing work.

## Earlier tracker history (retained)


## Tracker reconciliation — 2026-10-22 03:44 PDT

**What:** Run accepted scoring jobs through the existing durable flow engine.

**Why:** Accepted jobs must survive shutdown and crashes without duplicate completion.

**Current state:** At 03:40 PDT the lead reports the repair finished and handed to lander 2. The in-memory runner is removed; the builder reports crash survival and exactly-once replay. Landing is not confirmed. Status remains in-progress pending the lander's checks.

**Next step:** Lander 2 runs documentation checks and compares the observed command-line test failures against main. Resolve any introduced failures, retain recovery-test receipts and confirm landing before marking done.

**Open questions for Will:** None.

Evidence: lead text reply at 2026-10-22 10:40:54 UTC, extracted by script from the latest two hours across both supplied transcript paths. Automated notifications and tool payloads excluded. Rulings and queue answers take precedence over older decisions, proposals and surviving briefs. Reboot-wiped briefs are not outstanding work. Builder claims are reported evidence, not tests rerun by this tracker refresh. Implementation ownership is unchanged; Codex curates this note.

## Earlier tracker history (retained)


## Tracker reconciliation — 2026-10-22 02:34 PDT

**What:** Run accepted scoring jobs through the existing durable flow engine.

**Why:** Accepted work must survive process shutdown or a crash.

**Current state:** At 02:28 the lead reports a review finding: the scoring runner retains accepted jobs only in memory and can lose them. A Codex job is fixing it on Latitude, with an interruption test requiring every accepted job to finish exactly once. No completed implementation or validation is reported.

**Next step:** Locate the runner, replace its volatile execution path with durable flow steps, retain interruption/recovery receipts and obtain review and landing evidence.

**Open questions for Will:** None newly required.

Evidence: user-typed text and lead replies script-filtered from the available session, 00:34–02:34 PDT on 2026-10-22; tools, automated notifications and compaction summaries excluded. The supplied continuation transcript is absent; recent replies survive in the original file. Rulings and queue answers govern historical decisions, proposals and surviving briefs. Reboot-wiped briefs are not missing work. Product receipts are reported, not rerun here. Codex curates documentation without taking implementation ownership.

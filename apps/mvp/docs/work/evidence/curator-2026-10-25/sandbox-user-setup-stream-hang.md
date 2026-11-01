---
title: Drain sandbox user-setup error output
status: in-progress
area: sdk
owner: sandbox detached-command builder assigned by lead; Codex curates tracker
updated: 2026-10-22 10:34 PDT
links: [sandbox-check-script-jobs.md, ci-parity-long-commands.md, sandboxes.md, ../rulings.md]
---

## Tracker reconciliation — 2026-10-22 10:34 PDT

**What:** Drain sandbox initialization error output.

**Why:** An unread useradd warning stream must not hang first-user setup.

**Current state:** Final sandbox validation passed at 10:21, including the ten-minute real command. At 10:31 the batch still needs its builder’s rebase; no landing receipt exists.

**Next step:** Preserve the setup regression through rebase, land and verify production initialization.

**Open questions for Will:** None newly required.

Evidence: script-filtered lead replies through 2026-10-22T17:33:43Z. Continuation transcript unavailable; original includes recent replies. Rulings and queue answers govern older documentation; wiped briefs are not missing work. Product validation is lead-reported; this curator runs only the site build. Implementation ownership retained.

## Earlier tracker history (retained)


## Tracker reconciliation — 2026-10-22 10:24 PDT

**What:** Drain sandbox setup error output so first-user initialization completes.

**Why:** An unread useradd warning stream blocked setup and the earlier local terminal startup.

**Current state:** At 10:21 PDT the lead reports the sandbox-command batch passes all 3,134 app tests, type checks, docs and the ten-minute Mac mini command test. This includes the reviewed setup-stream repair. The batch still waits behind TODO stacks; Docker restart and dev-server reload explain earlier interrupted tests, not additional product defects.

**Next step:** Land the validated repair with the sandbox batch and verify first-user setup and terminal startup with warning output after deployment.

**Open questions for Will:** None newly required.

Evidence: script-filtered user text and lead replies through 2026-10-22T17:23:40Z. Both requested transcript paths were checked; the continuation path is absent, and recent replies survive in the original. Rulings and queue answers govern older planning documents and surviving briefs. Reboot-wiped files are not outstanding work. Product validation is lead-reported; this curator runs only the site build. Existing implementation ownership and all history are retained.

## Earlier tracker history (retained)


**What:** Prevent local sandbox user setup hanging on unread error output.

**Why:** A harmless useradd warning filled an unread stream, blocking the first setup and explaining the earlier Mac mini terminal hang.

**Current state:** At 08:48 the lead reports the cause and repair. At 09:02 the repair and passing ten-minute E2E are with lander 1; the sandboxes reviewer found the fix sound. All 3,134 app tests passed. Landing is unconfirmed.

**Next step:** Land the reviewed repair and verify first-user setup and terminal startup complete with warning output.

**Open questions for Will:** None.

Evidence: lead replies at 08:48 and 09:02, script-extracted from the requested transcripts. Rulings and queue answers govern. Product receipts are reported, not rerun by this curator.

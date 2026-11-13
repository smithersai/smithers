---
title: Client stack round-4 recovery findings
status: in-progress
area: local-first
owner: Codex GPT-6.1 Sol
updated: 2026-11-03
links: [../decisions/0023-device-ownership-and-queued-authority.md]
---
Fix leadership reacquisition ordering, dirty held-index invalidation, and whole-sign-out cleanup.
Use the library catalog entry `@smthrs/effect-tanstack-db` for outbox storage and ordering.
Write and execute red regressions before implementation. Run validation only through mini-run.
Keep owner filtering, send-time checks, and server binding intact. No reviewer, landing, push, or deployment.

Red evidence, executed on the Mac mini against the unchanged implementation:

- Reacquisition: `expected 1001 to be greater than 1001`, `test/Outbox.test.ts:1742` in the first red run.
- Dirty invalidation, before retry and while retry is queued: `expected false to be true`, `test/Outbox.test.ts:1789` in the first red run.
- Persisted collision recovery: `expected 1000 to be less than 1000`, `test/Outbox.test.ts:1731` in its isolated red run.
- Whole sign-out: all five injected local failures reached `expected undefined to be '1'`, `src/wipe.test.ts:507`, because no wipe marker was written.

Filtered red runs skipped unrelated tests (package 62 and 65, app 17); these are reproduction receipts, not full-suite validation.

The confirmed-session persistence case reproduced alone before implementation:
one failure at `src/wipe.test.ts:507`, with 21 unrelated tests filtered out.

Implementation derives the admission sequence from durable rows under the existing
admission lock through row persistence, recovers duplicate sequences through the
existing migration journal, retains dirty membership during invalidation, and
revalidates affected rows before index repair. Admission scans the retained backlog;
the old linear admission-read expectation now measures that explicit scan separately
from bounded status invalidation work.

The successful server sign-out path ensures wipe marking or sealing even when local
state or confirmation fails. Its outer finalizer releases the guard through the
host's `finishSignOut`, instead of depending on reaching `wipe`. Five faulty Effect
service cases exercise session update, confirmation restore/read/delete/persistence
against real retained collections and native Web Locks. The patch remains unchanged.

Final validation, executed only through mini-run on the Mac mini:

- App: 67 files, all 875 tests executed, 873 successful, two existing expected failures, zero unexpected failures, zero skips. Areas: device 86, coedit 34, issues 160, todos 148, runs 236, auth 37, chat 152, wipe 22. No isolated rerun was needed after implementation.
- Package: 17 files, all 214 tests successful, zero skips. The reacquisition, duplicate-repair, both invalidation-ordering, and retained ownership regressions all executed.
- App `pnpm typecheck`: client, worker, infra, and eval typechecks exited 0.
- Package `pnpm check`: source and test typechecks exited 0. This package has no `typecheck` script; the first attempt reported that missing command, then the declared `check` completed successfully.
- Capacity timeouts occurred before execution and were retried without changing test source. No tests, builds, installs, or caches were run on this Mac or either Latitude server.
- The dependency patch is 292 lines before and after. Both the patch and lockfile are unchanged above `09e9388d18b9`; no bottom-commit squash was necessary.

The original requested work-note squash reported no changes because the note was
already in `04509470645f`; the lane continued with `jj new` as requested.

Independent re-review remains outside this lane. No reviewer, landing, push, or
deployment was run. Browser E2E and coverage measurement were not run. No review
verdict is claimed. Owner filtering, send-time checks, and server device-person
binding remain intact; no path was added to send A's held write as B.
Raw round-4 test outputs are removed after retaining these receipts.

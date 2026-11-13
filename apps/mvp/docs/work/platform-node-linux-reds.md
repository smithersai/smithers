---
title: Platform Node Linux coverage failures
status: done
area: platform-node
owner: codex-platform-node-reds
updated: 2026-10-22
links:
  - packages/smithers/flows/platform-node/test/NativeRuntimeRestart.test.ts
---

Reproduce and repair the Linux coverage gate on Latitude. No push.
Catalog: `@smthrs/platform-node` for Node host execution and process containment;
`@smthrs/plan` for plan identity. No new library.

Restart fixture diagnosis: crypto/src/internal/sourceShape.ts explicitly drops
comments and whitespace for durable resume identity. Comment-only edits must
resume; semantic changes with the same action topology must refuse. This is an
outdated test assumption, not a Linux product defect.

Baseline (b5ccc983, Latitude nyc-01, Node 26.5): all nine reported failures
and both unhandled errors reproduced; focused suite 9 failed / 6 passed.
Restart fix: semantic payload edits refuse; two added comment-only edits resume.
Focused validation: restart 10/10; overall 17/17, no unhandled errors.

Signal/reap fixture diagnosis: engine-store.registration.recovered logs arrive
on stdout before the fixture readiness receipt. The old first-line parser
signals the host too early and converts a log line into NaN. Signal tests now
wait for the exact running receipt; reap uses a complete SPAWNED=<pid> line.
Reason for test changes: the captured baseline contains the registration log
as the actual readiness value; it is not a PID or a run-state receipt. Runtime
logging is valid, and killing before readiness does not test host cleanup.
Focused validation: all three signal and all four reap tests passed, without
suppressing Node's experimental Web Storage warning. No missing reaping support
or /proc access prevented these cases; no skip or environment workaround added.

First full coverage run: 1,299 passed / 11 skipped, zero failures/errors, but
coverage 99.9% statements, 99.85% branches, 99.86% functions, 99.93% lines.
Two additional source issues surfaced after the failures cleared:
- Seatbelt's public Plan.readDenies renderer lacked an explicit nonempty-plan
  assertion. Added a foreign-platform rendering test on Linux.
- ProcessConfinement retained a file-to-parent widening guard after
  ProcessSandbox.plan stopped widening directory writes. plan now refuses an
  existing file before returning (ProcessSandbox.ts directory-write loop), and
  confinement never passes writeFiles. The guard was unreachable migration
  residue. Removed it; the real-filesystem existing-file refusal assertion
  remains the behavioral security contract. No coverage ignore or threshold
  change is used.

A subsequent full run exposed an independent Linux product bug: the real
ProcSnapshot group read returned unavailable during process churn (1 failed /
1,299 passed / 11 skipped). A 200-scan diagnostic recorded 11,087 ENOENT and
4 ESRCH reads, and no malformed stat lines. The reader recognized only ENOENT.
Regression first: retain a real child proc-stat descriptor through child exit,
then read its inode via /proc/self/fd; Linux returns ESRCH deterministically.
Snapshot must skip that dead pid; startedAtMs must report gone. Before: 17 passed
/ 1 failed. After accepting ESRCH as gone: 18 passed. Other errors continue to
fail closed. No fake filesystem or syscall mock. This is a product fix, not a
host gap, and requires no Latitude runner modification.

Final proof: Latitude nyc-01 slot 4, Linux Node v26.5.0, full
`pnpm coverage run`: 74 files passed / 2 skipped; 1,301 tests passed / 11
existing skips, zero errors. Statements, branches, functions and lines: 100%.
Exit 0, 77.9 seconds including sync. No threshold changes or additional skips.
The last missing branch was the optional realpath fallback for declared reads;
the existing real-filesystem linked-workspace test now asserts that fallback's
exact read/write grants. Four added cases overall.

Latitude checks: package typecheck passed; changed-production-file ESLint and
changed-test/source dprint checks passed. Full source ESLint separately reports
two pre-existing no-unnecessary-type-assertion errors in EgressHttpClient.ts
(lines 236 and 265), untouched by this work.

Astra source review: no actionable findings, including follow-up ESRCH fix.
Fable review of the described changes: no actionable findings, including ESRCH.
No Latitude environment change was needed. Web Storage warnings remained enabled
during the green proof; readiness parsing no longer confuses logs with receipts.
No dependency installation, tests, typechecks or lint ran on the MacBook. No push.
Full report and proof logs: ~/smithers-builders/platform-node-reds-REPORT.md and
~/smithers-builders/platform-node-reds-final.log.

---
title: Landing target index escapes reserved farm capacity
status: blocked
area: tooling
owner: Codex GPT-6.1 Sol
updated: 2026-11-02
links:
  - ../../../../.smithers/flows/land/workspace.mjs
---

Mini admission never waits for a slot. Exit 7 or a failed CAPACITY_TIMEOUT
routes generation and drift checking to cfbox with the same validated receipt.
Remote preparation and tests run outside main-push.lock; publication re-fetches
main and refuses a changed base or source. The caller must sync and validate
again; no stale result is pushed. Cloud bootstrap uses the existing CI gate,
which installs pinned Node and pnpm. No Mac install or Git CLI is used.

The native smithers-jj-export helper is not needed: TargetIndex delegates to
GeneratedFile write/check actions, and build-cli's noninteractive host uses
NodeFileSystem. Its testCoverage prerequisite inventories declarations. None
acquires the confined AtomicFileSystem service or exports a jj workspace.
A live cfbox run with SMITHERS_WORKSPACE_JJ_EXPORT_BINARY=/no-native-helper
passed generation, drift checking, and receipt publication (exit 0).

Validation: fake-mini regressions failed first (exit 7, timeout markers, and
admission bound); the lock regression failed because mini held the push lock.
The six bootstrap suites then passed all 45 tests, covering real jj local
remotes, concurrent publication, cancellation, stale validation, and cleanup.
Home-network direct uploads failed TLS; cfbox's configurable upload relay
completed the live verification. Deployment-specific relay settings stay out
of the repository.
The final landing uses a 2-vCPU (8 GiB) box: the 4-vCPU tier reported capacity
exhaustion while a real 2-vCPU admission probe started in two seconds.
The final 2-vCPU run passed generate/check and receipt publication with CI=true
and the native helper configured to a nonexistent path. All 45 bootstrap tests
passed again. Publication is blocked by other live owners of the shared landing
lock; repeated bounded land attempts stopped without removing their locks.

Catalog entry: repository chores in `.smithers/flows`; this remains the
source-only bootstrap helper described in the maintenance skill, without an
installed SDK requirement on the Mac.

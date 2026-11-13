---
title: Release pg admission after gate clients exit
status: in-progress
area: tooling
owner: Codex (pg stop recovery hotfix)
updated: 2026-11-05
links:
  - ../../../../.smithers/flows/land/affected.mjs
  - ../../../../.smithers/flows/land/lock.mjs
---

Tests first: incomplete and interrupted gates release after their local clients
exit; dead local owners with dead recorded clients are reclaimed. Live owners
and surviving clients retain exclusion. Compare recorded process start times
when available. Remote boxes retain their own lifetime.

Catalog entry: repository chores in `.smithers/flows`; keep the existing
source-only bootstrap, with no new library or runtime. Investigate farm exit 5
and sibling cancellation without expanding the hotfix. Run the land suite on
nyc-01, describe the commit, and run one requested review, retrying capacity
only. Stop on any new review finding. No push or land is authorized.

Client close now records completion or stop even on failure and interruption.
Pre-launch interruption also records stop. The gate writes the stop receipt
before releasing. Same-host recovery verifies owner and client process identity,
records stop and logs its proof; live owners and clients, remote hosts and
unknown identity retain exclusion. The superseded remote-termination parser is
removed; completed execution evidence still requires the existing farm receipts.

Tests first on nyc-01: two client-exit regressions and two PID-reuse regressions
fail on the old code; killed-owner recovery times out. Pre-launch cancellation
also fails before its fix. The focused nine-case run passes after correcting a
fixture's race with PID persistence. All 56 land source hashes match the remote
tree. Node 26.5.0 and jj 0.45.1 run the real fixture repositories.

The full land glob executes 515 tests: 505 pass, nine setup failures, one
macOS-only skip. Five setup failures came from a runner-wide review-directory
override; four came from missing Go/ShellCheck and locale ordering. After
correcting only the runner, all 61 commit cases and all 43 farm/lane cases pass.
Combined final evidence covers 514 passing tests, zero remaining failures and
one platform skip. An earlier relative-loader attempt is invalid, not passing
evidence. Logs and the requested review receipt stay in private runner storage.

Farm diagnosis: the active client installation uploads an old service helper
that reuses stale OCI container state. The repository's stable private runtime
is already implemented; the active installation needs refreshing. No host reset
or service-runtime change is part of this patch. An incomplete non-box result
also cancels the shared box client and skips later batches, losing potential
unfinished evidence. That behavior is reported only, unchanged.

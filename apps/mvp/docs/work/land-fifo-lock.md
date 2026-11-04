---
title: Serialize land validation with a bounded FIFO lease
status: completed
area: devx
owner: codex-landlock-finish
updated: 2026-11-04
links: [../../../../docs/devx/parallel-agents.md]
---

Tests first: queue before sync and validation, recover dead or expired holders,
and fence publication after lease loss. Preserve the legacy mkdir push lock.
Use the library catalog's bootstrap `land` module; this change keeps its
bootstrap recovery path without an SDK install. Atomic legacy acquisition uses
Python 3's standard-library FFI because Node cannot exclusively rename a
prepared owner directory without overwriting an empty legacy mkdir lock.
No npm dependency or native build is needed; unsupported hosts fail closed.
Commit and review locally; do not land or push.

Local Node evidence (2026-11-04): the 14-case regression suite against the
original modules fails 13 cases, including a second land publishing during
another land's validation. The final FIFO suite passes all 15 cases, including
an actual land expired immediately before publication. Four focused workspace
cases and 14 process/files/projection cases pass. Twelve crash/recovery cases pass,
including atomic decision contention, interrupted cleanup, heartbeat startup,
orphan publication, publication cancellation, acquisition death, remote stop
proof, exclusive rename over an existing empty legacy lock, and a delayed
acquisition helper whose prepared source has been retired. The second
review's acquisition and remote regressions fail before the fix, as does the
outside-pusher retry regression on Latitude. The issue-sweep integration
suite passes all nine cases using real jj fixture repositories on Latitude.
The legacy-lock regression awaits the asynchronous release before inspecting
exclusion. Existing Git-backed and
workspace-creating suites are not executed on this Mac under this request.
The real-repository test's runner bound is three minutes under local load;
product stale and maximum-hold bounds are unchanged.

The first Astra review found five defects; the final revision addresses each
with the shared lease, atomic decisions and cleanup, independent publication
supervision and bounded heartbeat startup. Review uses the default reviews
store and the codex-6 home. Its second review found acquisition, remote
termination and single-use retry defects; these have regression tests and fixes.
The third review found a delayed initializer racing retirement before `done`.
Its event-driven regression fails before the fix. Initialization now atomically
publishes its complete source and owner against retirement's immutable claim;
cleanup cannot finish while a new acquisition source can still appear.
An orphan-publication run also exposed a process probe race: macOS `ps` can
return only `(node)` while a leader exits but its child remains alive. The old
probe mistook this for PID reuse and recorded termination. Diagnostics reproduced
the process-name-only result, and a pure observation regression fails before
the fix. Missing arguments or group observations now retain exclusion; probe
records and termination receipts identify the proof and producer without argv.
The supervisor closes its own launcher's IPC endpoint to trigger self-termination.
The fourth review identified failed argv probes becoming `undefined` and skipping
the identity check. Its added pure regression fails before the fix; every
observed live leader now requires its token, including failed/absent argv.
An absent leader with live children remains a live group requiring termination.

The follow-up first rebases onto `169fa459c9d3` and preserves main's disk-full and
cfbox fallback behavior while requiring the FIFO lease during validation.
The new injected-clock regression, "default admission keeps ticket two through
six minutes of healthy validation and publication", first failed with ticket 2
at position 2 timing out. It now passes through fenced publication with the
original ticket. `defaultLockTimeoutMs` exports one hour from `lock.mjs`, used
by both admission call sites; explicit timeout overrides still apply.
Follow-up cfbox evidence (2026-11-04): every land test file, including nested
farm and flow suites, plus issue-sweep's `land-queue.test.ts`, was submitted on
the change and `main@origin`. There are no added failing names. Both revisions
fail "a null receipt or a rollout that can't be parsed refuses a normal land;
the override still works": root can still read a mode-000 rollout, so the
permission-error assertion fails. The live-mini suite is **not run** (no host).
Three review permission cases are **not run** under root: the append-only inbox,
unwritable store root, and unreadable store cases. Main has no `lock.test.mjs`
or `lock-recovery.test.mjs`; the change passes all 16 and 15 cases respectively.
The aggregate flow, workspace, typecheck and all nine issue-sweep queue cases pass.

The first cfbox image lacked ShellCheck and the transport version jj needs.
Corrected-toolchain runs install those prerequisites inside cfbox. One baseline
stream ended during installation before tests; that attempt is **not run**.
Ten-minute runners stopped the commit suites without results; those attempts
are **not run**. Separate thirty-minute runs pass all 58 commit cases on both
revisions. The candidate's uninstrumented run took 1,182 seconds. A further
candidate run with bounded fixture commands and opt-in progress passes all 58
in 408 seconds, without a command timeout. Fixture commands now have a three-minute
bound and `SMITHERS_LAND_TEST_PROGRESS` records command number, tool, status and
elapsed time, never arguments or environment values. These timings describe
these runs, not a benchmark or an explanation of the runtime variation.

Sources were staged from `jj file list` only, without VCS metadata or secrets,
under the requested disposable `landlock/tree`, then deleted after upload.
No builds or pnpm ran on the Mac. Exact commands, per-suite failing names,
skips and the comparison are retained in the private landlock runner logs.
Review uses `review.mjs`, the codex-6 home and the default receipt store.
Main advanced during the run. The final baseline suites used `2a89eb62a5fc`;
the change was then rebased onto that head without conflicts. Only upstream app
checks and pull-review files changed; all land and issue-sweep source and tests
retain their tested bytes. Their suites ran before this final rebase; the real
app typecheck probes also passed on the new baseline. No land or push is authorized.

The follow-up Astra review found a suspended supervisor preventing publication
settlement, recovery fixtures depending on another suite's parent directory,
and a stale five-minute default in the maintenance skill. The deadline and
cancellation regressions both fail before the supervisor fix; a fresh-home
standalone fixture fails with `ENOENT`. All now pass. A third regression proves
unconfirmed termination returns an error while retaining the ticket and legacy
exclusion. Stop-request records contain controlled reason codes and process
metadata only. The recovery fixture owns its temporary directory. The full corrected candidate
rerun completes all 19 test-file entries in cfbox without a runner timeout;
its 15 recovery cases run with an independent fresh home. Commit's 58 cases,
flow's 100 cases, workspace's 16 cases, typecheck's 19 cases and issue-sweep's
nine queue cases pass. The failing-name comparison still has no added failures;
the shared unreadable-rollout failure and four not-run cases/suites above remain.
The staged revision is recorded outside the tree before dispatch and the tree
is deleted after upload. A new default-store Astra review is required for the amended
change; no land or push is authorized.

Integration with ptmloxru is handled after this lands, by the land-gate lane.

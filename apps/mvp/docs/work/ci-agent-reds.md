---
title: Repair assigned CLI, agent, control, gateway and Electric CI targets
status: blocked
area: sdk
owner: ci-agent
updated: 2026-10-31
links:
  - https://github.com/smithersai/smithers/actions/runs/40929998769
---

Not ready to land. The last complete integrated run passes five of seven assigned
targets. CLI and agent still need complete green receipts. The latest journal
candidate has focused assertion coverage only; its complete package gate and the
required final read-only review are pending. No timeout, coverage floor or
known-red entry was widened.

Libraries used: CLI, agent, model-host, control, gateway, effect-electric,
build-cli, flow, harness, database, journal, run-store and engine-store from
`docs/libraries.md`. Existing SDK services remain the dependency seams.

## Current receipts

- Control: passed, 152.8 seconds.
- Gateway: passed, 38.7 seconds, including committed grants and unreadable selectors.
- Model host: passed, 25.4 seconds.
- Harbor offline: passed, 29.0 seconds.
- Electric: passed, 69.1 seconds with fresh real Compose dependencies.
- CLI: failed, 1963.9 seconds. README, silent SSH and live-child startup failed.
- Agent: failed its unchanged 1200-second target limit; its stderr also records
  three 30-second tweet failures.

These integrated receipts precede the latest journal and test-harness changes.
They do not prove those changes pass the complete targets.

Three agent workers complete the full queue in 758.4 seconds on four CPUs, but
that run still has two tweet failures. A real worker CPU profile records 13.2
seconds of sampled self time in the journal credential-URL regex. The candidate
checks its two mandatory literal markers before scanning, preserving the exact
regex, replacement and custom same-id rules. All 373 focused redaction assertions
and all 24 focused agent assertions pass. The paired old-code agent run also
passes; the profile is diagnostic evidence, not a portable benchmark or proof
that the complete agent target is fixed. The original test clock is unchanged.

The latest four-CPU mixed CLI probe passes four files and 58 assertions. The
remaining failure is the independent SSH login/execution/TUI journey exceeding
its original 30-second case limit. Its three child CLIs now receive the shared
run-owned compile cache; that handoff alone does not resolve this loaded case.
The real silent-handshake case passes its original watchdog and verifies its
actual Node child cache. Its raw-environment negative control fails that check.
README assertions now follow the required SQL dependency contract introduced by
`ad31a575b6a2`. The live-run case passes with bounded success/failure phase
receipts and fixed operation names; its original live-child limit remains.

## Completed repairs retained in the stack

CLI children preserve the run-owned compile cache without enabling caches in
measured V8 workers or overriding explicit opt-outs. One coordinator preserves
the complete inventory and schedules slow process suites before ordinary units.
Native bootstrap remains restricted to non-persistent environment CRUD; durable
commands keep the established compiler and persisted callback identity. Real
retained-fork tests reject the former `plan_changed` behavior. Public type checks
use the required native compiler; Bash controls stop at the actual startup
boundary. Compiler preloads exclude the compiler itself. Canonical-spelling
scans retain all recorded sites while avoiding irrelevant parsing.

Follow readers drain through committed control status and detect a positively
dead same-host writer. Real SQLite process-death regressions cover terminal
outcomes and ownership. Materialization shares its memo map, and health teardown
closes probes before discovery unregisters. Agent admission preserves durable
delegation sequence. Gateway grants survive unversioned observations and reject
unreadable selectors safely. Harbor accepts curl transport failures only with
an explicit proxy denial. Electric cannot silently skip unavailable dependencies.

The engine-store timer reads time inside the sleeping fiber. Its SQLite old-code
counterexample finishes at 6000 ms for a 3000 ms wake; the correction finishes at
3000 ms. The complete SQLite/PostgreSQL matrix passed before the latest journal
candidate. This is not a proven explanation for every loaded tweet timeout.

## Remaining work

Diagnose the slow SSH login/TUI journey without moving its deadline. Then rerun
all seven exact CI targets and the complete journal check/test matrix. Complete
the bounded final read-only review and address its findings before landing.
Earlier Sol reviews found an orphaned follow-reader; its process-death regression
and fix are retained. The latest journal candidate has not received that review.

An additional, unowned build-cli run reaches all 158 files but fails the real
workspace-catalog discovery child at its existing 30-second limit. Its receipt
is retained for the CI lead; no current full build-cli pass is claimed. An older
empty-document source-snapshot failure has not recurred and its cause remains
unconfirmed. Generated target indexes and documentation projections remain the
lander's responsibility under the builder contract.

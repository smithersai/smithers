---
title: Bound hosted package CI with measured shards
status: blocked
area: sdk
owner: Codex ci-shard
updated: 2026-10-30
links: [../../../../packages/repo-targets/README.md, ci-repository-contracts.md]
---

Split the package and workspace gates through GithubCiGen, retaining coverage,
known-red policy, platform advisory status and per-target result artifacts.
Use the library catalog's `@smthrs/targets`, `@smthrs/build-cli` and private
`@smthrs/repo-targets`.
Timing inputs are hosted run 40929998769's workspace results and run
41088937554's Linux/macOS package logs. Hosted wall time still needs a hosted run.

The timing record retains completed observations and elapsed lower bounds for
cancelled targets. Eight bins carry 30.5–30.9 measured target-minutes, with two
execution slots each. Coverage, known-red policy and advisory platform rows stay
in force; selection ownership is disjoint while prerequisites may repeat.

The real planner exposed that `//package` names its default target. The SDK now
supports the nonrecursive `//package:*` wildcard with the existing manual,
exclusive and host omission rules. Regression tests cover omitted manual work,
exclusive opt-in, platform filtering, public routing and unchanged defaults.
CI inventory plans every emitted command through the real CLI, compares both
lanes against independently enumerated eligible declarations, and records
individual selection failures immediately. Ownership checks avoid rebuilding
the aggregate DAG solely to obtain its root list.

The broader release contract still read the global banner deleted by
`c95d756e`. Remove those obsolete assertions while retaining the live CLI
installation checks; this is a separate root cause and commit.

Validation receipts: all 117 GithubCiGen tests pass within the full targets
suite (2,826 passing, three existing skips); repo-targets passes 194 tests at
100% coverage. CI, release and evidence contracts and both generated-workflow
drift gates pass. The real CI inventory passes all 21 tests, resolving 74
commands and verifying unique ownership of 545 workspace roots and 224 package
test roots.

The generated `packages-2` command completed with 28 targets run and three
failed. Its database integration dependency rejects connections, calibration
tests require repository metadata absent from the test mirror, and one CLI
catalog-discovery subprocess reached its existing 30-second bound. The same
public CLI discovery command subsequently passed within that unchanged bound.
The full CLI suite recorded 2,607 passing cases, one failure and six existing
skips in that initial run; it is not a green full-shard receipt. The final repo-targets rerun,
including the separate test-cost balance regression, retains 100% coverage.
No tests, thresholds, known-red entries or existing deadlines were relaxed.
A green full-shard receipt remains blocked on these validation requirements;
hosted setup and wall time still require a hosted run.

The requested read-only Codex Sol review found an earlier `affected` filter
still treating the package wildcard as a named target. Both affected-selection
filters now share `Label.isWildcard`; ten real CLI cases fail before the fix
and pass after it, covering listing, execution, manual and other-host omissions,
and exclusive opt-in. An audit of the remaining label consumers also fixed
trusted-review policy selection: its regression preserves package scope,
explicit manual selection and rejection of recursive `:*` patterns.

The final CLI suite passes all 148 files and 2,619 tests, with six existing
skips and its unchanged coverage gates. The final generator-library suite
passes all 131 files and 2,826 tests, with three existing skips. Both workflow
drift checks executed fresh and passed after these fixes. These later receipts
supersede the CLI timeout for the owned SDK work; they do not turn the earlier
full-shard receipt green or verify hosted wall time.

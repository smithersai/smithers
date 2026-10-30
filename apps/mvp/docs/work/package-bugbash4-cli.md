---
title: Package bug bash round 4 CLI fixes
status: blocked
area: sdk
owner: bb6-cov4
updated: 2026-10-30
links: []
---

Confirmed findings: memory-eval 1, 2, 4, 5, 9; mcp 2, 4, 5, 6; local-cli 4, 9, 11.
Catalog entries: @smthrs/cli, @smthrs/memory, @smthrs/evals, @smthrs/build-cli.
Reproduce on Latitude before fixing; one commit per finding, with the three memory help omissions grouped.
W13 bb3-cli and W14 bb5-cli-docs reports contain no fixes for these findings. The concurrent reference and scaffold workstreams own other CLI docs and generators.
Filegroup remains cacheable as specified by the existing caching contract; execution must read and store its successful result.

Follow-up: cover W15's missed MCP lifetime, declaration-read and owner-path
branches through the public CLI boundaries, including subprocess lifetime receipts.

All confirmed behaviors have source fixes and regressions. The memory store
adds an atomic timestamp-defaulting append while preserving the explicit-time
API. MCP syntax handling ships in the CLI through Incur's public stdio input
seam; no workspace-only dependency patch is required.

Latitude: both storage backends pass the memory suite and its merged coverage
gate. Compilers, import rules and lint pass. Focused runs pass 150 CLI tests,
50 build tests, and a final seven MCP tests including help-flag precedence.
The new MCP framing module reaches 100% coverage in all four metrics. Other
changed modules still miss the requested 100% changed-file coverage.

The full build suite has 18 failures reproduced with the original changed
sources. Two additional failures passed on rerun; the corrected owner-path
cases retain legacy relative-path diagnostics.

The root docs commands timed out without completion receipts (both exit 124).
Content generation, package-owned tarball checks and API projection checks pass
separately; the durable entrypoint remains a validation blocker.
Codex Astra's findings (release packaging and overlapping retries) were fixed
and re-reviewed with no further findings. Fable review is unavailable.

W15 coverage follow-up complete: 73 focused CLI tests and 30 owner-command
tests pass on Latitude. The diff audit against `936ff90497e2` covers every
changed executable line, statement, branch and function in `Cli.ts`,
`cli/McpStdio.ts`, `operator/Triggers.ts` and build-cli's `Owners.ts` (100%).
MCP hosts supply real streams through an Effect transport service; tests cover
framing, EOF, read failure, abort, pre-abort, no signal, tool middleware and
help/update precedence, with separate CLI child-process receipts. Trigger
input tests exercise a real symlink loop; the redundant undefined-code fallback
is removed. Owner-command tests retain relative-path refusal diagnostics.
Both package typechecks and lints, plus CLI and agent import rules, pass.
Coverage thresholds are unchanged. The focused CLI run remains below its
package-wide thresholds; no full-suite gate is claimed. The earlier full-suite
and docs-entrypoint blockers above are outside this follow-up.

W16 follow-up: compare unchanged main and rebased build-cli coverage file by
file on Latitude, cover reachable gaps through the build CLI, and retain all
earlier fixes and tests. No push or deployment.

The file comparison identifies `PackageRunner.ts:2156`: Filegroup previously
fell through to Cargo.AppSet's return, so its new cache dispatch left that
existing line uncovered. Every added Filegroup line was already covered.
`ValueTargetsCli.test.ts` exercises AppSet twice with no Cargo on PATH, and
Filegroup cache hits, member edits and `--no-cache`, through the public CLI.
The package now declares `importRules` for the cache regressions' no-mock and
no-fixed-sleep contract, using the catalog's `@smthrs/repo-targets` macro;
the behavioral fixtures use `@smthrs/targets` and `@smthrs/build-cli`.

Dependency fingerprint failures during validation came from shared pnpm-store
inodes changing metadata while being opened. The reserved validation slot uses
private dependency inodes with identical sampled content hashes. Production
filesystem guards and the coverage configuration are unchanged. Target-index
regeneration remains with the lander, as the builder handoff requires.

W16 coverage follow-up is complete on unchanged main `0452688f`. The full
package run passes 2,538 tests with the same 18 baseline failures and 16 skips.
S/B/F/L moves from 91.42/84.09/93.48/93.74 to 91.43/84.11/93.48/93.75;
all exact covered/total ratios are at least main, and no previously covered
line becomes uncovered. AppSet's return now executes twice. Both package
typechecks and lints, all three package import-rule targets, and 12 MCP/skill
rebase regressions pass. The repository-wide dependency-boundary check has
eight unrelated manifest errors. The earlier documentation and baseline-suite
blockers remain outside this completed follow-up.

Coverage completion: bb6-cov4 owns the remaining PackageRunner and Evaluation
gaps. Behavioral tests use real tools and injected Effect fault services.
Coverage floors and exclusions stay unchanged; Latitude runs remain serial.

The coverage follow-up repairs scratch-tree sandbox preparation and shares it
with native target bodies. Result-cache mounts stay sealed; dependency links
are granted only to installed `node_modules` roots. Existing generator, agent,
overlay and commit-gate regressions exercise the repair.

Faults are scoped through invocation-local Effect services. Evaluation accepts
a scoped durable store layer; its attempt-store refusal test resumes the same
run identity without publishing an incomplete artifact.

Removed dead code: 32 failure-message fallbacks now ruled out by the
`ExecOutcome` union, success after a service waits on `Effect.never`, and
non-vacuous PR success logging in a host with no PR opener. PR refusal and
vacuous agent execution remain exercised. No coverage floor or exclusion changed.

An escaped overlay build previously cached and published its products before
portal validation. A real symlink regression reproduced a false cache hit on
the second invocation; publication now waits for successful validation.

Further dead branches removed: a sandbox plan cannot be absent after the same
request selects an enforceable mechanism; a successful process always has stdout;
a successful CI write always has its renderer report; splitting a commit message
always produces its first string. No racy filesystem refusal is removed.

A previously matching submodule plan could return a cache hit after the actual
checkout changed. A real two-revision fixture reproduces the false hit. The
executor now verifies the current checkout before either matching fast path.
Invalid restored trees are removed and checked out at the pinned revision.

The runner passes explicit agent data labels to its data helper, uses a detailed
red-gate type, and removes fallback lookups for a closed candidate identity map.
Direct services have no success outcome: their never-ending foreground body now
maps failure directly without an unreachable successful Exit branch.

The sandbox planner guarantees all returned writable mounts remain under its
canonical workspace; the coordinator's second outside-path filter was dead.
CI-rendered files always live under workflow or setup directories, so its
root-directory fallback was dead. Declared output helpers now require their
already-validated output contract explicitly.

The CLI package declares Node/V8 Vitest runs, with no package Bun coverage
suite. Its Bun-only host-selection arm is retained and reported separately;
no platform is simulated and no coverage exclusion is added.

Two more dead fallbacks are removed: owner-file plans always carry their emit
entries, and a vacuous lint report always carries the agent runtime's note.
The dependency-read regression also verifies that an undeclared external
`node_modules` link is refused rather than admitted by its basename alone.

The check/write outcome handling for Shell.Diff, Go.Lint and Go.Generate now
shares one Effect continuation. Both outcomes are behaviorally asserted; the
previous generator guards produced negative V8 branch counts despite executed
success paths. The planner-cache fault now reaches a consumer's closure lookup
and verifies its quiet approval recheck.

Build-cli's pre-review full-package receipt measures PackageRunner and Owners at
100% statements, branches, functions and lines. Check, lint and import rules
pass. The suite has 2,830 passing tests, six existing skips, and three failures:
two Docker host session-keyring refusals and the unchanged Cli.ts raw-error
count (19 sites on both the stack parent and base main revision 1e55f8b9,
against the test's 18).

The pre-review CLI full-package run has 5,716 passing tests, seven failed tests,
38 existing skips and three expected failures. Six failures hit existing
time limits; the remaining failure and a suite-setup failure cannot create a
Docker session keyring. Disk and inode capacity remained available. Check,
lint and CLI/agent import rules pass. Cli, ControlBridge, McpStdio, HostService,
Memory and Triggers measure 100% throughout. Evaluation measures
100/99.04/100/100; its only missing branch is the real Bun host selection.
The full gates remain blocked; the source coverage work does not establish
the cause of the CLI timeouts.

The requested Sol review found three issues: runtime installation-link grants,
dirty submodule restoration, and candidate composition hoisting checks before
the candidate existed. Their regressions failed before the fixes. Planning now
binds installation roots, checkout preflight preserves local changes, and
composition traversal hoists only leaf-check prerequisites. The real composed
plan is tested without rewriting its dependencies or work list.

The planner fix also repairs rejected one-shot commands dropping their only
argument and crashing before reporting their refusal. The planner's changed-file
coverage is now part of this follow-up's gate. Scoped Effect manifest-read
services exercise a crate disappearing after input admission. Host selection
and Bun lookup honor the plan's selected platform and environment.

Additional redundant planner paths removed: re-decoding validated closure
entries, a second bundler graph-kind check, repeated manager absence,
and defensive cache read/close catches around the cache's own fail-closed I/O.
Dependency labels are resolved through the planner's canonical label memo
instead of repeating a fallback map lookup. Final post-review receipts are recorded below; the earlier gates do not
stand for the subsequent changes.

The full post-review build run covers all 1,893 runner statements, 1,117
branches and 447 functions, and all 1,621 planner statements and 142
functions. Planner branches have two remaining reported gaps: an impossible
missing service node after its dependency visit, and a V8 counter of -1 on
a successfully exercised submodule outcome. The former guard is removed;
the latter outcome now enters a synchronous optional-refusal helper, with
the present/absent branch retained. The full validation is repeated.

Other dead planner checks removed: a missing execution-edge node after the
complete graph walk, missing documentation dependencies/expanded inputs after
that same walk, a duplicate path in a manifest keyed by unique paths, and an
agent payload failure outside its decoder's sole typed error. The raw-error
ratchet tightens from 17 planner sites to 14 after three deleted throws.
Unsupported pre-resolved runtime requirements retain their refusal and have
a regression; they can bypass manifest requirement validation.

Planner boundary tests run a real Nix derivation and its shell, real Go and
Rust tools, both malformed and valid persisted graph rows, and a Git patch
above 256 MiB split across real argument batches. No execution service is
replaced with a successful canned result.

A relative SDK-root guard is retained: Go permits relative GOROOT values.
Its real-tool regression supplies a relative path resolving to the installed
SDK and verifies that it adds no relative external-read authority.

Final build validation includes the retained relative-SDK guard: Runner has
1,893/1,893 statements, 1,117/1,117 branches, 447/447 functions and
1,538/1,538 lines. Planner has 1,622/1,622 statements, 1,297/1,297
branches, 142/142 functions and 1,425/1,425 lines. Owners is also 100%
in every metric. Check, lint and import rules pass. The full suite has
3,002 passes, six existing skips and three failures: two Docker session-key
creation failures and the unchanged build CLI raw-error count of 19 versus
18. The Docker account's kernel key quota is exhausted; disk and inode
capacity stayed available. The final CLI receipt follows.

Final CLI validation: check, lint and CLI/agent import rules pass. The full
suite has 5,717 passes, six failed tests, three expected failures and 38
existing skips, plus one failed-suite setup. Cli, ControlBridge, McpStdio,
HostService, Memory and Triggers are 100% in all four coverage metrics.
Evaluation is 176/176 statements, 104/105 branches, 35/35 functions and
162/162 lines; its sole missing branch is Bun host selection. This package
has runtime compatibility tests but no Bun coverage run. The branch remains.

The two Docker failures are session-key creation failures. Four other cases
time out: follow-logs, PostgreSQL history verification, SSH quickstart, and
Node TUI approval modes. Parked-exit returns 1 after approval instead of 0.
Those five CLI causes are not established by this coverage work. No coverage
threshold, exclusion or skip was changed. No run-owned process survived the
final CLI scope, and sampled disk/inode capacity stayed available.

One requested read-only Sol review found three issues, all fixed with
red-before-fix regressions and subsequent full-package coverage receipts:
plan-bound installation authority, preservation of dirty submodule paths,
and candidate checks composed through aliases and suites. The coverage work
is complete with the documented Bun-only exception; full gates remain red.

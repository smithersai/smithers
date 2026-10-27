---
title: Package bug bash round 4 CLI fixes
status: blocked
area: sdk
owner: bb6-cli3
updated: 2026-10-27
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

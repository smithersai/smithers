---
title: Bug bash round 4 documentation
status: in-progress
area: docs
owner: bb4-docs
updated: 2026-10-27
links: []
---

Confirmed CLI reference, flow instructions, missing guides, phone layout and
published-package mismatches. One commit per distinct fix; overlapping IDs
share the same fix. W12 bb2-docs edits nearby flow prose but retains the absent
slash commands. Validation runs on Latitude; deployment belongs to the lander.

Catalog entries: @smthrs/cli and build-cli for command declarations;
@smthrs/testing for BuiltinScript; @smthrs/platform-node for the durable host;
@smthrs/ui and ui-styleguide for documentation styling.

Validation: documentation sync and check completed on Latitude, with 51
published package tarballs passing. All app compiler/import/lint checks passed.
The site builds 118 pages and its reference renderer has 100% line, branch
and function coverage. The capture script's direct measurement is 91.10% lines,
74.51% branches and 88.89% functions; its strict 100% gate is red. The optional
host ports have 100% coverage in all four metrics. All 308 focused CLI behavioral assertions pass; the strict 100% gate
for Cli.ts and Commands.ts remains red. No coverage threshold was changed.

The full CLI run passed 5,563 tests and failed six. The two packaged-skill
failures were corrected and their three assertions pass on rerun. The remaining
SeatResolution and HostEvaluator failures reproduce with the original CLI
source (three failed, 130 passed, one skipped). HistoryVerify's PostgreSQL
timeout passed on both comparison runs. These are not a green full-suite receipt.

The full site test command records 119 passes, one failure and the known npm
consumer TODO. Its unchanged hostname-ownership assertion requires literals at
apps/mvp/alchemy.run.ts:96, where the app uses Effect configuration. This baseline
assertion needs an infrastructure-testing change. The real CLI capture tests,
including write/check behavior in temporary directories, pass without service
mocks. Both flows and platform-cloudflare import-rule targets pass. The final target
index regeneration and all seven documentation projection/drift checks pass.

The separate CLI-types note records se4-npm-4 and its decision. Deployment
specs are committed, pending the lander: no push or deployment was authorized,
and the Mac mini was unreachable. No changed-build browser or GIF proof is claimed.

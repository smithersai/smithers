---
title: Package bug bash round 3 CLI and build fixes
status: done
area: sdk
owner: bb3-cli2
updated: 2026-10-27
links: []
---

Fix confirmed build-3, build-4, cli-1, cli-3, misc-1, misc-3, misc-4,
docsnippets-1 and docsnippets-2 with red-first regressions and Latitude proof.
Library catalog: @smthrs/build-cli, @smthrs/cli, @smthrs/migrate,
@smthrs/model, @smthrs/std, @smthrs/control and @smthrs/platform-node.

## Open decisions

- build-4 settled by the lead: zero exit with missing declared outputs fails,
  naming the target and every path. No syscall provenance or wider grants.
  The declaration API has no explicit empty-directory form; empty prepared
  output directories fail. Implemented in the shared tool execution boundary;
  old empty-directory build cache entries are misses. Decision recorded in
  build-cli's execution docs (the package has no decision-record directory).
- cli-1: the catalog advertises install plan and source operations without
  transport bindings. The durable Control API supports plan, but is not mounted
  by the install's Worker; source is not a Control operation. The source catalog
  says co-edit while the report asks for inspection. Await Will's source choice;
  then define and mount the authorized install transport, rather than claiming
  a guessed endpoint works. Binding regressions remain marked known broken.

## Validation receipts

Seven findings are fixed in separate commits with red-first regressions and
patch changesets. build-4 is fixed in the continuation; cli-1 is deferred by
the lead and remains unchanged.

Latitude model: 1,117 passed, 9 skipped; std: 1,484 passed, 3 skipped;
both report 100% coverage. Final migration: 927 passed, 11 skipped, configured
coverage gate passed (96.14% statements, 89.06% branches, 96.51% functions,
97.94% lines). Final sandbox file: 120 tests, 100% in all four coverage metrics;
its additional cases cover real filesystem fallback and portable refusal rules.
Six package typechecks and both available import-rule targets passed. Changed
files pass lint/format checks. Whole-package lint failures are in unchanged
model Pricing tests/API documentation and platform-node EgressHttpClient.

Full suites recorded 5,566 CLI, 2,528 build and 1,292 platform-node passes.
The five CLI and eighteen build failures reproduce on clean main; all nine
platform failures reproduce with the original production source. No clean
full-suite gate is claimed. Thresholds and production code inclusion are intact.

Both docs commands completed as durable runs; all 51 published package tarballs
passed. Generated site projections are left to the lander. Mini runs were
skipped as requested. Astra's initial and follow-up reviews found no issues;
Fable could not launch because the account rotator had no available account.
The report and retained validation logs accompany the builder bookmark.

## build-4 continuation proof

bb3-cli2 completed the lead's decision; cli-1 remains deferred and unchanged.
Latitude: typecheck, package lint and importRules pass. All five output
regressions fail with the original PackageRunner and pass with the fix,
including empty directories, multiple missing paths, zero-byte files and
rejection of a cached empty manifest. Docker push now checks that the build
fails and the dependent push is skipped; Go archive fault tests seed a
nonempty module cache before exercising their failure path.

The full build-cli suite ran with its unchanged coverage configuration and
failure reporting enabled: 2,533 passed, 16 skipped, 18 failed. The failure
names exactly match the retained clean-main baseline; no new failures.
Measured coverage: statements 91.43%, branches 84.10%, functions 93.56%,
lines 93.76%; all configured coverage floors passed. The suite remains red
on the existing failures; no green full-suite claim is made.

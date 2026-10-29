---
title: Restore repository contract CI
status: done
area: sdk
owner: Codex ci-repo
updated: 2026-10-29
links: [repo-checks-green.md, ../../../../packages/repo-targets/README.md]
---

Repair dependency boundaries, documentation drift, lockfile parity, package contracts,
public exports, repository conformance, runner contracts and the test pin register.
Trace each failure to main's history and validate the CI commands on Latitude.
Use the existing repository contracts and the library catalog's `@smthrs/targets` entry.

## Findings

- Dependency boundaries: decision-queue snapshots (`0c455cbe`, `e1efaba2`) are
  data; executable imports introduced by `f1a35425`, `5940dfe3` and `96628360`
  need runtime declarations. Preserve checks on executable neighboring sources.
- Drift: `75fa7022` and `96628360` added app-doc and CLI-reference generators
  without their root drift checks.
- Lockfile parity: `39ccbd83` moved VibeLang to 0.0.8 without refreshing Bun's
  0.0.3 workspace ranges; later dependency additions were absent too.
- Package contract: SDK-6 and `89f5937d` allow workspace references, resolved
  before isolated release staging; `6c82383c` pinned Bun types; `8c69f33c`
  removed private host adapters from the platform-neutral flows barrel.
- Public exports: record additions from `6f12723f`, `f37a6ffe`, `725922c4`,
  `718a04bd` and `c0b1b365` while retaining the original export history.
- Conformance: `04f89c41` split two private Bun UI packages; `0431fcc8`
  publishes to staging before promoting the completed release's tags.
  Keep code-storage's report directory in the checked naming convention,
  follow moved and deleted coverage-inventory entries, and record `7ce5c496`'s
  mount bootstrap in the existing native CLI tooling boundary.
  Remove `5940dfe3`'s forbidden presentation-install coverage range and measure
  installation in freezable V8 realms through Vitest's subprocess collector.
- Runner contract: the `82b5490d` fixture retained external tool symlinks
  under default confinement. Declare its execution-only purpose explicitly
  and keep the real cache-hit and assertion sentinels. The GitHub log refused
  a workspace read outside its declared root; Latitude additionally lacks
  bubblewrap. Neither failure reached the intended assertion.
- Test-pin register: record the existing writer/replay defects and optional
  source-inventory, latency and long-command proofs at their introducing commits.

## Validation

All eight owned CI targets, the dependency-boundary and lockfile-parity unit
targets, and conformance typechecking pass on Latitude with the workflow's
`smthrs ci` invocation and existing known-red policy. No owned failures are
waived. Views passes `vibelang --project tsconfig.test.json` and all 248 tests
with 100% statement, branch, function and line coverage, including installation
and renderer refusals. The Sol review found that a later load's fresh clock
deadline can expire after initial success. Removed that coverage exclusion and
covered the timeout, its propagation and the following render's recovery through
an injected Clock. Restoring the old exclusion fails conformance; the final
views and owned CI suites pass after the review fix. The declaration-derived target index matches the
committed projection.

The additional release-pack suite exposed two existing failures outside this
lane: `c95d756e` deleted the docs banner the test still reads; its VibeLang
artifact test assumes which of several missing files rejects first. Release
lane commits `4363ee93664c` and `3c166a0df0a8` overlap the banner and workspace
staging changes; reconcile the latter when landing the lanes together.

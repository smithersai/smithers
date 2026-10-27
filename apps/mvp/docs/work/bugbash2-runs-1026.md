---
title: Run inspection bug bash round two
status: in-review
area: runs
owner: Codex bb2-runs
updated: 2026-10-27
links: [../features/runs.md]
---

Production probes reproduced failed-step selection, hidden attempt reasons,
skipped/queued disagreement, CI cleanup duplicates, empty CI command records,
raw results and event names, table copy, signed-out cloud requests, and cold
repository history without a loading frame.

Fixed each behavior in its own change. CI command output is sealed per command,
bounded before inspection and kept out of diagnostic telemetry; historical
output discarded by the old adapter cannot be recovered. Ordinary repeated
steps remain distinct; only CI's unused alternative cleanup is collapsed.
The run-name link opens a page and the chevron expands details; those are two
intentional actions. Return navigation now remembers the personal Runs list.
A local run id from a fresh device correctly says On another device; W11 already
proved same-device navigation and closed stopped-step timers.

Catalog entries: Render UI/loading (`@smthrs/ui`), Show what a flow step logged
(`@smthrs/engine-store`, `@smthrs/ui`), existing CI jobs (`@smthrs/sandbox`) and
the gateway's recorded-journal projection. No new dependencies.

Latitude: app typecheck, import rules and lint pass. The focused app suite passes
215 tests, at 100% lines, functions, branches and statements for the six run logic
files, three list views, repository run screen and CI adapter. Full router and
RunPageView file coverage is not claimed. The UI suite passes 2,669 tests;
touched UI files have 100% lines/functions, and its typecheck/import rules pass.
The sandbox suite passes 869 tests with 31 declared skips, at 100% configured
coverage; typecheck, source lint and changed-file formatting pass. The package's
full formatting check also finds a pre-existing difference in
SandboxTools.test.ts; that unrelated file was left unchanged.

Replacing the implementation with the starting revision produces 10 app,
12 UI and 3 CI-result regression failures. Astra reviewed the changes, its two
findings were fixed with regressions, and follow-up review found no further
concrete bugs. Fable review remains with the lander.

After deployment, run runs-visitor.spec.ts and run-records.spec.ts. The repository
case needs a retained CI run visible to that account under the repository's real
authority; a Member role on the deployment grants no role elsewhere. Never widen
permissions for the fixture. Run a fresh CI on an authorized scratch branch named
bugbash3-bb2-runs-*: inspect stdout/stderr, truncation, a single cleanup node,
consistent state words and return navigation. Check a failed TODO opens on its
first failure with its recorded reasons. Regenerate SDK API/docs artifacts.
No deployment, new-build production E2E, mini run or GIF is claimed.

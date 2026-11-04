---
title: Run checkout flows and diagnose unavailable saved API origins
status: done
area: cli
owner: codex-cliorigin-security
updated: 2026-11-04
links: []
---

Diagnose the issuefile dry-run stall, document the source CLI and local run store,
and make unavailable saved origins actionable without exposing credentials.
No landing or push. Validation runs on cfbox through nyc-01.

Library catalog: retain the CLI host and existing @smthrs/control,
@smthrs/platform-node, @smthrs/targets services; no new library or runtime.

The global rc.16 binary was actually linked to another source checkout. Profiling
recorded 35,487 native helper launches while eagerly importing the catalog before
run admission. Flow start now eagerly loads the selected body, collaborators and
retained active bodies; measured unrelated bodies load on first use. Load stages
and counts are observable with --verbose. No source identity checks were relaxed.

The old GCP origin answers 502; current Cloudflare app origin is smithers.sh, but
no equivalent legacy Cloud API/cache endpoint was verified there (404). Cache
default/docs now match the current origin without claiming deployed caching.
Saved-origin 5xx/DNS errors name config and repair command. Local inspection uses
--root and bypasses saved install routing.

cfbox through nyc-01: checkout-flow CLI 9 tests; backend availability 6; backend
origin/refusal/CLI-refusal 72; registry executable/deferred 143; refresh 8 and
refresh safety 5; remote cache 24; targeted workspace 1. CLI and registry
typechecks pass. New regressions were observed failing before the fix. No full
coverage claim: these are focused suites. Original 168-row dry run began in about
16 seconds and continued child runs until a deliberate 180-second cutoff; not a
completed dry run and no real filing. No Mac installs/builds; no tokens copied.
Required Astra review is tracked separately in the review receipt. No land/push.

Astra follow-up: explicit request destinations now retain their provenance so
HTTP/DNS failures cannot suggest repairing an unrelated saved api_origin. Real
HTTP503 and DNS cases cover explicit precedence over saved config and environment.
Four explicit-origin regressions failed before and pass after; the combined
backend suites pass all 78 tests, and the CLI typecheck passes again.
A one-node synthetic dry run completed through the real issues/file-tree CLI
with filed:1, dryRun:true and no exceptions; it needed no credentials or HTTP.
Pagination retains configured provenance separately from its pinned destination.
Four real HTTP/DNS pagination regressions failed before and pass after, for both
saved settings and environment overrides. CLI typecheck passes after this fix.

Confinement follow-up (2026-11-04): all six pack symlink cases shared an eager
catalog shape assertion. The added unconditional `deferred: []` field changed
that public result. Discovery's `withinRoot` guards still precede directory
descent and entry metadata reads; no confinement check was moved into loading.
Preserve the original eager shape when `initialFlows` is omitted. Add a real
filesystem test with `initialFlows: []`, a safe deferred entry and an outside
`flow.ts` file symlink: discovery warns `outside_root`, the escaped entry is
absent, and no body is loaded or imported. Retain all three Debug progress logs
and the corrected CLI reference. Library catalog entry: `@smthrs/registry`.

Remote confinement receipts: cfbox via nyc-01 reproduced all six original
failures at the catalog equality assertion (`deferred: []` was the sole
difference); their discovery, warning, body refusal and no-import assertions
passed. After the fix, the full registry suite passes 1286/1286 across 43 files,
including all six cases, the never-loaded symlink test, and both
ExecutableDeferred tests. Supplied main baseline: 1283/1283; original change:
1279/1285. The new fixture initially omitted capabilities and produced an
extra metadata warning; it now declares `capabilities: []`. No tests were
weakened. All builds/installs/tests stayed on cfbox; no land or push.

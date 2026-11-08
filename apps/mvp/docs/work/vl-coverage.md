---
title: Measure and close VibeLang source coverage
status: in-progress
area: vibelang
owner: Codex Sol (vl-coverage)
updated: 2026-11-08
links:
  - ../../../vibelang/wiki/decisions/0016-coverage.md
  - ../../../vibelang/wiki/decisions/0008-testing.md
---

VL-29 coverage remains incomplete. Decision 0016 records the independent per-file snapshots, strict 100% per-file
qualifications and attribution boundaries. No production source is excluded. The nyc-01 report and raw evidence are
`~/vl/vl-coverage.REPORT.md` and `~/vl/vl-coverage-evidence/`.

The Sol continuation landed `635f4dd34362` (typed client-path validation and cancelled-before-admission action
receipts) and `6db1ba5132c4` (real HTTP account/issue/action/Factory clients over product handlers and SQLite hosts).
Fresh-main ordinary validation passed typecheck and 828 unit/integration tests, with one opt-in GitHub integration skip.
The retained 123-file unit snapshot is 83.94% lines / 75.33% branches / 74.18% functions / 79.67% statements.
Chromium independently has 264 product passes, three expected mapping failures, twelve skips and no unexpected
failures; its diagnostic metrics are 48.46 / 54.82 / 58.10 / 52.44%. Workerd's inspector disables precise V8 coverage;
real isolate counters have passing partial/complete controls, but the full original-source report is blocked.

Original match ranges are reversed in both published 0.0.12 and upstream 46ce1cd7. Fix `f5d37aa764af` is queued
through VibeLang's merge queue, with 70 source-map tool tests, 12 affected compiler cases, four Go oracle roots and
the install/build/run/starter-test check passing. It changes source-map flags only; the fixture's emitted JavaScript
is byte-identical. Queued is not landed or published. Bundled statement attribution also has a separate plain-JS
reproduction. The six affected unit intervals and browser figures remain diagnostic.

Agent boundary cases exercise deferred action calls and real action/history cells and remove four
unregistered placeholder flow bodies with unchanged serialized catalogs; its inventory retains other lanes' proof
notes. Runnable known-red coverage qualifications and refreshed records remain pending. The audit also found predecessor GitHub success-response fakes and DOM geometry
stubs; those need replacement/removal before a no-mocks or 100% claim. Actual GitHub writes are outside this lane's
authorization. Live model/Container cases lack authorized test-binding references and receive no coverage credit.
No agents were started and no deployment was performed.

A further real HTTP issue regression found approval fields surviving an untrusted projection's downgrade and
becoming trusted gate receipts on a later read. The fix strips those external fields before saving projections.
Its focused regression fails first; four real SQLite/offline HTTP issue cases cover repeated reads, replay,
permission changes, comments, links, commitment and unchanged truth after invalid operations.

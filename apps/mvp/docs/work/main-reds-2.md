---
title: Isolate repository and home unit failures
status: done
area: testing
owner: main-reds-2
updated: 2026-10-26
links: []
---

Reproduce branch-ref invalidation and the home fixture deadlock on Latitude; fix their causes and prove each alone and in its file for twenty consecutive runs. Use the catalog's Effect SQL and Electric collection entries; no new libraries.

The branch fixture created a default-namespace ref only in Code Storage. Opening the view also starts an upstream refresh, which replaces that namespace; the fixture now publishes the new GitHub branch before pulling and recording the ref change, and asserts the default head stays fixed. Workspace-created branches use the ephemeral namespace and were not represented by the old fixture.

The home test reset tables with its first tab still reading Markdown. Captured `pg_stat_activity` showed reset's `TRUNCATE repositories, code_storage_usage` (PID 1106985) blocked by meterRead's transaction (PID 1107004), whose `SELECT sum(stored_bytes) FROM repositories` was blocked by the reset. PostgreSQL reported 40P01: AccessExclusiveLock on usage versus AccessShareLock on repositories. Separate tests now get normal tab and harness teardown between scenarios; the invalid-home cases also run as separate tests, each with full tab and harness teardown. No production code, timeouts or retries changed.

Baseline receipts: `repo-alone-before.log` and `repo-file-before.log` reproduce the branch failure; `home-covered-locks-before.log` contains the lock graph and PostgreSQL deadlock details. Test files are excluded from production coverage; there are no changed production files to measure.

Repeated full-file validation also exposed a content-classification fixture race: the scripted provider's default injected `sync_in_progress` response could overlap a missing-file lookup during the view's background refresh, correctly yielding Busy instead of Not found. Ready-home fixtures and the file-classification case now choose an immediately synced injected provider (`syncPolls = 0`); dedicated sync/outage tests retain their explicit faults. No product retry policy changed.

The full-file stress run also caught the generated-manifest assertion reading its Electric repository join too early: RepoApi's file and manifest can already be text while that independent row is absent, and `generatedLinksFor` correctly returns undefined then. The test now awaits that existing ready-row dependency before asserting links, using its unchanged wait budget.

Validation: Latitude typecheck and importRules passed. Each reported test passed twenty consecutive isolated runs; both complete files passed twenty consecutive unfiltered runs (62 tests each, 1,240 executions). Twenty preliminary stress runs also passed. Raw receipts are `complete-proof.log`, `alone-final-proof.log`, and their individual per-run logs. SHA-256 checks confirmed the tested files stayed unchanged. Astra and Fable approved the final diff. Production coverage excludes test files; no production files or coverage thresholds changed.

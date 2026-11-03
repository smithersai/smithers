---
title: Verify TLS for ops database connections
status: in-progress
area: operations
owner: Codex deployment migration diagnostic repair
updated: 2026-11-02
links: [../../ops/feed-barrier/confirm.ts, ../../ops/role-age/expire.ts, ../../ops/runner-cutover/cutover.ts]
---

Require verified TLS before any remote ops database connection. Keep literal loopback development connections available. Refuse with the hostname only, never connection strings. Normalize Neon's API-derived connection to verify-full and establish the actual driver's certificate verification against a real TLS Postgres on Latitude if available.

Work stays in this existing workspace on main's working copy. No landing, push, review, new Mac copies or installs. Tests run through lat-run with stdout captured to files; include apps/mvp pnpm typecheck. Record red-first and final receipts, ids, counts and skips.

Library catalog: retain the existing Effect SQL PgClient / Database.layer connection path; this is an operations connection boundary, not a product plugin or another SQL driver.

Implemented the shared ops TLS boundary, CA-file validation/loading, explicit chain and hostname verification, endpoint-override rejection, and Neon URL normalization to verify-full. Retained Node's default trust store, including NODE_EXTRA_CA_CERTS at startup. Channel binding is unsupported by this driver and is not claimed. Extracted the shared role-age constant so the real expiry CLI no longer loads unrelated browser/application modules. Added the helper to the main coverage gate and its code/tests to the existing infrastructure typecheck.

Baseline: main parent `7df7c2ecb983`, existing jj change `opmkrtvlvsru`. No bookmark, commit, landing, push or deployment operation.

All receipts below are lat-run executions on nyc-01, with stdout and runner stderr captured separately under `/tmp/mvp-ops-tls-*` on the Mac. No dependencies installed or repository copied on the Mac.

| Receipt id | Result | stdout file |
| --- | --- | --- |
| `slot1-60146-1793686200` | Initial CLI red: 24 failed, 0 passed, 0 skipped. 16 missing-refusal failures; 8 expiry CLI startup failures from its existing heavy import. | `/tmp/mvp-ops-tls-red-cli.stdout` |
| `slot2-67462-1793686275` | CLI baseline with the VibeLang loader: 24 failed, 0 passed, 0 skipped. Same 16 missing-refusal failures; expiry still failed to load an extensionless app import. | `/tmp/mvp-ops-tls-red-cli-loader.stdout` |
| `slot1-66086-1793686246` | Neon red: 1 failed, 9 passed, 0 skipped. | `/tmp/mvp-ops-tls-red-neon.stdout` |
| `slot1-81754-1793686403` | First corrected standalone suite: 71 passed, 0 failed, 0 skipped. | `/tmp/mvp-ops-tls-green2.stdout` |
| `slot1-93700-1793686436` | Existing confirm, expire, cutover, Database and RepoRoles suites: 136 passed, 0 failed, 0 skipped (5 files). | `/tmp/mvp-ops-tls-existing.stdout` |
| `slot3-97497-1793686486` | 75 tests passed, 0 failed, 0 skipped; coverage gate failed (helper layer/callback only executed in child processes). Added an actual in-process verified TLS query and boundary cases. | `/tmp/mvp-ops-tls-coverage.stdout` |
| `slot2-5152-1793686563` | Final standalone suite: 77 passed, 0 failed, 0 skipped (3 files). TLS helper statements, branches, functions, lines all 100%. | `/tmp/mvp-ops-tls-final.stdout` |
| `slot1-4502-1793686550` | `cd apps/mvp && pnpm typecheck`: exit 0, before explicitly adding the new ops directory to its scope. | `/tmp/mvp-ops-tls-typecheck2.stdout` |

Red assertion lines:

- `ops/database/Connection.test.ts:30`: expected the host-only TLS-policy refusal; confirm instead returned `PgConnection: Failed to connect`, cutover instead returned `fetch failed`.
- `ops/feed-barrier/confirm.test.ts:50`: expected `sslmode=verify-full`; received `sslmode=require`.

The final standalone run used an owned PostgreSQL 18 server and generated CA/certificate on Latitude. Its eight TLS cases executed with no skips: Neon-shaped require/channel_binding URI succeeds with verify-full and the process root store; untrusted issuer and wrong hostname fail; pinned CA succeeds independent of process roots; wrong pin and wrong hostname fail; a leaf certificate cannot act as a CA; the shared layer performs a real encrypted/authenticated query. The untrusted-issuer test also sets NODE_TLS_REJECT_UNAUTHORIZED=0 and still fails certificate verification.

Other attempts: the nyc-02 app-permit-queued combined red run `slot3-27159-1793686050` was cancelled before tests. The first typecheck dispatch `slot2-92843-1793686426` exited 5 in farm integration-service setup before executing typecheck. Both were rerouted through lat-run's root target to avoid unrelated app-service prerequisites. The first post-fix suite `slot1-74688-1793686328` passed 20 and failed 10 (8 expiry startup failures; 2 positive TLS tests incorrectly expected no warning with the global TLS opt-out); corrected the expiry dependency and limited that opt-out to its negative test. No product warning was suppressed.

Final typecheck receipt `slot1-11876-1793686643`: `cd apps/mvp && pnpm typecheck`, exit 0, with `ops/database` explicitly included in the infrastructure project. Stdout: `/tmp/mvp-ops-tls-typecheck-final.stdout`; runner: `/tmp/mvp-ops-tls-typecheck-final.runner`.

Final validation total: 213 passed, 0 failed, 0 skipped across the standalone 77-test run and five existing suites (136 tests). This is targeted execution, not a whole-app suite claim. TLS helper executed coverage is 100% statements/branches/functions/lines. Typecheck passes all four configured projects, including the new ops code and tests.

Reproduce through the existing lat-run executable with `LAT_RUN_SRC` selecting this workspace. Commands passed to lat-run:

- Root target `.`: `pnpm --dir apps/mvp exec vitest run --config ops/database/vitest.config.ts --maxWorkers=2 --reporter=verbose --coverage --coverage.include=ops/database/Connection.ts --coverage.thresholds.statements=100 --coverage.thresholds.branches=100 --coverage.thresholds.functions=100 --coverage.thresholds.lines=100`.
- App target `apps/mvp`: `pnpm exec vitest run ops/feed-barrier/confirm.test.ts ops/role-age/expire.test.ts ops/runner-cutover/cutover.test.ts db/Database.test.ts worker/github/RepoRoles.test.ts --coverage.enabled=false --maxWorkers=2 --reporter=verbose`.
- Root target `.`: `bash -lc 'cd apps/mvp && pnpm typecheck'` (no unnecessary app integration-service setup).

All stdout is redirected to the named files; runner stderr uses the matching `.runner` paths. The superseded detached nyc-02 run was explicitly stopped while still queued, matching only its exact argv, so it cannot start later after the local runner exits.

## Astra repair, 2026-11-02

Repair on top of 15782aa94dc7. Red first; test only through mini-run apps/mvp with captured output. No production access, mvp-prod-env, landing, push or review. Production certificate-chain verification belongs to Will. Inspect deploy URL provenance before changing its migration boundary.


Repair connection audit (source, before tests): Alchemy gets Neon’s `connectionUri` via `infra/Postgres.ts`; production migrations do not invoke the standalone `db/migrate.ts`. `ChatMigrations` previously provided `Database.layer` directly. It now takes `migrationUrl(postgres)` (the shared `neonConnectionUri` normalizer) and calls `Connection.migrate`, the same verified boundary as the standalone CLI. Electric keeps its existing `directUrl` adapter. No production URL was read and no deployment or `mvp-prod-env` command was run.

`DATABASE_URL` / `SMITHERS_TEST_DATABASE_URL` inventory under apps/mvp and .smithers: three operator CLIs; standalone migrations; deployment’s migration action; lane readiness; release-host capture and its backup-restore/fault callers (all use recorder `run` with `PGDATABASE`). All now reach the shared policy. TestDatabase/ElectricReplication already select an isolated loopback fixture; CI, compose and farm scripts construct their own local fixture URLs. ElectricRuntime and the Worker Hyperdrive bindings are product runtime adapters, not standalone operational connections. A repository-wide name search also found SDK runtime configuration and cache-service declarations outside this repair’s apps/mvp/.smithers scope.

Local log exposure audit: 17 existing `.log` files directly under `~/lanes` and `~/.smithers-lead/scratchpad-mirror` were scanned for credential-bearing `BLOCKED: no PostgreSQL at postgres[ql]://...` lines without printing matching contents. None found. The old gate could persist real credentials at `$HOME/lanes/$LANE.gates.log` and wherever its caller captured stdout. Remote lane logs were not inspected. No existing log was altered or deleted.

First mini red receipt: slot 2 / remote PID 89241, 28 failed, 0 passed, 0 skipped. Log: `~/.smithers-lead/scratchpad-mirror/ops-tls-repair-red.log`. Assertion lines `Entrypoints.test.ts:23` (missing migration refusal), `:34` (missing lane refusal), `:46` (recorder spawned instead of refusing), `:61` (hostname-only stdout/log), `:79` (nested URL driver diagnostics). One initial cutover diagnostic case was removed: it failed in its deployment fetch before reaching a driver, so it did not demonstrate P3. The confirm and expiry cases retain the real malformed-driver-parameter regression.

Intermediate execution: slot 3 / PID 91691: 103 passed, 2 failed, 0 skipped (old bracketed IPv6 expectation; corrected to the diagnostic’s bare IPv6 hostname). Slot 2 / PID 92272: all four typecheck projects passed. Slot 2 / PID 93786: existing five suites, 135 passed, 1 failed, 0 skipped (release-mismatch diagnostic accidentally classified as database failure; fixed by recording when TLS validation/database execution is active). Slot 2 / PID 98153: 114 passed, 1 failed, 0 skipped; the remaining failure was the new real libpq TLS success case, investigated separately; typecheck passed. The deploy URI-adapter test, shared migration boundary against the owned TLS server, repeated migration and standalone migration paths all executed successfully in that run.

`ops-tls-repair-green2.log` and `ops-tls-repair-libpq-diagnostic.log` ended with admission `CAPACITY_TIMEOUT`, exit 75, before any tests ran. They are not test results. All repair execution uses `MINI_RUN_SRC=$PWD ~/.smithers-lead/scratchpad-mirror/mini-run apps/mvp -- ...`, with both streams redirected to named scratchpad logs. The next diagnostic admission uses a longer wait; no occupied slot or process was disturbed.


Diagnostic receipt: slot 1 / PID 7879 (`ops-tls-repair-diagnostic2.log`): 116 passed, 2 failed, 0 skipped. The real psql and readiness success cases reproduced failure; fixed-word diagnostics identified a missing default Unix socket. psql was PostgreSQL 18.6 (Homebrew), OpenSSL 4.0.3. Cause: libpq fills `PGDATABASE` from defaults after its explicit-dbname URI expansion, so a URI supplied only through `PGDATABASE` is a literal database name, not the endpoint. This is established in PostgreSQL’s [psql startup](https://github.com/postgres/postgres/blob/REL_18_STABLE/src/bin/psql/startup.c) and [libpq parameter/default handling](https://github.com/postgres/postgres/blob/REL_18_STABLE/src/interfaces/libpq/fe-connect.c). The adapter now supplies separate PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD and TLS fields, with supported query options mapped explicitly. Unsupported or duplicate libpq query options fail closed. GSS transport is disabled so it cannot supersede certificate-verified TLS. URLs and credentials stay out of argv and receipts.


Final security/migration receipt: slot 2 / PID 16280, `ops-tls-repair-final.log`: 125 passed, 0 failed, 0 skipped, six files. All four app typecheck projects pass; combined command exits 0. Connection.ts and Policy.ts each execute at 100% statements, branches, functions and lines. Including Probe.ts, aggregate coverage is 95.12% statements, 93.05% branches, 100% functions, 95.31% lines. Probe’s native CLI wrapper (lines 19–21) executes in child-process tests but is not included in parent-process V8 counters; its direct probe behavior is exercised in process. This is targeted coverage, not a whole-app coverage claim.

Real TLS cases executed without skips: the existing eight Node TLS cases; shared deploy migration against the owned TLS Postgres, repeat idempotent migration, standalone migration with and without verified TLS; native libpq trusted pin success, wrong hostname failure, wrong CA failure, and rejection of the owned untrusted CA with system roots; real lane SQL and readiness fallback. The two deployment tests execute Alchemy’s actual URI mapping callback and verify the action/CLI source wiring. The actual Neon production chain remains **unverified, owner-run by Will**. No production access, credentials, `mvp-prod-env`, deployment, landing, push or external review was used.

Broader regression receipt: slot 2 / PID 13426, `ops-tls-repair-regressions.log`: the five existing app suites produced 135 passed, 1 failed, 0 skipped, with one associated unhandled rejection. The failure is `worker/github/RepoRoles.test.ts:702`, “a claim that waited for the row gets a lease counted from when it got it”: PostgreSQL `55P03`, canceling statement due to lock timeout while waiting for the role row. That test and RepoRoles implementation are unchanged by this repair. The run does not establish a wholly green broader suite. The four other suites, including runner release-mismatch refusal, passed. No unrelated role-lease code was changed or test retry used to erase the failure.

In the same receipt, lane-gates and lane-prerequisites produced 42 passed, 0 failed, 0 skipped. The subsequent ESLint command was invoked from apps/mvp and refused two outside-base-path files rather than checking them; it was corrected to run from the repository root in a separate mini receipt.


Final current-source receipt: slot 3 / PID 19665, `ops-tls-repair-final2.log`: **126 passed, 0 failed, 0 skipped**, six files, all four typecheck projects pass, root ESLint passes; combined command exit 0. This includes the final synchronous process-validation diagnostic regression for a decoded connection field containing NUL, so process spawn errors cannot echo it. The earlier 125-test coverage receipt remains valid for unchanged Connection.ts, Policy.ts and Probe.ts. The redundant queued lint-only request was cancelled (exit 143) after the combined final receipt proved lint, before it executed; no other process or reservation was disturbed.

Repairs P1–P3 are complete on jj change `smxkvqtu`, parent `15782aa94dc7`. Validation limits: the broader app run still has the unchanged role-lease test’s `55P03` failure and associated rejection; production Neon chain remains unverified for Will’s own check. No wholly green app, production-chain, review, landing or push claim.

Deployment diagnostic follow-up on baseline `128e8f4fea5b`: the shared migration effect still returned raw driver failures to Alchemy. Added a behavioral regression through the real `migrationUrl` adapter and driver, with a nested credential-bearing URL in invalid `connect_timeout`. Red Mini receipt `slot 3 / PID 35859`, `/tmp/ops-deploy-diagnostic-red.log`: 2 passed, 1 failed, 0 skipped. Red line `ops/database/Deployment.test.ts:44`: inspected/serialized/formatted failure output matched the forbidden URL/credential pattern. No socket is opened by this numeric-option parser failure.

`Connection.migrate` now replaces failure causes with a fresh error from the existing host-only diagnostic helper. No raw error or nested cause is retained. Library catalog: existing Effect SQL `PgClient` / `Database.layer`; no new driver or dependency.

The first validation admission (`/tmp/ops-deploy-diagnostic-green.log`) exited 75 after 120 seconds without running tests. Mini receipt `slot 2 / PID 51641`, `/tmp/ops-deploy-diagnostic-final.log`: the regression passed; 112 tests passed and 15 skipped, with one failed suite because PostgreSQL refused the generated server key's group/world permissions. App typecheck did not execute. The owned fixture now explicitly sets its server key to mode `0600`, independent of OpenSSL defaults or the host umask. Final standalone ops coverage and app typecheck receipt pending.

The post-permission-fix retry (`/tmp/ops-deploy-diagnostic-final2.log`) also exited 75, after a 600-second capacity wait; no tests or typecheck executed. Final validation is blocked on Mini admission. The migration regression is verified by PID 51641, but the fixture permission correction, complete coverage gate and app typecheck remain unverified. No occupied or ownerless reservation was changed.

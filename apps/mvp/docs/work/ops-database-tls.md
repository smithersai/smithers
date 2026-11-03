---
title: Verify TLS for ops database connections
status: done
area: operations
owner: Codex ops-database-tls
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

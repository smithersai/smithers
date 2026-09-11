Testing review — 2026-09-04

The suite is substantial, but it does not meet the requested standard of proving every meaningful input boundary, failure outcome, and operational invariant. The strongest evidence is a newly reproduced failure at the maximum accepted command size, and two deliberately broken byte-boundary comparisons that the entire gateway assertion suite accepts.

Remediation is consolidated in [consolidated-review-plan.md](consolidated-review-plan.md): findings 1–12 below map to T2–T13, with work assigned across W0–W19. This document preserves the original review evidence and experiments; use the consolidated plan for priorities, dependencies and implementation acceptance.

This reviews the current working tree, including its existing uncommitted changes. It is a repository-wide inventory and a focused behavioral audit, not a claim to have inspected every assertion. Production code and existing tests were not edited. Diagnostic tests and mutation configuration live under `/tmp`; they are not installed regression tests. Local execution used Node 24.18.0 and pnpm 11.25.0 on macOS; CI declares Node 22.19.0. No production services or paid model endpoints were exercised.

**Findings, in priority order**

1. **P1 — No test proves that the largest admitted command can actually be synchronized; that case currently fails.**

   [BranchCommands.ts](packages/smithers/flows/sync/src/BranchCommands.ts:474) measures the command submission, and defaults its maximum to the same 1 MiB used by sync. The persisted event adds its journal envelope. [SyncServer.ts](packages/smithers/flows/sync/src/SyncServer.ts:501) measures that larger event and refuses a single event over its ceiling.

   A temporary test composed the production branch command service, HMAC share service, production SQLite journal over the test database, and sync server. It constructed a command whose complete serialized submission was exactly 1,048,576 bytes. Submission succeeded with `status: admitted`; the persisted entry measured 1,048,854 bytes; reading it returned `frame_too_large`. The assertion that an admitted maximum-size command remains readable failed. The existing [PayloadLimits.test.ts](packages/smithers/flows/sync/test/PayloadLimits.test.ts:77) tests oversized submissions and oversized read entries separately, missing this composition.

   Required tests: admission → durable journal → bootstrap → live subscriber at the maximum, one byte below, and one above; ASCII, multibyte Unicode, JSON escaping, and identifier-length variations; configured limits as well as defaults. Prove that refusal writes nothing and leaves cursors unchanged. Resolve the end-to-end size contract before choosing the new acceptance expectations. An accepted record must remain consumable under the supported default configuration.

2. **P1 — Gateway byte-boundary regressions survive the entire assertion suite.**

   [Projections.ts](packages/smithers/gateway/src/Projections.ts:201) rejects event histories above 4 MiB; [the row guard](packages/smithers/gateway/src/Projections.ts:345) accepts rows at or below 4 MiB. A temporary Vite transform changed `encodedBytes > maxProjectionBytes` to `>=`, and `bytes <= maxProjectionBytes` to `<`. Both changes incorrectly reject an exactly maximal valid input. All 258 gateway assertions still passed with these mutations applied.

   [ProjectionsUnit.test.ts](packages/smithers/gateway/test/ProjectionsUnit.test.ts:311) uses a payload string of length `maxProjectionBytes`, which exceeds the complete serialized budget once its envelope is added. It does not exercise equality. This is a demonstrated missing oracle, not a hypothetical objection to code coverage.

   Required tests: independently construct valid event histories and row arrays whose complete encodings occupy N−1, N, and N+1 bytes, accounting for brackets, commas, keys, escapes, and UTF-8. Assert successful output content at N and the precise error at N+1. Preserve these mutations as a small mutation-testing gate, then extend it to authorization, cursor advancement, retry decisions, and owner fencing. Coverage was disabled for the mutation experiment to isolate assertion strength; no mutation-score claim is made beyond these two sites.

3. **P1 — Pull-request CI's “apps e2e” job does not run the browser suite.**

   [.github/workflows/ci.yml](.github/workflows/ci.yml:177) runs `smithers-build test '//apps/app/...'`. [apps/app/PACKAGE.ts](apps/app/PACKAGE.ts:91) declares a Bun unit test runner for `src`, and explicitly keeps Playwright and packaged E2E out of the per-push graph. Installing or checking for Chrome does not make that command a browser test. [The actual Playwright step](.github/workflows/apps-deploy.yml:67) is in the deploy workflow, triggered by `apps-v*` tags or manual dispatch.

   The main CI workflow also does not select `//apps/server/...`; that app's unit suite is explicitly run in the deploy workflow. UI typechecking is not selected by the test-only UI invocation either. The [test-script wiring gate](scripts/repo-contract/test-script-wiring.test.mjs:48) checks manifest scripts and recursive root commands, rather than the graph selected by actual CI; all four of its tests pass despite this mismatch.

   Required tests/gates: assert the resolved CI test inventory, not just the existence of a `test` script; include server tests and UI typechecking; run the offline Playwright tier on PRs. Add a sentinel browser failure and sentinel server failure in synthetic CI-wiring fixtures and prove each fails its intended gate. Native packaged tests need an explicitly owned platform tier if that product is supported.

4. **P1 — Reachable scheduler I/O failures are explicitly omitted from coverage.**

   [PlanScheduler.ts](packages/smithers/flows/engine-store/src/PlanScheduler.ts:627) and the error translations at lines 678, 695, and 705 use `v8 ignore` for filesystem expansion/stat/listing failures, describing them as equivalent to tested prepare failures. They are distinct points in execution: a failure while discovering produced files can happen after producers have completed and before consumers dispatch.

   Required tests: inject permission denial, I/O error, and disappearance into source-glob expansion, produced-file `stat`, produced-glob expansion, and tree enumeration. Assert the exact `boundary_unavailable` outcome, preserved cause, durable failed state, absence of downstream dispatch/cache publication, and released resources. A shared error tag alone does not prove those postconditions. Remove exclusions for reachable failures once their own tests exist. Keep separate justification for truly unreachable language/runtime invariants.

5. **P2 — The gateway's existing 100% gate is already failing locally.**

   Running the full gateway suite with its normal configuration produced 258 passing tests, 100% statements/functions/lines, and **99.23% branches (516/520)**. The command failed its declared 100% branch threshold. Reported gaps: [GatewayServer.ts](packages/smithers/gateway/src/GatewayServer.ts:371) and [NodeGateway.ts](packages/smithers/gateway/src/node/NodeGateway.ts:154), including lines 156–157.

   Required tests: Host values that pass the preliminary syntax filter but fail URL parsing, omitted bind-host defaults, and bind-authority construction branches. Exercise feasible cases through public constructors/HTTP requests. Verify on the pinned CI runtime before attributing any residual branch to instrumentation. This observation does not establish the status of a remote CI run.

6. **P2 — Input-boundary tests sometimes prove only that a function returns something.**

   [canonicalize.test.ts](packages/smithers/flows/canonical/test/canonicalize.test.ts:319) constructs the maximum supported depth of 10,000 but accepts any result starting with `[[[[`. A truncated or otherwise corrupted deep result satisfies that assertion. The public-schema depth case in [Canonical.test.ts](packages/smithers/flows/canonical/test/Canonical.test.ts:250) tests depth 10,001 rejection, without establishing exact maximum-depth output preservation.

   Required tests: compare the entire 10,000-level output to an independently constructed string (`'['.repeat(N) + 'null' + ']'.repeat(N)`); repeat for objects and mixed nesting; exercise the public schema and key derivation paths. Keep the existing deterministic over-depth error assertion. This is an assertion-quality gap, not a demonstrated serializer defect.

7. **P2 — Provider stream framing has neither a declared size ceiling nor size/resource tests.**

   [Framing.ts](packages/smithers/agent/model/src/Framing.ts:32) and its NDJSON path feed decoded input to line splitting without a local line/frame limit. [Framing.test.ts](packages/smithers/agent/model/test/Framing.test.ts:21) covers small fixtures at fixed chunk sizes 1, 3, 7, and 4096, sentinel handling, and truncation. It does not establish a supported maximum or bounded behavior while a peer keeps sending an unterminated record. Request error-body limits elsewhere do not establish successful streaming-response limits.

   Required tests: define line/frame and accumulated-tool-argument budgets, or explicitly state the alternative bounded-streaming contract; test N−1/N/N+1, many small chunks without a delimiter, oversized multiline SSE events, arbitrary chunk partitions, split multibyte code points, empty chunks, malformed encodings, interruption while buffering, and transport failure mid-record. Assert cancellation of the producer, bounded retained memory, and protocol-specific failure behavior. Preserve the intentionally different SSE/NDJSON truncation policies.

8. **P2 — Property testing does not yet explore the core durable state machine or a sustained fuzz campaign.**

   The repository has 12 files named `*.property.test.ts`, plus additional property cases in ordinary test files. Existing properties include valuable canonicalization, digest, capability, file-set, journal paging, sync, and notification laws. However, [SyncProtocol.property.test.ts](packages/smithers/flows/sync/test/SyncProtocol.property.test.ts:13) defaults to 100 cases and a fixed seed; raw byte samples are capped at 256 bytes. [SyncClient.property.test.ts](packages/smithers/flows/sync/test/SyncClient.property.test.ts:70) explores small frame histories. No generated command-model runner was found in the engine-store, run-store, engine, database, or control test directories. No scheduled high-budget fuzz invocation or mutation-testing pipeline was found in the declared workflows.

   Required tests: generate legal and illegal histories over create/claim/heartbeat/dispatch/settle/cancel/suspend/approve/signal/reclaim/restart/compact, compare observations against a small independent model, and assert invariants after every operation. Generate DAG shapes and dependency/conflict arrangements rather than only scalar arguments. Assert one live owner, stale-owner writes refused, committed outcomes survive restart, cancellation reaches descendants, and cursors never acknowledge unapplied data. State exactly-once guarantees at the journal/admission boundary; do not accidentally assert exactly-once external side effects where the product does not promise them.

   Add a scheduled rotating-seed tier with persisted seed, shrink path, minimized input, command history, runtime, and failing artifacts. Bias generators toward boundaries and nearly valid protocol messages; uniformly random bytes mostly exercise shallow parse rejection. Keep quick deterministic PR properties and promote every discovered failure to a deterministic regression. Prevent cache reuse from silently replacing intended new seed executions.

9. **P2 — Existing performance work does not constitute a benchmark regression suite.**

   [observation-bench.ts](packages/smithers/scripts/observation-bench.ts:38) and [search-bench.ts](packages/smithers/agent/std/scripts/search-bench.ts:11) report timings against operator-selected trees, without a checked baseline or pass/fail regression threshold. There are useful deterministic cost tests, including [AttemptProbeCost.test.ts](packages/smithers/flows/engine-store/test/AttemptProbeCost.test.ts:62), and bounded fan-out/heap tests in [ServerSoak.test.ts](packages/smithers/flows/sync/test/ServerSoak.test.ts:223). Those are strengths, but they cover selected regressions rather than the full performance envelope.

   Required benchmark fixtures: scheduler chains/wide DAGs/conflict-heavy graphs; journal append/replay/paging at increasing history sizes; sync fast/slow subscribers and reconnect storms; artifact upload/download/hash at production limits; canonicalization depth and width; workspace observation/search at increasing file counts; large UI transcripts/graphs. Measure useful work as well as elapsed time. Prefer query/syscall/allocation counts for PR gates; measure throughput, tail latency, retained heap, RSS, file descriptors, sockets, and database/WAL growth on controlled scheduled runners. Include warm/cold caches, warmup, repetitions, and a documented noise policy. The benchmark must validate its output so “doing less work” cannot appear as a speedup.

10. **P2 — Crash coverage is strong, but important combinations and long-lived behavior remain unproven.**

    Real process-kill/restart tests already exist, including [HardKillReclaim.test.ts](packages/smithers/flows/engine-store/test/HardKillReclaim.test.ts) and [DurableWaitingRestart.test.ts](packages/smithers/flows/engine-store/test/DurableWaitingRestart.test.ts). The [fault-matrix ledger](scripts/repo-contract/fault-gaps.md) explicitly records missing two-host timer races, real CLI process-boundary recovery flows, and a scheduled long-duration soak. Existing in-process or engine-level coverage should not be described as absent; the missing work is at these combined boundaries.

    Required tests: release two real drivers against one due timer using a barrier; race approval/cancellation/lease expiry around durable settlement; execute seatless or recorded-model fixtures through the shipped CLI across hard kills; combine reconnect, compaction, retention, and slow subscribers. For long-lived services, measure growth slope after warmup over repeated checkpoints and ensure handles/queues return to baseline. A one-time generous heap delta over a fixed short run cannot rule out a small per-cycle leak.

11. **P2 — Coverage enforcement is inconsistent across packages and platforms.**

    Examples of configured branch floors: [build-cli](packages/smithers/build/build-cli/vitest.config.ts:27) 76%, with `RepoResolution.ts` at 51% and `DockerExec.ts` at 58%; [std](packages/smithers/agent/std/vitest.config.ts:28) 84%; [migrate](packages/smithers/migrate/vitest.config.ts:41) 83%; [CLI](packages/smithers/vitest.config.ts:69) 91%. These are configuration floors, not newly measured coverage results. The Bun app test commands inspected do not themselves request a coverage gate. In [.github/workflows/ci.yml](.github/workflows/ci.yml:285), macOS and Windows package suites are advisory via `continue-on-error`.

    Required work: enumerate uncovered behavior in execution backends, migration rollback/recovery, filesystem tools, and CLI composition; add behavioral tests before raising floors. Set explicit coverage policies for Bun applications. Make supported OS/runtime conformance required, or publish a narrower support contract. Test platform-specific path syntax, case sensitivity, symlinks, executable resolution, process termination, and locking on their real target platforms. Do not treat the existence of a nonblocking matrix row as an enforced guarantee.

12. **P2 — Native/WASM ABI testing lacks generated hostile-input coverage.**

    [test_abi.rs](crates/flows-jj/tests/test_abi.rs:32) has deterministic malformed JSON, missing-field, unknown-op, and operation round trips; [BrowserJjWasmEdgeCases.test.ts](packages/smithers/flows/jj/test/BrowserJjWasmEdgeCases.test.ts) exercises the real WASM artifact and meaningful filesystem edge cases. No cargo-fuzz/proptest target was found in [the crate manifest](crates/flows-jj/Cargo.toml) or repository inventory. Native `call_json` tests bypass the pointer packing in [abi.rs](crates/flows-jj/src/abi.rs:141).

    Required tests: a parser-only raw-byte fuzz target, grammar-guided request mutations, and generated operation sequences constrained to temporary repositories. At the real WASM boundary, test zero-length allocations, repeated valid allocate/call/free cycles, memory growth, and instance behavior after classified failures. Respect the ABI's pointer ownership preconditions; arbitrary invalid frees are outside that contract and are not useful acceptance tests. Fail the supported conformance tier if the required WASM artifact is missing instead of silently reducing the inventory.

**The acceptance standard to apply to each input surface**

A percentage cannot express this contract. Each public input needs an inventory entry that states its unit, domain, limits, side effects, failure policy, and enforcing tests. Inputs without a finite product limit need an explicit complexity/resource contract; “largest possible JavaScript value” is not a practical substitute.

| Dimension | Required evidence |
| --- | --- |
| Shape | Omitted, null, empty, valid, wrong type, extra/unknown field according to policy, duplicate keys/IDs, structurally valid but semantically inconsistent input. |
| Numeric | Minimum and maximum inclusive/exclusive boundaries; adjacent representable values; negative, fractional, negative zero, NaN, infinities, unsafe integers where runtime callers can supply them. |
| Size | N−1, N, N+1 in the actual enforced unit; bytes versus characters; encoded envelope overhead; one large item versus many small items; combined count/depth/size limits. |
| Text | ASCII, multibyte Unicode, combining forms, lone surrogates where applicable, escaping, control characters, path separators and platform-specific names. |
| Maximum acceptance | Full correct output, successful downstream consumption, durable replay, and bounded resource cost—not merely absence of a throw. |
| Refusal | Exact error category and relevant fields; no unauthorized/partial writes, cursor movement, cache admission, or leaked handles; retryability and recovery behavior. |
| Failure location | Before action, after partial read/write, before commit, after commit before acknowledgment, during cleanup; distinguish failure, defect, and interruption. |
| Time/concurrency | Just before/at/after a deadline; renewal versus expiry; duplicate/reordered/stale messages; owner replacement; deterministic barriers for known races and generated histories for combinations. |
| Persistence | Reopen/restart with a fresh process; supported schema upgrades; corruption classification; rollback and retention/backup interaction. |
| Test strength | Independent oracle or law, sensitivity to targeted mutations, and explicit checks on meaningful state/output. |
| Execution | Actual CI selection, supported runtime/platform, required dependencies, cache invalidation, and failure artifacts. |

The first implementation batch should close findings 1–4: install the failing end-to-end size regression, add exact gateway byte-boundary cases that kill the demonstrated mutations, correct CI inventory enforcement, and test the excluded scheduler I/O failures. Follow with durable state-model generation and bounded stream behavior; then add the sustained fuzz/benchmark/soak tiers. Increasing case counts alone is insufficient if the domain or oracle remains weak.

**Checks performed and reproducibility**

| Check | Result |
| --- | --- |
| Repository inventory | 1,712 discovered JS/TS `test`/`spec`/`bench` files, excluding observability plugin data and SWE-bench archives; 12 explicitly named property-test files. These are file counts, not case counts or a coverage measurement. |
| Full gateway, normal coverage configuration | 13 files, 258 assertions passed; command failed because branch coverage was 99.23% against 100%. |
| Gateway with two byte-boundary mutations | All 258 assertions passed; transform logged that both mutations were applied. Coverage intentionally disabled. |
| Model Framing + ModelRequest | 21 tests passed; coverage disabled for this selected-file run. |
| Sync PayloadLimits + SyncProtocol properties + ServerRequestValidation | 19 tests passed; coverage disabled for this selected-file run. |
| Test-script wiring | 4 tests passed. |
| New temporary command-size composition regression | Failed: maximum-size admitted command cannot be read by the default sync server. |

The selected gateway run was followed by a full run; counts above do not imply distinct extra tests from the earlier selection. No full-workspace, Rust, Playwright, production, or long-duration test run was performed.

The following local artifacts preserve the experiments:

- [Maximum-command reproducer](/tmp/smithers-testing-review-boundary/boundary.test.ts), [config](/tmp/smithers-testing-review-boundary/vitest.config.mjs), and [failure log](/tmp/smithers-testing-review-boundary.log).
- [Gateway mutation configuration](/tmp/smithers-testing-review-gateway-mutation.config.mjs), [mutation log](/tmp/smithers-testing-review-gateway-mutation.log), and [normal full-suite log](/tmp/smithers-testing-review-gateway-full.log).
- [Model log](/tmp/smithers-testing-review-model.log), [sync log](/tmp/smithers-testing-review-sync.log), and [wiring log](/tmp/smithers-testing-review-wiring.log).

Re-run the command regression from `packages/smithers/flows/sync` with `pnpm exec vitest run --config /tmp/smithers-testing-review-boundary/vitest.config.mjs`. Re-run the mutation experiment from `packages/smithers/gateway` with `pnpm exec vitest run --config /tmp/smithers-testing-review-gateway-mutation.config.mjs`. Run the unmodified full gateway gate there with `pnpm exec vitest run`. Temporary files use this checkout's absolute path and are diagnostic artifacts for this session.

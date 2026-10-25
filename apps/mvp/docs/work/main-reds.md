---
title: Package validation reds
status: blocked
area: engine
owner: codex-main-reds
updated: 2026-10-25
links: []
---

The three requested fixes are implemented on baseline `d3d47529b6ba30ec2566e12a9984d31118089a39`. Blanket package coverage proof is blocked by ten additional package failures listed below; no gate was weakened.

Causes and regressions:

- Flow's retry table inferred `number[][]`; unchecked indexed access made both destructured values possibly undefined. A readonly tuple table preserves the actual two-value shape. Source/test typecheck and all 976 tests in 75 files pass, with 100% statements, branches, functions and lines.
- Recent Vitest setup additions broke existing import order and line-width rules. Formatted the 51 configurations listed below; dprint configuration and test settings are unchanged. The final check passed all 60 configurations selected by their owning dprint rules, plus both changed regression files. Three configs have no owning dprint config; two configs are already excluded by their owners.
- Pending-cancellation retry advanced virtual time before the failed database read returned and the sweeper registered its next heartbeat sleep. This is test timing, not an engine race. A latch forces the early advance; the old wait then fails on both SQLite and Postgres. The corrected wait drives TestClock until the durable cancellation receipt, retaining cursor and ownership assertions. Ten independent matrix runs each passed all six tests on both backends: Postgres 10/10. Full engine-store matrix: 2,237 tests in 224 files per backend, 100% merged coverage in all four categories; source/test typecheck passed.

Library catalog entries used: `@smthrs/flow` (durable workflows, retries and waits) and `@smthrs/engine-store` (durable attempts, owner fencing and waits). No production API or dependency changed, so no public-package changeset is needed.

Latitude proof logs delivered alongside the builder report: `main-reds-baseline.log`, `main-reds-regression.log`, `main-reds-engine-proof.log`, `main-reds-suites.log`, `main-reds-final.log`, `main-reds-provenance.log`; machine-readable results: `main-reds-SUITES.json`. All executions used nyc-02. Harness initially failed because the source mirror omits VCS metadata; its complete suite subsequently passed at 100% using a real shallow clone's metadata, parented at the exact builder baseline. Temporary clone and mirror metadata were removed after that run.

Formatted configurations and package coverage runs (statements / branches / functions / lines; a failed suite did not establish coverage proof):

| Configuration | Result | Tests | Coverage |
| --- | --- | --- | --- |
| `packages/smithers/agent/chain/vitest.config.ts` | PASS | 502 passed (502) | 100 / 100 / 100 / 100 |
| `packages/smithers/agent/evals/vitest.config.ts` | PASS | 285 passed (285) | 100 / 100 / 100 / 100 |
| `packages/smithers/agent/fs/vitest.config.ts` | PASS | 195 passed (195) | 100 / 100 / 100 / 100 |
| `packages/smithers/agent/harness-detect/vitest.config.ts` | PASS | 50 passed (50) | 100 / 100 / 100 / 100 |
| `packages/smithers/agent/harness/vitest.config.ts` | PASS | 2591 passed ; 3 skipped (2594) | 100 / 100 / 100 / 100 |
| `packages/smithers/agent/integrations/vitest.config.ts` | PASS | 1748 passed ; 8 skipped (1756) | 100 / 100 / 100 / 100 |
| `packages/smithers/agent/memory/vitest.config.ts` | PASS | 840 passed (840) | 100 / 98.1 / 100 / 100 |
| `packages/smithers/agent/model-host/vitest.config.ts` | PASS | 499 passed ; 1 expected fail (500) | 100 / 100 / 100 / 100 |
| `packages/smithers/agent/model/vitest.config.ts` | PASS | 1112 passed ; 9 skipped (1121) | 100 / 100 / 100 / 100 |
| `packages/smithers/agent/plugin/vitest.config.ts` | PASS | 265 passed ; 1 skipped (266) | 100 / 100 / 100 / 100 |
| `packages/smithers/agent/registry/vitest.config.ts` | PASS | 1283 passed (1283) | 100 / 100 / 100 / 100 |
| `packages/smithers/agent/scorers/vitest.config.ts` | PASS | 552 passed (552) | 100 / 100 / 100 / 100 |
| `packages/smithers/agent/std/vitest.config.ts` | PASS | 1483 passed ; 3 skipped (1486) | 100 / 100 / 100 / 100 |
| `packages/smithers/agent/triggers/vitest.config.ts` | PASS | 750 passed (750) | 100 / 100 / 100 / 100 |
| `packages/smithers/agent/vitest.config.ts` | FAIL | 2 failed ; 2231 passed ; 3 skipped (2236) | suite failed |
| `packages/smithers/build/build-cli/vitest.config.ts` | FAIL | 18 failed ; 2528 passed ; 16 skipped (2562) | suite failed |
| `packages/smithers/build/targets/vitest.config.ts` | FAIL | 1 failed ; 2818 passed ; 3 skipped (2822) | suite failed |
| `packages/smithers/build/vitest.config.ts` | PASS | 328 passed (328) | 97.26 / 93.07 / 95.5 / 98.61 |
| `packages/smithers/control/vitest.config.ts` | PASS | 2450 passed ; 2 skipped (2452) | 100 / 100 / 100 / 100 |
| `packages/smithers/flows/artifacts/vitest.config.ts` | PASS | 415 passed (415) | 100 / 100 / 100 / 100 |
| `packages/smithers/flows/canonical/vitest.config.ts` | PASS | 345 passed (345) | 100 / 100 / 100 / 100 |
| `packages/smithers/flows/capability/vitest.config.ts` | FAIL | 4 failed ; 966 passed (970) | suite failed |
| `packages/smithers/flows/core/vitest.config.ts` | PASS | 117 passed (117) | 100 / 100 / 100 / 100 |
| `packages/smithers/flows/crypto/vitest.config.ts` | PASS | 251 passed (251) | 100 / 100 / 100 / 100 |
| `packages/smithers/flows/database/vitest.config.ts` | PASS | 684 passed (684) | 100 / 100 / 100 / 100 |
| `packages/smithers/flows/engine-store/vitest.config.ts` | PASS | 4,474 passed (2,237 per backend) | 100 / 100 / 100 / 100 |
| `packages/smithers/flows/engine/vitest.config.ts` | PASS | 617 passed (617) | 100 / 100 / 100 / 100 |
| `packages/smithers/flows/flow/vitest.config.ts` | PASS | 976 passed (976) | 100 / 100 / 100 / 100 |
| `packages/smithers/flows/jj/vitest.config.ts` | PASS | 431 passed ; 1 skipped (432) | 100 / 100 / 100 / 100 |
| `packages/smithers/flows/journal/vitest.config.ts` | PASS | 1658 passed (1658) | 100 / 100 / 100 / 100 |
| `packages/smithers/flows/kernel/vitest.config.ts` | PASS | 863 passed (863) | 100 / 100 / 100 / 100 |
| `packages/smithers/flows/keys/vitest.config.ts` | PASS | 80 passed (80) | 100 / 100 / 100 / 100 |
| `packages/smithers/flows/observability/vitest.config.ts` | FAIL | 1 failed ; 217 passed (218) | suite failed |
| `packages/smithers/flows/patterns/vitest.config.ts` | FAIL | 2 failed ; 717 passed (719) | suite failed |
| `packages/smithers/flows/plan-store/vitest.config.ts` | PASS | 100 passed (100) | 100 / 100 / 100 / 100 |
| `packages/smithers/flows/plan/vitest.config.ts` | PASS | 2342 passed (2342) | 100 / 100 / 100 / 100 |
| `packages/smithers/flows/platform-browser/vitest.config.ts` | PASS | 359 passed (359) | 100 / 100 / 100 / 100 |
| `packages/smithers/flows/platform-cloudflare/vitest.config.ts` | PASS | 163 passed ; 13 skipped (176) | 100 / 100 / 100 / 100 |
| `packages/smithers/flows/platform-node/vitest.config.ts` | FAIL | 9 failed ; 1289 passed ; 11 skipped (1309) | suite failed |
| `packages/smithers/flows/run-store/vitest.config.ts` | PASS | 640 passed (640) | 100 / 100 / 100 / 100 |
| `packages/smithers/flows/sandbox/vitest.config.ts` | PASS | 862 passed ; 31 skipped (893) | 100 / 100 / 100 / 100 |
| `packages/smithers/flows/secrets/vitest.config.ts` | PASS | 107 passed (107) | 100 / 100 / 100 / 100 |
| `packages/smithers/flows/step-cache/vitest.config.ts` | PASS | 540 passed (540) | 100 / 100 / 100 / 100 |
| `packages/smithers/flows/sync/vitest.config.ts` | FAIL | 1 failed ; 653 passed (654) | suite failed |
| `packages/smithers/flows/time-travel/vitest.config.ts` | PASS | 1486 passed (1486) | 100 / 100 / 100 / 100 |
| `packages/smithers/flows/vitest.config.ts` | FAIL | 1 failed ; 234 passed (235) | suite failed |
| `packages/smithers/gateway/vitest.config.ts` | FAIL | 2 failed ; 915 passed (917) | suite failed |
| `packages/smithers/mcp/vitest.config.ts` | PASS | 423 passed (423) | 100 / 100 / 100 / 100 |
| `packages/smithers/migrate/vitest.config.ts` | PASS | 926 passed ; 11 skipped (937) | 96.14 / 89.05 / 96.5 / 97.94 |
| `packages/smithers/notifications/vitest.config.ts` | PASS | 291 passed (291) | 100 / 100 / 100 / 100 |
| `packages/smithers/ui/views/vitest.config.ts` | PASS | 243 passed (243) | 100 / 100 / 100 / 100 |

Additional observed failures (unchanged implementation/tests outside this repair):

`packages/smithers/agent`:

- `test/EngineChildren.test.ts > EngineChildren.spawn > does not start abandoned work when a dependency recovers after timeout`
- `test/Fault.sweep.test.ts > the fault sweep > registers a class for every tagged error an owner declares`

`packages/smithers/build/build-cli`:

- `test/AffectedFired.test.ts > affected does not report an exclusive dependency that ran through a named root as omitted`
- `test/AffectedFired.test.ts > affected reports an exclusive dependency's failed execution accurately`
- `test/AgentLaneExecution.test.ts > Agent.Diff dispatch > runs the gates against the exact candidate per round, applies the accepted candidate, replays from cache, and preserves an exhausted candidate`
- `test/AgentLaneExecution.test.ts > Agent.Diff service gates > starts a gate's services from the candidate tree, so the served smoke test judges the candidate`
- `test/AgentLaneExecution.test.ts > Git.Commit dispatch > stages, gates the candidate tree, composes the message, and commits; a red gate refuses`
- `test/AgentLaneExecution.test.ts > Git.Commit dispatch > judges the gates against the tree being committed, not the working tree`
- `test/DocsPageLane.test.ts > Docs.Page execution > writes the one output through the Agent.Diff lane and rejects any other path`
- `test/MultiPattern.test.ts > multiple patterns > lint runs the union of every pattern`
- `test/NodeLaneExecution.test.ts > Node lane package execution > confines Changesets.Version writes and distinguishes check/write`
- `test/NodeLaneExecution.test.ts > Node lane package execution > builds overlay consumers in scratch, caches outputs, and leaves source bytes untouched`
- `test/NodeLaneExecution.test.ts > Node lane package execution > keeps an overlay private to its own consumer and refuses rules with no scratch mount`
- `test/PackageExecution.test.ts > bare-label execution and verb mapping > reports drift for a Generate target whose write set lies inside a nested package`
- `test/PackageExecution.test.ts > bare-label execution and verb mapping > defaults a Diff target to check mode, applies with --write, and leaves check green after`
- `test/PackageExecution.test.ts > external-write confinement through escaping symlinks > reverts and fails a check-mode dry-run that touches the real tree through a symlink`
- `test/PackageExecution.test.ts > generate > checks script drift against a scratch copy and applies with --write`
- `test/PackageExecution.test.ts > generate > runs the bin form through the same check, drift, and write bracket`
- `test/PackageExecution.test.ts > generate > captures the stdout form inside the same check and write bracket`
- `test/RawErrorSites.test.ts > raw failure sites under src > match the reviewed plain Error count in every file`

`packages/smithers/build/targets`:

- `test/GithubWorkflow.test.ts > parseWorkflow > parses the Smithers repository's own pipeline`

`packages/smithers/flows/capability`:

- `test/CapabilityLiterals.test.ts > HARDEN-2: every staged capability literal grants something > .smithers/factory.json:1625 net:put:registry.npmjs.org/**`
- `test/CapabilityLiterals.test.ts > HARDEN-2: every staged capability literal grants something > .smithers/flows/README.md:38 proc:spawn: *`
- `test/CapabilityLiterals.test.ts > HARDEN-2: every staged capability literal grants something > .smithers/flows/pack.test.mjs:266 proc:spawn:`
- `test/CapabilityLiterals.test.ts > HARDEN-2: every staged capability literal grants something > .smithers/flows/release/publish/flow.ts:75 net:put:registry.npmjs.org/**`

`packages/smithers/flows/observability`:

- `test/NoConsole.test.ts > console guard > holds the teaching file to the console lines its worked example spells`

`packages/smithers/flows/patterns`:

- `test/BurndownJournal.test.ts > Burndown journal > journals the first item's landing and release before the second item's work finishes`
- `test/BurndownJournal.test.ts > Burndown journal > replays a recorded landing when the round runs again after a crash, instead of landing twice`

`packages/smithers/flows/platform-node`:

- `test/NativeRuntimeRestart.test.ts > resumes plain after SIGKILL with edited-body (changed=true)`
- `test/NativeRuntimeRestart.test.ts > resumes continuation after SIGKILL with edited-continuation (changed=true)`
- `test/NodeRuntimeReap.integration.test.ts > a host that was killed > starts no jj probe, so its live child is the only process it journals`
- `test/NodeRuntimeReap.integration.test.ts > a host that was killed > leaves nothing running, and the next incarnation retires the record without a signal`
- `test/NodeRuntimeReap.integration.test.ts > a host that was killed > leaves a group nothing could stop for the next incarnation of the same host to reap`
- ``test/NodeRuntimeReap.integration.test.ts > a host that was killed > names the abandoned group in `orphans` before anything signals it``
- `test/NodeRuntimeSignals.integration.test.ts > a signalled host > releases the run it was driving and exits on its own`
- `test/NodeRuntimeSignals.integration.test.ts > a signalled host > leaves on a second signal when the graceful shutdown will not finish`
- `test/NodeRuntimeSignals.integration.test.ts > a signalled host > leaves when a graceful shutdown outlasts its deadline`

`packages/smithers/flows/sync`:

- `test/PresenceRoom.test.ts > PresenceRoom > keeps host data on the connection and out of every frame`

`packages/smithers/flows`:

- `❯ test/examples/37-host-containment.test.ts (9 tests | 1 failed) 3894ms`

`packages/smithers/gateway`:

- `test/examples/37-host-containment.test.ts > reaps the process group a killed host left running`
- `test/GatewayProjection.test.ts > GatewayProjection.approvals > keeps a committed agent grant when its observed wait carries the grant token`
- `test/GatewayServer.test.ts > the assembled gateway over a real loopback bind > answers an unreadable selector as a defect, not as a refusal`

The build CLI diagnostics include Linux confinement refusing a missing read-only path beneath a writable mount, and 19 plain errors in Cli.ts against the reviewed count of 18. The agent fault sweep identifies unregistered RealmFlowError. The targets parser expectation still names five removed pipeline jobs. These failures are retained for the owning workstreams; this repair changes no runtime behavior to conceal them.

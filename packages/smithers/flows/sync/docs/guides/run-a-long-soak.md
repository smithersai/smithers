---
title: "Run the optional long soak"
description: "Execute and verify repeated resource-growth samples across TCP reconnects, compaction, retention and a stalled sync consumer."
---

Ordinary package gates keep the bounded `ServerSoak.test.ts` tests. The timed
tier is off until `SMITHERS_SOAK_MINUTES` is set. Run from the sync package:

```sh
SMITHERS_SOAK_MINUTES=60 \
SMITHERS_SOAK_ARTIFACT=/tmp/sync-soak/node26.json \
pnpm exec vitest run test/ServerLongSoak.test.ts --maxWorkers=1 --coverage.enabled=false
node test/fixtures/verify-soak.ts /tmp/sync-soak/node26.json 60
```

The focused timed tier does not replace the full package coverage gate. It
spawns the same Node executable with `--expose-gc`. Supported pinned lane
runtimes are Node 26.4.0 and 26.10.0. Minutes must be finite and within 1..720.
The artifact path is required. For a bounded local rehearsal use 3 minutes,
and label the receipt as local bounded evidence.

The workload uses an on-disk SQLite journal and schema-aware NDJSON RPC over
loopback TCP. Each cycle appends eight entries and opens four concurrent
connections. Each consumer reconstructs the complete count and checks its
applied cursor. A separate workspace consumer stalls inside `apply` for the
whole measurement. Journal changes are also held unread to measure their
bounded queue. Compaction advances a checkpoint while retaining 32 history
rows, collects superseded checkpoints, and repeatedly triggers snapshot
recovery in reconnecting clients. This exercises retention of history and
checkpoints, not whole-run deletion or retention of externally stored blobs.

## Artifact verifier contract

`test/soakArtifact.ts` defines schema version 1. CI must run the independent
`verify-soak.ts` command and fail on missing, malformed, incomplete, or failed
artifacts. The exit code of the workload is also required; a JSON file alone
is not a passing job. Preserve stdout/stderr and the JSON even on failure.

Required top-level fields:

| Field                     | Contract                                                                                                                                                       |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`, `status` | `1` and `complete` for a passing receipt; failure is explicit.                                                                                                 |
| `runtime`                 | Exact Node version, platform, architecture.                                                                                                                    |
| `candidate`               | Git head, dirty flag, SHA-256 over sorted sync source paths and bytes. A dirty local receipt is not immutable release certification.                           |
| `workload`                | Requested minutes, seed `20260904`, warmup `20000` ms, sampling interval `10000` ms.                                                                           |
| `samples`                 | At least five strictly increasing post-warmup checkpoints, continued useful work, no sample gap over 30 seconds, final sample at or beyond requested duration. |
| `slopes`                  | Ordinary least-squares regression of every metric against elapsed minutes. The verifier recomputes these values.                                               |
| `cleanup`                 | Zero active journal reads, pending writes, stalled subscribers and connected TCP sockets after scope release.                                                  |
| `failure`                 | Diagnostic reason when the run fails.                                                                                                                          |

Every sample must carry elapsed time, cycle count, emitted events, connections,
compactions, retained event/checkpoint counts, stalled-subscriber count, and
all metrics below. Memory is measured after explicit GC. Handles come from
Node's `_getActiveHandles`; connected sockets are actual `net.Socket` handles.
Queues measure outstanding journal reads/writes, socket readable/writable
bytes, and the stalled journal notification subscription. These are named
observed queues, not a claim to inspect every runtime-internal RPC queue.

| Metric                                                             | Maximum positive slope per minute |
| ------------------------------------------------------------------ | --------------------------------- |
| Retained heap                                                      | 1 MiB                             |
| RSS                                                                | 4 MiB                             |
| Open handles, connected sockets                                    | 0.5 each                          |
| Active journal reads, pending writes, queued journal notifications | 1 each                            |
| Queued socket bytes                                                | 64 KiB                            |
| Database bytes, WAL bytes                                          | 1 MiB each                        |

The verifier also requires at most 40 retained events, exactly one retained
checkpoint, exactly one stalled subscriber during sampling, zero pending
writes at checkpoints, and bounded journal notifications. SQLite's normal WAL
policy remains active; samples do not truncate the WAL to manufacture a flat
curve. The thresholds are provisional regression budgets, not a production
capacity or latency guarantee. Run the scheduled tier on a controlled host
and retain at least 30 days of artifacts for baseline comparison.

The scheduled owner should run a fresh 60-minute job on each pinned Node
version, serially or on separate workers, without a cached test result. A
three-minute local success verifies the harness and its bounded observation;
it does not close the hours-long leak campaign or certify remote CI execution.

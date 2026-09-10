# Deterministic performance gates

`node scripts/bench/gate.mjs` is the required PR target
`//scripts:benchmarkGate`. It executes 18 fixtures: scheduler chain, wide and
shared-write conflict graphs of 8, 32 and 64 nodes, and journal append, reopen
replay and 31-entry paging over 32, 256 and 1,024 events.

The scheduler, durable stores, and SQLite driver are production implementations.
The executor returns known arithmetic results and the filesystem boundary and
jj service are deterministic fixtures. This tier measures scheduling and SQL,
not actual filesystem syscalls, subprocess spawn cost or native jj operations.
Every node must settle as built exactly once with its independent expected
result; chained execution must preserve order and shared writes must serialize.
Journal reads reopen the actual SQLite file through a fresh connection and
compare all sequence numbers and complete payloads. Reducing useful work cannot
earn a lower cost result.

## Baseline and noise

`baseline.json` records the fixture roster, size, independently validated output
SHA-256, actual SQLite statement execution counts, statement allocations
(`prepares`), direct `exec` calls, scheduler dispatches and paging calls.
Instrumentation wraps the real Node SQLite methods in the isolated benchmark
process and is restored in `finally`. Migrations and setup are outside the
measured region. There is no wall-time threshold in the PR verdict.

Each counter may increase at most 5%, rounded up. This small allowance covers
legitimate scheduler interleaving differences. Zero remains zero. Missing or
non-finite counters, changed outputs, reduced inputs and roster changes fail.
Counter reductions still require all output assertions. The baseline is a
checked input, never automatically updated by CI. `--candidate` writes a
proposed measurement to an artifact directory; a reviewer must inspect changed
costs and semantics before editing the baseline. A broad performance claim
also needs the owning package's differential, fault and coverage gates.

## Scheduled observations

The `benchmark-observations` job runs
`node --expose-gc scripts/bench/gate.mjs --measure` on Ubuntu and Node 22.19.0.
One cold corpus records first-process/JIT observations. One corpus warms up
without contributing to the repeated samples. Three subsequent warm corpora
reuse loaded code and JIT state but each uses new SQLite files and connections.
GC is requested before and after each measured repetition. This is an explicit
warm-code/cold-storage policy, not a claim to flush the host's OS page cache.

Artifacts contain elapsed time, validated operations per second, fixture size,
and output hash. Scheduled journal cases also retain every durable append
receipt/page-read latency with empirical nearest-rank percentiles: p95 requires
at least 20 samples and p99 at least 100, otherwise the value is null. These are
observed samples for this workload, not established service-level guarantees.
The artifacts also include retained heap,
RSS, descriptor counts where available, active handles and sockets, and database,
WAL and SHM bytes while connections are open. Raw samples are retained rather
than presenting a three-repetition p99 as a statistically established tail.
Counters still gate every repeated sample. Timing observations are advisory
measurements pending controlled-runner baselines; they are not PR thresholds.

`SMITHERS_BENCH_ARTIFACT_DIR` selects a fresh output directory. A completed
`result.json` is never overwritten; failure writes `failure.json` and throws.
Any nonempty artifact directory is refused, including one containing only a
prior failure, so stale partial results cannot enter a new run.
CI uploads even on failure and retains results for 30 days. Temporary database
directories are removed on both success and handled failure. Process termination
can leave OS temporary files, but cannot write a completed result. The scheduled
sync soak is a separate lifecycle/growth tier; its receipt verifier is
`scripts/check-soak-campaign.mjs`.

The upload-on-failure and 30-day retention policy above applies to the scheduled
`benchmark-observations` job. The generated PR workflow collects and uploads
`ci-test-tier-evidence`, including `/tmp/smithers-benchmark-*`, under
`if: always()`, so a failed PR step still uploads whatever receipts exist. It
permits missing files (`if-no-files-found: ignore`) and its generator exposes
no retention control, so a lost runner or an unwritten receipt yields no
artifact and no error. Local failed receipts remain on disk.

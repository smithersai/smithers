# Lineage read benchmark

Run `pnpm --filter @smthrs/run-store bench test/LineageRead.bench.ts`.
To include a private copy of an existing SQLite store, set
`SMITHERS_RUN_STORE_BENCH_DB` to its absolute filename. The benchmark opens
that copy read-only, without migrations, and prints counts and timings only.
Do not commit a store or publish its contents.

The script and `LineageReadFixture.ts` run unchanged on the baseline:
the old `lineage` implementation ignores the new second argument and returns
full rows. The generated fixtures contain 10, 100 or 1,000 completed rounds
and one pending round. Each has a distinct roughly 37 KB state and one equally
large journal payload. Setup uses the public store, outside timing, and warms
its bounded admission cache.

A sweep reads every lineage root and checks that the total row count matches
the database. The first sweep is reported separately; the table is the mean
of five subsequent sweeps. The injected SQL client observes actual payload
bytes returned by production SQLite without replacing queries or results.
The regression test asserts zero payload bytes, never elapsed time.

Measured with Node 26.5 on isolated Linux boxes with four virtual CPUs.
Baseline: `7035d5968807`; after: the metadata projection in this change.

| Fixture                               | Before ms/sweep | After ms/sweep | Before state bytes/sweep | After state bytes/sweep |
| ------------------------------------- | --------------: | -------------: | -----------------------: | ----------------------: |
| 10 ended, 1 open                      |           1.374 |          0.457 |                  413,546 |                       0 |
| 100 ended, 1 open                     |          11.707 |          0.975 |                3,797,187 |                       0 |
| 1,000 ended, 1 open                   |       1,595.738 |          9.609 |               37,634,488 |                       0 |
| Retained store: 258 runs, 40 lineages |       1,145.391 |          9.467 |               10,263,923 |                       0 |

The retained store held 248 ended runs and 10 suspended runs. Sweeping all
lineages exceeds the old four-million-character admission cache, so subsequent
reads keep revalidating old states. Metadata projections return zero payload
bytes on the first read as well as subsequent reads.

These are measurements of this read, not end-to-end engine throughput or a
claim that leases cannot lapse. Metadata enumeration still costs O(rounds);
the improvement removes JSON work and transfer proportional to historical
payload size. The default full-state API retains its original semantics.

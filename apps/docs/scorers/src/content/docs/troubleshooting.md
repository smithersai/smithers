---
title: "Troubleshooting"
description: "The failures @smthrs/scorers reports, what each one means, and what to change: refused declarations, out-of-contract scores, rejected observations, lost retries, and moved sampling decisions."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/scorers/docs/troubleshooting.md"
---

Every failure this package reports is a `ScorerError` carrying one of eight
stable codes, or a thrown one of the same shape at plan time. Find the code or
the symptom and read the matching section. The complete code table is in the
[API reference](/reference/api/#failures).

## Scorer.make threw instead of failing

**What happened.** `Scorer.make` is a plan-time constructor: a bad declaration
is a programming error with no run to fail, so it throws a `ScorerError` with
code `invalid_declaration` rather than returning a failed `Effect`.

**What to change.** Catch it with `try`/`catch` in a test, and fix the
declaration in production. The message names the problem:

`A scorer must not declare OPTION; use score as its only implementation` names
a refused `body`, `model`, or `flows` option. Remove the option, even if its
value is `undefined`, and implement scoring in `score`.

| Message                                                                | Cause                                                            |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `A scorer id must be a string`                                         | `id` is not a string.                                            |
| `A scorer id must not be empty`                                        | `id` is blank or whitespace.                                     |
| `A scorer version must be a string`                                    | `version` is not a string.                                       |
| `A scorer version must not be empty`                                   | `version` is blank or whitespace.                                |
| `A scorer configuration must be representable as canonical JSON: PATH` | `config` carries something canonical JSON would drop, at `PATH`. |
| `A scorer configuration could not be inspected`                        | A getter or a proxy trap in `config` threw while it was walked.  |
| `A scorer configuration could not be canonicalized`                    | The canonical encoder refused `config` outright.                 |

The path form names what is wrong without printing the value: `config.rubric is
function`, `config.nested.deep[1] is undefined`, `config.when defines toJSON`,
`config.chain is nested deeper than 1000 levels`. A `Map`, a `Set`, a class
instance, a typed array, or a `RegExp` reaches the last row. See
[Declare a scorer](/guides/declare-a-scorer/#declarations-refused-at-plan-time).

## Calling the scorer raises FlowError missing_body

**What happened.** A scorer is a declaration-only flow. Calling the flow value
itself has no implementation to reach, so it raises `FlowError` with code
`missing_body`, the same as any body-less flow.

**What to change.** Call `scorer.score(input)`, or hand the scorer to a
[runner](/guides/run-a-batch-of-scorers/). `Scorer.MakeOptions` has no
`body`, `model`, or `flows` field. `Scorer.make` also rejects these options at
runtime, so dynamic-body options cannot give the scorer a second implementation.

## An observation came back inconclusive with code invalid_score

**What happened.** The scorer answered, and the answer did not satisfy
`Scorer.Result`: a `score` that is missing, not finite, or outside the
inclusive `[0, 1]` range. The runner validates every result before it records
one, so the run continued and the failure was recorded rather than thrown.

**What to change.** Clamp or normalize inside the scorer. The observation's
reason carries the validation failure, which names the offending score:

```text
A scorer result must carry a finite score in [0, 1], received 2
```

A score of exactly 0 or exactly 1 is legal. It is the ratio in a
[sampling policy](/concepts/sampling/) that excludes its endpoints, not a
score.

## invalid_sampling

**What happened.** `Sampling.decide` was handed a policy outside the
vocabulary: a ratio of `0` or `1`, a ratio outside `(0, 1)`, a non-finite
ratio, or an empty seed.

**What to change.** Use `"all"` and `"none"` for the endpoints, and keep a
ratio strictly between them with a non-empty seed. The bound is in the schema,
so building the policy through `Sampling.Sampling` catches it before a run
carries it anywhere.

## invalid_observation

**What happened.** The store refused to persist an observation. It validates
and fully encodes before the transaction opens, so nothing partial was written.

**What to change.** Match the message to the rule:

| Message                                                                   | Rule                                                                                                                                                    |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `does not match the durable observation contract`                         | Blank `targetStepKey` or `scorerKey`, a negative or non-integral `at`, a score outside `[0, 1]`, or an inconclusive row missing its `reason` or `code`. |
| `An observation reason exceeds 1024 UTF-8 bytes`                          | `reason` is over `ScoreStore.maxReasonBytes`.                                                                                                           |
| `Score observation metadata is not representable as canonical JSON: PATH` | `meta` carries a member canonical JSON would drop, at `PATH`.                                                                                           |
| `Score observation metadata exceeds 65536 UTF-8 bytes`                    | Encoded `meta` is over `ScoreStore.maxMetadataBytes`.                                                                                                   |
| `An observation could not be snapshotted`                                 | A getter on the observation threw while it was copied.                                                                                                  |

Producers inside this package truncate a reason on a code-point boundary rather
than failing. A direct caller is told instead of silently trimmed. The full
rule set is in [Durability](/durability/#what-the-store-refuses-to-persist).

## invalid_request

**What happened.** A store call argument was outside its documented bounds: a
blank or oversized job identity, or a page bound that is not a safe integer in
range.

**What to change.** Build identities with `Runner.jobIdentity` and keep them
within `ScoreStore.maxIdentityBytes` (512 UTF-8 bytes). Keep `limit` in
`[1, 1000]`, and `offset` and `before` non-negative safe integers. The message
names the value it was given.

## constraint

**What happened.** The database refused the write as a constraint violation.
The table repeats the observation rules as SQL `CHECK` constraints, so this is
usually a row that bypassed the service, or a schema older than the code.

**What to change.** Retrying cannot fix it, so do not build a retry ladder
around this code. Write through `ScoreStore`, never with a hand-written
`INSERT`, and let `SqlScoreStore.layer` apply the migrations.

## store

**What happened.** Any other persistence failure, including transient ones. The
message names the database's own code, as in
`Could not record score observation (database: busy)`.

**What to change.** Transient codes are worth retrying; a decode failure naming
a row id is not:

```text
Stored observation 41 does not match the durable observation contract
```

That row was written by something other than this store. The id is in the
message so you can find and repair it.

## recordOnce returns false and no observation is stored

**What happened.** The identity is already claimed, so the write is suppressed
as a duplicate. Two different units of work derive the same identity, and only
the first one was recorded. The mirror defect is an identity that is not stable
across a restart: every retry claims a fresh one and appends a second row for
work that was already scored.

**What to change.** Derive the identity from durable values only: a run id, the
target step key, and the scorer key. Never a process id, a random value, or a
wall clock. Build it with `Runner.jobIdentity`, which length-prefixes each
component so two different tuples cannot collide. See
[Record a score exactly once](/guides/record-a-score-once/).

## A ratio decision differs from one taken earlier

**What happened.** `Sampling.decide` is a pure function of the target step key,
the scorer key, and the seed, so a decision moves only when one of those three
moves. A seed rebuilt per process, a target step key that carries a run id, or
a bumped scorer `version` or changed `config` each give every step a fresh
decision.

**What to change.** Pin the seed to a durable value, keep run-specific data out
of the target step key, and treat a `version` bump as the start of a separate
sampling history. The hash encoding itself is frozen by golden vectors, so it
cannot move without a failing test; changing it deliberately would be a data
migration rather than a patch. See
[Replay-stable sampling](/concepts/sampling/).

## Two scorers share one key

**What happened.** `scorerKey` is `sha256` over the canonical JSON of
`{id, version, config}`. Two declarations agreeing on all three are one scorer
by definition.

**What to change.** Move whatever distinguishes them into `config`, or bump
`version`. A value that lives only in the `score` closure does not participate
in the key, and neither does the `context` a binding supplies. See
[Scorer identity](/concepts/scorer-identity/).

## An aggregate mean looks too good

**What happened.** `count`, `mean`, and `min` describe successful scores only.
A target where ninety-nine attempts were inconclusive and one returned `1.0`
reports `mean: 1`.

**What to change.** Read `inconclusive` beside `mean`. It is the denominator,
and it is the reason `aggregate` reports it. See
[Observations](/concepts/observations/#what-an-aggregate-means).

## A batch reported success but nothing was stored

**What happened.** A store failure never fails a batch. It is logged as a
warning, so `runBatch`, which returns observations only, records what each
scorer answered rather than what was persisted.

**What to change.** Use `runBatchCorrelated`, whose `recorded` field is
`"persisted"`, `"duplicate"`, or `"failed"` per job. Read the logs for the
warning that names the underlying error.

## submit stopped returning

**What happened.** `submit` backpressures once `capacity` queued jobs are
outstanding. It does not wait for a scorer to run, but it does wait for room in
the queue, so it is not safe on a latency-critical path.

**What to change.** Raise `capacity` or `concurrency` on `RunnerLive.layer`, or
move submission off the critical path. A value that is not a positive safe
integer is coerced to the default (1 and 1024) rather than rejected, so check
that the number you passed is one.

## The database refuses to open under Bun

**What happened.** `NodeDatabase.layer` from [`@smthrs/database`](https://database.smithers.sh/reference/api/)
runs the durable engine on Node.js only and raises `unsupported_runtime`
otherwise.

**What to change.** Run on Node.js 26.4.0 or later, or compose
`ScoreStore.layerNoop` when the process does not need persistence.

## Importing a module fails with ERR_PACKAGE_PATH_NOT_EXPORTED

**What happened.** `@smthrs/scorers/internal/*`,
`@smthrs/scorers/migrations/*`, and `@smthrs/scorers/*/index` are blocked in
the export map.

**What to change.** Import the root namespace (`Migrations` for the migration
aggregator) or a top-level module subpath. See
[Installation](/installation/#import-forms).

## The score tables keep growing

**What happened.** Nothing prunes `flows_scores` or `flows_score_jobs`. There
is no garbage collection path and no automatic expiry.

**What to change.** A deployment that scores every step of a long-running flow
owns that growth. Bound what you score with a
[sampling policy](/concepts/sampling/), and delete outside this package when
you need retention. See [Durability](/durability/#retention).

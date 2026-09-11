---
title: "Determinism and canonical artifacts"
description: "Caller-supplied run identity, deterministic sampling, and byte-stable serialization."
sidebar:
  order: 3
---

The runner guarantees determinism only for what it controls. Given identical
executor results, scorer results, metadata, and run options, two runs produce
byte-identical observations, and two identical comparisons produce
byte-identical reports. Ordering, sampling, job identity, and serialization are
stable by construction, through four decisions.

The runner cannot make your callbacks deterministic. `Runner.run` invokes every
executor and scorer effect afresh on each run, so the caller owns every input
those effects read: clocks, model responses, randomness, external state, and
mutation inside a callback. A scorer that counts its own calls grades the same
suite `0` on the first run and `1` on the second, with identical options.

## Identity and time come from the caller

`Runner.run` takes `runId` and `at` as options. `runId` identifies the
`RunResult` and joins every score job's identity; `at` stamps every
observation. The runner itself reads no clock and generates no identifier.
Pin `at` to a fixed instant when you want a suite to be comparable across days:
observation timestamps are report material, and pinning them keeps two runs
with stable callbacks byte-identical.

The format is strict because reproducibility is strict: `at` must be a
canonical UTC timestamp with millisecond precision that parses and re-renders
to itself, and anything else fails with `invalid_run_options`.

## Sampling is decided, not rolled

A binding's sampling policy selects which executions a scorer grades, and the
selection is a pure function of the policy, the step key, and the scorer key.
The same run over the same inputs samples the same executions every time, so a
sampled baseline stays comparable with the next sampled run. For the policy
types, see the [scorers API](/api/scorers).

## Job identity is injective

Every score job carries an identity built from the suite name, run identity,
sample identity, case, step key, scorer key, and the job's index, encoded as a
JSON array. Encoding a tuple rather than joining strings on a delimiter is
what makes the identity injective: two distinct jobs can never produce one
identity, so a correlated batch runner can always attribute its results.

## Serialization is total and canonical

`Baseline.write` and `Report.json` share one encoder. It sorts object keys by
code unit, drops `undefined` members, and normalizes negative zero. Everything
JSON cannot express becomes a bracketed marker that names what was there:
`[circular]`, `[depth exceeded]`, `[NaN]`, `[Infinity]`, `[-Infinity]`,
`[bigint n]`, `[function]`, `[symbol]`, and `[unreadable: …]` when a foreign
operation throws. An `Error` becomes an object holding its own fields plus
`name` and `message`. A `Date` becomes its ISO string, a `Set` becomes an
array, and a `Map` becomes an array of key/value pairs. Embedded strings are
capped at 8192 code units and nesting at 64 levels.

The encoder is total: a report of a broken run is still a report, never a
thrown `RangeError` out of a function typed `string`. And it redacts nothing:
a suite whose cases carry secrets must not print the report where the log is
readable.

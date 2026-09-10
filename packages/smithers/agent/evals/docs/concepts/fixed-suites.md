---
title: "Fixed suites"
description: "Why a suite is validated once, snapshotted, and frozen, and how a binding finds its target."
sidebar:
  order: 1
---

A fixed suite is the input half of an evaluation: named cases, the scorer
bindings that grade them, and the concurrency the runner is allowed. "Fixed"
is the load-bearing property. A committed baseline says "this suite scored
these numbers", and that sentence is only meaningful when the suite that
produced the baseline is the suite being run. So a suite is validated once, at
construction, and then never changes.

## The snapshot

`Suite.make` reads every option, case field, and binding field once when the
effect runs. It validates the data before copying it with `structuredClone`,
then deeply freezes the suite, cases, binding records, and copied data.
Mutating the caller's data or attempting to edit the returned snapshot cannot
change the validated suite.

Case input, expected values, and binding sampling, ground truth, and context
admit only these values:

- Plain objects with `Object.prototype` or a null prototype, and ordinary arrays.
- Enumerable, string-keyed data properties. Accessors, symbol keys, and
  non-enumerable properties are rejected, except for the array `length` property.
- Cloneable primitives: null, undefined, booleans, strings, numbers, and bigints.
  Numbers include NaN, infinities, and negative zero.

Cycles and shared references within a data field are preserved. Null-prototype
records become ordinary objects when cloned. Functions, symbols, class
instances, and other non-plain objects fail with `invalid_suite` at the
nested field path. This includes Map, Set, Date, RegExp, buffers, and typed
arrays: freezing these objects does not protect all their mutable state.
Nested getters are rejected without invocation. Getters on the outer options,
case, and binding fields are read once before data validation.

Each executor invocation receives its own mutable case copy. Each scorer
request receives independent copies of the original case input, expected
value, and binding data. Executor mutations do not change scorer ground
truth or input, and scorer mutations do not change another request or a later
run. Sequential and concurrent runs reuse the same protected snapshot.
Execution output remains the executor's value and is outside the fixed-suite
data contract.

## Bindings and identity

A binding says "this scorer grades that flow", and the match is by reference
identity: a run grades an execution with a binding only when the execution's
`target` is the very flow value the binding's `appliesTo` holds. A structurally
equal copy of the flow is graded by nothing.

Identity is what makes a binding durable. Two declarations of a flow with the
same name are different flows, and a baseline recorded against one says
nothing about the other. Reference identity makes that distinction exact
instead of approximate.

The scorer has the same split between identity and label. `Observation.scorer`
is the scorer key, a digest of the scorer's own `{ id, version, config }`
declaration, and it is what a baseline matches on: change the declaration and
the old scores no longer claim to describe the new scorer.
`Observation.scorerName` is the human name from the same declaration, carried
alongside so a report can be read without grepping for the digest. A Markdown
report prints `name (first 8 of the key)`, and the bare key when the
declaration carries no name. Report cells, gate summaries, and runner
diagnostics share that one rule, so a report never names one scorer two ways.

For the scorer, binding, and sampling types themselves, see the
[scorers API](/api/scorers).

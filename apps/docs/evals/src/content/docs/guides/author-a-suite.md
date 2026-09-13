---
title: "Author a suite"
description: "Declare fixed cases and scorer bindings, or load them from a JSON Lines fixture."
sidebar:
  order: 1
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/evals/docs/guides/author-a-suite.md"
---

A suite is the fixed input half of an evaluation: named cases, the scorer
bindings that grade them, and the concurrency the runner is allowed. Build one
with `Suite.make`, or load cases from a JSON Lines fixture with
`Suite.fromJsonLines`.

## Declare cases

A case is a name, an `input` handed to the executor, and an optional
`expected` offered to a bound scorer as ground truth:

```ts
const cases = [
  { name: "adds numbers", input: { left: 1, right: 2 }, expected: 3 },
  { name: "multiplies numbers", input: { left: 2, right: 4 }, expected: 8 }
]
```

When a case declares `expected` and the binding also declares `groundTruth`,
the case's value wins. A declared `null`, `false`, `0` or `""` is a value and
wins too; only an absent `expected` defers to the binding. When neither
declares one, the scorer is called without ground truth.

Case names must be non-empty, unique within the suite, and free of control
characters. A control character in a name corrupts Markdown reports and CI log
lines, so it is rejected where the name enters the system.

## Bind scorers

A binding attaches a scorer to the flow it grades:

```ts
import { Binding } from "@smthrs/scorers"

const bindings = [Binding.make({ scorer: polite, appliesTo: greet })]
```

`appliesTo` is matched against an execution's `target` by reference identity,
so the binding grades only the exact flow value it was declared against; a
structurally equal copy is graded by nothing. `Binding.make` also accepts
`groundTruth`, `context`, and a `sampling` policy, and defaults to scoring
every target step. For the binding and sampling types, see the
[scorers API](https://scorers.smithers.sh/reference/api/).

`Suite.make` copies each binding's data fields with `structuredClone` but
keeps `scorer` and `appliesTo` by reference: they are executable identities,
and copying them would break the identity match.

## Validate at construction

`Suite.make` fails with `invalid_suite` when the declaration is wrong, and
each failure locates the offending value in `path`:

| Failure                                                                                  | Path                                                                                                            |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Suite name is empty or holds a control character                                         | `name`                                                                                                          |
| No cases, or more than `limits.cases` cases                                              | `cases`                                                                                                         |
| Concurrency is not a safe integer in [1, `limits.concurrency`]                           | `concurrency`                                                                                                   |
| Case name is empty, holds a control character, or duplicates another case                | `cases[N].name`                                                                                                 |
| Case or binding data is not structured-cloneable, such as a function or a class instance | `cases[N].input`, `cases[N].expected`, `bindings[N].sampling`, `bindings[N].groundTruth`, `bindings[N].context` |

The clone check doubles as the suite's immutability guarantee: the copy is
what the suite keeps, so mutating the caller's objects afterwards leaves the
validated suite unchanged.

## Load cases from JSON Lines

For fixtures, `Suite.fromJsonLines` decodes one `{ name, input, expected? }`
object per line and passes the result through the same validation:

```json
{"name":"adds numbers","input":{"left":1,"right":2},"expected":3}
{"name":"multiplies numbers","input":{"left":2,"right":4},"expected":8}
```

```ts
import { Suite } from "@smthrs/evals"
import { Effect } from "effect"
import { readFile } from "node:fs/promises"

const program = Effect.gen(function*() {
  const text = yield* Effect.promise(() => readFile("suite.jsonl", "utf8"))
  return yield* Suite.fromJsonLines(text, { name: "arithmetic", concurrency: 4, bindings })
})
```

Blank lines are skipped, a leading byte-order mark is stripped, and LF and
CRLF both terminate a line. A malformed line fails with `invalid_suite`
carrying the 1-based line number in the message and the path: `Invalid JSON on
line 2` at `line[2]`, or `Invalid suite case on line 1` at `line[1]`.

## Declared limits

`Suite.limits` declares the ceilings a suite is validated against, so a
mistake fails at construction with a sentence instead of exhausting memory in
a runner:

| Limit           | Value   | Bounds                                          |
| --------------- | ------- | ----------------------------------------------- |
| `concurrency`   | 1024    | The fibers a run may hold open                  |
| `cases`         | 10000   | The cases in one suite                          |
| `fixtureLength` | 8388608 | The UTF-16 code units in one JSON Lines fixture |

Each ceiling is inclusive. A fixture larger than `fixtureLength` is rejected
before any of it is parsed. After 10000 cases, the next non-blank line fails
with `invalid_suite` at `cases`, before parsing or decoding that line or any
later lines. The message reports `got 10001`, the first excess case.

Next: [run the suite](/guides/run-a-suite/).

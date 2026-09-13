---
title: "Test a declaration without a host"
description: "Run the deferred maps, continuations, and recovery arms a node AST stores with TestRuntime, supply values for its execution leaves, and know where the helper stops."
sidebar:
  order: 7
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/core/docs/guides/test-a-declaration.md"
---

`Graph.build` proves a declaration plans correctly. It does not prove the
mapper you wrote returns the right number, because it never calls it.
`TestRuntime` does: it walks one in-memory node AST and executes the deferred
callbacks the AST stores.

This is a test helper. It is not a runtime, and the boundary is at the bottom
of this page.

## Evaluate a declaration

```ts
import { Node, TestRuntime } from "@smthrs/core"
import * as Result from "effect/Result"

const plan = Node.all({
  a: Node.succeed(1),
  b: Node.succeed(2)
}).pipe(
  Node.map((values) => values.a + values.b)
)

console.log(TestRuntime.evaluate(plan))
```

```text
{ _id: 'Result', _tag: 'Success', value: 3 }
```

`evaluate` returns a `Result`. A node that fails produces the typed failure,
and a malformed or unresolved declaration produces an `EvaluationError`.
Thrown callbacks and resolvers also produce an `EvaluationError`. `Node.catch`
handles typed node and resolver failures; evaluator errors bypass recovery arms.

## Supply the leaves the evaluator cannot invent

Two node kinds have no value a pure evaluator could compute: a `Dynamic` model
step, and a call to a flow with no body. Both cross one explicit resolver you
supply:

```ts
const resolver: TestRuntime.Resolver = (request) =>
  request._tag === "Dynamic"
    ? Result.succeed("a drafted answer")
    : Result.succeed({ approved: true, notes: "ok" })

const evaluated = TestRuntime.evaluate(plan, resolver)
```

A `DynamicRequest` carries the node's `model`, `flows`, `output`, `prompt`, and
`effects`. A `FlowCallRequest` carries the `flow`, its `target`, and the
`input` it was called with, so a test can assert on what the declaration asked
for as well as on what it did with the answer.

The resolver may fail. Its error type flows into the result's error channel, so
a test can drive the recovery arm it wants to exercise.

With no resolver, reaching either leaf fails with code `unresolved_node`:

```text
No test value was supplied for Dynamic
```

## Enter composed flow bodies

`evaluate` treats every flow call as a leaf. `evaluateInline` instead enters
any called flow that carries an in-memory body, and sends only the body-less
ones to the resolver:

```ts
const evaluated = TestRuntime.evaluateInline(plan, resolver)
```

Use it when the declaration under test is composed from smaller declared flows
and you want to assert on the whole composition's value. Use `evaluate` when
you want each call to be a seam you control.

## The failure codes

Every evaluator failure is an `EvaluationError` with a stable `code`, a
message, and the original thrown value in `cause` where one exists.

| Code                   | Cause                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------ |
| `callback_threw`       | A deferred mapper, continuation, or recovery arm threw.                              |
| `resolver_threw`       | Your resolver threw instead of returning a `Result`.                                 |
| `unresolved_node`      | A `Dynamic` node or body-less flow call with no resolver.                            |
| `invalid_continuation` | A continuation, recovery arm, or inlined body returned something that is not a node. |
| `missing_operation`    | An AST lost its in-memory callback, which happens after a serialization round trip.  |
| `missing_flow`         | A flow-call AST lost its in-memory flow reference.                                   |
| `invalid_schema`       | A `catch` AST carries something that is not a schema.                                |
| `depth_exceeded`       | The declaration nests more than 1,024 levels.                                        |

Node ASTs and their side tables are process-local. Deferred callbacks and flow
references live in weak maps beside the AST; losing them can produce
`missing_operation` or `missing_flow` during evaluation. Planning also requires
live Effect `Context` annotations and in-memory continuation associations.
A JSON round trip loses the `Context` identity, so even a constant declaration
fails `Graph.build` with `invalid_node`.

There is no Node AST serialization contract. For later inspection, persist
the built graph or the projections you need from its getters. To plan or
evaluate in another process, rebuild the declaration there.

## Where this helper stops

`TestRuntime` deliberately models none of the following: capabilities,
persistence, scheduling, retries, caching, concurrency, and output-schema
enforcement. It does not consult effect declarations, does not honor placement,
and does not order work by priority.

That means it can prove your builder installed the right callbacks and that
they compute the right values. It cannot prove anything about how a host
behaves. Integration tests against the durable engine remain responsible for
host semantics.

## Where to go next

- [Inspect a built graph](/guides/inspect-a-graph/): the other half of testing a
  declaration, which is asserting on the plan.
- [Keep a step key stable across processes](/guides/keep-a-step-key-stable/):
  assert on the identity algorithm as well as the value.

---
title: "Keep a step key stable across processes"
description: "Declare what a plan-time function closes over with Node.capture, so its identity survives a restart instead of changing with every process."
sidebar:
  order: 4
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/core/docs/guides/keep-a-step-key-stable.md"
---

A mapper, a continuation, and a flow body are closures, and JavaScript cannot
inspect closure state. An unannotated function therefore gets a process-local
identity: stable inside one process, different in the next one. A step keyed on
it misses the cache after every restart.

Fix that by declaring what the function closes over.

## Declare the captures

```ts
import { Node } from "@smthrs/core"

const factor = 3
const scale = Node.capture({ factor }, function(value: number) {
  return value * this.factor
})

const scaled = Node.map(Node.succeed(14), scale)
```

`Node.capture` returns a function you use exactly as before. What changed is
its identity: the digest now folds the function's source text with the
canonicalized capture data, and no per-process nonce.

## Confirm it worked

The algorithm name is visible in the plan, which makes this checkable rather
than hopeful:

```ts
import { Graph } from "@smthrs/core"

const [node] = Graph.nodes(Graph.build(scaled))
console.log(node?.keyMaterial.body)
```

```text
{
  _tag: 'Map',
  mapper: {
    _tag: 'FunctionIdentity',
    algorithm: 'sha256-source-captures/v4',
    digest: '71e53045e1ba8b4a62b9e6272f3bcc725e068d147fb98fe8aaf5ff1d9b497247'
  }
}
```

Without the capture the same node reports
`algorithm: 'sha256-source-ephemeral/v4'` and a digest that changes with every
process. Assert on the algorithm in a test when a step's cacheability matters.

## What you are promising

Read the declaration as a claim: this function's behavior is determined by its
source text and by these values. Nothing verifies the claim. A captured
function that also reads a mutable module variable, the clock, or the
environment will collide with itself across two different states, and the
collision looks like a cache hit that returns the wrong answer.

Declare everything the function depends on, or leave it unannotated and accept
the restart miss. Those are the two honest options.

## What capture data may hold

Capture data is canonicalized before it is hashed, and canonicalization refuses
whatever it cannot hash completely. Each refusal is a `TypeError` naming the
path:

```text
TypeError: Node.capture: capture at $.bad has unsupported type function; captures must be finite, inert data
TypeError: Node.capture: capture at $.cyc.self is cyclic; captures must be finite, inert data
TypeError: Node.capture: capture at $.n is not finite; captures must be finite, inert data
```

The full list of refusals is `undefined`, `bigint`, `symbol` and function
values; `NaN` and the infinities; cycles; non-plain prototypes; symbol keys;
accessor properties; array holes; non-index own keys on an array; nesting
past 256 levels; and objects rejected by structuredClone, including every
Proxy. Freezing alone cannot stop a Proxy from
answering a later read differently. Passing a non-function as the operation raises
`TypeError: Node.capture requires a function operation`.

Accepted ordinary data is copied and deeply frozen. The callback receives
that copy as its `this` receiver; use a function expression to read it. Caller
objects remain unchanged, including sealed, non-extensible, frozen and
null-prototype records. Frozen and mutable twins have the same identity.
Built-in brand checks reject prototype-swapped Map, Set, Date, buffers and
other internal-slot objects before structuredClone can traverse them. Proxies
are refused; hosts without structuredClone refuse object capture. Lexical
aliases still name original objects and must not supply mutable semantic
state. See the [capture boundary](/reference/api/#nodecapture).

Comparison is structural, so two references to one shared object digest
identically to two structurally equal copies. Aliasing is not identity.

## Capture composes

Capturing an already-captured function nests the two capture sets rather than
replacing the inner one, so a decorator can add what it closes over without
erasing what the original declared.

## The other half: plan values

Function identity is one input to a step key. The values in the plan are
another, and they follow a rule from the opposite direction: `Node.succeed`,
`Node.fail`, and a flow call retain your value by reference and read it when
`Graph.build` runs. Mutating a value between constructing the node and building
the graph changes the recorded identity. Build the graph from values nothing
else is still writing to.

## Where to go next

- [Identity and key material](/concepts/identity/): everything else a step
  keys on.
- [Test a declaration without a host](/guides/test-a-declaration/): assert on the
  behavior of the functions you captured.

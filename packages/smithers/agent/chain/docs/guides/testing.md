---
title: "Test a chain"
description: "The mock, noop, and in-memory layers this package tests itself with, and the runner conformance they pin."
sidebar:
  order: 7
---

Every service a chain needs ships with a test double in this package. Its
own tests run on these layers, and they are the supported way to test your
own chains and entries.

## Script the author seat

`Author.layerMock(outputs)` pops canned raw outputs in order, one per author
call, and fails with `exhausted` when asked for more than it holds.
`Author.layerFn(f)` is the reactive form: your function maps each author
input to raw model output, so a test can capture the contexts it saw.

Wrap each script in the one fenced `flow` block gate 1 expects:

````ts
import { Author } from "@smthrs/chain"

const flow = (...lines: ReadonlyArray<string>): string => ["```flow", ...lines, "```"].join("\n")

const author = Author.layerMock([
  flow(`const hits = await ctx.call("grep", {})`, "return done(hits)"),
  flow("return done(\"recovered\")")
])
````

`Author.contextOf(payload)` normalizes a script's author-call payload into
context lines; anything but `{ context: [...] }` becomes no context, which is
how a garbage payload stays a journaled observation rather than a crash.

## Seed the journal and queue

`Journal.layerMemory(events)` seeds the journal with prior events: the way to
replay a finished chain or resume a crashed one mid-test.
`Steering.layerMemory(messages)` seeds the steering queue the same way.

## Pick the runner

`ScriptRunner.layerInProcess` runs scripts in-process with NO isolation (the
`Function` constructor builds the body in global scope), which keeps fixtures
fast and synchronous-looking. `QuickJsRunner.layer()` is the production
sealed realm; use it when the test must match production behavior exactly.

This package runs a conformance set over BOTH bindings, so they agree on the
behavior a host depends on: calls settle one at a time in issue order, race
losers settle durably, `to` re-derives the successor digest (a forged digest
is discarded), `park` defaults its message, thrown scripts fail `runtime`,
non-outcomes fail `invalid_outcome`, local promise composition
(`Promise.all`, `Promise.race`, `.catch`) works, and a script left pending
with no runnable jobs and no queued catalog call fails `runtime`. Keep your
own runner doubles inside that envelope and the two bindings stay
interchangeable in tests.

To test the runner's load failure path, inject the loader:
`QuickJsRunner.make({}, () => Promise.reject(new Error("csp blocked wasm")))`
fails typed with `runner_unavailable`, never a defect, and `cachedLoad`
retries a rejected load instead of caching the failure.

## The noop defaults

Every port ships `makeNoop` and `layerNoop`: a service whose every operation
fails as unavailable, with per-operation overrides. They are the defaults a
test starts from when a service should NOT be called:

```ts
import { Author, Journal, ScriptRunner, Steering } from "@smthrs/chain"
import { Layer } from "effect"

// A finished chain replays its terminal without executing anything:
const replay = Layer.mergeAll(
  Journal.layerMemory(priorEvents),
  Author.layerMock([]),
  ScriptRunner.layerNoop(),
  catalogLayer
)
```

`ScriptRunner.layerNoop()` failing every run is exactly what proves the
replay executed zero effects. `Catalog.layerNoop` is the empty catalog: every
call misses gate 3.

## Assert on the journal, not the API

The in-memory journal is a stand-in for whatever durable journal you mount,
so this package's own end-to-end tests assert journal CONTENTS rather than
this API and survive a swap of the storage underneath. Do the same: run the chain, read the events,
and assert on outcomes, `CallSettled` keys, and `GateRejected` observations.
A counting entry (a handler that increments a counter) is the zero-effects
probe for replay tests.

For seeding and resuming, see [Resume and replay](./resume-and-replay.md).
For the failure codes to assert on, see
[Troubleshooting](../troubleshooting.md).

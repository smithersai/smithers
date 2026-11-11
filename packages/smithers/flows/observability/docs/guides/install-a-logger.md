---
title: "Install a logger"
description: "Pick a Logger layer for a development shell, a production process, or a silent test, and understand the two rules every one of them follows: the ambient set is replaced, and the minimum level is left alone."
sidebar:
  order: 4
---

`Logger` ships four layers over Effect's own logger machinery. They differ in
the sink; they agree on the two rules that decide what installing one does to
the rest of the application.

## Pick a layer

```ts
import { Logger } from "@smthrs/observability"

// A development shell: colored, human-readable lines.
const development = Logger.layerPrettyDev()

// A production process: one structured JSON object per line.
const production = Logger.layerStructuredJson()

// A test that should print nothing.
const silent = Logger.layerNoop()
```

`Logger.layerPrettyDev` chooses colors and mode from the terminal it finds, so
it degrades to plain text when the output is not a TTY.
`Logger.layerStructuredJson` is the one to ship: a log shipper can parse it, and
it is what a collector's log pipeline expects. A line logged inside a span
carries the span's `trace_id` and `span_id` in its annotations, so a log search
can join it to the trace and to browser records `OtlpRelay` relayed.

Every layer that installs a sink, `Logger.layer` included, wraps it in
`RedactedLogger.wrap` from `@smthrs/journal`. The journal's redaction rules run
over the message, the cause and the log annotations before the line is
rendered, so a token a log line quotes reaches the console as a marker, never
in clear.

To install a logger you wrote, or one from another package, use `Logger.layer`:

```ts
import * as EffectLogger from "effect/Logger"

const custom = Logger.layer(
  EffectLogger.make((options) => {
    /* your sink */
  })
)
```

## Rule one: the ambient set is replaced

`mergeWithExisting` defaults to `false`, matching Effect's own `Logger.layer`,
so installing one of these layers replaces the ambient logger set rather than
adding to it. That is what you want for a process that has exactly one sink,
and it is the usual explanation for logs disappearing after a layer was added.

Pass `true` to keep the loggers already installed:

```ts
const both = Logger.layerStructuredJson({ mergeWithExisting: true })
```

The same option is on
[`JournalLogger.layerJournalForwarding`](./forward-logs-to-the-journal.md), and
merging is how a control-plane run gets console output and durable
`telemetry.log` rows from one log call.

## Rule two: the minimum level is left alone

A layer that adds a sink has no business overriding the level an application
chose elsewhere, so `References.MinimumLogLevel` is provided only when you name
`minimumLogLevel`. Omitted, whatever the application set stands, and Effect's
own `Info` default applies when nothing set it.

```ts
// Leaves the application's chosen level in place.
const inherits = Logger.layerStructuredJson()

// Pins Warn for the whole application.
const pinned = Logger.layerStructuredJson({ minimumLogLevel: "Warn" })
```

`Logger.layerNoop` is the deliberate exception. Silence is its purpose, so it
pins `None` unless you name another level. Passing one is how a test silences
output while keeping a level assertion meaningful:

```ts
const quietButFiltered = Logger.layerNoop({ minimumLogLevel: "Debug" })
```

## Merge when you install more than one sink

Installing a logger decides what is rendered locally. It exports nothing on its
own: log records reach a collector because [`Otlp`](./export-to-a-collector.md)
adds its own log exporter to the same ambient set, and they reach a run's
history because
[`JournalLogger`](./forward-logs-to-the-journal.md) adds a forwarder to it.

That shared set is why rule one matters here. A `Logger` layer with the default
`mergeWithExisting: false` discards every logger the set already held, and
whether that includes the OTLP exporter depends on which layer the composition
builds last. Pass `mergeWithExisting: true` on the `Logger` layer whenever
another sink is installed, and the ordering question does not arise:

```ts
import * as Effect from "effect/Effect"

const outcome = program.pipe(
  Effect.provide(Logger.layerStructuredJson({ mergeWithExisting: true })),
  Effect.provide(telemetry),
  Effect.scoped
)
```

One `Effect.logInfo` call then renders locally, posts to the collector's
`/v1/logs` path, and, with the journal forwarder installed, lands on the run's
durable history.

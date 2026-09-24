---
title: "Instrumentation and export"
description: "Why the Smithers packages instrument themselves but export nothing, what that split buys, and the three independent ways to read the same run."
sidebar:
  order: 1
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/observability/docs/concepts/instrumentation-and-export.md"
---

Instrumentation and export are two different jobs, and Smithers puts them in
different packages on purpose.

## Every other package is already instrumented

A flow execution opens spans without being asked. The flow lifecycle, the
engine dispatch, a run claim, a heartbeat, a journal write, down to individual
`sql.execute` statements: each is a span on Effect's own tracer. Alongside
them, each store package declares and updates its own metric handles on its hot
paths: `JournalMetrics` in [`@smthrs/journal`](https://journal.smithers.sh/reference/api/), `RunStoreMetrics`
in [`@smthrs/run-store`](https://run-store.smithers.sh/reference/api/), `CacheStoreMetrics` in
[`@smthrs/step-cache`](https://step-cache.smithers.sh/reference/api/), `ArtifactStoreMetrics` in
[`@smthrs/artifacts`](https://artifacts.smithers.sh/reference/api/), and `DatabaseMetrics` in
[`@smthrs/database`](https://database.smithers.sh/reference/api/).

None of those packages allocates an exporter. Effect's tracer and metric
registry are collection points; with no exporter installed they collect and
discard, at a cost close to zero.

## This package is the exporter

`Otlp.layerFetch` installs Effect's OTLP logger, metrics exporter, and tracer
against a collector endpoint, with a service identity filled in. That is the
whole wiring, and it is why telemetry is additive rather than invasive:
providing one layer turns on delivery for instrumentation that was already
there, and removing the line turns it off without touching a flow body.

The split also keeps the dependency in one place. Because `Otlp` composes only
what `effect` already ships, a package that wants a counter takes on no
OpenTelemetry dependency to get one, and the process pays for an SDK only if a
host chooses `NodeOtel` or `BrowserOtel`.

## The producer owns the meaning, the exporter owns the delivery

A metric handle belongs to the package that knows when to advance it. This
package holds only the four cross-package runtime signals nobody else owns,
and it holds them so the producers can share one identifier:
`flows_run_throughput` is updated in [`@smthrs/run-store`](https://run-store.smithers.sh/reference/api/),
`flows_seat_active` and `flows_quota_park` in [`@smthrs/agent`](https://agent.smithers.sh/reference/api/),
and `flows_observability_log_dropped` here. Step-cache counters stay in
[`@smthrs/step-cache`](https://step-cache.smithers.sh/reference/api/); this package does not duplicate them.

The consequence for a reader: a metric's name tells you which package to open
to learn what advances it, and this package tells you only how it leaves the
process.

## Three ways to read one run

Export is one read path, not the only one, and the other two need no collector:

1. **The OTLP trace.** Every span and series posts to your collector. Filter on
   the `service.name` you passed to the layer.
2. **The durable journal.** `Journal.entries` reads a run's lifecycle events in
   process, and `JournalLogger` puts the run's log records on that same
   history. See [Forward logs to the run journal](/guides/forward-logs-to-the-journal/).
3. **The metric handles.** Effect's `Metric.value` reads a counter in process,
   with no exporter installed at all. See
   [Read the runtime metrics](/guides/read-runtime-metrics/).

The three tell the same story about the same run, which is what makes a
disagreement between them worth investigating.

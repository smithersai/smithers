---
title: "Instrumentation and export"
description: "Why the Smithers packages instrument themselves but export nothing, what that split buys, and the three independent ways to read the same run."
sidebar:
  order: 1
---

Instrumentation and export are two different jobs, and Smithers puts them in
different packages on purpose.

## Every other package is already instrumented

A flow execution opens spans without being asked. The flow lifecycle, the
engine dispatch, a run claim, a heartbeat, a journal write, down to individual
SQL statements: each is a span on Effect's own tracer. Alongside
them, each store package declares and updates its own metric handles on its hot
paths: `JournalMetrics` in [`@smthrs/journal`](/api/journal), `RunStoreMetrics`
in [`@smthrs/run-store`](/api/run-store), `CacheStoreMetrics` in
[`@smthrs/step-cache`](/api/step-cache), `ArtifactStoreMetrics` in
[`@smthrs/artifacts`](/api/artifacts), and `DatabaseMetrics` in
[`@smthrs/database`](/api/database).

None of those packages allocates an exporter. Effect's tracer and metric
registry are collection points; with no exporter installed they collect and
discard, at a cost close to zero.

## Spans Effect names

A Smithers package names its own spans for the operation, such as
`RunStore.claim` or `Journal.emitDurable`. Effect names the spans of the SQL,
HTTP and RPC clients those packages use:

| Span            | Name                                               | Kind               | What it carries                                                                                                              |
| --------------- | -------------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| SQL statement   | The database system: `sqlite` or `postgresql`      | `client`           | `db.system.name`, `db.query.text` and `effect.sql.method`                                                                    |
| SQL transaction | `sql.transaction`                                  | `internal`         | The events `effect.sql.transaction.commit`, `effect.sql.transaction.savepoint` and `effect.sql.transaction.rollback`         |
| HTTP request    | The request method, such as `POST`                 | `client`           | `http.request.method`, `url.full`, `url.path`, `url.scheme`, `server.address`, `server.port` and `http.response.status_code` |
| RPC call        | The procedure's tag, such as `Projection.Snapshot` | `client`, `server` | `rpc.system.name` (`effect_rpc`) and `rpc.method`                                                                            |

On an HTTP request span, `server.address` is the host name without the scheme,
and `server.port` is always present, as the scheme's default when the URL names
none.

An HTTP request span records no request or response header. A host that wants
them provides `HttpClient.TracerHeaderFilter`. The model, artifact and
step-cache packages add their credential header names to
`Headers.CurrentRedactedNames`, so a recorded credential header of theirs reads
`<redacted>`. Every other recorded header keeps its value, apart from the names
Effect redacts itself, such as `authorization`, `cookie`, `set-cookie` and
`x-api-key`.

A `4xx` or `5xx` answer ends an HTTP request span as failed, with the status in
`error.type`. That holds even where the calling package treats the status as an
ordinary answer: a shared-cache miss is a failed `GET` span with `error.type`
`404` inside a lookup span that succeeded.

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
package holds the eight shared runtime handles in `Metric.registry`,
and it holds them so the producers can share one identifier:
`flows_run_throughput` is updated in [`@smthrs/run-store`](/api/run-store),
`flows_seat_active`, `flows_quota_park`,
`flows_agent_structured_output_rejections` and
`flows_agent_structured_output_exhausted` in [`@smthrs/agent`](/api/agent), and
`flows_observability_log_dropped`, `flows_observability_otlp_relayed` and
`flows_observability_otlp_relay_dropped` here. `LogFailures` and `FetchFailures`
also declare their own failure counters outside that registry. Step-cache counters stay in
[`@smthrs/step-cache`](/api/step-cache); this package does not duplicate them.

The consequence for a reader: a metric's name tells you which package to open
to learn what advances it, and this package tells you only how it leaves the
process.

## Three ways to read one run

Export is one read path, not the only one, and the other two need no collector:

1. **The OTLP trace.** Every span and series posts to your collector. Filter on
   the `service.name` you passed to the layer.
2. **The durable journal.** `Journal.entries` reads a run's lifecycle events in
   process, and `JournalLogger` puts the run's log records on that same
   history. See [Forward logs to the run journal](../guides/forward-logs-to-the-journal.md).
3. **The metric handles.** Effect's `Metric.value` reads a counter in process,
   with no exporter installed at all. See
   [Read the runtime metrics](../guides/read-runtime-metrics.md).

The three tell the same story about the same run, which is what makes a
disagreement between them worth investigating.

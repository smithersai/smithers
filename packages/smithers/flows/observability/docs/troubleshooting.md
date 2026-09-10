---
title: "Troubleshooting"
description: "The typed refusals @smthrs/observability reports and the silent failures it cannot: nothing arriving at a collector, a bundler that cannot resolve async_hooks, logs that stopped, and a counter that reads zero."
---

Two kinds of problem show up here. A typed refusal names its own cause and
happens while the layer is built. A silent failure is the harder one, because
export is absorbed by design and a broken exporter looks exactly like a working
one.

## InvalidExporterEndpoint

**What happened.** A builder was handed a collector endpoint it will not
export to. The failure carries `code` `invalid_exporter_endpoint`, the `path`
of the option it arrived on (`baseUrl` for `Otlp`, `endpoint` for `NodeOtel`),
and a message. The rejected value is not in the error.

**What to change.** Pass an absolute `http:` or `https:` URL of at most 2,048
characters that carries no username or password and no spaces or control
characters. The usual culprits, in order:

- A trailing newline off a config file, or a leading space off a paste. Trim
  the value. This one is refused rather than repaired precisely because the
  URL parser would repair it into a URL nobody typed.
- A missing scheme: `collector:4318` instead of `http://collector:4318`.
- A signal path already appended. Pass the base URL; the builder adds
  `/v1/traces`, `/v1/metrics`, and `/v1/logs`.
- Credentials in the URL. Move them to the `headers` option.

## InvalidResourceConfiguration

**What happened.** The service identity or the resource attributes failed
decoding. The failure carries `code` `invalid_resource_configuration` and a
`path` naming the offending field, such as `serviceName` or an attribute key.

**What to change.** Check the value against the bounds: a non-empty service
name and version of at most 1,024 UTF-16 code units, at most 256 attributes,
attribute values that are strings of at most 65,536 code units, finite numbers,
booleans, or homogeneous arrays of those. NUL and unpaired surrogates are
refused anywhere. An empty `serviceName` is the common one, usually an
environment variable that was not set.

## InvalidJournalLoggerOptions

**What happened.** `JournalLogger.layerJournalForwarding` was given a run id or
a capacity it will not start a worker for. The failure carries `code`
`invalid_journal_logger_options` and the offending `path`.

**What to change.** Decode the run id through `JournalEvent.RunId` rather than
casting a string, and keep `capacity` between 1 and 65,536. The refusal happens
before any record is queued, so nothing was silently dropped.

## Nothing arrives at the collector

**What happened.** The layer built, the program ran, and the collector holds
nothing. Export failure is absorbed by design, so this is not reported anywhere
by default.

**What to check, in order.**

1. **Did the scope close?** Exporters batch. A short program delivers on the
   shutdown flush, so read the collector only after `Effect.scoped` completes.
   A program killed with `SIGKILL` never flushes.
2. **Is the base URL what you think?** Signals post below it, so
   `http://collector:4318` posts to `http://collector:4318/v1/traces`. If your
   collector expects a prefix, include it in `baseUrl`.
3. **Is the collector answering?** Run at `Debug`. The exporter logs
   `Disabling exporter for 60 seconds` when it gives up after three retries.
4. **Is the layer actually provided?** A composition that swapped in
   `Otlp.layerNoop` behaves exactly like a healthy one that delivers nothing.

## Log records stopped reaching the collector

**What happened.** Spans and metric series still arrive, and logs do not, after
a `Logger` layer was added.

**What to change.** `Otlp` adds its log exporter to the ambient logger set, and
a `Logger` layer with the default `mergeWithExisting: false` replaces that set.
Whether the exporter survives depends on which layer the composition builds
last, which is not worth reasoning about: pass `mergeWithExisting: true` on the
`Logger` layer whenever another sink is installed. See
[Install a logger](./guides/install-a-logger.md).

## A bundler cannot resolve `async_hooks`

**What happened.** A browser or edge build failed on `async_hooks`,
`node:async_hooks`, or a module under `@opentelemetry/context-async-hooks`.

**What to change.** Something in the graph imports
`@smthrs/observability/NodeOtel`, directly or through a module that does.
`NodeOtel` binds the Node OpenTelemetry SDK and cannot bundle for a browser.
Use `Otlp.layerFetch` for browser delivery, or `BrowserOtel` when you need the
web SDK, and keep the `NodeOtel` import behind a Node-only entry point. The
root entry point itself resolves no `node:` built-in and bundles for a browser
as it is.

## `Metric.value` reads zero

**What happened.** The system is clearly doing work, and a counter reads zero.

**What to check.**

- **A dimensioned counter read through its bare handle.** Some packages update
  only an attribute-tagged series, so the attribute-less parent stays at zero.
  Read the exported view, for example `EngineStoreMetrics.dispatch.Success`
  from [`@smthrs/engine-store`](/api/engine-store).
- **A registry provided per test.** Providing `Metric.MetricRegistry` with a
  fresh map isolates state; a read outside that scope sees a different
  registry.
- **A gauge read as a counter.** A gauge's value is `value`, a counter's is
  `count`.

## `droppedLogRecords` keeps climbing

**What happened.** `flows/observability/log/dropped` advances during a run,
which means log records are not reaching the journal.

**What to change.** The counter advances for three distinct losses, and the
last two also emit a warning annotated with the run id:

- **Queue overflow**, with no warning. Raise `capacity` above the default 256,
  up to 65,536.
- **A journal delivery failure.** Read the warning; the journal itself is the
  problem, not the logger.
- **A defect from the journal implementation.** Read the warning. The worker
  keeps draining, so the run continues with gaps.

Records queued behind an in-flight write can also be dropped when the layer's
scope closes, and the forwarder exposes no drain barrier. `journal.flush`
settles only the entries the journal has already admitted, so it returns while
a record is still waiting in the forwarder's queue. Poll the journal for the
records you expect while the layer's scope is open, as
[Forward logs to the run journal](./guides/forward-logs-to-the-journal.md#assert-on-a-short-lived-run)
shows.

## Reading a refusal's path

`path` is a dotted route into the value that failed, built from the decoder's
own issue path. `serviceName` names the identity field;
`attributes.region` names the `region` entry inside the `attributes` record. When the decoder cannot attribute the failure to a field,
the path is the bare `resource`, which means the whole configuration was
malformed: `null`, or not an object at all.

Neither refusal carries the rejected value, so pair the path with the value you
passed on that field.

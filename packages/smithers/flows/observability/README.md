# @smthrs/observability

Release candidate scope, host requirements and compatibility review are defined in the [library support policy](https://github.com/smithersai/smithers/blob/main/RELEASE_SUPPORT.md).

This package declares `effect` as an exact `4.1.0` peer dependency. Install one
`effect` release at that version so all Smithers packages share one Effect
runtime.

**Documentation:** https://github.com/smithersai/smithers/tree/main/packages/smithers/flows/observability/docs

# `@smthrs/observability`

Send an Effect program's logs, metrics, and traces to an OpenTelemetry collector with one layer.

`Otlp` composes what `effect` itself ships with the journal's redaction rules, so it allocates no OpenTelemetry SDK, never resolves a `node:` built-in, and runs unchanged in Node, Bun, and a browser. Around it the package ships the pieces a host installs beside an exporter: Effect logger layers, a validated `Resource` describing the service, a `JournalLogger` that mirrors a run's log records into a durable journal, the runtime `Metric` handles that cross package boundaries, `OtlpRelay`, which receives OTLP/HTTP JSON exports on your own server route (a Cloudflare Worker, for one) and re-emits each record as a structured Effect log line, and `Otel`, which bridges OpenTelemetry providers an application already built.

`NodeOtel` and `BrowserOtel` are deliberately not re-exported from the root. Each binds a host-specific OpenTelemetry SDK: `NodeOtel` reaches `@effect/opentelemetry/NodeSdk` and `@opentelemetry/sdk-trace-node`, which pulls the bare `async_hooks` specifier through `@opentelemetry/context-async-hooks`. Re-exporting it would put a module a browser bundler cannot resolve in the root entry point. Import them by subpath instead: `@smthrs/observability/NodeOtel`.

## Install

```bash
npm install @smthrs/observability@next effect
```

Node.js 22.19.0 or later. Effect services are identified by module identity, so install one `effect` release, at exactly `4.1.0`.

The default install supports the root, `Otlp`, `Otel`, and `Resource`. It
installs `@effect/opentelemetry@4.1.0` and requires the
`@opentelemetry/api@1.9.1` peer. It includes no HTTP exporters or trace SDK. Select the optional peers
for the host subpath you import:

```sh
# @smthrs/observability/NodeOtel
pnpm add @opentelemetry/exporter-logs-otlp-http@0.222.0 @opentelemetry/exporter-metrics-otlp-http@0.222.0 @opentelemetry/exporter-trace-otlp-http@0.222.0 @opentelemetry/sdk-trace-base@2.11.0 @opentelemetry/sdk-trace-node@2.11.0
# @smthrs/observability/BrowserOtel
pnpm add @opentelemetry/sdk-trace-base@2.11.0 @opentelemetry/sdk-trace-web@2.11.0
```

## Use

```ts
import { Otlp } from "@smthrs/observability"

const Telemetry = Otlp.layerFetch({
  baseUrl: "http://localhost:4318",
  serviceName: "my-service"
})
```

Provide the layer, give it a scope, and every span, log record, and metric series the program already produces posts to the collector. Deleting the provide removes telemetry and changes nothing else.

Resource identity fields and attribute keys are limited to 1,024 UTF-16 code
units, strings to 65,536 code units, and attributes to 256 entries.
Resources are refused during layer acquisition with `InvalidResourceConfiguration`
if arrays exceed 256 elements or the whole OTLP JSON resource exceeds 128 KiB.
The byte budget counts keys, values, wrappers, JSON escaping, and UTF-8, including
service identity and SDK-added `telemetry.sdk.name`, `telemetry.sdk.language`
and `telemetry.sdk.version`.
These SDK fields are reserved even for the default Effect exporter. Resource
metadata is explicit; both default OTLP and Node SDK layers isolate ambient
resource configuration so it cannot enlarge a resource after validation.
The 1 MiB transport reserves 8 KiB for the request envelope
and 888 KiB (`Otlp.reservedBatchBytes`) for signal batches: about 909 bytes per
record in the upstream 1,000-record log or span batch. Large application records
can still exceed the transport cap.

Discarded batches increment `flows_observability_otlp_dropped` and emit a
`Warn` diagnostic with code `otlp_export_discarded` at most once per minute per
transport through the loggers installed before exporter acquisition. Install
an ambient logger that writes outside OTLP to observe loss independently; an
empty logger set or a minimum level above `Warn` suppresses that diagnostic.
The warning never enters this exporter and includes only the discard reason,
request bytes, byte limit, and running drop count.

## Documentation

Full documentation is at [the package docs](https://github.com/smithersai/smithers/tree/main/packages/smithers/flows/observability/docs):

- [Quickstart](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/observability/docs/quickstart.md): export a trace, a log record, and a metric series to a collector you can watch.
- [Installation](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/observability/docs/installation.md): requirements, import forms, and the rule that keeps the root entry point bundling for a browser.
- [The layer map](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/observability/docs/concepts/layer-map.md): which builder to reach for, and what each one costs.
- [Relay browser telemetry](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/observability/docs/guides/relay-browser-telemetry.md): receive a browser's OTLP exports on your own Worker route and log each record there.
- [API reference](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/observability/docs/api.md): every public export, with validation, backpressure, shutdown, retry, and platform contracts.
- [Troubleshooting](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/observability/docs/troubleshooting.md): the typed refusals this package reports, and the silent cases that are not refusals at all.

## License

MIT

---
title: "Installation"
description: "Install @smthrs/observability, its runtime requirements and Effect version, its import forms, and the rule that keeps the root entry point bundling for a browser."
sidebar:
  order: 1
---

## Install the package

```bash
npm install @smthrs/observability@next effect
```

The `next` tag carries the 1.0 release candidates.

The package requires Node.js 22.19.0 or later and ships as both ESM and
CommonJS with TypeScript declarations.

## Install one Effect release

Effect services are identified by module identity, so a composition that
resolves two copies of `effect` splits its context and a provided layer stops
satisfying a requirement. Install one `effect` at exactly `4.0.5`.

`Otlp` is written entirely against `effect`, including its HTTP client and its
`effect/observability/Otlp` exporters. The `@effect/opentelemetry@4.0.5`
dependency, the required `@opentelemetry/api@1.9.1` peer, and the logs and
metrics dependencies support the root `Otel` and `Resource` modules. They
install with ordinary peer-aware package managers. `@effect/opentelemetry`
4.0.5 accepts any `effect` in `4.0.5`. The API peer stays below 1.10 to match
the SDK dependencies. The default install includes no HTTP exporters or trace SDK.

`NodeOtel` selects the optional Node trace SDK and three HTTP exporters:

```bash
pnpm add @opentelemetry/exporter-logs-otlp-http@0.222.0 @opentelemetry/exporter-metrics-otlp-http@0.222.0 @opentelemetry/exporter-trace-otlp-http@0.222.0 @opentelemetry/sdk-trace-base@2.11.0 @opentelemetry/sdk-trace-node@2.11.0
```

`BrowserOtel` selects the optional browser trace SDK instead:

```bash
pnpm add @opentelemetry/sdk-trace-base@2.11.0 @opentelemetry/sdk-trace-web@2.11.0
```

The browser adapter accepts the exporters you supply; those HTTP exporter
packages are not prerequisites for constructing its layer.

## Import forms

The root entry point re-exports eight modules as namespaces. Import them from
the root, as the [API reference](./api.md) does:

```ts
import { Endpoint, JournalLogger, Logger, Metric, Otel, Otlp, OtlpRelay, Resource } from "@smthrs/observability"
```

`@smthrs/observability/package.json` is exported.

## The two subpath-only modules

`NodeOtel` and `BrowserOtel` are not re-exported from the root, and importing
them by subpath is the only way to reach them:

```ts
import * as BrowserOtel from "@smthrs/observability/BrowserOtel"
import * as NodeOtel from "@smthrs/observability/NodeOtel"
```

`NodeOtel` resolves Node-only host modules: `@effect/opentelemetry/NodeSdk` and
`@opentelemetry/sdk-trace-node`, which reaches the bare `async_hooks` specifier
through `@opentelemetry/context-async-hooks`. Re-exporting it from the root
would put a module a browser bundler cannot resolve in the entry point, and
break the browser bundle the root guarantees. Nothing the root entry point
reaches resolves a `node:` built-in, so it bundles for a browser as it is.

Import `NodeOtel` only from code that runs on Node, and `BrowserOtel` only from
code that runs in a browser. `Otlp` is safe in both, because it exports over
Effect's `HttpClient` and never touches a `node:` built-in.

## What a real composition adds

The exporter alone needs nothing else. Two features have a dependency:

- `Otlp.layer` requires an Effect `HttpClient` from
  `effect/http/HttpClient`. `Otlp.layerFetch` supplies the host's
  global `fetch` and is the usual choice; a Node host that wants Undici instead
  provides `NodeHttpClient.layerUndici`, re-exported by
  [`@smthrs/platform-node`](/api/platform-node) as `NodeHost.NodeHttpClient`.
- `JournalLogger.layerJournalForwarding` requires a `Journal.Journal` service
  from [`@smthrs/journal`](/api/journal). A durable engine composition already
  provides one.

## Next step

Export your first trace, log record, and metric series in the
[Quickstart](./quickstart.md).

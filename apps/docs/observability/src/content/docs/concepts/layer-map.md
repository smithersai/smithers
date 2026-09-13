---
title: "The layer map"
description: "The five telemetry layer builders this package ships, what each one allocates, and the rule that keeps the root entry point free of Node modules."
sidebar:
  order: 2
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/observability/docs/concepts/layer-map.md"
---

Five builders produce a telemetry layer, and they differ in one thing: how much
they allocate for you.

## The five builders

| Builder                 | Allocates                                                                  | Reach for it when                                                                 |
| ----------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `Otlp.layerFetch`       | Effect's three OTLP exporters, plus the host's global `fetch`              | You have a collector and no other OpenTelemetry requirement. This is the default. |
| `Otlp.layer`            | Effect's three OTLP exporters. You provide the `HttpClient`                | You need a specific HTTP client, such as Undici on Node.                          |
| `NodeOtel.layerOtel`    | The Node OpenTelemetry SDK: three OTLP/HTTP exporters and their processors | Node code that must run through the OpenTelemetry SDK.                            |
| `BrowserOtel.layerOtel` | The web OpenTelemetry SDK around processors and readers you construct      | Browser code that must run through the OpenTelemetry SDK.                         |
| `Otel.layerOtel`        | Effect bridges; optional caller factories build providers                  | The application controls SDK provider construction.                               |

Each has an explicit do-nothing counterpart: `Otlp.layerNoop` and
`Otel.layerNoop` both provide nothing and export nothing, so wiring code
switches layers instead of branching around a missing one.

## Why `Otlp` is the default

`Otlp` composes only `effect/unstable/observability/Otlp`, so it adds no
OpenTelemetry SDK to the process, and it delivers over Effect's `HttpClient`
rather than a platform transport. That makes it the cheapest wiring and the
only one that runs unchanged in Node, in Bun, and in a browser.

Reach past it when something other than a collector endpoint is in play: an
existing OpenTelemetry instrumentation you must feed, a vendor exporter that is
not OTLP/HTTP JSON, or a provider a framework hands you.

## Why the root entry point stops at `Otel`

The root entry point exports `Otlp`, `Endpoint`, `JournalLogger`, `Logger`,
`Metric`, `Otel`, and `Resource`. It stops there because those seven resolve
nothing host-specific.

`NodeOtel` does. It reaches `@effect/opentelemetry/NodeSdk` and
`@opentelemetry/sdk-trace-node`, and the latter pulls
`@opentelemetry/context-async-hooks`, which imports the bare specifier
`async_hooks`. A browser bundler cannot resolve that, so re-exporting `NodeOtel`
from the root would break the root's browser bundle for every consumer,
including those that never wanted an SDK. `BrowserOtel` is kept beside it for
symmetry: a module that binds one host belongs on a subpath.

Nothing the root entry point reaches resolves a `node:` built-in, as an ESM
import or as a `require("node:...")` call, so a browser bundle of the root
carries no host module.

## `Resource` sits under all of them

Every builder decodes the same `Resource.Configuration`. `Otlp`, `NodeOtel`,
and `BrowserOtel` attach its attributes to all enabled signals. `Otel.layerOtel`
passes that validated resource to provider factories and the metric producer;
factories must use it when constructing tracer and logger providers.

Already-created providers retain their own resources. For those providers,
`Otel.layerOtel`'s resource option sets only the metric resource and tracer
instrumentation scope. Construct them with the intended resource before
injection to give all three signals the same service identity.

`Resource.layer` provides the resource on its own, for a composition that
assembles the rest itself.

`Otlp` is the one builder with defaults: `Otlp.defaultServiceName` is `flows`
and `Otlp.defaultServiceVersion` is this package's release version. Name your
own service in production, so a collector holding several Smithers processes
can tell them apart.

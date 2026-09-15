---
title: "Validation at layer acquisition"
description: "Export failure is absorbed by design, so a misconfigured exporter looks exactly like a working one. Endpoints and resources are therefore decoded when the layer is built, and refused with typed errors."
sidebar:
  order: 3
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/observability/docs/concepts/validated-acquisition.md"
---

An exporter that cannot deliver must not take the application down with it. A
collector outage is not an application outage, so Effect's exporter absorbs
export failure: it retries a transient failure three times, then temporarily
disables delivery, and the effect that produced the span never learns any of
it.

That is the right behavior, and it creates one hazard. A layer built against
`""`, `localhost:4318`, or an endpoint with a trailing newline behaves
identically to a working one: it builds, it runs, it fails nothing, and it
delivers nothing forever. Nobody notices until an operator goes looking for a
trace that was never sent.

## Acquisition is the only place to report it

So both configuration inputs are decoded while the layer is being built, before
any exporter exists:

- The collector endpoint, by `Endpoint.decode`, failing with
  `Endpoint.InvalidExporterEndpoint`.
- The service identity and resource attributes, by `Resource.decode`, failing
  with `Resource.InvalidResourceConfiguration`.

Both are typed failures in the layer's error channel, which means a composition
sees them at startup, in the place where the value was written, rather than as
silence in a dashboard weeks later. `Otlp.layer`, `Otlp.layerFetch`, and
`NodeOtel.layerOtel` all decode their endpoint; every builder decodes its
resource.

## What an endpoint must be

An absolute `http://` or `https://` URL, at most 2,048 characters, carrying no
username, password, query, fragment, backslashes, spaces, or control characters.
Base paths such as `https://collector.example/tenant/9` are supported.

Queries and fragments are refused because exporters append `/v1/<signal>` to
the base. Appending it after `?tenant=9` or `#notes` would leave the HTTP request
path unchanged, silently sending telemetry to the wrong route. Use exporter
headers for authentication, not credentials embedded in the URL.

The last clause is the one that surprises people, and it is the whole reason
`Endpoint` exists rather than a bare `new URL` check. The WHATWG URL parser is a
repairer, not a validator: it strips leading and trailing spaces and C0
controls, and removes tab, newline, and carriage return from anywhere in its
input. So `new URL("http://collector:4318\n")` succeeds, and reports a
well-formed URL, while the untrimmed original is what a builder would hand its
exporter. An endpoint read from a config file with a trailing newline, or
pasted with a leading space, is the most common shape of this mistake, and it
produces exactly the silent no-delivery the refusal exists to prevent. No legal
collector endpoint carries one of those characters, so refusing them costs
nothing.

Repeated trailing separators are normalized away instead of refused:
`http://host//` and `http://host` both post to `http://host/v1/traces`.

## What a resource must be

`Resource.Configuration` bounds the identity so an accepted value cannot become
an unencodable payload later:

- `serviceName` and `serviceVersion` are non-empty, well formed, and at most
  1,024 UTF-16 code units.
- At most 256 attributes, with non-empty, well formed keys of at most 1,024
  code units.
- Attribute values are finite numbers, booleans, strings of at most 65,536 code
  units, or homogeneous arrays of one of those scalar types with at most 256
  elements (`Resource.maximumAttributeArrayLength`).
- The complete OTLP JSON resource is at most 128 KiB
  (`Resource.maximumResourceBytes`), including identity, SDK-added
  `telemetry.sdk.name` and `telemetry.sdk.language`, keys, values, array wrappers,
  escaping and UTF-8. SDK fields are reserved even for the default Effect
  exporter. Counting stops as soon as the budget is exceeded;
  the value-free refusal names `attributes`, the measured lower bound and limit.
  Per-field limits alone cannot guarantee this cumulative bound.
- Resource metadata is explicit. The default OTLP and Node SDK layers isolate
  ambient resource configuration so it cannot enlarge metadata after admission.
- The 1 MiB transport reserves 8 KiB for the JSON envelope and escaped scope
  name, leaving 888 KiB (`Otlp.reservedBatchBytes`) for a signal batch. This is
  about 909 bytes per record at the upstream 1,000-record log or span limit,
  enough for ordinary batches; application records can still be too large.
- NUL and unpaired UTF-16 surrogates are refused anywhere. Valid astral Unicode
  is preserved.

An empty `serviceName` is refused rather than defaulted, because anonymous
telemetry in a shared collector is worse than none.

## Refusals never carry the rejected value

Both errors report a stable `code`, the `path` of the option the bad value
arrived on, and a message. Neither retains the value itself: `baseUrl` is the
field most likely to carry a token in a query string or a credential in its
userinfo, and an error message is the least controlled surface in a system. The
`path` is what you need to find the value, and you already have the value.

The `path` names the caller's own option, so a refusal from `Otlp` says
`baseUrl` and one from `NodeOtel` says `endpoint`.

For what to do when you see one, see
[Troubleshooting](/troubleshooting/).

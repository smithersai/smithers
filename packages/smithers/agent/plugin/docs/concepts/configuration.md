---
title: "Configuration"
description: "The config waterfall and the JSON boundary it enforces: plugin-owned namespaces, reserved root keys, deep merge semantics, admission rules, and the published size limits."
sidebar:
  order: 3
---

Configuration is the one lifecycle the kernel owns. It is two hooks: `config`,
a waterfall in which each plugin may return a patch, and `configResolved`, a
parallel observer that sees the frozen result. `Kernel.make` runs both.

## Configuration is a namespace map, not a policy surface

A configuration is a flat record whose root keys name plugin-owned namespaces.
Each namespace holds JSON, and the kernel never interprets it: the plugin that
owns a namespace is the only code that knows what its contents mean.

Four root keys are refused with `config_invalid`: `engine`, `retry`, `store`,
and `plugins`. The kernel does not apply retry, storage, concurrency, cache,
wait, journal, or ownership policy, and accepting those names would imply that
setting them changes something. Those policies stay on the Effect service or
constructor option that applies them.

## The waterfall merges patches

Each `config` handler receives the accumulated configuration and returns a
partial to merge, or nothing:

```ts
import { type FlowsPlugin, make } from "@smthrs/plugin"
import * as Effect from "effect/Effect"

const plugin: FlowsPlugin = make({
  name: "flows-plugin-endpoint",
  hooks: {
    config: (config) =>
      config["endpoint"] === undefined
        ? Effect.succeed({ endpoint: { url: "https://example.test" } })
        : Effect.void
  }
})
```

`Config.merge` is the merge function `Kernel.make` uses. Records merge key by
key, recursively. Every other JSON value, including an array, replaces the
previous value wholesale:

```ts
Config.merge({ a: { b: 1, c: 2 } }, { a: { c: 3, d: 4 } }) // { a: { b: 1, c: 3, d: 4 } }
Config.merge({ a: [1] }, { a: [2] }) // { a: [2] }
Config.merge({ a: { b: 1 } }, { a: 5 }) // { a: 5 }
```

Both operands and the merged result are admitted, so no handler in the chain
ever observes a value that breaks the rules below, even when each individual
patch was within them.

## What the boundary admits

Configuration is strict JSON, copied before any plugin observes it and frozen
recursively afterward. The following are refused with `config_invalid` and the
path of the offending value:

- Cycles and repeated object references.
- Sparse arrays, arrays with extra properties, and array subclasses.
- Accessors, symbol keys, non-enumerable properties, and exotic prototypes.
- Non-finite numbers, unpaired surrogates, and non-JSON values such as `Date`
  and `Map`.
- The prototype-control keys `__proto__`, `constructor`, and `prototype`, at
  every depth.
- `undefined` members.

The last one is a decision worth naming. `{ endpoint: undefined }` fails at
`$.endpoint` instead of resolving to `{}`. A silent drop hid a typo behind a
value the next handler never saw. To leave something unset, omit the key or
write `null`.

Admission reads a value through `Reflect.ownKeys`, `Object.getPrototypeOf`, and
one property descriptor per key. An accessor is never called, so a proxy sees a
bounded number of traps and only the data those traps return is copied. A trap
that throws refuses the whole tree.

## Size limits

| Limit                           | Value | Export                        |
| ------------------------------- | ----- | ----------------------------- |
| Encoded bytes per configuration | 1 MiB | `Config.maximumConfigBytes`   |
| Container nesting depth         | 64    | `Config.maximumConfigDepth`   |
| Aggregate members               | 4,096 | `Config.maximumConfigMembers` |
| Aggregate values                | 8,192 | `Config.maximumConfigNodes`   |

Strings are limited to 64 KiB of encoded JSON and keys to 1 KiB. A tree over any
bound fails with `config_invalid`, and because the merged result is admitted
too, a chain of small patches cannot add up past them.

## configResolved is a lossy observer boundary

After the waterfall settles, `Kernel.make` decodes and freezes the result, then
runs every `configResolved` handler in parallel. Those handlers are observers:
their success values are discarded, and their failures do not fail startup.
An observer still running after the handler timeout (`handlerTimeout`, 30
seconds by default) is stopped and reported as `hook_failed` too, so a stalled
observer never holds startup.
Read them from `kernel.observerErrors` and log them at your own boundary:

```ts
const kernel = await Effect.runPromise(Kernel.make([plugin]))
for (const error of kernel.observerErrors) {
  console.warn(`plugin ${error.plugin} failed to observe the config: ${error.code}`)
}
```

Dropping them on the floor is the one thing to avoid. A plugin whose observer
fails silently looks configured and is not.

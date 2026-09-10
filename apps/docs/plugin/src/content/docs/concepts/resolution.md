---
title: "Resolution"
description: "How a plugin list becomes an ordered immutable catalog: the order of the checks, Vite's two-level ordering rule, exact-Unicode names, the copies the kernel takes, and the published limits."
sidebar:
  order: 2
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/plugin/docs/concepts/resolution.md"
---

Resolution is the step between "here is an array of plugins" and "here is a
dispatcher". It happens once, at startup, and everything it produces is a copy
the kernel owns. `Resolve.resolve` does the work; `Kernel.make` calls it for
you.

## The order of the checks

The steps run in this order, and the order is part of the contract:

1. **Snapshot the options.** `target`, `hooks`, `parallelConcurrency`,
   `cacheEnvironment`, and `config` are read through property descriptors. An
   unknown option key is `invalid_plugin`.
2. **Flatten the input.** Nested arrays flatten within the depth and node
   limits, and `false`, `null`, and `undefined` entries drop. Array length must
   fit the remaining node budget, including queued entries, before keys are
   enumerated or element descriptors are read. A preset is therefore just a
   function that returns plugins.
3. **Validate every plugin record.** Each plugin, each hook entry, and each
   ordering object is checked for shape and copied. This happens _before_
   `apply` filtering, so an excluded plugin cannot hide a malformed one.
4. **Filter by `apply`.** A literal `"engine"` or `"harness"` is compared with
   the host's `target`. A predicate is called with the pre-resolution config.
5. **Check hook names against the host catalog.** This happens _after_
   selection, so a shared preset can carry `apply: "harness"` plugins with
   harness-only hooks and still resolve under a bare engine kernel.
6. **Reject duplicate names.** Two selected plugins with the same name fail with
   `duplicate_name` rather than the last one silently winning.
7. **Order the list and build the handler map.**
8. **Decode the cache environment**, when the host declared one. See
   [Declare a cache identity](/guides/cache-identity/).

## Ordering follows Vite exactly

Ordering has two levels, and they are applied in the opposite order from the one
most readers expect.

`enforce` sorts the plugin list once, into `pre`, then normal, then `post`,
stably within each group. That sorted list is the resolved plugin order, and it
is the order `kernel.layer` merges layers in.

The per-hook `order` then re-partitions that list, for one hook only. A handler
declared `{ order: "pre", handler }` runs ahead of every normal-order handler
even when its plugin is `enforce: "post"`:

```ts
const plugins = [
  make({ name: "post-plugin-pre-hook", enforce: "post", hooks: { configResolved: { order: "pre", handler } } }),
  make({ name: "pre-plugin-post-hook", enforce: "pre", hooks: { configResolved: { order: "post", handler } } })
]
// configResolved runs post-plugin-pre-hook first.
```

Ties keep the resolved plugin order. Because the per-hook `order` applies to one
hook, a plugin can be early for one hook and late for another. See
[Control the order handlers run in](/guides/order-handlers/) for how to pick
between the two levers.

## Names compare as exact Unicode

A plugin name is a bounded, non-empty, control-free, well-formed string of at
most 256 UTF-16 code units, and it is never normalized. Two canonically
equivalent spellings are two different plugins, and a name that is only
whitespace is refused. The same rules apply to `version` and to hook names in a
host catalog and to keys declared in a plugin's `hooks` record. Invalid
plugin-declared hook names fail with `invalid_plugin` before `apply` filtering,
using the bounded path `.hooks[N]`, where `N` is the key's zero-based index.

The naming convention is `flows-plugin-<thing>`, following Vite's
`vite-plugin-<thing>`. The kernel does not enforce it.

## Everything is copied

The resolved catalog owns every record it exposes. Dispatch never reads a
caller-owned map, plugin record, hook object, config value, or cache identity:

- Plugin records and hook objects are copied into frozen objects.
- The handler list for each hook is a frozen array of frozen records, each one
  carrying its plugin name and hook name for attribution.
- `Resolved.handlers` is a read-only map facade with no `set`, `delete`, or
  `clear`.
- The configuration `apply` predicates see is a snapshot taken before the first
  predicate runs.

Reflection is descriptor-only. Accessors are never executed, an exotic prototype
is refused, and a hostile proxy observes a bounded number of traps whose return
values are copied rather than retained. Mutating a plugin object after startup
changes nothing about dispatch.

## Limits

One kernel accepts:

| Limit                                                       | Value | Export                               |
| ----------------------------------------------------------- | ----- | ------------------------------------ |
| Plugins                                                     | 256   | `Resolve.maximumPlugins`             |
| Hook handlers                                               | 1,024 | `Resolve.maximumHandlers`            |
| Input nodes, including arrays and dropped entries           | 4,096 | `Resolve.maximumPluginInputNodes`    |
| Nested preset-array depth                                   | 64    | `Resolve.maximumPluginDepth`         |
| Plugin, version, and hook name length, in UTF-16 code units | 256   | `Resolve.maximumPluginNameLength`    |
| Parallel observers at once, by default                      | 16    | `Resolve.defaultParallelConcurrency` |
| Parallel observers at once, at most                         | 256   | `Resolve.maximumParallelConcurrency` |

Exceeding a count or depth limit fails with `resource_limit` and the path of the
offending entry or preset array. Invalid names fail with `invalid_plugin`.
The handler bound counts the handlers the kernel dispatches, so a plugin whose
hooks were filtered out costs nothing against it.

Resolution diagnostics truncate property and unknown-hook key text after 64
UTF-16 code units, appending `...`. Paths use dot notation for identifiers and
JSON-quoted brackets for other keys; unknown-hook messages also JSON-quote the
key. The `hook` error field retains the complete, validated hook identity.

Configuration and cache-identity JSON admission also bounds strings and diagnostic paths:

| Limit                                                        | Value             |
| ------------------------------------------------------------ | ----------------- |
| One JSON-encoded string, including quotes and escapes        | 64 KiB            |
| One JSON-encoded property name, including quotes and escapes | 1 KiB             |
| Refusal path, as a JSON-encoded string                       | At most 192 bytes |

String and key lengths are checked before scanning or encoding oversized text.
Oversized or ill-formed property names use the parent path plus `[key:N]`, where
`N` is the zero-based index in the record's own-key order. Longer refusal paths
retain a prefix ending in `...`; truncation preserves Unicode characters and
accounts for JSON escaping. Short paths for admitted keys keep their usual shape.

---
title: "Troubleshooting"
description: "Every PluginError code the kernel reports, what causes it, and what to change, plus the failures that are silent by design."
---

Every refusal this package makes is a `PluginError` with a `code` from a closed
set. Find the code and read its section. The full error schema is in the
[API reference](./api.md).

Most errors carry `plugin`, `hook`, and `path` alongside the message. Read
`path` first: it is a JSON pointer into the value the kernel refused, such as
`$[2].hooks.config` for the third plugin's `config` entry, or
`$options.parallelConcurrency` for an option.

## duplicate_name

**What happened.** Two selected plugins have the same name. Names compare as
exact Unicode strings with no normalization, so this is a real collision, not a
spelling variant.

**What to change.** Rename one, or exclude one with
[`apply`](./guides/select-plugins.md). The kernel refuses rather than letting
the last one win, because last-wins turns a duplicated preset into a silently
dropped plugin.

## unknown_hook

**What happened.** A selected plugin declares a hook name that is not in the
host's runtime catalog. The error names the plugin and the hook.

**What to change.** If the hook is yours to add, list it in the catalog you pass
as `Resolve.Options.hooks` and augment `FlowsHooks` to match. See
[Declare hooks for your host](./guides/host-your-own-hooks.md). If the hook
belongs to a different host, give the plugin an `apply` selector so this host
does not select it.

Passing no catalog means the shared one: `config` and `configResolved` only.

## hook_kind_mismatch

**What happened.** The runtime catalog and the kind actually run disagree.
At startup, `Options.hooks` labelled `config` with a kind other than
`waterfall`, or `configResolved` with a kind other than `parallel`; the path
names the entry, such as `$options.hooks.config`. At dispatch, a method was
called for a hook the catalog declares with a different kind, which only a cast
around the typed dispatcher can reach. In both cases no handler ran.

**What to change.** Make the catalog agree with the hook interface: spread
`engineHooks` for the shared hooks and write each of your own hooks with the
kind its type declares. `HookCatalog<H>` refuses a wrong kind for a declared
name at compile time.

## invalid_plugin

**What happened.** A plugin, preset, option, or hook entry has a shape the
kernel will not accept. Common causes, each reported at its own path:

- A hook entry that is `undefined` or `null`. Declarations must be callable, so
  a conditionally built hook is refused rather than skipped.
- An unknown property on a plugin record or on the options object.
- A name or version that is empty, whitespace only, longer than 256 UTF-16 code
  units, or not well-formed text.
- `enforce` or `order` that is not `"pre"` or `"post"`.
- `apply` that is not `"engine"`, `"harness"`, or a function.
- `layer` that is not an Effect `Layer`.
- A preset array that is sparse, cyclic, repeated, or carries extra properties.
- An accessor, a symbol key, or a non-enumerable property anywhere in the
  record.

**What to change.** Read `path`, fix that value. To omit an optional hook, leave
the key out of the `hooks` record instead of setting it to `undefined`.

## apply_failed

**What happened.** An `apply` predicate threw. The raw failure is not retained,
because a predicate runs before the kernel has anywhere safe to put an arbitrary
value.

**What to change.** Make the predicate total. It receives the pre-resolution
configuration and must return a boolean without reading anything it cannot
guarantee is there. A predicate that returns a non-boolean fails with
`invalid_plugin` instead.

## config_invalid

**What happened.** A configuration value is not bounded strict JSON, or it uses
a reserved root key. This covers the pre-resolution config, any patch a `config`
handler returned, and the merged result.

**What to change.** Read `path`. The frequent causes:

- `$.engine`, `$.retry`, `$.store`, or `$.plugins`: rename the namespace. The
  kernel does not apply those policies and refuses to look like it does.
- An `undefined` member: omit the key, or write `null`. `{ endpoint: undefined }`
  fails at `$.endpoint` rather than resolving to `{}`.
- A `Date`, `Map`, class instance, or non-finite number: encode it as JSON, or
  keep it in a service instead of in configuration.
- `__proto__`, `constructor`, or `prototype` as a key at any depth.
- A tree over 1 MiB, 64 deep, 4,096 members, or 8,192 values. See
  [Configuration](./concepts/configuration.md) for the whole list.

When a `config` handler returned the offending patch, the error also carries
that plugin and hook.

## cache_environment_invalid

**What happened.** You declared `cacheEnvironment` and the kernel could not
build a complete identity from it. Either a selected plugin has no `version`, or
the environment does not match the `Action.CacheEnvironment` schema.

**What to change.** Add a `version` to every selected plugin, or drop
`cacheEnvironment` and let sealed keys stay run-local. Both are correct; a bare
plugin name folded into a cross-run cache key is not. See
[Declare a cache identity](./guides/cache-identity.md).

## invalid_hook_result

**What happened.** A `first` hook handler returned something other than an
`Option`. The error names the plugin and the hook.

**What to change.** Return `Option.some(value)` to answer and `Option.none()` to
pass. A `first` hook stops at the first `some`, so returning a bare value would
make "no opinion" indistinguishable from "the answer is undefined".

## resource_limit

**What happened.** The plugin input, the handler count, or a concurrency option
exceeded a published bound: 256 plugins, 1,024 handlers, 4,096 input nodes, 64
nested preset arrays, or a `parallelConcurrency` outside 1 through 256.

**What to change.** Split the composition, or raise nothing: these bounds are
fixed. A list this large is usually a preset included twice or an array building
itself in a loop. The [limits table](./concepts/resolution.md) has each bound
and the export that names it.

## hook_failed

**What happened.** A handler failed, defected, threw synchronously, or returned
something that is not an Effect. The error names the plugin and the hook, and
the original failure is on `cause`.

**What to change.** Fix the handler. Where it surfaces depends on the kind: a
`sequential`, `first`, or `waterfall` hook fails the caller and stops dispatch
at that handler, while a `parallel` hook returns the error and keeps going. See
[Hook kinds](./concepts/hook-kinds.md).

## layer_failed

**What happened.** A plugin's layer failed while it was being built. The error
names the plugin, with the layer's own failure on `cause`.

**What to change.** Fix the layer's acquisition, or make the plugin conditional
so it is not selected in compositions where its dependencies are absent. The
failure arrives when something provides `kernel.layer`, not when `Kernel.make`
returns.

## Failures that are silent by design

**A `configResolved` handler failed and nothing happened.** Parallel observers
are lossy on purpose: their failures are collected, not raised. Read
`kernel.observerErrors` and log them. A composition that ignores that array
cannot tell a working observer from a broken one.

**A plugin was dropped and no error was reported.** Exclusion is not a failure.
`apply: "harness"` under the default `target: "engine"` drops the plugin
silently, which is exactly what a shared preset needs. Check
`kernel.plugins.resolved.plugins` for what was actually selected, and pass
`{ target: "harness" }` if your host is a harness.

**A hook never runs even though it resolved.** The kernel dispatches only the
config lifecycle. Every other hook runs when the host calls the dispatcher for
it, so a hook in the catalog that no host code dispatches is a handler nobody
calls.

**Mutating a plugin or a config object after startup changed nothing.**
Resolution copies everything it accepts. Dispatch reads the kernel's own frozen
records, never yours. Change the input and resolve again.

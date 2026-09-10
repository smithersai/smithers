---
title: "Hook kinds"
description: "The four dispatch shapes a hook can declare, what each promises about ordering, results, and failure, and how the type-level kind and the runtime catalog stay in agreement."
sidebar:
  order: 1
---

A hook is a name with a fixed dispatch shape. The shape is called its **kind**,
and the kernel fixes the four kinds: `sequential`, `parallel`, `first`, and
`waterfall`. A host picks a kind when it declares a hook, and that choice
decides how many handlers run, in what order, what the caller gets back, and
what a failing handler does to the caller.

## A hook entry is a handler or an ordering object

A plugin declares a hook either as a bare function or as Vite's per-hook
ordering object:

```ts
import { type FlowsPlugin, make } from "@smthrs/plugin"
import * as Effect from "effect/Effect"

const bare: FlowsPlugin = make({
  name: "flows-plugin-bare",
  hooks: { configResolved: () => Effect.void }
})

const ordered: FlowsPlugin = make({
  name: "flows-plugin-ordered",
  hooks: { configResolved: { order: "pre", handler: () => Effect.void } }
})
```

Both forms are the same handler to the dispatcher. `Hooks.handlerOf` and
`Hooks.orderOf` read either one. `undefined` and `null` are refused rather than
skipped, so a conditionally built plugin fails at startup with a path instead of
silently declaring nothing.

## What each kind promises

| Kind         | Which handlers run                                                             | What the caller receives                                                            | What a failing handler does                                                                                    |
| ------------ | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `sequential` | Every handler, in resolved order, one at a time. No two overlap.               | An array of every handler's success value, in resolved order.                       | Stops dispatch at that handler and fails the caller with `hook_failed`.                                        |
| `parallel`   | Every handler, concurrently, bounded by `parallelConcurrency` (16 by default). | An array of `PluginError`, in resolved handler order. Success values are discarded. | Nothing. The failure is returned, and the caller never fails.                                                  |
| `first`      | Handlers in resolved order until one answers `Option.some`.                    | That `Option`, or `Option.none()` when no handler answered.                         | Stops dispatch and fails the caller with `hook_failed`. A non-`Option` value fails with `invalid_hook_result`. |
| `waterfall`  | Every handler, each one seeing the value the previous handler produced.        | The final value.                                                                    | Stops dispatch and fails the caller with `hook_failed`.                                                        |

Choose by what the caller needs. Use `sequential` when every handler must run
and the caller reads every answer. Use `parallel` for observers whose failure is
not the caller's problem. Use `first` when the first plugin with an opinion
wins and the host has its own default for silence. Use `waterfall` when each
handler transforms a value the next one sees.

## Waterfall handlers return a patch, not the whole value

A waterfall dispatch takes a merge function alongside the initial value, and the
merge decides what a handler's answer means:

```ts
const merged = kernel.plugins.waterfall("config", initial, Config.merge)
const replaced = kernel.plugins.waterfall("tools", initial, (_previous, next) => next)
```

`Config.merge` deep-merges each returned patch into the accumulated
configuration, which is what makes the `config` hook a patch protocol. A host
that wants replacement passes `(_previous, next) => next`, which is what the
Smithers agent host in [`@smthrs/agent`](/api/agent) does for its registry,
flow, and model-request waterfalls. A handler that returns `undefined` (an
`Effect.void` handler) leaves the value untouched: the merge is not called at
all.

## The kind lives in the type and in the catalog

`SequentialHook`, `ParallelHook`, `FirstHook`, and `WaterfallHook` are phantom
carriers. They add nothing at runtime; they record the kind and the handler
signature in the type system so the dispatcher's methods can accept only the
hook names of their own kind:

```ts
declare module "@smthrs/plugin" {
  interface FlowsHooks {
    readonly toolCall: SequentialHook<(ctx: ToolCallContext) => Effect.Effect<Option.Option<ToolOverride>>>
  }
}
```

Calling `dispatcher.parallel("toolCall", ctx)` does not compile, because
`KeysOfKind<FlowsHooks, "parallel">` does not contain `toolCall`.

The type system cannot enumerate an augmentable interface, so the kernel also
needs the same information at runtime. That is the hook catalog a host passes as
`Resolve.Options.hooks`: a record from hook name to kind, typed as
`HookCatalog<H>` so a name the interface declares cannot carry another kind.
It is what the `unknown_hook` guard checks a plugin against, and it is what
[Declare hooks for your host](../guides/host-your-own-hooks.md) walks through.
Resolution keeps the admitted catalog as `Resolved.kinds`, refuses a catalog
that labels `config` or `configResolved` with another kind, and every dispatch
method refuses a hook whose catalog kind differs from its own with
`hook_kind_mismatch` before running a handler.

## Cancellation is fiber interruption

Nothing in the dispatcher threads an `AbortSignal`. Interrupting the fiber that
runs a dispatch interrupts the handler in flight, runs its finalizers, and skips
every handler that had not started, for both `sequential` and bounded `parallel`
dispatch. A handler that needs cleanup writes it with `Effect.onInterrupt` or
`Effect.acquireRelease` like any other Effect.

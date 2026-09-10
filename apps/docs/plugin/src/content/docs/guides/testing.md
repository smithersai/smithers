---
title: "Test a plugin"
description: "Exercise a plugin without booting a host: resolve a list, dispatch a hook, assert on ordering and typed failures, and stub the kernel out of a composition under test."
sidebar:
  order: 6
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/plugin/docs/guides/testing.md"
---

A plugin is a plain record and the dispatcher is a plain service, so a plugin
test needs no host, no engine, and no I/O. Resolve the list, dispatch the hook,
assert on the result.

## Dispatch a hook without a kernel

`Resolve.resolve` gives you the catalog and `Plugins.make` gives you the
dispatcher. Use them directly when the test is about one hook, with the hook
interface as an explicit type argument:

```ts
import { type FlowsPlugin, Plugins, Resolve, type WaterfallHook } from "@smthrs/plugin"
import * as Effect from "effect/Effect"
import { expect, it } from "vitest"

interface HostHooks {
  readonly tools: WaterfallHook<
    (tools: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<string> | void>
  >
}

const subject: FlowsPlugin<HostHooks> = {
  name: "flows-plugin-subject",
  hooks: { tools: (tools) => Effect.succeed([...tools, "read", "write"]) }
}

it("contributes its tools", async () => {
  const resolved = await Effect.runPromise(
    Resolve.resolve<HostHooks>([subject], { hooks: { tools: "waterfall" } })
  )
  const tools = await Effect.runPromise(
    Plugins.make<HostHooks>(resolved).waterfall("tools", [] as ReadonlyArray<string>, (_previous, next) => next)
  )
  expect(tools).toEqual(["read", "write"])
})
```

Use `Kernel.make` instead when the test is about the whole startup path: the
waterfall, the freeze, the observers, and the merged layer together.

## Startup hooks see no services

The shared `config` and `configResolved` hooks are context-free: `Kernel.make`
runs them before any plugin layer exists and supplies nothing itself, so a
handler that reads a service does not compile against `FlowsHooks`, and one
cast past the type fails at runtime with `hook_failed` on that hook. Provide
the service inside the hook, or, when a host's startup hooks genuinely require
services, declare a separate hook interface and provide them to the startup
Effect. `Kernel.make<H>` carries the requirement as `Kernel.StartupContext<H>`:

```ts
interface HostHooks {
  readonly config: WaterfallHook<
    (config: FlowsConfig) => Effect.Effect<Partial<FlowsConfig> | void, never, Settings>
  >
  readonly configResolved: ParallelHook<(config: ResolvedConfig) => Effect.Effect<void, never, Settings>>
}

const kernel = await Effect.runPromise(
  Kernel.make<HostHooks>([reader], {}, { hooks: { config: "waterfall", configResolved: "parallel" } }).pipe(
    Effect.provideService(Settings, { enabled: true })
  )
)
```

Without the `provideService`, the program does not compile.

## Assert the order, not just the membership

`resolved.plugins` is the resolved plugin order and
`resolved.handlers.get(hook)` is the ordered handler list for one hook, each
record carrying the plugin that declared it:

```ts
const names = (resolved: Resolve.Resolved, hook: string) =>
  (resolved.handlers.get(hook) ?? []).map((record) => record.plugin)

expect(names(resolved, "configResolved")).toEqual(["early", "normal", "late"])
```

Assert both when a plugin declares a per-hook `order`: the two lists differ on
purpose, and only the handler list proves the hook is positioned the way you
meant.

## Assert typed failures by code

Every refusal is a `PluginError` with a `code`, and most carry the plugin, the
hook, and the value path. Flip the Effect and match the fields you care about:

```ts
import { Kernel } from "@smthrs/plugin"

const error = await Effect.runPromise(
  Kernel.make([{ name: "duplicate" }, { name: "duplicate" }]).pipe(Effect.flip)
)
expect(error).toMatchObject({ code: "duplicate_name", plugin: "duplicate" })
```

Match on `code`, `plugin`, `hook`, and `path`, not on `message`. The codes are a
closed set, listed in [Troubleshooting](/troubleshooting/); the messages are
prose and may be reworded.

## Observer failures are a return value

A failing `configResolved` handler does not fail startup, so an assertion that
the kernel succeeded proves nothing about it. Read `observerErrors`:

```ts
const kernel = await Effect.runPromise(
  Kernel.make([{ name: "noisy", hooks: { configResolved: () => Effect.fail("boom") } }])
)
expect(kernel.observerErrors.map((error) => error.plugin)).toEqual(["noisy"])
```

## Stub the kernel out of a composition under test

When the subject is the host rather than the plugins, give it a dispatcher with
no plugins at all:

```ts
const dispatcher = Plugins.makeNoop()
```

`Plugins.layerNoop` is the same thing as a layer, for a composition that resolves
the shared `Plugins` service tag. Both dispatch nothing: a parallel hook returns
an empty error list, a first hook answers `Option.none()`, and a waterfall
returns the value it was given.

## Test the pure pieces directly

`Config.merge` and `Config.deepFreeze` are ordinary functions that throw a
`PluginError` rather than returning an Effect, so a merge-semantics test needs no
runtime:

```ts
import { Config } from "@smthrs/plugin"

expect(Config.merge({ a: { b: 1 } }, { a: { c: 2 } })).toEqual({ a: { b: 1, c: 2 } })
```

`Hooks.handlerOf` and `Hooks.orderOf` read either hook entry form and are the
same shape of test.

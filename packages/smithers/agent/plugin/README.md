# `@smthrs/plugin`

Release candidate scope, host requirements and compatibility review are defined in the [library support policy](https://github.com/smithersai/smithers/blob/main/RELEASE_SUPPORT.md).

This package declares `effect` as an exact `4.1.1` peer dependency. Install one
`effect` release at that version so all Smithers packages share one Effect
runtime.

**Documentation:** https://github.com/smithersai/smithers/tree/main/packages/smithers/agent/plugin/docs

A typed, bounded plugin kernel for Effect programs: Vite's plugin model, with
hooks that are ordinary Effects, ordering that follows Vite's rules exactly, and
a resolution boundary that copies every value a caller hands it.

```bash
npm install @smthrs/plugin@next effect
```

```ts
import { type FlowsPlugin, Kernel } from "@smthrs/plugin"
import { Effect } from "effect"

const feature: FlowsPlugin = {
  name: "flows-plugin-feature",
  hooks: {
    config: () => Effect.succeed({ feature: { enabled: true } }),
    configResolved: (config) => Effect.log(`feature enabled: ${config["feature"] !== undefined}`)
  }
}

const kernel = await Effect.runPromise(Kernel.make([feature]))
```

`kernel.config` is the frozen configuration every plugin agreed on,
`kernel.plugins` dispatches hooks, `kernel.layer` is every plugin's services
merged in resolved order, and `kernel.observerErrors` holds the failures that
`configResolved` observers reported without failing startup.

## The hook catalog is yours

The kernel owns one catalog of its own, the two-step config lifecycle. Every
other hook belongs to a host: declare it with TypeScript module augmentation,
hand the kernel the matching runtime catalog, and dispatch that catalog and
nothing else. `FlowsHooks` is open for augmentation and closed for dispatch.

```ts
declare module "@smthrs/plugin" {
  interface FlowsHooks {
    readonly toolCall: SequentialHook<(ctx: ToolCallContext) => Effect.Effect<Option.Option<ToolOverride>>>
  }
}
```

The shipped host is the Smithers agent loop in
[`@smthrs/agent`](https://github.com/smithersai/smithers/tree/main/packages/smithers/agent/docs), which adds three waterfalls to the
kernel's two hooks and dispatches them around each frame of an agent cell. Both
packages sit under the `smthrs` command line,
[`@smthrs/cli`](https://github.com/smithersai/smithers/tree/main/packages/smithers/docs).

## What it does not do

This is not an engine lifecycle registry. Retry, storage, concurrency, cache,
wait, journal, and ownership policy stay on the Effect service or constructor
option that applies them, and configuration refuses the root keys `engine`,
`retry`, `store`, and `plugins` so that a configuration file cannot imply
otherwise.

## Bounded by construction

Plugin names compare as exact Unicode and are never normalized. Resolution
validates every plugin record and hook entry before `apply` filtering, checks
hook names against the host catalog for the plugins it selected, snapshots
plugin records and hook objects, and exposes an immutable handler-map facade.
Configuration and cache identity are detached, bounded, strict JSON snapshots:
an `undefined` member is refused, not dropped. Mutating a caller's objects after
startup cannot change dispatch or sealed cache keys.

## Plugin manifests

A plugin can also be data. `Manifest.decode` admits a `plugin.json` that
declares views, slots, commands and keybindings, or refuses it naming the field.
`Load.load` checks a set of manifests against the host's facts, orders them by
`requires.plugins`, and folds them into one `Contributions` value; a bad plugin
is refused with a closed reason (`invalid`, `unsupported_point`,
`undeclared_use`, `conflict`, and so on) and the rest load. It runs no plugin
code. `PluginHost` is the contract a plugin's UI reads and dispatches through.

```ts
import { Load, Manifest } from "@smthrs/plugin"
import { Effect } from "effect"

const { contributions, refused } = await Effect.runPromise(Load.load(hostFacts, [
  { tier: "built-in", manifest: queueManifest }
]))
```

## Documentation

- [Quickstart](https://github.com/smithersai/smithers/blob/main/packages/smithers/agent/plugin/docs/quickstart.md): build a host with a hook
  of its own and run it.
- [Hook kinds](https://github.com/smithersai/smithers/blob/main/packages/smithers/agent/plugin/docs/concepts/hook-kinds.md),
  [Resolution](https://github.com/smithersai/smithers/blob/main/packages/smithers/agent/plugin/docs/concepts/resolution.md), and
  [Configuration](https://github.com/smithersai/smithers/blob/main/packages/smithers/agent/plugin/docs/concepts/configuration.md): the model
  behind the kernel.
- [Plugin manifests](https://github.com/smithersai/smithers/blob/main/packages/smithers/agent/plugin/docs/concepts/manifests.md):
  `plugin.json`, the loader's checks, and the host contract.
- [API reference](https://github.com/smithersai/smithers/blob/main/packages/smithers/agent/plugin/docs/api.md): every export, with
  signatures and limits.
- [Troubleshooting](https://github.com/smithersai/smithers/blob/main/packages/smithers/agent/plugin/docs/troubleshooting.md): every error
  code, what causes it, and what to change.

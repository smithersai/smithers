---
title: "Quickstart"
description: "Guard a host bundle end to end: refuse an ungranted read with an unattended store, then park the same read on an attended store and answer it."
sidebar:
  order: 2
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/kernel/docs/quickstart.md"
---

This quickstart guards a host with the capability kernel and runs the same
filesystem read twice: once against an unattended store, which refuses it, and
once against an attended store, where you answer the request the read parks
on. Nothing touches a real machine, so the run is deterministic.

By the end you will have seen the two shapes every kernel refusal takes: the
typed `PermissionRequired` that an unattended host reports, and the parked
request an operator resolves.

## Prerequisites

- Node.js 26.4.0 or later.
- A package that depends on `@smthrs/kernel` and has
  `"@smthrs/testing": "workspace:*"` in devDependencies. See
  [Installation](/installation/) for how to get them.
- A test runner, for the second half:

```bash
pnpm add -D @effect/vitest@4.0.0-rc.115 vitest@5.0.0
```

## Build the raw host

The kernel decorates ports; something else has to provide them.
`@smthrs/testing/TestHost` is the deterministic bundle: an in-memory
filesystem, a scripted interpreter, `TestClock`, and a seeded PRNG. `Workspace`
names the root that filesystem capability resources are resolved against.

Create `quickstart.test.ts`. Vitest only discovers files matching
`**/*.{test,spec}.?(c|m)[jt]s?(x)`, so the name is what makes the example
runnable:

```ts
import { GrantStore, HostServices, Permission, Workspace } from "@smthrs/kernel"
import * as TestHost from "@smthrs/testing/TestHost"
import { Effect, Fiber, FileSystem, Layer, Option, type PlatformError } from "effect"

/** The unguarded platform bundle plus the workspace root. */
const raw = Layer.mergeAll(
  TestHost.layer({ files: { "/workspace/README.md": "# hello" } }),
  Workspace.layer("/workspace")
)
```

## Refuse a read with no policy

`GrantStore.layer({ attended: false })` builds a store with no rules and
nobody to ask. `HostServices.layer` composed over the raw bundle replaces all
five tags with their guarded implementations:

```ts
const unattended = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const failure = yield* Effect.flip(fs.readFileString("/workspace/README.md"))
  return Option.getOrThrow(
    Permission.fromPlatformError(failure as PlatformError.PlatformError)
  )
}).pipe(
  Effect.provide(HostServices.layer),
  Effect.provide(Layer.orDie(GrantStore.layer({ attended: false }))),
  Effect.provide(raw),
  Effect.scoped
)
```

The program calls Effect's own `readFileString`. It never mentions permission,
and it is refused anyway, which is the point of decorating in place. Effect
fixes that method's error channel to `PlatformError`, so the kernel projects
its failure into one and keeps the structured original on the cause;
`Permission.fromPlatformError` reads it back:

```text
{
  _tag: '@smthrs/capability/PermissionRequired',
  code: 'permission_required',
  requestId: 'permission-1',
  capability: { action: 'fs:read', resource: '/workspace/README.md' },
  tier: 'sealed',
  meta: {}
}
```

`permission_required`, not `permission_denied`. No rule matched, so the
decision was `ask`, and an unattended store turns `ask` into a refusal that
names what it would have asked for. A `deny` would have produced
`permission_denied` instead. The `tier` is `sealed` because re-running a read
costs nothing; see [effect tiers](https://capability.smithers.sh/concepts/effect-tiers/).

## Answer the request instead

An attended store parks the asking fiber on a request and waits. Build the
store with `GrantStore.make` so you hold the service directly, fork the read,
read the pending request, and reply:

```ts
const attended = Effect.gen(function*() {
  const store = yield* GrantStore.make({ runId: "quickstart" })

  /** Polls until the forked read has parked. A real host waits on its own UI. */
  const pending = (): Effect.Effect<GrantStore.PendingRequest> =>
    Effect.flatMap(store.list, (requests) =>
      requests[0] === undefined
        ? Effect.andThen(Effect.yieldNow, pending())
        : Effect.succeed(requests[0]))

  return yield* Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const reading = yield* Effect.forkChild(fs.readFileString("/workspace/README.md"), {
      startImmediately: true
    })

    const request = yield* pending()
    // request.capability is { action: "fs:read", resource: "/workspace/README.md" }
    yield* store.reply(request.requestId, "once")

    return yield* Fiber.join(reading)
  }).pipe(
    Effect.provide(HostServices.layer),
    Effect.provideService(GrantStore.GrantStore, store)
  )
}).pipe(Effect.scoped, Effect.provide(raw))
```

`Fiber.join(reading)` answers `"# hello"`. The read did not fail and retry: it
suspended inside the decorator, and the reply woke it up to finish the
operation it was authorized for. `"once"` authorizes this request alone. The
other resolutions, `"run"`, `"remembered"`, and `"deny"`, are covered in
[Answer permission requests](/guides/answer-permission-requests/).

## Run it

Append the assertions to `quickstart.test.ts`, below both programs:

```ts
import { describe, expect, it } from "@effect/vitest"

describe("quickstart", () => {
  it.effect("refuses an ungranted read", () =>
    Effect.gen(function*() {
      expect((yield* unattended).code).toBe("permission_required")
    }))

  it.effect("resumes a read the operator allows", () =>
    Effect.gen(function*() {
      expect(yield* attended).toBe("# hello")
    }))
})
```

```bash
pnpm vitest run quickstart.test.ts
```

## What just happened

`HostServices.layer` is five middleware layers merged. Each one requires the
tag it also provides, so composing it over a platform bundle shadows the raw
implementations for everything downstream. Before delegating, the filesystem
decorator resolved `/workspace/README.md` to a canonical resource, built the
capability `fs:read` on it, and handed it to the store. The store found no
matching rule, defaulted to `ask`, and either refused or parked depending on
whether anybody was there to answer.

Nothing in either program held an unguarded `FileSystem`. That is the whole
design: there is no second, protected tag to reach for, so there is no
unguarded one to hold.

## Next steps

- [Write a capability policy](/guides/write-a-capability-policy/): rules
  that answer `allow` before anyone is asked.
- [Guard a host bundle](/guides/guard-a-host-bundle/): the same composition
  over a real platform.
- [How a grant decision is made](/concepts/grant-decisions/): the ceiling,
  the four rulesets, and the order they are consulted in.

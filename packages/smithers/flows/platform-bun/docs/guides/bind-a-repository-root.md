---
title: "Bind the host to a repository root"
description: "Use BunHost.layerAt and BunHost.layerContainedAt so the Jj slot runs against one absolute repository root instead of the process working directory, and handle the refusal they throw."
---

`BunHost.layer` binds the `Jj` slot to the process working directory. That is
the right default for a command-line tool a person runs inside a repository,
and the wrong one for a long-lived host: the working directory is ambient
state that some other part of the program can change, and a host that inherits
it commits version-control operations against whichever repository happened to
be current.

`BunHost.layerAt` binds the slot to one root you name.

## Bind the root

```ts
import { Jj } from "@smthrs/jj"
import { BunHost } from "@smthrs/platform-bun"
import * as Effect from "effect/Effect"

const program = Effect.gen(function*() {
  const jj = yield* Jj
  return yield* jj.status()
})

Effect.runPromise(
  Effect.scoped(Effect.provide(program, BunHost.layerAt("/srv/repositories/app")))
)
```

The other four slots are identical to `BunHost.layer`. Only `Jj` changes: it
is built with `BunJj.layerAt(root)` instead of `BunJj.layer`.

`BunHost.layerContainedAt` is the same substitution on the contained bundle.
Use it whenever you want both properties, which is the usual case for a
supervisor:

```ts
BunHost.layerContainedAt("/srv/repositories/app", { graceMs: 2_000 })
```

## Pass an absolute root

Both factories require an absolute path. A relative root, and the empty string,
are refused:

```ts
BunHost.layerAt("repositories/app")
// throws BunHostError: BunHost.layerAt requires an absolute repository root,
// got "repositories/app"
```

Three properties of that refusal matter when you handle it.

**It throws rather than fails.** A factory is called while your program
composes its layers, where there is no fiber to fail into. A wrong root is a
composition mistake, not a runtime outcome, so it surfaces where the mistake
was written, before any layer exists.

**It is this package's error, not the adapter's.** The `Jj` adapter underneath
would also refuse, with a bare `TypeError` that names `NodeJj.layerAt`, carries
no code, and echoes the whole string. You composed `BunHost`, so you get
`BunHost.BunHostError`, whose message names the Bun factory that refused and
mentions no adapter.

**Branch on `code`, never on the message.** The message is for a person and its
wording is not a contract:

```ts
import { BunHost } from "@smthrs/platform-bun"

try {
  return BunHost.layerAt(configuredRoot)
} catch (error) {
  if (error instanceof BunHost.BunHostError && error.code === "invalid_repository_root") {
    throw new Error(`SMITHERS_REPOSITORY_ROOT must be an absolute path, got ${configuredRoot}`)
  }
  throw error
}
```

`BunHost.BunHostErrorCode` is the union of codes a factory refuses with; today
`"invalid_repository_root"` is the only member.

## Roots that come from input

A root read from an environment variable, a request, or a configuration file is
untrusted text, and it lands in a log line the moment it is refused. The whole
message stays under 256 UTF-16 code units for a root of any content and any
length, so a hostile root cannot flood the line. A root is quoted in full when
it is 64 code points or fewer and its quoted form fits that bound. Otherwise
it is cut: the message carries a quoted excerpt of at most 64 code points,
then `... (N characters)` with the root's true length in code points.

The excerpt is passed through `JSON.stringify`, so a newline in the root
cannot break the line it lands on. Escaping widens some characters: a control
character becomes a six-character `\u0001`, so a root made of them is cut
well before 64 code points. The cut is counted in code points rather than
UTF-16 units and lands between escapes, so it never splits a surrogate pair
or an escape, and the excerpt is always one valid JSON string.

## Related

- [Contain and reap child processes](./contain-child-processes.md): what
  `layerContainedAt` adds on top of the root binding, including why `jj` runs
  through the contained spawner.
- [`@smthrs/jj`](/api/jj): the `Jj` contract itself, its failure codes, and
  choosing which `jj` binary runs.

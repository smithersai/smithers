---
title: "Implement your own search peer"
description: "Bind a third implementation of the Search service using the shared matcher, then prove it agrees with a reference peer using the differential conformance kit."
sidebar:
  order: 9
---

`Search` is a public extension seam. A host binds its own implementation and
every `grep` and `glob` call in the package goes through it, so an index server,
a remote service, or a virtual filesystem can back the search flows. This guide
is about filling that seam without drifting from what a pattern means.

## The interface

Two methods, both taking normalized input:

```ts
import { Search } from "@smthrs/std"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

const peer = Search.make({
  grep: (input) =>
    Effect.succeed({
      matches: [],
      files: [],
      filesSearched: 0,
      skippedBinary: 0,
      truncated: false
    }),
  glob: (input) => Effect.succeed({ paths: [], total: 0, truncated: false })
})

const layer = Layer.succeed(Search.Search, peer)
```

`Grep.run` and `Glob.run` do the validation and defaulting before they call you,
so `GrepInput` and `GlobInput` arrive complete: `root` is resolved, `globs` is an
array, the context fields are numbers, and `limit` is already capped. Your
implementation never sees an undefined option.

The error channel is `StdError`, and the codes a peer produces are `not_found`
for a missing root, `invalid_pattern` for a pattern it cannot compile, and
`command_failed` for a host failure of its own.

## Reuse the shared matcher

Do not reimplement pattern or glob semantics. `SearchContract` exports exactly
the functions both shipped peers build on:

```ts
import { SearchContract } from "@smthrs/std"

SearchContract.validatePattern(pattern, fixedStrings) // StdError | undefined
SearchContract.validateGlob(glob) // StdError | undefined
SearchContract.canonicalGlob("./src/**/*.ts ") // "/src/**/*.ts"
SearchContract.expression(pattern, fixedStrings, insensitive) // a RegExp
SearchContract.matchesGlob("*.ts", "src/widen.ts", "widen.ts") // true
SearchContract.includedByGlobs(globs, relative, basename) // ordered include and exclude
SearchContract.unsatisfiableNotice({ fileSystem, path, root, globs, hidden })
```

`matchesGlob` and `includedByGlobs` take a candidate's path **relative to the
root** and its basename, which is the whole of the root-relative rule described
in [The search contract](../concepts/search-contract.md).

`unsatisfiableNotice` is what keeps an empty answer honest: attach its result to
`notice` when your peer produced no entries, so "the tree holds no match" and
"this pattern can never match" stay distinguishable.

## Prove it agrees

`SearchConformance` generates a tree and a batch of calls from a seed, runs them
through two implementations, and reports every answer that differs. It knows
nothing about which peer is right: a divergence is the finding.

```ts
import { NodeServices } from "@effect/platform-node"
import type * as KernelPath from "@smthrs/kernel/Path"
import { PortableSearch, type Search, SearchConformance } from "@smthrs/std"
import * as Effect from "effect/Effect"
import type * as FileSystem from "effect/FileSystem"

const check = (subject: Search.Search) =>
  Effect.gen(function*() {
    const plan = SearchConformance.plan({
      seed: 1234,
      root: "/tmp/conformance",
      files: 24,
      calls: 40
    })
    yield* SearchConformance.materialize(plan)

    const services = yield* Effect.context<FileSystem.FileSystem | KernelPath.Path>()
    const divergences = yield* SearchConformance.compare({
      plan,
      subject,
      reference: PortableSearch.make(services)
    })
    return SearchConformance.report(divergences)
  })

const report = await Effect.runPromise(Effect.provide(check(peer), NodeServices.layer))
```

| Export        | What it does                                                          |
| ------------- | --------------------------------------------------------------------- |
| `plan`        | Builds a reproducible tree and call batch from a seed.                |
| `materialize` | Writes that plan's tree under its root.                               |
| `compare`     | Runs every call through both peers and returns the `Divergence` list. |
| `report`      | Renders divergences as the text a failing run should print.           |

The same seed and root always produce the same plan, so a divergence a run
reports replays exactly by rerunning that seed. A failure is compared like any
other answer: two peers that refuse the same call with the same code agree, and
one that refuses where the other answers has diverged.

`PortableSearch` is the obvious reference, because it needs no external binary.

## What the generator will not tell you

The generator deliberately stays inside the ground both peers claim to share: no
symlinks, no unreadable directories, no NUL bytes, no filename a shell
would have to quote. Those cases have an intended behavior rather than merely an
agreed one, and a generator can only say that two peers disagree, never which is
right. Pin them with hand-written cases alongside the conformance run, including raw
UTF-16 bytes with a BOM. Generated text includes bare CR and CRLF boundaries
and probes them with anchors and patterns that would cross a bare CR.

The kit earns its place on the cases nobody thought to write down. A literal `?`
matched `fo` in one shipped peer and `foo?` in the other for as long as nobody
wrote that case; the generator found it, along with a `maxCount` interaction with
context lines and a disagreement between `ignoreCase` and `smartCase`.

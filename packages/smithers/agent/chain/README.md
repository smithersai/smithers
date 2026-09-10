# @smthrs/chain

**Documentation:** https://chain.smithers.sh

A crash-safe agent loop for TypeScript. A model writes a small JavaScript
program, the program's only way to reach the outside world is
`ctx.call(name, payload)`, and every call is recorded in an append-only
journal before the loop moves on.

Chain provides exactly-once replay of journaled settled calls and
at-least-once handler execution. A matching settled call replays its recorded
result without running its handler. If a handler succeeds but a crash or
append failure prevents `CallSettled` from being recorded, resume can execute
the handler again. Handlers must be idempotent or, for non-repeatable effects,
use an external durable idempotency key derived from the stable call identity
(`chain`, `link`, `ordinal` in `Catalog.CallSlot`).

The journal is the only state. Every other structure, including the call
cache used for replay, transcripts, and UIs, is a pure fold over it. Each
call settles as a journaled event keyed by its link, the digest of the script
that issued it, its ordinal, and the callee's declaration digest, so a
resumed run serves a recorded result only when all four still match and fails
loudly with `replay_divergence` instead of serving a stale one.

## Install

`@smthrs/chain` is not on the npm registry. It is developed in the
[Smithers repository](https://github.com/smithersai/smithers) and is used
today from a checkout of it. It needs Node.js 22.19.0 or later and
[Effect](https://effect.website).

## Run a chain

This runs a whole chain to a terminal outcome with no model account: a mock
author supplies the script, an in-memory journal records the events, and the
production QuickJS runner executes it.

````ts
import { Author, Catalog, Chain, Journal, QuickJsRunner } from "@smthrs/chain"
import { Effect, Layer } from "effect"

const grep: Catalog.Entry = {
  name: "grep",
  description: "Search the workspace for a pattern",
  handler: () => Effect.succeed({ files: ["a.ts", "b.ts"] })
}

const script = [
  "```flow",
  `const hits = await ctx.call("grep", { pattern: "TODO" })`,
  "return done({ matched: hits.files.length })",
  "```"
].join("\n")

const layers = Layer.mergeAll(
  Journal.layerMemory(),
  Author.layerMock([script]),
  QuickJsRunner.layer(),
  Catalog.layer(Catalog.withSystem([grep]))
)

const outcome = await Effect.runPromise(
  Chain.run({ goal: "count the TODOs" }).pipe(Effect.provide(layers))
)
// { _tag: "Done", value: { matched: 2 } }
````

Swap `Author.layerMock` for `ModelAuthor.layer(config)` over a real model and
the same four layers drive a real agent. `Chain.run` requires `Journal`,
`Catalog`, `Author`, and `ScriptRunner`, and picks up the optional
`Authorize` and `Steering` seams when they are mounted. A catalog layer that
itself needs those services, such as `SubChains`, must be built over the SAME
instances the chain runs on.

## Two runners, one sandbox

`QuickJsRunner.layer()` is the production sealed interpreter: a fresh QuickJS
realm per link with memory, stack, and step limits and no host globals.
`ScriptRunner.layerInProcess` provides NO isolation. The `Function`
constructor builds its body in global scope, so a script reaches
`globalThis`, `process`, and dynamic `import()`. Use it for trusted fixtures
only.

## Failures

A run fails with `ChainError` (`replay_divergence`, `invalid_journal`),
`JournalError` (`journal_conflict`, `journal_unavailable`), `AuthorError`
(`exhausted`, `author_unavailable`), `AuthorizeError`
(`authorize_unavailable`, and `denied` for the model seat), or
`SteeringError` (`steering_unavailable`). Everything else, including a
failing script, a failing handler, a value that will not serialize, and a
denied or unknown catalog call, becomes a journaled observation the next
author routes around.

## Limits a caller inherits

32 links per chain, 64 calls per link, 4 levels of sub-chain nesting, a
64 MiB QuickJS heap with a 256 KiB stack and a 10000-poll step budget, and a
JSON boundary bounded at depth 128 and an 8 MiB size budget.

`./internal/*` is null-mapped in the export map and carries no promise.

## Documentation

The full documentation is at https://chain.smithers.sh:

- [Quickstart](https://chain.smithers.sh/quickstart/): a two-link run, the
  journal it writes, and the replay that repeats nothing.
- [API reference](https://chain.smithers.sh/reference/api/): every export of
  the 20 namespaces.
- [The chain contract](https://chain.smithers.sh/contract/): the gates, the
  failure taxonomy, the concurrency rule, the resource limits, and the JSON
  boundary.
- [Troubleshooting](https://chain.smithers.sh/troubleshooting/): every typed
  failure a run can carry, what causes it, and what to do.

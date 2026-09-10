---
title: "@smthrs/chain"
description: "A crash-safe agent loop for TypeScript: an append-only journal, keyed replayable calls, and a sealed sandbox that runs model-authored scripts."
---

`@smthrs/chain` runs a model-driven agent loop that survives a crash. The
model writes a small JavaScript program, the program's only way to reach the
outside world is `ctx.call(name, payload)`, and every call is recorded in an
append-only journal before the loop moves on.

Chain provides exactly-once replay of journaled settled calls and
at-least-once handler execution. A matching settled call replays its recorded
result without running its handler. If a handler succeeds but a crash or
append failure prevents `CallSettled` from being recorded, resume can execute
the handler again. Handlers must be idempotent or, for non-repeatable effects,
use an external durable idempotency key derived from the stable call identity
(`chain`, `link`, `ordinal` in `Catalog.CallSlot`).

## Why you would reach for it

An agent that calls tools, edits files, and spends money on model tokens is a
long-running program that can die in the middle. Restarting from scratch
re-sends the emails and re-applies the patches; restarting from a hand-rolled
cache serves stale results after you rename a tool. Four properties of this
package address that:

- **Replay settled calls without running their handlers.** Every settled call carries a key
  built from the link, the digest of the script that issued it, its ordinal,
  and the digest of the called entry's declaration. A resumed run serves a
  recorded result only when all four still match, and fails loudly with
  `replay_divergence` instead of serving a stale one.
- **One door for every effect.** A script has no import, no fetch, and no
  filesystem. It calls catalog entries you wrote, so the list of things an
  agent can do is a list you can read.
- **A sealed sandbox.** The production runner executes each authored script
  in a fresh QuickJS realm with memory, stack, and step limits, and without
  `Date` or `Math.random`, so time and randomness are journaled calls and
  replay stays deterministic.
- **A policy seam per call.** Mount `Authorize` and every call is decided
  against the capabilities its entry declares. A call that needs approval
  parks the run in place and re-asks after you grant it.

You own the model seat, the entries, and the storage. This package owns the
loop, the journal keys, and the sandbox.

## Install

`@smthrs/chain` is not on the npm registry; it is used today from a checkout
of the [Smithers repository](https://github.com/smithersai/smithers). It
targets Node.js 22.19.0 or later and depends on
[Effect](https://effect.website). For requirements, import paths, and the
services a run needs, see [Installation](./installation.md).

## Run a chain

This example runs a whole chain to a terminal outcome with no model account:
a mock author supplies the script, an in-memory journal records the events,
and the production QuickJS runner executes it.

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
the same four layers drive a real agent. The
[Quickstart](./quickstart.md) extends this run to two links, reads the
journal it wrote, and replays it.

## How this fits the rest of Smithers

`@smthrs/chain` is the standalone spine. It needs four services and nothing
else: no durable engine, no flow runtime, no control plane. Reach for it when
you are building your own host and want the journal, the replay keys, and the
sandbox without the rest.

[`@smthrs/agent`](/api/agent) is the parent package and the fuller answer.
It composes the production Smithers agent loop on the durable engine, and it
ships the two adapters that run it: `AgentSession` for control-plane runs an
operator can watch, steer, and approve, and `AgentAction` for a typed
model-backed step inside a larger flow. If you want an agent that plugs into
runs, approvals, and workflows rather than a loop you assemble yourself,
start there.

Both sit under [`@smthrs/cli`](/api/cli), the `smithers` command that runs
and inspects agents from a terminal.

## Where to go next

- [Installation](./installation.md): requirements, import paths, and the
  layers `Chain.run` needs.
- [Quickstart](./quickstart.md): a two-link run, the journal it writes, and
  the replay that repeats nothing.
- Concepts: [The journal](./concepts/journal.md),
  [Keyed replay](./concepts/keyed-replay.md),
  [The trampoline](./concepts/trampoline.md), and
  [Flow scripts](./concepts/flow-scripts.md).
- Guides: [Write catalog entries](./guides/catalog-entries.md),
  [Authorize calls](./guides/authorization.md),
  [Resume and replay](./guides/resume-and-replay.md),
  [Run sub-agents](./guides/sub-chains.md),
  [Steer a run](./guides/steering.md),
  [Project the registry and bind memory](./guides/registry-and-memory.md), and
  [Test a chain](./guides/testing.md).
- [API reference](./api.md): every export of the 19 namespaces.
- [The chain contract](./contract.md): the gates, the failure taxonomy, the
  concurrency rule, the resource limits, and the JSON boundary.
- [Troubleshooting](./troubleshooting.md): every typed failure a run can
  carry, what causes it, and what to do.

## Limits you inherit

Defaults a caller gets without asking: 32 links per chain, 64 calls per link,
4 levels of sub-chain nesting, a 64 MiB QuickJS heap with a 256 KiB stack and
a 10000-poll step budget, and a JSON boundary bounded at depth 128 and an
8 MiB size budget. Every default and the constant that carries it is in
[The chain contract](./contract.md).

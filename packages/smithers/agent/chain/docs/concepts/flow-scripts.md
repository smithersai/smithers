---
title: "Flow scripts"
description: "The artifact a model authors: text plus a digest, one fenced flow block, ctx.call as the only door, and the sealed realm it runs in."
sidebar:
  order: 4
---

A flow script is the authored artifact of one link: JavaScript text paired
with the content digest that keys every call the script makes. The model
writes it; the chain extracts, journals, and executes it.

## The shape gate

The author replies with raw model output. `Script.extract` applies gate 1:
the reply must contain exactly one fenced `flow` block, whose body becomes
the script. Zero blocks or two or more blocks is a rejection the next
authoring reads, not a crash.

````text
```flow
const hits = await ctx.call("grep", { pattern: "TODO" })
return done(hits.files)
```
````

`Script.make` digests the text, and the digest is the replay identity of
every call the script makes. Editing one character re-keys exactly the calls
inside the script and nothing else. For the key, see
[Keyed replay](./keyed-replay.md).

## The doors a script has

A script's only intended exits are `ctx.call(name, payload)` and the outcome
it returns:

- `ctx.call(name, payload)` settles one catalog call. The name must be a
  string, and the payload must cross the JSON boundary. Calls settle one at
  a time, in issue order, and the promise resolves to the journaled result.
- `done(value)` ends the chain with a JSON value (`undefined` becomes
  `null`).
- `to(script)` hands off to a successor script. The successor's digest is
  re-derived from its text: a script chooses the text it hands on, never the
  replay identity that text is keyed by.
- `park(code, message)` suspends the lineage with a typed waiting reason.

Returning anything else, or a value that is not JSON, fails the script with
`invalid_outcome`. `ctx.call` is the only EXTERNAL asynchronous operation:
there is no timer, network, or file system door, so nothing else can settle
from outside the script. Local promise composition works in both runners
(`await Promise.resolve(42)`, `Promise.all` over several calls,
`Promise.race`, `.catch`), because each runner drains the script's own
promise jobs before it decides the script is stuck. A script that is still
pending with no runnable jobs and no queued catalog call, such as
`await new Promise(function () {})`, fails with `runtime`. These failures
become journaled `script_failed` observations the next author routes around;
they never reach the run's error channel.

## The sealed realm

`QuickJsRunner.layer()` runs each script in a fresh QuickJS realm compiled to
WebAssembly: no reference to the host's globals, prototypes, or module
loader, with memory, stack, and step limits enforced by the runtime itself.
The prelude deletes `Date` and `Math.random`, so the only sources of time and
randomness are the `sys/now` and `sys/random` catalog entries, journaled like
any call. That is what makes replay deterministic.

Every value crossing the bridge in either direction passes the JSON boundary:
only `null`, finite numbers, strings, booleans, and acyclic plain objects and
arrays cross, and what crosses is a structural copy. For the copy semantics
and the limits, see [The chain contract](../contract.md).

`ScriptRunner.layerInProcess` is the other binding and provides NO
isolation: the script body runs as an async `Function` in global scope and
reaches `globalThis`, `process`, and dynamic `import()`. It exists for
trusted fixtures and for this package's own tests. `QuickJsRunner.layer()` is the only
sandbox for model-authored scripts.

# `@smthrs/merge-queue`

A merge queue whose rules are proved in Lean. The queue owns one target branch
and moves it only onto a tree whose every required check passed, for exactly
that tree. It consumes check results as they stream in, sends a failing change
to a fix agent at its first failed check, bisects failing batches, puts a
change that cannot be fixed out of the queue with a written reason, and
predicts check durations from past runs.

The package has two halves that say the same thing. `lean/` is the reference:
an executable Lean 4 model of the queue with a proof of every invariant in
[`lean/INVARIANTS.md`](lean/INVARIANTS.md). `src/` is the implementation: the
same states, transitions and names in TypeScript, one definition per Lean
definition. A differential fuzz test runs random event traces through both and
fails on the first line that differs.

The kernel (`step`, `plan`) is pure TypeScript with no dependencies. The
driver that runs it against CI, fix agents and the target branch is written in
Effect and reaches the world only through four injected services. Nothing
imports a Node built-in, so it runs in a browser, a Worker, Node and Bun.

**Documentation:** [`docs/`](docs/README.md)

## Install

The package is private in this repository. Add it as a workspace dependency,
with `effect` at this exact version.

```json
{
  "dependencies": {
    "@smthrs/merge-queue": "workspace:*",
    "effect": "4.1.1"
  }
}
```

## Quickstart

```ts
import { type Config, empty, plan, step } from "@smthrs/merge-queue"

const config: Config = {
  required: [1, 2], // every check a tree must pass
  maxAttempts: 2, // fix attempts per change
  maxBatch: 4, // changes tested together
  maxRuns: 2, // undecided CI runs at once
  window: 20, // duration samples kept per check
  defaultDuration: 60
}

let state = step(config, empty, { _tag: "enqueue", id: 7, priority: 0 })

// Ask the policy what to do next, and do it, until it has to wait.
for (let event = plan(config, state); event !== undefined; event = plan(config, state)) {
  state = step(config, state, event)
}

// CI streams results in; a result is one more event.
state = step(config, state, { _tag: "result", run: 0, check: 1, verdict: "pass", duration: 31 })
```

## Learn more

- [What the queue guarantees and how it works](docs/README.md)
- [API reference](docs/api.md)
- [The invariants and their theorems](lean/INVARIANTS.md)

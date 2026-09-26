# Flows, actions and replay

`@smthrs/flow` is the authoring model for durable workflows. An action is a stable name and the schemas on either side of it. A flow's body is a pure function that builds a plan. The code that does the work attaches separately, as an Effect layer. The package carries no engine; it declares the `FlowRuntime` port that an engine implements.

## Declare and implement one capability

```ts
const Summarize = Action.make("digest/Summarize", {
  payload: { url: Schema.String },
  success: Schema.String
})

const Digest = Flow.make("digest/Digest", {
  payload: { url: Schema.String },
  success: Schema.String,
  body: Node.capture(
    { action: Summarize.name, implementationVersion: "digest/v1" },
    (payload) => Summarize.call(payload)
  )
})

const layer = Interpreter.layerWithImplementations(
  Digest,
  Summarize.toLayer(({ url }) => Effect.succeed(`A summary of ${url}.`))
)
```

`Summarize.call` plans a step and runs nothing. A flow has no `toLayer`: its only behavior is its body. `Action.make` with a string tag is the declared form, pure data with no code; the inline form carries its `execute` effect directly.

## Missing implementations fail at compile time

Each declared action mints one context key from its tag. `Flow.make` reads the union of those keys off the node its body returns, and `toLayer` provides the key, so a composition missing an implementation fails to compile. At run time `Action.Implementations` is a table keyed by action tag, and `Action.layerImplementations` goes under the implementation layers.

`Action.makeSystem` erases the requirement. `Sleep`, `WaitFor` and `HumanTask` use it, so waiting pushes no layer obligation onto callers.

## Tiers describe retries

| Tier | Meaning |
| --- | --- |
| `sealed` | The default; a recorded result can be replayed. |
| `compensable` | The engine restores a workspace pre-image before the next attempt. |
| `irreversible` | Retrying without a declared `idempotencyKey` fails. |

## Replay is keyed by execution id

An engine records each step as it settles, so a re-run under the same execution id reads the recorded result rather than repeating the work. `Node.capture` declares semantic values outside the callback source, including a version for imported behavior; changed source, captures or implementation versions require a newly planned run. `FlowEngine.layerMemory` is the in-memory engine; the SQLite-backed engine in `@smthrs/engine-store` makes the same behavior survive a restart.

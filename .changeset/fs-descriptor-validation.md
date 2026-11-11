---
"@smthrs/fs": patch
---

`FlowInvoker` constructors now enforce their documented own data-property function requirement
and throw `TypeError` immediately for invalid implementations or supplied overrides.

`makeNoop` and `layerNoop` use the default only when `invoke` is absent;
a supplied `invoke: undefined` throws `TypeError`.

VibeLang consumers must handle the constructors' synchronous exception contract. For example,
replace top-level construction in `examples/quickstart.vibe` with an Effect:

```vibe
const invoker = Effect.try(() => FlowInvoker.make({
  invoke: effect ({ input }) => input
}))

effect function execute(invocation: FlowInvoker.Invocation) {
  provide FlowInvoker.FlowInvoker = try invoker {
    return try (try FlowInvoker.FlowInvoker).invoke(invocation)
  }
}
```

The same `Effect.try` bridge applies to `makeNoop` and `layerNoop`.

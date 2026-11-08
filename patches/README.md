# Dependency patches

Patch registrations and removal conditions live beside `patchedDependencies` in `pnpm-workspace.yaml`.

## effect@4.1.1

`effect@4.1.1.patch` corrects `Schema.Json`'s public type annotation in both shipped source and declarations. `JsonValueSchema` extends `Codec<Json>` and publishes the actual required readonly decoded/encoded key flags and a precise `Rebuild`. It retains Codec's other views. There is no runtime or VibeLang compiler change.

The erased flags made valid VibeLang schema fields fail EK2109 under VIP-15. `apps/vibelang/test/schemaJson.test.vibe` compiles positive fields, aliases, annotation/check/rebuild, nesting, errors, tuples and records. Negative cases retain strict optional/mutable/widened-key rejection and missing-key rejection.

Drop this patch when upgrading to an Effect release whose Json schema exposes these literal flags and retains them through rebuilds, after the positive and negative regressions pass without it. The same source correction and type/runtime tests landed in [smithersai/effect, c30802502817](https://github.com/smithersai/effect/commit/c30802502817062118a6b58904a362b6d2863ace) for upstream contribution. See VibeLang decision 0023.

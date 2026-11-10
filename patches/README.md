# Dependency patches

Patch registrations and removal conditions live beside `patchedDependencies` in `pnpm-workspace.yaml`.

## effect@4.1.1

`effect@4.1.1.patch` corrects `Schema.Json`'s public type annotation in both shipped source and declarations. `JsonValueSchema` extends `Codec<Json>` and publishes the actual required readonly decoded/encoded key flags and a precise `Rebuild`. It retains Codec's other views. There is no runtime or VibeLang compiler change.

The erased flags made valid VibeLang schema fields fail EK2109 under VIP-15. `apps/vibelang/test/schemaJson.test.vibe` compiles positive fields, aliases, annotation/check/rebuild, nesting, errors, tuples and records. Negative cases retain strict optional/mutable/widened-key rejection and missing-key rejection.

Drop this patch when upgrading to an Effect release whose Json schema exposes these literal flags and retains them through rebuilds, after the positive and negative regressions pass without it. The same source correction and type/runtime tests landed in [smithersai/effect, c30802502817](https://github.com/smithersai/effect/commit/c30802502817062118a6b58904a362b6d2863ace) for upstream contribution. See VibeLang decision 0023.

## @vitest/coverage-v8@5.0.0

The existing native-loader patch keeps Vite offsets/maps limited to code Vite actually transformed. The provider
also normalizes source-map open-ended **end** columns (`Infinity`) to the original line's UTF-16 length before
Istanbul merges counters. Otherwise native Node subprocess ranges and transformed/zero-seed ranges can create two
counters for one original branch or function, one incorrectly left at zero. Finite positions and all hit counts are
retained; missing source text leaves the range unchanged. This changes coverage reporting, not application code,
VibeLang lowering or source maps.

`apps/vibelang/test/coverageProvider.test.vibe` compiles and runs real JS and VibeLang programs in Node subprocesses,
then invokes Vitest's public coverage command. Both complete parameter matrices must reach all four 100% metrics;
unvisited conditional returns and an unused function sharing a line with a called one must still fail the gate.
The ordinary negative control in `sourceCoverage.test.vibe` retains the unvisited original `.vibe` return at line 4.

Remove the normalization hunk when the upstream provider merges these source ranges correctly and all six controls
pass without it. Minimal raw before/after evidence is in the coverage lane report; no upstream write is authorized.

## @alchemy.run/cloudflare@2.0.0-beta.85

The `lib/Workers/WorkerProvider.js` hunk is explained beside its registration in `pnpm-workspace.yaml`.

The `DurableObjectBridge` hunks (`lib/` and `src/`) give each Durable Object constructor its own open `Scope`, held
for the in-memory instance's life. `DurableObject.make` declares that the constructor's inner Effect needs `Scope`,
and captures the services of the Effect that built the object's layer. When the host Worker provides that layer
with `Effect.provide`, the form Alchemy documents, those services hold a scope that closes once Worker init returns.
The bridge passed that closed scope to every constructor. Work forked into it, such as `apps/vibelang`'s bounded
object start-up (`worker/ObjectStartup.vibe`), was interrupted before it ran, and every object stayed `starting` in
production on 2026-11-10.

`apps/vibelang/test/coldStartup.workerd.test.vibe` runs `alchemy dev` and starts every class cold at once. Without
the hunk, no object becomes `ready`; with it, all do. Drop the hunk when an Alchemy release provides constructors an
open scope and that test passes without it. Its minimal form: a Durable Object provided to its Worker by
`Effect.provide`, whose constructor runs `Effect.forkIn(work, yield* Scope.Scope)`; `work` never starts. No upstream
write is authorized; the lane report holds the evidence.

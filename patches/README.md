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

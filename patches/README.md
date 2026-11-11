# Dependency patches

Patch registrations and removal conditions live beside `patchedDependencies` in `pnpm-workspace.yaml`.

## effect@4.1.1

`effect@4.1.1.patch` corrects `Schema.Json`'s public type annotation in both shipped source and declarations. `JsonValueSchema` extends `Codec<Json>` and publishes the actual required readonly decoded/encoded key flags and a precise `Rebuild`. It retains Codec's other views. This type correction has no runtime or VibeLang compiler change.

The erased flags made valid VibeLang schema fields fail EK2109 under VIP-15. `apps/vibelang/test/schemaJson.test.vibe` compiles positive fields, aliases, annotation/check/rebuild, nesting, errors, tuples and records. Negative cases retain strict optional/mutable/widened-key rejection and missing-key rejection.

The patch adds a name stock effect@4.1.1 does not export, and published packages declare `effect` as a peer, so
consumers resolve the stock copy. Declarations emitted here named `Schema.JsonValueSchema` wherever a schema holds
`Schema.Json`, and a consumer's typecheck failed with TS2694 (the 1.0.0-rc.17 release smoke: 478 references in 20
packages). `portableEffectDeclarations` in `packages/repo-targets/scripts/build-library.mjs` rewrites each reference
to `(typeof Schema.Json)` after every package compile and fails the build on one it cannot rewrite;
`packages/repo-targets/test/BuildLibrary.test.ts` covers both. Delete it together with the patch.

Drop this patch when upgrading to an Effect release whose Json schema exposes these literal flags and retains them through rebuilds, after the positive and negative regressions pass without it. The same source correction and type/runtime tests landed in [smithersai/effect, c30802502817](https://github.com/smithersai/effect/commit/c30802502817062118a6b58904a362b6d2863ace) for upstream contribution. See VibeLang decision 0023.

The same patch repairs RPC stdio recovery in shipped source, JavaScript and declarations. The stock NDJSON
parser already clears its text buffer on a rejected line, but loses other frames in that chunk and retains its
streaming UTF-8 decoder state. An optional per-frame error callback preserves valid frames and unfinished tails;
callers without it keep the throwing API and reset both text and UTF-8 state on failure. NDJSON JSON-RPC forwards
the callback. Stdio consumes each chunk once, queues a safe JSON-RPC parse error (-32700, null id), and continues
the same subscription. Permanent stdin or stdout failures log once and terminate; neither is silently retried.

Built with `pnpm patch effect@4.1.1 --edit-dir <scratch>`, editing source and the matching shipped `dist` files,
then `pnpm patch-commit <scratch>`. Keep the existing Schema.Json hunks. `test/effectNdjson.test.vibe` in
`apps/vibelang` covers decoder recovery and real stdio transport failures using injected faulty Stdio services.
`surfaces/mcp-stdio` exercises the real factory with malformed lines in separate and coalesced chunks, parse-error
replies, initialize, EOF and interruption. Remove these RPC hunks when those regressions pass on stock Effect.

## @effect/platform-node@4.1.1

`@effect/platform-node@4.1.1.patch` changes the `createRequire` base in `internal/http.js` (and its source) from
`typeof __filename === "string" ? __filename : import.meta.url` to `import.meta.url ?? __filename`. `node --eval`,
`node --print` and the REPL define a global `__filename` of `[eval]`, so the ES module passed that string to
`createRequire` and threw ERR_INVALID_ARG_VALUE while `NodeHttpClient`, `NodeHttpServer` or `NodeClusterHttp`
loaded. The release smoke requires every packed package with `node --eval`, and the platform-node, platform-bun, cli
and build-cli tarballs vendor this module, so the 1.0.0-rc.17 candidate failed its CJS smoke. CommonJS bundles keep
working: esbuild gives them an empty `import.meta`, so they fall back to the module's own `__filename`.

`packages/smithers/flows/platform-node/test/EvalRequire.test.ts` requires the three modules under `node --eval` and
`node --print`; all four cases fail without the patch. Minimal reproduction, no Smithers code:
`node --eval 'require("@effect/platform-node/NodeHttpClient")'` in any project with `@effect/platform-node@4.1.1`.
Drop the patch when an Effect release reads `import.meta.url` first and that test passes without it. No upstream
write is authorized.

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

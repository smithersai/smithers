# Smithers Comments — Tests, Fuzzing & Benchmarks Review

## card: _Tests, Fuzzing & Benchmarks_|43 tests, 3,800 fuzz runs, 3 wall-time benchmarks

Every documented guarantee is enforced by ten test suites plus three wall-time benchmarks — spanning unit tests, property tests, feedback-guided fuzzing, real CLI end-to-end runs, and Smithers incremental build targets.

## code: Six verification layers · 10 files, 43 tests

```text Test suite breakdown (10/10 files, 43/43 PASS)
lexer.test.ts          9 tests · strings, regexes, pragmas, 4 families
sidecar.test.ts        4 tests · grammar, escaping, path confinement
anchor.test.ts         5 tests · symbol/pattern/line/file + code hashes
config.test.ts         3 tests · Effect Schema defaults & validation
virtual-file.test.ts   5 tests · projection, drift check, idempotency
workflow-cache.test.ts 3 tests · Smithers DAG, cache hit/miss, fix
properties.test.ts     5 tests · Effect Arbitrary.checkEffect invariants
fuzz.test.ts           3 tests · @smthrs/fuzz (3,800 coverage runs)
e2e.test.ts            3 tests · real CLI subprocess lifecycles
docs.test.ts           3 tests · docs links, splash page & CLI parity
```

```ts PACKAGE.ts · Smithers incremental targets
const tests = Smithers.Shell.Test({
  shell: "pnpm run test",
  data: [sources, testFiles, docs]
})
const fuzz = Smithers.Shell.Test({
  shell: "npx vitest run test/fuzz.test.ts",
  data: [sources, testFiles]
})
```

All ten suites run in parallel on `nyc-01` and wire directly into `PACKAGE.ts`, so Smithers skips unchanged test and lint targets incrementally.

## compare: _Property & Feedback-Guided Fuzzing_

```ts test/properties.test.ts · Effect Arbitrary
Arbitrary.checkEffect(
  Arbitrary.schema(SidecarDocumentSchema),
  (doc) =>
    Effect.gen(function*() {
      const formatted = formatSidecar(doc)
      const parsed = yield* parseSidecar(formatted)
      expect(parsed).toEqual(doc)
    }),
  { seed: 42, runs: 50 }
)
```

```ts test/fuzz.test.ts · @smthrs/fuzz (3,800 runs)
// 1,500 runs: Lexer across TS, Python, SQL, HTML
//   never throws; offsets strictly ordered & in-bounds
// 1,500 runs: Sidecar parser on arbitrary UTF-8
//   always returns SidecarDocument or SidecarParseError
//   800 runs: VirtualFile.projectFile projection
//   never throws; exact line count & deterministic digest
// Total runtime on final src/: 339 ms
```

Property tests verify lossless round-trips for sidecars, cache keys, and pragma preservation using Effect's `Arbitrary.checkEffect`. Feedback-guided fuzzing with Smithers' own `@smthrs/fuzz` executes three thousand eight hundred coverage-guided runs in three hundred thirty-nine milliseconds with zero crashes.

## code: Measured wall-time benchmarks · Final src/

```text nyc-01 · Node 26.5 · Effect 4.1.1 · Smithers rc.18
Lexer (500 files, 1.35 MB, 20,000 comments)
  60.5 ms   (21.8 MB/s)   budget: < 2,000 ms

Cache Cold -> Warm (100 comments, 2 ms simulated agent)
  317.3 ms (100 calls) -> 11.3 ms (0 calls)
  28.1x faster            budget: >= 10x, 0 warm calls

VirtualFileTree (200 files, 1,000 external comments)
  22.8 ms                 budget: < 500 ms
```

```text Dogfood self-check on smithers-comments/src/
$ node bin/smithers-comments.mjs check --offline --mode inline src
  files: 17  comments: 54  diagnostics: 0
  cache: 42 hits, 12 misses (12 agent calls)
```

On real hardware, the final lexer runs at twenty-one point eight megabytes per second, warm validation hits twenty-eight point one times speedup with zero agent calls, virtual tree projection finishes in twenty-two point eight milliseconds, and Smithers Comments passes its own dogfood check with zero diagnostics.

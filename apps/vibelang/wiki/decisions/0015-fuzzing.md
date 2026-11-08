# 0015. Fuzzing

**Status:** package in progress; app suite next. **Rulings:** VL-14, VL-15, VL-29.

## Package

`@smthrs/fuzz` copies `smithersai/effect` at `fc84e193be6b202f34a7351cdfb693629c95a38c` into `packages/fuzz`.
`Fuzz.ts`, `testing/FuzzSimulation.ts`, and `internal/fuzz/{engine,format,simulation,tape}.ts` remain TypeScript, file for file and unchanged except imports. This is the code we intend to contribute to Effect; keeping the copy identical makes contribution and later syncs simple. The original five test files likewise change only imports.

The library catalog's existing `@smthrs/testing` owns Node test tooling: the fork's filesystem corpus store is `src/internal/fuzz.ts`, and `@smthrs/testing/Vitest` adds `it.effect.fuzz` and `it.fuzz` without mutating the peer runner. `FuzzCorpus` exposes corpus tooling from the root. No Node API enters `@smthrs/fuzz`.

### Internal imports

- `internal/arbitrary/model.ts`: Effect 4.1.1 exposes no public generation/shrink-pull helpers. Copy only `ShrinkPull`, `Sample`, `Discarded`, `Attempt`, `Computation`, `Generation`, `GenerationRandom`, `GenerationState`, `Generator`, `onTypedFailure`, `isAttempt` and `toEffectGeneration`. Comments name the fork file and commit. The installed source matches the fork's model byte for byte.
- `Arbitrary.gen` is present at runtime but stripped from the npm declarations by `@internal`. Mirror that single type-only member in the copied model protocol; no runtime patch. The package emits declarations with the fork's compiler settings (`noUncheckedIndexedAccess: false`) and exposes that declaration boundary to stricter consumers. Its install `prepare` builds those declarations. Copied Vitest tests have a separate compiler project using the same upstream setting.
- Formatting uses public `effect/Formatter`, identical to the fork's formatter. `encoding/Base64Url` is public too. No formatter is copied.
- No fork-only Effect runtime change is required. Effect stays pinned at 4.1.1.

The explicit contribution copy retains upstream JSDoc and formatting, checked separately from Smithers-authored adapter code. It is excluded only from Smithers-specific JSDoc rewrites and its formatting pass, never from coverage.

## Corpus and budgets

All-Schema targets save confirmed, shrunk values when their JSON codec encodes them; otherwise they save a revision-bound tape. Failures live beside each test in `__fuzz__`, committed as regressions. Search inputs live in the ignored `node_modules/.cache/effect-fuzz` cache. Failed confirmation is reported as flaky and is not committed as a regression. Distinct fixed counterexamples of the same signature are retained.

A plain Vitest run replays saved failures and executes 100 fresh inputs. `EFFECT_FUZZ=1` searches all registered tests; `EFFECT_FUZZ_DURATION`, `EFFECT_FUZZ_EXECUTIONS`, and `EFFECT_FUZZ_SEED` set a session's budgets and seed. A duration also raises the runner timeout by 30 seconds for shrinking and cleanup. App targets will use short per-run defaults and `FUZZ_BUDGET` for campaigns.

## Executed package coverage

The seven package suites pass: 90 tests, 675/675 lines, 457/457 branches, 155/155 functions and 780/780 statements. This includes the fork's race, replay, corpus, confirmation, exhausted-run and Fable regression tests, plus an empty-cause shrink regression for the copied helper, a browser-global realm and Bun boundary executions. The package has no coverage exclusions.

## App targets and campaign

Pending after the package lands: conversation and delivery sequences, wire codecs, reply reasons and progress, sequencer, budget, tour, mock Factory, view and update, CLI/MCP arguments, and requests against the real API Worker in workerd. Concurrency uses `FuzzSimulation` with deterministic Effect services. App fuzz coverage will be measured independently using vl-coverage's V8 configuration, with any unreachable line named and justified here. The final record includes per-file lines and branches and the 30-minute campaign's findings.

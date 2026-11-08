# @smthrs/fuzz

Feedback-guided fuzzing over Effect 4.1.1's Schema-derived `Arbitrary`, with deterministic fiber scheduling and virtual time. Import `Fuzz` and `FuzzSimulation` from the package root in browsers, Workers, Node or Bun.

The implementation remains TypeScript, file for file with `smithersai/effect` at `fc84e193be6b202f34a7351cdfb693629c95a38c`, because we intend to contribute it to Effect. Keeping an identical copy, apart from imports, makes that contribution and later syncs simple. `internal/arbitrary/model.ts` holds only the generator protocol and helpers used here; the formatter is Effect's public `Formatter` API. The npm declarations strip `Arbitrary.gen`; the local protocol mirrors that type-only member. No runtime changes to Effect are required. The package builds its declaration boundary with its upstream compiler settings, so stricter consumer settings do not recheck the contribution copy. `prepare` creates those declarations during installation.

See [the guide](docs/README.md). Filesystem corpus storage and Vitest integration live in `@smthrs/testing/Vitest`.

```ts
import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Schema } from "effect"
const result = Fuzz.run(Arbitrary.schema(Schema.Int), (n) => n + 0 === n, { executions: 1000, seed: 1 })
Effect.runPromise(result)
```

The base copy is unchanged except imports. One follow-up sync patch fixes a bug
found by the app's long campaign: corpus-tail crossover appends words without
spreading a whole tape into a function call. JavaScript's argument limit could
otherwise crash a run on a large generated event. `test/tapeMutation.test.ts`
retains a 200,000-word regression; port this small patch when syncing the fork.

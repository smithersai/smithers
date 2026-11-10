# Fuzz properties and their regressions

Import `it` from `@smthrs/testing/Vitest`. `it.effect.fuzz` accepts Effect properties, and `it.fuzz` accepts pure
properties. Inputs are a tuple or record of Effect Schemas or Arbitraries. A plain test run replays committed
failures, then checks 100 fresh inputs. It does not write a corpus. A finding fails the test.

```ts
import { it } from "@smthrs/testing/Vitest"
import { Effect, Schema } from "effect"

const JsonString = Schema.fromJsonString(Schema.String)
it.effect.fuzz(
  "strings survive the JSON codec",
  [Schema.String],
  ([value]) => Effect.sync(() => Schema.decodeUnknownSync(JsonString)(Schema.encodeSync(JsonString)(value)) === value)
)
```

`EFFECT_FUZZ=1` searches every fuzz test. Set it to part of a bare test name to select a target.
`EFFECT_FUZZ_DURATION="1 minute"`, `EFFECT_FUZZ_EXECUTIONS=100000` and `EFFECT_FUZZ_SEED=42` bound or replay a session.
The duration raises the Vitest timeout by 30 seconds for shrinking and cleanup; an explicit test timeout takes
precedence. Execution-only sessions have no runner timeout.

Options accept `id`, `revision`, ordinary Vitest options, and `fuzz: Fuzz.Options`. The default id is the full test
name. Changing the generator requires a revision change. Confirmed failures save as codec values when possible,
otherwise as generator tapes. Value fixtures survive generator changes; stale tapes are reported explicitly.

Commit `test/__fuzz__/<file>/<target>-<hash>/` failures. Search inputs under `node_modules/.cache/effect-fuzz` are
local cache files. Distinct failures of one signature stay in the corpus after fixes. Confirmation failures are
reported as flaky and never saved as regressions.

Use `fuzz: { execution: FuzzSimulation.execution() }` for closed-world concurrency. The adapter preserves the
driver's Clock and Scheduler inside the Effect test services, including when replaying a saved schedule during a
plain test run. Real I/O and native promises escape that driver; inject deterministic Effect services.

`FuzzCorpus.fileCorpus` is also exported from the `@smthrs/testing` root for standalone campaigns. It uses Node's
filesystem with atomic rename. `Fuzz` and `FuzzSimulation` themselves come from `@smthrs/fuzz` and run on every
platform; no Node API enters that package. See [the package guide](https://github.com/smithersai/smithers/blob/main/packages/fuzz/docs/README.md).

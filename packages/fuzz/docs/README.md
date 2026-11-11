# Fuzzing with `Fuzz`

`Arbitrary.checkEffect` runs a property on a fixed number of random inputs. `Fuzz` runs the same property for as long
as you let it, and learns: it keeps inputs that made the program do something new, mutates them, and, with a corpus store, saves confirmed
failures so they replay as ordinary tests.

```
seed ─► pick a kept input ─► mutate its random tape ─► generate the value ─► run the property
                                                                                │
  kept inputs ◄── new feedback (spans, causes, observations, scores) ◄──────────┤
                                                                                │
                               failure ─► shrink (same signature) ─► confirm ─► save the shrunk value
```

## When to use it

Use `checkEffect` (or `it.effect.prop`) for laws that random inputs exercise well. Use `Fuzz` when a failure hides
behind conditions that random inputs almost never satisfy together: a magic number, a protocol prefix, a state reached
after a precise sequence of commands, or a fiber interleaving.

The test suite in `test/fuzz/Fuzz.benchmark.test.ts` has a parser with a four-byte magic number. `checkEffect` passes
it after 100,000 runs (seeds 1, 2 and 3). `Fuzz.run` finds the crash with each of seeds 1 to 8, in 47,749 to 701,387
executions (median 93,017.5), guided only by the `Effect.fn` spans the parser already has. Without span feedback
(`feedback: []`) it finds nothing in 1,000,000 executions.

## A first run

```ts
import { Arbitrary, Effect, Schema } from "effect"
import { Fuzz } from "@smthrs/fuzz"

const Byte = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 }))

const report = yield* Fuzz.run(Arbitrary.schema(Schema.Array(Byte)), (bytes) => parse(bytes).pipe(Effect.as(true)), {
  seed: 1,
  executions: 500_000
})
const diagnostic = Fuzz.formatReport(report)
if (diagnostic !== undefined) console.error(diagnostic)
```

With no explicit budget, `Fuzz.run` uses 10 seconds of wall time, longer than Vitest's default 5-second test timeout.
Use an execution budget as above, or raise the test timeout.

The property contract is the one of `checkEffect`: return `true` (or an Effect of `true`) to pass. Returning anything
else, failing, or **dying** is a finding. Unlike `checkEffect`, a defect raised by the property is a finding (`Died`),
because a crash is what fuzzing looks for. Interruption propagates.

A run stops at the first of `duration` (default 10 seconds when no budget is given), `executions`, `plateau`
(executions without new feedback) and `maxFindings` confirmed distinct signatures (default 1).
If every execution is discarded, it returns `Exhausted`; `formatReport` explains that no exploratory evaluation completed.
A zero-execution regression-only run can still return `Passed`.

## What guides the search

| Source         | What it records                                                                                   | Setup                                      |
| -------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `spans`        | `(parent span, span)` for every span started, so `Effect.fn("Bank.withdraw")` is a coverage point | on by default; `feedback: []` turns it off |
| `causes`       | the exit tag, each error `_tag`, each defect constructor                                          | always                                     |
| `observations` | each `Fuzz.observe(label)`                                                                        | call it where reaching a stage matters     |
| scores         | `Fuzz.score(label, value)`, maximized per label                                                   | call it to climb toward a goal             |
| `structural`   | header and tape-length buckets                                                                    | always                                     |
| injected       | any custom `Fuzz.Feedback`                                                                        | `feedback: [...]`                          |

`Fuzz.observe` and `Fuzz.score` do nothing outside a fuzz execution, so they can stay in production code.

`stats.features` counts features per source. A report whose only sources are `structural` and `causes` says
"structural exploration": nothing measured code coverage, and the search explored generator choices blindly.

```ts
// A score turns a needle into a hill: the fuzzer finds n === 777_777_777 in a billion values.
Fuzz.run(wide, (n) => Effect.as(Fuzz.score("closeness", -Math.abs(n - 777_777_777)), n !== 777_777_777))
```

## Findings

Each finding has a `signature`: `ReturnedFalse`, `PropertyError:<tag>`, `Died:<constructor>` or `Deadlock`. The tag is
the error's `_tag`, else its constructor name. Confirmed findings with the same signature are deduplicated within a run; flaky candidates do not block later confirmed failures. Shrinking uses the
existing Arbitrary shrink trees and accepts a smaller input only if it keeps the signature, so a `Bust` failure never
shrinks into a `Boom`.

`finding.replay` is a `fuzz1:` token: the generator tape, the schedule tape and the shrink path. Pass it back to
reproduce the finding:

```ts
Fuzz.run(arbitrary, property, { replay: finding.replay })
// Falsified when the same failure is confirmed; Passed when it no longer occurs.
// ReplayMismatch when the tape discards or its shrink path no longer exists (stats.stale: 1).
```

Before a finding is reported, its final input is evaluated once more. A finding in `report.findings` failed with the
same signature both times. One that did not is a flaky finding, in `report.flaky`, with both outcomes: `failure` and
`recheck`. A run whose every failure was flaky returns a `Flaky` report, never `Falsified`; `formatReport` marks each
one `FLAKY`. Only confirmed findings count toward `maxFindings`. Confirmation is one immediate recheck: failures that
depend on process history can agree twice and still fail to reproduce later. New flaky candidates are not persisted;
existing fixtures are retained even if their recheck becomes flaky.

## Keeping what it finds

`Fuzz.run` keeps its corpus in memory. To keep failures between runs, give the property a stable identity with
`Fuzz.target` and provide a store:

```ts
const target = Fuzz.target(Schema.Array(Byte), (bytes) => parse(bytes).pipe(Effect.as(true)), {
  id: "container/parse",
  revision: "1"
})
Fuzz.runTarget(target, { duration: "1 minute" }).pipe(Effect.provideService(Fuzz.Corpus, store))
```

A store saves two kinds of entries:

- **Confirmed failures are saved after shrinking and rechecking.** When the target was built from a Schema, the value
  is encoded with `Schema.toCodecJson`. A compatible codec lets it replay independently of generator changes. Pass
  `codec` to `Fuzz.target` to save values of a plain Arbitrary. If encoding throws, the finding remains available and
  is saved as a tape (`saved: "Tape"`); `codecError` and `formatReport` explain the fallback. An interrupted shrink
  does not persist its candidate.
- **Inputs are a search cache.** They are generator tapes, tied to `revision`. Change `revision` when the Arbitrary
  changes; saved tapes of another revision are skipped and counted in `stats.stale`. A failure without a codec is also
  a tape, and the report says it will not survive a generator change.

Failure file keys now hash the signature plus encoded value (or the revision and final tape/path when no value is
encoded). A later failure with the same signature gets its own file instead of evicting a fixed regression. Existing
signature-only fixture filenames still load; they need not be renamed.

`runTarget` with `executions: 0` only replays saved failures: the regression mode used by test runners. Confirmed saved
failures count toward `maxFindings`, so its default of 1 stops search until the known failure is fixed.

## `@smthrs/testing/Vitest`

```ts
import { it } from "@smthrs/testing/Vitest"

it.effect.fuzz(
  "parse never dies",
  [Schema.Array(Byte)],
  ([bytes]) =>
    parse(bytes).pipe(Effect.catchTag(["NotAContainer", "TooShort"], () => Effect.succeed(0)), Effect.as(true))
)
```

A plain `vitest run` replays every saved failure of the test, which must now pass, then checks 100 random inputs like
`it.effect.prop`. It writes nothing. The smoke check uses a fresh random seed; options in `fuzz` other than `execution` apply only to
sessions. Per-evaluation test-service construction adds overhead compared with `Fuzz.run`.

A fuzz session searches and saves:

```sh
EFFECT_FUZZ="parse never dies" EFFECT_FUZZ_DURATION="60 seconds" EFFECT_FUZZ_SEED=1 vitest run container.test.ts
```

`EFFECT_FUZZ` selects tests whose bare test name (without enclosing `describe` names) contains it, or every fuzz test when it is `1`. `EFFECT_FUZZ_EXECUTIONS` bounds
the session by executions instead. A session raises the test timeout to the duration plus 30 seconds. A finding fails
the test with the shrunk input, the signature and the replay token, and, when confirmed, is saved to
`__fuzz__/<test file>/<test name>-<hash>/<key>` beside the test file: commit that directory. The directory name is the
test name with punctuation replaced by `-`, then 16 hex digits of a SHA-256 of the full id, so `parse: x` and `parse x`
avoid the sanitization collisions of the readable prefix alone. Search inputs go to `node_modules/.cache/effect-fuzz`.

After the fix, the plain run prints `Replayed 1 saved failure(s) of Container > parse never dies` and passes. The test
in `packages/vitest/test/fuzz-example.test.ts` is this workflow, with its saved failure committed.

`it.fuzz` is the synchronous form. Options: `id` (default: the test's full name), `revision` (default `"1"`), `fuzz`
(search options for sessions), and the usual Vitest options.

`fuzz.execution` also applies to plain runs: saved failures replay under the same driver, and the random check runs
100 executions under it instead of `checkEffect`. Under `it.effect.fuzz`, the driver owns `Clock` and `Scheduler` for
each evaluation; the other test services (`TestConsole`, the scope) are still provided. So with
`fuzz: { execution: FuzzSimulation.execution() }`, `Effect.sleep` and `Effect.timeout` run in virtual time, not on the
`TestClock`.

## Fuzzing interleavings

`FuzzSimulation.execution()` from `effect/testing` makes fiber scheduling part of the input:

```ts
import { FuzzSimulation } from "@smthrs/fuzz"

Fuzz.run(amounts, conservesMoney, { execution: FuzzSimulation.execution(), executions: 10_000 })
```

Each execution runs in a fresh closed world. Queued tasks keep the scheduler's documented order (priority, then FIFO);
a second tape decides how many run-loop operations each fiber slice may take before the runtime preempts it. Word 0
means the ordinary slice, so shrinking a schedule zeroes words until the failing interleaving is as cooperative as it
the shrink budget permits. `Effect.sleep`, `Clock` and timeouts run on a virtual clock that jumps to the next timer when nothing is
runnable. A program with nothing runnable, no pending timer and an unfinished property is a `Deadlock` finding.

`test/fuzz/FuzzSimulation.test.ts` has two withdrawals that read a balance, check it, and write it back. `checkEffect`
passes 10,000 runs: the default scheduler runs each withdrawal to completion. Under the simulation, `Fuzz.run` finds the
lost update at execution 5 and shrinks it to amounts `[1, 1]` with one nonzero schedule word. Its replay token gives
the same interleaving 1,000 times out of 1,000:

```
A reads balance 100 | B reads balance 100 | B writes balance 99, pays 1 | A writes balance 99, pays 1
```

The world is closed: real I/O, native timers, `Date.now`, `Math.random` and promises from outside Effect escape it.

Virtual time is kept in integer nanoseconds, so `Effect.sleep("500 micros")` advances `Clock.currentTimeNanos` by
exactly 500,000; `currentTimeMillis` is whole milliseconds, like `Date.now`. `maxSteps` (default 100,000) counts both
dispatched tasks and timer wakes, so a loop of sleeps ends as a discard. A long evaluation yields the fuzz fiber every
4,096 steps, so interrupting the run stops it. After every evaluation, including one that completes, the driver
interrupts each fiber still alive in the world (a deadlocked or step-limited root, and fibers that outlive the root, such
as `Effect.forkDetach` forks) and runs their finalizers inside the world with another `maxSteps`. Cleanup that exceeds
that budget is a `FuzzError("Execution")` naming `maxSteps`; cleanup that deadlocks, including an uninterruptible
suspended fiber, is also an `Execution` error. The error identifies incomplete cleanup; a suspended fiber cannot be forced to release
resources. It is not reported as a successful cleanup or an ordinary finding.

## Determinism and its limits

With the same seed, generator, property, feedback, execution driver and empty or identical ordered corpus, the
fuzzer makes the same choices at execution `k`. Saved inputs replay before fresh search and consume execution numbers,
so different local caches can diverge immediately. `duration` only decides how many executions happen. A property that reads `Date.now`, `Math.random`, real I/O or
shared mutable state breaks this, exactly as it breaks `checkEffect` replay.

Do not mutate the input. The engine evaluates the same value again to shrink and to confirm a finding, and a generated
value shares parts with its shrink candidates, so a property that sorts its input array in place changes the next
candidate. Copy first: `(xs) => isSorted(mySort([...xs]))`. Build mutable fixtures inside the property. A property
that breaks this can show up as a flaky finding; one recheck does not detect every violation.

## Design notes

- **The input is the random tape.** Every generator draws its randomness through one `GenerationRandom`. Fuzzing
  replaces it with a tape of 32-bit words and mutates the words (random, boundary values, arithmetic, bit flips, block
  zero/delete/insert/duplicate, splices) and the header (`size`, numeric bias, null-prototype records). Changing a
  union's choice word reinterprets the rest of the tape, which is a structural mutation for free. Words past the end of
  a tape are a pure function of the tape key and position, so `flatMap` checkpoints and lazy shrink pulls replay.
- **No second generator model.** Every Arbitrary is fuzzable unchanged, including `map`, `filter`, `filterMap`,
  `flatMap`, recursion and records. A test pins that the same tape gives the same value with and without shrink trees.
- **Energy follows rarity.** A parent is chosen by the rarity of the rarest feature it owns (AFL++'s "fast" schedule);
  the best entry for each score has top energy. When spans, observations or an injected provider produced features,
  only theirs give energy: structural features keep adding diverse inputs, but must not starve the entry at the
  frontier of the program (this took the benchmark from 2 of 5 seeds to 8 of 8). One in four parents is uniform, one in
  eight inputs is fresh.
- **Infrastructure errors are not findings.** A dying generator, feedback source, store or execution driver is a
  `FuzzError`, as are decode errors and codec-id mismatches. Value-encoding errors retain the finding as a tape.
- **`checkEffect` is untouched.** `Fuzz` lives in its own module with its own evaluation and shrink walk, so ordinary
  property checks pay nothing.
- **Corpus files are text, version 2.** Free-text fields (`revision`, `signature`, `codec`, `value`) are JSON string
  literals, so a codec value with newlines stays in its field. Each field appears once; `null-prototype` is `true` or
  `false`; `bias` is 2 to 6. Version 1 files, which wrote those fields raw, still load.
- **Left out on purpose:** per-execution timeouts (cooperative interruption cannot stop synchronous code), tape-level
  shrinking of values (the shrink trees already do it), corpus merge and minimization, parallel executions inside one
  run, and comparison-operand feedback.

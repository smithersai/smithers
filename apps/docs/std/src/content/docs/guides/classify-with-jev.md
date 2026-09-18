---
title: "Judge state with classify"
description: "Ask Jev typed questions about any JSON a cell holds: judge a directory of files in one call, tell a real failure from a broken probe, and read the answers as data instead of spending a model turn."
sidebar:
  order: 9
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/std/docs/guides/classify-with-jev.md"
---

A cell that has read ten files and needs to know which of them matter used to
print all ten and decide next frame. `classify` moves that judgment inside the
cell: hand Jev the states you hold and typed questions about them, get back
probabilities the same cell branches on. No text comes back, which is the
point. A Jev answer costs about a thirtieth of a cent and lands in a few
hundred milliseconds, so judging every file in a directory is one call, not
ten frames.

The flow needs one host service, the `Evaluator` from
[`@smthrs/model`](https://model.smithers.sh/reference/api/), which is Jev through the Vercel AI Gateway. A
host without a gateway key binds `Evaluator.layerUnavailable()`, and every
call then resolves as `{ ok: false, error: { code: "flow_failed", message } }`
whose message contains `unreachable:` after the binding's `Flow <name> failed:`
prefix. The cell carries on; nothing hangs and nothing is invented.

## Ask your own questions

Three question shapes exist, and each answer has the shape its question
implies:

| Question                                              | Answer                                                       |
| ----------------------------------------------------- | ------------------------------------------------------------ |
| `{ type: "boolean", instructions, criteria? }`        | `{ value, probability }`                                     |
| `{ type: "choice", instructions, criteria: { ... } }` | `{ value, probabilities, confidence }`, `value` is an option |
| `{ type: "score", instructions, criteria: [ ... ] }`  | `{ value, label, probabilities, confidence }`                |

A `boolean` may carry `criteria: { true, false }` saying what each side means.
A `choice` names between 2 and 255 options and what each means. A `score`
orders at least two distinct rungs; `value` interpolates over their indexes and
`label` is the nearest rung.

Here is the file loop. The cell already holds the paths a `glob` returned and
the excerpts a `read` returned; one `classify` call judges all of them, and the
filter that follows runs in the same cell:

```cell
const excerpts = await Promise.all(files.paths.map((p) => ctx.call("read", { path: p, limit: 60 })))
const verdicts = await ctx.call("classify", {
  states: excerpts.map((e, i) => ({ task, file: files.paths[i], excerpt: e.content })),
  questions: {
    relevant: { type: "boolean", instructions: "Does this file need to change to fix the flaky test?" },
    role: { type: "choice", instructions: "What is this file's role?", criteria: { implementation: "code under test", fixture: "test data or setup", unrelated: "nothing to do with the test" } }
  }
})
const targets = verdicts.results.filter((r) => r.ok && r.answers.relevant.probability > 0.7).map((r) => r.state.file)
console.log(targets)
```

`states` takes up to 64 states of at most 32 KiB each, evaluated eight at a
time. Each entry of `results` is `{ ok: true, state, answers, confidence }` or
`{ ok: false, state, error: { code, message } }`, in the order the states were
given, so a state that timed out never hides its neighbours. When no state at
all was answered, the whole call resolves `{ ok: false }` instead, because
there is nothing to branch on.

One state under `state` instead of `states` answers with
`{ answers, confidence, latencyMs }` directly. `confidence` is one number per
question from 0 to 1: a boolean's distance from even odds, doubled; a choice's
or score's largest probability.

## Use a curated classifier

A host can declare classifiers once, with `Classifier.make`, and bind each as
its own flow named `classify/<id>`. The catalog then shows the model what each
one judges and, derived from the declared questions, every answer id with its
shape (`role choice implementation|fixture|unrelated { value, probabilities,
confidence }`), so a cell writes `answers.role.value` without a frame spent
printing the result. Its input is the classifier's own state schema, and the
questions never cross the wire from the cell. Three ship in `Classifiers`:

| Flow                        | State                                 | Answers                                                                        |
| --------------------------- | ------------------------------------- | ------------------------------------------------------------------------------ |
| `classify/triage/relevance` | `{ task, file, excerpt }`             | `relevant` boolean, `role` implementation, fixture, or unrelated, `risk` score |
| `classify/check/verdict`    | `{ task, command, exitCode, output }` | `rightReason` boolean, `invalidProbe` boolean                                  |
| `classify/edit/risk`        | `{ task, path, hunk }`                | `risk` score none to high, `reversible` boolean                                |

Every state starts with `task`, the task as the person stated it, because each
judgment is made against it: `rightReason` is only an answer when Jev can read
which bug the task describes.

`Classifiers` declares a fourth, `probe/attribution`, and binds it to nothing.
It takes `{ command, exitCode, output }` with no task, and the `test` flow asks
it through `Probe.classify` on every non-zero exit, so a cell never has to ask
whether the run it just made was a run at all.

`check/verdict` answers the question rule 7 of the cell contract leaves to the
model: a command is evidence only once it has failed for the right reason, and
a command that fails because it names a test, file, or module that does not
exist reproduces nothing. Ask it in the same cell that ran the check:

```cell
const before = await ctx.call("bash", { command: "pytest tests/test_widen.py::test_keeps_unit -q" }, { at: ctx.base })
const judged = await ctx.call("classify/check/verdict", {
  task: "widen() drops the unit: test_keeps_unit expects 'km' and gets 'm'",
  command: "pytest tests/test_widen.py::test_keeps_unit -q",
  exitCode: before.exitCode,
  output: before.stdout + before.stderr
})
const evidence = judged.ok !== false && judged.answers.rightReason.value && !judged.answers.invalidProbe.value
if (evidence) verification = { flow: "bash", input: { command: "pytest tests/test_widen.py::test_keeps_unit -q" } }
console.log(before.exitCode, judged.ok === false ? judged.error.message : judged.answers)
```

A curated flow takes one state, or `{ states: [...] }` for a batch, and
answers in the same two shapes as `classify`. Every state is held to 32 KiB as
JSON, and the catalog says so on the state itself, so trim an excerpt before
the call rather than after an `invalid_input` refusal.

## Bind it in a host

```ts
import * as Evaluator from "@smthrs/model/Evaluator"
import * as Classifiers from "@smthrs/std/Classifiers"
import * as Classify from "@smthrs/std/Classify"
import { Effect, Redacted } from "effect"

const evaluator = Evaluator.layerVercelGateway({ apiKey: Redacted.make(process.env.AI_GATEWAY_API_KEY!) })

const verdict = Classify.run({
  state: { file: "src/units/widen.py", excerpt: "return value" },
  questions: { relevant: { type: "boolean", instructions: "Does this file need to change?" } }
}).pipe(Effect.provide(evaluator))

const curated = Classify.curated(Classifiers.checkVerdict)
// curated.name === "classify/check/verdict"; curated.run takes the classifier's state
```

The declaration is a sealed model call with the capability `model:call:*`, so
a run's capability envelope must grant it, the same way `bash` needs
`proc:spawn:*`. In the agent loop, `StandardFlows.classify(services)` from
[`@smthrs/agent`](https://agent.smithers.sh/reference/api/) binds the ad-hoc flow and the three curated ones
in one source; see
[Give a run capabilities](https://agent.smithers.sh/guides/capabilities/).

## Failures

Every failure is a `ClassifierError` from `@smthrs/model`, carrying the
evaluator's own code: `unreachable` when no transport answered,
`refused` with the gateway's status, `empty` for a 200 with no answers,
`timeout` for the call's own deadline, `invalid_answer` for an answer the
question's shape does not accept, and `invalid_question` for a state or
question the gateway or the schema rejected. Too many states, an oversized
state, or an empty question map is refused by the input schema before any
transport is reached.

---
title: "Script the turns a recording cannot make"
description: "Answer chosen model turns from a script while the rest replay from a recording: ScriptedModel for any flow, BuiltinScript and its directive tags for Smithers' built-in flows, holds, and the turn log."
sidebar:
  order: 10
---

Record and replay is the default model double: `CachedModel` answers with what
a real model said. Some tests need an answer no real model gives on demand:

- a planner that asks the person a question, so the run waits on them;
- an edit that breaks the build once, so the repair path runs;
- a turn that waits until the test releases it, so the test can act while the
  run is mid-step.

Script those turns, and let every other turn replay.

## Script a turn

`ScriptedModel.make` offers each request to a script. A matched request is
answered with the script's text; any other request goes to `fallback`.

````ts
import { CachedModel, FixtureStore, ScriptedModel } from "@smthrs/testing"
import * as Effect from "effect/Effect"

const asks: ScriptedModel.Turn = {
  name: "plan/ask",
  when: (request) => request.system.some((part) => part.text.includes("Plan the change")),
  reply: () => "```cell\nctx.done({ clarification: \"Which file?\" });\n```"
}

const program = Effect.gen(function*() {
  const fixture = yield* FixtureStore.makeMemory(recorded)
  const model = ScriptedModel.make({
    script: ScriptedModel.fromTurns([asks]),
    fallback: CachedModel.make({ fixture })
  })
  // Provide `model` as the flow's `/model/Model`.
})
````

A scripted answer streams as one text part, a `stop` settle, and a usage report
of 100 input and 100 output tokens, so a metering proxy settles the call. Set
`usage` to change the count.

Without `fallback`, an unscripted request dies with `UnscriptedModelError`,
which `ModelServer` answers `501`. A script that throws refuses the request
with a `400` naming the reason.

`ScriptedModel.transcript(request)` gives the request as plain messages: one
system message per system part, then each message's text. Match on it when a
step's teaching is all that identifies the turn.

## Hold a turn

A reply that names `hold` waits on a `TurnGate` until the test releases the
key. The release is sticky: every later turn on the key passes at once.

```ts
import { ScriptedModel, TurnGate } from "@smthrs/testing"

const gate = yield* TurnGate.make()
const model = ScriptedModel.make({
  script: ScriptedModel.fromTurns([{ ...asks, hold: () => "plan" }]),
  gate
})
// The run reaches the plan turn and waits.
yield* gate.release("plan")
```

## Script Smithers' built-in flows

`BuiltinScript` is a script for the flows a Smithers install runs: a TODO's
coding steps, the pull request review, a conflict resolution, `/review` and the
wiki review. Each turn is recognized by its step's system teaching
(`BuiltinScript.teachings`) and answered with one cell that settles the step:
the plan names one file, the edit appends a greeting to it, the review
approves, and the judge routes the TODO to implement.

A test steers each TODO with directives. The TODO's prompt is the one channel an
out-of-process test has into the model, so a directive travels as a bracketed
tag in that prompt. Build the tag with `BuiltinScript.tag`:

```ts
import { BuiltinScript } from "@smthrs/testing"

const prompt = `${BuiltinScript.tag({ ask: true, file: "notes/t2.md", hold: "t2" })} Add a greeting`
// "[ASK] [HOLD t2] [FILE notes/t2.md] Add a greeting"
```

| Directive           | Tag                  | The scripted run                                                                            |
| ------------------- | -------------------- | ------------------------------------------------------------------------------------------- |
| `ask: true`         | `[ASK]`              | The request review asks `QUESTION`, so the TODO needs you; the edit writes the answer.      |
| `fail: true`        | `[FAIL]`             | The edit empties `JOURNEY.md`, so a check that reads it fails, until `fixed`.               |
| `failOnce: true`    | `[FAILONCE]`         | The first edit leaves `JOURNEY.md` blank; the repair restores it and the retry passes.      |
| `restore: true`     | `[RESTORE]`          | The edit appends the greeting to `JOURNEY.md`, including when `file` names another file.    |
| `fixed: true`       | `[FIXED]`            | Ends `fail` and `failOnce`, from a steer, an answer or retry feedback.                      |
| `hold: "k"`         | `[HOLD k]`           | The edit turn waits until `POST /__testing/release/k`.                                      |
| `file: "p"`         | `[FILE p]`           | The edit appends to `p` instead of `JOURNEY.md`.                                            |
| `noResolve: true`   | `[NORESOLVE]`        | A conflict turn on this TODO's file gives up instead of resolving.                          |
| `flowEdit: true`    | `[FLOWEDIT]`         | The edit writes only `.smithers/flows/todo/flow.ts`, adding `CHANGELOG_STEP` to every TODO. |
| `changelog: true`   | `[CHANGELOG]`        | The edit also appends one line to `CHANGELOG.md`.                                           |
| `observeUid: 19999` | `[OBSERVEUID 19999]` | The edit runs `id -u` and refuses unless the coding tools run as that uid.                  |
| `probeReview: true` | `[PROBEREVIEW]`      | The pull request review tries `write` and `bash` and approves only when both are refused.   |

Ordinary prose never sets a directive: `ASK` without brackets is just a word.
`BuiltinScript.directives(text)` reads them back.

`BuiltinScript.make(options)` takes:

| Option           | Meaning                                                                                               |
| ---------------- | ----------------------------------------------------------------------------------------------------- |
| `greeting`       | The line the edit appends. `GREETING` by default.                                                     |
| `todoFlow`       | The source of `.smithers/flows/todo/flow.ts`, which a `flowEdit` TODO edits. Required for `flowEdit`. |
| `holdAt`         | Steps besides `coding/edit-atom` that hold on the TODO's `hold` key, such as `coding/draft-plan`.     |
| `reviewFindings` | Findings the scripted `/review` reports when the reviewed text holds their path and code.             |

`BuiltinScript.evaluator` answers the coding run's judgments, and
`BuiltinScript.unscripted` settles any other turn while keeping its teaching and
last message as trace evidence.

## Serve a script over HTTP

An install calls its model from another process. `smthrs-model-server --script
builtin` serves `BuiltinScript` on the same wire as a recording:

```bash
npx smthrs-model-server --script builtin --script-config test/script.json \
  --trace evidence/model-turns.jsonl --trace-messages
```

`--script-config` is `BuiltinScript.Options` as JSON, except that `todoFlow` is a
path to the flow file, relative to the config. Add `--fixture` to replay what
the script does not answer. Add `--record --upstream ... --key-env ...` to send
every turn to a real model instead and record it; the script then only names
each traced turn.

| Route                         | Answer                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------ |
| `GET /__testing/turns`        | Turns served so far: `total`, `chat`, `evaluation`, `refused`, `steps` by name, and `held` |
| `GET /__testing/held`         | The keys turns wait on now                                                                 |
| `POST /__testing/release/<k>` | `204`; answers every turn held on `k`, and every later one at once                         |

`--trace` appends one JSON line per turn: `n`, `at`, `kind`, `step`, `model`,
`messageCount`, a `hold` when the turn waits, and with `--trace-messages` the
turn's `messages`. A trace never holds a header or a key.

## Keep the script honest

A script answers by teaching text. When a flow rewords its teaching, its turns
stop matching and fall to `unscripted`. Pin every teaching in the flows' own
tests:

```ts
import { BuiltinScript } from "@smthrs/testing"

for (const [step, teaching] of Object.entries(BuiltinScript.teachings)) {
  assert.ok(flowSourceFor(step).includes(teaching), step)
}
```

## Related

- [Replay a model instead of calling one](./replay-a-model.md) records and
  replays real turns.
- [Serve a recorded model over HTTP](./serve-a-recorded-model.md) serves a
  recording to an install.

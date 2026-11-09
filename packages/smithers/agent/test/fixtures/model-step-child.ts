/**
 * One host process for the ModelStep cases that need a real process boundary:
 * a SIGKILL between the seal and the next step, a SIGKILL mid-call, and a key
 * derived by a process that never shared memory with the suite.
 *
 * `node model-step-child.ts <mode> ...`, where mode is
 *
 * - `key <request-json>`: prints the step key of the request.
 * - `seal <schema> <root> <execution>`: seals the model step, then hangs in the
 *   next step.
 * - `midflight <schema> <root> <execution>`: hangs inside the provider call.
 * - `resume <schema> <root> <execution>`: drives the execution to completion.
 *
 * Every status is one JSON line on stdout.
 */
import { Action } from "@smthrs/flow"
import { ModelRequest } from "@smthrs/model"
import * as Effect from "effect/Effect"
import * as Metric from "effect/Metric"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as InternalModelStep from "../../src/internal/ModelStep.vibe"
import * as ModelStep from "../../src/ModelStep.ts"
import { ask, execute, reply, runtime, scripted, textOf, through } from "./model-step-stack.ts"

const say = (status: object) => process.stdout.write(JSON.stringify(status) + "\n")

const [mode, ...rest] = process.argv.slice(2)

const keyOf = (json: string) =>
  Effect.gen(function*() {
    const request = Schema.decodeUnknownSync(ModelRequest.ModelRequest)(JSON.parse(json))
    const prepared = yield* through(scripted(() => Stream.empty).model).route.prepare(request)
    return yield* InternalModelStep.key(InternalModelStep.material(request), prepared)
  })

const host = (schema: string, root: string, execution: string) => {
  const model = scripted((call) => {
    say({ status: "called", call })
    if (mode !== "midflight") return Stream.fromIterable(reply("Paris"))
    return Stream.concat(
      Stream.fromIterable(reply("Paris").slice(0, 2)),
      Stream.fromEffect(Effect.sync(() => say({ status: "in-flight" }))).pipe(Stream.flatMap(() => Stream.never))
    )
  })
  const layer = runtime({
    schema,
    workspaceRoot: root,
    hostId: "model-step-child",
    handler: ({ prompt }) =>
      Effect.gen(function*() {
        const result = yield* ModelStep.run({
          name: "agent/test/model-step/answer",
          request: ask([prompt]),
          ...through(model.model)
        })
        yield* Action.make({
          name: "agent/test/model-step/next",
          execute: mode === "seal"
            ? Effect.sync(() => say({ status: "next-entered" })).pipe(Effect.andThen(Effect.never))
            : Effect.void
        })
        return { text: textOf(result.events), replayed: result.replayed }
      })
  })
  return Effect.gen(function*() {
    yield* Effect.sync(() => say({ status: "booted" }))
    const value = yield* execute(execution, "capital of France")
    const redispatches = (yield* Metric.snapshot)
      .filter((metric) => metric.id === "agent_model_step_redispatches")
      .reduce((sum, metric) => sum + Number((metric.state as { readonly count: number }).count), 0)
    say({ status: "done", value, calls: model.calls.length, redispatches })
  }).pipe(Effect.provide(layer), Effect.scoped)
}

const program: Effect.Effect<void, unknown> = mode === "key"
  ? Effect.map(keyOf(rest[0]!), (key) => say({ status: "key", key }))
  : host(rest[0]!, rest[1]!, rest[2]!)

Effect.runPromise(program).then(
  () => process.exit(0),
  (error: unknown) => {
    process.stderr.write(`${String(error)}\n`)
    process.exit(1)
  }
)

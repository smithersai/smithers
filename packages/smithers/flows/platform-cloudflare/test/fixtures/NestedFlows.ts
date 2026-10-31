/**
 * Flows whose executions span several Durable Objects: a parent that runs a
 * child as its own execution, a child that fails, and a counter that loops
 * by handing off to its next round. Every action is the caller's `record`,
 * so a suite sees which steps ran, in what order, and can block one.
 */
import { Action, Flow, Interpreter, Sleep } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import type * as SqlClient from "effect/sql/SqlClient"
import { CloudflareRuntime, type ExecutionObject } from "../../src/index.ts"

/** Records `label` and answers with it. */
export const Step = Action.make("cloudflare-test/Step", {
  payload: { label: Schema.String },
  success: Schema.String
})

/** Records `value` and answers with the next number. */
export const Bump = Action.make("cloudflare-test/Bump", {
  payload: { value: Schema.Number },
  success: Schema.Number
})

/** A child execution: one step, `child:<label>`. */
export const Child = Flow.make("cloudflare-test/Child", {
  payload: { label: Schema.String },
  success: Schema.String,
  body: Node.capture({}, ({ label }) => Step.call({ label: `child:${label}` }))
})

/** Runs {@link Child} as its own execution, then records `parent:<what the child answered>`. */
export const Parent = Flow.make("cloudflare-test/Parent", {
  payload: { label: Schema.String },
  success: Schema.String,
  body: Node.capture({}, ({ label }) =>
    Child.child({ label }).pipe(
      Node.map(Node.capture({}, (answer: string) => `parent:${answer}`)),
      Node.bindPlanned(Node.capture({}, (answer) => Step.call({ label: answer })))
    ))
})

/** A child execution that fails with its declared error: a negative durable sleep. */
export const Faulty = Flow.make("cloudflare-test/Faulty", {
  payload: {},
  success: Schema.Void,
  error: Sleep.SleepRequestInvalid,
  body: Node.capture({}, () => Sleep.action.call({ millis: -1 }))
})

/** Runs {@link Faulty} as its own execution, so it fails with the child's error. */
export const Guardian = Flow.make("cloudflare-test/Guardian", {
  payload: {},
  success: Schema.Void,
  error: Sleep.SleepRequestInvalid,
  body: Node.capture({}, () => Faulty.child({}))
})

/** A child execution that parks until something outside the run answers it. */
export const Patient = Flow.make("cloudflare-test/Patient", {
  payload: {},
  success: Schema.String,
  body: Node.capture({}, () => Flow.park({ reason: "approval", token: "patient" }))
})

/** Hands off to {@link Patient} at once, so its lineage's current round is its second. */
export const Relay = Flow.make("cloudflare-test/Relay", {
  payload: {},
  success: Schema.String,
  body: Node.capture({}, () => Patient.to({}))
})

/** Runs {@link Relay} as its own execution and waits on its lineage. */
export const Supervisor = Flow.make("cloudflare-test/Supervisor", {
  payload: {},
  success: Schema.String,
  body: Node.capture({}, () => Relay.child({}))
})

/** A cancellation run: records `cleanup:<label>`. */
export const Cleanup = Flow.make("cloudflare-test/Cleanup", {
  payload: { label: Schema.String },
  success: Schema.String,
  body: Node.capture({}, ({ label }) => Step.call({ label: `cleanup:${label}` }))
})

/** A child that parks until answered and declares {@link Cleanup}, run as `cleanup:<label>`, as its cancellation. */
export const Holder = Flow.make("cloudflare-test/Holder", {
  payload: { label: Schema.String },
  success: Schema.String,
  body: Node.capture({}, () => Flow.park({ reason: "approval", token: "holder" }))
}).annotate(Flow.OnCancel, { flow: Cleanup, executionId: ({ label }: { readonly label: string }) => `cleanup:${label}` })

/** Runs {@link Holder} as its own execution and waits on it. */
export const Keeper = Flow.make("cloudflare-test/Keeper", {
  payload: { label: Schema.String },
  success: Schema.String,
  body: Node.capture({}, ({ label }) => Holder.child({ label }))
})

type CounterFlow = Flow.Flow<
  "cloudflare-test/Counter",
  Schema.Struct<{ value: typeof Schema.Number; target: typeof Schema.Number }>,
  typeof Schema.Number,
  typeof Schema.Never,
  // `.to()` drops the callee's requirements, so the type stays finite.
  Action.Requirement<"cloudflare-test/Bump">
>

/** Bumps `value` once per round and hands off to the next round until it reaches `target`. */
export const Counter: CounterFlow = Flow.make("cloudflare-test/Counter", {
  payload: { value: Schema.Number, target: Schema.Number },
  success: Schema.Number,
  body: Node.capture(
    {},
    ({ target, value }: { readonly value: number; readonly target: number }) =>
      Bump.call({ value }).pipe(
        Node.branch({
          if: Node.capture({ target }, function(next: number) {
            return next >= this.target
          }),
          then: Node.capture({}, (next) => Flow.done(next)),
          else: Node.capture({ target }, function(next) {
            return Counter.to({ value: next, target: this.target })
          })
        })
      )
  )
})

/** Every flow here, for an object's `flows`. */
export const flows: ReadonlyArray<Flow.Any> = [
  Parent,
  Child,
  Guardian,
  Faulty,
  Supervisor,
  Relay,
  Patient,
  Counter,
  Keeper,
  Holder,
  Cleanup
]

/**
 * Registers every flow here with `record` as each step: `Step` records its
 * label, `Bump` records `bump:<value>`.
 */
export const registration = (record: (label: string) => Effect.Effect<string>) => {
  const implementations = Layer.mergeAll(
    Step.toLayer(({ label }) => record(label)),
    Bump.toLayer(({ value }) => record(`bump:${value}`).pipe(Effect.as(value + 1)))
  )
  return Layer.mergeAll(
    Interpreter.layerWithImplementations(Child, implementations),
    Interpreter.layerWithImplementations(Parent, implementations),
    Interpreter.layerWithImplementations(Faulty, implementations),
    Interpreter.layerWithImplementations(Guardian, implementations),
    Interpreter.layerWithImplementations(Patient, implementations),
    Interpreter.layerWithImplementations(Relay, implementations),
    Interpreter.layerWithImplementations(Supervisor, implementations),
    Interpreter.layerWithImplementations(Counter, implementations),
    Interpreter.layerWithImplementations(Keeper, implementations),
    Interpreter.layerWithImplementations(Holder, implementations),
    Interpreter.layerWithImplementations(Cleanup, implementations)
  ).pipe(Layer.provideMerge(Action.layerImplementations))
}

/** The runtime an object's alarm builds: its own execution, over `database`. */
export const runtime = (options: {
  readonly record: (label: string) => Effect.Effect<string>
  readonly database: Layer.Layer<SqlClient.SqlClient>
}) =>
(intent: ExecutionObject.Intent) =>
  CloudflareRuntime.layer(
    { hostId: `object-${intent.executionId}`, executionId: intent.executionId },
    registration(options.record)
  ).pipe(Layer.provide(options.database))

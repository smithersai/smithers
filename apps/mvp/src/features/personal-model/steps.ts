import { Interpreter } from "@smthrs/flow"
import { Effect, Layer } from "effect"
import { type ModelNotTaken, PersonalModelClient } from "./api"
import { type ModelFailure, ModelRefused, ModelRemove, ModelTest, ModelUnsent, RemoveRequestStep, TestRequestStep } from "./flows"
import { record } from "./metrics"

// Testing and removing a person's own model (docs/features/personal-model.md#the-flows): one ChatApi request each,
// through `PersonalModelClient`. A person's press, or the agent's call, runs these steps on this device's engine.

/**
 * What ChatApi's answer means to the flow: a 4xx is final, with its code, but a timeout's or a rate limit's (408, 429);
 * so is `503 off` (no SECRETS_KEY: trying again changes nothing). Anything else is tried again.
 */
export const failureOf = (refused: ModelNotTaken): ModelFailure =>
  refused.status !== undefined &&
    (refused.status >= 400 && refused.status < 500 && refused.status !== 408 && refused.status !== 429 ||
      refused.code === "off")
    ? new ModelRefused({ status: refused.status, ...(refused.code === undefined ? {} : { code: refused.code }) })
    : new ModelUnsent()

/** The fields a refusal's record carries: its status, and its code when it had one. */
const fieldsOf = (refused: ModelNotTaken) => ({
  ...(refused.status === undefined ? {} : { status: refused.status }),
  ...(refused.code === undefined ? {} : { code: refused.code }),
})

/** A request as a step: its record by outcome, `sent`, `refused` or `unsent`; then its success, or its failure. */
const request = <A>(op: "delete" | "test", send: (client: PersonalModelClient["Service"]) => Effect.Effect<A, ModelNotTaken>) =>
  Effect.gen(function* () {
    const answer = yield* Effect.result(send(yield* PersonalModelClient))
    if (answer._tag === "Success") return answer.success
    const failure = failureOf(answer.failure)
    yield* record(op, failure._tag === "@smthrs/mvp/personal-model/ModelRefused" ? "refused" : "unsent", fieldsOf(answer.failure))
    return yield* Effect.fail(failure)
  })

/**
 * `model/test/request`: one `POST /api/me/model/test`. A test that went through is `ok`, or `failed` with the model
 * error's code and the provider's status.
 */
export const requestTest = request("test", (client) => client.test).pipe(
  Effect.tap((result) =>
    result.ok
      ? record("test", "ok")
      : record("test", "failed", { code: result.code, ...(result.status === null ? {} : { status: result.status }) })
  ),
)

/** `model/remove/request`: one `DELETE /api/me/model`. */
export const requestRemove = request("delete", (client) => client.remove).pipe(
  Effect.tap(() => record("delete", "sent")),
  Effect.as({ removed: true as const }),
)

/** Registers `model/test` and `model/remove` with their steps, asking through the host's `PersonalModelClient`. */
export const registration = Layer.merge(
  Interpreter.layerWithImplementations(ModelTest, TestRequestStep.toLayer(() => requestTest)),
  Interpreter.layerWithImplementations(ModelRemove, RemoveRequestStep.toLayer(() => requestRemove)),
)

/** The flows, asking ChatApi on `origin`. Needs the host's `HttpClient`. */
export const registrationAt = (origin: string) => registration.pipe(Layer.provide(PersonalModelClient.layer({ origin })))

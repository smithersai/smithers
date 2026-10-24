import { Effect, Exit, Option, Redacted } from "effect"
import { FlowDispatch } from "../../flows/dispatch"
import { type ModelNotTaken, PersonalModelClient } from "./api"
import { baseUrlOf, isModelId, isProtocol, longEnough, type Refusal } from "./contract"
import { record } from "./metrics"
import { FORM, type Form, HIDDEN, type Sent, TEST } from "./schema"
import { PersonalModelStore } from "./store"
import { onItsWay } from "./view"

// What a person does in the Your model section (docs/features/personal-model.md#the-settings-section), as Effects that
// finish synchronously. Save sends the key at once, in the person's own session, straight to ChatApi
// (`PersonalModelClient`), never through the device's outbox or a browser flow, either of which would keep it on the
// device; the key is `Redacted` from the moment it reaches the action and lives only in the one request. Remove and
// Test dispatch `model/remove` and `model/test` (door `button`), the flows the agent calls too.
//
// ChatApi's 202 means a write's flow started, not that it landed: the form clears its key at once and says Saving until
// the row shows the write (store.ts's follower), or that it hasn't shown up after `confirmWithin`. No whole answer is
// an unknown outcome, never a failure: the row may still show it landed.

/** The person's row, if the device has it. */
const current = Effect.flatMap(PersonalModelStore, (store) => Effect.map(store.row.toArray, ([row]) => row))

/** Forgets the last test, which said how the model before this write answered. */
const forgetTest = Effect.flatMap(PersonalModelStore, ({ tests }) => Effect.ignore(tests.delete(TEST)))

/**
 * Marks a write `sending`, remembering the row's `updatedAt` now (`before`). Answers the form's row, or none while its
 * last write is on its way.
 */
const begin = (op: Form["op"], sent: Sent | null) =>
  Effect.gen(function* () {
    const store = yield* PersonalModelStore
    const held = yield* store.form.get(FORM)
    if (Option.isSome(held) && onItsWay(held.value)) return Option.none<Form>()
    const write: Form = {
      id: FORM,
      op,
      state: "sending",
      failure: null,
      before: (yield* current)?.updatedAt ?? null,
      sent,
      saved: Option.isSome(held) ? held.value.saved : 0,
      quiet: false,
    }
    if (Option.isSome(held)) yield* store.form.update(FORM, (draft) => void Object.assign(draft, write))
    else yield* store.form.insert(write)
    yield* forgetTest
    return Option.some(write)
  })

/** The write was refused: the section says why, and it may be sent again. */
const refuse = (failure: Refusal) =>
  Effect.flatMap(PersonalModelStore, ({ form }) =>
    form.update(FORM, (draft) => {
      draft.state = "failed"
      draft.failure = failure
    }))

/**
 * ChatApi took the write: the form counts it (`saved`), which clears its key, and waits for the row, saying so after
 * `confirmWithin`.
 */
const confirm = (write: Form) =>
  Effect.gen(function* () {
    const store = yield* PersonalModelStore
    const op = write.op === "remove" ? "delete" : "put"
    const saved = write.saved + 1
    yield* store.form.update(FORM, (draft) => {
      draft.state = "confirming"
      draft.saved = saved
    })
    if (op === "put") yield* record(op, "started")
    yield* Effect.sleep(store.confirmWithin)
    const now = yield* store.form.get(FORM)
    // Landed meanwhile (`done`), or a later write took the form.
    if (Option.isNone(now) || now.value.state !== "confirming" || now.value.saved !== saved) return
    yield* store.form.update(FORM, (draft) => void (draft.state = "late"))
    yield* record(op, "late")
  })

/** A local check of what Save sends: the same refusal ChatApi would answer, or none. */
const checked = (protocol: string, baseUrl: string | undefined, modelId: string, key: string): Refusal | undefined => {
  if (!isProtocol(protocol)) return "invalid_protocol"
  if (baseUrl === undefined) return "invalid_base_url"
  if (!isModelId(modelId)) return "invalid_model"
  return longEnough(key) ? undefined : "too_short"
}

/**
 * Save: sets the person's model to `protocol` at `baseUrl`, with `modelId` and `key`. Always with a key, so a saved key
 * never goes to another host without the person typing it again. A field the server would refuse is refused here,
 * unsent, with the server's own code. Answers whether the save was sent: not while the last write is on its way, nor
 * when the section refused it.
 */
export const save = (protocol: string, baseUrl: string, modelId: string, key: string) => {
  const sealed = Redacted.make(key)
  return Effect.gen(function* () {
    const store = yield* PersonalModelStore
    const normalized = baseUrlOf(baseUrl)
    const id = modelId.trim()
    const local = checked(protocol, normalized, id, Redacted.value(sealed))
    const sent = local === undefined ? { protocol: protocol as Sent["protocol"], baseUrl: normalized!, modelId: id } : null
    const begun = yield* begin("save", sent)
    if (Option.isNone(begun)) return false
    if (local !== undefined) {
      yield* refuse(local)
      yield* record("put", "refused", { code: local })
      return false
    }
    yield* (yield* PersonalModelClient).put({ ...sent!, key: sealed }).pipe(
      Effect.matchEffect({
        onSuccess: () => confirm(begun.value),
        onFailure: (refused: ModelNotTaken) =>
          refused.code === undefined
            ? Effect.andThen(
              store.form.update(FORM, (draft) => void (draft.state = "unknown")),
              record("put", "unknown", refused.status === undefined ? {} : { status: refused.status }),
            )
            : Effect.andThen(refuse(refused.code), record("put", "refused", { code: refused.code, status: refused.status! })),
      }),
      Effect.ignore,
      Effect.forkIn(store.scope),
    )
    return true
  }).pipe(Effect.orDie)
}

/**
 * Remove: dispatches `model/remove`, door `button`. It returns at once; the section waits until the row is gone, or
 * says why it didn't go. Answers whether it was sent: not while the last write is on its way.
 */
export const remove = Effect.gen(function* () {
  const store = yield* PersonalModelStore
  const flows = yield* FlowDispatch
  const begun = yield* begin("remove", null)
  if (Option.isNone(begun)) return false
  yield* flows.dispatch("model/remove", {}, { door: "button" }).pipe(
    Effect.exit,
    Effect.flatMap((exit) => {
      if (Exit.isSuccess(exit) && exit.value._tag === "Done") return confirm(begun.value)
      const refused = Exit.isSuccess(exit) && exit.value._tag === "Failed" &&
          exit.value.error._tag === "@smthrs/mvp/personal-model/ModelRefused"
        ? exit.value.error.code
        : undefined
      return refuse(refused ?? "unavailable")
    }),
    Effect.ignore,
    Effect.forkIn(store.scope),
  )
  return true
}).pipe(Effect.orDie)

/**
 * Test: dispatches `model/test`, door `button`. It returns at once; the section shows the result, or why there was
 * none, once the flow ends. Answers whether it was sent: not while a test or a write is on its way.
 */
export const test = Effect.gen(function* () {
  const store = yield* PersonalModelStore
  const flows = yield* FlowDispatch
  const held = yield* store.tests.get(TEST)
  const write = yield* store.form.get(FORM)
  if (Option.isSome(held) && held.value.state === "testing" || Option.isSome(write) && onItsWay(write.value)) return false
  // The test takes the status line from the last write's outcome. The form keeps its count, which keys its fields.
  if (Option.isSome(write)) yield* store.form.update(FORM, (draft) => void (draft.quiet = true))
  const testing = { id: TEST, state: "testing" as const, result: null, failure: null, failedAt: null }
  if (Option.isSome(held)) yield* store.tests.update(TEST, (draft) => void Object.assign(draft, testing))
  else yield* store.tests.insert(testing)
  yield* flows.dispatch("model/test", {}, { door: "button" }).pipe(
    Effect.exit,
    Effect.flatMap((exit) =>
      Effect.gen(function* () {
        const now = yield* store.tests.get(TEST)
        // A write since forgot this test: its answer is about the model before.
        if (Option.isNone(now) || now.value.state !== "testing") return
        const failedAt = (yield* current)?.failedAt ?? null
        if (Exit.isSuccess(exit) && exit.value._tag === "Done") {
          const result = exit.value.value
          return yield* store.tests.update(TEST, (draft) => void Object.assign(draft, { state: "done", result, failedAt }))
        }
        const refused = Exit.isSuccess(exit) && exit.value._tag === "Failed" &&
            exit.value.error._tag === "@smthrs/mvp/personal-model/ModelRefused"
          ? exit.value.error.code
          : undefined
        yield* store.tests.update(TEST, (draft) =>
          void Object.assign(draft, { state: "failed", failure: refused ?? "unavailable", failedAt }))
      })
    ),
    Effect.ignore,
    Effect.forkIn(store.scope),
  )
  return true
}).pipe(Effect.orDie)

/** Hide on the failure toast: this device stops showing that failure; a later one shows again. */
export const hide = (failedAt: string) =>
  Effect.gen(function* () {
    const { hidden } = yield* PersonalModelStore
    if (Option.isSome(yield* hidden.get(HIDDEN))) yield* hidden.update(HIDDEN, (draft) => void (draft.failedAt = failedAt))
    else yield* hidden.insert({ id: HIDDEN, failedAt })
  }).pipe(
    // A device collection refuses only a row its own schema rejects, which these never are: a bug, not a state.
    Effect.orDie,
  )

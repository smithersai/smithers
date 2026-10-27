import { Effect, Exit, Option, Redacted } from "effect"
import { recordUnhandled } from "../../boundary"
import { FlowDispatch } from "../../flows/dispatch"
import { type ModelNotTaken, PersonalModelClient } from "./api"
import { checkSave, type Refusal } from "./contract"
import { record } from "./metrics"
import { testDraftProblem } from "./testDraft"
import { FORM, type Form, type Sent, TEST } from "./schema"
import { PersonalModelStore } from "./store"
import { lastFailure, latestUpdate, onItsWay, type SaveForm } from "./view"

// What a person does in the Your model section (docs/features/personal-model.md#the-settings-section), as Effects that
// finish synchronously. Save sends the keys at once, in the person's own session, straight to ChatApi
// (`PersonalModelClient`), never through the device's outbox or a browser flow, either of which would keep it on the
// device; each key is `Redacted` from the moment it reaches the action and lives only in the one request. Remove and
// Test dispatch `model/remove` and `model/test` (door `button`), the flows the agent calls too.
//
// ChatApi's 202 means a write's flow started, not that it landed: the form clears its keys at once and says Saving
// until the rows show the write (store.ts's follower), or that it hasn't shown up after `confirmWithin`. No whole answer
// is an unknown outcome, never a failure: the rows may still show it landed.

/**
 * A write's follow-up, for the store's scope: it writes only the form's row, which `begin` made and nothing deletes,
 * so a refusal is a bug. It dies, and since no caller awaits the fork, it is logged as `app.unhandled`.
 */
const followUp = <A, E, R>(effect: Effect.Effect<A, E, R>) => recordUnhandled(Effect.orDie(effect), "personal-model", "fork")

/** The person's saved keys' rows, as the device has them. */
const current = Effect.flatMap(PersonalModelStore, (store) => store.saved.toArray)

/** Forgets the last test, which said how the model before this write answered. */
const forgetTest = Effect.flatMap(PersonalModelStore, ({ tests }) => Effect.ignore(tests.delete(TEST)))

/**
 * Marks a write `sending`, remembering the rows' latest `updatedAt` now (`before`). Answers the form's row, or none
 * while its last write is on its way.
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
      before: latestUpdate(yield* current),
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
 * ChatApi took the write: the form counts it (`saved`), which clears its keys, and waits for the rows, saying so after
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

/**
 * Save: sets the person's keys and their tiers' models to `form`'s, removing a saved key it leaves out. A key left
 * empty keeps the one saved at the same base URL, so a saved key never goes to another host without the person typing
 * it again. What the server would refuse is refused here, unsent, with the server's own code (`checkSave`). Answers
 * whether the save was sent: not while the last write is on its way, nor when the section refused it.
 */
export const save = (form: SaveForm) => {
  const keys = form.keys.map(({ protocol, baseUrl, key }) => ({ protocol, baseUrl, key: Redacted.make(key) }))
  return Effect.gen(function* () {
    const store = yield* PersonalModelStore
    const checked = checkSave({
      keys: keys.map(({ protocol, baseUrl, key }) => ({ protocol, baseUrl, key: Redacted.value(key) })),
      models: form.models,
    }, yield* current)
    const sent: Sent | null = typeof checked === "string"
      ? null
      : { keys: checked.keys.map(({ protocol, baseUrl }) => ({ protocol, baseUrl })), models: checked.models }
    const begun = yield* begin("save", sent)
    if (Option.isNone(begun)) return false
    if (typeof checked === "string") {
      yield* refuse(checked)
      yield* record("put", "refused", { code: checked })
      return false
    }
    const put = {
      // The key as typed, `Redacted`, beside the base URL ChatApi keeps; none where the saved one stays.
      keys: checked.keys.map(({ protocol, baseUrl, key }) => ({
        protocol,
        baseUrl,
        key: key === undefined ? undefined : keys.find((typed) => typed.protocol === protocol)!.key,
      })),
      models: checked.models,
    }
    yield* (yield* PersonalModelClient).put(put).pipe(
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
      followUp,
      Effect.forkIn(store.scope),
    )
    return true
  }).pipe(Effect.orDie)
}

/**
 * Remove: dispatches `model/remove`, door `button`. It returns at once; the section waits until the rows are gone, or
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
    followUp,
    Effect.forkIn(store.scope),
  )
  return true
}).pipe(Effect.orDie)

/**
 * Test: dispatches `model/test`, door `button`. It returns at once; the section shows the result, or why there was
 * none, once the flow ends. A supplied form is checked synchronously and must match the saved model; only a refusal
 * code survives that check. Answers whether it was sent: not while a test or a write is on its way.
 */
export const test = (draft?: SaveForm) => Effect.gen(function* () {
  const store = yield* PersonalModelStore
  const flows = yield* FlowDispatch
  const held = yield* store.tests.get(TEST)
  const write = yield* store.form.get(FORM)
  if (Option.isSome(held) && held.value.state === "testing" || Option.isSome(write) && onItsWay(write.value)) return false
  if (draft !== undefined) {
    const failure = testDraftProblem(draft, yield* current)
    if (failure !== undefined) {
      // Replace an old result without storing the draft, especially its keys.
      if (Option.isSome(write)) yield* store.form.update(FORM, (row) => void (row.quiet = true))
      const refused = { id: TEST, state: "failed" as const, result: null, failure, failedAt: lastFailure(yield* current)?.failedAt ?? null }
      if (Option.isSome(held)) yield* store.tests.update(TEST, (row) => void Object.assign(row, refused))
      else yield* store.tests.insert(refused)
      yield* record("test", "refused", { code: failure })
      return false
    }
  }
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
        const failedAt = lastFailure(yield* current)?.failedAt ?? null
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
    // expected: a save meanwhile can delete the test row (forgetTest), and its answer is then about the model before
    Effect.ignore,
    Effect.forkIn(store.scope),
  )
  return true
}).pipe(Effect.orDie)


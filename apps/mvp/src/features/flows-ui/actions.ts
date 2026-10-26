import { answersToSend } from "@smthrs/ui"
import { Deferred, Effect, Option, Stream } from "effect"
import { type DispatchFailed, FlowDispatch } from "../../flows/dispatch"
import { RunsNavigation } from "../runs/actions"
import { runPath } from "../runs/contract"
import { codePath, draftPath, FLOWS_PATH, MAX_REQUEST_CHARS, NAME_PATTERN, NEW_FLOW_PATH, RESERVED_NAMES } from "./contract"
import { trackEditorPersistence } from "./editorWrites"
import { roundExecutionId } from "./round"
import { type Code, FlowsUiStore, type Form, SHOWN, type Shown } from "./store"

// What a person does with their own flows (decision 0014 §2 and §5, docs/features/flows.md#the-browser): the new-flow
// form, a draft's answers, Save, Run, Edit, Code and Delete. Every act runs its flow through `FlowDispatch`, door
// `button`, the same declarations the agent and the slash commands run. A flow that takes a while (a draft round, a
// run) is started and left to run: the page goes where it shows once the engine has recorded the run.

/** Whether the form can start a draft: a name a person's flow may take, and something it should do. */
export const formReady = (form: Pick<Form, "name" | "request">): boolean =>
  NAME_PATTERN.test(form.name) &&
  !(RESERVED_NAMES as ReadonlyArray<string>).includes(form.name) &&
  form.request.trim().length > 0 &&
  form.request.trim().length <= MAX_REQUEST_CHARS

/** Sets fields of the form. */
export const setForm = (fields: Partial<Omit<Form, "id">>) =>
  // Tracked from the keystroke, through the editor's restore, to its receipt: an update never reloads in between.
  Effect.flatMap(FlowsUiStore, ({ form, formId, editorReady }) => trackEditorPersistence(Effect.flatMap(editorReady, (ready) => ready
    ? Effect.flatMap(form.update(formId, (draft) => void Object.assign(draft, fields)), (write) => write.persisted)
    : Effect.void))).pipe(
    Effect.asVoid,
    // The form's row always exists, and its schema takes any text: a refusal is a bug.
    Effect.orDie,
  )

/** Sets fields of the shown draft's row. */
const setShown = (fields: Partial<Omit<Shown, "id">>) =>
  Effect.flatMap(FlowsUiStore, ({ shown }) => shown.update(SHOWN, (draft) => void Object.assign(draft, fields))).pipe(
    Effect.asVoid,
    Effect.orDie,
  )

/** A slow action on one draft must not mark the next draft's card. */
const setShownFor = (draftId: string, fields: Partial<Omit<Shown, "id">>) =>
  Effect.flatMap(FlowsUiStore, ({ shown }) => shown.update(SHOWN, (draft) => {
    if (draft.draftId === draftId) Object.assign(draft, fields)
  })).pipe(Effect.asVoid, Effect.orDie)

/** Goes to `path` in this tab. */
const go = (path: string) => Effect.flatMap(RunsNavigation, ({ navigate }) => Effect.sync(() => navigate(path)))

/** A background draft action may navigate only while its card is still the page. */
const onDraftPage = (draftId: string) =>
  Effect.map(RunsNavigation, ({ pathname }) => pathname === undefined || pathname() === draftPath(draftId))

/**
 * Starts `run` in the background and waits only until the engine has recorded it: `true` once it has, `false` when
 * the engine refused it.
 */
const started = (run: (admitted: Deferred.Deferred<void, DispatchFailed>) => Effect.Effect<unknown, unknown>) =>
  Effect.gen(function* () {
    const admitted = yield* Deferred.make<void, DispatchFailed>()
    yield* Effect.forkDetach(Effect.ignore(run(admitted)))
    return yield* Deferred.await(admitted).pipe(Effect.as(true), Effect.orElseSucceed(() => false))
  })

/** The new-flow route's loader: keep typed text; clear only an untouched name supplied by an Edit link. */
export const openNew = (name: string | undefined) =>
  Effect.gen(function* () {
    const { form, formId, editorReady } = yield* FlowsUiStore
    if (!(yield* editorReady)) return
    const current = Option.getOrThrow(yield* form.get(formId))
    if (name === undefined) {
      if (current.seeded && current.request === "") yield* setForm({ name: "", seeded: false })
      return
    }
    // A typed request belongs to the person, not to the next Edit link they happen to open.
    if (current.request !== "") return
    if (current.name !== name) yield* setForm({ name, request: "", seeded: true })
    else if (current.request === "" && !current.seeded) yield* setForm({ seeded: true })
  })

/**
 * Draft: round 0 of a new draft, from the form; its card opens once the engine has the round. The draft's id is the
 * form's, so a second press before the first is admitted starts the same execution, which the engine runs once; the
 * form then takes a new one.
 */
export const startDraft = Effect.gen(function* () {
  const store = yield* FlowsUiStore
  if (!(yield* store.editorReady)) return
  const form = Option.getOrThrow(yield* store.form.get(store.formId))
  if (!formReady(form)) return
  const { draftId } = form
  const flows = yield* FlowDispatch
  const admitted = yield* started((admitted) =>
    flows.dispatch("flow/new", { name: form.name, request: form.request.trim() }, {
      door: "button",
      executionId: roundExecutionId(draftId, 0),
      admitted,
    })
  )
  if (!admitted) return
  if ((Option.getOrThrow(yield* store.form.get(store.formId))).draftId === draftId) {
    yield* setForm({ name: "", request: "", draftId: crypto.randomUUID(), seeded: false })
  }
  yield* go(draftPath(draftId))
})

/** The draft route's loader: shows `draftId`, with no refusal, and reads its round from this device's engine. */
export const openDraft = (draftId: string) =>
  Effect.andThen(setShown({ draftId, refusal: null, busy: false }), Effect.flatMap(FlowsUiStore, (store) => store.readRound))

/** An answer typed into a question's field. */
export const setAnswer = (draftId: string, questionId: string, value: string) =>
  Effect.gen(function* () {
    const { answers, editorTabId, editorReady } = yield* FlowsUiStore
    const id = `${editorTabId}:${draftId}:${questionId}`
    yield* trackEditorPersistence(Effect.gen(function* () {
      if (!(yield* editorReady)) return
      const current = yield* answers.get(id)
      const write = yield* Option.isNone(current)
        ? answers.insert({ id, tabId: editorTabId, draftId, questionId, value })
        : answers.update(id, (draft) => void (draft.value = value))
      yield* write.persisted
    }))
  }).pipe(Effect.asVoid, Effect.orDie)

/** The shown draft and the person's unsent answers to it, by question id. */
const shownDraft = Effect.gen(function* () {
  const store = yield* FlowsUiStore
  const shown = Option.getOrThrow(yield* store.shown.get(SHOWN))
  if (shown.draftId === null) return Option.none()
  const draft = yield* store.drafts.get(shown.draftId)
  const answers = (yield* store.answers.toArray).filter((answer) => answer.tabId === store.editorTabId && answer.draftId === shown.draftId)
  return Option.map(draft, (draft) => ({
    draft,
    answers: Object.fromEntries(answers.map((answer) => [answer.questionId, answer.value])),
    ids: answers.map((answer) => answer.id),
  }))
})

/**
 * Answer: the changed answers, and each blocking question nobody answered at the value its field shows (its default
 * until the person types), start the draft's next round.
 */
export const answer = Effect.gen(function* () {
  if (!(yield* (yield* FlowsUiStore).editorReady)) return
  const shown = yield* shownDraft
  if (Option.isNone(shown)) return
  const { draft, answers, ids } = shown.value
  const changed = answersToSend(draft.questions, answers)
  if (changed.length === 0) return
  const flows = yield* FlowDispatch
  const admitted = yield* started((admitted) =>
    flows.dispatch("flow/answer", { draftId: draft.id, round: draft.round, answers: changed }, { door: "button", admitted })
  )
  if (admitted && ids.length > 0) yield* trackEditorPersistence(Effect.flatMap((yield* FlowsUiStore).answers.delete(ids), (write) => write.persisted)).pipe(Effect.orDie)
})

/**
 * Draft again: the shown draft's next round, from its request and what it drafted so far, at the first round after its
 * own that this device's engine holds no run of; a round already started here is left to run. Its card follows the
 * new round once the device has its row.
 */
export const draftAgain = Effect.gen(function* () {
  const shown = yield* shownDraft
  if (Option.isNone(shown)) return
  const { draft } = shown.value
  const store = yield* FlowsUiStore
  const next = yield* store.nextRound(draft.id, draft.round)
  // A round started here already, its row on the way: a second press starts nothing.
  if (next._tag === "Pending") return
  if (next._tag === "Unreadable") return yield* setShownFor(draft.id, { refusal: "again_unavailable" })
  const flows = yield* FlowDispatch
  const admitted = yield* started((admitted) =>
    // `flow/new` names every draft it writes.
    flows.dispatch("flow/new", { name: draft.name!, request: draft.request }, {
      door: "button",
      executionId: roundExecutionId(draft.id, next.round),
      admitted,
    })
  )
  if (!admitted) yield* setShownFor(draft.id, { refusal: "again_unavailable" })
})

/** Delete: the draft `draftId`, its round stopped here; the list of flows opens once it is gone. */
export const deleteDraft = (draftId: string) =>
  Effect.gen(function* () {
    const dispatched = yield* (yield* FlowDispatch).dispatch("flow/draft/delete", { draftId }, { door: "button" }).pipe(
      Effect.result,
    )
    if (dispatched._tag === "Success" && dispatched.success._tag === "Done") {
      if (yield* onDraftPage(draftId)) yield* go(FLOWS_PATH)
      return
    }
    const { draftId: showing } = Option.getOrThrow(yield* (yield* FlowsUiStore).shown.get(SHOWN))
    if (showing === draftId) yield* setShownFor(draftId, { refusal: "delete_unavailable" })
  })

/** What `flow/save` refused, as the code the card shows: `name_taken`, the refusal's own code, else `unavailable`. */
export const savedRefusal = (error: { readonly _tag: string; readonly code?: string }) =>
  error._tag === "@smthrs/mvp/flows/NameTaken" ? "name_taken" : error.code ?? "unavailable"

/** Save: the shown draft becomes the person's flow; the list of flows opens. */
export const save = Effect.gen(function* () {
  const shown = yield* shownDraft
  if (Option.isNone(shown)) return
  const draftId = shown.value.draft.id
  yield* setShownFor(draftId, { busy: true, refusal: null })
  const dispatched = yield* (yield* FlowDispatch).dispatch("flow/save", { draftId }, {
    door: "button",
  }).pipe(Effect.result)
  if (dispatched._tag === "Failure") return yield* setShownFor(draftId, { busy: false, refusal: "unavailable" })
  const ended = dispatched.success
  if (ended._tag === "Failed") return yield* setShownFor(draftId, { busy: false, refusal: savedRefusal(ended.error) })
  yield* synced(ended.value)
  yield* setShownFor(draftId, { busy: false })
  if (yield* onDraftPage(draftId)) yield* go(FLOWS_PATH)
})

/**
 * Waits until this device has the saved revision, so the list Save opens shows it: Electric delivers it, or the device
 * has it. One Electric doesn't deliver within the store's `confirmWithin` is logged `flow.save.unconfirmed`, and the
 * list opens anyway: the save is done, and the row follows.
 */
const synced = (saved: { readonly flowId: string; readonly revision: number }) =>
  Effect.gen(function* () {
    const { flows, confirmWithin } = yield* FlowsUiStore
    // With the rows the device has as the first batch, so a row that arrived before the wait isn't missed.
    const delivered = yield* flows.changes({ initial: true }).pipe(
      Stream.mapEffect(() => flows.get(saved.flowId)),
      Stream.filter((row) => Option.isSome(row) && row.value.revision >= saved.revision),
      Stream.runHead,
      Effect.timeoutOption(confirmWithin),
    )
    if (Option.isNone(delivered)) {
      yield* Effect.logWarning("flow.save.unconfirmed").pipe(Effect.annotateLogs({ feature: "flows" }))
    }
  })

/** Applies a result only while the same opening still owns the editor. */
const changeCodeIf = (epoch: number, name: string | undefined, change: (draft: Code) => void) =>
  Effect.flatMap(FlowsUiStore, ({ code, codeId, codeEpoch, editorReady }) => trackEditorPersistence(Effect.flatMap(editorReady, (ready) => ready
    ? Effect.flatMap(code.update(codeId, (draft) => {
      if (codeEpoch.current === epoch && (name === undefined || draft.name === name)) change(draft)
    }), (write) => write.persisted)
    : Effect.void))).pipe(
    Effect.asVoid,
    Effect.orDie,
  )

const setCodeIf = (epoch: number, name: string | undefined, fields: Partial<Omit<Code, "id">>) =>
  changeCodeIf(epoch, name, (draft) => void Object.assign(draft, fields))

/** The code row. */
const codeRow = Effect.flatMap(FlowsUiStore, ({ code, codeId }) => code.get(codeId)).pipe(Effect.map(Option.getOrThrow))

/**
 * The code route's loader: reads the flow `name`'s latest code through `flow/read` and shows it. A read that ends after
 * the tab moved on to another flow's code changes nothing.
 */
export const openCode = (name: string, expectedEpoch?: number) =>
  Effect.gen(function* () {
    const store = yield* FlowsUiStore
    if (!(yield* store.editorReady)) return
    if (expectedEpoch !== undefined && store.codeEpoch.current !== expectedEpoch) return
    const epoch = ++store.codeEpoch.current
    let before = yield* codeRow
    if (before.name !== name) {
      if (before.name !== "" && before.state === "read") {
        // Hide the outgoing editor before the SQLite stash waits. A last keystroke before this write is read below;
        // one after it cannot edit a page the person is leaving.
        yield* setCodeIf(epoch, before.name, { state: "loading" })
        if (store.codeEpoch.current !== epoch) return
        before = yield* codeRow
      }
      if (before.name !== "" && before.text !== before.source) {
        const id = `${store.codeId}:draft:${before.name}`
        const kept = { ...before, id, state: "read" as const, busy: false }
        const existing = yield* store.code.get(id)
        yield* trackEditorPersistence(Effect.flatMap(
          Option.isNone(existing)
            ? store.code.insert(kept)
            : store.code.update(id, (row) => void Object.assign(row, kept)),
          (write) => write.persisted,
        )).pipe(Effect.orDie)
        if (store.codeEpoch.current !== epoch) return
      }
      const stashId = `${store.codeId}:draft:${name}`
      const stashed = yield* store.code.get(stashId)
      if (store.codeEpoch.current !== epoch) return
      if (Option.isSome(stashed)) {
        const saved = stashed.value
        yield* setCodeIf(epoch, undefined, {
          name, state: saved.state, revision: saved.revision, source: saved.source,
          text: saved.text, busy: false, refusal: saved.refusal,
        })
        if (store.codeEpoch.current !== epoch) return
        yield* trackEditorPersistence(Effect.flatMap(store.code.delete(stashId), (write) => write.persisted)).pipe(Effect.orDie)
        if (store.codeEpoch.current !== epoch) return
        before = { ...saved, id: store.codeId }
      }
    }
    if (store.codeEpoch.current !== epoch) return
    const editing = before.name === name && before.text !== before.source
    if (editing) yield* setCodeIf(epoch, name, { busy: false })
    else yield* setCodeIf(epoch, undefined, { name, state: "loading", revision: 0, source: "", text: "", busy: false, refusal: null })
    if (store.codeEpoch.current !== epoch) return
    const dispatched = yield* (yield* FlowDispatch).dispatch("flow/read", { name }, { door: "button" }).pipe(Effect.result)
    if (store.codeEpoch.current !== epoch || (yield* codeRow).name !== name) return
    const ended = dispatched._tag === "Success" ? dispatched.success : undefined
    if (ended?._tag !== "Done") {
      // The engine refused the read, or ChatApi did: the flow isn't the person's, or the read failed.
      const notFound = ended?._tag === "Failed" && ended.error._tag === "@smthrs/mvp/flows/FlowNotFound"
      return yield* setCodeIf(epoch, name, editing
        ? { state: "read", busy: false, refusal: notFound ? "not_found" : "unavailable" }
        : { state: notFound ? "not_found" : "unavailable" })
    }
    if (editing) {
      // Keep unsaved text across a reload. Adopt the current server revision but require an explicit overwrite press
      // before that text can replace a newer revision.
      return yield* changeCodeIf(epoch, name, (draft) => {
        const unchanged = draft.revision === ended.value.revision && draft.source === ended.value.source
        const alreadySaved = draft.text === ended.value.source
        const wasStale = draft.refusal === "stale"
        Object.assign(draft, {
          state: "read",
          busy: false,
          revision: ended.value.revision,
          source: ended.value.source,
          refusal: alreadySaved || (unchanged && !wasStale) ? null : "stale",
        })
      })
    }
    yield* setCodeIf(epoch, name, { state: "read", revision: ended.value.revision, source: ended.value.source, text: ended.value.source })
  })

/** A keystroke from an earlier code page cannot edit the flow opened after it. */
export const editCode = (name: string, text: string, epoch: number) =>
  changeCodeIf(epoch, name, (draft) => {
    if (draft.state === "read") Object.assign(draft, { text })
  })

/** What `flow/write` refused, as the code the page shows: a check as `check:<check>`, ChatApi's code, else `unavailable`. */
export const writtenRefusal = (error: { readonly _tag: string; readonly code?: string; readonly check?: string }) =>
  error.check !== undefined
    ? `check:${error.check}`
    : error.code ?? (error._tag === "@smthrs/mvp/flows/FlowNotFound" ? "not_found" : "unavailable")

/** Whether the shown code can be saved: read, changed, not empty, and no write in flight. */
export const codeSaveable = (code: Pick<Code, "state" | "busy" | "text" | "source">): boolean =>
  code.state === "read" && !code.busy && code.text !== code.source && code.text.trim() !== ""

/** Save: the edited code becomes the flow's next revision through `flow/write`; the list of flows opens. */
export const saveCode = (confirmStale = false) => Effect.gen(function* () {
  const store = yield* FlowsUiStore
  if (!(yield* store.editorReady)) return
  const epoch = store.codeEpoch.current
  const code = yield* codeRow
  if (store.codeEpoch.current !== epoch) return
  if (!codeSaveable(code)) return
  if (code.refusal === "stale" && !confirmStale) return
  yield* setCodeIf(epoch, code.name, { busy: true, refusal: null })
  if (store.codeEpoch.current !== epoch) return
  const dispatched = yield* (yield* FlowDispatch).dispatch(
    "flow/write",
    { name: code.name, revision: code.revision, source: code.text },
    { door: "button" },
  ).pipe(Effect.result)
  if (store.codeEpoch.current !== epoch || (yield* codeRow).name !== code.name) return
  if (dispatched._tag === "Failure") return yield* setCodeIf(epoch, code.name, { busy: false, refusal: "unavailable" })
  const ended = dispatched.success
  if (ended._tag === "Failed") {
    const refusal = writtenRefusal(ended.error)
    yield* setCodeIf(epoch, code.name, { busy: false, refusal })
    if (refusal === "stale" && store.codeEpoch.current === epoch && (yield* codeRow).name === code.name) yield* openCode(code.name, epoch)
    return
  }
  yield* synced(ended.value)
  if (store.codeEpoch.current !== epoch || (yield* codeRow).name !== code.name) return
  yield* setCodeIf(epoch, code.name, { busy: false, revision: ended.value.revision, source: code.text })
  const current = yield* codeRow
  const route = yield* RunsNavigation
  if (store.codeEpoch.current === epoch && current.name === code.name && current.text === code.text &&
      (route.pathname === undefined || route.pathname() === codePath(code.name))) yield* go(FLOWS_PATH)
})

/** Run: a run of the person's flow `name` at `revision`, whose page opens once the engine has it. */
export const run = (name: string, revision: number) =>
  Effect.gen(function* () {
    const runId = crypto.randomUUID()
    const flows = yield* FlowDispatch
    const admitted = yield* started((admitted) =>
      flows.dispatch("flow/run", { name, revision }, { door: "button", executionId: runId, admitted })
    )
    if (admitted) yield* go(runPath(runId))
  })

/** Edit: a new draft of the flow `name`, from its latest revision. */
export const edit = (name: string) => go(`${NEW_FLOW_PATH}?name=${encodeURIComponent(name)}`)

/** Delete: the person's flow `flowId`. */
export const remove = (flowId: string) =>
  Effect.flatMap(FlowDispatch, (flows) => flows.dispatch("flow/delete", { flowId }, { door: "button" })).pipe(
    Effect.ignore,
  )

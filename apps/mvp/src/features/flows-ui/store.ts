import { ElectricCollection } from "@smthrs/effect-electric"
import { Collection, LiveQuery, Persistence, Query } from "@smthrs/effect-tanstack-db"
import { BrowserEngine } from "@smthrs/platform-browser"
import { Context, Deferred, Duration, Effect, Layer, Option, Schema, Stream } from "effect"
import { FLOW_DRAFTS_SHAPE_ROUTE, FLOWS_SHAPE_ROUTE } from "./contract"
import * as Following from "./following"
import { roundExecutionId } from "./round"
import { AnswerRow, Code, CODE, Draft, FlowRow, Form, FORM } from "./schema"
export { AnswerRow, Code, CODE, Form, FORM } from "./schema"

// Your own flows on this tab (decision 0014 §1 "On the device", docs/features/flows.md#the-browser): the person's flows
// and drafts, which Postgres keeps and Electric syncs to every device they sign in on, kept on the device; and this
// tab's own form, unsent answers and code editor kept on the device; the draft it shows, its last refusal and how the
// shown draft's round runs on this device's engine in memory. The round is read again on each batch of the engine's events
// and each change of the drafts, at most once per `FOLLOW_EVERY`; nothing polls.

/** Where the shapes sync from: ChatApi's origin, the site's own. */
export interface FlowsUiConfig {
  readonly origin: string
  /** Stable for one browser tab across reloads; different tabs never share unfinished editors. */
  readonly editorTabId: string
  readonly editorTabPersistent: boolean
  /** How long Save waits for Electric to deliver the flow it saved before the list opens anyway. Default 15 s. */
  readonly confirmWithin?: Duration.Input
}

/** How often the shown draft's round is read again while the engine works or the drafts change. */
export const FOLLOW_EVERY = Duration.millis(200)
/** How long the editors wait for the device to restore their rows before they say storage is unavailable. Its rows stay untouched for a later reload. */
export const EDITOR_RESTORE_WITHIN = Duration.seconds(5)

/**
 * Whether this tab's editors (the form, the answers and the code) may write: `restoring` until the device store has
 * restored and seeded their rows, in the background so the app renders without waiting (docs/decisions/0108-first-load.md);
 * then `available`, or `unavailable` when it couldn't, the tab's identity can't survive a reload, or the device keeps
 * nothing.
 */
export const EDITOR = "editor"
export const EditorState = Schema.Literals(["restoring", "available", "unavailable"])
export type EditorState = typeof EditorState.Type
export const Editor = Schema.Struct({ id: Schema.Literal(EDITOR), state: EditorState })
export type Editor = typeof Editor.Type

/** The editors' state. */
export const editorQuery = (editor: Collection.Collection<Editor, string>) =>
  LiveQuery.make((q) => q.from({ editor: editor.tanstack }).findOne())

/** A run's status on this device's engine, or `absent` when the engine doesn't hold it (another device, or none). */
export const RoundStatus = Schema.Literals(["pending", "running", "suspended", "completed", "failed", "cancelled", "absent"])
export type RoundStatus = typeof RoundStatus.Type

/** The shown draft's round, `<draftId>:<round>`, as this device's engine last read it. */
export const ROUND = "round"
export const RoundRun = Schema.Struct({ id: Schema.Literal(ROUND), runId: Schema.NullOr(Schema.String), status: RoundStatus })
export type RoundRun = typeof RoundRun.Type

/** The draft this tab shows full size, and the last refusal of an act on it (`name_taken`, `checks`, ...). */
export const SHOWN = "shown"
export const Shown = Schema.Struct({
  id: Schema.Literal(SHOWN),
  draftId: Schema.NullOr(Schema.String),
  refusal: Schema.NullOr(Schema.String),
  busy: Schema.Boolean,
})
export type Shown = typeof Shown.Type

/** The shown draft's round run. */
export const roundQuery = (round: Collection.Collection<RoundRun, string>) =>
  LiveQuery.make((q) => q.from({ round: round.tanstack }).findOne())

/** The draft `shown` names, once the device has it. */
export const draftQuery = (shown: Collection.Collection<Shown, string>, drafts: Collection.Collection<Draft>) =>
  LiveQuery.make((q) =>
    q
      .from({ shown: shown.tanstack })
      .innerJoin({ draft: drafts.tanstack }, ({ shown, draft }) => Query.eq(shown.draftId, draft.id))
      .select(({ shown, draft }) => ({ shown, draft }))
      .findOne()
  )

/** The person's flows, by name. */
export const flowsQuery = (flows: Collection.Collection<FlowRow>) =>
  LiveQuery.make((q) => q.from({ flow: flows.tanstack }).orderBy(({ flow }) => flow.name, "asc"))

/** The person's drafts not saved yet, newest first. */
export const draftsQuery = (drafts: Collection.Collection<Draft>) =>
  LiveQuery.make((q) =>
    q
      .from({ draft: drafts.tanstack })
      .where(({ draft }) => Query.and(Query.not(Query.eq(draft.status, "saved")), Query.not(Query.eq(draft.status, "proposed"))))
      .orderBy(({ draft }) => draft.updatedAt, "desc")
  )

/** The form's row. */
export const formQuery = (form: Collection.Collection<Form, string>, id: string) =>
  LiveQuery.make((q) => q.from({ form: form.tanstack }).where(({ form }) => Query.eq(form.id, id)).findOne())

/** The code this tab shows. */
export const codeQuery = (code: Collection.Collection<Code, string>, id: string) =>
  LiveQuery.make((q) => q.from({ code: code.tanstack }).where(({ code }) => Query.eq(code.id, id)).findOne())

/** Every unsent answer. */
export const answersQuery = (answers: Collection.Collection<AnswerRow, string>, tabId: string) =>
  LiveQuery.make((q) => q.from({ answer: answers.tanstack }).where(({ answer }) => Query.eq(answer.tabId, tabId)))

const answerKey = (row: AnswerRow): string => row.id

type Live<F extends (...args: never) => unknown> = Effect.Success<ReturnType<F>>

/** Your own flows' state for one tab. */
export class FlowsUiStore extends Context.Service<
  FlowsUiStore,
  {
    readonly flows: ElectricCollection.ElectricCollection<FlowRow>
    readonly drafts: ElectricCollection.ElectricCollection<Draft>
    readonly editorTabId: string
    readonly formId: string
    readonly codeId: string
    /** Distinguishes successive openings, including A → B → A in one tab. */
    readonly codeEpoch: { current: number }
    /** Whether the editors may write, as the page shows it; unavailable device storage disables them (`Editor`). */
    readonly editor: Collection.Collection<Editor, string>
    /**
     * Waits for the editors' rows to be restored and answers whether the editors may write. Unavailable device storage
     * disables them; retained rows are never overwritten.
     */
    readonly editorReady: Effect.Effect<boolean>
    readonly form: Collection.Collection<Form, string>
    readonly answers: Collection.Collection<AnswerRow, string>
    readonly shown: Collection.Collection<Shown, string>
    readonly code: Collection.Collection<Code, string>
    readonly round: Collection.Collection<RoundRun, string>
    readonly draft: Live<typeof draftQuery>
    readonly flowList: Live<typeof flowsQuery>
    readonly draftList: Live<typeof draftsQuery>
    readonly formRow: Live<typeof formQuery>
    readonly answerList: Live<typeof answersQuery>
    readonly codeRow: Live<typeof codeQuery>
    readonly editorRow: Live<typeof editorQuery>
    readonly roundRow: Live<typeof roundQuery>
    readonly confirmWithin: Duration.Input
    /** Reads the shown draft's round from this device's engine again. */
    readonly readRound: Effect.Effect<void>
    /**
     * What Draft again does after the draft's round `round`: start the first later round this device's engine holds
     * no run of, skipping rounds whose runs here failed or stopped; nothing when a later round started here is still
     * going or done but not delivered yet (`Pending`); or say the engine can't be read (`Unreadable`).
     */
    readonly nextRound: (draftId: string, round: number) => Effect.Effect<Following.NextRound>
  }
>()("@smthrs/mvp/flows/FlowsUiStore") {
  /**
   * The store over this tab's `BrowserEngine`; its collections cleaned up, its Electric shapes closed and its following
   * of the engine stopped when the scope closes.
   */
  static readonly layer = (config: FlowsUiConfig) =>
    Layer.effect(
      FlowsUiStore,
      Effect.gen(function* () {
        const engine = yield* BrowserEngine.BrowserEngine
        const storageAvailable = Option.isSome((yield* Persistence.Persistence).persistence)
        if (!storageAvailable) yield* Effect.logWarning("flows.editor.storage").pipe(
          Effect.annotateLogs({ collection: "device", outcome: "unavailable" }),
        )
        const editorTabId = config.editorTabId
        const formId = `${FORM}:${editorTabId}`
        const codeId = `${CODE}:${editorTabId}`
        const shape = (route: string) => ({
          url: `${config.origin}${route}`,
          columnMapper: ElectricCollection.snakeCamelMapper(),
          parser: {
            int4: (value: string) => Number(value),
            timestamptz: (value: string) => new Date(value).toISOString(),
          },
        })
        const flows = yield* ElectricCollection.make<FlowRow>({
          id: "flows",
          schema: FlowRow,
          getKey: (row) => row.id,
          syncMode: "eager",
          // 2: rows carry where the flow runs (`placement`).
          persist: { schemaVersion: 2 },
          shape: shape(FLOWS_SHAPE_ROUTE),
        })
        const drafts = yield* ElectricCollection.make<Draft>({
          id: "flow-drafts",
          schema: Draft,
          getKey: (row) => row.id,
          syncMode: "eager",
          persist: { schemaVersion: 1 },
          shape: shape(FLOW_DRAFTS_SHAPE_ROUTE),
        })
        const formSeed = (): Form => ({ id: formId, name: "", request: "", draftId: crypto.randomUUID(), seeded: false })
        const form = yield* Collection.persisted<Form, string>({
          id: "flow-form",
          schema: Form,
          getKey: (row) => row.id,
          schemaVersion: 1,
        })
        const answers = yield* Collection.persisted<AnswerRow, string>({
          id: "flow-answers",
          schema: AnswerRow,
          getKey: answerKey,
          schemaVersion: 1,
        })
        const codeSeed = (): Code => ({
          id: codeId, name: "", state: "loading", revision: 0, source: "", text: "", busy: false, refusal: null,
        })
        const code = yield* Collection.persisted<Code, string>({
          id: "flow-code",
          schema: Code,
          getKey: (row) => row.id,
          schemaVersion: 1,
        })
        // The editors' rows restore in the background, each with its own deadline, so the app renders without waiting
        // for them; the editors write only once all three are back.
        const usable = config.editorTabPersistent && storageAvailable
        const editor = yield* Collection.local<Editor, string>({
          id: "flow-editor",
          schema: Editor,
          getKey: (row) => row.id,
          initialData: [{ id: EDITOR, state: usable ? "restoring" : "unavailable" }],
        })
        const verdict = yield* Deferred.make<boolean>()
        const restore = Effect.gen(function* () {
          const [formReady, answersReady, codeReady] = yield* Effect.all([
            Effect.result(Effect.gen(function* () {
              yield* form.restored
              if (Option.isNone(yield* form.get(formId))) {
                yield* Effect.flatMap(form.insert(formSeed()), (write) => write.persisted)
              }
            }).pipe(Effect.timeout(EDITOR_RESTORE_WITHIN))),
            Effect.result(answers.restored.pipe(Effect.timeout(EDITOR_RESTORE_WITHIN))),
            Effect.result(Effect.gen(function* () {
              yield* code.restored
              if (Option.isNone(yield* code.get(codeId))) {
                yield* Effect.flatMap(code.insert(codeSeed()), (write) => write.persisted)
              }
            }).pipe(Effect.timeout(EDITOR_RESTORE_WITHIN))),
          ] as const, { concurrency: 3 })
          for (const [collection, ready] of [["flow-form", formReady], ["flow-answers", answersReady], ["flow-code", codeReady]] as const) {
            if (ready._tag === "Failure") {
              yield* Effect.logWarning("flows.editor.storage").pipe(Effect.annotateLogs({ collection, outcome: "failed" }))
            }
          }
          const available = formReady._tag === "Success" && answersReady._tag === "Success" && codeReady._tag === "Success"
          // A local collection refuses only a row its own schema rejects, which a state never is.
          yield* Effect.orDie(editor.update(EDITOR, (row) => void (row.state = available ? "available" : "unavailable")))
          yield* Deferred.succeed(verdict, available)
        })
        if (usable) yield* Effect.forkScoped(restore)
        else yield* Deferred.succeed(verdict, false)
        const shown = yield* Collection.local<Shown, string>({
          id: "flow-shown",
          schema: Shown,
          getKey: (row) => row.id,
          initialData: [{ id: SHOWN, draftId: null, refusal: null, busy: false }],
        })
        const round = yield* Collection.local<RoundRun, string>({
          id: "flow-round",
          schema: RoundRun,
          getKey: (row) => row.id,
          initialData: [{ id: ROUND, runId: null, status: "absent" }],
        })

        /** How this engine holds `runId`: its status, `absent` when it doesn't hold it, or none when it can't be read. */
        const statusOf = (runId: string) =>
          engine.inspect(runId, { limit: 1 }).pipe(
            Effect.map((inspection): Option.Option<RoundStatus> => Option.some(inspection.run.status)),
            Effect.catch((failure) => Effect.succeed(Following.refusedRead(failure))),
          )

        const readRound = Following.readRound({
          shownRunId: Effect.gen(function* () {
            const showing = Option.getOrThrow(yield* shown.get(SHOWN))
            const draft = showing.draftId === null ? Option.none() : yield* drafts.get(showing.draftId)
            return Option.match(draft, { onNone: () => null, onSome: (row) => roundExecutionId(row.id, row.round) })
          }),
          statusOf,
          write: (runId, status) =>
            Effect.asVoid(round.update(ROUND, (row) => {
              row.runId = runId
              row.status = status
            })).pipe(Effect.orDie),
        })

        const nextRound = (draftId: string, after: number) => Following.nextRound(statusOf, draftId, after)

        // Every batch of the engine's events for the shown draft, and every change of the drafts, reads the round again.
        yield* Stream.merge(
          engine.events.pipe(Stream.map((event) => event.executionId)),
          drafts.changes().pipe(Stream.as("")),
        ).pipe(
          Stream.groupedWithin(Number.MAX_SAFE_INTEGER, FOLLOW_EVERY),
          Stream.runForEach((ids) =>
            Effect.gen(function* () {
              const { draftId } = Option.getOrThrow(yield* shown.get(SHOWN))
              if (draftId === null) return
              if (ids.some((id) => id === "" || id.startsWith(`${draftId}:`))) yield* readRound
            })
          ),
          Effect.forkScoped,
        )

        return FlowsUiStore.of({
          flows,
          drafts,
          editorTabId,
          formId,
          codeId,
          codeEpoch: { current: 0 },
          editor,
          editorReady: Deferred.await(verdict),
          form,
          answers,
          shown,
          code,
          round,
          readRound,
          nextRound,
          draft: yield* draftQuery(shown, drafts),
          flowList: yield* flowsQuery(flows),
          draftList: yield* draftsQuery(drafts),
          formRow: yield* formQuery(form, formId),
          answerList: yield* answersQuery(answers, editorTabId),
          codeRow: yield* codeQuery(code, codeId),
          editorRow: yield* editorQuery(editor),
          roundRow: yield* roundQuery(round),
          confirmWithin: config.confirmWithin ?? Duration.seconds(15),
        })
      }),
    )
}

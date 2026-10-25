import { BrowserEngine } from "@smthrs/platform-browser"
import { Context, Effect, Metric, Option } from "effect"
import { type DispatchFailed, FlowDispatch } from "../../flows/dispatch"
import { RETRY_ID_SEARCH_LIMIT, retriedRunId, retryActId, runPath } from "./contract"
import { todoRetryPayload } from "./todoRun"
import { retriesOf } from "./page"
import type { Inspection, RepoName, RunTab, RunView } from "./schema"
import { VIEW } from "./schema"
import { RunsStore } from "./store"

// What a person does on runs (decision 0014 §2 and §5, docs/features/runs.md#acts): opening the list or a run, which
// read the engine; choosing a step or a tab, which only this tab sees; and Stop, Retry and Resume, which run the acts'
// flows through `FlowDispatch`, door `button`, the same declarations the agent calls. An act carries the journal
// sequence the page last read, so the engine refuses one on a run that moved since, and the page then reads it again.

/** Where this tab goes: the router's `navigate`, which the host gives. */
export class RunsNavigation extends Context.Service<RunsNavigation, {
  readonly navigate: (path: string) => void
  /** The host router's current path, when one is mounted. */
  readonly pathname?: () => string
}>()(
  "@smthrs/mvp/runs/RunsNavigation",
) {}

/** Sets fields of the view's one row. */
const setView = (fields: Partial<Omit<RunView, "id">>) =>
  Effect.flatMap(RunsStore, ({ view }) => view.update(VIEW, (draft) => void Object.assign(draft, fields))).pipe(
    Effect.asVoid,
    // The view's row always exists, and its schema takes every field set here: a refusal is a bug.
    Effect.orDie,
  )

/** Hovering the list's link reads it without changing the page. */
export const warmList = Effect.flatMap(RunsStore, (store) => store.warmList)

/**
 * The list's route loader: shows the list, reusing a warm unless the engine has changed, and reads the runs on
 * Cloudflare in the background. `open` is the run the list shows opened in place (`?open=`), read and followed live.
 */
export const openList = (open: string | null = null) => Effect.gen(function* () {
  const store = yield* RunsStore
  // The run page is left: an act still answering for it no longer moves or marks this tab.
  yield* setView({ listOpen: true, actToken: null, expanded: open })
  yield* store.loadCloud
  if (open !== null) yield* store.loadRun(open, null)
  yield* warmList
})

/**
 * The run route's `onLeave` for `runId`: once the tab no longer shows that run, an act still answering for it (a late
 * Retry) neither navigates nor marks the view, and the engine's events stop reading it. When another run's page opened
 * first (Retry opening its new run), that page stays.
 */
export const closeRun = (runId: string) =>
  Effect.gen(function* () {
    const view = Option.getOrThrow(yield* (yield* RunsStore).view.get(VIEW))
    if (view.runId === runId) yield* setView({ runId: null, acting: null, actToken: null, refusal: null })
  })

/**
 * A run's route entry: shows the frame and cached rows immediately; the store reads and follows it live. A
 * repository's run (`repo`, docs/features/actions.md) is read and followed there, with the runs it started.
 */
export const openRun = (runId: string, repo: RepoName | null = null) =>
  Effect.gen(function* () {
    const store = yield* RunsStore
    yield* store.beginRoute(runId)
    yield* setView({ runId, listOpen: false, expanded: null, selected: null, at: null, inspectorOpen: true, tab: "steps", acting: null, actToken: null, refusal: null, repo })
    if (repo !== null) yield* store.cloud(runId)
    yield* store.loadRun(runId, repo)
  })

/** Selects a step. */
export const select = (stepId: string) => setView({ selected: stepId })

/** Shows a tab. */
export const showTab = (tab: RunTab) => setView({ tab })

/** More: reads the open run's journal past what the page has. */
export const more = Effect.gen(function* () {
  const store = yield* RunsStore
  const view = Option.getOrThrow(yield* store.view.get(VIEW))
  if (view.runId !== null) yield* store.readMore(view.runId)
})

/** The open run as the page last read it, or none. */
const openInspection = Effect.gen(function* () {
  const store = yield* RunsStore
  const view = Option.getOrThrow(yield* store.view.get(VIEW))
  if (view.runId === null) return Option.none()
  const page = yield* store.pages.get(view.runId)
  return Option.flatMap(page, (page) => Option.fromNullishOr(page.inspection as Inspection | null))
})

type Act = "stop" | "retry" | "retry_from" | "resume"

/**
 * Runs `act` on the open run with `dispatch`, marking it in flight until its flow answers; a refusal's code stays on the
 * view (`refusal`). Then the run is read again.
 */
const acting = (
  act: Act,
  run: (inspection: Inspection, current: Effect.Effect<boolean, never, RunsStore>) => Effect.Effect<Option.Option<string>, DispatchFailed, FlowDispatch | RunsStore | RunsNavigation | BrowserEngine.BrowserEngine>,
) =>
  Effect.gen(function* () {
    const inspection = yield* openInspection
    if (Option.isNone(inspection)) return
    const runId = inspection.value.run.runId
    const token = crypto.randomUUID()
    const current = Effect.gen(function* () {
      const view = Option.getOrThrow(yield* (yield* RunsStore).view.get(VIEW))
      return view.runId === runId && view.actToken === token
    })
    // Installing the marker and its finalizer is one uninterruptible acquisition.
    yield* Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
      yield* setView({ acting: act, actToken: token, refusal: null })
      const refresh = yield* restore(Effect.gen(function* () {
        const refused = yield* run(inspection.value, current).pipe(
          Effect.catch((error) => Effect.succeed(Option.some(error.reason))),
        )
        if (!(yield* current)) return false
        yield* setView({ refusal: Option.getOrNull(refused) })
        return true
      })).pipe(Effect.ensuring(Effect.gen(function* () {
        if (yield* current) yield* setView({ acting: null, actToken: null })
      })))
      // A refresh publishes the result only after the act's finalizer released its indicator.
      if (refresh) yield* restore((yield* RunsStore).readRun(runId))
    }))
  })

/** What a dispatched act answers: nothing when it was done, its refusal's code when it was refused. */
const refusalOf = (dispatched: { readonly _tag: "Done" } | { readonly _tag: "Failed"; readonly error: { readonly code: string } | { readonly _tag: string } }) =>
  dispatched._tag === "Done" ? Option.none() : Option.some("code" in dispatched.error ? dispatched.error.code : "unavailable")

/** Stop: `run/cancel` on the open run; on Cloudflare for a repository's run. */
export const stop = acting("stop", (inspection) =>
  Effect.gen(function* () {
    const view = Option.getOrThrow(yield* (yield* RunsStore).view.get(VIEW))
    const payload = { runId: inspection.run.runId, seq: inspection.run.lastSeq }
    return yield* (yield* FlowDispatch).dispatch(
      "run/cancel",
      view.repo == null ? payload : { ...payload, host: "cloud" as const },
      { door: "button" },
    )
  }).pipe(Effect.map(refusalOf)))

/** Resume: `run/resume` on the open run. */
export const resume = acting("resume", (inspection) =>
  Effect.flatMap(FlowDispatch, (flows) =>
    flows.dispatch("run/resume", { runId: inspection.run.runId, seq: inspection.run.lastSeq }, { door: "button" })).pipe(
      Effect.map(refusalOf),
    ))

/**
 * The next unused `retry:<runId>:<n>`, checked against durable history beyond the bounded list: Retry and Retry from
 * here number one run's retries together. Answers the act's id, or why none could be chosen.
 */
const nextRetryAct = (
  runId: string,
): Effect.Effect<{ readonly actId: string } | { readonly refusal: string }, never, RunsStore | BrowserEngine.BrowserEngine> =>
  Effect.gen(function* () {
    const store = yield* RunsStore
    // The list holds this device's earlier retries of the run: read it now, so the act is the next one.
    yield* store.readList
    const engine = yield* BrowserEngine.BrowserEngine
    let n = retriesOf(yield* store.runs.toArray, runId) + 1
    // The list is bounded; existence in the durable engine decides which identity is unused.
    for (let checked = 0; ; checked++, n++) {
      if (checked === RETRY_ID_SEARCH_LIMIT) return { refusal: "refused" } as const
      const actId = retryActId(runId, n)
      let reserved = false
      // A refused or interrupted act may exist without ever having created its child.
      for (const id of [retriedRunId(actId), actId]) {
        const existing = yield* Effect.result(engine.inspect(id, { limit: 1 }))
        if (existing._tag === "Success") { reserved = true; break }
        if (!(existing.failure instanceof BrowserEngine.RequestRefused) || existing.failure.error !== "@smthrs/engine-store/RunNotFound") {
          return { refusal: "unavailable" } as const
        }
      }
      if (!reserved) return { actId } as const
    }
  })

/** Opens a retry's new run, while this view still owns the act that started it. */
const openRetried = (runId: string, current: Effect.Effect<boolean, never, RunsStore>) =>
  Effect.gen(function* () {
    yield* (yield* RunsStore).readList
    if (yield* current) (yield* RunsNavigation).navigate(runPath(runId))
  })

/**
 * Retry: `run/retry` as the next unused `retry:<runId>:<n>`. Its new run opens only while this view still owns the
 * originating act.
 */
export const retry = (version: "pinned" | "current") =>
  acting("retry", (inspection, current) =>
    Effect.gen(function* () {
      const runId = inspection.run.runId
      if (inspection.run.flowName === "todo") {
        const payload = todoRetryPayload(inspection.run.input)
        if (payload === undefined) return Option.some("not_retryable")
        return refusalOf(yield* (yield* FlowDispatch).dispatch("todo/Retry", payload, { door: "button" }))
      }
      const act = yield* nextRetryAct(runId)
      if ("refusal" in act) return Option.some(act.refusal)
      const dispatched = yield* (yield* FlowDispatch).dispatch("run/retry", { runId, version }, {
        door: "button",
        executionId: act.actId,
      })
      if (dispatched._tag === "Failed") return Option.some(dispatched.error.code)
      yield* openRetried(dispatched.value.runId, current)
      return Option.none()
    }))

/**
 * Retry from here (ruling FLOW-11): `run/retry/from` on the open run from its step `step` (the engine's node id), as the
 * next unused `retry:<runId>:<n>`. Its new run opens only while this view still owns the act.
 */
export const retryFrom = (step: string) =>
  acting("retry_from", (inspection, current) =>
    Effect.gen(function* () {
      const runId = inspection.run.runId
      const act = yield* nextRetryAct(runId)
      if ("refusal" in act) return Option.some(act.refusal)
      const dispatched = yield* (yield* FlowDispatch).dispatch("run/retry/from", { runId, step }, {
        door: "button",
        executionId: act.actId,
      })
      if (dispatched._tag === "Failed") return Option.some(dispatched.error.code)
      yield* openRetried(dispatched.value.runId, current)
      return Option.none()
    }))

/** Read-only replay position and inspector visibility, local to this tab. */
export const replaySelections = Metric.counter("smithers_run_replay_selections", { description: "Read-only journal selections", incremental: true })
export const scrub = (at: number | null) => Effect.gen(function* () {
  yield* setView({ at })
  if (at === null) {
    const store = yield* RunsStore
    const current = Option.getOrThrow(yield* store.view.get(VIEW))
    if (current.runId !== null) yield* store.readRun(current.runId)
  }
  yield* Metric.update(Metric.withAttributes(replaySelections, { mode: at === null ? "live" : "replay" }), 1)
  yield* Effect.logDebug("run.replay.selected").pipe(Effect.annotateLogs({ mode: at === null ? "live" : "replay", sequence: at }))
}).pipe(Effect.withSpan("run.replay.select"))
export const inspectStep = (stepId: string) => setView({ selected: stepId, inspectorOpen: true })
export const showInspector = (inspectorOpen: boolean) => setView({ inspectorOpen })

/**
 * What a steer that couldn't be queued leaves in the view: `unavailable`, and its words back in the composer only while
 * the view shows the run it was for and nothing new was typed there.
 */
export const afterFailedSteer = (latest: RunView, runId: string | null, body: string): Partial<Omit<RunView, "id">> =>
  latest.runId === runId && (latest.steerDraft ?? "") === "" ? { steerDraft: body, refusal: "unavailable" } : { refusal: "unavailable" }

/** What the steer composer holds, as a person types (docs/features/runs.md#steering). */
export const setSteerDraft = (text: string) => setView({ steerDraft: text })

/**
 * Steer: `run/steer` on the open run with the composer's message, door `composer`. The composer empties at once; the
 * message shows Sending from the outbox until the route answers. A run that couldn't queue it says `unavailable`, and
 * gives the words back to the composer only while the page still shows that run and nothing new was typed there.
 */
export const steer = Effect.gen(function* () {
  const store = yield* RunsStore
  const current = Option.getOrThrow(yield* store.view.get(VIEW))
  const body = (current.steerDraft ?? "").trim()
  if (current.runId === null || body === "") return
  yield* setView({ steerDraft: "", refusal: null })
  const dispatched = yield* (yield* FlowDispatch).dispatch("run/steer", { runId: current.runId, body }, { door: "composer" })
    .pipe(Effect.result)
  if (dispatched._tag === "Failure" || dispatched.success._tag === "Failed") {
    yield* setView(afterFailedSteer(Option.getOrThrow(yield* store.view.get(VIEW)), current.runId, body))
  }
})

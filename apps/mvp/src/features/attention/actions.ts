import type { Inbox } from "@smthrs/notifications"
import { Deferred, Effect, Exit, Metric, Option } from "effect"
import { type DispatchFailed, FlowDispatch } from "../../flows/dispatch"
import { retryAnswer } from "../chat/actions"
import { focus } from "../status/actions"
import type { PanelVia, Surface } from "./contract"
import { panel as panelActs } from "./metrics"
import { newestNeed } from "./entries"
import { PANEL, type Panel } from "./schema"
import { AttentionNavigation, AttentionStore } from "./store"

// What a person does with the feed (decision 0009 decision 10): open an entry, hide a toast, dismiss an entry, mark one
// read, and use the notifications panel: open it, expand an entry in it, answer or retry from it. Read, Hide and
// Dismiss show on this device straight away, kept on the device until the synced row shows them, and run on as
// `notification/ack` (door `button`), one run per press. An act that can't land (the engine refused it, or ChatApi did,
// or it went unsent for a day) leaves the device too, so the entry shows as it is and the person can act again; ChatApi
// merges an act with `greatest()`, so an act sent twice changes nothing. The panel is this tab's own.

/** Acts this device took back because they couldn't land, by `act` and `reason`: the failure's tag. */
export const dropped = Metric.counter("smithers_notification_acts_dropped", {
  description: "Read, Dismiss and Hide this device took back because they couldn't land, by act and reason",
  incremental: true,
})

/**
 * Runs `notification/ack` for the act this device holds as pending row `id`, at `version`, in the store's scope, as a
 * run of its own: a press after one that couldn't land runs again rather than joining the run that failed. When it
 * can't land, the pending row goes, unless a later act replaced it; a log line `notifications.pending` and a count of
 * `dropped` say so.
 */
const send = (id: string, request: { readonly subject: string; readonly version: number; readonly act: Inbox.Act }) =>
  Effect.gen(function* () {
    const { pending, scope } = yield* AttentionStore
    const flows = yield* FlowDispatch
    const drop = (reason: string) =>
      Effect.gen(function* () {
        const held = Option.filter(yield* pending.get(id), (row) => row.version === request.version)
        yield* Effect.forEach(Option.toArray(held), () =>
          Effect.gen(function* () {
            yield* pending.delete(id)
            yield* Metric.update(Metric.withAttributes(dropped, { act: request.act, reason }), 1)
            yield* Effect.logWarning("notifications.pending").pipe(
              Effect.annotateLogs({ ...request, outcome: "dropped", reason }),
            )
          }))
      }).pipe(Effect.orDie)
    yield* flows.dispatch("notification/ack", request, { door: "button" }).pipe(
      Effect.flatMap((done) => (done._tag === "Done" ? Effect.void : Effect.fail(done.error))),
      Effect.catch((error) => drop(error._tag)),
      Effect.forkIn(scope),
    )
  })

/** Records `act` on entry `subject` at the version this tab shows: at once here, then through ChatApi. */
const record = (subject: string, act: Inbox.Act) =>
  Effect.gen(function* () {
    const { entries, pending } = yield* AttentionStore
    const entry = yield* entries.get(subject)
    if (Option.isNone(entry)) return entry
    const { version } = entry.value
    const id = `${subject}:${act}`
    const held = yield* pending.get(id)
    if (Option.isSome(held) && held.value.version >= version) return entry
    if (Option.isSome(held)) yield* pending.update(id, (draft) => void (draft.version = version))
    else yield* pending.insert({ id, subject, act, version })
    yield* send(id, { subject, version, act })
    return entry
  }).pipe(
    // A local collection refuses only a row its own schema rejects, which these never are: a bug, not a state.
    Effect.orDie,
  )

/** Hides entry `subject`'s toast: on every device, and it stays in the person's list. */
export const hide = (subject: string) => Effect.asVoid(record(subject, "hide"))

/** Dismisses entry `subject`: it leaves the person's list on every device. */
export const dismiss = (subject: string) => Effect.asVoid(record(subject, "dismiss"))

/** Marks entry `subject` read on every device, if it is unread. */
export const read = (subject: string) =>
  Effect.gen(function* () {
    const { entries } = yield* AttentionStore
    const entry = yield* entries.get(subject)
    if (Option.isSome(entry) && entry.value.unread) yield* record(subject, "read")
  })

/** The panel's row now. */
const panelNow = Effect.gen(function* () {
  const { panel } = yield* AttentionStore
  // The panel's one row is always there.
  return Option.getOrThrow(yield* panel.get(PANEL))
})

/** Changes the panel's row. */
const setPanel = (change: Partial<Omit<Panel, "id">>) =>
  Effect.gen(function* () {
    const { panel } = yield* AttentionStore
    yield* panel.update(PANEL, (draft) => void Object.assign(draft, change))
  }).pipe(
    // The panel's one row is always there, and these changes keep its shape: a refusal is a bug, not a state.
    Effect.orDie,
  )

/** Records what the person did in the panel: a log line and a count, with the entry's subject and never its words. */
const recorded = (
  act: "open" | "expand" | "retry",
  fields: {
    readonly via?: PanelVia
    readonly subject?: string
    readonly outcome?: "started" | "failed"
    readonly reason?: DispatchFailed["reason"]
  },
) =>
  Effect.gen(function* () {
    yield* Metric.update(Metric.withAttributes(panelActs, {
      act,
      ...(fields.via === undefined ? {} : { via: fields.via }),
      ...(fields.outcome === undefined ? {} : { outcome: fields.outcome }),
    }), 1)
    // A retry the engine didn't admit is a failure, by dispatch's reason; every other act is Info.
    yield* (fields.outcome === "failed" ? Effect.logWarning : Effect.logInfo)("notifications.panel").pipe(
      Effect.annotateLogs({ feature: "attention", act, ...fields }),
    )
  })

/**
 * Opens the notifications panel (`via`), at entry `subject`: that entry expanded, taking focus, and read. Without one,
 * at the newest run waiting on the person, so one more press reaches it; with none, the first entry takes focus.
 */
export const openPanel = (via: PanelVia, subject: string | null = null) =>
  Effect.gen(function* () {
    const { entries } = yield* AttentionStore
    const at = subject ?? newestNeed(yield* entries.toArray)
    yield* setPanel(at === null ? { open: true, focus: null } : { open: true, focus: at, expanded: at, answer: 0 })
    if (at !== null) yield* read(at)
    yield* recorded("open", at === null ? { via } : { via, subject: at })
  })

/** Closes the notifications panel. */
export const closePanel = setPanel({ open: false, focus: null })

/** Opens the panel when it is closed, and closes it when it is open: the bell and Alt+N. */
export const togglePanel = (via: PanelVia) =>
  Effect.gen(function* () {
    if ((yield* panelNow).open) yield* closePanel
    else yield* openPanel(via)
  })

/** Expands entry `subject` in the panel, or collapses it when it is the one expanded. Expanding it reads it. */
export const expand = (subject: string) =>
  Effect.gen(function* () {
    const now = yield* panelNow
    // A field asked to take focus before stays where it is: only A asks again.
    if (now.expanded === subject) {
      yield* setPanel({ expanded: null, answer: 0 })
      return
    }
    yield* setPanel({ expanded: subject, answer: 0 })
    yield* read(subject)
    yield* recorded("expand", { subject })
  })

/**
 * Opens entry `subject` from `surface`: records Read, closes the panel, then brings the person to it. The person's own
 * open question, on the conversation it was asked in, takes focus there; a question elsewhere takes focus once its card
 * shows. Any other run opens its conversation at its answer (`#<run id>`); `main` and a release open their page.
 */
export const open = (subject: string, _surface: Surface) =>
  Effect.gen(function* () {
    const entry = yield* record(subject, "read")
    if (Option.isNone(entry)) return
    const { action, runId, href } = entry.value
    if ((yield* panelNow).open) yield* closePanel
    // Its run is the answer it asks about: the question's card takes focus where it shows.
    if (action === "answer" && runId !== null) {
      (yield* AttentionNavigation).navigate(`${href}#${runId}`)
      yield* focus(runId)
      return
    }
    (yield* AttentionNavigation).navigate(runId === null ? href : `${href}#${runId}`)
  })

/**
 * A on entry `subject`: in the panel, its question's field takes focus there, the entry expanded; on a toast, as its
 * Answer. An entry with no question of the person's to answer does nothing.
 */
export const answer = (subject: string, surface: Surface | "panel") =>
  Effect.gen(function* () {
    const { entries } = yield* AttentionStore
    const entry = yield* entries.get(subject)
    if (Option.isNone(entry) || entry.value.action !== "answer") return
    if (surface !== "panel") return yield* open(subject, surface)
    const now = yield* panelNow
    yield* setPanel({ expanded: subject, answer: now.answer + 1 })
    yield* read(subject)
  })

/**
 * Retry on the person's failed run in the conversation the tab shows: asks its question again, there, and dismisses the
 * entry, whose run the new one replaces. On the person's failed clone, Try again: runs `repo/clone` for its repository
 * again, door `button`, whose new attempt raises the entry again. Anything else does nothing.
 */
export const retry = (subject: string) =>
  Effect.gen(function* () {
    const { entries, details, scope } = yield* AttentionStore
    const entry = yield* entries.get(subject)
    if (Option.isSome(entry) && entry.value.action === "retry") {
      // The clone's new attempt raises the entry again once RepoApi takes it; the press returns at once.
      const flows = yield* FlowDispatch
      yield* Effect.gen(function* () {
        const admitted = yield* Deferred.make<void, DispatchFailed>()
        yield* flows.dispatch("repo/clone", { repo: entry.value.href.slice(1) }, { door: "button", admitted }).pipe(
          // Also release the admission waiter if dispatch fails before it can return a start receipt.
          Effect.onExit((exit) => Exit.isFailure(exit) ? Deferred.failCause(admitted, exit.cause) : Effect.void),
          Effect.ignore,
          Effect.forkIn(scope),
        )
        const started = yield* Effect.result(Deferred.await(admitted))
        yield* recorded("retry", started._tag === "Success"
          ? { subject, outcome: "started" }
          : { subject, outcome: "failed", reason: started.failure.reason })
      }).pipe(Effect.forkIn(scope))
      return
    }
    const detail = yield* details.get(subject)
    const runId = Option.isSome(entry) && Option.isSome(detail) && detail.value.retry ? entry.value.runId : null
    if (runId === null) return
    yield* retryAnswer(runId)
    yield* dismiss(subject)
    yield* recorded("retry", { subject })
  })

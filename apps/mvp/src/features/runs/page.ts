import { Journal } from "@smthrs/flows"
import { NotificationEvent, SteerPayload } from "@smthrs/notifications"
import type { AttemptRow, JsonValueData, JournalRow, RunRow as UiRunRow, StepRow, WaitData } from "@smthrs/ui"
import { Option, Schema } from "effect"
import {
  CLOUD,
  COULDNT_READ,
  isRemoteRun,
  listed,
  NOT_FOUND,
  NOT_STARTED,
  ON_ANOTHER_DEVICE,
  runPath,
  settled,
  steerable,
  STEERED_ACTION,
  type SteerRefusal,
  THIS_DEVICE,
} from "./contract"
import { branchWords } from "./words"
import { retryable } from "./retry"
import { failedTodoRun, hasDomainOutcome, todoRetryPayload } from "./todoRun"
import { ACTIONS_LIMIT, actionRunPath } from "../actions/contract"
import { isoOf } from "../pulls/view"
import { repoId } from "../repo/contract"
import type { CloudRun, Inspection, RepoRunRow, RepoRunsLoaded, RunPage, RunRow, RunView, SteerSending, SteerSent } from "./schema"

// A run's page as a frontend draws it (decision 0014 §5, docs/features/runs.md#the-run-page): pure functions from the
// engine's read of a run to `@smthrs/ui`'s run-page rows. The steps are the plan's action calls and child boundaries,
// and the runs this run started: an agent's cell calls and a person's flow's pinned child, whose input and result are
// that step's input and output. The engine doesn't record an action's input, so only a child's step has one.

/** One step of the page: its row, and what its detail shows. */
export interface PageStep {
  readonly logs: ReadonlyArray<JsonValueData>
  readonly row: StepRow
  readonly input: JsonValueData | null
  readonly output: JsonValueData | null
  readonly attempts: ReadonlyArray<AttemptRow>
  readonly wait: WaitData | null
  /** A child run's own page. */
  readonly href: string | null
  /** The engine's address of a plan step: the run that holds it and its node id. */
  readonly node?: { readonly runId: string; readonly nodeId: string }
}

/** The step a page shows the detail of: the selected one, else the first failure, live work, then the latest. */
export const selectedStep = (steps: ReadonlyArray<PageStep>, selected: string | null): PageStep | undefined =>
  steps.find((step) => step.row.id === selected) ?? steps.find((step) => step.row.state === "failed") ?? steps.find((step) => step.row.state === "running" || step.row.state === "waiting") ?? [...steps].reverse().find((step) => step.row.state !== "pending") ?? steps[0]

/** The journal's rows: the first page and every page More read after it. */
export const journalOf = (page: RunPage): ReadonlyArray<JournalRow> => {
  const inspection = page.inspection as Inspection
  return [...inspection.journal.events, ...(page.more as ReadonlyArray<JournalRow>)].map((event) => ({
    seq: event.seq,
    eventType: event.eventType,
    emittedAtMs: event.emittedAtMs,
    payload: event.payload,
  }))
}

/** How long a running run may record nothing before the page offers Resume: it may have no host driving it. */
export const STALLED_AFTER_MS = 60_000

/**
 * Which acts the page offers on a run at `now`: Stop while it hasn't settled and no stop was asked; Retry once it
 * settled, when its flow is retried; Resume while it waits, or runs but has recorded nothing for `STALLED_AFTER_MS`.
 * A Cloudflare TODO offers Retry through todo/Retry, which allocates its attempt through the stack writer.
 * Stop and Resume remain local-engine acts; a remote TODO stops when its TODO drops.
 */
export const actsOf = (
  inspection: Inspection,
  now: number,
  events: ReadonlyArray<Pick<JournalRow, "emittedAtMs">> = inspection.journal.events,
  cloud = false,
) => {
  const { run } = inspection
  // A repository's run stops on Cloudflare (docs/features/actions.md#acts), and its jobs with it; a TODO's stops when its
  // TODO is dropped.
  if (cloud) {
    return {
      stop: run.parentRunId === null && !settled(run.status) && run.cancelRequestedAtMs === null,
      retry: false,
      resume: false,
    }
  }
  if (isRemoteRun(run.runId)) return { stop: false, retry: failedTodoRun(run) && todoRetryPayload(run.input) !== undefined, resume: false }
  const last = events.at(-1)?.emittedAtMs ?? run.createdAtMs
  return {
    stop: !settled(run.status) && run.cancelRequestedAtMs === null,
    retry: settled(run.status) && retryable(run.flowName),
    resume: run.status === "suspended" || (run.status === "running" && now - last >= STALLED_AFTER_MS),
  }
}

/**
 * The steps of a run that offer Retry from here (ruling FLOW-11), by node id: on a settled run of this device whose flow
 * is retried, an action or a child boundary of the run itself that completed or failed, once another of its steps
 * completed before it began. A step with nothing before it would replay nothing: that is Retry, in the header. A run on
 * Cloudflare offers none.
 *
 * An action began with its first attempt; a boundary when its child run was created. The engine schedules a node before
 * the nodes it waits on, so its scheduling says nothing about when its own work began.
 */
export const retriesFrom = (inspection: Inspection, cloud = false): ReadonlySet<string> => {
  const { run } = inspection
  if (cloud || isRemoteRun(run.runId) || !settled(run.status) || !retryable(run.flowName)) return new Set()
  const children = new Set(inspection.children.map((child) => child.flowName))
  const steps = inspection.steps.filter((step) =>
    step.kind === "ActionCall" || (step.kind === "FlowCall" && step.action !== null && children.has(step.action))
  )
  const began = (step: Inspection["steps"][number]) =>
    step.attempts[0]?.startedAtMs ??
      Math.min(
        ...inspection.children
          .filter((child) => child.flowName === step.action && child.createdAtMs >= step.scheduledAtMs)
          .map((child) => child.createdAtMs),
      )
  return new Set(
    steps.filter((step) =>
      (step.status === "completed" || step.status === "failed") &&
      steps.some((other) => other !== step && other.status === "completed" && other.settledAtMs !== null && other.settledAtMs <= began(step))
    ).map((step) => step.nodeId),
  )
}

/** Where a run runs, as its header says: this device, or Cloudflare (a TODO's run, or a repository's: `cloud`). */
export const hostOf = (runId: string, cloud = false): string => (cloud || isRemoteRun(runId) ? CLOUD : THIS_DEVICE)

/** What a page says when it has no run to show, by why. */
export const missingOf = (page: Pick<RunPage, "id" | "state">, cloud = false): string =>
  page.state === "not_started"
    ? NOT_STARTED
    : page.state === "not_found"
    ? cloud || isRemoteRun(page.id) ? NOT_FOUND : ON_ANOTHER_DEVICE
    : COULDNT_READ

/** A retry's new run: `retry:<runId>:<n>/run` (`retriedRunId`). */
const RETRIED = /^retry:.+:\d+\/run$/

/** What started a run on this device, as the list's Trigger column reads it: the door the engine kept. */
export const deviceTrigger = (run: Pick<RunRow, "id" | "origin">): string | undefined =>
  RETRIED.test(run.id) ? "retry" : run.origin == null || run.origin.door === "unknown" ? undefined : run.origin.door

/** Who started a run on this device: the person on it, their agent, or the app. */
export const deviceActor = (run: Pick<RunRow, "origin">): string | undefined =>
  run.origin?.actor === "person" ? "you" : run.origin?.actor === "agent" ? "agent" : run.origin?.actor === "app" ? "app" : undefined

/** What started a run on Cloudflare, in the list's words. */
export const cloudTrigger = (trigger: CloudRun["trigger"]): string => trigger === "pull_request" ? "pull request" : trigger

/** Where a run on Cloudflare opens: a repository's run under its repository, every other on the Runs page. */
export const cloudHref = (run: Pick<CloudRun, "runId" | "kind" | "repo">): string => {
  if (run.kind === "repo" && run.repo !== null) {
    const [owner, name] = run.repo.split("/") as [string, string]
    return actionRunPath(owner, name, run.runId)
  }
  return runPath(run.runId)
}

/** A run on Cloudflare as a row of this device's run index reads, for the flows summary. */
export const cloudRowOf = (run: CloudRun): RunRow => ({
  id: run.runId,
  flow: run.flow,
  status: run.status,
  cancelRequested: run.cancelRequested,
  createdAtMs: run.createdAtMs,
  startedAtMs: run.startedAtMs,
  finishedAtMs: run.finishedAtMs,
  seq: -1,
})

/** What the Runs page's address says: one flow's runs (`flow`), and the run opened in place (`open`). */
export interface ListView {
  readonly flow?: string
  readonly open?: string
}

/**
 * Whether the Runs page may say it has no runs: this device's list and the runs on Cloudflare have each answered once.
 * Until then a list of none shows nothing, as a repository's list does (`repoRunsLoaded`).
 */
export const listLoaded = (view: Pick<RunView, "listLoaded" | "cloudLoaded"> | undefined): boolean =>
  view?.listLoaded === true && view.cloudLoaded === true

/** Reads the Runs page's address (the route's `validateSearch`), keeping only a flow and a run that could name one. */
export const runsSearch = (search: Record<string, unknown>): ListView => ({
  ...(typeof search.flow === "string" && search.flow !== "" && search.flow.length <= 256 ? { flow: search.flow } : {}),
  ...(typeof search.open === "string" && search.open !== "" && search.open.length <= 512 ? { open: search.open } : {}),
})

/** The Runs page's address for `view`. */
export const listHref = (view: ListView): string => {
  const query = new URLSearchParams()
  if (view.flow !== undefined) query.set("flow", view.flow)
  if (view.open !== undefined) query.set("open", view.open)
  return query.size === 0 ? "/app/runs" : `/app/runs?${query}`
}

/**
 * The runs a person's list shows, newest first, like a CI system's runs: this device's work (never an act on a run)
 * and the runs on Cloudflare they may read, each with what started it, its branch and who started it, filtered to
 * `view.flow`, and each with a toggle that opens it in place (`view.open`).
 */
export const listRows = (
  runs: ReadonlyArray<RunRow>,
  cloud: ReadonlyArray<CloudRun> = [],
  view: ListView = {},
): ReadonlyArray<UiRunRow> => {
  const device = runs.filter((run) => listed(run.flow)).map((run) => ({
    createdAtMs: run.createdAtMs,
    row: {
      id: run.id,
      flow: run.flow,
      state: run.status === "completed" && hasDomainOutcome(run.flow) && run.outcome === "failed" ? "failed" as const : run.status,
      cancelRequested: run.cancelRequested,
      startedAtMs: run.startedAtMs ?? run.createdAtMs,
      finishedAtMs: run.finishedAtMs,
      href: runPath(run.id),
      ...(deviceTrigger(run) === undefined ? {} : { trigger: deviceTrigger(run)! }),
      branch: null,
      ...(deviceActor(run) === undefined ? {} : { actor: deviceActor(run)! }),
    } satisfies UiRunRow,
  }))
  const remote = cloud.map((run) => ({
    createdAtMs: run.createdAtMs,
    row: {
      id: run.runId,
      flow: run.flow,
      state: run.status,
      cancelRequested: run.cancelRequested,
      startedAtMs: run.startedAtMs ?? run.createdAtMs,
      finishedAtMs: run.finishedAtMs,
      href: cloudHref(run),
      trigger: cloudTrigger(run.trigger),
      branch: run.branch === null ? null : branchWords(run.branch),
      actor: run.actor,
    } satisfies UiRunRow,
  }))
  const flow = view.flow
  return [...device, ...remote]
    .filter(({ row }) => flow === undefined || row.flow === flow)
    .sort((left, right) => right.createdAtMs - left.createdAtMs)
    .map(({ row }) => {
      const expanded = view.open === row.id
      return {
        ...row,
        expanded,
        toggleHref: listHref({ ...(flow === undefined ? {} : { flow }), ...(expanded ? {} : { open: row.id }) }),
      }
    })
}

/**
 * How many times `runId` was retried from this device: each Retry and Retry from here is one act, `retry:<runId>:<n>`,
 * numbered together.
 */
export const retriesOf = (runs: ReadonlyArray<RunRow>, runId: string): number =>
  runs.filter((run) => (run.flow === "run/retry" || run.flow === "run/retry/from") && run.id.startsWith(`retry:${runId}:`)).length

/**
 * A steer's state on the run page (docs/features/runs.md#steering): in the outbox (`sending`), taken by the route or in
 * the run's queue (`sent`), read by the agent (`delivered`: its queue handed it to a turn, and that turn acted), never
 * read because the agent ended first (`not_delivered`), or refused for good (`not_sent`).
 */
export type SteerState = "sending" | "sent" | "delivered" | "not_delivered" | "not_sent"

/** One message to a run's agent, as its page lists it. */
export interface SteerItem {
  readonly id: string
  readonly body: string
  /** Who sent it, by login, when the run's journal says. */
  readonly by: string | null
  readonly state: SteerState
  readonly reason: SteerRefusal | null
  /** When it was queued on this device, or admitted to the run. */
  readonly atMs: number
  /** When the agent read it. */
  readonly deliveredAtMs: number | null
}

const decodeAdmitted = Schema.decodeUnknownOption(NotificationEvent.Admitted)
const decodePromoted = Schema.decodeUnknownOption(NotificationEvent.Promoted)

/** A journal event's payload as JSON, or none when it was cut or isn't JSON. */
const payloadOf = (event: { readonly payload: { readonly text: string; readonly clipped: boolean } }): unknown => {
  if (event.payload.clipped) return undefined
  try {
    return JSON.parse(event.payload.text)
    // expected: a payload that isn't JSON shows as none
  } catch {
    return undefined
  }
}

/** Whether a run on this page still has an agent to steer: a TODO's run, before it or its agent's step ends. */
export const steerOpen = (inspection: Inspection): boolean =>
  isRemoteRun(inspection.run.runId) && steerable(inspection.run, inspection.steps)

/**
 * The messages to a run's agent, oldest first: those the run's journal holds (the notification queue's admissions, and
 * its promotions, when a boundary handed them to the agent's next turn), and this device's own that the journal doesn't
 * show yet, from the outbox (`sending`) and the route's answers (`sent`). A promotion alone is no proof the agent read
 * it: the run may stop before that turn. A message is Delivered once the agent acted after its promotion, a cell call
 * the journal records (`Journal.CallFact`) or its step's answer.
 */
export const steersOf = (
  page: RunPage,
  sending: ReadonlyArray<SteerSending>,
  sent: ReadonlyArray<SteerSent>,
): ReadonlyArray<SteerItem> => {
  const inspection = page.inspection as Inspection | null
  if (inspection === null) return []
  const runId = inspection.run.runId
  const events = [...inspection.journal.events, ...(page.more as Inspection["journal"]["events"])]
  const promotions = new Map<string, { readonly seq: number; readonly at: number }>()
  let lastAct = -1
  const admitted: Array<SteerItem> = []
  for (const event of events) {
    if (event.eventType === Journal.CallFact.eventType) {
      lastAct = Math.max(lastAct, event.seq)
    } else if (event.eventType === NotificationEvent.PromotedEventType) {
      const promoted = decodePromoted(payloadOf(event))
      if (Option.isSome(promoted) && promoted.value.targetLineageId === runId) {
        for (const id of promoted.value.ids) {
          if (!promotions.has(id)) promotions.set(id, { seq: event.seq, at: event.emittedAtMs })
        }
      }
    } else if (event.eventType === NotificationEvent.AdmittedEventType) {
      const decoded = decodeAdmitted(payloadOf(event))
      if (Option.isNone(decoded) || decoded.value.notification._tag !== "human-steer") continue
      const notification = decoded.value.notification
      const item = SteerPayload.decode(notification)
      admitted.push({
        id: notification.id,
        body: item?.kind === "Message" ? item.body : "",
        by: notification.provenance.attribution?.["login"] ?? null,
        state: "sent",
        reason: null,
        atMs: event.emittedAtMs,
        deliveredAtMs: null,
      })
    }
  }
  const open = steerable(inspection.run, inspection.steps)
  const answeredAt = inspection.steps.find((step) => step.action === STEERED_ACTION && step.status === "completed")
    ?.settledAtMs ?? null
  const journaled = admitted.map((item): SteerItem => {
    const promoted = promotions.get(item.id)
    const read = promoted !== undefined && (lastAct > promoted.seq || (answeredAt !== null && answeredAt >= promoted.at))
    return read
      ? { ...item, state: "delivered", deliveredAtMs: promoted.at }
      : { ...item, state: open ? "sent" : "not_delivered" }
  })
  const known = new Set(journaled.map((item) => item.id))
  const local: Array<SteerItem> = [
    ...sent.filter((row) => row.runId === runId && !known.has(row.id)).map((row): SteerItem => ({
      id: row.id,
      body: row.body,
      by: null,
      state: row.status === "sent" ? (open ? "sent" : "not_delivered") : "not_sent",
      reason: row.reason,
      atMs: row.queuedAt,
      deliveredAtMs: null,
    })),
    ...sending.filter((row) => row.runId === runId && !known.has(row.id) && !sent.some((answered) => answered.id === row.id))
      .map((row): SteerItem => ({
        id: row.id,
        body: row.body,
        by: null,
        state: "sending",
        reason: null,
        atMs: row.queuedAt,
        deliveredAtMs: null,
      })),
  ]
  return [...journaled, ...local].sort((left, right) => left.atMs - right.atMs)
}

/** The agent's first step that began at or after a steer was delivered: its response, or none yet. */
export const responseStep = (steps: ReadonlyArray<PageStep>, deliveredAtMs: number): string | null =>
  [...steps].filter((step) => step.row.startedAtMs >= deliveredAtMs).sort((left, right) =>
    left.row.startedAtMs - right.row.startedAtMs
  )[0]?.row.id ?? null

/** A repository run's state, as `RunList` draws it, from its row's status. */
export const repoRunStateOf = (status: string) =>
  status === "done"
    ? "completed" as const
    : status === "failed"
    ? "failed" as const
    : status === "stopped"
    ? "cancelled" as const
    : "running" as const

/**
 * `/$owner/$repo/actions`: the repository's runs, newest first, at most `ACTIONS_LIMIT`, each named by its flow and
 * ref and opening its run page (docs/features/actions.md).
 */
/** Whether this tab has loaded `owner/name`'s runs, so an empty list means the repository has none. */
export const repoRunsLoaded = (loaded: ReadonlyArray<RepoRunsLoaded>, owner: string, name: string): boolean => {
  const id = repoId(owner, name)
  return loaded.some((row) => row.id === id)
}

export const repoRunRows = (rows: ReadonlyArray<RepoRunRow>, owner: string, name: string): ReadonlyArray<UiRunRow> => {
  const id = repoId(owner, name)
  return rows
    .filter((row) => row.repoId === id)
    .map((row) => ({ row, startedAtMs: Date.parse(isoOf(row.createdAt)) }))
    .sort((left, right) => right.startedAtMs - left.startedAtMs)
    .slice(0, ACTIONS_LIMIT)
    .map(({ row, startedAtMs }) => {
      const state = repoRunStateOf(row.status)
      return {
        id: row.id,
        flow: `${row.flow} · ${branchWords(row.ref)}`,
        state,
        startedAtMs,
        finishedAtMs: state === "running" ? null : Date.parse(isoOf(row.updatedAt)),
        href: actionRunPath(owner, name, row.execution),
      }
    })
}

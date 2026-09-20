/*
 * The live dispatchers of a repository: GET /api/workflow/triggers?repo=owner/repo.
 *
 * The declared rules (the `on` table of `.smithers/factory.json`) are not this
 * route's business: the app reads them from the public mirror through the
 * contents route, signed in or not. This route answers the OTHER source, the
 * box: the durable registrations in the workspace's trigger store
 * (`@smthrs/triggers` TriggerStore, read through `Control.list
 * { _tag: "triggers" }` over the gateway relay) and the webhook channels the
 * control plane's `Channels` coordinator holds.
 *
 * `live` is the one fact the client needs beside the rows: true only when a
 * signed-in session's box answered the listing on this call. Signed out, no
 * identity seam, no box provisioned, a box that cannot be reached, or a box
 * whose host serves no trigger store all answer the same honest 200 with
 * `live: false` and empty lists. The route never states a reason as if it
 * were a row, and never provisions a box to answer a read.
 *
 * Webhooks: `Channels` exposes register, lookup, ingest and project with no
 * list, so the webhook list is empty until a `Channels.list` export exists;
 * `live: true` therefore speaks for the trigger store alone.
 */
import type { GatewayRpcFrame } from "./gatewayRpc"

/** How a schedule decides a fire that meets a run still in flight, in the trigger store's own three words. */
export type WorkflowTriggerOverlap = "skip" | "buffer-one" | "supersede"

/** What a schedule owes for the fires it missed, in the trigger store's own three words. */
export type WorkflowTriggerCatchUp = "none" | "one" | "all"

/**
 * One trigger row as the client renders it: the whole `TriggerSummary` the
 * box answered, under the client's own names for its clock fields.
 *
 * Every field past `activeRunId` joined later and is optional for one reason
 * each: a row the box wrote without it, and a client that was written before
 * it. `nextFireAt` stays the first of `nextFiresAt` so a client that reads
 * only the first upcoming fire keeps reading it.
 */
export interface WorkflowTrigger {
  readonly id: string
  readonly flowId: string
  readonly cron: string
  readonly timezone?: string
  readonly enabled: boolean
  readonly lastFiredAt?: number
  readonly nextFireAt?: number
  readonly activeRunId?: string
  /** Every upcoming fire the box computed on this read, in time order; the box computes five. */
  readonly nextFiresAt?: ReadonlyArray<number>
  readonly overlap?: WorkflowTriggerOverlap
  readonly catchUp?: WorkflowTriggerCatchUp
  /** The bound on how many missed fires one catch-up may owe. */
  readonly maxCatchUp?: number
  /** The input every fire of this schedule carries, as the registration recorded it. */
  readonly input?: unknown
  /** Which revision of the registration this row is. */
  readonly revision?: number
  /** The occurrence the trigger has claimed and not yet launched. */
  readonly pendingAt?: number
  /** The scheduler's last poll on the box; absent means no scheduler has ticked, so an enabled trigger is not going to fire. */
  readonly schedulerLastTickAt?: number
}

/**
 * One registered webhook as the client renders it: the channel name, and the
 * flow it starts when the declaration fixes one (a channel's inbound map may
 * choose the flow per payload, so the flow is optional).
 */
export interface WorkflowWebhook {
  readonly name: string
  readonly flowId?: string
}

/** The route's answer: the box's live rows when a box answered, and whether one did. */
export interface WorkflowTriggersBody {
  readonly status: "ok"
  readonly repo: string
  readonly live: boolean
  readonly triggers: ReadonlyArray<WorkflowTrigger>
  readonly webhooks: ReadonlyArray<WorkflowWebhook>
}

/** The answer when no box answered: signed out, no box, or a box without a trigger store. */
export const noLiveTriggers = (repo: string): WorkflowTriggersBody => ({
  status: "ok",
  repo,
  live: false,
  triggers: [],
  webhooks: []
})

/** The `List { _tag: "triggers" }` request the relay carries to the box. */
export const LIST_TRIGGERS_PAYLOAD = { _tag: "triggers" } as const

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** The overlap policy the box wrote, or nothing: a word the store never writes is not one. */
const overlapOf = (value: unknown): WorkflowTriggerOverlap | undefined =>
  value === "skip" || value === "buffer-one" || value === "supersede" ? value : undefined

/** The catch-up policy the box wrote, or nothing. */
const catchUpOf = (value: unknown): WorkflowTriggerCatchUp | undefined =>
  value === "none" || value === "one" || value === "all" ? value : undefined

/**
 * One `TriggerSummary` (`@smthrs/control` ControlSchema) as a client row.
 *
 * Only well-formed items become rows, and only what the box wrote is carried:
 * a field of a shape this route does not recognise is left out rather than
 * repaired, so no client reads a policy or a clock the box never stated. The
 * first upcoming occurrence is the next fire, and the whole list rides beside
 * it.
 */
const triggerRow = (item: unknown): WorkflowTrigger | undefined => {
  if (!isRecord(item)) return undefined
  if (typeof item.triggerId !== "string" || typeof item.flowId !== "string" || typeof item.cron !== "string") return undefined
  const upcoming = Array.isArray(item.nextOccurrencesMs)
    ? item.nextOccurrencesMs.filter((at): at is number => typeof at === "number")
    : undefined
  const next = upcoming?.[0]
  const overlap = overlapOf(item.overlap)
  const catchUp = catchUpOf(item.catchUp)
  return {
    id: item.triggerId,
    flowId: item.flowId,
    cron: item.cron,
    ...(typeof item.timezone === "string" ? { timezone: item.timezone } : {}),
    enabled: item.enabled === true,
    ...(typeof item.lastFiredAtMs === "number" ? { lastFiredAt: item.lastFiredAtMs } : {}),
    ...(typeof next === "number" ? { nextFireAt: next } : {}),
    ...(typeof item.activeRunId === "string" ? { activeRunId: item.activeRunId } : {}),
    ...(upcoming === undefined ? {} : { nextFiresAt: upcoming }),
    ...(overlap === undefined ? {} : { overlap }),
    ...(catchUp === undefined ? {} : { catchUp }),
    ...(typeof item.maxCatchUp === "number" ? { maxCatchUp: item.maxCatchUp } : {}),
    ...(item.input === undefined ? {} : { input: item.input }),
    ...(typeof item.revision === "number" ? { revision: item.revision } : {}),
    ...(typeof item.pendingAtMs === "number" ? { pendingAt: item.pendingAtMs } : {}),
    ...(typeof item.schedulerLastTickMs === "number" ? { schedulerLastTickAt: item.schedulerLastTickMs } : {})
  }
}

/**
 * The route body for a box's answer to `List { _tag: "triggers" }`. A refusal
 * (a host without a trigger store answers `this host serves no trigger
 * store`) or a malformed page is "no box answered", never an empty live list.
 */
export const workflowTriggersFromFrame = (repo: string, frame: GatewayRpcFrame): WorkflowTriggersBody => {
  if (!frame.ok) return noLiveTriggers(repo)
  const page = frame.payload
  if (!isRecord(page) || page._tag !== "triggers" || !Array.isArray(page.items)) return noLiveTriggers(repo)
  const triggers = page.items.map(triggerRow).filter((row): row is WorkflowTrigger => row !== undefined)
  return { status: "ok", repo, live: true, triggers, webhooks: [] }
}

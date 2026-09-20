/*
 * A schedule on the plan's canvas: the pure half.
 *
 * A trigger is a Dispatcher registration, not a plan node (D-031). It has no
 * step key, it is never `built` or `clean`, and a manual re-run does not
 * re-fire it, so it carries its own state — `disabled`, `armed` or `fired` —
 * it joins the plan by a UI-only `fires` edge, and it is excluded from every
 * count the plan card states. Nothing here touches React, the DOM or a seam.
 *
 * A trigger is a cron schedule and nothing else (D-043): `Trigger` is
 * `{id, flowId, input, ...Schedule.fields, enabled}`, so every reading below
 * comes off the row the box answered with and no field is completed into a
 * value the store never stated.
 */
import type { Card } from "../state/AppState"
import type { PlanCardNode } from "./FlowGraph"

/** One registered schedule, exactly as the dispatcher card carries it. */
export type TriggerCardRow = Extract<Card, { kind: "trigger-list" }>["payload"]["triggers"][number]

/** One claimed occurrence of a schedule, exactly as the card carries it. */
export type TriggerFireRow = NonNullable<TriggerCardRow["fires"]>[number]

/**
 * What a schedule is doing, in one word (D-031).
 *
 * `disabled` is the flag the store recorded (`enabled`): a registration the
 * box says is off does not fire, whatever its cron reads, so `armed` — which
 * says the opposite — is never the word for it. It is read first: the panel
 * still shows the claimed occurrence and the run in flight beneath the word,
 * so a schedule turned off mid-occurrence hides neither.
 *
 * `fired` is an occurrence this schedule has in flight right now: the box has
 * either claimed one and not yet reported it (`pendingAt`) or launched a run
 * that is still going (`activeRunId`). Everything else is `armed`. Having
 * fired at some point in the past is history, which the ledger holds; it is
 * not a state the node is in.
 */
export type TriggerNodeState = "disabled" | "armed" | "fired"

/** One trigger as the canvas draws it, with the row it was read from. */
export interface TriggerGraphNode {
  readonly id: string
  readonly state: TriggerNodeState
  readonly row: TriggerCardRow
}

/** One UI-only `fires` edge: this schedule starts that plan node. */
export interface TriggerFiresEdge {
  readonly id: string
  readonly from: string
  readonly to: string
}

/** The trigger half of a plan's graph. */
export interface TriggerGraphPart {
  readonly nodes: ReadonlyArray<TriggerGraphNode>
  readonly edges: ReadonlyArray<TriggerFiresEdge>
}

/** The canvas id of one trigger, namespaced so it can never collide with a plan node's id. */
export const triggerNodeId = (triggerId: string): string => `trigger:${triggerId}`

/** Whether a canvas id names a schedule rather than one of the plan's own nodes. */
export const isTriggerNodeId = (nodeId: string): boolean => nodeId.startsWith("trigger:")

/** @see TriggerNodeState */
export const triggerNodeState = (row: TriggerCardRow): TriggerNodeState =>
  row.enabled === false ? "disabled" : row.pendingAt !== undefined || row.activeRunId !== undefined ? "fired" : "armed"

/**
 * The schedules that fire one flow, and the edges from each of them into the
 * plan.
 *
 * The edge goes to every ROOT of the plan — the nodes that wait on nothing —
 * because that is what a fire actually starts. A plan with no nodes draws the
 * trigger and no edge rather than an edge into nothing.
 */
export const triggerGraph = (
  rows: ReadonlyArray<TriggerCardRow>,
  flowId: string,
  nodes: ReadonlyArray<PlanCardNode>
): TriggerGraphPart => {
  const matched = rows.filter((row) => row.flowId === flowId)
  const roots = nodes.filter((node) => node.dependsOn.length === 0)
  return {
    nodes: matched.map((row): TriggerGraphNode => ({ id: triggerNodeId(row.id), state: triggerNodeState(row), row })),
    edges: matched.flatMap((row) =>
      roots.map((node): TriggerFiresEdge => ({
        id: `${triggerNodeId(row.id)}->${node.id}`,
        from: triggerNodeId(row.id),
        to: node.id
      }))
    )
  }
}

/** How many upcoming fires the panel shows, however many the box computed. */
export const FIRE_TIME_COUNT = 5

/**
 * One upcoming fire, read in the zone the schedule declared and in UTC.
 *
 * `zoned` is present only when the schedule named a zone that is not UTC:
 * printing the same reading twice says nothing, and a zone the store never
 * named is the scheduler's default, which is the store's fact and not this
 * card's to guess.
 */
export interface TriggerFireTime {
  readonly at: number
  readonly zoned?: string
  readonly utc: string
}

const reading = (at: number, timeZone: string): string =>
  new Intl.DateTimeFormat([], { timeZone, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })
    .format(new Date(at))

/**
 * One instant read the way this schedule's own occurrences are read, so every
 * time on the panel — an upcoming fire, a claimed occurrence, a ledger entry —
 * is in the same two zones and never in the reader's own.
 *
 * @see TriggerFireTime
 */
export const fireTime = (row: TriggerCardRow, at: number): TriggerFireTime => {
  const zone = row.timezone === undefined || row.timezone === "UTC" ? undefined : row.timezone
  return { at, ...(zone === undefined ? {} : { zoned: reading(at, zone) }), utc: reading(at, "UTC") }
}

/**
 * The upcoming fires this row carries, cut to what the panel shows.
 *
 * A box row carries every occurrence its scheduler computed (`nextFiresAt`,
 * whose first entry is `nextFireAt`). A Plue registration is served one
 * instant and no more (`nextFireAt`), so that instant is its whole list.
 * Nothing is merged across the two registries: each reading comes off the
 * row's own field, and a row carrying neither has no upcoming fire to show.
 */
export const nextFireTimes = (row: TriggerCardRow, count: number = FIRE_TIME_COUNT): ReadonlyArray<TriggerFireTime> => {
  const upcoming = row.nextFiresAt ?? (row.nextFireAt === undefined ? [] : [row.nextFireAt])
  return upcoming.slice(0, count).map((at) => fireTime(row, at))
}

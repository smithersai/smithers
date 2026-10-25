import type { BrowserEngine } from "@smthrs/platform-browser"
import type { Effect } from "effect"
import { Schema } from "effect"
import { STEER_REFUSALS } from "./contract"

// Runs on this tab (decision 0014 §1 "On the device", docs/features/runs.md#the-browser): this device's engine's runs,
// read through `BrowserEngine` (its leader's `RunInspection`), kept in local collections, never in Postgres. Nothing
// here is stored on the device: a reload reads the engine again.

/** One run of this device's engine, as `BrowserEngine.inspect` reads it. */
export type Inspection = Effect.Success<ReturnType<BrowserEngine.Service["inspect"]>>

/** The engine's statuses. */
export const RunStatus = Schema.Literals(["pending", "running", "suspended", "completed", "failed", "cancelled"])
export type RunStatus = typeof RunStatus.Type

/** One run of the list: `localRuns` of decision 0014 §1. */
export const RunRow = Schema.Struct({
  id: Schema.String,
  flow: Schema.String,
  status: RunStatus,
  cancelRequested: Schema.Boolean,
  createdAtMs: Schema.Number,
  startedAtMs: Schema.NullOr(Schema.Number),
  finishedAtMs: Schema.NullOr(Schema.Number),
  seq: Schema.Number,
  /** The finite result of a completed answer or draft, when its inspection could be read. */
  outcome: Schema.optionalKey(Schema.Literals(["succeeded", "failed", "unknown"])),
})
export type RunRow = typeof RunRow.Type

/**
 * One run's page as the engine last read it (`runTraces`): `read` with its inspection, or why there is none: the engine
 * doesn't hold it (`not_found`: on another device, or for a run on Cloudflare, none this person may read), hasn't
 * begun it (`not_started`, a run on Cloudflare its TODO just started) or couldn't be reached (`unavailable`).
 */
export const RunPage = Schema.Struct({
  id: Schema.String,
  state: Schema.Literals(["loading", "read", "not_found", "not_started", "unavailable"]),
  inspection: Schema.NullOr(Schema.Unknown),
  /** The journal events read past the first page, by More. */
  more: Schema.Array(Schema.Unknown),
  descendants: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  hasMore: Schema.Boolean,
})
export type RunPage = typeof RunPage.Type

/** The tabs of a run's page. */
export const RUN_TABS = ["steps", "timeline", "journal"] as const
export type RunTab = (typeof RUN_TABS)[number]

/** An act a person pressed, until its flow answers. */
export const Acting = Schema.NullOr(Schema.Literals(["stop", "retry", "resume"]))

/** This tab's run view (`runPage`): the run it shows, the step selected, the tab, an act in flight and a refusal. */
/** A repository, by owner and name. */
export const RepoName = Schema.Struct({ owner: Schema.String, name: Schema.String })
export type RepoName = typeof RepoName.Type

export const RunView = Schema.Struct({
  id: Schema.Literal("view"),
  runId: Schema.NullOr(Schema.String),
  listOpen: Schema.Boolean,
  /** A successful list read, valid until the engine next changes. */
  listReady: Schema.optionalKey(Schema.Boolean),
  listRevision: Schema.optionalKey(Schema.Number),
  selected: Schema.NullOr(Schema.String),
  now: Schema.optionalKey(Schema.Number),
  at: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  inspectorOpen: Schema.optionalKey(Schema.Boolean),
  tab: Schema.Literals(["steps", "timeline", "journal"]),
  acting: Acting,
  actToken: Schema.optionalKey(Schema.NullOr(Schema.String)),
  refusal: Schema.NullOr(Schema.String),
  /** What the steer composer holds (docs/features/runs.md#steering): kept with the view, never on the device. */
  steerDraft: Schema.optionalKey(Schema.String),
  /** The repository whose run this is, read on Cloudflare (docs/features/actions.md); none for any other run. */
  repo: Schema.optionalKey(Schema.NullOr(RepoName)),
})
export type RunView = typeof RunView.Type

/** The one row of `RunView`. */
export const VIEW = "view"

/**
 * A run's row of the engine's change feed on Cloudflare (`flows_run_changes`, `RUN_CHANGE_COLUMNS`): its revision moves
 * whenever the run does. Postgres `numeric`, which Electric sends as text.
 */
export const RunChange = Schema.Struct({ runId: Schema.String, revision: Schema.String })
export type RunChange = typeof RunChange.Type

/** A person's message to a TODO's running agent (docs/features/runs.md#steering): its id, its run and its words. */
const SteerFields = { id: Schema.String, runId: Schema.String, body: Schema.String }

/**
 * A steer as a step asks the tab to queue it: its message, and the run credential of the run that sent it unless that
 * run is the person's own press (decision 0017 slice 0). The tab sends it with that credential and without the session
 * cookie, so ChatApi reads an agent's steer as the agent's, for the person.
 */
export const QueuedSteer = Schema.Struct({ ...SteerFields, credential: Schema.optional(Schema.String) })
export type QueuedSteer = typeof QueuedSteer.Type

/**
 * A steer the outbox holds: the optimistic row of its outbox write (`steer-sending`), keyed by its id. `queuedAt` (epoch
 * ms) orders it among the run's messages. `v` is the row's version in the outbox.
 */
export const SteerSending = Schema.Struct({ ...QueuedSteer.fields, queuedAt: Schema.Number, v: Schema.Literal(1) })
export type SteerSending = typeof SteerSending.Type

/**
 * A steer the route answered on this tab: `sent` (taken, until the run's journal shows it) or `not_sent`, with why. In
 * memory: after a reload the run's journal is where a sent message shows.
 */
export const SteerSent = Schema.Struct({
  ...SteerFields,
  queuedAt: Schema.Number,
  status: Schema.Literals(["sent", "not_sent"]),
  reason: Schema.NullOr(Schema.Literals(STEER_REFUSALS)),
})
export type SteerSent = typeof SteerSent.Type

/** What a steer step asks the tab that started it to do: queue the message in the device's outbox. */
export const RunsCall = Schema.Struct({ kind: Schema.Literal("steer"), steer: QueuedSteer })
export type RunsCall = typeof RunsCall.Type

/** What the tab answered: whether its outbox took the message. */
export const SteerKept = Schema.Struct({ kept: Schema.Boolean })

/**
 * One of a repository's runs, as `ACTIONS_SHAPE_ROUTE` syncs it (docs/features/actions.md): a `runs` row with the
 * engine's run id (`execution`), its flow, state, commit, ref and what started it. Postgres timestamps arrive as text.
 */
export const RepoRunRow = Schema.Struct({
  id: Schema.String,
  repoId: Schema.String,
  execution: Schema.String,
  flow: Schema.String,
  status: Schema.String,
  sha: Schema.String,
  ref: Schema.String,
  event: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
})
export type RepoRunRow = typeof RepoRunRow.Type

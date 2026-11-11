/**
 * `runner/Workstreams`: what a runner's lanes are working toward, read from
 * the lanes' own runs.
 *
 * A workstream is declared once, in `runner.json`: its title, its goal, the
 * criteria that make it done and the tasks planned for it. That is the plan;
 * it changes only when the plan does. A lane joins a task when
 * `runner start --workstream W --task T` queues it. Everything else, which
 * task is being worked, by which lane, and how far the workstream has come,
 * is folded from the state the runner already keeps: the lane requests still
 * queued and each admitted lane's control run. No one writes a status.
 *
 *   runner.json workstreams ──┐
 *   lanes/<id>.json (queued) ─┼─> project ──> Workstream[] (tasks, owners, progress)
 *   lanes/admitted/<id>.json ─┤
 *   Control.list (run status) ┘
 *
 * A task is `done` once one of its lanes' runs completed, `doing` while one
 * is open, `blocked` while one waits on a person or the last one failed, and
 * `todo` otherwise, a lane queued or cancelled included. A workstream is
 * `done` when it has tasks and every one is done, `active` while any task is
 * being worked, `blocked` when tasks are blocked and none is being worked,
 * and `idle` otherwise.
 *
 * @since 1.0.0
 */

import { Control, ControlSchema } from "@smthrs/control"
import { Effect, FileSystem, type Layer, Option, Schema } from "effect"
import { join } from "node:path"
import type * as Config from "./Config.ts"
import type * as Lane from "./Lane.ts"
import * as LaneIntake from "./LaneIntake.ts"

/**
 * Where one lane is: still queued, its run's status, or `missing` when the
 * lane's run can't be found on the lanes root.
 *
 * @category schemas
 * @since 1.0.0
 */
export const LaneStatus = Schema.Union([ControlSchema.RunStatus, Schema.Literals(["queued", "missing"])])

/**
 * One lane a projection reads: its request, the task it works on, the
 * profile that runs its agent, and where it is.
 *
 * @category models
 * @since 1.0.0
 */
export interface LaneState {
  readonly request: string
  readonly task?: Lane.Task | undefined
  readonly profile?: string | undefined
  readonly standing?: boolean | undefined
  readonly runId?: string | undefined
  readonly status: typeof LaneStatus.Type
}

/**
 * A task's status.
 *
 * @category schemas
 * @since 1.0.0
 */
export const TaskStatus = Schema.Literals(["todo", "doing", "blocked", "done"])

/**
 * A workstream's status.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Status = Schema.Literals(["idle", "active", "blocked", "done"])

/**
 * One lane working on a task: its request, its run once admitted, the
 * profile that runs its agent and whether it is standing (unknown for a lane
 * admitted before its record kept them), and where it is.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Owner = Schema.Struct({
  request: Schema.String,
  runId: Schema.optional(Schema.String),
  profile: Schema.optional(Schema.String),
  standing: Schema.optional(Schema.Boolean),
  status: LaneStatus
})

/**
 * A count of done tasks out of all of them.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Progress = Schema.Struct({ done: Schema.Int, total: Schema.Int, unit: Schema.Literal("tasks") })

/**
 * One task of a workstream: what the plan says of it, its status, and the
 * lanes on it, oldest first.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Task = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  criteria: Schema.Array(Schema.String),
  status: TaskStatus,
  owners: Schema.Array(Owner)
})

/**
 * One workstream: its plan, its status, its progress and its tasks.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Workstream = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  goal: Schema.optional(Schema.String),
  criteria: Schema.Array(Schema.String),
  status: Status,
  progress: Progress,
  tasks: Schema.Array(Task)
})

/**
 * One workstream, decoded.
 *
 * @category models
 * @since 1.0.0
 */
export type Workstream = typeof Workstream.Type

type TaskRow = typeof Task.Type

/** A run that is still being worked. */
const OPEN: ReadonlySet<string> = new Set(["accepted", "running", "parked"])

/** A task's status from its lanes, oldest first. */
const taskStatus = (owners: ReadonlyArray<typeof Owner.Type>): typeof TaskStatus.Type => {
  if (owners.some((owner) => owner.status === "completed")) return "done"
  if (owners.some((owner) => OPEN.has(owner.status))) return "doing"
  if (owners.some((owner) => owner.status === "waiting-approval")) return "blocked"
  const last = owners.filter((owner) => owner.status !== "queued").at(-1)
  return last?.status === "failed" ? "blocked" : "todo"
}

/** A workstream's status from its tasks. */
const status = (tasks: ReadonlyArray<TaskRow>): typeof Status.Type =>
  tasks.length > 0 && tasks.every((task) => task.status === "done")
    ? "done"
    : tasks.some((task) => task.status === "doing")
    ? "active"
    : tasks.some((task) => task.status === "blocked")
    ? "blocked"
    : "idle"

/**
 * Folds the declared workstreams and the lanes, oldest first, into each
 * workstream's tasks, owners and progress: declared workstreams in their
 * order, then any a lane names that `runner.json` no longer declares; in each,
 * declared tasks in their order, then tasks only a lane names. A lane with no
 * task belongs to no workstream.
 *
 * @category constructors
 * @since 1.0.0
 */
export const project = (
  declared: Config.Config["workstreams"],
  lanes: ReadonlyArray<LaneState>
): ReadonlyArray<Workstream> => {
  const plans = new Map(Object.entries(declared ?? {}))
  for (const lane of lanes) {
    if (lane.task !== undefined && !plans.has(lane.task.workstream)) {
      plans.set(lane.task.workstream, { title: lane.task.workstream })
    }
  }
  return [...plans].map(([id, plan]) => {
    const rows = new Map<string, { title: string; criteria: ReadonlyArray<string>; owners: Array<typeof Owner.Type> }>(
      (plan.tasks ?? []).map((task) => [task.id, { title: task.title, criteria: task.criteria ?? [], owners: [] }])
    )
    for (const lane of lanes) {
      if (lane.task?.workstream !== id) continue
      const row = rows.get(lane.task.id) ?? { title: lane.task.title ?? lane.task.id, criteria: [], owners: [] }
      row.owners.push({
        request: lane.request,
        ...(lane.runId === undefined ? {} : { runId: lane.runId }),
        ...(lane.profile === undefined ? {} : { profile: lane.profile }),
        ...(lane.standing === undefined ? {} : { standing: lane.standing }),
        status: lane.status
      })
      rows.set(lane.task.id, row)
    }
    const tasks = [...rows].map(([task, row]): TaskRow => ({
      id: task,
      title: row.title,
      criteria: row.criteria,
      status: taskStatus(row.owners),
      owners: row.owners
    }))
    return {
      id,
      title: plan.title,
      ...(plan.goal === undefined ? {} : { goal: plan.goal }),
      criteria: plan.criteria ?? [],
      status: status(tasks),
      progress: { done: tasks.filter((task) => task.status === "done").length, total: tasks.length, unit: "tasks" },
      tasks
    }
  })
}

const decodeRequest = Schema.decodeUnknownOption(Schema.fromJsonString(LaneIntake.Request))
const decodeAdmitted = Schema.decodeUnknownOption(Schema.fromJsonString(LaneIntake.Admitted))

/** The JSON files directly in `dir`, by name; none when it doesn't exist. */
const files = (dir: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    if (!(yield* fs.exists(dir))) return []
    const names = (yield* fs.readDirectory(dir)).filter((name) => !name.startsWith(".") && name.endsWith(".json"))
    return yield* Effect.forEach(names.sort(), (name) => fs.readFileString(join(dir, name)))
  })

/** The lane records under the runner's state: the requests still queued and the admitted lanes. */
const records = (config: Config.Checked) =>
  Effect.gen(function*() {
    const at = LaneIntake.paths(config.stateDir)
    return {
      queued: (yield* files(at.dir)).flatMap((text) => Option.toArray(decodeRequest(text))),
      admitted: (yield* files(join(at.dir, "admitted"))).flatMap((text) => Option.toArray(decodeAdmitted(text)))
    }
  })

/** Each admitted lane with its run's status through the context's `Control`, oldest run first. */
const admittedStates = (admitted: ReadonlyArray<typeof LaneIntake.Admitted.Type>) =>
  Effect.gen(function*() {
    const control = yield* Control.Control
    const read: Array<LaneState & { readonly createdAt: number }> = []
    for (const lane of admitted) {
      const page = yield* control.list({ _tag: "runs", filters: { runId: lane.runId }, limit: 1 })
      const run = page._tag === "runs" ? page.items.find((item) => item.runId === lane.runId) : undefined
      read.push({
        request: lane.id,
        task: lane.task,
        profile: lane.profile,
        standing: lane.standing,
        runId: lane.runId,
        status: run?.status ?? "missing",
        createdAt: run?.createdAt ?? Number.MAX_SAFE_INTEGER
      })
    }
    return read.sort((a, b) => a.createdAt - b.createdAt).map(({ createdAt: _, ...lane }): LaneState => lane)
  })

/**
 * The workstreams of the runner `config` describes, read now: the requests
 * still queued and the admitted lanes, each with its run's status through
 * `control`, the control plane on the lanes root, built only when a lane was
 * admitted. Files that don't decode are left out; the daemon sets those
 * aside.
 *
 * @category constructors
 * @since 1.0.0
 */
export const read = <E, R>(config: Config.Checked, control: Layer.Layer<Control.Control, E, R>) =>
  Effect.gen(function*() {
    const { queued, admitted } = yield* records(config)
    const states = admitted.length === 0 ? [] : yield* admittedStates(admitted).pipe(Effect.provide(control))
    return project(config.workstreams, [
      ...states,
      ...queued.map((request): LaneState => ({
        request: request.id,
        task: request.input.task,
        profile: request.input.profile,
        standing: request.input.standing,
        status: "queued"
      }))
    ])
  })

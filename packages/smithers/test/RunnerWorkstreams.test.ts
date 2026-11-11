/**
 * `runner/Workstreams`: the fold from the declared plan and the lanes' states to each workstream's tasks, owners and
 * progress, and `smthrs runner status` reading a runner's lane records with no daemon up. The lanes the real daemon
 * runs are read in `RunnerLane.test.ts`.
 */
import { Effect } from "effect"
import { mkdirSync, writeFileSync } from "node:fs"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import * as RunnerCmd from "../src/commands/Runner.ts"
import * as Config from "../src/runner/Config.ts"
import * as LaneIntake from "../src/runner/LaneIntake.ts"
import * as Workstreams from "../src/runner/Workstreams.ts"
import * as Lanes from "./fixtures/runner/lanes.ts"

const plan = {
  alpha: {
    title: "Alpha",
    goal: "Alpha ships.",
    criteria: ["The alpha tag exists"],
    tasks: [{ id: "parser", title: "Port the parser", criteria: ["parser tests pass"] }, {
      id: "docs",
      title: "Write the docs"
    }]
  }
}

const lane = (
  request: string,
  status: Workstreams.LaneState["status"],
  task: { readonly workstream: string; readonly id: string; readonly title?: string } | undefined = {
    workstream: "alpha",
    id: "parser"
  }
): Workstreams.LaneState => ({ request, task, profile: "claude", standing: false, runId: `run-${request}`, status })

const tasksOf = (lanes: ReadonlyArray<Workstreams.LaneState>) =>
  Workstreams.project(plan, lanes)[0]!.tasks.map((task) => [task.id, task.status])

describe("runner/Workstreams.project", () => {
  test("a task is done once a lane completed, doing while one is open, blocked on a person or a failure, else todo", () => {
    expect(tasksOf([])).toEqual([["parser", "todo"], ["docs", "todo"]])
    expect(tasksOf([lane("a", "queued")])).toEqual([["parser", "todo"], ["docs", "todo"]])
    for (const open of ["accepted", "running", "parked"] as const) {
      expect(tasksOf([lane("a", "failed"), lane("b", open)])[0]).toEqual(["parser", "doing"])
    }
    expect(tasksOf([lane("a", "running"), lane("b", "completed")])[0]).toEqual(["parser", "done"])
    expect(tasksOf([lane("a", "waiting-approval")])[0]).toEqual(["parser", "blocked"])
    expect(tasksOf([lane("a", "failed"), lane("b", "queued")])[0]).toEqual(["parser", "blocked"])
    // A lane cancelled after one failed leaves the task to be picked up again; so does one whose run is gone.
    expect(tasksOf([lane("a", "failed"), lane("b", "cancelled")])[0]).toEqual(["parser", "todo"])
    expect(tasksOf([lane("a", "missing")])[0]).toEqual(["parser", "todo"])
  })

  test("a workstream is done when every task is, active while one is worked, blocked when only blocked ones move", () => {
    const status = (lanes: ReadonlyArray<Workstreams.LaneState>) => {
      const [workstream] = Workstreams.project(plan, lanes)
      return [workstream!.status, workstream!.progress]
    }
    expect(status([])).toEqual(["idle", { done: 0, total: 2, unit: "tasks" }])
    expect(status([lane("a", "running")])).toEqual(["active", { done: 0, total: 2, unit: "tasks" }])
    expect(status([lane("a", "failed")])).toEqual(["blocked", { done: 0, total: 2, unit: "tasks" }])
    expect(status([lane("a", "completed"), lane("b", "completed", { workstream: "alpha", id: "docs" })]))
      .toEqual(["done", { done: 2, total: 2, unit: "tasks" }])
    expect(Workstreams.project({ empty: { title: "Empty" } }, [])).toEqual([
      {
        id: "empty",
        title: "Empty",
        criteria: [],
        status: "idle",
        progress: { done: 0, total: 0, unit: "tasks" },
        tasks: []
      }
    ])
  })

  test("lanes join declared tasks in plan order, add tasks and workstreams the plan doesn't list, and own nothing without a task", () => {
    const [alpha, beta] = Workstreams.project(plan, [
      lane("a", "running", { workstream: "alpha", id: "extra", title: "An extra task" }),
      lane("b", "completed", { workstream: "alpha", id: "untitled" }),
      lane("c", "parked", { workstream: "beta", id: "one" }),
      lane("d", "running"),
      { request: "e", profile: "claude", runId: "run-e", status: "running" },
      { request: "f", task: { workstream: "alpha", id: "docs" }, status: "queued" }
    ])
    expect(alpha).toMatchObject({
      id: "alpha",
      title: "Alpha",
      goal: "Alpha ships.",
      criteria: ["The alpha tag exists"]
    })
    expect(alpha!.tasks).toEqual([
      {
        id: "parser",
        title: "Port the parser",
        criteria: ["parser tests pass"],
        status: "doing",
        owners: [{ request: "d", runId: "run-d", profile: "claude", standing: false, status: "running" }]
      },
      {
        id: "docs",
        title: "Write the docs",
        criteria: [],
        status: "todo",
        owners: [{ request: "f", status: "queued" }]
      },
      {
        id: "extra",
        title: "An extra task",
        criteria: [],
        status: "doing",
        owners: [{ request: "a", runId: "run-a", profile: "claude", standing: false, status: "running" }]
      },
      {
        id: "untitled",
        title: "untitled",
        criteria: [],
        status: "done",
        owners: [{ request: "b", runId: "run-b", profile: "claude", standing: false, status: "completed" }]
      }
    ])
    // A workstream runner.json no longer declares keeps its lanes, under its id.
    expect(beta).toMatchObject({ id: "beta", title: "beta", criteria: [], status: "active" })
    expect(beta).not.toHaveProperty("goal")
    // With no workstreams declared, the lanes' tasks are the whole picture.
    expect(
      Workstreams.project(undefined, [lane("a", "completed")]).map((workstream) => [workstream.id, workstream.status])
    )
      .toEqual([["alpha", "done"]])
  })

  test("runner status renders one block per workstream and one line per task", () => {
    expect(RunnerCmd.renderStatus([])).toBe("No workstreams. Declare them under workstreams in runner.json.")
    expect(RunnerCmd.renderStatus(Workstreams.project(plan, [lane("a", "running"), {
      request: "b",
      task: { workstream: "beta", id: "one" },
      status: "queued"
    }]))).toBe(
      [
        "Alpha (alpha)  active  0/2 tasks",
        "  goal: Alpha ships.",
        "  doing   Port the parser (parser)  run-a claude running",
        "  todo    Write the docs (docs)  no lane",
        "",
        "beta (beta)  idle  0/1 tasks",
        "  todo    one (one)  b queued"
      ].join("\n")
    )
  })
})

describe("smthrs runner status", () => {
  let lanes: Lanes.Lanes

  beforeEach(() => {
    lanes = Lanes.make()
  })

  afterEach(async () => {
    await lanes.close()
  })

  test(
    "reads queued requests and admitted records with no daemon up; a run the lanes root doesn't hold is missing",
    async () => {
      lanes.configure({ workstreams: plan })
      const status = () => Effect.runPromise(RunnerCmd.status(lanes.configPath))
      // Before any lane, with no state directory yet: the plan alone, every task todo.
      expect((await status()).map((workstream) => workstream.tasks.map((task) => [task.id, task.status])))
        .toEqual([[["parser", "todo"], ["docs", "todo"]]])
      const at = LaneIntake.paths(lanes.stateDir)
      const { request } = await Effect.runPromise(RunnerCmd.start({
        brief: lanes.brief("port the parser"),
        config: lanes.configPath,
        profile: "test-agent",
        repository: Lanes.REPOSITORY,
        standing: true,
        maxHours: 1,
        restarts: 1,
        workstream: "alpha",
        task: "parser"
      }))
      mkdirSync(`${at.dir}/admitted`, { recursive: true })
      // An admitted lane whose run is gone, one admitted before records kept a task, and a record that doesn't decode.
      writeFileSync(
        at.admitted("00000000-0000-4000-8000-000000000001"),
        JSON.stringify({
          id: "00000000-0000-4000-8000-000000000001",
          runId: "gone",
          task: { workstream: "alpha", id: "docs" }
        })
      )
      writeFileSync(
        at.admitted("00000000-0000-4000-8000-000000000002"),
        JSON.stringify({ id: "00000000-0000-4000-8000-000000000002", runId: "old" })
      )
      writeFileSync(at.admitted("00000000-0000-4000-8000-000000000003"), "{")
      const workstreams = await status()
      // The command prints the same document, and nothing else, on stdout.
      expect(await lanes.workstreams()).toEqual(workstreams)
      expect(workstreams.map((workstream) => [workstream.id, workstream.status, workstream.progress.done])).toEqual([[
        "alpha",
        "idle",
        0
      ]])
      expect(workstreams[0]!.tasks.map((task) => [task.id, task.status, task.owners])).toEqual([
        ["parser", "todo", [{ request, profile: "test-agent", standing: true, status: "queued" }]],
        ["docs", "todo", [{ request: "00000000-0000-4000-8000-000000000001", runId: "gone", status: "missing" }]]
      ])
      expect(RunnerCmd.renderStatus(workstreams).split("\n").slice(2)).toEqual([
        `  todo    Port the parser (parser)  ${request} test-agent queued`,
        "  todo    Write the docs (docs)  gone missing"
      ])
      lanes.configure({ origin: "https://smithers.example" })
      expect(await Effect.runPromise(RunnerCmd.status(lanes.configPath).pipe(Effect.flip))).toMatchObject({
        message: "runner status needs a runner.json with no origin"
      })
    },
    120_000
  )

  test("runner.json refuses a workstream that plans one task id twice, or an id that isn't lowercase kebab", async () => {
    const checked = (workstreams: unknown) => {
      lanes.configure({ workstreams })
      return Effect.runPromise(
        Config.load(lanes.configPath).pipe(
          Effect.map(() => "ok"),
          Effect.catch((error) => Effect.succeed(error.message))
        )
      )
    }
    expect(await checked(plan)).toBe("ok")
    expect(await checked({ alpha: { title: "Alpha", tasks: [{ id: "a", title: "A" }, { id: "a", title: "B" }] } }))
      .toBe("workstreams.alpha.tasks has a task id twice")
    expect(await checked({ Alpha: { title: "Alpha" } }))
      .toBe("a workstreams key is lowercase letters, digits and -, up to 64 characters")
    expect(await checked({ alpha: { title: "Alpha", tasks: [{ id: "Notes", title: "Notes" }] } })).not.toBe("ok")
  })
})

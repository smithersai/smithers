// A run's page as a frontend draws it (src/features/runs/page.ts, decision 0014 §5): the steps a person reads, the
// selected one, the journal with what More read, the acts a run offers, and the list's rows.
import { describe, expect, test } from "vitest"
import { ACTIONS_LIMIT } from "../actions/contract"
import {
  actsOf,
  cloudHref,
  cloudRowOf,
  deviceActor,
  deviceTrigger,
  hostOf,
  journalOf,
  listHref,
  listLoaded,
  listRows,
  missingOf,
  repoRunRows,
  repoRunsLoaded,
  retriesFrom,
  retriesOf,
  runsSearch,
  runOriginSearch,
  selectedStep,
  STALLED_AFTER_MS,
} from "./page"
import type { CloudRun, Inspection, RepoRunRow, RunPage, RunRow } from "./schema"

const value = (text: string) => ({ text, bytes: text.length, clipped: false })

const run = (overrides: Partial<Inspection["run"]> = {}): Inspection["run"] => ({
  runId: "run-1",
  flowName: "flow/run",
  status: "completed",
  createdAtMs: 1_000,
  startedAtMs: 1_010,
  finishedAtMs: 2_000,
  parentRunId: null,
  cancelRequestedAtMs: null,
  waiting: null,
  lastSeq: 9,
  origin: null,
  input: value("{}"),
  result: value('"Hello."'),
  ...overrides,
})

const inspection = (overrides: Partial<Inspection> = {}): Inspection => ({
  run: run(),
  steps: [
    { nodeId: "root", action: "flow/run", kind: "FlowCall", status: "completed", scheduledAtMs: 1_000, settledAtMs: 2_000, seq: 1, output: null, attempts: [] },
    { nodeId: "root.flow", action: null, kind: "AndThen", status: "completed", scheduledAtMs: 1_001, settledAtMs: 2_000, seq: 2, output: null, attempts: [] },
    {
      nodeId: "root.flow.load",
      action: "flow/run/load",
      kind: "ActionCall",
      status: "completed",
      scheduledAtMs: 1_002,
      settledAtMs: 1_100,
      seq: 3,
      output: value('{"name":"hello"}'),
      attempts: [
        { attempt: 1, state: "failed", startedAtMs: 1_002, finishedAtMs: 1_050, outcome: null, error: "FlowsUnavailable" },
        { attempt: 2, state: "succeeded", startedAtMs: 1_060, finishedAtMs: 1_100, outcome: value("{}"), error: null },
      ],
    },
    { nodeId: "root.flow.prompt", action: "flow/run/prompt", kind: "FlowCall", status: "completed", scheduledAtMs: 1_101, settledAtMs: 1_900, seq: 4, output: null, attempts: [] },
  ],
  children: [
    {
      runId: "run-1/child",
      flowName: "flow/run/prompt",
      status: "suspended",
      createdAtMs: 1_102,
      startedAtMs: 1_103,
      finishedAtMs: null,
      parentRunId: "run-1",
      cancelRequestedAtMs: null,
      waiting: { kind: "human", reason: "human", wakeAtMs: 9_000 },
      lastSeq: 3,
      origin: null,
      input: value('{"input":""}'),
      result: null,
    },
  ],
  journal: {
    events: [{ seq: 0, eventType: "flows.engine.run-decision", emittedAtMs: 1_000, payload: value("{}") }],
    afterSeq: -1,
    nextSeq: 0,
    hasMore: true,
  },
  ...overrides,
})

describe("selectedStep", () => {
  test("explicit selection wins, otherwise follow live work, then the latest settled step", () => {
    const step = (id: string, state: import("@smthrs/ui").StepState): import("./page").PageStep => ({ row: { id, label: id, state, kind: "step", startedAtMs: 0, endedAtMs: null, depth: 0, attempts: 0, failedAttempts: 0 }, input: null, output: null, attempts: [], wait: null, href: null, logs: [] })
    const steps = [step("a", "completed"), step("b", "running"), step("c", "pending")]
    expect(selectedStep(steps, "a")?.row.id).toBe("a")
    expect(selectedStep(steps, null)?.row.id).toBe("b")
    expect(selectedStep([steps[0]!, steps[2]!], null)?.row.id).toBe("a")
    expect(selectedStep([steps[2]!], null)?.row.id).toBe("c")
    expect(selectedStep([], null)).toBeUndefined()
    const failed = [...steps, step("first-failure", "failed"), step("later-failure", "failed"), step("cleanup", "completed")]
    expect(selectedStep(failed, null)?.row.id).toBe("first-failure")
    expect(selectedStep(failed, "cleanup")?.row.id).toBe("cleanup")
    expect(selectedStep(failed, "missing")?.row.id).toBe("first-failure")
  })
})

describe("journalOf", () => {
  test("the first page, then what More read", () => {
    const more = [{ seq: 1, eventType: "flows.engine.node-scheduled", emittedAtMs: 1_001, payload: value("{}") }]
    expect(journalOf({ id: "run-1", state: "read", inspection: inspection(), more, hasMore: false }).map((event) => event.seq))
      .toEqual([0, 1])
  })
})

describe("actsOf", () => {
  test("Retry once a retried flow settled; never for an act or an answer", () => {
    expect(actsOf(inspection(), 3_000)).toEqual({ stop: false, retry: true, resume: false })
    expect(actsOf(inspection({ run: run({ flowName: "chat/Answer" }) }), 3_000).retry).toBe(false)
  })

  test("Stop while it runs and no stop was asked; Resume while it waits, or once it recorded nothing for a minute", () => {
    const live = inspection({ run: run({ status: "running", finishedAtMs: null }) })
    expect(actsOf(live, 1_000 + STALLED_AFTER_MS - 1)).toEqual({ stop: true, retry: false, resume: false })
    expect(actsOf(live, 1_000 + STALLED_AFTER_MS).resume).toBe(true)
    expect(actsOf(inspection({ run: run({ status: "running", cancelRequestedAtMs: 1_500 }) }), 0).stop).toBe(false)
    expect(actsOf(inspection({ run: run({ status: "suspended" }) }), 0).resume).toBe(true)
    const silent = inspection({ run: run({ status: "running" }), journal: { ...inspection().journal, events: [] } })
    expect(actsOf(silent, 1_000 + STALLED_AFTER_MS).resume).toBe(true)
  })
})

describe("retriesFrom", () => {
  const steps = inspection().steps
  const [rootStep, sequence, load, prompt] = steps

  test("a person's flow offers Retry from here on its prompt, after its load; never on the load, with nothing before", () => {
    expect([...retriesFrom(inspection())]).toEqual(["root.flow.prompt"])
  })

  test("a step that failed after another completed offers it; a skipped or running one, or one before nothing, doesn't", () => {
    const failed = { ...prompt!, status: "failed" as const }
    expect([...retriesFrom(inspection({ steps: [rootStep!, sequence!, load!, failed] }))]).toEqual(["root.flow.prompt"])
    for (const status of ["skipped", "running", "waiting"] as const) {
      expect(retriesFrom(inspection({ steps: [rootStep!, sequence!, load!, { ...prompt!, status }] })).size).toBe(0)
    }
    // A boundary began when its child run was created, not when the engine scheduled it, which is before the load it
    // waits on: scheduled at 1,003, its child created at 1,102, after the load settled.
    const early = { ...prompt!, scheduledAtMs: 1_003 }
    expect([...retriesFrom(inspection({ steps: [rootStep!, sequence!, load!, early] }))]).toEqual(["root.flow.prompt"])
    // A step that began before anything completed replays nothing: Retry covers it.
    const overlapping = inspection({
      steps: [rootStep!, sequence!, load!, early],
      children: inspection().children.map((child) => ({ ...child, createdAtMs: 1_050 })),
    })
    expect(retriesFrom(overlapping).size).toBe(0)
    // An action step began at its first attempt, not when it was scheduled.
    const finish = { ...load!, nodeId: "root.flow.finish", action: "x/finish", scheduledAtMs: 1_001, settledAtMs: 1_950,
      attempts: [{ attempt: 1, state: "succeeded", startedAtMs: 1_901, finishedAtMs: 1_950, outcome: null, error: null }] }
    expect([...retriesFrom(inspection({ steps: [...steps, finish] }))]).toEqual(["root.flow.prompt", "root.flow.finish"])
  })

  test("a boundary whose child isn't among the run's children is structure, not a step: no offer", () => {
    expect(retriesFrom(inspection({ children: [] })).size).toBe(0)
  })

  test("only a settled run of a retried flow on this device offers it", () => {
    expect(retriesFrom(inspection({ run: run({ status: "running", finishedAtMs: null }) })).size).toBe(0)
    expect(retriesFrom(inspection({ run: run({ flowName: "chat/Answer" }) })).size).toBe(0)
    expect(retriesFrom(inspection({ run: run({ runId: "todo:6f1c2a7e-3b4d-4c5e-8f90-1a2b3c4d5e6f" }) })).size).toBe(0)
    expect(retriesFrom(inspection(), true).size).toBe(0)
  })
})

describe("a run on Cloudflare", () => {
  const TODO_RUN = "todo:6f1c2a7e-3b4d-4c5e-8f90-1a2b3c4d5e6f"

  test("offers no acts, whatever its state: each act runs on this device's engine", () => {
    for (const status of ["running", "suspended", "completed", "failed"] as const) {
      expect(actsOf(inspection({ run: run({ runId: TODO_RUN, status }) }), 1_000 + STALLED_AFTER_MS))
        .toEqual({ stop: false, retry: false, resume: false })
    }
  })

  test("its header says Cloud; this device's says This device", () => {
    expect([hostOf(TODO_RUN), hostOf("run-1"), hostOf("todo:not-an-attempt")]).toEqual(["Cloud", "This device", "This device"])
  })

  test("a page without a run says why: Not started, Not found, On another device, or Couldn't read this run", () => {
    expect(missingOf({ id: TODO_RUN, state: "not_started" })).toBe("Not started")
    expect(missingOf({ id: TODO_RUN, state: "not_found" })).toBe("Not found")
    expect(missingOf({ id: "run-1", state: "not_found" })).toBe("On another device")
    expect(missingOf({ id: TODO_RUN, state: "unavailable" })).toBe("Couldn't read this run")
    expect(missingOf({ id: "run-1", state: "unavailable" })).toBe("Couldn't read this run")
  })
})

describe("a repository's run", () => {
  test("Stop while it runs and no stop was asked; nothing else, on Cloudflare", () => {
    const live = inspection({ run: run({ runId: "ci:1", status: "running", finishedAtMs: null }) })
    expect(actsOf(live, 1_000 + STALLED_AFTER_MS, undefined, true)).toEqual({ stop: true, retry: false, resume: false })
    const asked = inspection({ run: run({ runId: "ci:1", status: "running", cancelRequestedAtMs: 1_500 }) })
    expect(actsOf(asked, 0, undefined, true).stop).toBe(false)
    expect(actsOf(inspection({ run: run({ runId: "ci:1" }) }), 0, undefined, true).stop).toBe(false)
    // A job stops with its run: its own page offers no Stop.
    const job = inspection({ run: run({ runId: "job-1", parentRunId: "ci:1", status: "running", finishedAtMs: null }) })
    expect(actsOf(job, 0, undefined, true).stop).toBe(false)
    expect(hostOf("ci:1", true)).toBe("Cloud")
    expect(missingOf({ id: "ci:1", state: "not_found" }, true)).toBe("Not found")
  })

  const repoRun = (overrides: Partial<RepoRunRow>): RepoRunRow => ({
    id: "row-1",
    repoId: "github/octo/hello",
    execution: "ci:1",
    flow: "ci",
    status: "working",
    sha: "a".repeat(40),
    ref: "main",
    event: "push",
    createdAt: "2026-10-22 10:00:00+00",
    updatedAt: "2026-10-22 10:00:05+00",
    ...overrides,
  })

  test("the repository's list: its runs only, newest first, each its flow and ref, its state and its page", () => {
    const rows = [
      repoRun({ id: "old", execution: "ci:old", status: "done", createdAt: "2026-10-22 09:00:00+00", updatedAt: "2026-10-22 09:01:00+00" }),
      repoRun({ id: "new", execution: "release:new", flow: "release", ref: "v1.2.0" }),
      repoRun({ id: "failed", execution: "ci:failed", status: "failed", createdAt: "2026-10-22T09:30:00Z" }),
      repoRun({ id: "stopped", execution: "ci:stopped", status: "stopped", createdAt: "2026-10-22 09:15:00+00" }),
      repoRun({ id: "other", repoId: "github/octo/other" }),
    ]
    expect(repoRunRows(rows, "Octo", "Hello")).toEqual([
      { id: "new", flow: "release · v1.2.0", state: "running", startedAtMs: Date.parse("2026-10-22T10:00:00+00:00"), finishedAtMs: null, href: "/Octo/Hello/actions/runs/release%3Anew" },
      { id: "failed", flow: "ci · main", state: "failed", startedAtMs: Date.parse("2026-10-22T09:30:00Z"), finishedAtMs: Date.parse("2026-10-22T10:00:05+00:00"), href: "/Octo/Hello/actions/runs/ci%3Afailed" },
      { id: "stopped", flow: "ci · main", state: "cancelled", startedAtMs: Date.parse("2026-10-22T09:15:00+00:00"), finishedAtMs: Date.parse("2026-10-22T10:00:05+00:00"), href: "/Octo/Hello/actions/runs/ci%3Astopped" },
      { id: "old", flow: "ci · main", state: "completed", startedAtMs: Date.parse("2026-10-22T09:00:00+00:00"), finishedAtMs: Date.parse("2026-10-22T09:01:00+00:00"), href: "/Octo/Hello/actions/runs/ci%3Aold" },
    ])
    // At most ACTIONS_LIMIT, the newest.
    const many = Array.from({ length: ACTIONS_LIMIT + 5 }, (_, i) =>
      repoRun({ id: `r${i}`, createdAt: new Date(Date.UTC(2026, 9, 22, 0, 0, i)).toISOString() }))
    const shown = repoRunRows(many, "octo", "hello")
    expect([shown.length, shown[0]!.id]).toEqual([ACTIONS_LIMIT, `r${ACTIONS_LIMIT + 4}`])
  })

  test("a repository's runs have loaded only once its own id is among the loaded, whatever the case of its name", () => {
    expect(repoRunsLoaded([], "octo", "hello")).toBe(false)
    expect(repoRunsLoaded([{ id: "github/octo/other" }], "octo", "hello")).toBe(false)
    expect(repoRunsLoaded([{ id: "github/octo/other" }, { id: "github/octo/hello" }], "Octo", "HELLO")).toBe(true)
  })
})

describe("the list", () => {
  const row = (overrides: Partial<RunRow>): RunRow => ({
    id: "a",
    flow: "flow/run",
    status: "completed",
    cancelRequested: false,
    createdAtMs: 1,
    startedAtMs: null,
    finishedAtMs: null,
    seq: 0,
    ...overrides,
  })

  test("work only, newest first, each linking its page", () => {
    expect(listRows([row({ id: "a", createdAtMs: 1 }), row({ id: "b", createdAtMs: 2, startedAtMs: 3 }), row({ id: "c", flow: "run/retry" })]))
      .toEqual([
        { id: "b", flow: "flow/run", state: "completed", cancelRequested: false, startedAtMs: 3, finishedAtMs: null, href: "/app/runs/b", branch: null, expanded: false, toggleHref: "/app/runs?open=b" },
        { id: "a", flow: "flow/run", state: "completed", cancelRequested: false, startedAtMs: 1, finishedAtMs: null, href: "/app/runs/a", branch: null, expanded: false, toggleHref: "/app/runs?open=a" },
      ])
  })

  const cloud = (runId: string, overrides: Partial<CloudRun> = {}): CloudRun => ({
    runId, flow: "todo", kind: "todo", status: "running", cancelRequested: false, createdAtMs: 5, startedAtMs: 6, finishedAtMs: null,
    trigger: "commit", branch: "todo/fix", actor: "maya", repo: "octo/hello", ...overrides,
  })

  test("like a CI system's runs: this device's beside Cloudflare's, newest first, with trigger, branch and actor", () => {
    const rows = listRows(
      [
        row({ id: "theme", flow: "app/theme/set", createdAtMs: 1, origin: { door: "button", actor: "person" } }),
        row({ id: "answer", flow: "chat/Answer", createdAtMs: 7, origin: { door: "composer", actor: "agent" } }),
        row({ id: "old", createdAtMs: 0, origin: { door: "unknown", actor: "unknown" } }),
      ],
      [
        cloud("todo:a", { createdAtMs: 9 }),
        cloud("ci:1", { kind: "repo", flow: "ci", trigger: "pull_request", branch: "main", actor: "github", createdAtMs: 3 }),
        cloud("spend-1", { kind: "system", flow: "ops/SpendAlert", trigger: "system", branch: null, actor: null, repo: null, createdAtMs: 2, startedAtMs: null, status: "pending" }),
      ],
    )
    // A run the engine hasn't begun counts from when it was recorded.
    expect(rows.find((run) => run.id === "spend-1")).toMatchObject({ state: "pending", startedAtMs: 2 })
    expect(rows.map((run) => [run.id, run.trigger, run.branch, run.actor, run.where, run.href])).toEqual([
      ["todo:a", "commit", "todo/fix", "maya", undefined, "/app/runs/todo%3Aa"],
      ["answer", "composer", null, "agent", undefined, "/app/runs/answer"],
      ["ci:1", "pull request", "main", "github", undefined, "/octo/hello/actions/runs/ci%3A1?from=runs"],
      ["spend-1", "system", null, null, undefined, "/app/runs/spend-1"],
      ["theme", "button", null, "you", undefined, "/app/runs/theme"],
      ["old", undefined, null, undefined, undefined, "/app/runs/old"],
    ])
  })

  test("one flow's runs, and one run opened in place: its toggle closes it, every other opens its own", () => {
    const rows = listRows(
      [row({ id: "a", flow: "flow/run", createdAtMs: 1 }), row({ id: "b", flow: "app/theme/set", createdAtMs: 2 })],
      [cloud("todo:c", { createdAtMs: 3 })],
      { flow: "flow/run", open: "a" },
    )
    expect(rows.map((run) => [run.id, run.expanded, run.toggleHref])).toEqual([["a", true, "/app/runs?flow=flow%2Frun"]])
    expect(listRows([row({ id: "a" })], [], { open: "b" })[0]).toMatchObject({ expanded: false, toggleHref: "/app/runs?open=a" })
    expect(listRows([row({ id: "a" })], [], { open: "a" })[0]).toMatchObject({ expanded: true, toggleHref: "/app/runs" })
  })

  test("the words and addresses the list uses", () => {
    expect(deviceTrigger({ id: "retry:x:1/run", origin: { door: "flow", actor: "person" } })).toBe("retry")
    expect(deviceTrigger({ id: "x", origin: null })).toBeUndefined()
    expect(deviceTrigger({ id: "x" })).toBeUndefined()
    expect(deviceActor({ origin: { door: "sync", actor: "app" } })).toBe("app")
    expect(deviceActor({ origin: { door: "x", actor: "other" } })).toBeUndefined()
    expect(cloudHref({ runId: "ci:1", kind: "repo", repo: null })).toBe("/app/runs/ci%3A1")
    // The page says it has no runs only once both lists have answered.
    expect([listLoaded(undefined), listLoaded({ listLoaded: true }), listLoaded({ cloudLoaded: true }), listLoaded({ listLoaded: true, cloudLoaded: true })])
      .toEqual([false, false, false, true])
    expect(runsSearch({ flow: "todo", open: "todo:1", other: "x" })).toEqual({ flow: "todo", open: "todo:1" })
    expect(runsSearch({ flow: "", open: 7 })).toEqual({})
    expect(runsSearch({ flow: "x".repeat(257), open: "y".repeat(513) })).toEqual({})
    expect(listHref({})).toBe("/app/runs")
    expect(listHref({ flow: "todo", open: "todo:1" })).toBe("/app/runs?flow=todo&open=todo%3A1")
    expect(cloudRowOf(cloud("todo:a", { status: "failed", finishedAtMs: 8 }))).toEqual({
      id: "todo:a", flow: "todo", status: "failed", cancelRequested: false, createdAtMs: 5, startedAtMs: 6, finishedAtMs: 8, seq: -1,
    })
  })

  test("shows an inspected answer or draft's failed work in its list row", () => {
    expect(listRows([
      row({ id: "answer", flow: "chat/Answer", outcome: "failed" }),
      row({ id: "draft", flow: "flow/new", outcome: "failed" }),
      row({ id: "unread", flow: "chat/Answer", outcome: "unknown" }),
    ]).map(({ id, state }) => ({ id, state }))).toEqual([
      { id: "answer", state: "failed" },
      { id: "draft", state: "failed" },
      { id: "unread", state: "completed" },
    ])
  })

  test("counts a run's retries from this device", () => {
    expect(retriesOf([row({ id: "retry:a:1", flow: "run/retry" }), row({ id: "retry:a:2", flow: "run/retry" }), row({ id: "retry:b:1", flow: "run/retry" })], "a"))
      .toBe(2)
    // Retry from here numbers with Retry.
    expect(retriesOf([row({ id: "retry:a:1", flow: "run/retry" }), row({ id: "retry:a:2", flow: "run/retry/from" })], "a")).toBe(2)
  })
})


test("stall detection uses the latest event from More as well as the first journal page", () => {
  const live = inspection({ run: run({ status: "running", finishedAtMs: null }) })
  const page = { id: "run-1", state: "read" as const, inspection: live, more: [{ seq: 501, eventType: "flows.engine.node-scheduled", emittedAtMs: 50_000, payload: value("{}") }], hasMore: false }
  expect(actsOf(live, 61_000, journalOf(page)).resume).toBe(false)
  expect(actsOf(live, 50_000 + STALLED_AFTER_MS, journalOf(page)).resume).toBe(true)
})

test("failed system TODO runs have Retry while remote running TODOs do not", () => {
  const input = { repoId: "github/octo/hello", number: 1 }
  const base = { runId: "todo:12345678-1234-1234-1234-123456789abc", flowName: "todo", input: value(JSON.stringify(input)), status: "running", result: null }
  const inspection = { run: base, journal: { events: [] } } as unknown as Parameters<typeof actsOf>[0]
  expect(actsOf(inspection, 0).retry).toBe(false)
  expect(actsOf({ ...inspection, run: { ...inspection.run, status: "completed", result: value(JSON.stringify({ state: "failed" })) } }, 0).retry).toBe(true)
  expect(actsOf({ ...inspection, run: { ...inspection.run, status: "completed", result: value(JSON.stringify({ state: "merged" })) } }, 0).retry).toBe(false)
})

test("only the known Runs origin survives search decoding", () => {
  expect(runOriginSearch({ from: "runs" })).toEqual({ from: "runs" })
  for (const from of [undefined, "other", "/external", 7]) expect(runOriginSearch({ from })).toEqual({})
})

test("cloud and repository rows strip transport prefixes from branch names", () => {
  const cloud: CloudRun = { runId: "ci:prefix", flow: "ci", kind: "repo", status: "completed", cancelRequested: false,
    createdAtMs: 1, startedAtMs: 1, finishedAtMs: 2, trigger: "push", branch: "refs/heads/feature/a", actor: "you", repo: "octo/hello" }
  expect(listRows([], [cloud])[0]!.branch).toBe("feature/a")
  expect(listRows([], [cloud])[0]!.where).toBeUndefined()
})

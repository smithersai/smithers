/*
 * The dev fixture seam (UI-COMMON "Rules": never in the product path). Two
 * things have to hold: the flag is OFF unless something explicitly turned it
 * on, and what the seam offers, it can answer — a history row the replay
 * route then refuses is a dead end in the card.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { criticalPath } from "@smthrs/rpc/TargetGraph"
import {
  createTargetGraphDevFixtures,
  fixtureRunEvents,
  fixtureRunLabels,
  fixtureTargetGraph,
  TARGET_GRAPH_FIXTURE_FLAG,
  targetGraphFixturesEnabled
} from "./fixtureRunStream"

GlobalRegistrator.register()

afterEach(() => {
  localStorage.removeItem(TARGET_GRAPH_FIXTURE_FLAG)
})

afterAll(async () => {
  for (let tick = 0; tick < 3; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0))
  await GlobalRegistrator.unregister()
})

const enabled = () => {
  localStorage.setItem(TARGET_GRAPH_FIXTURE_FLAG, "1")
  const fixtures = createTargetGraphDevFixtures()
  if (fixtures === undefined) throw new Error("the flag is on; the seam should exist")
  return fixtures
}

describe("the target-graph dev fixtures", () => {
  test("the seam is absent unless the flag is explicitly on", () => {
    expect(targetGraphFixturesEnabled()).toBe(false)
    expect(createTargetGraphDevFixtures()).toBeUndefined()
    localStorage.setItem(TARGET_GRAPH_FIXTURE_FLAG, "0")
    expect(createTargetGraphDevFixtures()).toBeUndefined()
  })

  /*
   * The defect this guards: the seam also read
   * `import.meta.env.SMITHERS_TARGET_GRAPH_FIXTURES`, a name no build ever
   * populates (vite.config.ts sets no `envPrefix`, so Vite copies only
   * `VITE_` names onto `import.meta.env`). The switch was dead in the app and
   * live only under a runtime that aliases `import.meta.env` to
   * `process.env`, where a stray variable turned the fixtures on. The
   * localStorage flag is the one opt-in.
   */
  test("no environment variable can turn the seam on", () => {
    process.env.SMITHERS_TARGET_GRAPH_FIXTURES = "1"
    process.env.VITE_SMITHERS_TARGET_GRAPH_FIXTURES = "1"
    try {
      /* The control: this runtime really does expose the variable to the module. */
      expect(import.meta.env?.SMITHERS_TARGET_GRAPH_FIXTURES).toBe("1")
      expect(targetGraphFixturesEnabled()).toBe(false)
      expect(createTargetGraphDevFixtures()).toBeUndefined()
    } finally {
      delete process.env.SMITHERS_TARGET_GRAPH_FIXTURES
      delete process.env.VITE_SMITHERS_TARGET_GRAPH_FIXTURES
    }
  })

  test("the graph is the captured force workspace: 82 nodes, 94 edges", () => {
    expect(enabled().graph("force").nodes.length).toBe(82)
    expect(fixtureTargetGraph("force").edges.length).toBe(94)
  })

  /*
   * The defect this guards: history listed a run id that replay answered
   * `undefined` for, so selecting the only row in the card did nothing.
   */
  test("every run the history offers is replayable", () => {
    const fixtures = enabled()
    const runs = fixtures.history("force").runs
    expect(runs.length).toBeGreaterThan(0)
    for (const run of runs) {
      const replay = fixtures.replay(run.runId)
      expect(replay).toBeDefined()
      expect(replay?.run.runId).toBe(run.runId)
      expect(replay?.events.length).toBeGreaterThan(0)
      /* The row's own totals are the recording's, not a second story. */
      expect(replay?.run.summary).toEqual(run.summary)
      expect(replay?.run.startedAt).toBe(run.startedAt)
    }
  })

  test("an unrecorded run id stays honestly undefined", () => {
    expect(enabled().replay("no-such-run")).toBeUndefined()
  })

  test("the scripted stream emits started → node → summary, in order", async () => {
    const fixtures = enabled()
    const frames: Array<string> = []
    await new Promise<void>((resolve) => {
      const cancel = fixtures.streamRun("dev-run-1", "//:prePush", (frame) => {
        frames.push(frame.type)
        if (frame.type === "summary") {
          cancel()
          resolve()
        }
      }, 0)
    })
    expect(frames[0]).toBe("started")
    expect(frames.at(-1)).toBe("summary")
    expect(frames).toContain("node")
    /* Every node settles: pending → running → a terminal status. */
    expect(frames.filter((type) => type === "node").length % 3).toBe(0)
  })

  test("the scripted run's summary carries the critical path of its own timings", () => {
    const graph = fixtureTargetGraph("force")
    const events = fixtureRunEvents(graph, { runId: "r", root: "//:prePush", base: 1_000 })
    const summary = events.find((event) => event.type === "summary")
    if (summary?.type !== "summary") throw new Error("expected a summary frame")
    expect(summary.summary.total).toBe(fixtureRunLabels(graph, "//:prePush").length)
    expect(summary.summary.hit + summary.summary.ran + summary.summary.failed).toBe(summary.summary.total)
    const timings = events.flatMap((event) =>
      event.type === "node" && event.node.endedAt !== undefined ? [event.node] : []
    )
    expect(summary.summary.criticalPath).toEqual([...criticalPath(timings, graph.edges)])
  })
})

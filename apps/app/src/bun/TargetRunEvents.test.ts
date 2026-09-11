import { describe, expect, test } from "bun:test"
import { createRunStdoutParser } from "./Targets"

describe("run stdout parser", () => {
  test("parses every status, reasons, keys, summary, and ignores interleaved stderr", () => {
    const parser = createRunStdoutParser({ startedAt: 1_000, edges: [{ from: "//:root", to: "//:dep", kind: "data" }] })
    expect(parser.push("stdout", "//:dep  pending\n//:dep  running key=abc\n", 1_100)).toHaveLength(2)
    expect(parser.push("stderr", "compiler chatter\n", 1_101)).toEqual([])
    const events = parser.push("stdout", [
      "//:dep hit 20ms key=abc",
      "//:root ran 50ms",
      "//:bad failed 3ms compiler exploded",
      "//:skip skipped 1ms dependency failed",
      "//:no refused 2ms approval required",
      "//:cancel cancelled 1ms",
      "6 targets: 1 hit, 1 ran, 1 failed, 1 skipped, 1 refused (75ms)",
      ""
    ].join("\n"), 1_200)
    const nodes = events.filter((event) => event.type === "node").map((event) => event.node)
    expect(nodes.map((node) => node.status)).toEqual(["hit", "ran", "failed", "skipped", "refused", "cancelled"])
    expect(nodes.find((node) => node.status === "failed")?.reason).toBe("compiler exploded")
    expect(events.find((event) => event.type === "summary" && event.summary.total === 6)).toBeDefined()
    for (const node of nodes) {
      expect(node.durationMs).toBeDefined()
      expect(node.durationMs).toBe((node.endedAt ?? 0) - (node.startedAt ?? 0))
    }
  })

  test("settled rows without an executor duration still get an exact wall duration", () => {
    const parser = createRunStdoutParser({ startedAt: 1_000 })
    parser.push("stdout", "//:test running\n", 1_100)
    const event = parser.push("stdout", "//:test ran\n", 1_175)[0]
    expect(event?.type).toBe("node")
    if (event?.type !== "node") throw new Error("expected node event")
    expect(event.node).toMatchObject({ startedAt: 1_100, endedAt: 1_175, durationMs: 75 })
  })

  test("computes the critical path from graph edges and fixture timings", () => {
    const parser = createRunStdoutParser({ startedAt: 0, edges: [
      { from: "//:root", to: "//:slow", kind: "data" },
      { from: "//:root", to: "//:fast", kind: "data" }
    ] })
    const events = parser.push("stdout", "//:slow ran 90ms\n//:fast hit 5ms\n//:root ran 10ms\n3 targets: 1 hit, 2 ran (100ms)\n", 100)
    const summary = events.find((event) => event.type === "summary")
    expect(summary?.type === "summary" ? summary.summary.criticalPath : []).toEqual(["//:slow", "//:root"])
  })
})

/*
 * The stable-line parsers the backend maps the CLI onto, at their edges
 * (docs/LOCAL-APP.md "Cards: target graph"). The authors' suites cover the
 * shapes the force workspace happens to print; these are the shapes a
 * different workspace prints — labels with dashes and slashes, private
 * helpers, a refusal whose text carries colons, an all-zero summary, stdout
 * and stderr interleaved mid-line — plus the graph parser's cycles and
 * self-loops, which `reachable` has to survive.
 */
import { expect, test } from "bun:test"
import { criticalPath, reachable } from "@smthrs/rpc/TargetGraph"
import { createRunStdoutParser } from "./Targets"
import { parseTextGraph as parseGraph } from "./TargetGraph"

const BASE = 1_700_000_000_000

test("labels with dashes, dots and nested packages parse into nodes and edges", () => {
  const text = [
    "//packages/smithers/build/build-cli:type-check",
    "  -deps-> //packages/smithers/build/build-cli:srcs",
    "  -data-> //packages/smithers/build/targets/src:schema.v2",
    "//packages/smithers/build/build-cli:srcs",
    "//packages/smithers/build/targets/src:schema.v2"
  ].join("\n")
  const { nodes, edges } = parseGraph(text)
  expect(nodes.map((node) => node.label).sort()).toEqual([
    "//packages/smithers/build/build-cli:srcs",
    "//packages/smithers/build/build-cli:type-check",
    "//packages/smithers/build/targets/src:schema.v2"
  ])
  expect(edges).toEqual([
    { from: "//packages/smithers/build/build-cli:type-check", to: "//packages/smithers/build/build-cli:srcs", kind: "deps" },
    { from: "//packages/smithers/build/build-cli:type-check", to: "//packages/smithers/build/targets/src:schema.v2", kind: "data" }
  ])
  /* The package/name split has to survive a nested path and a dotted name. */
  const deep = nodes.find((node) => node.label === "//packages/smithers/build/targets/src:schema.v2")
  expect(deep).toMatchObject({ package: "//packages/smithers/build/targets/src", name: "schema.v2" })
})

test("a private helper is flagged, and only by its name prefix", () => {
  const text = "//src:build\n  -deps-> //src:__private_Overlay_4\n//src:__private_Overlay_4\n//src:not__private_x\n"
  const nodes = parseGraph(text).nodes
  expect(nodes.find((node) => node.label === "//src:__private_Overlay_4")?.private).toBe(true)
  /* The prefix has to be at the START of the name, not anywhere in it. */
  expect(nodes.find((node) => node.label === "//src:not__private_x")?.private).toBe(false)
  expect(nodes.find((node) => node.label === "//src:build")?.private).toBe(false)
})

test("a node named by a row but absent from the text graph still becomes a node", () => {
  const { nodes } = parseGraph("//src:build\n", [
    { label: "//src:build", target: "Shell.Build", kinds: ["build"] },
    { label: "//src:orphan", target: "Filegroup", kinds: [] }
  ])
  expect(nodes.map((node) => node.label).sort()).toEqual(["//src:build", "//src:orphan"])
  /* `rule` falls back to `target` when the row does not carry `rule`. */
  expect(nodes.find((node) => node.label === "//src:build")?.rule).toBe("Shell.Build")
  /* A node with no row at all gets an empty rule, never `undefined`. */
  expect(parseGraph("//src:lonely\n").nodes[0]?.rule).toBe("")
})

test("an edge line before any label, and unknown edge kinds, are ignored", () => {
  const { nodes, edges } = parseGraph("  -deps-> //src:orphan\n//src:build\n  -bogus-> //src:x\n")
  expect(edges).toEqual([])
  /* The dangling edge's target is not invented as a node either. */
  expect(nodes.map((node) => node.label)).toEqual(["//src:build"])
})

test("a graph with a cycle and a self-loop is walked without hanging", () => {
  const text = "//a:x\n  -deps-> //b:y\n//b:y\n  -deps-> //a:x\n  -deps-> //b:y\n"
  const { edges } = parseGraph(text)
  expect(edges.length).toBe(3)
  /* A cycle returns to the start label, which is what puts it in the set. */
  expect([...reachable(edges, "//a:x", "deps")].sort()).toEqual(["//a:x", "//b:y"])
  expect([...reachable(edges, "//b:y", "rdeps")].sort()).toEqual(["//a:x", "//b:y"])
  /* A self-loop alone reaches only itself. */
  expect([...reachable([{ from: "//b:y", to: "//b:y", kind: "deps" }], "//b:y", "deps")]).toEqual(["//b:y"])
  /* An unknown label reaches nothing rather than throwing. */
  expect([...reachable(edges, "//nope:missing", "deps")]).toEqual([])
  /* And the critical path terminates on the same cycle. */
  const path = criticalPath(
    [{ label: "//a:x", status: "ran", durationMs: 10 }, { label: "//b:y", status: "ran", durationMs: 20 }],
    edges
  )
  expect(new Set(path).size).toBe(path.length)
})

test("a refusal whose text carries colons keeps the whole reason", () => {
  const parser = createRunStdoutParser({ startedAt: BASE })
  const reason = "Github.CiGen: approval required: run with --write"
  const events = parser.push("stdout", `//.github:github  refused  ${reason}\n`, BASE + 5)
  expect(events.length).toBe(1)
  expect(events[0]).toMatchObject({ type: "node", node: { label: "//.github:github", status: "refused", reason } })
  /* A refusal is settled, so it gets an end and, per the contract, a duration: zero wall time. */
  expect((events[0] as { node: { endedAt?: number; durationMs?: number } }).node.endedAt).toBe(BASE + 5)
  expect((events[0] as { node: { durationMs?: number } }).node.durationMs).toBe(0)
})

test("a failure line keeps its reason and a skip keeps its cause", () => {
  const parser = createRunStdoutParser({ startedAt: BASE })
  const failed = parser.push("stdout", "//src:typeCheck  failed  2.5s  tsc exited 2: 3 errors\n", BASE + 2500)
  expect(failed[0]).toMatchObject({
    type: "node",
    node: { label: "//src:typeCheck", status: "failed", durationMs: 2500, reason: "tsc exited 2: 3 errors" }
  })
  const skipped = parser.push("stdout", "//src:lint  skipped  a dependency failed\n", BASE + 2600)
  expect(skipped[0]).toMatchObject({ node: { status: "skipped", reason: "a dependency failed" } })
  /* A successful node's trailing detail is NOT a reason: nothing went wrong. */
  const ran = parser.push("stdout", "//src:build  ran  1.0s  key=abc123\n", BASE + 3600)
  expect(ran[0]).toMatchObject({ node: { status: "ran", key: "abc123" } })
  expect((ran[0] as { node: { reason?: string } }).node.reason).toBeUndefined()
})

test("a summary of an all-zero run reports zero totals and stays ok", () => {
  const parser = createRunStdoutParser({ startedAt: BASE })
  const events = parser.push("stdout", "0 targets: 0 hit, 0 ran, 0 failed, 0 skipped (0ms)\n", BASE + 1)
  expect(events[0]).toMatchObject({
    type: "summary",
    summary: { total: 0, hit: 0, ran: 0, failed: 0, skipped: 0, durationMs: 0, ok: true, criticalPath: [] }
  })
  expect(parser.summary()?.ok).toBe(true)
})

test("a summary counts refusals as failures and goes not-ok", () => {
  const parser = createRunStdoutParser({ startedAt: BASE })
  parser.push("stdout", "//a:x  refused  no approval\n", BASE + 1)
  const events = parser.push("stdout", "3 targets: 1 hit, 0 ran, 1 failed, 0 skipped, 1 refused (2.0s)\n", BASE + 2000)
  expect(events[0]).toMatchObject({ type: "summary", summary: { total: 3, failed: 2, ok: false, durationMs: 2000 } })
})

test("a summary with no elapsed clause falls back to the wall clock", () => {
  const parser = createRunStdoutParser({ startedAt: BASE })
  const events = parser.push("stdout", "1 targets: 1 hit, 0 ran, 0 failed, 0 skipped\n", BASE + 1234)
  expect(events[0]).toMatchObject({ type: "summary", summary: { durationMs: 1234 } })
})

test("stdout and stderr are buffered apart, so interleaving cannot corrupt a line", () => {
  const parser = createRunStdoutParser({ startedAt: BASE })
  /* The status line arrives split around a stderr write, as a real pty does. */
  expect(parser.push("stdout", "//src:type", BASE)).toEqual([])
  expect(parser.push("stderr", "warning: peer dep\n", BASE)).toEqual([])
  expect(parser.push("stdout", "Check  ran  1.5s\n", BASE + 1500)).toMatchObject([
    { type: "node", node: { label: "//src:typeCheck", status: "ran", durationMs: 1500 } }
  ])
})

test("a final line with no newline is flushed on finish, once", () => {
  const parser = createRunStdoutParser({ startedAt: BASE })
  parser.push("stdout", "//src:build  ran  1ms", BASE)
  const flushed = parser.finish(BASE + 1)
  expect(flushed).toMatchObject([{ type: "node", node: { label: "//src:build", status: "ran" } }])
  /* The buffers are cleared, so a second finish emits nothing. */
  expect(parser.finish(BASE + 2)).toEqual([])
  expect(parser.timings().length).toBe(1)
})

test("a running node keeps the start it was first seen with when it settles", () => {
  const parser = createRunStdoutParser({ startedAt: BASE })
  parser.push("stdout", "//src:build  running\n", BASE + 100)
  const settled = parser.push("stdout", "//src:build  ran  5.0s\n", BASE + 5100)
  /* Without the carry, a 5s node would claim it started 5s before it did. */
  expect(settled[0]).toMatchObject({ node: { startedAt: BASE + 100, endedAt: BASE + 5100, durationMs: 5000 } })
})

test("a pending node has no start and no end until it runs", () => {
  const parser = createRunStdoutParser({ startedAt: BASE })
  const pending = parser.push("stdout", "//src:build  pending\n", BASE)
  const node = (pending[0] as { node: { startedAt?: number; endedAt?: number } }).node
  expect(node.startedAt).toBeUndefined()
  expect(node.endedAt).toBeUndefined()
})

test("a JSON envelope on stdout wins over the text line parser", () => {
  const parser = createRunStdoutParser({
    startedAt: BASE,
    edges: [{ from: "//src:typeCheck", to: "//src:srcs", kind: "deps" }]
  })
  const envelope = JSON.stringify({
    targets: [
      { label: "//src:srcs", status: "ran", durationMs: 5 },
      { label: "//src:typeCheck", status: "hit", startedAt: BASE + 10, endedAt: BASE + 16, durationMs: 6, key: "k1" },
      { label: "//src:bogus", status: "not-a-status" },
      { label: 42, status: "ran" },
      "not an object"
    ]
  })
  const events = parser.push("stdout", `${envelope}\n`, BASE + 20)
  /* Rows with an unknown status or a non-string label are dropped, not guessed. */
  expect(events.map((event) => (event as { node: { label: string } }).node.label))
    .toEqual(["//src:srcs", "//src:typeCheck"])
  /* A row with only a duration gets its start derived from the frame's clock. */
  expect(events[0]).toMatchObject({ node: { startedAt: BASE + 15, endedAt: BASE + 20, durationMs: 5 } })
  expect(criticalPath(parser.timings(), [{ from: "//src:typeCheck", to: "//src:srcs", kind: "deps" }]))
    .toEqual(["//src:srcs", "//src:typeCheck"])
})

test("a JSON line that is not an envelope falls through to the line parser", () => {
  const parser = createRunStdoutParser({ startedAt: BASE })
  expect(parser.push("stdout", "{not json\n", BASE)).toEqual([])
  expect(parser.push("stdout", `${JSON.stringify({ hello: "world" })}\n`, BASE)).toEqual([])
  expect(parser.push("stdout", `${JSON.stringify(null)}\n`, BASE)).toEqual([])
  expect(parser.push("stdout", `${JSON.stringify({ targets: [] })}\n`, BASE)).toEqual([])
  /* A plain log line is not a node frame either. */
  expect(parser.push("stdout", "building 3 targets…\n", BASE)).toEqual([])
})

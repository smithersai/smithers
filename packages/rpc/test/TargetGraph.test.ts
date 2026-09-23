import { readFileSync } from "node:fs"
import { describe, expect, test } from "vitest"
import {
  AffectedCardPayloadSchema,
  AffectedResponseSchema,
  CiMatrixCardPayloadSchema,
  CiMatrixResponseSchema,
  criticalPath,
  GRAPH_EDGE_KINDS,
  GraphCardPayloadSchema,
  type GraphEdge,
  GraphEdgeKindSchema,
  GraphEdgeSchema,
  GraphNodeSchema,
  NODE_RUN_STATUSES,
  type NodeTiming,
  NodeTimingSchema,
  reachable,
  RunHistoryCardPayloadSchema,
  RunHistoryResponseSchema,
  RunRecordSchema,
  RunReplayResponseSchema,
  RunSummarySchema,
  RunTimelineCardPayloadSchema,
  TargetGraphResponseSchema,
  TargetRunEventSchema
} from "../src/TargetGraph.ts"

/*
 * The fixtures are the CLI's real envelopes captured from `~/artsy/force`
 * (82 targets, 94 edges). `graph.json`'s `graph` field is the text rendering;
 * the backend lane owns the production parser, so the two-rule reader below
 * stays local to this file: it exists to prove the helpers against real edges,
 * not to become a module.
 */
const fixture = (name: string): any =>
  JSON.parse(readFileSync(new URL(`../fixtures/force/${name}`, import.meta.url), "utf8"))

const graphFixture = fixture("graph.json")
const planFixture = fixture("plan-typeCheck.json")

const parseGraphText = (text: string): Array<GraphEdge> => {
  const edges: Array<GraphEdge> = []
  let from = ""
  for (const line of text.split("\n")) {
    if (line.length === 0) continue
    const edge = /^\s+-([a-z]+)->\s+(\S+)$/.exec(line)
    if (edge === null) {
      from = line.trim()
      continue
    }
    edges.push({ from, to: edge[2]!, kind: GraphEdgeKindSchema.parse(edge[1]) })
  }
  return edges
}

const forceEdges = parseGraphText(graphFixture.graph)

/** A settled timing row; `durationMs` left off means the run reported none. */
const timing = (label: string, durationMs?: number): NodeTiming => ({ label, status: "ran", durationMs })
const dep = (from: string, to: string): GraphEdge => ({ from, to, kind: "deps" })

describe("the fixture the contract was drawn from", () => {
  test("the text graph reads back as the envelope's own edge list: 82 nodes, 94 edges", () => {
    expect(graphFixture.roots).toHaveLength(82)
    expect(forceEdges).toHaveLength(94)
    expect(forceEdges).toEqual(graphFixture.edges)
    expect(new Set(forceEdges.map((edge) => edge.kind))).toEqual(new Set(["data", "gates", "services"]))
  })
})

describe("GraphNodeSchema", () => {
  const node = {
    label: "//src:typeCheck",
    package: "//src",
    name: "typeCheck",
    rule: "Shell.Test",
    kinds: ["test"],
    plan: {
      mode: "execute",
      cacheable: true,
      key: planFixture.targets[0].key,
      argv: planFixture.targets[0].argv,
      sandbox: "workspace",
      outDirs: ["dist"],
      outFiles: ["tsconfig.tsbuildinfo"]
    },
    source: { file: "src/PACKAGE.ts", line: 42 }
  }

  test("parses a fixture-shaped node and defaults `private` to false", () => {
    const parsed = GraphNodeSchema.parse(node)
    expect(parsed.private).toBe(false)
    expect(parsed.plan?.key).toBe(planFixture.targets[0].key)
    expect(parsed.plan?.argv).toEqual(planFixture.targets[0].argv)
    expect(parsed.plan?.argv?.[0]).toContain("node_modules/.bin/tsc")
    expect(parsed.source).toEqual({ file: "src/PACKAGE.ts", line: 42 })
  })

  test("parses the minimum the loader can emit: no kinds, no plan, no source", () => {
    const parsed = GraphNodeSchema.parse({
      label: "//:claudeMd",
      package: "//",
      name: "claudeMd",
      rule: "Filegroup",
      kinds: []
    })
    expect(parsed).toEqual({
      label: "//:claudeMd",
      package: "//",
      name: "claudeMd",
      rule: "Filegroup",
      kinds: [],
      private: false
    })
  })

  test("carries a private helper node and a plan-time refusal", () => {
    const parsed = GraphNodeSchema.parse({
      label: "//src:__private_Overlay_4",
      package: "//src",
      name: "__private_Overlay_4",
      rule: "Overlay",
      kinds: [],
      private: true,
      plan: { mode: "check", cacheable: false, refusal: "host bin absent: go" }
    })
    expect(parsed.private).toBe(true)
    expect(parsed.plan?.refusal).toBe("host bin absent: go")
  })

  test("refuses a missing label, a non-array `kinds`, a wrong plan mode, and a non-boolean cacheable", () => {
    expect(GraphNodeSchema.safeParse({ package: "//src", name: "x", rule: "R", kinds: [] }).success).toBe(false)
    expect(GraphNodeSchema.safeParse({ ...node, kinds: "test" }).success).toBe(false)
    expect(GraphNodeSchema.safeParse({ ...node, plan: { mode: "build" } }).success).toBe(false)
    expect(GraphNodeSchema.safeParse({ ...node, plan: { cacheable: "yes" } }).success).toBe(false)
    expect(GraphNodeSchema.safeParse({ ...node, source: { line: 3 } }).success).toBe(false)
    expect(GraphNodeSchema.safeParse({ ...node, source: { file: "p.ts", line: "3" } }).success).toBe(false)
  })
})

describe("GraphEdgeSchema", () => {
  test("parses every declared kind and every edge the fixture renders", () => {
    for (const kind of GRAPH_EDGE_KINDS) {
      expect(GraphEdgeSchema.parse({ from: "//a:a", to: "//b:b", kind })).toEqual({ from: "//a:a", to: "//b:b", kind })
    }
    for (const edge of forceEdges) expect(GraphEdgeSchema.safeParse(edge).success).toBe(true)
  })

  test("refuses an unknown kind and a missing endpoint", () => {
    expect(GraphEdgeSchema.safeParse({ from: "//a:a", to: "//b:b", kind: "needs" }).success).toBe(false)
    expect(GraphEdgeSchema.safeParse({ from: "//a:a", kind: "data" }).success).toBe(false)
    expect(GraphEdgeKindSchema.safeParse("DATA").success).toBe(false)
  })
})

describe("TargetGraphResponseSchema", () => {
  const response = {
    repoId: "force",
    nodes: graphFixture.targets.map((target: { label: string; target: string }) => ({
      label: target.label,
      package: target.label.slice(0, target.label.indexOf(":")),
      name: target.label.slice(target.label.indexOf(":") + 1),
      rule: target.target,
      kinds: []
    })),
    edges: forceEdges,
    warnings: graphFixture.warnings,
    generatedAt: "2026-08-27T17:02:00.000Z",
    durationMs: 1234
  }

  test("parses the whole force graph", () => {
    const parsed = TargetGraphResponseSchema.parse(response)
    expect(parsed.nodes).toHaveLength(82)
    expect(parsed.edges).toHaveLength(94)
    expect(parsed.warnings).toEqual([])
    expect(parsed.nodes.every((node) => node.private === false)).toBe(true)
  })

  test("refuses a missing `warnings`, a string duration, and one bad node in an otherwise good list", () => {
    const { warnings: _warnings, ...noWarnings } = response
    expect(TargetGraphResponseSchema.safeParse(noWarnings).success).toBe(false)
    expect(TargetGraphResponseSchema.safeParse({ ...response, durationMs: "1234" }).success).toBe(false)
    expect(TargetGraphResponseSchema.safeParse({ ...response, generatedAt: 0 }).success).toBe(false)
    expect(
      TargetGraphResponseSchema.safeParse({ ...response, nodes: [...response.nodes, { label: "//x:y" }] }).success
    ).toBe(false)
  })
})

describe("NodeTimingSchema", () => {
  test("parses every declared status and the settled row the executor produces", () => {
    for (const status of NODE_RUN_STATUSES) {
      expect(NodeTimingSchema.parse({ label: "//src:lint", status }).status).toBe(status)
    }
    const parsed = NodeTimingSchema.parse({
      label: "//src:typeCheck",
      status: "ran",
      startedAt: 1_700_000_000_000,
      endedAt: 1_700_000_004_900,
      durationMs: 4900,
      key: "83972035f4fb7ae7",
      exitCode: 0
    })
    expect(parsed.durationMs).toBe(4900)
    expect(parsed.exitCode).toBe(0)
  })

  test("accepts a null exit code (killed) and a refusal reason", () => {
    expect(
      NodeTimingSchema.parse({ label: "//src:go", status: "refused", reason: "host bin absent: go", exitCode: null })
        .exitCode
    ).toBeNull()
  })

  test("refuses an unknown status and a string duration", () => {
    expect(NodeTimingSchema.safeParse({ label: "//src:lint", status: "cached" }).success).toBe(false)
    expect(NodeTimingSchema.safeParse({ label: "//src:lint", status: "ran", durationMs: "4.9s" }).success).toBe(false)
    expect(NodeTimingSchema.safeParse({ status: "ran" }).success).toBe(false)
  })
})

describe("RunSummarySchema", () => {
  const summary = {
    total: 12,
    hit: 9,
    ran: 2,
    failed: 0,
    skipped: 1,
    durationMs: 8123,
    ok: true,
    criticalPath: ["//src:srcs", "//src:typeCheck"]
  }

  test("parses the summary line's counts with a critical path", () => {
    expect(RunSummarySchema.parse(summary).criticalPath).toEqual(["//src:srcs", "//src:typeCheck"])
    expect(RunSummarySchema.parse({ ...summary, criticalPath: [] }).criticalPath).toEqual([])
  })

  test("refuses a missing count, a non-boolean ok, and a non-string path entry", () => {
    const { skipped: _skipped, ...missing } = summary
    expect(RunSummarySchema.safeParse(missing).success).toBe(false)
    expect(RunSummarySchema.safeParse({ ...summary, ok: "yes" }).success).toBe(false)
    expect(RunSummarySchema.safeParse({ ...summary, criticalPath: [1] }).success).toBe(false)
    expect(RunSummarySchema.safeParse({ ...summary, criticalPath: "//src:lint" }).success).toBe(false)
  })
})

describe("TargetRunEventSchema", () => {
  const frames = [
    { type: "started", runId: "r1", label: "//src:typeCheck", at: 1, labels: ["//src:typeCheck", "//src:srcs"] },
    { type: "stdout", data: "//src:lint  ran  4.9s\n" },
    { type: "stdout", data: "tsc output\n", label: "//src:typeCheck" },
    { type: "stderr", data: "warn\n", label: "//src:typeCheck" },
    { type: "node", node: { label: "//src:typeCheck", status: "running", startedAt: 2 }, at: 2 },
    { type: "node", node: { label: "//src:typeCheck", status: "ran", durationMs: 4900, exitCode: 0 }, at: 3 },
    {
      type: "summary",
      summary: {
        total: 3,
        hit: 1,
        ran: 2,
        failed: 0,
        skipped: 0,
        durationMs: 4900,
        ok: true,
        criticalPath: ["//src:srcs", "//src:typeCheck"]
      },
      at: 4
    },
    { type: "exit", code: 0 },
    { type: "exit", code: null },
    { type: "error", message: "spawn ENOENT" }
  ]

  test("parses every frame the WS topic carries, in order", () => {
    expect(frames.map((frame) => TargetRunEventSchema.parse(frame).type)).toEqual([
      "started",
      "stdout",
      "stdout",
      "stderr",
      "node",
      "node",
      "summary",
      "exit",
      "exit",
      "error"
    ])
  })

  test("refuses an unknown frame type, a missing discriminator, and a bad inner shape", () => {
    expect(TargetRunEventSchema.safeParse({ type: "progress", pct: 1 }).success).toBe(false)
    expect(TargetRunEventSchema.safeParse({ data: "no type" }).success).toBe(false)
    expect(TargetRunEventSchema.safeParse({ type: "node", node: { label: "//a:a", status: "cached" }, at: 1 }).success)
      .toBe(false)
    expect(TargetRunEventSchema.safeParse({ type: "node", node: { label: "//a:a", status: "ran" } }).success).toBe(
      false
    )
    expect(TargetRunEventSchema.safeParse({ type: "started", runId: "r1", label: "//a:a", at: 1 }).success).toBe(false)
    expect(TargetRunEventSchema.safeParse({ type: "exit" }).success).toBe(false)
    expect(TargetRunEventSchema.safeParse({ type: "stdout", data: 12 }).success).toBe(false)
  })
})

describe("RunRecordSchema and the history/replay envelopes", () => {
  const record = {
    runId: "r1",
    repoId: "force",
    label: "//src:typeCheck",
    status: "done",
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_004_900,
    exitCode: 0,
    summary: { total: 3, hit: 1, ran: 2, failed: 0, skipped: 0, durationMs: 4900, ok: true, criticalPath: [] }
  }

  test("defaults `labels` to an empty list and keeps a still-running record open", () => {
    expect(RunRecordSchema.parse(record).labels).toEqual([])
    const running = RunRecordSchema.parse({
      runId: "r2",
      repoId: "force",
      label: "//src:lint",
      status: "running",
      startedAt: 1
    })
    expect(running.endedAt).toBeUndefined()
    expect(running.summary).toBeUndefined()
  })

  test("refuses an unknown status and a string startedAt", () => {
    expect(RunRecordSchema.safeParse({ ...record, status: "ok" }).success).toBe(false)
    expect(RunRecordSchema.safeParse({ ...record, startedAt: "now" }).success).toBe(false)
  })

  test("parses an empty history and a populated one", () => {
    expect(RunHistoryResponseSchema.parse({ runs: [] }).runs).toEqual([])
    expect(RunHistoryResponseSchema.parse({ runs: [record] }).runs).toHaveLength(1)
    expect(RunHistoryResponseSchema.safeParse({}).success).toBe(false)
  })

  test("parses a replay envelope and refuses one whose frames are malformed", () => {
    const replay = RunReplayResponseSchema.parse({
      run: record,
      events: [{ type: "started", runId: "r1", label: "//src:typeCheck", at: 1, labels: [] }, { type: "exit", code: 0 }]
    })
    expect(replay.events).toHaveLength(2)
    expect(RunReplayResponseSchema.parse({ run: record, events: [] }).events).toEqual([])
    expect(RunReplayResponseSchema.safeParse({ run: record, events: [{ type: "tick" }] }).success).toBe(false)
    expect(RunReplayResponseSchema.safeParse({ events: [] }).success).toBe(false)
  })
})

describe("AffectedResponseSchema", () => {
  const affected = {
    repoId: "force",
    base: "HEAD",
    changedFiles: ["src/index.ts"],
    affected: [
      { label: "//src:srcs", reason: "src/index.ts" },
      { label: "//src:typeCheck", reason: "transitive via //src:srcs" }
    ],
    durationMs: 42
  }

  test("parses a diff with reasons and a clean tree", () => {
    expect(AffectedResponseSchema.parse(affected).affected).toHaveLength(2)
    expect(AffectedResponseSchema.parse({ ...affected, changedFiles: [], affected: [] }).affected).toEqual([])
  })

  test("refuses an entry without a reason and a missing base", () => {
    expect(AffectedResponseSchema.safeParse({ ...affected, affected: [{ label: "//src:srcs" }] }).success).toBe(false)
    const { base: _base, ...noBase } = affected
    expect(AffectedResponseSchema.safeParse(noBase).success).toBe(false)
  })
})

describe("CiMatrixResponseSchema", () => {
  const ci = {
    repoId: "force",
    workflows: [
      {
        name: "ci",
        path: ".github/workflows/ci.yml",
        yaml: "name: ci\n",
        jobs: [
          { name: "test", targets: ["//src:test"], matrix: { shard: ["1/4", "2/4", "3/4", "4/4"] } },
          { name: "lint", targets: ["//src:lint"] }
        ]
      }
    ],
    durationMs: 7
  }

  test("parses a workflow with a sharded job, an unsharded job, and a repo with no workflows", () => {
    const parsed = CiMatrixResponseSchema.parse(ci)
    expect(parsed.workflows[0]!.jobs[0]!.matrix).toEqual({ shard: ["1/4", "2/4", "3/4", "4/4"] })
    expect(parsed.workflows[0]!.jobs[1]!.matrix).toBeUndefined()
    expect(CiMatrixResponseSchema.parse({ repoId: "force", workflows: [], durationMs: 0 }).workflows).toEqual([])
  })

  test("refuses a missing yaml and a matrix axis that is not a string list", () => {
    const broken = { ...ci, workflows: [{ ...ci.workflows[0], yaml: undefined }] }
    expect(CiMatrixResponseSchema.safeParse(broken).success).toBe(false)
    const badMatrix = {
      ...ci,
      workflows: [{ ...ci.workflows[0], jobs: [{ name: "t", targets: [], matrix: { shard: "1/4" } }] }]
    }
    expect(CiMatrixResponseSchema.safeParse(badMatrix).success).toBe(false)
  })
})

describe("the five card payloads", () => {
  test("each carries pending, done and failed without inventing data", () => {
    expect(GraphCardPayloadSchema.parse({ repoId: "force", repoName: "artsy/force", status: "pending" }).graph)
      .toBeUndefined()
    expect(
      GraphCardPayloadSchema.parse({
        repoId: "force",
        repoName: "artsy/force",
        status: "failed",
        error: "graph load failed: exit 1"
      }).error
    ).toBe("graph load failed: exit 1")
    expect(
      GraphCardPayloadSchema.parse({
        repoId: "force",
        repoName: "artsy/force",
        status: "done",
        graph: {
          repoId: "force",
          nodes: [],
          edges: [],
          warnings: [],
          generatedAt: "2026-08-27T00:00:00.000Z",
          durationMs: 1
        },
        focus: "//src:typeCheck",
        runId: "r1"
      }).focus
    ).toBe("//src:typeCheck")

    expect(
      RunTimelineCardPayloadSchema.parse({
        repoId: "force",
        runId: "r1",
        label: "//src:typeCheck",
        status: "running",
        nodes: []
      }).cursor
    ).toBeUndefined()
    expect(
      RunTimelineCardPayloadSchema.parse({
        repoId: "force",
        runId: "r1",
        label: "//src:typeCheck",
        status: "done",
        nodes: [{ label: "//src:typeCheck", status: "ran", durationMs: 4900 }],
        summary: {
          total: 1,
          hit: 0,
          ran: 1,
          failed: 0,
          skipped: 0,
          durationMs: 4900,
          ok: true,
          criticalPath: ["//src:typeCheck"]
        },
        cursor: 1_700_000_000_000
      }).cursor
    ).toBe(1_700_000_000_000)

    expect(RunHistoryCardPayloadSchema.parse({ repoId: "force", status: "pending", runs: [] }).selected).toBeUndefined()
    expect(AffectedCardPayloadSchema.parse({ repoId: "force", status: "failed", error: "not a git repo" }).result)
      .toBeUndefined()
    expect(CiMatrixCardPayloadSchema.parse({ repoId: "force", status: "pending" }).result).toBeUndefined()
  })

  test("each refuses a status outside pending/done/failed and a mistyped result", () => {
    expect(GraphCardPayloadSchema.safeParse({ repoId: "force", repoName: "f", status: "running" }).success).toBe(false)
    expect(
      RunTimelineCardPayloadSchema.safeParse({
        repoId: "force",
        runId: "r1",
        label: "//a:a",
        status: "done",
        nodes: [{ label: "//a:a" }]
      }).success
    ).toBe(false)
    expect(
      RunTimelineCardPayloadSchema.safeParse({
        repoId: "force",
        runId: "r1",
        label: "//a:a",
        status: "pending",
        nodes: []
      }).success
    ).toBe(true)
    expect(RunHistoryCardPayloadSchema.safeParse({ repoId: "force", status: "done", runs: [{ runId: "r1" }] }).success)
      .toBe(false)
    expect(
      AffectedCardPayloadSchema.safeParse({ repoId: "force", status: "done", result: { repoId: "force" } }).success
    ).toBe(false)
    expect(CiMatrixCardPayloadSchema.safeParse({ repoId: "force", status: "done", result: { workflows: [] } }).success)
      .toBe(false)
  })
})

describe("reachable, on the real force graph", () => {
  test("deps() of //:prePush is its twelve transitive dependencies, not itself", () => {
    const deps = reachable(forceEdges, "//:prePush", "deps")
    expect([...deps].sort()).toEqual([
      "//data:schema",
      "//src:agentLints",
      "//src:analyticsLint",
      "//src:conventionsLint",
      "//src:lint",
      "//src:relayArtifacts",
      "//src:relayLint",
      "//src:srcs",
      "//src:ssrLint",
      "//src:test",
      "//src:testAccuracyLint",
      "//src:typeCheck"
    ])
    expect(deps.has("//:prePush")).toBe(false)
  })

  test("deps() of //src:typeCheck matches the plan fixture's transitive closure", () => {
    expect([...reachable(forceEdges, "//src:typeCheck", "deps")].sort()).toEqual([
      "//data:schema",
      "//src:relayArtifacts",
      "//src:srcs"
    ])
    const planned = planFixture.targets.map((target: { label: string }) => target.label).filter((label: string) =>
      label !== "//src:typeCheck"
    )
    expect([...reachable(forceEdges, "//src:typeCheck", "deps")].sort()).toEqual([...planned].sort())
  })

  test("rdeps() of //src:typeCheck are the eight targets that would rebuild", () => {
    expect([...reachable(forceEdges, "//src:typeCheck", "rdeps")].sort()).toEqual([
      "//.github:ci",
      "//.github:github",
      "//.github:pr",
      "//:commit",
      "//:preCommit",
      "//:prePush",
      "//workflows/adding-a-new-app-route:addAppRoute",
      "//workflows/fix-sentry-issue:fixSentryIssue"
    ])
  })

  test("a leaf has no deps, a root has no rdeps, and //src:srcs fans out to 45 rdeps", () => {
    expect(reachable(forceEdges, "//src:srcs", "deps").size).toBe(0)
    expect(reachable(forceEdges, "//.github:github", "rdeps").size).toBe(0)
    expect(reachable(forceEdges, "//.github:github", "deps").size).toBe(25)
    expect(reachable(forceEdges, "//src:srcs", "rdeps").size).toBe(45)
  })

  test("an isolated node and an unknown label both reach nothing", () => {
    expect(reachable(forceEdges, "//:claudeMd", "deps").size).toBe(0)
    expect(reachable(forceEdges, "//:claudeMd", "rdeps").size).toBe(0)
    expect(reachable(forceEdges, "//nope:nope", "deps").size).toBe(0)
    expect(reachable(forceEdges, "", "rdeps").size).toBe(0)
  })

  test("labels with slashes and dots in the package survive the walk", () => {
    expect(reachable(forceEdges, "//src/Apps/Auction:test", "deps").has("//src/Apps/Auction:srcs")).toBe(true)
    expect(reachable(forceEdges, "//.storybook:storybook", "deps").has("//src:relayArtifacts")).toBe(true)
  })
})

describe("reachable, on graphs the loader should never emit but might", () => {
  test("a self-loop reaches itself once and terminates", () => {
    expect([...reachable([dep("a", "a")], "a", "deps")]).toEqual(["a"])
    expect([...reachable([dep("a", "a")], "a", "rdeps")]).toEqual(["a"])
  })

  test("a cycle terminates and yields every member, including the start label", () => {
    const cycle = [dep("a", "b"), dep("b", "c"), dep("c", "a")]
    expect([...reachable(cycle, "a", "deps")].sort()).toEqual(["a", "b", "c"])
    expect([...reachable(cycle, "b", "rdeps")].sort()).toEqual(["a", "b", "c"])
  })

  test("an empty edge list reaches nothing, and duplicate edges do not duplicate the set", () => {
    expect(reachable([], "a", "deps").size).toBe(0)
    expect([...reachable([dep("a", "b"), dep("a", "b"), { from: "a", to: "b", kind: "data" }], "a", "deps")]).toEqual([
      "b"
    ])
  })

  test("every edge kind walks alike: reachability is kind-blind", () => {
    const mixed: Array<GraphEdge> = [
      { from: "a", to: "b", kind: "data" },
      { from: "b", to: "c", kind: "gates" },
      { from: "c", to: "d", kind: "services" },
      { from: "d", to: "e", kind: "deps" }
    ]
    expect([...reachable(mixed, "a", "deps")].sort()).toEqual(["b", "c", "d", "e"])
    expect([...reachable(mixed, "e", "rdeps")].sort()).toEqual(["a", "b", "c", "d"])
  })

  test("the two directions are exact mirrors on the real graph", () => {
    for (const label of ["//:prePush", "//src:typeCheck", "//src:srcs"]) {
      for (const other of reachable(forceEdges, label, "deps")) {
        expect(reachable(forceEdges, other, "rdeps").has(label)).toBe(true)
      }
    }
  })
})

describe("criticalPath", () => {
  test("an empty run has no path and a lone node is its own path", () => {
    expect(criticalPath([], [])).toEqual([])
    expect(criticalPath([], [dep("a", "b")])).toEqual([])
    expect(criticalPath([timing("a", 5)], [])).toEqual(["a"])
    expect(criticalPath([timing("a")], [])).toEqual(["a"])
  })

  test("a chain returns the whole chain, root last", () => {
    expect(criticalPath([timing("a", 1), timing("b", 2), timing("c", 3)], [dep("a", "b"), dep("b", "c")])).toEqual([
      "c",
      "b",
      "a"
    ])
  })

  test("a diamond takes the slower arm", () => {
    const nodes = [timing("root", 1), timing("fast", 5), timing("slow", 9), timing("leaf", 2)]
    const edges = [dep("root", "fast"), dep("root", "slow"), dep("fast", "leaf"), dep("slow", "leaf")]
    expect(criticalPath(nodes, edges)).toEqual(["leaf", "slow", "root"])
  })

  test("a cache hit on the chain stays on the path because its subtree is slow", () => {
    expect(
      criticalPath([timing("root", 10), timing("hit", 0), timing("dep", 500)], [dep("root", "hit"), dep("hit", "dep")])
    )
      .toEqual(["dep", "hit", "root"])
  })

  test("a tie between two arms resolves by edge order, not node order", () => {
    // The arm declared first wins, whichever way the timing rows are listed:
    // the tie-break is the order `deps` were declared, so a replay of the same
    // graph always highlights the same chain.
    const nodes = [timing("root", 1), timing("x", 5), timing("y", 5)]
    expect(criticalPath(nodes, [dep("root", "x"), dep("root", "y")])).toEqual(["x", "root"])
    expect(criticalPath(nodes, [dep("root", "y"), dep("root", "x")])).toEqual(["y", "root"])
    expect(criticalPath([timing("root", 1), timing("y", 5), timing("x", 5)], [dep("root", "x"), dep("root", "y")]))
      .toEqual(["x", "root"])
  })

  test("a run whose durations are all zero or missing still reports the dependency chain, root last", () => {
    // An all-cache-hit run has no wall time anywhere, but the UI highlights
    // the chain, so a zero-cost chain stays on the path (contract 0e717461d).
    expect(criticalPath([timing("a", 0), timing("b", 0), timing("c", 0)], [dep("a", "b"), dep("b", "c")])).toEqual([
      "c",
      "b",
      "a"
    ])
    expect(criticalPath([timing("a"), timing("b"), timing("c")], [dep("a", "b"), dep("b", "c")])).toEqual([
      "c",
      "b",
      "a"
    ])
  })

  test("a node with a duration but no dependency still wins over a slower-total sibling chain", () => {
    expect(criticalPath([timing("a", 1), timing("b", 2), timing("c", 30)], [])).toEqual(["c"])
  })

  test("edges whose endpoints have no timing row are ignored", () => {
    expect(criticalPath([timing("a", 4)], [dep("a", "ghost"), dep("ghost", "a")])).toEqual(["a"])
    expect(criticalPath([timing("a", 4), timing("b", 9)], [dep("a", "ghost"), dep("ghost", "b")])).toEqual(["b"])
  })

  test("a self-loop terminates and does not double-count the node", () => {
    expect(criticalPath([timing("a", 4)], [dep("a", "a")])).toEqual(["a"])
  })

  test("a cycle terminates, truncates at the back edge, and never repeats a label", () => {
    const two = criticalPath([timing("a", 10), timing("b", 5)], [dep("a", "b"), dep("b", "a")])
    expect(two).toEqual(["b", "a"])
    expect(new Set(two).size).toBe(two.length)

    const reordered = criticalPath([timing("b", 5), timing("a", 10)], [dep("a", "b"), dep("b", "a")])
    expect(reordered).toEqual(["a", "b"])

    const three = criticalPath(
      [timing("a", 1), timing("b", 2), timing("c", 3)],
      [dep("a", "b"), dep("b", "c"), dep("c", "a")]
    )
    expect(three).toEqual(["c", "b", "a"])
    expect(new Set(three).size).toBe(three.length)
  })

  test("a duplicated timing row takes the last duration and appears once", () => {
    expect(criticalPath([timing("a", 1), timing("a", 9), timing("b", 5)], [dep("b", "a")])).toEqual(["a", "b"])
  })

  test("the returned path is always a real dependency chain of the given edges", () => {
    const nodes = [timing("root", 3), timing("mid", 7), timing("leaf", 11), timing("aside", 1)]
    const edges = [dep("root", "mid"), dep("mid", "leaf"), dep("root", "aside")]
    const path = criticalPath(nodes, edges)
    expect(path).toEqual(["leaf", "mid", "root"])
    for (let index = 0; index + 1 < path.length; index += 1) {
      expect(edges.some((edge) => edge.from === path[index + 1] && edge.to === path[index])).toBe(true)
    }
  })

  test("a deep chain does not blow the stack", () => {
    const nodes = Array.from({ length: 3000 }, (_, index) => timing(`n${index}`, 1))
    const edges = Array.from({ length: 2999 }, (_, index) => dep(`n${index}`, `n${index + 1}`))
    expect(criticalPath(nodes, edges)).toHaveLength(3000)
  })

  test("a chain deeper than the call stack still resolves, end to end", () => {
    // Recursion dies near 50k frames; a monorepo-scale chain must not crash
    // the helper the backend and the replay scrubber both call.
    const depth = 60_000
    const nodes = Array.from({ length: depth }, (_, index) => timing(`n${index}`, 1))
    const edges = Array.from({ length: depth - 1 }, (_, index) => dep(`n${index}`, `n${index + 1}`))
    const path = criticalPath(nodes, edges)
    expect(path).toHaveLength(depth)
    expect(path[0]).toBe(`n${depth - 1}`)
    expect(path[depth - 1]).toBe("n0")
  })

  test("the force graph's typeCheck run reports the chain the plan implies", () => {
    const nodes = [
      timing("//src:typeCheck", 4900),
      timing("//src:relayArtifacts", 12_000),
      timing("//src:srcs", 30),
      timing("//data:schema", 5)
    ]
    expect(criticalPath(nodes, forceEdges)).toEqual(["//src:srcs", "//src:relayArtifacts", "//src:typeCheck"])
  })
})

/*
 * The dev fixture seam (goal lane ui/ui): while the backend's target-graph
 * routes land in parallel, the cards can be driven end-to-end from the
 * captured force fixtures (packages/rpc/fixtures/force/) plus a scripted run
 * stream — `started` → `node` (pending → running → settled, with timings)
 * → `summary` frames on a timer. This is EXPLICIT dev tooling: it activates
 * only when the `smithers.dev.targetGraphFixtures` localStorage flag is "1",
 * and the product path never sees it — `createTargetGraphDevFixtures` answers
 * undefined unless the flag is on. There is deliberately no build-time env
 * switch: vite.config.ts sets no `envPrefix`, so only `VITE_` names reach
 * `import.meta.env` and any other name reads as undefined in every build.
 */
import graphFixture from "../../../../../packages/rpc/fixtures/force/graph.json"
import planFixture from "../../../../../packages/rpc/fixtures/force/plan-typeCheck.json"
import type {
  AffectedResponse,
  CiMatrixResponse,
  NodeTiming,
  RunHistoryResponse,
  RunRecord,
  RunReplayResponse,
  TargetGraphResponse,
  TargetRunEvent
} from "@smthrs/rpc/TargetGraph"
import { criticalPath } from "@smthrs/rpc/TargetGraph"
import {
  CliGraphEnvelopeSchema,
  CliPlanEnvelopeSchema,
  mergePlanFacts,
  targetGraphFromCli
} from "@smthrs/rpc/TargetGraphCli"

export const TARGET_GRAPH_FIXTURE_FLAG = "smithers.dev.targetGraphFixtures"

/** The one explicit opt-in: the localStorage flag. Never an env, never a default. */
export const targetGraphFixturesEnabled = (): boolean => {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem(TARGET_GRAPH_FIXTURE_FLAG) === "1"
  } catch {
    // Storage the webview refuses is the flag off.
    return false
  }
}

/** The captured force graph with the typeCheck plan facts merged on. */
export const fixtureTargetGraph = (repoId: string): TargetGraphResponse =>
  mergePlanFacts(
    targetGraphFromCli(CliGraphEnvelopeSchema.parse(graphFixture), {
      repoId,
      generatedAt: new Date(0).toISOString(),
      durationMs: 0
    }),
    CliPlanEnvelopeSchema.parse(planFixture)
  )

/** The labels a fixture run touches: the root's transitive deps, root last, in stable label order. */
export const fixtureRunLabels = (graph: TargetGraphResponse, root: string): Array<string> => {
  const deps = new Map<string, Array<string>>()
  for (const edge of graph.edges) {
    const list = deps.get(edge.from)
    if (list === undefined) deps.set(edge.from, [edge.to])
    else list.push(edge.to)
  }
  const seen = new Set<string>()
  const order: Array<string> = []
  const visit = (label: string): void => {
    for (const dep of [...(deps.get(label) ?? [])].sort()) {
      if (seen.has(dep)) continue
      seen.add(dep)
      visit(dep)
      order.push(dep)
    }
  }
  seen.add(root)
  visit(root)
  order.push(root)
  return order
}

/** A small deterministic duration so bars and the critical path are stable in tests. */
const fixtureDurationMs = (label: string): number => {
  let hash = 0
  for (const char of label) hash = (hash * 31 + char.charCodeAt(0)) % 997
  return 400 + (hash % 5) * 300
}

/**
 * The scripted run, as the contract's frames: `started`, then for every
 * label in dependency order a `pending` → `running` → settled (`hit` every
 * fourth, `failed` on the eighth so red renders) `node` frame with timings,
 * then the `summary` with the critical path. Deterministic given `base`.
 */
export const fixtureRunEvents = (
  graph: TargetGraphResponse,
  options: { readonly runId: string; readonly root: string; readonly base: number }
): ReadonlyArray<TargetRunEvent> => {
  const labels = fixtureRunLabels(graph, options.root)
  const events: Array<TargetRunEvent> = [
    { type: "started", runId: options.runId, label: options.root, at: options.base, labels }
  ]
  let clock = options.base
  const timings: Array<NodeTiming> = []
  labels.forEach((label, index) => {
    const durationMs = fixtureDurationMs(label)
    const startedAt = clock
    const settled: NodeTiming["status"] = index % 8 === 7 ? "failed" : index % 4 === 3 ? "hit" : "ran"
    const endedAt = settled === "hit" ? startedAt : startedAt + durationMs
    clock = endedAt + 40
    events.push({ type: "node", node: { label, status: "pending" }, at: startedAt - 20 })
    events.push({ type: "node", node: { label, status: "running", startedAt }, at: startedAt })
    events.push({
      type: "node",
      node: {
        label,
        status: settled,
        startedAt,
        endedAt,
        durationMs: endedAt - startedAt,
        key: `fixture-${index.toString(16).padStart(4, "0")}`,
        ...(settled === "failed" ? { reason: "exit 1", exitCode: 1 } : { exitCode: 0 })
      },
      at: endedAt
    })
    events.push({ type: "stdout", data: `${label}  ${settled}  ${((endedAt - startedAt) / 1000).toFixed(1)}s\n`, label })
    timings.push({ label, status: settled, startedAt, endedAt, durationMs: endedAt - startedAt })
  })
  const hit = timings.filter((timing) => timing.status === "hit").length
  const ran = timings.filter((timing) => timing.status === "ran").length
  const failed = timings.filter((timing) => timing.status === "failed").length
  events.push({
    type: "summary",
    summary: {
      total: timings.length,
      hit,
      ran,
      failed,
      skipped: 0,
      durationMs: clock - options.base,
      ok: failed === 0,
      criticalPath: [...criticalPath(timings, graph.edges)]
    },
    at: clock
  })
  return events
}

export interface TargetGraphDevFixtures {
  readonly graph: (repoId: string) => TargetGraphResponse
  readonly history: (repoId: string) => RunHistoryResponse
  readonly replay: (runId: string) => RunReplayResponse | undefined
  readonly affected: (repoId: string) => AffectedResponse
  readonly ci: (repoId: string) => CiMatrixResponse
  /** The scripted run stream: frames on a timer, in order; the returned function cancels it. */
  readonly streamRun: (
    runId: string,
    root: string,
    onFrame: (frame: TargetRunEvent) => void,
    intervalMs?: number
  ) => () => void
}

const FIXTURE_RUN_ID = "fixture-run-1"
const FIXTURE_RUN_BASE = 1_700_000_000_000
const FIXTURE_RUN_ROOT = "//:prePush"

/**
 * The dev seam the target-graph controller consumes instead of the routes,
 * or undefined when the flag is off. One recorded run (the scripted prePush
 * run at a fixed base) backs history and replay; `streamRun` re-emits it
 * live so the overlay and timeline paint frame by frame.
 */
export const createTargetGraphDevFixtures = (): TargetGraphDevFixtures | undefined => {
  if (!targetGraphFixturesEnabled()) return undefined
  const recorded = new Map<string, RunReplayResponse>()
  /*
   * The one standing recording the history card lists. It has to BE a
   * recording, not just a row: a history that offers a run the replay route
   * then refuses is exactly the dead end the card must never render.
   */
  const standingRecording = (repoId: string): RunReplayResponse => {
    const live = recorded.get(FIXTURE_RUN_ID)
    if (live !== undefined) return live
    const graph = fixtureTargetGraph(repoId)
    const events = fixtureRunEvents(graph, {
      runId: FIXTURE_RUN_ID,
      root: FIXTURE_RUN_ROOT,
      base: FIXTURE_RUN_BASE
    })
    const summary = events.find((event): event is Extract<TargetRunEvent, { type: "summary" }> =>
      event.type === "summary"
    )?.summary
    const run: RunRecord = {
      runId: FIXTURE_RUN_ID,
      repoId,
      label: FIXTURE_RUN_ROOT,
      labels: fixtureRunLabels(graph, FIXTURE_RUN_ROOT),
      status: summary?.ok === false ? "failed" : "done",
      startedAt: FIXTURE_RUN_BASE,
      ...(summary === undefined ? {} : { endedAt: FIXTURE_RUN_BASE + summary.durationMs, summary }),
      exitCode: summary?.ok === false ? 1 : 0
    }
    return { run, events: [...events] }
  }
  return {
    graph: (repoId) => fixtureTargetGraph(repoId),
    history: (repoId) => ({ runs: [standingRecording(repoId).run] }),
    replay: (runId) => (runId === FIXTURE_RUN_ID ? standingRecording("fixture") : recorded.get(runId)),
    affected: (repoId) => ({
      repoId,
      base: "origin/main",
      changedFiles: ["src/App.tsx", "data/schema.graphql"],
      affected: [
        { label: "//src:typeCheck", reason: "src/App.tsx" },
        { label: "//src:relayArtifacts", reason: "data/schema.graphql" },
        { label: "//:prePush", reason: "transitive via //src:typeCheck" }
      ],
      durationMs: 0
    }),
    ci: (repoId) => ({
      repoId,
      workflows: [{
        name: "ci",
        path: ".github/workflows/ci.yml",
        yaml: "name: ci\non: [push]\njobs:\n  main:\n    runs-on: ubuntu-latest\n    steps:\n      - run: smithers-build '//.github:ci'\n",
        jobs: [{ name: "main", targets: ["//.github:ci"], matrix: { shard: ["1", "2", "3"] } }]
      }],
      durationMs: 0
    }),
    streamRun: (runId, root, onFrame, intervalMs = 60) => {
      const events = fixtureRunEvents(fixtureTargetGraph("fixture"), { runId, root, base: Date.now() })
      const emitted: Array<TargetRunEvent> = []
      let index = 0
      const timer = setInterval(() => {
        const event = events[index]
        if (event === undefined) {
          clearInterval(timer)
          recorded.set(runId, {
            run: {
              runId,
              repoId: "fixture",
              label: root,
              labels: fixtureRunLabels(fixtureTargetGraph("fixture"), root),
              status: "done",
              startedAt: emitted[0]?.type === "started" ? emitted[0].at : Date.now(),
              summary: emitted.find((frame): frame is Extract<TargetRunEvent, { type: "summary" }> =>
                frame.type === "summary"
              )?.summary
            },
            events: emitted
          })
          return
        }
        emitted.push(event)
        index += 1
        onFrame(event)
      }, intervalMs)
      ;(timer as { unref?: () => void }).unref?.()
      return () => clearInterval(timer)
    }
  }
}

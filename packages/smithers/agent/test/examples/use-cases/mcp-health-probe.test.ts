import { afterAll, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Kit from "../../../examples/use-cases/kit.vibe"
import { layer, McpHealthProbe } from "../../../examples/use-cases/mcp-health-probe.vibe"

const directory = mkdtempSync(join(tmpdir(), "mcp-health-probe-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

interface Probed {
  readonly server: string
  readonly healthy: boolean
  readonly capabilityDrift: boolean
}

/**
 * A prober whose server lists its baseline capabilities minus the last one
 * while `drifting(server, probe number)` holds; a checker that judges each
 * server by its latest probe; and a reporter that names the servers the check
 * it is handed called drifted. Every request is recorded with what it saw.
 */
const script = (drifting: (server: string, probe: number) => boolean) => {
  const turns: Array<string> = []
  const probes = new Map<string, number>()
  const answer: Kit.Script = (asked) => {
    const schedule =
      /Decide whether to probe the MCP servers now \(iteration (\d+)\)\.\n\nInterval \(ms\): (\d+)\nLast run: (.*)/
        .exec(asked)
    if (schedule !== null) {
      turns.push(`schedule ${schedule[1]} every ${schedule[2]} since ${schedule[3]}`)
      return { shouldProbe: true, reason: "interval elapsed", intervalMs: Number(schedule[2]) }
    }
    const probe = /Probe the MCP server (.+)\.\n\nBaseline capabilities: (.+)\nLatency threshold \(ms\): (\d+)/.exec(
      asked
    )
    if (probe !== null) {
      const server = probe[1]!
      const n = (probes.get(server) ?? 0) + 1
      probes.set(server, n)
      const baseline: ReadonlyArray<string> = JSON.parse(probe[2]!)
      const drift = drifting(server, n)
      turns.push(`probe ${server}`)
      return {
        server,
        healthy: true,
        latencyMs: 40,
        capabilities: drift ? baseline.slice(0, -1) : baseline,
        capabilityDrift: drift,
        ...(drift ? { driftDetails: `${baseline.at(-1)} disappeared` } : {})
      }
    }
    const check = /Check these probe results for material changes\.\n\nProbe results: (.+)\nPrevious baseline: (.+)\n/
      .exec(asked)
    if (check !== null) {
      const results: ReadonlyArray<Probed> = JSON.parse(check[1]!)
      const latest = new Map(results.map((r) => [r.server, r]))
      const drifted = [...latest.values()].filter((r) => r.capabilityDrift).map((r) => r.server)
      turns.push(`check ${results.length} probes`)
      return {
        materialChange: drifted.length > 0,
        unhealthyServers: [...latest.values()].filter((r) => !r.healthy).map((r) => r.server),
        driftedServers: drifted,
        newIssues: drifted.map((server) => `${server} lost a capability`),
        resolvedIssues: []
      }
    }
    const report =
      /Report the MCP health check\.\n\nCheck: (.+)\nProbe results: .+\nOutput path: (.+)\nNotify channel: (.+)/
        .exec(asked)
    if (report !== null) {
      const { driftedServers } = JSON.parse(report[1]!)
      turns.push(`report to ${report[2]} via ${report[3]}`)
      return {
        reported: true,
        summary: `drift on ${driftedServers.join(", ")}`,
        details: report[2]!,
        recommendations: [`pin ${driftedServers[0]}`]
      }
    }
    return undefined
  }
  return { answer, turns }
}

it.effect("reports a material change and stops at the first round without one", () =>
  Effect.gen(function*() {
    const { answer, turns } = script((server, probe) => server === "github" && probe === 1)
    const outcome = yield* Kit.run(McpHealthProbe, {
      servers: ["github", "filesystem"],
      baselines: { github: ["search_code", "list_issues"], filesystem: ["read_file"] }
    }, {
      filename: join(directory, "material-change.sqlite"),
      executionId: "mcp-health-probe-material-change",
      script: answer,
      actions: layer
    })

    // Both servers are probed after each ruling; the second check reads both
    // rounds' probes; only the first round's change is reported.
    expect(turns.slice(0, 1)).toEqual(["schedule 0 every 300000 since never"])
    expect([...turns.slice(1, 3)].sort()).toEqual(["probe filesystem", "probe github"])
    expect(turns.slice(3, 6)).toEqual([
      "check 2 probes",
      "report to ./mcp-health-report.md via none",
      "schedule 1 every 300000 since never"
    ])
    expect([...turns.slice(6, 8)].sort()).toEqual(["probe filesystem", "probe github"])
    expect(turns.slice(8)).toEqual(["check 4 probes"])
    expect(outcome).toEqual({
      iterations: 2,
      check: { materialChange: false, unhealthyServers: [], driftedServers: [], newIssues: [], resolvedIssues: [] },
      reports: [{
        reported: true,
        summary: "drift on github",
        details: "./mcp-health-report.md",
        recommendations: ["pin github"]
      }]
    })
  }))

it.effect("reports every round until the bound when the change persists", () =>
  Effect.gen(function*() {
    const { answer, turns } = script(() => true)
    const outcome = yield* Kit.run(McpHealthProbe, {
      servers: ["github"],
      baselines: { github: ["search_code", "list_issues"] },
      maxIterations: 2,
      lastRun: "2026-10-14T00:00:00Z",
      outputPath: "reports/mcp.md",
      notifyChannel: "#oncall"
    }, {
      filename: join(directory, "persistent-change.sqlite"),
      executionId: "mcp-health-probe-persistent-change",
      script: answer,
      actions: layer
    })

    expect(turns).toEqual([
      "schedule 0 every 300000 since 2026-10-14T00:00:00Z",
      "probe github",
      "check 1 probes",
      "report to reports/mcp.md via #oncall",
      "schedule 1 every 300000 since 2026-10-14T00:00:00Z",
      "probe github",
      "check 2 probes",
      "report to reports/mcp.md via #oncall"
    ])
    expect(outcome.iterations).toBe(2)
    expect(outcome.check.driftedServers).toEqual(["github"])
    expect(outcome.reports).toHaveLength(2)
  }))

it.effect("checks an empty probe set and reports nothing when no servers are given", () =>
  Effect.gen(function*() {
    const { answer, turns } = script(() => true)
    const outcome = yield* Kit.run(McpHealthProbe, {}, {
      filename: join(directory, "no-servers.sqlite"),
      executionId: "mcp-health-probe-no-servers",
      script: answer,
      actions: layer
    })

    expect(turns).toEqual(["schedule 0 every 300000 since never", "check 0 probes"])
    expect(outcome).toEqual({
      iterations: 1,
      check: { materialChange: false, unhealthyServers: [], driftedServers: [], newIssues: [], resolvedIssues: [] },
      reports: []
    })
  }))

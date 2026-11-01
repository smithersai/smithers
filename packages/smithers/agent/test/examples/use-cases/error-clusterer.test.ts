import { afterAll, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ErrorClusterer, layer } from "../../../examples/use-cases/error-clusterer.vibe"
import * as Kit from "../../../examples/use-cases/kit.ts"

const directory = mkdtempSync(join(tmpdir(), "error-clusterer-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

const error = (id: string, source: "ci" | "api" | "runtime", fingerprint: string, minute: number) => ({
  id,
  source,
  message: `${fingerprint} in ${id}`,
  timestamp: `2026-10-14T10:${String(minute).padStart(2, "0")}:00Z`,
  fingerprint
})

interface SeenCluster {
  readonly clusterId: string
  readonly fingerprint: string
  readonly count: number
  readonly errorIds: ReadonlyArray<string>
  readonly firstSeen: string
  readonly lastSeen: string
}

/**
 * An ingester that returns `errors`, an explainer that rates each cluster it
 * is handed by size, and an updater that builds its table from the
 * explanations and clusters it is handed and opens a ticket per critical or
 * high cluster. Every request is recorded with what it saw.
 */
const script = (errors: ReadonlyArray<ReturnType<typeof error>>) => {
  const turns: Array<string> = []
  const explained: Array<ReadonlyArray<SeenCluster>> = []
  const answer: Kit.Script = (asked) => {
    const ingest = /Ingest the errors from these sources\.\n\nSources: (.+)\nLog paths: (.+)\nSince: (.+)/.exec(asked)
    if (ingest !== null) {
      turns.push(`ingest ${ingest[1]} ${ingest[2]} ${ingest[3]}`)
      return {
        errors,
        totalIngested: errors.length,
        sources: {
          ci: errors.filter((e) => e.source === "ci").length,
          api: errors.filter((e) => e.source === "api").length,
          runtime: errors.filter((e) => e.source === "runtime").length
        }
      }
    }
    const explain = /Explain these (\d+) error clusters\.\n\nKnowledge base: (.+)\nClusters: (.+)/.exec(asked)
    if (explain !== null) {
      const clusters: ReadonlyArray<SeenCluster> = JSON.parse(explain[3]!)
      turns.push(`explain ${explain[1]} into ${explain[2]}`)
      explained.push(clusters)
      return {
        explanations: clusters.map((c) => ({
          clusterId: c.clusterId,
          fingerprint: c.fingerprint,
          rootCause: `${c.fingerprint} root cause`,
          remediation: `fix ${c.fingerprint}`,
          severity: c.count >= 3 ? "critical" : c.count === 2 ? "medium" : "low"
        })),
        summary: `${clusters.length} clusters`
      }
    }
    const update = /Update the knowledge base at (.+)\.\n\nTicket prefix: (.+)\nExplanations: (.+)\nClusters: (.+)/
      .exec(asked)
    if (update !== null) {
      const explanations: ReadonlyArray<
        {
          readonly clusterId: string
          readonly fingerprint: string
          readonly rootCause: string
          readonly remediation: string
          readonly severity: string
        }
      > = JSON.parse(update[3]!)
      const clusters: ReadonlyArray<SeenCluster> = JSON.parse(update[4]!)
      turns.push(`update ${update[1]} with ${update[2]}`)
      return {
        entriesWritten: explanations.length,
        ticketsCreated: explanations
          .filter((e) => e.severity === "critical" || e.severity === "high")
          .map((e) => `${update[2]}-${e.clusterId}`),
        kbPath: update[1]!,
        remediationTable: explanations.map((e) => ({
          fingerprint: e.fingerprint,
          rootCause: e.rootCause,
          remediation: e.remediation,
          severity: e.severity,
          occurrences: clusters.find((c) => c.clusterId === e.clusterId)?.count ?? 0
        })),
        summary: `${explanations.length} entries`
      }
    }
    return undefined
  }
  return { answer, explained, turns }
}

it.effect("clusters errors by fingerprint, largest first, and files the table", () =>
  Effect.gen(function*() {
    const { answer, explained, turns } = script([
      error("e1", "api", "null-user", 1),
      error("e2", "ci", "db-timeout", 2),
      error("e3", "ci", "db-timeout", 3),
      error("e4", "runtime", "oom", 4),
      error("e5", "api", "null-user", 5),
      error("e6", "ci", "db-timeout", 6)
    ])
    const update = yield* Kit.run(
      ErrorClusterer,
      { sources: ["ci", "api", "runtime"], logPaths: ["logs/ci.log"], since: "7d", kbPath: "kb", ticketPrefix: "OPS" },
      {
        filename: join(directory, "clustered.sqlite"),
        executionId: "error-clusterer-clustered",
        script: answer,
        actions: layer
      }
    )

    expect(turns).toEqual([
      `ingest ["ci","api","runtime"] ["logs/ci.log"] 7d`,
      "explain 3 into kb",
      "update kb with OPS"
    ])
    // Ids follow first appearance; the sort puts the three db-timeouts first.
    expect(explained).toEqual([[
      {
        clusterId: "cluster-2",
        fingerprint: "db-timeout",
        representative: "db-timeout in e2",
        count: 3,
        source: "ci",
        errorIds: ["e2", "e3", "e6"],
        firstSeen: "2026-10-14T10:02:00Z",
        lastSeen: "2026-10-14T10:06:00Z"
      },
      {
        clusterId: "cluster-1",
        fingerprint: "null-user",
        representative: "null-user in e1",
        count: 2,
        source: "api",
        errorIds: ["e1", "e5"],
        firstSeen: "2026-10-14T10:01:00Z",
        lastSeen: "2026-10-14T10:05:00Z"
      },
      {
        clusterId: "cluster-3",
        fingerprint: "oom",
        representative: "oom in e4",
        count: 1,
        source: "runtime",
        errorIds: ["e4"],
        firstSeen: "2026-10-14T10:04:00Z",
        lastSeen: "2026-10-14T10:04:00Z"
      }
    ]])
    expect(update).toEqual({
      entriesWritten: 3,
      ticketsCreated: ["OPS-cluster-2"],
      kbPath: "kb",
      remediationTable: [
        {
          fingerprint: "db-timeout",
          rootCause: "db-timeout root cause",
          remediation: "fix db-timeout",
          severity: "critical",
          occurrences: 3
        },
        {
          fingerprint: "null-user",
          rootCause: "null-user root cause",
          remediation: "fix null-user",
          severity: "medium",
          occurrences: 2
        },
        { fingerprint: "oom", rootCause: "oom root cause", remediation: "fix oom", severity: "low", occurrences: 1 }
      ],
      summary: "3 entries"
    })
  }))

it.effect("uses the 0.x defaults and still explains and updates when nothing was ingested", () =>
  Effect.gen(function*() {
    const { answer, explained, turns } = script([])
    const update = yield* Kit.run(ErrorClusterer, {}, {
      filename: join(directory, "empty.sqlite"),
      executionId: "error-clusterer-empty",
      script: answer,
      actions: layer
    })

    expect(turns).toEqual([`ingest ["ci"] [] 24h`, "explain 0 into ./error-kb", "update ./error-kb with ERR"])
    expect(explained).toEqual([[]])
    expect(update).toEqual({
      entriesWritten: 0,
      ticketsCreated: [],
      kbPath: "./error-kb",
      remediationTable: [],
      summary: "0 entries"
    })
  }))

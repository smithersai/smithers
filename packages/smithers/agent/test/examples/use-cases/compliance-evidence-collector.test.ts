import { afterAll, expect, it } from "@effect/vitest"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ComplianceEvidenceCollector, layer } from "../../../examples/use-cases/compliance-evidence-collector.ts"
import * as Kit from "../../../examples/use-cases/kit.ts"

const directory = mkdtempSync(join(tmpdir(), "compliance-evidence-collector-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

const field = (asked: string, name: string): string => new RegExp(`\\n${name}: (.+)`).exec(asked)?.[1] ?? ""

/** Two controls over three sources. */
const accessControls = [
  {
    controlId: "CC6.1",
    description: "Logical access is restricted",
    sources: [
      { sourceId: "okta", endpoint: "https://okta.test/api/v1/policies", preferredMethod: "api" },
      { sourceId: "github", endpoint: "github://org/settings", preferredMethod: "mcp" }
    ]
  },
  {
    controlId: "CC7.2",
    description: "Anomalies are monitored",
    sources: [{ sourceId: "siem", endpoint: "https://siem.test/alerts", preferredMethod: "browser" }]
  }
]

/**
 * A planner that answers with `controls`, a fetcher that answers off-schema
 * for any source in `unreachable`, a normalizer that calls evidence compliant
 * when its payload says "enforced" and answers off-schema for any source in
 * `garbled`, a fetcher that names a source in `misnamed` as its mapped id, and a packet agent that grades each control from the findings it
 * is handed. Each request is recorded in order.
 */
const script = (
  controls: ReadonlyArray<unknown>,
  options: {
    readonly unreachable?: ReadonlyArray<string>
    readonly garbled?: ReadonlyArray<string>
    readonly misnamed?: Readonly<Record<string, string>>
  } = {}
) => {
  const turns: Array<string> = []
  const answer: Kit.Script = (asked) => {
    if (asked.includes("You are a compliance planning agent")) {
      turns.push(`plan ${/Plan the evidence collection for (\S+)\./.exec(asked)?.[1]} scope ${field(asked, "Scope")}`)
      return {
        controls,
        totalSources: controls.reduce((sum: number, c) => sum + (c as { sources: Array<unknown> }).sources.length, 0)
      }
    }
    if (asked.includes("You are an evidence fetcher")) {
      const order = /Fetch evidence for control (\S+) from source (\S+) by (\w+)\./.exec(asked)
      const [controlId, sourceId, method] = [order?.[1] ?? "", order?.[2] ?? "", order?.[3] ?? ""]
      turns.push(`fetch ${controlId}/${sourceId}`)
      if (options.unreachable?.includes(sourceId)) return { unexpected: true }
      return {
        sourceId: options.misnamed?.[sourceId] ?? sourceId,
        controlId,
        title: `${sourceId} export`,
        rawPayload: sourceId === "okta" ? "MFA enforced for all users" : "2 unreviewed alerts",
        fetchedAt: "2026-10-14T00:00:00Z",
        method,
        status: "collected"
      }
    }
    if (asked.includes("You are an evidence normalizer")) {
      const order = /Normalize the evidence for control (\S+) from source (\S+) \(fetched by \w+\)\./.exec(asked)
      const [controlId, sourceId] = [order?.[1] ?? "", order?.[2] ?? ""]
      turns.push(`normalize ${controlId}/${sourceId}`)
      if (options.garbled?.includes(sourceId)) return { unexpected: true }
      const raw: string = JSON.parse(field(asked, "Raw payload"))
      const compliant = raw.includes("enforced")
      return {
        controlId,
        sourceId,
        finding: raw,
        compliant,
        ...(compliant ? {} : { severity: "medium" })
      }
    }
    if (asked.includes("You are a compliance packet assembler")) {
      const framework = /Assemble the (\S+) review packet\./.exec(asked)?.[1] ?? ""
      turns.push(`packet ${framework}`)
      const planned: ReadonlyArray<{ readonly controlId: string }> = JSON.parse(field(asked, "Controls"))
      const findings: ReadonlyArray<
        { readonly controlId: string; readonly sourceId: string; readonly compliant: boolean }
      > = JSON.parse(field(asked, "Findings"))
      const graded = planned.map(({ controlId }) => {
        const own = findings.filter((finding) => finding.controlId === controlId)
        const status = own.length === 0
          ? "insufficient-evidence" as const
          : own.every((finding) => finding.compliant)
          ? "compliant" as const
          : "non-compliant" as const
        return { controlId, status, evidence: own.map((finding) => finding.sourceId) }
      })
      return {
        framework,
        generatedAt: "2026-10-14T00:00:00Z",
        controlCount: planned.length,
        compliantCount: graded.filter((g) => g.status === "compliant").length,
        nonCompliantCount: graded.filter((g) => g.status === "non-compliant").length,
        findings: graded,
        summary: `${findings.length} findings over ${planned.length} controls`
      }
    }
    return undefined
  }
  return { answer, turns }
}

it.effect("drops an unreachable source and grades each control from the rest", () =>
  Effect.gen(function*() {
    const { answer, turns } = script(accessControls, { unreachable: ["github"] })
    const packet = yield* Kit.run(ComplianceEvidenceCollector, { framework: "SOC2-Type2", scope: "production" }, {
      filename: join(directory, "packet.sqlite"),
      executionId: "compliance-packet",
      script: answer,
      actions: layer
    })

    // One fetch per planned source; every fetch settled before any normalize.
    expect(turns[0]).toBe(`plan SOC2-Type2 scope "production"`)
    const fetches = turns.filter((turn) => turn.startsWith("fetch"))
    expect([...new Set(fetches)].sort()).toEqual(["fetch CC6.1/github", "fetch CC6.1/okta", "fetch CC7.2/siem"])
    const lastFetch = turns.map((turn) => turn.startsWith("fetch")).lastIndexOf(true)
    const firstNormalize = turns.findIndex((turn) => turn.startsWith("normalize"))
    expect(lastFetch).toBeLessThan(firstNormalize)
    // Only the evidence that arrived was normalized, and the packet came last.
    expect(turns.slice(firstNormalize).sort()).toEqual([
      "normalize CC6.1/okta",
      "normalize CC7.2/siem",
      "packet SOC2-Type2"
    ])
    expect(turns.at(-1)).toBe("packet SOC2-Type2")
    expect(packet).toEqual({
      framework: "SOC2-Type2",
      generatedAt: "2026-10-14T00:00:00Z",
      controlCount: 2,
      compliantCount: 1,
      nonCompliantCount: 1,
      findings: [
        { controlId: "CC6.1", status: "compliant", evidence: ["okta"] },
        { controlId: "CC7.2", status: "non-compliant", evidence: ["siem"] }
      ],
      summary: "2 findings over 2 controls"
    })
  }))

it.effect("assembles a SOC2 packet with no fetches when the plan names no sources", () =>
  Effect.gen(function*() {
    const { answer, turns } = script([{ controlId: "CC1.1", description: "Integrity and ethics", sources: [] }])
    const packet = yield* Kit.run(ComplianceEvidenceCollector, {}, {
      filename: join(directory, "empty.sqlite"),
      executionId: "compliance-empty",
      script: answer,
      actions: layer
    })

    expect(turns).toEqual(["plan SOC2 scope null", "packet SOC2"])
    expect(packet.findings).toEqual([{ controlId: "CC1.1", status: "insufficient-evidence", evidence: [] }])
  }))

it.effect("fails without a packet when a normalize fails", () =>
  Effect.gen(function*() {
    const { answer, turns } = script(accessControls, { garbled: ["siem"] })
    const exit = yield* Effect.exit(Kit.run(ComplianceEvidenceCollector, { maxConcurrency: 1 }, {
      filename: join(directory, "normalize-failed.sqlite"),
      executionId: "compliance-normalize-failed",
      script: answer,
      actions: layer
    }))

    // Unlike a fetch, a failed normalize is not dropped: 0.x set no continueOnFail on it.
    expect(Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : undefined).toMatchObject({
      _tag: "Some",
      value: { _tag: "/harness/StructuredOutputFailure" }
    })
    expect(turns).toContain("normalize CC7.2/siem")
    expect(turns).not.toContain("packet SOC2")
  }))

it.effect("keeps every planned pair's evidence when ids repeat or an answer misnames its source", () =>
  Effect.gen(function*() {
    const { answer, turns } = script([{
      controlId: "CC6.1",
      description: "Logical access is restricted",
      sources: [
        { sourceId: "okta", endpoint: "https://okta.test/api/v1/policies", preferredMethod: "api" },
        { sourceId: "okta", endpoint: "https://okta.test/api/v1/factors", preferredMethod: "api" },
        { sourceId: "github", endpoint: "github://org/settings", preferredMethod: "mcp" }
      ]
    }], { misnamed: { github: "okta" } })
    const packet = yield* Kit.run(ComplianceEvidenceCollector, {}, {
      filename: join(directory, "repeated.sqlite"),
      executionId: "compliance-repeated",
      script: answer,
      actions: layer
    })

    expect(turns.filter((turn) => turn.startsWith("fetch")).sort()).toEqual([
      "fetch CC6.1/github",
      "fetch CC6.1/okta",
      "fetch CC6.1/okta"
    ])
    expect(turns.filter((turn) => turn.startsWith("normalize")).sort()).toEqual([
      "normalize CC6.1/github",
      "normalize CC6.1/okta",
      "normalize CC6.1/okta"
    ])
    expect([...packet.findings[0]!.evidence].sort()).toEqual(["github", "okta", "okta"])
  }))

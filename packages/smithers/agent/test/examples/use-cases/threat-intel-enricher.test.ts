import { afterAll, expect, it } from "@effect/vitest"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Kit from "../../../examples/use-cases/kit.ts"
import { layer, ThreatIntelEnricher } from "../../../examples/use-cases/threat-intel-enricher.vibe"

const directory = mkdtempSync(join(tmpdir(), "threat-intel-enricher-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

const field = (asked: string, name: string): string => new RegExp(`\\n${name}: (.+)`).exec(asked)?.[1] ?? ""

/**
 * An ingest step that reads the alert's id and address, enrichers that report
 * on the indicators they are handed, an analyst that grades severity from the
 * external report, and a case step that files what it was told. Each request
 * is recorded in order. `offSchema` names a step that answers off-schema.
 */
const script = (offSchema?: "external") => {
  const turns: Array<string> = []
  const answer: Kit.Script = (asked) => {
    if (asked.includes("Ingest and normalize this security alert")) {
      turns.push(`ingest from ${field(asked, "Source")}`)
      const alert = JSON.parse(field(asked, "Alert"))
      return {
        alertId: alert.id ?? "ALERT-0",
        source: field(asked, "Source"),
        indicators: alert.ip === undefined ? [] : [{ type: "ip", value: alert.ip }],
        rawDescription: alert.text ?? "",
        timestamp: "2026-10-14T00:00:00Z",
        summary: "normalized"
      }
    }
    if (asked.includes("You are a threat intelligence enrichment specialist")) {
      const indicators = JSON.parse(field(asked, "Indicators")) as ReadonlyArray<{ readonly value: string }>
      turns.push(`external ${indicators.map((i) => i.value).join(",")}`)
      if (offSchema === "external") return { unexpected: true }
      return {
        indicators: indicators.map((i) => ({
          value: i.value,
          threatFeeds: ["abuse.ch"],
          knownMalicious: true,
          tags: ["c2"]
        })),
        cveMatches: [],
        summary: "known C2 address"
      }
    }
    if (asked.includes("You are an internal security context gatherer")) {
      turns.push(`internal ${field(asked, "Description")}`)
      return {
        affectedAssets: [{ hostname: "web-1", service: "checkout", environment: "production", owner: "payments" }],
        recentActivity: [],
        priorIncidents: [],
        summary: "one production host"
      }
    }
    if (asked.includes("You are a senior security analyst")) {
      turns.push("analyst")
      const external = JSON.parse(field(asked, "External"))
      const internal = JSON.parse(field(asked, "Internal"))
      const malicious = external.indicators.some((i: { readonly knownMalicious: boolean }) => i.knownMalicious)
      return {
        severity: malicious ? "critical" : "low",
        confidence: 0.9,
        attackVector: "outbound C2",
        firstActions: [`isolate ${internal.affectedAssets[0].hostname}`, "block the address at the egress"],
        narrative: external.summary,
        summary: "C2 beacon from production"
      }
    }
    if (asked.includes("File a case in the case management system")) {
      turns.push("case")
      const assets = JSON.parse(field(asked, "Affected assets")) as ReadonlyArray<{ readonly owner: string }>
      return {
        caseId: "CASE-1",
        severity: field(asked, "Severity"),
        title: field(asked, "Narrative"),
        assignee: assets[0]?.owner ?? "soc",
        firstActions: JSON.parse(field(asked, "First actions")),
        enrichmentSummary: "external and internal",
        status: "open",
        summary: `filed for ${/for alert (\S+)\./.exec(asked)?.[1]}`
      }
    }
    return undefined
  }
  return { answer, turns }
}

it.effect("enriches both ways, then files the analyst's severity and first actions", () =>
  Effect.gen(function*() {
    const { answer, turns } = script()
    const record = yield* Kit.run(
      ThreatIntelEnricher,
      { alert: { id: "ALERT-7", ip: "203.0.113.9", text: "beacon every 60s" }, source: "edr" },
      {
        filename: join(directory, "enriched.sqlite"),
        executionId: "threat-intel-enriched",
        script: answer,
        actions: layer
      }
    )

    // Both enrichments read the ingested alert, and the analyst ran after both.
    expect(turns[0]).toBe("ingest from edr")
    expect([...turns.slice(1, 3)].sort()).toEqual(["external 203.0.113.9", "internal beacon every 60s"])
    expect(turns.slice(3)).toEqual(["analyst", "case"])
    // The case carries the analyst's verdict and the internal asset owner.
    expect(record).toEqual({
      caseId: "CASE-1",
      severity: "critical",
      title: "known C2 address",
      assignee: "payments",
      firstActions: ["isolate web-1", "block the address at the egress"],
      enrichmentSummary: "external and internal",
      status: "open",
      summary: "filed for ALERT-7"
    })
  }))

it.effect("ingests an empty alert from an unknown source when none is given", () =>
  Effect.gen(function*() {
    const { answer, turns } = script()
    const record = yield* Kit.run(ThreatIntelEnricher, {}, {
      filename: join(directory, "defaults.sqlite"),
      executionId: "threat-intel-defaults",
      script: answer,
      actions: layer
    })

    expect(turns).toContain("ingest from unknown")
    expect(turns).toContain("external ")
    expect(record.severity).toBe("low")
    expect(record.summary).toBe("filed for ALERT-0")
  }))

it.effect("fails without an analyst or a case when an enrichment fails", () =>
  Effect.gen(function*() {
    const { answer, turns } = script("external")
    const exit = yield* Effect.exit(Kit.run(ThreatIntelEnricher, { alert: { ip: "198.51.100.1" } }, {
      filename: join(directory, "failed.sqlite"),
      executionId: "threat-intel-failed",
      script: answer,
      actions: layer
    }))

    expect(Exit.isFailure(exit)).toBe(true)
    expect(Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "").toContain("StructuredOutput")
    expect(turns).toContain("external 198.51.100.1")
    expect(turns).not.toContain("analyst")
    expect(turns).not.toContain("case")
  }))

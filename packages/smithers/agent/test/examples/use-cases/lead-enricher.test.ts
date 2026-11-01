import { afterAll, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Kit from "../../../examples/use-cases/kit.ts"
import { layer, LeadEnricher } from "../../../examples/use-cases/lead-enricher.vibe"

const directory = mkdtempSync(join(tmpdir(), "lead-enricher-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

const field = (asked: string, label: string): string => new RegExp(`\\n${label}: (.*)`).exec(asked)?.[1] ?? ""

/**
 * Four agents, each answering from what it was handed: the intake echoes the
 * lead's company, the enricher sizes the company it was told, the profiler
 * scores by that size, and the CRM step copies the profile. Every request is
 * recorded in order with the value that carried the handoff. `brokenEnrich`
 * makes the enricher answer off-schema.
 */
const script = (brokenEnrich = false) => {
  const turns: Array<string> = []
  const answer: Kit.Script = (asked) => {
    if (asked.includes("Normalize this raw inbound lead")) {
      const lead = JSON.parse(field(asked, "Lead")) as { readonly company?: string; readonly email?: string }
      const source = field(asked, "Source")
      turns.push(`intake: ${source} ${JSON.stringify(lead)}`)
      return {
        leadId: "lead-1",
        company: lead.company ?? "unknown",
        contactName: "Ada",
        contactEmail: lead.email ?? "",
        source: source === "webinar" ? "webinar" : "other",
        rawNotes: "asked about SSO",
        summary: "inbound lead"
      }
    }
    if (asked.includes("You are a firmographic enrichment specialist")) {
      const company = field(asked, "Company")
      turns.push(`enrich: ${company}`)
      if (brokenEnrich) return { unexpected: true }
      return {
        firmographics: { industry: "logistics", employeeCount: company === "Acme" ? 1200 : 15, hqLocation: "Berlin" },
        techStack: ["postgres"],
        recentNews: [{ headline: `${company} raises series C`, relevance: "high" }],
        competitors: [],
        summary: `${company} enriched`
      }
    }
    if (asked.includes("You are a lead profiling strategist")) {
      const intake = JSON.parse(field(asked, "Intake")) as { readonly leadId: string; readonly company: string }
      const { employeeCount } = JSON.parse(field(asked, "Firmographics")) as { readonly employeeCount: number }
      turns.push(`profile: ${intake.leadId} ${intake.company} ${employeeCount}`)
      const enterprise = employeeCount >= 1000
      return {
        segment: enterprise ? "enterprise" : "startup",
        icpFit: enterprise ? 0.9 : 0.3,
        buyerPersona: "VP Operations",
        painPoints: ["manual routing"],
        recommendedPlaybook: enterprise ? "enterprise-sso" : "self-serve",
        talkingPoints: [`${intake.company} is hiring`],
        summary: "profiled"
      }
    }
    if (asked.includes("Write the CRM record for this profiled lead")) {
      const profile = JSON.parse(field(asked, "Profile")) as {
        readonly leadId: string
        readonly company: string
        readonly segment: string
        readonly icpFit: number
        readonly recommendedPlaybook: string
      }
      turns.push(`crm: ${profile.segment} ${profile.recommendedPlaybook}`)
      return {
        leadId: profile.leadId,
        company: profile.company,
        segment: profile.segment,
        icpFit: profile.icpFit,
        owner: "enterprise-ae",
        nextAction: `Run the ${profile.recommendedPlaybook} playbook`,
        status: "enriched",
        profileSummary: `${profile.company} fits at ${profile.icpFit}`,
        summary: "written"
      }
    }
    return undefined
  }
  return { answer, turns }
}

it.effect("hands each step's output to the next and settles with the CRM record", () =>
  Effect.gen(function*() {
    const { answer, turns } = script()
    const record = yield* Kit.run(LeadEnricher, {
      lead: { company: "Acme", email: "ada@acme.test" },
      source: "webinar"
    }, {
      filename: join(directory, "enriched.sqlite"),
      executionId: "lead-enricher-enriched",
      script: answer,
      actions: layer
    })

    // One request per step, in order, each carrying what the step before it produced.
    expect(turns).toEqual([
      `intake: webinar {"company":"Acme","email":"ada@acme.test"}`,
      "enrich: Acme",
      "profile: lead-1 Acme 1200",
      "crm: enterprise enterprise-sso"
    ])
    expect(record).toEqual({
      leadId: "lead-1",
      company: "Acme",
      segment: "enterprise",
      icpFit: 0.9,
      owner: "enterprise-ae",
      nextAction: "Run the enterprise-sso playbook",
      status: "enriched",
      profileSummary: "Acme fits at 0.9",
      summary: "written"
    })
  }))

it.effect("hands the intake an empty lead from an unknown source when none is given", () =>
  Effect.gen(function*() {
    const { answer, turns } = script()
    const record = yield* Kit.run(LeadEnricher, {}, {
      filename: join(directory, "defaults.sqlite"),
      executionId: "lead-enricher-defaults",
      script: answer,
      actions: layer
    })

    expect(turns[0]).toBe("intake: other {}")
    expect(record.company).toBe("unknown")
    expect(record.segment).toBe("startup")
  }))

it.effect("fails the run when enrichment fails, before profiling or writing anything", () =>
  Effect.gen(function*() {
    const { answer, turns } = script(true)
    const exit = yield* Effect.exit(Kit.run(LeadEnricher, { lead: { company: "Acme" } }, {
      filename: join(directory, "enrich-fails.sqlite"),
      executionId: "lead-enricher-enrich-fails",
      script: answer,
      actions: layer
    }))

    expect(Exit.isFailure(exit)).toBe(true)
    expect(turns).toContain("enrich: Acme")
    expect(turns.some((turn) => turn.startsWith("profile") || turn.startsWith("crm"))).toBe(false)
  }))

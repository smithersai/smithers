import { afterAll, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Kit from "../../../examples/use-cases/kit.ts"
import { layer, TrustSafetyModerator } from "../../../examples/use-cases/trust-safety-moderator.vibe"

const directory = mkdtempSync(join(tmpdir(), "trust-safety-moderator-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

const field = (asked: string, name: string): string => new RegExp(`\\n${name}: (.+)`).exec(asked)?.[1] ?? ""

/**
 * An intake that ids the content by its author, a moderator that is unsure of
 * anything containing "kill" and blocks anything containing "buy now", and an
 * action handler that decides from the moderation it is handed. Each request
 * is recorded in order. With `brokenModerator` the moderator answers
 * off-schema.
 */
const script = (brokenModerator = false) => {
  const turns: Array<string> = []
  const answer: Kit.Script = (asked) => {
    if (asked.includes("Take in this content for moderation")) {
      turns.push(`intake ${field(asked, "Source")} by ${field(asked, "Author")}`)
      return {
        contentId: `post-${field(asked, "Author")}`,
        contentType: "text",
        rawText: JSON.parse(field(asked, "Content")),
        metadata: { source: field(asked, "Source"), authorId: field(asked, "Author") }
      }
    }
    if (asked.includes("You are a trust & safety content moderator")) {
      const header = /Moderate content (\S+) \(\w+\) against the (\S+) policies/.exec(asked)
      const text: string = JSON.parse(field(asked, "Text"))
      turns.push(`moderate ${header?.[1]} under ${header?.[2]}`)
      if (brokenModerator) return { unexpected: true }
      const unsure = text.includes("kill")
      const spam = text.includes("buy now")
      return {
        contentId: header?.[1],
        riskLevel: spam ? "block" : unsure ? "medium" : "allow",
        policyClass: spam ? "spam" : unsure ? "violence" : "safe",
        confidence: unsure ? 0.55 : 0.97,
        reasoning: unsure ? "gaming slang or a threat" : "clear",
        flaggedSegments: unsure ? [{ text: "kill", policy: "violence", severity: "medium" }] : [],
        needsHumanReview: unsure
      }
    }
    if (asked.includes("You are a trust & safety action handler")) {
      const moderation = JSON.parse(field(asked, "Moderation"))
      turns.push(`act on ${moderation.contentId}`)
      const decision = moderation.needsHumanReview
        ? "escalated"
        : moderation.riskLevel === "block"
        ? "rejected"
        : "approved"
      return {
        contentId: moderation.contentId,
        decision,
        action: decision === "escalated" ? "queued for review" : decision,
        ...(decision === "escalated"
          ? { escalationReason: `${moderation.policyClass} at confidence ${moderation.confidence}` }
          : {}),
        summary: `${moderation.flaggedSegments.length} flagged segments`
      }
    }
    return undefined
  }
  return { answer, turns }
}

it.effect("escalates content the moderator is unsure of", () =>
  Effect.gen(function*() {
    const { answer, turns } = script()
    const decision = yield* Kit.run(
      TrustSafetyModerator,
      { content: "I will kill you in the next round", source: "chat", authorId: "u42", policies: "community" },
      {
        filename: join(directory, "escalated.sqlite"),
        executionId: "trust-safety-escalated",
        script: answer,
        actions: layer
      }
    )

    // Each step read the one before it: the intake's id, then the moderation.
    expect(turns).toEqual(["intake chat by u42", "moderate post-u42 under community", "act on post-u42"])
    expect(decision).toEqual({
      contentId: "post-u42",
      decision: "escalated",
      action: "queued for review",
      escalationReason: "violence at confidence 0.55",
      summary: "1 flagged segments"
    })
  }))

it.effect("screens an anonymous submission against the default policies", () =>
  Effect.gen(function*() {
    const { answer, turns } = script()
    const decision = yield* Kit.run(TrustSafetyModerator, { content: "buy now!!! cheap watches" }, {
      filename: join(directory, "defaults.sqlite"),
      executionId: "trust-safety-defaults",
      script: answer,
      actions: layer
    })

    expect(turns).toEqual([
      "intake user_submission by anonymous",
      "moderate post-anonymous under default",
      "act on post-anonymous"
    ])
    expect(decision.decision).toBe("rejected")
  }))

it.effect("fails without acting when the moderation fails", () =>
  Effect.gen(function*() {
    const { answer, turns } = script(true)
    const exit = yield* Effect.exit(Kit.run(TrustSafetyModerator, { content: "hello" }, {
      filename: join(directory, "failed.sqlite"),
      executionId: "trust-safety-failed",
      script: answer,
      actions: layer
    }))

    expect(Exit.isFailure(exit)).toBe(true)
    expect(turns).toContain("moderate post-anonymous under default")
    expect(turns.some((turn) => turn.startsWith("act on"))).toBe(false)
  }))

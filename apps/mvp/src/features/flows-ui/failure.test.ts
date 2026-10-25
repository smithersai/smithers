// Why a draft round failed, read from the drafting agent's failure (./failure.ts): its tags and codes only.
import { AgentAction, Budget, Seat } from "@smthrs/agent"
import { HarnessError, StructuredOutput } from "@smthrs/harness"
import { ModelError } from "@smthrs/model"
import { Schema } from "effect"
import { describe, expect, test } from "vitest"
import { DRAFT_FAILURE_WORDS } from "./contract"
import { DRAFT_FAILURES, draftFailure } from "./failure"

const SENTINEL = "SENTINEL-the-model-said-this"

/** A model call that failed with `code`, wrapped as the agent's step reports it. */
const modelFailed = (code: ModelError.ModelErrorCode, httpStatus?: number) =>
  new HarnessError.HarnessError({
    code: "model_failed",
    message: SENTINEL,
    cause: new ModelError.ModelError({ code, message: SENTINEL, ...(httpStatus === undefined ? {} : { httpStatus }) }),
  })

/**
 * The failure as `flow/new/write` receives it: rendered as `AgentAction` renders it (a harness error's cause as plain
 * JSON), then through the journal's codec and back.
 */
const journaled = (failure: AgentAction.AgentFailure) => {
  const codec = Schema.toCodecJson(AgentAction.AgentFailure)
  const rendered = failure instanceof HarnessError.HarnessError && failure.cause !== undefined
    ? new HarnessError.HarnessError({ code: failure.code, message: failure.message, cause: JSON.parse(JSON.stringify(failure.cause)) })
    : failure
  return Schema.decodeUnknownSync(codec)(JSON.parse(JSON.stringify(Schema.encodeSync(codec)(rendered))))
}

const budget = new Budget.BudgetExceeded({ scope: "daily", onExceeded: "fail", used: 2, max: 1, next: 1, message: SENTINEL })

describe("draftFailure", () => {
  test("a model call refused for having no route, or no sign-in, is no_model", () => {
    expect(draftFailure(modelFailed("no_route", 409))).toBe("no_model")
    expect(draftFailure(journaled(modelFailed("no_route", 409)))).toBe("no_model")
    expect(draftFailure(modelFailed("authentication", 401))).toBe("no_model")
    expect(draftFailure(new Seat.SeatUnresolved({ seat: "agent", message: SENTINEL }))).toBe("no_model")
    expect(draftFailure({ _tag: "@smthrs/agent/Seat/SeatUnrouted", reason: "no_candidates" })).toBe("no_model")
  })

  test("a spent budget, the day's or the run's, is quota; a provider's rate limit is rate_limited", () => {
    expect(draftFailure(modelFailed("quota_exceeded", 429))).toBe("quota")
    expect(draftFailure(modelFailed("out_of_credit", 402))).toBe("quota")
    expect(draftFailure(budget)).toBe("quota")
    expect(draftFailure({ _tag: "flows/agent/Skipped", budget, message: SENTINEL })).toBe("quota")
    expect(draftFailure(new HarnessError.HarnessError({ code: "model_failed", message: SENTINEL, cause: budget }))).toBe("quota")
    expect(draftFailure(journaled(modelFailed("rate_limited", 429)))).toBe("rate_limited")
  })

  test("an answer that never decoded is undecodable; one that ran out of frames is frames", () => {
    const undecoded = new StructuredOutput.StructuredOutputFailure({
      code: "correction_exhausted",
      schema: "s",
      candidate: "c",
      corrections: 2,
      limit: 2,
      issues: [],
      message: SENTINEL,
    })
    expect(draftFailure(undecoded)).toBe("undecodable")
    expect(draftFailure(journaled(undecoded))).toBe("undecodable")
    expect(draftFailure({ _tag: "/harness/HarnessError", code: "model_failed", message: SENTINEL, cause: { _tag: "FramesExhausted", frames: 8, corrected: 0 } }))
      .toBe("frames")
  })

  test("anything else, or nothing readable, is model_error", () => {
    for (const code of ["invalid_request", "provider_internal", "transport", "call_timeout", "unknown"] as const) {
      expect(draftFailure(modelFailed(code))).toBe("model_error")
    }
    expect(draftFailure(new HarnessError.HarnessError({ code: "engine_failed", message: SENTINEL }))).toBe("model_error")
    for (const value of [undefined, null, "draft", 5, {}, { _tag: 5 }, { _tag: "toString" }, { _tag: "flows/model/ModelError", code: "toString" }]) {
      expect(draftFailure(value)).toBe("model_error")
    }
  })

  test("the innermost failure that names a code wins, a cycle ends the walk, and the walk stops 16 deep", () => {
    // A rate limit wrapped in a harness error wrapped again: the model's own code.
    expect(draftFailure({ _tag: "x", cause: { _tag: "/harness/HarnessError", code: "model_failed", cause: modelFailed("rate_limited") } }))
      .toBe("rate_limited")
    const cycle: { _tag: string; cause?: unknown } = { _tag: "flows/agent/BudgetExceeded" }
    cycle.cause = cycle
    expect(draftFailure(cycle)).toBe("quota")
    let deep: unknown = { _tag: "/harness/StructuredOutputFailure" }
    for (let i = 0; i < 16; i++) deep = { _tag: "wrap", cause: deep }
    expect(draftFailure(deep)).toBe("model_error")
    // A field whose read throws counts as absent.
    const hostile = Object.defineProperty({}, "_tag", { enumerable: true, get: () => { throw new Error(SENTINEL) } })
    expect(draftFailure(hostile)).toBe("model_error")
  })

  test("a provider refusing for credit or quota never reads as Smithers' own budget", () => {
    // 2026-10-25: a person's provider answered 402 for billing, and the draft said "Model budget spent" while the day's
    // budget stood at 1,554 of 5,000,000 tokens.
    expect(DRAFT_FAILURE_WORDS[draftFailure(modelFailed("out_of_credit", 402))]).toBe("Model credit or quota used up")
    expect(DRAFT_FAILURE_WORDS.quota).not.toMatch(/budget/i)
  })

  test("the codes are closed, and none carries what the failure said", () => {
    expect(DRAFT_FAILURES).toEqual(["no_model", "quota", "rate_limited", "undecodable", "frames", "model_error", "checks", "stopped", "ended"])
    for (const code of DRAFT_FAILURES) expect(code).not.toContain("SENTINEL")
  })
})

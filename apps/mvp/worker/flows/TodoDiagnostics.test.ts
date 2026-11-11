import { Budget } from "@smthrs/agent"
import { HarnessError, Sandbox } from "@smthrs/harness"
import { Evaluator, ModelError } from "@smthrs/model"
import { expect, test } from "vitest"
import { agentFailureCodes } from "./TodoDiagnostic.vibe"

test("TODO failure diagnostics keep typed agent and model codes without messages", () => {
  const privateText = "private repository content and provider message"
  const failure = new HarnessError.HarnessError({
    code: "model_failed",
    message: privateText,
    cause: new ModelError.ModelError({ code: "rate_limited", message: privateText }),
  })
  const codes = agentFailureCodes(failure)
  expect(codes).toEqual({ harnessCode: "model_failed", modelCode: "rate_limited", budgetScope: "none", causeCode: "none" })
  expect(JSON.stringify(codes)).not.toContain(privateText)
  expect(agentFailureCodes(JSON.parse(JSON.stringify(failure)))).toEqual(codes)
})

test("TODO failure diagnostics refuse arbitrary codes in a serialized cause", () => {
  expect(agentFailureCodes(new HarnessError.HarnessError({ code: "engine_failed", message: "private cause" })))
    .toEqual({ harnessCode: "engine_failed", modelCode: "none", budgetScope: "none", causeCode: "none" })
  expect(agentFailureCodes({
    _tag: "/harness/HarnessError",
    code: "model_failed",
    cause: { _tag: "flows/model/ModelError", code: "custom provider response" },
  })).toEqual({ harnessCode: "model_failed", modelCode: "none", budgetScope: "none", causeCode: "none" })
  expect(agentFailureCodes({
    _tag: "/harness/HarnessError",
    code: "unknown code with user content",
    cause: { _tag: "flows/model/ModelError", code: "custom provider response" },
  })).toEqual({ harnessCode: "none", modelCode: "none", budgetScope: "none", causeCode: "none" })
  expect(agentFailureCodes({ _tag: "@smthrs/mvp/todo/TodoFailed", failure: "implement" }))
    .toEqual({ harnessCode: "none", modelCode: "none", budgetScope: "none", causeCode: "none" })
})

test("TODO failure diagnostics distinguish finite agent budget scopes without amounts or messages", () => {
  const privateText = "private request content"
  const budget = new Budget.BudgetExceeded({
    scope: "daily", onExceeded: "fail", used: 12, max: 10, next: 3, message: privateText,
  })
  const expected = { harnessCode: "none", modelCode: "none", budgetScope: "daily", causeCode: "none" }
  expect(agentFailureCodes(budget)).toEqual(expected)
  expect(agentFailureCodes(JSON.parse(JSON.stringify(budget)))).toEqual(expected)
  expect(agentFailureCodes(new Budget.Skipped({ budget, message: privateText }))).toEqual(expected)
  expect(agentFailureCodes(new HarnessError.HarnessError({
    code: "model_failed", message: privateText, cause: budget,
  }))).toEqual({ ...expected, harnessCode: "model_failed" })
  expect(JSON.stringify(expected)).not.toContain(privateText)
  expect(agentFailureCodes({ _tag: "flows/agent/BudgetExceeded", scope: privateText }))
    .toEqual({ harnessCode: "none", modelCode: "none", budgetScope: "none", causeCode: "none" })
})

test("TODO diagnostics retain only finite evaluator, sandbox, and repeated-failure causes", () => {
  const privateText = "private request and repository content"
  const harness = (cause: unknown) => new HarnessError.HarnessError({
    code: "engine_failed", message: privateText, cause,
  })
  const cases = [
    [new Evaluator.EvaluatorError({ code: "unreachable", message: privateText }), "evaluator_unreachable"],
    [new Sandbox.SandboxError({ code: "runtime_failed", message: privateText }), "sandbox_runtime_failed"],
    [{ _tag: "/harness/CellTurn/RepeatedFailure", frames: 5, message: privateText }, "repeated_failure"],
  ] as const
  for (const [cause, causeCode] of cases) {
    const expected = { harnessCode: "engine_failed", modelCode: "none", budgetScope: "none", causeCode }
    expect(agentFailureCodes(harness(cause))).toEqual(expected)
    expect(agentFailureCodes(JSON.parse(JSON.stringify(harness(cause))))).toEqual(expected)
    expect(JSON.stringify(expected)).not.toContain(privateText)
  }
  expect(agentFailureCodes(harness({ _tag: "flows/harness/SandboxError", code: privateText })))
    .toMatchObject({ causeCode: "none" })
  expect(agentFailureCodes(harness({ _tag: privateText, code: "runtime_failed" })))
    .toMatchObject({ causeCode: "none" })
})

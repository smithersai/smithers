import { describe, expect, it } from "vitest"
import { failure, unavailable } from "../../src/select/Failure.vibe"

const model = "The model that predicts which tests a change cannot break"
const classifier = "flows/model/ClassifierError"

describe("what a person reads when the model does not answer", () => {
  it.each([
    [
      "no key and no sign-in",
      { code: "unconfigured" },
      `${model} needs a key or a sign-in, and this machine has neither. Set AI_GATEWAY_API_KEY, run \`claude auth login\` with ANTHROPIC_API_KEY unset, or run \`codex login\` with SMITHERS_OPENAI_AUTH=chatgpt.`
    ],
    [
      "a usage limit",
      { code: "refused", status: 429 },
      `${model} is over its usage limit. Run this again when the limit resets.`
    ],
    [
      "a refusal",
      { code: "refused", status: 401 },
      `${model} refused the request. Check AI_GATEWAY_API_KEY or your sign-in.`
    ],
    [
      "no answer in time",
      { code: "timeout" },
      `${model} did not answer in time. Check this machine's network and run this again.`
    ],
    [
      "no connection",
      { code: "unreachable" },
      `${model} could not be reached. Check this machine's network, AI_GATEWAY_API_KEY and your sign-in.`
    ],
    ["an empty answer", { code: "empty" }, `${model} did not give a usable answer. Run this again.`],
    ["an answer it cannot read", { code: "invalid_answer" }, `${model} did not give a usable answer. Run this again.`],
    ["a question it rejected", { code: "invalid_question" }, `${model} did not give a usable answer. Run this again.`]
  ])("says what to do about %s", (_name, error, line) => {
    expect(unavailable({ _tag: classifier, ...error })).toBe(line)
  })

  it("reads a failure of the engine around the request as an unusable answer", () => {
    expect(unavailable({ _tag: "StoreUnavailable" })).toBe(`${model} did not give a usable answer. Run this again.`)
  })

  it("never uses the program's own words, or the service's", () => {
    const codes = ["unconfigured", "refused", "timeout", "unreachable", "empty"]
    for (const code of codes) {
      expect(unavailable({ _tag: classifier, code } as never)).not.toMatch(/judge|scorer|rows|Jev/i)
    }
  })

  it("makes a failure of the select part", () => {
    expect(failure("model-unavailable", "m")).toEqual({ code: "model-unavailable", message: "m", part: "select" })
  })
})

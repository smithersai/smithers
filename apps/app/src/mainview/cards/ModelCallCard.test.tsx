import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, describe, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { MODEL_CALL_NAME_MAX, MODEL_CALL_STATE_MAX_BYTES, MODEL_CALL_TEMPERATURE_TEXT_MAX, MODEL_CALL_TEXT_MAX, ModelCallCardPayloadSchema } from "@smthrs/rpc/ConfiguredModel"
import type { ModelCallCardPayload, ModelTestResult } from "@smthrs/rpc/ConfiguredModel"
import type { Card } from "../state/AppState"
import { modelAnswerLine, ModelCallCardBody, modelCallPill } from "./ModelCallCard"

/*
 * The composer card: the request is controls, each committing through its
 * flow with its args, and the answer is read-only text beside the question
 * it answered. Every state is asserted through the DOM contract the real
 * suite reads (data-field, data-question, data-stale, data-problem).
 */

GlobalRegistrator.register()

afterAll(async () => {
  for (let tick = 0; tick < 3; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0))
  await GlobalRegistrator.unregister()
})

type ModelCallCard = Extract<Card, { kind: "model-call" }>

const decision: ModelCallCardPayload["request"] = {
  kind: "decision",
  state: [
    { key: "text", kind: "text", value: "The sky is blue." },
    { key: "diff", kind: "diff", value: "@@ -1 +1 @@\n-a\n+b" },
    { key: "passed", kind: "boolean", value: "true" },
    { key: "count", kind: "number", value: "3" }
  ],
  questions: {
    q2: { type: "score", instructions: "How sure?", criteria: ["low", "high"] },
    ok: { type: "boolean", instructions: "Does it mention a color?" },
    q1: { type: "choice", instructions: "Which?", criteria: { b: "a rose", a: "the sky" } }
  }
}
const answered: ModelTestResult = {
  ok: true, latencyMs: 41, sample: "true 0.97",
  output: { kind: "decision", answers: {
    ok: { type: "boolean", value: true, probability: 0.97 },
    q1: { type: "choice", value: "a", probabilities: { a: 0.97, b: 0 }, confidence: 0.97 },
    q2: { type: "score", value: 1, label: "high", probabilities: { low: 0, high: 1 }, confidence: 1 }
  } }
}
const generation: ModelCallCardPayload["request"] = { kind: "generation", system: "Answer tersely.", prompt: "ping?", maxTokens: 64, temperature: "0.2" }
/** An ask that is out: the snapshot the card holds while it is. */
const out = (request: ModelCallCardPayload["request"]): NonNullable<ModelCallCardPayload["pending"]> =>
  ({ requestId: "ask-0001", request, binding: { protocol: "evaluation", modelId: "typesafe-ai/jev", credential: "AI_GATEWAY_API_KEY" }, owner: null })

/** A payload the wire accepts: a fixture the schema refuses would prove nothing about the card. */
const card = (payload: ModelCallCardPayload): ModelCallCard => ({
  id: `model-call-${payload.model}`, kind: "model-call", title: payload.model, status: "active", createdAt: 0, ordinal: 0,
  payload: ModelCallCardPayloadSchema.parse(payload)
})

/** One root, kept, so a later snapshot rerenders the same tree: a second createRoot would remount and reset every defaultValue. */
const mount = (node: React.ReactNode): { host: HTMLElement; rerender: (next: React.ReactNode) => void } => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  const rerender = (next: React.ReactNode) => flushSync(() => { root.render(next) })
  rerender(node)
  return { host, rerender }
}
const recorder = () => {
  const calls: Array<[string, string | undefined]> = []
  return { calls, onRunCommand: (name: string, args?: string) => void calls.push([name, args]) }
}
const render = (payload: ModelCallCardPayload, recall = false) => {
  const { calls, onRunCommand } = recorder()
  const { host, rerender } = mount(<ModelCallCardBody card={card(payload)} recall={recall} onRunCommand={onRunCommand} />)
  const root = host.querySelector<HTMLElement>('[data-testid="model-call"]')!
  return {
    host, root, calls,
    args: (call: [string, string | undefined]) => JSON.parse(call[1] ?? "{}") as Record<string, unknown>,
    rerender: (next: ModelCallCardPayload) => rerender(<ModelCallCardBody card={card(next)} recall={recall} onRunCommand={onRunCommand} />)
  }
}
const input = (root: Element, selector: string): HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement => {
  const element = root.querySelector<HTMLInputElement>(selector)
  if (element === null) throw new Error(`nothing matches ${selector}`)
  return element
}
const type = (element: Element, value: string): void => {
  const node = element as HTMLInputElement
  node.value = value
  node.dispatchEvent(new Event("input", { bubbles: true }))
}

describe("the composer, a decision request", () => {
  test("the state is fields, each drawn by its kind, and questions are drawn in name order with their kind", () => {
    const { root } = render({ model: "judge", request: decision })
    expect(root.getAttribute("data-kind")).toBe("decision")
    const fields = [...root.querySelectorAll("[data-field]")].map((field) => [field.getAttribute("data-field"), field.getAttribute("data-field-kind")])
    expect(fields).toEqual([["text", "text"], ["diff", "diff"], ["passed", "boolean"], ["count", "number"]])
    expect(input(root, '[data-field="diff"] textarea').value).toBe("@@ -1 +1 @@\n-a\n+b")
    expect((input(root, '[data-field="passed"] input[type="checkbox"]') as HTMLInputElement).checked).toBe(true)
    expect(input(root, '[data-field="count"] input[type="number"]').value).toBe("3")
    // No raw JSON anywhere: the state reads as its fields.
    expect(root.textContent).not.toContain("{")
    expect([...root.querySelectorAll("[data-question]")].map((question) => [question.getAttribute("data-question"), question.getAttribute("data-question-type")]))
      .toEqual([["ok", "boolean"], ["q1", "choice"], ["q2", "score"]])
    expect([...root.querySelectorAll('[data-question="q1"] [data-option]')].map((option) => option.getAttribute("data-option"))).toEqual(["a", "b"])
    expect([...root.querySelectorAll('[data-question="q2"] [data-option]')].map((option) => option.getAttribute("data-option"))).toEqual(["low", "high"])
  })

  test("every edit is its flow with its args: field value, field kind, field rename, question wording, question kind, question rename, option, option rename, and the removes", () => {
    const { root, calls, args } = render({ model: "judge", request: decision })
    type(input(root, '[data-field="text"] input[type="text"]'), "The sky is red.")
    ;(input(root, '[data-field="count"] select') as HTMLSelectElement).value = "boolean"
    input(root, '[data-field="count"] select').dispatchEvent(new Event("change", { bubbles: true }))
    const key = input(root, '[data-field="diff"] input[aria-label="Key"]')
    key.value = "patch"
    // React's onBlur listens for focusout, which bubbles.
    key.dispatchEvent(new FocusEvent("focusout", { bubbles: true }))
    type(input(root, '[data-question="q1"] textarea'), "Which one?")
    ;(input(root, '[data-question="q1"] select') as HTMLSelectElement).value = "score"
    input(root, '[data-question="q1"] select').dispatchEvent(new Event("change", { bubbles: true }))
    const id = input(root, '[data-question="q1"] input[aria-label="Id"]')
    // Leaving the id as it was is no edit.
    id.dispatchEvent(new FocusEvent("focusout", { bubbles: true }))
    id.value = "which"
    id.dispatchEvent(new FocusEvent("focusout", { bubbles: true }))
    type(input(root, '[data-question="q1"] [data-option="a"] input[aria-label="About a"]'), "the blue one")
    type(input(root, '[data-question="ok"] input[aria-label="True"]'), "names a color")
    const option = input(root, '[data-question="q1"] [data-option="a"] input[aria-label="Option"]')
    option.value = "c"
    option.dispatchEvent(new FocusEvent("focusout", { bubbles: true }))
    root.querySelector<HTMLButtonElement>('[data-question="q1"] [data-testid="model-call-option-add"]')!.click()
    root.querySelector<HTMLButtonElement>('[data-testid="model-call-field-add"]')!.click()
    root.querySelector<HTMLButtonElement>('[data-testid="model-call-question-add"]')!.click()
    root.querySelector<HTMLButtonElement>('[data-question="q2"] [data-option="low"] button')!.click()
    root.querySelector<HTMLButtonElement>('[data-field="passed"] button')!.click()
    root.querySelector<HTMLButtonElement>('[data-question="q2"] .model-call-question-head button')!.click()
    expect(calls.map(([name]) => name)).toEqual(["model.state", "model.state", "model.state", "model.question", "model.question", "model.question", "model.option", "model.question", "model.option", "model.option", "model.state", "model.question", "model.option", "model.state", "model.question"])
    expect(calls.map(args)).toEqual([
      { id: "judge", key: "text", value: "The sky is red." },
      { id: "judge", key: "count", kind: "boolean" },
      { id: "judge", key: "patch", was: "diff" },
      { id: "judge", question: "q1", instructions: "Which one?" },
      { id: "judge", question: "q1", type: "score" },
      { id: "judge", question: "which", was: "q1" },
      { id: "judge", question: "q1", option: "a", about: "the blue one" },
      { id: "judge", question: "ok", criteria: { true: "names a color", false: "" } },
      { id: "judge", question: "q1", option: "c", was: "a" },
      { id: "judge", question: "q1" },
      { id: "judge" },
      { id: "judge" },
      { id: "judge", question: "q2", option: "low", remove: true },
      { id: "judge", key: "passed", remove: true },
      { id: "judge", question: "q2", remove: true }
    ])
  })

  test("every free text box says what it takes, and none takes more than the wire carries", () => {
    const { root } = render({ model: "judge", request: decision })
    expect(input(root, '[data-question="q1"] textarea').getAttribute("placeholder")).toBe("Question")
    expect(input(root, '[data-question="q1"] [data-option="a"] input[aria-label="About a"]').getAttribute("placeholder")).toBe("About")
    expect(input(root, '[data-question="ok"] input[aria-label="True"]').getAttribute("placeholder")).toBe("true")
    expect(input(root, '[data-question="ok"] input[aria-label="False"]').getAttribute("placeholder")).toBe("false")
    expect(input(root, '[data-question="q1"] textarea').getAttribute("maxlength")).toBe(String(MODEL_CALL_TEXT_MAX))
    expect(input(root, '[data-question="q1"] [data-option="a"] input[aria-label="About a"]').getAttribute("maxlength")).toBe(String(MODEL_CALL_TEXT_MAX))
    expect(input(root, '[data-question="ok"] input[aria-label="True"]').getAttribute("maxlength")).toBe(String(MODEL_CALL_TEXT_MAX))
    expect(input(root, '[data-question="q1"] [data-option="a"] input[aria-label="Option"]').getAttribute("maxlength")).toBe(String(MODEL_CALL_NAME_MAX))
    expect(input(root, '[data-question="q2"] [data-option="low"] input[aria-label="Rung"]').getAttribute("maxlength")).toBe(String(MODEL_CALL_NAME_MAX))
    expect(input(root, '[data-field="text"] input[type="text"]').getAttribute("maxlength")).toBe(String(MODEL_CALL_STATE_MAX_BYTES * 4))
    expect(input(root, '[data-field="diff"] textarea').getAttribute("maxlength")).toBe(String(MODEL_CALL_STATE_MAX_BYTES * 4))
  })

  test("a snapshot that lags the keystrokes leaves the focused control alone, and catches it up once it is left", () => {
    const { root, rerender } = render({ model: "judge", request: decision })
    const box = input(root, '[data-question="ok"] textarea')
    box.focus()
    expect(document.activeElement).toBe(box)
    box.value = "Does it mention a colour?"
    rerender({ model: "judge", request: decision })
    expect(box.value).toBe("Does it mention a colour?")
    box.blur()
    rerender({ model: "judge", request: decision })
    expect(box.value).toBe("Does it mention a color?")
  })

  test("a request with a problem says which, and Ask waits; a request without one asks", () => {
    const broken = render({ model: "judge", request: { ...decision, questions: { ...decision.questions, q1: { type: "choice", instructions: "Which?", criteria: { a: "" } } } } })
    expect(broken.root.querySelector('[data-testid="model-call-problem"]')?.textContent).toBe("options_count · q1 · 1")
    expect(broken.root.querySelector('[data-testid="model-call-problem"]')?.getAttribute("data-problem")).toBe("options_count")
    expect(broken.root.querySelector<HTMLButtonElement>('[data-testid="model-call-ask"]')?.disabled).toBe(true)
    const ready = render({ model: "judge", request: decision })
    expect(ready.root.querySelector('[data-testid="model-call-problem"]')).toBeNull()
    const ask = ready.root.querySelector<HTMLButtonElement>('[data-testid="model-call-ask"]')!
    expect([ask.disabled, ask.textContent, ask.getAttribute("data-flow"), ask.getAttribute("data-flow-args")]).toEqual([false, "Ask", "model.ask", "judge"])
    ask.click()
    expect(ready.calls).toEqual([["model.ask", "judge"]])
    const asking = render({ model: "judge", request: decision, pending: out(decision) })
    expect(asking.root.querySelector<HTMLButtonElement>('[data-testid="model-call-ask"]')?.disabled).toBe(true)
    expect(asking.root.getAttribute("data-asking")).toBe("true")
    // A rung named as an object's prototype is on screen as typed, beside why it cannot be asked.
    const reserved = render({ model: "judge", request: { ...decision, questions: { q2: { type: "score", instructions: "How sure?", criteria: ["__proto__", "high"] } } } })
    expect(input(reserved.root, '[data-option="__proto__"] input').value).toBe("__proto__")
    expect(reserved.root.querySelector('[data-testid="model-call-problem"]')?.textContent).toBe("name_reserved · q2 · __proto__")
    expect(reserved.root.querySelector<HTMLButtonElement>('[data-testid="model-call-ask"]')?.disabled).toBe(true)
  })

  test("the answer stands beside each question as its value and number, and reads stale once the request moves on", () => {
    const fresh = render({ model: "judge", request: decision, response: { askedAt: 1, request: decision, result: answered } })
    expect(fresh.root.getAttribute("data-stale")).toBe("false")
    expect([...fresh.root.querySelectorAll('[data-testid="model-call-answer"]')].map((answer) => answer.textContent)).toEqual(["yes · 0.97", "a · 0.97", "high · 1"])
    expect(fresh.root.querySelector('[data-testid="model-call-result"]')?.textContent).toBe("41 ms")
    expect(fresh.root.querySelector<HTMLButtonElement>('[data-testid="model-call-ask"]')?.textContent).toBe("Ask again")
    const edited = { ...decision, questions: { ...decision.questions, q1: { type: "choice" as const, instructions: "Which now?", criteria: { b: "a rose", a: "the sky" } } } }
    const stale = render({ model: "judge", request: edited, response: { askedAt: 1, request: decision, result: answered } })
    expect(stale.root.getAttribute("data-stale")).toBe("true")
    expect(stale.root.querySelectorAll('[data-testid="model-call-answer"]')).toHaveLength(3)
    // Nothing on the card lets the answer be typed into.
    expect(stale.root.querySelector('[data-testid="model-call-answer"] input, [data-testid="model-call-answer"] textarea')).toBeNull()
    // A question added after the answer has none.
    const grown = render({ model: "judge", request: { ...decision, questions: { ...decision.questions, q3: { type: "boolean", instructions: "New?" } } }, response: { askedAt: 1, request: decision, result: answered } })
    expect(grown.root.querySelector('[data-question="q3"] [data-testid="model-call-answer"]')).toBeNull()
  })

  test("a failed answer is its code and number, and the pill follows the state", () => {
    const refused: ModelTestResult = { ok: false, latencyMs: 9, failure: { code: "refused", status: 429 }, fault: "wait" }
    const { root } = render({ model: "judge", request: decision, response: { askedAt: 1, request: decision, result: refused } })
    const result = root.querySelector('[data-testid="model-call-result"]')
    expect([result?.textContent, result?.getAttribute("data-ok"), result?.getAttribute("role")]).toEqual(["refused · 429", "false", "alert"])
    expect(root.querySelector('[data-testid="model-call-fixture"]')).toBeNull()
    expect(modelCallPill(card({ model: "judge", request: decision, response: { askedAt: 1, request: decision, result: refused } }))).toBe("failed")
    expect(modelCallPill(card({ model: "judge", request: decision, pending: out(decision) }))).toBe("running")
    expect(modelCallPill(card({ model: "judge", request: decision }))).toBe("done")
  })

  test("the fixture is asked for through its flow and drawn as code with a Copy that is the clipboard flow", () => {
    const { root, calls } = render({ model: "judge", request: decision, response: { askedAt: 1, request: decision, result: answered }, fixture: "Evaluator.layerScripted(() => ({ ok: { probability: 0.97 } }))" })
    const fixture = root.querySelector<HTMLButtonElement>('[data-testid="model-call-fixture"]')!
    expect([fixture.getAttribute("data-flow"), fixture.getAttribute("data-flow-args")]).toEqual(["model.fixture", "judge"])
    expect(root.querySelector('[data-testid="model-call-fixture-text"]')?.textContent).toContain("layerScripted")
    root.querySelector<HTMLButtonElement>('button[aria-label="Copy fixture"]')!.click()
    expect(calls).toEqual([["chat.copy-message", "Evaluator.layerScripted(() => ({ ok: { probability: 0.97 } }))"]])
  })

  test("Last test is offered only when a Test was recorded: on an untested model it could do nothing", () => {
    const untested = render({ model: "judge", request: decision, response: { askedAt: 1, request: decision, result: answered } })
    expect(untested.root.querySelector('[data-testid="model-call-recall"]')).toBeNull()
    const tested = render({ model: "judge", request: decision }, true)
    const recall = tested.root.querySelector<HTMLButtonElement>('[data-testid="model-call-recall"]')!
    expect([recall.textContent, recall.getAttribute("data-flow"), recall.getAttribute("data-flow-args")]).toEqual(["Last test", "model.recall", "judge"])
  })
})

describe("the composer, a generation request", () => {
  test("the prompt is two texts and two knobs, each committing through model.prompt, and the answer is the words", () => {
    const { root, calls, args } = render({ model: "writer", request: generation, response: { askedAt: 1, request: generation, result: { ok: true, latencyMs: 9, sample: "pong", output: { kind: "generation", text: "loopback pong" } } } })
    expect(root.getAttribute("data-kind")).toBe("generation")
    expect(input(root, '[data-testid="model-call-system"]').value).toBe("Answer tersely.")
    expect(input(root, '[data-testid="model-call-prompt"]').value).toBe("ping?")
    expect(input(root, '[data-testid="model-call-max-tokens"]').value).toBe("64")
    expect(input(root, '[data-testid="model-call-temperature"]').value).toBe("0.2")
    expect(root.querySelector('[data-testid="model-call-text"]')?.textContent).toBe("loopback pong")
    type(input(root, '[data-testid="model-call-prompt"]'), "pong?")
    type(input(root, '[data-testid="model-call-max-tokens"]'), "8")
    type(input(root, '[data-testid="model-call-temperature"]'), "")
    expect(calls.map(([name]) => name)).toEqual(["model.prompt", "model.prompt", "model.prompt"])
    expect(calls.map(args)).toEqual([{ id: "writer", prompt: "pong?" }, { id: "writer", maxTokens: 8 }, { id: "writer", temperature: "" }])
    expect(root.querySelector('[data-testid="model-call-question-add"]')).toBeNull()
    expect(root.querySelector('[data-testid="model-call-fixture"]')).toBeNull()
    expect(input(root, '[data-testid="model-call-system"]').getAttribute("maxlength")).toBe(String(MODEL_CALL_TEXT_MAX))
    expect(input(root, '[data-testid="model-call-prompt"]').getAttribute("maxlength")).toBe(String(MODEL_CALL_TEXT_MAX))
  })

  test("a Max tokens the draft cannot hold commits as 0, like any text that is no whole number, so the box never shows a number the ask would not send", () => {
    const { root, calls, args, rerender } = render({ model: "writer", request: generation })
    const box = () => input(root, '[data-testid="model-call-max-tokens"]')
    const unheld = ["99999999999999999999", "9007199254740993", "64.0000000000000001", "1e3", "1.5", "-5", ""]
    for (const typed of unheld) type(box(), typed)
    expect(calls.map(args)).toEqual(unheld.map(() => ({ id: "writer", maxTokens: 0 })))
    type(box(), "128")
    expect(args(calls.at(-1)!)).toEqual({ id: "writer", maxTokens: 128 })
    rerender({ model: "writer", request: { ...generation, maxTokens: 0 } })
    const problem = root.querySelector('[data-testid="model-call-problem"]')
    expect([problem?.textContent, problem?.getAttribute("data-problem")]).toEqual(["max_tokens · 1–4096", "max_tokens"])
    expect((root.querySelector('[data-testid="model-call-ask"]') as HTMLButtonElement).disabled).toBe(true)
  })

  test("the temperature on screen is the temperature that would be asked: what is typed is committed as typed, and one that is no number from 0 to 2 waits beside its reason", () => {
    const { root, calls, args, rerender } = render({ model: "writer", request: generation })
    const temperature = () => input(root, '[data-testid="model-call-temperature"]')
    // Free text: a number box hands back nothing for text it cannot read, and the draft would then say something the screen does not.
    expect([temperature().getAttribute("type"), temperature().getAttribute("inputmode"), temperature().getAttribute("maxlength")]).toEqual(["text", "decimal", String(MODEL_CALL_TEMPERATURE_TEXT_MAX)])
    for (const typed of ["3", "-", "warm"]) type(temperature(), typed)
    expect(calls.map(args)).toEqual([{ id: "writer", temperature: "3" }, { id: "writer", temperature: "-" }, { id: "writer", temperature: "warm" }])
    rerender({ model: "writer", request: { ...generation, temperature: "3" } })
    expect(temperature().value).toBe("3")
    expect(temperature().getAttribute("aria-invalid")).toBe("true")
    const problem = root.querySelector('[data-testid="model-call-problem"]')
    expect([problem?.textContent, problem?.getAttribute("data-problem"), problem?.getAttribute("role")]).toEqual(["temperature · 0–2", "temperature", "alert"])
    expect(root.querySelector<HTMLButtonElement>('[data-testid="model-call-ask"]')?.disabled).toBe(true)
    rerender({ model: "writer", request: { ...generation, temperature: "1.5" } })
    expect(temperature().value).toBe("1.5")
    expect(temperature().getAttribute("aria-invalid")).toBeNull()
    expect(root.querySelector('[data-testid="model-call-problem"]')).toBeNull()
    expect(root.querySelector<HTMLButtonElement>('[data-testid="model-call-ask"]')?.disabled).toBe(false)
  })

  test("an answer reads as its value and its number", () => {
    expect([
      modelAnswerLine({ type: "boolean", value: false, probability: 0.2 }),
      modelAnswerLine({ type: "choice", value: "b", probabilities: { a: 0.1, b: 0.9 }, confidence: 0.9 }),
      modelAnswerLine({ type: "score", value: 1.4, label: "mid", probabilities: { low: 0.1, mid: 0.6, high: 0.3 }, confidence: 0.6 })
    ]).toEqual(["no · 0.20", "b · 0.90", "mid · 1.4"])
  })
})

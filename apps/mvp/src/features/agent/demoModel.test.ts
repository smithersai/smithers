import type { ModelRequest } from "@smthrs/model"
import { Effect, Stream } from "effect"
import { describe, expect, test } from "vitest"
import { AuthClient } from "../auth/api"
import { ChatClient } from "../chat/api"
import {
  DEMO_SESSION,
  demoModel,
  demoRenderer,
  demoReplyFor,
  demoServices,
  demoSummary,
  isDemoMode,
} from "./demoModel"

const requestFor = (...texts: ReadonlyArray<string>): ModelRequest.ModelRequest => ({
  modelId: "agent",
  system: [],
  tools: [],
  params: {},
  messages: texts.map((text, index) =>
    index % 2 === 0
      ? { role: "user" as const, content: [{ type: "text" as const, text }] }
      : { role: "assistant" as const, content: [{ type: "text" as const, text }], stopReason: "stop" as const },
  ),
})

const collectText = async (model: typeof demoModel, request: ModelRequest.ModelRequest) => {
  const events = await Effect.runPromise(Stream.runCollect(model.stream(request)))
  return [...events]
    .filter((event) => event.type === "text-delta")
    .map((event) => event.text)
    .join("")
}

describe("demoModel (?agent=mock)", () => {
  test("detects ?agent=mock query parameter cleanly", () => {
    expect(isDemoMode("?agent=mock")).toBe(true)
    expect(isDemoMode("?foo=1&agent=mock")).toBe(true)
    expect(isDemoMode("?agent=other")).toBe(false)
    expect(isDemoMode("")).toBe(false)
  })

  test("handles approval, question, todo, and general demo prompts", async () => {
    const askApproval = await collectText(demoModel, requestFor("deploy preview"))
    expect(askApproval).toContain("app/agent/ask")
    expect(askApproval).toContain('kind: "approval"')

    const approved = await collectText(demoModel, requestFor("deploy preview", '{"answered":true,"approved":true}', "deploy preview"))
    expect(approved).toContain("Approved")
    expect(demoReplyFor("deploy preview", { answered: true, approved: false })).toContain("Kept local")

    const askQuestion = await collectText(demoModel, requestFor("which workflow"))
    expect(askQuestion).toContain('kind: "question"')
    expect(demoReplyFor("which workflow", { answered: true, answer: "TODO Stack" })).toContain("TODO Stack")
    expect(demoReplyFor("which workflow", { answered: false })).toContain("No option selected")

    const todo = await collectText(demoModel, requestFor("explain todo stack"))
    expect(todo).toContain("T1 → T2 → T3")

    const general = await collectText(demoModel, requestFor("hello smithers"))
    expect(general).toContain("Smithers interactive demo")

    // Empty message list falls back safely
    const empty = await collectText(demoModel, requestFor())
    expect(empty).toContain("Smithers interactive demo")
    const nonText = await collectText(demoModel, {
      modelId: "agent",
      system: [],
      tools: [],
      params: {},
      messages: [{ role: "user", content: [{ type: "image", data: "AA==", mediaType: "image/png" } as never] }],
    })
    expect(nonText).toContain("Smithers interactive demo")
  })

  test("streams summaries, renderer fallback, and provides in-memory demoServices", async () => {
    expect(await collectText(demoSummary, requestFor("how do durable flows work here"))).toBe("Demo: how do durable flows")
    expect(await collectText(demoSummary, requestFor())).toBe("Smithers demo")
    expect(await collectText(demoRenderer, requestFor("render"))).toContain("export default function View")

    const [session, sent] = await Effect.runPromise(
      Effect.gen(function* () {
        const auth = yield* AuthClient
        const chat = yield* ChatClient
        yield* auth.signOut
        expect(yield* auth.setHostedModel(false)).toEqual({ enabled: false })
        const s = yield* auth.session
        const r = yield* chat.ask({ id: "q1", answerId: "a1", text: "hi" })
        return [s, r] as const
      }).pipe(Effect.provide(demoServices)),
    )
    expect(session).toEqual(DEMO_SESSION)
    expect(sent).toEqual({ _tag: "inserted" })
  })
})

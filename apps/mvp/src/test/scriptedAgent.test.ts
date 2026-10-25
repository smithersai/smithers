// The `queue` scripted agent (./scriptedAgent.ts), turn by turn: what it asks for the person's message, and how it
// finishes once its cell printed what it heard. The end-to-end tests run it in the browser's engine worker.
import { ModelRequest } from "@smthrs/model"
import { Cause, Effect, Exit, Stream } from "effect"
import { describe, expect, test } from "vitest"
import { scriptedModel } from "./scriptedAgent"

/** A request whose task is `task`, after this run's cell printed `heard`, if it has. */
const request = (task: string, heard?: unknown) =>
  new ModelRequest.ModelRequest({
    modelId: "scripted",
    system: [{ type: "text", text: "You are Smithers." }, { type: "text", text: task }],
    messages: heard === undefined ? [] : [
      new ModelRequest.UserMessage({ role: "user", content: [{ type: "text", text: `Output:\n${JSON.stringify(heard)}` }] }),
    ],
    tools: [],
    params: ModelRequest.GenerationParams.make(),
  })

/** The cell the script's turn streams. */
const turnOf = (task: string, heard?: unknown) =>
  Effect.runPromise(
    Stream.runCollect(scriptedModel("queue")!.stream(request(task, heard))).pipe(
      Effect.map((events) =>
        events.flatMap((event) => (event.type === "text-delta" ? [event.text] : [])).join("")
      ),
    ),
  )

describe("the queue script", () => {
  test("asks which branch, named for the message's last word; an approval when the message says approve", async () => {
    expect(await turnOf("Deploy alpha")).toContain(
      `ctx.call("app/agent/ask", {"kind":"question","prompt":"Deploy which branch for alpha?","options":["main","docs-v2","release"]})`,
    )
    // After the conversation before it, only the person's latest message counts.
    const later = "The conversation so far:\nPerson: approve gamma\nSmithers: Approved.\n\nThe person now asks: Ship beta."
    expect(await turnOf(later)).toContain(`"prompt":"Deploy which branch for beta?"`)
    expect(await turnOf("Please approve gamma")).toContain(
      `ctx.call("app/agent/ask", {"kind":"approval","prompt":"Approve the deploy for gamma?"})`,
    )
    expect(await turnOf("")).toContain(`"prompt":"Deploy which branch for none?"`)
  })

  test("finishes with what it heard", async () => {
    expect(await turnOf("Deploy alpha", { answered: true, answer: "release" })).toContain(`ctx.done("Deploying release.")`)
    expect(await turnOf("approve gamma", { answered: true, approved: true, note: "Only docs." })).toContain(
      `ctx.done("Approved: Only docs.")`,
    )
    expect(await turnOf("approve gamma", { answered: true, approved: true })).toContain(`ctx.done("Approved.")`)
    expect(await turnOf("approve gamma", { answered: true, approved: false, note: "Not yet." })).toContain(
      `ctx.done("Kept it.")`,
    )
    expect(await turnOf("Deploy alpha", { answered: false })).toContain(`ctx.done("No answer, so nothing deployed.")`)
  })
})

test("the quota script injects a terminal credit refusal", async () => {
  const exit = await Effect.runPromiseExit(Stream.runCollect(scriptedModel("quota-refused")!.stream(request("hi"))))
  expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toMatchObject({ code: "out_of_credit", httpStatus: 402 })
})

import { Model, ModelError, type ModelEvent, type ModelRequest } from "@smthrs/model"
import { Effect, Stream } from "effect"

// Model is the only scripted seam: the same claim, sealed ModelStep, engine and recorded summary still run. It answers
// the way the real summary model does: a few words for a message, and JSON spans for a segmentation, here starting a
// span wherever a line's `Topic: …` changes. A message saying `summaries-fail:<code>` makes its summary refuse; the phases around it go on, or that fault would outlive its test in the shared conversation.

const say = (text: string) => Stream.fromIterable<ModelEvent.ModelEvent>([
  { type: "text-delta", id: "summary", text },
  { type: "usage", inputTokens: 12, outputTokens: 5 },
  { type: "settle", stopReason: "stop" },
])

const textOf = (request: ModelRequest.ModelRequest) => request.messages.flatMap(message => message.content.flatMap(part => part.type === "text" ? [part.text] : [])).join("\n")

const words = (text: string) => text.replace(/Topic: [^.]*\.\s*/, "").split(/\s+/).filter(Boolean).slice(0, 6).join(" ").replace(/[^\w #.-]/g, "")

const spans = (input: string) => {
  const made: Array<{ from: number; title: string; summary: string }> = []
  let topic: string | undefined
  // An item is its number's line and what follows it, up to the next number.
  for (const item of input.split(/\n(?=\d+\. )/)) {
    const number = Number(/^(\d+)\. /.exec(item)?.[1] ?? 0)
    const found = /Topic: ([^.:]*)/.exec(item)?.[1] ?? `part ${Math.ceil(number / 5)}`
    if (found === topic) continue
    topic = found
    made.push({ from: number, title: `Working on ${found}`, summary: `The ${found} work finished after a few runs.` })
  }
  return JSON.stringify({ spans: made })
}

export const scriptedSummary = Model.make({
  stream: (request) => {
    const input = textOf(request)
    const system = request.system.map(part => part.text).join("")
    if (system.startsWith("You divide")) return say(spans(input))
    const refused = /summaries-fail:(no_route|out_of_credit|quota_exceeded|provider_internal)/.exec(input)?.[1]
    if (refused !== undefined) return Stream.fromEffect(Effect.fail(new ModelError.ModelError({ code: refused as ModelError.ModelError["code"], message: "scripted refusal" })))
    if (input.includes("Topic: ")) {
      const message = JSON.parse(input) as { readonly question?: string; readonly answer?: string }
      return say(words(message.answer ?? message.question ?? ""))
    }
    return say("Release regression check completed")
  },
})

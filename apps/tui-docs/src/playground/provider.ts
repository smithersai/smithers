import * as Seat from "@smthrs/agent/Seat"
import * as Model from "@smthrs/model/Model"
import { ModelError } from "@smthrs/model/ModelError"
import type * as ModelEvent from "@smthrs/model/ModelEvent"
import * as Chat from "@smthrs/model/OpenAIChatCompletions"
import { Effect, Stream } from "effect"
import { canonical, type Journal } from "./store.ts"
export type Settings = { baseUrl: string; model: string; apiKey: string }
export function endpoint(base: string): string {
  const url = new URL(base)
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
  ) throw new Error("Use HTTPS, or a localhost provider.")
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Use a base URL without credentials, query, or fragment.")
  }
  return `${url.href.replace(/\/$/, "")}/chat/completions`
}
export function resolveSeat(settings: Settings, journal: Journal, changed: () => void) {
  let ordinal = 0
  const modelId = settings.model || "sponsored"
  const model = Model.make({
    stream: (request) =>
      Stream.unwrap(Effect.gen(function*() {
        const body = yield* Chat.protocol.body.from(request, { native: false })
        const fingerprint = canonical(body)
        const index = ordinal++
        const saved = journal.head.run!.replies[index]
        let text: string
        if (saved) {
          if (saved.request !== fingerprint) {
            return yield* Effect.fail(
              new ModelError({
                code: "invalid_request",
                message: "Saved request changed. Branch from a checkpoint to continue."
              })
            )
          }
          text = saved.text
        } else {
          text = yield* Effect.tryPromise({
            try: async (signal) => {
              const personal = settings.baseUrl.trim() !== ""
              const response = await fetch(personal ? endpoint(settings.baseUrl) : "/api/playground/model", {
                method: "POST",
                signal,
                redirect: "error",
                headers: {
                  "Content-Type": "application/json",
                  ...(personal && settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {})
                },
                body: JSON.stringify({ ...body, stream: false, stream_options: undefined, max_tokens: 2048 })
              })
              if (!response.ok) {
                if (!personal && response.status === 503) {
                  throw new Error("Sponsored access is unavailable. Add a provider in Settings.")
                }
                throw new Error(`Provider returned ${response.status}. Check Settings or retry.`)
              }
              const result = await response.json()
              const choice = result.choices?.[0]
              if (choice?.finish_reason !== "stop" || typeof choice.message?.content !== "string") {
                throw new Error("Provider response was incomplete. Retry or choose another model.")
              }
              if (choice.message.content.length > 100_000) {
                throw new Error("Provider response exceeded the sandbox limit.")
              }
              return choice.message.content as string
            },
            catch: (error) =>
              new ModelError({ code: "unknown", message: error instanceof Error ? error.message : "Provider failed" })
          })
          yield* Effect.sync(() => {
            journal.update((frame) => {
              frame.run!.replies.push({ request: fingerprint, text })
            })
            changed()
          })
        }
        return Stream.fromIterable(
          [
            { type: "text-start", id: "answer" },
            { type: "text-delta", id: "answer", text },
            { type: "text-end", id: "answer" },
            { type: "settle", stopReason: "stop" }
          ] satisfies ModelEvent.ModelEvent[]
        )
      }))
  })
  return Seat.make({
    id: modelId,
    modelId,
    contextWindowTokens: 32_768,
    model,
    route: {
      prepare: (request) =>
        Effect.map(Chat.protocol.body.from(request, { native: false }), (body) => ({
          routeId: modelId,
          protocolId: "openai-chat-completions",
          method: "POST",
          url: settings.baseUrl ? endpoint(settings.baseUrl) : "https://sponsored.invalid/chat/completions",
          publicHeaders: {},
          body: new TextEncoder().encode(canonical(body)),
          bodyText: canonical(body)
        }))
    }
  })
}

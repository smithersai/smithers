import { Model, type ModelEvent } from "@smthrs/model"
import { Stream } from "effect"

// Model is the only scripted seam: the same claim, sealed ModelStep, engine and recorded summary still run.
export const scriptedSummary = Model.make({
  stream: () =>
    Stream.fromIterable<ModelEvent.ModelEvent>([
      { type: "text-delta", id: "summary", text: "Release regression check completed" },
      { type: "usage", inputTokens: 12, outputTokens: 5 },
      { type: "settle", stopReason: "stop" },
    ]),
})

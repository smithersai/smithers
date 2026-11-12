// TypeScript is structural: the model's anonymous `client` is a `Client`, its `pending` is a list of `Pending`, and
// a `Pending` passes where a `Ref` (a subset of its fields) is expected. An imported constant declared without a
// value is a fixed value of its type.
import { type Model, empty } from "./model";
import { flipped, counted } from "./client";

//@ verify
//@ ensures \result.client.gap == !model.client.gap && \result.label == model.label
export function next(model: Model): Model {
  return { ...model, client: flipped(model.client) }
}

//@ verify
//@ ensures \result == model.client.pending.length
export function waiting(model: Model): number {
  return counted(model.client.pending)
}

//@ verify
//@ ensures model.client.last.type === "Cleared" ==> \result == model.client
export function chosen(model: Model): Model["client"] {
  const last = model.client.last
  switch (last.type) {
    case "Posted": {
      const picked = empty
      return picked
    }
    case "Cleared": return model.client
  }
}

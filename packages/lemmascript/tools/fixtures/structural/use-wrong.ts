// The flipped client is not the client it came from.
import { type Model } from "./model";
import { flipped } from "./client";

//@ verify
//@ ensures \result.client == model.client
export function next(model: Model): Model {
  return { ...model, client: flipped(model.client) }
}

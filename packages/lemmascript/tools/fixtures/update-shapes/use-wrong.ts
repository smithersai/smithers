// A defaulted binding takes the model's value only when the payload has none.
import { Message } from "./messages";

export interface Model { readonly following: boolean; readonly intent: number }

//@ verify
//@ ensures message._tag == "Scrolled" ==> \result.intent == model.intent
export function arms(model: Model, message: Message): Model {
  return Message.match(message, {
    Measured: () => model,
    Scrolled: ({ bottom, intent = model.intent }) => ({ ...model, following: bottom, intent }),
    Loaded: () => model,
  })
}

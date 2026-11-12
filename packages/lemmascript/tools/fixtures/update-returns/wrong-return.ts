// A result's model is not another model.
import type * as Hostlib from "hostlib";
import { Message } from "./messages";
export interface Model { readonly page: string; readonly count: number }

//@ verify
//@ ensures \result.model.count == model.count + 1
export function same(model: Model): Hostlib.Return<Model, Message> {
  return { model, commands: [] }
}

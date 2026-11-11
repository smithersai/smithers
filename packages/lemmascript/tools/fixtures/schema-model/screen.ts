// A proved projection over the schema's value type, which `cross.ts` calls from another module.
import type { Model } from "./model"

export interface Screen { readonly docs: "pane" | "max"; readonly seq: number }

//@ verify
//@ ensures \result.docs == model.docs && \result.seq == model.current.seq
export function screen(model: Model): Screen {
  return { docs: model.docs, seq: model.current.seq }
}

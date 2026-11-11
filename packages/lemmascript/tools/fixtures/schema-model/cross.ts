// A proved function of another module called with a schema value type: the callee's signature names the type's
// datatype, not the type's expanded text, which Dafny cannot parse.
import type { Model } from "./model"
import { screen } from "./screen"

//@ verify
//@ ensures \result == model.current.seq
export function seqOf(model: Model): number {
  return screen(model).seq
}

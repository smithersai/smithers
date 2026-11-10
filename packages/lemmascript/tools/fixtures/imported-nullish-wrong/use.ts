// The importer cannot prove more than the imported ?? contract says.
import { type Box, runsOf } from "./base"

//@ verify
//@ ensures \result == (box.runs ?? [1]).length
export function count(box: Box): number {
  return runsOf(box).length
}

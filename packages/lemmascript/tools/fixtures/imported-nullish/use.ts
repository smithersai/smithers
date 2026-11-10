// An imported function whose contract reads an optional with ?? is an axiom the importer can use.
import { type Box, runsOf } from "./base"

//@ verify
//@ ensures \result == (box.runs ?? []).length
export function count(box: Box): number {
  return runsOf(box).length
}

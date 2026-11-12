// A generated table is fixed but unknown: its length is not assumed.
import { pages } from "./table";

//@ verify
//@ ensures \result == 2
export function pageCount(): number {
  return pages.length
}

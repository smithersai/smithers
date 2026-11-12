// Types and values: a command `Act` beside a type `Act`; a proved function over an anonymous message union; a
// copied constant built as its own record although another record shares a field name.
import type * as Hostlib from "hostlib";
import { Act } from "./commands";
import * as View from "./view";
import type { Msg } from "./msg";
import { STEPS } from "./steps";

export interface Screen { readonly target: string; readonly open: boolean }

//@ verify
//@ ensures \result == (View.stops(kind) ? [Act({ n: 1 })] : [])
export function stop(kind: View.Act): ReadonlyArray<Hostlib.Command<string>> {
  return View.stops(kind) ? [Act({ n: 1 })] : []
}

//@ verify
//@ ensures \result == View.isA(message)
export function first(message: Msg): boolean {
  return View.isA(message)
}

//@ verify
//@ ensures \result.target == STEPS[0].target
export function opening(): Screen {
  return { target: STEPS[0]!.target, open: true }
}

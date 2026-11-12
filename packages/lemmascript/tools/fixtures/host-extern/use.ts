// A command built by a declared value is an opaque extern of a record of its arguments (`{}` is the empty record),
// every type the host library declares (`Hostlib.Command<…>`, its `Effect`) is the one opaque `Host`, and a type
// reached through a namespace import (`Decide.Screen`) is the declaration it names.
import type * as Hostlib from "hostlib";
import { Ping, Focus, Load } from "./commands";
import * as Decide from "./decide";

export interface Step { readonly count: number; readonly commands: ReadonlyArray<Hostlib.Command<string>> }

//@ verify
//@ ensures \result.count == n
//@ ensures \result.commands == [Ping({ count: n, label: "ping" }), Focus({})]
export function step(n: number): Step {
  return { count: n, commands: [Ping({ count: n, label: "ping" }), Focus({})] };
}

//@ verify
//@ ensures \result.open && \result.count == screen.count + 1
export function openedAndCounted(screen: Decide.Screen): Decide.Screen {
  return { ...Decide.opened(screen), count: screen.count + 1 };
}

export interface Plan { readonly count: number; readonly commands?: ReadonlyArray<Hostlib.Command<string>> }

//@ verify
//@ ensures focus ==> \result.commands == [Load({}), Focus({})]
//@ ensures !focus ==> \result.commands == [Load({})]
export function plan(n: number, focus: boolean): Plan {
  return { count: n, commands: [Load({}), ...(focus ? [Focus({})] : [])] };
}

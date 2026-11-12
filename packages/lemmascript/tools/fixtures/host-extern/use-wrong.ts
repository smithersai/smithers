// Two commands built from different arguments are not known to be equal.
import type * as Hostlib from "hostlib";
import { Ping } from "./commands";

export interface Step { readonly count: number; readonly commands: ReadonlyArray<Hostlib.Command<string>> }

//@ verify
//@ ensures \result.commands == [Ping({ count: n + 1, label: "ping" })]
export function step(n: number): Step {
  return { count: n, commands: [Ping({ count: n, label: "ping" })] };
}

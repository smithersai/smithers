// A proved decision over a string union whose name a command also takes (`Act`), and one over an anonymous message
// union (`typeof Msg.Type`, as VibeLang declares a Foldkit union).
import type { Msg } from "./msg";
export type Act = "start" | "stop"

//@ verify
//@ ensures \result == (kind == "stop")
export function stops(kind: Act): boolean {
  return kind === "stop"
}

//@ verify
//@ ensures \result == (message._tag == "A")
export function isA(message: Msg): boolean {
  return message._tag === "A"
}

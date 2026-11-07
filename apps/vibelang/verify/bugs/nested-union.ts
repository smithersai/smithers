export {}
type Event = { readonly type: "A"; readonly seq: number } | { readonly type: "B"; readonly seq: number }
type Reason = "empty" | "busy"
type Decision = { readonly ok: true; readonly event: Event } | { readonly ok: false; readonly reason: Reason }
//@ verify
//@ ensures \result.ok ==> \result.event.seq == seq
function decide(seq: number): Decision {
  if (seq < 0) return { ok: false, reason: "empty" }
  return { ok: true, event: { type: "A", seq } }
}

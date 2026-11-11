// Dafny 4.11 does not prove this identity: the ensures clause is the requires clause with res := a.
// The goal's term res[i] sits only under the negated exists' binder, so nothing instantiates the hypothesis.
// A forall statement that picks k with :| is not enough either: Z3 skolemizes the negated goal to i0, and a[i0] occurs
// only under k's binder. LemmaScript's `//@ assert ... by exists(k, C)` names the body as a predicate, so the negated
// goal is a ground atom (packages/lemmascript/tools/fixtures/forall-exists-witness.ts).
// Run: dafny verify verify/bugs/forall-exists-witness.dfy (expected today: 1 postcondition error).
method Copy(parts: seq<int>, a: seq<int>) returns (res: seq<int>)
  requires forall i :: 0 <= i < |a| ==> exists k :: 0 <= k < |parts| && a[i] == parts[k]
  ensures forall i :: 0 <= i < |res| ==> exists k :: 0 <= k < |parts| && res[i] == parts[k]
{
  res := a;
}

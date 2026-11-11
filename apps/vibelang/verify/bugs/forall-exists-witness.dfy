// Dafny 4.11 does not prove this identity: the ensures clause is the requires clause with res := a.
// The goal's term res[i] sits only under the negated exists' binder, so nothing instantiates the hypothesis.
// Dafny closes it with a forall statement that picks k with :| ; LemmaScript has no such witness statement, so
// markdownDecision.inlinePieces cannot state each piece's parity as coming from its part.
// Run: dafny verify verify/bugs/forall-exists-witness.dfy (expected today: 1 postcondition error).
method Copy(parts: seq<int>, a: seq<int>) returns (res: seq<int>)
  requires forall i :: 0 <= i < |a| ==> exists k :: 0 <= k < |parts| && a[i] == parts[k]
  ensures forall i :: 0 <= i < |res| ==> exists k :: 0 <= k < |parts| && res[i] == parts[k]
{
  res := a;
}

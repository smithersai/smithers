import PatternsSpec.Basic

/-!
# Escalation: a ladder that stops at the first rung that is good enough

The model of `Escalation.run`. A rung's own `escalateIf` decides first, then the shared `accept`, then the default
reader of the rung's result. A fallback runs only after every rung escalated.
-/

namespace PatternsSpec.Escalation

open PatternsSpec

structure Rung where
  /-- What the rung returns. -/
  result : Value
  /-- What the rung's `escalateIf` returns, when the rung names one. Anything but `false` escalates. -/
  escalateIf : Option Value
  /-- What the shared `accept` returns for this rung's result. -/
  decision : Value

/-- Whether a rung escalates. `accept`: the ladder has a shared `accept`. -/
def escalates (accept : Bool) (rung : Rung) : Bool :=
  match rung.escalateIf with
  | some answer => !answer.isFalse
  | none => if accept then !accepted rung.decision else defaultEscalate rung.result

/-- The level of the first rung that does not escalate, counting from `level`. -/
def climb (accept : Bool) : Nat → List Rung → Option Nat
  | _, [] => none
  | level, rung :: rest => if escalates accept rung then climb accept (level + 1) rest else some level

inductive Outcome where
  /-- The ladder has no rung. -/
  | refused
  /-- A rung settled at `level`, or the fallback did at the ladder's length. Never exhausted. -/
  | reached (level : Nat) (fallback : Bool)
  /-- Every rung escalated and there is no fallback: the last rung's result, at the last level. -/
  | exhausted (level : Nat)
  deriving Repr, DecidableEq

structure Run where
  /-- How many rungs ran. -/
  ran : Nat
  /-- The levels at which the rung's own `escalateIf` was asked. -/
  predicated : List Nat
  /-- The levels at which the shared `accept` was asked. -/
  asked : List Nat
  outcome : Outcome
  deriving Repr, DecidableEq

/-- The levels below `ran` whose rung satisfies `keep`. -/
def levels (keep : Rung → Bool) (rungs : List Rung) (ran : Nat) : List Nat :=
  (List.range ran).filter (fun level => match rungs[level]? with
    | some rung => keep rung
    | none => false)

/-- `Escalation.run`. -/
def run (accept fallback : Bool) (rungs : List Rung) : Run :=
  if rungs = [] then { ran := 0, predicated := [], asked := [], outcome := .refused }
  else
    let settled := climb accept 0 rungs
    let ran := match settled with
      | some level => level + 1
      | none => rungs.length
    { ran
      predicated := levels (fun rung => rung.escalateIf.isSome) rungs ran
      asked := levels (fun rung => rung.escalateIf.isNone && accept) rungs ran
      outcome := match settled with
        | some level => .reached level false
        | none => if fallback then .reached rungs.length true else .exhausted (rungs.length - 1) }

end PatternsSpec.Escalation

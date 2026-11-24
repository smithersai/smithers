import PatternsSpec.Basic

/-!
# Quarantine: continue-on-failure fan-out

The model of `Quarantine.run` and `Quarantine.settle`. Under `quarantine` every member runs and a failure becomes an
entry of the result; under `halt` the first failure fails the join. `settle` turns a joined result back into values,
failing when a member was quarantined.
-/

namespace PatternsSpec.Quarantine

open PatternsSpec

inductive Policy where
  | quarantine
  | halt
  deriving Repr, DecidableEq

structure Member where
  name : Text
  fails : Bool
  deriving Repr, DecidableEq

/-- A member's envelope in a quarantined join. -/
inductive Settled where
  | succeeded (name : Text)
  | quarantined (name : Text)
  deriving Repr, DecidableEq

def envelope (member : Member) : Settled :=
  if member.fails then .quarantined member.name else .succeeded member.name

inductive Refusal where
  | empty
  | width
  deriving Repr, DecidableEq

inductive Outcome where
  | refused (reason : Refusal)
  /-- The quarantined join: one envelope per member, in declaration order. -/
  | settled (entries : List Settled)
  /-- The halting join: every member's raw value, in declaration order. -/
  | joined (names : List Text)
  /-- The failure of the named member. -/
  | failed (name : Text)
  deriving Repr, DecidableEq

structure Run where
  started : List Text
  outcome : Outcome
  deriving Repr

/--
`Quarantine.run` over members that each take the same time. `concurrency` is `none` for `"unbounded"`. A halting join
slides a window like `Bounded.run`.
-/
def run (policy : Policy) (concurrency : Option Num) (members : List Member) : Run :=
  if members = [] then { started := [], outcome := .refused .empty }
  else
    let names := members.map (·.name)
    let proceed (width : Option Nat) : Run :=
      match policy with
      | .quarantine => { started := names, outcome := .settled (members.map envelope) }
      | .halt =>
        match members.findIdx? (·.fails) with
        | none => { started := names, outcome := .joined names }
        | some position =>
          { started := match width with
              | some width => names.take (position + width)
              | none => names
            outcome := .failed (names.getD position []) }
    match concurrency with
    | none => proceed none
    | some num =>
      match num.atLeast 1 with
      | none => { started := [], outcome := .refused .width }
      | some width => proceed (some width)

/-- What `settle` finds under a member's name. -/
inductive Entry where
  | succeeded
  | quarantined
  /-- Neither envelope, such as a raw value. -/
  | invalid
  deriving Repr, DecidableEq

inductive Settlement where
  /-- `invalid_input`, naming the offending members, ascending. -/
  | invalid (names : List Text)
  /-- `quarantined`, naming the failed members, ascending. -/
  | quarantined (names : List Text)
  /-- Every member's value, in the record's order. -/
  | values (names : List Text)
  deriving Repr, DecidableEq

def named (kind : Entry) (entries : List (Text × Entry)) : List Text :=
  (entries.filter (fun entry => entry.2 = kind)).map (·.1)

/-- `Quarantine.settle`. -/
def settle (entries : List (Text × Entry)) : Settlement :=
  if named .invalid entries ≠ [] then .invalid (sortTexts (named .invalid entries))
  else if named .quarantined entries ≠ [] then .quarantined (sortTexts (named .quarantined entries))
  else .values (entries.map (·.1))

end PatternsSpec.Quarantine

import PatternsSpec.Basic

/-!
# ReviewLoop: bounded produce-review-revise rounds, with a stall breaker

The model of `ReviewLoop.run` and of the stall fold it shares with every round loop (`Stall.observe`). A round is
reviewed; an accepted review settles the loop, the last round exhausts it, and otherwise the stall breaker folds the
round's observation in before the next revision.
-/

namespace PatternsSpec.ReviewLoop

open PatternsSpec

/-- What a stalled loop does. -/
inductive On where
  | stop
  | park
  | escalate
  deriving Repr, DecidableEq

/-- The compared signals, in the order a stall is attributed. -/
inductive Signal where
  | tree
  | checks
  | output
  deriving Repr, DecidableEq

/-- What one round reports. Each signal is a key, or is absent and then not compared. -/
structure Observation where
  tree : Option Nat
  /-- The failing checks. They are compared as a set, and no failing check is not a repeated failure. -/
  checks : List Nat
  output : Option Nat
  deriving Repr, DecidableEq

/-- Puts a check into an ascending list without repeats. -/
def insertCheck (check : Nat) : List Nat → List Nat
  | [] => [check]
  | head :: rest =>
    if head < check then head :: insertCheck check rest
    else if head = check then head :: rest
    else check :: head :: rest

/-- The key of the failing checks: the set, in its one canonical order; absent when no check fails. -/
def checksKey (checks : List Nat) : Option (List Nat) :=
  if checks = [] then none else some (checks.foldr insertCheck [])

/-- A streak: the key last seen and for how many rounds in a row. -/
abbrev Streak (κ : Type) := Option (κ × Nat)

/-- Folds a round's key into a streak: the same key extends it, a new key restarts it, an absent key clears it. -/
def advance {κ : Type} [BEq κ] (prior : Streak κ) : Option κ → Streak κ
  | none => none
  | some key =>
    match prior with
    | some (held, rounds) => if held == key then some (key, rounds + 1) else some (key, 1)
    | none => some (key, 1)

def length {κ : Type} : Streak κ → Nat
  | some (_, rounds) => rounds
  | none => 0

structure State where
  tree : Streak Nat
  checks : Streak (List Nat)
  output : Streak Nat
  deriving Repr

def initial : State := { tree := none, checks := none, output := none }

/-- A validated stall option: `rounds` is at least 2. -/
structure Policy where
  rounds : Nat
  on : On
  deriving Repr, DecidableEq

structure Stalled where
  signal : Signal
  rounds : Nat
  on : On
  deriving Repr, DecidableEq

/-- `Stall.observe`: the new streaks, and the first signal, in order, that repeated `policy.rounds` times. -/
def observe (policy : Policy) (state : State) (observation : Observation) : State × Option Stalled :=
  let next : State := {
    tree := advance state.tree observation.tree
    checks := advance state.checks (checksKey observation.checks)
    output := advance state.output observation.output }
  let stalled :=
    if policy.rounds ≤ length next.tree then some { signal := .tree, rounds := length next.tree, on := policy.on }
    else if policy.rounds ≤ length next.checks then
      some { signal := .checks, rounds := length next.checks, on := policy.on }
    else if policy.rounds ≤ length next.output then
      some { signal := .output, rounds := length next.output, on := policy.on }
    else none
  (next, stalled)

/-- One round as the script gives it: the review of that round's output, and what the output reports. -/
structure Round where
  review : Value
  observation : Observation

/-- Past the script every review refuses and nothing is observed. -/
def Round.silent : Round := { review := .undefined, observation := { tree := none, checks := [], output := none } }

def roundAt (rounds : List Round) (index : Nat) : Round := rounds.getD index Round.silent

inductive Refusal where
  /-- `maxRounds` is not a positive safe integer. -/
  | maxRounds
  /-- The stall option's `rounds` is not a safe integer of at least 2. -/
  | stall
  deriving Repr, DecidableEq

inductive Verdict where
  | refused (reason : Refusal)
  | approved
  | exhausted
  /-- The loop settled as stalled, under `stop` or `park`. -/
  | stalled (stalled : Stalled)
  /-- The loop failed `stalled`, under `escalate`, after this many equal rounds. -/
  | escalated (rounds : Nat)
  deriving Repr, DecidableEq

/-- How a loop ended: the number of reviews it made, and the verdict. The output it holds is that of the last round. -/
structure Run where
  round : Nat
  verdict : Verdict
  deriving Repr, DecidableEq

/-- The rounds from `index` on, with `fuel` revisions left. -/
def loop (policy : Option Policy) (rounds : List Round) : Nat → Nat → State → Run
  | 0, index, _ =>
    if accepted (roundAt rounds index).review then { round := index + 1, verdict := .approved }
    else { round := index + 1, verdict := .exhausted }
  | fuel + 1, index, state =>
    if accepted (roundAt rounds index).review then { round := index + 1, verdict := .approved }
    else
      match policy with
      | none => loop policy rounds fuel (index + 1) state
      | some policy' =>
        match observe policy' state (roundAt rounds index).observation with
        | (_, some stalled) =>
          { round := index + 1
            verdict := if stalled.on = .escalate then .escalated stalled.rounds else .stalled stalled }
        | (next, none) => loop policy rounds fuel (index + 1) next

structure Request where
  maxRounds : Num
  /-- The stall option: its `rounds`, and its `on` when stated (`stop` otherwise). -/
  stall : Option (Num × Option On)
  rounds : List Round

/-- `ReviewLoop.run`. -/
def run (request : Request) : Run :=
  match request.maxRounds.atLeast 1 with
  | none => { round := 0, verdict := .refused .maxRounds }
  | some maxRounds =>
    match request.stall with
    | none => loop none request.rounds (maxRounds - 1) 0 initial
    | some (rounds, on) =>
      match rounds.atLeast 2 with
      | none => { round := 0, verdict := .refused .stall }
      | some rounds => loop (some { rounds, on := on.getD .stop }) request.rounds (maxRounds - 1) 0 initial

end PatternsSpec.ReviewLoop

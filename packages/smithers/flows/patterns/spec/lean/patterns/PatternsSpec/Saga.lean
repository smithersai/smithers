import PatternsSpec.Basic

/-!
# Saga: forward steps, and compensations that unwind in reverse

The model of `Saga.run`. A step's action succeeds, fails, dies, or is where an interruption lands. A step that
finished registers its compensation; anything but a clean finish runs the registered compensations last first, each
exactly once, and a compensation that does not undo its step leaves that step in the residue.
-/

namespace PatternsSpec.Saga

open PatternsSpec

/-- What a saga does about a forward failure. `fail` registers no compensation. -/
inductive Policy where
  | compensate
  | compensateAndFail
  | fail
  deriving Repr, DecidableEq

/-- What a step's action does. `interrupt`: the run is interrupted while this action is in flight. -/
inductive Action where
  | ok
  | fail
  | die
  | interrupt
  deriving Repr, DecidableEq

/-- What a step's compensation does. Only `ok` undoes the step; a typed failure, a defect and a throw do not. -/
inductive Undo where
  | ok
  | fail
  | die
  | throw
  deriving Repr, DecidableEq

structure Step where
  id : Text
  action : Action
  undo : Undo
  /-- `uninterruptible`: the action and the registration of its compensation are one unit. -/
  sealed : Bool
  deriving Repr, DecidableEq

/-- Why the forward chain ended. -/
inductive Stop where
  | finished
  | failed (id : Text)
  | died (id : Text)
  | interrupted
  deriving Repr, DecidableEq

/-- The forward chain: the steps whose action started, the steps that committed, and why the chain ended. -/
structure Forward where
  started : List Text
  committed : List Step
  stop : Stop
  deriving Repr

/--
Runs the actions in order. An interruption inside a sealed step still commits it; inside any other step it does not.
-/
def forward : List Step → Forward
  | [] => { started := [], committed := [], stop := .finished }
  | step :: rest =>
    match step.action with
    | .ok =>
      let tail := forward rest
      { started := step.id :: tail.started, committed := step :: tail.committed, stop := tail.stop }
    | .fail => { started := [step.id], committed := [], stop := .failed step.id }
    | .die => { started := [step.id], committed := [], stop := .died step.id }
    | .interrupt =>
      { started := [step.id], committed := if step.sealed then [step] else [], stop := .interrupted }

/-- The steps compensated, in the order their compensations run: the committed steps, last first. -/
def unwinding (policy : Policy) (chain : Forward) : List Step :=
  if chain.stop = .finished ∨ policy = .fail then [] else chain.committed.reverse

/-- The compensated steps left dirty, by id, ascending. -/
def residue (unwound : List Step) : List Text :=
  sortTexts ((unwound.filter (fun step => step.undo != .ok)).map (·.id))

inductive Refusal where
  | empty
  | duplicate
  deriving Repr, DecidableEq

inductive Outcome where
  | refused (reason : Refusal)
  /-- Every step finished; the ids whose values the envelope holds, in order. -/
  | completed (values : List Text)
  /-- A clean unwind under `compensate`, holding the failure of the named step. -/
  | compensated (failure : Text)
  /-- The failure of the named step, re-raised. -/
  | failed (failure : Text)
  /-- The defect of the named step, re-raised. -/
  | died (defect : Text)
  /-- The interruption, with the dirty steps it logged. -/
  | interrupted (reported : List Text)
  /-- `compensation_failed`: the dirty steps, and the typed failure that started the unwind when there was one. -/
  | dirty (residue : List Text) (failure : Option Text)
  deriving Repr, DecidableEq

structure Run where
  started : List Text
  unwound : List Text
  outcome : Outcome
  deriving Repr

def settle (policy : Policy) (chain : Forward) : Outcome :=
  let left := residue (unwinding policy chain)
  match chain.stop with
  | .finished => .completed (chain.committed.map (·.id))
  | .interrupted => .interrupted left
  | .failed id =>
    if left ≠ [] then .dirty left (some id)
    else if policy = .compensate then .compensated id
    else .failed id
  | .died id => if left ≠ [] then .dirty left none else .died id

/-- `Saga.run`. -/
def run (policy : Policy) (steps : List Step) : Run :=
  if steps = [] then { started := [], unwound := [], outcome := .refused .empty }
  else if ¬ (steps.map (·.id)).Nodup then { started := [], unwound := [], outcome := .refused .duplicate }
  else
    let chain := forward steps
    { started := chain.started
      unwound := (unwinding policy chain).map (·.id)
      outcome := settle policy chain }

end PatternsSpec.Saga

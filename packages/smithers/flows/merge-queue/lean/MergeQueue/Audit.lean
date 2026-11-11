/-
The build's own check: no `sorry`, and no axiom beyond Lean's three.

`lake build` compiles this file after every other module. It walks every
declaration of this project, definitions and theorems alike, collects the
axioms each one rests on, and fails the build if any rests on `sorryAx` or on
an axiom other than `propext`, `Classical.choice` and `Quot.sound`.

The lakefile turns every warning into an error as well, so a `sorry` fails
twice. The method is the lang factory model's (`factory/model/Factory/NoSorry.lean`).
-/
import Lean
import MergeQueue.Idempotent
import MergeQueue.Order
import MergeQueue.Prediction
import MergeQueue.Progress
import MergeQueue.NeverBlocks
import MergeQueue.Rebase
import MergeQueue.Trace

open Lean Elab Command

namespace MergeQueue.Audit

/-- The axioms Lean's own logic uses. Nothing else is allowed. -/
def allowed : List Name := [``propext, ``Classical.choice, ``Quot.sound]

/-- Whether a declaration belongs to this project: its module is `MergeQueue` or under it. -/
def ours (env : Environment) (name : Name) : Bool :=
  match env.getModuleIdxFor? name with
  | some idx => (env.header.moduleNames[idx.toNat]!).getRoot == `MergeQueue
  | none => false

run_cmd do
  let env ← getEnv
  let names := env.constants.fold (init := #[]) fun acc name _ => if ours env name then acc.push name else acc
  let mut proved : Nat := 0
  let mut bad : Array String := #[]
  for name in names do
    let isTheorem := match env.find? name with
      | some (.thmInfo _) => true
      | _ => false
    if isTheorem then proved := proved + 1
    let axioms ← collectAxioms name
    for used in axioms do
      unless allowed.contains used do
        bad := bad.push s!"{name} rests on {used}"
  unless bad.isEmpty do
    throwError "the model is not proved:\n{"\n".intercalate bad.toList}"
  logInfo m!"checked {names.size} declarations, {proved} of them theorems: no sorry, and no axiom beyond \
    propext, Classical.choice and Quot.sound."

end MergeQueue.Audit

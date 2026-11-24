import PatternsSpec.Basic

/-!
# Intervene: read, propose, apply behind an approval, report

The model of `Intervene.run`. A dry run reports the proposal and never applies. Otherwise an approval, when one is
configured, must decide the literal `"approved"`; any other decision denies and nothing is applied or reported.
-/

namespace PatternsSpec.Intervene

open PatternsSpec

inductive Phase where
  | read
  | propose
  | approval
  | apply
  | report
  deriving Repr, DecidableEq

structure Request where
  dryRun : Bool
  /-- The decision the approval returns, when an approval is configured. -/
  approval : Option Value
  /-- The phase whose effect fails, if any. -/
  failAt : Option Phase

inductive Outcome where
  /-- The report ran, and was told whether a change was applied and whether the run was dry. -/
  | reported (applied dryRun : Bool)
  /-- The approval decided something other than `"approved"`. -/
  | denied
  /-- The named phase failed. -/
  | failed (phase : Phase)
  deriving Repr, DecidableEq

structure Run where
  /-- The phases called, in order. -/
  calls : List Phase
  outcome : Outcome
  deriving Repr, DecidableEq

/-- Calls a phase after `calls`: it fails the run, or the run continues with `next`. -/
def step (request : Request) (calls : List Phase) (phase : Phase) (next : List Phase → Run) : Run :=
  if request.failAt = some phase then { calls := calls ++ [phase], outcome := .failed phase }
  else next (calls ++ [phase])

def report (request : Request) (applied : Bool) (calls : List Phase) : Run :=
  step request calls .report fun calls => { calls, outcome := .reported applied request.dryRun }

def apply (request : Request) (calls : List Phase) : Run :=
  step request calls .apply (report request true)

/-- `Intervene.run`. -/
def run (request : Request) : Run :=
  step request [] .read fun calls =>
    step request calls .propose fun calls =>
      if request.dryRun then report request false calls
      else
        match request.approval with
        | none => apply request calls
        | some decision =>
          step request calls .approval fun calls =>
            if decision.isApproved then apply request calls else { calls, outcome := .denied }

end PatternsSpec.Intervene

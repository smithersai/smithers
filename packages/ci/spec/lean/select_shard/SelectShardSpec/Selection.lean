import SelectShardSpec.Basic

/-!
# Contract 6: selection by score cutoff and top-K, and its metrics

The reference for `packages/ci/src/contract/Selection.vibe`: `select` and `metrics`.

A score is a finite double from 0 to 1, and selection only orders scores and compares them with the cutoff. The
specification therefore holds a score as its `scoreKey`: the bit pattern of the double read as a natural number,
which for non-negative finite doubles has the same order as the doubles themselves. Every law below is then a law
of natural numbers.

Outside that range the key is not the order: a negative score has a larger key than every score from 0 to 1. The
`Score` and `Settings` schemas admit only finite numbers from 0 to 1. A selection over several changes holds each
commit once, as the implementation's `Map` does.
-/

namespace SelectShardSpec

/-- The order-preserving key of a non-negative finite double: its IEEE-754 bits, with `-0` read as `0`. -/
def scoreKey (score : Float) : Nat :=
  (if score == 0 then (0 : Float) else score).toBits.toNat

/-- The model's answer for one change and one target. `score` is a `scoreKey`. -/
structure Score where
  commit : Text
  target : Text
  score : Nat
  deriving Repr, DecidableEq

/-- The two selection settings. `scoreCutoff` is a `scoreKey`. -/
structure Settings where
  scoreCutoff : Nat
  countCutoff : Nat
  deriving Repr, DecidableEq

/-- `a` ranks before `b`: the higher score first, then the lower target. -/
def Score.before (a b : Score) : Bool :=
  b.score < a.score || (a.score == b.score && textLt a.target b.target)

/-- The scores from the highest down; equal scores in target order. -/
def ranked (scores : List Score) : List Score :=
  scores.mergeSort (fun a b => !b.before a)

/-- An entry at rank `index` is selected when its score reaches the cutoff or its rank is among the top few. -/
def keep (settings : Settings) (index : Nat) (entry : Score) : Bool :=
  decide (settings.scoreCutoff ≤ entry.score) || decide (index < settings.countCutoff)

/-- The targets of the kept entries of a ranked list whose first rank is `index`. -/
def chosenFrom (settings : Settings) : Nat → List Score → List Text
  | _, [] => []
  | index, entry :: rest =>
    if keep settings index entry then entry.target :: chosenFrom settings (index + 1) rest
    else chosenFrom settings (index + 1) rest

/-- The targets of every kept entry, in rank order, with repeats. -/
def chosen (scores : List Score) (settings : Settings) : List Text :=
  chosenFrom settings 0 (ranked scores)

/-- `Selection.select`: the targets selected for one change, distinct and sorted by label. -/
def select (scores : List Score) (settings : Settings) : List Text :=
  sortTexts (chosen scores settings)

/-- The scored targets that are not selected, distinct and sorted by label. -/
def skipped (scores : List Score) (settings : Settings) : List Text :=
  sortTexts ((scores.map (·.target)).filter (fun target => decide (target ∉ chosen scores settings)))

/-- What the metrics read of one entry with a known outcome. -/
structure Row where
  commit : Text
  target : Text
  failed : Bool
  flaky : Bool
  deriving Repr, DecidableEq

/-- A selection over several changes: each commit with the targets selected for it. -/
abbrev Selected := List (Text × List Text)

/-- The targets selected for `commit`; none for a commit the selection does not hold. -/
def targetsFor : Selected → Text → List Text
  | [], _ => []
  | (known, targets) :: rest, commit => if known = commit then targets else targetsFor rest commit

/-- True when the selection holds the row's target for the row's commit. -/
def isSelected (selected : Selected) (row : Row) : Bool :=
  decide (row.target ∈ targetsFor selected row.commit)

/-- The counts behind the paper's three metrics. `caught` and `caughtChanges` are the numerators of the recalls. -/
structure Counts where
  rows : Nat
  selected : Nat
  failures : Nat
  failedChanges : Nat
  caught : Nat
  caughtChanges : Nat
  deriving Repr, DecidableEq

/-- The counts of a selection given as a predicate on rows. -/
def countsWith (pick : Row → Bool) (rows : List Row) : Counts :=
  let failures := rows.filter (·.failed)
  let caught := failures.filter pick
  { rows := rows.length
    selected := (rows.filter pick).length
    failures := failures.length
    failedChanges := (dedup (failures.map (·.commit))).length
    caught := caught.length
    caughtChanges := (dedup (caught.map (·.commit))).length }

/-- `Selection.metrics`, as exact counts. -/
def metrics (rows : List Row) (selected : Selected) : Counts :=
  countsWith (isSelected selected) rows

/-- Rows the selection skips. -/
def Counts.skipped (counts : Counts) : Nat := counts.rows - counts.selected

/-- `selectionRate` as the implementation's double. -/
def Counts.selectionRate (counts : Counts) : Float :=
  if counts.rows = 0 then 0 else counts.selected.toFloat / counts.rows.toFloat

/-- `testRecall` as the implementation's double; absent when no row failed. -/
def Counts.testRecall (counts : Counts) : Option Float :=
  if counts.failures = 0 then none else some (counts.caught.toFloat / counts.failures.toFloat)

/-- `changeRecall` as the implementation's double; absent when no row failed. -/
def Counts.changeRecall (counts : Counts) : Option Float :=
  if counts.failures = 0 then none else some (counts.caughtChanges.toFloat / counts.failedChanges.toFloat)

end SelectShardSpec

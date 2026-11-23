import SelectShardSpec.Features

/-!
# Measuring fast mode: split, sample, sweep, calibrate, and Wilson's bound

The reference for `packages/ci/src/select/Measure.vibe` without `render`.

Recall comparisons are exact: "test recall at least 0.9" is `9 * failures ≤ 10 * caught`. The implementation compares
correctly rounded doubles. The two agree for every count below 2^40, and a JavaScript array holds fewer than 2^32
rows: two different fractions with denominators below 2^40 and at most 1000 are more than 9e-16 apart, and the two
roundings move a comparison by at most 1.2e-16. Far above that they can differ: with 19,000,000,000,001 failed
changes and 18,981,000,000,001 caught, the exact change recall is above 0.999 and the double is equal to it.

Times are whole milliseconds below 2^53 in size, where the implementation's doubles are exact. Wilson's bound is IEEE
double arithmetic, operation for operation.
-/

namespace SelectShardSpec

/-- The test set is the rows of this many days up to the newest row. -/
def testDays : Int := 7

/-- Rows split by time. -/
structure Split where
  first : Int
  last : Int
  history : List Observation
  test : List Observation
  deriving Repr

/-- `split`: the newest `testDays` days are the test set and the rest is history. -/
def split (observations : List Observation) : Split :=
  let last := observations.foldl (fun newest observation => max newest observation.time)
    ((observations.head?.map (·.time)).getD 0)
  let first := last - testDays * day
  { first, last
    history := observations.filter (fun observation => decide (observation.time ≤ first))
    test := observations.filter (fun observation => !decide (observation.time ≤ first)) }

/-- The test set's commits in time order, each at the time of its last observation; equal times in commit order. -/
def changesInOrder (test : List Observation) : List Text :=
  let timeOf := fun (commit : Text) =>
    (((test.filter (fun observation => observation.row.commit == commit)).getLast?).map (·.time)).getD 0
  (((dedup (test.map (·.row.commit))).map (fun commit => (commit, timeOf commit))).mergeSort
    (fun a b => decide (a.2 < b.2) || (a.2 == b.2 && !textLt b.1 a.1))).map (·.1)

/-- `sample`: at most `count` changes, evenly spaced through the time order, with all of their rows. -/
def sample (test : List Observation) (count : Nat) : List Observation :=
  let ordered := changesInOrder test
  if ordered.length ≤ count then test
  else
    let kept := (List.range count).map (fun index => ordered.getD (index * ordered.length / count) [])
    test.filter (fun observation => kept.contains observation.row.commit)

/-- `selected`: the selection of every change, each change's scores selected on their own. -/
def selected (scores : List Score) (settings : Settings) : Selected :=
  (dedup (scores.map (·.commit))).map (fun commit =>
    (commit, select (scores.filter (fun score => score.commit == commit)) settings))

/-- `measure`: the counts of `settings` over `rows`. -/
def measure (rows : List Row) (scores : List Score) (settings : Settings) : Counts :=
  metrics rows (selected scores settings)

/-- `Math.max(0, x)`. -/
def maxZero (x : Float) : Float :=
  if x.isNaN then x else if x > 0 then x else 0

/-- The 95th percentile of the standard normal distribution. -/
def z : Float := 1.6448536269514722

/-- `lowerBound`: Wilson's one-sided 95% lower bound for `caught` of `total`, in the implementation's operations. -/
def lowerBound (caught total : Float) : Float :=
  if caught ≤ 0 || total ≤ 0 then 0
  else
    let share := caught / total
    let centre := share + (z * z) / (2 * total)
    let spread := z * Float.sqrt ((share * (1 - share)) / total + (z * z) / (4 * total * total))
    maxZero ((centre - spread) / (1 + (z * z) / total))

/-- `lowerBound` over counts. -/
def lowerBoundOfCounts (caught total : Nat) : Float :=
  if caught = 0 then 0 else lowerBound caught.toFloat total.toFloat

/-- The score cutoffs swept with the count cutoff at 0, highest first. -/
def scoreCutoffs : List Float := [1, 0.9, 0.7, 0.5, 0.3, 0.2, 0.1, 0.05, 0.02, 0.01, 0]

/-- The count cutoffs swept with the score cutoff at 1, lowest first. -/
def countCutoffs : List Nat := [0, 1, 2, 5, 10, 20, 50, 100]

/-- The settings fast mode starts with. -/
def defaults : Settings := { scoreCutoff := scoreKey 0.1, countCutoff := 5 }

/-- One setting and what it measured. -/
structure Point where
  settings : Settings
  counts : Counts
  deriving Repr, DecidableEq

/-- Test recall is at least 0.9: the weekly check's bar. -/
def reachesWeekly (counts : Counts) : Bool := decide (9 * counts.failures ≤ 10 * counts.caught)

/-- Test recall is above 0.95. -/
def passesTestRecall (counts : Counts) : Bool := decide (19 * counts.failures < 20 * counts.caught)

/-- Change recall is above 0.999. -/
def passesChangeRecall (counts : Counts) : Bool := decide (999 * counts.failedChanges < 1000 * counts.caughtChanges)

/-- What an eval reports. `measured` is false when no row failed; then there is no weekly check and no calibration. -/
structure Report where
  rows : Nat
  changes : Nat
  failures : Nat
  failedChanges : Nat
  flaky : Nat
  measured : Bool
  start : Point
  byScore : List Point
  byCount : List Point
  weekly : Option Point
  calibrated : Option Point
  deriving Repr

/-- The point of `settings`. -/
def pointOf (rows : List Row) (scores : List Score) (settings : Settings) : Point :=
  { settings, counts := measure rows scores settings }

/-- The score-cutoff sweep. -/
def sweepByScore (rows : List Row) (scores : List Score) : List Point :=
  scoreCutoffs.map (fun cutoff => pointOf rows scores { scoreCutoff := scoreKey cutoff, countCutoff := 0 })

/--
The calibration: the first setting, by score cutoff from the highest and then by count cutoff from the lowest, whose
score cutoff alone passes test recall and which passes change recall.
-/
def calibrate (rows : List Row) (scores : List Score) : Option Point :=
  ((sweepByScore rows scores).filter (fun point => passesTestRecall point.counts)).findSome? (fun point =>
    countCutoffs.findSome? (fun countCutoff =>
      let calibrated := pointOf rows scores { scoreCutoff := point.settings.scoreCutoff, countCutoff }
      if passesChangeRecall calibrated.counts then some calibrated else none))

/-- `report`: the sweeps, the weekly check and the calibration. -/
def report (rows : List Row) (scores : List Score) : Report :=
  let byScore := sweepByScore rows scores
  let start := pointOf rows scores defaults
  let measured := start.counts.failures != 0
  { rows := rows.length
    changes := (dedup (rows.map (·.commit))).length
    failures := start.counts.failures
    failedChanges := start.counts.failedChanges
    flaky := (rows.filter (·.flaky)).length
    measured
    start
    byScore
    byCount := countCutoffs.map (fun countCutoff => pointOf rows scores { scoreCutoff := scoreKey 1, countCutoff })
    weekly := if measured then byScore.find? (fun point => reachesWeekly point.counts) else none
    calibrated := if measured then calibrate rows scores else none }

end SelectShardSpec

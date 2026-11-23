import SelectShardSpec.Selection

/-!
# Fast mode's features: change and failure windows, and graph distance

The reference for the pure window and graph functions of `packages/ci/src/select/Features.vibe`: `projectOf`,
`fileChanges`, `failureRates` and `graphDistances`. Times are whole milliseconds below 2^53 in size, where the
implementation's doubles are exact, so every window is exact integer arithmetic; a failure rate is a pair of counts, with the implementation's double beside it.
-/

namespace SelectShardSpec

/-- One day, in milliseconds. -/
def day : Int := 86400000

/-- The graph distance of a target no changed file reaches. -/
def unreachable : Int := -1

/-- One past commit: when it was made and the files it changed. -/
structure Commit where
  time : Int
  files : List Text
  deriving Repr

/-- A row and the time of its change. -/
structure Observation where
  time : Int
  row : Row
  deriving Repr, DecidableEq

/-- Everything before the last `unit`; the whole list when it has none. -/
def dropFromLast (unit : Nat) : List Nat → List Nat
  | [] => []
  | x :: rest => if x = unit ∧ !rest.contains unit then [] else x :: dropFromLast unit rest

/-- `projectOf`: the label without a leading `//` and without its last `:` and what follows; the root is `.`. -/
def projectOf (label : Text) : Text :=
  let path := dropFromLast 58 (if [47, 47].isPrefixOf label then label.drop 2 else label)
  if path.isEmpty then [46] else path

/-- True when `file` is inside `project`. -/
def inside (project file : Text) : Bool :=
  project == [46] || (project ++ [47]).isPrefixOf file

/-- How many commits that changed one of `files` are before `time` and at most `days` days old. -/
def changesWithin (files : List Text) (time : Int) (history : List Commit) (days : Int) : Nat :=
  (history.filter (fun commit =>
    decide (commit.time < time) && commit.files.any (fun file => files.contains file)
      && decide (time - commit.time ≤ days * day))).length

/-- `fileChanges`: the counts for 3, 14 and 56 days. -/
def fileChanges (files : List Text) (time : Int) (history : List Commit) : Nat × Nat × Nat :=
  (changesWithin files time history 3, changesWithin files time history 14, changesWithin files time history 56)

/-- The runs before `time` and at most `days` days old. -/
def window (time : Int) (runs : List Observation) (days : Int) : List Observation :=
  runs.filter (fun run => decide (run.time < time) && decide (time - run.time ≤ days * day))

/-- A failure rate as exact counts: `failed` of `total` runs. -/
structure Rate where
  failed : Nat
  total : Nat
  deriving Repr, DecidableEq

/-- The failure rate of one window. -/
def rateWithin (time : Int) (runs : List Observation) (days : Int) : Rate :=
  let runs := window time runs days
  { failed := (runs.filter (·.row.failed)).length, total := runs.length }

/-- The rate as the implementation's double: 0 for a window with no run. -/
def Rate.toFloat (rate : Rate) : Float :=
  if rate.total = 0 then 0 else rate.failed.toFloat / rate.total.toFloat

/-- `failureRates`: the rates for 7, 14, 28 and 56 days. -/
def failureRates (time : Int) (runs : List Observation) : List Rate :=
  [7, 14, 28, 56].map (rateWithin time runs)

/-- A planned target: its label and the labels it depends on. -/
structure PlannedTarget where
  label : Text
  dependencies : List Text
  deriving Repr

/-- How specific a project is: the root least, then by length. -/
def specificity (project : Text) : Nat :=
  if project = [46] then 0 else project.length

/--
One level of the walk: each label of `frontier` not yet seen is recorded at `distance`, and its dependents join the
next frontier.
-/
def visit (dependents : Text → List Text) (distance : Nat) (frontier : List Text)
    (seen : List (Text × Nat)) : List (Text × Nat) × List Text :=
  frontier.foldl
    (fun (state : List (Text × Nat) × List Text) label =>
      if state.1.any (fun known => known.1 == label) then state
      else ((label, distance) :: state.1, state.2 ++ dependents label))
    (seen, [])

/--
The breadth-first walk. A level with a non-empty next frontier records at least one new label, and every label it
can record is one of the plan's or the targets', so `fuel` of their number plus one is never exhausted early.
-/
def walk (dependents : Text → List Text) : Nat → Nat → List Text → List (Text × Nat) → List (Text × Nat)
  | 0, _, _, seen => seen
  | fuel + 1, distance, frontier, seen =>
    if frontier.isEmpty then seen
    else
      let next := visit dependents distance frontier seen
      walk dependents fuel (distance + 1) next.2 next.1

/--
`graphDistances`: the shortest distance from a changed file to each label. A changed file belongs to the most
specific project that holds it; that project's targets are at 0; a dependent of a target at `n` is at most at
`n + 1`; a label nothing reaches is `unreachable`.
-/
def graphDistances (files targets : List Text) (plan : Option (List PlannedTarget)) : List (Text × Int) :=
  let planned := plan.getD []
  let labels := dedup (targets ++ planned.map (·.label))
  let projects := (dedup (labels.map projectOf)).mergeSort (fun a b => decide (specificity b ≤ specificity a))
  let owners := files.filterMap (fun file => projects.find? (fun project => inside project file))
  let dependents := fun (label : Text) =>
    planned.flatMap (fun target => (target.dependencies.filter (· == label)).map (fun _ => target.label))
  let seen := walk dependents (labels.length + 1) 0 (labels.filter (fun label => owners.contains (projectOf label))) []
  labels.map (fun label =>
    (label, match seen.find? (fun known => known.1 == label) with
      | some known => (known.2 : Int)
      | none => unreachable))

end SelectShardSpec

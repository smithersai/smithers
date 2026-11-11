import MergeQueue.Step

/-!
# Predicted durations

The queue remembers how long each check took and predicts from that. A
prediction orders work and tells people when to expect a result. It never
decides what lands: `step` reads `history` only to append to it.
-/

namespace MergeQueue

/-- The remembered durations of one check, oldest first. -/
def samples (history : List (CheckId × Nat)) (check : CheckId) : List Nat :=
  (history.filter fun h => h.1 == check).map (·.2)

/-- The predicted duration of a check: the median of its samples (the upper
one of two middles), or the configured default with no samples. -/
def estimate (cfg : Config) (history : List (CheckId × Nat)) (check : CheckId) : Nat :=
  let sorted := (samples history check).mergeSort fun a b => a ≤ b
  match sorted[sorted.length / 2]? with
  | some d => d
  | none => cfg.defaultDuration

/-- The required checks in the order to start them: slowest first, so the
check that decides how long the run takes starts at once. Ties keep the
configured order. -/
def schedule (cfg : Config) (history : List (CheckId × Nat)) : List CheckId :=
  cfg.required.mergeSort fun a b => estimate cfg history b ≤ estimate cfg history a

/-- The checks of a run that have no result yet, in schedule order. -/
def remaining (cfg : Config) (history : List (CheckId × Nat)) (results : List (CheckId × Verdict)) :
    List CheckId :=
  (schedule cfg history).filter fun c => !answered results c

/-- The predicted time for a run's remaining checks when they run side by
side: the slowest of them. -/
def eta (cfg : Config) (history : List (CheckId × Nat)) (results : List (CheckId × Verdict)) : Nat :=
  ((remaining cfg history results).map (estimate cfg history)).foldl max 0

end MergeQueue

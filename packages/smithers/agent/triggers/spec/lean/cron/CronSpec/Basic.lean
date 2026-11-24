/-!
# A cron schedule and the two bounded searches

A schedule is six sets of numbers and one flag. An empty set stands for the whole field, which is how the
implementation holds a field written `*`. Each set is kept in increasing order with no repeats.

The searches are the whole of the specification's computation: the least number at or above a floor that satisfies a
predicate, and the greatest number below a ceiling that does. Each is bounded by a count it is given, so it ends.
-/

namespace CronSpec

/-- A parsed cron expression: the values each field admits, an empty list admitting every value. -/
structure Cron where
  seconds : List Nat
  minutes : List Nat
  hours : List Nat
  days : List Nat
  months : List Nat
  weekdays : List Nat
  /-- Day of month and weekday must both match; otherwise either one matching is enough. -/
  both : Bool
deriving Repr, DecidableEq

/-- A field admits a value when the field is unrestricted or lists the value. -/
def allows (set : List Nat) (value : Nat) : Bool := set.isEmpty || set.contains value

/-- The least `k` with `floor ≤ k < floor + count` and `p k`. -/
def firstFrom (p : Nat → Bool) (floor : Nat) : Nat → Option Nat
  | 0 => none
  | count + 1 => if p floor then some floor else firstFrom p (floor + 1) count

/-- The greatest `k` with `k < ceiling` and `p k`. -/
def lastBelow (p : Nat → Bool) : Nat → Option Nat
  | 0 => none
  | ceiling + 1 => if p ceiling then some ceiling else lastBelow p ceiling

end CronSpec

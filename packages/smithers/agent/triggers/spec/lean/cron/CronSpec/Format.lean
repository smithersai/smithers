import CronSpec.Basic

/-!
# Writing a schedule as an expression

A field is written as `*` when unrestricted. Otherwise three or more values in a row at one distance are written as
a range, `1-5` or `0-30/10`, and every other value alone. The seconds field is left out when it is exactly second 0,
unless it is asked for.
-/

namespace CronSpec

/-- The last value of the run that continues from `last` at distance `stride`, and the values after the run. -/
def runFrom (stride : Nat) : (last : Nat) → List Nat → Nat × List Nat
  | last, [] => (last, [])
  | last, value :: rest => if value - last == stride then runFrom stride value rest else (last, value :: rest)

/-- The items of a field, given at least as much fuel as it has values. -/
def formatItems : (fuel : Nat) → List Nat → List String
  | 0, _ => []
  | _, [] => []
  | fuel + 1, [value] => toString value :: formatItems fuel []
  | fuel + 1, [first, second] => toString first :: formatItems fuel [second]
  | fuel + 1, first :: second :: third :: rest =>
    if third - second == second - first then
      let stride := second - first
      let (last, after) := runFrom stride third rest
      (s!"{first}-{last}" ++ (if stride == 1 then "" else s!"/{stride}")) :: formatItems fuel after
    else toString first :: formatItems fuel (second :: third :: rest)

/-- One field as text. -/
def formatSegment (values : List Nat) : String :=
  if values.isEmpty then "*" else ",".intercalate (formatItems values.length values)

/-- A schedule as an expression. -/
def format (cron : Cron) (includeSeconds : Bool) : String :=
  let segments := [cron.seconds, cron.minutes, cron.hours, cron.days, cron.months, cron.weekdays].map formatSegment
  " ".intercalate (if !includeSeconds && cron.seconds == [0] then segments.drop 1 else segments)

end CronSpec

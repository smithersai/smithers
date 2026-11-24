import CronSpec.Basic
import CronSpec.Calendar

/-!
# Matching and the occurrence searches, in UTC

An instant is a whole number of seconds from the epoch, negative before it. It splits into a day and a second of
that day, and a schedule matches it when it matches the day's date and the second's time.

The next occurrence is the least matching instant after a given one. It is found on the given day when that day
matches and a later second of it does; otherwise on the first matching day after it, at that day's first matching
second. The search looks `horizon` days ahead, one full era of the calendar, after which every date has recurred on
its weekday: a schedule with no occurrence in that window has none at all.
-/

namespace CronSpec

/-- The seconds in a day. -/
abbrev daySeconds : Nat := 86400

/-- The days in a 400 year era, a whole number of weeks. -/
def horizon : Nat := 146097

/-- Whether the schedule matches a second of the day: its second, minute and hour. -/
def timeMatch (cron : Cron) (second : Nat) : Bool :=
  allows cron.seconds (second % 60) && allows cron.minutes (second / 60 % 60) && allows cron.hours (second / 3600)

/-- Whether the schedule matches a day: its month, and its day of month and weekday under the `both` flag. -/
def dateMatch (cron : Cron) (epochDay : Int) : Bool :=
  let date := civil epochDay
  allows cron.months date.month &&
    (if cron.days.isEmpty && cron.weekdays.isEmpty then true
    else if cron.both then allows cron.days date.day && allows cron.weekdays date.weekday
    else if cron.weekdays.isEmpty then cron.days.contains date.day
    else if cron.days.isEmpty then cron.weekdays.contains date.weekday
    else cron.days.contains date.day || cron.weekdays.contains date.weekday)

/-- Whether the schedule fires at an instant, in whole seconds. -/
def fires (cron : Cron) (instant : Int) : Bool :=
  dateMatch cron (instant / 86400) && timeMatch cron (instant % 86400).toNat

/-- A matching second later in the same day, when the day matches. -/
def laterToday (cron : Cron) (day : Int) (second : Nat) : Option Nat :=
  if dateMatch cron day then firstFrom (timeMatch cron) (second + 1) (86399 - second) else none

/-- A matching second no later in the same day, when the day matches. -/
def earlierToday (cron : Cron) (day : Int) (second : Nat) : Option Nat :=
  if dateMatch cron day then lastBelow (timeMatch cron) (second + 1) else none

/-- The first occurrence strictly after an instant, or none when the schedule never fires. -/
def nextSecond (cron : Cron) (instant : Int) : Option Int :=
  let day := instant / 86400
  match laterToday cron day (instant % 86400).toNat with
  | some second => some (day * 86400 + second)
  | none =>
    match firstFrom (fun ahead => dateMatch cron (day + 1 + ahead)) 0 horizon, firstFrom (timeMatch cron) 0 86400 with
    | some ahead, some second => some ((day + 1 + ahead) * 86400 + second)
    | _, _ => none

/-- The last occurrence at or before an instant, or none when the schedule never fires. -/
def previousSecond (cron : Cron) (instant : Int) : Option Int :=
  let day := instant / 86400
  match earlierToday cron day (instant % 86400).toNat with
  | some second => some (day * 86400 + second)
  | none =>
    match firstFrom (fun back => dateMatch cron (day - 1 - back)) 0 horizon, lastBelow (timeMatch cron) 86400 with
    | some back, some second => some ((day - 1 - back) * 86400 + second)
    | _, _ => none

/-- Whether the schedule fires at the second a millisecond instant falls in. -/
def firesAt (cron : Cron) (millis : Int) : Bool := fires cron (millis / 1000)

/-- The first occurrence strictly after a millisecond instant, in milliseconds. -/
def next (cron : Cron) (millis : Int) : Option Int := (nextSecond cron (millis / 1000)).map (· * 1000)

/-- The last occurrence at or before a millisecond instant, in milliseconds. -/
def previous (cron : Cron) (millis : Int) : Option Int := (previousSecond cron (millis / 1000)).map (· * 1000)

/-- The occurrences after `cursor` and at or before `to`, in order, at most `limit` of them. -/
def between (cron : Cron) (to : Int) : (limit : Nat) → (cursor : Int) → List Int
  | 0, _ => []
  | limit + 1, cursor =>
    match next cron cursor with
    | some occurrence => if occurrence ≤ to then occurrence :: between cron to limit occurrence else []
    | none => []

/-- A schedule some calendar date and time of day satisfies. -/
def satisfiable (cron : Cron) : Bool := (nextSecond cron 0).isSome

end CronSpec

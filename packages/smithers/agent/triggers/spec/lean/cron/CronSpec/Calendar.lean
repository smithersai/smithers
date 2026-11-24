/-!
# The proleptic Gregorian calendar

A day is counted from 1 January 1970, which is day 0 and a Thursday; days before it are negative. The conversion is
the era arithmetic of Howard Hinnant's `civil_from_days`: a 400 year era is 146,097 days, and the year inside it
starts on 1 March so the leap day is the last day of its year.
-/

namespace CronSpec

/-- A calendar date. The month is 1 to 12, the day 1 to 31, and the weekday 0 (Sunday) to 6. -/
structure Date where
  year : Int
  month : Nat
  day : Nat
  weekday : Nat
deriving Repr, DecidableEq

/-- The day of the year that starts on 1 March, 0 to 365, of a day of its 400 year era. -/
def dayOfYear (dayOfEra : Nat) : Nat :=
  let yearOfEra := (dayOfEra - dayOfEra / 1460 + dayOfEra / 36524 - dayOfEra / 146096) / 365
  dayOfEra - (365 * yearOfEra + yearOfEra / 4 - yearOfEra / 100)

/-- The month, 1 to 12, of a day of the year that starts on 1 March. -/
def monthOf (dayOfYear : Nat) : Nat :=
  let shiftedMonth := (5 * dayOfYear + 2) / 153
  if shiftedMonth < 10 then shiftedMonth + 3 else shiftedMonth - 9

/-- The day of the month, 1 to 31, of a day of the year that starts on 1 March. -/
def dayOfMonth (dayOfYear : Nat) : Nat := dayOfYear - (153 * ((5 * dayOfYear + 2) / 153) + 2) / 5 + 1

/-- The calendar date of a day counted from 1 January 1970. -/
def civil (epochDay : Int) : Date :=
  let shifted := epochDay + 719468
  let era := shifted / 146097
  let dayOfEra := (shifted % 146097).toNat
  let yearOfEra := (dayOfEra - dayOfEra / 1460 + dayOfEra / 36524 - dayOfEra / 146096) / 365
  let month := monthOf (dayOfYear dayOfEra)
  { year := (yearOfEra : Int) + era * 400 + (if month ≤ 2 then 1 else 0)
    month := month
    day := dayOfMonth (dayOfYear dayOfEra)
    weekday := ((epochDay + 4) % 7).toNat }

end CronSpec

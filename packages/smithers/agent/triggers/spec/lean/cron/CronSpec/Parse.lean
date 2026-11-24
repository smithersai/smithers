import CronSpec.Basic

/-!
# Parsing a cron expression

An expression is five or six fields separated by white space: an optional seconds field, then minutes, hours, days
of the month, months and weekdays. A field is a list of items separated by commas. An item is `*`, a value, or a
range `low-high`, each optionally followed by `/step`. A month or a weekday may be written as its three letter
English name in any case, and weekday 7 is Sunday, the same as 0.

The details the implementation fixes, and this follows:

- A field whose first item is `*` or `*/1` admits every value and is held as the empty set, whatever follows it.
- A value with a step, `5/15`, runs from the value to the field's maximum.
- A step is at least 1 and at most the field's maximum.
- Day of month and weekday must both match when one of them begins with `*` and neither is unrestricted.
- The first field in error decides the message, and within a field the first item in error.
-/

namespace CronSpec

/-- The characters JavaScript's `\s` and `trim` treat as white space. -/
def isSpace (c : Char) : Bool :=
  [0x9, 0xA, 0xB, 0xC, 0xD, 0x20, 0xA0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF].contains c.toNat ||
    (0x2000 ≤ c.toNat && c.toNat ≤ 0x200A)

/-- The pieces between separators, empty pieces included, as JavaScript's `split` returns them. -/
def splitBy (separator : Char → Bool) : List Char → List (List Char)
  | [] => [[]]
  | c :: rest =>
    if separator c then [] :: splitBy separator rest
    else
      match splitBy separator rest with
      | piece :: pieces => (c :: piece) :: pieces
      | [] => [[c]]

/-- The text before the first separator and the text after it, when there is one. -/
def breakAt (separator : Char) : List Char → Option (List Char × List Char)
  | [] => none
  | c :: rest =>
    if c == separator then some ([], rest)
    else (breakAt separator rest).map (fun (before, after) => (c :: before, after))

/-- The largest number a double holds; a longer numeral reads as infinity, which is not an integer. -/
def finiteBound : Nat := 2 ^ 1024 - 2 ^ 970

/-- A numeral of decimal digits as a number, or none for any other text. -/
def decimal (text : List Char) : Option Nat :=
  if text.isEmpty || !text.all Char.isDigit then none
  else
    let value := text.foldl (fun total digit => total * 10 + (digit.toNat - '0'.toNat)) 0
    if value < finiteBound then some value else none

/-- The limits and names of one field. -/
structure Field where
  min : Nat
  max : Nat
  names : List (String × Nat) := []
  /-- Weekday 7 is weekday 0. -/
  wraps : Bool := false

def secondField : Field := { min := 0, max := 59 }
def minuteField : Field := { min := 0, max := 59 }
def hourField : Field := { min := 0, max := 23 }
def dayField : Field := { min := 1, max := 31 }

def monthField : Field :=
  { min := 1
    max := 12
    names := [("jan", 1), ("feb", 2), ("mar", 3), ("apr", 4), ("may", 5), ("jun", 6), ("jul", 7), ("aug", 8),
      ("sep", 9), ("oct", 10), ("nov", 11), ("dec", 12)] }

def weekdayField : Field :=
  { min := 0
    max := 7
    names := [("sun", 0), ("mon", 1), ("tue", 2), ("wed", 3), ("thu", 4), ("fri", 5), ("sat", 6)]
    wraps := true }

/-- A name of the field in any case, or a numeral. -/
def valueOf (field : Field) (text : List Char) : Option Nat :=
  match field.names.lookup (String.ofList (text.map Char.toLower)) with
  | some value => some value
  | none => decimal text

/-- A step as written: absent, not a numeral, or a number. -/
inductive Step where
  | absent
  | malformed
  | of (value : Nat)
deriving Repr, DecidableEq

/-- An item split at its first `/`. -/
def splitStep (item : List Char) : List Char × Step :=
  match breakAt '/' item with
  | none => (item, .absent)
  | some (body, step) =>
    (body, match decimal step with
      | some value => .of value
      | none => .malformed)

/-- The distance between two values of an item. -/
def Step.stride : Step → Nat
  | .of value => value
  | _ => 1

/-- `low`, `low + stride`, … up to `high`. -/
def stepped (low high stride : Nat) : List Nat :=
  ((List.range (high + 1 - low)).filter (fun offset => offset % stride == 0)).map (low + ·)

/-- The value a field holds for a value written in it. -/
def Field.normalize (field : Field) (value : Nat) : Nat := if field.wraps && value == 7 then 0 else value

/-- The values one item adds, or the message it is refused with. `leads` is true for the first item of the field. -/
def itemValues (field : Field) (leads : Bool) (item : List Char) : Except String (List Nat) := do
  let (body, step) := splitStep item
  match step with
  | .absent => pure ()
  | .malformed => throw "Expected step value to be a positive integer"
  | .of value =>
    if value < 1 then throw "Expected step value to be greater than 0"
    if value > field.max then throw s!"Expected step value to be less than or equal to {field.max}"
  if body == ['*'] then
    if leads && (step == .absent || step == .of 1) then pure []
    else pure (stepped field.min field.max step.stride)
  else
    let bounded (text : List Char) : Except String Nat :=
      match valueOf field text with
      | none => throw "Expected a positive integer"
      | some value =>
        if value < field.min || value > field.max then
          throw s!"Expected a value between {field.min} and {field.max}"
        else pure value
    match breakAt '-' body with
    | none =>
      let low ← bounded body
      pure (stepped low (if step == .absent then low else field.max) step.stride)
    | some (left, right) =>
      let low ← bounded left
      let high ← bounded right
      if low > high then throw "Invalid value range"
      pure (stepped low high step.stride)

/-- The values every item adds, in the order written. -/
def itemsValues (field : Field) : (leads : Bool) → List (List Char) → Except String (List Nat)
  | _, [] => pure []
  | leads, item :: rest => do
    let values ← itemValues field leads item
    pure (values ++ (← itemsValues field false rest))

/-- A field as parsed: the values it admits and whether its first item is `*`, stepped or not. -/
structure Segment where
  values : List Nat
  wildcard : Bool
deriving Repr, DecidableEq

/-- A set of field values in increasing order with no repeats. -/
def ordered (field : Field) (values : List Nat) : List Nat :=
  (List.range (field.max + 1)).filter (fun value => values.contains value)

/-- One field of an expression. -/
def parseSegment (field : Field) (input : List Char) : Except String Segment := do
  let items := splitBy (· == ',') input
  let lead := splitStep (items.headD [])
  let wildcard := lead.1 == ['*']
  let unrestricted := wildcard && (lead.2 == .absent || lead.2 == .of 1)
  let values ← itemsValues field true items
  pure { values := if unrestricted then [] else ordered field (values.map field.normalize), wildcard }

/-- The fields of an expression: its runs of characters that are not white space. -/
def words (expression : String) : List (List Char) :=
  (splitBy isSpace expression.toList).filter (fun word => !word.isEmpty)

/-- A cron expression as a schedule, or the message it is refused with. -/
def parse (expression : String) : Except String Cron := do
  let fields := words expression
  let fields ← match fields.length with
    | 5 => pure (['0'] :: fields)
    | 6 => pure fields
    | _ => throw "Invalid number of segments in cron expression"
  match fields with
  | [seconds, minutes, hours, days, months, weekdays] =>
    let seconds ← parseSegment secondField seconds
    let minutes ← parseSegment minuteField minutes
    let hours ← parseSegment hourField hours
    let days ← parseSegment dayField days
    let months ← parseSegment monthField months
    let weekdays ← parseSegment weekdayField weekdays
    pure {
      seconds := seconds.values
      minutes := minutes.values
      hours := hours.values
      days := days.values
      months := months.values
      weekdays := weekdays.values
      both := (days.wildcard || weekdays.wildcard) && !days.values.isEmpty && !weekdays.values.isEmpty }
  | _ => throw "Invalid number of segments in cron expression"

end CronSpec

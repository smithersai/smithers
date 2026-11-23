/-
The values an expression gives, and JSON as `JSON.parse` and `JSON.stringify` read and write it.
-/
import InventorySpec.Number

namespace InventorySpec

/--
A value an expression gives.

A list and a mapping carry an identity, because two of them are equal only when they are the same one. A list or
mapping that a context holds has an identity other than 0, the same wherever the context is read. One that an
expression makes (`fromJSON`, `.*`) has identity 0 and equals nothing: an expression has no way to read it twice.
-/
inductive Value where
  | null
  | bool (b : Bool)
  | num (x : Float)
  | str (s : String)
  | arr (id : Nat) (items : List Value)
  | obj (id : Nat) (fields : List (String × Value))
  deriving Inhabited

/-- A text in double quotes as `JSON.stringify` writes it. -/
def quoteJson (text : List Char) : List Char :=
  '"' :: text.flatMap (fun c =>
    if c == '"' then ['\\', '"']
    else if c == '\\' then ['\\', '\\']
    else if c == '\n' then ['\\', 'n']
    else if c == '\r' then ['\\', 'r']
    else if c == '\t' then ['\\', 't']
    else if c.toNat == 8 then ['\\', 'b']
    else if c.toNat == 12 then ['\\', 'f']
    else if c.toNat < 0x20 then '\\' :: 'u' :: hexDigits c.toNat 4
    else [c]) ++ ['"']

mutual
  /-- `JSON.stringify(value, undefined, 2)` at one depth of indentation. A number JSON cannot write is `null`. -/
  def stringify (indent : List Char) : Value → List Char
    | .null => "null".toList
    | .bool b => (if b then "true" else "false").toList
    | .num x => if x.isFinite then jsNumberText x else "null".toList
    | .str s => quoteJson s.toList
    | .arr _ [] => ['[', ']']
    | .arr _ (first :: rest) =>
      '[' :: '\n' :: stringifyItems (' ' :: ' ' :: indent) (first :: rest) ++ '\n' :: indent ++ [']']
    | .obj _ [] => ['{', '}']
    | .obj _ (first :: rest) =>
      '{' :: '\n' :: stringifyFields (' ' :: ' ' :: indent) (first :: rest) ++ '\n' :: indent ++ ['}']

  /-- The entries of a list, one to a line. -/
  def stringifyItems (indent : List Char) : List Value → List Char
    | [] => []
    | [item] => indent ++ stringify indent item
    | item :: rest => indent ++ stringify indent item ++ ',' :: '\n' :: stringifyItems indent rest

  /-- The fields of a mapping, one to a line. -/
  def stringifyFields (indent : List Char) : List (String × Value) → List Char
    | [] => []
    | [(key, item)] => indent ++ quoteJson key.toList ++ ':' :: ' ' :: stringify indent item
    | (key, item) :: rest =>
      indent ++ quoteJson key.toList ++ ':' :: ' ' :: stringify indent item ++ ',' :: '\n' :: stringifyFields indent rest
end

/-- `toJSON`. -/
def toJson (held : Value) : String := String.ofList (stringify [] held)

/-- The index a property name is when JavaScript orders it before the other names: `0` to `4294967294`, written plainly. -/
def arrayIndex? (key : String) : Option Nat :=
  let digits := key.toList
  if digits.isEmpty || !digits.all isDigit || (digits.length > 1 && digits.head? == some '0') then none
  else
    let n := decimalValue digits
    if n < 2 ^ 32 - 1 then some n else none

/-- Sets one field: a name already there keeps its place and takes the new value. -/
def setField {α : Type} (fields : List (String × α)) (key : String) (item : α) : List (String × α) :=
  if fields.any (·.1 == key) then fields.map fun (k, v) => if k == key then (k, item) else (k, v)
  else fields ++ [(key, item)]

/--
The fields of a mapping in the order JavaScript keeps them: names that are indices first, in rising order, then
the others as first written. A name written twice has its last value.
-/
def jsObject {α : Type} (pairs : List (String × α)) : List (String × α) :=
  let fields := pairs.foldl (fun so_far (key, item) => setField so_far key item) []
  let indexed := fields.filterMap fun (key, item) => (arrayIndex? key).map fun n => (n, key, item)
  (indexed.mergeSort (fun a b => a.1 ≤ b.1)).map (fun (_, key, item) => (key, item))
    ++ fields.filter fun (key, _) => (arrayIndex? key).isNone

/-- The white space JSON allows between tokens. -/
def skipJsonSpace (text : List Char) : List Char :=
  text.dropWhile fun c => c == ' ' || c == '\t' || c == '\n' || c == '\r'

/-- The code unit four hexadecimal digits spell. -/
def hex4? (a b c d : Char) : Option Nat := digitsValue? 16 [a, b, c, d]

/-- A JSON string from after its opening quote: its code units, and the text after its closing quote. -/
def parseJsonString : List Char → List Nat → Option (List Nat × List Char)
  | [], _ => none
  | '"' :: rest, units => some (units.reverse, rest)
  | '\\' :: 'u' :: a :: b :: c :: d :: rest, units =>
    match hex4? a b c d with
    | some unit => parseJsonString rest (unit :: units)
    | none => none
  | '\\' :: escape :: rest, units =>
    let unit? : Option Nat :=
      if escape == '"' then some 34 else if escape == '\\' then some 92 else if escape == '/' then some 47
      else if escape == 'b' then some 8 else if escape == 'f' then some 12 else if escape == 'n' then some 10
      else if escape == 'r' then some 13 else if escape == 't' then some 9 else none
    match unit? with
    | some unit => parseJsonString rest (unit :: units)
    | none => none
  | c :: rest, units => if c.toNat < 0x20 || c == '\\' then none else parseJsonString rest ((utf16 [c]).reverse ++ units)

/-- A JSON number at the start of a text: `-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?`. -/
def parseJsonNumber (text : List Char) : Option (Float × List Char) :=
  let (negative, unsigned) := match text with
    | '-' :: rest => (true, rest)
    | _ => (false, text)
  let (whole, rest) := unsigned.span isDigit
  if whole.isEmpty || (whole.length > 1 && whole.head? == some '0') then none
  else
    let fraction? : Option (List Char × List Char) := match rest with
      | '.' :: after =>
        let (fraction, rest') := after.span isDigit
        if fraction.isEmpty then none else some (fraction, rest')
      | _ => some ([], rest)
    fraction?.bind fun (fraction, rest) =>
      let finish (exponentNegative : Bool) (exponent rest : List Char) : Option (Float × List Char) :=
        some (Decimal.toFloat negative { whole, fraction, exponentNegative, exponent }, rest)
      let exponentAt (after : List Char) : Option (Float × List Char) :=
        let (exponentNegative, digitsAt) := match after with
          | '+' :: more => (false, more)
          | '-' :: more => (true, more)
          | _ => (false, after)
        let (exponent, rest') := digitsAt.span isDigit
        if exponent.isEmpty then none else finish exponentNegative exponent rest'
      match rest with
      | 'e' :: after => exponentAt after
      | 'E' :: after => exponentAt after
      | _ => finish false [] rest

mutual
  /-- One JSON value at the start of a text, and the text after it. `fuel` bounds the depth and is never short. -/
  def parseJsonValue : Nat → List Char → Option (Value × List Char)
    | 0, _ => none
    | fuel + 1, text =>
      match skipJsonSpace text with
      | 'n' :: 'u' :: 'l' :: 'l' :: rest => some (.null, rest)
      | 't' :: 'r' :: 'u' :: 'e' :: rest => some (.bool true, rest)
      | 'f' :: 'a' :: 'l' :: 's' :: 'e' :: rest => some (.bool false, rest)
      | '"' :: rest => (parseJsonString rest []).map fun (units, rest) => (.str (String.ofList (ofUtf16 units)), rest)
      | '[' :: rest =>
        match skipJsonSpace rest with
        | ']' :: rest => some (.arr 0 [], rest)
        | rest => parseJsonItems fuel rest []
      | '{' :: rest =>
        match skipJsonSpace rest with
        | '}' :: rest => some (.obj 0 [], rest)
        | rest => parseJsonFields fuel rest []
      | other => (parseJsonNumber other).map fun (x, rest) => (.num x, rest)

  /-- The entries of a list from after `[` or a comma. -/
  def parseJsonItems : Nat → List Char → List Value → Option (Value × List Char)
    | 0, _, _ => none
    | fuel + 1, text, items =>
      match parseJsonValue fuel text with
      | none => none
      | some (item, rest) =>
        match skipJsonSpace rest with
        | ',' :: rest => parseJsonItems fuel rest (item :: items)
        | ']' :: rest => some (.arr 0 (item :: items).reverse, rest)
        | _ => none

  /-- The fields of a mapping from after `{` or a comma. -/
  def parseJsonFields : Nat → List Char → List (String × Value) → Option (Value × List Char)
    | 0, _, _ => none
    | fuel + 1, text, fields =>
      match skipJsonSpace text with
      | '"' :: rest =>
        match parseJsonString rest [] with
        | none => none
        | some (units, rest) =>
          match skipJsonSpace rest with
          | ':' :: rest =>
            match parseJsonValue fuel rest with
            | none => none
            | some (item, rest) =>
              let fields := (String.ofList (ofUtf16 units), item) :: fields
              match skipJsonSpace rest with
              | ',' :: rest => parseJsonFields fuel rest fields
              | '}' :: rest => some (.obj 0 (jsObject fields.reverse), rest)
              | _ => none
          | _ => none
      | _ => none
end

/-- `JSON.parse`: the value a text spells, or `none` for text that is not JSON. -/
def parseJson (text : String) : Option Value :=
  let chars := text.toList
  match parseJsonValue (2 * chars.length + 4) chars with
  | some (held, rest) => if (skipJsonSpace rest).isEmpty then some held else none
  | none => none

end InventorySpec

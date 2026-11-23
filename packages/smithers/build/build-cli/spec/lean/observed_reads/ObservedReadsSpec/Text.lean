import ObservedReadsSpec.Sha256

/-!
# Text as JavaScript reads it

`ObservedReads.ts` orders names by UTF-16 code unit (`byCodeUnit`), trims and tests white space as ECMAScript
defines it, and digests `JSON.stringify` of a list of names. A Lean `String` is a sequence of Unicode scalar
values, so every text here is a well-formed one: a lone surrogate is outside the model.
-/
namespace ObservedReadsSpec

/-- The UTF-16 code units of a character: one, or a surrogate pair above the basic plane. -/
def utf16Units (c : Char) : List Nat :=
  let v := c.toNat
  if v < 0x10000 then [v] else [0xD800 + (v - 0x10000) / 0x400, 0xDC00 + (v - 0x10000) % 0x400]

/-- The UTF-16 code units of a text. -/
def unitsOf (s : String) : List Nat := s.toList.flatMap utf16Units

/-- Lexicographic order on code units. -/
def unitsLe : List Nat → List Nat → Bool
  | [], _ => true
  | _ :: _, [] => false
  | a :: as, b :: bs => a < b || (a == b && unitsLe as bs)

/-- `byCodeUnit(a, b) <= 0`: the order `Array.prototype.sort` gives strings by default. -/
def byCodeUnitLe (a b : String) : Bool := unitsLe (unitsOf a) (unitsOf b)

/-- Names in the order of `names.sort(byCodeUnit)`. -/
def sortByCodeUnit (names : List String) : List String := names.mergeSort byCodeUnitLe

/-- Sorting keeps exactly the names it was given. -/
theorem mem_sortByCodeUnit {name : String} {names : List String} :
    name ∈ sortByCodeUnit names ↔ name ∈ names := List.mem_mergeSort

/-- ECMAScript `WhiteSpace` and `LineTerminator`: what `/\s/` matches and `trim` removes. -/
def isJsSpace (c : Char) : Bool :=
  let v := c.toNat
  (9 ≤ v && v ≤ 13) || v == 0x20 || v == 0xA0 || v == 0x1680 || (0x2000 ≤ v && v ≤ 0x200A) || v == 0x2028 ||
    v == 0x2029 || v == 0x202F || v == 0x205F || v == 0x3000 || v == 0xFEFF

/-- ECMAScript `LineTerminator`: what `.` does not match. -/
def isJsLineEnd (c : Char) : Bool := c == '\n' || c == '\r' || c.toNat == 0x2028 || c.toNat == 0x2029

/-- `String.prototype.trim`. -/
def trimJs (text : List Char) : List Char :=
  ((text.dropWhile isJsSpace).reverse.dropWhile isJsSpace).reverse

def isDigit (c : Char) : Bool := '0' ≤ c && c ≤ '9'

/-- `\w`: an ASCII letter, a digit or `_`. -/
def isWord (c : Char) : Bool := isDigit c || ('A' ≤ c && c ≤ 'Z') || ('a' ≤ c && c ≤ 'z') || c == '_'

def isOctal (c : Char) : Bool := '0' ≤ c && c ≤ '7'

def isHex (c : Char) : Bool := isDigit c || ('a' ≤ c && c ≤ 'f') || ('A' ≤ c && c ≤ 'F')

/-- The value of a hexadecimal digit. -/
def hexValue (c : Char) : Nat :=
  if isDigit c then c.toNat - 48 else if 'a' ≤ c && c ≤ 'f' then c.toNat - 87 else c.toNat - 55

/-- A character as `JSON.stringify` writes it inside a string. -/
def jsonEscape (c : Char) : List Char :=
  if c == '"' then ['\\', '"']
  else if c == '\\' then ['\\', '\\']
  else if c.toNat == 8 then ['\\', 'b']
  else if c.toNat == 9 then ['\\', 't']
  else if c.toNat == 10 then ['\\', 'n']
  else if c.toNat == 12 then ['\\', 'f']
  else if c.toNat == 13 then ['\\', 'r']
  else if c.toNat < 0x20 then
    ['\\', 'u', '0', '0', Sha256.hexDigit (c.toNat / 16), Sha256.hexDigit (c.toNat % 16)]
  else [c]

/-- `JSON.stringify` of a string. -/
def jsonString (s : String) : String := String.ofList ('"' :: s.toList.flatMap jsonEscape ++ ['"'])

/-- `JSON.stringify` of an array whose elements are already written. -/
def jsonArray (parts : List String) : String := "[" ++ ",".intercalate parts ++ "]"

/-- `JSON.stringify` of an array of strings. -/
def jsonStrings (names : List String) : String := jsonArray (names.map jsonString)

end ObservedReadsSpec

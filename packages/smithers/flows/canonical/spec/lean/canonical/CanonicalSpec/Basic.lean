/-!
# Texts and JSON values

A text is a list of UTF-16 code units, the way JavaScript holds a string, so a lone surrogate is a value like any
other and key order is code-unit order. A JSON value is a tree; an object is its members in own-key order.

A number is a whole number or one of the four doubles the serializer treats specially. Every other double is outside
this specification: its text is the shortest round-trip decimal, which the differential test leaves to the engine.
-/

namespace CanonicalSpec

/-- A string as its UTF-16 code units. -/
abbrev Text := List Nat

/-- The code units of an ASCII literal. -/
def ascii (text : String) : Text := text.toList.map Char.toNat

/-- A JSON number the specification covers. -/
inductive Number where
  | int (value : Int)
  | negZero
  | nan
  | posInf
  | negInf

mutual
  /-- A JSON value. -/
  inductive Value where
    | null
    | bool (value : Bool)
    | num (value : Number)
    | str (value : Text)
    | arr (items : Items)
    | obj (members : Members)

  /-- The items of an array, in index order. -/
  inductive Items where
    | nil
    | cons (head : Value) (tail : Items)

  /-- The members of an object, in own-key order. -/
  inductive Members where
    | nil
    | cons (key : Text) (value : Value) (tail : Members)
end

def Items.length : Items → Nat
  | .nil => 0
  | .cons _ tail => tail.length + 1

def Members.length : Members → Nat
  | .nil => 0
  | .cons _ _ tail => tail.length + 1

def Members.keys : Members → List Text
  | .nil => []
  | .cons key _ tail => key :: tail.keys

-- Surrogates ----------------------------------------------------------------------------------------------------------

def isHigh (unit : Nat) : Bool := 0xd800 ≤ unit && unit ≤ 0xdbff

def isLow (unit : Nat) : Bool := 0xdc00 ≤ unit && unit ≤ 0xdfff

/-- Well-formed UTF-16 after a pending high surrogate (`true`) or none (`false`). -/
def wellFormedFrom : Bool → Text → Bool
  | pending, [] => !pending
  | true, unit :: rest => isLow unit && wellFormedFrom false rest
  | false, unit :: rest => if isHigh unit then wellFormedFrom true rest else !isLow unit && wellFormedFrom false rest

/-- `String.prototype.isWellFormed`: every surrogate is half of a pair. -/
def wellFormed (text : Text) : Bool := wellFormedFrom false text

-- Order ---------------------------------------------------------------------------------------------------------------

/-- Code-unit order, the order of `Array.prototype.sort` with no comparator. -/
def lt : Text → Text → Bool
  | [], [] => false
  | [], _ :: _ => true
  | _ :: _, [] => false
  | a :: as, b :: bs => if a < b then true else if b < a then false else lt as bs

/-- `le a b` is "not `lt b a`". -/
def le (a b : Text) : Bool := !lt b a

-- JSON text -----------------------------------------------------------------------------------------------------------

def hexDigit (value : Nat) : Nat := if value < 10 then 48 + value else 87 + value

/-- `\uXXXX`, lower case, as `JSON.stringify` writes it. -/
def unicodeEscape (unit : Nat) : Text :=
  [92, 117, hexDigit (unit / 4096 % 16), hexDigit (unit / 256 % 16), hexDigit (unit / 16 % 16), hexDigit (unit % 16)]

/-- One code unit that is not a surrogate, escaped as `JSON.stringify` escapes it. -/
def escapeUnit (unit : Nat) : Text :=
  if unit = 0x22 then [92, 0x22]
  else if unit = 0x5c then [92, 92]
  else if unit = 0x08 then [92, 98]
  else if unit = 0x09 then [92, 116]
  else if unit = 0x0a then [92, 110]
  else if unit = 0x0c then [92, 102]
  else if unit = 0x0d then [92, 114]
  else if unit < 0x20 then unicodeEscape unit
  else [unit]

/-- One code unit with no pending high surrogate before it; a lone low surrogate is escaped. -/
def quoteUnit (unit : Nat) : Text := if isLow unit then unicodeEscape unit else escapeUnit unit

/-- The body of a JSON string literal after an optional pending high surrogate. -/
def quoteFrom : Option Nat → Text → Text
  | none, [] => []
  | some high, [] => unicodeEscape high
  | none, unit :: rest => if isHigh unit then quoteFrom (some unit) rest else quoteUnit unit ++ quoteFrom none rest
  | some high, unit :: rest =>
    if isLow unit then high :: unit :: quoteFrom none rest
    else if isHigh unit then unicodeEscape high ++ quoteFrom (some unit) rest
    else unicodeEscape high ++ quoteUnit unit ++ quoteFrom none rest

/-- `JSON.stringify(text)`: a pair stays, a lone surrogate becomes its escape. -/
def quote (text : Text) : Text := 0x22 :: quoteFrom none text ++ [0x22]

/-- `String(value)` for a whole number. -/
def decimal (value : Int) : Text := ascii (toString value)

/-- `String(index)`. -/
def decimalNat (value : Nat) : Text := ascii (toString value)

/-- The text a covered number serializes as, or none when it is not finite. -/
def numberText : Number → Option Text
  | .int value => some (decimal value)
  | .negZero => some [48]
  | _ => none

-- Encoded size --------------------------------------------------------------------------------------------------------

/-- UTF-8 bytes one non-surrogate code unit costs inside a JSON string literal. -/
def unitBytes (unit : Nat) : Nat :=
  if unit = 0x22 || unit = 0x5c || unit = 0x08 || unit = 0x09 || unit = 0x0a || unit = 0x0c || unit = 0x0d then 2
  else if unit ≤ 0x1f then 6
  else if unit ≤ 0x7f then 1
  else if unit ≤ 0x7ff then 2
  else 3

/-- Encoded bytes of a string body, or none for a lone surrogate. `pending` is an open high surrogate. -/
def bodyBytesFrom : Bool → Text → Option Nat
  | pending, [] => if pending then none else some 0
  | true, unit :: rest => if isLow unit then (bodyBytesFrom false rest).map (· + 4) else none
  | false, unit :: rest =>
    if isHigh unit then bodyBytesFrom true rest
    else if isLow unit then none
    else (bodyBytesFrom false rest).map (· + unitBytes unit)

/-- True when `count` is inside an optional inclusive bound. -/
def within (count : Nat) : Option Nat → Bool
  | none => true
  | some maximum => count ≤ maximum

/-- `BoundedJson.encodedStringBytes`: quotes and escapes included; none when ill-formed or over `maximum`. -/
def encodedStringBytes (text : Text) (maximum : Option Nat) : Option Nat :=
  match bodyBytesFrom false text with
  | none => none
  | some body => if within (body + 2) maximum then some (body + 2) else none

-- Paths ---------------------------------------------------------------------------------------------------------------

/-- One step of a path. `position` is a key named by its index, as strict admission's `boundedText` reports it. -/
inductive Segment where
  | key (text : Text)
  | index (value : Nat)
  | position (value : Nat)

def isIdentifierStart (unit : Nat) : Bool :=
  (65 ≤ unit && unit ≤ 90) || (97 ≤ unit && unit ≤ 122) || unit = 95 || unit = 36

def isIdentifierPart (unit : Nat) : Bool := isIdentifierStart unit || (48 ≤ unit && unit ≤ 57)

/-- `/^[A-Za-z_$][A-Za-z0-9_$]*$/`. -/
def isIdentifier : Text → Bool
  | [] => false
  | first :: rest => isIdentifierStart first && rest.all isIdentifierPart

/-- One step as path text: `[index]`, `[key:position]`, `.key` for an identifier, `["key"]` otherwise. -/
def segmentText : Segment → Text
  | .index value => 91 :: decimalNat value ++ [93]
  | .position value => ascii "[key:" ++ decimalNat value ++ [93]
  | .key text => if isIdentifier text then 46 :: text else 91 :: quote text ++ [93]

/-- A path from the root as text: `$`, then each step. -/
def pathText (segments : List Segment) : Text := 36 :: (segments.map segmentText).flatten

end CanonicalSpec

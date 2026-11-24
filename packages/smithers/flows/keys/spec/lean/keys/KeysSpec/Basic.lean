/-!
# Texts, key material and the JSON that is hashed

A text is a list of UTF-16 code units, the way JavaScript holds a string, so a lone surrogate is a value like any
other and key order is code-unit order.

`Value` is what a caller can hand `deriveKey`: JSON, and the JavaScript values JSON has no form for. `Json` is what is
left once the derivation has accepted a value: the tree whose text is hashed. `write` is that text, the preimage of
the key.

A number is a whole number or one of the four doubles the derivation treats specially. Every other double is outside
this specification: its text is the shortest round-trip decimal, which the differential test leaves to the engine.
-/

namespace KeysSpec

/-- A string as its UTF-16 code units. -/
abbrev Text := List Nat

/-- The code units of an ASCII literal. -/
def ascii (text : String) : Text := text.toList.map Char.toNat

/-- A number the specification covers. -/
inductive Number where
  | int (value : Int)
  | negZero
  | nan
  | posInf
  | negInf

/-- A JavaScript value JSON has no form for. -/
inductive Opaque where
  | undefined
  | symbol
  /-- A function with no `toJSON`. -/
  | function
  /-- An Effect `Redacted`. -/
  | redacted
  | bigint
  /-- A `Date` whose time is `NaN`. -/
  | invalidDate
  /-- A `Map`, `Set`, typed array or class instance: an object that is not a plain record. -/
  | unsupported
  /-- A `Map`, `Set` or typed array whose prototype was replaced so it passes for a plain record (#4530). -/
  | maskedCollection

mutual
  /-- Key material as the caller holds it. -/
  inductive Value where
    | null
    | bool (value : Bool)
    | num (value : Number)
    | str (value : Text)
    | opaque (kind : Opaque)
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

mutual
  /-- Accepted key material: the tree whose text is hashed. -/
  inductive Json where
    | null
    | bool (value : Bool)
    | int (value : Int)
    | str (value : Text)
    | arr (items : JItems)
    | obj (members : JMembers)

  inductive JItems where
    | nil
    | cons (head : Json) (tail : JItems)

  inductive JMembers where
    | nil
    | cons (key : Text) (value : Json) (tail : JMembers)
end

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

/-- One code unit of a well-formed text, escaped as `JSON.stringify` escapes it. -/
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

/-- The inside of a JSON string literal. A well-formed text has no lone surrogate, so every unit stands alone. -/
def body : Text → Text
  | [] => []
  | unit :: rest => escapeUnit unit ++ body rest

/-- `JSON.stringify(text)` for a well-formed text. -/
def quote (text : Text) : Text := 0x22 :: (body text ++ [0x22])

/-- `String(value)` for a natural number: its decimal digits, most significant first. -/
def digits (value : Nat) : Text :=
  if _h : value < 10 then [48 + value] else digits (value / 10) ++ [48 + value % 10]
decreasing_by omega

/-- `String(value)` for a whole number. -/
def decimal (value : Int) : Text := if value < 0 then 45 :: digits value.natAbs else digits value.toNat

/-- A comma before every member or item but the first. -/
def separator (first : Bool) : Text := if first then [] else [44]

mutual
  /-- The canonical JSON text of accepted key material: the bytes that are hashed, as code units. -/
  def write : Json → Text
    | .null => [110, 117, 108, 108]
    | .bool true => [116, 114, 117, 101]
    | .bool false => [102, 97, 108, 115, 101]
    | .int value => decimal value
    | .str value => quote value
    | .arr items => 91 :: writeItems true items
    | .obj members => 123 :: writeMembers true members

  /-- The items and the closing bracket. -/
  def writeItems (first : Bool) : JItems → Text
    | .nil => [93]
    | .cons head tail => separator first ++ (write head ++ writeItems false tail)

  /-- The members as `"key":value` and the closing brace. -/
  def writeMembers (first : Bool) : JMembers → Text
    | .nil => [125]
    | .cons key value tail => separator first ++ (quote key ++ 58 :: (write value ++ writeMembers false tail))
end

end KeysSpec

/-!
# Parsed JSON and its limits

A text is a list of UTF-16 code units, the way JavaScript holds a string. A JSON value is what `JSON.parse` returns:
a tree whose objects hold one member per key, in own-key order.

A number is a whole number, some other finite double, or a double outside the finite range, which `JSON.parse`
returns for a literal such as `1e999`. Nothing in the protocol reads more of a number than that.

`checkParsed` is `JsonLimits.checkParsed`: it refuses a number outside the finite range and nesting past the limit,
visiting a container's last child first, so the issue it reports is the first one in that order.
`isPositiveInteger` and `firstInvalid` are `Limits`' option check.
-/

namespace McpProtocolSpec

/-- A string as its UTF-16 code units. -/
abbrev Text := List Nat

/-- The code units of an ASCII literal. -/
def ascii (text : String) : Text := text.toList.map Char.toNat

/-- A JSON number, as far as the protocol reads it. -/
inductive Num where
  /-- A double with a whole value, of any size. -/
  | int (value : Int)
  /-- A finite double that is not whole. -/
  | fraction
  /-- An infinity or `NaN`. -/
  | nonFinite

mutual
  /-- A parsed JSON value. -/
  inductive Json where
    | null
    | bool (value : Bool)
    | num (value : Num)
    | str (value : Text)
    | arr (items : Items)
    | obj (members : Members)

  /-- The items of an array, in index order. -/
  inductive Items where
    | nil
    | cons (head : Json) (tail : Items)

  /-- The members of an object, in own-key order. -/
  inductive Members where
    | nil
    | cons (key : Text) (value : Json) (tail : Members)
end

-- Nesting and number limits -------------------------------------------------------------------------------------------

/-- `JsonLimits.maxDepth`: the most containers on one path, the wire envelope counted as the first. -/
def maxDepth : Nat := 128

/-- What `checkParsed` refuses. -/
inductive Issue where
  | number
  | depth
  deriving DecidableEq

/-- The text `checkParsed` returns for an issue under a limit. -/
def Issue.message (limit : Nat) : Issue → String
  | .number => "a JSON number is outside the finite range"
  | .depth => s!"JSON nesting exceeds {limit} containers"

mutual
  /-- The first issue at or below a value that is the `depth`-th container or leaf on its path. -/
  def check (limit : Nat) : Json → Nat → Option Issue
    | .num .nonFinite, _ => some .number
    | .arr items, depth => if depth > limit then some .depth else checkItems limit items (depth + 1)
    | .obj members, depth => if depth > limit then some .depth else checkMembers limit members (depth + 1)
    | _, _ => none

  /-- The items, last to first: the implementation pops the child it pushed last. -/
  def checkItems (limit : Nat) : Items → Nat → Option Issue
    | .nil, _ => none
    | .cons head tail, depth =>
      match checkItems limit tail depth with
      | some issue => some issue
      | none => check limit head depth

  /-- The members' values, last to first. -/
  def checkMembers (limit : Nat) : Members → Nat → Option Issue
    | .nil, _ => none
    | .cons _ value tail, depth =>
      match checkMembers limit tail depth with
      | some issue => some issue
      | none => check limit value depth
end

/-- `JsonLimits.checkParsed(value)` under a limit: the issue, or none. -/
def checkParsedWith (limit : Nat) (value : Json) : Option Issue := check limit value 1

/-- `JsonLimits.checkParsed(value)`. -/
def checkParsed (value : Json) : Option Issue := checkParsedWith maxDepth value

mutual
  /-- The most containers on one path of a value. -/
  def nesting : Json → Nat
    | .arr items => 1 + nestingItems items
    | .obj members => 1 + nestingMembers members
    | _ => 0

  def nestingItems : Items → Nat
    | .nil => 0
    | .cons head tail => max (nesting head) (nestingItems tail)

  def nestingMembers : Members → Nat
    | .nil => 0
    | .cons _ value tail => max (nesting value) (nestingMembers tail)
end

mutual
  /-- True when every number in a value is finite. -/
  def finite : Json → Bool
    | .num .nonFinite => false
    | .arr items => finiteItems items
    | .obj members => finiteMembers members
    | _ => true

  def finiteItems : Items → Bool
    | .nil => true
    | .cons head tail => finite head && finiteItems tail

  def finiteMembers : Members → Bool
    | .nil => true
    | .cons _ value tail => finite value && finiteMembers tail
end

-- Option limits -------------------------------------------------------------------------------------------------------

/-- `Number.MAX_SAFE_INTEGER`. -/
def maxSafe : Nat := 9007199254740991

/-- `Number.isSafeInteger` for a whole number. -/
def isSafe (value : Int) : Bool := -(maxSafe : Int) ≤ value && value ≤ (maxSafe : Int)

/-- `Limits.isPositiveInteger`: a positive safe integer. -/
def isPositiveInteger : Num → Bool
  | .int value => 0 < value && value ≤ (maxSafe : Int)
  | _ => false

/-- The name of the first option that is not a positive integer: the one `checkPositiveIntegers` reports. -/
def firstInvalid : List (Text × Num) → Option Text
  | [] => none
  | (name, value) :: rest => if isPositiveInteger value then firstInvalid rest else some name

end McpProtocolSpec

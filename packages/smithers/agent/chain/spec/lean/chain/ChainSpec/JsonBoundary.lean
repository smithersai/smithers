/-!
# The JSON boundary

The reference specification of `src/internal/unicode.ts` (`isWellFormed`) and `src/JsonBoundary.ts` (`jsonBoundary`,
`decodeOutcome`).

A text is its UTF-16 code units, so a lone surrogate is a value like any other. A number is the 64 bits of its
IEEE-754 double, so `-0`, the infinities and every NaN are exact values and no float arithmetic is trusted.

A JavaScript value is a tree. What the tree cannot hold is named instead: `exotic` is a value JSON has no word for
(a function, a symbol, a bigint), `cycle` is a reference to a container the walk is already inside, and an object
carries whether its prototype is `Object.prototype` or `null`. An object's fields are in `Object.keys` order; a
repeated key cannot come from a real object and is what a proxy with a lying `ownKeys` trap offers.
-/

namespace ChainSpec

/-- A text: its UTF-16 code units. -/
abbrev Text := List Nat

/-- The code units of a text written in ASCII. -/
def ascii (text : String) : Text := text.toList.map Char.toNat

-- --- well-formed text ----------------------------------------------------------------------------------------------

def isHigh (unit : Nat) : Bool := 0xD800 ≤ unit && unit ≤ 0xDBFF

def isLow (unit : Nat) : Bool := 0xDC00 ≤ unit && unit ≤ 0xDFFF

/-- Whether a text holds no unpaired surrogate: one pass, a high surrogate consumes the low one after it. -/
def isWellFormed : Text → Bool
  | [] => true
  | unit :: rest =>
    if isHigh unit then
      match rest with
      | next :: tail => if isLow next then isWellFormed tail else false
      | [] => false
    else if isLow unit then false
    else isWellFormed rest

/-- Unicode text, said without an algorithm: scalars outside the surrogate range and high-low pairs. -/
inductive WellFormed : Text → Prop
  | nil : WellFormed []
  | scalar (unit : Nat) (rest : Text) : isHigh unit = false → isLow unit = false → WellFormed rest →
      WellFormed (unit :: rest)
  | pair (high low : Nat) (rest : Text) : isHigh high = true → isLow low = true → WellFormed rest →
      WellFormed (high :: low :: rest)

-- --- values --------------------------------------------------------------------------------------------------------

mutual
  /-- A JavaScript value as the boundary sees it. -/
  inductive Js where
    | undefined
    | null
    | bool (value : Bool)
    /-- A number: the 64 bits of its double. -/
    | num (bits : Nat)
    | str (text : Text)
    /-- An array. A hole reads as `undefined`. -/
    | arr (items : Items)
    /-- An object: whether its prototype is `Object.prototype` or `null`, and its own enumerable string keys. -/
    | obj (plain : Bool) (fields : Fields)
    /-- A function, a symbol or a bigint. -/
    | exotic
    /-- A reference to a container the walk is already inside. -/
    | cycle

  inductive Items where
    | nil
    | cons (head : Js) (tail : Items)

  inductive Fields where
    | nil
    | cons (key : Text) (value : Js) (tail : Fields)
end

def Items.ofList : List Js → Items
  | [] => .nil
  | head :: tail => .cons head (Items.ofList tail)

def Fields.ofList : List (Text × Js) → Fields
  | [] => .nil
  | (key, value) :: tail => .cons key value (Fields.ofList tail)

def keysOf : Fields → List Text
  | .nil => []
  | .cons key _ tail => key :: keysOf tail

def hasDuplicate : List Text → Bool
  | [] => false
  | key :: rest => rest.contains key || hasDuplicate rest

/-- The first field under a key. -/
def Fields.find (wanted : Text) : Fields → Option Js
  | .nil => none
  | .cons key value tail => if key = wanted then some value else tail.find wanted

-- --- numbers -------------------------------------------------------------------------------------------------------

/-- The bits of `-0`. -/
def negativeZero : Nat := 2 ^ 63

/-- A double is finite unless its eleven exponent bits are all set. -/
def isFiniteBits (bits : Nat) : Bool := (bits / 2 ^ 52) % 2048 != 2047

/-- `-0` crosses as `0`; every other number crosses as itself. -/
def normalizeZero (bits : Nat) : Nat := if bits = negativeZero then 0 else bits

-- --- the walk ------------------------------------------------------------------------------------------------------

/-- The deepest nesting a value may carry across the boundary. -/
def maxJsonDepth : Nat := 128

/-- The size budget: one unit per node plus one per code unit of every string and key. -/
def maxJsonSize : Nat := 8 * 1024 * 1024

/-- Spends units of the budget; a budget that would go negative refuses. -/
def spend (budget units : Nat) : Option Nat := if units ≤ budget then some (budget - units) else none

/-- Entering a node: its depth is within the cap and one unit is spent. -/
def enter (depth budget : Nat) : Option Nat := if depth ≤ maxJsonDepth then spend budget 1 else none

mutual
  /-- The single pass of `jsonBoundary`: validates and copies at once, threading what is left of the budget. -/
  def walk (depth : Nat) : Js → Nat → Option (Js × Nat)
    | .undefined, _ => none
    | .exotic, _ => none
    | .cycle, _ => none
    | .null, budget => (enter depth budget).bind fun rest => some (.null, rest)
    | .bool value, budget => (enter depth budget).bind fun rest => some (.bool value, rest)
    | .num bits, budget =>
      (enter depth budget).bind fun rest => if isFiniteBits bits then some (.num (normalizeZero bits), rest) else none
    | .str text, budget =>
      (enter depth budget).bind fun rest =>
        (spend rest text.length).bind fun rest => if isWellFormed text then some (.str text, rest) else none
    | .arr items, budget =>
      (enter depth budget).bind fun rest =>
        (walkItems (depth + 1) items rest).bind fun copied => some (.arr copied.1, copied.2)
    | .obj plain fields, budget =>
      (enter depth budget).bind fun rest =>
        if plain && !hasDuplicate (keysOf fields) then
          (walkFields (depth + 1) fields rest).bind fun copied => some (.obj plain copied.1, copied.2)
        else none

  def walkItems (depth : Nat) : Items → Nat → Option (Items × Nat)
    | .nil, budget => some (.nil, budget)
    | .cons head tail, budget =>
      (walk depth head budget).bind fun first =>
        (walkItems depth tail first.2).bind fun others => some (.cons first.1 others.1, others.2)

  def walkFields (depth : Nat) : Fields → Nat → Option (Fields × Nat)
    | .nil, budget => some (.nil, budget)
    | .cons key value tail, budget =>
      (spend budget key.length).bind fun rest =>
        if isWellFormed key then
          (walk depth value rest).bind fun first =>
            (walkFields depth tail first.2).bind fun others => some (.cons key first.1 others.1, others.2)
        else none
end

/-- `undefined` is refused everywhere except as the whole value, where it becomes `null`. -/
def whole : Js → Js
  | .undefined => .null
  | value => value

/-- The boundary under a given budget: the copy, or nothing when the value is refused. -/
def boundaryWith (budget : Nat) (value : Js) : Option Js := (walk 0 (whole value) budget).map Prod.fst

/-- `jsonBoundary`: `some copy` is `Ok`, `none` is `Refused`. -/
def jsonBoundary (value : Js) : Option Js := boundaryWith maxJsonSize value

-- --- the same boundary, said without a budget in hand --------------------------------------------------------------

mutual
  /-- What the walk admits when the budget is no object: shape, depth, text and number checks. -/
  def valid (depth : Nat) : Js → Bool
    | .undefined => false
    | .exotic => false
    | .cycle => false
    | .null => depth ≤ maxJsonDepth
    | .bool _ => depth ≤ maxJsonDepth
    | .num bits => depth ≤ maxJsonDepth && isFiniteBits bits
    | .str text => depth ≤ maxJsonDepth && isWellFormed text
    | .arr items => depth ≤ maxJsonDepth && validItems (depth + 1) items
    | .obj plain fields =>
      depth ≤ maxJsonDepth && (plain && !hasDuplicate (keysOf fields)) && validFields (depth + 1) fields

  def validItems (depth : Nat) : Items → Bool
    | .nil => true
    | .cons head tail => valid depth head && validItems depth tail

  def validFields (depth : Nat) : Fields → Bool
    | .nil => true
    | .cons key value tail => isWellFormed key && valid depth value && validFields depth tail
end

mutual
  /-- What a value costs: one per node plus the code units of every string and key. -/
  def cost : Js → Nat
    | .str text => 1 + text.length
    | .arr items => 1 + costItems items
    | .obj _ fields => 1 + costFields fields
    | _ => 1

  def costItems : Items → Nat
    | .nil => 0
    | .cons head tail => cost head + costItems tail

  def costFields : Fields → Nat
    | .nil => 0
    | .cons key value tail => key.length + cost value + costFields tail
end

mutual
  /-- The copy of an admitted value: itself, with every `-0` read as `0`. -/
  def norm : Js → Js
    | .num bits => .num (normalizeZero bits)
    | .arr items => .arr (normItems items)
    | .obj plain fields => .obj plain (normFields fields)
    | value => value

  def normItems : Items → Items
    | .nil => .nil
    | .cons head tail => .cons (norm head) (normItems tail)

  def normFields : Fields → Fields
    | .nil => .nil
    | .cons key value tail => .cons key (norm value) (normFields tail)
end

mutual
  /-- Whether a value holds a `-0` anywhere. -/
  def holdsNegativeZero : Js → Bool
    | .num bits => bits == negativeZero
    | .arr items => itemsHoldNegativeZero items
    | .obj _ fields => fieldsHoldNegativeZero fields
    | _ => false

  def itemsHoldNegativeZero : Items → Bool
    | .nil => false
    | .cons head tail => holdsNegativeZero head || itemsHoldNegativeZero tail

  def fieldsHoldNegativeZero : Fields → Bool
    | .nil => false
    | .cons _ value tail => holdsNegativeZero value || fieldsHoldNegativeZero tail
end

/-- A value under `count` arrays. -/
def nest : Nat → Js → Js
  | 0, value => value
  | count + 1, value => .arr (.cons (nest count value) .nil)

-- --- outcomes ------------------------------------------------------------------------------------------------------

/-- What a link can end with. A successor is its text: the digest is derived from the text, never read. -/
inductive Outcome where
  | done (value : Js)
  | to (text : Text)
  | park (code : Text) (message : Text)

def parkCodes : List Text := ["approval", "event", "timer", "quota", "plugin"].map ascii

mutual
  /-- A JSON value: what `Schema.Json` admits. -/
  def isJson : Js → Bool
    | .null => true
    | .bool _ => true
    | .num bits => isFiniteBits bits
    | .str _ => true
    | .arr items => itemsAreJson items
    | .obj plain fields => plain && fieldsAreJson fields
    | _ => false

  def itemsAreJson : Items → Bool
    | .nil => true
    | .cons head tail => isJson head && itemsAreJson tail

  def fieldsAreJson : Fields → Bool
    | .nil => true
    | .cons _ value tail => isJson value && fieldsAreJson tail
end

/--
`decodeOutcome` over a value that crossed the boundary. Extra fields are dropped. A successor is a text or an
object holding one under `text`; whatever digest came with it is not read.
-/
def decodeOutcome : Js → Option Outcome
  | .obj true fields =>
    match fields.find (ascii "_tag") with
    | some (.str tag) =>
      if tag = ascii "Done" then
        match fields.find (ascii "value") with
        | some value => if isJson value then some (.done value) else none
        | none => none
      else if tag = ascii "To" then
        match fields.find (ascii "script") with
        | some (.str text) => if isWellFormed text then some (.to text) else none
        | some (.obj true script) =>
          match script.find (ascii "text") with
          | some (.str text) => if isWellFormed text then some (.to text) else none
          | _ => none
        | _ => none
      else if tag = ascii "Park" then
        match fields.find (ascii "reason") with
        | some (.obj true reason) =>
          match reason.find (ascii "code"), reason.find (ascii "message") with
          | some (.str code), some (.str message) =>
            if parkCodes.contains code then some (.park code message) else none
          | _, _ => none
        | _ => none
      else none
    | _ => none
  | _ => none

end ChainSpec

import KeysSpec.Basic

/-!
# Key derivation

`deriveKey(input)` is `key1_` and the SHA-256 of the UTF-8 of a text. `preimage` is that text, or the refusal.

`normalize` sorts the members of every object by key in code-unit order. `accept` then walks the sorted tree in the
order the implementation reads it, and the first refusal wins: a value is checked as it is read (`check`, the
refusals `deriveKey` names), then against the depth limit, then by its kind. An object's keys are checked before any
of its members. A member whose value is `undefined`, a symbol or a function is left out, as `JSON.stringify` leaves
it out; the same value at the root or in an array is refused, because JSON would write `null` for it there.
-/

namespace KeysSpec

/-- Where a value stands: the input itself, the value of an object member, or an array item. -/
inductive Position where
  | root
  | member
  | element
  deriving DecidableEq

/-- Why a value has no key. -/
inductive Reason where
  | nan
  | posInf
  | negInf
  | undefined
  | symbol
  | function
  | redacted
  | invalidDate
  | collection
  /-- The serializer refused: a lone surrogate, a BigInt, a non-plain object, or nesting past the limit. -/
  | canonical
  deriving DecidableEq

/-- `KeyDerivationError.message` for a `canonicalization_failed` refusal. It never contains the input. -/
def Reason.message : Reason → String
  | .nan => "NaN cannot be keyed"
  | .posInf => "Infinity cannot be keyed"
  | .negInf => "-Infinity cannot be keyed"
  | .undefined => "undefined cannot be keyed"
  | .symbol => "symbol cannot be keyed"
  | .function => "function cannot be keyed"
  | .redacted => "redacted value cannot be keyed"
  | .invalidDate => "invalid date"
  | .collection => "unsupported collection cannot be keyed"
  | .canonical => "Key input could not be canonicalized"

/-- `MAX_CANONICAL_DEPTH`: the deepest nesting below the root. -/
def maxDepth : Nat := 10000

-- Sorting -------------------------------------------------------------------------------------------------------------

/-- Inserts a member before the first member whose key is not below its own. -/
def insertMember (key : Text) (value : Value) : Members → Members
  | .nil => .cons key value .nil
  | .cons key' value' rest =>
    if lt key' key then .cons key' value' (insertMember key value rest) else .cons key value (.cons key' value' rest)

/-- Members in key order. -/
def sortMembers : Members → Members
  | .nil => .nil
  | .cons key value rest => insertMember key value (sortMembers rest)

mutual
  /-- The value with every object's members in key order. -/
  def normalize : Value → Value
    | .null => .null
    | .bool value => .bool value
    | .num value => .num value
    | .str value => .str value
    | .opaque kind => .opaque kind
    | .arr items => .arr (normalizeItems items)
    | .obj members => .obj (sortMembers (normalizeMembers members))

  def normalizeItems : Items → Items
    | .nil => .nil
    | .cons head tail => .cons (normalize head) (normalizeItems tail)

  /-- Normalizes each member's value and keeps the order. -/
  def normalizeMembers : Members → Members
    | .nil => .nil
    | .cons key value tail => .cons key (normalize value) (normalizeMembers tail)
end

-- Admission -----------------------------------------------------------------------------------------------------------

/-- The refusals `deriveKey` makes as it reads a value, before the serializer sees it. -/
def check : Value → Position → Except Reason Unit
  | .opaque .redacted, _ => .error .redacted
  | .num .nan, _ => .error .nan
  | .num .posInf, _ => .error .posInf
  | .num .negInf, _ => .error .negInf
  | .opaque .undefined, position => if position = .member then .ok () else .error .undefined
  | .opaque .symbol, position => if position = .member then .ok () else .error .symbol
  | .opaque .function, position => if position = .member then .ok () else .error .function
  | .opaque .invalidDate, _ => .error .invalidDate
  | _, _ => .ok ()

/-- True when some key is not well-formed UTF-16. -/
def illFormedKey : Members → Bool
  | .nil => false
  | .cons key _ rest => !wellFormed key || illFormedKey rest

/-- What a value at `depth` passes before its kind matters: `check`, then the depth limit. -/
def guard (limit : Nat) (value : Value) (position : Position) (depth : Nat)
    (next : Except Reason (Option Json)) : Except Reason (Option Json) :=
  match check value position with
  | .error reason => .error reason
  | .ok () => if depth > limit then .error .canonical else next

mutual
  /-- Accepts a value whose objects are already in key order: its JSON, nothing when it is left out, or the refusal. -/
  def accept (limit : Nat) : Value → Position → Nat → Except Reason (Option Json)
    | .null, position, depth => guard limit .null position depth (.ok (some .null))
    | .bool value, position, depth => guard limit (.bool value) position depth (.ok (some (.bool value)))
    | .num (.int value), position, depth =>
      guard limit (.num (.int value)) position depth (.ok (some (.int value)))
    | .num .negZero, position, depth => guard limit (.num .negZero) position depth (.ok (some (.int 0)))
    | .num other, position, depth => guard limit (.num other) position depth (.error .canonical)
    | .str value, position, depth =>
      guard limit (.str value) position depth (if wellFormed value then .ok (some (.str value)) else .error .canonical)
    | .opaque .undefined, position, depth => guard limit (.opaque .undefined) position depth (.ok none)
    | .opaque .symbol, position, depth => guard limit (.opaque .symbol) position depth (.ok none)
    | .opaque .function, position, depth => guard limit (.opaque .function) position depth (.ok none)
    | .opaque .maskedCollection, position, depth =>
      guard limit (.opaque .maskedCollection) position depth (.error .collection)
    | .opaque other, position, depth => guard limit (.opaque other) position depth (.error .canonical)
    | .arr items, position, depth =>
      guard limit (.arr items) position depth
        (match acceptItems limit items (depth + 1) with
        | .error reason => .error reason
        | .ok accepted => .ok (some (.arr accepted)))
    | .obj members, position, depth =>
      guard limit (.obj members) position depth
        (if illFormedKey members then .error .canonical
        else
          match acceptMembers limit members (depth + 1) with
          | .error reason => .error reason
          | .ok accepted => .ok (some (.obj accepted)))

  /-- The items, first to last. An item that is left out would be written `null`; `check` refuses every such item. -/
  def acceptItems (limit : Nat) : Items → Nat → Except Reason JItems
    | .nil, _ => .ok .nil
    | .cons head tail, depth =>
      match accept limit head .element depth with
      | .error reason => .error reason
      | .ok first =>
        match acceptItems limit tail depth with
        | .error reason => .error reason
        | .ok rest => .ok (.cons (first.getD .null) rest)

  /-- The members, first to last, without the ones that are left out. -/
  def acceptMembers (limit : Nat) : Members → Nat → Except Reason JMembers
    | .nil, _ => .ok .nil
    | .cons key value tail, depth =>
      match accept limit value .member depth with
      | .error reason => .error reason
      | .ok first =>
        match acceptMembers limit tail depth with
        | .error reason => .error reason
        | .ok rest =>
          match first with
          | none => .ok rest
          | some accepted => .ok (.cons key accepted rest)
end

/-- The accepted key material of `value` under a depth limit: sorted, checked, and without what JSON leaves out. -/
def materialWith (limit : Nat) (value : Value) : Except Reason Json :=
  match accept limit (normalize value) .root 0 with
  | .error reason => .error reason
  | .ok none => .error .canonical
  | .ok (some accepted) => .ok accepted

/-- The text `deriveKey` hashes under a depth limit, or why there is no key. -/
def preimageWith (limit : Nat) (value : Value) : Except Reason Text := (materialWith limit value).map write

/-- The text `deriveKey(value)` hashes, or why there is no key. -/
def preimage (value : Value) : Except Reason Text := preimageWith maxDepth value

-- The stored key ------------------------------------------------------------------------------------------------------

/-- `key1_`. -/
def keyPrefix : Text := [107, 101, 121, 49, 95]

/-- `[0-9a-f]`. -/
def isLowerHex (unit : Nat) : Bool := (48 ≤ unit && unit ≤ 57) || (97 ≤ unit && unit ≤ 102)

/-- A SHA-256 digest as text: exactly 64 lower-case hexadecimal digits. -/
def isDigest (text : Text) : Bool := text.length == 64 && text.all isLowerHex

/-- `/^key1_[0-9a-f]{64}$/`: what `KeyV1` and `StoredKey` accept. -/
def isKey (text : Text) : Bool := text.take 5 == keyPrefix && isDigest (text.drop 5)

/-- The key of a digest. -/
def keyOf (digest : Text) : Text := keyPrefix ++ digest

/-- `digest(key)`: the key without its prefix. -/
def digestOf (key : Text) : Text := key.drop 5

end KeysSpec

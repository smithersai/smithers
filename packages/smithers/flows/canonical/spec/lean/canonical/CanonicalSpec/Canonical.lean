import CanonicalSpec.Basic

/-!
# Canonical serialization

`canonicalize` is `render` after `normalize`. `normalize` sorts the members of every object by key in code-unit
order; `render` walks the sorted tree in the order the serializer does and refuses what it refuses, with the same
code and path.

The walk checks an object's keys before any of its members, from the last key to the first, so the refused key is the
last ill-formed one. Members and items are then visited first to last, and the first refusal wins.
-/

namespace CanonicalSpec

/-- A refused serialization: the stable code and the path of the value. -/
structure Refusal where
  code : String
  path : Text

/-- The serializer's settings: `escape` writes lone surrogates as escapes; `limit` is the deepest nesting allowed. -/
structure Options where
  escape : Bool
  limit : Nat

/-- `MAX_CANONICAL_DEPTH`. -/
def maxCanonicalDepth : Nat := 10000

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

-- Rendering -----------------------------------------------------------------------------------------------------------

/-- The last key that is not well formed. -/
def lastIllFormedKey : Members → Option Text
  | .nil => none
  | .cons key _ rest =>
    match lastIllFormedKey rest with
    | some later => some later
    | none => if wellFormed key then none else some key

/-- A refusal at a path held innermost step first, which is how the walk extends it. -/
def refuse (code : String) (path : List Segment) : Except Refusal Text :=
  .error { code, path := pathText path.reverse }

/-- Refuses a value nested deeper than the limit before anything else about it is read. -/
def guardDepth (options : Options) (path : List Segment) (depth : Nat) (next : Except Refusal Text) :
    Except Refusal Text :=
  if depth > options.limit then refuse "canonical_depth_exceeded" path else next

/-- Joins a rendered head to a rendered tail with a comma. -/
def joinComma (head tail : Text) : Text := if tail.isEmpty then head else head ++ 44 :: tail

mutual
  /-- The JSON text of a value whose objects are already in key order. -/
  def render (options : Options) : Value → List Segment → Nat → Except Refusal Text
    | .null, path, depth => guardDepth options path depth (.ok (ascii "null"))
    | .bool value, path, depth => guardDepth options path depth (.ok (ascii (if value then "true" else "false")))
    | .num .nan, path, depth => guardDepth options path depth (refuse "canonical_nan" path)
    | .num .posInf, path, depth => guardDepth options path depth (refuse "canonical_non_finite" path)
    | .num .negInf, path, depth => guardDepth options path depth (refuse "canonical_non_finite" path)
    | .num .negZero, path, depth => guardDepth options path depth (.ok [48])
    | .num (.int value), path, depth => guardDepth options path depth (.ok (decimal value))
    | .str value, path, depth =>
      guardDepth options path depth
        (if !options.escape && !wellFormed value then refuse "canonical_lone_surrogate" path
        else .ok (quote value))
    | .arr items, path, depth =>
      guardDepth options path depth
        (match renderItems options items path 0 (depth + 1) with
        | .error refusal => .error refusal
        | .ok body => .ok (91 :: body ++ [93]))
    | .obj members, path, depth =>
      guardDepth options path depth
        (match (if options.escape then none else lastIllFormedKey members) with
        | some key => refuse "canonical_lone_surrogate" (.key key :: path)
        | none =>
          match renderMembers options members path (depth + 1) with
          | .error refusal => .error refusal
          | .ok body => .ok (123 :: body ++ [125]))

  /-- The items, comma separated. -/
  def renderItems (options : Options) : Items → List Segment → Nat → Nat → Except Refusal Text
    | .nil, _, _, _ => .ok []
    | .cons head tail, path, index, depth =>
      match render options head (.index index :: path) depth with
      | .error refusal => .error refusal
      | .ok first =>
        match renderItems options tail path (index + 1) depth with
        | .error refusal => .error refusal
        | .ok rest => .ok (joinComma first rest)

  /-- The members as `"key":value`, comma separated. -/
  def renderMembers (options : Options) : Members → List Segment → Nat → Except Refusal Text
    | .nil, _, _ => .ok []
    | .cons key value tail, path, depth =>
      match render options value (.key key :: path) depth with
      | .error refusal => .error refusal
      | .ok first =>
        match renderMembers options tail path depth with
        | .error refusal => .error refusal
        | .ok rest => .ok (joinComma (quote key ++ 58 :: first) rest)
end

/-- `canonicalize(value, options)`: sort every object, then serialize from the root. -/
def canonicalizeWith (options : Options) (value : Value) : Except Refusal Text :=
  render options (normalize value) [] 0

/-- `canonicalize(value)` with the package's depth limit. -/
def canonicalize (escape : Bool) (value : Value) : Except Refusal Text :=
  canonicalizeWith { escape, limit := maxCanonicalDepth } value

/-- `count` arrays around a `null`: the value the depth limit is measured with. -/
def nest : Nat → Value
  | 0 => .null
  | count + 1 => .arr (.cons (nest count) .nil)

end CanonicalSpec

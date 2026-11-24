import CanonicalSpec.Basic

/-!
# Bounded admission

`BoundedJson`'s two admissions, plain (`admitJson` here) and strict (`admitStrict`), walk a JSON tree once, counting
encoded bytes, values and members against limits, and refuse at the first limit crossed. The walk is modeled over
plain JSON trees: no proxy, accessor, symbol, sparse array, cycle or foreign prototype, which the differential test
leaves to the implementation's own suite.

The counters are threaded through the walk in visiting order. `size` is what a tree costs in bytes with no limit in
the way; the theorems tie the walk's count to it.
-/

namespace CanonicalSpec

/-- `BoundedJson.Limits`; an absent optional limit is no limit. -/
structure Limits where
  maxBytes : Option Nat
  maxDepth : Nat
  maxMembers : Nat
  maxTotalMembers : Option Nat
  maxNodes : Nat
  maxStringBytes : Option Nat
  maxKeyBytes : Option Nat

/-- `BoundedJson.StrictLimits`: every limit is required. -/
structure StrictLimits where
  maxBytes : Nat
  maxDepth : Nat
  maxMembers : Nat
  maxNodes : Nat
  maxStringBytes : Nat
  maxKeyBytes : Nat

/-- A refused admission. -/
structure Issue where
  code : String
  complaint : String
  path : List Segment

/-- What the walk has counted so far. -/
structure Counters where
  bytes : Nat
  nodes : Nat
  members : Nat

def Counters.zero : Counters := { bytes := 0, nodes := 0, members := 0 }

abbrev Walk := Except Issue Counters

/-- Bytes a number costs, or none when it is not finite. -/
def numberBytes (value : Number) : Option Nat := (numberText value).map List.length

/-- Brackets or braces and the commas between `count` children. -/
def structureBytes (count : Nat) : Nat := 2 + (count - 1)

-- Plain admission ---------------------------------------------------------------------------------------------------

/-- Counts `count` bytes, or refuses when the total passes `maxBytes`. -/
def addBytes (limits : Limits) (path : List Segment) (count : Nat) (counters : Counters) : Walk :=
  if within (counters.bytes + count) limits.maxBytes then .ok { counters with bytes := counters.bytes + count }
  else .error { code := "bytes", complaint := "exceeds the JSON byte limit", path }

/-- The checks every value passes first: its depth, then the value count. -/
def enter (limits : Limits) (path : List Segment) (depth : Nat) (counters : Counters) : Walk :=
  if depth > limits.maxDepth then
    .error { code := "depth", complaint := s!"exceeds the maximum JSON depth of {limits.maxDepth}", path }
  else if counters.nodes + 1 > limits.maxNodes then
    .error { code := "nodes", complaint := s!"contains more than {limits.maxNodes} JSON values", path }
  else .ok { counters with nodes := counters.nodes + 1 }

def membersIssue (path : List Segment) : Issue :=
  { code := "members", complaint := "exceeds the JSON members limit", path }

/-- Counts a container's `count` members against the per-container and the cumulative limit. -/
def countMembers (limits : Limits) (path : List Segment) (count : Nat) (counters : Counters) : Walk :=
  if count ≤ limits.maxMembers && within (counters.members + count) limits.maxTotalMembers then
    .ok { counters with members := counters.members + count }
  else .error (membersIssue path)

/--
The check an object makes as it lists its members, before it counts them: member `count` of `remaining + count - 1`
is refused when it is one too many, or, with `preflight`, when the members listed so far cannot fit the value or byte
limit even as the smallest members there are.
-/
def listMembers (limits : Limits) (preflight : Bool) (path : List Segment) (counters : Counters) :
    Nat → Nat → Except Issue Unit
  | _, 0 => .ok ()
  | count, remaining + 1 =>
    if !(count ≤ limits.maxMembers && within (counters.members + count) limits.maxTotalMembers) then
      .error (membersIssue path)
    else if preflight && counters.nodes + count > limits.maxNodes then
      .error { code := "nodes", complaint := s!"contains more than {limits.maxNodes} JSON values", path }
    else if preflight && !within (counters.bytes + 2 + (count - 1) + 4 * count) limits.maxBytes then
      .error { code := "bytes", complaint := "exceeds the JSON byte limit", path }
    else listMembers limits preflight path counters (count + 1) remaining

/-- A leaf of `bytes` bytes. -/
def admitLeaf (limits : Limits) (path : List Segment) (depth bytes : Nat) (counters : Counters) : Walk :=
  match enter limits path depth counters with
  | .error issue => .error issue
  | .ok entered => addBytes limits path bytes entered

mutual
  /-- Plain admission from one value down. -/
  def admitValue (limits : Limits) (preflight : Bool) : Value → List Segment → Nat → Counters → Walk
    | .null, path, depth, counters => admitLeaf limits path depth 4 counters
    | .bool value, path, depth, counters => admitLeaf limits path depth (if value then 4 else 5) counters
    | .num value, path, depth, counters =>
      match enter limits path depth counters with
      | .error issue => .error issue
      | .ok entered =>
        match numberBytes value with
        | none => .error { code := "number", complaint := "contains a non-finite number", path }
        | some bytes => addBytes limits path bytes entered
    | .str value, path, depth, counters =>
      match enter limits path depth counters with
      | .error issue => .error issue
      | .ok entered =>
        match encodedStringBytes value limits.maxStringBytes with
        | none => .error { code := "string", complaint := "contains unbounded or ill-formed text", path }
        | some bytes => addBytes limits path bytes entered
    | .arr items, path, depth, counters =>
      match enter limits path depth counters with
      | .error issue => .error issue
      | .ok entered =>
        match countMembers limits path items.length entered with
        | .error issue => .error issue
        | .ok counted =>
          match addBytes limits path (structureBytes items.length) counted with
          | .error issue => .error issue
          | .ok opened => admitItems limits preflight items path 0 (depth + 1) opened
    | .obj members, path, depth, counters =>
      match enter limits path depth counters with
      | .error issue => .error issue
      | .ok entered =>
        match listMembers limits preflight path entered 1 members.length with
        | .error issue => .error issue
        | .ok () =>
          match countMembers limits path members.length entered with
          | .error issue => .error issue
          | .ok counted =>
            match addBytes limits path (structureBytes members.length) counted with
            | .error issue => .error issue
            | .ok opened => admitMembers limits preflight members path (depth + 1) opened

  def admitItems (limits : Limits) (preflight : Bool) : Items → List Segment → Nat → Nat → Counters → Walk
    | .nil, _, _, _, counters => .ok counters
    | .cons head tail, path, index, depth, counters =>
      match admitValue limits preflight head (path ++ [.index index]) depth counters with
      | .error issue => .error issue
      | .ok next => admitItems limits preflight tail path (index + 1) depth next

  def admitMembers (limits : Limits) (preflight : Bool) : Members → List Segment → Nat → Counters → Walk
    | .nil, _, _, counters => .ok counters
    | .cons key value tail, path, depth, counters =>
      match encodedStringBytes key limits.maxKeyBytes with
      | none =>
        .error
          { code := "key", complaint := "contains an unbounded or ill-formed object key", path := path ++ [.key key] }
      | some bytes =>
        match addBytes limits path (bytes + 1) counters with
        | .error issue => .error issue
        | .ok keyed =>
          match admitValue limits preflight value (path ++ [.key key]) depth keyed with
          | .error issue => .error issue
          | .ok next => admitMembers limits preflight tail path depth next
end

/-- Plain admission of `value` under `limits`, with or without object preflight: the bytes counted, or the refusal. -/
def admitJson (limits : Limits) (preflight : Bool) (value : Value) : Except Issue Nat :=
  match admitValue limits preflight value [] 0 .zero with
  | .error issue => .error issue
  | .ok counters => .ok counters.bytes

-- What a tree costs ---------------------------------------------------------------------------------------------------

mutual
  /-- Encoded bytes of a tree the walk accepts: literals, numbers, strings, keys, colons, commas and brackets. -/
  def size : Value → Nat
    | .null => 4
    | .bool value => if value then 4 else 5
    | .num value => (numberBytes value).getD 0
    | .str value => (encodedStringBytes value none).getD 0
    | .arr items => structureBytes items.length + sizeItems items
    | .obj members => structureBytes members.length + sizeMembers members

  def sizeItems : Items → Nat
    | .nil => 0
    | .cons head tail => size head + sizeItems tail

  def sizeMembers : Members → Nat
    | .nil => 0
    | .cons key value tail => (encodedStringBytes key none).getD 0 + 1 + size value + sizeMembers tail
end

mutual
  /-- Values in a tree, itself included. -/
  def nodes : Value → Nat
    | .arr items => 1 + nodesItems items
    | .obj members => 1 + nodesMembers members
    | _ => 1

  def nodesItems : Items → Nat
    | .nil => 0
    | .cons head tail => nodes head + nodesItems tail

  def nodesMembers : Members → Nat
    | .nil => 0
    | .cons _ value tail => nodes value + nodesMembers tail
end

mutual
  /-- Nesting below a value: 0 for a leaf or an empty container. -/
  def height : Value → Nat
    | .arr items => heightItems items
    | .obj members => heightMembers members
    | _ => 0

  /-- One more than the tallest item, or 0 with no items. -/
  def heightItems : Items → Nat
    | .nil => 0
    | .cons head tail => max (height head + 1) (heightItems tail)

  def heightMembers : Members → Nat
    | .nil => 0
    | .cons _ value tail => max (height value + 1) (heightMembers tail)
end

-- `admitStrict` -------------------------------------------------------------------------------------------------------

def strictBytes (limits : StrictLimits) (path : List Segment) (count : Nat) (counters : Counters) : Walk :=
  if counters.bytes + count ≤ limits.maxBytes then .ok { counters with bytes := counters.bytes + count }
  else .error { code := "bytes", complaint := s!"exceeds the {limits.maxBytes}-byte limit", path }

def strictEnter (limits : StrictLimits) (path : List Segment) (counters : Counters) : Walk :=
  if counters.nodes + 1 > limits.maxNodes then
    .error { code := "nodes", complaint := s!"exceeds the {limits.maxNodes}-node limit", path }
  else .ok { counters with nodes := counters.nodes + 1 }

/-- A container's checks: its depth, then its members against the cumulative limit. -/
def strictOpen (limits : StrictLimits) (path : List Segment) (depth count : Nat) (counters : Counters) : Walk :=
  if depth ≥ limits.maxDepth then
    .error { code := "depth", complaint := s!"exceeds the depth limit of {limits.maxDepth}", path }
  else if count ≤ limits.maxMembers && counters.members + count ≤ limits.maxMembers then
    .ok { counters with members := counters.members + count }
  else .error { code := "members", complaint := s!"exceeds the {limits.maxMembers}-member limit", path }

def reservedKeys : List Text := [ascii "__proto__", ascii "constructor", ascii "prototype"]

/--
Checks every key before any member is visited and totals what the keys and their colons cost. `boundedText` checks a
key's length first and names a refused key by its position.
-/
def strictKeys (limits : StrictLimits) (boundedText : Bool) (path : List Segment) :
    Members → Nat → Nat → Except Issue Nat
  | .nil, _, total => .ok total
  | .cons key _ tail, index, total =>
    let located := path ++ [if boundedText then .position index else .key key]
    let tooLong : Issue :=
      { code := "key", complaint := s!"exceeds the {limits.maxKeyBytes}-byte key limit", path := located }
    let reserved : Issue :=
      { code := "key", complaint := "uses a reserved property name", path := path ++ [.key key] }
    if boundedText && key.length > limits.maxKeyBytes then .error tooLong
    else
      match encodedStringBytes key none with
      | none => .error { code := "key", complaint := "has an ill-formed property name", path := located }
      | some bytes =>
        if !boundedText && reservedKeys.contains key then .error reserved
        else if bytes > limits.maxKeyBytes then .error tooLong
        else if reservedKeys.contains key then .error reserved
        else strictKeys limits boundedText path tail (index + 1) (total + bytes + 1)

mutual
  /-- `BoundedJson.admitStrict` from one value down. -/
  def strictValue (limits : StrictLimits) (boundedText : Bool) : Value → List Segment → Nat → Counters → Walk
    | .null, path, _, counters =>
      match strictEnter limits path counters with
      | .error issue => .error issue
      | .ok entered => strictBytes limits path 4 entered
    | .bool value, path, _, counters =>
      match strictEnter limits path counters with
      | .error issue => .error issue
      | .ok entered => strictBytes limits path (if value then 4 else 5) entered
    | .num value, path, _, counters =>
      match strictEnter limits path counters with
      | .error issue => .error issue
      | .ok entered =>
        match numberBytes value with
        | none => .error { code := "number", complaint := "must be a finite JSON number", path }
        | some bytes => strictBytes limits path bytes entered
    | .str value, path, _, counters =>
      match strictEnter limits path counters with
      | .error issue => .error issue
      | .ok entered =>
        let tooLong : Issue :=
          { code := "string", complaint := s!"exceeds the {limits.maxStringBytes}-byte string limit", path }
        if boundedText && value.length > limits.maxStringBytes then .error tooLong
        else
          match encodedStringBytes value none with
          | none => .error { code := "string", complaint := "contains an unpaired UTF-16 surrogate", path }
          | some bytes => if bytes > limits.maxStringBytes then .error tooLong else strictBytes limits path bytes entered
    | .arr items, path, depth, counters =>
      match strictEnter limits path counters with
      | .error issue => .error issue
      | .ok entered =>
        match strictOpen limits path depth items.length entered with
        | .error issue => .error issue
        | .ok counted =>
          match strictBytes limits path (structureBytes items.length) counted with
          | .error issue => .error issue
          | .ok opened => strictItems limits boundedText items path 0 (depth + 1) opened
    | .obj members, path, depth, counters =>
      match strictEnter limits path counters with
      | .error issue => .error issue
      | .ok entered =>
        match strictOpen limits path depth members.length entered with
        | .error issue => .error issue
        | .ok counted =>
          match strictKeys limits boundedText path members 0 (structureBytes members.length) with
          | .error issue => .error issue
          | .ok bytes =>
            match strictBytes limits path bytes counted with
            | .error issue => .error issue
            | .ok opened => strictMembers limits boundedText members path (depth + 1) opened

  def strictItems (limits : StrictLimits) (boundedText : Bool) : Items → List Segment → Nat → Nat → Counters → Walk
    | .nil, _, _, _, counters => .ok counters
    | .cons head tail, path, index, depth, counters =>
      match strictValue limits boundedText head (path ++ [.index index]) depth counters with
      | .error issue => .error issue
      | .ok next => strictItems limits boundedText tail path (index + 1) depth next

  def strictMembers (limits : StrictLimits) (boundedText : Bool) : Members → List Segment → Nat → Counters → Walk
    | .nil, _, _, counters => .ok counters
    | .cons key value tail, path, depth, counters =>
      match strictValue limits boundedText value (path ++ [.key key]) depth counters with
      | .error issue => .error issue
      | .ok next => strictMembers limits boundedText tail path depth next
end

/-- `BoundedJson.admitStrict(value, limits, { boundedText })`: accepted, or the refusal. -/
def admitStrict (limits : StrictLimits) (boundedText : Bool) (value : Value) : Except Issue Counters :=
  strictValue limits boundedText value [] 0 .zero

end CanonicalSpec

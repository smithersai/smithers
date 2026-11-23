/-
`strategy.matrix`, expanded the way GitHub Actions does.

The reference for `packages/ci/src/inventory/Matrix.vibe`: every combination of the matrix's lists, less
`exclude`, then `include`. Which values are named like a secret is decided by regular expressions outside this
specification, so the expansion takes that as a function.
-/
import InventorySpec.Json

namespace InventorySpec

/-- The values one variant sets, by name, in the order they were set. A name is there once. -/
abbrev Assignment := List (String × String)

/-- GitHub refuses a matrix with more variants than this. -/
def maxVariants : Nat := 256

/-- The text of a scalar, as a workflow runner would print it. A null is empty; lists and mappings have none. -/
def asScalar : Value → Option String
  | .str s => some s
  | .num x => some (String.ofList (jsNumberText x))
  | .bool b => some (if b then "true" else "false")
  | .null => some ""
  | _ => none

mutual
  /--
  Adds one value under its name; a mapping's fields become `name.field`. `none` for a list, and for text with an
  expression in it, which is only known when the workflow runs.
  -/
  def flatten (name : String) (into : Assignment) : Value → Option Assignment
    | .obj _ fields => flattenFields name into fields
    | .arr _ _ => none
    | scalar =>
      match asScalar scalar with
      | some text => if includes "${{".toList text.toList then none else some (setField into name text)
      | none => none

  /-- Adds the fields of a mapping, each under `name.field`. -/
  def flattenFields (name : String) (into : Assignment) : List (String × Value) → Option Assignment
    | [] => some into
    | (key, item) :: rest =>
      match flatten (name ++ "." ++ key) into item with
      | none => none
      | some into => flattenFields name into rest
end

/-- Adds the fields of an `include` or `exclude` entry, each under its own name. -/
def flattenEntry (into : Assignment) : List (String × Value) → Option Assignment
  | [] => some into
  | (key, item) :: rest =>
    match flatten key into item with
    | none => none
    | some into => flattenEntry into rest

/-- Every item, when every one of them could be read. -/
def allRead {α : Type} : List (Option α) → Option (List α)
  | [] => some []
  | none :: _ => none
  | some item :: rest => (allRead rest).map (item :: ·)

/-- One entry of `include` or `exclude`. -/
def readAssignment : Value → Option Assignment
  | .obj _ fields => flattenEntry [] fields
  | _ => none

/-- `include` or `exclude`: a list of mappings, or nothing at all. -/
def readAssignments : Option Value → Option (List Assignment)
  | none => some []
  | some (.arr _ items) => allRead (items.map readAssignment)
  | some _ => none

/-- The values of one list of the matrix, each as what it sets. -/
def readAxis (name : String) : Value → Option (List Assignment)
  | .arr _ items => allRead (items.map (flatten name []))
  | _ => none

/-- Whether a variant has every value a filter names. An empty filter matches every variant. -/
def matchesFilter (variant filter : Assignment) : Bool :=
  filter.all fun (key, held) => variant.lookup key == some held

/-- The top-level matrix name a flattened name starts with. -/
def rootOf (key : String) : String := String.ofList (key.toList.takeWhile (· != '.'))

/-- One top-level matrix value, with any nested fields. -/
def valueAt (assignment : Assignment) (root : String) : Assignment :=
  assignment.filter fun (key, _) => rootOf key == root

/-- Whether two values hold the same fields. A name is there once, so the order does not matter. -/
def sameValue (left right : Assignment) : Bool :=
  left.all right.contains && right.all left.contains

/-- True when adding `entry` changes no value `original` has. -/
def fits (original entry : Assignment) : Bool :=
  entry.all fun (key, _) =>
    let held := valueAt original (rootOf key)
    held.isEmpty || sameValue held (valueAt entry (rootOf key))

/-- A variant with an `include` entry added: the entry replaces each value it names, with all its fields. -/
def mergeEntry (variant entry : Assignment) : Assignment :=
  variant.filter (fun (key, _) => !(entry.map fun (name, _) => rootOf name).contains (rootOf key)) ++ entry

/-- What says a matrix is too large. -/
def tooMany : String := "it has over " ++ toString maxVariants ++ " variants"

/-- Every combination of what is there with one more list. A name set twice keeps its place and its last value. -/
def cross (combinations axis : List Assignment) : List Assignment :=
  combinations.flatMap fun base =>
    axis.map fun held => held.foldl (fun so_far (key, text) => setField so_far key text) base

/-- Every combination of the matrix's lists, one list at a time, refused as soon as there are too many. -/
def combine (combinations : List Assignment) : List (String × Value) → Except String (List Assignment)
  | [] => .ok combinations
  | (name, values) :: rest =>
    match readAxis name values with
    | none => .error (name ++ " is not a list of plain values")
    | some axis =>
      if combinations.length * axis.length > maxVariants then .error tooMany
      else combine (cross combinations axis) rest

/-- The combinations no `exclude` entry matches. -/
def applyExclude (excluded combinations : List Assignment) : List Assignment :=
  combinations.filter fun variant => !excluded.any (matchesFilter variant)

/--
Adds the `include` entries in order. An entry joins each original combination whose original values it does not
change, and is a new variant when it joins none. `merged` holds the originals with what earlier entries added.
-/
def applyInclude (originals merged added : List Assignment) :
    List Assignment → Except String (List Assignment × List Assignment)
  | [] => .ok (merged, added)
  | entry :: rest =>
    let joins := originals.map (fits · entry)
    if joins.any id then
      applyInclude originals
        (List.zipWith (fun variant join => if join then mergeEntry variant entry else variant) merged joins) added rest
    else if merged.length + added.length ≥ maxVariants then .error tooMany
    else applyInclude originals merged (added ++ [entry]) rest

/-- The part of a flattened name after its last dot: the name the value has where it is used. -/
def lastPart (key : String) : String :=
  String.ofList (key.toList.reverse.takeWhile (· != '.')).reverse

/-- Whether a variant holds a value named like a secret. -/
def holdsSecret (secret : String → String → Bool) (variant : Assignment) : Bool :=
  variant.any fun (key, held) => secret (lastPart key) held

/-- The variants of a matrix written as a mapping, or why it cannot be read. -/
def expandFields (secret : String → String → Bool) (fields : List (String × Value)) :
    Except String (List Assignment) :=
  match readAssignments (fields.lookup "exclude"), readAssignments (fields.lookup "include") with
  | some excluded, some included =>
    let lists := fields.filter fun (key, _) => key != "exclude" && key != "include"
    match combine (if lists.isEmpty then [] else [[]]) lists with
    | .error why => .error why
    | .ok combinations =>
      let originals := applyExclude excluded combinations
      match applyInclude originals originals [] included with
      | .error why => .error why
      | .ok (merged, added) =>
        if (merged ++ added).any (holdsSecret secret) then .error "it holds a value named like a secret"
        else .ok (merged ++ added)
  | _, _ => .error "include or exclude holds a computed value"

/-- The variants of a job, the variable names they set, and why a matrix could not be read. -/
structure Matrix where
  variants : List Assignment
  keys : List String
  problem : Option String

/-- A job with no matrix. -/
def noMatrix : Matrix := { variants := [], keys := [], problem := none }

/--
Reads a matrix: every combination of its lists, less `exclude`, then `include`. A matrix with a problem has no
variants. `none` is a job that has no matrix.
-/
def expandMatrix (secret : String → String → Bool) : Option Value → Matrix
  | none => noMatrix
  | some (.obj _ fields) =>
    match expandFields secret fields with
    | .ok variants =>
      { variants, keys := (variants.flatMap fun variant => variant.map (·.1)).eraseDups, problem := none }
    | .error why => { noMatrix with problem := some why }
  | some _ => { noMatrix with problem := some "the matrix is computed when the workflow runs" }

end InventorySpec

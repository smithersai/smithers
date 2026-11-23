import Lean.Data.Json
import ObservedReadsSpec.Vfs

/-!
# Records: their shape, their count of paths, their id, and the stored history

The specification of `asRecord`, `pathsOf`, `idOf` and `store`.

`isRecordShape` is the test `isRecord` in `ObservedReads.ts` makes of a value read back from disk.
`isRecord` is the test the specification asks for: it also holds `running` and `served` to their types, which
the implementation reads later without having checked them (`programsWellFormed`).
-/
namespace ObservedReadsSpec

open Lean (Json)

/-- The format tag of a stored set of records. -/
def format : String := "smthrs-observed-reads/4"

/-- Records kept for one declaration. -/
def maximumRecords : Nat := 4

/-- The most paths one record holds. -/
def maximumPaths : Nat := 400000

/-- Which rules of the implementation the specification is read under. -/
structure Rules where
  /-- A file the run changed is held only as the run found it (`[path, left, before]` matches `before`). -/
  u2 : Bool
  /-- A directory the run looked at without listing is held by its link count (`links`). -/
  u3 : Bool
  deriving Repr, DecidableEq

/-- A path with what the run left there, and for a path the run wrote, another state it may hold. -/
structure ReadRow where
  path : String
  state : String
  other : Option String
  deriving Repr, DecidableEq

/-- A directory the run listed: its listing's digest, the names the run wrote, and the names a step before it wrote. -/
structure ListRow where
  path : String
  digest : String
  own : List String
  added : Option (List (String × Nat))
  deriving Repr, DecidableEq

/-- A directory the run looked at: its link count, the names the run wrote, and the names a step before it wrote. -/
structure LinkRow where
  path : String
  count : Int
  own : List String
  added : Option (List (String × Nat))
  deriving Repr, DecidableEq

/-- What one run read. -/
structure Record where
  id : String
  reads : List ReadRow
  lists : List ListRow
  links : Option (List LinkRow) := none
  «from» : Option (List (String × String)) := none
  given : Option (List (String × String × Nat)) := none
  left : Bool := false
  made : Option (List String) := none
  variables : Option (List (String × String)) := none
  running : Bool := false
  served : Option (List (String × String)) := none
  /-- The archive that names the kept files, when the run's files are kept. -/
  kept : Option String := none
  deriving Repr, DecidableEq

/-- `pathsOf`: the paths a record holds, counted against `maximumPaths`. -/
def pathsOf (record : Record) : Nat :=
  record.reads.length + record.lists.length + (record.links.getD []).length + (record.given.getD []).length

/-! ## The shape of a record read back from disk -/

def isText : Json → Bool
  | .str _ => true
  | _ => false

/-- A property of an object; none where JavaScript reads `undefined`. -/
def field (value : Json) (key : String) : Option Json := (value.getObjVal? key).toOption

/-- The elements of an array. -/
def elements : Json → Option (List Json)
  | .arr items => some items.toList
  | _ => none

/-- A property that defaults to an empty array when it is `undefined`. -/
def arrayField (value : Json) (key : String) : Option (List Json) :=
  match field value key with
  | none => some []
  | some found => elements found

/-- The integer a number is, when it is one (`Number.isInteger`). -/
def integer? : Json → Option Int
  | .num number =>
    let scale : Int := (10 : Int) ^ number.exponent
    if number.mantissa % scale = 0 then some (number.mantissa / scale) else none
  | _ => none

/-- A place in `from`: an integer from 0 below its length. -/
def isPlace (count : Nat) (value : Json) : Bool :=
  match integer? value with
  | some place => 0 ≤ place && place < count
  | none => false

/-- An array of exactly `size` strings. -/
def isTexts (size : Nat) (value : Json) : Bool :=
  match elements value with
  | some items => items.length == size && items.all isText
  | none => false

/-- An array of strings of any length. -/
def isNames (value : Json) : Bool :=
  match elements value with
  | some items => items.all isText
  | none => false

/-- `/^[0-9a-f]{64}$/`. -/
def isArchive (text : String) : Bool :=
  text.toList.length == 64 && text.toList.all (fun c => isDigit c || ('a' ≤ c && c ≤ 'f'))

/-- `isKept`: nothing, or an archive's name with the paths the run removed and those it left outside. -/
def isKept : Option Json → Bool
  | none => true
  | some (.obj fields) =>
    let value := Json.obj fields
    (match field value "archive" with
      | some (.str archive) => isArchive archive
      | _ => false) &&
    (match field value "gone" with
      | some gone => isNames gone
      | none => false) &&
    (match (field value "outside").bind elements with
      | some rows => rows.all (isTexts 2)
      | none => false)
  | some _ => false

/-- The fourth part of a `lists` or `links` row: the names steps before the run wrote, each with a place in `from`. -/
def isAdded (count : Nat) (value : Json) : Bool :=
  match elements value with
  | some rows => rows.all fun row =>
    match elements row with
    | some [name, place] => isText name && isPlace count place
    | _ => false
  | none => false

/-- A row of `lists` (`text` digest) or of `links` (integer count). -/
def isDirectoryRow (count : Nat) (second : Json → Bool) (row : Json) : Bool :=
  match elements row with
  | some [path, held, own] => isText path && second held && isNames own
  | some [path, held, own, added] => isText path && second held && isNames own && isAdded count added
  | _ => false

/--
The test `isRecord` makes in `ObservedReads.ts`. Under `u3` it also holds `links` to its shape; before `u3`
a record has no `links` and the property is not looked at.
-/
def isRecordShape (rules : Rules) (value : Json) : Bool :=
  match value with
  | .obj _ =>
    match elements <$> field value "reads", elements <$> field value "lists", arrayField value "from",
      arrayField value "given", arrayField value "made", arrayField value "variables",
      (if rules.u3 then arrayField value "links" else some []) with
    | some (some reads), some (some lists), some origin, some given, some made, some variables, some links =>
      (match field value "id" with
        | some (.str _) => true
        | _ => false) &&
      (match field value "left" with
        | none => true
        | some (.bool true) => true
        | _ => false) &&
      isKept (field value "kept") &&
      made.all isText &&
      variables.all (isTexts 2) &&
      reads.all (fun row => isTexts 2 row || isTexts 3 row) &&
      origin.all (isTexts 2) &&
      given.all (fun row =>
        match elements row with
        | some [path, state, place] => isText path && isText state && isPlace origin.length place
        | _ => false) &&
      links.all (isDirectoryRow origin.length (fun count => (integer? count).isSome)) &&
      lists.all (isDirectoryRow origin.length isText)
    | _, _, _, _, _, _, _ => false
  | _ => false

/--
Whether `running` and `served` have their types: `running` unset or `true`, `served` unset or pairs of strings.
`changed` iterates `served` and `idOf` digests both, so a record that fails this cannot be read safely.
-/
def programsWellFormed (value : Json) : Bool :=
  (match field value "running" with
    | none => true
    | some (.bool true) => true
    | _ => false) &&
  (match field value "served" with
    | none => true
    | some served =>
      match elements served with
      | some rows => rows.all (isTexts 2)
      | none => false)

/-- The shape the specification asks of a stored record. -/
def isRecord (rules : Rules) (value : Json) : Bool := isRecordShape rules value && programsWellFormed value

/-! ## Reading a record of the right shape -/

def textOf : Json → String
  | .str text => text
  | _ => ""

def pairOf (row : Json) : String × String :=
  match elements row with
  | some [first, second] => (textOf first, textOf second)
  | _ => ("", "")

def placeOf (value : Json) : Nat := ((integer? value).getD 0).toNat

def namesOf (value : Json) : List String := ((elements value).getD []).map textOf

def addedOf (value : Json) : List (String × Nat) :=
  ((elements value).getD []).map fun row =>
    match elements row with
    | some [name, place] => (textOf name, placeOf place)
    | _ => ("", 0)

def readRowOf (row : Json) : ReadRow :=
  match elements row with
  | some [path, state] => ⟨textOf path, textOf state, none⟩
  | some [path, state, other] => ⟨textOf path, textOf state, some (textOf other)⟩
  | _ => ⟨"", "", none⟩

def listRowOf (row : Json) : ListRow :=
  match elements row with
  | some [path, digest, own] => ⟨textOf path, textOf digest, namesOf own, none⟩
  | some [path, digest, own, added] => ⟨textOf path, textOf digest, namesOf own, some (addedOf added)⟩
  | _ => ⟨"", "", [], none⟩

def linkRowOf (row : Json) : LinkRow :=
  match elements row with
  | some [path, count, own] => ⟨textOf path, (integer? count).getD 0, namesOf own, none⟩
  | some [path, count, own, added] => ⟨textOf path, (integer? count).getD 0, namesOf own, some (addedOf added)⟩
  | _ => ⟨"", 0, [], none⟩

def givenRowOf (row : Json) : String × String × Nat :=
  match elements row with
  | some [path, state, place] => (textOf path, textOf state, placeOf place)
  | _ => ("", "", 0)

/-- The record a value of the right shape holds. -/
def decode (rules : Rules) (value : Json) : Record where
  id := ((field value "id").map textOf).getD ""
  reads := (((field value "reads").bind elements).getD []).map readRowOf
  lists := (((field value "lists").bind elements).getD []).map listRowOf
  links := if rules.u3 then ((field value "links").bind elements).map (·.map linkRowOf) else none
  «from» := ((field value "from").bind elements).map (·.map pairOf)
  given := ((field value "given").bind elements).map (·.map givenRowOf)
  left := (field value "left") == some (.bool true)
  made := (field value "made").map namesOf
  variables := ((field value "variables").bind elements).map (·.map pairOf)
  running := (field value "running") == some (.bool true)
  served := ((field value "served").bind elements).map (·.map pairOf)
  kept := ((field value "kept").bind (field · "archive")).map textOf

/-- `asRecord`: a record read back from where it was kept; any other shape is none. -/
def asRecord (rules : Rules) (value : Json) : Option Record :=
  if isRecord rules value then some (decode rules value) else none

/-! ## `idOf` -/

def jsonPair (pair : String × String) : String := jsonArray [jsonString pair.1, jsonString pair.2]

def jsonAdded (added : List (String × Nat)) : String :=
  jsonArray (added.map fun (name, place) => jsonArray [jsonString name, toString place])

def ReadRow.json (row : ReadRow) : String :=
  jsonArray ([jsonString row.path, jsonString row.state] ++ (row.other.map jsonString).toList)

def ListRow.json (row : ListRow) : String :=
  jsonArray ([jsonString row.path, jsonString row.digest, jsonStrings row.own] ++ (row.added.map jsonAdded).toList)

def LinkRow.json (row : LinkRow) : String :=
  jsonArray ([jsonString row.path, toString row.count, jsonStrings row.own] ++ (row.added.map jsonAdded).toList)

def jsonBool (value : Bool) : String := if value then "true" else "false"

/-- What `idOf` digests: `JSON.stringify` of the record's parts, each new part only where a record has it. -/
def idText (record : Record) : String :=
  jsonArray (
    [jsonArray (record.reads.map ReadRow.json), jsonArray (record.lists.map ListRow.json)] ++
    (match record.links with
      | none => []
      | some links => [jsonString "links", jsonArray (links.map LinkRow.json)]) ++
    [jsonArray ((record.from.getD []).map jsonPair),
      jsonArray ((record.given.getD []).map fun (path, state, place) =>
        jsonArray [jsonString path, jsonString state, toString place]),
      jsonBool record.left] ++
    (match record.made with
      | none => []
      | some made => [jsonString "made", jsonStrings made]) ++
    (match record.variables with
      | none => []
      | some variables => [jsonArray (variables.map jsonPair)]) ++
    (if !record.running && record.served.isNone then []
      else [jsonString "programs", jsonBool record.running, jsonArray ((record.served.getD []).map jsonPair)]))

/-- `idOf`: the id of a record, a digest of what it holds. -/
def idOf (record : Record) : String := sha256Hex (idText record)

/-! ## `store` -/

/-- The stored form of a declaration's records. -/
structure Stored where
  kind : String
  format : String
  records : List Record
  deriving Repr, DecidableEq

/--
`store`: puts a new record in front of the stored ones and keeps the newest `maximumRecords`. A record with
the new one's id is replaced by it. None when the new record holds more than `maximumPaths` paths.
-/
def store (added : Record) (earlier : List Record) : Option Stored :=
  if pathsOf added > maximumPaths then none
  else
    some {
      kind := "observed"
      format := format
      records := (added :: earlier.filter (fun record => record.id != added.id)).take maximumRecords
    }

/-! ## Theorems -/

/-- `store` never keeps a record that holds more than `maximumPaths` paths. -/
theorem store_none_of_too_many (added : Record) (earlier : List Record) (many : pathsOf added > maximumPaths) :
    store added earlier = none := by
  simp [store, many]

/-- `store` refuses exactly the records over the bound: it never returns a history for one, and always for the rest. -/
theorem store_isSome_iff (added : Record) (earlier : List Record) :
    (store added earlier).isSome ↔ pathsOf added ≤ maximumPaths := by
  unfold store
  split <;> simp <;> omega

/-- A stored history never holds a record over the bound at its head. -/
theorem store_head_within (added : Record) (earlier : List Record) (stored : Stored)
    (kept : store added earlier = some stored) : pathsOf added ≤ maximumPaths :=
  (store_isSome_iff added earlier).mp (by simp [kept])

/-- A stored history holds at most `maximumRecords` records. -/
theorem store_length_le (added : Record) (earlier : List Record) (stored : Stored)
    (kept : store added earlier = some stored) : stored.records.length ≤ maximumRecords := by
  unfold store at kept
  split at kept
  · cases kept
  · cases kept
    exact List.length_take_le _ _

/-- The new record is the first of the stored history. -/
theorem store_head (added : Record) (earlier : List Record) (stored : Stored)
    (kept : store added earlier = some stored) : stored.records.head? = some added := by
  unfold store at kept
  split at kept
  · cases kept
  · cases kept
    simp [maximumRecords]

/-- Every stored record is the new one or one of the earlier ones: `store` makes none up. -/
theorem store_subset (added : Record) (earlier : List Record) (stored : Stored)
    (kept : store added earlier = some stored) (record : Record) (held : record ∈ stored.records) :
    record = added ∨ record ∈ earlier := by
  unfold store at kept
  split at kept
  · cases kept
  · cases kept
    have inside := (List.take_sublist maximumRecords _).subset held
    rcases List.mem_cons.mp inside with same | later
    · exact .inl same
    · exact .inr (List.mem_filter.mp later).1

/-- The earlier records keep their order: what follows the new record is a sublist of the earlier ones. -/
theorem store_keeps_order (added : Record) (earlier : List Record) (stored : Stored)
    (kept : store added earlier = some stored) : stored.records.tail.Sublist earlier := by
  unfold store at kept
  split at kept
  · cases kept
  · cases kept
    simp only [maximumRecords, List.take_succ_cons, List.tail_cons]
    exact (List.take_sublist _ _).trans List.filter_sublist

/-- Where the earlier records have distinct ids, so do the stored ones. -/
theorem store_ids_nodup (added : Record) (earlier : List Record) (stored : Stored)
    (distinct : (earlier.map (·.id)).Nodup) (kept : store added earlier = some stored) :
    (stored.records.map (·.id)).Nodup := by
  unfold store at kept
  split at kept
  · cases kept
  · cases kept
    refine List.Nodup.sublist ((List.take_sublist maximumRecords _).map _) ?_
    rw [List.map_cons, List.nodup_cons]
    constructor
    · intro held
      obtain ⟨record, inside, same⟩ := List.mem_map.mp held
      have other := (List.mem_filter.mp inside).2
      simp [same] at other
    · exact List.Nodup.sublist (List.filter_sublist.map _) distinct

end ObservedReadsSpec

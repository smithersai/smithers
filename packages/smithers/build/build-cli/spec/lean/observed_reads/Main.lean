import Lean.Data.Json
import ObservedReadsSpec

/-!
# `observed-reads-spec`: the specification as an oracle

Reads one JSON request a line from standard input, answers each with one JSON line on standard output, and ends
when its input does. `test/ObservedReads.lean-diff.test.ts` starts it once and holds `ObservedReads.ts` against it.

A request is `{"op": <name>, ...}` and its answer `{"r": <result>}`, or `{"error": <why>}` for a request that
cannot be read. A file system is written `{"f": <content>, "x": <bool>}` for a file, `{"d": {<name>: <node>}}`
for a directory and `{"l": <target>}` for a symbolic link.
-/
open Lean (Json ToJson toJson)
open ObservedReadsSpec

def text (value : Json) (key : String) : String := ((field value key).map textOf).getD ""

def names (value : Json) (key : String) : List String := ((field value key).map namesOf).getD []

def flag (value : Json) (key : String) : Bool := field value key == some (.bool true)

def members : Json → List (String × Json)
  | .obj fields => fields.toList
  | _ => []

def orNull {α : Type} [ToJson α] : Option α → Json
  | none => .null
  | some value => toJson value

/-- Reading a tree follows the nesting of its JSON, which Lean cannot see end; it reads no more than it is given. -/
partial def nodeOf (value : Json) : Node :=
  match field value "d", field value "l" with
  | some entries, _ => .dir ((members entries).map fun (name, child) => (name, nodeOf child))
  | none, some target => .symlink (textOf target)
  | none, none => .regular (text value "f") (flag value "x")

def rulesOf (value : Json) : Rules :=
  let rules := (field value "rules").getD .null
  ⟨flag rules "u2", flag rules "u3"⟩

/-- A map from names to texts; a name set to `null` is one the host does not set. -/
def valuesOf (value : Json) : String → Option String :=
  let pairs := members value
  fun name => (pairs.lookup name).bind fun
    | .str held => some held
    | _ => none

def answersOf (value : Json) : String → Option (List String) :=
  let pairs := members value
  fun label => (pairs.lookup label).bind fun
    | .null => none
    | ids => some (namesOf ids)

def worldOfJson (value : Json) : World where
  fs := nodeOf ((field value "fs").getD .null)
  root := text value "root"
  values := valuesOf ((field value "values").getD .null)
  answered := answersOf ((field value "answered").getD .null)
  served := answersOf ((field value "served").getD .null)
  holds := match field value "holds" with
    | some (.arr committed) => fun made => some (made.filter fun name => (committed.toList.map textOf).contains name)
    | _ => fun _ => none
  own := fun path => (names value "own").contains path

def timedOf (value : Json) (key : String) : List (String × Nat) :=
  (((field value key).bind elements).getD []).map fun row =>
    match elements row with
    | some [path, line] => (textOf path, placeOf line)
    | _ => ("", 0)

def traceOf (value : Json) : Trace where
  found := timedOf value "found"
  missing := timedOf value "missing"
  listed := timedOf value "listed"
  made := timedOf value "made"
  emptied := timedOf value "emptied"
  changed := names value "changed"
  removed := names value "removed"
  unlinked := names value "unlinked"

def optionsOf (value : Json) : Options where
  root := text value "root"
  found := (((field value "found").bind elements).getD []).map pairOf
  values := valuesOf ((field value "values").getD .null)
  shown := names value "shown"
  held := match field value "held" with
    | some (.arr committed) => some fun name => (committed.toList.map textOf).contains name
    | _ => none

def addedJson (added : List (String × Nat)) : Json :=
  .arr (added.map fun (name, place) => Json.arr #[.str name, toJson place]).toArray

def pairsJson (pairs : List (String × String)) : Json :=
  .arr (pairs.map fun (one, two) => Json.arr #[.str one, .str two]).toArray

/-- A record as `ObservedReads.ts` writes it. -/
def recordJson (record : Record) : Json :=
  Json.mkObj (
    [("id", .str record.id),
      ("reads", .arr (record.reads.map fun row =>
        Json.arr ((#[.str row.path, .str row.state] : Array Json) ++ (row.other.map Json.str).toArray)).toArray),
      ("lists", .arr (record.lists.map fun row =>
        Json.arr ((#[.str row.path, .str row.digest, toJson row.own] : Array Json) ++
          (row.added.map addedJson).toArray)).toArray)] ++
    (match record.links with
      | none => []
      | some links => [("links", .arr (links.map fun row =>
        Json.arr ((#[.str row.path, toJson row.count, toJson row.own] : Array Json) ++
          (row.added.map addedJson).toArray)).toArray)]) ++
    (if record.left then [("left", .bool true)] else []) ++
    (match record.made with
      | none => []
      | some made => [("made", toJson made)]) ++
    (match record.variables with
      | none => []
      | some variables => [("variables", pairsJson variables)]))

def seenJson : Seen → Json
  | .found path => Json.mkObj [("found", .str path)]
  | .missing path => Json.mkObj [("missing", .str path)]
  | .unreadable argument => Json.mkObj [("unreadable", .str argument)]
  | .other => Json.mkObj [("other", .bool true)]

def errnoJson {α : Type} (shown : α → Json) : Except Errno α → Json
  | .ok value => Json.mkObj [("ok", shown value)]
  | .error code => Json.mkObj [("error", .str code.code)]

def answer (request : Json) : Except String Json :=
  let fs := nodeOf ((field request "fs").getD .null)
  let path := text request "path"
  let rules := rulesOf request
  let value := (field request "value").getD .null
  match text request "op" with
  | "sha256" => .ok (.str (sha256Hex (text request "text")))
  | "heldAs" => .ok (.str (heldAs ((field request "value").bind fun
      | .str held => some held
      | _ => none)))
  | "measure" => .ok (.str (measure fs path))
  | "lstat" => .ok (errnoJson (fun node => match node with
      | .regular content exec => Json.mkObj [("kind", "f"), ("size", toJson content.toUTF8.size), ("x", .bool exec)]
      | .dir entries => Json.mkObj [("kind", "d"), ("nlink", toJson (linkCount (.dir entries)))]
      | .symlink target => Json.mkObj [("kind", "l"), ("target", .str target)]) (lstat fs path))
  | "readdir" => .ok (errnoJson (fun found => toJson (sortByCodeUnit found)) (readdir fs path))
  | "listing" => .ok (orNull (listing fs path (names request "own")))
  | "dirLinks" => .ok (orNull (dirLinks fs path (names request "own")))
  | "isRecord" => .ok (Json.mkObj [
      ("shape", .bool (isRecordShape rules value)),
      ("programs", .bool (programsWellFormed value)),
      ("record", .bool (isRecord rules value))])
  | "pathsOf" => .ok (toJson (pathsOf (decode rules value)))
  | "idOf" => .ok (.str (idOf (decode rules value)))
  | "store" =>
    let added := decode rules ((field request "added").getD .null)
    let earlier := (((field request "earlier").bind elements).getD []).map (decode rules)
    .ok (match store added earlier with
      | none => .null
      | some stored => Json.mkObj [
          ("kind", .str stored.kind),
          ("format", .str stored.format),
          ("ids", toJson (stored.records.map (·.id))),
          ("paths", toJson (stored.records.map pathsOf)),
          ("kept", .arr (stored.records.map fun record => orNull record.kept).toArray)])
  | "pidOf" => .ok (match pidOf (text request "line") with
      | none => .null
      | some (pid, rest) => Json.mkObj [("pid", .str (toString pid)), ("rest", .str rest)])
  | "callOf" => .ok (match callOf (text request "text") with
      | none => .null
      | some call => Json.mkObj [("name", .str call.name), ("body", .str call.body), ("answer", .str call.answer)])
  | "split" => .ok (toJson (split (text request "text")))
  | "spelled" => .ok (.str (spelled path))
  | "unquote" => .ok (orNull (unquote (text request "text")))
  | "openLine" => .ok (seenJson (openLine (text request "cwd") (text request "line")))
  | "changed" =>
    let world := worldOfJson ((field request "world").getD .null)
    .ok (orNull (changed rules world (decode rules ((field request "record").getD .null))))
  | "observe" =>
    let trace := traceOf ((field request "trace").getD .null)
    let options := optionsOf ((field request "options").getD .null)
    .ok (match observe rules fs trace options with
      | .error refusal => Json.mkObj [("refusal", .str refusal)]
      | .ok record => Json.mkObj [("record", recordJson record)])
  | other => .error ("unknown op " ++ other)

partial def serve (input output : IO.FS.Stream) : IO Unit := do
  let line ← input.getLine
  if line.isEmpty then return
  let reply := match Json.parse line with
    | .error why => Json.mkObj [("error", .str why)]
    | .ok request =>
      match answer request with
      | .ok result => Json.mkObj [("r", result)]
      | .error why => Json.mkObj [("error", .str why)]
  output.putStrLn reply.compress
  output.flush
  serve input output

def main : IO Unit := do
  serve (← IO.getStdin) (← IO.getStdout)

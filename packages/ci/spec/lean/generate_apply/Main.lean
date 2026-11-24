import Lean.Data.Json
import GenerateApplySpec

/-!
# The oracle

Reads one JSON request a line from standard input and writes one JSON answer a line to standard output, so a test
starts this program once and asks it thousands of questions. A string is an array of its UTF-16 code units, in a
request and in an answer: JSON text holds no lone surrogate, and the rules specified read code units.
-/

open Lean
open GenerateApplySpec

/-- A string of a request. -/
def unitsOf (json : Json) : Except String Str := do
  (← json.getArr?).toList.mapM fun unit => unit.getNat?

/-- A string of an answer. -/
def ofUnits (text : Str) : Json := toJson text.toArray

/-- A list of strings of a request. -/
def listOf (json : Json) : Except String (List Str) := do
  (← json.getArr?).toList.mapM unitsOf

/-- What a file system call answers: `{"ok": units}` or `{"failed": units}`. -/
def answerOf (json : Json) : Except String Paths.Answer :=
  match json.getObjVal? "ok" with
  | .ok value => return .ok (← unitsOf value)
  | .error _ => return .failed (← unitsOf (← json.getObjVal? "failed"))

/-- What `stat` says. -/
def kindOf (json : Json) : Except String Paths.Kind := do
  match ← json.getStr? with
  | "file" => return .file
  | "directory" => return .directory
  | _ => return .other

/-- The file system of a request: the prefixes it names, and nothing anywhere else. -/
def diskOf (json : Json) : Except String Paths.Disk := do
  let nodes ← (← json.getArr?).toList.mapM fun node => do
    let pre ← unitsOf (← node.getObjVal? "prefix")
    let real ← answerOf (← node.getObjVal? "real")
    let link ← answerOf (← node.getObjVal? "link")
    let kind ← kindOf (← node.getObjVal? "kind")
    return (pre, ({ real, link, kind } : Paths.Node))
  return fun pre =>
    match nodes.find? fun node => node.1 == pre with
    | some node => node.2
    | none => { real := .failed Paths.notFound, link := .failed Paths.notFound, kind := .other }

/-- A place as an answer. -/
def ofPlace : Paths.Place → Json
  | .absent => Json.mkObj [("place", "absent")]
  | .present => Json.mkObj [("place", "present")]
  | .refused why => Json.mkObj [("place", "refused"), ("why", ofUnits why)]

/-- One matrix assignment of a request: `[[name, value], ...]`. -/
def variantOf (json : Json) : Except String Labels.Variant := do
  (← json.getArr?).toList.mapM fun pair => do
    match ← listOf pair with
    | [name, value] => return (name, value)
    | _ => throw "a variant entry is a name and a value"

mutual
  /-- A YAML value of a request. -/
  partial def valueOf (json : Json) : Except String Yaml.Value :=
    match json.getObjVal? "string", json.getObjVal? "int", json.getObjVal? "bool", json.getObjVal? "mapping",
      json.getObjVal? "sequence" with
    | .ok text, _, _, _, _ => return .str (← unitsOf text) (← (← json.getObjVal? "readsBack").getBool?)
    | _, .ok value, _, _, _ => return .int (← value.getInt?)
    | _, _, .ok value, _, _ => return .bool (← value.getBool?)
    | _, _, _, .ok entries, _ => return .mapping (← entriesOf entries)
    | _, _, _, _, .ok items => return .sequence (← itemsOf items)
    | _, _, _, _, _ => throw "a value is a string, an int, a bool, a mapping or a sequence"

  /-- The entries of a mapping of a request. -/
  partial def entriesOf (json : Json) : Except String Yaml.Entries := do
    (← json.getArr?).foldrM (init := Yaml.Entries.nil) fun entry tail => do
      return .cons (← unitsOf (← entry.getObjVal? "key")) (← (← entry.getObjVal? "readsBack").getBool?)
        (← valueOf (← entry.getObjVal? "value")) (← listOf (← entry.getObjVal? "comments")) tail

  /-- The items of a sequence of a request. -/
  partial def itemsOf (json : Json) : Except String Yaml.Items := do
    (← json.getArr?).foldrM (init := Yaml.Items.nil) fun item tail => do
      return .cons (← valueOf (← item.getObjVal? "value")) (← listOf (← item.getObjVal? "comments")) tail
end

/-- The answer to one request. -/
def answer (request : Json) : Except String Json := do
  let text (name : String) : Except String Str := do unitsOf (← request.getObjVal? name)
  match ← (← request.getObjVal? "op").getStr? with
  | "portable" => return toJson (Paths.portable (← text "path"))
  | "prefixes" => return toJson ((Paths.prefixesOf (← text "path")).map ofUnits)
  | "within" => return toJson (Paths.withinRoot (← text "realRoot") (← text "real"))
  | "place" =>
    return ofPlace (Paths.placeOf (← diskOf (← request.getObjVal? "disk")) (← text "realRoot") (← text "path"))
  | "cacheToken" =>
    let flag (name : String) := request.getObjVal? name >>= Json.getBool?
    let secret (name : String) := request.getObjVal? name >>= Json.getStr?
    return toJson (Cache.token (← flag "pullRequest") (← flag "branch") (← flag "defaultName")
      (← secret "read") (← secret "write"))
  | "labels" =>
    let batch ← (← (← request.getObjVal? "batch").getArr?).toList.mapM fun step => do
      return (← unitsOf (← step.getObjVal? "id"), ← variantOf (← step.getObjVal? "variant"))
    match Labels.allocate batch with
    | some labels => return toJson (labels.map ofUnits)
    | none => return Json.null
  | "document" =>
    return ofUnits (Yaml.document (← entriesOf (← request.getObjVal? "entries")) (← listOf (← request.getObjVal? "header")))
  | "key" =>
    return ofUnits (Yaml.mappingHead (← text "key") (← (← request.getObjVal? "readsBack").getBool?)
      (← (← request.getObjVal? "indent").getNat?))
  | "plainShape" => return toJson (Yaml.plainShape (← text "text"))
  | "strip" => return ofUnits (Refusal.stripAnsi (← text "text"))
  | "warning" => return toJson (Refusal.isNodeWarning (← text "text"))
  | "errorLine" => return ofUnits (Refusal.errorLine (← text "text"))
  | "refusedTargets" => return toJson ((Refusal.refusedTargets (← text "text")).map ofUnits)
  | "refusal" => return ofUnits (Refusal.refusalOf (← text "text"))
  | other => throw s!"unknown op {other}"

/-- Answers every line of standard input until it ends. -/
partial def serve (input output : IO.FS.Stream) : IO Unit := do
  let line ← input.getLine
  if line.isEmpty then return
  let reply := match Json.parse line >>= answer with
    | .ok value => Json.mkObj [("ok", value)]
    | .error message => Json.mkObj [("error", message)]
  output.putStrLn reply.compress
  output.flush
  serve input output

def main : IO Unit := do
  serve (← IO.getStdin) (← IO.getStdout)

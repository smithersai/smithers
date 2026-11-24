import Lean.Data.Json
import RepoPathsSpec

/-!
# The oracle: the specification over JSON lines

Reads one JSON request per line from standard input and writes one JSON response per line to standard output, so a
test starts the program once and asks it thousands of questions. A request is `{"op": …, …}`; the response is
`{"ok": …}` or `{"error": …}`.

A text is an array of UTF-16 code units, so a lone surrogate and a NUL survive the trip.
-/

open Lean RepoPathsSpec

abbrev Decode := Except String

def field (json : Json) (name : String) : Decode Json := json.getObjVal? name

def listOf {α : Type} (decode : Json → Decode α) (json : Json) : Decode (List α) := do
  (← json.getArr?).toList.mapM decode

def text (json : Json) : Decode Text := listOf Json.getNat? json

def ofList {α : Type} (encode : α → Json) (values : List α) : Json := Json.arr (values.map encode).toArray

def ofText (value : Text) : Json := ofList (fun (unit : Nat) => toJson unit) value

def ofOption {α : Type} (encode : α → Json) : Option α → Json
  | some value => encode value
  | none => Json.null

def ofTarget (target : LinkTarget) : Json :=
  Json.mkObj [
    ("kind", Json.str (match target.kind with | .tree => "tree" | .blob => "blob")),
    ("path", ofText target.path)]

def answer (op : String) (request : Json) : Decode Json := do
  match op with
  | "parentOf" => pure (ofText (parentOf (← text (← field request "path"))))
  | "ancestorsOf" => pure (ofList ofText (ancestorsOf (← text (← field request "path"))))
  | "directoriesOf" =>
    pure (ofList ofText (directoriesOf (← listOf text (← field request "paths"))
      (← listOf text (← field request "folders"))))
  | "decodeSegment" => pure (ofOption ofText (decodeSegment (← text (← field request "segment"))))
  | "resolveLink" =>
    pure (ofOption ofTarget (resolveLink (← text (← field request "from")) (← text (← field request "href"))
      (← listOf text (← field request "paths")) (← listOf text (← field request "folders"))))
  | other => throw s!"unknown op {other}"

def respond (line : String) : Json :=
  match Json.parse line with
  | .error message => Json.mkObj [("error", Json.str message)]
  | .ok request =>
    match (do answer (← (← field request "op").getStr?) request) with
    | .ok result => Json.mkObj [("ok", result)]
    | .error message => Json.mkObj [("error", Json.str message)]

partial def serve (input output : IO.FS.Stream) : IO Unit := do
  let line ← input.getLine
  if line.isEmpty then return
  output.putStrLn (respond line).compress
  output.flush
  serve input output

def main : IO Unit := do
  serve (← IO.getStdin) (← IO.getStdout)

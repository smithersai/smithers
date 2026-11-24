import Lean.Data.Json
import KeysSpec

/-!
# The oracle: the specification over JSON lines

Reads one JSON request per line from standard input and writes one JSON response per line to standard output, so a
test starts the program once and asks it thousands of questions. A request is `{"op": …, …}`; the response is
`{"ok": …}` or `{"error": …}`.

A text is an array of UTF-16 code units, so a lone surrogate survives the trip. A value is `null`, a boolean,
`{"n": text}` for a number (a whole number in decimal, or `-0`, `nan`, `inf`, `-inf`), `{"s": units}` for a string,
`{"x": name}` for a value JSON has no form for, an array, or `{"o": [[key, value], …]}` for an object, its members
in own-key order.
-/

open Lean (Json toJson)
open KeysSpec hiding Json

abbrev Decode := Except String

def field (json : Json) (name : String) : Decode Json := json.getObjVal? name

def text (json : Json) : Decode Text := do (← json.getArr?).toList.mapM Json.getNat?

def number (source : String) : Decode Number :=
  match source with
  | "-0" => pure .negZero
  | "nan" => pure .nan
  | "inf" => pure .posInf
  | "-inf" => pure .negInf
  | other =>
    match other.toInt? with
    | some value => pure (.int value)
    | none => throw s!"not a number: {other}"

def opaqueOf (name : String) : Decode Opaque :=
  match name with
  | "undefined" => pure .undefined
  | "symbol" => pure .symbol
  | "function" => pure .function
  | "redacted" => pure .redacted
  | "bigint" => pure .bigint
  | "invalidDate" => pure .invalidDate
  | "unsupported" => pure .unsupported
  | "maskedCollection" => pure .maskedCollection
  | other => throw s!"not an opaque value: {other}"

partial def value (json : Json) : Decode Value := do
  match json with
  | .null => pure .null
  | .bool flag => pure (.bool flag)
  | .arr entries =>
    let items ← entries.toList.mapM value
    pure (.arr (items.foldr Items.cons .nil))
  | other =>
    if let .ok source := other.getObjVal? "n" then return .num (← number (← source.getStr?))
    if let .ok units := other.getObjVal? "s" then return .str (← text units)
    if let .ok name := other.getObjVal? "x" then return .opaque (← opaqueOf (← name.getStr?))
    let members ← (← (← field other "o").getArr?).toList.mapM fun entry => do
      let pair ← entry.getArr?
      match pair[0]?, pair[1]? with
      | some key, some member => pure (← text key, ← value member)
      | _, _ => throw "a member is a key and a value"
    pure (.obj (members.foldr (fun member rest => Members.cons member.1 member.2 rest) .nil))

def ofText (units : Text) : Json := Json.arr (units.map fun (unit : Nat) => toJson unit).toArray

def answer (op : String) (request : Json) : Decode Json := do
  match op with
  | "preimage" =>
    match preimage (← value (← field request "value")) with
    | .ok written => pure (Json.mkObj [("text", ofText written)])
    | .error reason => pure (Json.mkObj [("refused", Json.str reason.message)])
  | "isKey" => pure (Json.bool (isKey (← text (← field request "text"))))
  | "digestOf" => pure (ofText (digestOf (← text (← field request "text"))))
  | "lt" => pure (Json.bool (lt (← text (← field request "a")) (← text (← field request "b"))))
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

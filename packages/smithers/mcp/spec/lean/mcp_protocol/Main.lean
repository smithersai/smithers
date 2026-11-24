import Lean.Data.Json
import McpProtocolSpec

/-!
# The oracle: the specification over JSON lines

Reads one JSON request per line from standard input and writes one JSON response per line to standard output, so a
test starts the program once and asks it thousands of questions. A request is `{"op": …, …}`; the response is
`{"ok": …}` or `{"error": …}`.

A text is an array of UTF-16 code units, so a lone surrogate survives the trip. A parsed JSON value is `null`, a
boolean, `{"n": text}` for a number (a whole number in decimal, `fraction` or `nonFinite`), `{"s": units}` for a
string, an array, or `{"o": [[key, value], …]}` for an object, its members in own-key order. A whole number in an
answer is decimal text, so one of any size arrives exactly. A value that may be absent is an array of none or one.
-/

open Lean (toJson)
open McpProtocolSpec hiding Json

abbrev Wire := Lean.Json
abbrev Decode := Except String

def field (json : Wire) (name : String) : Decode Wire := json.getObjVal? name

def listOf {α : Type} (decode : Wire → Decode α) (json : Wire) : Decode (List α) := do
  (← json.getArr?).toList.mapM decode

def text (json : Wire) : Decode Text := listOf Lean.Json.getNat? json

def whole (json : Wire) : Decode Int := do
  match (← json.getStr?).toInt? with
  | some value => pure value
  | none => throw "not a whole number"

def num (source : String) : Decode Num :=
  match source with
  | "fraction" => pure .fraction
  | "nonFinite" => pure .nonFinite
  | other =>
    match other.toInt? with
    | some value => pure (.int value)
    | none => throw s!"not a number: {other}"

partial def value (json : Wire) : Decode McpProtocolSpec.Json := do
  match json with
  | .null => pure .null
  | .bool flag => pure (.bool flag)
  | .arr entries =>
    let items ← entries.toList.mapM value
    pure (.arr (items.foldr Items.cons .nil))
  | other =>
    if let .ok source := other.getObjVal? "n" then return .num (← num (← source.getStr?))
    if let .ok units := other.getObjVal? "s" then return .str (← text units)
    let members ← (← (← field other "o").getArr?).toList.mapM fun entry => do
      let pair ← entry.getArr?
      match pair[0]?, pair[1]? with
      | some key, some member => pure (← text key, ← value member)
      | _, _ => throw "a member is a key and a value"
    pure (.obj (members.foldr (fun member rest => Members.cons member.1 member.2 rest) .nil))

def message (json : Wire) : Decode Members := do
  match ← value json with
  | .obj members => pure members
  | _ => throw "a message is an object"

def ofText (units : Text) : Wire := Lean.Json.arr (units.map fun (unit : Nat) => toJson unit).toArray

def ofWhole (value : Int) : Wire := Lean.Json.str (toString value)

mutual
  partial def ofValue : McpProtocolSpec.Json → Wire
    | .null => Lean.Json.null
    | .bool flag => Lean.Json.bool flag
    | .num (.int whole) => Lean.Json.mkObj [("n", ofWhole whole)]
    | .num .fraction => Lean.Json.mkObj [("n", Lean.Json.str "fraction")]
    | .num .nonFinite => Lean.Json.mkObj [("n", Lean.Json.str "nonFinite")]
    | .str units => Lean.Json.mkObj [("s", ofText units)]
    | .arr items => Lean.Json.arr (ofItems items).toArray
    | .obj members => Lean.Json.mkObj [("o", Lean.Json.arr (ofMembers members).toArray)]

  partial def ofItems : Items → List Wire
    | .nil => []
    | .cons head tail => ofValue head :: ofItems tail

  partial def ofMembers : Members → List Wire
    | .nil => []
    | .cons key member tail => Lean.Json.arr #[ofText key, ofValue member] :: ofMembers tail
end

def ofOptional : Option McpProtocolSpec.Json → Wire
  | none => Lean.Json.arr #[]
  | some present => Lean.Json.arr #[ofValue present]

def ofRequestId : RequestId → Wire
  | .text units => Lean.Json.mkObj [("s", ofText units)]
  | .number whole => Lean.Json.mkObj [("n", ofWhole whole)]

def ofClassification : Classification → Wire
  | .notification => Lean.Json.mkObj [("tag", "Notification")]
  | .request id method params =>
    Lean.Json.mkObj [("tag", "Request"), ("id", ofRequestId id), ("method", ofText method), ("params", ofOptional params)]
  | .result id result => Lean.Json.mkObj [("tag", "Result"), ("id", ofWhole id), ("result", ofValue result)]
  | .error id code text data =>
    Lean.Json.mkObj [("tag", "Error"), ("id", ofWhole id), ("code", ofWhole code), ("message", ofText text),
      ("data", ofOptional data)]
  | .uncorrelatedError code text data =>
    Lean.Json.mkObj [("tag", "UncorrelatedError"), ("code", ofWhole code), ("message", ofText text),
      ("data", ofOptional data)]
  | .malformed reason => Lean.Json.mkObj [("tag", "Malformed"), ("reason", reason)]

def ofAction : Action → Wire
  | .ignore => Lean.Json.mkObj [("do", "ignore")]
  | .resolve id result => Lean.Json.mkObj [("do", "resolve"), ("id", ofWhole id), ("result", ofValue result)]
  | .reject id code => Lean.Json.mkObj [("do", "reject"), ("id", ofWhole id), ("code", ofWhole code)]
  | .report code => Lean.Json.mkObj [("do", "report"), ("code", ofWhole code)]
  | .respond id pong => Lean.Json.mkObj [("do", "respond"), ("id", ofRequestId id), ("pong", pong)]
  | .close reason => Lean.Json.mkObj [("do", "close"), ("reason", reason)]
  | .refuse issue => Lean.Json.mkObj [("do", "refuse"), ("issue", issue.message maxDepth)]

def ofLines (result : Option (List (List Nat))) : Wire :=
  match result with
  | none => Lean.Json.null
  | some made => Lean.Json.arr (made.map ofText).toArray

def answer (op : String) (request : Wire) : Decode Wire := do
  match op with
  | "checkParsed" =>
    match checkParsed (← value (← field request "value")) with
    | none => pure Lean.Json.null
    | some issue => pure (Lean.Json.str (issue.message maxDepth))
  | "isPositiveInteger" => pure (Lean.Json.bool (isPositiveInteger (← num (← (← field request "value").getStr?))))
  | "firstInvalid" =>
    let entries ← listOf (fun entry => do
      let pair ← entry.getArr?
      match pair[0]?, pair[1]? with
      | some name, some option => pure (← text name, ← num (← option.getStr?))
      | _, _ => throw "an option is a name and a value") (← field request "entries")
    match firstInvalid entries with
    | none => pure Lean.Json.null
    | some name => pure (ofText name)
  | "lines" =>
    pure (ofLines (lines (← (← field request "cr").getBool?) (← (← field request "max").getNat?)
      (← listOf text (← field request "chunks"))))
  | "accepts" => pure (Lean.Json.bool (accepts (← value (← field request "value"))))
  | "classify" => pure (ofClassification (classify (← message (← field request "message"))))
  | "replyOf" => pure (ofClassification (replyOf (← message (← field request "message"))))
  | "readAll" =>
    let done := readAll (← listOf whole (← field request "pending")) (← listOf value (← field request "lines"))
    pure (Lean.Json.mkObj [
      ("pending", Lean.Json.arr (done.1.map ofWhole).toArray),
      ("actions", Lean.Json.arr (done.2.map ofAction).toArray)])
  | other => throw s!"unknown op {other}"

def respond (line : String) : Wire :=
  match Lean.Json.parse line with
  | .error complaint => Lean.Json.mkObj [("error", Lean.Json.str complaint)]
  | .ok request =>
    match (do answer (← (← field request "op").getStr?) request) with
    | .ok result => Lean.Json.mkObj [("ok", result)]
    | .error complaint => Lean.Json.mkObj [("error", Lean.Json.str complaint)]

partial def serve (input output : IO.FS.Stream) : IO Unit := do
  let line ← input.getLine
  if line.isEmpty then return
  output.putStrLn (respond line).compress
  output.flush
  serve input output

def main : IO Unit := do
  serve (← IO.getStdin) (← IO.getStdout)

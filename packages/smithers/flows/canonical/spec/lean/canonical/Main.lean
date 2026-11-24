import Lean.Data.Json
import CanonicalSpec

/-!
# The oracle: the specification over JSON lines

Reads one JSON request per line from standard input and writes one JSON response per line to standard output, so a
test starts the program once and asks it thousands of questions. A request is `{"op": …, …}`; the response is
`{"ok": …}` or `{"error": …}`.

A text is an array of UTF-16 code units, so a lone surrogate survives the trip. A value is `null`, a boolean,
`{"n": text}` for a number (a whole number in decimal, or `-0`, `nan`, `inf`, `-inf`), `{"s": units}` for a string,
an array, or `{"o": [[units, value], …]}` for an object in own-key order.
-/

open Lean CanonicalSpec

abbrev Decode := Except String

def field (json : Json) (name : String) : Decode Json := json.getObjVal? name

def listOf {α : Type} (decode : Json → Decode α) (json : Json) : Decode (List α) := do
  (← json.getArr?).toList.mapM decode

def text (json : Json) : Decode Text := listOf Json.getNat? json

/-- An absent or `null` field is no limit. -/
def optionalNat (json : Json) (name : String) : Decode (Option Nat) :=
  match json.getObjVal? name with
  | .ok Json.null => pure none
  | .ok value => do pure (some (← value.getNat?))
  | .error _ => pure none

def number (json : Json) : Decode Number := do
  match ← json.getStr? with
  | "-0" => pure .negZero
  | "nan" => pure .nan
  | "inf" => pure .posInf
  | "-inf" => pure .negInf
  | digits =>
    match digits.toInt? with
    | some value => pure (.int value)
    | none => throw s!"not a covered number: {digits}"

mutual
  partial def value (json : Json) : Decode Value := do
    match json with
    | .null => pure .null
    | .bool flag => pure (.bool flag)
    | .arr entries => do pure (.arr (← items entries.toList))
    | other =>
      match other.getObjVal? "n", other.getObjVal? "s", other.getObjVal? "o" with
      | .ok digits, _, _ => do pure (.num (← number digits))
      | _, .ok units, _ => do pure (.str (← text units))
      | _, _, .ok entries => do pure (.obj (← members (← entries.getArr?).toList))
      | _, _, _ => throw "not a value"

  partial def items : List Json → Decode Items
    | [] => pure .nil
    | head :: tail => do pure (.cons (← value head) (← items tail))

  partial def members : List Json → Decode Members
    | [] => pure .nil
    | head :: tail => do
      match (← head.getArr?).toList with
      | [key, member] => pure (.cons (← text key) (← value member) (← members tail))
      | _ => throw "a member is a key and a value"
end

def limits (json : Json) : Decode Limits := do
  pure {
    maxBytes := ← optionalNat json "maxBytes"
    maxDepth := ← (← field json "maxDepth").getNat?
    maxMembers := ← (← field json "maxMembers").getNat?
    maxTotalMembers := ← optionalNat json "maxTotalMembers"
    maxNodes := ← (← field json "maxNodes").getNat?
    maxStringBytes := ← optionalNat json "maxStringBytes"
    maxKeyBytes := ← optionalNat json "maxKeyBytes" }

def strictLimits (json : Json) : Decode StrictLimits := do
  pure {
    maxBytes := ← (← field json "maxBytes").getNat?
    maxDepth := ← (← field json "maxDepth").getNat?
    maxMembers := ← (← field json "maxMembers").getNat?
    maxNodes := ← (← field json "maxNodes").getNat?
    maxStringBytes := ← (← field json "maxStringBytes").getNat?
    maxKeyBytes := ← (← field json "maxKeyBytes").getNat? }

def ofText (value : Text) : Json := Json.arr (value.map (fun (unit : Nat) => toJson unit)).toArray

def ofRendered : Except Refusal Text → Json
  | .ok rendered => Json.mkObj [("text", ofText rendered)]
  | .error refusal => Json.mkObj [("code", Json.str refusal.code), ("path", ofText refusal.path)]

/-- A path step as plain admission reports it: `String(segment)`. -/
def ofSegment : Segment → Json
  | .key key => ofText key
  | .index index => ofText (decimalNat index)
  | .position index => ofText (decimalNat index)

def answer (op : String) (request : Json) : Decode Json := do
  match op with
  | "canonicalize" =>
    pure (ofRendered (canonicalize (← (← field request "escape").getBool?) (← value (← field request "value"))))
  | "canonicalizeNested" =>
    pure (ofRendered (canonicalize false (nest (← (← field request "depth").getNat?))))
  | "normalizedAgain" =>
    let escape ← (← field request "escape").getBool?
    let tree ← value (← field request "value")
    pure (ofRendered (canonicalize escape (normalize tree)))
  | "encodedStringBytes" =>
    pure (match encodedStringBytes (← text (← field request "text")) (← optionalNat request "maximum") with
      | some bytes => toJson bytes
      | none => Json.null)
  | "admitJson" =>
    let outcome := admitJson (← limits (← field request "limits")) (← (← field request "preflight").getBool?)
      (← value (← field request "value"))
    pure (match outcome with
      | .ok bytes => Json.mkObj [("bytes", toJson bytes)]
      | .error issue =>
        Json.mkObj [
          ("code", Json.str issue.code),
          ("complaint", Json.str issue.complaint),
          ("path", Json.arr (issue.path.map ofSegment).toArray)])
  | "admitStrict" =>
    let outcome := admitStrict (← strictLimits (← field request "limits"))
      (← (← field request "boundedText").getBool?) (← value (← field request "value"))
    pure (match outcome with
      | .ok _ => Json.mkObj [("accepted", Json.bool true)]
      | .error issue =>
        Json.mkObj [("complaint", Json.str issue.complaint), ("path", ofText (pathText issue.path))])
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

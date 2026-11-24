import Lean.Data.Json
import CapabilitySpec

/-!
# The oracle: the specification over JSON lines

Reads one JSON request per line from standard input and writes one JSON response per line to standard output, so a
test starts the program once and asks it thousands of questions. A request is `{"op": …, …}`; the response is
`{"ok": …}` or `{"error": …}`.

A resource is an array of UTF-16 code units, so a lone surrogate survives the trip. An action is its name.
-/

open Lean CapabilitySpec

abbrev Decode := Except String

def field (json : Json) (name : String) : Decode Json := json.getObjVal? name

def listOf {α : Type} (decode : Json → Decode α) (json : Json) : Decode (List α) := do
  (← json.getArr?).toList.mapM decode

def text (json : Json) : Decode Text := listOf Json.getNat? json

def action (json : Json) : Decode Action := do
  let name ← json.getStr?
  match Action.named name with
  | some value => pure value
  | none => throw s!"unknown action {name}"

def selector (json : Json) : Decode Selector := do
  let name ← json.getStr?
  match Selector.named name with
  | some value => pure value
  | none => throw s!"unknown pattern action {name}"

def capability (json : Json) : Decode Capability := do
  pure { action := ← action (← field json "action"), resource := ← text (← field json "resource") }

def pattern (json : Json) : Decode Pattern := do
  pure { action := ← selector (← field json "action"), resource := ← text (← field json "resource") }

def effect (json : Json) : Decode Effect := do
  match ← json.getStr? with
  | "allow" => pure .allow
  | "deny" => pure .deny
  | "ask" => pure .ask
  | other => throw s!"unknown effect {other}"

def rule (json : Json) : Decode Rule := do
  pure { effect := ← effect (← field json "effect"), pattern := ← pattern (← field json "pattern") }

def groups (json : Json) : Decode Groups := listOf (listOf pattern) json

def ofList {α : Type} (encode : α → Json) (values : List α) : Json := Json.arr (values.map encode).toArray

def ofText (value : Text) : Json := ofList (fun (unit : Nat) => toJson unit) value

def ofOption {α : Type} (encode : α → Json) : Option α → Json
  | some value => encode value
  | none => Json.null

def ofPattern (value : Pattern) : Json :=
  Json.mkObj [("action", Json.str value.action.name), ("resource", ofText value.resource)]

def ofCapability (value : Capability) : Json :=
  Json.mkObj [("action", Json.str value.action.name), ("resource", ofText value.resource)]

def ofEffect : Effect → Json
  | .allow => Json.str "allow"
  | .deny => Json.str "deny"
  | .ask => Json.str "ask"

def ofGroups (value : Groups) : Json := ofList (ofList ofPattern) value

/-- The selector ranks agree with the order of the selector names by code unit, for every pair. -/
def ranksAgree : Bool :=
  Selector.all.all fun left => Selector.all.all fun right =>
    decide (left.rank < right.rank) == ltList (units left.name) (units right.name)

def answer (op : String) (request : Json) : Decode Json := do
  match op with
  | "matchesAction" =>
    pure (Json.bool ((← selector (← field request "pattern")).selects (← action (← field request "action"))))
  | "actionSubsumes" =>
    pure (Json.bool ((← selector (← field request "left")).covers (← selector (← field request "right"))))
  | "matchesResource" =>
    pure (Json.bool (matchesResource (← text (← field request "pattern")) (← text (← field request "resource"))))
  | "forms" =>
    pure (ofOption (ofList ofText)
      (forms (← selector (← field request "action")) (← text (← field request "resource"))))
  | "matches" =>
    pure (Json.bool (selected (← pattern (← field request "pattern")) (← capability (← field request "capability"))))
  | "withinMatchBudget" =>
    pure (Json.bool
      (withinMatchBudget (← pattern (← field request "pattern")) (← capability (← field request "capability"))))
  | "subsumes" =>
    pure (Json.bool (subsumes (← pattern (← field request "left")) (← pattern (← field request "right"))))
  | "mayOverlap" =>
    pure (Json.bool (mayOverlap (← pattern (← field request "left")) (← pattern (← field request "right"))))
  | "isLiteralResource" => pure (Json.bool (isLiteral (← text (← field request "resource"))))
  | "patternFromCapability" =>
    pure (ofOption ofPattern (exactPattern (← capability (← field request "capability"))))
  | "format" => pure (ofText (format (← pattern (← field request "pattern"))))
  | "parse" => pure (ofOption ofCapability (parse (← text (← field request "input"))))
  | "parsePattern" => pure (ofOption ofPattern (parsePattern (← text (← field request "input"))))
  | "evaluate" =>
    pure (ofEffect
      (evaluate (← listOf (listOf rule) (← field request "rulesets")) (← capability (← field request "capability"))))
  | "fromGroups" => pure (ofGroups (make (← groups (← field request "groups"))))
  | "intersect" =>
    pure (ofGroups (intersect (make (← groups (← field request "left"))) (make (← groups (← field request "right")))))
  | "allows" =>
    pure (Json.bool (allows (make (← groups (← field request "groups"))) (← capability (← field request "capability"))))
  | "within" =>
    pure (Json.bool (within (make (← groups (← field request "inner"))) (make (← groups (← field request "outer")))))
  | "ranksAgree" => pure (Json.bool ranksAgree)
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

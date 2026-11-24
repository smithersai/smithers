import Lean.Data.Json
import FlowSpec

/-!
# The oracle: the specification over JSON lines

Reads one JSON request per line from standard input and writes one JSON response per line to standard output, so a
test starts the program once and asks it thousands of questions. A request is `{"op": …, …}`; the response is
`{"ok": …}` or `{"error": …}`.

A text is an array of UTF-16 code units, so a lone surrogate survives the trip. A double is the decimal text of its
64 bits, so every double, infinite or not a number, arrives exactly. An absent option is a missing field or `null`.
-/

open Lean FlowSpec

abbrev Decode := Except String

def field (json : Json) (name : String) : Decode Json := json.getObjVal? name

def maybe {α : Type} (json : Json) (name : String) (decode : Json → Decode α) : Decode (Option α) :=
  match json.getObjVal? name with
  | .ok Json.null => pure none
  | .ok value => do pure (some (← decode value))
  | .error _ => pure none

def listOf {α : Type} (decode : Json → Decode α) (json : Json) : Decode (List α) := do
  (← json.getArr?).toList.mapM decode

def item (json : Json) (index : Nat) : Decode Json := do
  match (← json.getArr?)[index]? with
  | some value => pure value
  | none => throw s!"no item {index}"

def text (json : Json) : Decode Text := listOf Json.getNat? json

def float (json : Json) : Decode Float := do
  match (← json.getStr?).toNat? with
  | some value => pure (Float.ofBits value.toUInt64)
  | none => throw "bits are not a decimal number"

def retryable (json : Json) : Decode Retryable := do
  let code ← match ← item json 1 with
    | Json.null => pure none
    | value => do pure (some (← text value))
  pure { tag := ← text (← item json 0), code }

/-- A policy whose numbers are read by `number`: doubles for the implementation, naturals for the exact schedule. -/
def policy {ω : Type} (number : Json → Decode ω) (json : Json) : Decode (Policy ω) := do
  pure {
    initialMs := ← number (← field json "initialMs")
    factor := ← number (← field json "factor")
    maxMs := ← number (← field json "maxMs")
    maxAttempts := ← maybe json "maxAttempts" number
    expirationMs := ← maybe json "expirationMs" number
    jitterRatio := ← maybe json "jitterRatio" number
    nonRetryable := ← maybe json "nonRetryable" (listOf text)
    retryable := ← maybe json "retryable" (listOf retryable) }

def pattern (json : Json) : Decode Pattern := do
  pure { action := ← text (← item json 0), resource := ← text (← item json 1) }

def ceiling (json : Json) : Decode (List (List Text)) := listOf (listOf text) json

def ofList {α : Type} (encode : α → Json) (values : List α) : Json := Json.arr (values.map encode).toArray

def ofText (value : Text) : Json := ofList (fun (unit : Nat) => toJson unit) value

def ofFloat (value : Float) : Json :=
  if value.isNaN then Json.str "nan" else Json.str (toString value.toBits.toNat)

def ofOption {α : Type} (encode : α → Json) : Option α → Json
  | some value => encode value
  | none => Json.null

def ofDecision {ω : Type} (encode : ω → Json) : Decision ω → Json
  | .retryAfter delay => Json.mkObj [("retryAfter", encode delay)]
  | .giveUp reason => Json.mkObj [("giveUp", Json.str reason.name)]

/-- The retry operations over one arithmetic. -/
def retry {ω : Type} [Arith ω] (number : Json → Decode ω) (encode : ω → Json) (op : String) (request : Json) :
    Decode Json := do
  let policy ← policy number (← field request "policy")
  match op with
  | "issue" => pure (ofOption (fun (issue : Field) => Json.str issue.name) (issue policy))
  | "isNonRetryable" =>
    pure (Json.bool (isNonRetryable policy (← maybe request "tag" text) (← maybe request "code" text)))
  | "nextDelay" =>
    pure (ofOption encode (nextDelay policy (← number (← field request "attempt"))
      (← maybe request "random" number) (← maybe request "elapsed" number)))
  | _ =>
    pure (ofDecision encode (decideRetry policy (← number (← field request "attempt"))
      (← maybe request "tag" text) (← maybe request "code" text) (← maybe request "hint" number)
      (← maybe request "random" number) (← maybe request "elapsed" number)))

def answer (op : String) (request : Json) : Decode Json := do
  match op with
  | "issue" | "isNonRetryable" | "nextDelay" | "decide" => retry float ofFloat op request
  | "nextDelayExact" => retry Json.getNat? (fun (value : Nat) => toJson value) "nextDelay" request
  | "decideExact" => retry Json.getNat? (fun (value : Nat) => toJson value) "decide" request
  | "pow" =>
    pure (ofFloat (Arith.pow (← float (← field request "base")) (← (← field request "exponent").getNat?)))
  | "scope" =>
    let kind ← match ← (← field request "kind").getStr? with
      | "action" => pure Kind.action
      | "internal" => pure Kind.internal
      | other => throw s!"unknown kind {other}"
    let idempotency := match ← maybe request "text" text, ← maybe request "object" text with
      | some digest, _ => Idempotency.text digest
      | none, some key => Idempotency.object key
      | none, none => Idempotency.absent
    pure (ofText (scope {
      kind, name := ← text (← field request "name"), idempotency, site := ← maybe request "site" text }))
  | "decimal" => pure (ofText (decimal (← (← field request "value").getNat?)))
  | "parsePattern" =>
    pure (ofOption (fun (parsed : Pattern) => Json.arr #[ofText parsed.action, ofText parsed.resource])
      (parsePattern (← text (← field request "text"))))
  | "intersect" =>
    pure (ofList (ofList ofText)
      (intersectCeilings (← ceiling (← field request "left")) (← ceiling (← field request "right"))))
  | "within" =>
    pure (Json.bool (ceilingWithin (← ceiling (← field request "inner")) (← ceiling (← field request "outer"))))
  | "subsumes" =>
    pure (Json.bool (subsumes (← pattern (← field request "left")) (← pattern (← field request "right"))))
  | "metadata" =>
    pure (ofOption (fun (issue : MetadataIssue) => Json.str issue.name)
      (metadataIssue (Float.ofNat maxSafeInteger) (← text (← field request "tag"))
        (← maybe request "maxRounds" float) (← maybe request "deadline" float)))
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

import Lean.Data.Json
import PatternsSpec

/-!
# The oracle: the specification over JSON lines

Reads one JSON request per line from standard input and writes one JSON response per line to standard output, so a
test starts the program once and asks it thousands of questions. A request is `{"op": …, …}`; the response is
`{"ok": …}` or `{"error": …}`.

A name is an array of UTF-16 code units, so a lone surrogate survives the trip. A number option is whatever JSON the
caller holds: an integral JSON number is an integer and anything else is not a number. A decision value is a tagged
array: `["u"]`, `["n"]`, `["b", true]`, `["i", 3]`, `["s", "text"]`, `["o", [["key", value], …]]`.
-/

open Lean PatternsSpec

abbrev Decode := Except String

def field (json : Json) (name : String) : Decode Json := json.getObjVal? name

def present (json : Json) (name : String) : Option Json :=
  match json.getObjVal? name with
  | .ok Json.null => none
  | .ok value => some value
  | .error _ => none

def listOf {α : Type} (decode : Json → Decode α) (json : Json) : Decode (List α) := do
  (← json.getArr?).toList.mapM decode

def item (json : Json) (index : Nat) : Decode Json := do
  match (← json.getArr?)[index]? with
  | some value => pure value
  | none => throw s!"no item {index}"

def text (json : Json) : Decode Text := listOf Json.getNat? json

def num (json : Json) : Num :=
  match json with
  | Json.num number =>
    let scale : Int := (10 : Int) ^ number.exponent
    if number.mantissa % scale == 0 then .integer (number.mantissa / scale) else .other
  | _ => .other

def nullable {α : Type} (decode : Json → Decode α) (json : Json) : Decode (Option α) :=
  match json with
  | Json.null => pure none
  | value => do pure (some (← decode value))

partial def value (json : Json) : Decode Value := do
  match ← (← item json 0).getStr? with
  | "u" => pure .undefined
  | "n" => pure .null
  | "b" => pure (.bool (← (← item json 1).getBool?))
  | "i" => pure (.int (← (← item json 1).getInt?))
  | "s" => pure (.str (← (← item json 1).getStr?))
  | "o" =>
    let fields ← listOf (fun entry => do pure ((← (← item entry 0).getStr?), ← value (← item entry 1))) (← item json 1)
    pure (.obj fields)
  | other => throw s!"unknown value tag {other}"

def ofList {α : Type} (encode : α → Json) (values : List α) : Json := Json.arr (values.map encode).toArray

def ofText (value : Text) : Json := ofList (fun (unit : Nat) => toJson unit) value

def ofTexts (values : List Text) : Json := ofList ofText values

def ofOption {α : Type} (encode : α → Json) : Option α → Json
  | some value => encode value
  | none => Json.null

def tagged (tag : String) (fields : List (String × Json)) : Json := Json.mkObj (("tag", Json.str tag) :: fields)

/-! ## Saga -/

def sagaPolicy : String → Decode Saga.Policy
  | "compensate" => pure .compensate
  | "compensate-and-fail" => pure .compensateAndFail
  | "fail" => pure .fail
  | other => throw s!"unknown saga policy {other}"

def sagaAction : String → Decode Saga.Action
  | "ok" => pure .ok
  | "fail" => pure .fail
  | "die" => pure .die
  | "interrupt" => pure .interrupt
  | other => throw s!"unknown action {other}"

def sagaUndo : String → Decode Saga.Undo
  | "ok" => pure .ok
  | "fail" => pure .fail
  | "die" => pure .die
  | "throw" => pure .throw
  | other => throw s!"unknown compensation {other}"

def sagaStep (json : Json) : Decode Saga.Step := do
  pure {
    id := ← text (← item json 0)
    action := ← sagaAction (← (← item json 1).getStr?)
    undo := ← sagaUndo (← (← item json 2).getStr?)
    sealed := ← (← item json 3).getBool? }

def ofSagaOutcome : Saga.Outcome → Json
  | .refused .empty => tagged "refused" [("reason", "empty")]
  | .refused .duplicate => tagged "refused" [("reason", "duplicate")]
  | .completed values => tagged "completed" [("values", ofTexts values)]
  | .compensated failure => tagged "compensated" [("failure", ofText failure)]
  | .failed failure => tagged "failed" [("failure", ofText failure)]
  | .died defect => tagged "died" [("defect", ofText defect)]
  | .interrupted reported => tagged "interrupted" [("reported", ofTexts reported)]
  | .dirty residue failure => tagged "dirty" [("residue", ofTexts residue), ("failure", ofOption ofText failure)]

/-! ## Bounded and Quarantine -/

def ofBoundedOutcome : Bounded.Outcome → Json
  | .refused .width => tagged "refused" [("reason", "width")]
  | .refused .empty => tagged "refused" [("reason", "empty")]
  | .refused (.unknown name) => tagged "refused" [("reason", "unknown"), ("name", ofText name)]
  | .refused (.priority name) => tagged "refused" [("reason", "priority"), ("name", ofText name)]
  | .joined names => tagged "joined" [("names", ofTexts names)]
  | .failed name => tagged "failed" [("name", ofText name)]

def quarantinePolicy : String → Decode Quarantine.Policy
  | "quarantine" => pure .quarantine
  | "halt" => pure .halt
  | other => throw s!"unknown quarantine policy {other}"

def ofSettled : Quarantine.Settled → Json
  | .succeeded name => Json.arr #["succeeded", ofText name]
  | .quarantined name => Json.arr #["quarantined", ofText name]

def ofQuarantineOutcome : Quarantine.Outcome → Json
  | .refused .empty => tagged "refused" [("reason", "empty")]
  | .refused .width => tagged "refused" [("reason", "width")]
  | .settled entries => tagged "settled" [("entries", ofList ofSettled entries)]
  | .joined names => tagged "joined" [("names", ofTexts names)]
  | .failed name => tagged "failed" [("name", ofText name)]

def quarantineEntry : String → Decode Quarantine.Entry
  | "succeeded" => pure .succeeded
  | "quarantined" => pure .quarantined
  | "invalid" => pure .invalid
  | other => throw s!"unknown entry {other}"

def ofSettlement : Quarantine.Settlement → Json
  | .invalid names => tagged "invalid" [("names", ofTexts names)]
  | .quarantined names => tagged "quarantined" [("names", ofTexts names)]
  | .values names => tagged "values" [("names", ofTexts names)]

/-! ## ReviewLoop -/

def stallOn : String → Decode ReviewLoop.On
  | "stop" => pure .stop
  | "park" => pure .park
  | "escalate" => pure .escalate
  | other => throw s!"unknown stall action {other}"

def ofOn : ReviewLoop.On → Json
  | .stop => "stop"
  | .park => "park"
  | .escalate => "escalate"

def ofSignal : ReviewLoop.Signal → Json
  | .tree => "tree"
  | .checks => "checks"
  | .output => "output"

def round (json : Json) : Decode ReviewLoop.Round := do
  pure {
    review := ← value (← item json 0)
    observation := {
      tree := ← nullable Json.getNat? (← item json 1)
      checks := ← listOf Json.getNat? (← item json 2)
      output := ← nullable Json.getNat? (← item json 3) } }

def ofVerdict : ReviewLoop.Verdict → Json
  | .refused .maxRounds => tagged "refused" [("reason", "maxRounds")]
  | .refused .stall => tagged "refused" [("reason", "stall")]
  | .approved => tagged "approved" []
  | .exhausted => tagged "exhausted" []
  | .stalled stalled =>
    tagged "stalled" [("signal", ofSignal stalled.signal), ("rounds", toJson stalled.rounds), ("on", ofOn stalled.on)]
  | .escalated rounds => tagged "escalated" [("rounds", toJson rounds)]

/-! ## Escalation and Intervene -/

def rung (json : Json) : Decode Escalation.Rung := do
  pure {
    result := ← value (← item json 0)
    escalateIf := ← nullable value (← item json 1)
    decision := ← value (← item json 2) }

def ofEscalationOutcome : Escalation.Outcome → Json
  | .refused => tagged "refused" []
  | .reached level fallback => tagged "reached" [("level", toJson level), ("fallback", Json.bool fallback)]
  | .exhausted level => tagged "exhausted" [("level", toJson level)]

def phase : String → Decode Intervene.Phase
  | "read" => pure .read
  | "propose" => pure .propose
  | "approval" => pure .approval
  | "apply" => pure .apply
  | "report" => pure .report
  | other => throw s!"unknown phase {other}"

def ofPhase : Intervene.Phase → Json
  | .read => "read"
  | .propose => "propose"
  | .approval => "approval"
  | .apply => "apply"
  | .report => "report"

def ofInterveneOutcome : Intervene.Outcome → Json
  | .reported applied dryRun => tagged "reported" [("applied", Json.bool applied), ("dryRun", Json.bool dryRun)]
  | .denied => tagged "denied" []
  | .failed phase => tagged "failed" [("phase", ofPhase phase)]

/-! ## Requests -/

def answer (op : String) (request : Json) : Decode Json := do
  match op with
  | "saga" =>
    let run := Saga.run (← sagaPolicy (← (← field request "policy").getStr?)) (← listOf sagaStep (← field request "steps"))
    pure (Json.mkObj [
      ("started", ofTexts run.started),
      ("unwound", ofTexts run.unwound),
      ("outcome", ofSagaOutcome run.outcome)])
  | "bounded" =>
    let priorities ← listOf (fun entry => do pure (← text (← item entry 0), num (← item entry 1)))
      (← field request "priorities")
    let run := Bounded.run {
      members := ← listOf text (← field request "members")
      priorities
      fallback := (present request "fallback").map num
      concurrency := num (← field request "concurrency")
      failing := ← listOf text (← field request "failing") }
    pure (Json.mkObj [
      ("started", ofTexts run.started),
      ("peak", toJson run.peak),
      ("batches", ofList ofTexts run.batches),
      ("outcome", ofBoundedOutcome run.outcome)])
  | "quarantine" =>
    let members ← listOf (fun entry => do
      pure ({ name := ← text (← item entry 0), fails := ← (← item entry 1).getBool? } : Quarantine.Member))
      (← field request "members")
    let run := Quarantine.run (← quarantinePolicy (← (← field request "policy").getStr?))
      ((present request "concurrency").map num) members
    pure (Json.mkObj [("started", ofTexts run.started), ("outcome", ofQuarantineOutcome run.outcome)])
  | "settle" =>
    let entries ← listOf (fun entry => do
      pure (← text (← item entry 0), ← quarantineEntry (← (← item entry 1).getStr?)))
      (← field request "entries")
    pure (ofSettlement (Quarantine.settle entries))
  | "reviewLoop" =>
    let stall ← match present request "stall" with
      | none => pure none
      | some stall => do
        let on ← match present stall "on" with
          | none => pure none
          | some on => do pure (some (← stallOn (← on.getStr?)))
        pure (some (num (← field stall "rounds"), on))
    let run := ReviewLoop.run {
      maxRounds := num (← field request "maxRounds")
      stall
      rounds := ← listOf round (← field request "rounds") }
    pure (Json.mkObj [("round", toJson run.round), ("verdict", ofVerdict run.verdict)])
  | "escalation" =>
    let run := Escalation.run (← (← field request "accept").getBool?) (← (← field request "fallback").getBool?)
      (← listOf rung (← field request "rungs"))
    pure (Json.mkObj [
      ("ran", toJson run.ran),
      ("predicated", toJson run.predicated),
      ("asked", toJson run.asked),
      ("outcome", ofEscalationOutcome run.outcome)])
  | "intervene" =>
    let failAt ← match present request "failAt" with
      | none => pure none
      | some name => do pure (some (← phase (← name.getStr?)))
    let approval ← match present request "approval" with
      | none => pure none
      | some decision => do pure (some (← value decision))
    let run := Intervene.run { dryRun := ← (← field request "dryRun").getBool?, approval, failAt }
    pure (Json.mkObj [("calls", ofList ofPhase run.calls), ("outcome", ofInterveneOutcome run.outcome)])
  | "accepted" => pure (Json.bool (accepted (← value (← field request "value"))))
  | "defaultEscalate" => pure (Json.bool (defaultEscalate (← value (← field request "value"))))
  | "sortTexts" => pure (ofTexts (sortTexts (← listOf text (← field request "texts"))))
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

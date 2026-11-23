import Lean.Data.Json
import SelectShardSpec

/-!
# The oracle: the specification over JSON lines

Reads one JSON request per line from standard input and writes one JSON response per line to standard output, so a
test starts the program once and asks it thousands of questions. A request is `{"id": …, "op": …, …}`; the response
is `{"id": …, "ok": …}` or `{"id": …, "error": …}`.

A text is an array of UTF-16 code units, so a lone surrogate survives the trip. A double is the decimal text of its
64 bits, so every double, infinite or not a number, arrives exactly.
-/

open Lean SelectShardSpec

abbrev Decode := Except String

def field (json : Json) (name : String) : Decode Json := json.getObjVal? name

def listOf {α : Type} (decode : Json → Decode α) (json : Json) : Decode (List α) := do
  (← json.getArr?).toList.mapM decode

def item (json : Json) (index : Nat) : Decode Json := do
  match (← json.getArr?)[index]? with
  | some value => pure value
  | none => throw s!"no item {index}"

def text (json : Json) : Decode Text := listOf Json.getNat? json

def bits (json : Json) : Decode Nat := do
  match (← json.getStr?).toNat? with
  | some value => pure value
  | none => throw "bits are not a decimal number"

def float (json : Json) : Decode Float := do
  pure (Float.ofBits (← bits json).toUInt64)

def score (json : Json) : Decode Score := do
  pure { commit := ← text (← item json 0), target := ← text (← item json 1), score := ← bits (← item json 2) }

def row (json : Json) : Decode Row := do
  pure {
    commit := ← text (← item json 0)
    target := ← text (← item json 1)
    failed := ← (← item json 2).getBool?
    flaky := ← (← item json 3).getBool? }

def observation (json : Json) : Decode Observation := do
  pure { time := ← (← item json 0).getInt?, row := ← row (← item json 1) }

def settings (json : Json) : Decode Settings := do
  pure { scoreCutoff := ← bits (← field json "cutoff"), countCutoff := ← (← field json "top").getNat? }

def ofList {α : Type} (encode : α → Json) (values : List α) : Json := Json.arr (values.map encode).toArray

def ofText (value : Text) : Json := ofList (fun (unit : Nat) => toJson unit) value

def ofFloat (value : Float) : Json :=
  if value.isNaN then Json.str "nan" else Json.str (toString value.toBits.toNat)

def ofOption {α : Type} (encode : α → Json) : Option α → Json
  | some value => encode value
  | none => Json.null

def ofRow (value : Row) : Json :=
  Json.arr #[ofText value.commit, ofText value.target, Json.bool value.failed, Json.bool value.flaky]

def ofObservation (value : Observation) : Json := Json.arr #[toJson value.time, ofRow value.row]

def ofCounts (counts : Counts) : Json :=
  Json.mkObj [
    ("rows", toJson counts.rows),
    ("selected", toJson counts.selected),
    ("skipped", toJson counts.skipped),
    ("failures", toJson counts.failures),
    ("failedChanges", toJson counts.failedChanges),
    ("caught", toJson counts.caught),
    ("caughtChanges", toJson counts.caughtChanges),
    ("selectionRate", ofFloat counts.selectionRate),
    ("testRecall", ofOption ofFloat counts.testRecall),
    ("changeRecall", ofOption ofFloat counts.changeRecall)]

def ofPoint (point : Point) : Json :=
  Json.mkObj [
    ("cutoff", Json.str (toString point.settings.scoreCutoff)),
    ("top", toJson point.settings.countCutoff),
    ("metrics", ofCounts point.counts)]

def ofAssigned (assigned : List (Text × Nat)) : Json :=
  ofList (fun entry => Json.arr #[ofText entry.1, toJson entry.2]) assigned

def answer (op : String) (request : Json) : Decode Json := do
  match op with
  | "utf16" => pure (ofText (utf16 (← (← field request "text").getStr?)))
  | "shardOf" =>
    pure (toJson (shardOf (← text (← field request "label")) (← (← field request "count").getNat?)))
  | "labelsOf" =>
    pure (ofList ofText (labelsOf (← listOf text (← field request "labels"))
      (← (← field request "index").getNat?) (← (← field request "count").getNat?)))
  | "assign" =>
    let durations ← listOf (fun entry => do pure (← text (← item entry 0), ← float (← item entry 1)))
      (← field request "durations")
    pure (ofAssigned (assign (← listOf text (← field request "labels")) (← (← field request "count").getNat?)
      (measuredWeight durations)))
  | "assignExact" =>
    let durations ← listOf (fun entry => do pure (← text (← item entry 0), ← (← item entry 1).getNat?))
      (← field request "durations")
    pure (ofAssigned (assign (← listOf text (← field request "labels")) (← (← field request "count").getNat?)
      (exactWeight durations)))
  | "scoreKey" => pure (Json.str (toString (scoreKey (← float (← field request "score")))))
  | "select" =>
    let scores ← listOf score (← field request "scores")
    let settings ← settings request
    pure (Json.mkObj [
      ("selected", ofList ofText (select scores settings)),
      ("skipped", ofList ofText (skipped scores settings))])
  | "selected" =>
    pure (ofList (fun (entry : Text × List Text) => Json.arr #[ofText entry.1, ofList ofText entry.2])
      (selected (← listOf score (← field request "scores")) (← settings request)))
  | "metrics" =>
    let chosen ← listOf (fun entry => do pure (← text (← item entry 0), ← listOf text (← item entry 1)))
      (← field request "selected")
    pure (ofCounts (metrics (← listOf row (← field request "rows")) chosen))
  | "measure" =>
    pure (ofCounts (measure (← listOf row (← field request "rows")) (← listOf score (← field request "scores"))
      (← settings request)))
  | "report" =>
    let report := report (← listOf row (← field request "rows")) (← listOf score (← field request "scores"))
    pure (Json.mkObj [
      ("rows", toJson report.rows),
      ("changes", toJson report.changes),
      ("failures", toJson report.failures),
      ("failedChanges", toJson report.failedChanges),
      ("flaky", toJson report.flaky),
      ("measured", Json.bool report.measured),
      ("start", ofPoint report.start),
      ("byScore", ofList ofPoint report.byScore),
      ("byCount", ofList ofPoint report.byCount),
      ("weekly", ofOption ofPoint report.weekly),
      ("calibrated", ofOption ofPoint report.calibrated)])
  | "split" =>
    let split := split (← listOf observation (← field request "observations"))
    pure (Json.mkObj [
      ("from", toJson split.first),
      ("to", toJson split.last),
      ("history", ofList ofObservation split.history),
      ("test", ofList ofObservation split.test)])
  | "sample" =>
    pure (ofList ofObservation (sample (← listOf observation (← field request "observations"))
      (← (← field request "count").getNat?)))
  | "lowerBound" =>
    pure (ofFloat (lowerBound (← float (← field request "caught")) (← float (← field request "total"))))
  | "lowerBoundOfCounts" =>
    pure (ofFloat (lowerBoundOfCounts (← (← field request "caught").getNat?) (← (← field request "total").getNat?)))
  | "projectOf" => pure (ofText (projectOf (← text (← field request "label"))))
  | "fileChanges" =>
    let history ← listOf (fun entry => do
      pure ({ time := ← (← item entry 0).getInt?, files := ← listOf text (← item entry 1) } : Commit))
      (← field request "history")
    let counts := fileChanges (← listOf text (← field request "files")) (← (← field request "at").getInt?) history
    pure (Json.arr #[toJson counts.1, toJson counts.2.1, toJson counts.2.2])
  | "failureRates" =>
    let rates := failureRates (← (← field request "at").getInt?) (← listOf observation (← field request "runs"))
    pure (ofList (fun (rate : Rate) => Json.arr #[toJson rate.failed, toJson rate.total, ofFloat rate.toFloat]) rates)
  | "graphDistances" =>
    let plan ← match ← field request "plan" with
      | Json.null => pure none
      | targets => do
        pure (some (← listOf (fun entry => do
          pure ({ label := ← text (← item entry 0), dependencies := ← listOf text (← item entry 1) } : PlannedTarget))
          targets))
    pure (ofList (fun (entry : Text × Int) => Json.arr #[ofText entry.1, toJson entry.2])
      (graphDistances (← listOf text (← field request "files")) (← listOf text (← field request "targets")) plan))
  | other => throw s!"unknown op {other}"

def respond (line : String) : Json :=
  match Json.parse line with
  | .error message => Json.mkObj [("id", Json.null), ("error", Json.str message)]
  | .ok request =>
    let id := (request.getObjVal? "id").toOption.getD Json.null
    match (do answer (← (← field request "op").getStr?) request) with
    | .ok result => Json.mkObj [("id", id), ("ok", result)]
    | .error message => Json.mkObj [("id", id), ("error", Json.str message)]

partial def serve (input output : IO.FS.Stream) : IO Unit := do
  let line ← input.getLine
  if line.isEmpty then return
  output.putStrLn (respond line).compress
  output.flush
  serve input output

def main : IO Unit := do
  serve (← IO.getStdin) (← IO.getStdout)

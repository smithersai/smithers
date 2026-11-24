import Lean.Data.Json
import JournalSpec

/-!
# The oracle: the specification over JSON lines

Reads one JSON request per line from standard input and writes one JSON response per line to standard output, so a
test starts the program once and asks it thousands of questions. A request is `{"op": …, …}`; the response is
`{"ok": …}` or `{"error": …}`.

A payload is an array of UTF-16 code units, so a lone surrogate survives the trip. An entry is
`[seq, source, sourceSeq, units]` and a checkpoint is `[seq, state, compacted]`.
-/

open Lean JournalSpec

abbrev Decode := Except String

def field (json : Json) (name : String) : Decode Json := json.getObjVal? name

def nat (json : Json) (name : String) : Decode Nat := do (← field json name).getNat?

/-- An absent or `null` field is none. -/
def optionalNat (json : Json) (name : String) : Decode (Option Nat) :=
  match json.getObjVal? name with
  | .ok Json.null => pure none
  | .ok value => do pure (some (← value.getNat?))
  | .error _ => pure none

def text (json : Json) : Decode Text := do (← json.getArr?).toList.mapM Json.getNat?

def call (json : Json) : Decode Op := do
  match ← (← field json "t").getStr? with
  | "hold" => pure (.hold (← nat json "owner"))
  | "release" => pure .release
  | "restart" => pure .restart
  | "emit" =>
    pure (.emit (← optionalNat json "owner") (← nat json "source") (← optionalNat json "sourceSeq")
      (← text (← field json "payload")) (← optionalNat json "steal"))
  | "checkpoint" => pure (.checkpoint (← nat json "seq") (← nat json "state") (← nat json "owner"))
  | "compact" => pure (.compact (← optionalNat json "upTo") (← nat json "owner"))
  | "entries" =>
    pure (.entries (← optionalNat json "after") (← nat json "limit") (← (← field json "descending").getBool?))
  | "latestCheckpoint" => pure .latestCheckpoint
  | other => throw s!"unknown call {other}"

def ofOption {α : Type} (encode : α → Json) : Option α → Json
  | some value => encode value
  | none => Json.null

def ofNat (value : Nat) : Json := toJson value

def ofEntry (entry : Entry) : Json :=
  Json.arr #[ofNat entry.seq, ofNat entry.source, ofNat entry.sourceSeq, Json.arr (entry.content.map ofNat).toArray]

def ofCheckpoint (checkpoint : Checkpoint) : Json :=
  Json.arr #[ofNat checkpoint.seq, ofNat checkpoint.state, Json.bool checkpoint.compacted]

def ofList {α : Type} (encode : α → Json) (values : List α) : Json := Json.arr (values.map encode).toArray

def ofOutcome : Outcome → Json
  | .done => Json.null
  | .accepted seq sourceSeq =>
    Json.mkObj [("tag", Json.str "Accepted"), ("seq", ofNat seq), ("sourceSeq", ofNat sourceSeq)]
  | .duplicate seq sourceSeq =>
    Json.mkObj [("tag", Json.str "Duplicate"), ("seq", ofNat seq), ("sourceSeq", ofNat sourceSeq)]
  | .failed code checkpointSeq => Json.mkObj [("error", Json.str code), ("checkpointSeq", ofOption ofNat checkpointSeq)]
  | .checkpointed seq state => Json.mkObj [("checkpoint", Json.arr #[ofNat seq, ofNat state, Json.bool false])]
  | .compacted checkpointSeq deleted =>
    Json.mkObj [("checkpointSeq", ofNat checkpointSeq), ("deleted", ofNat deleted)]
  | .page entries hasMore => Json.mkObj [("entries", ofList ofEntry entries), ("hasMore", Json.bool hasMore)]
  | .latest checkpoint => Json.mkObj [("latest", ofOption ofCheckpoint checkpoint)]

/-- Rows as a table holds them: in sequence order. -/
def bySeq {α : Type} (seq : α → Nat) (rows : List α) : List α :=
  (rows.toArray.qsort (fun left right => seq left < seq right)).toList

def answer (op : String) (request : Json) : Decode Json := do
  match op with
  | "entryBytes" => pure (ofNat (entryBytes (← text (← field request "payload"))))
  | "run" =>
    let config : Config :=
      { maxEntryBytes := ← nat request "maxEntryBytes", threshold := ← optionalNat request "threshold" }
    let calls ← (← (← field request "calls").getArr?).toList.mapM call
    let (outcomes, journal) := run config calls .empty
    pure (Json.mkObj [
      ("outcomes", ofList ofOutcome outcomes),
      ("entries", ofList ofEntry journal.entries),
      ("retired", ofList (fun (row : Entry) => Json.arr #[ofNat row.seq, ofNat row.source, ofNat row.sourceSeq])
        (bySeq (·.seq) journal.retired)),
      ("checkpoints", ofList ofCheckpoint (bySeq (·.seq) journal.checkpoints))])
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

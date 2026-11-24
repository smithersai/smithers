import Lean.Data.Json
import TimeTravelSpec

/-!
# The oracle: the specification over JSON lines

Reads one JSON request per line from standard input and writes one JSON response per line to standard output, so a
test starts the program once and asks it thousands of questions. A request is `{"op": …, …}`; the response is
`{"ok": …}` or `{"error": …}`.

A record crosses as `[run, seq, eventId, lineage | null, eventType | null]`, an edge as
`[parent, parentSeq, child, kind, attached]`, and an owner as `[host, pid, nonce]`.
-/

open Lean TimeTravelSpec

abbrev Decode := Except String

def field (json : Json) (name : String) : Decode Json := json.getObjVal? name

def listOf {α : Type} (decode : Json → Decode α) (json : Json) : Decode (List α) := do
  (← json.getArr?).toList.mapM decode

def item (json : Json) (index : Nat) : Decode Json := do
  match (← json.getArr?)[index]? with
  | some value => pure value
  | none => throw s!"no item {index}"

def orNull {α : Type} (decode : Json → Decode α) (json : Json) : Decode (Option α) :=
  if json.isNull then pure none else some <$> decode json

def kindOf : String → Decode EdgeKind
  | "child" => pure .child
  | "fork" => pure .fork
  | "continuation" => pure .continuation
  | other => throw s!"unknown edge kind {other}"

def kindText : EdgeKind → String
  | .child => "child"
  | .fork => "fork"
  | .continuation => "continuation"

def record (json : Json) : Decode Record := do
  pure {
    run := ← (← item json 0).getStr?
    seq := ← (← item json 1).getNat?
    eventId := ← (← item json 2).getStr?
    lineage := ← orNull Json.getStr? (← item json 3)
    eventType := ← orNull Json.getStr? (← item json 4) }

def edge (json : Json) : Decode Edge := do
  pure {
    parent := ← (← item json 0).getStr?
    parentSeq := ← (← item json 1).getNat?
    child := ← (← item json 2).getStr?
    kind := ← kindOf (← (← item json 3).getStr?)
    attached := ← (← item json 4).getBool? }

def owner (json : Json) : Decode Owner := do
  pure { host := ← (← item json 0).getStr?, pid := ← (← item json 1).getNat?, nonce := ← (← item json 2).getStr? }

def keyed {α : Type} (decode : Json → Decode α) (json : Json) : Decode (String × α) := do
  pure (← (← item json 0).getStr?, ← decode (← item json 1))

def state (json : Json) : Decode State := do
  pure {
    records := ← listOf record (← field json "records")
    archived := []
    bumps := []
    edges := ← listOf edge (← field json "edges")
    intents := []
    live := ← listOf Json.getStr? (← field json "live")
    statuses := ← listOf (keyed Json.getBool?) (← field json "statuses")
    owners := ← listOf (keyed owner) (← field json "owners") }

def optionJson (value : Option String) : Json :=
  match value with
  | none => Json.null
  | some text => Json.str text

def recordJson (r : Record) : Json :=
  Json.arr #[Json.str r.run, toJson r.seq, Json.str r.eventId, optionJson r.lineage, optionJson r.eventType]

def edgeJson (e : Edge) : Json :=
  Json.arr #[Json.str e.parent, toJson e.parentSeq, Json.str e.child, Json.str (kindText e.kind), Json.bool e.attached]

def listJson {α : Type} (encode : α → Json) (values : List α) : Json := Json.arr (values.map encode).toArray

def stateJson (s : State) : Json :=
  Json.mkObj [
    ("records", listJson recordJson s.records),
    ("archived", listJson (fun entry => Json.arr #[recordJson entry.1, toJson entry.2]) s.archived),
    ("edges", listJson edgeJson s.edges),
    ("intents", listJson (fun i => Json.arr #[Json.str i.child, Json.str i.parent, toJson i.parentSeq]) s.intents)]

def failed (code : String) : Json := Json.mkObj [("error", Json.str code)]

def done (value : Json) : Json := Json.mkObj [("ok", value)]

/-- One store call: the state it leaves and what it answered. A refused call leaves the state as it was. -/
def step (s : State) (json : Json) : Decode (State × Json) := do
  match ← (← field json "do").getStr? with
  | "rewind" =>
    let outcome := rewind s (← (← field json "run").getStr?) (← (← field json "lineage").getStr?)
      (← (← field json "seq").getNat?) (← owner (← field json "owner"))
      (← listOf (keyed owner) (← field json "childOwners"))
    match outcome with
    | .error code => pure (s, failed code)
    | .ok rewound =>
      pure (rewound.state,
        done (Json.mkObj [("archived", toJson rewound.archived), ("orphaned", listJson edgeJson rewound.orphaned)]))
  | "fork" =>
    let outcome := fork s (← (← field json "parent").getStr?) (← (← field json "lineage").getStr?)
      (← (← field json "seq").getNat?) (← orNull Json.getStr? (← field json "child"))
    match outcome with
    | .error code => pure (s, failed code)
    | .ok (next, id) => pure (next, done (Json.str id))
  | "reserve" =>
    let (next, id) := reserve s (← (← field json "parent").getStr?) (← (← field json "seq").getNat?)
    pure (next, done (Json.str id))
  | "append" =>
    match append s (← record (← field json "record")) with
    | .error code => pure (s, failed code)
    | .ok next => pure (next, done Json.null)
  | "archivedAt" =>
    pure (s, done (Json.bool (archivedAt s (← (← field json "run").getStr?) (← (← field json "seq").getNat?)
      (← orNull Json.getNat? (← field json "generation")))))
  | "descendants" =>
    let walk := descendants s.edges (← (← field json "run").getStr?) (← (← field json "seq").getNat?)
    pure (s, done (Json.mkObj [
      ("attached", listJson edgeJson walk.attached), ("detached", listJson edgeJson walk.detached)]))
  | other => throw s!"unknown step {other}"

def steps (s : State) : List Json → Decode (State × List Json)
  | [] => pure (s, [])
  | json :: rest => do
    let (next, answer) ← step s json
    let (final, answers) ← steps next rest
    pure (final, answer :: answers)

def answer (request : Json) : Decode Json := do
  match ← (← field request "op").getStr? with
  | "descendants" =>
    let walk := descendants (← listOf edge (← field request "edges")) (← (← field request "run").getStr?)
      (← (← field request "seq").getNat?)
    pure (Json.mkObj [
      ("attached", listJson edgeJson walk.attached),
      ("detached", listJson edgeJson walk.detached),
      ("drained", Json.bool walk.queue.isEmpty)])
  | "run" =>
    let (final, answers) ← steps (← state (← field request "state")) (← (← field request "steps").getArr?).toList
    pure (Json.mkObj [("answers", Json.arr answers.toArray), ("state", stateJson final)])
  | other => throw s!"unknown op {other}"

def respond (line : String) : Json :=
  match Json.parse line >>= answer with
  | .ok value => Json.mkObj [("ok", value)]
  | .error message => Json.mkObj [("error", Json.str message)]

partial def serve (input output : IO.FS.Stream) : IO Unit := do
  let line ← input.getLine
  if line.isEmpty then return
  output.putStrLn (respond line).compress
  output.flush
  serve input output

def main : IO Unit := do
  serve (← IO.getStdin) (← IO.getStdout)

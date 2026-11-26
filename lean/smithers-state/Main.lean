import Lean.Data.Json
import SmithersState

/-!
# JSON trace oracle

Reads one JSON trace per line on stdin and writes one JSON result per line on
stdout, then a trailer line. A trace is `{"seed": n, "detail": bool, "replicas": n, "ops": [...]}`; `detail` adds
the per-op result codes and the full final world to the output line.
Each op runs the proven functions of `SmithersState` (`submit`, `bumpEpoch`,
`applyCommit`, `installSnapshot`, `rebasePending`) and yields a short result code.
After every op the oracle folds the result code and the canonical JSON of the
state the op touched into an FNV-1a 32-bit digest. `@smthrs/app-state` computes
the same codes and the same digest; `test/DifferentialFuzz.test.ts` compares them.

Ops:
* `{"op":"submit","epoch":e,"origin":o,"commandId":c,"command":{…}}`
* `{"op":"bumpEpoch"}`
* `{"op":"deliver","replica":i,"from":k,"count":n}`: commits at log index `k … k+n-1`
* `{"op":"resync","replica":i}`: install the authority's snapshot
* `{"op":"rebase","replica":i,"pending":[{…}]}`
-/

open Lean (Json toJson)
open SmithersState

namespace Oracle

def optStrJ : Option String → Json
  | none => Json.null
  | some s => Json.str s

def optNatJ : Option Nat → Json
  | none => Json.null
  | some n => toJson n

def strsJ (xs : List String) : Json := Json.arr (xs.map Json.str).toArray

def str (j : Json) (k : String) : Except String String := do
  (← j.getObjVal? k).getStr?

def nat (j : Json) (k : String) : Except String Nat := do
  (← j.getObjVal? k).getNat?

def optStr (j : Json) (k : String) : Except String (Option String) := do
  let v ← j.getObjVal? k
  if v.isNull then pure none else pure (some (← v.getStr?))

def optNat (j : Json) (k : String) : Except String (Option Nat) := do
  let v ← j.getObjVal? k
  if v.isNull then pure none else pure (some (← v.getNat?))

def strs (j : Json) (k : String) : Except String (List String) := do
  let a ← (← j.getObjVal? k).getArr?
  a.toList.mapM (fun x => x.getStr?)

/-- An optional key: absent means `none`. TypeScript's canonical JSON omits absent fields. -/
def keyStr (j : Json) (k : String) : Except String (Option String) :=
  match j.getObjVal? k with
  | .ok v => do pure (some (← v.getStr?))
  | .error _ => pure none

def keyNat (j : Json) (k : String) : Except String (Option Nat) :=
  match j.getObjVal? k with
  | .ok v => do pure (some (← v.getNat?))
  | .error _ => pure none

def parsePart (j : Json) : Except String MessagePart := do
  pure { id := ← str j "id", flow := ← str j "flow", status := ← str j "status" }

def keyParts (j : Json) (k : String) : Except String (Option (List MessagePart)) :=
  match j.getObjVal? k with
  | .ok v => do pure (some (← (← v.getArr?).toList.mapM parsePart))
  | .error _ => pure none

def parseOrigin (j : Json) : Except String MessageOrigin := do
  pure {
    role := ← keyStr j "role", questionId := ← keyStr j "questionId",
    position := ← keyNat j "position", createdAt := ← keyStr j "createdAt" }

def parseRun (j : Json) : Except String MessageRun := do
  pure {
    parts := ← keyParts j "parts", failure := ← keyStr j "failure",
    modelId := ← keyStr j "modelId", stopReason := ← keyStr j "stopReason",
    inputTokens := ← keyNat j "inputTokens", outputTokens := ← keyNat j "outputTokens" }

def parseNotes (j : Json) : Except String MessageNotes := do
  pure {
    summary := ← keyStr j "summary", summaryRevision := ← keyStr j "summaryRevision",
    phase := ← keyStr j "phase", arc := ← keyStr j "arc", updatedAt := ← keyStr j "updatedAt" }

/-- The fields that hold a value. An absent field has no key in the output. -/
def present (fields : List (String × Option Json)) : List (String × Json) :=
  fields.filterMap (fun (k, v) => v.map (fun j => (k, j)))

def partJ (p : MessagePart) : Json :=
  Json.mkObj [("id", p.id), ("kind", "step"), ("flow", p.flow), ("status", p.status)]

def originJ (o : MessageOrigin) : List (String × Json) :=
  present [("role", o.role.map Json.str), ("questionId", o.questionId.map Json.str),
    ("position", o.position.map toJson), ("createdAt", o.createdAt.map Json.str)]

def runJ (r : MessageRun) : List (String × Json) :=
  present [("parts", r.parts.map (fun ps => Json.arr (ps.map partJ).toArray)),
    ("failure", r.failure.map Json.str), ("modelId", r.modelId.map Json.str),
    ("stopReason", r.stopReason.map Json.str), ("inputTokens", r.inputTokens.map toJson),
    ("outputTokens", r.outputTokens.map toJson)]

def notesJ (n : MessageNotes) : List (String × Json) :=
  present [("summary", n.summary.map Json.str),
    ("summaryRevision", n.summaryRevision.map Json.str), ("phase", n.phase.map Json.str),
    ("arc", n.arc.map Json.str), ("updatedAt", n.updatedAt.map Json.str)]

/-- Required fields, typed so that optional ones can be appended. -/
def fields (xs : List (String × Json)) : List (String × Json) := xs

def parseCommand (j : Json) : Except String Command := do
  let tag ← str j "_tag"
  match tag with
  | "UpsertPlanNode" =>
    pure (.upsertPlanNode (← str j "id") (← optStr j "parent") (← str j "title")
      (← str j "milestone") (← strs j "sources") (← strs j "assumptions")
      (← str j "dodFast") (← nat j "order") (← optNat j "expectedRevision"))
  | "MovePlanNode" =>
    pure (.movePlanNode (← str j "id") (← optStr j "newParent") (← nat j "order")
      (← optNat j "expectedRevision"))
  | "ToggleAssumption" =>
    pure (.toggleAssumption (← str j "nodeId") (← nat j "index") (← optNat j "expectedRevision"))
  | "SetNodeStatus" =>
    pure (.setNodeStatus (← str j "nodeId") (← str j "status") (← optNat j "expectedRevision"))
  | "AttachArtifact" =>
    pure (.attachArtifact (← str j "nodeId") (← str j "artifactId") (← optNat j "expectedRevision"))
  | "PostMessage" =>
    pure (.postMessage (← str j "messageId") (← str j "author") (← str j "body")
      (← parseOrigin j) (← parseRun j) (← parseNotes j))
  | "UpdateMessageStatus" =>
    pure (.updateMessageStatus (← str j "messageId") (← str j "status"))
  | "UpdateMessageMetadata" =>
    pure (.updateMessageMetadata (← str j "messageId") (← parseRun j) (← parseNotes j))
  | other => throw s!"unknown command tag {other}"

def commandJ : Command → Json
  | .upsertPlanNode id parent title milestone sources assumptions dodFast order exp =>
    Json.mkObj [("_tag", "UpsertPlanNode"), ("id", id), ("parent", optStrJ parent),
      ("title", title), ("milestone", milestone), ("sources", strsJ sources),
      ("assumptions", strsJ assumptions), ("dodFast", dodFast), ("order", toJson order),
      ("expectedRevision", optNatJ exp)]
  | .movePlanNode id newParent order exp =>
    Json.mkObj [("_tag", "MovePlanNode"), ("id", id), ("newParent", optStrJ newParent),
      ("order", toJson order), ("expectedRevision", optNatJ exp)]
  | .toggleAssumption nodeId index exp =>
    Json.mkObj [("_tag", "ToggleAssumption"), ("nodeId", nodeId), ("index", toJson index),
      ("expectedRevision", optNatJ exp)]
  | .setNodeStatus nodeId status exp =>
    Json.mkObj [("_tag", "SetNodeStatus"), ("nodeId", nodeId), ("status", status),
      ("expectedRevision", optNatJ exp)]
  | .attachArtifact nodeId artifactId exp =>
    Json.mkObj [("_tag", "AttachArtifact"), ("nodeId", nodeId), ("artifactId", artifactId),
      ("expectedRevision", optNatJ exp)]
  | .postMessage messageId author body origin run notes =>
    Json.mkObj (fields [("_tag", "PostMessage"), ("messageId", messageId), ("author", author),
      ("body", body)] ++ originJ origin ++ runJ run ++ notesJ notes)
  | .updateMessageStatus messageId status =>
    Json.mkObj [("_tag", "UpdateMessageStatus"), ("messageId", messageId), ("status", status)]
  | .updateMessageMetadata messageId run notes =>
    Json.mkObj (fields [("_tag", "UpdateMessageMetadata"), ("messageId", messageId)]
      ++ runJ run ++ notesJ notes)

def eventJ : Event → Json
  | .planNodeCreated id parent title milestone sources assumptions dodFast order =>
    Json.mkObj [("_tag", "PlanNodeCreated"), ("id", id), ("parent", optStrJ parent),
      ("title", title), ("milestone", milestone), ("sources", strsJ sources),
      ("assumptions", strsJ assumptions), ("dodFast", dodFast), ("order", toJson order)]
  | .planNodeUpdated id title milestone sources assumptions dodFast =>
    Json.mkObj [("_tag", "PlanNodeUpdated"), ("id", id), ("title", title),
      ("milestone", milestone), ("sources", strsJ sources),
      ("assumptions", strsJ assumptions), ("dodFast", dodFast)]
  | .planNodeMoved id parent order =>
    Json.mkObj [("_tag", "PlanNodeMoved"), ("id", id), ("parent", optStrJ parent),
      ("order", toJson order)]
  | .assumptionToggled id index =>
    Json.mkObj [("_tag", "AssumptionToggled"), ("id", id), ("index", toJson index)]
  | .nodeStatusSet id status =>
    Json.mkObj [("_tag", "NodeStatusSet"), ("id", id), ("status", status)]
  | .artifactAttached id artifactId =>
    Json.mkObj [("_tag", "ArtifactAttached"), ("id", id), ("artifactId", artifactId)]
  | .messagePosted id author body origin run notes =>
    Json.mkObj (fields [("_tag", "MessagePosted"), ("id", id), ("author", author), ("body", body)]
      ++ originJ origin ++ runJ run ++ notesJ notes)
  | .messageStatusUpdated id status =>
    Json.mkObj [("_tag", "MessageStatusUpdated"), ("id", id), ("status", status)]
  | .messageMetadataUpdated id run notes =>
    Json.mkObj (fields [("_tag", "MessageMetadataUpdated"), ("id", id)]
      ++ runJ run ++ notesJ notes)

def nodeJ (n : PlanNode) : Json :=
  Json.mkObj [("id", n.id), ("parent", optStrJ n.parent), ("title", n.title),
    ("milestone", n.milestone), ("status", n.status), ("sources", strsJ n.sources),
    ("assumptions", Json.arr (n.assumptions.map (fun a =>
      Json.mkObj [("text", a.text), ("verified", Json.bool a.verified)])).toArray),
    ("dodFast", n.dodFast), ("artifactIds", strsJ n.artifactIds), ("order", toJson n.order)]

def appStateJ (s : AppState) : Json :=
  Json.mkObj [
    ("plan", Json.mkObj [("revision", toJson s.plan.revision),
      ("nodes", Json.mkObj (s.plan.nodes.map (fun n => (n.id, nodeJ n))))]),
    ("chat", Json.mkObj [("messages", Json.arr (s.chat.messages.map (fun m =>
      Json.mkObj (fields [("id", m.id), ("author", m.author), ("body", m.body),
        ("status", m.status), ("hubSeq", toJson m.hubSeq)]
        ++ originJ m.origin ++ runJ m.run ++ notesJ m.notes))).toArray)])]

def commitJ (c : Commit) : Json :=
  Json.mkObj [("hubSeq", toJson c.hubSeq), ("epoch", toJson c.epoch), ("origin", c.origin),
    ("commandId", c.commandId), ("event", eventJ c.event)]

def receiptKey (origin commandId : String) : String :=
  (Json.arr #[Json.str origin, Json.str commandId]).compress

def hubJ (s : ShardState) : Json :=
  Json.mkObj [("epoch", toJson s.epoch), ("headSeq", toJson s.headSeq),
    ("state", appStateJ s.state),
    ("receipts", Json.mkObj (s.receipts.map (fun r =>
      (receiptKey r.origin r.commandId,
        Json.mkObj [("origin", r.origin), ("commandId", r.commandId),
          ("command", commandJ r.command), ("firstSeq", toJson r.firstSeq),
          ("count", toJson r.count)])))),
    ("log", Json.arr (s.log.map commitJ).toArray)]

def replicaJ (r : Replica) : Json :=
  Json.mkObj [("epoch", toJson r.epoch), ("cursor", toJson r.cursor),
    ("confirmed", appStateJ r.confirmed)]

structure World where
  hub : ShardState
  replicas : Array Replica

def World.init (replicas : Nat) : World :=
  { hub := ShardState.init, replicas := Array.replicate replicas Replica.init }

def worldJ (w : World) : Json :=
  Json.mkObj [("hub", hubJ w.hub), ("replicas", Json.arr (w.replicas.map replicaJ))]

def fnv (h : UInt32) (s : String) : UInt32 :=
  s.toUTF8.foldl (fun h b => (h ^^^ b.toUInt32) * 16777619) h

def fnvInit : UInt32 := 2166136261

def submitCode : SubmitResult → String
  | .accepted f c => s!"A:{f}:{c}"
  | .duplicate f c => s!"D:{f}:{c}"
  | .refused r => s!"R:{r}"
  | .epochMismatch e => s!"E:{e}"

def applyCode : ApplyResult → String
  | .applied => "a"
  | .duplicate => "d"
  | .gap => "g"
  | .staleEpoch => "s"
  | .epochAhead => "h"

def decisionCode : Decision → String
  | .accepted evs => s!"a{evs.length}"
  | .refused r => s!"r:{r}"

def replicaAt (w : World) (i : Nat) : Except String Replica :=
  match w.replicas[i]? with
  | some r => pure r
  | none => throw s!"no replica {i}"

/-- Run one op. Returns the new world, the result code, and the JSON of what it touched. -/
def runOp (w : World) (op : Json) : Except String (World × String × Json) := do
  let kind ← str op "op"
  match kind with
  | "submit" =>
    let env : Envelope := {
      epoch := ← nat op "epoch", origin := ← str op "origin",
      commandId := ← str op "commandId", command := ← parseCommand (← op.getObjVal? "command") }
    let (hub, res) := submit w.hub env
    pure ({ w with hub := hub }, submitCode res, hubJ hub)
  | "bumpEpoch" =>
    let hub := bumpEpoch w.hub
    pure ({ w with hub := hub }, s!"B:{hub.epoch}", hubJ hub)
  | "deliver" =>
    let i ← nat op "replica"
    let r ← replicaAt w i
    let commits := (w.hub.log.drop (← nat op "from")).take (← nat op "count")
    let (r, codes) := commits.foldl (fun (acc : Replica × String) c =>
      let (r', res) := applyCommit acc.1 c
      (r', acc.2 ++ applyCode res)) (r, "")
    pure ({ w with replicas := w.replicas.set! i r }, "V:" ++ codes, replicaJ r)
  | "resync" =>
    let i ← nat op "replica"
    let r ← replicaAt w i
    let r := installSnapshot r w.hub.epoch w.hub.headSeq w.hub.state
    pure ({ w with replicas := w.replicas.set! i r }, s!"S:{r.epoch}:{r.cursor}", replicaJ r)
  | "rebase" =>
    let i ← nat op "replica"
    let r ← replicaAt w i
    let pending ← (← (← op.getObjVal? "pending").getArr?).toList.mapM parseCommand
    let (st, ds) := rebasePending r.confirmed pending
    pure (w, "P:" ++ ",".intercalate (ds.map decisionCode), appStateJ st)
  | other => throw s!"unknown op {other}"

def runTrace (line : String) : Except String Json := do
  let j ← Json.parse line
  let seed ← nat j "seed"
  let detail ← (← j.getObjVal? "detail").getBool?
  let replicas ← nat j "replicas"
  let ops ← (← j.getObjVal? "ops").getArr?
  let mut w := World.init replicas
  let mut digest := fnvInit
  let mut results : Array Json := #[]
  for op in ops do
    let (w', code, touched) ← runOp w op
    w := w'
    digest := fnv (fnv digest code) touched.compress
    results := results.push (Json.str code)
  let final := worldJ w
  let base := [("seed", toJson seed), ("inputFnv", toJson (fnv fnvInit line).toNat),
    ("ops", toJson ops.size), ("digest", toJson digest.toNat),
    ("finalFnv", toJson (fnv fnvInit final.compress).toNat)]
  pure (Json.mkObj
    (if detail then base ++ [("results", Json.arr results), ("final", final)] else base))

partial def loop (stdin : IO.FS.Stream) (n : Nat) : IO Nat := do
  let line ← stdin.getLine
  if line.isEmpty then
    return n
  else if line == "\n" then
    loop stdin n
  else
    match runTrace line with
    | .ok out =>
      IO.println out.compress
      loop stdin (n + 1)
    | .error e =>
      throw (IO.userError s!"trace {n}: {e}")

end Oracle

def main : IO UInt32 := do
  let stdin ← IO.getStdin
  let n ← Oracle.loop stdin 0
  IO.println (Json.mkObj [("trailer", Json.bool true), ("traces", toJson n),
    ("oracle", "lean/smithers-state Main.lean"), ("lean", Lean.versionString)]).compress
  return 0

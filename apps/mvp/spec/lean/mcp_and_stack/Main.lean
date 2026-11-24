import Lean.Data.Json
import McpAndStackSpec

/-!
# The oracle: the specification over JSON lines

Reads one JSON request per line from standard input and writes one JSON response per line to standard output, so a
test starts the program once and asks it thousands of questions. A request is `{"op": …, …}`; the response is
`{"ok": …}` or `{"error": …}`.

A tool name, an act, a token and a header are arrays of UTF-16 code units, so a lone surrogate survives the trip. A
TODO's id is a JSON string.
-/

open Lean McpAndStackSpec

abbrev Decode := Except String

def field (json : Json) (name : String) : Decode Json := json.getObjVal? name

def listOf {α : Type} (decode : Json → Decode α) (json : Json) : Decode (List α) := do
  (← json.getArr?).toList.mapM decode

def nullable {α : Type} (decode : Json → Decode α) : Json → Decode (Option α)
  | Json.null => pure none
  | json => some <$> decode json

def text (json : Json) : Decode Text := listOf Json.getNat? json

def roleOf (json : Json) : Decode Role := do
  match ← json.getStr? with
  | "guest" => pure .guest
  | "member" => pure .member
  | "maintainer" => pure .maintainer
  | "admin" => pure .admin
  | other => throw s!"unknown role {other}"

def actorOf (json : Json) : Decode Actor := do
  pure { role := ← nullable roleOf (← field json "role"), agent := ← (← field json "agent").getBool? }

def principalOf (json : Json) : Decode Principal := do
  pure {
    read := ← (← field json "read").getBool?
    write := ← (← field json "write").getBool?
    actOk := ← (← field json "actOk").getBool?
    pinnedElsewhere := ← (← field json "pinnedElsewhere").getBool? }

def stateOf (json : Json) : Decode TodoState := do
  match ← json.getStr? with
  | "queued" => pure .queued
  | "working" => pure .working
  | "in_review" => pure .inReview
  | "merged" => pure .merged
  | "dropped" => pure .dropped
  | "failed" => pure .failed
  | other => throw s!"unknown state {other}"

def baseOf (json : Json) : Decode Base := do
  match ← json.getStr? with
  | "stacked" => pure .stacked
  | "independent" => pure .independent
  | other => throw s!"unknown base {other}"

def rowOfJson (json : Json) : Decode Row := do
  pure {
    id := ← (← field json "id").getStr?
    number := ← (← field json "number").getNat?
    state := ← stateOf (← field json "state")
    position := ← nullable Json.getNat? (← field json "position")
    attempt := ← (← field json "attempt").getNat?
    revision := ← (← field json "revision").getNat?
    after := ← nullable Json.getStr? (← field json "after")
    baseClosed := ← nullable Json.getBool? (← field json "baseClosed") }

def stackOf (json : Json) : Decode Stack := do
  pure {
    nextNumber := ← (← field json "nextNumber").getNat?
    lanes := ← (← field json "lanes").getNat?
    maxOpen := ← (← field json "maxOpen").getNat?
    base := ← baseOf (← field json "base")
    todos := ← listOf rowOfJson (← field json "todos") }

def finishedOf (json : Json) : Decode Finished := do
  match ← json.getStr? with
  | "merged" => pure .merged
  | "dropped" => pure .dropped
  | "failed" => pure .failed
  | other => throw s!"unknown ending {other}"

/-- A commit's `after`: the string `"base"` when the change names none, `null`, or a number. -/
def commitAfterOf : Json → Decode CommitAfter
  | Json.null => pure .none
  | Json.str "base" => pure .base
  | json => .number <$> json.getInt?

def opOf (json : Json) : Decode Op := do
  match ← (← field json "kind").getStr? with
  | "commit" => pure (.commit (← (← field json "id").getStr?) (← commitAfterOf (← field json "after")))
  | "drop" => pure (.drop (← (← field json "number").getInt?))
  | "retry" => pure (.retry (← (← field json "number").getInt?))
  | "configure" =>
    pure (.configure (← (← field json "lanes").getNat?) (← (← field json "maxOpen").getNat?)
      (← baseOf (← field json "base")))
  | "publish" => pure (.publish (← (← field json "id").getStr?) (← (← field json "ordinal").getInt?))
  | "finish" =>
    pure (.finish (← (← field json "id").getStr?) (← (← field json "ordinal").getInt?)
      (← finishedOf (← field json "state")))
  | other => throw s!"unknown change {other}"

def ofList {α : Type} (encode : α → Json) (values : List α) : Json := Json.arr (values.map encode).toArray

def ofOption {α : Type} (encode : α → Json) : Option α → Json
  | some value => encode value
  | none => Json.null

def ofText (value : Text) : Json := ofList (fun (unit : Nat) => toJson unit) value

def ofRole : Role → Json
  | .guest => "guest"
  | .member => "member"
  | .maintainer => "maintainer"
  | .admin => "admin"

def ofOutcome : Outcome → Json
  | .ok => "ok"
  | .personOnly => "person_only"
  | .notFound => "not_found"
  | .authentication => "authentication"
  | .forbidden => "forbidden"

def ofState : TodoState → Json
  | .queued => "queued"
  | .working => "working"
  | .inReview => "in_review"
  | .merged => "merged"
  | .dropped => "dropped"
  | .failed => "failed"

def ofBase : Base → Json
  | .stacked => "stacked"
  | .independent => "independent"

def ofFinished : Finished → Json
  | .merged => "merged"
  | .dropped => "dropped"
  | .failed => "failed"

def ofRefusal : Refusal → Json
  | .stackFull => "stack_full"
  | .merged => "merged"
  | .notFound => "not_found"
  | .stale => "stale"
  | .notRetryable => "not_retryable"
  | .afterNotOpen => "after_not_open"

def ofRow (row : Row) : Json :=
  Json.mkObj [
    ("id", row.id),
    ("number", toJson row.number),
    ("state", ofState row.state),
    ("position", ofOption (fun (value : Nat) => toJson value) row.position),
    ("attempt", toJson row.attempt),
    ("revision", toJson row.revision),
    ("after", ofOption Json.str row.after),
    ("baseClosed", ofOption Json.bool row.baseClosed)]

def ofStack (stack : Stack) : Json :=
  Json.mkObj [
    ("nextNumber", toJson stack.nextNumber),
    ("lanes", toJson stack.lanes),
    ("maxOpen", toJson stack.maxOpen),
    ("base", ofBase stack.base),
    ("todos", ofList ofRow stack.todos)]

def ofStart (start : Start) : Json :=
  Json.mkObj [
    ("todoId", start.todoId),
    ("number", toJson start.number),
    ("ordinal", toJson start.ordinal),
    ("revision", toJson start.revision)]

def ofResult : Result → Json
  | .committed number position starts =>
    Json.mkObj [("kind", "committed"), ("number", toJson number), ("position", toJson position),
      ("starts", ofList ofStart starts)]
  | .dropped number changed stopped starts =>
    Json.mkObj [("kind", "dropped"), ("number", toJson number), ("changed", Json.bool changed),
      ("stopped", ofOption (fun (entry : String × Nat) =>
        Json.mkObj [("todoId", entry.1), ("ordinal", toJson entry.2)]) stopped),
      ("starts", ofList ofStart starts)]
  | .published number starts =>
    Json.mkObj [("kind", "published"), ("number", toJson number), ("starts", ofList ofStart starts)]
  | .finished number state starts =>
    Json.mkObj [("kind", "finished"), ("number", toJson number), ("state", ofFinished state),
      ("starts", ofList ofStart starts)]
  | .retried number starts =>
    Json.mkObj [("kind", "retried"), ("number", toJson number), ("starts", ofList ofStart starts)]
  | .configured starts => Json.mkObj [("kind", "configured"), ("starts", ofList ofStart starts)]
  | .refused code => Json.mkObj [("kind", "refused"), ("code", ofRefusal code)]

def ofStep (step : Stack × Result) : Json := Json.mkObj [("stack", ofStack step.1), ("result", ofResult step.2)]

def ofBearer : Bearer → Json
  | .absent => "absent"
  | .malformed => "malformed"
  | .token value => ofText value

def answer (op : String) (request : Json) : Decode Json := do
  match op with
  | "rankOf" => pure (toJson (rankOf (← nullable roleOf (← field request "role"))))
  | "access" =>
    let actor ← actorOf request
    let present ← (← field request "present").getBool?
    pure (Json.mkObj [
      ("memberOrAbove", Json.bool (memberOrAbove actor.role)),
      ("mayRead", Json.bool (mayRead (if present then some actor else none))),
      ("mayChange", Json.bool (mayChange actor)),
      ("mayConfigure", Json.bool (mayConfigure actor)),
      ("mayRetryAny", Json.bool (mayRetryAny actor)),
      ("via", match viaOf actor with | .person => "person" | .agent => "agent")])
  | "blockedActs" => pure (ofList ofText blockedActs)
  | "blocked" =>
    let name ← text (← field request "name")
    pure (Json.mkObj [
      ("name", Json.bool (isBlockedName name)),
      ("act", Json.bool (isBlockedMcpAct name)),
      ("canonical", ofText (canonical name))])
  | "catalog" =>
    pure (ofList (fun (spec : ToolSpec) => Json.arr #[ofText spec.name, Json.bool (spec.access == .write),
      ofOption ofRole spec.minimum]) catalog)
  | "listTools" =>
    pure (ofList ofText (listTools (← nullable principalOf (← field request "principal"))
      (← (← field request "inRepo").getBool?) (← nullable roleOf (← field request "role"))
      (← (← field request "isPublic").getBool?)))
  | "callOutcome" =>
    pure (ofOutcome (callOutcome (← text (← field request "name"))
      (← nullable principalOf (← field request "principal")) (← nullable roleOf (← field request "role"))
      (← (← field request "isPublic").getBool?)))
  | "tokenFormat" => pure (Json.bool (isValidTokenFormat (← text (← field request "token"))))
  | "parseBearer" => pure (ofBearer (parseBearer (← nullable text (← field request "header"))))
  | "apply" => pure (ofStep (apply (← stackOf (← field request "stack")) (← opOf (← field request "change"))))
  | "run" =>
    pure (ofList ofStep (run (← stackOf (← field request "stack")) (← listOf opOf (← field request "changes"))))
  | "stackView" =>
    let stack ← stackOf (← field request "stack")
    pure (Json.mkObj [
      ("open", ofList (fun (row : Row) => Json.str row.id) (openOf stack)),
      ("ready", ofList Json.bool (stack.todos.map (isReady stack.todos))),
      ("violations", ofList Json.str (violations stack))])
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

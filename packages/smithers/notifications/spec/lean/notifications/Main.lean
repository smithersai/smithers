import Lean.Data.Json
import NotificationsSpec

/-!
# The oracle: the specification over JSON lines

Reads one JSON request per line from standard input and writes one JSON response per line to standard output, so a
test starts the program once and asks it thousands of questions. A request is `{"op": …, …}`; the response is
`{"ok": …}` or `{"error": …}`.

A text is an array of UTF-16 code units, so a lone surrogate survives the trip. A double is the decimal text of its
64 bits. An absent value is `null`.
-/

open Lean NotificationsSpec

abbrev Decode := Except String

def field (json : Json) (name : String) : Decode Json := json.getObjVal? name

def listOf {α : Type} (decode : Json → Decode α) (json : Json) : Decode (List α) := do
  (← json.getArr?).toList.mapM decode

def item (json : Json) (index : Nat) : Decode Json := do
  match (← json.getArr?)[index]? with
  | some value => pure value
  | none => throw s!"no item {index}"

def maybe {α : Type} (decode : Json → Decode α) : Json → Decode (Option α)
  | Json.null => pure none
  | json => some <$> decode json

def text (json : Json) : Decode Text := listOf Json.getNat? json

def float (json : Json) : Decode Float := do
  match (← json.getStr?).toNat? with
  | some value => pure (Float.ofBits value.toUInt64)
  | none => throw "bits are not a decimal number"

def ofList {α : Type} (encode : α → Json) (values : List α) : Json := Json.arr (values.map encode).toArray

def ofText (value : Text) : Json := ofList (fun (unit : Nat) => toJson unit) value

def ofOption {α : Type} (encode : α → Json) : Option α → Json
  | some value => encode value
  | none => Json.null

def ofFloat (value : Float) : Json :=
  if value.isNaN then Json.str "nan" else Json.str (toString value.toBits.toNat)

/-! ## The queue -/

def tag (json : Json) : Decode Tag := do
  match ← json.getStr? with
  | "human-steer" => pure .humanSteer
  | "human-followup" => pure .humanFollowup
  | "system-event" => pure .systemEvent
  | other => throw s!"unknown tag {other}"

def ofTag : Tag → Json
  | .humanSteer => "human-steer"
  | .humanFollowup => "human-followup"
  | .systemEvent => "system-event"

def payload (json : Json) : Decode Payload := do
  let token ← (← field json "token").getNat?
  if ← (← field json "record").getBool? then pure (.record (← maybe text (← field json "kind")) token)
  else pure (.other token)

def ofPayload : Payload → Json
  | .record kind token =>
    Json.mkObj [("record", Json.bool true), ("kind", ofOption ofText kind), ("token", toJson token)]
  | .other token => Json.mkObj [("record", Json.bool false), ("kind", Json.null), ("token", toJson token)]

def notification (json : Json) : Decode Notification := do
  pure {
    tag := ← tag (← field json "tag")
    id := ← text (← field json "id")
    lineage := ← text (← field json "lineage")
    key := ← maybe text (← field json "key")
    payload := ← payload (← field json "payload") }

def ofNotification (value : Notification) : Json :=
  Json.mkObj [
    ("tag", ofTag value.tag),
    ("id", ofText value.id),
    ("lineage", ofText value.lineage),
    ("key", ofOption ofText value.key),
    ("payload", ofPayload value.payload)]

def pendingItem (json : Json) : Decode Pending := do
  pure { notification := ← notification (← field json "notification"), seq := ← (← field json "seq").getInt? }

def ofPending (value : Pending) : Json :=
  Json.mkObj [("notification", ofNotification value.notification), ("seq", toJson value.seq)]

def state (json : Json) : Decode State := do
  pure { capacity := ← (← field json "capacity").getNat?, items := ← listOf pendingItem (← field json "items") }

def ofState (value : State) : Json :=
  Json.mkObj [("capacity", toJson value.capacity), ("items", ofList ofPending value.items)]

def decision (json : Json) : Decode Decision := do
  match ← json.getStr? with
  | "admitted" => pure .admitted
  | "coalesced" => pure .coalesced
  | "rejected-full" => pure .rejectedFull
  | other => throw s!"unknown decision {other}"

def ofDecision : Decision → Json
  | .admitted => "admitted"
  | .coalesced => "coalesced"
  | .rejectedFull => "rejected-full"

def delivery (json : Json) : Decode Delivery := do
  match ← json.getStr? with
  | "steer" => pure .steer
  | "queue" => pure .queue
  | other => throw s!"unknown admission class {other}"

def ofPromotion (value : Promotion) : Json :=
  Json.mkObj [("state", ofState value.state), ("promoted", ofList ofPending value.promoted)]

def entry (json : Json) : Decode Entry := do
  let eventType ← match ← (← field json "type").getStr? with
    | "admitted" => pure EntryType.admitted
    | "promoted" => pure EntryType.promoted
    | "other" => pure EntryType.other
    | other => throw s!"unknown entry type {other}"
  let body ← field json "body"
  let body ← match ← (← field body "kind").getStr? with
    | "admitted" =>
      pure (Body.admitted (← notification (← field body "notification")) (← decision (← field body "decision"))
        (← (← field body "versioned").getBool?))
    | "promoted" => pure (Body.promoted (← listOf text (← field body "ids")))
    | "undecodable" => pure Body.undecodable
    | other => throw s!"unknown body {other}"
  pure { eventType, sourceId := ← text (← field json "sourceId"), seq := ← (← field json "seq").getInt?, body }

/-! ## Alert policy -/

def severity (json : Json) : Decode Severity := do
  match ← json.getStr? with
  | "info" => pure .info
  | "warning" => pure .warning
  | "critical" => pure .critical
  | other => throw s!"unknown severity {other}"

def ofSeverity : Severity → Json
  | .info => "info"
  | .warning => "warning"
  | .critical => "critical"

def named {α : Type} (decode : Json → Decode α) (json : Json) : Decode (Text × α) := do
  pure (← text (← item json 0), ← decode (← item json 1))

def detector (json : Json) : Decode Detector := do
  pure {
    field := ← text (← field json "field")
    value := ← text (← field json "value")
    eventTypes := ← maybe (listOf text) (← field json "eventTypes")
    summary := ← maybe text (← field json "summary") }

def rule (json : Json) : Decode Rule := do
  pure {
    afterMs := ← (← field json "afterMs").getInt?
    repeatMs := ← maybe Json.getInt? (← field json "repeatMs")
    severity := ← maybe severity (← field json "severity")
    owner := ← maybe text (← field json "owner")
    runbook := ← maybe text (← field json "runbook") }

def defaults (json : Json) : Decode Defaults := do
  pure {
    severity := ← maybe severity (← field json "severity")
    owner := ← maybe text (← field json "owner")
    runbook := ← maybe text (← field json "runbook") }

def policy (json : Json) : Decode Policy := do
  pure {
    defaults := ← maybe defaults (← field json "defaults")
    rules := ← listOf (named rule) (← field json "rules")
    detectors := ← listOf (named detector) (← field json "detectors") }

def alertEntry (json : Json) : Decode AlertEntry := do
  pure {
    eventType := ← text (← field json "eventType")
    emittedAtMs := ← (← field json "at").getInt?
    payload := ← maybe (listOf (named (maybe text))) (← field json "payload") }

def openCondition (json : Json) : Decode Open := do
  pure {
    runId := ← text (← field json "runId")
    condition := ← text (← field json "condition")
    since := ← (← field json "since").getInt?
    summary := ← maybe text (← field json "summary") }

def ofOpen (value : Open) : Json :=
  Json.mkObj [
    ("runId", ofText value.runId),
    ("condition", ofText value.condition),
    ("since", toJson value.since),
    ("summary", ofOption ofText value.summary)]

def ofAlert (value : Alert) : Json :=
  Json.mkObj [
    ("runId", ofText value.runId),
    ("condition", ofText value.condition),
    ("since", toJson value.since),
    ("firedAt", toJson value.firedAt),
    ("reminder", ofOption (fun (count : Int) => toJson count) value.reminder),
    ("severity", ofSeverity value.severity),
    ("coalescingKey", ofText value.coalescingKey),
    ("summary", ofOption ofText value.summary),
    ("owner", ofOption ofText value.owner),
    ("runbook", ofOption ofText value.runbook),
    ("id", ofText (alertId value.coalescingKey value.since value.reminder))]

/-! ## Inbox -/

def level (json : Json) : Decode Level := do
  match ← json.getStr? with
  | "all" => pure .all
  | "attention" => pure .attention
  | "muted" => pure .muted
  | other => throw s!"unknown level {other}"

def runState (json : Json) : Decode RunState := do
  match ← json.getStr? with
  | "working" => pure .working
  | "waiting" => pure .waiting
  | "needs_you" => pure .needsYou
  | "failed" => pure .failed
  | "done" => pure .done
  | other => throw s!"unknown run state {other}"

def ofRunState : RunState → Json
  | .working => "working"
  | .waiting => "waiting"
  | .needsYou => "needs_you"
  | .failed => "failed"
  | .done => "done"

def watcher (json : Json) : Decode Watcher := do
  pure { principal := ← text (← item json 0), level := ← level (← item json 1) }

/-- Who may read: everyone when no list is given, else everyone but the listed. -/
def mayRead (json : Json) : Decode (Text → Bool) := do
  match ← maybe (listOf text) json with
  | none => pure (fun _ => true)
  | some blocked => pure (fun principal => !blocked.contains principal)

def act (json : Json) : Decode Act := do
  match ← json.getStr? with
  | "read" => pure .read
  | "dismiss" => pure .dismiss
  | "hide" => pure .hide
  | other => throw s!"unknown act {other}"

def versions (json : Json) : Decode Versions := do
  pure {
    version := ← (← item json 0).getInt?
    readVersion := ← (← item json 1).getInt?
    dismissedVersion := ← (← item json 2).getInt?
    hiddenVersion := ← (← item json 3).getInt? }

def ofVersions (value : Versions) : Json :=
  Json.mkObj [
    ("notice", Json.arr #[toJson value.version, toJson value.readVersion, toJson value.dismissedVersion,
      toJson value.hiddenVersion]),
    ("open", Json.bool (isOpen value)),
    ("unread", Json.bool (isUnread value)),
    ("hidden", Json.bool (isHidden value))]

def answer (op : String) (request : Json) : Decode Json := do
  match op with
  | "normalizeCapacity" => pure (ofFloat (normalizedCapacity (← float (← field request "capacity"))))
  | "classify" =>
    let value ← notification (← field request "notification")
    pure (Json.mkObj [
      ("admission", match admissionClass value with | .steer => "steer" | .queue => "queue"),
      ("coalesceKey", ofOption ofText (coalesceKey value))])
  | "admitOne" =>
    let admission := admitOne (← state (← field request "state")) (← notification (← field request "notification"))
      (← (← field request "seq").getInt?)
    pure (Json.mkObj [("state", ofState admission.state), ("decision", ofDecision admission.decision)])
  | "applyAdmission" =>
    pure (ofState (applyAdmission (← state (← field request "state"))
      (← notification (← field request "notification")) (← (← field request "seq").getInt?)
      (← decision (← field request "decision"))))
  | "pending" =>
    pure (ofList ofPending (pending (← state (← field request "state")) (← delivery (← field request "admission"))
      (← maybe text (← field request "lineage"))))
  | "promoteSteers" =>
    pure (ofPromotion (promoteSteers (← state (← field request "state"))
      (← maybe Json.getInt? (← field request "cutoff")) (← maybe text (← field request "lineage"))))
  | "promoteIds" =>
    pure (ofPromotion (promoteIds (← state (← field request "state")) (← listOf text (← field request "ids"))
      (← maybe text (← field request "lineage"))))
  | "promoteQueued" =>
    pure (ofPromotion (promoteQueued (← state (← field request "state"))
      (← maybe text (← field request "lineage"))))
  | "applyPromoted" =>
    pure (ofState (applyPromoted (← state (← field request "state")) (← listOf text (← field request "ids"))))
  | "derive" => pure (ofState (derive (← listOf entry (← field request "entries"))))
  | "names" =>
    pure (Json.bool (names (← listOf text (← field request "eventTypes")) (← text (← field request "eventType"))))
  | "conditions" =>
    pure (ofList ofOpen (conditions (← policy (← field request "policy")) (← text (← field request "runId"))
      (← listOf alertEntry (← field request "entries"))))
  | "decide" =>
    pure (ofOption (ofList ofAlert) (decideAlerts (← policy (← field request "policy"))
      (← listOf openCondition (← field request "open")) (← (← field request "now").getInt?)))
  | "coalescingKey" =>
    pure (ofOption ofText (coalescingKey (← text (← field request "runId")) (← text (← field request "condition"))))
  | "recordSourceId" =>
    pure (ofText (recordSourceId (← text (← field request "id")) (← text (← field request "outcome"))))
  | "route" =>
    let told := route (← maybe text (← field request "launcher")) (← runState (← field request "state"))
      (← listOf watcher (← field request "watchers")) (← mayRead (← field request "blocked"))
    pure (ofList (fun (each : Told) => Json.mkObj [
      ("recipient", ofText each.recipient),
      ("mine", Json.bool each.mine),
      ("state", ofRunState each.state),
      ("quiet", Json.bool each.quiet)]) told)
  | "audience" =>
    pure (ofList ofText (audience (← listOf watcher (← field request "watchers"))
      (← mayRead (← field request "blocked"))))
  | "raises" =>
    pure (Json.bool (raises (← maybe runState (← field request "before")) (← runState (← field request "after"))))
  | "ack" =>
    pure (ofVersions (ack (← versions (← field request "notice")) (← act (← field request "act"))
      (← (← field request "version").getInt?)))
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

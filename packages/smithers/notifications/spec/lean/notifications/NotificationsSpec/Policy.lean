import NotificationsSpec.State

/-!
# Alert and routing policy: the reference specification of `src/AlertPolicy.ts` and `src/Inbox.ts`

`AlertPolicy` decides which conditions a journal leaves open and which of them have outlived their delay. `Inbox`
decides who is told about a run and how loudly, and how far a person's read, dismiss and hide marks advance.
Everything here is pure, and times are whole milliseconds.
-/

namespace NotificationsSpec

/-! ## `encodeURIComponent` -/

/-- A unit `encodeURIComponent` keeps: a letter, a digit, or one of `-_.!~*'()`. -/
def isUnreserved (c : Nat) : Bool :=
  (65 ≤ c && c ≤ 90) || (97 ≤ c && c ≤ 122) || (48 ≤ c && c ≤ 57) ||
    c == 45 || c == 95 || c == 46 || c == 33 || c == 126 || c == 42 || c == 39 || c == 40 || c == 41

/-- An upper-case hexadecimal digit. -/
def hexDigit (value : Nat) : Nat := if value < 10 then 48 + value else 55 + value

/-- One byte as `%XX`. -/
def percent (byte : Nat) : Text := [37, hexDigit (byte / 16), hexDigit (byte % 16)]

/-- A code point as its percent-encoded UTF-8 bytes. -/
def percentUtf8 (point : Nat) : Text :=
  if point < 128 then percent point
  else if point < 2048 then percent (192 + point / 64) ++ percent (128 + point % 64)
  else if point < 65536 then
    percent (224 + point / 4096) ++ percent (128 + point / 64 % 64) ++ percent (128 + point % 64)
  else
    percent (240 + point / 262144) ++ percent (128 + point / 4096 % 64) ++ percent (128 + point / 64 % 64)
      ++ percent (128 + point % 64)

def isHighSurrogate (c : Nat) : Bool := 55296 ≤ c && c ≤ 56319
def isLowSurrogate (c : Nat) : Bool := 56320 ≤ c && c ≤ 57343

/-- `encodeURIComponent`, or `none` where it throws: on a surrogate without its pair. -/
def encodeAux : Nat → Text → Option Text
  | _, [] => some []
  | 0, _ :: _ => none
  | fuel + 1, c :: cs =>
    if isUnreserved c then (encodeAux fuel cs).map (c :: ·)
    else if isLowSurrogate c then none
    else if isHighSurrogate c then
      match cs with
      | low :: rest =>
        if isLowSurrogate low then
          (encodeAux fuel rest).map (percentUtf8 (65536 + (c - 55296) * 1024 + (low - 56320)) ++ ·)
        else none
      | [] => none
    else (encodeAux fuel cs).map (percentUtf8 c ++ ·)

def encodeURIComponent (text : Text) : Option Text := encodeAux text.length text

/-! ## Alert policy -/

inductive Severity where
  | info
  | warning
  | critical
  deriving DecidableEq, Repr

structure Detector where
  field : Text
  value : Text
  eventTypes : Option (List Text)
  summary : Option Text
  deriving DecidableEq, Repr

structure Rule where
  afterMs : Int
  repeatMs : Option Int
  severity : Option Severity
  owner : Option Text
  runbook : Option Text
  deriving DecidableEq, Repr

structure Defaults where
  severity : Option Severity
  owner : Option Text
  runbook : Option Text
  deriving DecidableEq, Repr

/-- A policy. `rules` and `detectors` are the own entries of the two records, in key order. -/
structure Policy where
  defaults : Option Defaults
  rules : List (Text × Rule)
  detectors : List (Text × Detector)
  deriving DecidableEq, Repr

def deliveredEventType : Text := ascii "flows.alerts.delivered"
def failedEventType : Text := ascii "flows.alerts.failed"
def acknowledgedEventType : Text := ascii "flows.alerts.acknowledged"
def maxSummaryLength : Nat := 500

def controlFamily : Option (List Text) := some [ascii "control.*"]

/-- The four conditions a control plane journals out of the box. -/
def defaultDetectors : List (Text × Detector) := [
  (ascii "waiting-approval",
    { field := ascii "status", value := ascii "waiting-approval", eventTypes := controlFamily, summary := none }),
  (ascii "failed", { field := ascii "status", value := ascii "failed", eventTypes := controlFamily, summary := none }),
  (ascii "stalled", { field := ascii "health", value := ascii "stalled", eventTypes := controlFamily, summary := none }),
  (ascii "quota-parked",
    { field := ascii "waitingReason", value := ascii "quota", eventTypes := controlFamily, summary := none })]

/-- The first value stored under `key`. -/
def find {α : Type} (entries : List (Text × α)) (key : Text) : Option α :=
  match entries with
  | [] => none
  | (name, value) :: rest => if name = key then some value else find rest key

/-- `detectorsOf(policy)[condition]`: the deployment's own detector, else the one this package ships. -/
def detectorOf (policy : Policy) (condition : Text) : Option Detector :=
  match find policy.detectors condition with
  | some detector => some detector
  | none => find defaultDetectors condition

/-- `named.endsWith(".*")`. -/
def isFamily (named : Text) : Bool := 2 ≤ named.length && named.drop (named.length - 2) == [46, 42]

/-- Whether `eventTypes` names an event type, exactly or through a `.*` family. -/
def names (eventTypes : List Text) (eventType : Text) : Bool :=
  eventTypes.any (fun named => if isFamily named then named.dropLast.isPrefixOf eventType else named == eventType)

/-- A journal entry as a detector reads it. A payload that is not a record is `none`; a value is a string or not. -/
structure AlertEntry where
  eventType : Text
  emittedAtMs : Int
  payload : Option (List (Text × Option Text))
  deriving DecidableEq, Repr

structure Opened where
  since : Int
  summary : Option Text
  deriving DecidableEq, Repr

/-- The open conditions in the order they opened, as a JavaScript `Map` holds them. -/
abbrev OpenMap := List (Text × Opened)

def isOpenIn (conditions : OpenMap) (condition : Text) : Bool := conditions.any (fun each => each.1 == condition)

/-- What the opening entry said: the string under the detector's summary key, cut to the most an alert carries. -/
def summaryOf (detector : Detector) (payload : List (Text × Option Text)) : Option Text :=
  match detector.summary with
  | none => none
  | some key =>
    match find payload key with
    | some (some text) => some (text.take maxSummaryLength)
    | _ => none

/-- Whether a detector consults entries of this event type at all: every type when it names none. -/
def consults (detector : Detector) (eventType : Text) : Bool :=
  match detector.eventTypes with
  | none => true
  | some eventTypes => names eventTypes eventType

/-- One rule's condition read off one entry: opened, closed, or left as it was. -/
def observeCondition (policy : Policy) (eventType : Text) (at_ : Int) (payload : List (Text × Option Text))
    (conditions : OpenMap) (condition : Text) : OpenMap :=
  match detectorOf policy condition with
  | none => conditions
  | some detector =>
    if consults detector eventType = false then conditions
    else
      match find payload detector.field with
      | none => conditions
      | some value =>
        if value = some detector.value then
          if isOpenIn conditions condition then conditions
          else conditions ++ [(condition, { since := at_, summary := summaryOf detector payload })]
        else conditions.filter (fun each => each.1 != condition)

/-- Whether an entry is one of the alerter's own records, which are never evidence about a condition. -/
def isOwnRecord (eventType : Text) : Bool :=
  eventType == deliveredEventType || eventType == failedEventType || eventType == acknowledgedEventType

/-- `observe`: folds one entry into the open conditions, one rule at a time in the policy's order. -/
def observe (policy : Policy) (eventType : Text) (at_ : Int) (payload : List (Text × Option Text))
    (conditions : OpenMap) : OpenMap :=
  if isOwnRecord eventType then conditions
  else (policy.rules.map (·.1)).foldl (observeCondition policy eventType at_ payload) conditions

/-- The open conditions a journal leaves, oldest entry first. An entry without a record payload is skipped. -/
def openAfter (policy : Policy) (entries : List AlertEntry) : OpenMap :=
  entries.foldl
    (fun conditions entry =>
      match entry.payload with
      | none => conditions
      | some payload => observe policy entry.eventType entry.emittedAtMs payload conditions)
    []

structure Open where
  runId : Text
  condition : Text
  since : Int
  summary : Option Text
  deriving DecidableEq, Repr

/-- `conditions`: every condition a run's journal leaves open, with the time each opened. -/
def conditions (policy : Policy) (runId : Text) (entries : List AlertEntry) : List Open :=
  (openAfter policy entries).map (fun each =>
    { runId, condition := each.1, since := each.2.since, summary := each.2.summary })

structure Alert where
  runId : Text
  condition : Text
  since : Int
  firedAt : Int
  reminder : Option Int
  severity : Severity
  coalescingKey : Text
  summary : Option Text
  owner : Option Text
  runbook : Option Text
  deriving DecidableEq, Repr

/-- `coalescingKey`: the two components percent-encoded and joined by `:`; `none` where encoding throws. -/
def coalescingKey (runId condition : Text) : Option Text :=
  match encodeURIComponent runId, encodeURIComponent condition with
  | some run, some named => some (run ++ 58 :: named)
  | _, _ => none

/-- The decimal text of a whole number, as JavaScript writes one. -/
def decimal (value : Int) : Text := ascii (toString value)

/-- `alertId`: `alert:<key>:<since>`, and `:r<n>` on a repeat. -/
def alertId (key : Text) (since : Int) (reminder : Option Int) : Text :=
  ascii "alert:" ++ key ++ 58 :: decimal since ++
    (match reminder with
      | none => []
      | some count => ascii ":r" ++ decimal count)

/-- `recordSourceId`. -/
def recordSourceId (id outcome : Text) : Text := ascii "/notifications/alerts/" ++ id ++ 47 :: outcome

/-- `rule.severity ?? policy.defaults?.severity ?? "warning"`. -/
def severityOf (policy : Policy) (rule : Rule) : Severity :=
  match rule.severity with
  | some severity => severity
  | none =>
    match policy.defaults with
    | some { severity := some severity, .. } => severity
    | _ => .warning

def ownerOf (policy : Policy) (rule : Rule) : Option Text :=
  match rule.owner with
  | some owner => some owner
  | none => policy.defaults.bind (·.owner)

def runbookOf (policy : Policy) (rule : Rule) : Option Text :=
  match rule.runbook with
  | some runbook => some runbook
  | none => policy.defaults.bind (·.runbook)

/-- How many whole repeat periods a condition has outlived its delay by at `now`. -/
def reminderAt (rule : Rule) (since now : Int) : Int :=
  match rule.repeatMs with
  | none => 0
  | some period => (now - (since + rule.afterMs)) / period

/-- The journal instant a page came due: the end of the delay, or of the latest whole repeat period. -/
def firedAtOf (rule : Rule) (since now : Int) : Int :=
  match rule.repeatMs with
  | none => since + rule.afterMs
  | some period => since + rule.afterMs + reminderAt rule since now * period

/--
The alert one open condition raises at `now`: none without a rule or before the delay. The outer `none` is the
`URIError` `encodeURIComponent` throws for a run id or a condition name holding a lone surrogate.
-/
def alertOf (policy : Policy) (condition : Open) (now : Int) : Option (List Alert) :=
  match find policy.rules condition.condition with
  | none => some []
  | some rule =>
    if now - condition.since < rule.afterMs then some []
    else
      match coalescingKey condition.runId condition.condition with
      | none => none
      | some key =>
        some [{
          runId := condition.runId
          condition := condition.condition
          since := condition.since
          firedAt := firedAtOf rule condition.since now
          reminder := if reminderAt rule condition.since now = 0 then none else some (reminderAt rule condition.since now)
          severity := severityOf policy rule
          coalescingKey := key
          summary := condition.summary
          owner := ownerOf policy rule
          runbook := runbookOf policy rule }]

/-- `decide`: the alerts a policy raises for the conditions open at `now`, in the conditions' order. -/
def decideAlerts (policy : Policy) : List Open → Int → Option (List Alert)
  | [], _ => some []
  | condition :: rest, now =>
    match alertOf policy condition now with
    | none => none
    | some alerts =>
      match decideAlerts policy rest now with
      | none => none
      | some later => some (alerts ++ later)

/-! ## Inbox routing -/

inductive Level where
  | all
  | attention
  | muted
  deriving DecidableEq, Repr

inductive RunState where
  | working
  | waiting
  | needsYou
  | failed
  | done
  deriving DecidableEq, Repr

structure Watcher where
  principal : Text
  level : Level
  deriving DecidableEq, Repr

structure Told where
  recipient : Text
  mine : Bool
  state : RunState
  quiet : Bool
  deriving DecidableEq, Repr

/--
`heard`: the watchers who are told, in order. A principal counts once, at their first entry; the excluded
principal, a muted watcher and one who may not read the run are left out.
-/
def heardFrom (mayRead : Text → Bool) (exclude : Option Text) : List Text → List Watcher → List Watcher
  | _, [] => []
  | seen, watcher :: rest =>
    if exclude = some watcher.principal ∨ watcher.principal ∈ seen then heardFrom mayRead exclude seen rest
    else if watcher.level = .muted ∨ mayRead watcher.principal = false then
      heardFrom mayRead exclude (watcher.principal :: seen) rest
    else watcher :: heardFrom mayRead exclude (watcher.principal :: seen) rest

def heard (mayRead : Text → Bool) (exclude : Option Text) (watchers : List Watcher) : List Watcher :=
  heardFrom mayRead exclude [] watchers

/-- What a watcher is told of a run's state: `needs_you` is the launcher's alone, a watcher hears `waiting`. -/
def watcherState (state : RunState) : RunState := if state = .needsYou then .waiting else state

/-- `route`: who is told about a run, the launcher first. -/
def route (launcher : Option Text) (state : RunState) (watchers : List Watcher) (mayRead : Text → Bool) :
    List Told :=
  (match launcher with
    | some principal =>
      if mayRead principal then [{ recipient := principal, mine := true, state, quiet := false }] else []
    | none => []) ++
  (heard mayRead launcher watchers).map (fun watcher =>
    { recipient := watcher.principal, mine := false, state := watcherState state
      quiet := decide (watcher.level = .attention) })

/-- `audience`: the principals who hear what is said in a run. -/
def audience (watchers : List Watcher) (mayRead : Text → Bool) : List Text :=
  (heard mayRead none watchers).map (·.principal)

/-- The states that ask for somebody's attention. -/
def isAttention (state : RunState) : Bool := state = .needsYou || state = .failed || state = .done

/-- `raises`: a run's first notice, or a change into a state that asks for attention. -/
def raises (before : Option RunState) (after : RunState) : Bool :=
  match before with
  | none => true
  | some earlier => after != earlier && isAttention after

inductive Act where
  | read
  | dismiss
  | hide
  deriving DecidableEq, Repr

structure Versions where
  version : Int
  readVersion : Int
  dismissedVersion : Int
  hiddenVersion : Int
  deriving DecidableEq, Repr

def markOf (notice : Versions) : Act → Int
  | .read => notice.readVersion
  | .dismiss => notice.dismissedVersion
  | .hide => notice.hiddenVersion

def setMark (notice : Versions) (act : Act) (value : Int) : Versions :=
  match act with
  | .read => { notice with readVersion := value }
  | .dismiss => { notice with dismissedVersion := value }
  | .hide => { notice with hiddenVersion := value }

/-- `Number.isSafeInteger` for a whole number. -/
def isSafe (value : Int) : Bool := -9007199254740991 ≤ value && value ≤ 9007199254740991

/-- `Math.min(version, limit)`. -/
def capped (version limit : Int) : Int := if version ≤ limit then version else limit

/-- `ack`: advances one mark to `version`, never past the notice's own version and never backwards. -/
def ack (notice : Versions) (act : Act) (version : Int) : Versions :=
  if isSafe version = false then notice
  else if markOf notice act < capped version notice.version then setMark notice act (capped version notice.version)
  else notice

def isOpen (notice : Versions) : Bool := notice.dismissedVersion < notice.version
def isUnread (notice : Versions) : Bool := notice.readVersion < notice.version
def isHidden (notice : Versions) : Bool := notice.version ≤ notice.hiddenVersion

end NotificationsSpec

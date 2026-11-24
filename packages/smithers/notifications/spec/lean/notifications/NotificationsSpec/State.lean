/-!
# The pending-notification queue: the reference specification of `src/NotificationState.ts`

A notification is admitted into a bounded queue, where it is `admitted`, `coalesced` into a pending system event of
the same key and lineage, or `rejected-full`. It leaves the queue by promotion at a boundary and never returns.
`src/Projection.ts` re-derives the queue by folding the journal's admission and promotion records, which is
specified here as `derive`.

A text is the list of its UTF-16 code units, which is how JavaScript holds a string.
-/

namespace NotificationsSpec

/-- A JavaScript string: its UTF-16 code units. -/
abbrev Text := List Nat

/-- The code units of an ASCII literal. -/
def ascii (literal : String) : Text := literal.toList.map Char.toNat

/-! ## Notifications -/

inductive Tag where
  | humanSteer
  | humanFollowup
  | systemEvent
  deriving DecidableEq, Repr

/-- How a notification may reach the model: in a batch at turn close, or one at a time when the run idles. -/
inductive Delivery where
  | steer
  | queue
  deriving DecidableEq, Repr

/--
What the queue reads of a JSON payload. A `record` is a JSON object, with its own `kind` when that is a string;
`other` is an array, a scalar or `null`. The token stands for the rest of the payload, which the queue never reads.
-/
inductive Payload where
  | record (kind : Option Text) (token : Nat)
  | other (token : Nat)
  deriving DecidableEq, Repr

structure Notification where
  tag : Tag
  id : Text
  lineage : Text
  /-- A system event's coalescing key. The other two kinds carry none. -/
  key : Option Text
  payload : Payload
  deriving DecidableEq, Repr

/-- `admissionClass`: a human steer is a `steer`; a follow-up and a system event are `queue`. -/
def admissionClass (notification : Notification) : Delivery :=
  match notification.tag with
  | .humanSteer => .steer
  | _ => .queue

/-- `coalesceKey`: only a system event coalesces, and only when it declares a key. -/
def coalesceKey (notification : Notification) : Option Text :=
  match notification.tag with
  | .systemEvent => notification.key
  | _ => none

def outsideChange : Text := ascii "outside_change"

/-- A steer, or a legacy `outside_change` system event: both reach the next boundary. -/
def deliversAtBoundary (notification : Notification) : Bool :=
  admissionClass notification == .steer ||
    (notification.tag == .systemEvent &&
      match notification.payload with
      | .record (some kind) _ => kind == outsideChange
      | _ => false)

/-! ## The queue -/

structure Pending where
  notification : Notification
  seq : Int
  deriving DecidableEq, Repr

structure State where
  capacity : Nat
  items : List Pending
  deriving DecidableEq, Repr

inductive Decision where
  | admitted
  | coalesced
  | rejectedFull
  deriving DecidableEq, Repr

structure Admission where
  state : State
  decision : Decision
  deriving DecidableEq, Repr

structure Promotion where
  state : State
  promoted : List Pending
  deriving DecidableEq, Repr

/-- `Math.max(0, Math.floor(capacity))` for a finite capacity, and zero for any other. -/
def normalizedCapacity (capacity : Float) : Float :=
  if capacity.isFinite then (if capacity.floor > 0 then capacity.floor else 0) else 0

def empty (capacity : Nat) : State := { capacity, items := [] }

/-- Whether a pending item is the one `notification` coalesces into: the same key, in the same lineage. -/
def coalesces (notification : Notification) (item : Pending) : Bool :=
  match coalesceKey notification with
  | none => false
  | some key => item.notification.lineage == notification.lineage && coalesceKey item.notification == some key

/-- Replaces the notification of the first item `matches` holds for, keeping that item's sequence. -/
def replaceFirst (matching : Pending → Bool) (notification : Notification) : List Pending → Option (List Pending)
  | [] => none
  | item :: rest =>
    if matching item then some ({ notification, seq := item.seq } :: rest)
    else (replaceFirst matching notification rest).map (item :: ·)

/-- The queue's admission, `admitOne` here: coalesce into a pending item, or refuse a full queue, or append. -/
def admitOne (state : State) (notification : Notification) (seq : Int) : Admission :=
  match replaceFirst (coalesces notification) notification state.items with
  | some items => { state := { state with items }, decision := .coalesced }
  | none =>
    if state.capacity ≤ state.items.length then { state, decision := .rejectedFull }
    else { state := { state with items := state.items ++ [{ notification, seq }] }, decision := .admitted }

/-- `applyAdmission`: applies a decision a journal record already committed. Replay never re-decides. -/
def applyAdmission (state : State) (notification : Notification) (seq : Int) : Decision → State
  | .rejectedFull => state
  | .admitted => { state with items := state.items ++ [{ notification, seq }] }
  | .coalesced =>
    match replaceFirst (coalesces notification) notification state.items with
    | some items => { state with items }
    | none => { state with items := state.items ++ [{ notification, seq }] }

/-- Whether a notification is addressed to `target`; every lineage when there is no target. -/
def inLineage (target : Option Text) (notification : Notification) : Bool :=
  match target with
  | none => true
  | some lineage => notification.lineage == lineage

/-- `pending`: the still-pending notifications of one admission class, in journal order. -/
def pending (state : State) (admission : Delivery) (target : Option Text) : List Pending :=
  state.items.filter (fun item => admissionClass item.notification == admission && inLineage target item.notification)

/-- A promotion that takes every item `taken` holds for and leaves the rest, both in journal order. -/
def promoteWhere (taken : Pending → Bool) (state : State) : Promotion :=
  { state := { state with items := state.items.filter (fun item => !taken item) }
    promoted := state.items.filter taken }

/-- What `promoteSteers` takes. No cutoff is an infinite one. -/
def steerTaken (cutoff : Option Int) (target : Option Text) (item : Pending) : Bool :=
  deliversAtBoundary item.notification &&
    (match cutoff with
      | none => true
      | some highest => decide (item.seq ≤ highest)) &&
    inLineage target item.notification

/-- `promoteSteers`: every boundary-delivered notification admitted at or before the cutoff. -/
def promoteSteers (state : State) (cutoff : Option Int) (target : Option Text) : Promotion :=
  promoteWhere (steerTaken cutoff target) state

/-- What `promoteIds` takes. -/
def idTaken (ids : List Text) (target : Option Text) (item : Pending) : Bool :=
  deliversAtBoundary item.notification && decide (item.notification.id ∈ ids) && inLineage target item.notification

/-- `promoteIds`: the boundary-delivered notifications named in `ids`, whatever their sequences. -/
def promoteIds (state : State) (ids : List Text) (target : Option Text) : Promotion :=
  promoteWhere (idTaken ids target) state

/-- The first item `matching` holds for, and the items without it. -/
def takeFirst (matching : Pending → Bool) : List Pending → Option (Pending × List Pending)
  | [] => none
  | item :: rest =>
    if matching item then some (item, rest)
    else (takeFirst matching rest).map (fun (found, others) => (found, item :: others))

/-- `promoteQueued`: exactly the oldest pending queue notification. -/
def promoteQueued (state : State) (target : Option Text) : Promotion :=
  match takeFirst
    (fun item => admissionClass item.notification == .queue && inLineage target item.notification) state.items with
  | none => { state, promoted := [] }
  | some (found, others) => { state := { state with items := others }, promoted := [found] }

/-- `applyPromoted`: drops every pending item a promotion record names. -/
def applyPromoted (state : State) (ids : List Text) : State :=
  { state with items := state.items.filter (fun item => !decide (item.notification.id ∈ ids)) }

/-! ## The journal projection -/

inductive EntryType where
  | admitted
  | promoted
  | other
  deriving DecidableEq, Repr

/-- What an entry's payload decodes as. -/
inductive Body where
  | admitted (notification : Notification) (decision : Decision) (versioned : Bool)
  | promoted (ids : List Text)
  | undecodable
  deriving DecidableEq, Repr

structure Entry where
  eventType : EntryType
  sourceId : Text
  seq : Int
  body : Body
  deriving DecidableEq, Repr

inductive Event where
  | admitted (notification : Notification) (decision : Decision) (versioned : Bool)
  | promoted (ids : List Text)
  deriving DecidableEq, Repr

def admissionSourcePrefix : Text := ascii "/notifications/admission/"
def drainSourcePrefix : Text := ascii "/notifications/drain/"

/--
`NotificationEvent.fromEntry`: an admission record counts only under the source of the notification it admits, and
a promotion record only under a drain source. Every other entry is foreign.
-/
def fromEntry (entry : Entry) : Option Event :=
  match entry.eventType, entry.body with
  | .admitted, .admitted notification decision versioned =>
    if entry.sourceId = admissionSourcePrefix ++ notification.id then some (.admitted notification decision versioned)
    else none
  | .promoted, .promoted ids =>
    if drainSourcePrefix.isPrefixOf entry.sourceId then some (.promoted ids) else none
  | _, _ => none

/--
`internal/replay.applyAdmitted`: a versioned edit of a notification that is still pending replaces it in place,
keeping its sequence; any other admission record applies its committed decision.
-/
def applyAdmitted (state : State) (notification : Notification) (decision : Decision) (versioned : Bool)
    (seq : Int) : State :=
  if versioned && state.items.any (fun item => item.notification.id == notification.id) then
    { state with
      items := state.items.map (fun item =>
        if item.notification.id == notification.id then { notification, seq := item.seq } else item) }
  else applyAdmission state notification seq decision

/-- One step of `Projection.derive`. A foreign entry leaves the state unchanged. -/
def reduce (state : State) (entry : Entry) : State :=
  match fromEntry entry with
  | none => state
  | some (.admitted notification decision versioned) => applyAdmitted state notification decision versioned entry.seq
  | some (.promoted ids) => applyPromoted state ids

/-- `NotificationState.defaultCapacity`. -/
def defaultCapacity : Nat := 128

/-- `Projection.derive` over a journal, oldest entry first. -/
def derive (entries : List Entry) : State := entries.foldl reduce (empty defaultCapacity)

end NotificationsSpec

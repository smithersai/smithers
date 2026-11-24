import TimeTravelSpec.Basic

/-!
# Fork: copy a prefix into a new run

`createFork` and `nextForkId` of the memory store, without a step override or a child rebinding. A fork of `parent`
at frame `seq` writes a new run whose journal is the parent's records up to the frame, renamed, followed by one
fork-created record at `seq + 1`. The parent is not touched, and the new edge is detached.
-/

namespace TimeTravelSpec

def forkCreatedEventType : String := "flows.time-travel.fork-created"

/-- One pass over the edges: the parent of every run already reached is reached. -/
def reach (edges : List Edge) (seen : List String) : List String :=
  edges.foldl (fun acc edge => if acc.contains edge.child && !acc.contains edge.parent then acc ++ [edge.parent] else acc)
    seen

def reachMany (edges : List Edge) : Nat → List String → List String
  | 0, seen => seen
  | passes + 1, seen => reachMany edges passes (reach edges seen)

/-- A run and every run it descends from. -/
def ancestors (edges : List Edge) (run : String) : List String :=
  reachMany edges (edges.length + 1) [run]

/-- The id a fork of `parent` at `seq` gets when its caller names none. -/
def mint (s : State) (parent : String) (seq : Nat) : String :=
  let forks := s.edges.filter (fun edge =>
    decide (edge.kind = EdgeKind.fork) && decide (edge.parent = parent) && decide (edge.parentSeq = seq))
  let reserved := s.intents.filter (fun intent => decide (intent.parent = parent) && decide (intent.parentSeq = seq))
  s!"{parent}:fork:{seq}:{forks.length + reserved.length + 1}"

/-- The id names a run the store already knows. -/
def taken (s : State) (id : String) : Bool :=
  s.records.any (fun record => decide (record.run = id)) ||
    s.edges.any (fun edge => decide (edge.parent = id) || decide (edge.child = id)) ||
    s.live.contains id || (lookup id s.statuses).isSome || (lookup id s.owners).isSome

/-- A parent record as the child holds it. -/
def copied (id : String) (record : Record) : Record :=
  { record with run := id, eventId := s!"fork:{id}:{record.eventId}" }

/-- The record that marks a run as fork-created, directly above the copied prefix. -/
def marker (id lineage : String) (seq : Nat) : Record :=
  { run := id, seq := seq + 1, eventId := s!"fork:{id}:created", lineage := some lineage,
    eventType := some forkCreatedEventType }

def forkEdge (parent : String) (seq : Nat) (id : String) : Edge :=
  { parent := parent, parentSeq := seq, child := id, kind := EdgeKind.fork, attached := false }

/-- The parent's records the child copies. -/
def framePrefix (s : State) (parent : String) (seq : Nat) : List Record :=
  s.records.filter (fun record => decide (record.run = parent) && decide (record.seq ≤ seq))

/-- The state after the fork commits. -/
def branch (s : State) (parent lineage : String) (seq : Nat) (id : String) : State :=
  { s with
    intents := s.intents.filter (fun intent => !decide (intent.child = id))
    records := s.records ++ ((framePrefix s parent seq).map (copied id) ++ [marker id lineage seq])
    edges := s.edges ++ [forkEdge parent seq id] }

/-- The frame names a record of the parent; frame zero of any run is accepted. -/
def frameExists (s : State) (parent lineage : String) (seq : Nat) : Bool :=
  seq = 0 || s.records.any (fun record =>
    decide (record.run = parent) && decide (record.seq = seq) &&
      (match record.lineage with
        | none => true
        | some own => decide (own = lineage)))

def fork (s : State) (parent lineage : String) (seq : Nat) (child : Option String) : Except String (State × String) :=
  if (ancestors s.edges parent).any s.live.contains then .error "live_parent"
  else if !frameExists s parent lineage seq then .error "not_found"
  else
    let id := child.getD (mint s parent seq)
    if taken s id then .error "invalid" else .ok (branch s parent lineage seq id, id)

/-- Reserves the next fork id of a parent frame. -/
def reserve (s : State) (parent : String) (seq : Nat) : State × String :=
  let id := mint s parent seq
  ({ s with intents := s.intents ++ [{ child := id, parent := parent, parentSeq := seq }] }, id)

/-- Appends one record; a run holds one record per sequence number. -/
def append (s : State) (record : Record) : Except String State :=
  if s.records.any (fun existing => decide (existing.run = record.run) && decide (existing.seq = record.seq)) then
    .error "invalid"
  else .ok { s with records := s.records ++ [record] }

end TimeTravelSpec

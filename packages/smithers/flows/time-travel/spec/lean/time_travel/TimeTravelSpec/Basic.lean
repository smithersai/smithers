/-!
# The state time travel rewrites

The memory store of `@smthrs/time-travel` (`src/MemoryTimeTravelStore.ts`) is the reference the SQL store is held to.
Its state is a handful of lists: the live journal records of every run, the records a rewind archived with the
generation they were archived under, the lineage edges, and the fork ids reserved but not yet committed.

A run's journal is the live records that carry its id, in the order the store holds them. A run's generation is the
number of times a rewind has truncated it; the store keeps a counter per run, and the specification keeps the list of
truncations, so the counter is a count.
-/

namespace TimeTravelSpec

/-- Why a child run exists. -/
inductive EdgeKind where
  | child
  | fork
  | continuation
  deriving DecidableEq, Repr

/-- One journal record: the run, its sequence number, and the fields a fork rewrites or reads. -/
structure Record where
  run : String
  seq : Nat
  eventId : String
  lineage : Option String
  eventType : Option String
  deriving DecidableEq, Repr

/-- One parent-to-child link, anchored at the parent sequence the child branched from. -/
structure Edge where
  parent : String
  parentSeq : Nat
  child : String
  kind : EdgeKind
  attached : Bool
  deriving DecidableEq, Repr

/-- The process that owns a run. -/
structure Owner where
  host : String
  pid : Nat
  nonce : String
  deriving DecidableEq, Repr

/-- A fork id reserved for a parent frame and not yet committed. -/
structure Intent where
  child : String
  parent : String
  parentSeq : Nat
  deriving DecidableEq, Repr

structure State where
  /-- The live records of every run. -/
  records : List Record
  /-- The records rewinds removed, each with its run's generation before that rewind. -/
  archived : List (Record × Nat)
  /-- One entry per truncation of a run. -/
  bumps : List String
  edges : List Edge
  intents : List Intent
  /-- The runs that are live; a fork refuses a live parent or ancestor. -/
  live : List String
  /-- Each known run's status: `true` when it is terminal. -/
  statuses : List (String × Bool)
  owners : List (String × Owner)

/-- The first value stored under a key. -/
def lookup {α : Type} (key : String) : List (String × α) → Option α
  | [] => none
  | (k, v) :: rest => if k = key then some v else lookup key rest

/-- A run's journal: its live records, in store order. -/
def State.journal (s : State) (run : String) : List Record :=
  s.records.filter (fun r => decide (r.run = run))

/-- How many times a run has been truncated. -/
def State.generation (s : State) (run : String) : Nat :=
  s.bumps.count run

/-- A run's journal is in strictly increasing sequence order. -/
def State.Sorted (s : State) (run : String) : Prop :=
  (s.journal run).Pairwise (fun a b => a.seq < b.seq)

/-- Every archived record was archived under a generation its run has since left. -/
def State.ArchiveBelow (s : State) : Prop :=
  ∀ entry ∈ s.archived, entry.2 < s.generation entry.1.run

end TimeTravelSpec

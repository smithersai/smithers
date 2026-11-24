/-!
# One run's journal, as data

The specification follows one run through one database. What is durable is the run's entries, the identities
compaction retired, its checkpoints and who holds its lease. What a journal process keeps in memory is its allocation
floors and its count toward the next automatic compaction; a restart forgets those and keeps everything durable.

A payload is a string, held as its UTF-16 code units, and an entry's size is the UTF-8 size of that string's JSON
text plus the four bytes of a `null` meta. Producers, owners and checkpoint states are numbers: the journal compares
them and never reads into them.
-/

namespace JournalSpec

/-- A string as its UTF-16 code units. -/
abbrev Text := List Nat

/-- A committed entry. `seq` orders the run; `source` and `sourceSeq` are the producer's identity for it. -/
structure Entry where
  seq : Nat
  source : Nat
  sourceSeq : Nat
  content : Text
  deriving DecidableEq

/-- A checkpoint: the replay state that stands for every entry at or below `seq`. -/
structure Checkpoint where
  seq : Nat
  state : Nat
  compacted : Bool
  deriving DecidableEq

/-- The journal of one run. -/
structure Journal where
  /-- Committed entries, oldest first. -/
  entries : List Entry
  /-- Identities of entries a compaction deleted: they still answer a retry and still bound allocation. -/
  retired : List Entry
  checkpoints : List Checkpoint
  /-- The owner holding the run's lease, if any. -/
  holder : Option Nat
  /-- This process's next sequence to reserve. -/
  floor : Nat
  /-- This process's next producer sequence, by producer. -/
  sourceFloors : List (Nat × Nat)
  /-- This process's count of the run's entries toward automatic compaction, once it has counted. -/
  counted : Option Nat

def Journal.empty : Journal :=
  { entries := [], retired := [], checkpoints := [], holder := none, floor := 0, sourceFloors := [], counted := none }

/-- The journal's settings. -/
structure Config where
  /-- Largest entry admitted, in encoded bytes. -/
  maxEntryBytes : Nat
  /-- Entries after which an owner's commit checkpoints and compacts, when the policy is on. -/
  threshold : Option Nat

-- Encoded size --------------------------------------------------------------------------------------------------------

def isHigh (unit : Nat) : Bool := 0xd800 ≤ unit && unit ≤ 0xdbff

def isLow (unit : Nat) : Bool := 0xdc00 ≤ unit && unit ≤ 0xdfff

/-- UTF-8 bytes of one non-surrogate code unit inside a JSON string literal. -/
def unitBytes (unit : Nat) : Nat :=
  if unit = 0x22 || unit = 0x5c || unit = 0x08 || unit = 0x09 || unit = 0x0a || unit = 0x0c || unit = 0x0d then 2
  else if unit ≤ 0x1f then 6
  else if unit ≤ 0x7f then 1
  else if unit ≤ 0x7ff then 2
  else 3

/--
UTF-8 bytes of the body of `JSON.stringify(text)`: a surrogate pair is one four-byte character and a lone surrogate
is a six-byte `\uXXXX` escape. `pending` is a high surrogate still waiting for its low half.
-/
def bodyBytes : Bool → Text → Nat
  | pending, [] => if pending then 6 else 0
  | true, unit :: rest =>
    if isLow unit then 4 + bodyBytes false rest
    else if isHigh unit then 6 + bodyBytes true rest
    else 6 + unitBytes unit + bodyBytes false rest
  | false, unit :: rest =>
    if isHigh unit then bodyBytes true rest
    else if isLow unit then 6 + bodyBytes false rest
    else unitBytes unit + bodyBytes false rest

/-- What an entry with this payload and no meta persists: the payload's JSON text and `null`. -/
def entryBytes (content : Text) : Nat := bodyBytes false content + 2 + 4

-- Reading the durable state -------------------------------------------------------------------------------------------

/-- One past the highest sequence among the entries: `MAX(seq) + 1`, or 0 for none. -/
def nextSeq : List Entry → Nat
  | [] => 0
  | entry :: rest => max (entry.seq + 1) (nextSeq rest)

/-- One past a producer's highest sequence among the rows: `MAX(source_seq) + 1`, or 0 for none. -/
def nextSourceSeq (source : Nat) : List Entry → Nat
  | [] => 0
  | entry :: rest =>
    if entry.source = source then max (entry.sourceSeq + 1) (nextSourceSeq source rest) else nextSourceSeq source rest

/-- The row holding a producer identity, lowest sequence first. -/
def findIdentity (source sourceSeq : Nat) (rows : List Entry) : Option Entry :=
  rows.find? (fun row => row.source = source && row.sourceSeq = sourceSeq)

/-- The checkpoint with the highest sequence. -/
def latest : List Checkpoint → Option Checkpoint
  | [] => none
  | checkpoint :: rest =>
    match latest rest with
    | none => some checkpoint
    | some other => if other.seq < checkpoint.seq then some checkpoint else some other

/-- The compaction floor: the highest compacted checkpoint's sequence. -/
def compactionFloor (checkpoints : List Checkpoint) : Option Nat :=
  (latest (checkpoints.filter (·.compacted))).map (·.seq)

/-- A process's floor for a producer, 0 until it has reserved one. -/
def sourceFloor (source : Nat) : List (Nat × Nat) → Nat
  | [] => 0
  | (key, value) :: rest => if key = source then value else sourceFloor source rest

/-- Raises a producer's floor to at least `value`. -/
def raiseSourceFloor (source value : Nat) (floors : List (Nat × Nat)) : List (Nat × Nat) :=
  (source, max (sourceFloor source floors) value) :: floors.filter (·.1 ≠ source)

end JournalSpec

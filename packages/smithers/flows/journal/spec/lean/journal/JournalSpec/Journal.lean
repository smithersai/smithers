import JournalSpec.Basic

/-!
# The journal's operations

Each operation is a function from a journal to an outcome and the journal after it. The durable channel is modeled:
`emitDurable` (fenced on an owner) and `emitDurableUnfenced`, `checkpoint`, `compact`, `entries`, `latestCheckpoint`,
and the automatic checkpoint-and-compact policy that runs after an owner's commit. The lossy queue and live streams
are outside the specification.

The order of the checks is the implementation's. An entry over the byte bound is refused before anything is
reserved, so it costs no sequence. Every other refused or duplicate write has already reserved one, so the process's
floor moves and the run's sequences may gap; they never repeat or go backwards.
-/

namespace JournalSpec

/-- One call on the journal. -/
inductive Op where
  /-- Makes `owner` the lease holder, displacing any other. -/
  | hold (owner : Nat)
  /-- Drops the lease. -/
  | release
  /-- A new journal process over the same database. -/
  | restart
  /--
  `emitDurable` for `some owner`, `emitDurableUnfenced` for none. `steal` is who takes the lease while the automatic
  policy captures its state, if this commit triggers it: the race of issue 4555.
  -/
  | emit (owner : Option Nat) (source : Nat) (sourceSeq : Option Nat) (content : Text) (steal : Option Nat)
  | checkpoint (seq state owner : Nat)
  | compact (upTo : Option Nat) (owner : Nat)
  | entries (after : Option Nat) (limit : Nat) (descending : Bool)
  | latestCheckpoint

/-- What a call answered. -/
inductive Outcome where
  | done
  | accepted (seq sourceSeq : Nat)
  | duplicate (seq sourceSeq : Nat)
  | failed (code : String) (checkpointSeq : Option Nat)
  | checkpointed (seq state : Nat)
  | compacted (checkpointSeq deleted : Nat)
  | page (entries : List Entry) (hasMore : Bool)
  | latest (checkpoint : Option Checkpoint)

/-- True when `owner` holds the run. -/
def holds (journal : Journal) (owner : Nat) : Bool := journal.holder == some owner

-- Checkpoints and compaction ------------------------------------------------------------------------------------------

/-- Replaces the state of the checkpoint at `seq`, or adds one. -/
def upsertCheckpoint (seq state : Nat) : List Checkpoint → List Checkpoint
  | [] => [{ seq, state, compacted := false }]
  | checkpoint :: rest =>
    if checkpoint.seq = seq then { checkpoint with state } :: rest else checkpoint :: upsertCheckpoint seq state rest

/-- `checkpoint`: fenced, at a committed entry above the compaction floor. -/
def checkpoint (seq state owner : Nat) (journal : Journal) : Outcome × Journal :=
  if !holds journal owner then (.failed "fence_lost" none, journal)
  else if !journal.entries.any (·.seq = seq) then (.failed "checkpoint_invalid" none, journal)
  else
    match compactionFloor journal.checkpoints with
    | some floor =>
      if seq ≤ floor then (.failed "checkpoint_invalid" (some floor), journal)
      else (.checkpointed seq state, { journal with checkpoints := upsertCheckpoint seq state journal.checkpoints })
    | none => (.checkpointed seq state, { journal with checkpoints := upsertCheckpoint seq state journal.checkpoints })

/-- The journal with everything strictly below the checkpoint at `seq` truncated and that checkpoint the floor. -/
def truncate (seq : Nat) (journal : Journal) : Journal :=
  { journal with
    entries := journal.entries.filter (seq ≤ ·.seq)
    retired := journal.retired ++ journal.entries.filter (·.seq < seq)
    checkpoints :=
      (journal.checkpoints.filter (seq ≤ ·.seq)).map
        (fun checkpoint => if checkpoint.seq = seq then { checkpoint with compacted := true } else checkpoint) }

/-- `compact`: fenced, to the named checkpoint or the latest; a retry of a finished compaction deletes nothing. -/
def compact (upTo : Option Nat) (owner : Nat) (journal : Journal) : Outcome × Journal :=
  if !holds journal owner then (.failed "fence_lost" none, journal)
  else
    let target :=
      match upTo with
      | none => latest journal.checkpoints
      | some seq => journal.checkpoints.find? (·.seq = seq)
    match target with
    | none => (.failed "checkpoint_invalid" none, journal)
    | some target =>
      if target.compacted then (.compacted target.seq 0, journal)
      else
        (.compacted target.seq (journal.entries.filter (·.seq < target.seq)).length, truncate target.seq journal)

-- Writing -------------------------------------------------------------------------------------------------------------

/-- State the automatic policy captures at the run's tail. The journal never reads it; the test supplies the same. -/
def captured (upTo : Nat) : Nat := 7 * upTo + 1

/-- The count the policy compares with its threshold: the entries on first use, one more than last time after. -/
def countToward (journal : Journal) : Nat :=
  match journal.counted with
  | none => journal.entries.length
  | some known => known + 1

/-- A thief, if there is one, takes the lease. -/
def displace (steal : Option Nat) (journal : Journal) : Journal :=
  match steal with
  | none => journal
  | some thief => { journal with holder := some thief }

/--
One automatic attempt at `upTo` for `owner`: a fenced checkpoint, then a fenced compaction to it. A refusal of either
restarts the count; a success counts what is left.
-/
def checkpointAndCompact (owner upTo : Nat) (journal : Journal) : Journal :=
  match checkpoint upTo (captured upTo) owner journal with
  | (.checkpointed _ _, marked) =>
    match compact (some upTo) owner marked with
    | (.compacted _ _, compacted) => { compacted with counted := some compacted.entries.length }
    | (_, refused) => { refused with counted := some 0 }
  | (_, refused) => { refused with counted := some 0 }

/--
The automatic policy after a commit, on behalf of the owner whose fence admitted it. A thief may take the lease while
the state is captured; the checkpoint and the compaction are each fenced, so a displaced owner changes nothing but
its own count.
-/
def maintain (config : Config) (owner : Option Nat) (steal : Option Nat) (journal : Journal) : Journal :=
  match config.threshold with
  | none => journal
  | some threshold =>
    match owner with
    | none => { journal with counted := some (countToward journal) }
    | some owner =>
      if countToward journal < threshold then { journal with counted := some (countToward journal) }
      else
        checkpointAndCompact owner (nextSeq journal.entries - 1)
          (displace steal { journal with counted := some (countToward journal) })

/-- How a write that names a producer identity already held is answered: the original, or a conflict. -/
def answerExisting (existing : Entry) (sourceSeq : Nat) (content : Text) : Outcome :=
  if existing.content = content then .duplicate existing.seq sourceSeq else .failed "idempotency_conflict" none

/-- The row an identity collides with, in the entries or among the retired identities, lowest sequence first. -/
def existing (journal : Journal) (source sourceSeq : Nat) : Option Entry :=
  match findIdentity source sourceSeq journal.entries, findIdentity source sourceSeq journal.retired with
  | some entry, some retired => if retired.seq < entry.seq then some retired else some entry
  | some entry, none => some entry
  | none, other => other

/-- The producer sequence a write carries: the one supplied, or the next above the durable rows and the floor. -/
def resolveSourceSeq (source : Nat) (given : Option Nat) (journal : Journal) : Nat :=
  match given with
  | some supplied => supplied
  | none =>
    max (max (nextSourceSeq source journal.entries) (nextSourceSeq source journal.retired))
      (sourceFloor source journal.sourceFloors)

/-- Reserves the process's next sequence and the producer sequence: only the process's floors move. -/
def reserve (source sourceSeq : Nat) (journal : Journal) : Journal :=
  { journal with
    floor := journal.floor + 1
    sourceFloors := raiseSourceFloor source (sourceSeq + 1) journal.sourceFloors }

/-- Appends a committed entry and raises the floor past it. -/
def append (entry : Entry) (journal : Journal) : Journal :=
  { journal with entries := journal.entries ++ [entry], floor := max journal.floor (entry.seq + 1) }

/-- A write after its reservation of `reserved`: the fence, the identity, the insert, the policy. -/
def write (config : Config) (owner : Option Nat) (source sourceSeq : Nat) (content : Text) (steal : Option Nat)
    (reserved : Nat) (journal : Journal) : Outcome × Journal :=
  if owner.any (!holds journal ·) then (.failed "fence_lost" none, journal)
  else
    match existing journal source sourceSeq with
    | some row => (answerExisting row sourceSeq content, journal)
    | none =>
      (.accepted (max reserved (nextSeq journal.entries)) sourceSeq,
        maintain config owner steal
          (append { seq := max reserved (nextSeq journal.entries), source, sourceSeq, content } journal))

/-- A durable write: the byte bound first, then the reservation and the write. -/
def emit (config : Config) (owner : Option Nat) (source : Nat) (sourceSeq : Option Nat) (content : Text)
    (steal : Option Nat) (journal : Journal) : Outcome × Journal :=
  if entryBytes content > config.maxEntryBytes then (.failed "invalid_event" none, journal)
  else
    write config owner source (resolveSourceSeq source sourceSeq journal) content steal journal.floor
      (reserve source (resolveSourceSeq source sourceSeq journal) journal)

-- Reading -------------------------------------------------------------------------------------------------------------

/-- The entries above an optional cursor, oldest first. -/
def above (after : Option Nat) (entries : List Entry) : List Entry :=
  match after with
  | none => entries
  | some cursor => entries.filter (cursor < ·.seq)

/-- `entries`: one page above the cursor, or `compacted` when the cursor is below the floor. -/
def readPage (after : Option Nat) (limit : Nat) (descending : Bool) (journal : Journal) : Outcome :=
  let behind (floor : Nat) : Bool :=
    match after with
    | none => 0 < floor
    | some cursor => cursor + 1 < floor
  match compactionFloor journal.checkpoints with
  | some floor =>
    if behind floor then .failed "compacted" (some floor)
    else
      let rows := above after journal.entries
      let rows := if descending then rows.reverse else rows
      .page (rows.take limit) (limit < rows.length)
  | none =>
    let rows := above after journal.entries
    let rows := if descending then rows.reverse else rows
    .page (rows.take limit) (limit < rows.length)

/-- One call. -/
def step (config : Config) (op : Op) (journal : Journal) : Outcome × Journal :=
  match op with
  | .hold owner => (.done, { journal with holder := some owner })
  | .release => (.done, { journal with holder := none })
  | .restart => (.done, { journal with floor := 0, sourceFloors := [], counted := none })
  | .emit owner source sourceSeq content steal => emit config owner source sourceSeq content steal journal
  | .checkpoint seq state owner => checkpoint seq state owner journal
  | .compact upTo owner => compact upTo owner journal
  | .entries after limit descending => (readPage after limit descending journal, journal)
  | .latestCheckpoint => (.latest (latest journal.checkpoints), journal)

/-- A script of calls from a journal: every outcome, in order, and the journal at the end. -/
def run (config : Config) : List Op → Journal → List Outcome × Journal
  | [], journal => ([], journal)
  | op :: rest, journal =>
    let (outcome, next) := step config op journal
    let (outcomes, final) := run config rest next
    (outcome :: outcomes, final)

-- Replay --------------------------------------------------------------------------------------------------------------

/-- Folds entries into a state, oldest first. -/
def fold {σ : Type} (apply : σ → Entry → σ) (state : σ) (entries : List Entry) : σ := entries.foldl apply state

/-- Replay from a checkpoint: its state, then every entry after it. -/
def replayFrom {σ : Type} (apply : σ → Entry → σ) (state : σ) (seq : Nat) (entries : List Entry) : σ :=
  fold apply state (entries.filter (seq < ·.seq))

end JournalSpec

import MergeQueue.Step

/-!
# The policy

`step` says what may happen; `plan` says what the queue does next. `plan` is a
function of the durable state alone, so a queue that restarts picks up exactly
where it stopped.

Safety never depends on the policy: `step` checks every guard itself, so no
policy, however wrong, can land a tree that was not tested green.
-/

namespace MergeQueue

/-- The run can land now. -/
def State.landable (cfg : Config) (s : State) (r : Run) : Bool :=
  (s.live r).isSome && green cfg r.results

/-- The run has failed and exactly one change is left to blame. -/
def State.blameable (s : State) (r : Run) : Bool :=
  match s.live r with
  | some [_] => failed r.results
  | _ => false

/-- The run blamed a change that a fix agent is still working on. Its later
failures stream to that agent, so the queue keeps it. -/
def State.evidence (s : State) (r : Run) : Bool :=
  s.changes.any fun c => c.status == .fixing r.id

/-- For a live run whose parts are still the first ready changes in order: how
many of them. -/
def State.prefixLength (s : State) (r : Run) : Option Nat :=
  match s.live r with
  | some batch => if batch = (s.ready.take batch.length).map Change.part then some batch.length else none
  | none => none

/-- The smallest of a list of numbers. -/
def minOf : List Nat → Option Nat
  | [] => none
  | x :: rest =>
    match minOf rest with
    | none => some x
    | some m => some (min x m)

/-- The largest of a list of numbers; 0 for none. -/
def maxOf : List Nat → Nat
  | [] => 0
  | x :: rest => max x (maxOf rest)

/-- The lengths of the prefixes that a failed run has shown to fail. -/
def State.failedPrefixes (s : State) : List Nat :=
  s.runs.filterMap fun r =>
    match s.prefixLength r with
    | some n => if failed r.results then some n else none
    | none => none

/-- The lengths below `bound` of the prefixes that a run is testing and has
not failed. -/
def State.unfailedPrefixes (s : State) (bound : Nat) : List Nat :=
  s.runs.filterMap fun r =>
    match s.prefixLength r with
    | some n => if !failed r.results && n < bound then some n else none
    | none => none

/-- The shortest failed prefix: the first `m` ready changes are known to fail
together. -/
def State.shortestFailed (s : State) : Option Nat := minOf s.failedPrefixes

/-- The longest prefix below `bound` that a run is testing and has not failed. -/
def State.longestUnfailed (s : State) (bound : Nat) : Nat := maxOf (s.unfailedPrefixes bound)

/-- A live run the queue has no more use for: it failed without being a prefix
of the ready order, or it contains a prefix already known to fail. -/
def State.doomed (s : State) (r : Run) : Bool :=
  match s.live r with
  | none => false
  | some _ =>
    match s.prefixLength r with
    | none => failed r.results
    | some n =>
      match s.shortestFailed with
      | some m => m < n
      | none => false

/-- A pending live run started under an older ready order. It keeps its slot:
the queue starts nothing new until it lands or fails. -/
def State.outOfOrder (cfg : Config) (s : State) : Bool :=
  s.runs.any fun r => (s.live r).isSome && (s.prefixLength r).isNone && r.pending cfg

/-- How many ready changes the next run should take, if the queue should start
one. With no known failure it extends the longest prefix under test by up to
`maxBatch` (speculation). With the first `m` known to fail it tests a prefix
halfway between the longest unfailed prefix and `m` (bisection). -/
def State.nextStart (cfg : Config) (s : State) : Option Nat :=
  if cfg.maxRuns ≤ s.pendingCount cfg then none
  else if s.outOfOrder cfg then none
  else
    let ready := s.ready.length
    match s.shortestFailed with
    | none =>
      let tested := s.longestUnfailed (ready + 1)
      if tested < ready then some (tested + min (max cfg.maxBatch 1) (ready - tested)) else none
    | some m =>
      let tested := s.longestUnfailed m
      if tested + 1 < m then some (tested + (m - tested + 1) / 2) else none

/-- The landable run with the longest tree; the earliest such run on a tie. -/
def State.bestLandable (cfg : Config) (s : State) : Option Run :=
  s.runs.foldl
    (fun best r =>
      if s.landable cfg r then
        match best with
        | some b => if b.tree.length < r.tree.length then some r else best
        | none => some r
      else best)
    none

/-- The run to push next: the best landable run, unless a push is under way. -/
def State.nextPush (cfg : Config) (s : State) : Option Run :=
  if s.pushingRun.isSome then none else s.bestLandable cfg

/-- A run the queue should forget: it can no longer land or help a fix, or it
is doomed. The run being pushed is never forgotten. -/
def State.useless (s : State) (r : Run) : Bool :=
  (!(s.live r).isSome && !s.evidence r) || (s.doomed r && s.pushing != some r.id)

/-- The queue's next decision, or `none` when it has to wait for the world.
In order: push what can land, blame what can be blamed, cancel what is no
longer useful, then start the next run. -/
def plan (cfg : Config) (s : State) : Option Event :=
  match s.nextPush cfg with
  | some r => some (.push r.id)
  | none =>
    match s.runs.find? s.blameable with
    | some r => some (.blame r.id)
    | none =>
      match s.runs.find? s.useless with
      | some r => some (.cancel r.id)
      | none =>
        match s.nextStart cfg with
        | some count => some (.start count)
        | none => none

/-- Apply the policy's decisions until it has none left, at most `fuel` times. -/
def settle (cfg : Config) : Nat → State → State
  | 0, s => s
  | fuel + 1, s =>
    match plan cfg s with
    | some e => settle cfg fuel (step cfg s e)
    | none => s

/-! ## What the world must be doing

The driver derives its work from the state, never from memory, so every command
below is safe to issue again after a restart. -/

/-- CI should be running this run: it is unfinished, and either undecided or
still feeding failures to a fix agent. -/
def State.wantsCi (cfg : Config) (s : State) (r : Run) : Bool :=
  !complete cfg r.results && (r.pending cfg || s.evidence r)

/-- A change that is ahead of another in the queue and has not ended. `fixing`
says a fix agent is on it. -/
structure Ahead where
  id : ChangeId
  fixing : Bool
deriving DecidableEq, Repr

/-- What a fix agent is given. -/
structure FixBrief where
  id : ChangeId
  rev : Nat
  attempt : Nat
  /-- The failed checks so far; more may stream in. -/
  failures : List CheckId
  /-- The changes ahead in the queue, in order, and whether each is being fixed. -/
  ahead : List Ahead
deriving DecidableEq, Repr

/-- The unfinished changes ahead of `c`, in landing order. -/
def State.ahead (s : State) (c : Change) : List Ahead :=
  ((s.changes.filter fun d => !d.status.isTerminal && d.id != c.id && d.before c).mergeSort Change.before).map
    fun d => ⟨d.id, d.status.isFixing⟩

/-- One brief per change being fixed. -/
def State.fixBriefs (s : State) : List FixBrief :=
  (s.changes.filter fun c => c.status.isFixing).map fun c =>
    ⟨c.id, c.rev, c.attempts, s.failuresOf c, s.ahead c⟩

end MergeQueue

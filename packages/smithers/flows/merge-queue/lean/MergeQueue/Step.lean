import MergeQueue.Basic

/-!
# The transition function

`step cfg s e` is the whole queue: every state change is one event applied by
this function. Each event has a guard; an event whose guard fails leaves the
state exactly as it was, so a late, duplicate or stale event is harmless.
-/

namespace MergeQueue

/-! ## Reading results -/

/-- A check has a result. -/
def answered (results : List (CheckId × Verdict)) (check : CheckId) : Bool :=
  results.any fun r => r.1 == check

/-- A check passed. -/
def passed (results : List (CheckId × Verdict)) (check : CheckId) : Bool :=
  results.contains (check, Verdict.pass)

/-- Some check failed. One failure is enough: the rest of the run is not needed
to know the tree is not green. -/
def failed (results : List (CheckId × Verdict)) : Bool :=
  results.any fun r => r.2 == Verdict.fail

/-- Every required check has a result. -/
def complete (cfg : Config) (results : List (CheckId × Verdict)) : Bool :=
  cfg.required.all (answered results)

/-- A complete green result: there is at least one required check, every
required check passed, and nothing failed. Only this lets a tree land. -/
def green (cfg : Config) (results : List (CheckId × Verdict)) : Bool :=
  !cfg.required.isEmpty && cfg.required.all (passed results) && !failed results

/-- The failed checks, in arrival order. -/
def failures (results : List (CheckId × Verdict)) : List CheckId :=
  (results.filter fun r => r.2 == Verdict.fail).map (·.1)

/-- A run is pending while it has neither failed nor completed. Pending runs
are the ones that count against `maxRuns`. -/
def Run.pending (cfg : Config) (r : Run) : Bool :=
  !failed r.results && !complete cfg r.results

/-! ## Order -/

/-- `a` lands no later than `b`: higher priority first, then earlier arrival. -/
def Change.before (a b : Change) : Bool :=
  a.priority > b.priority || (a.priority == b.priority && a.seq ≤ b.seq)

/-- The changes waiting to land, in landing order. -/
def State.ready (s : State) : List Change :=
  (s.changes.filter fun c => c.status.isQueued).mergeSort Change.before

/-! ## Liveness of a run -/

/-- `strip main tree` is what `tree` adds to `main`, when `tree` extends it. -/
def strip : Tree → Tree → Option (List Part)
  | [], t => some t
  | _ :: _, [] => none
  | a :: m, b :: t => if a = b then strip m t else none

/-- The part is the current revision of a queued change. -/
def State.partReady (s : State) (p : Part) : Bool :=
  s.changes.any fun c => c.part == p && c.status.isQueued

/-- A run is live when its tree is the target's tree plus at least one part,
and every added part is still the current revision of a queued change. `live`
returns those added parts. Only a live run can land or blame. A run that is not
live can never become live again. -/
def State.live (s : State) (r : Run) : Option (List Part) :=
  match strip s.main r.tree with
  | some (p :: rest) => if (p :: rest).all s.partReady then some (p :: rest) else none
  | _ => none

def State.pendingCount (cfg : Config) (s : State) : Nat :=
  s.runs.countP (Run.pending cfg)

def State.findRun (s : State) (run : RunId) : Option Run :=
  s.runs.find? fun r => r.id == run

/-- The failed checks a fix agent is working from: those of the run that blamed
the change, including the ones that arrive after the blame. -/
def State.failuresOf (s : State) (c : Change) : List CheckId :=
  match c.status with
  | .fixing run =>
    match s.findRun run with
    | some r => failures r.results
    | none => []
  | _ => []

/-- The run the queue is pushing, while that push can still succeed: the run
is held and still live. A push whose run died (the target moved, a part was
blamed) is over. -/
def State.pushingRun (s : State) : Option Run :=
  match s.pushing with
  | none => none
  | some id =>
    match s.findRun id with
    | none => none
    | some r => if (s.live r).isSome then some r else none

/-- The part is on its way onto the target: it is in the batch being pushed. -/
def State.pushingPart (s : State) (p : Part) : Bool :=
  match s.pushingRun with
  | none => false
  | some r => r.batch.contains p

/-! ## Durations -/

/-- Record one finished check, keeping at most `window` samples per check. -/
def record (window : Nat) (history : List (CheckId × Nat)) (check : CheckId) (duration : Nat) :
    List (CheckId × Nat) :=
  let next := history ++ [(check, duration)]
  if (next.filter fun h => h.1 == check).length > window then next.eraseP fun h => h.1 == check else next

/-! ## Events from outside -/

/-- A new change joins the queue. An id the queue has seen is refused. -/
def State.enqueue (s : State) (id : ChangeId) (priority : Nat) : State :=
  if s.changes.any (fun c => c.id == id) then s
  else
    { s with
      changes := s.changes ++ [{ id, priority, seq := s.nextSeq, rev := 0, attempts := 0, status := .queued }]
      nextSeq := s.nextSeq + 1 }

/-- End a change that has not ended as withdrawn. -/
def State.withdrawNow (s : State) (id : ChangeId) : State :=
  { s with
    changes := s.changes.map fun c =>
      if c.id = id ∧ (c.status.isQueued ∨ c.status.isFixing) then { c with status := .withdrawn } else c }

/-- The author takes a change back. Only a change that has not ended can be
withdrawn, and not one that is on its way onto the target: that one lands. -/
def State.withdraw (s : State) (id : ChangeId) : State :=
  if s.changes.any (fun c => c.id == id && s.pushingPart c.part) then s else s.withdrawNow id

/-- Someone other than the queue put a commit on the target. The queue adopts
the new tip: the commit joins the target's tree as a merged change the queue
did not test, and every run on the old tip stops being live, so everything
still queued is rebuilt on the new tip and tested again. -/
def State.foreign (s : State) (id : ChangeId) : State :=
  if s.changes.any (fun c => c.id == id) then s
  else
    { s with
      main := s.main ++ [⟨id, 0⟩]
      changes := s.changes ++ [{ id, priority := 0, seq := s.nextSeq, rev := 0, attempts := 0, status := .merged }]
      nextSeq := s.nextSeq + 1
      landed := s.landed ++ [{ run := 0, base := s.main, batch := [⟨id, 0⟩], results := [], foreign := true }] }

/-- One check result streams in. It is recorded when the check is required, the
run exists and the check has no result yet. -/
def State.result (cfg : Config) (s : State) (run : RunId) (check : CheckId) (verdict : Verdict)
    (duration : Nat) : State :=
  if cfg.required.contains check ∧ s.runs.any (fun r => r.id == run && !answered r.results check) then
    { s with
      runs := s.runs.map fun r =>
        if r.id = run ∧ answered r.results check = false then { r with results := r.results ++ [(check, verdict)] }
        else r
      history := record cfg.window s.history check duration }
  else s

/-- The new revision of a change being fixed, queued again with a new arrival
number. -/
def State.fixedNow (s : State) (id : ChangeId) (attempt : Nat) : State :=
  { s with
    changes := s.changes.map fun c =>
      if c.id = id ∧ c.status.isFixing ∧ c.attempts = attempt then
        { c with rev := c.rev + 1, seq := s.nextSeq, status := .queued }
      else c
    nextSeq := s.nextSeq + 1 }

/-- A fix agent delivers a new revision, for the fix attempt it was started
for. The change is queued again at the back of its priority: it takes a new
arrival number, so it does not jump ahead of the runs already in flight. -/
def State.fixed (s : State) (id : ChangeId) (attempt : Nat) : State :=
  if s.changes.any (fun c => c.id == id && c.status.isFixing && c.attempts == attempt) then s.fixedNow id attempt
  else s

/-- A fix agent judges the change unmergeable. The verdict stands only with
written words for the author. -/
def State.gaveUp (s : State) (id : ChangeId) (attempt : Nat) (detail : String) : State :=
  { s with
    changes := s.changes.map fun c =>
      if c.id = id ∧ c.status.isFixing ∧ c.attempts = attempt ∧ detail ≠ "" then
        { c with status := .unmergeable ⟨.agentVerdict, detail, s.failuresOf c, c.attempts⟩ }
      else c }

/-! ## Decisions -/

/-- Start a run on the target's tree plus the first `count` ready changes. -/
def State.start (cfg : Config) (s : State) (count : Nat) : State :=
  let batch := (s.ready.take count).map Change.part
  if count = 0 ∨ s.ready.length < count ∨ cfg.maxRuns ≤ s.pendingCount cfg
      ∨ s.runs.any (fun r => r.tree == s.main ++ batch) then s
  else
    { s with
      runs := s.runs ++ [{ id := s.nextRun, base := s.main, batch, results := [] }]
      nextRun := s.nextRun + 1 }

/-- Test one ready change alone on the target's tree. A probe is an ordinary
run: it is blamed at its first failed check, and it can land if it is green.
Its use is to find a failing change before it holds up the changes queued
around it. -/
def State.probe (cfg : Config) (s : State) (id : ChangeId) : State :=
  match s.changes.find? fun c => c.id == id && c.status.isQueued with
  | none => s
  | some c =>
    if cfg.maxRuns ≤ s.pendingCount cfg ∨ s.runs.any (fun r => r.tree == s.main ++ [c.part]) then s
    else
      { s with
        runs := s.runs ++ [{ id := s.nextRun, base := s.main, batch := [c.part], results := [] }]
        nextRun := s.nextRun + 1 }

/-- Decide to fast-forward the target onto a run's tree. The run must be live
and its result complete and green, and no other push may be under way. Nothing
lands yet: the landing is recorded when the target is seen on that tree. -/
def State.push (cfg : Config) (s : State) (run : RunId) : State :=
  match s.pushingRun with
  | some _ => s
  | none =>
    match s.findRun run with
    | none => s
    | some r => if (s.live r).isSome && green cfg r.results then { s with pushing := some run } else s

/-- Record a landing. The run must be live and its result complete and green.
The target becomes exactly the tree that was tested, which extends the target
as it is now: a fast-forward. -/
def State.landNow (cfg : Config) (s : State) (run : RunId) : State :=
  match s.findRun run with
  | none => s
  | some r =>
    match s.live r with
    | none => s
    | some batch =>
      if green cfg r.results then
        { s with
          main := r.tree
          changes := s.changes.map fun c =>
            if batch.contains c.part ∧ c.status.isQueued then { c with status := .merged } else c
          runs := s.runs.filter fun x => x.id != run
          landed := s.landed ++ [{ run, base := s.main, batch, results := r.results, foreign := false }]
          pushing := none }
      else s

/-- The target was seen on the tree the queue was pushing. Only the run being
pushed can land. -/
def State.land (cfg : Config) (s : State) (run : RunId) : State :=
  if s.pushing = some run then s.landNow cfg run else s

/-- The words recorded when a change runs out of fix attempts. -/
def exhaustedDetail : String := "still failing after every allowed fix attempt"

/-- Blame the only suspect of a failed run. The run must be live with exactly
one part beyond the target, and one failed check is enough: blame does not wait
for the run to finish. The change goes to a fix agent, or, with no attempts
left, out of the queue with a reason. -/
def State.blame (cfg : Config) (s : State) (run : RunId) : State :=
  match s.findRun run with
  | none => s
  | some r =>
    match s.live r with
    | some [p] =>
      if failed r.results then
        { s with
          changes := s.changes.map fun c =>
            if c.part = p ∧ c.status.isQueued then
              if c.attempts < cfg.maxAttempts then { c with attempts := c.attempts + 1, status := .fixing run }
              else
                { c with
                  status := .unmergeable ⟨.attemptsExhausted, exhaustedDetail, failures r.results, c.attempts⟩ }
            else c }
      else s
    | _ => s

/-- Forget a run. Always allowed: losing a run can only delay a landing. -/
def State.cancel (s : State) (run : RunId) : State :=
  { s with runs := s.runs.filter fun x => x.id != run }

/-- The queue. -/
def step (cfg : Config) (s : State) : Event → State
  | .enqueue id priority => s.enqueue id priority
  | .withdraw id => s.withdraw id
  | .result run check verdict duration => s.result cfg run check verdict duration
  | .fixed id attempt => s.fixed id attempt
  | .gaveUp id attempt detail => s.gaveUp id attempt detail
  | .foreign id => s.foreign id
  | .push run => s.push cfg run
  | .probe id => s.probe cfg id
  | .start count => s.start cfg count
  | .land run => s.land cfg run
  | .blame run => s.blame cfg run
  | .cancel run => s.cancel run

/-- Apply a list of events in order. -/
def run (cfg : Config) (s : State) (events : List Event) : State :=
  events.foldl (step cfg) s

/-- The states the queue can reach from empty. -/
inductive Reachable (cfg : Config) : State → Prop where
  | empty : Reachable cfg State.empty
  | step {s : State} (e : Event) : Reachable cfg s → Reachable cfg (step cfg s e)

end MergeQueue

/-!
# The merge queue's vocabulary

A merge queue owns one target branch. People and agents hand it changes; it
tests candidate trees and moves the target only onto a tree whose every
required check passed.

The names here are the names the TypeScript kernel uses
(`packages/smithers/flows/merge-queue/src`). One Lean definition maps to one
TypeScript definition.
-/

namespace MergeQueue

abbrev ChangeId := Nat
abbrev CheckId := Nat
abbrev RunId := Nat

/-- One revision of one change. A tree is made of parts, so two trees are the
same tree exactly when they apply the same revisions in the same order. -/
structure Part where
  id : ChangeId
  rev : Nat
deriving DecidableEq, Repr, Inhabited

/-- A tree is the list of parts applied on top of the target's first commit, in
order. The target branch itself is a tree; a candidate is the target's tree
with more parts appended. -/
abbrev Tree := List Part

inductive Verdict where
  | pass
  | fail
deriving DecidableEq, Repr, Inhabited

/-- Why a change was put out of the queue as unmergeable. -/
inductive ReasonKind where
  /-- The change failed as the only suspect once more than `maxAttempts` fix
  attempts allow. -/
  | attemptsExhausted
  /-- The fix agent judged that the change must be redone from scratch. -/
  | agentVerdict
deriving DecidableEq, Repr, Inhabited

/-- The written record handed to a change's author when it is unmergeable. -/
structure Reason where
  kind : ReasonKind
  /-- The words for the author. Never empty. -/
  detail : String
  /-- The checks that had failed for the last revision tested. -/
  failures : List CheckId
  /-- The fix attempts the change had used. -/
  attempts : Nat
deriving DecidableEq, Repr, Inhabited

inductive Status where
  /-- Waiting to be tested, or being tested. -/
  | queued
  /-- A fix agent is working on it. `run` is the run whose failure blamed it;
  that run's later failures keep streaming to the agent. -/
  | fixing (run : RunId)
  | merged
  | unmergeable (reason : Reason)
  | withdrawn
deriving DecidableEq, Repr, Inhabited

def Status.isQueued : Status → Bool
  | .queued => true
  | _ => false

def Status.isFixing : Status → Bool
  | .fixing _ => true
  | _ => false

/-- A terminal status never changes again. -/
def Status.isTerminal : Status → Bool
  | .merged => true
  | .unmergeable _ => true
  | .withdrawn => true
  | _ => false

structure Change where
  id : ChangeId
  /-- Higher lands first. -/
  priority : Nat
  /-- Arrival order; breaks priority ties. A fix takes a new one, so a fixed
  change queues behind the runs already in flight. -/
  seq : Nat
  /-- Bumped by every fix. -/
  rev : Nat
  /-- Fix attempts used. -/
  attempts : Nat
  status : Status
deriving DecidableEq, Repr, Inhabited

def Change.part (c : Change) : Part := ⟨c.id, c.rev⟩

/-- One CI run on one exact tree. `tree = base ++ batch`. -/
structure Run where
  id : RunId
  /-- The target's tree when the run started. -/
  base : Tree
  /-- The parts under test, in landing order. -/
  batch : List Part
  /-- Check results in arrival order. The first result for a check stands. -/
  results : List (CheckId × Verdict)
deriving DecidableEq, Repr, Inhabited

def Run.tree (r : Run) : Tree := r.base ++ r.batch

/-- The audit record of one landing. -/
structure Landing where
  run : RunId
  /-- The target's tree before. -/
  base : Tree
  /-- The parts that landed. -/
  batch : List Part
  /-- The results that justified it. -/
  results : List (CheckId × Verdict)
  /-- Someone other than the queue put these commits on the target. The queue
  did not test them; it adopted the new tip and retests everything on it. -/
  foreign : Bool
deriving DecidableEq, Repr, Inhabited

def Landing.tree (l : Landing) : Tree := l.base ++ l.batch

structure Config where
  /-- Every check a tree must pass before the target moves onto it. -/
  required : List CheckId
  /-- Fix attempts a change may use before it is unmergeable. -/
  maxAttempts : Nat
  /-- Most changes tested together in one new batch. -/
  maxBatch : Nat
  /-- Most undecided runs at once. -/
  maxRuns : Nat
  /-- Duration samples kept per check. -/
  window : Nat
  /-- The estimate for a check with no samples. -/
  defaultDuration : Nat
deriving Repr, Inhabited

/-- Everything the queue remembers. All of it is durable: a restart continues
from this value alone. -/
structure State where
  /-- The target branch's tree. -/
  main : Tree
  /-- Every change ever enqueued, in arrival order. Never shrinks. -/
  changes : List Change
  runs : List Run
  nextRun : RunId
  nextSeq : Nat
  /-- Every landing, oldest first. -/
  landed : List Landing
  /-- Durations of finished checks, oldest first, at most `window` per check. -/
  history : List (CheckId × Nat)
  /-- The run whose tree the queue is fast-forwarding the target onto. The
  landing is recorded when the target is seen there. -/
  pushing : Option RunId
deriving Repr, Inhabited

def State.empty : State :=
  { main := [], changes := [], runs := [], nextRun := 0, nextSeq := 0, landed := [], history := [], pushing := none }

/-- What happens to the queue. The first group arrives from outside; the second
is what the queue decides, and `Policy.plan` chooses among them. Every event is
safe at any time: `step` refuses one whose guard does not hold. -/
inductive Event where
  | enqueue (id : ChangeId) (priority : Nat)
  | withdraw (id : ChangeId)
  /-- One check of one run finished. -/
  | result (run : RunId) (check : CheckId) (verdict : Verdict) (duration : Nat)
  /-- The fix agent for `id`, on fix attempt `attempt`, produced a new revision. -/
  | fixed (id : ChangeId) (attempt : Nat)
  /-- The fix agent judged the change unmergeable and wrote why. -/
  | gaveUp (id : ChangeId) (attempt : Nat) (detail : String)
  /-- Someone other than the queue put a commit on the target. -/
  | foreign (id : ChangeId)
  /-- The target was seen on the tree the queue was pushing: the landing. -/
  | land (run : RunId)
  /-- Test the first `count` ready changes on top of the target. -/
  | start (count : Nat)
  /-- Test one ready change alone on the target, to find a failing change
  before it holds up the changes around it. -/
  | probe (id : ChangeId)
  /-- Fast-forward the target onto a run's tree. -/
  | push (run : RunId)
  /-- Send the only suspect of a failed run to a fix agent. -/
  | blame (run : RunId)
  /-- Forget a run: the queue cancelled it, or CI lost it. -/
  | cancel (run : RunId)
deriving DecidableEq, Repr, Inhabited

end MergeQueue

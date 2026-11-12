import MergeQueue.Invariant
import MergeQueue.Policy

/-!
# What the queue keeps between rounds

The state of `Basic.lean` never forgets: every change ever enqueued and every
landing stay in it, and the invariants are proved about that state. A queue
that runs for months cannot carry all of it from round to round. What it
carries is `s.pruned`: the changes that have not ended, and no landings. How
each change ended goes to a record outside the state.

This file proves that forgetting changes nothing the queue does. Nothing
`step` or `plan` reads looks at an ended change or a landing, so:

* `pruned_plan`: the pruned state plans the same decision;
* `pruned_step`: one event on the pruned state gives the pruning of that event
  on the full state;
* `pruned_run`, `pruned_settle`: so do a whole trace and the policy's
  settling, for the queue that prunes after every event (`runPruned`,
  `settlePruned`), which is what the driver does.

One rule is needed: **a change id is never used again** (`Event.fresh`). `step`
refuses an `enqueue` or a `foreign` commit for an id the state holds, and the
pruned state no longer holds the id of a change that ended.
-/

namespace MergeQueue

/-- What the queue keeps: the changes that have not ended, and no landings. -/
def State.pruned (s : State) : State :=
  { s with changes := s.changes.filter (fun c => !c.status.isTerminal), landed := [] }

/-- The rule that a change id is never used again: the event does not hand in,
as a new change or as a foreign commit, the id of a change that has ended. -/
def Event.fresh (s : State) : Event → Bool
  | .enqueue id _ => !s.changes.any fun c => c.id == id && c.status.isTerminal
  | .foreign id => !s.changes.any fun c => c.id == id && c.status.isTerminal
  | _ => true

/-! ## Reading the pruned state -/

theorem Status.queued_not_terminal {st : Status} (h : st.isQueued = true) : st.isTerminal = false := by
  cases st <;> simp_all [Status.isQueued, Status.isTerminal]

theorem Status.fixing_not_terminal {st : Status} (h : st.isFixing = true) : st.isTerminal = false := by
  cases st <;> simp_all [Status.isFixing, Status.isTerminal]

@[simp] theorem State.pruned_main (s : State) : s.pruned.main = s.main := rfl
@[simp] theorem State.pruned_runs (s : State) : s.pruned.runs = s.runs := rfl
@[simp] theorem State.pruned_nextRun (s : State) : s.pruned.nextRun = s.nextRun := rfl
@[simp] theorem State.pruned_nextSeq (s : State) : s.pruned.nextSeq = s.nextSeq := rfl
@[simp] theorem State.pruned_history (s : State) : s.pruned.history = s.history := rfl
@[simp] theorem State.pruned_pushing (s : State) : s.pruned.pushing = s.pushing := rfl
@[simp] theorem State.pruned_landed (s : State) : s.pruned.landed = [] := rfl

theorem State.pruned_changes (s : State) :
    s.pruned.changes = s.changes.filter (fun c => !c.status.isTerminal) := rfl

/-- Pruning twice is pruning once. -/
theorem State.pruned_pruned (s : State) : s.pruned.pruned = s.pruned := by
  simp [State.pruned, List.filter_filter]

/-- Two states with the same fields apart from changes and landings prune to
the same state when their changes that have not ended are the same. -/
theorem State.pruned_congr {s t : State} (main : s.main = t.main) (runs : s.runs = t.runs)
    (nextRun : s.nextRun = t.nextRun) (nextSeq : s.nextSeq = t.nextSeq) (history : s.history = t.history)
    (pushing : s.pushing = t.pushing)
    (changes : s.changes.filter (fun c => !c.status.isTerminal) = t.changes.filter (fun c => !c.status.isTerminal)) :
    s.pruned = t.pruned := by
  cases s; cases t; simp_all [State.pruned]

/-- A question asked only of changes that have not ended has the same answer. -/
theorem any_pruned {s : State} {p : Change → Bool} (h : ∀ c, p c = true → c.status.isTerminal = false) :
    s.pruned.changes.any p = s.changes.any p := by
  have same : (fun c : Change => !c.status.isTerminal && p c) = p := by
    funext c
    cases hp : p c
    · simp
    · simp [h c hp]
  rw [State.pruned_changes, List.any_filter, same]

theorem filter_pruned {s : State} {p : Change → Bool} (h : ∀ c, p c = true → c.status.isTerminal = false) :
    s.pruned.changes.filter p = s.changes.filter p := by
  have same : (fun c : Change => p c && !c.status.isTerminal) = p := by
    funext c
    cases hp : p c
    · simp
    · simp [h c hp]
  rw [State.pruned_changes, List.filter_filter, same]

theorem State.pruned_ready (s : State) : s.pruned.ready = s.ready := by
  unfold State.ready
  rw [filter_pruned fun c h => Status.queued_not_terminal h]

theorem State.pruned_partReady (s : State) : s.pruned.partReady = s.partReady := by
  funext p
  unfold State.partReady
  exact any_pruned fun c h => Status.queued_not_terminal (by simp_all)

theorem State.pruned_live (s : State) : s.pruned.live = s.live := by
  funext r
  simp [State.live, State.pruned_partReady]

theorem State.pruned_findRun (s : State) : s.pruned.findRun = s.findRun := rfl

theorem State.pruned_pendingCount (cfg : Config) (s : State) : s.pruned.pendingCount cfg = s.pendingCount cfg := rfl

theorem State.pruned_pushingRun (s : State) : s.pruned.pushingRun = s.pushingRun := by
  simp [State.pushingRun, State.pruned_live, State.pruned_findRun]

theorem State.pruned_pushingPart (s : State) : s.pruned.pushingPart = s.pushingPart := by
  funext p
  simp [State.pushingPart, State.pruned_pushingRun]

theorem State.pruned_failuresOf (s : State) : s.pruned.failuresOf = s.failuresOf := rfl

/-! ## The policy reads nothing that was pruned -/

theorem State.pruned_landable (cfg : Config) (s : State) : s.pruned.landable cfg = s.landable cfg := by
  funext r
  simp [State.landable, State.pruned_live]

theorem State.pruned_blameable (s : State) : s.pruned.blameable = s.blameable := by
  funext r
  simp [State.blameable, State.pruned_live]

theorem State.pruned_evidence (s : State) : s.pruned.evidence = s.evidence := by
  funext r
  unfold State.evidence
  exact any_pruned fun c h => by
    have : c.status = .fixing r.id := by simpa using h
    simp [this, Status.isTerminal]

theorem State.pruned_prefixLength (s : State) : s.pruned.prefixLength = s.prefixLength := by
  funext r
  simp [State.prefixLength, State.pruned_live, State.pruned_ready]

theorem State.pruned_failedPrefixes (s : State) : s.pruned.failedPrefixes = s.failedPrefixes := by
  simp [State.failedPrefixes, State.pruned_prefixLength]

theorem State.pruned_unfailedPrefixes (s : State) : s.pruned.unfailedPrefixes = s.unfailedPrefixes := by
  funext bound
  simp [State.unfailedPrefixes, State.pruned_prefixLength]

theorem State.pruned_shortestFailed (s : State) : s.pruned.shortestFailed = s.shortestFailed := by
  simp [State.shortestFailed, State.pruned_failedPrefixes]

theorem State.pruned_longestUnfailed (s : State) : s.pruned.longestUnfailed = s.longestUnfailed := by
  funext bound
  simp [State.longestUnfailed, State.pruned_unfailedPrefixes]

theorem State.pruned_doomed (s : State) : s.pruned.doomed = s.doomed := by
  funext r
  simp [State.doomed, State.pruned_live, State.pruned_prefixLength, State.pruned_shortestFailed]

theorem State.pruned_outOfOrder (cfg : Config) (s : State) : s.pruned.outOfOrder cfg = s.outOfOrder cfg := by
  simp [State.outOfOrder, State.pruned_live, State.pruned_prefixLength]

theorem State.pruned_nextStart (cfg : Config) (s : State) : s.pruned.nextStart cfg = s.nextStart cfg := by
  simp [State.nextStart, State.pruned_pendingCount, State.pruned_outOfOrder, State.pruned_ready,
    State.pruned_shortestFailed, State.pruned_longestUnfailed]

theorem State.pruned_nextProbe (cfg : Config) (s : State) : s.pruned.nextProbe cfg = s.nextProbe cfg := by
  simp [State.nextProbe, State.pruned_pendingCount, State.pruned_ready]

theorem State.pruned_bestLandable (cfg : Config) (s : State) : s.pruned.bestLandable cfg = s.bestLandable cfg := by
  simp [State.bestLandable, State.pruned_landable]

theorem State.pruned_nextPush (cfg : Config) (s : State) : s.pruned.nextPush cfg = s.nextPush cfg := by
  simp [State.nextPush, State.pruned_pushingRun, State.pruned_bestLandable]

theorem State.pruned_useless (s : State) : s.pruned.useless = s.useless := by
  funext r
  simp [State.useless, State.pruned_live, State.pruned_evidence, State.pruned_doomed]

/-- **The pruned state plans the same decision.** -/
theorem pruned_plan (cfg : Config) (s : State) : plan cfg s.pruned = plan cfg s := by
  simp [plan, State.pruned_nextPush, State.pruned_blameable, State.pruned_useless, State.pruned_nextStart,
    State.pruned_nextProbe]

/-! ## Events on the pruned state -/

/-- Rewriting changes commutes with pruning when the rewrite leaves every
ended change alone. -/
theorem filter_map_fixed {f : Change → Change} {l : List Change}
    (fixed : ∀ c ∈ l, c.status.isTerminal = true → f c = c) :
    ((l.filter (fun c => !c.status.isTerminal)).map f).filter (fun c => !c.status.isTerminal)
      = (l.map f).filter (fun c => !c.status.isTerminal) := by
  induction l with
  | nil => rfl
  | cons a rest ih =>
    have tail := ih fun c member => fixed c (List.mem_cons_of_mem a member)
    cases terminal : a.status.isTerminal
    · simp [List.filter_cons, terminal, tail]
    · have same := fixed a (by simp) terminal
      simp [terminal, tail, same]

/-- A state whose only difference from `s` is a rewrite of its changes that
leaves ended changes alone prunes to the same state from `s` and from
`s.pruned`. -/
theorem State.pruned_rewrite (s : State) (f : Change → Change)
    (fixed : ∀ c ∈ s.changes, c.status.isTerminal = true → f c = c) :
    ({ s.pruned with changes := s.pruned.changes.map f } : State).pruned
      = ({ s with changes := s.changes.map f } : State).pruned := by
  apply State.pruned_congr <;> try rfl
  exact filter_map_fixed fixed

theorem State.pruned_enqueue (s : State) (id : ChangeId) (priority : Nat)
    (fresh : (Event.enqueue id priority).fresh s = true) :
    (s.pruned.enqueue id priority).pruned = (s.enqueue id priority).pruned := by
  have known : s.pruned.changes.any (fun c => c.id == id) = s.changes.any (fun c => c.id == id) := by
    rw [State.pruned_changes, List.any_filter]
    apply Bool.eq_iff_iff.mpr
    simp only [List.any_eq_true, Bool.and_eq_true]
    constructor
    · rintro ⟨c, member, _, same⟩
      exact ⟨c, member, same⟩
    · rintro ⟨c, member, same⟩
      refine ⟨c, member, ?_, same⟩
      cases terminal : c.status.isTerminal
      · rfl
      · have : (s.changes.any fun c => c.id == id && c.status.isTerminal) = true :=
          List.any_eq_true.mpr ⟨c, member, by simp [same, terminal]⟩
        simp [Event.fresh, this] at fresh
  unfold State.enqueue
  rw [known]
  split
  · exact State.pruned_pruned s
  · apply State.pruned_congr <;> try rfl
    simp [State.pruned_changes, List.filter_append, List.filter_filter]

theorem State.pruned_foreign (s : State) (id : ChangeId) (fresh : (Event.foreign id).fresh s = true) :
    (s.pruned.foreign id).pruned = (s.foreign id).pruned := by
  have known : s.pruned.changes.any (fun c => c.id == id) = s.changes.any (fun c => c.id == id) := by
    rw [State.pruned_changes, List.any_filter]
    apply Bool.eq_iff_iff.mpr
    simp only [List.any_eq_true, Bool.and_eq_true]
    constructor
    · rintro ⟨c, member, _, same⟩
      exact ⟨c, member, same⟩
    · rintro ⟨c, member, same⟩
      refine ⟨c, member, ?_, same⟩
      cases terminal : c.status.isTerminal
      · rfl
      · have : (s.changes.any fun c => c.id == id && c.status.isTerminal) = true :=
          List.any_eq_true.mpr ⟨c, member, by simp [same, terminal]⟩
        simp [Event.fresh, this] at fresh
  unfold State.foreign
  rw [known]
  split
  · exact State.pruned_pruned s
  · apply State.pruned_congr <;> try rfl
    simp [State.pruned_changes, List.filter_append, List.filter_filter]

theorem State.pruned_withdrawNow (s : State) (id : ChangeId) :
    (s.pruned.withdrawNow id).pruned = (s.withdrawNow id).pruned := by
  apply State.pruned_rewrite s
  intro c _ terminal
  have queued : c.status.isQueued = false := by
    cases h : c.status.isQueued
    · rfl
    · simp [Status.queued_not_terminal h] at terminal
  have fixing : c.status.isFixing = false := by
    cases h : c.status.isFixing
    · rfl
    · simp [Status.fixing_not_terminal h] at terminal
  simp [queued, fixing]

theorem State.pruned_withdraw (s : State) (id : ChangeId) (ids : (s.changes.map (·.id)).Nodup) :
    (s.pruned.withdraw id).pruned = (s.withdraw id).pruned := by
  unfold State.withdraw
  rw [State.pruned_pushingPart]
  cases kept : s.pruned.changes.any (fun c => c.id == id && s.pushingPart c.part)
  · cases full : s.changes.any (fun c => c.id == id && s.pushingPart c.part)
    · simpa using State.pruned_withdrawNow s id
    · -- The change being pushed under this id has ended, so no change the
      -- queue still holds has the id, and the withdrawal changes nothing.
      obtain ⟨c0, member0, holds0⟩ := List.any_eq_true.mp full
      have id0 : c0.id = id := by
        have both := holds0
        simp only [Bool.and_eq_true, beq_iff_eq] at both
        exact both.1
      have ended0 : c0.status.isTerminal = true := by
        cases terminal : c0.status.isTerminal
        · have : s.pruned.changes.any (fun c => c.id == id && s.pushingPart c.part) = true :=
            List.any_eq_true.mpr ⟨c0, by simp [State.pruned_changes, member0, terminal], holds0⟩
          simp [kept] at this
        · rfl
      have none : ∀ c ∈ s.pruned.changes, c.id ≠ id := by
        intro c member same
        have parts := List.mem_filter.mp (State.pruned_changes s ▸ member)
        have equal : c = c0 := eq_of_nodup_map ids parts.1 member0 (same.trans id0.symm)
        simp [equal, ended0] at parts
      have unchanged : s.pruned.withdrawNow id = s.pruned := by
        unfold State.withdrawNow
        have : (s.pruned.changes.map fun c =>
            if c.id = id ∧ (c.status.isQueued ∨ c.status.isFixing) then { c with status := .withdrawn } else c)
            = s.pruned.changes := by
          conv => rhs; rw [← List.map_id s.pruned.changes]
          apply List.map_congr_left
          intro c member
          simp [none c member]
        rw [this]
      simp [unchanged, State.pruned_pruned]
  · have full : s.changes.any (fun c => c.id == id && s.pushingPart c.part) = true := by
      obtain ⟨c, member, holds⟩ := List.any_eq_true.mp kept
      exact List.any_eq_true.mpr ⟨c, (List.mem_filter.mp (State.pruned_changes s ▸ member)).1, holds⟩
    simp [full, State.pruned_pruned]

theorem State.pruned_result (cfg : Config) (s : State) (run : RunId) (check : CheckId) (verdict : Verdict)
    (duration : Nat) :
    (s.pruned.result cfg run check verdict duration).pruned = (s.result cfg run check verdict duration).pruned := by
  unfold State.result
  simp only [State.pruned_runs, State.pruned_history]
  split
  · apply State.pruned_congr <;> first | rfl | simp [State.pruned_changes, List.filter_filter]
  · exact State.pruned_pruned s

theorem State.pruned_fixed (s : State) (id : ChangeId) (attempt : Nat) :
    (s.pruned.fixed id attempt).pruned = (s.fixed id attempt).pruned := by
  have known : s.pruned.changes.any (fun c => c.id == id && c.status.isFixing && c.attempts == attempt)
      = s.changes.any (fun c => c.id == id && c.status.isFixing && c.attempts == attempt) :=
    any_pruned fun c h => Status.fixing_not_terminal (by simp_all)
  unfold State.fixed
  rw [known]
  split
  · unfold State.fixedNow
    apply State.pruned_congr <;> try rfl
    apply filter_map_fixed
    intro c _ terminal
    have fixing : c.status.isFixing = false := by
      cases h : c.status.isFixing
      · rfl
      · simp [Status.fixing_not_terminal h] at terminal
    simp [fixing]
  · exact State.pruned_pruned s

theorem State.pruned_gaveUp (s : State) (id : ChangeId) (attempt : Nat) (detail : String) :
    (s.pruned.gaveUp id attempt detail).pruned = (s.gaveUp id attempt detail).pruned := by
  unfold State.gaveUp
  rw [State.pruned_failuresOf]
  apply State.pruned_rewrite s
  intro c _ terminal
  have fixing : c.status.isFixing = false := by
    cases h : c.status.isFixing
    · rfl
    · simp [Status.fixing_not_terminal h] at terminal
  simp [fixing]

theorem State.pruned_start (cfg : Config) (s : State) (count : Nat) :
    (s.pruned.start cfg count).pruned = (s.start cfg count).pruned := by
  unfold State.start
  simp only [State.pruned_ready, State.pruned_pendingCount, State.pruned_runs, State.pruned_main,
    State.pruned_nextRun]
  split
  · exact State.pruned_pruned s
  · apply State.pruned_congr <;> first | rfl | simp [State.pruned_changes, List.filter_filter]

theorem State.pruned_probe (cfg : Config) (s : State) (id : ChangeId) :
    (s.pruned.probe cfg id).pruned = (s.probe cfg id).pruned := by
  have found : s.pruned.changes.find? (fun c => c.id == id && c.status.isQueued)
      = s.changes.find? (fun c => c.id == id && c.status.isQueued) := by
    have same : (fun c : Change =>
        decide ((!c.status.isTerminal) = true ∧ (c.id == id && c.status.isQueued) = true))
        = fun c => c.id == id && c.status.isQueued := by
      funext c
      cases queued : c.status.isQueued
      · simp
      · have open_ := Status.queued_not_terminal queued
        cases named : c.id == id <;> simp [open_]
    rw [State.pruned_changes, List.find?_filter, same]
  unfold State.probe
  rw [found]
  simp only [State.pruned_pendingCount, State.pruned_runs, State.pruned_main, State.pruned_nextRun]
  split
  · exact State.pruned_pruned s
  · split
    · exact State.pruned_pruned s
    · apply State.pruned_congr <;> first | rfl | simp [State.pruned_changes, List.filter_filter]

theorem State.pruned_push (cfg : Config) (s : State) (run : RunId) :
    (s.pruned.push cfg run).pruned = (s.push cfg run).pruned := by
  unfold State.push
  simp only [State.pruned_pushingRun, State.pruned_findRun, State.pruned_live]
  split
  · exact State.pruned_pruned s
  · split
    · exact State.pruned_pruned s
    · split
      · apply State.pruned_congr <;> first | rfl | simp [State.pruned_changes, List.filter_filter]
      · exact State.pruned_pruned s

theorem State.pruned_landNow (cfg : Config) (s : State) (run : RunId) :
    (s.pruned.landNow cfg run).pruned = (s.landNow cfg run).pruned := by
  unfold State.landNow
  simp only [State.pruned_findRun, State.pruned_live]
  split
  · exact State.pruned_pruned s
  · split
    · exact State.pruned_pruned s
    · rename_i batch _
      split
      · apply State.pruned_congr <;> try rfl
        apply filter_map_fixed
        intro c _ terminal
        have queued : c.status.isQueued = false := by
          cases h : c.status.isQueued
          · rfl
          · simp [Status.queued_not_terminal h] at terminal
        simp [queued]
      · exact State.pruned_pruned s

theorem State.pruned_land (cfg : Config) (s : State) (run : RunId) :
    (s.pruned.land cfg run).pruned = (s.land cfg run).pruned := by
  unfold State.land
  simp only [State.pruned_pushing]
  split
  · exact State.pruned_landNow cfg s run
  · exact State.pruned_pruned s

theorem State.pruned_blame (cfg : Config) (s : State) (run : RunId) :
    (s.pruned.blame cfg run).pruned = (s.blame cfg run).pruned := by
  unfold State.blame
  simp only [State.pruned_findRun, State.pruned_live]
  split
  · exact State.pruned_pruned s
  · split
    · split
      · apply State.pruned_rewrite s
        intro c _ terminal
        have queued : c.status.isQueued = false := by
          cases h : c.status.isQueued
          · rfl
          · simp [Status.queued_not_terminal h] at terminal
        simp [queued]
      · exact State.pruned_pruned s
    · exact State.pruned_pruned s

theorem State.pruned_cancel (s : State) (run : RunId) : (s.pruned.cancel run).pruned = (s.cancel run).pruned := by
  unfold State.cancel
  apply State.pruned_congr <;> first | rfl | simp [State.pruned_changes, List.filter_filter]

/-- **One event on the pruned state is the pruning of that event on the full
state**, for an event that keeps the rule that an id is never used again, on a
state whose changes have distinct ids (every reachable state: `Inv.changeIds`). -/
theorem pruned_step (cfg : Config) (s : State) (e : Event) (ids : (s.changes.map (·.id)).Nodup)
    (fresh : e.fresh s = true) : (step cfg s.pruned e).pruned = (step cfg s e).pruned := by
  cases e with
  | enqueue id priority => exact State.pruned_enqueue s id priority fresh
  | withdraw id => exact State.pruned_withdraw s id ids
  | result run check verdict duration => exact State.pruned_result cfg s run check verdict duration
  | fixed id attempt => exact State.pruned_fixed s id attempt
  | gaveUp id attempt detail => exact State.pruned_gaveUp s id attempt detail
  | foreign id => exact State.pruned_foreign s id fresh
  | land run => exact State.pruned_land cfg s run
  | start count => exact State.pruned_start cfg s count
  | probe id => exact State.pruned_probe cfg s id
  | push run => exact State.pruned_push cfg s run
  | blame run => exact State.pruned_blame cfg s run
  | cancel run => exact State.pruned_cancel s run

/-! ## Whole traces and whole rounds -/

/-- The queue that keeps only the pruned state: one event, then prune. -/
def runPruned (cfg : Config) (s : State) (events : List Event) : State :=
  events.foldl (fun t e => (step cfg t e).pruned) s

/-- The policy settling on the queue that keeps only the pruned state. -/
def settlePruned (cfg : Config) : Nat → State → State
  | 0, s => s
  | fuel + 1, s =>
    match plan cfg s with
    | some e => settlePruned cfg fuel (step cfg s e).pruned
    | none => s

/-- A trace keeps the rule when each event is fresh for the state the full
queue is in when the event arrives. -/
def freshTrace (cfg : Config) : State → List Event → Prop
  | _, [] => True
  | s, e :: rest => e.fresh s = true ∧ freshTrace cfg (step cfg s e) rest

/-- The policy never hands in a change: every decision keeps the rule. -/
theorem plan_fresh {cfg : Config} {s : State} {e : Event} (planned : plan cfg s = some e) : e.fresh s = true := by
  unfold plan at planned
  repeat' split at planned
  all_goals first
    | (injection planned with same; subst same; rfl)
    | exact absurd planned (by simp)

/-- **A trace on the pruned queue ends in the pruning of that trace on the
full queue**, from any reachable state, when the trace keeps the rule that an
id is never used again. -/
theorem pruned_run (cfg : Config) {s : State} (reach : Reachable cfg s) (events : List Event)
    (fresh : freshTrace cfg s events) : runPruned cfg s.pruned events = (run cfg s events).pruned := by
  induction events generalizing s with
  | nil => rfl
  | cons e rest ih =>
    have here : (step cfg s.pruned e).pruned = (step cfg s e).pruned :=
      pruned_step cfg s e reach.inv.changeIds fresh.1
    have later := ih (Reachable.step e reach) fresh.2
    simpa [runPruned, run, here] using later

/-- **The policy settles the pruned queue into the pruning of what it settles
the full queue into.** -/
theorem pruned_settle (cfg : Config) (fuel : Nat) {s : State} (reach : Reachable cfg s) :
    settlePruned cfg fuel s.pruned = (settle cfg fuel s).pruned := by
  induction fuel generalizing s with
  | zero => rfl
  | succ fuel ih =>
    simp only [settlePruned, settle, pruned_plan]
    cases planned : plan cfg s with
    | none => rfl
    | some e =>
      have here : (step cfg s.pruned e).pruned = (step cfg s e).pruned :=
        pruned_step cfg s e reach.inv.changeIds (plan_fresh planned)
      simpa [here] using ih (Reachable.step e reach)

/-- **One round of the pruned queue is the pruning of that round of the full
queue**: fold the events the world reported, then let the policy settle. -/
theorem pruned_round (cfg : Config) (fuel : Nat) {s : State} (reach : Reachable cfg s) (events : List Event)
    (fresh : freshTrace cfg s events) :
    settlePruned cfg fuel (runPruned cfg s.pruned events) = (settle cfg fuel (run cfg s events)).pruned := by
  have reached : Reachable cfg (run cfg s events) := by
    clear fresh
    induction events generalizing s with
    | nil => exact reach
    | cons e rest ih => exact ih (Reachable.step e reach)
  rw [pruned_run cfg reach events fresh]
  exact pruned_settle cfg fuel reached

end MergeQueue

import MergeQueue.Invariant

/-!
# Safety

What can never happen, in the words of the brief. Each theorem is a row of
`INVARIANTS.md`.
-/

namespace MergeQueue

/-! ## Main is always green -/

/-- A green result is a complete result. -/
theorem green_complete {cfg : Config} {results : List (CheckId × Verdict)} (h : green cfg results = true) :
    complete cfg results = true := by
  simp only [green, Bool.and_eq_true, List.all_eq_true] at h
  simp only [complete, List.all_eq_true]
  intro c hc
  have pass := h.1.2 c hc
  simp only [passed, List.contains_iff_mem] at pass
  simp only [answered, List.any_eq_true, beq_iff_eq]
  exact ⟨_, pass, rfl⟩

/-- A green result has no failed check. -/
theorem green_not_failed {cfg : Config} {results : List (CheckId × Verdict)} (h : green cfg results = true) :
    failed results = false := by
  simp only [green, Bool.and_eq_true, Bool.not_eq_true'] at h
  exact h.2

/-- A green result means there was something to check. -/
theorem green_checked {cfg : Config} {results : List (CheckId × Verdict)} (h : green cfg results = true) :
    cfg.required ≠ [] ∧ ∀ c ∈ cfg.required, (c, Verdict.pass) ∈ results := by
  simp only [green, Bool.and_eq_true, List.all_eq_true, Bool.not_eq_true', List.isEmpty_eq_false_iff] at h
  refine ⟨h.1.1, fun c hc => ?_⟩
  simpa [passed] using h.1.2 c hc

/-- **Main is always green.** In every reachable state the target's tree is
the empty tree it started from, or the exact tree of a recorded landing whose
result was complete and green. -/
theorem main_always_green {cfg : Config} {s : State} (reachable : Reachable cfg s) :
    s.main = [] ∨ ∃ l ∈ s.landed, l.tree = s.main ∧ l.batch ≠ [] ∧ green cfg l.results = true := by
  have inv := reachable.inv
  rcases inv.chain.last_landed with same | ⟨l, member, tree⟩
  · exact Or.inl same
  · exact Or.inr ⟨l, member, tree, inv.landings l member⟩

/-- Every landing in the record starts on the tree the one before it made: the
target never held a tree the record does not show. -/
theorem landings_form_one_chain {cfg : Config} {s : State} (reachable : Reachable cfg s) :
    Chained [] s.landed s.main :=
  reachable.inv.chain

/-! ## The tested tree is the merged tree -/

/-- **Only a landing moves the target.** -/
theorem main_moves_only_by_land {cfg : Config} {s : State} {e : Event} (moved : (step cfg s e).main ≠ s.main) :
    ∃ run, e = .land run := by
  cases e with
  | land run => exact ⟨run, rfl⟩
  | enqueue id priority => exact absurd (by simp only [step, State.enqueue]; split <;> rfl) moved
  | withdraw id => exact absurd rfl moved
  | result run check verdict duration =>
    exact absurd (by simp only [step, State.result]; split <;> rfl) moved
  | fixed id attempt => exact absurd rfl moved
  | gaveUp id attempt detail => exact absurd rfl moved
  | start count => exact absurd (by simp only [step, State.start]; split <;> rfl) moved
  | blame run => exact absurd (by simp only [step, State.blame]; (repeat' split) <;> rfl) moved
  | cancel run => exact absurd rfl moved

/-- **The tested tree is the merged tree.** When a landing moves the target,
the new target is exactly the tree of a run the queue holds, that run's result
is complete and green, and the run tested that tree and no other. -/
theorem land_tree_was_tested {cfg : Config} {s : State} {run : RunId} (moved : (s.land cfg run).main ≠ s.main) :
    ∃ r ∈ s.runs, r.id = run ∧ (s.land cfg run).main = r.tree ∧ green cfg r.results = true
      ∧ complete cfg r.results = true ∧ failed r.results = false := by
  unfold State.land at moved ⊢
  split at moved
  · exact absurd rfl moved
  · rename_i r found
    obtain ⟨member, id⟩ := State.findRun_some found
    split at moved
    · exact absurd rfl moved
    · split at moved
      · rename_i isGreen
        refine ⟨r, member, id, ?_, isGreen, green_complete isGreen, green_not_failed isGreen⟩
        simp [*]
      · exact absurd rfl moved

/-- **Streaming never lets a partial result merge.** A run that still misses a
required check cannot land, whatever has passed so far. -/
theorem partial_result_never_lands {cfg : Config} {s : State} {run : RunId} {r : Run}
    (found : s.findRun run = some r) (unfinished : complete cfg r.results = false) : s.land cfg run = s := by
  unfold State.land
  simp only [found]
  split
  · rfl
  · split
    · rename_i isGreen
      rw [green_complete isGreen] at unfinished
      cases unfinished
    · rfl

/-- A run with a failed check cannot land. -/
theorem failed_result_never_lands {cfg : Config} {s : State} {run : RunId} {r : Run}
    (found : s.findRun run = some r) (hasFailed : failed r.results = true) : s.land cfg run = s := by
  unfold State.land
  simp only [found]
  split
  · rfl
  · split
    · rename_i isGreen
      rw [green_not_failed isGreen] at hasFailed
      cases hasFailed
    · rfl

/-- A run the queue does not hold cannot land: a stale or invented run id is
refused. -/
theorem unknown_run_never_lands {cfg : Config} {s : State} {run : RunId} (absent : s.findRun run = none) :
    s.land cfg run = s := by
  unfold State.land
  simp [absent]

/-- **The target only grows.** Every event leaves the target's tree as it was
or appends to it; nothing already landed is reordered or removed. -/
theorem main_only_grows (cfg : Config) (s : State) (e : Event) :
    ∃ added, (step cfg s e).main = s.main ++ added := by
  by_cases same : (step cfg s e).main = s.main
  · exact ⟨[], by simp [same]⟩
  · obtain ⟨run, rfl⟩ := main_moves_only_by_land same
    obtain ⟨r, _, _, tree, _⟩ := land_tree_was_tested same
    simp only [step] at same ⊢
    unfold State.land at same tree ⊢
    split at same
    · exact absurd rfl same
    · rename_i found _
      split at same
      · exact absurd rfl same
      · rename_i batch live
        split at same
        · exact ⟨batch, by simp [*, (State.live_some live).1]⟩
        · exact absurd rfl same

/-! ## No change is lost or merged twice -/

/-- **No change merges twice.** The target's tree applies each change at most
once. -/
theorem merged_at_most_once {cfg : Config} {s : State} (reachable : Reachable cfg s) :
    (s.main.map (·.id)).Nodup :=
  reachable.inv.mainNodup

/-- A change is recorded as merged exactly when the target's tree holds it, at
the revision recorded. -/
theorem merged_iff_in_main {cfg : Config} {s : State} (reachable : Reachable cfg s) {c : Change}
    (member : c ∈ s.changes) : c.status = .merged ↔ c.part ∈ s.main := by
  have inv := reachable.inv
  constructor
  · exact inv.mergedMain c member
  · intro inMain
    obtain ⟨d, dMember, part, merged⟩ := inv.mainMerged _ inMain
    have : d = c := eq_of_nodup_map inv.changeIds dMember member (Change.part_eq.mp part).1
    rw [← this]
    exact merged

theorem mem_map_of_fixed {α : Type} {l : List α} {g : α → α} {a : α} (member : a ∈ l) (fixed : g a = a) :
    a ∈ l.map g :=
  List.mem_map.mpr ⟨a, member, fixed⟩

/-- **A change that has ended stays exactly as it ended.** Merged, unmergeable
and withdrawn are final: no event changes such a change or removes it. -/
theorem ended_is_final (cfg : Config) {s : State} {c : Change} (member : c ∈ s.changes)
    (ended : c.status.isTerminal = true) (e : Event) : c ∈ (step cfg s e).changes := by
  have notQueued : c.status.isQueued = false := by
    cases h : c.status <;> simp_all [Status.isTerminal, Status.isQueued]
  have notFixing : c.status.isFixing = false := Status.terminal_not_fixing ended
  cases e with
  | enqueue id priority =>
    simp only [step, State.enqueue]
    split
    · exact member
    · exact List.mem_append_left _ member
  | withdraw id => exact mem_map_of_fixed member (by simp [notQueued, notFixing])
  | result run check verdict duration =>
    simp only [step, State.result]
    split <;> exact member
  | fixed id attempt => exact mem_map_of_fixed member (by simp [notFixing])
  | gaveUp id attempt detail => exact mem_map_of_fixed member (by simp [notFixing])
  | start count =>
    simp only [step, State.start]
    split <;> exact member
  | land run =>
    simp only [step, State.land]
    (repeat' split) <;> first | exact member | exact mem_map_of_fixed member (by simp [notQueued])
  | blame run =>
    simp only [step, State.blame]
    (repeat' split) <;> first | exact member | exact mem_map_of_fixed member (by simp [notQueued])
  | cancel run => exact member

/-- **No change is ever lost.** Whatever happens, a change the queue has seen
is still in the queue's record, under the same id, arrival number and priority. -/
theorem never_lost (cfg : Config) {s : State} {c : Change} (member : c ∈ s.changes) (e : Event) :
    ∃ d ∈ (step cfg s e).changes, d.id = c.id ∧ d.seq = c.seq ∧ d.priority = c.priority := by
  have mapped : ∀ g : Change → Change, (∀ x, (g x).id = x.id ∧ (g x).seq = x.seq ∧ (g x).priority = x.priority) →
      ∃ d ∈ s.changes.map g, d.id = c.id ∧ d.seq = c.seq ∧ d.priority = c.priority :=
    fun g keeps => ⟨g c, List.mem_map_of_mem member, keeps c⟩
  have same : ∃ d ∈ s.changes, d.id = c.id ∧ d.seq = c.seq ∧ d.priority = c.priority := ⟨c, member, rfl, rfl, rfl⟩
  cases e with
  | enqueue id priority =>
    simp only [step, State.enqueue]
    split
    · exact same
    · exact ⟨c, List.mem_append_left _ member, rfl, rfl, rfl⟩
  | withdraw id => exact mapped _ fun x => by split <;> exact ⟨rfl, rfl, rfl⟩
  | result run check verdict duration =>
    simp only [step, State.result]
    split <;> exact same
  | fixed id attempt => exact mapped _ fun x => by split <;> exact ⟨rfl, rfl, rfl⟩
  | gaveUp id attempt detail => exact mapped _ fun x => by split <;> exact ⟨rfl, rfl, rfl⟩
  | start count =>
    simp only [step, State.start]
    split <;> exact same
  | land run =>
    simp only [step, State.land]
    (repeat' split) <;> first | exact same | exact mapped _ fun x => by split <;> exact ⟨rfl, rfl, rfl⟩
  | blame run =>
    simp only [step, State.blame]
    (repeat' split) <;>
      first
      | exact same
      | exact mapped _ fun x => by (repeat' split) <;> exact ⟨rfl, rfl, rfl⟩
  | cancel run => exact same

/-! ## Fixing is bounded; unmergeable has a reason -/

/-- **Fix loops are bounded.** No change ever uses more fix attempts than the
configured limit. -/
theorem attempts_bounded {cfg : Config} {s : State} (reachable : Reachable cfg s) :
    ∀ c ∈ s.changes, c.attempts ≤ cfg.maxAttempts :=
  reachable.inv.attempts

/-- **Unmergeable only with a recorded reason.** Every unmergeable change
carries written words for its author. -/
theorem unmergeable_has_reason {cfg : Config} {s : State} (reachable : Reachable cfg s) :
    ∀ c ∈ s.changes, ∀ reason, c.status = .unmergeable reason → reason.detail ≠ "" :=
  reachable.inv.reasons

/-- A verdict without words is refused: the change stays with its fix agent. -/
theorem wordless_verdict_refused (s : State) (id : ChangeId) (attempt : Nat) : s.gaveUp id attempt "" = s := by
  unfold State.gaveUp
  simp

/-! ## Resources -/

/-- No more undecided runs than the configured limit, ever. -/
theorem runs_bounded {cfg : Config} {s : State} (reachable : Reachable cfg s) :
    s.pendingCount cfg ≤ cfg.maxRuns :=
  reachable.inv.pending

/-- Run ids are never reused, so a result always belongs to one run. -/
theorem run_ids_unique {cfg : Config} {s : State} (reachable : Reachable cfg s) :
    (s.runs.map (·.id)).Nodup ∧ ∀ r ∈ s.runs, r.id < s.nextRun :=
  ⟨reachable.inv.runIds, reachable.inv.runFresh⟩

/-- A run holds at most one result per check, and only for required checks. -/
theorem results_are_clean {cfg : Config} {s : State} (reachable : Reachable cfg s) :
    ∀ r ∈ s.runs, (r.results.map (·.1)).Nodup ∧ ∀ x ∈ r.results, x.1 ∈ cfg.required :=
  fun r member => ⟨reachable.inv.resultsUnique r member, reachable.inv.resultsRequired r member⟩

/-! ## Crash and restart -/

/-- **A crash keeps every invariant.** Losing any set of runs at any moment
leaves a state that satisfies the whole invariant; the queue restarts from it. -/
theorem crash_keeps_invariant {cfg : Config} {s : State} (inv : Inv cfg s) (lost : List RunId) :
    Inv cfg (lost.foldl State.cancel s) := by
  induction lost generalizing s with
  | nil => exact inv
  | cons run rest ih => exact ih (inv.cancel run)

/-- A crash never moves the target and never changes a change. -/
theorem crash_keeps_main_and_changes (s : State) (lost : List RunId) :
    (lost.foldl State.cancel s).main = s.main ∧ (lost.foldl State.cancel s).changes = s.changes := by
  induction lost generalizing s with
  | nil => exact ⟨rfl, rfl⟩
  | cons run rest ih => exact ih (s.cancel run)

/-! ## Stale answers and other runs -/

/-- **A fix answer for another attempt is refused.** An agent started for an
earlier attempt cannot move a change that has since been blamed again. -/
theorem stale_fix_refused (s : State) (id : ChangeId) (attempt : Nat)
    (stale : ∀ c ∈ s.changes, c.id = id → c.attempts ≠ attempt) : s.fixed id attempt = s := by
  unfold State.fixed
  have same : (s.changes.map fun c =>
      if c.id = id ∧ c.status.isFixing = true ∧ c.attempts = attempt then
        { c with rev := c.rev + 1, status := Status.queued }
      else c) = s.changes := by
    conv => rhs; rw [← List.map_id s.changes]
    apply List.map_congr_left
    intro c member
    split
    · rename_i h
      exact absurd h.2.2 (stale c member h.1)
    · rfl
  rw [same]

/-- A verdict for another attempt is refused. -/
theorem stale_verdict_refused (s : State) (id : ChangeId) (attempt : Nat) (detail : String)
    (stale : ∀ c ∈ s.changes, c.id = id → c.attempts ≠ attempt) : s.gaveUp id attempt detail = s := by
  unfold State.gaveUp
  have same : (s.changes.map fun c =>
      if c.id = id ∧ c.status.isFixing = true ∧ c.attempts = attempt ∧ detail ≠ "" then
        { c with status := Status.unmergeable ⟨.agentVerdict, detail, s.failuresOf c, c.attempts⟩ }
      else c) = s.changes := by
    conv => rhs; rw [← List.map_id s.changes]
    apply List.map_congr_left
    intro c member
    split
    · rename_i h
      exact absurd h.2.2.1 (stale c member h.1)
    · rfl
  rw [same]

/-- **Cancelling a run forgets that run and no other.** -/
theorem cancel_keeps_other_runs (s : State) (run : RunId) (r : Run) (member : r ∈ s.runs) (other : r.id ≠ run) :
    r ∈ (s.cancel run).runs := by
  simp only [State.cancel, List.mem_filter, bne_iff_ne, ne_eq]
  exact ⟨member, other⟩

/-- **A fix is tested afresh.** After a fix answer takes effect, no run the
queue holds is live with the fixed change in it: the new revision can land or
be blamed only on a run started after the fix. -/
theorem fix_is_tested_afresh {cfg : Config} {s : State} (inv : Inv cfg s) {c : Change} (member : c ∈ s.changes)
    (fixing : c.status.isFixing = true) (r : Run) (held : r ∈ s.runs) (batch : List Part)
    (live : (s.fixed c.id c.attempts).live r = some batch) : ∀ p ∈ batch, p.id ≠ c.id := by
  intro p inBatch same
  obtain ⟨tree, _, allReady⟩ := State.live_some live
  obtain ⟨c', member', part, queued⟩ := State.partReady_iff.mp (allReady p inBatch)
  simp only [State.fixed] at member'
  obtain ⟨d, dMember, rfl⟩ := List.mem_map.mp member'
  have dIs : d = c := by
    apply eq_of_nodup_map inv.changeIds dMember member
    have : d.id = p.id := by
      split at part <;> simpa [Change.part] using congrArg Part.id part
    rw [this, same]
  subst dIs
  have bumped : p.rev = d.rev + 1 := by
    simp only [fixing, and_self, if_true, Change.part] at part
    rw [← part]
  have inTree : p ∈ r.tree := by rw [tree]; exact List.mem_append_right _ inBatch
  obtain ⟨e, eMember, eId, eRev⟩ := inv.runRevs r held p inTree
  have eIs : e = d := eq_of_nodup_map inv.changeIds eMember member (by rw [eId, same])
  subst eIs
  omega

end MergeQueue

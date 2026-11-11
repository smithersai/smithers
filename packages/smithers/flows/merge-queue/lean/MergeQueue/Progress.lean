import MergeQueue.PolicyLemmas

/-!
# Progress

The queue cannot get stuck and cannot loop.

* `no_deadlock`: when the policy has nothing to do and a change is still
  waiting, CI owes the queue an answer.
* `plan_takes_effect`: every decision the policy makes changes the state.
* `budget_*`: every landing, blame, fix answer, verdict and withdrawal strictly
  lowers a number that no other event raises except a new change arriving. So
  fix loops end, and so does the life of every change.
* `bisection_narrows`: a bisection run is strictly between the longest prefix
  not known to fail and the shortest prefix known to fail.
-/

namespace MergeQueue

/-! ## The budget -/

/-- What a change can still cost the queue. An ended change costs nothing. An
unfinished change costs two per fix attempt left, plus one while queued or two
while being fixed, so a fix answer lowers it too. -/
def Change.budget (cfg : Config) (c : Change) : Nat :=
  if c.status.isTerminal then 0
  else 2 * (cfg.maxAttempts - c.attempts) + (if c.status.isFixing then 2 else 1)

/-- The budget of the whole queue. -/
def State.budget (cfg : Config) (s : State) : Nat :=
  (s.changes.map (Change.budget cfg)).sum

theorem sum_map_le {α : Type} (f : α → Nat) (g : α → α) (l : List α) (le : ∀ c ∈ l, f (g c) ≤ f c) :
    ((l.map g).map f).sum ≤ (l.map f).sum := by
  induction l with
  | nil => simp
  | cons x rest ih =>
    simp only [List.map_cons, List.sum_cons]
    have := le x (by simp)
    have := ih fun c hc => le c (List.mem_cons_of_mem _ hc)
    omega

theorem sum_map_lt {α : Type} (f : α → Nat) (g : α → α) (l : List α) (le : ∀ c ∈ l, f (g c) ≤ f c)
    (strict : ∃ c ∈ l, f (g c) < f c) : ((l.map g).map f).sum < (l.map f).sum := by
  induction l with
  | nil =>
    obtain ⟨c, member, _⟩ := strict
    cases member
  | cons x rest ih =>
    simp only [List.map_cons, List.sum_cons]
    have head := le x (by simp)
    have tail := sum_map_le f g rest fun c hc => le c (List.mem_cons_of_mem _ hc)
    obtain ⟨c, member, lower⟩ := strict
    rcases List.mem_cons.mp member with rfl | inRest
    · omega
    · have := ih (fun c hc => le c (List.mem_cons_of_mem _ hc)) ⟨c, inRest, lower⟩
      omega

/-- An unfinished change has a positive budget. -/
theorem Change.budget_pos {cfg : Config} {c : Change} (unfinished : c.status.isTerminal = false) :
    0 < c.budget cfg := by
  unfold Change.budget
  simp only [unfinished, Bool.false_eq_true, if_false]
  split <;> omega

/-- **A withdrawal never raises the budget.** -/
theorem budget_withdraw (cfg : Config) (s : State) (id : ChangeId) :
    (s.withdraw id).budget cfg ≤ s.budget cfg := by
  unfold State.withdraw State.budget
  apply sum_map_le
  intro c _
  split
  · simp [Change.budget, Status.isTerminal]
  · exact Nat.le_refl _

/-- **A fix answer strictly lowers the budget** when it takes effect, and never
raises it. -/
theorem budget_fixed (cfg : Config) (s : State) (id : ChangeId) (attempt : Nat) :
    (s.fixed id attempt).budget cfg ≤ s.budget cfg := by
  unfold State.fixed State.budget
  apply sum_map_le
  intro c _
  split
  · rename_i h
    obtain ⟨run, fixing⟩ := Status.isFixing_iff.mp h.2.1
    simp [Change.budget, fixing, Status.isTerminal, Status.isFixing]
  · exact Nat.le_refl _

theorem budget_fixed_lt (cfg : Config) (s : State) (id : ChangeId) (attempt : Nat)
    (took : ∃ c ∈ s.changes, c.id = id ∧ c.status.isFixing = true ∧ c.attempts = attempt) :
    (s.fixed id attempt).budget cfg < s.budget cfg := by
  unfold State.fixed State.budget
  apply sum_map_lt
  · intro c _
    split
    · rename_i h
      obtain ⟨run, fixing⟩ := Status.isFixing_iff.mp h.2.1
      simp [Change.budget, fixing, Status.isTerminal, Status.isFixing]
    · exact Nat.le_refl _
  · obtain ⟨c, member, h⟩ := took
    refine ⟨c, member, ?_⟩
    obtain ⟨run, fixing⟩ := Status.isFixing_iff.mp h.2.1
    simp [h, Change.budget, fixing, Status.isTerminal, Status.isFixing]

/-- **A verdict never raises the budget.** -/
theorem budget_gaveUp (cfg : Config) (s : State) (id : ChangeId) (attempt : Nat) (detail : String) :
    (s.gaveUp id attempt detail).budget cfg ≤ s.budget cfg := by
  unfold State.gaveUp State.budget
  apply sum_map_le
  intro c _
  split
  · simp [Change.budget, Status.isTerminal]
  · exact Nat.le_refl _

theorem blamedChange_budget_le (cfg : Config) (run : RunId) (r : Run) (p : Part) (c : Change) :
    (blamedChange cfg run r p c).budget cfg ≤ c.budget cfg := by
  unfold blamedChange
  split
  · rename_i h
    have queued : c.status = .queued := Status.isQueued_iff.mp h.2
    split
    · simp only [Change.budget, queued, Status.isTerminal, Status.isFixing, Bool.false_eq_true, if_false,
        if_true]
      omega
    · simp [Change.budget, Status.isTerminal]
  · exact Nat.le_refl _

theorem blamedChange_budget_lt (cfg : Config) (run : RunId) (r : Run) (p : Part) (c : Change)
    (matches_ : c.part = p ∧ c.status.isQueued = true) :
    (blamedChange cfg run r p c).budget cfg < c.budget cfg := by
  unfold blamedChange
  have queued : c.status = .queued := Status.isQueued_iff.mp matches_.2
  simp only [matches_, and_self, if_true]
  split
  · simp only [Change.budget, queued, Status.isTerminal, Status.isFixing, Bool.false_eq_true, if_false, if_true]
    omega
  · simp only [Change.budget, queued, Status.isTerminal, Status.isFixing, Bool.false_eq_true, if_false, if_true]
    omega

/-- **Every blame that takes effect strictly lowers the budget.** This is why
fix loops end: each round of fail, fix, fail costs budget, and nothing but a
new change adds any. -/
theorem budget_blame_lt (cfg : Config) (s : State) (run : RunId) (took : s.blame cfg run ≠ s) :
    (s.blame cfg run).budget cfg < s.budget cfg := by
  rcases s.blame_cases cfg run with refused | ⟨r, p, _, live, _, eq⟩
  · exact absurd refused took
  · rw [eq]
    unfold State.budget
    apply sum_map_lt
    · intro c _
      exact blamedChange_budget_le cfg run r p c
    · have ready := (State.live_some live).2.2 p (by simp)
      obtain ⟨c, member, part, queued⟩ := State.partReady_iff.mp ready
      exact ⟨c, member, blamedChange_budget_lt cfg run r p c ⟨part, Status.isQueued_iff.mpr queued⟩⟩

theorem landedChange_budget_le (cfg : Config) (batch : List Part) (c : Change) :
    (landedChange batch c).budget cfg ≤ c.budget cfg := by
  unfold landedChange
  split
  · simp [Change.budget, Status.isTerminal]
  · exact Nat.le_refl _

/-- **Every landing strictly lowers the budget.** -/
theorem budget_land_lt (cfg : Config) (s : State) (run : RunId) (took : s.land cfg run ≠ s) :
    (s.land cfg run).budget cfg < s.budget cfg := by
  rcases s.land_cases cfg run with refused | ⟨r, batch, _, live, _, eq⟩
  · exact absurd refused took
  · rw [eq]
    unfold State.budget
    apply sum_map_lt
    · intro c _
      exact landedChange_budget_le cfg batch c
    · obtain ⟨_, nonempty, allReady⟩ := State.live_some live
      obtain ⟨p, rest, shape⟩ := List.exists_cons_of_ne_nil nonempty
      have ready := allReady p (by simp [shape])
      obtain ⟨c, member, part, queued⟩ := State.partReady_iff.mp ready
      refine ⟨c, member, ?_⟩
      have inBatch : batch.contains c.part = true := by simp [part, shape]
      have positive := Change.budget_pos (cfg := cfg) (c := c) (by simp [queued, Status.isTerminal])
      simp only [landedChange, inBatch, queued, Status.isQueued, and_self, if_true]
      simpa [Change.budget, Status.isTerminal] using positive

/-- Results, starts and cancels do not touch the budget. -/
theorem budget_unchanged (cfg : Config) (s : State) (e : Event)
    (kind : (∃ run check verdict duration, e = .result run check verdict duration) ∨ (∃ count, e = .start count)
      ∨ (∃ run, e = .cancel run)) : (step cfg s e).budget cfg = s.budget cfg := by
  rcases kind with ⟨run, check, verdict, duration, rfl⟩ | ⟨count, rfl⟩ | ⟨run, rfl⟩
  · simp only [step, State.result, State.budget]
    split <;> rfl
  · simp only [step, State.start, State.budget]
    split <;> rfl
  · rfl

/-- **Only a new change raises the budget.** Every other event leaves it as it
was or lowers it. -/
theorem budget_never_rises (cfg : Config) (s : State) (e : Event) (notEnqueue : ∀ id priority, e ≠ .enqueue id priority) :
    (step cfg s e).budget cfg ≤ s.budget cfg := by
  cases e with
  | enqueue id priority => exact absurd rfl (notEnqueue id priority)
  | withdraw id => exact budget_withdraw cfg s id
  | result run check verdict duration =>
    exact Nat.le_of_eq (budget_unchanged cfg s _ (Or.inl ⟨run, check, verdict, duration, rfl⟩))
  | fixed id attempt => exact budget_fixed cfg s id attempt
  | gaveUp id attempt detail => exact budget_gaveUp cfg s id attempt detail
  | start count => exact Nat.le_of_eq (budget_unchanged cfg s _ (Or.inr (Or.inl ⟨count, rfl⟩)))
  | land run =>
    by_cases took : s.land cfg run = s
    · simp only [step, took]; exact Nat.le_refl _
    · exact Nat.le_of_lt (budget_land_lt cfg s run took)
  | blame run =>
    by_cases took : s.blame cfg run = s
    · simp only [step, took]; exact Nat.le_refl _
    · exact Nat.le_of_lt (budget_blame_lt cfg s run took)
  | cancel run => exact Nat.le_of_eq (budget_unchanged cfg s _ (Or.inr (Or.inr ⟨run, rfl⟩)))

/-! ## Every decision takes effect -/

theorem State.blameable_some {s : State} {r : Run} (h : s.blameable r = true) :
    ∃ p, s.live r = some [p] ∧ failed r.results = true := by
  unfold State.blameable at h
  split at h
  · rename_i p live
    exact ⟨p, live, h⟩
  · cases h

/-- What `nextStart` promises about the count it returns. -/
theorem State.nextStart_some {cfg : Config} {s : State} {count : Nat} (h : s.nextStart cfg = some count) :
    s.pendingCount cfg < cfg.maxRuns ∧ 0 < count ∧ count ≤ s.ready.length
      ∧ ∀ x ∈ s.runs, x.tree ≠ s.main ++ (s.ready.take count).map Change.part := by
  unfold State.nextStart at h
  split at h
  · cases h
  · rename_i slots
    split at h
    · cases h
    · simp only at h
      refine ⟨by omega, ?_⟩
      split at h
      · rename_i noFailed
        split at h
        · rename_i room
          cases h
          have step : 0 < min (max cfg.maxBatch 1) (s.ready.length - s.longestUnfailed (s.ready.length + 1)) := by
            omega
          refine ⟨by omega, by omega, ?_⟩
          intro x member tree
          have isPrefix := State.prefixLength_of_tree (s := s) (x := x) (by omega) (by omega) tree
          have notFailed : failed x.results = false := by
            cases hasFailed : failed x.results
            · rfl
            · have : _ ∈ s.failedPrefixes := State.mem_failedPrefixes.mpr ⟨x, member, isPrefix, hasFailed⟩
              rw [State.shortestFailed] at noFailed
              rw [minOf_none.mp noFailed] at this
              cases this
          have listed : _ ∈ s.unfailedPrefixes (s.ready.length + 1) :=
            State.mem_unfailedPrefixes.mpr ⟨x, member, isPrefix, notFailed, by omega⟩
          have := maxOf_ge listed
          simp only [State.longestUnfailed] at *
          omega
        · cases h
      · rename_i m found
        split at h
        · rename_i gap
          cases h
          obtain ⟨inList, least⟩ := minOf_some (by rw [State.shortestFailed] at found; exact found)
          obtain ⟨y, yMember, yPrefix, _⟩ := State.mem_failedPrefixes.mp inList
          have mBounds := State.prefixLength_bounds yPrefix
          refine ⟨by omega, by omega, ?_⟩
          intro x member tree
          have isPrefix := State.prefixLength_of_tree (s := s) (x := x) (by omega) (by omega) tree
          cases hasFailed : failed x.results
          · have listed : _ ∈ s.unfailedPrefixes m :=
              State.mem_unfailedPrefixes.mpr ⟨x, member, isPrefix, hasFailed, by omega⟩
            have := maxOf_ge listed
            simp only [State.longestUnfailed] at *
            omega
          · have := least _ (State.mem_failedPrefixes.mpr ⟨x, member, isPrefix, hasFailed⟩)
            omega
        · cases h

/-- **Every decision the policy makes changes the state.** The policy never
proposes an event the queue refuses, so it cannot spin in place. -/
theorem plan_takes_effect {cfg : Config} {s : State} {e : Event} (inv : Inv cfg s) (planned : plan cfg s = some e) :
    step cfg s e ≠ s := by
  unfold plan at planned
  split at planned
  · rename_i r best
    cases planned
    obtain ⟨member, can⟩ := State.bestLandable_some best
    simp only [State.landable, Bool.and_eq_true, Option.isSome_iff_exists] at can
    obtain ⟨⟨batch, live⟩, isGreen⟩ := can
    have found := State.findRun_of_mem inv.runIds member
    obtain ⟨tree, nonempty, _⟩ := State.live_some live
    intro same
    have main := congrArg State.main same
    simp only [step, State.land, found, live, isGreen, if_true] at main
    rw [tree] at main
    exact nonempty (List.append_right_eq_self.mp main)
  · split at planned
    · rename_i r found
      cases planned
      have member := List.mem_of_find?_eq_some found
      have can : s.blameable r = true := by simpa using List.find?_some found
      obtain ⟨p, live, hasFailed⟩ := State.blameable_some can
      have looked := State.findRun_of_mem inv.runIds member
      have before := (State.live_some live).2.2 p (by simp)
      intro same
      have after := State.blamed_not_ready cfg s (s.blame cfg r.id) r.id r p (by
        unfold State.blame
        simp only [looked, live, hasFailed, if_true]
        rfl)
      simp only [step] at same
      rw [same, before] at after
      cases after
    · split at planned
      · rename_i r found
        cases planned
        have member := List.mem_of_find?_eq_some found
        intro same
        have runs := congrArg State.runs same
        simp only [step, State.cancel] at runs
        rw [← runs] at member
        simp at member
      · split at planned
        · rename_i count next
          cases planned
          obtain ⟨slots, positive, enough, fresh⟩ := State.nextStart_some next
          intro same
          have counter := congrArg State.nextRun same
          have took : s.start cfg count =
              { s with
                runs := s.runs ++ [Run.mk s.nextRun s.main ((s.ready.take count).map Change.part) []]
                nextRun := s.nextRun + 1 } := by
            unfold State.start
            simp only
            apply if_neg
            intro guard
            rcases guard with zero | short | full | duplicate
            · omega
            · omega
            · omega
            · obtain ⟨x, member, tree⟩ := List.any_eq_true.mp duplicate
              exact fresh x member (by simpa using tree)
          simp [step, took] at counter
        · cases planned

/-! ## No deadlock -/

/-- **No deadlock.** With something to check and a run slot, if the policy has
nothing to do while a change is still waiting, then some run is pending: the
queue is waiting on CI, never on itself. -/
theorem no_deadlock {cfg : Config} {s : State} (checks : cfg.required ≠ []) (slots : 0 < cfg.maxRuns)
    (idle : plan cfg s = none) (waiting : s.ready ≠ []) : ∃ r ∈ s.runs, r.pending cfg = true := by
  apply Classical.byContradiction
  intro nonePending
  have settled : ∀ r ∈ s.runs, r.pending cfg = false := by
    intro r member
    cases h : r.pending cfg
    · rfl
    · exact absurd ⟨r, member, h⟩ nonePending
  have noPending : s.pendingCount cfg = 0 := by
    unfold State.pendingCount
    exact List.countP_eq_zero.mpr fun r member => by simp [settled r member]
  -- A settled run that has not failed is complete, so it is green.
  have greenOf : ∀ r ∈ s.runs, failed r.results = false → green cfg r.results = true := by
    intro r member clean
    have := settled r member
    simp only [Run.pending, clean, Bool.not_false, Bool.true_and, Bool.not_eq_false'] at this
    exact green_of_complete checks this clean
  unfold plan at idle
  split at idle
  · cases idle
  · rename_i noLand
    have cannotLand := State.bestLandable_none noLand
    split at idle
    · cases idle
    · rename_i noBlame
      split at idle
      · cases idle
      · split at idle
        · cases idle
        · rename_i noStart
          have ready : 0 < s.ready.length := List.length_pos_iff.mpr waiting
          -- A live prefix run that has not failed could land: impossible.
          have unfailedLands : ∀ bound n, n ∈ s.unfailedPrefixes bound → False := by
            intro bound n listed
            obtain ⟨r, member, isPrefix, clean, _⟩ := State.mem_unfailedPrefixes.mp listed
            obtain ⟨batch, live, _, _⟩ := State.prefixLength_some isPrefix
            have := cannotLand r member
            simp [State.landable, live, greenOf r member clean] at this
          unfold State.nextStart at noStart
          have notFull : ¬cfg.maxRuns ≤ s.pendingCount cfg := by omega
          have inOrder : s.outOfOrder cfg = false := by
            simp only [State.outOfOrder, List.any_eq_false, Bool.and_eq_true, not_and, Bool.not_eq_true]
            intro r member _
            exact settled r member
          simp only [notFull, if_false, inOrder, Bool.false_eq_true] at noStart
          split at noStart
          · split at noStart
            · cases noStart
            · rename_i tested
              rcases maxOf_mem (s.unfailedPrefixes (s.ready.length + 1)) with zero | listed
              · unfold State.longestUnfailed at tested
                omega
              · exact unfailedLands _ _ listed
          · rename_i m found
            split at noStart
            · cases noStart
            · rename_i gap
              obtain ⟨inList, _⟩ := minOf_some (by rw [State.shortestFailed] at found; exact found)
              obtain ⟨x, member, isPrefix, hasFailed⟩ := State.mem_failedPrefixes.mp inList
              have bounds := State.prefixLength_bounds isPrefix
              rcases maxOf_mem (s.unfailedPrefixes m) with zero | listed
              · -- The failed prefix has length 1: it is blameable.
                unfold State.longestUnfailed at gap
                have one : m = 1 := by omega
                subst one
                obtain ⟨batch, live, length, _⟩ := State.prefixLength_some isPrefix
                have blameable : s.blameable x = true := by
                  unfold State.blameable
                  match batch, length, live with
                  | [p], _, live => simp [live, hasFailed]
                have := List.find?_eq_none.mp noBlame x member
                simp [blameable] at this
              · exact unfailedLands _ _ listed

/-- When the queue is quiet (the policy has nothing to do, no run is pending
and no fix agent is working) every change has ended. **Nothing is left
behind.** -/
theorem quiet_means_done {cfg : Config} {s : State} (checks : cfg.required ≠ []) (slots : 0 < cfg.maxRuns)
    (idle : plan cfg s = none) (noRuns : ∀ r ∈ s.runs, r.pending cfg = false)
    (noFixes : ∀ c ∈ s.changes, c.status.isFixing = false) : ∀ c ∈ s.changes, c.status.isTerminal = true := by
  intro c member
  cases status : c.status with
  | queued =>
    have waiting : s.ready ≠ [] := List.ne_nil_of_mem (State.mem_ready.mpr ⟨member, status⟩)
    obtain ⟨r, inRuns, pending⟩ := no_deadlock checks slots idle waiting
    rw [noRuns r inRuns] at pending
    cases pending
  | fixing run =>
    have := noFixes c member
    simp [status, Status.isFixing] at this
  | merged => rfl
  | unmergeable reason => rfl
  | withdrawn => rfl

/-! ## Bisection narrows -/

/-- **Bisection narrows.** When the first `m` ready changes are known to fail
together, the next run tests a prefix strictly longer than the longest prefix
not known to fail and strictly shorter than `m`. Each bisection run cuts the
gap, so a failing batch reaches a single suspect. -/
theorem bisection_narrows {cfg : Config} {s : State} {m count : Nat} (known : s.shortestFailed = some m)
    (next : s.nextStart cfg = some count) : s.longestUnfailed m < count ∧ count < m := by
  unfold State.nextStart at next
  split at next
  · cases next
  · split at next
    · cases next
    · simp only [known] at next
      split at next
      · cases next
        omega
      · cases next

/-! ## Fixing starts at the first failure -/

/-- **Fixing starts at the first failure.** A live run with one part beyond the
target and one failed check can be blamed at once: the blame takes effect and
the change leaves the ready list. Nothing here asks for the run to be complete. -/
theorem blame_at_first_failure {cfg : Config} {s : State} {run : RunId} {r : Run} {p : Part}
    (found : s.findRun run = some r) (live : s.live r = some [p]) (hasFailed : failed r.results = true) :
    s.blame cfg run ≠ s ∧ (s.blame cfg run).partReady p = false := by
  have after := State.blamed_not_ready cfg s (s.blame cfg run) run r p (by
    unfold State.blame
    simp only [found, live, hasFailed, if_true]
    rfl)
  refine ⟨?_, after⟩
  intro same
  have before := (State.live_some live).2.2 p (by simp)
  rw [same, before] at after
  cases after

end MergeQueue

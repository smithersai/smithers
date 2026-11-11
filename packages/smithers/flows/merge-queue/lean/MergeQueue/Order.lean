import MergeQueue.Invariant

/-!
# Order and priority

Changes land by priority, then by arrival. A run always tests the first ready
changes in that order, so nothing ready is skipped.
-/

namespace MergeQueue

theorem Change.before_trans (a b c : Change) (ab : a.before b = true) (bc : b.before c = true) :
    a.before c = true := by
  simp only [Change.before, Bool.or_eq_true, Bool.and_eq_true, decide_eq_true_eq, beq_iff_eq] at *
  omega

theorem Change.before_total (a b : Change) : (a.before b || b.before a) = true := by
  simp only [Change.before, Bool.or_eq_true, Bool.and_eq_true, decide_eq_true_eq, beq_iff_eq]
  omega

/-- **The ready list is in landing order**: higher priority first, earlier
arrival first among equals. -/
theorem State.ready_sorted (s : State) : s.ready.Pairwise fun a b => a.before b = true :=
  List.pairwise_mergeSort (le := Change.before) Change.before_trans Change.before_total _

/-- The ready list is exactly the queued changes: none missing, none added. -/
theorem State.ready_exact (s : State) (c : Change) : c ∈ s.ready ↔ c ∈ s.changes ∧ c.status = .queued :=
  State.mem_ready

/-- **A run tests the first ready changes.** A start that takes effect adds
one run, on the target's tree, whose batch is the first `count` ready changes
in landing order. -/
theorem start_takes_the_first {cfg : Config} {s : State} {count : Nat} (started : s.start cfg count ≠ s) :
    (s.start cfg count).runs =
        s.runs ++ [{ id := s.nextRun, base := s.main, batch := (s.ready.take count).map Change.part, results := [] }]
      ∧ 0 < count ∧ count ≤ s.ready.length := by
  unfold State.start at started ⊢
  simp only at started ⊢
  split
  · rename_i refused
    simp only [refused, if_true] at started
    exact absurd rfl started
  · rename_i guard
    simp only [not_or, Nat.not_lt] at guard
    exact ⟨rfl, Nat.pos_of_ne_zero guard.1, guard.2.1⟩

/-- **Nothing ready is overtaken.** Every change a run takes lands no later
than every ready change it leaves behind. -/
theorem nothing_overtaken (s : State) (count : Nat) :
    ∀ taken ∈ s.ready.take count, ∀ left ∈ s.ready.drop count, taken.before left = true := by
  have sorted := s.ready_sorted
  rw [← List.take_append_drop count s.ready, List.pairwise_append] at sorted
  exact sorted.2.2

/-- Among changes of one priority, the earlier arrival is first. A change that
needed a fix keeps its arrival number, so it keeps its place. -/
theorem earlier_arrival_first {a b : Change} (same : a.priority = b.priority) (first : a.seq ≤ b.seq) :
    a.before b = true := by
  simp [Change.before, same, first]

/-- **Higher priority lands first**, whenever the two changes arrived. -/
theorem higher_priority_first {a b : Change} (higher : b.priority < a.priority) :
    a.before b = true ∧ b.before a = false := by
  constructor
  · simp [Change.before, higher]
  · simp only [Change.before, Bool.or_eq_false_iff, decide_eq_false_iff_not, Bool.and_eq_false_iff,
      beq_eq_false_iff_ne, ne_eq]
    omega

/-- **A fix re-queues at the back.** The fixed change comes back at its next
revision with an arrival number above every arrival so far, and every other
change is left exactly as it was. So a fix never jumps ahead of the runs
already in flight. -/
theorem fix_requeues_at_the_back {cfg : Config} {s : State} (inv : Inv cfg s) {c : Change} (member : c ∈ s.changes)
    (fixing : c.status.isFixing = true) :
    { c with rev := c.rev + 1, seq := s.nextSeq, status := Status.queued } ∈ (s.fixed c.id c.attempts).changes
      ∧ (∀ d ∈ s.changes, d.seq < s.nextSeq)
      ∧ ∀ d ∈ s.changes, d.id ≠ c.id → d ∈ (s.fixed c.id c.attempts).changes := by
  rw [State.fixed_of_fixing s member fixing]
  refine ⟨?_, inv.seqs, ?_⟩
  · simp only [State.fixedNow, List.mem_map]
    exact ⟨c, member, by simp [fixing]⟩
  · intro d dMember other
    simp only [State.fixedNow, List.mem_map]
    exact ⟨d, dMember, by simp [other]⟩

end MergeQueue

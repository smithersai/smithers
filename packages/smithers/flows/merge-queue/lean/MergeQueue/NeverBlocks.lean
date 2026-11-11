import MergeQueue.Progress

/-!
# The queue never blocks

Will, 2026-11-10: "you should never block new commits. The merge queue, if
built correctly, should absolutely churn through it."

The model has no paused, frozen or held state, and these theorems say what
that buys: a new change is always accepted, accepting it disturbs no run in
flight, a green run always lands whatever else is failing or being fixed, a
change being fixed is out of everyone's way, and a free run slot is always
used while a change waits.
-/

namespace MergeQueue

/-- **Intake is never refused.** In every state, a change with a new id is
accepted and queued. Nothing the queue is doing can close the door. -/
theorem enqueue_always_accepted (s : State) (id : ChangeId) (priority : Nat)
    (fresh : ∀ c ∈ s.changes, c.id ≠ id) :
    ∃ c ∈ (s.enqueue id priority).changes, c.id = id ∧ c.priority = priority ∧ c.status = .queued := by
  unfold State.enqueue
  have absent : ¬(s.changes.any (fun c => c.id == id) = true) := by
    simp only [List.any_eq_true, beq_iff_eq, not_exists, not_and]
    exact fresh
  rw [if_neg absent]
  exact ⟨_, List.mem_append_right _ (List.mem_singleton.mpr rfl), rfl, rfl, rfl⟩

/-- **Intake disturbs nothing in flight.** A run that could land or be blamed
before a change arrived still can afterwards, on the same parts. -/
theorem enqueue_keeps_runs_live (s : State) (id : ChangeId) (priority : Nat) (r : Run) (batch : List Part)
    (live : s.live r = some batch) : (s.enqueue id priority).live r = some batch := by
  rcases s.enqueue_cases id priority with refused | ⟨_, took⟩
  · rw [refused]; exact live
  · rw [took]
    obtain ⟨tree, nonempty, allReady⟩ := State.live_some live
    unfold State.live
    simp only [tree, strip_append]
    match batch, nonempty, allReady with
    | p :: rest, _, allReady =>
      have still : (p :: rest).all
          (State.partReady { s with
            changes := s.changes ++ [Change.mk id priority s.nextSeq 0 0 .queued]
            nextSeq := s.nextSeq + 1 }) = true := by
        rw [List.all_eq_true]
        intro q hq
        have was := allReady q hq
        simp only [State.partReady, List.any_append, Bool.or_eq_true] at was ⊢
        exact Or.inl was
      simp only [still, if_true]

/-- Intake leaves every run and the target as they were. -/
theorem enqueue_keeps_runs_and_main (s : State) (id : ChangeId) (priority : Nat) :
    (s.enqueue id priority).runs = s.runs ∧ (s.enqueue id priority).main = s.main := by
  unfold State.enqueue
  split <;> exact ⟨rfl, rfl⟩

/-- **A green run always lands.** A live run with a complete green result
lands when the queue says so, whatever any other change is doing: failing,
being fixed, waiting. No repair anywhere holds a landing back. -/
theorem green_run_always_lands {cfg : Config} {s : State} {run : RunId} {r : Run} {batch : List Part}
    (found : s.findRun run = some r) (live : s.live r = some batch) (isGreen : green cfg r.results = true) :
    (s.land cfg run).main = r.tree ∧ s.land cfg run ≠ s := by
  have moved : (s.land cfg run).main = r.tree := by
    unfold State.land
    simp only [found, live, isGreen, if_true]
  refine ⟨moved, ?_⟩
  intro same
  rw [same] at moved
  obtain ⟨tree, nonempty, _⟩ := State.live_some live
  rw [tree] at moved
  exact nonempty (List.append_right_eq_self.mp moved.symm)

/-- **A change being fixed is out of the way.** It is not in the ready list,
so no run waits for it and no change behind it is held. -/
theorem fixing_is_out_of_the_way (s : State) (c : Change) (fixing : c.status.isFixing = true) : c ∉ s.ready := by
  intro member
  have queued := (State.mem_ready.mp member).2
  rw [queued] at fixing
  cases fixing

/-- **A free slot is always used.** With something to check and a run slot,
while a change waits and no run is pending, the policy has a decision to make:
the queue never idles with work it could start. -/
theorem free_slot_is_used {cfg : Config} {s : State} (checks : cfg.required ≠ []) (slots : 0 < cfg.maxRuns)
    (waiting : s.ready ≠ []) (nonePending : ∀ r ∈ s.runs, r.pending cfg = false) : plan cfg s ≠ none := by
  intro idle
  obtain ⟨r, member, pending⟩ := no_deadlock checks slots idle waiting
  rw [nonePending r member] at pending
  cases pending

end MergeQueue

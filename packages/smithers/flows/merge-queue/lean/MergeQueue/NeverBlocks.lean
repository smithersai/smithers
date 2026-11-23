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

/-- **A green run is always pushed.** When no push is under way, a live run
with a complete green result is pushed when the queue says so, whatever any
other change is doing: failing, being fixed, waiting. No repair anywhere holds
a landing back. -/
theorem green_run_is_always_pushed {cfg : Config} {s : State} {run : RunId} {r : Run} {batch : List Part}
    (idle : s.pushingRun = none) (found : s.findRun run = some r) (live : s.live r = some batch)
    (isGreen : green cfg r.results = true) : (s.push cfg run).pushing = some run := by
  unfold State.push
  simp [idle, found, live, isGreen]

/-- **A pushed run always lands.** Once the target is seen on the pushed tree,
the landing is recorded, whatever any other change is doing. -/
theorem green_run_always_lands {cfg : Config} {s : State} {run : RunId} {r : Run} {batch : List Part}
    (pushed : s.pushing = some run) (found : s.findRun run = some r) (live : s.live r = some batch)
    (isGreen : green cfg r.results = true) : (s.land cfg run).main = r.tree ∧ s.land cfg run ≠ s := by
  have moved : (s.land cfg run).main = r.tree := by
    unfold State.land State.landNow
    simp only [pushed, found, live, isGreen, if_true]
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
while a change waits, no run is pending and no push is under way, the policy
has a decision to make: the queue never idles with work it could start. -/
theorem free_slot_is_used {cfg : Config} {s : State} (checks : cfg.required ≠ []) (slots : 0 < cfg.maxRuns)
    (waiting : s.ready ≠ []) (nonePending : ∀ r ∈ s.runs, r.pending cfg = false) (noPush : s.pushingRun = none) :
    plan cfg s ≠ none := by
  intro idle
  rcases no_deadlock checks slots idle waiting with ⟨r, member, pending⟩ | busy
  · rw [nonePending r member] at pending
    cases pending
  · rw [noPush] at busy
    cases busy

/-- **A probe tests one ready change alone on the tip.** A probe that takes
effect adds one run whose base is the target's tree and whose batch is that
change at its current revision. -/
theorem probe_is_on_the_tip {cfg : Config} {s : State} {id : ChangeId} (took : s.probe cfg id ≠ s) :
    ∃ c ∈ s.changes, c.id = id ∧ c.status = .queued
      ∧ (s.probe cfg id).runs = s.runs ++ [Run.mk s.nextRun s.main [c.part] []] := by
  rcases s.probe_cases cfg id with refused | ⟨c, _, member, same, queued, _, _, eq⟩
  · exact absurd refused took
  · exact ⟨c, member, same, queued, by rw [eq]⟩

/-- **An idle queue has probed every ready change.** When the policy has
nothing to do and a run slot is free, every ready change is under test alone
on the target's tree: a failing change is found without waiting for the
changes ahead of it. -/
theorem idle_means_every_change_is_probed {cfg : Config} {s : State} (idle : plan cfg s = none)
    (slot : s.pendingCount cfg < cfg.maxRuns) :
    ∀ c ∈ s.ready, ∃ r ∈ s.runs, r.tree = s.main ++ [c.part] := by
  have none : s.nextProbe cfg = none := by
    unfold plan at idle
    (repeat' split at idle) <;> first | assumption | cases idle
  unfold State.nextProbe at none
  rw [if_neg (by omega)] at none
  intro c member
  have := List.find?_eq_none.mp none c member
  simpa using this

/-! ## What one run can add

The queue's capacity has a ceiling. A run needs a free slot, and with no known
failure a new run reaches at most `maxBatch` changes past the longest prefix
already under test. So `maxRuns` slots put at most `maxRuns * maxBatch` changes
under test past the target per CI duration, and no policy on these slots lands
more than that. -/

/-- **A speculative run adds at most `maxBatch` changes.** With no prefix known
to fail, the run the policy starts has a free slot and takes at most
`max maxBatch 1` ready changes beyond the longest prefix already under test. -/
theorem speculation_reach {cfg : Config} {s : State} {count : Nat} (noFailure : s.shortestFailed = none)
    (next : s.nextStart cfg = some count) :
    s.pendingCount cfg < cfg.maxRuns
      ∧ count ≤ s.longestUnfailed (s.ready.length + 1) + max cfg.maxBatch 1 := by
  refine ⟨(State.nextStart_some next).1, ?_⟩
  unfold State.nextStart at next
  split at next
  · cases next
  · split at next
    · cases next
    · simp only [noFailure] at next
      split at next
      · cases next
        omega
      · cases next

/-- **Nothing lands while every run fails.** A landing needs a green run, so a
state whose runs have all failed takes no landing: the rate at which changes
land has no lower bound that ignores how many of them fail. -/
theorem all_failed_nothing_lands {cfg : Config} {s : State} (allFailed : ∀ r ∈ s.runs, failed r.results = true)
    (run : RunId) : s.land cfg run = s := by
  rcases s.land_cases cfg run with refused | ⟨_, eq⟩
  · exact refused
  · rw [eq]
    rcases s.landNow_cases cfg run with refused | ⟨r, _, found, _, isGreen, _⟩
    · exact refused
    · have hasFailed := allFailed r (State.findRun_some found).1
      simp only [green, Bool.and_eq_true, Bool.not_eq_true'] at isGreen
      rw [hasFailed] at isGreen
      cases isGreen.2

end MergeQueue

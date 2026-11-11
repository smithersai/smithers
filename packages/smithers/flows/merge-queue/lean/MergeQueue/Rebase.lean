import MergeQueue.NeverBlocks

/-!
# Everything is rebased on the tip of the target

Will, 2026-11-10: "the way a merge queue works is you rebase all the changes
on tip of main ... Make sure the merge queue checks for being main."

The queue has one tree it lands on: the target's. There is no side branch to
integrate into and nothing to merge back. A run is built on the target's tip.
What lands is the tested tree, and it extends the tip, so the target only
fast-forwards. When someone else moves the target, every run built on the old
tip is dead: nothing tested on a stale tip can land, and everything still
queued is rebuilt on the new tip and tested again, without the queue stopping.
-/

namespace MergeQueue

/-- **A run is built on the tip of the target.** A start that takes effect
makes a run whose base is the target's tree at that moment. -/
theorem run_starts_on_the_tip {cfg : Config} {s : State} {count : Nat} (started : s.start cfg count ≠ s) :
    ∃ r ∈ (s.start cfg count).runs, r.id = s.nextRun ∧ r.base = s.main
      ∧ r.batch = (s.ready.take count).map Change.part := by
  rcases s.start_cases cfg count with refused | ⟨_, _, _, _, took⟩
  · exact absurd refused started
  · rw [took]
    exact ⟨_, List.mem_append_right _ (List.mem_singleton.mpr rfl), rfl, rfl, rfl⟩

/-- **A landing is a fast-forward of the tip.** When the queue's landing moves
the target, the new tree is the target as it was plus the parts that landed:
the tested tree descends from the tip it lands on. -/
theorem land_fast_forwards {cfg : Config} {s : State} {run : RunId} (moved : (s.land cfg run).main ≠ s.main) :
    ∃ batch, batch ≠ [] ∧ (s.land cfg run).main = s.main ++ batch := by
  rcases s.land_cases cfg run with refused | ⟨_, eq⟩
  · rw [refused] at moved; exact absurd rfl moved
  · rw [eq] at moved ⊢
    rcases s.landNow_cases cfg run with refused | ⟨r, batch, _, live, _, took⟩
    · rw [refused] at moved; exact absurd rfl moved
    · obtain ⟨tree, nonempty, _⟩ := State.live_some live
      exact ⟨batch, nonempty, by rw [took]; exact tree⟩

/-- **A moved target kills every run on the old tip.** After someone else puts
a commit on the target, no run the queue holds is live: none of them was built
on the new tip. -/
theorem foreign_kills_every_run {cfg : Config} {s : State} (inv : Inv cfg s) (id : ChangeId)
    (fresh : ∀ c ∈ s.changes, c.id ≠ id) (r : Run) (held : r ∈ s.runs) : (s.foreign id).live r = none := by
  cases stillLive : (s.foreign id).live r with
  | none => rfl
  | some batch =>
    exfalso
    obtain ⟨tree, _, _⟩ := State.live_some stillLive
    have absent : ¬(s.changes.any (fun c => c.id == id) = true) := by
      simp only [List.any_eq_true, beq_iff_eq, not_exists, not_and]
      exact fresh
    have main : (s.foreign id).main = s.main ++ [⟨id, 0⟩] := by
      unfold State.foreign
      rw [if_neg absent]
    rw [main] at tree
    have inTree : (⟨id, 0⟩ : Part) ∈ r.tree := by
      rw [tree]
      simp
    obtain ⟨c, member, same, _⟩ := inv.runRevs r held _ inTree
    exact fresh c member same

/-- **Nothing tested on a stale tip lands.** After the target moved, a landing
for any run the queue held is refused. This is the case where the target moves
between a run's test and its landing. -/
theorem moved_target_refuses_landing {cfg : Config} {s : State} (inv : Inv cfg s) (id : ChangeId)
    (fresh : ∀ c ∈ s.changes, c.id ≠ id) (run : RunId) : (s.foreign id).land cfg run = s.foreign id := by
  rcases (s.foreign id).land_cases cfg run with refused | ⟨_, eq⟩
  · exact refused
  · rw [eq]
    rcases (s.foreign id).landNow_cases cfg run with refused | ⟨r, batch, found, live, _, _⟩
    · exact refused
    · have runs : (s.foreign id).runs = s.runs := by
        unfold State.foreign
        split <;> rfl
      have held : r ∈ s.runs := by rw [← runs]; exact (State.findRun_some found).1
      rw [foreign_kills_every_run inv id fresh r held] at live
      cases live

/-- **A moved target never stops the queue.** The foreign commit is accepted
in every state, costs the queue no budget, and leaves every queued change
queued: they are tested again on the new tip. -/
theorem moved_target_keeps_the_queue (cfg : Config) (s : State) (id : ChangeId) :
    (s.foreign id).budget cfg = s.budget cfg ∧ ∀ c ∈ s.changes, c ∈ (s.foreign id).changes := by
  refine ⟨budget_foreign cfg s id, ?_⟩
  intro c member
  unfold State.foreign
  split
  · exact member
  · exact List.mem_append_left _ member

/-- After the target moved, the queue has work to do at once: with a queued
change, a check and a run slot, it is not idle unless CI or the target owes it
an answer. Progress does not depend on who moved the target. -/
theorem moved_target_makes_progress {cfg : Config} (s : State) (id : ChangeId) (checks : cfg.required ≠ [])
    (slots : 0 < cfg.maxRuns) (waiting : (s.foreign id).ready ≠ []) (idle : plan cfg (s.foreign id) = none) :
    (∃ r ∈ (s.foreign id).runs, r.pending cfg = true) ∨ (s.foreign id).pushingRun.isSome = true :=
  no_deadlock checks slots idle waiting

end MergeQueue

import MergeQueue.Lemmas

/-!
# Delivering an event twice

After a crash the driver cannot know whether its last event was recorded, so it
delivers it again. That is safe: applying any event a second time changes
nothing.
-/

namespace MergeQueue

theorem State.enqueue_twice (s : State) (id : ChangeId) (priority : Nat) :
    (s.enqueue id priority).enqueue id priority = s.enqueue id priority := by
  rcases s.enqueue_cases id priority with refused | ⟨_, took⟩
  · rw [refused, refused]
  · rw [took]
    unfold State.enqueue
    simp

theorem State.withdrawNow_twice (s : State) (id : ChangeId) : (s.withdrawNow id).withdrawNow id = s.withdrawNow id := by
  unfold State.withdrawNow
  simp only [List.map_map, State.mk.injEq, and_true, true_and]
  apply List.map_congr_left
  intro c _
  simp only [Function.comp_def]
  split <;> simp_all [Status.isQueued, Status.isFixing]

theorem State.fixed_twice (s : State) (id : ChangeId) (attempt : Nat) :
    (s.fixed id attempt).fixed id attempt = s.fixed id attempt := by
  rcases s.fixed_cases id attempt with refused | ⟨_, took⟩
  · rw [refused, refused]
  · rw [took]
    unfold State.fixed
    have gone : (s.fixedNow id attempt).changes.any
        (fun c => c.id == id && c.status.isFixing && c.attempts == attempt) = false := by
      simp only [State.fixedNow, List.any_map, List.any_eq_false, Function.comp_def]
      intro c _
      split <;> simp_all [Status.isFixing]
    simp [gone]

theorem State.gaveUp_twice (s : State) (id : ChangeId) (attempt : Nat) (detail : String) :
    (s.gaveUp id attempt detail).gaveUp id attempt detail = s.gaveUp id attempt detail := by
  unfold State.gaveUp
  simp only [List.map_map, State.mk.injEq, and_true, true_and]
  apply List.map_congr_left
  intro c _
  simp only [Function.comp_def]
  split <;> simp_all [Status.isFixing]

theorem State.cancel_twice (s : State) (run : RunId) : (s.cancel run).cancel run = s.cancel run := by
  simp [State.cancel, List.filter_filter]

theorem State.result_twice (cfg : Config) (s : State) (run : RunId) (check : CheckId) (verdict : Verdict)
    (duration : Nat) :
    (s.result cfg run check verdict duration).result cfg run check verdict duration
      = s.result cfg run check verdict duration := by
  rcases s.result_cases cfg run check verdict duration with refused | ⟨_, took⟩
  · rw [refused, refused]
  · rw [took]
    unfold State.result
    apply if_neg
    intro again
    obtain ⟨r, member, stillOpen⟩ := List.any_eq_true.mp again.2
    obtain ⟨old, _, rfl⟩ := List.mem_map.mp member
    simp only [Bool.and_eq_true, beq_iff_eq, Bool.not_eq_true'] at stillOpen
    split at stillOpen
    · have := stillOpen.2
      rw [answered_append] at this
      simp at this
    · rename_i closed
      exact closed ⟨stillOpen.1, stillOpen.2⟩

theorem State.start_twice (cfg : Config) (s : State) (count : Nat) :
    (s.start cfg count).start cfg count = s.start cfg count := by
  rcases s.start_cases cfg count with refused | ⟨_, _, _, _, took⟩
  · rw [refused, refused]
  · rw [took]
    unfold State.start
    simp only
    apply if_pos
    right; right; right
    simp [State.ready, Run.tree]

theorem State.landNow_twice (cfg : Config) (s : State) (run : RunId) :
    (s.landNow cfg run).landNow cfg run = s.landNow cfg run := by
  rcases s.landNow_cases cfg run with refused | ⟨r, batch, _, _, _, took⟩
  · rw [refused, refused]
  · rw [took]
    exact State.landNow_of_absent (State.findRun_none_of_filter (s := s) rfl)

theorem State.blame_twice (cfg : Config) (s : State) (run : RunId) :
    (s.blame cfg run).blame cfg run = s.blame cfg run := by
  rcases s.blame_cases cfg run with refused | ⟨r, p, found, live, _, took⟩
  · rw [refused, refused]
  · rw [took]
    refine State.blame_of_dead (r := r) found ?_
    have notReady := State.blamed_not_ready cfg s { s with changes := s.changes.map (blamedChange cfg run r p) }
      run r p rfl
    unfold State.live
    simp only [(State.live_some live).1, strip_append]
    simp [notReady]

theorem State.withdraw_twice (s : State) (id : ChangeId) : (s.withdraw id).withdraw id = s.withdraw id := by
  have cases : s.withdraw id = s ∨ s.withdraw id = s.withdrawNow id := by
    unfold State.withdraw
    split
    · exact Or.inl rfl
    · exact Or.inr rfl
  rcases cases with refused | took
  · rw [refused, refused]
  · rw [took]
    unfold State.withdraw
    split
    · rfl
    · exact s.withdrawNow_twice id

theorem State.foreign_twice (s : State) (id : ChangeId) : (s.foreign id).foreign id = s.foreign id := by
  have cases : s.foreign id = s ∨ ∃ c ∈ (s.foreign id).changes, c.id = id := by
    unfold State.foreign
    split
    · exact Or.inl rfl
    · exact Or.inr ⟨_, List.mem_append_right _ (List.mem_singleton.mpr rfl), rfl⟩
  rcases cases with refused | ⟨c, member, same⟩
  · rw [refused, refused]
  · generalize s.foreign id = t at member ⊢
    unfold State.foreign
    have present : t.changes.any (fun c => c.id == id) = true :=
      List.any_eq_true.mpr ⟨c, member, by simp [same]⟩
    simp [present]

theorem State.land_twice (cfg : Config) (s : State) (run : RunId) :
    (s.land cfg run).land cfg run = s.land cfg run := by
  rcases s.land_cases cfg run with refused | ⟨_, eq⟩
  · rw [refused, refused]
  · rcases s.landNow_cases cfg run with same | ⟨r, batch, _, _, _, took⟩
    · rw [eq, same, eq, same]
    · rw [eq, took]
      unfold State.land
      simp

theorem State.push_twice (cfg : Config) (s : State) (run : RunId) :
    (s.push cfg run).push cfg run = s.push cfg run := by
  have cases : s.push cfg run = s
      ∨ ∃ r, s.findRun run = some r ∧ (s.live r).isSome = true ∧ s.push cfg run = { s with pushing := some run } := by
    unfold State.push
    split
    · exact Or.inl rfl
    · split
      · exact Or.inl rfl
      · rename_i r found
        split
        · rename_i can
          simp only [Bool.and_eq_true] at can
          exact Or.inr ⟨r, found, can.1, rfl⟩
        · exact Or.inl rfl
  rcases cases with refused | ⟨r, found, live, took⟩
  · rw [refused, refused]
  · rw [took]
    have busy : State.pushingRun { s with pushing := some run } = some r := by
      unfold State.pushingRun
      have found' : State.findRun { s with pushing := some run } run = some r := found
      have live' : (State.live { s with pushing := some run } r).isSome = true := live
      simp only [found', live', if_true]
    unfold State.push
    simp only [busy]

theorem State.probe_twice (cfg : Config) (s : State) (id : ChangeId) :
    (s.probe cfg id).probe cfg id = s.probe cfg id := by
  rcases s.probe_cases cfg id with refused | ⟨c, found, _, _, _, _, _, took⟩
  · rw [refused, refused]
  · rw [took]
    unfold State.probe
    simp only [found]
    apply if_pos
    right
    simp [Run.tree]

/-- **Delivering any event twice is the same as delivering it once.** -/
theorem step_idempotent (cfg : Config) (s : State) (e : Event) : step cfg (step cfg s e) e = step cfg s e := by
  cases e with
  | enqueue id priority => exact s.enqueue_twice id priority
  | withdraw id => exact s.withdraw_twice id
  | result run check verdict duration => exact s.result_twice cfg run check verdict duration
  | fixed id attempt => exact s.fixed_twice id attempt
  | gaveUp id attempt detail => exact s.gaveUp_twice id attempt detail
  | foreign id => exact s.foreign_twice id
  | push run => exact s.push_twice cfg run
  | probe id => exact s.probe_twice cfg id
  | start count => exact s.start_twice cfg count
  | land run => exact s.land_twice cfg run
  | blame run => exact s.blame_twice cfg run
  | cancel run => exact s.cancel_twice run

end MergeQueue

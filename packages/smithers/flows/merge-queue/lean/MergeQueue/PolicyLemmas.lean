import MergeQueue.Policy
import MergeQueue.Safety

/-!
# Facts about the policy's helper functions
-/

namespace MergeQueue

/-! ## minOf, maxOf -/

theorem minOf_none {l : List Nat} : minOf l = none ↔ l = [] := by
  cases l with
  | nil => simp [minOf]
  | cons x rest =>
    simp only [minOf, reduceCtorEq, iff_false]
    split <;> simp

theorem minOf_some {l : List Nat} {m : Nat} (h : minOf l = some m) : m ∈ l ∧ ∀ x ∈ l, m ≤ x := by
  induction l generalizing m with
  | nil => simp [minOf] at h
  | cons y rest ih =>
    simp only [minOf] at h
    split at h
    · rename_i empty
      cases h
      rw [minOf_none.mp empty]
      simp
    · rename_i m' found
      cases h
      have := ih found
      refine ⟨?_, ?_⟩
      · by_cases le : y ≤ m'
        · simp [Nat.min_eq_left le]
        · have : min y m' = m' := Nat.min_eq_right (by omega)
          simp [this, ‹m' ∈ rest ∧ _›.1]
      · intro x hx
        rcases List.mem_cons.mp hx with rfl | inRest
        · exact Nat.min_le_left _ _
        · exact Nat.le_trans (Nat.min_le_right _ _) (this.2 x inRest)

theorem maxOf_ge {l : List Nat} {x : Nat} (h : x ∈ l) : x ≤ maxOf l := by
  induction l with
  | nil => cases h
  | cons y rest ih =>
    simp only [maxOf]
    rcases List.mem_cons.mp h with rfl | inRest
    · exact Nat.le_max_left _ _
    · exact Nat.le_trans (ih inRest) (Nat.le_max_right _ _)

theorem maxOf_mem (l : List Nat) : maxOf l = 0 ∨ maxOf l ∈ l := by
  induction l with
  | nil => exact Or.inl rfl
  | cons y rest ih =>
    simp only [maxOf]
    by_cases le : maxOf rest ≤ y
    · exact Or.inr (by simp [Nat.max_eq_left le])
    · have eq : max y (maxOf rest) = maxOf rest := Nat.max_eq_right (by omega)
      rw [eq]
      rcases ih with zero | member
      · omega
      · exact Or.inr (List.mem_cons_of_mem _ member)

/-! ## prefixLength -/

theorem State.prefixLength_some {s : State} {r : Run} {n : Nat} (h : s.prefixLength r = some n) :
    ∃ batch, s.live r = some batch ∧ batch.length = n ∧ batch = (s.ready.take n).map Change.part := by
  unfold State.prefixLength at h
  split at h
  · rename_i batch live
    split at h
    · rename_i isPrefix
      cases h
      exact ⟨batch, live, rfl, isPrefix⟩
    · cases h
  · cases h

/-- A prefix length is at least 1 and at most the number of ready changes. -/
theorem State.prefixLength_bounds {s : State} {r : Run} {n : Nat} (h : s.prefixLength r = some n) :
    0 < n ∧ n ≤ s.ready.length := by
  obtain ⟨batch, live, length, isPrefix⟩ := State.prefixLength_some h
  have nonempty := (State.live_some live).2.1
  have : batch.length = min n s.ready.length := by
    rw [isPrefix, List.length_map, List.length_take]
  refine ⟨?_, by omega⟩
  rw [← length]
  exact List.length_pos_iff.mpr nonempty

/-- A run on the target plus the first `count` ready changes is a live prefix
run of that length. -/
theorem State.prefixLength_of_tree {s : State} {x : Run} {count : Nat} (pos : 0 < count)
    (le : count ≤ s.ready.length) (tree : x.tree = s.main ++ (s.ready.take count).map Change.part) :
    s.prefixLength x = some count := by
  have length : ((s.ready.take count).map Change.part).length = count := by
    rw [List.length_map, List.length_take]
    omega
  have allReady : ∀ q ∈ (s.ready.take count).map Change.part, s.partReady q = true := by
    intro q hq
    obtain ⟨c, member, rfl⟩ := List.mem_map.mp hq
    have := State.mem_ready.mp ((List.take_sublist count _).subset member)
    exact State.partReady_iff.mpr ⟨c, this.1, rfl, this.2⟩
  have live : s.live x = some ((s.ready.take count).map Change.part) := by
    unfold State.live
    rw [tree, strip_append]
    cases shape : (s.ready.take count).map Change.part with
    | nil => rw [shape] at length; simp at length; omega
    | cons p rest =>
      rw [shape] at allReady
      have : (p :: rest).all s.partReady = true := List.all_eq_true.mpr allReady
      simp only [this, if_true]
  unfold State.prefixLength
  simp only [live, length, if_true]

theorem State.mem_failedPrefixes {s : State} {n : Nat} :
    n ∈ s.failedPrefixes ↔ ∃ r ∈ s.runs, s.prefixLength r = some n ∧ failed r.results = true := by
  simp only [State.failedPrefixes, List.mem_filterMap]
  constructor
  · rintro ⟨r, member, h⟩
    split at h
    · rename_i k found
      split at h
      · cases h; exact ⟨r, member, found, ‹_›⟩
      · cases h
    · cases h
  · rintro ⟨r, member, found, hasFailed⟩
    exact ⟨r, member, by simp [found, hasFailed]⟩

theorem State.mem_unfailedPrefixes {s : State} {bound n : Nat} :
    n ∈ s.unfailedPrefixes bound ↔
      ∃ r ∈ s.runs, s.prefixLength r = some n ∧ failed r.results = false ∧ n < bound := by
  simp only [State.unfailedPrefixes, List.mem_filterMap]
  constructor
  · rintro ⟨r, member, h⟩
    split at h
    · rename_i k found
      split at h
      · rename_i cond
        cases h
        simp only [Bool.and_eq_true, Bool.not_eq_true', decide_eq_true_eq] at cond
        exact ⟨r, member, found, cond.1, cond.2⟩
      · cases h
    · cases h
  · rintro ⟨r, member, found, notFailed, below⟩
    exact ⟨r, member, by simp [found, notFailed, below]⟩

/-! ## bestLandable -/

theorem bestLandable_fold_none (cfg : Config) (s : State) (l : List Run) (init : Option Run)
    (h : l.foldl
        (fun best r =>
          if s.landable cfg r then
            match best with
            | some b => if b.tree.length < r.tree.length then some r else best
            | none => some r
          else best)
        init = none) : init = none ∧ ∀ r ∈ l, s.landable cfg r = false := by
  induction l generalizing init with
  | nil => exact ⟨h, by simp⟩
  | cons x rest ih =>
    simp only [List.foldl_cons] at h
    have step := ih _ h
    by_cases can : s.landable cfg x = true
    · simp only [can, if_true] at step
      have := step.1
      split at this
      · split at this <;> simp_all
      · cases this
    · have can' : s.landable cfg x = false := by simpa using can
      simp only [can', Bool.false_eq_true, if_false] at step
      exact ⟨step.1, by
        intro r hr
        rcases List.mem_cons.mp hr with rfl | inRest
        · exact can'
        · exact step.2 r inRest⟩

theorem bestLandable_fold_some (cfg : Config) (s : State) (l : List Run) (init : Option Run) (r : Run)
    (h : l.foldl
        (fun best r =>
          if s.landable cfg r then
            match best with
            | some b => if b.tree.length < r.tree.length then some r else best
            | none => some r
          else best)
        init = some r) : init = some r ∨ (r ∈ l ∧ s.landable cfg r = true) := by
  induction l generalizing init with
  | nil => exact Or.inl h
  | cons x rest ih =>
    simp only [List.foldl_cons] at h
    rcases ih _ h with fromInit | ⟨member, can⟩
    · by_cases canX : s.landable cfg x = true
      · simp only [canX, if_true] at fromInit
        split at fromInit
        · split at fromInit
          · cases fromInit
            exact Or.inr ⟨by simp, canX⟩
          · exact Or.inl fromInit
        · cases fromInit
          exact Or.inr ⟨by simp, canX⟩
      · have canX' : s.landable cfg x = false := by simpa using canX
        simp only [canX', Bool.false_eq_true, if_false] at fromInit
        exact Or.inl fromInit
    · exact Or.inr ⟨List.mem_cons_of_mem _ member, can⟩

theorem State.bestLandable_none {cfg : Config} {s : State} (h : s.bestLandable cfg = none) :
    ∀ r ∈ s.runs, s.landable cfg r = false :=
  (bestLandable_fold_none cfg s s.runs none h).2

theorem State.bestLandable_some {cfg : Config} {s : State} {r : Run} (h : s.bestLandable cfg = some r) :
    r ∈ s.runs ∧ s.landable cfg r = true := by
  rcases bestLandable_fold_some cfg s s.runs none r h with impossible | found
  · cases impossible
  · exact found

/-! ## findRun -/

/-- With unique run ids, looking a run up by its id finds that run. -/
theorem State.findRun_of_mem {s : State} {r : Run} (unique : (s.runs.map (·.id)).Nodup) (member : r ∈ s.runs) :
    s.findRun r.id = some r := by
  unfold State.findRun
  cases found : s.runs.find? fun x => x.id == r.id with
  | none =>
    have := List.find?_eq_none.mp found r member
    simp at this
  | some x =>
    have same : x.id = r.id := by simpa using List.find?_some found
    rw [eq_of_nodup_map unique (List.mem_of_find?_eq_some found) member same]

/-! ## green -/

/-- A complete result with no failure is green, when there is something to
check. -/
theorem green_of_complete {cfg : Config} {results : List (CheckId × Verdict)} (checks : cfg.required ≠ [])
    (done : complete cfg results = true) (clean : failed results = false) : green cfg results = true := by
  simp only [green, Bool.and_eq_true, Bool.not_eq_true', List.all_eq_true, List.isEmpty_eq_false_iff]
  refine ⟨⟨checks, ?_⟩, clean⟩
  intro c hc
  simp only [complete, List.all_eq_true] at done
  have := done c hc
  simp only [answered, List.any_eq_true, beq_iff_eq] at this
  obtain ⟨⟨c', v⟩, member, rfl⟩ := this
  simp only [failed, List.any_eq_false, beq_iff_eq] at clean
  have pass : v = Verdict.pass := by
    cases v with
    | pass => rfl
    | fail => exact absurd rfl (clean _ member)
  subst pass
  simpa [passed] using member

end MergeQueue

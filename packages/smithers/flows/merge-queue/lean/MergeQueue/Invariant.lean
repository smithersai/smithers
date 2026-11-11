import MergeQueue.Lemmas

/-!
# The invariant

`Inv cfg s` is everything that is true of every reachable state. It is proved
once, by induction over events (`Inv.step`), and every safety theorem in
`MergeQueue/Safety.lean` reads its answer off it.
-/

namespace MergeQueue

/-- `Chained first landings last`: the landings are a chain of trees from
`first` to `last`, each landing starting on the tree the one before it made. -/
def Chained : Tree → List Landing → Tree → Prop
  | first, [], last => last = first
  | first, l :: rest, last => l.base = first ∧ Chained (l.base ++ l.batch) rest last

theorem Chained.append {first last : Tree} {landings : List Landing} (h : Chained first landings last)
    (l : Landing) (base : l.base = last) : Chained first (landings ++ [l]) (l.base ++ l.batch) := by
  induction landings generalizing first with
  | nil =>
    simp only [Chained] at h
    subst h
    exact ⟨base, rfl⟩
  | cons x rest ih => exact ⟨h.1, ih h.2⟩

/-- The end of a chain is its start or the tree of one of its landings. -/
theorem Chained.last_landed {first last : Tree} {landings : List Landing} (h : Chained first landings last) :
    last = first ∨ ∃ l ∈ landings, l.tree = last := by
  induction landings generalizing first with
  | nil => exact Or.inl h
  | cons x rest ih =>
    rcases ih h.2 with same | ⟨l, member, tree⟩
    · exact Or.inr ⟨x, by simp, same.symm⟩
    · exact Or.inr ⟨l, by simp [member], tree⟩

structure Inv (cfg : Config) (s : State) : Prop where
  /-- No two changes share an id. -/
  changeIds : (s.changes.map (·.id)).Nodup
  /-- Every arrival number is below the next one to hand out. -/
  seqs : ∀ c ∈ s.changes, c.seq < s.nextSeq
  /-- No two runs share an id. -/
  runIds : (s.runs.map (·.id)).Nodup
  runFresh : ∀ r ∈ s.runs, r.id < s.nextRun
  /-- No run's tree applies a change twice. -/
  runTrees : ∀ r ∈ s.runs, (r.tree.map (·.id)).Nodup
  /-- A run holds results only for required checks. -/
  resultsRequired : ∀ r ∈ s.runs, ∀ x ∈ r.results, x.1 ∈ cfg.required
  /-- A run holds at most one result per check. -/
  resultsUnique : ∀ r ∈ s.runs, (r.results.map (·.1)).Nodup
  /-- The target's tree applies no change twice. -/
  mainNodup : (s.main.map (·.id)).Nodup
  /-- Every part of the target's tree is a change recorded as merged, at that
  revision. -/
  mainMerged : ∀ p ∈ s.main, ∃ c ∈ s.changes, c.part = p ∧ c.status = .merged
  /-- Every change recorded as merged is in the target's tree, at that revision. -/
  mergedMain : ∀ c ∈ s.changes, c.status = .merged → c.part ∈ s.main
  /-- No change uses more fix attempts than allowed. -/
  attempts : ∀ c ∈ s.changes, c.attempts ≤ cfg.maxAttempts
  /-- An unmergeable change carries written words for its author. -/
  reasons : ∀ c ∈ s.changes, ∀ r, c.status = .unmergeable r → r.detail ≠ ""
  /-- The landings are one chain from the empty tree to the target's tree. -/
  chain : Chained [] s.landed s.main
  /-- Every landing landed something. A landing the queue made was on a
  complete green result; the others are commits someone else put on the target. -/
  landings : ∀ l ∈ s.landed, l.batch ≠ [] ∧ (l.foreign = true ∨ green cfg l.results = true)
  /-- No more undecided runs than allowed. -/
  pending : s.pendingCount cfg ≤ cfg.maxRuns
  /-- A run's tree names only known changes, at revisions that exist. -/
  runRevs : ∀ r ∈ s.runs, ∀ p ∈ r.tree, ∃ c ∈ s.changes, c.id = p.id ∧ p.rev ≤ c.rev

/-! ## List facts -/

theorem eq_of_nodup_map {α β : Type} {f : α → β} {l : List α} (nodup : (l.map f).Nodup) {a b : α}
    (ha : a ∈ l) (hb : b ∈ l) (same : f a = f b) : a = b := by
  induction l with
  | nil => cases ha
  | cons x rest ih =>
    simp only [List.map_cons, List.nodup_cons, List.mem_map, not_exists, not_and] at nodup
    rcases List.mem_cons.mp ha with rfl | ha' <;> rcases List.mem_cons.mp hb with rfl | hb'
    · rfl
    · exact absurd same.symm (nodup.1 b hb')
    · exact absurd same (nodup.1 a ha')
    · exact ih nodup.2 ha' hb'

theorem countP_map_le {α : Type} (p : α → Bool) (f : α → α) (l : List α) (mono : ∀ x, p (f x) = true → p x = true) :
    (l.map f).countP p ≤ l.countP p := by
  rw [List.countP_map]
  exact List.countP_mono_left fun x _ h => mono x h

theorem countP_filter_le {α : Type} (p q : α → Bool) (l : List α) : (l.filter q).countP p ≤ l.countP p :=
  List.Sublist.countP_le List.filter_sublist

theorem Change.part_eq {c d : Change} : c.part = d.part ↔ c.id = d.id ∧ c.rev = d.rev := by
  cases c; cases d; simp [Change.part]

/-! ## The empty queue -/

theorem Inv.empty (cfg : Config) : Inv cfg State.empty := by
  constructor <;> simp [State.empty, State.pendingCount, Chained]

/-! ## Events that rewrite changes in place -/

/-- Rewriting changes by a function that keeps identity, leaves merged changes
alone and merges nothing keeps the invariant. `withdraw`, `fixed`, `gaveUp`
and `blame` are all of this shape. -/
theorem Inv.mapChanges' {cfg : Config} {s : State} (inv : Inv cfg s) (g : Change → Change) (next : Nat)
    (hid : ∀ c, (g c).id = c.id) (hseq : ∀ c ∈ s.changes, (g c).seq < next)
    (keep : ∀ c, c.status = .merged → g c = c)
    (fresh : ∀ c, (g c).status = .merged → c.status = .merged)
    (att : ∀ c ∈ s.changes, (g c).attempts ≤ cfg.maxAttempts)
    (rsn : ∀ c ∈ s.changes, ∀ r, (g c).status = .unmergeable r → r.detail ≠ "")
    (hrev : ∀ c, c.rev ≤ (g c).rev) :
    Inv cfg { s with changes := s.changes.map g, nextSeq := next } := by
  have ids : (s.changes.map g).map (·.id) = s.changes.map (·.id) := by
    simp [List.map_map, Function.comp_def, hid]
  constructor
  · show ((s.changes.map g).map (·.id)).Nodup
    rw [ids]; exact inv.changeIds
  · intro c hc
    obtain ⟨old, member, rfl⟩ := List.mem_map.mp hc
    exact hseq old member
  · exact inv.runIds
  · exact inv.runFresh
  · exact inv.runTrees
  · exact inv.resultsRequired
  · exact inv.resultsUnique
  · exact inv.mainNodup
  · intro p hp
    obtain ⟨c, member, part, merged⟩ := inv.mainMerged p hp
    exact ⟨g c, List.mem_map_of_mem member, by rw [keep c merged]; exact part, by rw [keep c merged]; exact merged⟩
  · intro c hc merged
    obtain ⟨old, member, rfl⟩ := List.mem_map.mp hc
    have was := fresh old merged
    rw [keep old was]
    exact inv.mergedMain old member was
  · intro c hc
    obtain ⟨old, member, rfl⟩ := List.mem_map.mp hc
    exact att old member
  · intro c hc r unmergeable
    obtain ⟨old, member, rfl⟩ := List.mem_map.mp hc
    exact rsn old member r unmergeable
  · exact inv.chain
  · exact inv.landings
  · exact inv.pending
  · intro r hr p hp
    obtain ⟨c, member, same, rev⟩ := inv.runRevs r hr p hp
    exact ⟨g c, List.mem_map_of_mem member, by rw [hid]; exact same, Nat.le_trans rev (hrev c)⟩

/-- Rewriting changes by a function that also keeps arrival numbers. -/
theorem Inv.mapChanges {cfg : Config} {s : State} (inv : Inv cfg s) (g : Change → Change)
    (hid : ∀ c, (g c).id = c.id) (hseq : ∀ c, (g c).seq = c.seq)
    (keep : ∀ c, c.status = .merged → g c = c)
    (fresh : ∀ c, (g c).status = .merged → c.status = .merged)
    (att : ∀ c ∈ s.changes, (g c).attempts ≤ cfg.maxAttempts)
    (rsn : ∀ c ∈ s.changes, ∀ r, (g c).status = .unmergeable r → r.detail ≠ "")
    (hrev : ∀ c, c.rev ≤ (g c).rev) :
    Inv cfg { s with changes := s.changes.map g } :=
  inv.mapChanges' g s.nextSeq hid (fun c member => by rw [hseq]; exact inv.seqs c member) keep fresh att rsn hrev

theorem Inv.withdrawNow {cfg : Config} {s : State} (inv : Inv cfg s) (id : ChangeId) : Inv cfg (s.withdrawNow id) := by
  unfold State.withdrawNow
  apply inv.mapChanges
  · intro c; split <;> rfl
  · intro c; split <;> rfl
  · intro c merged
    split
    · rename_i h; simp [merged, Status.isQueued, Status.isFixing] at h
    · rfl
  · intro c merged
    split at merged
    · cases merged
    · exact merged
  · intro c member
    split
    · exact inv.attempts c member
    · exact inv.attempts c member
  · intro c member r unmergeable
    split at unmergeable
    · cases unmergeable
    · exact inv.reasons c member r unmergeable
  · intro c; split <;> exact Nat.le_refl _

theorem Inv.withdraw {cfg : Config} {s : State} (inv : Inv cfg s) (id : ChangeId) : Inv cfg (s.withdraw id) := by
  unfold State.withdraw
  split
  · exact inv
  · exact inv.withdrawNow id

theorem Inv.fixedNow {cfg : Config} {s : State} (inv : Inv cfg s) (id : ChangeId) (attempt : Nat) :
    Inv cfg (s.fixedNow id attempt) := by
  unfold State.fixedNow
  apply inv.mapChanges'
  · intro c; split <;> rfl
  · intro c member
    split
    · exact Nat.lt_succ_self _
    · exact Nat.lt_succ_of_lt (inv.seqs c member)
  · intro c merged
    split
    · rename_i h; simp [merged, Status.isFixing] at h
    · rfl
  · intro c merged
    split at merged
    · cases merged
    · exact merged
  · intro c member
    split
    · exact inv.attempts c member
    · exact inv.attempts c member
  · intro c member r unmergeable
    split at unmergeable
    · cases unmergeable
    · exact inv.reasons c member r unmergeable
  · intro c; split <;> simp

theorem Inv.fixed {cfg : Config} {s : State} (inv : Inv cfg s) (id : ChangeId) (attempt : Nat) :
    Inv cfg (s.fixed id attempt) := by
  unfold State.fixed
  split
  · exact inv.fixedNow id attempt
  · exact inv

theorem Inv.gaveUp {cfg : Config} {s : State} (inv : Inv cfg s) (id : ChangeId) (attempt : Nat) (detail : String) :
    Inv cfg (s.gaveUp id attempt detail) := by
  unfold State.gaveUp
  apply inv.mapChanges
  · intro c; split <;> rfl
  · intro c; split <;> rfl
  · intro c merged
    split
    · rename_i h; simp [merged, Status.isFixing] at h
    · rfl
  · intro c merged
    split at merged
    · cases merged
    · exact merged
  · intro c member
    split
    · exact inv.attempts c member
    · exact inv.attempts c member
  · intro c member r unmergeable
    split at unmergeable
    · rename_i h
      cases unmergeable
      exact h.2.2.2
    · exact inv.reasons c member r unmergeable
  · intro c; split <;> exact Nat.le_refl _

theorem exhaustedDetail_ne : exhaustedDetail ≠ "" := by decide

theorem Inv.blame {cfg : Config} {s : State} (inv : Inv cfg s) (run : RunId) : Inv cfg (s.blame cfg run) := by
  unfold State.blame
  split
  · exact inv
  · split
    · split
      · apply inv.mapChanges
        · intro c; (repeat' split) <;> rfl
        · intro c; (repeat' split) <;> rfl
        · intro c merged
          split
          · rename_i h; simp [merged] at h
          · rfl
        · intro c merged
          split at merged
          · split at merged <;> cases merged
          · exact merged
        · intro c member
          split
          · split
            · rename_i lt; exact lt
            · exact inv.attempts c member
          · exact inv.attempts c member
        · intro c member r unmergeable
          split at unmergeable
          · split at unmergeable
            · cases unmergeable
            · cases unmergeable; exact exhaustedDetail_ne
          · exact inv.reasons c member r unmergeable
        · intro c; (repeat' split) <;> exact Nat.le_refl _
      · exact inv
    · exact inv

/-! ## Enqueue -/

theorem Inv.enqueue {cfg : Config} {s : State} (inv : Inv cfg s) (id : ChangeId) (priority : Nat) :
    Inv cfg (s.enqueue id priority) := by
  unfold State.enqueue
  split
  · exact inv
  · rename_i absent
    simp only [List.any_eq_true, beq_iff_eq, not_exists, not_and] at absent
    constructor
    · show ((s.changes ++ [_]).map Change.id).Nodup
      simp only [List.map_append, List.map_cons, List.map_nil]
      refine List.nodup_append.mpr ⟨inv.changeIds, by simp, ?_⟩
      intro a ha b hb
      simp only [List.mem_singleton] at hb
      subst hb
      obtain ⟨c, member, rfl⟩ := List.mem_map.mp ha
      exact absent c member
    · intro c hc
      rcases List.mem_append.mp hc with old | new
      · exact Nat.lt_succ_of_lt (inv.seqs c old)
      · simp only [List.mem_singleton] at new
        subst new
        exact Nat.lt_succ_self _
    · exact inv.runIds
    · exact inv.runFresh
    · exact inv.runTrees
    · exact inv.resultsRequired
    · exact inv.resultsUnique
    · exact inv.mainNodup
    · intro p hp
      obtain ⟨c, member, part, merged⟩ := inv.mainMerged p hp
      exact ⟨c, List.mem_append_left _ member, part, merged⟩
    · intro c hc merged
      rcases List.mem_append.mp hc with old | new
      · exact inv.mergedMain c old merged
      · simp only [List.mem_singleton] at new
        subst new
        cases merged
    · intro c hc
      rcases List.mem_append.mp hc with old | new
      · exact inv.attempts c old
      · simp only [List.mem_singleton] at new
        subst new
        exact Nat.zero_le _
    · intro c hc r unmergeable
      rcases List.mem_append.mp hc with old | new
      · exact inv.reasons c old r unmergeable
      · simp only [List.mem_singleton] at new
        subst new
        cases unmergeable
    · exact inv.chain
    · exact inv.landings
    · exact inv.pending
    · intro r hr p hp
      obtain ⟨c, member, h⟩ := inv.runRevs r hr p hp
      exact ⟨c, List.mem_append_left _ member, h⟩

/-! ## Cancel -/

theorem Inv.cancel {cfg : Config} {s : State} (inv : Inv cfg s) (run : RunId) : Inv cfg (s.cancel run) := by
  unfold State.cancel
  have sub : (s.runs.filter fun x => x.id != run).Sublist s.runs := List.filter_sublist
  constructor
  · exact inv.changeIds
  · exact inv.seqs
  · exact (sub.map _).nodup inv.runIds
  · intro r hr; exact inv.runFresh r (sub.subset hr)
  · intro r hr; exact inv.runTrees r (sub.subset hr)
  · intro r hr; exact inv.resultsRequired r (sub.subset hr)
  · intro r hr; exact inv.resultsUnique r (sub.subset hr)
  · exact inv.mainNodup
  · exact inv.mainMerged
  · exact inv.mergedMain
  · exact inv.attempts
  · exact inv.reasons
  · exact inv.chain
  · exact inv.landings
  · exact Nat.le_trans (countP_filter_le _ _ _) inv.pending
  · intro r hr; exact inv.runRevs r (sub.subset hr)

/-! ## Result -/

theorem Inv.result {cfg : Config} {s : State} (inv : Inv cfg s) (run : RunId) (check : CheckId)
    (verdict : Verdict) (duration : Nat) : Inv cfg (s.result cfg run check verdict duration) := by
  unfold State.result
  split
  · rename_i guard
    have required : check ∈ cfg.required := by simpa using guard.1
    have ids :
        (s.runs.map fun r =>
              if r.id = run ∧ answered r.results check = false then
                { r with results := r.results ++ [(check, verdict)] }
              else r).map (·.id) = s.runs.map (·.id) := by
      rw [List.map_map]
      apply List.map_congr_left
      intro r _
      simp only [Function.comp_def]
      split <;> rfl
    constructor
    · exact inv.changeIds
    · exact inv.seqs
    · show (List.map Run.id (List.map _ s.runs)).Nodup
      rw [ids]; exact inv.runIds
    · intro r hr
      obtain ⟨old, member, rfl⟩ := List.mem_map.mp hr
      have := inv.runFresh old member
      split <;> exact this
    · intro r hr
      obtain ⟨old, member, rfl⟩ := List.mem_map.mp hr
      have := inv.runTrees old member
      split <;> exact this
    · intro r hr x hx
      obtain ⟨old, member, rfl⟩ := List.mem_map.mp hr
      split at hx
      · rcases List.mem_append.mp hx with was | new
        · exact inv.resultsRequired old member x was
        · simp only [List.mem_singleton] at new
          subst new
          exact required
      · exact inv.resultsRequired old member x hx
    · intro r hr
      obtain ⟨old, member, rfl⟩ := List.mem_map.mp hr
      split
      · rename_i h
        simp only [List.map_append, List.map_cons, List.map_nil]
        refine List.nodup_append.mpr ⟨inv.resultsUnique old member, by simp, ?_⟩
        intro a ha b hb
        simp only [List.mem_singleton] at hb
        subst hb
        intro same
        subst same
        obtain ⟨x, hx, rfl⟩ := List.mem_map.mp ha
        have unanswered := h.2
        simp only [answered, List.any_eq_false, beq_iff_eq] at unanswered
        exact unanswered x hx rfl
      · exact inv.resultsUnique old member
    · exact inv.mainNodup
    · exact inv.mainMerged
    · exact inv.mergedMain
    · exact inv.attempts
    · exact inv.reasons
    · exact inv.chain
    · exact inv.landings
    · refine Nat.le_trans (countP_map_le _ _ _ ?_) inv.pending
      intro r h
      split at h
      · exact Run.pending_append h
      · exact h
    · intro r hr p hp
      obtain ⟨old, member, rfl⟩ := List.mem_map.mp hr
      split at hp <;> exact inv.runRevs old member p hp
  · exact inv

/-! ## Start -/

theorem State.ready_ids_nodup {cfg : Config} {s : State} (inv : Inv cfg s) : (s.ready.map (·.id)).Nodup :=
  ((s.ready_perm.map _).nodup_iff).mpr ((List.filter_sublist.map _).nodup inv.changeIds)

/-- A tree made of the target plus a prefix of the ready changes applies no
change twice. -/
theorem State.candidate_nodup {cfg : Config} {s : State} (inv : Inv cfg s) (count : Nat) :
    ((s.main ++ (s.ready.take count).map Change.part).map (·.id)).Nodup := by
  have batch : ((s.ready.take count).map Change.part).map (·.id) = (s.ready.take count).map (·.id) := by
    simp [List.map_map, Function.comp_def, Change.part]
  rw [List.map_append, batch]
  refine List.nodup_append.mpr ⟨inv.mainNodup, ((List.take_sublist count _).map _).nodup (ready_ids_nodup inv), ?_⟩
  intro a ha b hb same
  subst same
  obtain ⟨p, hp, rfl⟩ := List.mem_map.mp ha
  obtain ⟨d, hd, same⟩ := List.mem_map.mp hb
  obtain ⟨c, member, part, merged⟩ := inv.mainMerged p hp
  have ready := State.mem_ready.mp ((List.take_sublist count _).subset hd)
  have ids : c.id = d.id := by rw [same, ← part]; rfl
  have := eq_of_nodup_map inv.changeIds member ready.1 ids
  subst this
  rw [merged] at ready
  cases ready.2

theorem Inv.start {cfg : Config} {s : State} (inv : Inv cfg s) (count : Nat) : Inv cfg (s.start cfg count) := by
  unfold State.start
  simp only
  split
  · exact inv
  · rename_i guard
    simp only [not_or, Nat.not_le] at guard
    constructor
    · exact inv.changeIds
    · exact inv.seqs
    · show ((s.runs ++ [_]).map Run.id).Nodup
      simp only [List.map_append, List.map_cons, List.map_nil]
      refine List.nodup_append.mpr ⟨inv.runIds, by simp, ?_⟩
      intro a ha b hb
      simp only [List.mem_singleton] at hb
      subst hb
      obtain ⟨r, member, rfl⟩ := List.mem_map.mp ha
      exact Nat.ne_of_lt (inv.runFresh r member)
    · intro r hr
      rcases List.mem_append.mp hr with old | new
      · exact Nat.lt_succ_of_lt (inv.runFresh r old)
      · simp only [List.mem_singleton] at new
        subst new
        exact Nat.lt_succ_self _
    · intro r hr
      rcases List.mem_append.mp hr with old | new
      · exact inv.runTrees r old
      · simp only [List.mem_singleton] at new
        subst new
        exact State.candidate_nodup inv count
    · intro r hr x hx
      rcases List.mem_append.mp hr with old | new
      · exact inv.resultsRequired r old x hx
      · simp only [List.mem_singleton] at new
        subst new
        cases hx
    · intro r hr
      rcases List.mem_append.mp hr with old | new
      · exact inv.resultsUnique r old
      · simp only [List.mem_singleton] at new
        subst new
        simp
    · exact inv.mainNodup
    · exact inv.mainMerged
    · exact inv.mergedMain
    · exact inv.attempts
    · exact inv.reasons
    · exact inv.chain
    · exact inv.landings
    · show (s.runs ++ [_]).countP (Run.pending cfg) ≤ cfg.maxRuns
      rw [List.countP_append, List.countP_singleton]
      have room : s.runs.countP (Run.pending cfg) < cfg.maxRuns := guard.2.2.1
      split <;> omega
    · intro r hr p hp
      rcases List.mem_append.mp hr with old | new
      · exact inv.runRevs r old p hp
      · simp only [List.mem_singleton] at new
        subst new
        rcases List.mem_append.mp hp with inMain | inBatch
        · obtain ⟨c, member, part, _⟩ := inv.mainMerged p inMain
          exact ⟨c, member, by rw [← part]; rfl, by rw [← part]; exact Nat.le_refl _⟩
        · obtain ⟨d, taken, rfl⟩ := List.mem_map.mp inBatch
          have ready := State.mem_ready.mp ((List.take_sublist count _).subset taken)
          exact ⟨d, ready.1, rfl, Nat.le_refl _⟩

/-! ## Probe -/

theorem Inv.probe {cfg : Config} {s : State} (inv : Inv cfg s) (id : ChangeId) : Inv cfg (s.probe cfg id) := by
  rcases s.probe_cases cfg id with refused | ⟨c, _, member, _, queued, room, _, took⟩
  · rw [refused]; exact inv
  · rw [took]
    constructor
    · exact inv.changeIds
    · exact inv.seqs
    · show ((s.runs ++ [_]).map Run.id).Nodup
      simp only [List.map_append, List.map_cons, List.map_nil]
      refine List.nodup_append.mpr ⟨inv.runIds, by simp, ?_⟩
      intro a ha b hb
      simp only [List.mem_singleton] at hb
      subst hb
      obtain ⟨r, inRuns, rfl⟩ := List.mem_map.mp ha
      exact Nat.ne_of_lt (inv.runFresh r inRuns)
    · intro r hr
      rcases List.mem_append.mp hr with old | new
      · exact Nat.lt_succ_of_lt (inv.runFresh r old)
      · simp only [List.mem_singleton] at new
        subst new
        exact Nat.lt_succ_self _
    · intro r hr
      rcases List.mem_append.mp hr with old | new
      · exact inv.runTrees r old
      · simp only [List.mem_singleton] at new
        subst new
        show ((s.main ++ [c.part]).map Part.id).Nodup
        simp only [List.map_append, List.map_cons, List.map_nil]
        refine List.nodup_append.mpr ⟨inv.mainNodup, by simp, ?_⟩
        intro a ha b hb
        simp only [List.mem_singleton] at hb
        subst hb
        obtain ⟨p, inMain, rfl⟩ := List.mem_map.mp ha
        obtain ⟨d, dMember, part, merged⟩ := inv.mainMerged p inMain
        intro same
        have : d = c := eq_of_nodup_map inv.changeIds dMember member (by rw [← part] at same; exact same)
        subst this
        rw [merged] at queued
        cases queued
    · intro r hr x hx
      rcases List.mem_append.mp hr with old | new
      · exact inv.resultsRequired r old x hx
      · simp only [List.mem_singleton] at new
        subst new
        cases hx
    · intro r hr
      rcases List.mem_append.mp hr with old | new
      · exact inv.resultsUnique r old
      · simp only [List.mem_singleton] at new
        subst new
        simp
    · exact inv.mainNodup
    · exact inv.mainMerged
    · exact inv.mergedMain
    · exact inv.attempts
    · exact inv.reasons
    · exact inv.chain
    · exact inv.landings
    · show (s.runs ++ [_]).countP (Run.pending cfg) ≤ cfg.maxRuns
      rw [List.countP_append, List.countP_singleton]
      have room' : s.runs.countP (Run.pending cfg) < cfg.maxRuns := room
      split <;> omega
    · intro r hr p hp
      rcases List.mem_append.mp hr with old | new
      · exact inv.runRevs r old p hp
      · simp only [List.mem_singleton] at new
        subst new
        rcases List.mem_append.mp hp with inMain | inBatch
        · obtain ⟨d, dMember, part, _⟩ := inv.mainMerged p inMain
          exact ⟨d, dMember, by rw [← part]; rfl, by rw [← part]; exact Nat.le_refl _⟩
        · simp only [List.mem_singleton] at inBatch
          subst inBatch
          exact ⟨c, member, rfl, Nat.le_refl _⟩

/-! ## Land -/

theorem Inv.landNow {cfg : Config} {s : State} (inv : Inv cfg s) (run : RunId) : Inv cfg (s.landNow cfg run) := by
  unfold State.landNow
  split
  · exact inv
  · rename_i r found
    split
    · exact inv
    · rename_i batch live
      split
      · rename_i isGreen
        obtain ⟨member, _⟩ := State.findRun_some found
        obtain ⟨tree, nonempty, allReady⟩ := State.live_some live
        have sub : (s.runs.filter fun x => x.id != run).Sublist s.runs := List.filter_sublist
        have hid : ∀ c : Change,
            (if batch.contains c.part = true ∧ c.status.isQueued = true then { c with status := Status.merged }
              else c).id = c.id := by
          intro c; split <;> rfl
        have hpart : ∀ c : Change,
            (if batch.contains c.part = true ∧ c.status.isQueued = true then { c with status := Status.merged }
              else c).part = c.part := by
          intro c; split <;> rfl
        constructor
        · show (List.map Change.id (List.map _ s.changes)).Nodup
          rw [List.map_map]
          have : (Change.id ∘ fun c : Change =>
              if batch.contains c.part = true ∧ c.status.isQueued = true then { c with status := Status.merged }
              else c) = Change.id := funext hid
          rw [this]
          exact inv.changeIds
        · intro c hc
          obtain ⟨old, was, rfl⟩ := List.mem_map.mp hc
          have := inv.seqs old was
          split <;> exact this
        · exact (sub.map _).nodup inv.runIds
        · intro x hx; exact inv.runFresh x (sub.subset hx)
        · intro x hx; exact inv.runTrees x (sub.subset hx)
        · intro x hx; exact inv.resultsRequired x (sub.subset hx)
        · intro x hx; exact inv.resultsUnique x (sub.subset hx)
        · exact inv.runTrees r member
        · intro p hp
          show ∃ c ∈ List.map _ s.changes, Change.part c = p ∧ Change.status c = Status.merged
          rw [tree] at hp
          rcases List.mem_append.mp hp with old | new
          · obtain ⟨c, was, part, merged⟩ := inv.mainMerged p old
            refine ⟨c, List.mem_map.mpr ⟨c, was, ?_⟩, part, merged⟩
            simp [merged, Status.isQueued]
          · obtain ⟨c, was, part, queued⟩ := State.partReady_iff.mp (allReady p new)
            refine ⟨{ c with status := .merged }, List.mem_map.mpr ⟨c, was, ?_⟩, part, rfl⟩
            have inBatch : c.part ∈ batch := by rw [part]; exact new
            simp [inBatch, queued]
        · intro c hc merged
          obtain ⟨old, was, rfl⟩ := List.mem_map.mp hc
          show _ ∈ r.tree
          rw [tree, hpart]
          split at merged
          · rename_i h
            exact List.mem_append_right _ (by simpa using h.1)
          · exact List.mem_append_left _ (inv.mergedMain old was merged)
        · intro c hc
          obtain ⟨old, was, rfl⟩ := List.mem_map.mp hc
          have := inv.attempts old was
          split <;> exact this
        · intro c hc reason unmergeable
          obtain ⟨old, was, rfl⟩ := List.mem_map.mp hc
          split at unmergeable
          · cases unmergeable
          · exact inv.reasons old was reason unmergeable
        · show Chained [] (s.landed ++ [_]) r.tree
          rw [tree]
          exact inv.chain.append ⟨run, s.main, batch, r.results, false⟩ rfl
        · intro l hl
          rcases List.mem_append.mp hl with old | new
          · exact inv.landings l old
          · simp only [List.mem_singleton] at new
            subst new
            exact ⟨nonempty, Or.inr isGreen⟩
        · exact Nat.le_trans (countP_filter_le _ _ _) inv.pending
        · intro x hx p hp
          obtain ⟨c, was, same, rev⟩ := inv.runRevs x (sub.subset hx) p hp
          refine ⟨_, List.mem_map_of_mem was, by rw [hid]; exact same, ?_⟩
          split <;> exact rev
      · exact inv

/-- Changing which run is being pushed keeps the invariant. -/
theorem Inv.setPushing {cfg : Config} {s : State} (inv : Inv cfg s) (pushing : Option RunId) :
    Inv cfg { s with pushing := pushing } :=
  ⟨inv.changeIds, inv.seqs, inv.runIds, inv.runFresh, inv.runTrees, inv.resultsRequired, inv.resultsUnique,
    inv.mainNodup, inv.mainMerged, inv.mergedMain, inv.attempts, inv.reasons, inv.chain, inv.landings, inv.pending,
    inv.runRevs⟩

theorem Inv.push {cfg : Config} {s : State} (inv : Inv cfg s) (run : RunId) : Inv cfg (s.push cfg run) := by
  unfold State.push
  split
  · exact inv
  · split
    · exact inv
    · split
      · exact inv.setPushing _
      · exact inv

theorem Inv.land {cfg : Config} {s : State} (inv : Inv cfg s) (run : RunId) : Inv cfg (s.land cfg run) := by
  unfold State.land
  split
  · exact inv.landNow run
  · exact inv

/-! ## A commit from outside -/

theorem Inv.foreign {cfg : Config} {s : State} (inv : Inv cfg s) (id : ChangeId) : Inv cfg (s.foreign id) := by
  unfold State.foreign
  split
  · exact inv
  · rename_i absent
    simp only [List.any_eq_true, beq_iff_eq, not_exists, not_and] at absent
    constructor
    · show ((s.changes ++ [_]).map Change.id).Nodup
      simp only [List.map_append, List.map_cons, List.map_nil]
      refine List.nodup_append.mpr ⟨inv.changeIds, by simp, ?_⟩
      intro a ha b hb
      simp only [List.mem_singleton] at hb
      subst hb
      obtain ⟨c, member, rfl⟩ := List.mem_map.mp ha
      exact absent c member
    · intro c hc
      rcases List.mem_append.mp hc with old | new
      · exact Nat.lt_succ_of_lt (inv.seqs c old)
      · simp only [List.mem_singleton] at new
        subst new
        exact Nat.lt_succ_self _
    · exact inv.runIds
    · exact inv.runFresh
    · exact inv.runTrees
    · exact inv.resultsRequired
    · exact inv.resultsUnique
    · show ((s.main ++ [_]).map Part.id).Nodup
      simp only [List.map_append, List.map_cons, List.map_nil]
      refine List.nodup_append.mpr ⟨inv.mainNodup, by simp, ?_⟩
      intro a ha b hb
      simp only [List.mem_singleton] at hb
      subst hb
      obtain ⟨p, inMain, rfl⟩ := List.mem_map.mp ha
      obtain ⟨c, member, part, _⟩ := inv.mainMerged p inMain
      intro same
      exact absent c member (by rw [← same, ← part]; rfl)
    · intro p hp
      rcases List.mem_append.mp hp with old | new
      · obtain ⟨c, member, part, merged⟩ := inv.mainMerged p old
        exact ⟨c, List.mem_append_left _ member, part, merged⟩
      · simp only [List.mem_singleton] at new
        subst new
        exact ⟨_, List.mem_append_right _ (List.mem_singleton.mpr rfl), rfl, rfl⟩
    · intro c hc merged
      rcases List.mem_append.mp hc with old | new
      · exact List.mem_append_left _ (inv.mergedMain c old merged)
      · simp only [List.mem_singleton] at new
        subst new
        exact List.mem_append_right _ (List.mem_singleton.mpr rfl)
    · intro c hc
      rcases List.mem_append.mp hc with old | new
      · exact inv.attempts c old
      · simp only [List.mem_singleton] at new
        subst new
        exact Nat.zero_le _
    · intro c hc r unmergeable
      rcases List.mem_append.mp hc with old | new
      · exact inv.reasons c old r unmergeable
      · simp only [List.mem_singleton] at new
        subst new
        cases unmergeable
    · exact inv.chain.append ⟨0, s.main, [⟨id, 0⟩], [], true⟩ rfl
    · intro l hl
      rcases List.mem_append.mp hl with old | new
      · exact inv.landings l old
      · simp only [List.mem_singleton] at new
        subst new
        exact ⟨by simp, Or.inl rfl⟩
    · exact inv.pending
    · intro r hr p hp
      obtain ⟨c, member, h⟩ := inv.runRevs r hr p hp
      exact ⟨c, List.mem_append_left _ member, h⟩

/-! ## Every event -/

/-- Every event keeps the invariant, whatever the event and whenever it
arrives. A lost run is `cancel`, so this covers a crash at any step. -/
theorem Inv.step {cfg : Config} {s : State} (inv : Inv cfg s) (e : Event) : Inv cfg (step cfg s e) := by
  cases e with
  | enqueue id priority => exact inv.enqueue id priority
  | withdraw id => exact inv.withdraw id
  | result run check verdict duration => exact inv.result run check verdict duration
  | fixed id attempt => exact inv.fixed id attempt
  | gaveUp id attempt detail => exact inv.gaveUp id attempt detail
  | foreign id => exact inv.foreign id
  | push run => exact inv.push run
  | probe id => exact inv.probe id
  | start count => exact inv.start count
  | land run => exact inv.land run
  | blame run => exact inv.blame run
  | cancel run => exact inv.cancel run

/-- Every reachable state satisfies the invariant. -/
theorem Reachable.inv {cfg : Config} {s : State} (reachable : Reachable cfg s) : Inv cfg s := by
  induction reachable with
  | empty => exact Inv.empty cfg
  | step e _ ih => exact ih.step e

end MergeQueue

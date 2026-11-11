import MergeQueue.Step

/-!
# Facts about the kernel's helper functions

Each lemma turns one executable (Boolean) definition into the statement it
decides, so the invariant proofs can speak in propositions.
-/

namespace MergeQueue

@[simp] theorem Status.isQueued_iff {st : Status} : st.isQueued = true ↔ st = .queued := by
  cases st <;> simp [Status.isQueued]

theorem Status.isFixing_iff {st : Status} : st.isFixing = true ↔ ∃ run, st = .fixing run := by
  cases st <;> simp [Status.isFixing]

theorem Status.terminal_not_queued {st : Status} (h : st.isTerminal = true) : st ≠ .queued := by
  cases st <;> simp_all [Status.isTerminal]

theorem Status.terminal_not_fixing {st : Status} (h : st.isTerminal = true) : st.isFixing = false := by
  cases st <;> simp_all [Status.isTerminal, Status.isFixing]

/-! ## strip -/

theorem strip_eq_some {m t b : Tree} : strip m t = some b ↔ t = m ++ b := by
  induction m generalizing t with
  | nil => simp [strip, eq_comm]
  | cons a m ih =>
    cases t with
    | nil => simp [strip]
    | cons x t =>
      simp only [strip, List.cons_append, List.cons.injEq]
      by_cases h : a = x
      · simp [h, ih]
      · simp [h, eq_comm]

theorem strip_append (m b : Tree) : strip m (m ++ b) = some b := strip_eq_some.mpr rfl

/-! ## partReady, live -/

theorem State.partReady_iff {s : State} {p : Part} :
    s.partReady p = true ↔ ∃ c ∈ s.changes, c.part = p ∧ c.status = .queued := by
  simp [State.partReady]

/-- What a live run guarantees. -/
theorem State.live_some {s : State} {r : Run} {batch : List Part} (h : s.live r = some batch) :
    r.tree = s.main ++ batch ∧ batch ≠ [] ∧ ∀ p ∈ batch, s.partReady p = true := by
  unfold State.live at h
  split at h
  · rename_i p rest found
    split at h
    · rename_i all
      cases h
      exact ⟨strip_eq_some.mp found, by simp, by simpa using all⟩
    · cases h
  · cases h

theorem State.findRun_some {s : State} {run : RunId} {r : Run} (h : s.findRun run = some r) :
    r ∈ s.runs ∧ r.id = run := by
  unfold State.findRun at h
  exact ⟨List.mem_of_find?_eq_some h, by simpa using List.find?_some h⟩

/-! ## ready -/

theorem State.mem_ready {s : State} {c : Change} : c ∈ s.ready ↔ c ∈ s.changes ∧ c.status = .queued := by
  unfold State.ready
  rw [(List.mergeSort_perm _ _).mem_iff]
  simp

theorem State.ready_perm (s : State) :
    s.ready.Perm (s.changes.filter fun c => c.status.isQueued) :=
  List.mergeSort_perm _ _

/-! ## results -/

theorem answered_append {results : List (CheckId × Verdict)} {check c : CheckId} {v : Verdict} :
    answered (results ++ [(c, v)]) check = (answered results check || c == check) := by
  simp [answered]

theorem failed_append {results : List (CheckId × Verdict)} {c : CheckId} {v : Verdict} :
    failed (results ++ [(c, v)]) = (failed results || v == Verdict.fail) := by
  simp [failed]

theorem complete_append {cfg : Config} {results : List (CheckId × Verdict)} {c : CheckId} {v : Verdict}
    (h : complete cfg results = true) : complete cfg (results ++ [(c, v)]) = true := by
  simp only [complete, List.all_eq_true] at *
  intro x hx
  rw [answered_append]
  simp [h x hx]

/-- Adding a result never makes a run pending again. -/
theorem Run.pending_append {cfg : Config} {r : Run} {c : CheckId} {v : Verdict}
    (h : Run.pending cfg { r with results := r.results ++ [(c, v)] } = true) : Run.pending cfg r = true := by
  simp only [Run.pending, Bool.and_eq_true, Bool.not_eq_true'] at *
  constructor
  · have := h.1
    rw [failed_append] at this
    simp only [Bool.or_eq_false_iff] at this
    exact this.1
  · cases hc : complete cfg r.results
    · rfl
    · have := complete_append (c := c) (v := v) hc
      simp [this] at h

/-! ## Refused or took effect

One lemma per decision: the event either left the state alone, or its guard
held and the state is the stated one. -/

/-- The change a blame makes to one change. -/
def blamedChange (cfg : Config) (run : RunId) (r : Run) (p : Part) (c : Change) : Change :=
  if c.part = p ∧ c.status.isQueued = true then
    if c.attempts < cfg.maxAttempts then { c with attempts := c.attempts + 1, status := .fixing run }
    else { c with status := .unmergeable ⟨.attemptsExhausted, exhaustedDetail, failures r.results, c.attempts⟩ }
  else c

/-- The change a landing makes to one change. -/
def landedChange (batch : List Part) (c : Change) : Change :=
  if batch.contains c.part = true ∧ c.status.isQueued = true then { c with status := .merged } else c

theorem State.enqueue_cases (s : State) (id : ChangeId) (priority : Nat) :
    s.enqueue id priority = s
      ∨ ((∀ c ∈ s.changes, c.id ≠ id) ∧ s.enqueue id priority =
          { s with
            changes := s.changes ++ [Change.mk id priority s.nextSeq 0 0 .queued]
            nextSeq := s.nextSeq + 1 }) := by
  unfold State.enqueue
  split
  · exact Or.inl rfl
  · rename_i absent
    refine Or.inr ⟨?_, rfl⟩
    simpa using absent

theorem State.result_cases (cfg : Config) (s : State) (run : RunId) (check : CheckId) (verdict : Verdict)
    (duration : Nat) :
    s.result cfg run check verdict duration = s
      ∨ (check ∈ cfg.required ∧ s.result cfg run check verdict duration =
          { s with
            runs := s.runs.map fun r =>
              if r.id = run ∧ answered r.results check = false then
                { r with results := r.results ++ [(check, verdict)] }
              else r
            history := record cfg.window s.history check duration }) := by
  unfold State.result
  split
  · rename_i guard
    exact Or.inr ⟨by simpa using guard.1, rfl⟩
  · exact Or.inl rfl

theorem State.start_cases (cfg : Config) (s : State) (count : Nat) :
    s.start cfg count = s
      ∨ (0 < count ∧ count ≤ s.ready.length ∧ s.pendingCount cfg < cfg.maxRuns
          ∧ (∀ r ∈ s.runs, r.tree ≠ s.main ++ (s.ready.take count).map Change.part)
          ∧ s.start cfg count =
            { s with
              runs := s.runs ++ [Run.mk s.nextRun s.main ((s.ready.take count).map Change.part) []]
              nextRun := s.nextRun + 1 }) := by
  unfold State.start
  simp only
  split
  · exact Or.inl rfl
  · rename_i guard
    simp only [not_or, Nat.not_lt, Nat.not_le, List.any_eq_true, beq_iff_eq, not_exists, not_and] at guard
    exact Or.inr ⟨Nat.pos_of_ne_zero guard.1, guard.2.1, guard.2.2.1, guard.2.2.2, rfl⟩

theorem State.landNow_cases (cfg : Config) (s : State) (run : RunId) :
    s.landNow cfg run = s
      ∨ ∃ r batch, s.findRun run = some r ∧ s.live r = some batch ∧ green cfg r.results = true
          ∧ s.landNow cfg run =
            { s with
              main := r.tree
              changes := s.changes.map (landedChange batch)
              runs := s.runs.filter fun x => x.id != run
              landed := s.landed ++ [Landing.mk run s.main batch r.results false]
              pushing := none } := by
  unfold State.landNow
  split
  · exact Or.inl rfl
  · rename_i r found
    split
    · exact Or.inl rfl
    · rename_i batch live
      split
      · rename_i isGreen
        exact Or.inr ⟨r, batch, found, live, isGreen, rfl⟩
      · exact Or.inl rfl

theorem State.blame_cases (cfg : Config) (s : State) (run : RunId) :
    s.blame cfg run = s
      ∨ ∃ r p, s.findRun run = some r ∧ s.live r = some [p] ∧ failed r.results = true
          ∧ s.blame cfg run = { s with changes := s.changes.map (blamedChange cfg run r p) } := by
  unfold State.blame
  split
  · exact Or.inl rfl
  · rename_i r found
    split
    · rename_i p live
      split
      · rename_i hasFailed
        exact Or.inr ⟨r, p, found, live, hasFailed, rfl⟩
      · exact Or.inl rfl
    · exact Or.inl rfl

theorem State.landNow_of_absent {cfg : Config} {s : State} {run : RunId} (absent : s.findRun run = none) :
    s.landNow cfg run = s := by
  unfold State.landNow
  simp [absent]

theorem State.blame_of_dead {cfg : Config} {s : State} {run : RunId} {r : Run} (found : s.findRun run = some r)
    (dead : s.live r = none) : s.blame cfg run = s := by
  unfold State.blame
  simp [found, dead]

theorem State.findRun_none_of_filter {s s' : State} {run : RunId}
    (h : s'.runs = s.runs.filter fun x => x.id != run) : s'.findRun run = none := by
  simp only [State.findRun, h, List.find?_eq_none, List.mem_filter, bne_iff_ne, ne_eq, beq_iff_eq, and_imp]
  intro r _ differs
  exact differs

/-- After a blame, the blamed part is not ready any more. -/
theorem State.blamed_not_ready (cfg : Config) (s s' : State) (run : RunId) (r : Run) (p : Part)
    (h : s'.changes = s.changes.map (blamedChange cfg run r p)) : s'.partReady p = false := by
  simp only [State.partReady, h, List.any_map, List.any_eq_false, Function.comp_def, Bool.and_eq_true, beq_iff_eq,
    Status.isQueued_iff, not_and]
  intro c _
  unfold blamedChange
  split
  · split <;> simp
  · rename_i other
    intro part queued
    simp only [Status.isQueued_iff] at other
    exact other ⟨by simpa [Change.part] using part, queued⟩

/-- A landing is refused unless that run is the one being pushed; otherwise it
is the recorded landing. -/
theorem State.land_eq (cfg : Config) (s : State) (run : RunId) :
    s.land cfg run = if s.pushing = some run then s.landNow cfg run else s := rfl

theorem State.land_cases (cfg : Config) (s : State) (run : RunId) :
    s.land cfg run = s ∨ (s.pushing = some run ∧ s.land cfg run = s.landNow cfg run) := by
  unfold State.land
  split
  · rename_i pushed; exact Or.inr ⟨pushed, rfl⟩
  · exact Or.inl rfl

/-- A fix answer is refused, or it is the re-queue of the change. -/
theorem State.fixed_cases (s : State) (id : ChangeId) (attempt : Nat) :
    s.fixed id attempt = s
      ∨ ((∃ c ∈ s.changes, c.id = id ∧ c.status.isFixing = true ∧ c.attempts = attempt)
          ∧ s.fixed id attempt = s.fixedNow id attempt) := by
  unfold State.fixed
  split
  · rename_i found
    obtain ⟨c, member, h⟩ := List.any_eq_true.mp found
    simp only [Bool.and_eq_true, beq_iff_eq] at h
    exact Or.inr ⟨⟨c, member, h.1.1, h.1.2, h.2⟩, rfl⟩
  · exact Or.inl rfl

/-- A fix answer for a change that is being fixed on that attempt takes effect. -/
theorem State.fixed_of_fixing (s : State) {c : Change} (member : c ∈ s.changes) (fixing : c.status.isFixing = true) :
    s.fixed c.id c.attempts = s.fixedNow c.id c.attempts := by
  unfold State.fixed
  have found : s.changes.any (fun d => d.id == c.id && d.status.isFixing && d.attempts == c.attempts) = true :=
    List.any_eq_true.mpr ⟨c, member, by simp [fixing]⟩
  simp [found]

end MergeQueue

import MergeQueue.Policy
import MergeQueue.Predict
import MergeQueue.Lemmas

/-!
# What predictions can and cannot do

Predicted durations order the checks and give an ETA. They never drop a check
and never influence what lands.
-/

namespace MergeQueue

/-! ## The schedule -/

/-- **Scheduling never drops or adds a check.** The schedule is the required
checks in another order. -/
theorem schedule_perm (cfg : Config) (history : List (CheckId × Nat)) :
    (schedule cfg history).Perm cfg.required :=
  List.mergeSort_perm _ _

/-- **Slowest first.** In the schedule, no check is predicted slower than one
before it. -/
theorem schedule_slowest_first (cfg : Config) (history : List (CheckId × Nat)) :
    (schedule cfg history).Pairwise fun a b => estimate cfg history b ≤ estimate cfg history a := by
  have sorted :=
    List.pairwise_mergeSort (le := fun a b => decide (estimate cfg history b ≤ estimate cfg history a))
      (fun a b c ab bc => by
        simp only [decide_eq_true_eq] at *
        omega)
      (fun a b => by
        simp only [Bool.or_eq_true, decide_eq_true_eq]
        omega)
      cfg.required
  simpa [schedule] using sorted

/-- The checks still to run are exactly the required checks without a result. -/
theorem mem_remaining {cfg : Config} {history : List (CheckId × Nat)} {results : List (CheckId × Verdict)}
    {check : CheckId} :
    check ∈ remaining cfg history results ↔ check ∈ cfg.required ∧ answered results check = false := by
  simp [remaining, (schedule_perm cfg history).mem_iff]

/-- Nothing is left to run exactly when the result is complete. -/
theorem remaining_nil_iff_complete {cfg : Config} {history : List (CheckId × Nat)}
    {results : List (CheckId × Verdict)} : remaining cfg history results = [] ↔ complete cfg results = true := by
  rw [List.eq_nil_iff_forall_not_mem]
  simp only [mem_remaining, not_and, Bool.not_eq_false, complete, List.all_eq_true]

/-! ## The estimate -/

/-- With no samples the estimate is the configured default. -/
theorem estimate_default {cfg : Config} {history : List (CheckId × Nat)} {check : CheckId}
    (none : samples history check = []) : estimate cfg history check = cfg.defaultDuration := by
  simp [estimate, none]

/-- **The estimate is a duration that happened.** With samples, the estimate
is one of them, so it lies between the fastest and the slowest run seen. -/
theorem estimate_is_a_sample {cfg : Config} {history : List (CheckId × Nat)} {check : CheckId}
    (some : samples history check ≠ []) : estimate cfg history check ∈ samples history check := by
  unfold estimate
  simp only
  have perm := List.mergeSort_perm (samples history check) fun a b => decide (a ≤ b)
  have length := perm.length_eq
  have positive : 0 < (samples history check).length := List.length_pos_iff.mpr some
  have inRange : ((samples history check).mergeSort fun a b => decide (a ≤ b)).length / 2
      < ((samples history check).mergeSort fun a b => decide (a ≤ b)).length := by
    rw [length]
    omega
  rw [List.getElem?_eq_getElem inRange]
  exact perm.mem_iff.mp (List.getElem_mem inRange)

/-! ## The ETA -/

theorem le_foldl_max (xs : List Nat) (start : Nat) : start ≤ xs.foldl max start ∧ ∀ x ∈ xs, x ≤ xs.foldl max start := by
  induction xs generalizing start with
  | nil => simp
  | cons y rest ih =>
    simp only [List.foldl_cons, List.mem_cons, forall_eq_or_imp]
    have := ih (max start y)
    exact ⟨Nat.le_trans (Nat.le_max_left _ _) this.1, Nat.le_trans (Nat.le_max_right _ _) this.1, this.2⟩

/-- **The ETA covers every check still to run.** No remaining check is
predicted to take longer than the run's ETA. -/
theorem eta_covers_remaining {cfg : Config} {history : List (CheckId × Nat)} {results : List (CheckId × Verdict)}
    {check : CheckId} (left : check ∈ remaining cfg history results) :
    estimate cfg history check ≤ eta cfg history results :=
  (le_foldl_max _ 0).2 _ (List.mem_map_of_mem left)

/-- A complete run has nothing left to wait for. -/
theorem eta_zero_when_complete {cfg : Config} {history : List (CheckId × Nat)} {results : List (CheckId × Verdict)}
    (done : complete cfg results = true) : eta cfg history results = 0 := by
  simp [eta, remaining_nil_iff_complete.mpr done]

/-! ## Predictions never decide -/

/-- The state without its duration history: everything a decision reads. -/
def State.core (s : State) : State := { s with history := [] }

/-- **Predictions never decide what happens.** Two queues that differ only in
their duration history take the same step: the same changes, runs, landings
and target. -/
theorem predictions_never_decide (cfg : Config) (s : State) (history : List (CheckId × Nat)) (e : Event) :
    (step cfg { s with history := history } e).core = (step cfg s e).core := by
  have findRun : ∀ run, State.findRun { s with history := history } run = s.findRun run := fun _ => rfl
  have live : ∀ r, State.live { s with history := history } r = s.live r := fun _ => rfl
  have ready : State.ready { s with history := history } = s.ready := rfl
  have pending : State.pendingCount cfg { s with history := history } = s.pendingCount cfg := rfl
  have pushingRun : State.pushingRun { s with history := history } = s.pushingRun := rfl
  have pushingPart : ∀ p, State.pushingPart { s with history := history } p = s.pushingPart p := fun _ => rfl
  have failuresOf : ∀ c, State.failuresOf { s with history := history } c = s.failuresOf c := fun _ => rfl
  cases e with
  | enqueue id priority =>
    simp only [step, State.enqueue]
    split <;> rfl
  | withdraw id =>
    simp only [step, State.withdraw, pushingPart]
    split <;> rfl
  | result run check verdict duration =>
    simp only [step, State.result]
    split <;> rfl
  | fixed id attempt =>
    simp only [step, State.fixed, State.fixedNow]
    split <;> rfl
  | gaveUp id attempt detail =>
    simp only [step, State.gaveUp, failuresOf]
    rfl
  | foreign id =>
    simp only [step, State.foreign]
    split <;> rfl
  | push run =>
    simp only [step, State.push, pushingRun, findRun]
    split
    · rfl
    · split
      · rfl
      · rename_i r _
        simp only [live]
        split <;> rfl
  | start count =>
    simp only [step, State.start, ready, pending]
    split <;> rfl
  | probe id =>
    simp only [step, State.probe, pending]
    (repeat' split) <;> rfl
  | land run =>
    simp only [step, State.land, State.landNow, findRun]
    split
    · split
      · rfl
      · rename_i r _
        simp only [live]
        split
        · rfl
        · split <;> rfl
    · rfl
  | blame run =>
    simp only [step, State.blame, findRun]
    split
    · rfl
    · rename_i r _
      simp only [live]
      split
      · split <;> rfl
      · rfl
  | cancel run => rfl

/-- The policy reads no durations: the same queue with another history makes
the same decision. -/
theorem plan_ignores_history (cfg : Config) (s : State) (history : List (CheckId × Nat)) :
    plan cfg { s with history := history } = plan cfg s := rfl

/-! ## Bounded memory -/

theorem length_filter_eraseP_le {α : Type} (p : α → Bool) (l : List α) (some : (l.filter p).length ≠ 0) :
    ((l.eraseP p).filter p).length + 1 = (l.filter p).length := by
  induction l with
  | nil => simp at some
  | cons x rest ih =>
    by_cases hx : p x = true
    · simp [hx]
    · have hx' : p x = false := by simpa using hx
      simp only [List.eraseP_cons, hx', cond_false, List.filter_cons, Bool.false_eq_true, if_false] at *
      exact ih some

/-- Recording keeps at most `window` samples of the recorded check when it had
at most `window` before, and leaves every other check's samples alone. -/
theorem record_bounded (window : Nat) (history : List (CheckId × Nat)) (check other : CheckId) (duration : Nat)
    (bounded : (samples history other).length ≤ window) :
    (samples (record window history check duration) other).length ≤ window := by
  simp only [samples, List.length_map] at *
  unfold record
  simp only
  by_cases same : other = check
  · subst same
    split
    · rename_i over
      have := length_filter_eraseP_le (fun h : CheckId × Nat => h.1 == other) (history ++ [(other, duration)])
        (by omega)
      simp only [List.filter_append, List.length_append] at this over ⊢
      simp at this over
      omega
    · rename_i fits
      omega
  · have skip : ∀ l : List (CheckId × Nat),
        ((l.eraseP fun h => h.1 == check).filter fun h => h.1 == other) = l.filter fun h => h.1 == other := by
      intro l
      induction l with
      | nil => rfl
      | cons x rest ih =>
        by_cases hx : (x.1 == check) = true
        · have differs : (x.1 == other) = false := by
            simp only [beq_iff_eq] at hx
            simp only [beq_eq_false_iff_ne, ne_eq, hx]
            exact fun h => same h.symm
          rw [List.eraseP_cons_of_pos (by simpa using hx), List.filter_cons_of_neg (by simp [differs])]
        · rw [List.eraseP_cons_of_neg (by simpa using hx), List.filter_cons, List.filter_cons, ih]
    have appended :
        ((history ++ [(check, duration)]).filter fun h => h.1 == other) = history.filter fun h => h.1 == other := by
      have : (check == other) = false := by simp; exact fun h => same h.symm
      simp [List.filter_append, this]
    split
    · rw [skip, appended]; exact bounded
    · rw [appended]; exact bounded

/-- **The duration history is bounded.** The queue never remembers more than
`window` samples of any check. -/
theorem history_bounded {cfg : Config} {s : State} (reachable : Reachable cfg s) (check : CheckId) :
    (samples s.history check).length ≤ cfg.window := by
  induction reachable with
  | empty => simp [State.empty, samples]
  | @step s e _ ih =>
    cases e with
    | enqueue id priority =>
      simp only [step, State.enqueue]
      split <;> exact ih
    | withdraw id =>
      simp only [step, State.withdraw]
      split <;> exact ih
    | result run c verdict duration =>
      rcases s.result_cases cfg run c verdict duration with refused | ⟨_, took⟩
      · simp only [step, refused]; exact ih
      · simp only [step, took]
        exact record_bounded _ _ _ _ _ ih
    | fixed id attempt =>
      simp only [step, State.fixed, State.fixedNow]
      split <;> exact ih
    | gaveUp id attempt detail => exact ih
    | foreign id =>
      simp only [step, State.foreign]
      split <;> exact ih
    | push run =>
      simp only [step, State.push]
      (repeat' split) <;> exact ih
    | probe id =>
      simp only [step, State.probe]
      (repeat' split) <;> exact ih
    | start count =>
      simp only [step, State.start]
      split <;> exact ih
    | land run =>
      rcases s.land_cases cfg run with refused | ⟨_, eq⟩
      · simp only [step, refused]; exact ih
      · rcases s.landNow_cases cfg run with refused | ⟨_, _, _, _, _, took⟩
        · simp only [step, eq, refused]; exact ih
        · simp only [step, eq, took]; exact ih
    | blame run =>
      rcases s.blame_cases cfg run with refused | ⟨_, _, _, _, _, took⟩
      · simp only [step, refused]; exact ih
      · simp only [step, took]; exact ih
    | cancel run => exact ih

end MergeQueue

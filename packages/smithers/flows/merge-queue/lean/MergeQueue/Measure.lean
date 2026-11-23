import MergeQueue.Progress

/-!
# One measure for the whole queue

`State.measure` is one number. Every decision the policy makes lowers it, and
so does every answer that takes effect: a check result, a fix, a verdict, a
landing, a withdrawal. So a queue that receives no new change, no commit from
outside and loses no run cannot go on for ever: the number of decisions and
answers is at most the measure (`advancing_bounded`), and the policy settles
within that many decisions (`settle_quiet`).

The measure is the budget, weighted above everything else, plus what the queue
can still do without the budget moving:

* the prefixes of the ready order the policy may still start (`openPrefixes`),
* the ready changes it may still probe (`openProbes`),
* whether it may still push (`pushFree`),
* the runs it holds, each of which it can cancel once, and
* the required checks those runs have not answered (`owed`).

A start or a probe uses one open prefix or probe and adds one run and its
checks; a cancel removes a run and reopens nothing; a result answers one check.

Three events may raise the measure, and only these: a new change, a commit
from outside, and a run forgotten other than by the policy's own decision. The
measure speaks of the policy's decisions, not of any `start`, `probe` or
`cancel` a driver could send: a driver that starts and cancels the same run
for ever is refused nothing by `step`, and `plan` never does it.
-/

namespace MergeQueue

/-! ## Counting -/

theorem countP_lt_of {α : Type} (p q : α → Bool) (l : List α) (mono : ∀ x ∈ l, p x = true → q x = true)
    (strict : ∃ x ∈ l, q x = true ∧ p x = false) : l.countP p < l.countP q := by
  induction l with
  | nil =>
    obtain ⟨x, member, _⟩ := strict
    cases member
  | cons a rest ih =>
    have tail : rest.countP p ≤ rest.countP q :=
      List.countP_mono_left fun x hx => mono x (List.mem_cons_of_mem _ hx)
    have head := mono a (by simp)
    obtain ⟨x, member, qx, px⟩ := strict
    simp only [List.countP_cons]
    rcases List.mem_cons.mp member with rfl | inRest
    · simp only [qx, px, if_true, Bool.false_eq_true, if_false]
      omega
    · have := ih (fun x hx => mono x (List.mem_cons_of_mem _ hx)) ⟨x, inRest, qx, px⟩
      cases hp : p a
      · simp only [Bool.false_eq_true, if_false]
        split <;> omega
      · simp only [head hp, if_true]
        omega

theorem sum_map_filter_le {α : Type} (f : α → Nat) (p : α → Bool) (l : List α) :
    ((l.filter p).map f).sum ≤ (l.map f).sum := by
  induction l with
  | nil => simp
  | cons a rest ih =>
    simp only [List.filter_cons]
    split
    · simp only [List.map_cons, List.sum_cons]
      omega
    · simp only [List.map_cons, List.sum_cons]
      omega

theorem length_filter_lt {α : Type} (p : α → Bool) (l : List α) (x : α) (member : x ∈ l) (out : p x = false) :
    (l.filter p).length < l.length := by
  induction l with
  | nil => cases member
  | cons a rest ih =>
    have le : (rest.filter p).length ≤ rest.length := List.length_filter_le _ _
    simp only [List.filter_cons]
    rcases List.mem_cons.mp member with rfl | inRest
    · simp only [out, Bool.false_eq_true, if_false, List.length_cons]
      omega
    · have := ih inRest
      split
      · simp only [List.length_cons]
        omega
      · simp only [List.length_cons]
        omega

/-! ## The parts of the measure -/

/-- The required checks a run has not answered. -/
def Run.owed (cfg : Config) (r : Run) : Nat :=
  cfg.required.countP fun check => !answered r.results check

/-- The required checks the queue's runs have not answered. -/
def State.owed (cfg : Config) (s : State) : Nat :=
  (s.runs.map (Run.owed cfg)).sum

/-- The target's tree plus the first `n` ready changes. -/
def State.prefixTree (s : State) (n : Nat) : Tree :=
  s.main ++ (s.ready.take n).map Change.part

/-- The queue holds a run on this tree. -/
def State.held (s : State) (tree : Tree) : Bool :=
  s.runs.any fun r => r.tree == tree

/-- The policy may still start the first `n` ready changes: no run is on that
tree, and no failed run shows that those `n`, or fewer, fail together. -/
def State.openPrefix (s : State) (n : Nat) : Bool :=
  !s.held (s.prefixTree n) && s.failedPrefixes.all fun m => n < m

/-- How many prefixes of the ready order the policy may still start. -/
def State.openPrefixes (s : State) : Nat :=
  (List.range s.ready.length).countP fun i => s.openPrefix (i + 1)

/-- How many ready changes no run tests alone on the target. -/
def State.openProbes (s : State) : Nat :=
  s.ready.countP fun c => !s.held (s.main ++ [c.part])

/-- 1 while the queue may decide to push, 0 while a push is under way. -/
def State.pushFree (s : State) : Nat :=
  if s.pushingRun.isSome then 0 else 1

/-- **The measure.** The budget, weighted above everything the queue can do
while the budget stands still. -/
def State.measure (cfg : Config) (s : State) : Nat :=
  s.budget cfg * ((cfg.required.length + 2) * (2 * s.changes.length) + 2)
    + ((cfg.required.length + 2) * (s.openPrefixes + s.openProbes) + s.pushFree)
    + (s.runs.length + s.owed cfg)

/-! ## What depends on what -/

theorem State.ready_congr {s s' : State} (changes : s'.changes = s.changes) : s'.ready = s.ready := by
  unfold State.ready
  rw [changes]

theorem State.live_congr {s s' : State} (main : s'.main = s.main) (changes : s'.changes = s.changes) (r : Run) :
    s'.live r = s.live r := by
  have ready : s'.partReady = s.partReady := by
    funext p
    simp only [State.partReady, changes]
  unfold State.live
  rw [main, ready]

theorem State.live_tree (s : State) {r r' : Run} (tree : r'.tree = r.tree) : s.live r' = s.live r := by
  unfold State.live
  rw [tree]

theorem State.prefixLength_congr {s s' : State} (main : s'.main = s.main) (changes : s'.changes = s.changes)
    (r : Run) : s'.prefixLength r = s.prefixLength r := by
  unfold State.prefixLength
  rw [State.live_congr main changes, State.ready_congr changes]

theorem State.prefixLength_tree (s : State) {r r' : Run} (tree : r'.tree = r.tree) :
    s.prefixLength r' = s.prefixLength r := by
  unfold State.prefixLength
  rw [State.live_tree s tree]

theorem State.prefixTree_congr {s s' : State} (main : s'.main = s.main) (changes : s'.changes = s.changes)
    (n : Nat) : s'.prefixTree n = s.prefixTree n := by
  unfold State.prefixTree
  rw [main, State.ready_congr changes]

theorem State.held_iff {s : State} {tree : Tree} : s.held tree = true ↔ ∃ r ∈ s.runs, r.tree = tree := by
  simp [State.held]

theorem State.held_false {s : State} {tree : Tree} : s.held tree = false ↔ ∀ r ∈ s.runs, r.tree ≠ tree := by
  simp [State.held]

theorem State.openPrefix_iff {s : State} {n : Nat} :
    s.openPrefix n = true ↔ s.held (s.prefixTree n) = false ∧ ∀ m ∈ s.failedPrefixes, n < m := by
  simp [State.openPrefix]

theorem State.pushingRun_isSome {s : State} :
    s.pushingRun.isSome = true ↔ ∃ id r, s.pushing = some id ∧ s.findRun id = some r ∧ (s.live r).isSome = true := by
  unfold State.pushingRun
  constructor
  · intro h
    split at h
    · cases h
    · rename_i id pushed
      split at h
      · cases h
      · rename_i r found
        split at h
        · rename_i alive
          exact ⟨id, r, pushed, found, alive⟩
        · cases h
  · rintro ⟨id, r, pushed, found, alive⟩
    simp [pushed, found, alive]

theorem State.pushFree_le_one (s : State) : s.pushFree ≤ 1 := by
  unfold State.pushFree
  split <;> omega

theorem State.ready_length_le (s : State) : s.ready.length ≤ s.changes.length := by
  rw [s.ready_perm.length_eq]
  exact List.length_filter_le _ _

theorem State.openPrefixes_le (s : State) : s.openPrefixes ≤ s.changes.length := by
  have : s.openPrefixes ≤ (List.range s.ready.length).length := List.countP_le_length
  rw [List.length_range] at this
  exact Nat.le_trans this s.ready_length_le

theorem State.openProbes_le (s : State) : s.openProbes ≤ s.changes.length :=
  Nat.le_trans List.countP_le_length s.ready_length_le

/-- Open prefixes do not rise when every prefix open after was open before. -/
theorem State.openPrefixes_mono {s s' : State} (changes : s'.changes = s.changes)
    (keeps : ∀ n, 0 < n → n ≤ s.ready.length → s'.openPrefix n = true → s.openPrefix n = true) :
    s'.openPrefixes ≤ s.openPrefixes := by
  unfold State.openPrefixes
  rw [State.ready_congr changes]
  apply List.countP_mono_left
  intro i member
  have := List.mem_range.mp member
  exact keeps (i + 1) (by omega) (by omega)

/-- Open prefixes fall when, besides, one that was open is open no more. -/
theorem State.openPrefixes_lt {s s' : State} (changes : s'.changes = s.changes)
    (keeps : ∀ n, 0 < n → n ≤ s.ready.length → s'.openPrefix n = true → s.openPrefix n = true)
    (used : ∃ n, 0 < n ∧ n ≤ s.ready.length ∧ s.openPrefix n = true ∧ s'.openPrefix n = false) :
    s'.openPrefixes < s.openPrefixes := by
  unfold State.openPrefixes
  rw [State.ready_congr changes]
  apply countP_lt_of
  · intro i member
    have := List.mem_range.mp member
    exact keeps (i + 1) (by omega) (by omega)
  · obtain ⟨n, positive, enough, before, after⟩ := used
    cases n with
    | zero => omega
    | succ k => exact ⟨k, List.mem_range.mpr (by omega), before, after⟩

theorem State.openProbes_mono {s s' : State} (main : s'.main = s.main) (changes : s'.changes = s.changes)
    (keeps : ∀ c ∈ s.ready, s'.held (s.main ++ [c.part]) = false → s.held (s.main ++ [c.part]) = false) :
    s'.openProbes ≤ s.openProbes := by
  unfold State.openProbes
  rw [State.ready_congr changes, main]
  apply List.countP_mono_left
  intro c member open'
  simp only [Bool.not_eq_true'] at open' ⊢
  exact keeps c member open'

theorem State.openProbes_lt {s s' : State} (main : s'.main = s.main) (changes : s'.changes = s.changes)
    (keeps : ∀ c ∈ s.ready, s'.held (s.main ++ [c.part]) = false → s.held (s.main ++ [c.part]) = false)
    (used : ∃ c ∈ s.ready, s.held (s.main ++ [c.part]) = false ∧ s'.held (s.main ++ [c.part]) = true) :
    s'.openProbes < s.openProbes := by
  unfold State.openProbes
  rw [State.ready_congr changes, main]
  apply countP_lt_of
  · intro c member open'
    simp only [Bool.not_eq_true'] at open' ⊢
    exact keeps c member open'
  · obtain ⟨c, member, before, after⟩ := used
    exact ⟨c, member, by simp [before], by simp [after]⟩

/-! ## Putting the parts together -/

/-- With the budget and the changes as they were, the measure falls when the
rest of it falls. -/
theorem measure_lt_of_rest {cfg : Config} {s s' : State} (budget : s'.budget cfg = s.budget cfg)
    (changes : s'.changes.length = s.changes.length)
    (rest : (cfg.required.length + 2) * (s'.openPrefixes + s'.openProbes) + s'.pushFree
        + (s'.runs.length + s'.owed cfg)
      < (cfg.required.length + 2) * (s.openPrefixes + s.openProbes) + s.pushFree + (s.runs.length + s.owed cfg)) :
    s'.measure cfg < s.measure cfg := by
  unfold State.measure
  rw [budget, changes]
  omega

/-- A lower budget lowers the measure, whatever the queue may now start, probe
or push, as long as it holds no more runs and owes no more checks. -/
theorem measure_lt_of_budget {cfg : Config} {s s' : State} (budget : s'.budget cfg < s.budget cfg)
    (changes : s'.changes.length = s.changes.length) (runs : s'.runs.length ≤ s.runs.length)
    (owed : s'.owed cfg ≤ s.owed cfg) : s'.measure cfg < s.measure cfg := by
  unfold State.measure
  rw [changes]
  have prefixes := s'.openPrefixes_le
  have probes := s'.openProbes_le
  have push := s'.pushFree_le_one
  have todo : (cfg.required.length + 2) * (s'.openPrefixes + s'.openProbes)
      ≤ (cfg.required.length + 2) * (2 * s.changes.length) :=
    Nat.mul_le_mul_left _ (by omega)
  have weight : (s'.budget cfg + 1) * ((cfg.required.length + 2) * (2 * s.changes.length) + 2)
      ≤ s.budget cfg * ((cfg.required.length + 2) * (2 * s.changes.length) + 2) :=
    Nat.mul_le_mul_right _ budget
  rw [Nat.succ_mul] at weight
  omega

/-! ## Events that only add to what the queue holds -/

/-- `s'` holds every run `s` holds, on the same tree and no less failed, and
nothing else about the queue differs. A result, a start and a probe are such
steps. -/
structure Grows (s s' : State) : Prop where
  main : s'.main = s.main
  changes : s'.changes = s.changes
  pushing : s'.pushing = s.pushing
  runs : ∀ r ∈ s.runs, ∃ r' ∈ s'.runs, r'.tree = r.tree ∧ (failed r.results = true → failed r'.results = true)
  find : ∀ id r, s.findRun id = some r → ∃ r', s'.findRun id = some r' ∧ r'.tree = r.tree

theorem Grows.held {s s' : State} (grows : Grows s s') {tree : Tree} (h : s.held tree = true) :
    s'.held tree = true := by
  obtain ⟨r, member, same⟩ := State.held_iff.mp h
  obtain ⟨r', member', tree', _⟩ := grows.runs r member
  exact State.held_iff.mpr ⟨r', member', by rw [tree', same]⟩

theorem Grows.unheld {s s' : State} (grows : Grows s s') {tree : Tree} (h : s'.held tree = false) :
    s.held tree = false := by
  cases before : s.held tree
  · rfl
  · rw [grows.held before] at h
    cases h

theorem Grows.failedPrefixes {s s' : State} (grows : Grows s s') {m : Nat} (h : m ∈ s.failedPrefixes) :
    m ∈ s'.failedPrefixes := by
  obtain ⟨r, member, isPrefix, hasFailed⟩ := State.mem_failedPrefixes.mp h
  obtain ⟨r', member', tree, keeps⟩ := grows.runs r member
  refine State.mem_failedPrefixes.mpr ⟨r', member', ?_, keeps hasFailed⟩
  rw [State.prefixLength_congr grows.main grows.changes, State.prefixLength_tree s tree]
  exact isPrefix

theorem Grows.openPrefix {s s' : State} (grows : Grows s s') (n : Nat) (h : s'.openPrefix n = true) :
    s.openPrefix n = true := by
  obtain ⟨free, short⟩ := State.openPrefix_iff.mp h
  rw [State.prefixTree_congr grows.main grows.changes] at free
  exact State.openPrefix_iff.mpr ⟨grows.unheld free, fun m member => short m (grows.failedPrefixes member)⟩

theorem Grows.openPrefixes {s s' : State} (grows : Grows s s') : s'.openPrefixes ≤ s.openPrefixes :=
  State.openPrefixes_mono grows.changes fun n _ _ => grows.openPrefix n

theorem Grows.openProbes {s s' : State} (grows : Grows s s') : s'.openProbes ≤ s.openProbes :=
  State.openProbes_mono grows.main grows.changes fun _ _ => grows.unheld

theorem Grows.pushFree {s s' : State} (grows : Grows s s') : s'.pushFree ≤ s.pushFree := by
  unfold State.pushFree
  cases busy : s.pushingRun.isSome
  · simp only [Bool.false_eq_true, if_false]
    split <;> omega
  · obtain ⟨id, r, pushed, found, alive⟩ := State.pushingRun_isSome.mp busy
    obtain ⟨r', found', tree⟩ := grows.find id r found
    have : s'.pushingRun.isSome = true :=
      State.pushingRun_isSome.mpr ⟨id, r', by rw [grows.pushing, pushed], found', by
        rw [State.live_congr grows.main grows.changes, State.live_tree s tree]
        exact alive⟩
    simp [this]

/-- Adding a run is such a step. -/
theorem grows_append (s : State) (x : Run) (next : RunId) :
    Grows s { s with runs := s.runs ++ [x], nextRun := next } where
  main := rfl
  changes := rfl
  pushing := rfl
  runs := fun r member => ⟨r, List.mem_append_left _ member, rfl, id⟩
  find := fun id r found => by
    refine ⟨r, ?_, rfl⟩
    unfold State.findRun at found ⊢
    simp [List.find?_append, found]

/-- The run a result is recorded on. -/
def answeredRun (run : RunId) (check : CheckId) (verdict : Verdict) (r : Run) : Run :=
  if r.id = run ∧ answered r.results check = false then { r with results := r.results ++ [(check, verdict)] } else r

theorem answeredRun_id (run : RunId) (check : CheckId) (verdict : Verdict) (r : Run) :
    (answeredRun run check verdict r).id = r.id := by
  unfold answeredRun
  split <;> rfl

theorem answeredRun_tree (run : RunId) (check : CheckId) (verdict : Verdict) (r : Run) :
    (answeredRun run check verdict r).tree = r.tree := by
  unfold answeredRun
  split <;> rfl

theorem answeredRun_failed (run : RunId) (check : CheckId) (verdict : Verdict) (r : Run)
    (h : failed r.results = true) : failed (answeredRun run check verdict r).results = true := by
  unfold answeredRun
  split
  · simp [failed_append, h]
  · exact h

/-- Recording a result is such a step. -/
theorem grows_answered (s : State) (run : RunId) (check : CheckId) (verdict : Verdict)
    (history : List (CheckId × Nat)) :
    Grows s { s with runs := s.runs.map (answeredRun run check verdict), history := history } where
  main := rfl
  changes := rfl
  pushing := rfl
  runs := fun r member =>
    ⟨answeredRun run check verdict r, List.mem_map_of_mem member, answeredRun_tree run check verdict r,
      answeredRun_failed run check verdict r⟩
  find := fun id r found => by
    refine ⟨answeredRun run check verdict r, ?_, answeredRun_tree run check verdict r⟩
    have same : ((fun x : Run => x.id == id) ∘ answeredRun run check verdict) = fun x : Run => x.id == id := by
      funext x
      simp [answeredRun_id]
    unfold State.findRun at found ⊢
    simp only [List.find?_map, same, found, Option.map_some]

/-! ## A result -/

theorem Run.owed_answered_le (cfg : Config) (run : RunId) (check : CheckId) (verdict : Verdict) (r : Run) :
    (answeredRun run check verdict r).owed cfg ≤ r.owed cfg := by
  unfold answeredRun
  split
  · unfold Run.owed
    apply List.countP_mono_left
    intro x _ open'
    simp only [answered_append, Bool.not_eq_true', Bool.or_eq_false_iff] at open'
    simp [open'.1]
  · exact Nat.le_refl _

theorem Run.owed_answered_lt (cfg : Config) {run : RunId} {check : CheckId} (verdict : Verdict) {r : Run}
    (required : check ∈ cfg.required) (id : r.id = run) (unanswered : answered r.results check = false) :
    (answeredRun run check verdict r).owed cfg < r.owed cfg := by
  unfold answeredRun
  rw [if_pos ⟨id, unanswered⟩]
  unfold Run.owed
  apply countP_lt_of
  · intro x _ open'
    simp only [answered_append, Bool.not_eq_true', Bool.or_eq_false_iff] at open'
    simp [open'.1]
  · exact ⟨check, required, by simp [unanswered], by simp [answered_append]⟩

/-- **Every check result that is recorded lowers the measure.** -/
theorem measure_result_lt (cfg : Config) (s : State) (run : RunId) (check : CheckId) (verdict : Verdict)
    (duration : Nat) (took : s.result cfg run check verdict duration ≠ s) :
    (s.result cfg run check verdict duration).measure cfg < s.measure cfg := by
  unfold State.result at took ⊢
  split
  · rename_i guard
    obtain ⟨required, waiting⟩ := guard
    obtain ⟨r, member, holds⟩ := List.any_eq_true.mp waiting
    simp only [Bool.and_eq_true, beq_iff_eq, Bool.not_eq_true'] at holds
    have grows := grows_answered s run check verdict (record cfg.window s.history check duration)
    have prefixes := grows.openPrefixes
    have probes := grows.openProbes
    have push := grows.pushFree
    have owed : (State.owed cfg
        { s with
          runs := s.runs.map (answeredRun run check verdict)
          history := record cfg.window s.history check duration }) < s.owed cfg := by
      unfold State.owed
      apply sum_map_lt
      · intro x _
        exact Run.owed_answered_le cfg run check verdict x
      · exact ⟨r, member, Run.owed_answered_lt cfg verdict (by simpa using required) holds.1 holds.2⟩
    have todo := Nat.mul_le_mul_left (cfg.required.length + 2) (Nat.add_le_add prefixes probes)
    refine measure_lt_of_rest (s := s)
      (s' := { s with
        runs := s.runs.map (answeredRun run check verdict)
        history := record cfg.window s.history check duration }) rfl rfl ?_
    simp only [List.length_map]
    omega
  · rename_i refused
    rw [if_neg refused] at took
    exact absurd rfl took

/-! ## A push -/

/-- **Every decision to push that takes effect lowers the measure.** -/
theorem measure_push_lt (cfg : Config) (s : State) (run : RunId) (took : s.push cfg run ≠ s) :
    (s.push cfg run).measure cfg < s.measure cfg := by
  unfold State.push at took ⊢
  split
  · rename_i busy
    simp only [busy] at took
    exact absurd rfl took
  · rename_i idle
    simp only [idle] at took
    split
    · rename_i absent
      simp only [absent] at took
      exact absurd rfl took
    · rename_i r found
      simp only [found] at took
      split
      · rename_i can
        simp only [Bool.and_eq_true] at can
        have before : s.pushFree = 1 := by simp [State.pushFree, idle]
        have after : State.pushFree { s with pushing := some run } = 0 := by
          have : (State.pushingRun { s with pushing := some run }).isSome = true :=
            State.pushingRun_isSome.mpr ⟨run, r, rfl, found, can.1⟩
          simp [State.pushFree, this]
        refine measure_lt_of_rest (s := s) (s' := { s with pushing := some run }) rfl rfl ?_
        show (cfg.required.length + 2) * (s.openPrefixes + s.openProbes)
            + State.pushFree { s with pushing := some run } + (s.runs.length + s.owed cfg) < _
        rw [after, before]
        omega
      · rename_i cannot
        simp only [cannot] at took
        exact absurd rfl took

/-! ## A start and a probe -/

theorem Run.owed_new (cfg : Config) (id : RunId) (base : Tree) (batch : List Part) :
    (Run.mk id base batch []).owed cfg = cfg.required.length := by
  simp [Run.owed, answered]

theorem State.owed_append (cfg : Config) (s : State) (x : Run) (next : RunId) :
    State.owed cfg { s with runs := s.runs ++ [x], nextRun := next } = s.owed cfg + x.owed cfg := by
  simp [State.owed]

/-- **Every start the policy decides lowers the measure.** -/
theorem measure_start_lt {cfg : Config} {s : State} {count : Nat} (next : s.nextStart cfg = some count)
    (took : s.start cfg count ≠ s) : (s.start cfg count).measure cfg < s.measure cfg := by
  rcases s.start_cases cfg count with refused | ⟨positive, enough, _, fresh, eq⟩
  · exact absurd refused took
  · rw [eq]
    have grows := grows_append s (Run.mk s.nextRun s.main ((s.ready.take count).map Change.part) []) (s.nextRun + 1)
    have probes := grows.openProbes
    have push := grows.pushFree
    have prefixes : State.openPrefixes
        { s with
          runs := s.runs ++ [Run.mk s.nextRun s.main ((s.ready.take count).map Change.part) []]
          nextRun := s.nextRun + 1 } + 1 ≤ s.openPrefixes := by
      apply State.openPrefixes_lt grows.changes (fun n _ _ => grows.openPrefix n)
      refine ⟨count, positive, enough, ?_, ?_⟩
      · refine State.openPrefix_iff.mpr ⟨State.held_false.mpr fresh, ?_⟩
        intro m member
        cases known : s.shortestFailed with
        | none =>
          rw [State.shortestFailed] at known
          rw [minOf_none.mp known] at member
          cases member
        | some least =>
          have narrow := bisection_narrows known next
          have := (minOf_some (by rw [State.shortestFailed] at known; exact known)).2 m member
          omega
      · cases after : State.openPrefix _ count
        · rfl
        · have := (State.openPrefix_iff.mp after).1
          rw [State.held_false] at this
          exact absurd rfl (this _ (List.mem_append_right _ (List.mem_singleton.mpr rfl)))
    have owed := State.owed_append cfg s (Run.mk s.nextRun s.main ((s.ready.take count).map Change.part) [])
      (s.nextRun + 1)
    rw [Run.owed_new] at owed
    have todo := Nat.mul_le_mul_left (cfg.required.length + 2) (Nat.add_le_add prefixes probes)
    refine measure_lt_of_rest (s := s) rfl rfl ?_
    rw [owed]
    simp only [List.length_append, List.length_singleton]
    simp only [Nat.mul_add, Nat.mul_one] at todo ⊢
    omega

/-- **Every probe that takes effect lowers the measure.** -/
theorem measure_probe_lt (cfg : Config) (s : State) (id : ChangeId) (took : s.probe cfg id ≠ s) :
    (s.probe cfg id).measure cfg < s.measure cfg := by
  rcases s.probe_cases cfg id with refused | ⟨c, _, member, _, queued, _, fresh, eq⟩
  · exact absurd refused took
  · rw [eq]
    have grows := grows_append s (Run.mk s.nextRun s.main [c.part] []) (s.nextRun + 1)
    have prefixes := grows.openPrefixes
    have push := grows.pushFree
    have probes : State.openProbes
        { s with runs := s.runs ++ [Run.mk s.nextRun s.main [c.part] []], nextRun := s.nextRun + 1 } + 1
          ≤ s.openProbes := by
      apply State.openProbes_lt grows.main grows.changes (fun _ _ => grows.unheld)
      refine ⟨c, State.mem_ready.mpr ⟨member, queued⟩, State.held_false.mpr fresh, ?_⟩
      exact State.held_iff.mpr ⟨_, List.mem_append_right _ (List.mem_singleton.mpr rfl), rfl⟩
    have owed := State.owed_append cfg s (Run.mk s.nextRun s.main [c.part] []) (s.nextRun + 1)
    rw [Run.owed_new] at owed
    have todo := Nat.mul_le_mul_left (cfg.required.length + 2) (Nat.add_le_add prefixes probes)
    refine measure_lt_of_rest (s := s) rfl rfl ?_
    rw [owed]
    simp only [List.length_append, List.length_singleton]
    simp only [Nat.mul_add, Nat.mul_one] at todo ⊢
    omega

/-! ## A cancel the policy decides -/

/-- A useless live run is doomed, and is not the run being pushed. -/
theorem State.useless_live {s : State} {r : Run} (useless : s.useless r = true) (alive : (s.live r).isSome = true) :
    s.doomed r = true ∧ s.pushing ≠ some r.id := by
  simp only [State.useless, alive, Bool.not_true, Bool.false_and, Bool.false_or, Bool.and_eq_true, bne_iff_ne,
    ne_eq] at useless
  exact useless

/-- A doomed prefix run is longer than another failed prefix the queue holds. -/
theorem State.doomed_prefix {s : State} {r : Run} {n : Nat} (doomed : s.doomed r = true)
    (isPrefix : s.prefixLength r = some n) :
    ∃ y ∈ s.runs, ∃ m, s.prefixLength y = some m ∧ failed y.results = true ∧ m < n := by
  obtain ⟨batch, alive, _, _⟩ := State.prefixLength_some isPrefix
  unfold State.doomed at doomed
  simp only [alive, isPrefix] at doomed
  split at doomed
  · rename_i m known
    have shorter : m < n := by simpa using doomed
    have listed := (minOf_some (by rw [State.shortestFailed] at known; exact known)).1
    obtain ⟨y, member, yPrefix, yFailed⟩ := State.mem_failedPrefixes.mp listed
    exact ⟨y, member, m, yPrefix, yFailed, shorter⟩
  · cases doomed

/-- A run on the target plus one ready change is live with that one part. -/
theorem State.live_single {s : State} {r : Run} {c : Change} (ready : c ∈ s.ready)
    (tree : r.tree = s.main ++ [c.part]) : s.live r = some [c.part] := by
  have queued := State.mem_ready.mp ready
  have : s.partReady c.part = true := State.partReady_iff.mpr ⟨c, queued.1, rfl, queued.2⟩
  unfold State.live
  rw [tree, strip_append]
  simp [this]

/-- With nothing to blame, a useless run is not a run of one ready change. -/
theorem State.useless_not_single {s : State} {r : Run} {c : Change} (noBlame : s.runs.find? s.blameable = none)
    (member : r ∈ s.runs) (useless : s.useless r = true) (ready : c ∈ s.ready) :
    r.tree ≠ s.main ++ [c.part] := by
  intro tree
  have alive := State.live_single ready tree
  have doomed := (State.useless_live useless (by simp [alive])).1
  have notBlameable : s.blameable r = false := by
    have := List.find?_eq_none.mp noBlame r member
    simpa using this
  cases isPrefix : s.prefixLength r with
  | none =>
    unfold State.doomed at doomed
    simp only [alive, isPrefix] at doomed
    unfold State.blameable at notBlameable
    simp only [alive] at notBlameable
    rw [doomed] at notBlameable
    cases notBlameable
  | some n =>
    obtain ⟨batch, alive', length, _⟩ := State.prefixLength_some isPrefix
    rw [alive] at alive'
    cases alive'
    obtain ⟨y, _, m, yPrefix, _, shorter⟩ := State.doomed_prefix doomed isPrefix
    have := (State.prefixLength_bounds yPrefix).1
    simp only [List.length_singleton] at length
    omega

/-- **Every cancel the policy decides lowers the measure.** The policy forgets
a run only when it has no more use for it, so no prefix and no probe opens
again, and the push under way is never forgotten. -/
theorem measure_cancel_lt {cfg : Config} {s : State} {r : Run} (inv : Inv cfg s)
    (noBlame : s.runs.find? s.blameable = none) (found : s.runs.find? s.useless = some r) :
    (s.cancel r.id).measure cfg < s.measure cfg := by
  have member := List.mem_of_find?_eq_some found
  have useless : s.useless r = true := by simpa using List.find?_some found
  -- Every other run is still held.
  have others : ∀ x ∈ s.runs, x ≠ r → x ∈ (s.cancel r.id).runs := by
    intro x xMember differs
    simp only [State.cancel, List.mem_filter, bne_iff_ne, ne_eq]
    exact ⟨xMember, fun same => differs (eq_of_nodup_map inv.runIds xMember member same)⟩
  have keepsFailed : ∀ m y, y ∈ s.runs → y ≠ r → s.prefixLength y = some m → failed y.results = true →
      m ∈ (s.cancel r.id).failedPrefixes := by
    intro m y yMember differs yPrefix yFailed
    exact State.mem_failedPrefixes.mpr ⟨y, others y yMember differs, yPrefix, yFailed⟩
  have prefixes : (s.cancel r.id).openPrefixes ≤ s.openPrefixes := by
    apply State.openPrefixes_mono (s := s) (s' := s.cancel r.id) rfl
    intro n positive enough after
    obtain ⟨free, short⟩ := State.openPrefix_iff.mp after
    have free' : ∀ x ∈ (s.cancel r.id).runs, x.tree ≠ s.prefixTree n := State.held_false.mp free
    refine State.openPrefix_iff.mpr ⟨State.held_false.mpr ?_, ?_⟩
    · intro x xMember tree
      by_cases same : x = r
      · subst same
        have isPrefix := State.prefixLength_of_tree positive enough tree
        obtain ⟨_, alive, _, _⟩ := State.prefixLength_some isPrefix
        have doomed := (State.useless_live useless (by simp [alive])).1
        obtain ⟨y, yMember, m, yPrefix, yFailed, shorter⟩ := State.doomed_prefix doomed isPrefix
        have differs : y ≠ x := by
          intro eq
          rw [eq, isPrefix] at yPrefix
          cases yPrefix
          omega
        have := short m (keepsFailed m y yMember differs yPrefix yFailed)
        omega
      · exact free' x (others x xMember same) tree
    · intro m listed
      obtain ⟨y, yMember, yPrefix, yFailed⟩ := State.mem_failedPrefixes.mp listed
      by_cases same : y = r
      · subst same
        obtain ⟨_, alive, _, _⟩ := State.prefixLength_some yPrefix
        have doomed := (State.useless_live useless (by simp [alive])).1
        obtain ⟨z, zMember, k, zPrefix, zFailed, shorter⟩ := State.doomed_prefix doomed yPrefix
        have differs : z ≠ y := by
          intro eq
          rw [eq, yPrefix] at zPrefix
          cases zPrefix
          omega
        have := short k (keepsFailed k z zMember differs zPrefix zFailed)
        omega
      · exact short m (keepsFailed m y yMember same yPrefix yFailed)
  have probes : (s.cancel r.id).openProbes ≤ s.openProbes := by
    apply State.openProbes_mono (s := s) (s' := s.cancel r.id) rfl rfl
    intro c ready free
    have free' : ∀ x ∈ (s.cancel r.id).runs, x.tree ≠ s.main ++ [c.part] := State.held_false.mp free
    refine State.held_false.mpr ?_
    intro x xMember tree
    by_cases same : x = r
    · subst same
      exact State.useless_not_single noBlame xMember useless ready tree
    · exact free' x (others x xMember same) tree
  have push : (s.cancel r.id).pushFree ≤ s.pushFree := by
    unfold State.pushFree
    cases busy : s.pushingRun.isSome
    · simp only [Bool.false_eq_true, if_false]
      split <;> omega
    · obtain ⟨id, x, pushed, looked, alive⟩ := State.pushingRun_isSome.mp busy
      obtain ⟨xMember, xId⟩ := State.findRun_some looked
      have differs : x ≠ r := by
        intro same
        subst same
        exact (State.useless_live useless alive).2 (by rw [pushed, xId])
      have idDiffers : id ≠ r.id := fun same =>
        differs (eq_of_nodup_map inv.runIds xMember member (by rw [xId, same]))
      have looked' : (s.cancel r.id).findRun id = some x := by
        unfold State.findRun at looked ⊢
        simp only [State.cancel, List.find?_filter]
        have same : (fun a : Run => decide ((a.id != r.id) = true ∧ (a.id == id) = true))
            = fun a : Run => a.id == id := by
          funext a
          by_cases h : a.id = id
          · simp [h, idDiffers]
          · simp [h]
        rw [same]
        exact looked
      have : (s.cancel r.id).pushingRun.isSome = true :=
        State.pushingRun_isSome.mpr ⟨id, x, pushed, looked', alive⟩
      simp [this]
  have runs : (s.cancel r.id).runs.length < s.runs.length :=
    length_filter_lt _ _ r member (by simp)
  have owed : (s.cancel r.id).owed cfg ≤ s.owed cfg := sum_map_filter_le _ _ _
  have todo := Nat.mul_le_mul_left (cfg.required.length + 2) (Nat.add_le_add prefixes probes)
  refine measure_lt_of_rest (s := s) (s' := s.cancel r.id) rfl rfl ?_
  omega

/-! ## Events that lower the budget -/

/-- **Every blame that takes effect lowers the measure.** -/
theorem measure_blame_lt (cfg : Config) (s : State) (run : RunId) (took : s.blame cfg run ≠ s) :
    (s.blame cfg run).measure cfg < s.measure cfg := by
  have budget := budget_blame_lt cfg s run took
  rcases s.blame_cases cfg run with refused | ⟨r, p, _, _, _, eq⟩
  · exact absurd refused took
  · rw [eq] at budget ⊢
    exact measure_lt_of_budget budget (List.length_map _) (Nat.le_refl _) (Nat.le_refl _)

/-- **Every landing lowers the measure.** -/
theorem measure_land_lt (cfg : Config) (s : State) (run : RunId) (took : s.land cfg run ≠ s) :
    (s.land cfg run).measure cfg < s.measure cfg := by
  have budget := budget_land_lt cfg s run took
  rcases s.land_cases cfg run with refused | ⟨_, eq⟩
  · exact absurd refused took
  · rw [eq] at budget took ⊢
    rcases s.landNow_cases cfg run with refused | ⟨r, batch, _, _, _, now⟩
    · exact absurd refused took
    · rw [now] at budget ⊢
      exact measure_lt_of_budget budget (List.length_map _) (List.length_filter_le _ _)
        (sum_map_filter_le _ _ _)

/-- **Every fix answer that takes effect lowers the measure.** -/
theorem measure_fixed_lt (cfg : Config) (s : State) (id : ChangeId) (attempt : Nat) (took : s.fixed id attempt ≠ s) :
    (s.fixed id attempt).measure cfg < s.measure cfg := by
  have budget := budget_fixed_lt cfg s id attempt took
  rcases s.fixed_cases id attempt with refused | ⟨_, eq⟩
  · exact absurd refused took
  · rw [eq] at budget ⊢
    exact measure_lt_of_budget budget (List.length_map _) (Nat.le_refl _) (Nat.le_refl _)

/-- Ending a change that has not ended lowers the budget. -/
theorem budget_end_lt (cfg : Config) (s : State) (g : Change → Change)
    (ends : ∀ c ∈ s.changes, g c = c ∨ (c.status.isTerminal = false ∧ (g c).status.isTerminal = true))
    (took : { s with changes := s.changes.map g } ≠ s) :
    State.budget cfg { s with changes := s.changes.map g } < s.budget cfg := by
  unfold State.budget
  apply sum_map_lt
  · intro c member
    rcases ends c member with same | ⟨_, ended⟩
    · rw [same]
      exact Nat.le_refl _
    · simp [Change.budget, ended]
  · have moved : ∃ c ∈ s.changes, g c ≠ c := by
      apply Classical.byContradiction
      intro none
      apply took
      have same : s.changes.map g = s.changes := by
        have : ∀ c ∈ s.changes, g c = c := fun c member =>
          Classical.byContradiction fun differs => none ⟨c, member, differs⟩
        rw [List.map_congr_left this, List.map_id']
      rw [same]
    obtain ⟨c, member, differs⟩ := moved
    rcases ends c member with same | ⟨unfinished, ended⟩
    · exact absurd same differs
    · refine ⟨c, member, ?_⟩
      have positive := Change.budget_pos (cfg := cfg) unfinished
      simpa [Change.budget, ended] using positive

/-- **Every verdict that takes effect lowers the measure.** -/
theorem measure_gaveUp_lt (cfg : Config) (s : State) (id : ChangeId) (attempt : Nat) (detail : String)
    (took : s.gaveUp id attempt detail ≠ s) : (s.gaveUp id attempt detail).measure cfg < s.measure cfg := by
  unfold State.gaveUp at took ⊢
  refine measure_lt_of_budget (budget_end_lt cfg s _ ?_ took) (List.length_map _) (Nat.le_refl _) (Nat.le_refl _)
  intro c _
  split
  · rename_i h
    obtain ⟨run, fixing⟩ := Status.isFixing_iff.mp h.2.1
    exact Or.inr ⟨by simp [fixing, Status.isTerminal], rfl⟩
  · exact Or.inl rfl

/-- **Every withdrawal that takes effect lowers the measure.** -/
theorem measure_withdraw_lt (cfg : Config) (s : State) (id : ChangeId) (took : s.withdraw id ≠ s) :
    (s.withdraw id).measure cfg < s.measure cfg := by
  unfold State.withdraw at took ⊢
  split
  · rename_i pushed
    rw [if_pos pushed] at took
    exact absurd rfl took
  · rename_i free
    rw [if_neg free] at took
    unfold State.withdrawNow at took ⊢
    refine measure_lt_of_budget (budget_end_lt cfg s _ ?_ took) (List.length_map _) (Nat.le_refl _) (Nat.le_refl _)
    intro c _
    split
    · rename_i h
      refine Or.inr ⟨?_, rfl⟩
      rcases h.2 with queued | fixing
      · rw [Status.isQueued_iff.mp queued]
        rfl
      · obtain ⟨run, isFixing⟩ := Status.isFixing_iff.mp fixing
        rw [isFixing]
        rfl
    · exact Or.inl rfl

/-! ## The theorems -/

/-- **Every decision lowers the measure.** Whatever the policy decides next,
the state after it has a strictly smaller measure. -/
theorem measure_plan_lt {cfg : Config} {s : State} {e : Event} (inv : Inv cfg s) (planned : plan cfg s = some e) :
    (step cfg s e).measure cfg < s.measure cfg := by
  have took := plan_takes_effect inv planned
  unfold plan at planned
  split at planned
  · cases planned
    exact measure_push_lt cfg s _ took
  · split at planned
    · cases planned
      exact measure_blame_lt cfg s _ took
    · rename_i noBlame
      split at planned
      · rename_i r found
        cases planned
        exact measure_cancel_lt inv noBlame found
      · split at planned
        · rename_i count next
          cases planned
          exact measure_start_lt next took
        · split at planned
          · cases planned
            exact measure_probe_lt cfg s _ took
          · cases planned

/-- An answer from the world: a check result, a fix, a verdict, the target
seen on the pushed tree, or a withdrawal. -/
def Event.isAnswer : Event → Bool
  | .result _ _ _ _ => true
  | .fixed _ _ => true
  | .gaveUp _ _ _ => true
  | .land _ => true
  | .withdraw _ => true
  | _ => false

/-- **Every answer lowers the measure**, when it takes effect. -/
theorem measure_answer_lt (cfg : Config) (s : State) (e : Event) (answer : e.isAnswer = true)
    (took : step cfg s e ≠ s) : (step cfg s e).measure cfg < s.measure cfg := by
  cases e with
  | result run check verdict duration => exact measure_result_lt cfg s run check verdict duration took
  | fixed id attempt => exact measure_fixed_lt cfg s id attempt took
  | gaveUp id attempt detail => exact measure_gaveUp_lt cfg s id attempt detail took
  | land run => exact measure_land_lt cfg s run took
  | withdraw id => exact measure_withdraw_lt cfg s id took
  | enqueue _ _ => cases answer
  | foreign _ => cases answer
  | push _ => cases answer
  | probe _ => cases answer
  | start _ => cases answer
  | blame _ => cases answer
  | cancel _ => cases answer

/-- The event moves the queue on: it is the policy's decision in this state,
or an answer that takes effect. -/
def Advances (cfg : Config) (s : State) (e : Event) : Prop :=
  plan cfg s = some e ∨ (e.isAnswer = true ∧ step cfg s e ≠ s)

/-- **One measure for the whole queue.** A decision of the policy and an
answer that takes effect each strictly lower `State.measure`. -/
theorem measure_lt {cfg : Config} {s : State} {e : Event} (inv : Inv cfg s) (advances : Advances cfg s e) :
    (step cfg s e).measure cfg < s.measure cfg := by
  rcases advances with planned | ⟨answer, took⟩
  · exact measure_plan_lt inv planned
  · exact measure_answer_lt cfg s e answer took

/-- A trace in which every event moves the queue on. -/
def Advancing (cfg : Config) : State → List Event → Prop
  | _, [] => True
  | s, e :: rest => Advances cfg s e ∧ Advancing cfg (step cfg s e) rest

/-- **The queue cannot go on for ever.** With no new change, no commit from
outside and no run lost, a trace of decisions and answers is no longer than
the measure of the state it starts in. -/
theorem advancing_bounded {cfg : Config} {s : State} {events : List Event} (inv : Inv cfg s)
    (advancing : Advancing cfg s events) : events.length ≤ s.measure cfg := by
  induction events generalizing s with
  | nil => exact Nat.zero_le _
  | cons e rest ih =>
    obtain ⟨advances, later⟩ := advancing
    have lower := measure_lt inv advances
    have := ih (inv.step e) later
    simp only [List.length_cons]
    omega

/-- **The policy settles.** Given as many decisions as the measure, the policy
reaches a state in which it has nothing left to decide. -/
theorem settle_quiet {cfg : Config} {s : State} (inv : Inv cfg s) {fuel : Nat} (enough : s.measure cfg ≤ fuel) :
    plan cfg (settle cfg fuel s) = none := by
  induction fuel generalizing s with
  | zero =>
    cases planned : plan cfg s with
    | none => simpa [settle] using planned
    | some e =>
      have := measure_plan_lt inv planned
      omega
  | succ fuel ih =>
    cases planned : plan cfg s with
    | none => simp [settle, planned]
    | some e =>
      have lower := measure_plan_lt inv planned
      simp only [settle, planned]
      exact ih (inv.step e) (by omega)

end MergeQueue

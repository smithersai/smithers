import SelectShardSpec.Measure
import SelectShardSpec.Shard

/-!
# Machine-checked laws of selection, measurement and sharding

Every theorem here is proved in full from the definitions of the specification and rests on nothing but Lean's own
foundations. The selection and measurement laws are laws of natural numbers; the sharding laws hold for every load
arithmetic, so they hold for the implementation's doubles.
-/

namespace SelectShardSpec

/-! ## Selection: partition -/

theorem chosenFrom_subset (settings : Settings) {target : Text} : ∀ (entries : List Score) (index : Nat),
    target ∈ chosenFrom settings index entries → target ∈ entries.map (·.target)
  | [], _, h => by simp [chosenFrom] at h
  | entry :: rest, index, h => by
    have ih := chosenFrom_subset settings (target := target) rest (index + 1)
    rw [chosenFrom] at h
    split at h
    · cases List.mem_cons.mp h with
      | inl e => exact List.mem_map.mpr ⟨entry, List.mem_cons_self, e.symm⟩
      | inr m => exact List.mem_cons_of_mem _ (ih m)
    · exact List.mem_cons_of_mem _ (ih h)

/-- The ranking reorders the scores and nothing else. -/
theorem ranked_perm (scores : List Score) : (ranked scores).Perm scores :=
  List.mergeSort_perm _ _

/-- Only scored targets are chosen. -/
theorem chosen_subset {scores : List Score} {settings : Settings} {target : Text}
    (h : target ∈ chosen scores settings) : target ∈ scores.map (·.target) :=
  ((ranked_perm scores).map _).mem_iff.mp (chosenFrom_subset settings _ 0 h)

theorem mem_select {scores : List Score} {settings : Settings} {target : Text} :
    target ∈ select scores settings ↔ target ∈ chosen scores settings :=
  mem_sortTexts

theorem mem_skipped {scores : List Score} {settings : Settings} {target : Text} :
    target ∈ skipped scores settings ↔ target ∈ scores.map (·.target) ∧ target ∉ chosen scores settings := by
  unfold skipped
  rw [mem_sortTexts, List.mem_filter, decide_eq_true_eq]

/-- No target is both selected and skipped. -/
theorem select_disjoint_skipped {scores : List Score} {settings : Settings} {target : Text}
    (h : target ∈ select scores settings) : target ∉ skipped scores settings :=
  fun hs => (mem_skipped.mp hs).2 (mem_select.mp h)

/-- Neither list repeats a target. -/
theorem select_nodup (scores : List Score) (settings : Settings) : (select scores settings).Nodup :=
  nodup_sortTexts _

theorem skipped_nodup (scores : List Score) (settings : Settings) : (skipped scores settings).Nodup :=
  nodup_sortTexts _

/--
**Partition.** The selected and the skipped targets, together, are exactly the distinct scored targets: none is
dropped, none is repeated, none is on both sides.
-/
theorem select_partition (scores : List Score) (settings : Settings) :
    (select scores settings ++ skipped scores settings).Perm (sortTexts (scores.map (·.target))) := by
  apply perm_of_nodup
  · refine List.nodup_append.mpr ⟨select_nodup _ _, skipped_nodup _ _, ?_⟩
    intro a ha b hb hab
    exact select_disjoint_skipped ha (hab ▸ hb)
  · exact nodup_sortTexts _
  · intro a
    rw [List.mem_append, mem_select, mem_skipped, mem_sortTexts]
    constructor
    · intro h
      cases h with
      | inl h => exact chosen_subset h
      | inr h => exact h.1
    · intro h
      by_cases hc : a ∈ chosen scores settings
      · exact Or.inl hc
      · exact Or.inr ⟨h, hc⟩

/-- The selected and the skipped targets, counted, are the distinct scored targets. -/
theorem select_length_add_skipped_length (scores : List Score) (settings : Settings) :
    (select scores settings).length + (skipped scores settings).length
      = (sortTexts (scores.map (·.target))).length := by
  rw [← List.length_append]
  exact (select_partition scores settings).length_eq

/-! ## Selection: monotonicity -/

theorem chosenFrom_mono {loose strict : Settings} (hc : loose.scoreCutoff ≤ strict.scoreCutoff)
    (hk : strict.countCutoff ≤ loose.countCutoff) {target : Text} : ∀ (entries : List Score) (index : Nat),
    target ∈ chosenFrom strict index entries → target ∈ chosenFrom loose index entries
  | [], _, h => h
  | entry :: rest, index, h => by
    have ih := chosenFrom_mono hc hk (target := target) rest (index + 1)
    have kept : keep strict index entry = true → keep loose index entry = true := by
      unfold keep
      rw [Bool.or_eq_true, Bool.or_eq_true, decide_eq_true_eq, decide_eq_true_eq, decide_eq_true_eq,
        decide_eq_true_eq]
      omega
    rw [chosenFrom] at h ⊢
    by_cases hs : keep strict index entry = true
    · rw [if_pos hs] at h
      rw [if_pos (kept hs)]
      cases List.mem_cons.mp h with
      | inl e => exact e ▸ List.mem_cons_self
      | inr m => exact List.mem_cons_of_mem _ (ih m)
    · rw [if_neg hs] at h
      by_cases hl : keep loose index entry = true
      · rw [if_pos hl]
        exact List.mem_cons_of_mem _ (ih h)
      · rw [if_neg hl]
        exact ih h

/--
**Monotonicity of the selected set.** Lowering the score cutoff or raising the count cutoff only adds targets:
whatever the stricter settings select, the looser settings select too.
-/
theorem select_mono {loose strict : Settings} (hc : loose.scoreCutoff ≤ strict.scoreCutoff)
    (hk : strict.countCutoff ≤ loose.countCutoff) (scores : List Score) {target : Text}
    (h : target ∈ select scores strict) : target ∈ select scores loose :=
  mem_select.mpr (chosenFrom_mono hc hk _ 0 (mem_select.mp h))

/-- Looser settings skip no target the stricter settings run. -/
theorem skipped_antitone {loose strict : Settings} (hc : loose.scoreCutoff ≤ strict.scoreCutoff)
    (hk : strict.countCutoff ≤ loose.countCutoff) (scores : List Score) {target : Text}
    (h : target ∈ skipped scores loose) : target ∈ skipped scores strict :=
  mem_skipped.mpr ⟨(mem_skipped.mp h).1, fun hs =>
    (mem_skipped.mp h).2 (chosenFrom_mono hc hk _ 0 hs)⟩

/-- Looser settings select at least as many targets. -/
theorem select_length_mono {loose strict : Settings} (hc : loose.scoreCutoff ≤ strict.scoreCutoff)
    (hk : strict.countCutoff ≤ loose.countCutoff) (scores : List Score) :
    (select scores strict).length ≤ (select scores loose).length :=
  length_le_of_nodup_of_subset (select_nodup _ _) (fun _ h => select_mono hc hk scores h)

/-! ## Selection: boundaries -/

theorem chosenFrom_all {settings : Settings} : ∀ (entries : List Score) (index : Nat),
    settings.scoreCutoff = 0 ∨ index + entries.length ≤ settings.countCutoff →
    chosenFrom settings index entries = entries.map (·.target)
  | [], _, _ => rfl
  | entry :: rest, index, h => by
    have kept : keep settings index entry = true := by
      unfold keep
      rw [Bool.or_eq_true, decide_eq_true_eq, decide_eq_true_eq]
      rw [List.length_cons] at h
      omega
    rw [chosenFrom, if_pos kept, chosenFrom_all rest (index + 1) (by rw [List.length_cons] at h; omega)]
    rfl

theorem chosenFrom_none {settings : Settings} (hk : settings.countCutoff = 0) : ∀ (entries : List Score) (index : Nat),
    (∀ entry, entry ∈ entries → entry.score < settings.scoreCutoff) → chosenFrom settings index entries = []
  | [], _, _ => rfl
  | entry :: rest, index, h => by
    have dropped : ¬ keep settings index entry = true := by
      unfold keep
      rw [Bool.or_eq_true, decide_eq_true_eq, decide_eq_true_eq]
      have := h entry List.mem_cons_self
      omega
    rw [chosenFrom, if_neg dropped]
    exact chosenFrom_none hk rest (index + 1) (fun e he => h e (List.mem_cons_of_mem _ he))

/-- With a score cutoff of 0, or a count cutoff of at least the number of scores, nothing is skipped. -/
theorem skipped_eq_nil_of_all {scores : List Score} {settings : Settings}
    (h : settings.scoreCutoff = 0 ∨ scores.length ≤ settings.countCutoff) : skipped scores settings = [] := by
  have all : chosen scores settings = (ranked scores).map (·.target) :=
    chosenFrom_all _ 0 (by rw [(ranked_perm scores).length_eq]; omega)
  have none : (scores.map (·.target)).filter (fun target => decide (target ∉ chosen scores settings)) = [] := by
    rw [List.filter_eq_nil_iff]
    intro target ht
    rw [decide_eq_true_eq, all]
    exact fun hn => hn (((ranked_perm scores).map _).mem_iff.mpr ht)
  unfold skipped
  rw [none]
  exact sortTexts_nil

/-- With a count cutoff of 0 and every score below the cutoff, nothing is selected. -/
theorem select_eq_nil_of_none {scores : List Score} {settings : Settings} (hk : settings.countCutoff = 0)
    (h : ∀ entry, entry ∈ scores → entry.score < settings.scoreCutoff) : select scores settings = [] := by
  have none : chosen scores settings = [] :=
    chosenFrom_none hk _ 0 (fun entry he => h entry ((ranked_perm scores).mem_iff.mp he))
  unfold select
  rw [none]
  exact sortTexts_nil

/-- No scores, nothing selected and nothing skipped. -/
theorem select_nil (settings : Settings) : select [] settings = [] ∧ skipped [] settings = [] := by
  constructor
  · unfold select chosen ranked
    rw [List.mergeSort_nil]
    exact sortTexts_nil
  · unfold skipped
    exact sortTexts_nil

/-! ## Metrics: bounds -/

theorem commits_subset {inner outer : List Row} (h : ∀ row, row ∈ inner → row ∈ outer) :
    ∀ commit, commit ∈ dedup (inner.map (·.commit)) → commit ∈ dedup (outer.map (·.commit)) := by
  intro commit hc
  have ⟨row, hr, e⟩ := List.mem_map.mp (mem_dedup.mp hc)
  exact mem_dedup.mpr (List.mem_map.mpr ⟨row, h row hr, e⟩)

/--
**Bounds.** Whatever the selection: the failures caught are at most the failures, the rows selected and the rows
skipped are each at most the rows and add up to them, and the same holds change by change.
-/
theorem counts_bounds (pick : Row → Bool) (rows : List Row) :
    (countsWith pick rows).caught ≤ (countsWith pick rows).failures
    ∧ (countsWith pick rows).failures ≤ (countsWith pick rows).rows
    ∧ (countsWith pick rows).selected ≤ (countsWith pick rows).rows
    ∧ (countsWith pick rows).skipped ≤ (countsWith pick rows).rows
    ∧ (countsWith pick rows).selected + (countsWith pick rows).skipped = (countsWith pick rows).rows
    ∧ (countsWith pick rows).caught ≤ (countsWith pick rows).selected
    ∧ (countsWith pick rows).caughtChanges ≤ (countsWith pick rows).failedChanges
    ∧ (countsWith pick rows).failedChanges ≤ (countsWith pick rows).failures
    ∧ (countsWith pick rows).caughtChanges ≤ (countsWith pick rows).caught := by
  have h₁ : ((rows.filter (·.failed)).filter pick).length ≤ (rows.filter (·.failed)).length :=
    List.length_filter_le _ _
  have h₂ : (rows.filter (·.failed)).length ≤ rows.length := List.length_filter_le _ _
  have h₃ : (rows.filter pick).length ≤ rows.length := List.length_filter_le _ _
  have h₄ : ((rows.filter (·.failed)).filter pick).length ≤ (rows.filter pick).length :=
    (List.Sublist.filter pick List.filter_sublist).length_le
  have h₅ : (dedup (((rows.filter (·.failed)).filter pick).map (·.commit))).length
      ≤ (dedup ((rows.filter (·.failed)).map (·.commit))).length :=
    length_le_of_nodup_of_subset (nodup_dedup _) (commits_subset (fun _ h => (List.mem_filter.mp h).1))
  have h₆ : (dedup ((rows.filter (·.failed)).map (·.commit))).length ≤ (rows.filter (·.failed)).length := by
    have := length_dedup_le ((rows.filter (·.failed)).map (·.commit))
    rwa [List.length_map] at this
  have h₇ : (dedup (((rows.filter (·.failed)).filter pick).map (·.commit))).length
      ≤ ((rows.filter (·.failed)).filter pick).length := by
    have := length_dedup_le (((rows.filter (·.failed)).filter pick).map (·.commit))
    rwa [List.length_map] at this
  refine ⟨h₁, h₂, h₃, ?_, ?_, h₄, h₅, h₆, h₇⟩
  · exact Nat.sub_le _ _
  · exact Nat.add_sub_cancel' h₃

/-- The bounds for `Selection.metrics`. -/
theorem metrics_bounds (rows : List Row) (selected : Selected) :
    (metrics rows selected).caught ≤ (metrics rows selected).failures
    ∧ (metrics rows selected).failures ≤ (metrics rows selected).rows
    ∧ (metrics rows selected).selected ≤ (metrics rows selected).rows
    ∧ (metrics rows selected).skipped ≤ (metrics rows selected).rows :=
  have h := counts_bounds (isSelected selected) rows
  ⟨h.1, h.2.1, h.2.2.1, h.2.2.2.1⟩

/-- What a selection is measured against does not depend on the selection. -/
theorem counts_fixed (pick other : Row → Bool) (rows : List Row) :
    (countsWith pick rows).rows = (countsWith other rows).rows
    ∧ (countsWith pick rows).failures = (countsWith other rows).failures
    ∧ (countsWith pick rows).failedChanges = (countsWith other rows).failedChanges :=
  ⟨rfl, rfl, rfl⟩

/-- No rows, every count 0. -/
theorem counts_nil (pick : Row → Bool) : countsWith pick [] = ⟨0, 0, 0, 0, 0, 0⟩ := rfl

/-! ## Metrics: monotonicity -/

/-- A selection that holds every row another holds catches at least as much, row by row and change by change. -/
theorem counts_mono {narrow wide : Row → Bool} (rows : List Row)
    (h : ∀ row, narrow row = true → wide row = true) :
    (countsWith narrow rows).caught ≤ (countsWith wide rows).caught
    ∧ (countsWith narrow rows).selected ≤ (countsWith wide rows).selected
    ∧ (countsWith narrow rows).caughtChanges ≤ (countsWith wide rows).caughtChanges := by
  refine ⟨length_filter_le_of_imp _ (fun row _ => h row), length_filter_le_of_imp _ (fun row _ => h row), ?_⟩
  exact length_le_of_nodup_of_subset (nodup_dedup _) (commits_subset (fun row hr =>
    List.mem_filter.mpr ⟨(List.mem_filter.mp hr).1, h row (List.mem_filter.mp hr).2⟩))

theorem targetsFor_map (targets : Text → List Text) (commit : Text) : ∀ (commits : List Text),
    targetsFor (commits.map (fun known => (known, targets known))) commit
      = if commit ∈ commits then targets commit else []
  | [] => rfl
  | known :: rest => by
    have ih := targetsFor_map targets commit rest
    rw [List.map_cons, targetsFor]
    by_cases h : known = commit
    · rw [if_pos h, if_pos (h ▸ List.mem_cons_self), h]
    · rw [if_neg h, ih]
      by_cases hm : commit ∈ rest
      · rw [if_pos hm, if_pos (List.mem_cons_of_mem _ hm)]
      · rw [if_neg hm, if_neg (fun hc => (List.mem_cons.mp hc).elim (fun e => h e.symm) hm)]

/-- A row selected under the stricter settings is selected under the looser settings. -/
theorem isSelected_mono {loose strict : Settings} (hc : loose.scoreCutoff ≤ strict.scoreCutoff)
    (hk : strict.countCutoff ≤ loose.countCutoff) (scores : List Score) (row : Row)
    (h : isSelected (selected scores strict) row = true) : isSelected (selected scores loose) row = true := by
  unfold isSelected selected at h ⊢
  rw [decide_eq_true_eq, targetsFor_map (fun commit =>
    select (scores.filter (fun score => score.commit == commit)) _)] at h ⊢
  by_cases hm : row.commit ∈ dedup (scores.map (·.commit))
  · rw [if_pos hm] at h ⊢
    exact select_mono hc hk _ h
  · rw [if_neg hm] at h
    exact absurd h List.not_mem_nil

/--
**Monotonicity of caught failures.** Lowering the score cutoff or raising the count cutoff never loses a caught
failure, a caught change or a selected row, over any rows and any scores of any number of changes.
-/
theorem measure_mono {loose strict : Settings} (hc : loose.scoreCutoff ≤ strict.scoreCutoff)
    (hk : strict.countCutoff ≤ loose.countCutoff) (rows : List Row) (scores : List Score) :
    (measure rows scores strict).caught ≤ (measure rows scores loose).caught
    ∧ (measure rows scores strict).selected ≤ (measure rows scores loose).selected
    ∧ (measure rows scores strict).caughtChanges ≤ (measure rows scores loose).caughtChanges :=
  counts_mono rows (isSelected_mono hc hk scores)

/-- The bounds for a measured setting. -/
theorem measure_bounds (rows : List Row) (scores : List Score) (settings : Settings) :
    (measure rows scores settings).caught ≤ (measure rows scores settings).failures
    ∧ (measure rows scores settings).failures ≤ (measure rows scores settings).rows
    ∧ (measure rows scores settings).selected ≤ (measure rows scores settings).rows
    ∧ (measure rows scores settings).skipped ≤ (measure rows scores settings).rows :=
  metrics_bounds rows _

/-! ## Measure: split, sample, report -/

/-- The history and the test set, together, are the observations: the split loses and repeats none. -/
theorem split_partition (observations : List Observation) :
    ((split observations).history ++ (split observations).test).Perm observations :=
  filter_append_filter_not_perm _ observations

/-- A sample is rows of the test set, in the test set's order. -/
theorem sample_sublist (test : List Observation) (count : Nat) : (sample test count).Sublist test := by
  unfold sample
  dsimp only
  split
  · exact List.Sublist.refl _
  · exact List.filter_sublist

/-- A weekly point reaches a test recall of 0.9, as exact counts. -/
theorem report_weekly_sound {rows : List Row} {scores : List Score} {point : Point}
    (h : (report rows scores).weekly = some point) : 9 * point.counts.failures ≤ 10 * point.counts.caught := by
  unfold report at h
  dsimp only at h
  split at h
  · have reached : reachesWeekly point.counts = true :=
      List.find?_some (p := fun point : Point => reachesWeekly point.counts) h
    exact of_decide_eq_true reached
  · exact absurd h (by simp)

/-- A calibrated point has a change recall above 0.999, as exact counts. -/
theorem report_calibrated_sound {rows : List Row} {scores : List Score} {point : Point}
    (h : (report rows scores).calibrated = some point) :
    999 * point.counts.failedChanges < 1000 * point.counts.caughtChanges := by
  unfold report at h
  dsimp only at h
  split at h
  · unfold calibrate at h
    have ⟨_, _, inner⟩ := List.exists_of_findSome?_eq_some h
    have ⟨_, _, found⟩ := List.exists_of_findSome?_eq_some inner
    dsimp only at found
    split at found
    · rename_i passed
      have same := Option.some.inj found
      rw [← same]
      exact of_decide_eq_true passed
    · exact absurd found (by simp)
  · exact absurd h (by simp)

/-- With no failure there is no recall to report: no weekly check and no calibration. -/
theorem report_refuses {rows : List Row} {scores : List Score} (h : (report rows scores).measured = false) :
    (report rows scores).weekly = none ∧ (report rows scores).calibrated = none := by
  unfold report at h ⊢
  dsimp only at h ⊢
  rw [h]
  exact ⟨rfl, rfl⟩

/-- The bound of no caught failure is 0, whatever the total. -/
theorem lowerBoundOfCounts_zero (total : Nat) : lowerBoundOfCounts 0 total = 0 := rfl

/-! ## Features: windows -/

/-- A longer window counts at least the commits of a shorter one. -/
theorem changesWithin_mono (files : List Text) (time : Int) (history : List Commit) {short long : Int}
    (h : short ≤ long) : changesWithin files time history short ≤ changesWithin files time history long := by
  apply length_filter_le_of_imp
  intro commit _ hp
  rw [Bool.and_eq_true, decide_eq_true_eq] at hp ⊢
  refine ⟨hp.1, ?_⟩
  have := hp.2
  unfold day at this ⊢
  omega

/-- The three change counts are nested: 3 days within 14 within 56. -/
theorem fileChanges_nested (files : List Text) (time : Int) (history : List Commit) :
    (fileChanges files time history).1 ≤ (fileChanges files time history).2.1
    ∧ (fileChanges files time history).2.1 ≤ (fileChanges files time history).2.2 :=
  ⟨changesWithin_mono files time history (by decide), changesWithin_mono files time history (by decide)⟩

/-- In every window the failed runs are at most the runs, so the exact failure rate is from 0 to 1. -/
theorem rateWithin_bounds (time : Int) (runs : List Observation) (days : Int) :
    (rateWithin time runs days).failed ≤ (rateWithin time runs days).total :=
  List.length_filter_le _ _

/-- A longer window holds at least the runs of a shorter one. -/
theorem rateWithin_total_mono (time : Int) (runs : List Observation) {short long : Int} (h : short ≤ long) :
    (rateWithin time runs short).total ≤ (rateWithin time runs long).total := by
  apply length_filter_le_of_imp
  intro run _ hp
  rw [Bool.and_eq_true, decide_eq_true_eq, decide_eq_true_eq] at hp ⊢
  refine ⟨hp.1, ?_⟩
  have := hp.2
  unfold day at this ⊢
  omega

/-- A window holds only runs before the change. -/
theorem window_before {time : Int} {runs : List Observation} {days : Int} {run : Observation}
    (h : run ∈ window time runs days) : run.time < time := by
  have := (List.mem_filter.mp h).2
  rw [Bool.and_eq_true, decide_eq_true_eq] at this
  exact this.1

/-! ## Sharding: the hash partition -/

/-- **Range.** A label's shard is below the shard count. -/
theorem shardOf_lt (label : Text) {count : Nat} (h : 0 < count) : shardOf label count < count :=
  Nat.mod_lt _ h

/-- A hash is a 32-bit number. -/
theorem fnv1a_lt (label : Text) : fnv1a label < 2 ^ 32 := by
  unfold fnv1a
  have step : ∀ (units : List Nat) (hash : Nat), hash < 2 ^ 32 → units.foldl fnvStep hash < 2 ^ 32 := by
    intro units
    induction units with
    | nil => exact fun _ h => h
    | cons unit rest ih => exact fun hash _ => ih _ (Nat.mod_lt _ (by decide))
  exact step label fnvOffset (by decide)

/--
**Partition completeness of the hash partition.** The shards `0, 1, …, count - 1` of `labelsOf`, one after another,
are a permutation of the labels: every label, with its repeats, is in exactly one shard.
-/
theorem labelsOf_partition (labels : List Text) {count : Nat} (h : 0 < count) :
    ((List.range count).flatMap (fun index => labelsOf labels index count)).Perm labels := by
  have all : labels.filter (fun label => decide (shardOf label count < count)) = labels :=
    List.filter_eq_self.mpr (fun label _ => decide_eq_true (shardOf_lt label h))
  have perm := flatMap_range_filter_perm (fun label => shardOf label count) labels count
  rw [all] at perm
  exact perm

/-- A label is in the shard its hash names and in no other. -/
theorem mem_labelsOf {labels : List Text} {label : Text} {index count : Nat} :
    label ∈ labelsOf labels index count ↔ label ∈ labels ∧ shardOf label count = index := by
  unfold labelsOf
  rw [List.mem_filter, beq_iff_eq]

/-- With one shard, every label is in shard 0. -/
theorem shardOf_one (label : Text) : shardOf label 1 = 0 := Nat.mod_one _

theorem labelsOf_one (labels : List Text) : labelsOf labels 0 1 = labels :=
  List.filter_eq_self.mpr (fun label _ => beq_iff_eq.mpr (shardOf_one label))

/-- No labels, an empty shard. -/
theorem labelsOf_nil (index count : Nat) : labelsOf [] index count = [] := rfl

/-- The empty label hashes to the offset basis. -/
theorem shardOf_empty (count : Nat) : shardOf [] count = fnvOffset % count := rfl

/-! ## Sharding: the weighted assignment -/

section Assign

variable {ω : Type} [Load ω]

theorem lightestFrom_lt (loads : List ω) (bound : Nat) : ∀ (rest : List ω) (index best : Nat),
    best < bound → index + rest.length ≤ bound → lightestFrom loads rest index best < bound
  | [], _, _, hb, _ => hb
  | load :: rest, index, best, hb, hi => by
    rw [List.length_cons] at hi
    rw [lightestFrom]
    apply lightestFrom_lt loads bound rest (index + 1)
    · split <;> omega
    · omega

/-- The lightest shard is one of the shards. -/
theorem lightest_lt {loads : List ω} (h : 0 < loads.length) : lightest loads < loads.length :=
  lightestFrom_lt loads loads.length loads 0 0 h (by omega)

theorem slot_lt {count : Nat} (hc : 0 < count) (weight : Text → ω) {loads : List ω} (hl : loads.length = count)
    (label : Text) : slot count weight loads label < count := by
  unfold slot
  split
  · exact hl ▸ lightest_lt (hl ▸ hc)
  · exact shardOf_lt label hc

/-- Taking a duration changes no shard count. -/
theorem settle_length (loads : List ω) (index : Nat) (duration : ω) :
    (settle loads index duration).length = loads.length := by
  unfold settle
  dsimp only
  split
  · rw [List.length_set, List.length_map]
  · rw [List.length_set]

theorem assignFrom_keys (count : Nat) (weight : Text → ω) : ∀ (labels : List Text) (loads : List ω),
    (assignFrom count weight loads labels).map Prod.fst = labels
  | [], _ => rfl
  | label :: rest, loads => by
    rw [assignFrom, List.map_cons, assignFrom_keys count weight rest]

theorem assignFrom_range {count : Nat} (hc : 0 < count) (weight : Text → ω) : ∀ (labels : List Text)
    (loads : List ω), loads.length = count →
    ∀ entry, entry ∈ assignFrom count weight loads labels → entry.2 < count
  | [], _, _, _, h => absurd h List.not_mem_nil
  | label :: rest, loads, hl, entry, h => by
    rw [assignFrom] at h
    cases List.mem_cons.mp h with
    | inl e => exact e ▸ slot_lt hc weight hl label
    | inr m => exact assignFrom_range hc weight rest _ (by rw [settle_length]; exact hl) entry m

theorem assignFrom_unweighted (count : Nat) (weight : Text → ω) : ∀ (labels : List Text) (loads : List ω),
    ∀ entry, entry ∈ assignFrom count weight loads labels →
    Load.lt Load.zero (weight entry.1) = false → entry.2 = shardOf entry.1 count
  | [], _, _, h, _ => absurd h List.not_mem_nil
  | label :: rest, loads, entry, h, hw => by
    rw [assignFrom] at h
    cases List.mem_cons.mp h with
    | inl e =>
      subst e
      show slot count weight loads label = shardOf label count
      unfold slot
      rw [if_neg (by rw [hw]; exact Bool.false_ne_true)]
    | inr m => exact assignFrom_unweighted count weight rest _ entry m hw

/--
**Range.** Every shard `assign` gives is below the shard count, whatever the durations: zero, tied, huge, infinite
or not a number.
-/
theorem assign_range (labels : List Text) {count : Nat} (hc : 0 < count) (weight : Text → ω) :
    ∀ entry, entry ∈ assign labels count weight → entry.2 < count :=
  assignFrom_range hc weight _ _ List.length_replicate

/-- The labels `assign` places are the distinct labels, reordered. -/
theorem assign_keys_perm (labels : List Text) (count : Nat) (weight : Text → ω) :
    ((assign labels count weight).map Prod.fst).Perm (dedup labels) := by
  unfold assign
  rw [assignFrom_keys]
  exact List.mergeSort_perm _ _

/-- `assign` places no label twice. -/
theorem assign_keys_nodup (labels : List Text) (count : Nat) (weight : Text → ω) :
    ((assign labels count weight).map Prod.fst).Nodup :=
  (assign_keys_perm labels count weight).nodup_iff.mpr (nodup_dedup labels)

/--
**Partition completeness of the assignment.** The shards `0, 1, …, count - 1` of `assign`, one after another, are a
permutation of the distinct labels: none is dropped and none is on two machines.
-/
theorem assign_partition (labels : List Text) {count : Nat} (hc : 0 < count) (weight : Text → ω) :
    ((List.range count).flatMap (shard (assign labels count weight))).Perm (dedup labels) := by
  have all : (assign labels count weight).filter (fun entry => decide (entry.2 < count))
      = assign labels count weight :=
    List.filter_eq_self.mpr (fun entry h => decide_eq_true (assign_range labels hc weight entry h))
  have perm := (flatMap_range_filter_perm (fun entry : Text × Nat => entry.2) (assign labels count weight) count).map
    Prod.fst
  rw [all, List.map_flatMap] at perm
  exact perm.trans (assign_keys_perm labels count weight)

theorem mem_shard {assigned : List (Text × Nat)} {label : Text} {index : Nat} :
    label ∈ shard assigned index ↔ (label, index) ∈ assigned := by
  unfold shard
  rw [List.mem_map]
  constructor
  · intro ⟨entry, he, e⟩
    have hf := List.mem_filter.mp he
    have hi : entry.2 = index := beq_iff_eq.mp hf.2
    have : entry = (label, index) := Prod.ext e hi
    exact this ▸ hf.1
  · intro h
    exact ⟨(label, index), List.mem_filter.mpr ⟨h, beq_iff_eq.mpr rfl⟩, rfl⟩

/-- Every label is in exactly one shard of `assign`, and that shard is below the shard count. -/
theorem assign_exactly_one (labels : List Text) {count : Nat} (hc : 0 < count) (weight : Text → ω) {label : Text}
    (h : label ∈ labels) :
    ∃ index, index < count ∧ label ∈ shard (assign labels count weight) index
      ∧ ∀ other, label ∈ shard (assign labels count weight) other → other = index := by
  have hk : label ∈ (assign labels count weight).map Prod.fst :=
    (assign_keys_perm labels count weight).mem_iff.mpr (mem_dedup.mpr h)
  have ⟨entry, he, e⟩ := List.mem_map.mp hk
  have hp : (label, entry.2) ∈ assign labels count weight := by
    have : entry = (label, entry.2) := Prod.ext e rfl
    exact this ▸ he
  exact ⟨entry.2, assign_range labels hc weight entry he, mem_shard.mpr hp, fun other ho =>
    eq_of_nodup_keys (assign_keys_nodup labels count weight) (mem_shard.mp ho) hp⟩

/-- A label with no measured duration goes where its hash puts it, whatever the other labels weigh. -/
theorem assign_unweighted (labels : List Text) (count : Nat) (weight : Text → ω) :
    ∀ entry, entry ∈ assign labels count weight →
    Load.lt Load.zero (weight entry.1) = false → entry.2 = shardOf entry.1 count :=
  assignFrom_unweighted count weight _ _

/-- **Empty.** No labels, no assignment. -/
theorem assign_nil (count : Nat) (weight : Text → ω) : assign [] count weight = [] := by
  unfold assign order
  rw [show dedup ([] : List Text) = [] from rfl, List.mergeSort_nil]
  rfl

/-- **One shard.** With one shard, every label is on shard 0. -/
theorem assign_count_one (labels : List Text) (weight : Text → ω) :
    ∀ entry, entry ∈ assign labels 1 weight → entry.2 = 0 := fun entry h =>
  Nat.lt_one_iff.mp (assign_range labels (by decide) weight entry h)

theorem lightestFrom_zero (hz : Load.lt (Load.zero : ω) Load.zero = false) (loads : List ω)
    (h0 : loads.getD 0 Load.zero = Load.zero) : ∀ (rest : List ω) (index : Nat),
    (∀ load, load ∈ rest → load = Load.zero) → lightestFrom loads rest index 0 = 0
  | [], _, _ => rfl
  | load :: rest, index, h => by
    rw [lightestFrom, h load List.mem_cons_self, h0, hz, if_neg Bool.false_ne_true]
    exact lightestFrom_zero hz loads h0 rest (index + 1) (fun other ho => h other (List.mem_cons_of_mem _ ho))

/-- With every shard empty, the lightest is shard 0. -/
theorem lightest_replicate (hz : Load.lt (Load.zero : ω) Load.zero = false) (count : Nat) :
    lightest (List.replicate count (Load.zero : ω)) = 0 :=
  lightestFrom_zero hz _ (by cases count <;> rfl) _ 0 (fun _ h => List.eq_of_mem_replicate h)

/--
**Singleton.** One label goes to shard 0 when it has a weight and to its hash's shard when it has none. The
hypothesis is that 0 is not less than 0, which holds for doubles and for natural numbers.
-/
theorem assign_singleton (hz : Load.lt (Load.zero : ω) Load.zero = false) (label : Text) (count : Nat)
    (weight : Text → ω) :
    assign [label] count weight
      = [(label, if Load.lt Load.zero (weight label) then 0 else shardOf label count)] := by
  have one : order weight [label] = [label] := by
    unfold order
    show List.mergeSort [label] _ = [label]
    simp
  unfold assign
  rw [one, assignFrom, assignFrom]
  unfold slot
  rw [lightest_replicate hz]

end Assign

/-- The singleton law for exact loads, with no hypothesis. -/
theorem assign_singleton_exact (label : Text) (count : Nat) (weight : Text → Nat) :
    assign [label] count weight = [(label, if 0 < weight label then 0 else shardOf label count)] := by
  have e : Load.lt (Load.zero : Nat) (weight label) = decide (0 < weight label) := rfl
  rw [assign_singleton (ω := Nat) rfl label count weight]
  simp only [e, decide_eq_true_eq]

end SelectShardSpec

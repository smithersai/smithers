import TimeTravelSpec.Rewind
import TimeTravelSpec.Fork

/-!
# Machine-checked laws of rewind and fork

Every theorem here is proved in full from the definitions of the specification and rests on nothing but Lean's own
foundations. The laws are stated for the committed states `truncate` and `branch`, and then for `rewind` and `fork`,
which commit exactly those states or refuse.
-/

namespace TimeTravelSpec

/-! ## Lists in sequence order -/

/-- In a strictly increasing list, the items at or below a bound are a prefix. -/
theorem filter_le_prefix {α : Type} (f : α → Nat) (n : Nat) : ∀ (l : List α),
    l.Pairwise (fun a b => f a < f b) → l.filter (fun a => decide (f a ≤ n)) <+: l
  | [], _ => by simp
  | a :: t, h => by
    have ⟨ha, ht⟩ := List.pairwise_cons.mp h
    by_cases c : f a ≤ n
    · rw [List.filter_cons_of_pos (by simpa using c)]
      exact (List.prefix_cons_inj a).mpr (filter_le_prefix f n t ht)
    · have empty : t.filter (fun a => decide (f a ≤ n)) = [] :=
        List.filter_eq_nil_iff.mpr (fun b hb => by have := ha b hb; simp; omega)
      rw [List.filter_cons_of_neg (by simpa using c), empty]
      exact List.nil_prefix

theorem mem_journal {s : State} {run : String} {record : Record} :
    record ∈ s.journal run ↔ record ∈ s.records ∧ record.run = run := by
  simp [State.journal]

/-! ## The lineage walk -/

/-- The children a walk has reported as attached. -/
def Walk.ids (walk : Walk) : List String := walk.attached.map (·.child)

theorem visit_ids_mono (root : String) (walk : Walk) (edge : Edge) {id : String} (member : id ∈ walk.ids) :
    id ∈ (visit root walk edge).ids := by
  unfold visit
  split
  · exact member
  · split
    · split
      · exact member
      · simp only [Walk.ids, List.map_append, List.mem_append]
        exact Or.inl member
    · split <;> exact member

theorem foldl_visit_ids_mono (root : String) {id : String} : ∀ (edges : List Edge) (walk : Walk),
    id ∈ walk.ids → id ∈ (edges.foldl (visit root) walk).ids
  | [], _, member => member
  | edge :: rest, walk, member =>
    foldl_visit_ids_mono root rest (visit root walk edge) (visit_ids_mono root walk edge member)

theorem drain_ids_mono (edges : List Edge) (root : String) {id : String} : ∀ (fuel : Nat) (walk : Walk),
    id ∈ walk.ids → id ∈ (drain edges root fuel walk).ids
  | 0, _, member => member
  | fuel + 1, walk, member => by
    unfold drain
    split
    · exact member
    · exact drain_ids_mono edges root fuel _ (foldl_visit_ids_mono root _ _ member)

/-- An attached edge to a run other than the root is reported once it is visited. -/
theorem visit_reports (root : String) (walk : Walk) (edge : Edge) (attached : edge.attached = true)
    (other : edge.child ≠ root) : edge.child ∈ (visit root walk edge).ids := by
  unfold visit
  rw [if_neg other, if_pos attached]
  split
  · rename_i seen
    obtain ⟨found, member, same⟩ := List.any_eq_true.mp seen
    exact List.mem_map.mpr ⟨found, member, by simpa using same⟩
  · simp [Walk.ids]

theorem foldl_visit_reports (root : String) {edge : Edge} (attached : edge.attached = true)
    (other : edge.child ≠ root) : ∀ (edges : List Edge) (walk : Walk),
    edge ∈ edges → edge.child ∈ (edges.foldl (visit root) walk).ids
  | [], _, member => by cases member
  | head :: rest, walk, member => by
    cases List.mem_cons.mp member with
    | inl same =>
      subst same
      exact foldl_visit_ids_mono root rest _ (visit_reports root walk edge attached other)
    | inr later => exact foldl_visit_reports root attached other rest _ later

/-- Edges that are detached or point at the root add nothing to the attached side of a walk. -/
theorem foldl_visit_inert (root : String) : ∀ (edges : List Edge) (walk : Walk),
    (∀ edge ∈ edges, edge.attached = true → edge.child = root) →
      (edges.foldl (visit root) walk).attached = walk.attached ∧ (edges.foldl (visit root) walk).queue = walk.queue
  | [], _, _ => ⟨rfl, rfl⟩
  | head :: rest, walk, inert => by
    have step : (visit root walk head).attached = walk.attached ∧ (visit root walk head).queue = walk.queue := by
      unfold visit
      split
      · exact ⟨rfl, rfl⟩
      · rename_i other
        split
        · rename_i attached
          exact absurd (inert head List.mem_cons_self attached) other
        · split <;> exact ⟨rfl, rfl⟩
    have tail := foldl_visit_inert root rest (visit root walk head)
      (fun edge member => inert edge (List.mem_cons_of_mem _ member))
    exact ⟨tail.1.trans step.1, tail.2.trans step.2⟩

theorem visit_never_root (root : String) (walk : Walk) (edge : Edge) (clean : root ∉ walk.ids) :
    root ∉ (visit root walk edge).ids := by
  unfold visit
  split
  · exact clean
  · rename_i other
    split
    · split
      · exact clean
      · simp only [Walk.ids, List.map_append, List.mem_append, List.map_cons, List.map_nil, List.mem_singleton]
        intro found
        cases found with
        | inl old => exact clean old
        | inr same => exact other same.symm
    · split <;> exact clean

theorem foldl_visit_never_root (root : String) : ∀ (edges : List Edge) (walk : Walk),
    root ∉ walk.ids → root ∉ (edges.foldl (visit root) walk).ids
  | [], _, clean => clean
  | edge :: rest, walk, clean => foldl_visit_never_root root rest _ (visit_never_root root walk edge clean)

theorem drain_never_root (edges : List Edge) (root : String) : ∀ (fuel : Nat) (walk : Walk),
    root ∉ walk.ids → root ∉ (drain edges root fuel walk).ids
  | 0, _, clean => clean
  | fuel + 1, walk, clean => by
    unfold drain
    split
    · exact clean
    · exact drain_never_root edges root fuel _ (foldl_visit_never_root root _ _ clean)

/-- A walk with nothing queued is finished. -/
theorem drain_idle (edges : List Edge) (root : String) (fuel : Nat) (walk : Walk) (idle : walk.queue = []) :
    drain edges root fuel walk = walk := by
  cases fuel with
  | zero => rfl
  | succ fuel => unfold drain; rw [idle]

theorem attachedIds_of_idle (edges : List Edge) (root : String) (seq : Nat)
    (attached : ((crossed edges root seq).foldl (visit root) Walk.empty).attached = [])
    (queue : ((crossed edges root seq).foldl (visit root) Walk.empty).queue = []) : attachedIds edges root seq = [] := by
  unfold attachedIds descendants
  rw [drain_idle _ _ _ _ queue, attached]
  rfl

/-- **A run is never its own descendant**, whatever cycle the edges hold. -/
theorem root_not_attached (edges : List Edge) (root : String) (seq : Nat) : root ∉ attachedIds edges root seq :=
  drain_never_root edges root _ _ (foldl_visit_never_root root _ _ (by simp [Walk.ids, Walk.empty]))

/-- Every attached edge of the root above the frame, to another run, has its child among the attached ids. -/
theorem crossed_attached (edges : List Edge) (root : String) (seq : Nat) {edge : Edge}
    (member : edge ∈ crossed edges root seq) (attached : edge.attached = true) (other : edge.child ≠ root) :
    edge.child ∈ attachedIds edges root seq :=
  drain_ids_mono edges root _ _ (foldl_visit_reports root attached other _ _ member)

/-- Once the attached descendants' edges are removed, the walk from the same frame attaches nothing. -/
theorem attachedIds_settled (edges : List Edge) (root : String) (seq : Nat) :
    attachedIds (edges.filter (fun edge => !(attachedIds edges root seq).contains edge.child)) root seq = [] := by
  have inert := foldl_visit_inert root
    (crossed (edges.filter (fun edge => !(attachedIds edges root seq).contains edge.child)) root seq) Walk.empty
    (fun edge member attached => by
      have parts := List.mem_filter.mp member
      have kept := List.mem_filter.mp parts.1
      apply Decidable.byContradiction
      intro other
      have found := crossed_attached edges root seq (List.mem_filter.mpr ⟨kept.1, parts.2⟩) attached other
      have gone := kept.2
      simp [found] at gone)
  exact attachedIds_of_idle _ root seq inert.1 inert.2

/-! ## Rewind -/

/-- A rewind that commits leaves exactly the truncated state. -/
theorem rewind_state {s : State} {root lineage : String} {seq : Nat} {owner : Owner}
    {childOwners : List (String × Owner)} {rewound : Rewound}
    (h : rewind s root lineage seq owner childOwners = .ok rewound) : rewound.state = truncate s root seq := by
  unfold rewind at h
  split at h
  · cases h
  · split at h
    · cases h
    · split at h
      · cases h
      · cases h; rfl

/-- A rewind commits only for the owner the store has recorded for the run. -/
theorem rewind_owned {s : State} {root lineage : String} {seq : Nat} {owner : Owner}
    {childOwners : List (String × Owner)} {rewound : Rewound}
    (h : rewind s root lineage seq owner childOwners = .ok rewound) : lookup root s.owners = some owner := by
  unfold rewind at h
  split at h
  · cases h
  · split at h
    · cases h
    · rename_i owned
      exact Decidable.of_not_not owned

/-- A truncated run's journal is what the rewind did not remove from it. -/
theorem journal_truncate (s : State) (root : String) (seq : Nat) (run : String) :
    (truncate s root seq).journal run =
      (s.journal run).filter (fun record => !dead root seq (attachedIds s.edges root seq) record) := by
  simp only [State.journal, truncate, List.filter_filter]
  apply List.filter_congr
  intro record _
  exact Bool.and_comm _ _

/--
**Prefix preservation.** After a rewind, every run's journal is a prefix of what it was: the root keeps its records up
to the frame, an attached descendant keeps none, and every other run keeps all of its own.
-/
theorem truncate_journal_prefix (s : State) (root : String) (seq : Nat) (run : String) (sorted : s.Sorted root) :
    (truncate s root seq).journal run <+: s.journal run := by
  rw [journal_truncate]
  by_cases attached : (attachedIds s.edges root seq).contains run = true
  · have empty : (s.journal run).filter
        (fun record => !dead root seq (attachedIds s.edges root seq) record) = [] :=
      List.filter_eq_nil_iff.mpr (fun record member => by
        have same := (mem_journal.mp member).2
        have inIds : run ∈ attachedIds s.edges root seq := by simpa using attached
        simp [dead, same, inIds])
    rw [empty]
    exact List.nil_prefix
  · by_cases isRoot : run = root
    · subst isRoot
      have same : (s.journal run).filter (fun record => !dead run seq (attachedIds s.edges run seq) record) =
          (s.journal run).filter (fun record => decide (record.seq ≤ seq)) := by
        apply List.filter_congr
        intro record member
        have own := (mem_journal.mp member).2
        have free : run ∉ attachedIds s.edges run seq := by simpa using attached
        simp [dead, own, free, ← Nat.not_lt]
      rw [same]
      exact filter_le_prefix (fun record : Record => record.seq) seq _ sorted
    · have all : (s.journal run).filter
          (fun record => !dead root seq (attachedIds s.edges root seq) record) = s.journal run :=
        List.filter_eq_self.mpr (fun record member => by
          have own := (mem_journal.mp member).2
          have free : run ∉ attachedIds s.edges root seq := by simpa using attached
          simp [dead, own, isRoot, free])
      rw [all]
      exact List.prefix_refl _

/-- After a rewind, the root holds no record above the frame. -/
theorem truncate_within_frame (s : State) (root : String) (seq : Nat) {record : Record}
    (member : record ∈ (truncate s root seq).journal root) : record.seq ≤ seq := by
  rw [journal_truncate, List.mem_filter] at member
  have own := (mem_journal.mp member.1).2
  have alive := member.2
  simp [dead, own] at alive
  omega

/-- A second rewind to the same frame finds nothing of the root left to remove. -/
theorem truncate_root_settled (s : State) (root : String) (seq : Nat) :
    ((truncate s root seq).journal root).filter (fun record => decide (record.seq ≤ seq)) =
      (truncate s root seq).journal root :=
  List.filter_eq_self.mpr (fun _ member => by simpa using truncate_within_frame s root seq member)

/-- A rewind keeps every run's journal in sequence order. -/
theorem truncate_sorted (s : State) (root : String) (seq : Nat) (run : String) (sorted : s.Sorted run) :
    (truncate s root seq).Sorted run := by
  unfold State.Sorted
  rw [journal_truncate]
  exact List.Pairwise.sublist List.filter_sublist sorted

theorem generation_truncate (s : State) (root : String) (seq : Nat) (run : String) :
    (truncate s root seq).generation run =
      s.generation run + (root :: attachedIds s.edges root seq).count run := by
  simp [State.generation, truncate, List.count_append]

/-- **Monotonic generations.** A rewind strictly advances the generation of the run it rewinds. -/
theorem truncate_generation_strict (s : State) (root : String) (seq : Nat) :
    s.generation root < (truncate s root seq).generation root := by
  rw [generation_truncate, List.count_cons_self]
  omega

/-- **A rewind advances the rewound run's generation by exactly one.** -/
theorem truncate_generation_next (s : State) (root : String) (seq : Nat) :
    (truncate s root seq).generation root = s.generation root + 1 := by
  rw [generation_truncate, List.count_cons_self, List.count_eq_zero_of_not_mem (root_not_attached s.edges root seq)]

/--
**Rewind is idempotent on history.** A second rewind to the same frame removes no record, archives nothing and
drops no edge; only the generation moves.
-/
theorem truncate_idempotent (s : State) (root : String) (seq : Nat) :
    (truncate (truncate s root seq) root seq).records = (truncate s root seq).records ∧
      (truncate (truncate s root seq) root seq).archived = (truncate s root seq).archived ∧
      (truncate (truncate s root seq) root seq).edges = (truncate s root seq).edges := by
  have settled : attachedIds (truncate s root seq).edges root seq = [] := attachedIds_settled s.edges root seq
  have alive : ∀ record ∈ (truncate s root seq).records, dead root seq [] record = false := by
    intro record member
    have kept := (List.mem_filter.mp member).2
    simp only [dead, Bool.not_eq_true', Bool.or_eq_false_iff] at kept
    simp [dead, kept.1]
  have none : (truncate s root seq).records.filter (dead root seq []) = [] :=
    List.filter_eq_nil_iff.mpr (fun record member => by simp [alive record member])
  have all : (truncate s root seq).records.filter (fun record => !dead root seq [] record) =
      (truncate s root seq).records :=
    List.filter_eq_self.mpr (fun record member => by simp [alive record member])
  refine ⟨?_, ?_, ?_⟩
  · show (truncate s root seq).records.filter _ = _
    rw [settled]
    exact all
  · show (truncate s root seq).archived ++ _ = _
    rw [settled, none]
    simp
  · show (truncate s root seq).edges.filter _ = _
    rw [settled]
    simp

/-- No rewind lowers any run's generation. -/
theorem truncate_generation_mono (s : State) (root : String) (seq : Nat) (run : String) :
    s.generation run ≤ (truncate s root seq).generation run := by
  rw [generation_truncate]
  omega

/-- The archive only grows: what earlier rewinds archived stays, in place. -/
theorem truncate_archive_prefix (s : State) (root : String) (seq : Nat) :
    s.archived <+: (truncate s root seq).archived :=
  List.prefix_append _ _

/-- Every record a rewind removes, it archives: none is lost. -/
theorem truncate_conserves (s : State) (root : String) (seq : Nat) {record : Record} (member : record ∈ s.records) :
    record ∈ (truncate s root seq).records ∨ record ∈ (truncate s root seq).archived.map (·.1) := by
  by_cases gone : dead root seq (attachedIds s.edges root seq) record = true
  · refine Or.inr (List.mem_map.mpr ⟨(record, s.generation record.run), ?_, rfl⟩)
    exact List.mem_append_right _
      (List.mem_map.mpr ⟨record, List.mem_filter.mpr ⟨member, gone⟩, rfl⟩)
  · exact Or.inl (List.mem_filter.mpr ⟨member, by simpa using gone⟩)

/--
**Generations separate archives.** Every archived record carries a generation below its run's current one, and a
rewind keeps it so: the records it archives carry the generation their run is leaving.
-/
theorem truncate_archive_below (s : State) (root : String) (seq : Nat) (below : s.ArchiveBelow) :
    (truncate s root seq).ArchiveBelow := by
  intro entry member
  rw [generation_truncate]
  have split : entry ∈ s.archived ∨ entry ∈
      (s.records.filter (dead root seq (attachedIds s.edges root seq))).map
        (fun record => (record, s.generation record.run)) := List.mem_append.mp member
  cases split with
  | inl old => have := below entry old; omega
  | inr new =>
    obtain ⟨record, doomed, made⟩ := List.mem_map.mp new
    subst made
    have gone := (List.mem_filter.mp doomed).2
    have bumped : 0 < (root :: attachedIds s.edges root seq).count record.run := by
      apply List.count_pos_iff.mpr
      simp only [dead, Bool.or_eq_true, Bool.and_eq_true, decide_eq_true_eq, List.contains_iff_mem] at gone
      cases gone with
      | inl isRoot => rw [isRoot.1]; exact List.mem_cons_self
      | inr attached => exact List.mem_cons_of_mem _ attached
    dsimp only
    omega

/-- A rewind's answer counts exactly the records it archived. -/
theorem rewind_archived_count {s : State} {root lineage : String} {seq : Nat} {owner : Owner}
    {childOwners : List (String × Owner)} {rewound : Rewound}
    (h : rewind s root lineage seq owner childOwners = .ok rewound) :
    rewound.state.archived.length = s.archived.length + rewound.archived := by
  unfold rewind at h
  split at h
  · cases h
  · split at h
    · cases h
    · split at h
      · cases h
      · cases h; simp [truncate]

/-- **Prefix preservation**, for a rewind that commits. -/
theorem rewind_journal_prefix {s : State} {root lineage : String} {seq : Nat} {owner : Owner}
    {childOwners : List (String × Owner)} {rewound : Rewound}
    (h : rewind s root lineage seq owner childOwners = .ok rewound) (run : String) (sorted : s.Sorted root) :
    rewound.state.journal run <+: s.journal run := by
  rw [rewind_state h]
  exact truncate_journal_prefix s root seq run sorted

/-- **Monotonic generations**, for a rewind that commits. -/
theorem rewind_generation_strict {s : State} {root lineage : String} {seq : Nat} {owner : Owner}
    {childOwners : List (String × Owner)} {rewound : Rewound}
    (h : rewind s root lineage seq owner childOwners = .ok rewound) :
    s.generation root < rewound.state.generation root := by
  rw [rewind_state h]
  exact truncate_generation_strict s root seq

theorem rewind_generation_mono {s : State} {root lineage : String} {seq : Nat} {owner : Owner}
    {childOwners : List (String × Owner)} {rewound : Rewound}
    (h : rewind s root lineage seq owner childOwners = .ok rewound) (run : String) :
    s.generation run ≤ rewound.state.generation run := by
  rw [rewind_state h]
  exact truncate_generation_mono s root seq run

theorem rewind_archive_below {s : State} {root lineage : String} {seq : Nat} {owner : Owner}
    {childOwners : List (String × Owner)} {rewound : Rewound}
    (h : rewind s root lineage seq owner childOwners = .ok rewound) (below : s.ArchiveBelow) :
    rewound.state.ArchiveBelow := by
  rw [rewind_state h]
  exact truncate_archive_below s root seq below

/-! ## Fork -/

/-- A fork that commits leaves exactly the branched state, under an id no run held. -/
theorem fork_state {s : State} {parent lineage : String} {seq : Nat} {child : Option String} {next : State}
    {id : String} (h : fork s parent lineage seq child = .ok (next, id)) :
    next = branch s parent lineage seq id ∧ taken s id = false := by
  unfold fork at h
  split at h
  · cases h
  · split at h
    · cases h
    · simp only at h
      split at h
      · cases h
      · rename_i free
        cases h
        exact ⟨rfl, by simpa using free⟩

/-- An id no run holds has an empty journal. -/
theorem journal_of_free {s : State} {id : String} (free : taken s id = false) : s.journal id = [] := by
  simp only [taken, Bool.or_eq_false_iff] at free
  have none := free.1.1.1.1
  exact List.filter_eq_nil_iff.mpr (fun record member => by
    have := List.any_eq_false.mp none record member
    simpa using this)

/-- **Prefix preservation.** A fork only appends: every record the store held stays, in place. -/
theorem branch_records_prefix (s : State) (parent lineage : String) (seq : Nat) (id : String) :
    s.records <+: (branch s parent lineage seq id).records :=
  List.prefix_append _ _

/-- A fork leaves every other run's journal as it was, the parent's included. -/
theorem branch_journal_other (s : State) (parent lineage : String) (seq : Nat) (id run : String) (other : run ≠ id) :
    (branch s parent lineage seq id).journal run = s.journal run := by
  have none : ((framePrefix s parent seq).map (copied id) ++ [marker id lineage seq]).filter
      (fun record => decide (record.run = run)) = [] :=
    List.filter_eq_nil_iff.mpr (fun record member => by
      have own : record.run = id := by
        cases List.mem_append.mp member with
        | inl copy =>
          obtain ⟨_, _, made⟩ := List.mem_map.mp copy
          rw [← made]; rfl
        | inr mark =>
          rw [List.mem_singleton.mp mark]; rfl
      simp only [decide_eq_true_eq]
      rw [own]
      exact fun same => other same.symm)
  simp only [State.journal, branch, List.filter_append] at none ⊢
  rw [none, List.append_nil]

/-- The child's journal is the parent's records up to the frame, renamed, and then the fork-created record. -/
theorem branch_journal_child (s : State) (parent lineage : String) (seq : Nat) (id : String)
    (fresh : s.journal id = []) :
    (branch s parent lineage seq id).journal id =
      ((s.journal parent).filter (fun record => decide (record.seq ≤ seq))).map (copied id) ++
        [marker id lineage seq] := by
  have all : ((framePrefix s parent seq).map (copied id) ++ [marker id lineage seq]).filter
      (fun record => decide (record.run = id)) =
        (framePrefix s parent seq).map (copied id) ++ [marker id lineage seq] :=
    List.filter_eq_self.mpr (fun record member => by
      cases List.mem_append.mp member with
      | inl copy =>
        obtain ⟨_, _, made⟩ := List.mem_map.mp copy
        rw [← made]; simp [copied]
      | inr mark =>
        rw [List.mem_singleton.mp mark]; simp [marker])
  have same : framePrefix s parent seq = (s.journal parent).filter (fun record => decide (record.seq ≤ seq)) := by
    simp [framePrefix, State.journal, List.filter_filter, Bool.and_comm]
  unfold State.journal at fresh
  show (s.records ++ _).filter _ = _
  rw [List.filter_append, fresh, List.nil_append, all, same]

/--
**The child shares the parent's past.** The child's sequence numbers are those of a prefix of the parent's journal,
followed by the fork-created record at `seq + 1`.
-/
theorem branch_child_prefix (s : State) (parent lineage : String) (seq : Nat) (id : String)
    (fresh : s.journal id = []) (sorted : s.Sorted parent) :
    ∃ kept, kept <+: s.journal parent ∧
      ((branch s parent lineage seq id).journal id).map (·.seq) = kept.map (·.seq) ++ [seq + 1] := by
  refine ⟨(s.journal parent).filter (fun record => decide (record.seq ≤ seq)),
    filter_le_prefix (fun record : Record => record.seq) seq _ sorted, ?_⟩
  rw [branch_journal_child s parent lineage seq id fresh]
  simp [copied, marker, Function.comp_def]

/-- The child's journal is in sequence order when the parent's is. -/
theorem branch_child_sorted (s : State) (parent lineage : String) (seq : Nat) (id : String)
    (fresh : s.journal id = []) (sorted : s.Sorted parent) : (branch s parent lineage seq id).Sorted id := by
  unfold State.Sorted
  rw [branch_journal_child s parent lineage seq id fresh]
  apply List.pairwise_append.mpr
  refine ⟨?_, List.pairwise_singleton _ _, ?_⟩
  · apply List.pairwise_map.mpr
    exact List.Pairwise.sublist List.filter_sublist sorted
  · intro a ha b hb
    obtain ⟨record, kept, made⟩ := List.mem_map.mp ha
    have bound := (List.mem_filter.mp kept).2
    rw [List.mem_singleton.mp hb, ← made]
    simp only [decide_eq_true_eq] at bound
    show record.seq < seq + 1
    omega

/-- A fork is not a rewind: it changes no generation and archives nothing. -/
theorem branch_generation (s : State) (parent lineage : String) (seq : Nat) (id run : String) :
    (branch s parent lineage seq id).generation run = s.generation run := rfl

theorem branch_archived (s : State) (parent lineage : String) (seq : Nat) (id : String) :
    (branch s parent lineage seq id).archived = s.archived := rfl

theorem branch_archive_below (s : State) (parent lineage : String) (seq : Nat) (id : String)
    (below : s.ArchiveBelow) : (branch s parent lineage seq id).ArchiveBelow := below

/-- The edge a fork records is detached, at the frame, and the last edge of the store. -/
theorem branch_edges (s : State) (parent lineage : String) (seq : Nat) (id : String) :
    (branch s parent lineage seq id).edges =
      s.edges ++ [{ parent := parent, parentSeq := seq, child := id, kind := EdgeKind.fork, attached := false }] :=
  rfl

/-- **Fork leaves the parent unchanged**, for a fork that commits from a parent that has a journal. -/
theorem fork_parent_unchanged {s : State} {parent lineage : String} {seq : Nat} {child : Option String}
    {next : State} {id : String} (h : fork s parent lineage seq child = .ok (next, id))
    (exists_ : s.journal parent ≠ []) : next.journal parent = s.journal parent := by
  obtain ⟨made, free⟩ := fork_state h
  rw [made]
  apply branch_journal_other
  intro same
  exact exists_ (by rw [same]; exact journal_of_free free)

/-- A fork that commits leaves every run but the child as it was. -/
theorem fork_other_unchanged {s : State} {parent lineage : String} {seq : Nat} {child : Option String}
    {next : State} {id : String} (h : fork s parent lineage seq child = .ok (next, id)) (run : String)
    (other : run ≠ id) : next.journal run = s.journal run := by
  rw [(fork_state h).1]
  exact branch_journal_other s parent lineage seq id run other

/-- **Prefix preservation**, for a fork that commits. -/
theorem fork_child_prefix {s : State} {parent lineage : String} {seq : Nat} {child : Option String}
    {next : State} {id : String} (h : fork s parent lineage seq child = .ok (next, id)) (sorted : s.Sorted parent) :
    ∃ kept, kept <+: s.journal parent ∧ (next.journal id).map (·.seq) = kept.map (·.seq) ++ [seq + 1] := by
  obtain ⟨made, free⟩ := fork_state h
  rw [made]
  exact branch_child_prefix s parent lineage seq id (journal_of_free free) sorted

theorem fork_generation {s : State} {parent lineage : String} {seq : Nat} {child : Option String}
    {next : State} {id : String} (h : fork s parent lineage seq child = .ok (next, id)) (run : String) :
    next.generation run = s.generation run := by
  rw [(fork_state h).1]
  rfl

/-- A fork refuses a live parent. -/
theorem fork_parent_not_live {s : State} {parent lineage : String} {seq : Nat} {child : Option String}
    {next : State} {id : String} (h : fork s parent lineage seq child = .ok (next, id)) :
    (ancestors s.edges parent).any s.live.contains = false := by
  unfold fork at h
  split at h
  · cases h
  · rename_i quiet
    simpa using quiet

/-! ## Reservations and appends -/

/-- Reserving a fork id changes no journal, generation or archive. -/
theorem reserve_inert (s : State) (parent : String) (seq : Nat) :
    (reserve s parent seq).1.records = s.records ∧ (reserve s parent seq).1.bumps = s.bumps ∧
      (reserve s parent seq).1.archived = s.archived :=
  ⟨rfl, rfl, rfl⟩

/-- An append that commits extends the store and no run then holds two records at its sequence. -/
theorem append_prefix {s next : State} {record : Record} (h : append s record = .ok next) :
    next.records = s.records ++ [record] ∧
      ∀ existing ∈ s.records, existing.run = record.run → existing.seq ≠ record.seq := by
  unfold append at h
  split at h
  · cases h
  · rename_i fresh
    cases h
    refine ⟨rfl, fun existing member same clash => fresh ?_⟩
    exact List.any_eq_true.mpr ⟨existing, member, by simp [same, clash]⟩

end TimeTravelSpec

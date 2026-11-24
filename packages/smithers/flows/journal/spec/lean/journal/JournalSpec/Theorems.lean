import JournalSpec.Journal

/-!
# What the specification guarantees

Machine-checked: every proof is complete and nothing is assumed beyond Lean's own foundations.

* **Sequences only rise.** A committed entry's sequence is above every sequence already in the run and at or above
  the process's floor, and the entries stay in strictly ascending order through every call.
* **The byte bound (issue 4558).** An entry over `maxEntryBytes` is refused with the journal untouched, so it costs
  no sequence and leaves no gap, and every entry a call commits is within the bound.
* **The fence (issue 4555).** A checkpoint or compaction by anyone but the holder changes nothing. A fenced write by
  anyone but the holder commits nothing. An owner displaced while the automatic policy captures its state changes no
  entry, no retired identity and no checkpoint.
* **Compaction preserves replay.** Compaction removes only entries below its checkpoint and keeps every identity it
  removes, and replay from that checkpoint or any later one reads what it read before.
* **Replay is a fold.** A checkpoint whose state is the fold of the entries at or below it replays to the state the
  whole history folds to, and a page's last sequence is a cursor that resumes exactly after the page.
-/

namespace JournalSpec

/-- The entries are in strictly ascending sequence order. -/
def Ascending (entries : List Entry) : Prop := entries.Pairwise (fun earlier later => earlier.seq < later.seq)

-- Sequences only rise -------------------------------------------------------------------------------------------------

theorem lt_nextSeq : (entries : List Entry) → (entry : Entry) → entry ∈ entries → entry.seq < nextSeq entries
  | [], _, h => by simp at h
  | head :: rest, entry, h => by
    simp only [nextSeq]
    rcases List.mem_cons.mp h with rfl | inRest
    · omega
    · have := lt_nextSeq rest entry inRest
      omega

theorem checkpoint_entries (seq state owner : Nat) (journal : Journal) :
    (checkpoint seq state owner journal).2.entries = journal.entries ∧
      (checkpoint seq state owner journal).2.retired = journal.retired ∧
        (checkpoint seq state owner journal).2.holder = journal.holder := by
  simp only [checkpoint]
  repeat' split
  all_goals exact ⟨rfl, rfl, rfl⟩

/-- A compaction leaves the entries as they were or keeps exactly those at or above some sequence. -/
theorem compact_entries (upTo : Option Nat) (owner : Nat) (journal : Journal) :
    (compact upTo owner journal).2.entries = journal.entries ∨
      ∃ seq, (compact upTo owner journal).2.entries = journal.entries.filter (seq ≤ ·.seq) := by
  simp only [compact]
  repeat' split
  all_goals first | exact .inl rfl | exact .inr ⟨_, rfl⟩

theorem ascending_compact (upTo : Option Nat) (owner : Nat) (journal : Journal) (ascending : Ascending journal.entries) :
    Ascending (compact upTo owner journal).2.entries := by
  rcases compact_entries upTo owner journal with same | ⟨seq, kept⟩
  · rw [same]
    exact ascending
  · rw [kept]
    exact List.Pairwise.filter _ ascending

/-- The automatic attempt leaves the entries as they were or keeps exactly those at or above some sequence. -/
theorem checkpointAndCompact_entries (owner upTo : Nat) (journal : Journal) :
    (checkpointAndCompact owner upTo journal).entries = journal.entries ∨
      ∃ seq, (checkpointAndCompact owner upTo journal).entries = journal.entries.filter (seq ≤ ·.seq) := by
  have marked := (checkpoint_entries upTo (captured upTo) owner journal).1
  simp only [checkpointAndCompact]
  cases hfirst : checkpoint upTo (captured upTo) owner journal with
  | mk outcome first =>
    rw [hfirst] at marked
    simp only at marked
    cases outcome
    case checkpointed =>
      have kept := compact_entries (some upTo) owner first
      dsimp only
      cases hsecond : compact (some upTo) owner first with
      | mk outcome second =>
        rw [hsecond, marked] at kept
        cases outcome <;> exact kept
    all_goals exact .inl marked

/-- So does the policy as a whole. -/
theorem maintain_entries (config : Config) (owner steal : Option Nat) (journal : Journal) :
    (maintain config owner steal journal).entries = journal.entries ∨
      ∃ seq, (maintain config owner steal journal).entries = journal.entries.filter (seq ≤ ·.seq) := by
  simp only [maintain]
  split
  · exact .inl rfl
  · split
    · exact .inl rfl
    · split
      · exact .inl rfl
      · next owner _ =>
        have same : (displace steal { journal with counted := some (countToward journal) }).entries = journal.entries := by
          cases steal <;> rfl
        have kept := checkpointAndCompact_entries owner (nextSeq journal.entries - 1)
          (displace steal { journal with counted := some (countToward journal) })
        rw [same] at kept
        exact kept

theorem ascending_maintain (config : Config) (owner steal : Option Nat) (journal : Journal)
    (ascending : Ascending journal.entries) : Ascending (maintain config owner steal journal).entries := by
  rcases maintain_entries config owner steal journal with same | ⟨seq, kept⟩
  · rw [same]
    exact ascending
  · rw [kept]
    exact List.Pairwise.filter _ ascending

/-- **A committed sequence is new and above the floor.** -/
theorem emit_accepted_fresh (config : Config) (owner : Option Nat) (source : Nat) (sourceSeq : Option Nat)
    (content : Text) (steal : Option Nat) (journal next : Journal) (seq given : Nat)
    (accepted : emit config owner source sourceSeq content steal journal = (.accepted seq given, next)) :
    journal.floor ≤ seq ∧ ∀ entry ∈ journal.entries, entry.seq < seq := by
  simp only [emit] at accepted
  split at accepted
  · simp at accepted
  · simp only [write] at accepted
    split at accepted
    · simp at accepted
    · split at accepted
      · next row _ =>
        simp only [answerExisting, Prod.mk.injEq] at accepted
        split at accepted <;> simp at accepted
      · simp only [Prod.mk.injEq, Outcome.accepted.injEq] at accepted
        obtain ⟨⟨rfl, _⟩, _⟩ := accepted
        refine ⟨Nat.le_max_left _ _, fun entry inside => ?_⟩
        have := lt_nextSeq journal.entries entry inside
        simp only [reserve]
        omega

theorem ascending_write (config : Config) (owner : Option Nat) (source sourceSeq : Nat) (content : Text)
    (steal : Option Nat) (reserved : Nat) (journal : Journal) (ascending : Ascending journal.entries) :
    Ascending (write config owner source sourceSeq content steal reserved journal).2.entries := by
  simp only [write]
  split
  · exact ascending
  · split
    · exact ascending
    · apply ascending_maintain
      refine List.pairwise_append.mpr ⟨ascending, List.pairwise_singleton _ _, fun entry inside later isNew => ?_⟩
      simp only [List.mem_singleton] at isNew
      subst isNew
      have := lt_nextSeq journal.entries entry inside
      simp only
      omega

/-- **The entries stay in ascending order through every call.** -/
theorem ascending_step (config : Config) (op : Op) (journal : Journal) (ascending : Ascending journal.entries) :
    Ascending (step config op journal).2.entries := by
  cases op with
  | hold _ => exact ascending
  | release => exact ascending
  | restart => exact ascending
  | entries _ _ _ => exact ascending
  | latestCheckpoint => exact ascending
  | checkpoint seq state owner =>
    simp only [step]
    rw [(checkpoint_entries seq state owner journal).1]
    exact ascending
  | compact upTo owner => exact ascending_compact upTo owner journal ascending
  | emit owner source sourceSeq content steal =>
    simp only [step, emit]
    split
    · exact ascending
    · exact ascending_write config owner source _ content steal _ (reserve source _ journal) ascending

/-- A whole script keeps the order, from the empty journal on. -/
theorem ascending_run (config : Config) :
    (ops : List Op) → (journal : Journal) → Ascending journal.entries → Ascending (run config ops journal).2.entries
  | [], _, ascending => ascending
  | op :: rest, journal, ascending => by
    simp only [run]
    exact ascending_run config rest _ (ascending_step config op journal ascending)

-- The byte bound ------------------------------------------------------------------------------------------------------

/-- **Issue 4558.** An entry over the bound is refused and the journal is untouched: no sequence, no gap. -/
theorem emit_oversized (config : Config) (owner : Option Nat) (source : Nat) (sourceSeq : Option Nat) (content : Text)
    (steal : Option Nat) (journal : Journal) (over : config.maxEntryBytes < entryBytes content) :
    emit config owner source sourceSeq content steal journal = (.failed "invalid_event" none, journal) := by
  simp [emit, over]

/-- Every entry is within the bound. -/
def Bounded (config : Config) (entries : List Entry) : Prop :=
  ∀ entry ∈ entries, entryBytes entry.content ≤ config.maxEntryBytes

theorem bounded_compact (config : Config) (upTo : Option Nat) (owner : Nat) (journal : Journal)
    (bounded : Bounded config journal.entries) : Bounded config (compact upTo owner journal).2.entries := by
  rcases compact_entries upTo owner journal with same | ⟨seq, kept⟩
  · rw [same]
    exact bounded
  · rw [kept]
    exact fun entry inside => bounded entry (List.mem_filter.mp inside).1

/-- The automatic policy only removes entries: what it leaves was there before. -/
theorem maintain_entries_subset (config : Config) (owner steal : Option Nat) (journal : Journal) :
    ∀ entry ∈ (maintain config owner steal journal).entries, entry ∈ journal.entries := by
  intro entry inside
  rcases maintain_entries config owner steal journal with same | ⟨seq, kept⟩
  · rw [same] at inside
    exact inside
  · rw [kept] at inside
    exact (List.mem_filter.mp inside).1

/-- **Every committed entry is within the bound,** through every call. -/
theorem bounded_step (config : Config) (op : Op) (journal : Journal) (bounded : Bounded config journal.entries) :
    Bounded config (step config op journal).2.entries := by
  cases op with
  | hold _ => exact bounded
  | release => exact bounded
  | restart => exact bounded
  | entries _ _ _ => exact bounded
  | latestCheckpoint => exact bounded
  | checkpoint seq state owner =>
    simp only [step]
    rw [(checkpoint_entries seq state owner journal).1]
    exact bounded
  | compact upTo owner => exact bounded_compact config upTo owner journal bounded
  | emit owner source sourceSeq content steal =>
    simp only [step, emit]
    split
    · exact bounded
    · next fits =>
      simp only [write]
      split
      · exact bounded
      · split
        · exact bounded
        · intro entry inside
          have before := maintain_entries_subset config owner steal _ entry inside
          simp only [append, reserve, List.mem_append, List.mem_singleton] at before
          rcases before with old | rfl
          · exact bounded entry old
          · simp only
            omega

-- The fence -----------------------------------------------------------------------------------------------------------

/-- A checkpoint by anyone but the holder is refused and changes nothing. -/
theorem checkpoint_fenced (seq state owner : Nat) (journal : Journal) (displaced : journal.holder ≠ some owner) :
    checkpoint seq state owner journal = (.failed "fence_lost" none, journal) := by
  simp [checkpoint, holds, displaced]

/-- A compaction by anyone but the holder is refused and changes nothing. -/
theorem compact_fenced (upTo : Option Nat) (owner : Nat) (journal : Journal) (displaced : journal.holder ≠ some owner) :
    compact upTo owner journal = (.failed "fence_lost" none, journal) := by
  simp [compact, holds, displaced]

/-- A fenced write by anyone but the holder commits nothing: only the process's own floors move. -/
theorem emit_fenced (config : Config) (owner source : Nat) (sourceSeq : Option Nat) (content : Text)
    (steal : Option Nat) (journal : Journal) (displaced : journal.holder ≠ some owner) :
    (emit config (some owner) source sourceSeq content steal journal).2.entries = journal.entries ∧
      (emit config (some owner) source sourceSeq content steal journal).2.retired = journal.retired ∧
        (emit config (some owner) source sourceSeq content steal journal).2.checkpoints = journal.checkpoints ∧
          (emit config (some owner) source sourceSeq content steal journal).2.holder = journal.holder := by
  simp only [emit]
  split
  · exact ⟨rfl, rfl, rfl, rfl⟩
  · simp [write, holds, reserve, displaced]

/--
**Issue 4555.** An owner displaced while the automatic policy captures its state changes no entry, no retired
identity and no checkpoint: its stale state is never pinned and the live owner's history is never deleted.
-/
theorem maintain_displaced (config : Config) (owner thief : Nat) (journal : Journal) (other : thief ≠ owner) :
    (maintain config (some owner) (some thief) journal).entries = journal.entries ∧
      (maintain config (some owner) (some thief) journal).retired = journal.retired ∧
        (maintain config (some owner) (some thief) journal).checkpoints = journal.checkpoints := by
  simp only [maintain]
  split
  · exact ⟨rfl, rfl, rfl⟩
  · split
    · exact ⟨rfl, rfl, rfl⟩
    · have displaced :
          (displace (some thief) { journal with counted := some (countToward journal) }).holder ≠ some owner := by
        simpa [displace] using other
      simp only [checkpointAndCompact, checkpoint_fenced _ _ owner _ displaced]
      exact ⟨rfl, rfl, rfl⟩

-- Compaction preserves replay -----------------------------------------------------------------------------------------

/-- Filtering to the entries after `seq` is unchanged by first dropping entries below `floor ≤ seq`. -/
theorem filter_after_truncated (entries : List Entry) (floor seq : Nat) (above : floor ≤ seq) :
    (entries.filter (floor ≤ ·.seq)).filter (seq < ·.seq) = entries.filter (seq < ·.seq) := by
  rw [List.filter_filter]
  apply List.filter_congr
  intro entry _
  by_cases after : seq < entry.seq
  · have : floor ≤ entry.seq := by omega
    simp [after, this]
  · simp [after]

/--
**Compaction preserves replay.** After a compaction to `checkpointSeq`, replay from that checkpoint or from any later
one folds exactly the entries it folded before.
-/
theorem compact_preserves_replay {σ : Type} (apply : σ → Entry → σ) (state : σ) (upTo : Option Nat) (owner : Nat)
    (journal next : Journal) (checkpointSeq deleted seq : Nat)
    (done : compact upTo owner journal = (.compacted checkpointSeq deleted, next)) (above : checkpointSeq ≤ seq) :
    replayFrom apply state seq next.entries = replayFrom apply state seq journal.entries := by
  simp only [compact] at done
  split at done
  · simp at done
  · split at done
    · simp at done
    · split at done
      · simp only [Prod.mk.injEq, Outcome.compacted.injEq] at done
        obtain ⟨_, rfl⟩ := done
        rfl
      · simp only [Prod.mk.injEq, Outcome.compacted.injEq] at done
        obtain ⟨⟨rfl, _⟩, rfl⟩ := done
        simp only [replayFrom, truncate, filter_after_truncated _ _ _ above]

/-- Compaction loses no identity: each entry is still an entry or is retired, so a retry is still answered. -/
theorem compact_keeps_identities (upTo : Option Nat) (owner : Nat) (journal : Journal) (entry : Entry)
    (inside : entry ∈ journal.entries) :
    entry ∈ (compact upTo owner journal).2.entries ∨ entry ∈ (compact upTo owner journal).2.retired := by
  simp only [compact]
  repeat' split
  all_goals first
    | exact .inl inside
    | (next target _ _ =>
        simp only [truncate, List.mem_filter, List.mem_append, decide_eq_true_eq]
        by_cases below : entry.seq < target.seq
        · exact .inr (.inr ⟨inside, below⟩)
        · exact .inl ⟨inside, by omega⟩)

/-- Compaction removes only entries below its checkpoint: the checkpointed entry and everything after survive. -/
theorem compact_keeps_tail (upTo : Option Nat) (owner : Nat) (journal next : Journal) (checkpointSeq deleted : Nat)
    (done : compact upTo owner journal = (.compacted checkpointSeq deleted, next)) (entry : Entry)
    (inside : entry ∈ journal.entries) (above : checkpointSeq ≤ entry.seq) : entry ∈ next.entries := by
  simp only [compact] at done
  split at done
  · simp at done
  · split at done
    · simp at done
    · split at done
      · simp only [Prod.mk.injEq, Outcome.compacted.injEq] at done
        obtain ⟨_, rfl⟩ := done
        exact inside
      · simp only [Prod.mk.injEq, Outcome.compacted.injEq] at done
        obtain ⟨⟨rfl, _⟩, rfl⟩ := done
        simp only [truncate, List.mem_filter, decide_eq_true_eq]
        exact ⟨inside, above⟩

-- Replay is a fold ----------------------------------------------------------------------------------------------------

/-- Ascending entries split at any sequence into those at or below it, then those after it. -/
theorem split_at_seq (seq : Nat) :
    (entries : List Entry) → Ascending entries →
      entries.filter (·.seq ≤ seq) ++ entries.filter (seq < ·.seq) = entries
  | [], _ => rfl
  | head :: rest, ascending => by
    have ⟨headFirst, restAscending⟩ := List.pairwise_cons.mp ascending
    by_cases below : head.seq ≤ seq
    · have notAfter : ¬ seq < head.seq := by omega
      simp only [List.filter_cons, below, notAfter, decide_true, decide_false, if_true, List.cons_append]
      simp only [Bool.false_eq_true, if_false]
      rw [split_at_seq seq rest restAscending]
    · have after : seq < head.seq := by omega
      have none : rest.filter (·.seq ≤ seq) = [] := by
        apply List.filter_eq_nil_iff.mpr
        intro entry inside
        have := headFirst entry inside
        simp only [decide_eq_true_eq]
        omega
      have all : rest.filter (seq < ·.seq) = rest := by
        apply List.filter_eq_self.mpr
        intro entry inside
        have := headFirst entry inside
        simp only [decide_eq_true_eq]
        omega
      simp [below, after, none, all]

/--
**Replay is deterministic.** A checkpoint whose state is the fold of every entry at or below its sequence replays,
with the entries after it, to the state the whole history folds to.
-/
theorem replay_from_checkpoint {σ : Type} (apply : σ → Entry → σ) (initial : σ) (seq : Nat) (entries : List Entry)
    (ascending : Ascending entries) :
    replayFrom apply (fold apply initial (entries.filter (·.seq ≤ seq))) seq entries = fold apply initial entries := by
  simp only [replayFrom, fold, ← List.foldl_append, split_at_seq seq entries ascending]

/-- Folding page after page is folding the pages joined. -/
theorem fold_pages {σ : Type} (apply : σ → Entry → σ) (state : σ) (page rest : List Entry) :
    fold apply (fold apply state page) rest = fold apply state (page ++ rest) := by
  simp [fold, List.foldl_append]

/-- **A page's last sequence is its cursor.** Reading after it yields exactly what follows the page. -/
theorem cursor_resumes (page rest : List Entry) (last : Entry) (ascending : Ascending (page ++ last :: rest)) :
    (page ++ last :: rest).filter (last.seq < ·.seq) = rest := by
  have ⟨_, tail, across⟩ := List.pairwise_append.mp ascending
  have ⟨lastFirst, _⟩ := List.pairwise_cons.mp tail
  have before : page.filter (last.seq < ·.seq) = [] := by
    apply List.filter_eq_nil_iff.mpr
    intro entry inside
    have := across entry inside last (List.mem_cons_self ..)
    simp only [decide_eq_true_eq]
    omega
  have after : rest.filter (last.seq < ·.seq) = rest := by
    apply List.filter_eq_self.mpr
    intro entry inside
    simpa using lastFirst entry inside
  simp [List.filter_append, before, after]

end JournalSpec

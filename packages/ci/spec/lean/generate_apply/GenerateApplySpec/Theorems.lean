import GenerateApplySpec.Paths
import GenerateApplySpec.Labels
import GenerateApplySpec.Yaml
import GenerateApplySpec.Refusal

/-!
# What the specification guarantees

Every theorem here is checked by Lean's kernel: no proof is left open and no axiom is added.

* A generated path `placeOf` does not refuse for its name holds no NUL, no backslash, no drive, no leading slash and
  no empty, `.` or `..` segment; a path it finds present has every prefix inside the repository's real location,
  and none of them is a link.
* The labels of a batch of steps are distinct even without regard to case, are never `__proto__` or `_repository`,
  and fit Smithers build's limit as `//:label`.
* A double-quoted YAML key holds no line break and no character that needs an escape, and the merge key `<<` is
  always double-quoted.
* `stripAnsi` leaves no escape character, so no control sequence, and is idempotent; a Node warning line changes
  nothing of a refusal that has a substantive line.
-/

namespace GenerateApplySpec

/-! ## Strings -/

theorem not_mem_of_contains_eq_false {α : Type} [BEq α] [LawfulBEq α] {a : α} {l : List α}
    (h : l.contains a = false) : a ∉ l := by
  intro hm
  have : l.contains a = true := by simpa using hm
  rw [this] at h
  cases h

theorem splitOn_ne_nil (sep : Nat) (s : Str) : splitOn sep s ≠ [] := by
  cases s with
  | nil => simp [splitOn]
  | cons c cs =>
    simp only [splitOn]
    split
    · simp
    · split <;> simp

theorem joinWith_cons_cons (sep : Str) (c : Nat) (s : Str) (ss : List Str) :
    joinWith sep ((c :: s) :: ss) = c :: joinWith sep (s :: ss) := by
  cases ss <;> simp [joinWith]

/-- Splitting loses nothing: the parts joined by the separator are the string. -/
theorem joinWith_splitOn (sep : Nat) (s : Str) : joinWith [sep] (splitOn sep s) = s := by
  induction s with
  | nil => simp [splitOn, joinWith]
  | cons c cs ih =>
    simp only [splitOn]
    split
    · next h =>
      cases hs : splitOn sep cs with
      | nil => exact absurd hs (splitOn_ne_nil sep cs)
      | cons a as =>
        rw [hs] at ih
        simp [joinWith, ih, h]
    · cases hs : splitOn sep cs with
      | nil => exact absurd hs (splitOn_ne_nil sep cs)
      | cons a as =>
        rw [hs] at ih
        simp [joinWith_cons_cons, ih]

/-- No part of a split string holds the separator. -/
theorem splitOn_no_sep (sep : Nat) (s : Str) : ∀ part ∈ splitOn sep s, sep ∉ part := by
  induction s with
  | nil => simp [splitOn]
  | cons c cs ih =>
    simp only [splitOn]
    split
    · intro part hp
      rcases List.mem_cons.mp hp with rfl | hp
      · simp
      · exact ih part hp
    · next h =>
      cases hs : splitOn sep cs with
      | nil => exact absurd hs (splitOn_ne_nil sep cs)
      | cons a as =>
        rw [hs] at ih
        show ∀ part ∈ (c :: a) :: as, sep ∉ part
        intro part hp
        rcases List.mem_cons.mp hp with rfl | hp
        · intro hm
          rcases List.mem_cons.mp hm with e | hm
          · exact h e.symm
          · exact ih a (List.mem_cons_self ..) hm
        · exact ih part (List.mem_cons_of_mem _ hp)

/-! ## Generated paths -/

namespace Paths

theorem portable_parts {p : Str} (h : portable p = true) :
    p.contains 92 = false ∧ p.contains 0 = false ∧ drivePrefix p = false ∧
      (splitOn 47 p).any badSegment = false := by
  unfold portable at h
  cases h1 : p.contains 92 <;> cases h2 : p.contains 0 <;> cases h3 : drivePrefix p <;>
    cases h4 : (splitOn 47 p).any badSegment <;> simp_all

theorem badSegment_false {s : Str} (h : badSegment s = false) : s ≠ [] ∧ s ≠ [46] ∧ s ≠ [46, 46] := by
  refine ⟨?_, ?_, ?_⟩ <;> (intro e; subst e; revert h; decide)

/-- A portable name holds no NUL. -/
theorem portable_no_nul {p : Str} (h : portable p = true) : 0 ∉ p :=
  not_mem_of_contains_eq_false (portable_parts h).2.1

/-- A portable name holds no backslash. -/
theorem portable_no_backslash {p : Str} (h : portable p = true) : 92 ∉ p :=
  not_mem_of_contains_eq_false (portable_parts h).1

/-- A portable name starts with no drive, such as `C:`. -/
theorem portable_no_drive {p : Str} (h : portable p = true) (c : Nat) (rest : Str) (hp : p = c :: 58 :: rest) :
    isAlpha c = false := by
  have hd := (portable_parts h).2.2.1
  subst hp
  simpa [drivePrefix] using hd

/-- No segment of a portable name is empty, `.` or `..`. -/
theorem portable_segments {p : Str} (h : portable p = true) :
    ∀ s ∈ splitOn 47 p, s ≠ [] ∧ s ≠ [46] ∧ s ≠ [46, 46] := by
  intro s hs
  apply badSegment_false
  cases hb : badSegment s with
  | false => rfl
  | true =>
    have hany : (splitOn 47 p).any badSegment = true := List.any_eq_true.mpr ⟨s, hs, hb⟩
    rw [(portable_parts h).2.2.2] at hany
    cases hany

/-- A portable name does not start with a slash: it is relative. -/
theorem portable_no_leading_slash {p : Str} (h : portable p = true) : p.head? ≠ some 47 := by
  intro hhead
  cases p with
  | nil => simp at hhead
  | cons c cs =>
    have hc : c = 47 := by simpa using hhead
    subst hc
    exact (portable_segments h [] (by simp [splitOn])).1 rfl

/-- A portable name does not end with a slash, and holds no two slashes in a row: either leaves an empty segment. -/
theorem portable_ne_nil {p : Str} (h : portable p = true) : p ≠ [] := by
  intro e
  subst e
  exact (portable_segments h [] (by simp [splitOn])).1 rfl

/-- Every security property of an accepted name at once. -/
theorem portable_secure {p : Str} (h : portable p = true) :
    0 ∉ p ∧ 92 ∉ p ∧ (∀ c rest, p = c :: 58 :: rest → isAlpha c = false) ∧ p.head? ≠ some 47 ∧
      ∀ s ∈ splitOn 47 p, s ≠ [] ∧ s ≠ [46] ∧ s ≠ [46, 46] :=
  ⟨portable_no_nul h, portable_no_backslash h, portable_no_drive h, portable_no_leading_slash h, portable_segments h⟩

theorem mem_inits_self {α : Type} : ∀ (l : List α), l ≠ [] → l ∈ inits l
  | [], h => absurd rfl h
  | [a], _ => by simp [inits]
  | a :: b :: rest, _ => by
    have ih := mem_inits_self (b :: rest) (by simp)
    rw [inits]
    exact List.mem_cons_of_mem _ (List.mem_map.mpr ⟨b :: rest, ih, rfl⟩)

/-- The walk ends at the path itself: it is one of its own prefixes. -/
theorem path_mem_prefixes (p : Str) : p ∈ prefixesOf p := by
  unfold prefixesOf
  exact List.mem_map.mpr ⟨splitOn 47 p, mem_inits_self _ (splitOn_ne_nil 47 p), joinWith_splitOn 47 p⟩

/-- A location is inside itself. -/
theorem withinRoot_refl (realRoot : Str) : withinRoot realRoot realRoot = true := by
  simp [withinRoot]

theorem withinRoot_iff (realRoot real : Str) :
    withinRoot realRoot real = true ↔ real = realRoot ∨ ∃ rest, real = belowRoot realRoot ++ rest := by
  unfold withinRoot startsWith
  rw [Bool.or_eq_true, beq_iff_eq, List.isPrefixOf_iff_prefix]
  constructor
  · rintro (h | ⟨rest, h⟩)
    · exact Or.inl h
    · exact Or.inr ⟨rest, h.symm⟩
  · rintro (h | ⟨rest, h⟩)
    · exact Or.inl h
    · exact Or.inr (by rw [h]; exact List.prefix_append _ _)

/-- Everything below the repository's real location is inside it. -/
theorem withinRoot_below (realRoot rest : Str) : withinRoot realRoot (belowRoot realRoot ++ rest) = true :=
  (withinRoot_iff _ _).mpr (Or.inr ⟨rest, rfl⟩)

/-- Every absolute path is inside the volume root `/`. -/
theorem withinRoot_volume (rest : Str) : withinRoot [47] (47 :: rest) = true := by
  have h := withinRoot_below [47] rest
  have hb : belowRoot [47] = [47] := by decide
  rw [hb] at h
  exact h

/--
No sibling whose name starts with the repository's: `/repo-evil` is not inside `/repo`. What follows the real
location must start with the separator.
-/
theorem withinRoot_sibling (realRoot rest : Str) (c : Nat) (hc : c ≠ 47) (hroot : endsWith realRoot [47] = false) :
    withinRoot realRoot (realRoot ++ c :: rest) = false := by
  cases h : withinRoot realRoot (realRoot ++ c :: rest) with
  | false => rfl
  | true =>
    exfalso
    rcases (withinRoot_iff _ _).mp h with h | ⟨tail, h⟩
    · have hlen := congrArg List.length h
      rw [List.length_append, List.length_cons] at hlen
      omega
    · simp [belowRoot, hroot] at h
      exact hc h.1

example : withinRoot [47, 114, 101, 112, 111] [47, 114, 101, 112, 111, 45, 101, 118, 105, 108] = false := by decide
example : withinRoot [47, 114, 101, 112, 111] [47, 114, 101, 112, 111, 47, 111, 117, 116] = true := by decide
example : withinRoot [47] [47, 111, 117, 116] = true := by decide

theorem inspect_ne_present (realRoot path pre : Str) (node : Node) :
    inspect realRoot path pre node ≠ some .present := by
  intro h
  unfold inspect at h
  (repeat' split at h) <;> cases h

theorem inspect_none {realRoot path pre : Str} {node : Node} (h : inspect realRoot path pre node = none) :
    ∃ real, node.real = .ok real ∧ withinRoot realRoot real = true := by
  cases hreal : node.real with
  | failed reason =>
    exfalso
    unfold inspect at h
    rw [hreal] at h
    (repeat' split at h) <;> first | contradiction | cases h
  | ok real =>
    refine ⟨real, rfl, ?_⟩
    cases hw : withinRoot realRoot real with
    | true => rfl
    | false =>
      simp [inspect, hreal, hw] at h

/-- A prefix the walk goes past is no link: `readLink` gave no target for it. -/
theorem inspect_none_no_link {realRoot path pre : Str} {node : Node} (h : inspect realRoot path pre node = none) :
    ∀ target, node.link ≠ .ok target := by
  intro target hl
  cases hreal : node.real with
  | failed reason =>
    unfold inspect at h
    rw [hreal] at h
    (repeat' split at h) <;> first | contradiction | cases h
  | ok real =>
    cases hw : withinRoot realRoot real with
    | false => simp [inspect, hreal, hw] at h
    | true => simp [inspect, hreal, hw, hl] at h

theorem walk_present_no_link {disk : Disk} {realRoot path : Str} :
    ∀ (prefixes : List Str), walk disk realRoot path prefixes = .present →
      ∀ pre ∈ prefixes, ∀ target, (disk pre).link ≠ .ok target
  | [], _, _, hm => by cases hm
  | first :: rest, h, pre, hm => by
    rw [walk] at h
    cases hi : inspect realRoot path first (disk first) with
    | some place =>
      rw [hi] at h
      dsimp only at h
      rw [h] at hi
      exact absurd hi (inspect_ne_present _ _ _ _)
    | none =>
      rw [hi] at h
      dsimp only at h
      rcases List.mem_cons.mp hm with rfl | hm
      · exact inspect_none_no_link hi
      · exact walk_present_no_link rest h pre hm

theorem walk_present {disk : Disk} {realRoot path : Str} :
    ∀ (prefixes : List Str), walk disk realRoot path prefixes = .present →
      ∀ pre ∈ prefixes, ∃ real, (disk pre).real = .ok real ∧ withinRoot realRoot real = true
  | [], _, _, hm => by cases hm
  | first :: rest, h, pre, hm => by
    rw [walk] at h
    cases hi : inspect realRoot path first (disk first) with
    | some place =>
      rw [hi] at h
      dsimp only at h
      rw [h] at hi
      exact absurd hi (inspect_ne_present _ _ _ _)
    | none =>
      rw [hi] at h
      dsimp only at h
      rcases List.mem_cons.mp hm with rfl | hm
      · exact inspect_none hi
      · exact walk_present rest h pre hm

/-- A name that is not portable is refused before the file system is asked anything. -/
theorem placeOf_refuses_unportable (disk : Disk) (realRoot path : Str) (h : portable path = false) :
    placeOf disk realRoot path =
      .refused (jsonQuote path ++ lit " is outside the repository (not a repository-relative file path)") := by
  simp [placeOf, h]

/--
Confinement: a path `placeOf` finds present is portable, and it and every directory above it resolve to a real
location inside the repository's.
-/
theorem placeOf_present_confined {disk : Disk} {realRoot path : Str} (h : placeOf disk realRoot path = .present) :
    portable path = true ∧
      ∀ pre ∈ prefixesOf path, ∃ real, (disk pre).real = .ok real ∧ withinRoot realRoot real = true := by
  unfold placeOf at h
  split at h
  · next hp => exact ⟨hp, walk_present _ h⟩
  · cases h

/--
No write through a link: a path `placeOf` finds present is no link, and no directory above it is one. A link inside
the repository, as `.smithers` to `.git/hooks`, is refused like one that leaves it.
-/
theorem placeOf_present_no_link {disk : Disk} {realRoot path : Str} (h : placeOf disk realRoot path = .present) :
    ∀ pre ∈ prefixesOf path, ∀ target, (disk pre).link ≠ .ok target := by
  unfold placeOf at h
  split at h
  · exact walk_present_no_link _ h
  · cases h

/-- Only a portable name is found absent, so only a portable name is ever written. -/
theorem placeOf_absent_portable {disk : Disk} {realRoot path : Str} (h : placeOf disk realRoot path = .absent) :
    portable path = true := by
  unfold placeOf at h
  split at h
  · next hp => exact hp
  · cases h

end Paths

/-! ## Target labels -/

namespace Labels

theorem search_free {taken : List Str} {base identity : Str} :
    ∀ (fuel attempt : Nat) (label found : Str),
      search taken base identity fuel attempt label = some found → blocked taken found = false
  | 0, _, _, _, h => by simp [search] at h
  | fuel + 1, attempt, label, found, h => by
    rw [search] at h
    split at h
    · exact search_free fuel _ _ _ h
    · next hb =>
      cases h
      simpa using hb

theorem blocked_false {taken : List Str} {label : Str} (h : blocked taken label = false) :
    label.length ≤ maximumName ∧ lowerStr label ∉ taken := by
  unfold blocked at h
  rw [Bool.or_eq_false_iff] at h
  exact ⟨Nat.le_of_not_lt (of_decide_eq_false h.1), not_mem_of_contains_eq_false h.2⟩

/-- A label `uniqueLabel` gives is short enough and was not taken, in any case. -/
theorem uniqueLabel_free {taken : List Str} {id : Str} {variant : Variant} {label : Str}
    (h : uniqueLabel taken id variant = some label) : label.length ≤ maximumName ∧ lowerStr label ∉ taken := by
  unfold uniqueLabel at h
  exact blocked_false (search_free _ _ _ _ h)

theorem allocateFrom_sound :
    ∀ (batch : List (Str × Variant)) (taken labels : List Str), allocateFrom taken batch = some labels →
      labels.length = batch.length ∧ (∀ label ∈ labels, label.length ≤ maximumName ∧ lowerStr label ∉ taken) ∧
        (labels.map lowerStr).Pairwise (· ≠ ·)
  | [], taken, labels, h => by
    rw [allocateFrom] at h
    cases h
    simp
  | step :: rest, taken, labels, h => by
    rw [allocateFrom] at h
    cases hu : uniqueLabel taken step.1 step.2 with
    | none => simp [hu] at h
    | some label =>
      rw [hu] at h
      dsimp only at h
      cases ha : allocateFrom (lowerStr label :: taken) rest with
      | none => simp [ha] at h
      | some more =>
        rw [ha] at h
        dsimp only at h
        cases h
        have ih := allocateFrom_sound rest _ more ha
        have hown := uniqueLabel_free hu
        refine ⟨by simp [ih.1], ?_, ?_⟩
        · intro l hl
          rcases List.mem_cons.mp hl with rfl | hl
          · exact hown
          · exact ⟨(ih.2.1 l hl).1, fun hm => (ih.2.1 l hl).2 (List.mem_cons_of_mem _ hm)⟩
        · rw [List.map_cons, List.pairwise_cons]
          refine ⟨?_, ih.2.2⟩
          intro other hother heq
          rcases List.mem_map.mp hother with ⟨l, hl, rfl⟩
          exact (ih.2.1 l hl).2 (by rw [← heq]; simp)

/-- A batch that is given labels is given one for each step. -/
theorem allocate_length {batch : List (Str × Variant)} {labels : List Str} (h : allocate batch = some labels) :
    labels.length = batch.length :=
  (allocateFrom_sound batch reserved labels h).1

/-- No two labels of a batch are equal even without regard to case, which is what Smithers build refuses. -/
theorem allocate_distinct_ignoring_case {batch : List (Str × Variant)} {labels : List Str}
    (h : allocate batch = some labels) : (labels.map lowerStr).Pairwise (· ≠ ·) :=
  (allocateFrom_sound batch reserved labels h).2.2

/-- Injectivity: the labels of a batch are pairwise distinct. -/
theorem allocate_distinct {batch : List (Str × Variant)} {labels : List Str} (h : allocate batch = some labels) :
    labels.Pairwise (· ≠ ·) := by
  have hd := allocate_distinct_ignoring_case h
  rw [List.pairwise_map] at hd
  exact hd.imp fun hne heq => hne (by rw [heq])

/-- No label is `__proto__` or `_repository`, in any case. -/
theorem allocate_never_reserved {batch : List (Str × Variant)} {labels : List Str}
    (h : allocate batch = some labels) :
    ∀ label ∈ labels, lowerStr label ≠ proto ∧ lowerStr label ≠ repositoryLabel := by
  intro label hl
  have hfree := ((allocateFrom_sound batch reserved labels h).2.1 label hl).2
  constructor
  · intro e
    exact hfree (by rw [e]; simp [reserved])
  · intro e
    exact hfree (by rw [e]; simp [reserved])

/-- No label is the literal `__proto__`, which would set a prototype in the generated target map. -/
theorem allocate_never_proto {batch : List (Str × Variant)} {labels : List Str} (h : allocate batch = some labels) :
    ∀ label ∈ labels, label ≠ proto := by
  intro label hl e
  have hlower : lowerStr proto = proto := by decide
  exact (allocate_never_reserved h label hl).1 (by rw [e, hlower])

/-- Every label fits Smithers build's limit as the exact reference `//:label`. -/
theorem allocate_within_limit {batch : List (Str × Variant)} {labels : List Str} (h : allocate batch = some labels) :
    ∀ label ∈ labels, 3 + label.length ≤ maximumLabelLength := by
  intro label hl
  have hlen := ((allocateFrom_sound batch reserved labels h).2.1 label hl).1
  unfold maximumName maximumLabelLength at hlen
  unfold maximumLabelLength
  omega

end Labels

/-! ## YAML keys -/

namespace Yaml

theorem hexDigit_calm : ∀ d : Fin 16, escapes (hexDigit d.val) = false ∧ hexDigit d.val ≠ 10 := by decide

/-- What a double-quoted string holds for a character is nothing that needs an escape, and no line feed. -/
theorem escapeUnit_calm (c : Nat) : ∀ u ∈ escapeUnit c, escapes u = false ∧ u ≠ 10 := by
  unfold escapeUnit
  by_cases h9 : c = 9
  · rw [if_pos h9]; decide
  rw [if_neg h9]
  by_cases h13 : c = 13
  · rw [if_pos h13]; decide
  rw [if_neg h13]
  by_cases h10 : c = 10
  · rw [if_pos h10]; decide
  rw [if_neg h10]
  by_cases h34 : c = 34
  · rw [if_pos h34]; decide
  rw [if_neg h34]
  by_cases h92 : c = 92
  · rw [if_pos h92]; decide
  rw [if_neg h92]
  by_cases he : escapes c = true
  · rw [if_pos he]
    have hfirst : ∀ u ∈ [92, 117], escapes u = false ∧ u ≠ 10 := by decide
    have hhex : ∀ u ∈ hex4 c, escapes u = false ∧ u ≠ 10 := by
      intro u hu
      simp only [hex4, List.mem_cons, List.not_mem_nil, or_false] at hu
      rcases hu with rfl | rfl | rfl | rfl <;> exact hexDigit_calm ⟨_, Nat.mod_lt _ (by decide)⟩
    intro u hu
    rcases List.mem_append.mp hu with hu | hu
    · exact hfirst u hu
    · exact hhex u hu
  · rw [if_neg he]
    intro u hu
    rw [List.mem_singleton] at hu
    subst hu
    exact ⟨by simpa using he, h10⟩

/--
A double-quoted key or value stays on its line and is safe for every YAML linter: it holds no line break, no control
character and no irregular space as it is.
-/
theorem doubleQuoted_calm (value : Str) : ∀ u ∈ doubleQuoted value, escapes u = false ∧ u ≠ 10 := by
  intro u hu
  unfold doubleQuoted at hu
  rcases List.mem_append.mp hu with hu | hu
  · rcases List.mem_append.mp hu with hu | hu
    · rw [List.mem_singleton] at hu
      subst hu
      decide
    · rcases List.mem_flatMap.mp hu with ⟨c, _, hc⟩
      exact escapeUnit_calm c u hc
  · rw [List.mem_singleton] at hu
    subst hu
    decide

/-- The merge key `<<` is never written plain as a key, whatever a parser says of it as a value. -/
theorem mergeKey_quoted (readsBack : Bool) (indent : Nat) :
    keyName mergeKey readsBack indent = doubleQuoted mergeKey := by
  have hon : (mergeKey == [111, 110]) = false := by decide
  have hordinary : ordinaryKey mergeKey = false := by decide
  simp [keyName, hon, hordinary]

/-- A string no YAML parser reads back as itself is never written plain. -/
theorem isPlain_needs_parser (value : Str) : isPlain value false = false := by
  simp [isPlain]

end Yaml

/-! ## Refusals -/

namespace Refusal

theorem stripFrom_no_esc : ∀ (text : Str) (skip : Nat), esc ∉ stripFrom skip text
  | [], skip => by simp [stripFrom]
  | _ :: rest, skip + 1 => by
    rw [stripFrom]
    exact stripFrom_no_esc rest skip
  | c :: rest, 0 => by
    rw [stripFrom]
    split
    · exact stripFrom_no_esc rest _
    · next h =>
      intro hm
      rcases List.mem_cons.mp hm with e | hm
      · exact h e.symm
      · exact stripFrom_no_esc rest 0 hm

theorem stripFrom_clean : ∀ (text : Str), esc ∉ text → stripFrom 0 text = text
  | [], _ => by simp [stripFrom]
  | c :: rest, h => by
    have hc : c ≠ esc := fun e => h (by simp [e])
    rw [stripFrom, if_neg hc, stripFrom_clean rest fun hm => h (List.mem_cons_of_mem _ hm)]

theorem stripFrom_sublist : ∀ (text : Str) (skip : Nat), (stripFrom skip text).Sublist text
  | [], skip => by simp [stripFrom]
  | c :: rest, skip + 1 => by
    rw [stripFrom]
    exact (stripFrom_sublist rest skip).cons c
  | c :: rest, 0 => by
    rw [stripFrom]
    split
    · exact (stripFrom_sublist rest _).cons c
    · exact (stripFrom_sublist rest 0).cons_cons c

/-- `stripAnsi` leaves no escape character. -/
theorem stripAnsi_no_esc (text : Str) : esc ∉ stripAnsi text := stripFrom_no_esc text 0

/-- Text with no escape character is left as it is. -/
theorem stripAnsi_clean {text : Str} (h : esc ∉ text) : stripAnsi text = text := stripFrom_clean text h

/-- `stripAnsi` only removes: what is left is the text with some units gone, in order. -/
theorem stripAnsi_sublist (text : Str) : (stripAnsi text).Sublist text := stripFrom_sublist text 0

/-- `stripAnsi` is idempotent: there is nothing for a second pass to remove. -/
theorem stripAnsi_idempotent (text : Str) : stripAnsi (stripAnsi text) = stripAnsi text :=
  stripAnsi_clean (stripAnsi_no_esc text)

/-- A control sequence: the escape character, `[`, parameter bytes, intermediate bytes and one final byte. -/
def IsControlSequence (sequence : Str) : Prop :=
  ∃ parameters intermediates final,
    sequence = esc :: 91 :: (parameters ++ intermediates ++ [final]) ∧
      (∀ c ∈ parameters, isParameter c = true) ∧ (∀ c ∈ intermediates, isIntermediate c = true) ∧
      isFinal final = true

/-- `stripAnsi` removes every control sequence: none is left anywhere in what it gives. -/
theorem stripAnsi_no_control_sequence (text before sequence after : Str) (hs : IsControlSequence sequence) :
    stripAnsi text ≠ before ++ sequence ++ after := by
  intro h
  rcases hs with ⟨parameters, intermediates, final, rfl, _⟩
  exact stripAnsi_no_esc text (by rw [h]; simp)

theorem useful_useful (lines : List Str) : useful (useful lines) = useful lines := by
  simp [useful, List.filter_filter]

theorem fallback_kept {kept : List Str} (h : kept ≠ []) (lines other : List Str) :
    fallback kept lines = fallback kept other := by
  unfold fallback
  cases hlast : kept.getLast? with
  | none => exact absurd (List.getLast?_eq_none_iff.mp hlast) h
  | some line => rfl

/--
Warning lines are ignored when a substantive line exists: the refusal is the refusal of the other lines alone.
-/
theorem refusal_ignores_warnings (lines : List Str) (h : useful lines ≠ []) :
    refusalOfLines lines = refusalOfLines (useful lines) := by
  unfold refusalOfLines
  rw [useful_useful, fallback_kept h lines (useful lines)]

/-- A Node warning line, wherever it is printed, changes nothing of a refusal that has a substantive line. -/
theorem refusal_warning_line (before after : List Str) (warning : Str) (hw : isNodeWarning (trim warning) = true)
    (h : useful (before ++ after) ≠ []) :
    refusalOfLines (before ++ warning :: after) = refusalOfLines (before ++ after) := by
  have hsame : useful (before ++ warning :: after) = useful (before ++ after) := by
    simp [useful, List.filter_append, hw]
  have h' : useful (before ++ warning :: after) ≠ [] := by rw [hsame]; exact h
  rw [refusal_ignores_warnings _ h', hsame, ← refusal_ignores_warnings _ h]

end Refusal

end GenerateApplySpec

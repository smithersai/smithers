/-!
# Shared vocabulary of the select and shard specification

JavaScript strings, the two orders the implementation sorts by, first-occurrence
deduplication, and the list lemmas the theorems of `Theorems.lean` rest on.
-/

namespace SelectShardSpec

universe u

variable {α : Type u}

/-- A JavaScript string: its UTF-16 code units. Labels, commits and paths are compared and hashed by code unit. -/
abbrev Text := List Nat

/-- The UTF-16 code units of a Lean string: one unit below U+10000, a surrogate pair above. -/
def utf16 (s : String) : Text :=
  s.toList.flatMap fun c =>
    if c.toNat < 0x10000 then [c.toNat]
    else [0xD800 + (c.toNat - 0x10000) / 0x400, 0xDC00 + (c.toNat - 0x10000) % 0x400]

/-- JavaScript's `a < b` on strings: lexicographic by code unit, a proper prefix first. -/
def textLt : Text → Text → Bool
  | [], [] => false
  | [], _ :: _ => true
  | _ :: _, [] => false
  | a :: as, b :: bs => a < b || (a == b && textLt as bs)

/-- The distinct elements in order of first occurrence: the order of `new Set(list)`. -/
def dedup [DecidableEq α] : List α → List α
  | [] => []
  | x :: xs => x :: (dedup xs).filter (fun y => y != x)

/-- Distinct texts in ascending code-unit order: `[...new Set(texts)].sort()`. -/
def sortTexts (texts : List Text) : List Text :=
  (dedup texts).mergeSort (fun a b => !textLt b a)

/-! ## Lemmas -/

theorem mem_dedup [DecidableEq α] {a : α} : ∀ {l : List α}, a ∈ dedup l ↔ a ∈ l
  | [] => by simp [dedup]
  | x :: xs => by
    have ih : a ∈ dedup xs ↔ a ∈ xs := mem_dedup
    by_cases h : a = x <;> simp [dedup, List.mem_filter, ih, h]

theorem nodup_dedup [DecidableEq α] : ∀ (l : List α), (dedup l).Nodup
  | [] => List.nodup_nil
  | x :: xs => by
    simp only [dedup]
    refine List.nodup_cons.mpr ⟨?_, List.Nodup.sublist List.filter_sublist (nodup_dedup xs)⟩
    simp [List.mem_filter]

theorem length_dedup_le [DecidableEq α] : ∀ (l : List α), (dedup l).length ≤ l.length
  | [] => Nat.le_refl _
  | x :: xs => by
    have h₁ := List.length_filter_le (fun y => y != x) (dedup xs)
    have h₂ := length_dedup_le xs
    simp only [dedup, List.length_cons]
    omega

theorem mem_sortTexts {t : Text} {l : List Text} : t ∈ sortTexts l ↔ t ∈ l :=
  ((List.mergeSort_perm _ _).mem_iff).trans mem_dedup

theorem sortTexts_nil : sortTexts [] = [] := by
  unfold sortTexts dedup
  exact List.mergeSort_nil

theorem nodup_sortTexts (l : List Text) : (sortTexts l).Nodup :=
  (List.mergeSort_perm _ _).nodup_iff.mpr (nodup_dedup l)

/-- Two duplicate-free lists with the same members are permutations of each other. -/
theorem perm_of_nodup [DecidableEq α] : ∀ {l₁ l₂ : List α},
    l₁.Nodup → l₂.Nodup → (∀ a, a ∈ l₁ ↔ a ∈ l₂) → l₁.Perm l₂
  | [], l₂, _, _, h => by
    cases l₂ with
    | nil => exact .nil
    | cons b bs => exact absurd ((h b).mpr List.mem_cons_self) List.not_mem_nil
  | a :: as, l₂, h₁, h₂, h => by
    have ha : a ∈ l₂ := (h a).mp List.mem_cons_self
    have h₁' := List.nodup_cons.mp h₁
    have ih : as.Perm (l₂.erase a) := perm_of_nodup h₁'.2 (h₂.erase a) (fun b => by
      constructor
      · intro hb
        have hne : b ≠ a := fun e => h₁'.1 (e ▸ hb)
        exact (List.mem_erase_of_ne hne).mpr ((h b).mp (List.mem_cons_of_mem _ hb))
      · intro hb
        have hne : b ≠ a := fun e => by
          subst e
          exact absurd hb (List.Nodup.not_mem_erase h₂)
        have hm := (h b).mpr ((List.mem_erase_of_ne hne).mp hb)
        cases List.mem_cons.mp hm with
        | inl e => exact absurd e hne
        | inr m => exact m)
    exact (ih.cons a).trans (List.perm_cons_erase ha).symm

/-- A duplicate-free list is no longer than any list that holds all its members. -/
theorem length_le_of_nodup_of_subset [DecidableEq α] : ∀ {l₁ l₂ : List α},
    l₁.Nodup → (∀ a, a ∈ l₁ → a ∈ l₂) → l₁.length ≤ l₂.length
  | [], _, _, _ => Nat.zero_le _
  | a :: as, l₂, h₁, h => by
    have ha : a ∈ l₂ := h a List.mem_cons_self
    have h₁' := List.nodup_cons.mp h₁
    have ih : as.length ≤ (l₂.erase a).length := length_le_of_nodup_of_subset h₁'.2 (fun b hb =>
      (List.mem_erase_of_ne (fun (e : b = a) => h₁'.1 (e ▸ hb))).mpr (h b (List.mem_cons_of_mem _ hb)))
    have hl := List.length_erase_of_mem ha
    have hpos : 0 < l₂.length := List.length_pos_of_mem ha
    simp only [List.length_cons]
    omega

/-- A weaker predicate keeps at least as many elements. -/
theorem length_filter_le_of_imp {p q : α → Bool} : ∀ (l : List α),
    (∀ a, a ∈ l → p a = true → q a = true) → (l.filter p).length ≤ (l.filter q).length
  | [], _ => Nat.le_refl _
  | x :: xs, h => by
    have ih := length_filter_le_of_imp xs (fun a ha => h a (List.mem_cons_of_mem _ ha))
    by_cases hp : p x = true
    · rw [List.filter_cons_of_pos hp, List.filter_cons_of_pos (h x List.mem_cons_self hp)]
      simp only [List.length_cons]
      omega
    · rw [List.filter_cons_of_neg hp]
      by_cases hq : q x = true
      · rw [List.filter_cons_of_pos hq, List.length_cons]
        omega
      · rw [List.filter_cons_of_neg hq]
        exact ih

/-- A predicate and its negation split a list. -/
theorem filter_append_filter_not_perm (p : α → Bool) : ∀ (l : List α),
    (l.filter p ++ l.filter (fun x => !p x)).Perm l
  | [] => .nil
  | x :: xs => by
    have ih := filter_append_filter_not_perm p xs
    by_cases hp : p x = true
    · rw [List.filter_cons_of_pos hp, List.filter_cons_of_neg (p := fun x => !p x) (by simp [hp])]
      exact ih.cons x
    · rw [List.filter_cons_of_neg hp, List.filter_cons_of_pos (p := fun x => !p x) (by simp [hp])]
      exact List.perm_middle.trans (ih.cons x)

theorem filter_lt_succ_perm (f : α → Nat) (n : Nat) : ∀ (l : List α),
    (l.filter (fun x => decide (f x < n)) ++ l.filter (fun x => f x == n)).Perm
      (l.filter (fun x => decide (f x < n + 1)))
  | [] => .nil
  | x :: xs => by
    have ih := filter_lt_succ_perm f n xs
    have lt_pos : ∀ {m : Nat}, f x < m →
        xs.filter (fun x => decide (f x < m)) = xs.filter (fun x => decide (f x < m)) →
        (x :: xs).filter (fun x => decide (f x < m)) = x :: xs.filter (fun x => decide (f x < m)) :=
      fun hm _ => List.filter_cons_of_pos (decide_eq_true hm)
    have lt_neg : ∀ {m : Nat}, ¬ f x < m →
        (x :: xs).filter (fun x => decide (f x < m)) = xs.filter (fun x => decide (f x < m)) :=
      fun hm => List.filter_cons_of_neg (fun h => hm (of_decide_eq_true h))
    have eq_pos : f x = n → (x :: xs).filter (fun x => f x == n) = x :: xs.filter (fun x => f x == n) :=
      fun hm => List.filter_cons_of_pos (beq_iff_eq.mpr hm)
    have eq_neg : ¬ f x = n → (x :: xs).filter (fun x => f x == n) = xs.filter (fun x => f x == n) :=
      fun hm => List.filter_cons_of_neg (fun h => hm (beq_iff_eq.mp h))
    by_cases h₁ : f x < n
    · rw [lt_pos h₁ rfl, eq_neg (by omega), lt_pos (m := n + 1) (by omega) rfl]
      exact ih.cons x
    · by_cases h₂ : f x = n
      · rw [lt_neg h₁, eq_pos h₂, lt_pos (m := n + 1) (by omega) rfl]
        exact List.perm_middle.trans (ih.cons x)
      · rw [lt_neg h₁, eq_neg h₂, lt_neg (m := n + 1) (by omega)]
        exact ih

/--
Grouping a list by a number below `n` loses and repeats nothing: the groups `0, 1, …, n - 1`, one after another,
are a permutation of the elements whose number is below `n`.
-/
theorem flatMap_range_filter_perm (f : α → Nat) (l : List α) : ∀ (n : Nat),
    ((List.range n).flatMap (fun i => l.filter (fun x => f x == i))).Perm (l.filter (fun x => decide (f x < n)))
  | 0 => by simp
  | n + 1 => by
    rw [List.range_succ, List.flatMap_append]
    simp only [List.flatMap_cons, List.flatMap_nil, List.append_nil]
    exact ((flatMap_range_filter_perm f l n).append_right _).trans (filter_lt_succ_perm f n l)

/-- A key that occurs once in a list of pairs has one value. -/
theorem eq_of_nodup_keys {β : Type u} : ∀ {l : List (α × β)} {a : α} {b c : β},
    (l.map Prod.fst).Nodup → (a, b) ∈ l → (a, c) ∈ l → b = c
  | [], _, _, _, _, hb, _ => absurd hb List.not_mem_nil
  | p :: rest, a, b, c, h, hb, hc => by
    have h' := List.nodup_cons.mp (show (p.1 :: rest.map Prod.fst).Nodup from h)
    have key : ∀ {d : β}, (a, d) ∈ rest → a ∈ rest.map Prod.fst := fun hd => List.mem_map.mpr ⟨_, hd, rfl⟩
    cases List.mem_cons.mp hb with
    | inl eb =>
      cases List.mem_cons.mp hc with
      | inl ec => exact (Prod.mk.inj (eb.trans ec.symm)).2
      | inr mc => exact absurd (key mc) (by rw [← eb] at h'; exact h'.1)
    | inr mb =>
      cases List.mem_cons.mp hc with
      | inl ec => exact absurd (key mb) (by rw [← ec] at h'; exact h'.1)
      | inr mc => exact eq_of_nodup_keys h'.2 mb mc

end SelectShardSpec

/-!
# Shared vocabulary of the flow specification

JavaScript strings, strict orders and the lexicographic order built from one, the sorted duplicate-free list a
comparator sort followed by adjacent deduplication produces, decimal numerals, and the list lemmas the theorems of
`Theorems.lean` rest on.
-/

namespace FlowSpec

universe u

variable {α : Type u}

/-- A JavaScript string: its UTF-16 code units. Names, tags and patterns are compared and measured by code unit. -/
abbrev Text := List Nat

/-- The UTF-16 code units of a Lean string: one unit below U+10000, a surrogate pair above. -/
def utf16 (s : String) : Text :=
  s.toList.flatMap fun c =>
    if c.toNat < 0x10000 then [c.toNat]
    else [0xD800 + (c.toNat - 0x10000) / 0x400, 0xDC00 + (c.toNat - 0x10000) % 0x400]

/-! ## Strict orders -/

/-- A strict total order given as a Boolean test, the shape of a JavaScript comparator's `< 0`. -/
structure StrictOrder (lt : α → α → Bool) : Prop where
  irrefl : ∀ a, lt a a = false
  trans : ∀ a b c, lt a b = true → lt b c = true → lt a c = true
  connected : ∀ a b, lt a b = false → lt b a = false → a = b

theorem StrictOrder.asymm {lt : α → α → Bool} (o : StrictOrder lt) {a b : α} (h : lt a b = true) :
    lt b a = false := by
  cases hb : lt b a with
  | false => rfl
  | true =>
    have contra := o.trans a b a h hb
    rw [o.irrefl] at contra
    exact absurd contra (by simp)

/-- Code units in ascending order. -/
def unitLt (a b : Nat) : Bool := decide (a < b)

theorem unitLt_strict : StrictOrder unitLt where
  irrefl := fun a => by simp [unitLt]
  trans := fun a b c h₁ h₂ => by
    simp only [unitLt, decide_eq_true_eq] at *
    omega
  connected := fun a b h₁ h₂ => by
    simp only [unitLt, decide_eq_false_iff_not] at *
    omega

/--
The lexicographic order a comparator loop decides: the first position where the elements differ decides, and a
proper prefix comes first. With code units this is JavaScript's `<` on strings.
-/
def lexLt (lt : α → α → Bool) : List α → List α → Bool
  | [], [] => false
  | [], _ :: _ => true
  | _ :: _, [] => false
  | a :: as, b :: bs => lt a b || (!lt b a && lexLt lt as bs)

theorem lexLt_cons {lt : α → α → Bool} (o : StrictOrder lt) {a b : α} {as bs : List α} :
    lexLt lt (a :: as) (b :: bs) = true ↔ lt a b = true ∨ (a = b ∧ lexLt lt as bs = true) := by
  constructor
  · intro h
    cases hab : lt a b with
    | true => exact Or.inl rfl
    | false =>
      cases hba : lt b a with
      | true => simp [lexLt, hab, hba] at h
      | false =>
        have e := o.connected a b hab hba
        simp [lexLt, hab, hba] at h
        exact Or.inr ⟨e, h⟩
  · intro h
    cases h with
    | inl h => simp [lexLt, h]
    | inr h =>
      obtain ⟨e, h⟩ := h
      subst e
      simp [lexLt, o.irrefl, h]

theorem lexLt_irrefl {lt : α → α → Bool} (o : StrictOrder lt) : ∀ l : List α, lexLt lt l l = false
  | [] => rfl
  | a :: as => by simp [lexLt, o.irrefl, lexLt_irrefl o as]

theorem lexLt_trans {lt : α → α → Bool} (o : StrictOrder lt) : ∀ l₁ l₂ l₃ : List α,
    lexLt lt l₁ l₂ = true → lexLt lt l₂ l₃ = true → lexLt lt l₁ l₃ = true
  | [], [], _, h, _ => by simp [lexLt] at h
  | [], _ :: _, [], _, h => by simp [lexLt] at h
  | [], _ :: _, _ :: _, _, _ => rfl
  | _ :: _, [], _, h, _ => by simp [lexLt] at h
  | _ :: _, _ :: _, [], _, h => by simp [lexLt] at h
  | a :: as, b :: bs, c :: cs, h₁, h₂ => by
    have ih := lexLt_trans o as bs cs
    rw [lexLt_cons o] at h₁ h₂ ⊢
    cases h₁ with
    | inl h₁ =>
      cases h₂ with
      | inl h₂ => exact Or.inl (o.trans a b c h₁ h₂)
      | inr h₂ => exact Or.inl (h₂.1 ▸ h₁)
    | inr h₁ =>
      cases h₂ with
      | inl h₂ => exact Or.inl (h₁.1 ▸ h₂)
      | inr h₂ => exact Or.inr ⟨h₁.1.trans h₂.1, ih h₁.2 h₂.2⟩

theorem lexLt_connected {lt : α → α → Bool} (o : StrictOrder lt) : ∀ l₁ l₂ : List α,
    lexLt lt l₁ l₂ = false → lexLt lt l₂ l₁ = false → l₁ = l₂
  | [], [], _, _ => rfl
  | [], _ :: _, h, _ => by simp [lexLt] at h
  | _ :: _, [], _, h => by simp [lexLt] at h
  | a :: as, b :: bs, h₁, h₂ => by
    have ih := lexLt_connected o as bs
    cases hab : lt a b with
    | true => simp [lexLt, hab] at h₁
    | false =>
      cases hba : lt b a with
      | true => simp [lexLt, hba] at h₂
      | false =>
        simp [lexLt, hab, hba] at h₁ h₂
        rw [o.connected a b hab hba, ih h₁ h₂]

/-- The lexicographic order of a strict order is a strict order. -/
theorem lexLt_strict {lt : α → α → Bool} (o : StrictOrder lt) : StrictOrder (lexLt lt) where
  irrefl := lexLt_irrefl o
  trans := lexLt_trans o
  connected := lexLt_connected o

/-- JavaScript's `a < b` on strings. -/
def textLt : Text → Text → Bool := lexLt unitLt

theorem textLt_strict : StrictOrder textLt := lexLt_strict unitLt_strict

/-! ## Sorted duplicate-free lists -/

/-- Puts `x` in its place in an ascending duplicate-free list; an element already there is kept once. -/
def place (lt : α → α → Bool) (x : α) : List α → List α
  | [] => [x]
  | y :: ys => if lt x y then x :: y :: ys else if lt y x then y :: place lt x ys else y :: ys

/--
The distinct elements in ascending order: what `list.sort(compare)` followed by dropping each element equal to its
predecessor leaves.
-/
def canon (lt : α → α → Bool) (l : List α) : List α := l.foldr (place lt) []

/-- Strictly ascending. -/
abbrev Sorted (lt : α → α → Bool) (l : List α) : Prop := l.Pairwise (fun a b => lt a b = true)

theorem mem_place {lt : α → α → Bool} (o : StrictOrder lt) {a x : α} :
    ∀ {l : List α}, a ∈ place lt x l ↔ a = x ∨ a ∈ l
  | [] => by simp [place]
  | y :: ys => by
    have ih := mem_place o (a := a) (x := x) (l := ys)
    by_cases h₁ : lt x y = true
    · rw [place, if_pos h₁]
      simp
    · by_cases h₂ : lt y x = true
      · rw [place, if_neg h₁, if_pos h₂, List.mem_cons, ih, List.mem_cons]
        constructor
        · intro h
          rcases h with h | h | h
          · exact Or.inr (Or.inl h)
          · exact Or.inl h
          · exact Or.inr (Or.inr h)
        · intro h
          rcases h with h | h | h
          · exact Or.inr (Or.inl h)
          · exact Or.inl h
          · exact Or.inr (Or.inr h)
      · have e : x = y := o.connected x y (by simpa using h₁) (by simpa using h₂)
        subst e
        rw [place, if_neg h₁, if_neg h₂, List.mem_cons]
        constructor
        · intro h
          exact Or.inr h
        · intro h
          rcases h with h | h
          · exact Or.inl h
          · exact h

theorem sorted_place {lt : α → α → Bool} (o : StrictOrder lt) (x : α) :
    ∀ {l : List α}, Sorted lt l → Sorted lt (place lt x l)
  | [], _ => by simp [place, Sorted]
  | y :: ys, h => by
    have hy := (List.pairwise_cons.mp h).1
    have hys := (List.pairwise_cons.mp h).2
    by_cases h₁ : lt x y = true
    · rw [place, if_pos h₁]
      refine List.pairwise_cons.mpr ⟨fun z hz => ?_, h⟩
      rcases List.mem_cons.mp hz with e | hz
      · exact e ▸ h₁
      · exact o.trans _ _ _ h₁ (hy z hz)
    · by_cases h₂ : lt y x = true
      · rw [place, if_neg h₁, if_pos h₂]
        refine List.pairwise_cons.mpr ⟨fun z hz => ?_, sorted_place o x hys⟩
        rcases (mem_place o).mp hz with e | hz
        · exact e ▸ h₂
        · exact hy z hz
      · rw [place, if_neg h₁, if_neg h₂]
        exact h

/-- Two strictly ascending lists with the same members are the same list. -/
theorem sorted_ext {lt : α → α → Bool} (o : StrictOrder lt) : ∀ {l₁ l₂ : List α},
    Sorted lt l₁ → Sorted lt l₂ → (∀ a, a ∈ l₁ ↔ a ∈ l₂) → l₁ = l₂
  | [], l₂, _, _, h => by
    cases l₂ with
    | nil => rfl
    | cons b bs => exact absurd ((h b).mpr List.mem_cons_self) List.not_mem_nil
  | a :: as, [], _, _, h => absurd ((h a).mp List.mem_cons_self) List.not_mem_nil
  | a :: as, b :: bs, h₁, h₂, h => by
    have ha := (List.pairwise_cons.mp h₁).1
    have hb := (List.pairwise_cons.mp h₂).1
    have e : a = b := by
      rcases List.mem_cons.mp ((h a).mp List.mem_cons_self) with e | ma
      · exact e
      · rcases List.mem_cons.mp ((h b).mpr List.mem_cons_self) with e | mb
        · exact e.symm
        · have contra := o.asymm (hb a ma)
          rw [ha b mb] at contra
          exact absurd contra (by simp)
    subst e
    have tails : ∀ z, z ∈ as ↔ z ∈ bs := by
      intro z
      constructor
      · intro hz
        rcases List.mem_cons.mp ((h z).mp (List.mem_cons_of_mem _ hz)) with e | m
        · have contra := ha z hz
          rw [e, o.irrefl] at contra
          exact absurd contra (by simp)
        · exact m
      · intro hz
        rcases List.mem_cons.mp ((h z).mpr (List.mem_cons_of_mem _ hz)) with e | m
        · have contra := hb z hz
          rw [e, o.irrefl] at contra
          exact absurd contra (by simp)
        · exact m
    rw [sorted_ext o (List.pairwise_cons.mp h₁).2 (List.pairwise_cons.mp h₂).2 tails]

theorem mem_canon {lt : α → α → Bool} (o : StrictOrder lt) {a : α} : ∀ {l : List α}, a ∈ canon lt l ↔ a ∈ l
  | [] => by simp [canon]
  | x :: xs => by
    have ih := mem_canon o (a := a) (l := xs)
    show a ∈ place lt x (canon lt xs) ↔ a ∈ x :: xs
    rw [mem_place o, ih, List.mem_cons]

theorem sorted_canon {lt : α → α → Bool} (o : StrictOrder lt) : ∀ l : List α, Sorted lt (canon lt l)
  | [] => List.Pairwise.nil
  | x :: xs => sorted_place o x (sorted_canon o xs)

/-- The canonical form depends on the members alone: not on their order, and not on how often each appears. -/
theorem canon_congr {lt : α → α → Bool} (o : StrictOrder lt) {l₁ l₂ : List α} (h : ∀ a, a ∈ l₁ ↔ a ∈ l₂) :
    canon lt l₁ = canon lt l₂ :=
  sorted_ext o (sorted_canon o l₁) (sorted_canon o l₂) fun a => by rw [mem_canon o, mem_canon o, h a]

/-- A strictly ascending list is its own canonical form. -/
theorem canon_of_sorted {lt : α → α → Bool} (o : StrictOrder lt) {l : List α} (h : Sorted lt l) : canon lt l = l :=
  sorted_ext o (sorted_canon o l) h fun _ => mem_canon o

theorem canon_canon {lt : α → α → Bool} (o : StrictOrder lt) (l : List α) : canon lt (canon lt l) = canon lt l :=
  canon_of_sorted o (sorted_canon o l)

theorem canon_eq_nil {lt : α → α → Bool} (o : StrictOrder lt) {l : List α} (h : canon lt l = []) : l = [] := by
  cases l with
  | nil => rfl
  | cons x xs =>
    have m : x ∈ canon lt (x :: xs) := (mem_canon o).mpr List.mem_cons_self
    rw [h] at m
    exact absurd m List.not_mem_nil

/-! ## Decimal numerals -/

/-- The code units of a natural number written in decimal, as a template literal writes a `length`. -/
def decimal (n : Nat) : Text :=
  if n < 10 then [48 + n] else decimal (n / 10) ++ [48 + n % 10]
termination_by n
decreasing_by omega

theorem decimal_ne_nil (n : Nat) : decimal n ≠ [] := by
  rw [decimal]
  split <;> simp

/-- A numeral is made of the ten digits, so it holds no separator. -/
theorem mem_decimal : ∀ (n : Nat) {d : Nat}, d ∈ decimal n → 48 ≤ d ∧ d ≤ 57 := by
  intro n
  induction n using Nat.strongRecOn with
  | _ n ih =>
    intro d h
    rw [decimal] at h
    split at h
    · simp only [List.mem_singleton] at h
      omega
    · rcases List.mem_append.mp h with h | h
      · exact ih (n / 10) (by omega) h
      · simp only [List.mem_singleton] at h
        omega

/-- Distinct numbers have distinct numerals. -/
theorem decimal_inj : ∀ (n m : Nat), decimal n = decimal m → n = m := by
  intro n
  induction n using Nat.strongRecOn with
  | _ n ih =>
    intro m h
    rw [decimal, decimal.eq_1 m] at h
    by_cases hn : n < 10
    · by_cases hm : m < 10
      · rw [if_pos hn, if_pos hm] at h
        simp only [List.cons.injEq, and_true] at h
        omega
      · rw [if_pos hn, if_neg hm] at h
        have len := congrArg List.length h
        simp only [List.length_cons, List.length_nil, List.length_append] at len
        exact absurd (List.eq_nil_of_length_eq_zero (by omega)) (decimal_ne_nil (m / 10))
    · by_cases hm : m < 10
      · rw [if_neg hn, if_pos hm] at h
        have len := congrArg List.length h
        simp only [List.length_cons, List.length_nil, List.length_append] at len
        exact absurd (List.eq_nil_of_length_eq_zero (by omega)) (decimal_ne_nil (n / 10))
      · rw [if_neg hn, if_neg hm] at h
        have parts := List.append_inj' h rfl
        have high := ih (n / 10) (by omega) (m / 10) parts.1
        have low := parts.2
        simp only [List.cons.injEq, and_true] at low
        omega

/-! ## Framing -/

/-- A separator that neither prefix holds splits a text one way only. -/
theorem append_sep_inj {c : α} : ∀ {l₁ l₂ x y : List α}, c ∉ l₁ → c ∉ l₂ →
    l₁ ++ c :: x = l₂ ++ c :: y → l₁ = l₂ ∧ x = y
  | [], [], _, _, _, _, h => by
    simp only [List.nil_append, List.cons.injEq, true_and] at h
    exact ⟨rfl, h⟩
  | [], b :: bs, _, _, _, h₂, h => by
    simp only [List.nil_append, List.cons_append, List.cons.injEq] at h
    exact absurd (h.1 ▸ List.mem_cons_self) h₂
  | a :: as, [], _, _, h₁, _, h => by
    simp only [List.nil_append, List.cons_append, List.cons.injEq] at h
    exact absurd (h.1 ▸ List.mem_cons_self) h₁
  | a :: as, b :: bs, x, y, h₁, h₂, h => by
    simp only [List.cons_append, List.cons.injEq] at h
    have rest := append_sep_inj (l₁ := as) (l₂ := bs) (x := x) (y := y)
      (fun m => h₁ (List.mem_cons_of_mem _ m)) (fun m => h₂ (List.mem_cons_of_mem _ m)) h.2
    exact ⟨by rw [h.1, rest.1], rest.2⟩

end FlowSpec

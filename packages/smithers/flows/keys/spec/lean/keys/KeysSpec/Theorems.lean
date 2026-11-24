import KeysSpec.Derive

/-!
# What the specification guarantees

Machine-checked: every proof is complete and nothing is assumed beyond Lean's own foundations.

* **Key order.** `lt` is a strict total order on texts. Sorting does not depend on the order two members with
  different keys arrived in, so reordering an object's members changes neither the preimage nor the refusal
  (`preimage_reorder`). Normalizing is idempotent, so a value and its sorted form key alike (`preimage_normalize`).
* **Injectivity.** `write` is injective (`write_injective`): two accepted trees with the same text are the same
  tree. So two inputs share a preimage only when their accepted key material is the same (`preimage_injective`).
* **Refusal.** A value with a preimage holds no non-finite number, redacted value, BigInt, invalid date or
  non-plain object at any depth, and none of its texts or keys has a lone surrogate (`preimage_clean`). A
  non-finite number, a redacted value and an invalid date are refused wherever they stand.
* **The stored key.** `keyOf` of a digest is a key, `digestOf` gives the digest back, and a key is 69 code units.
-/

namespace KeysSpec

-- Key order -----------------------------------------------------------------------------------------------------------

theorem lt_irrefl : (a : Text) → lt a a = false
  | [] => rfl
  | unit :: rest => by simp [lt, lt_irrefl rest]

theorem lt_asymm : (a b : Text) → lt a b = true → lt b a = false
  | [], [], h => by simp [lt] at h
  | [], _ :: _, _ => rfl
  | _ :: _, [], h => by simp [lt] at h
  | x :: xs, y :: ys, h => by
    simp only [lt] at h ⊢
    by_cases hxy : x < y
    · have : ¬ y < x := by omega
      simp [this, hxy]
    · by_cases hyx : y < x
      · simp [hxy, hyx] at h
      · simp only [hxy, hyx, if_false] at h ⊢
        exact lt_asymm xs ys h

/-- Two texts neither of which is below the other are the same text. -/
theorem eq_of_not_lt : (a b : Text) → lt a b = false → lt b a = false → a = b
  | [], [], _, _ => rfl
  | [], _ :: _, h, _ => by simp [lt] at h
  | _ :: _, [], _, h => by simp [lt] at h
  | x :: xs, y :: ys, h, h' => by
    simp only [lt] at h h'
    by_cases hxy : x < y
    · simp [hxy] at h
    · by_cases hyx : y < x
      · simp [hyx] at h'
      · simp only [hxy, hyx, if_false] at h h'
        have : x = y := by omega
        rw [this, eq_of_not_lt xs ys h h']

theorem lt_trans : (a b c : Text) → lt a b = true → lt b c = true → lt a c = true
  | [], [], _, h, _ => by simp [lt] at h
  | [], _ :: _, [], _, h => by simp [lt] at h
  | [], _ :: _, _ :: _, _, _ => rfl
  | _ :: _, [], _, h, _ => by simp [lt] at h
  | _ :: _, _ :: _, [], _, h => by simp [lt] at h
  | x :: xs, y :: ys, z :: zs, h, h' => by
    simp only [lt] at h h' ⊢
    by_cases hxy : x < y
    · by_cases hyz : y < z
      · have : x < z := by omega
        simp [this]
      · by_cases hzy : z < y
        · simp [hyz, hzy] at h'
        · have : x < z := by omega
          simp [this]
    · by_cases hyx : y < x
      · simp [hxy, hyx] at h
      · simp only [hxy, hyx, if_false] at h
        have hxy' : x = y := by omega
        subst hxy'
        by_cases hxz : x < z
        · simp [hxz]
        · by_cases hzx : z < x
          · simp [hxz, hzx] at h'
          · simp only [hxz, hzx, if_false] at h' ⊢
            exact lt_trans xs ys zs h h'

-- Sorting -------------------------------------------------------------------------------------------------------------

/-- `key` is at or below the first key of the members, if there is one. -/
def HeadLe (key : Text) : Members → Prop
  | .nil => True
  | .cons key' _ _ => le key key' = true

/-- Each key is at or below the next. -/
def Sorted : Members → Prop
  | .nil => True
  | .cons key _ rest => HeadLe key rest ∧ Sorted rest

theorem headLe_insert (bound key : Text) (value : Value) :
    (members : Members) → HeadLe bound members → le bound key = true → HeadLe bound (insertMember key value members)
  | .nil, _, h => h
  | .cons key' _ _, h, h' => by
    simp only [insertMember]
    split <;> simp_all [HeadLe]

theorem sorted_insert (key : Text) (value : Value) :
    (members : Members) → Sorted members → Sorted (insertMember key value members)
  | .nil, _ => ⟨trivial, trivial⟩
  | .cons key' value' rest, h => by
    simp only [insertMember]
    split
    · next below =>
      refine ⟨headLe_insert key' key value rest h.1 ?_, sorted_insert key value rest h.2⟩
      simp [le, lt_asymm key' key below]
    · next notBelow =>
      refine ⟨?_, h⟩
      simpa [HeadLe, le] using notBelow

/-- Sorting sorts. -/
theorem sorted_sortMembers : (members : Members) → Sorted (sortMembers members)
  | .nil => trivial
  | .cons key value rest => sorted_insert key value _ (sorted_sortMembers rest)

theorem insert_of_headLe (key : Text) (value : Value) :
    (members : Members) → HeadLe key members → insertMember key value members = .cons key value members
  | .nil, _ => rfl
  | .cons key' _ _, h => by
    have : lt key' key = false := by simpa [HeadLe, le] using h
    simp [insertMember, this]

/-- Sorting sorted members changes nothing. -/
theorem sortMembers_of_sorted : (members : Members) → Sorted members → sortMembers members = members
  | .nil, _ => rfl
  | .cons key value rest, h => by
    simp only [sortMembers]
    rw [sortMembers_of_sorted rest h.2, insert_of_headLe key value rest h.1]

/-- Sorting is idempotent. -/
theorem sortMembers_idempotent (members : Members) : sortMembers (sortMembers members) = sortMembers members :=
  sortMembers_of_sorted _ (sorted_sortMembers members)

/-- Two members with different keys can be inserted in either order. -/
theorem insert_comm (key₁ key₂ : Text) (value₁ value₂ : Value) (distinct : key₁ ≠ key₂) :
    (members : Members) →
      insertMember key₁ value₁ (insertMember key₂ value₂ members) =
        insertMember key₂ value₂ (insertMember key₁ value₁ members)
  | .nil => by
    simp only [insertMember]
    by_cases h₁ : lt key₂ key₁ = true
    · simp [h₁, lt_asymm key₂ key₁ h₁]
    · by_cases h₂ : lt key₁ key₂ = true
      · simp [h₂, lt_asymm key₁ key₂ h₂]
      · exact absurd (eq_of_not_lt key₁ key₂ (by simpa using h₂) (by simpa using h₁)) distinct
  | .cons key value rest => by
    simp only [insertMember]
    by_cases h₁ : lt key key₁ = true <;> by_cases h₂ : lt key key₂ = true
    · simp [h₁, h₂, insertMember, insert_comm key₁ key₂ value₁ value₂ distinct rest]
    · by_cases h : lt key₂ key₁ = true
      · simp [h₁, h₂, insertMember, h]
      · have h₂' : lt key key₂ = false := by simpa using h₂
        by_cases h' : lt key₁ key₂ = true
        · exact absurd (lt_trans key key₁ key₂ h₁ h') (by simp [h₂'])
        · exact absurd (eq_of_not_lt key₁ key₂ (by simpa using h') (by simpa using h)) distinct
    · by_cases h : lt key₁ key₂ = true
      · simp [h₁, h₂, insertMember, h]
      · have h₁' : lt key key₁ = false := by simpa using h₁
        by_cases h' : lt key₂ key₁ = true
        · exact absurd (lt_trans key key₂ key₁ h₂ h') (by simp [h₁'])
        · exact absurd (eq_of_not_lt key₁ key₂ (by simpa using h) (by simpa using h')) distinct
    · have h₁' : lt key key₁ = false := by simpa using h₁
      have h₂' : lt key key₂ = false := by simpa using h₂
      by_cases h : lt key₂ key₁ = true
      · simp [h₁', h₂', insertMember, h, lt_asymm key₂ key₁ h]
      · by_cases h' : lt key₁ key₂ = true
        · simp [h₁', h₂', insertMember, h', lt_asymm key₁ key₂ h']
        · exact absurd (eq_of_not_lt key₁ key₂ (by simpa using h') (by simpa using h)) distinct

/-- Swapping two neighbouring members with different keys does not change the sort. -/
theorem sortMembers_swap (key₁ key₂ : Text) (value₁ value₂ : Value) (rest : Members) (distinct : key₁ ≠ key₂) :
    sortMembers (.cons key₁ value₁ (.cons key₂ value₂ rest)) =
      sortMembers (.cons key₂ value₂ (.cons key₁ value₁ rest)) :=
  insert_comm key₁ key₂ value₁ value₂ distinct (sortMembers rest)

/--
One object's members in another order. A JavaScript object holds one member per key, so every reordering of one is
made of swaps of neighbours with different keys.
-/
inductive Reorder : Members → Members → Prop where
  | refl (members : Members) : Reorder members members
  | swap (key₁ key₂ : Text) (value₁ value₂ : Value) (rest : Members) :
    key₁ ≠ key₂ → Reorder (.cons key₁ value₁ (.cons key₂ value₂ rest)) (.cons key₂ value₂ (.cons key₁ value₁ rest))
  | cons (key : Text) (value : Value) {members members' : Members} :
    Reorder members members' → Reorder (.cons key value members) (.cons key value members')
  | trans {a b c : Members} : Reorder a b → Reorder b c → Reorder a c

theorem sortMembers_reorder {a b : Members} (reorder : Reorder a b) :
    sortMembers (normalizeMembers a) = sortMembers (normalizeMembers b) := by
  induction reorder with
  | refl => rfl
  | swap key₁ key₂ value₁ value₂ rest distinct =>
    simp only [normalizeMembers]
    exact sortMembers_swap key₁ key₂ _ _ _ distinct
  | cons key value _ same => simp only [normalizeMembers, sortMembers, same]
  | trans _ _ first second => exact first.trans second

/-- Inputs with the same sorted form have the same preimage, or the same refusal. -/
theorem preimage_of_normalize_eq (limit : Nat) {a b : Value} (same : normalize a = normalize b) :
    preimageWith limit a = preimageWith limit b := by
  simp [preimageWith, materialWith, same]

/-- **Key-order invariance.** An object keys the same whatever order its members are in. -/
theorem preimage_reorder (limit : Nat) {a b : Members} (reorder : Reorder a b) :
    preimageWith limit (.obj a) = preimageWith limit (.obj b) :=
  preimage_of_normalize_eq limit (by simp only [normalize, sortMembers_reorder reorder])

-- Idempotency ---------------------------------------------------------------------------------------------------------

theorem normalizeMembers_insert (key : Text) (value : Value) :
    (members : Members) →
      normalizeMembers (insertMember key value members) = insertMember key (normalize value) (normalizeMembers members)
  | .nil => by simp [insertMember, normalizeMembers]
  | .cons key' value' rest => by
    simp only [insertMember, normalizeMembers]
    split
    · simp [normalizeMembers, normalizeMembers_insert key value rest]
    · simp [normalizeMembers]

/-- Normalizing the values and sorting the members commute: sorting reads keys only. -/
theorem normalizeMembers_sort :
    (members : Members) → normalizeMembers (sortMembers members) = sortMembers (normalizeMembers members)
  | .nil => rfl
  | .cons key value rest => by
    simp only [sortMembers, normalizeMembers]
    rw [normalizeMembers_insert, normalizeMembers_sort rest]

mutual
  /-- Normalizing a normalized tree changes nothing. -/
  theorem normalize_idempotent : (value : Value) → normalize (normalize value) = normalize value
    | .null => rfl
    | .bool _ => rfl
    | .num _ => rfl
    | .str _ => rfl
    | .opaque _ => rfl
    | .arr items => by simp [normalize, normalizeItems_idempotent items]
    | .obj members => by
      simp only [normalize]
      rw [normalizeMembers_sort, normalizeMembers_idempotent members, sortMembers_idempotent]

  theorem normalizeItems_idempotent : (items : Items) → normalizeItems (normalizeItems items) = normalizeItems items
    | .nil => rfl
    | .cons head tail => by simp [normalizeItems, normalize_idempotent head, normalizeItems_idempotent tail]

  theorem normalizeMembers_idempotent :
      (members : Members) → normalizeMembers (normalizeMembers members) = normalizeMembers members
    | .nil => rfl
    | .cons _ value tail => by simp [normalizeMembers, normalize_idempotent value, normalizeMembers_idempotent tail]
end

/-- **Idempotency.** A value and its sorted form have the same preimage. -/
theorem preimage_normalize (limit : Nat) (value : Value) :
    preimageWith limit (normalize value) = preimageWith limit value :=
  preimage_of_normalize_eq limit (normalize_idempotent value)

-- Numbers -------------------------------------------------------------------------------------------------------------

/-- A decimal digit as a code unit. -/
def IsDigit (unit : Nat) : Prop := 48 ≤ unit ∧ unit ≤ 57

/-- The text does not go on with a digit: where a number stops is not in doubt. -/
def Stop (rest : Text) : Prop := ∀ unit tail, rest = unit :: tail → ¬ IsDigit unit

theorem digits_all : (value : Nat) → ∀ unit ∈ digits value, IsDigit unit := by
  intro value
  induction value using Nat.strongRecOn with
  | _ value ih =>
    intro unit member
    rw [digits] at member
    split at member
    · simp at member; subst member; exact ⟨by omega, by omega⟩
    · rcases List.mem_append.mp member with inner | last
      · exact ih (value / 10) (by omega) unit inner
      · simp at last; subst last; exact ⟨by omega, by omega⟩

theorem digits_ne_nil (value : Nat) : digits value ≠ [] := by
  rw [digits]
  split <;> simp

/-- The number a run of digits spells. -/
def valueOf (text : Text) : Nat := text.foldl (fun total unit => total * 10 + (unit - 48)) 0

theorem valueOf_digits : (value : Nat) → valueOf (digits value) = value := by
  intro value
  induction value using Nat.strongRecOn with
  | _ value ih =>
    rw [digits]
    split
    · simp [valueOf]
    · have inner := ih (value / 10) (by omega)
      simp only [valueOf, List.foldl_append, List.foldl_cons, List.foldl_nil] at inner ⊢
      rw [inner]
      omega

theorem digits_injective {a b : Nat} (same : digits a = digits b) : a = b := by
  rw [← valueOf_digits a, ← valueOf_digits b, same]

/-- Two runs of digits, each followed by something that is not a digit, are the same run when the texts agree. -/
theorem run_cancel : (xs ys : Text) → (r₁ r₂ : Text) → (∀ unit ∈ xs, IsDigit unit) → (∀ unit ∈ ys, IsDigit unit) →
    Stop r₁ → Stop r₂ → xs ++ r₁ = ys ++ r₂ → xs = ys ∧ r₁ = r₂
  | [], [], _, _, _, _, _, _, h => ⟨rfl, by simpa using h⟩
  | [], y :: ys, r₁, _, _, hy, stop, _, h => by
    exact absurd (hy y (by simp)) (stop y _ (by simpa using h))
  | x :: xs, [], _, r₂, hx, _, _, stop, h => by
    exact absurd (hx x (by simp)) (stop x _ (by simpa using h.symm))
  | x :: xs, y :: ys, r₁, r₂, hx, hy, stop₁, stop₂, h => by
    simp only [List.cons_append, List.cons.injEq] at h
    have inner := run_cancel xs ys r₁ r₂ (fun unit member => hx unit (by simp [member]))
      (fun unit member => hy unit (by simp [member])) stop₁ stop₂ h.2
    exact ⟨by rw [h.1, inner.1], inner.2⟩

theorem digits_cancel {a b : Nat} {r₁ r₂ : Text} (stop₁ : Stop r₁) (stop₂ : Stop r₂)
    (same : digits a ++ r₁ = digits b ++ r₂) : a = b ∧ r₁ = r₂ :=
  have both := run_cancel _ _ r₁ r₂ (digits_all a) (digits_all b) stop₁ stop₂ same
  ⟨digits_injective both.1, both.2⟩

/-- The first code unit of a natural number's text is a digit. -/
theorem digits_head (value : Nat) : ∃ unit tail, digits value = unit :: tail ∧ IsDigit unit := by
  cases shape : digits value with
  | nil => exact absurd shape (digits_ne_nil value)
  | cons unit tail => exact ⟨unit, tail, rfl, digits_all value unit (by simp [shape])⟩

/-- A whole number's text, followed by something that is not a digit, is the text of no other whole number. -/
theorem decimal_cancel {a b : Int} {r₁ r₂ : Text} (stop₁ : Stop r₁) (stop₂ : Stop r₂)
    (same : decimal a ++ r₁ = decimal b ++ r₂) : a = b ∧ r₁ = r₂ := by
  unfold decimal at same
  by_cases negA : a < 0 <;> by_cases negB : b < 0
  · simp only [negA, negB, if_true, List.cons_append, List.cons.injEq, true_and] at same
    have both := digits_cancel stop₁ stop₂ same
    exact ⟨by omega, both.2⟩
  · simp only [negA, negB, if_true, if_false, List.cons_append] at same
    obtain ⟨unit, tail, shape, digit⟩ := digits_head b.toNat
    rw [shape] at same
    simp only [List.cons_append, List.cons.injEq] at same
    exact absurd same.1 (by unfold IsDigit at digit; omega)
  · simp only [negA, negB, if_true, if_false, List.cons_append] at same
    obtain ⟨unit, tail, shape, digit⟩ := digits_head a.toNat
    rw [shape] at same
    simp only [List.cons_append, List.cons.injEq] at same
    exact absurd same.1 (by unfold IsDigit at digit; omega)
  · simp only [negA, negB, if_false] at same
    have both := digits_cancel stop₁ stop₂ same
    exact ⟨by omega, both.2⟩

-- Strings -------------------------------------------------------------------------------------------------------------

/-- The unit a two-unit escape stands for. -/
def unshort (unit : Nat) : Nat :=
  if unit = 98 then 0x08 else if unit = 116 then 0x09 else if unit = 110 then 0x0a
  else if unit = 102 then 0x0c else if unit = 114 then 0x0d else unit

/-- The three shapes an escape takes: the unit itself, a backslash and a letter, or `\u` and four digits. -/
theorem escapeUnit_shape (a : Nat) :
    (escapeUnit a = [a] ∧ a ≠ 92 ∧ a ≠ 0x22) ∨
      (∃ letter, escapeUnit a = [92, letter] ∧ letter ≠ 117 ∧ a = unshort letter) ∨
      (∃ h₁ h₂, escapeUnit a = [92, 117, h₁, h₂, hexDigit (a / 16 % 16), hexDigit (a % 16)] ∧ a < 32) := by
  unfold escapeUnit
  repeat' split
  · exact .inr (.inl ⟨0x22, rfl, by decide, by simp_all [unshort]⟩)
  · exact .inr (.inl ⟨92, rfl, by decide, by simp_all [unshort]⟩)
  · exact .inr (.inl ⟨98, rfl, by decide, by simp_all [unshort]⟩)
  · exact .inr (.inl ⟨116, rfl, by decide, by simp_all [unshort]⟩)
  · exact .inr (.inl ⟨110, rfl, by decide, by simp_all [unshort]⟩)
  · exact .inr (.inl ⟨102, rfl, by decide, by simp_all [unshort]⟩)
  · exact .inr (.inl ⟨114, rfl, by decide, by simp_all [unshort]⟩)
  · exact .inr (.inr ⟨_, _, rfl, by assumption⟩)
  · exact .inl ⟨rfl, by omega, by omega⟩

theorem hex_pair {a b : Nat} (smallA : a < 32) (smallB : b < 32)
    (high : hexDigit (a / 16 % 16) = hexDigit (b / 16 % 16)) (low : hexDigit (a % 16) = hexDigit (b % 16)) :
    a = b := by
  unfold hexDigit at high low
  repeat' split at high
  all_goals repeat' split at low
  all_goals omega

/-- The escapes are a prefix code: one unit's escape never begins another's. -/
theorem escapeUnit_cancel (a b : Nat) (x y : Text) (same : escapeUnit a ++ x = escapeUnit b ++ y) :
    a = b ∧ x = y := by
  rcases escapeUnit_shape a with ⟨shapeA, notSlashA, _⟩ | ⟨letterA, shapeA, notUA, isA⟩ | ⟨_, _, shapeA, smallA⟩ <;>
    rcases escapeUnit_shape b with ⟨shapeB, notSlashB, _⟩ | ⟨letterB, shapeB, notUB, isB⟩ | ⟨_, _, shapeB, smallB⟩ <;>
    rw [shapeA, shapeB] at same <;>
    simp only [List.cons_append, List.nil_append, List.cons.injEq] at same
  · exact same
  · exact absurd same.1 notSlashA
  · exact absurd same.1 notSlashA
  · exact absurd same.1.symm notSlashB
  · exact ⟨by rw [isA, isB, same.2.1], same.2.2⟩
  · exact absurd same.2.1 notUA
  · exact absurd same.1.symm notSlashB
  · exact absurd same.2.1.symm notUB
  · exact ⟨hex_pair smallA smallB same.2.2.2.2.1 same.2.2.2.2.2.1, same.2.2.2.2.2.2⟩

/-- No escape begins with the quote that closes a string. -/
theorem escapeUnit_not_quote (a : Nat) (x y : Text) : escapeUnit a ++ x ≠ 0x22 :: y := by
  intro same
  rcases escapeUnit_shape a with ⟨shape, _, notQuote⟩ | ⟨_, shape, _, _⟩ | ⟨_, _, shape, _⟩ <;>
    rw [shape] at same <;> simp only [List.cons_append, List.nil_append, List.cons.injEq] at same
  · exact notQuote same.1
  · omega
  · omega

/-- A string's inside, closed by its quote, is the inside of no other string. -/
theorem body_cancel : (s t : Text) → (r₁ r₂ : Text) → body s ++ 0x22 :: r₁ = body t ++ 0x22 :: r₂ → s = t ∧ r₁ = r₂
  | [], [], _, _, h => ⟨rfl, by simpa [body] using h⟩
  | [], b :: t, r₁, r₂, h => by
    simp only [body, List.nil_append, List.append_assoc] at h
    exact absurd h.symm (escapeUnit_not_quote b _ _)
  | a :: s, [], r₁, r₂, h => by
    simp only [body, List.nil_append, List.append_assoc] at h
    exact absurd h (escapeUnit_not_quote a _ _)
  | a :: s, b :: t, r₁, r₂, h => by
    simp only [body, List.append_assoc] at h
    have head := escapeUnit_cancel a b _ _ h
    have inner := body_cancel s t r₁ r₂ head.2
    exact ⟨by rw [head.1, inner.1], inner.2⟩

theorem quote_cancel {s t : Text} {r₁ r₂ : Text} (same : quote s ++ r₁ = quote t ++ r₂) : s = t ∧ r₁ = r₂ := by
  simp only [quote, List.cons_append, List.cons.injEq, true_and, List.append_assoc, List.nil_append] at same
  exact body_cancel s t r₁ r₂ same

-- Injectivity ---------------------------------------------------------------------------------------------------------

/-- The class of a code unit a value's text can begin with. -/
def lead (unit : Nat) : Nat :=
  if unit = 110 then 0
  else if unit = 116 ∨ unit = 102 then 1
  else if unit = 45 ∨ (48 ≤ unit ∧ unit ≤ 57) then 2
  else if unit = 0x22 then 3
  else if unit = 91 then 4
  else if unit = 123 then 5
  else 6

/-- The class of a value: `lead` of the first code unit of its text. -/
def kind : Json → Nat
  | .null => 0
  | .bool _ => 1
  | .int _ => 2
  | .str _ => 3
  | .arr _ => 4
  | .obj _ => 5

/-- A value's text begins with a code unit that names its kind. -/
theorem write_head : (value : Json) → ∃ unit tail, write value = unit :: tail ∧ lead unit = kind value
  | .null => ⟨110, _, rfl, rfl⟩
  | .bool true => ⟨116, _, rfl, rfl⟩
  | .bool false => ⟨102, _, rfl, rfl⟩
  | .int value => by
    simp only [write, decimal, kind]
    split
    · exact ⟨45, _, rfl, rfl⟩
    · obtain ⟨unit, tail, shape, digit⟩ := digits_head value.toNat
      refine ⟨unit, tail, shape, ?_⟩
      unfold IsDigit at digit
      unfold lead
      repeat' split
      all_goals omega
  | .str _ => ⟨0x22, _, rfl, rfl⟩
  | .arr _ => ⟨91, _, rfl, rfl⟩
  | .obj _ => ⟨123, _, rfl, rfl⟩

/-- After an item, the text goes on with a comma or the closing bracket. -/
theorem stop_items (items : JItems) (rest : Text) : Stop (writeItems false items ++ rest) := by
  intro unit tail shape digit
  unfold IsDigit at digit
  cases items <;> simp [writeItems, separator] at shape <;> omega

/-- After a member, the text goes on with a comma or the closing brace. -/
theorem stop_members (members : JMembers) (rest : Text) : Stop (writeMembers false members ++ rest) := by
  intro unit tail shape digit
  unfold IsDigit at digit
  cases members <;> simp [writeMembers, separator] at shape <;> omega

theorem kind_eq {a b : Json} {r₁ r₂ : Text} (same : write a ++ r₁ = write b ++ r₂) : kind a = kind b := by
  obtain ⟨unitA, tailA, shapeA, classA⟩ := write_head a
  obtain ⟨unitB, tailB, shapeB, classB⟩ := write_head b
  rw [shapeA, shapeB] at same
  simp only [List.cons_append, List.cons.injEq] at same
  rw [← classA, ← classB, same.1]

mutual
  /-- A value's text, followed by something that is not a digit, is the text of no other value. -/
  theorem write_cancel : (a b : Json) → (r₁ r₂ : Text) → Stop r₁ → Stop r₂ → write a ++ r₁ = write b ++ r₂ →
      a = b ∧ r₁ = r₂
    | .null, b, r₁, r₂, _, _, same => by
      have class' := kind_eq same
      cases b <;> simp [kind] at class'
      simpa [write] using same
    | .bool x, b, r₁, r₂, _, _, same => by
      have class' := kind_eq same
      cases b <;> simp [kind] at class'
      rename_i y
      cases x <;> cases y <;> simp [write] at same ⊢ <;> exact same
    | .int x, b, r₁, r₂, stop₁, stop₂, same => by
      have class' := kind_eq same
      cases b <;> simp [kind] at class'
      simp only [write] at same
      have both := decimal_cancel stop₁ stop₂ same
      exact ⟨by rw [both.1], both.2⟩
    | .str x, b, r₁, r₂, _, _, same => by
      have class' := kind_eq same
      cases b <;> simp [kind] at class'
      simp only [write] at same
      have both := quote_cancel same
      exact ⟨by rw [both.1], both.2⟩
    | .arr x, b, r₁, r₂, _, _, same => by
      have class' := kind_eq same
      cases b <;> simp [kind] at class'
      rename_i y
      simp only [write, List.cons_append, List.cons.injEq, true_and] at same
      have both := items_cancel true x y r₁ r₂ same
      exact ⟨by rw [both.1], both.2⟩
    | .obj x, b, r₁, r₂, _, _, same => by
      have class' := kind_eq same
      cases b <;> simp [kind] at class'
      rename_i y
      simp only [write, List.cons_append, List.cons.injEq, true_and] at same
      have both := members_cancel true x y r₁ r₂ same
      exact ⟨by rw [both.1], both.2⟩

  theorem items_cancel (first : Bool) : (a b : JItems) → (r₁ r₂ : Text) →
      writeItems first a ++ r₁ = writeItems first b ++ r₂ → a = b ∧ r₁ = r₂
    | .nil, .nil, _, _, same => ⟨rfl, by simpa [writeItems] using same⟩
    | .nil, .cons head _, r₁, r₂, same => by
      obtain ⟨unit, tail, shape, class'⟩ := write_head head
      cases first <;> simp [writeItems, separator, shape] at same
      rw [← same.1] at class'
      cases head <;> simp [lead, kind] at class'
    | .cons head _, .nil, r₁, r₂, same => by
      obtain ⟨unit, tail, shape, class'⟩ := write_head head
      cases first <;> simp [writeItems, separator, shape] at same
      rw [same.1] at class'
      cases head <;> simp [lead, kind] at class'
    | .cons headA tailA, .cons headB tailB, r₁, r₂, same => by
      simp only [writeItems, List.append_assoc, List.append_cancel_left_eq] at same
      have head := write_cancel headA headB _ _ (stop_items tailA r₁) (stop_items tailB r₂) same
      have tail := items_cancel false tailA tailB r₁ r₂ head.2
      exact ⟨by rw [head.1, tail.1], tail.2⟩

  theorem members_cancel (first : Bool) : (a b : JMembers) → (r₁ r₂ : Text) →
      writeMembers first a ++ r₁ = writeMembers first b ++ r₂ → a = b ∧ r₁ = r₂
    | .nil, .nil, _, _, same => ⟨rfl, by simpa [writeMembers] using same⟩
    | .nil, .cons _ _ _, r₁, r₂, same => by
      cases first <;> simp [writeMembers, separator, quote] at same
    | .cons _ _ _, .nil, r₁, r₂, same => by
      cases first <;> simp [writeMembers, separator, quote] at same
    | .cons keyA valueA tailA, .cons keyB valueB tailB, r₁, r₂, same => by
      simp only [writeMembers, List.append_assoc, List.append_cancel_left_eq] at same
      have key := quote_cancel same
      have rest := key.2
      simp only [List.cons_append, List.cons.injEq, true_and, List.append_assoc] at rest
      have value := write_cancel valueA valueB _ _ (stop_members tailA r₁) (stop_members tailB r₂) rest
      have tail := members_cancel false tailA tailB r₁ r₂ value.2
      exact ⟨by rw [key.1, value.1, tail.1], tail.2⟩
end

/-- **The preimage encoding is injective.** Two accepted trees with the same text are the same tree. -/
theorem write_injective {a b : Json} (same : write a = write b) : a = b :=
  (write_cancel a b [] [] (fun _ _ shape => by simp at shape) (fun _ _ shape => by simp at shape)
    (by simpa using same)).1

theorem materialWith_of_preimageWith {limit : Nat} {value : Value} {text : Text}
    (accepted : preimageWith limit value = .ok text) : ∃ json, materialWith limit value = .ok json ∧ write json = text := by
  unfold preimageWith at accepted
  cases shape : materialWith limit value with
  | error reason => simp [shape, Except.map] at accepted
  | ok json => exact ⟨json, rfl, by simpa [shape, Except.map] using accepted⟩

/--
**Preimage injectivity.** Two inputs hash the same text only when their accepted key material is the same tree: the
same values under the same keys, up to member order, members JSON leaves out, and the sign of zero.
-/
theorem preimage_injective {limit : Nat} {a b : Value} {text : Text}
    (first : preimageWith limit a = .ok text) (second : preimageWith limit b = .ok text) :
    materialWith limit a = materialWith limit b := by
  obtain ⟨jsonA, materialA, textA⟩ := materialWith_of_preimageWith first
  obtain ⟨jsonB, materialB, textB⟩ := materialWith_of_preimageWith second
  rw [materialA, materialB, write_injective (textA.trans textB.symm)]

-- Refusal -------------------------------------------------------------------------------------------------------------

/-- An opaque value that has no key wherever it stands. -/
def Opaque.unkeyable : Opaque → Bool
  | .undefined => false
  | .symbol => false
  | .function => false
  | _ => true

mutual
  /-- True when the value holds, at any depth, something that has no key wherever it stands. -/
  def unkeyable : Value → Bool
    | .num .nan => true
    | .num .posInf => true
    | .num .negInf => true
    | .str value => !wellFormed value
    | .opaque kind' => kind'.unkeyable
    | .arr items => unkeyableItems items
    | .obj members => unkeyableMembers members
    | _ => false

  def unkeyableItems : Items → Bool
    | .nil => false
    | .cons head tail => unkeyable head || unkeyableItems tail

  def unkeyableMembers : Members → Bool
    | .nil => false
    | .cons key value tail => !wellFormed key || unkeyable value || unkeyableMembers tail
end

theorem unkeyableMembers_insert (key : Text) (value : Value) : (members : Members) →
    unkeyableMembers (insertMember key value members) = (!wellFormed key || unkeyable value || unkeyableMembers members)
  | .nil => rfl
  | .cons key' value' rest => by
    simp only [insertMember]
    split
    · simp only [unkeyableMembers, unkeyableMembers_insert key value rest]
      cases wellFormed key <;> cases wellFormed key' <;> cases unkeyable value <;> cases unkeyable value' <;> simp
    · simp only [unkeyableMembers]

theorem unkeyableMembers_sort : (members : Members) → unkeyableMembers (sortMembers members) = unkeyableMembers members
  | .nil => rfl
  | .cons key value rest => by
    simp only [sortMembers, unkeyableMembers_insert, unkeyableMembers_sort rest, unkeyableMembers]

mutual
  /-- Sorting moves members; it neither adds nor removes what has no key. -/
  theorem unkeyable_normalize : (value : Value) → unkeyable (normalize value) = unkeyable value
    | .null => rfl
    | .bool _ => rfl
    | .num _ => rfl
    | .str _ => rfl
    | .opaque _ => rfl
    | .arr items => by simp only [normalize, unkeyable, unkeyableItems_normalize items]
    | .obj members => by
      simp only [normalize, unkeyable, unkeyableMembers_sort, unkeyableMembers_normalize members]

  theorem unkeyableItems_normalize : (items : Items) → unkeyableItems (normalizeItems items) = unkeyableItems items
    | .nil => rfl
    | .cons head tail => by
      simp only [normalizeItems, unkeyableItems, unkeyable_normalize head, unkeyableItems_normalize tail]

  theorem unkeyableMembers_normalize :
      (members : Members) → unkeyableMembers (normalizeMembers members) = unkeyableMembers members
    | .nil => rfl
    | .cons _ value tail => by
      simp only [normalizeMembers, unkeyableMembers, unkeyable_normalize value, unkeyableMembers_normalize tail]
end

theorem illFormedKey_of_unkeyable : (members : Members) → illFormedKey members = true → unkeyableMembers members = true
  | .nil, h => by simp [illFormedKey] at h
  | .cons key value rest, h => by
    simp only [illFormedKey, Bool.or_eq_true] at h
    simp only [unkeyableMembers, Bool.or_eq_true]
    rcases h with here | later
    · exact .inl (.inl here)
    · exact .inr (illFormedKey_of_unkeyable rest later)

theorem guard_ok {limit : Nat} {value : Value} {position : Position} {depth : Nat}
    {next : Except Reason (Option Json)} {result : Option Json}
    (accepted : guard limit value position depth next = .ok result) : next = .ok result := by
  unfold guard at accepted
  split at accepted
  · cases accepted
  · split at accepted
    · cases accepted
    · exact accepted

mutual
  /-- An accepted value holds nothing that has no key. -/
  theorem accept_clean (limit : Nat) : (value : Value) → (position : Position) → (depth : Nat) →
      (result : Option Json) → accept limit value position depth = .ok result → unkeyable value = false
    | .null, _, _, _, _ => rfl
    | .bool _, _, _, _, _ => rfl
    | .num (.int _), _, _, _, _ => rfl
    | .num .negZero, _, _, _, _ => rfl
    | .num .nan, _, _, _, accepted => by simp [accept, guard, check] at accepted
    | .num .posInf, _, _, _, accepted => by simp [accept, guard, check] at accepted
    | .num .negInf, _, _, _, accepted => by simp [accept, guard, check] at accepted
    | .str value, _, _, _, accepted => by
      have inner := guard_ok (by simpa only [accept] using accepted)
      split at inner
      · simp [unkeyable, *]
      · cases inner
    | .opaque .undefined, _, _, _, _ => rfl
    | .opaque .symbol, _, _, _, _ => rfl
    | .opaque .function, _, _, _, _ => rfl
    | .opaque .redacted, _, _, _, accepted => by simp [accept, guard, check] at accepted
    | .opaque .bigint, _, _, _, accepted => by cases guard_ok (by simpa only [accept] using accepted)
    | .opaque .invalidDate, _, _, _, accepted => by simp [accept, guard, check] at accepted
    | .opaque .unsupported, _, _, _, accepted => by cases guard_ok (by simpa only [accept] using accepted)
    | .opaque .maskedCollection, _, _, _, accepted => by cases guard_ok (by simpa only [accept] using accepted)
    | .arr items, _, depth, _, accepted => by
      have inner := guard_ok (by simpa only [accept] using accepted)
      split at inner
      · cases inner
      · next _ accepted' => simpa only [unkeyable] using acceptItems_clean limit items (depth + 1) _ accepted'
    | .obj members, _, depth, _, accepted => by
      have inner := guard_ok (by simpa only [accept] using accepted)
      split at inner
      · cases inner
      · next keys =>
        split at inner
        · cases inner
        · next _ accepted' =>
          simpa only [unkeyable] using
            acceptMembers_clean limit members (depth + 1) _ (by simpa using keys) accepted'

  theorem acceptItems_clean (limit : Nat) : (items : Items) → (depth : Nat) → (result : JItems) →
      acceptItems limit items depth = .ok result → unkeyableItems items = false
    | .nil, _, _, _ => rfl
    | .cons head tail, depth, _, accepted => by
      simp only [acceptItems] at accepted
      split at accepted
      · cases accepted
      · next first acceptedHead =>
        split at accepted
        · cases accepted
        · next rest acceptedTail =>
          simp only [unkeyableItems, accept_clean limit head .element depth first acceptedHead,
            acceptItems_clean limit tail depth rest acceptedTail, Bool.or_self]

  theorem acceptMembers_clean (limit : Nat) : (members : Members) → (depth : Nat) → (result : JMembers) →
      illFormedKey members = false → acceptMembers limit members depth = .ok result → unkeyableMembers members = false
    | .nil, _, _, _, _ => rfl
    | .cons key value tail, depth, _, keys, accepted => by
      simp only [illFormedKey, Bool.or_eq_false_iff] at keys
      simp only [acceptMembers] at accepted
      split at accepted
      · cases accepted
      · next first acceptedValue =>
        split at accepted
        · cases accepted
        · next rest acceptedTail =>
          simp only [unkeyableMembers, keys.1, accept_clean limit value .member depth first acceptedValue,
            acceptMembers_clean limit tail depth rest keys.2 acceptedTail, Bool.or_self]
end

/--
**Unkeyable values are refused.** A value with a preimage holds, at any depth, no non-finite number, redacted value,
BigInt, invalid date or non-plain object, and no text or key with a lone surrogate.
-/
theorem preimage_clean {limit : Nat} {value : Value} {text : Text} (accepted : preimageWith limit value = .ok text) :
    unkeyable value = false := by
  obtain ⟨json, material, _⟩ := materialWith_of_preimageWith accepted
  unfold materialWith at material
  split at material
  · cases material
  · cases material
  · next _ admitted => rw [← unkeyable_normalize value]; exact accept_clean limit _ .root 0 _ admitted

/-- A non-finite number is refused wherever it stands, and the refusal names it. -/
theorem nan_refused (limit : Nat) (position : Position) (depth : Nat) :
    accept limit (.num .nan) position depth = .error .nan ∧
      accept limit (.num .posInf) position depth = .error .posInf ∧
      accept limit (.num .negInf) position depth = .error .negInf := by
  simp [accept, guard, check]

/-- A redacted value and an invalid date are refused wherever they stand, before the depth limit is read. -/
theorem redacted_refused (limit : Nat) (position : Position) (depth : Nat) :
    accept limit (.opaque .redacted) position depth = .error .redacted ∧
      accept limit (.opaque .invalidDate) position depth = .error .invalidDate := by
  simp [accept, guard, check]

/-- `undefined`, a symbol and a function are left out of an object and refused at the root and in an array. -/
theorem undefined_refused (limit : Nat) (depth : Nat) :
    accept limit (.opaque .undefined) .root depth = .error .undefined ∧
      accept limit (.opaque .undefined) .element depth = .error .undefined ∧
      accept limit (.opaque .symbol) .element depth = .error .symbol ∧
      accept limit (.opaque .function) .element depth = .error .function ∧
      accept limit (.opaque .function) .root depth = .error .function := by
  simp [accept, guard, check]

/-- A collection that passes for a plain record is refused by name (#4530). -/
theorem masked_collection_refused (limit : Nat) (position : Position) (depth : Nat) (inside : depth ≤ limit) :
    accept limit (.opaque .maskedCollection) position depth = .error .collection := by
  simp [accept, guard, check, Nat.not_lt.mpr inside]

/-- A member that is left out does not change the key: `{}` and `{key: undefined}` share a preimage. -/
theorem omitted_member (key : Text) (wellFormedKey : wellFormed key = true) :
    preimage (.obj (.cons key (.opaque .undefined) .nil)) = preimage (.obj .nil) := by
  simp [preimage, preimageWith, materialWith, normalize, normalizeMembers, sortMembers, insertMember, accept, guard,
    check, illFormedKey, wellFormedKey, acceptMembers, maxDepth]

/-- Both zeros key alike. -/
theorem zero_sign : preimage (.num .negZero) = preimage (.num (.int 0)) := rfl

-- The stored key ------------------------------------------------------------------------------------------------------

/-- The key of a digest is a key exactly when the digest is one. -/
theorem isKey_keyOf (digest : Text) : isKey (keyOf digest) = isDigest digest := by
  simp [isKey, keyOf, keyPrefix]

/-- `digestOf` gives back the digest a key was made of. -/
theorem digestOf_keyOf (digest : Text) : digestOf (keyOf digest) = digest := by
  simp [digestOf, keyOf, keyPrefix]

/-- A key is `key1_` and its digest, 69 code units in all. -/
theorem isKey_shape {text : Text} (valid : isKey text = true) :
    text = keyOf (digestOf text) ∧ isDigest (digestOf text) = true ∧ text.length = 69 := by
  simp only [isKey, Bool.and_eq_true, beq_iff_eq] at valid
  have whole : text = keyOf (digestOf text) := by
    unfold keyOf digestOf
    rw [← valid.1, List.take_append_drop]
  refine ⟨whole, valid.2, ?_⟩
  have length := valid.2
  simp only [isDigest, Bool.and_eq_true, beq_iff_eq] at length
  have dropped := length.1
  rw [List.length_drop] at dropped
  omega

end KeysSpec

import CanonicalSpec.Canonical
import CanonicalSpec.Bounded

/-!
# What the specification guarantees

Machine-checked: every proof is complete and nothing is assumed beyond Lean's own foundations.

* **Key order.** `lt` is a strict total order on texts, `sortMembers` puts members in it, and the result does not
  depend on the order two members with different keys arrived in.
* **Idempotency.** `normalize` is idempotent and leaves a tree every object of which is sorted, so canonicalizing a
  canonical tree changes nothing.
* **Bound soundness.** A tree `admitJson` accepts is inside every limit: its byte count is exactly `size`, and that size,
  its value count and its nesting are within `maxBytes`, `maxNodes` and `maxDepth`. `admitStrict` is inside its
  limits the same way. A text `encodedStringBytes` counts is well formed and within its maximum.
-/

namespace CanonicalSpec

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

/-- The order is total: of two texts, one is at or below the other. -/
theorem le_total (a b : Text) : le a b = false → le b a = true := by
  intro h
  simp only [le, Bool.not_eq_false'] at h
  simp [le, lt_asymm b a h]

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

/-- **Deterministic key order.** Swapping two neighbouring members with different keys does not change the sort. -/
theorem sortMembers_swap (key₁ key₂ : Text) (value₁ value₂ : Value) (rest : Members) (distinct : key₁ ≠ key₂) :
    sortMembers (.cons key₁ value₁ (.cons key₂ value₂ rest)) =
      sortMembers (.cons key₂ value₂ (.cons key₁ value₁ rest)) :=
  insert_comm key₁ key₂ value₁ value₂ distinct (sortMembers rest)

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
  /-- **Idempotency.** Normalizing a normalized tree changes nothing. -/
  theorem normalize_idempotent : (value : Value) → normalize (normalize value) = normalize value
    | .null => rfl
    | .bool _ => rfl
    | .num _ => rfl
    | .str _ => rfl
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

/-- **Canonicalization is idempotent.** A normalized tree serializes to the text its source serializes to. -/
theorem canonicalize_idempotent (options : Options) (value : Value) :
    canonicalizeWith options (normalize value) = canonicalizeWith options value := by
  simp [canonicalizeWith, normalize_idempotent]

mutual
  /-- Every object in the tree has its members in key order. -/
  def Canonical : Value → Prop
    | .arr items => CanonicalItems items
    | .obj members => Sorted members ∧ CanonicalMembers members
    | _ => True

  def CanonicalItems : Items → Prop
    | .nil => True
    | .cons head tail => Canonical head ∧ CanonicalItems tail

  def CanonicalMembers : Members → Prop
    | .nil => True
    | .cons _ value tail => Canonical value ∧ CanonicalMembers tail
end

theorem canonicalMembers_insert (key : Text) (value : Value) (canonical : Canonical value) :
    (members : Members) → CanonicalMembers members → CanonicalMembers (insertMember key value members)
  | .nil, _ => ⟨canonical, trivial⟩
  | .cons _ _ rest, h => by
    simp only [insertMember]
    split
    · exact ⟨h.1, canonicalMembers_insert key value canonical rest h.2⟩
    · exact ⟨canonical, h⟩

theorem canonicalMembers_sort : (members : Members) → CanonicalMembers members → CanonicalMembers (sortMembers members)
  | .nil, _ => trivial
  | .cons key value rest, h => canonicalMembers_insert key value h.1 _ (canonicalMembers_sort rest h.2)

mutual
  /-- `normalize` leaves every object sorted, at every depth. -/
  theorem canonical_normalize : (value : Value) → Canonical (normalize value)
    | .null => trivial
    | .bool _ => trivial
    | .num _ => trivial
    | .str _ => trivial
    | .arr items => by simpa [normalize, Canonical] using canonicalItems_normalize items
    | .obj members => by
      simp only [normalize, Canonical]
      exact ⟨sorted_sortMembers _, canonicalMembers_sort _ (canonicalMembers_normalize members)⟩

  theorem canonicalItems_normalize : (items : Items) → CanonicalItems (normalizeItems items)
    | .nil => trivial
    | .cons head tail => ⟨canonical_normalize head, canonicalItems_normalize tail⟩

  theorem canonicalMembers_normalize : (members : Members) → CanonicalMembers (normalizeMembers members)
    | .nil => trivial
    | .cons _ value tail => ⟨canonical_normalize value, canonicalMembers_normalize tail⟩
end

mutual
  /-- A tree whose objects are all sorted is its own normal form. -/
  theorem normalize_of_canonical : (value : Value) → Canonical value → normalize value = value
    | .null, _ => rfl
    | .bool _, _ => rfl
    | .num _, _ => rfl
    | .str _, _ => rfl
    | .arr items, h => by
      simp only [Canonical] at h
      simp [normalize, normalizeItems_of_canonical items h]
    | .obj members, h => by
      simp only [Canonical] at h
      simp [normalize, normalizeMembers_of_canonical members h.2, sortMembers_of_sorted members h.1]

  theorem normalizeItems_of_canonical : (items : Items) → CanonicalItems items → normalizeItems items = items
    | .nil, _ => rfl
    | .cons head tail, h => by
      simp [normalizeItems, normalize_of_canonical head h.1, normalizeItems_of_canonical tail h.2]

  theorem normalizeMembers_of_canonical :
      (members : Members) → CanonicalMembers members → normalizeMembers members = members
    | .nil, _ => rfl
    | .cons _ value tail, h => by
      simp [normalizeMembers, normalize_of_canonical value h.1, normalizeMembers_of_canonical tail h.2]
end

-- Encoded strings -----------------------------------------------------------------------------------------------------

theorem wellFormed_of_bodyBytes :
    (pending : Bool) → (text : Text) → (bytes : Nat) → bodyBytesFrom pending text = some bytes →
      wellFormedFrom pending text = true
  | true, [], _, h => by simp [bodyBytesFrom] at h
  | false, [], _, _ => rfl
  | true, unit :: rest, _, h => by
    simp only [bodyBytesFrom] at h
    split at h
    · next low =>
      cases hrest : bodyBytesFrom false rest with
      | none => simp [hrest] at h
      | some body => simp [wellFormedFrom, low, wellFormed_of_bodyBytes false rest body hrest]
    · simp at h
  | false, unit :: rest, bytes, h => by
    simp only [bodyBytesFrom] at h
    split at h
    · next high => simp [wellFormedFrom, high, wellFormed_of_bodyBytes true rest bytes h]
    · next notHigh =>
      split at h
      · simp at h
      · next notLow =>
        cases hrest : bodyBytesFrom false rest with
        | none => simp [hrest] at h
        | some body => simp [wellFormedFrom, notHigh, notLow, wellFormed_of_bodyBytes false rest body hrest]

/-- **A counted text is sound.** It is well formed, and its count is within the maximum. -/
theorem encodedStringBytes_sound (text : Text) (maximum : Option Nat) (bytes : Nat)
    (counted : encodedStringBytes text maximum = some bytes) :
    wellFormed text = true ∧ within bytes maximum = true ∧ encodedStringBytes text none = some bytes := by
  simp only [encodedStringBytes] at counted ⊢
  cases hbody : bodyBytesFrom false text with
  | none => simp [hbody] at counted
  | some body =>
    simp only [hbody] at counted ⊢
    split at counted
    · next inside =>
      simp only [Option.some.injEq] at counted
      subst counted
      exact ⟨wellFormed_of_bodyBytes false text body hbody, inside, by simp [within]⟩
    · simp at counted

-- Bound soundness: plain admission ------------------------------------------------------------------------------------

/-- What the walk has counted is inside the byte and value limits. -/
def Inside (limits : Limits) (counters : Counters) : Prop :=
  within counters.bytes limits.maxBytes = true ∧ counters.nodes ≤ limits.maxNodes

theorem addBytes_ok {limits : Limits} {path : List Segment} {count : Nat} {counters next : Counters}
    (h : addBytes limits path count counters = .ok next) :
    next.bytes = counters.bytes + count ∧ next.nodes = counters.nodes ∧
      within next.bytes limits.maxBytes = true := by
  simp only [addBytes] at h
  split at h
  · next inside =>
    simp only [Except.ok.injEq] at h
    subst h
    exact ⟨rfl, rfl, inside⟩
  · simp at h

theorem enter_ok {limits : Limits} {path : List Segment} {depth : Nat} {counters next : Counters}
    (h : enter limits path depth counters = .ok next) :
    next.bytes = counters.bytes ∧ next.nodes = counters.nodes + 1 ∧ next.nodes ≤ limits.maxNodes ∧
      depth ≤ limits.maxDepth := by
  simp only [enter] at h
  split at h
  · simp at h
  · split at h
    · simp at h
    · simp only [Except.ok.injEq] at h
      subst h
      refine ⟨rfl, rfl, ?_, ?_⟩ <;> first | omega | (dsimp only; omega)

theorem countMembers_ok {limits : Limits} {path : List Segment} {count : Nat} {counters next : Counters}
    (h : countMembers limits path count counters = .ok next) :
    next.bytes = counters.bytes ∧ next.nodes = counters.nodes ∧ count ≤ limits.maxMembers := by
  simp only [countMembers] at h
  split at h
  · next inside =>
    simp only [Except.ok.injEq] at h
    subst h
    simp only [Bool.and_eq_true, decide_eq_true_eq] at inside
    exact ⟨rfl, rfl, inside.1⟩
  · simp at h

theorem admitLeaf_ok {limits : Limits} {path : List Segment} {depth bytes : Nat} {counters next : Counters}
    (h : admitLeaf limits path depth bytes counters = .ok next) :
    next.bytes = counters.bytes + bytes ∧ next.nodes = counters.nodes + 1 ∧ Inside limits next ∧
      depth ≤ limits.maxDepth := by
  simp only [admitLeaf] at h
  split at h
  · simp at h
  · next entered hentered =>
    have ⟨b, n, m, d⟩ := enter_ok hentered
    have ⟨b', n', w⟩ := addBytes_ok h
    exact ⟨by omega, by omega, ⟨w, by omega⟩, d⟩

mutual
  /--
  A value the walk accepts adds exactly its `size` to the bytes and its `nodes` to the values, leaves both inside
  their limits, and is nested no deeper than `maxDepth` allows from where it sits.
  -/
  theorem admitValue_ok (limits : Limits) (preflight : Bool) :
      (value : Value) → (path : List Segment) → (depth : Nat) → (counters next : Counters) →
        admitValue limits preflight value path depth counters = .ok next →
          next.bytes = counters.bytes + size value ∧ next.nodes = counters.nodes + nodes value ∧
            Inside limits next ∧ depth + height value ≤ limits.maxDepth
    | .null, path, depth, counters, next, h => by
      simp only [admitValue] at h
      have ⟨b, n, i, d⟩ := admitLeaf_ok h
      exact ⟨by simpa [size] using b, by simpa [nodes] using n, i, by simpa [height] using d⟩
    | .bool flag, path, depth, counters, next, h => by
      simp only [admitValue] at h
      have ⟨b, n, i, d⟩ := admitLeaf_ok h
      exact ⟨by simpa [size] using b, by simpa [nodes] using n, i, by simpa [height] using d⟩
    | .num number, path, depth, counters, next, h => by
      simp only [admitValue] at h
      split at h
      · simp at h
      · next entered hentered =>
        have ⟨b, n, m, d⟩ := enter_ok hentered
        split at h
        · simp at h
        · next bytes hbytes =>
          have ⟨b', n', w⟩ := addBytes_ok h
          refine ⟨?_, ?_, ⟨w, by omega⟩, by simpa [height] using d⟩
          · simp only [size, hbytes, Option.getD_some]
            omega
          · simp only [nodes]
            omega
    | .str text, path, depth, counters, next, h => by
      simp only [admitValue] at h
      split at h
      · simp at h
      · next entered hentered =>
        have ⟨b, n, m, d⟩ := enter_ok hentered
        split at h
        · simp at h
        · next bytes hbytes =>
          have ⟨b', n', w⟩ := addBytes_ok h
          have unbounded := (encodedStringBytes_sound text _ bytes hbytes).2.2
          refine ⟨?_, ?_, ⟨w, by omega⟩, by simpa [height] using d⟩
          · simp only [size, unbounded, Option.getD_some]
            omega
          · simp only [nodes]
            omega
    | .arr items, path, depth, counters, next, h => by
      simp only [admitValue] at h
      split at h
      · simp at h
      · next entered hentered =>
        have ⟨b, n, m, d⟩ := enter_ok hentered
        split at h
        · simp at h
        · next counted hcounted =>
          have ⟨b₁, n₁, _⟩ := countMembers_ok hcounted
          split at h
          · simp at h
          · next opened hopened =>
            have ⟨b₂, n₂, w⟩ := addBytes_ok hopened
            have ⟨b₃, n₃, i, d₃⟩ :=
              admitItems_ok limits preflight items path 0 (depth + 1) opened next h ⟨w, by omega⟩ (by omega)
            refine ⟨?_, ?_, i, ?_⟩
            · simp only [size]
              omega
            · simp only [nodes]
              omega
            · simp only [height]
              omega
    | .obj members, path, depth, counters, next, h => by
      simp only [admitValue] at h
      split at h
      · simp at h
      · next entered hentered =>
        have ⟨b, n, m, d⟩ := enter_ok hentered
        split at h
        · simp at h
        · split at h
          · simp at h
          · next counted hcounted =>
            have ⟨b₁, n₁, _⟩ := countMembers_ok hcounted
            split at h
            · simp at h
            · next opened hopened =>
              have ⟨b₂, n₂, w⟩ := addBytes_ok hopened
              have ⟨b₃, n₃, i, d₃⟩ :=
                admitMembers_ok limits preflight members path (depth + 1) opened next h ⟨w, by omega⟩ (by omega)
              refine ⟨?_, ?_, i, ?_⟩
              · simp only [size]
                omega
              · simp only [nodes]
                omega
              · simp only [height]
                omega

  theorem admitItems_ok (limits : Limits) (preflight : Bool) :
      (items : Items) → (path : List Segment) → (index depth : Nat) → (counters next : Counters) →
        admitItems limits preflight items path index depth counters = .ok next →
          Inside limits counters → depth ≤ limits.maxDepth + 1 →
            next.bytes = counters.bytes + sizeItems items ∧ next.nodes = counters.nodes + nodesItems items ∧
              Inside limits next ∧ depth + heightItems items ≤ limits.maxDepth + 1
    | .nil, _, _, depth, counters, next, h, inside, shallow => by
      simp only [admitItems, Except.ok.injEq] at h
      subst h
      exact ⟨by simp [sizeItems], by simp [nodesItems], inside, by simpa [heightItems] using shallow⟩
    | .cons head tail, path, index, depth, counters, next, h, _, shallow => by
      simp only [admitItems] at h
      split at h
      · simp at h
      · next middle hmiddle =>
        have ⟨b, n, i, d⟩ := admitValue_ok limits preflight head _ depth counters middle hmiddle
        have ⟨b', n', i', d'⟩ := admitItems_ok limits preflight tail path (index + 1) depth middle next h i shallow
        refine ⟨?_, ?_, i', ?_⟩
        · simp only [sizeItems]
          omega
        · simp only [nodesItems]
          omega
        · simp only [heightItems]
          omega

  theorem admitMembers_ok (limits : Limits) (preflight : Bool) :
      (members : Members) → (path : List Segment) → (depth : Nat) → (counters next : Counters) →
        admitMembers limits preflight members path depth counters = .ok next →
          Inside limits counters → depth ≤ limits.maxDepth + 1 →
            next.bytes = counters.bytes + sizeMembers members ∧
              next.nodes = counters.nodes + nodesMembers members ∧
                Inside limits next ∧ depth + heightMembers members ≤ limits.maxDepth + 1
    | .nil, _, depth, counters, next, h, inside, shallow => by
      simp only [admitMembers, Except.ok.injEq] at h
      subst h
      exact ⟨by simp [sizeMembers], by simp [nodesMembers], inside, by simpa [heightMembers] using shallow⟩
    | .cons key value tail, path, depth, counters, next, h, _, shallow => by
      simp only [admitMembers] at h
      split at h
      · simp at h
      · next bytes hbytes =>
        have unbounded := (encodedStringBytes_sound key _ bytes hbytes).2.2
        split at h
        · simp at h
        · next keyed hkeyed =>
          have ⟨b₀, n₀, _⟩ := addBytes_ok hkeyed
          split at h
          · simp at h
          · next middle hmiddle =>
            have ⟨b, n, i, d⟩ := admitValue_ok limits preflight value _ depth keyed middle hmiddle
            have ⟨b', n', i', d'⟩ := admitMembers_ok limits preflight tail path depth middle next h i shallow
            refine ⟨?_, ?_, i', ?_⟩
            · simp only [sizeMembers, unbounded, Option.getD_some]
              omega
            · simp only [nodesMembers]
              omega
            · simp only [heightMembers]
              omega
end

/--
**Bound soundness.** The count `admitJson` returns for an accepted tree is exactly the tree's encoded size, and that
size, the tree's value count and its nesting are inside `maxBytes`, `maxNodes` and `maxDepth`.
-/
theorem admitJson_sound (limits : Limits) (preflight : Bool) (value : Value) (bytes : Nat)
    (accepted : admitJson limits preflight value = .ok bytes) :
    bytes = size value ∧ within (size value) limits.maxBytes = true ∧ nodes value ≤ limits.maxNodes ∧
      height value ≤ limits.maxDepth := by
  simp only [admitJson] at accepted
  split at accepted
  · simp at accepted
  · next counters walked =>
    simp only [Except.ok.injEq] at accepted
    have ⟨b, n, i, d⟩ := admitValue_ok limits preflight value [] 0 .zero counters walked
    simp only [Counters.zero, Nat.zero_add] at b n d
    subst accepted
    exact ⟨b, by simpa [b] using i.1, by simpa [n] using i.2, d⟩

-- Bound soundness: `admitStrict` --------------------------------------------------------------------------------------

/-- What an object's keys cost: each key's encoded bytes and its colon. -/
def keyBytes : Members → Nat
  | .nil => 0
  | .cons key _ tail => (encodedStringBytes key none).getD 0 + 1 + keyBytes tail

/-- What an object's member values cost. -/
def valueBytes : Members → Nat
  | .nil => 0
  | .cons _ value tail => size value + valueBytes tail

theorem sizeMembers_split : (members : Members) → sizeMembers members = keyBytes members + valueBytes members
  | .nil => rfl
  | .cons _ _ tail => by
    simp only [sizeMembers, keyBytes, valueBytes, sizeMembers_split tail]
    omega

/-- What the strict walk has counted is inside the byte and value limits. -/
def StrictInside (limits : StrictLimits) (counters : Counters) : Prop :=
  counters.bytes ≤ limits.maxBytes ∧ counters.nodes ≤ limits.maxNodes

theorem strictBytes_ok {limits : StrictLimits} {path : List Segment} {count : Nat} {counters next : Counters}
    (h : strictBytes limits path count counters = .ok next) :
    next.bytes = counters.bytes + count ∧ next.nodes = counters.nodes ∧ next.bytes ≤ limits.maxBytes := by
  simp only [strictBytes] at h
  split at h
  · next inside =>
    simp only [Except.ok.injEq] at h
    subst h
    exact ⟨rfl, rfl, inside⟩
  · simp at h

theorem strictEnter_ok {limits : StrictLimits} {path : List Segment} {counters next : Counters}
    (h : strictEnter limits path counters = .ok next) :
    next.bytes = counters.bytes ∧ next.nodes = counters.nodes + 1 ∧ next.nodes ≤ limits.maxNodes := by
  simp only [strictEnter] at h
  split at h
  · simp at h
  · simp only [Except.ok.injEq] at h
    subst h
    refine ⟨rfl, rfl, ?_⟩
    first | omega | (dsimp only; omega)

theorem strictOpen_ok {limits : StrictLimits} {path : List Segment} {depth count : Nat} {counters next : Counters}
    (h : strictOpen limits path depth count counters = .ok next) :
    next.bytes = counters.bytes ∧ next.nodes = counters.nodes ∧ depth < limits.maxDepth := by
  simp only [strictOpen] at h
  split at h
  · simp at h
  · split at h
    · simp only [Except.ok.injEq] at h
      subst h
      exact ⟨rfl, rfl, by omega⟩
    · simp at h

/-- Keys that pass add exactly their encoded bytes and colons to the running total. -/
theorem strictKeys_ok (limits : StrictLimits) (boundedText : Bool) (path : List Segment) :
    (members : Members) → (index total result : Nat) →
      strictKeys limits boundedText path members index total = .ok result → result = total + keyBytes members
  | .nil, _, _, _, h => by
    simp only [strictKeys, Except.ok.injEq] at h
    simp [keyBytes, h]
  | .cons key _ tail, index, total, result, h => by
    simp only [strictKeys] at h
    split at h
    · simp at h
    · split at h
      · simp at h
      · next bytes hbytes =>
        split at h
        · simp at h
        · split at h
          · simp at h
          · split at h
            · simp at h
            · have := strictKeys_ok limits boundedText path tail _ _ _ h
              simp only [keyBytes, hbytes, Option.getD_some]
              omega

mutual
  /--
  A value the strict walk accepts adds exactly its `size` and its `nodes`, leaves both inside their limits, and is
  nested no deeper than `maxDepth` allows from where it sits.
  -/
  theorem strictValue_ok (limits : StrictLimits) (boundedText : Bool) :
      (value : Value) → (path : List Segment) → (depth : Nat) → (counters next : Counters) →
        strictValue limits boundedText value path depth counters = .ok next → depth ≤ limits.maxDepth →
          next.bytes = counters.bytes + size value ∧ next.nodes = counters.nodes + nodes value ∧
            StrictInside limits next ∧ depth + height value ≤ limits.maxDepth
    | .null, path, depth, counters, next, h, shallow => by
      simp only [strictValue] at h
      split at h
      · simp at h
      · next entered hentered =>
        have ⟨b, n, m⟩ := strictEnter_ok hentered
        have ⟨b', n', w⟩ := strictBytes_ok h
        exact ⟨by simp only [size]; omega, by simp only [nodes]; omega, ⟨w, by omega⟩, by simpa [height] using shallow⟩
    | .bool flag, path, depth, counters, next, h, shallow => by
      simp only [strictValue] at h
      split at h
      · simp at h
      · next entered hentered =>
        have ⟨b, n, m⟩ := strictEnter_ok hentered
        have ⟨b', n', w⟩ := strictBytes_ok h
        exact ⟨by simp only [size]; omega, by simp only [nodes]; omega, ⟨w, by omega⟩, by simpa [height] using shallow⟩
    | .num number, path, depth, counters, next, h, shallow => by
      simp only [strictValue] at h
      split at h
      · simp at h
      · next entered hentered =>
        have ⟨b, n, m⟩ := strictEnter_ok hentered
        split at h
        · simp at h
        · next bytes hbytes =>
          have ⟨b', n', w⟩ := strictBytes_ok h
          refine ⟨?_, ?_, ⟨w, by omega⟩, by simpa [height] using shallow⟩
          · simp only [size, hbytes, Option.getD_some]
            omega
          · simp only [nodes]
            omega
    | .str text, path, depth, counters, next, h, shallow => by
      simp only [strictValue] at h
      split at h
      · simp at h
      · next entered hentered =>
        have ⟨b, n, m⟩ := strictEnter_ok hentered
        split at h
        · simp at h
        · split at h
          · simp at h
          · next bytes hbytes =>
            split at h
            · simp at h
            · have ⟨b', n', w⟩ := strictBytes_ok h
              refine ⟨?_, ?_, ⟨w, by omega⟩, by simpa [height] using shallow⟩
              · simp only [size, hbytes, Option.getD_some]
                omega
              · simp only [nodes]
                omega
    | .arr items, path, depth, counters, next, h, _ => by
      simp only [strictValue] at h
      split at h
      · simp at h
      · next entered hentered =>
        have ⟨b, n, m⟩ := strictEnter_ok hentered
        split at h
        · simp at h
        · next counted hcounted =>
          have ⟨b₁, n₁, d₁⟩ := strictOpen_ok hcounted
          split at h
          · simp at h
          · next opened hopened =>
            have ⟨b₂, n₂, w⟩ := strictBytes_ok hopened
            have ⟨b₃, n₃, i, d₃⟩ :=
              strictItems_ok limits boundedText items path 0 (depth + 1) opened next h ⟨w, by omega⟩ (by omega)
            refine ⟨?_, ?_, i, ?_⟩
            · simp only [size]
              omega
            · simp only [nodes]
              omega
            · simp only [height]
              omega
    | .obj members, path, depth, counters, next, h, _ => by
      simp only [strictValue] at h
      split at h
      · simp at h
      · next entered hentered =>
        have ⟨b, n, m⟩ := strictEnter_ok hentered
        split at h
        · simp at h
        · next counted hcounted =>
          have ⟨b₁, n₁, d₁⟩ := strictOpen_ok hcounted
          split at h
          · simp at h
          · next keys hkeys =>
            have total := strictKeys_ok limits boundedText path members _ _ _ hkeys
            split at h
            · simp at h
            · next opened hopened =>
              have ⟨b₂, n₂, w⟩ := strictBytes_ok hopened
              have ⟨b₃, n₃, i, d₃⟩ :=
                strictMembers_ok limits boundedText members path (depth + 1) opened next h ⟨w, by omega⟩ (by omega)
              refine ⟨?_, ?_, i, ?_⟩
              · simp only [size, sizeMembers_split]
                omega
              · simp only [nodes]
                omega
              · simp only [height]
                omega

  theorem strictItems_ok (limits : StrictLimits) (boundedText : Bool) :
      (items : Items) → (path : List Segment) → (index depth : Nat) → (counters next : Counters) →
        strictItems limits boundedText items path index depth counters = .ok next →
          StrictInside limits counters → depth ≤ limits.maxDepth →
            next.bytes = counters.bytes + sizeItems items ∧ next.nodes = counters.nodes + nodesItems items ∧
              StrictInside limits next ∧ depth + heightItems items ≤ limits.maxDepth + 1
    | .nil, _, _, depth, counters, next, h, inside, shallow => by
      simp only [strictItems, Except.ok.injEq] at h
      subst h
      exact ⟨by simp [sizeItems], by simp [nodesItems], inside, by simp only [heightItems]; omega⟩
    | .cons head tail, path, index, depth, counters, next, h, _, shallow => by
      simp only [strictItems] at h
      split at h
      · simp at h
      · next middle hmiddle =>
        have ⟨b, n, i, d⟩ := strictValue_ok limits boundedText head _ depth counters middle hmiddle shallow
        have ⟨b', n', i', d'⟩ :=
          strictItems_ok limits boundedText tail path (index + 1) depth middle next h i shallow
        refine ⟨?_, ?_, i', ?_⟩
        · simp only [sizeItems]
          omega
        · simp only [nodesItems]
          omega
        · simp only [heightItems]
          omega

  theorem strictMembers_ok (limits : StrictLimits) (boundedText : Bool) :
      (members : Members) → (path : List Segment) → (depth : Nat) → (counters next : Counters) →
        strictMembers limits boundedText members path depth counters = .ok next →
          StrictInside limits counters → depth ≤ limits.maxDepth →
            next.bytes = counters.bytes + valueBytes members ∧
              next.nodes = counters.nodes + nodesMembers members ∧
                StrictInside limits next ∧ depth + heightMembers members ≤ limits.maxDepth + 1
    | .nil, _, depth, counters, next, h, inside, shallow => by
      simp only [strictMembers, Except.ok.injEq] at h
      subst h
      exact ⟨by simp [valueBytes], by simp [nodesMembers], inside, by simp only [heightMembers]; omega⟩
    | .cons key value tail, path, depth, counters, next, h, _, shallow => by
      simp only [strictMembers] at h
      split at h
      · simp at h
      · next middle hmiddle =>
        have ⟨b, n, i, d⟩ := strictValue_ok limits boundedText value _ depth counters middle hmiddle shallow
        have ⟨b', n', i', d'⟩ := strictMembers_ok limits boundedText tail path depth middle next h i shallow
        refine ⟨?_, ?_, i', ?_⟩
        · simp only [valueBytes]
          omega
        · simp only [nodesMembers]
          omega
        · simp only [heightMembers]
          omega
end

/--
**Strict bound soundness.** A tree `admitStrict` accepts has an encoded size inside `maxBytes`, a value count inside
`maxNodes` and nesting inside `maxDepth`.
-/
theorem admitStrict_sound (limits : StrictLimits) (boundedText : Bool) (value : Value) (counters : Counters)
    (accepted : admitStrict limits boundedText value = .ok counters) :
    size value ≤ limits.maxBytes ∧ nodes value ≤ limits.maxNodes ∧ height value ≤ limits.maxDepth := by
  have ⟨b, n, i, d⟩ := strictValue_ok limits boundedText value [] 0 .zero counters accepted (Nat.zero_le _)
  simp only [Counters.zero, Nat.zero_add] at b n d
  exact ⟨by simpa [b] using i.1, by simpa [n] using i.2, d⟩

end CanonicalSpec

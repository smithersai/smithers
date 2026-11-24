import ChainSpec.JsonBoundary
import ChainSpec.Authz
import ChainSpec.Replay

namespace ChainSpec

-- --- well-formed text ----------------------------------------------------------------------------------------------

theorem isWellFormed_sound : ∀ (text : Text), isWellFormed text = true → WellFormed text
  | [], _ => .nil
  | [unit], h => by
    unfold isWellFormed at h
    by_cases high : isHigh unit = true
    · simp [high] at h
    · by_cases low : isLow unit = true
      · simp [high, low] at h
      · exact .scalar unit [] (by simpa using high) (by simpa using low) .nil
  | unit :: next :: tail, h => by
    unfold isWellFormed at h
    by_cases high : isHigh unit = true
    · by_cases low : isLow next = true
      · simp [high, low] at h
        exact .pair unit next tail high low (isWellFormed_sound tail h)
      · simp [high, low] at h
    · by_cases low : isLow unit = true
      · simp [high, low] at h
      · simp [high, low] at h
        exact .scalar unit (next :: tail) (by simpa using high) (by simpa using low)
          (isWellFormed_sound (next :: tail) h)

theorem isWellFormed_complete {text : Text} (h : WellFormed text) : isWellFormed text = true := by
  induction h with
  | nil => rfl
  | scalar unit rest high low _ ih => unfold isWellFormed; simp [high, low, ih]
  | pair high low rest hh hl _ ih => unfold isWellFormed; simp [hh, hl, ih]

/-- `isWellFormed` decides Unicode text exactly: scalars outside the surrogate range and high-low pairs. -/
theorem isWellFormed_iff (text : Text) : isWellFormed text = true ↔ WellFormed text :=
  ⟨isWellFormed_sound text, isWellFormed_complete⟩

-- --- the walk is the declarative boundary --------------------------------------------------------------------------

mutual
  theorem walk_eq : ∀ (value : Js) (depth budget : Nat),
      walk depth value budget =
        if valid depth value = true ∧ cost value ≤ budget then some (norm value, budget - cost value) else none
    | .undefined, _, _ => by simp [walk, valid]
    | .exotic, _, _ => by simp [walk, valid]
    | .cycle, _, _ => by simp [walk, valid]
    | .null, depth, budget => by
      simp only [walk, valid, cost, norm, enter, spend]
      by_cases hd : depth ≤ maxJsonDepth <;> by_cases hb : 1 ≤ budget <;> simp [hd, hb]
    | .bool _, depth, budget => by
      simp only [walk, valid, cost, norm, enter, spend]
      by_cases hd : depth ≤ maxJsonDepth <;> by_cases hb : 1 ≤ budget <;> simp [hd, hb]
    | .num bits, depth, budget => by
      simp only [walk, valid, cost, norm, enter, spend]
      by_cases hd : depth ≤ maxJsonDepth <;> by_cases hb : 1 ≤ budget <;>
        by_cases hf : isFiniteBits bits = true <;> simp [hd, hb, hf]
    | .str text, depth, budget => by
      simp only [walk, valid, cost, norm, enter, spend]
      by_cases hd : depth ≤ maxJsonDepth <;> by_cases hb : 1 ≤ budget <;>
        by_cases hl : text.length ≤ budget - 1 <;>
        by_cases hw : isWellFormed text = true <;> simp [hd, hb, hl, hw] <;> omega
    | .arr items, depth, budget => by
      simp only [walk, valid, cost, norm, enter, spend, walkItems_eq items]
      by_cases hd : depth ≤ maxJsonDepth <;> by_cases hb : 1 ≤ budget <;>
        by_cases hv : validItems (depth + 1) items = true <;>
        by_cases hc : costItems items ≤ budget - 1 <;> simp [hd, hb, hv, hc] <;> omega
    | .obj plain fields, depth, budget => by
      simp only [walk, valid, cost, norm, enter, spend, walkFields_eq fields]
      by_cases hd : depth ≤ maxJsonDepth <;> by_cases hb : 1 ≤ budget <;>
        by_cases hp : (plain && !hasDuplicate (keysOf fields)) = true <;>
        by_cases hv : validFields (depth + 1) fields = true <;>
        by_cases hc : costFields fields ≤ budget - 1 <;> simp [hd, hb, hp, hv, hc] <;> omega

  theorem walkItems_eq : ∀ (items : Items) (depth budget : Nat),
      walkItems depth items budget =
        if validItems depth items = true ∧ costItems items ≤ budget then
          some (normItems items, budget - costItems items)
        else none
    | .nil, _, _ => by simp [walkItems, validItems, costItems, normItems]
    | .cons head tail, depth, budget => by
      simp only [walkItems, validItems, costItems, normItems, walk_eq head, walkItems_eq tail]
      by_cases hv : valid depth head = true <;> by_cases hc : cost head ≤ budget <;>
        by_cases hvt : validItems depth tail = true <;>
        by_cases hct : costItems tail ≤ budget - cost head <;> simp [hv, hc, hvt, hct] <;> omega

  theorem walkFields_eq : ∀ (fields : Fields) (depth budget : Nat),
      walkFields depth fields budget =
        if validFields depth fields = true ∧ costFields fields ≤ budget then
          some (normFields fields, budget - costFields fields)
        else none
    | .nil, _, _ => by simp [walkFields, validFields, costFields, normFields]
    | .cons key value tail, depth, budget => by
      simp only [walkFields, validFields, costFields, normFields, spend, walk_eq value, walkFields_eq tail]
      by_cases hk : key.length ≤ budget <;> by_cases hw : isWellFormed key = true <;>
        by_cases hv : valid depth value = true <;> by_cases hc : cost value ≤ budget - key.length <;>
        by_cases hvt : validFields depth tail = true <;>
        by_cases hct : costFields tail ≤ budget - key.length - cost value <;>
        simp [hk, hw, hv, hc, hvt, hct] <;> omega
end

/-- The walk spends exactly the cost of what it copies, and the copy costs what the value did. -/
theorem walk_spends_cost {value copied : Js} {depth budget rest : Nat}
    (h : walk depth value budget = some (copied, rest)) :
    rest + cost value = budget ∧ copied = norm value ∧ valid depth value = true := by
  rw [walk_eq] at h
  split at h
  · rename_i ok
    simp only [Option.some.injEq, Prod.mk.injEq] at h
    exact ⟨by omega, h.1.symm, ok.1⟩
  · simp at h

theorem boundaryWith_eq (budget : Nat) (value : Js) :
    boundaryWith budget value =
      if valid 0 (whole value) = true ∧ cost (whole value) ≤ budget then some (norm (whole value)) else none := by
  simp only [boundaryWith, walk_eq]
  split <;> simp

-- --- the copy -----------------------------------------------------------------------------------------------------

theorem normalizeZero_idempotent (bits : Nat) : normalizeZero (normalizeZero bits) = normalizeZero bits := by
  unfold normalizeZero
  by_cases h : bits = negativeZero
  · simp [h]
  · simp [h]

theorem isFiniteBits_normalizeZero (bits : Nat) : isFiniteBits (normalizeZero bits) = isFiniteBits bits := by
  unfold normalizeZero
  by_cases h : bits = negativeZero
  · subst h; decide
  · simp [h]

theorem normalizeZero_ne_negativeZero (bits : Nat) : (normalizeZero bits == negativeZero) = false := by
  unfold normalizeZero
  by_cases h : bits = negativeZero
  · simp [h]; decide
  · simp [h]

theorem keysOf_normFields : ∀ (fields : Fields), keysOf (normFields fields) = keysOf fields
  | .nil => rfl
  | .cons _ _ tail => by simp [normFields, keysOf, keysOf_normFields tail]

mutual
  theorem valid_norm : ∀ (value : Js) (depth : Nat), valid depth (norm value) = valid depth value
    | .undefined, _ => rfl
    | .exotic, _ => rfl
    | .cycle, _ => rfl
    | .null, _ => rfl
    | .bool _, _ => rfl
    | .str _, _ => rfl
    | .num bits, _ => by simp [norm, valid, isFiniteBits_normalizeZero]
    | .arr items, depth => by simp [norm, valid, validItems_norm items]
    | .obj _ fields, depth => by
      simp [norm, valid, validFields_norm fields, keysOf_normFields]

  theorem validItems_norm : ∀ (items : Items) (depth : Nat), validItems depth (normItems items) = validItems depth items
    | .nil, _ => rfl
    | .cons head tail, depth => by simp [normItems, validItems, valid_norm head, validItems_norm tail]

  theorem validFields_norm :
      ∀ (fields : Fields) (depth : Nat), validFields depth (normFields fields) = validFields depth fields
    | .nil, _ => rfl
    | .cons _ value tail, depth => by simp [normFields, validFields, valid_norm value, validFields_norm tail]
end

mutual
  theorem cost_norm : ∀ (value : Js), cost (norm value) = cost value
    | .undefined => rfl
    | .exotic => rfl
    | .cycle => rfl
    | .null => rfl
    | .bool _ => rfl
    | .str _ => rfl
    | .num _ => rfl
    | .arr items => by simp [norm, cost, costItems_norm items]
    | .obj _ fields => by simp [norm, cost, costFields_norm fields]

  theorem costItems_norm : ∀ (items : Items), costItems (normItems items) = costItems items
    | .nil => rfl
    | .cons head tail => by simp [normItems, costItems, cost_norm head, costItems_norm tail]

  theorem costFields_norm : ∀ (fields : Fields), costFields (normFields fields) = costFields fields
    | .nil => rfl
    | .cons _ value tail => by simp [normFields, costFields, cost_norm value, costFields_norm tail]
end

mutual
  theorem norm_norm : ∀ (value : Js), norm (norm value) = norm value
    | .undefined => rfl
    | .exotic => rfl
    | .cycle => rfl
    | .null => rfl
    | .bool _ => rfl
    | .str _ => rfl
    | .num bits => by simp [norm, normalizeZero_idempotent]
    | .arr items => by simp [norm, normItems_norm items]
    | .obj _ fields => by simp [norm, normFields_norm fields]

  theorem normItems_norm : ∀ (items : Items), normItems (normItems items) = normItems items
    | .nil => rfl
    | .cons head tail => by simp [normItems, norm_norm head, normItems_norm tail]

  theorem normFields_norm : ∀ (fields : Fields), normFields (normFields fields) = normFields fields
    | .nil => rfl
    | .cons _ value tail => by simp [normFields, norm_norm value, normFields_norm tail]
end

mutual
  theorem norm_holds_no_negativeZero : ∀ (value : Js), holdsNegativeZero (norm value) = false
    | .undefined => rfl
    | .exotic => rfl
    | .cycle => rfl
    | .null => rfl
    | .bool _ => rfl
    | .str _ => rfl
    | .num bits => by simp only [norm, holdsNegativeZero, normalizeZero_ne_negativeZero]
    | .arr items => by simp [norm, holdsNegativeZero, normItems_hold_no_negativeZero items]
    | .obj _ fields => by simp [norm, holdsNegativeZero, normFields_hold_no_negativeZero fields]

  theorem normItems_hold_no_negativeZero : ∀ (items : Items), itemsHoldNegativeZero (normItems items) = false
    | .nil => rfl
    | .cons head tail => by
      simp [normItems, itemsHoldNegativeZero, norm_holds_no_negativeZero head, normItems_hold_no_negativeZero tail]

  theorem normFields_hold_no_negativeZero : ∀ (fields : Fields), fieldsHoldNegativeZero (normFields fields) = false
    | .nil => rfl
    | .cons _ value tail => by
      simp [normFields, fieldsHoldNegativeZero, norm_holds_no_negativeZero value,
        normFields_hold_no_negativeZero tail]
end

theorem whole_norm_whole (value : Js) : whole (norm (whole value)) = norm (whole value) := by
  cases value <;> simp [whole, norm]

-- --- the boundary ---------------------------------------------------------------------------------------------------

/-- What crossed the boundary crosses it again unchanged: the boundary is idempotent. -/
theorem boundaryWith_idempotent {budget : Nat} {value copied : Js} (h : boundaryWith budget value = some copied) :
    boundaryWith budget copied = some copied := by
  rw [boundaryWith_eq] at h
  split at h
  · rename_i ok
    simp only [Option.some.injEq] at h
    subst h
    rw [boundaryWith_eq, whole_norm_whole, valid_norm, cost_norm, norm_norm]
    simp [ok]
  · simp at h

theorem jsonBoundary_idempotent {value copied : Js} (h : jsonBoundary value = some copied) :
    jsonBoundary copied = some copied := boundaryWith_idempotent h

theorem valid_too_deep : ∀ (value : Js) (depth : Nat), maxJsonDepth < depth → valid depth value = false := by
  intro value depth deep
  cases value <;> simp [valid] <;> omega

theorem valid_nest (value : Js) : ∀ (count depth : Nat), maxJsonDepth < depth + count →
    valid depth (nest count value) = false
  | 0, depth, deep => valid_too_deep value depth (by simpa using deep)
  | count + 1, depth, deep => by
    have inner := valid_nest value count (depth + 1) (by omega)
    simp [nest, valid, validItems, inner]

/-- A node deeper than `maxJsonDepth` is refused whatever the budget. -/
theorem walk_refuses_too_deep (value : Js) (depth budget : Nat) (deep : maxJsonDepth < depth) :
    walk depth value budget = none := by
  rw [walk_eq, valid_too_deep value depth deep]
  simp

/-- A value under more than `maxJsonDepth` arrays is refused whatever it is and whatever the budget. -/
theorem boundaryWith_refuses_deep_nesting (value : Js) (count budget : Nat) (deep : maxJsonDepth < count) :
    boundaryWith budget (nest count value) = none := by
  cases count with
  | zero => simp [maxJsonDepth] at deep
  | succ count =>
    rw [boundaryWith_eq]
    have refused := valid_nest value (count + 1) 0 (by omega)
    simp only [nest] at refused
    simp [nest, whole, refused]

/-- A value accepted under a budget is accepted, with the same copy, under every larger budget. -/
theorem boundaryWith_monotone {small large : Nat} {value copied : Js} (le : small ≤ large)
    (h : boundaryWith small value = some copied) : boundaryWith large value = some copied := by
  rw [boundaryWith_eq] at h ⊢
  split at h
  · rename_i ok
    rw [if_pos ⟨ok.1, by omega⟩]
    exact h
  · simp at h

/-- A value that costs more than the budget is refused. -/
theorem boundaryWith_refuses_over_budget {budget : Nat} {value : Js} (over : budget < cost (whole value)) :
    boundaryWith budget value = none := by
  rw [boundaryWith_eq]
  have : ¬ (valid 0 (whole value) = true ∧ cost (whole value) ≤ budget) := fun ok => by omega
  simp [this]

/-- A value is accepted exactly when it is valid and costs no more than the budget. -/
theorem jsonBoundary_accepts_iff (value : Js) :
    (jsonBoundary value).isSome = true ↔ valid 0 (whole value) = true ∧ cost (whole value) ≤ maxJsonSize := by
  unfold jsonBoundary
  rw [boundaryWith_eq]
  split <;> simp_all

/-- `-0` crosses as `0`. -/
theorem jsonBoundary_negativeZero : jsonBoundary (.num negativeZero) = some (.num 0) := by
  have finite : isFiniteBits negativeZero = true := by decide
  unfold jsonBoundary
  rw [boundaryWith_eq]
  simp [whole, valid, cost, norm, normalizeZero, finite, maxJsonSize]

/-- Nothing that crossed holds a `-0`. -/
theorem boundaryWith_holds_no_negativeZero {budget : Nat} {value copied : Js}
    (h : boundaryWith budget value = some copied) : holdsNegativeZero copied = false := by
  rw [boundaryWith_eq] at h
  split at h
  · simp only [Option.some.injEq] at h
    subst h
    exact norm_holds_no_negativeZero _
  · simp at h

/-- A number that is not finite is refused. -/
theorem boundaryWith_refuses_nonFinite {budget bits : Nat} (h : isFiniteBits bits = false) :
    boundaryWith budget (.num bits) = none := by
  rw [boundaryWith_eq]; simp [whole, valid, h]

/-- A string holding an unpaired surrogate is refused. -/
theorem boundaryWith_refuses_unpaired {budget : Nat} {text : Text} (h : isWellFormed text = false) :
    boundaryWith budget (.str text) = none := by
  rw [boundaryWith_eq]; simp [whole, valid, h]

/-- An object whose prototype is neither `Object.prototype` nor `null` is refused. -/
theorem boundaryWith_refuses_prototype (budget : Nat) (fields : Fields) :
    boundaryWith budget (.obj false fields) = none := by
  rw [boundaryWith_eq]; simp [whole, valid]

/-- An object offering one key twice is refused. -/
theorem boundaryWith_refuses_duplicate {budget : Nat} {plain : Bool} {fields : Fields}
    (h : hasDuplicate (keysOf fields) = true) : boundaryWith budget (.obj plain fields) = none := by
  rw [boundaryWith_eq]; simp [whole, valid, h]

/-- A cycle, wherever the walk meets it, is refused. -/
theorem walk_refuses_cycle (depth budget : Nat) : walk depth .cycle budget = none := by
  simp [walk]

-- --- the order of effects ------------------------------------------------------------------------------------------

theorem Effect.le_def (left right : Effect) : left ≤ right ↔ left.rank ≤ right.rank := Iff.rfl

theorem Effect.le_refl (effect : Effect) : effect ≤ effect := Nat.le_refl _

theorem Effect.le_trans {a b c : Effect} (ab : a ≤ b) (bc : b ≤ c) : a ≤ c := Nat.le_trans ab bc

theorem Effect.deny_le (effect : Effect) : Effect.deny ≤ effect := Nat.zero_le _

theorem Effect.le_allow (effect : Effect) : effect ≤ Effect.allow := by
  cases effect <;> simp [Effect.le_def, Effect.rank]

theorem Effect.meet_comm (a b : Effect) : a.meet b = b.meet a := by
  cases a <;> cases b <;> rfl

theorem Effect.meet_left_comm (a b c : Effect) : a.meet (b.meet c) = b.meet (a.meet c) := by
  cases a <;> cases b <;> cases c <;> rfl

theorem Effect.meet_allow (a : Effect) : Effect.allow.meet a = a := by
  cases a <;> rfl

theorem Effect.meet_deny (a : Effect) : a.meet .deny = .deny := by
  cases a <;> rfl

theorem Effect.deny_meet (a : Effect) : Effect.deny.meet a = .deny := by
  cases a <;> rfl

theorem Effect.meet_le_left (a b : Effect) : a.meet b ≤ a := by
  cases a <;> cases b <;> simp [Effect.le_def, Effect.meet, Effect.rank]

theorem Effect.meet_le_right (a b : Effect) : a.meet b ≤ b := by
  cases a <;> cases b <;> simp [Effect.le_def, Effect.meet, Effect.rank]

theorem Effect.meet_mono {a a' b b' : Effect} (ha : a ≤ a') (hb : b ≤ b') : a.meet b ≤ a'.meet b' := by
  cases a <;> cases a' <;> cases b <;> cases b' <;> simp_all [Effect.le_def, Effect.meet, Effect.rank]

theorem Effect.meet_eq_allow {a b : Effect} (h : a.meet b = .allow) : a = .allow ∧ b = .allow := by
  cases a <;> cases b <;> simp_all [Effect.meet, Effect.rank]

-- --- the loop is the lattice ---------------------------------------------------------------------------------------

theorem worstVerdict_cons (rules : List Rule) (declared : Text) (rest : List Text) :
    worstVerdict rules (declared :: rest) = (claimVerdict rules declared).meet (worstVerdict rules rest) := rfl

theorem decideClaims_effect (rules : List Rule) : ∀ (claims : List Text) (asking : Option Text),
    (decideClaims rules claims asking).effect =
      (match asking with
        | none => Effect.allow
        | some _ => Effect.ask).meet (worstVerdict rules claims)
  | [], none => rfl
  | [], some _ => rfl
  | declared :: rest, asking => by
    rw [worstVerdict_cons]
    unfold decideClaims
    cases verdict : claimVerdict rules declared with
    | deny => cases asking <;> simp [Decision.effect, Effect.deny_meet] <;> rfl
    | allow =>
      simp only [decideClaims_effect rules rest asking, Effect.meet_allow]
    | ask =>
      simp only [decideClaims_effect rules rest (some (asking.getD declared))]
      cases asking <;> cases worstVerdict rules rest <;> rfl

/--
The seam's verdict is the most restrictive verdict among its claims: the early exit on a denial and the remembered
first asking claim compute the meet of the lattice `deny < ask < allow`.
-/
theorem authorize_effect (rules : List Rule) (claims : List Text) :
    (authorize rules claims).effect = worstVerdict rules (effectiveClaims claims) := by
  unfold authorize
  rw [decideClaims_effect]
  exact Effect.meet_allow _

/-- The verdict is a function of the rules and the claims and of nothing else. -/
theorem authorize_deterministic (rules : List Rule) (claims : List Text) (first second : Decision)
    (h₁ : first = authorize rules claims) (h₂ : second = authorize rules claims) : first = second := by
  rw [h₁, h₂]

theorem effectiveClaims_ne_nil (claims : List Text) : effectiveClaims claims ≠ [] := by
  unfold effectiveClaims
  cases claims <;> simp

theorem effectiveClaims_of_ne_nil {claims : List Text} (h : claims ≠ []) : effectiveClaims claims = claims := by
  unfold effectiveClaims
  cases claims <;> simp_all

theorem worstVerdict_not_allow {rules : List Rule} {claims : List Text} {declared : Text}
    (member : declared ∈ claims) (h : claimVerdict rules declared ≠ .allow) :
    worstVerdict rules claims ≠ .allow := by
  induction claims with
  | nil => cases member
  | cons head rest ih =>
    rw [worstVerdict_cons]
    intro allowed
    have both := Effect.meet_eq_allow allowed
    cases member with
    | head => exact h both.1
    | tail _ inRest => exact ih inRest both.2

theorem worstVerdict_deny {rules : List Rule} {claims : List Text} {declared : Text}
    (member : declared ∈ claims) (h : claimVerdict rules declared = .deny) :
    worstVerdict rules claims = .deny := by
  induction claims with
  | nil => cases member
  | cons head rest ih =>
    rw [worstVerdict_cons]
    cases member with
    | head => rw [h]; exact Effect.deny_meet _
    | tail _ inRest => rw [ih inRest]; exact Effect.meet_deny _

-- --- fail closed ---------------------------------------------------------------------------------------------------

theorem claimVerdict_no_rules (declared : Text) : claimVerdict [] declared ≠ .allow := by
  unfold claimVerdict
  split
  · simp
  · split
    · unfold evaluateExact
      split <;> simp [evaluateRules]
    · simp [evaluatePattern]

/-- With no rules nothing is allowed, whatever is claimed and however many claims there are. -/
theorem authorize_no_rules (claims : List Text) : (authorize [] claims).effect ≠ .allow := by
  rw [authorize_effect]
  cases h : effectiveClaims claims with
  | nil => exact absurd h (effectiveClaims_ne_nil claims)
  | cons head rest => exact worstVerdict_not_allow (List.mem_cons_self) (claimVerdict_no_rules head)

/-- A claim that does not parse is never allowed, whatever the rules. -/
theorem authorize_unparseable {rules : List Rule} {claims : List Text} {declared : Text}
    (member : declared ∈ effectiveClaims claims) (h : claimPattern declared = none) :
    (authorize rules claims).effect ≠ .allow := by
  rw [authorize_effect]
  refine worstVerdict_not_allow member ?_
  simp [claimVerdict, h]

-- --- claims --------------------------------------------------------------------------------------------------------

theorem worstVerdict_append_le (rules : List Rule) (claims extra : List Text) :
    worstVerdict rules (claims ++ extra) ≤ worstVerdict rules claims := by
  induction claims with
  | nil => exact Effect.le_allow _
  | cons head rest ih =>
    rw [List.cons_append, worstVerdict_cons, worstVerdict_cons]
    exact Effect.meet_mono (Effect.le_refl _) ih

/-- Adding claims to a request never loosens its verdict. -/
theorem authorize_add_claims (rules : List Rule) {claims : List Text} (extra : List Text) (h : claims ≠ []) :
    (authorize rules (claims ++ extra)).effect ≤ (authorize rules claims).effect := by
  rw [authorize_effect, authorize_effect, effectiveClaims_of_ne_nil h,
    effectiveClaims_of_ne_nil (by simp [h])]
  exact worstVerdict_append_le rules claims extra

theorem worstVerdict_perm (rules : List Rule) {claims reordered : List Text} (h : claims.Perm reordered) :
    worstVerdict rules claims = worstVerdict rules reordered := by
  induction h with
  | nil => rfl
  | cons head _ ih => rw [worstVerdict_cons, worstVerdict_cons, ih]
  | swap first second rest =>
    rw [worstVerdict_cons, worstVerdict_cons, worstVerdict_cons, worstVerdict_cons]
    exact Effect.meet_left_comm _ _ _
  | trans _ _ ih₁ ih₂ => exact ih₁.trans ih₂

/-- The verdict does not depend on the order the claims are declared in. -/
theorem authorize_claim_order (rules : List Rule) {claims reordered : List Text} (h : claims.Perm reordered) :
    (authorize rules claims).effect = (authorize rules reordered).effect := by
  rw [authorize_effect, authorize_effect]
  cases claims with
  | nil =>
    have : reordered = [] := List.length_eq_zero_iff.mp (by simpa using h.length_eq.symm)
    rw [this]
  | cons head rest =>
    have nonEmpty : reordered ≠ [] := by
      intro empty
      have := h.length_eq
      simp [empty] at this
    rw [effectiveClaims_of_ne_nil (by simp), effectiveClaims_of_ne_nil nonEmpty]
    exact worstVerdict_perm rules h

theorem worstVerdict_mono {tight loose : List Rule}
    (h : ∀ declared, claimVerdict tight declared ≤ claimVerdict loose declared) (claims : List Text) :
    worstVerdict tight claims ≤ worstVerdict loose claims := by
  induction claims with
  | nil => exact Effect.le_refl _
  | cons head rest ih =>
    rw [worstVerdict_cons, worstVerdict_cons]
    exact Effect.meet_mono (h head) ih

-- --- one more deny -------------------------------------------------------------------------------------------------

theorem stepExact_deny_le (capability : Pattern) (forms : List Text) (verdict : Effect) {rule : Rule}
    (h : rule.effect = .deny) : stepExact capability forms verdict rule ≤ verdict := by
  unfold stepExact
  repeat' split
  all_goals first | exact Effect.le_refl _ | (rw [h]; exact Effect.deny_le _)

theorem evaluateRules_append_deny (capability : Pattern) (forms : List Text) {rule : Rule} (h : rule.effect = .deny) :
    ∀ (rules : List Rule) (verdict : Effect),
      evaluateRules capability forms (rules ++ [rule]) verdict ≤ evaluateRules capability forms rules verdict
  | [], verdict => by
    simp only [List.nil_append, evaluateRules]
    split
    · exact stepExact_deny_le capability forms verdict h
    · exact Effect.deny_le _
  | head :: rest, verdict => by
    simp only [List.cons_append, evaluateRules]
    split
    · exact evaluateRules_append_deny capability forms h rest _
    · exact Effect.le_refl _

theorem stepPattern_deny_le (claim : Pattern) (verdict : Effect) {rule : Rule} (h : rule.effect = .deny) :
    stepPattern claim verdict rule ≤ verdict := by
  unfold stepPattern
  split
  · rw [h]; exact Effect.deny_le _
  · split
    · rw [h]; exact Effect.deny_le _
    · exact Effect.le_refl _

theorem claimVerdict_append_deny (rules : List Rule) {rule : Rule} (h : rule.effect = .deny) (declared : Text) :
    claimVerdict (rules ++ [rule]) declared ≤ claimVerdict rules declared := by
  unfold claimVerdict
  split
  · exact Effect.le_refl _
  · split
    · unfold evaluateExact
      split
      · exact Effect.le_refl _
      · exact evaluateRules_append_deny _ _ h rules .ask
    · simp only [evaluatePattern, List.foldl_append, List.foldl_cons, List.foldl_nil]
      exact stepPattern_deny_le _ _ h

/-- Appending a `deny` rule never loosens a verdict. -/
theorem authorize_append_deny (rules : List Rule) {rule : Rule} (h : rule.effect = .deny) (claims : List Text) :
    (authorize (rules ++ [rule]) claims).effect ≤ (authorize rules claims).effect := by
  rw [authorize_effect, authorize_effect]
  exact worstVerdict_mono (claimVerdict_append_deny rules h) _

-- --- deny everything -----------------------------------------------------------------------------------------------

theorem anySuffix_of_empty {holds : Text → Bool} (h : holds [] = true) : ∀ (text : Text), anySuffix holds text = true
  | [] => h
  | _ :: rest => by simp [anySuffix, anySuffix_of_empty h rest]

theorem anySuffix_of_whole {holds : Text → Bool} {text : Text} (h : holds text = true) :
    anySuffix holds text = true := by
  cases text with
  | nil => exact h
  | cons unit rest => simp [anySuffix, h]

/-- `**` matches every resource. -/
theorem glob_star_star (resource : Text) : glob [star, star] resource = true := by
  have one : ∀ text, glob [star] text = true := fun text => by
    simp only [glob, if_true]
    exact anySuffix_of_empty rfl text
  simp only [glob, if_true]
  exact anySuffix_of_whole (one resource)

theorem matchesResource_star_star {resource : Text} (h : 2 * resource.length ≤ maxMatchWork) :
    matchesResource [star, star] resource = true := by
  unfold matchesResource
  simp only [glob_star_star, Bool.or_true]
  simp
  exact h

theorem dotSegmentForms_head {action resource : Text} {forms : List Text}
    (h : dotSegmentForms action resource = some forms) : ∃ rest, forms = resource :: rest := by
  unfold dotSegmentForms at h
  split at h
  · exact ⟨[], by simpa using h.symm⟩
  · split at h
    · simp at h
    · split at h
      · simp at h
      · split at h
        · simp at h
        · exact ⟨_, by simpa using h.symm⟩

theorem matchesAction_star (action : Text) : matchesAction [star] action = true := by
  simp [matchesAction]

theorem actionSubsumes_star (action : Text) : actionSubsumes [star] action = true := by
  simp [actionSubsumes]

theorem stepExact_denyAll {capability : Pattern} {rest : List Text} (verdict : Effect)
    (h : withinMatchBudget denyAll.pattern capability = true) :
    stepExact capability (capability.resource :: rest) verdict denyAll = .deny := by
  have budget : 2 * capability.resource.length ≤ maxMatchWork := by
    simpa [withinMatchBudget, denyAll, matchesAction_star] using h
  simp [stepExact, denyAll, restricts, matchesAction_star, matchesResource_star_star budget]

theorem evaluateRules_denyAll (capability : Pattern) (rest : List Text) : ∀ (rules : List Rule) (verdict : Effect),
    evaluateRules capability (capability.resource :: rest) (rules ++ [denyAll]) verdict = .deny
  | [], verdict => by
    simp only [List.nil_append, evaluateRules]
    split
    · rename_i within
      exact stepExact_denyAll verdict within
    · rfl
  | head :: others, verdict => by
    simp only [List.cons_append, evaluateRules]
    split
    · exact evaluateRules_denyAll capability rest others _
    · rfl

theorem stepPattern_denyAll (claim : Pattern) (verdict : Effect) : stepPattern claim verdict denyAll = .deny := by
  have overlap : mayOverlap ⟨[star], [star, star]⟩ claim = true := by
    simp [mayOverlap, actionSubsumes_star, resourcesMayOverlap, isLiteralResource, literalPrefix]
  unfold stepPattern
  split
  · rfl
  · cases verdict <;> simp [overlap, denyAll, Effect.rank]

theorem claimVerdict_denyAll (rules : List Rule) {declared : Text} {claim : Pattern}
    (h : claimPattern declared = some claim) : claimVerdict (rules ++ [denyAll]) declared = .deny := by
  unfold claimVerdict
  rw [h]
  simp only
  split
  · unfold evaluateExact
    split
    · rfl
    · rename_i forms found
      obtain ⟨rest, shape⟩ := dotSegmentForms_head found
      rw [shape]
      exact evaluateRules_denyAll _ rest rules .ask
  · simp only [evaluatePattern, List.foldl_append, List.foldl_cons, List.foldl_nil]
    exact stepPattern_denyAll _ _

/-- Under a trailing deny-all rule a request with any claim that parses is denied, whatever came before. -/
theorem authorize_denyAll (rules : List Rule) {claims : List Text} {declared : Text} {claim : Pattern}
    (member : declared ∈ effectiveClaims claims) (h : claimPattern declared = some claim) :
    (authorize (rules ++ [denyAll]) claims).effect = .deny := by
  rw [authorize_effect]
  exact worstVerdict_deny member (claimVerdict_denyAll rules h)

/-- Under a trailing deny-all rule a request that declares nothing, and so claims everything, is denied. -/
theorem authorize_denyAll_undeclared (rules : List Rule) : (authorize (rules ++ [denyAll]) []).effect = .deny :=
  authorize_denyAll rules (declared := [star]) (claim := ⟨[star], [star, star]⟩) (by simp [effectiveClaims]) (by decide)

/--
A trailing deny-all rule does not turn an unparseable claim into a denial: a request whose every claim fails to
parse asks, whatever the rules. Asking is still not allowing.
-/
theorem authorize_all_unparseable (rules : List Rule) {claims : List Text} (nonEmpty : claims ≠ [])
    (h : ∀ declared ∈ claims, claimPattern declared = none) : (authorize rules claims).effect = .ask := by
  rw [authorize_effect, effectiveClaims_of_ne_nil nonEmpty]
  induction claims with
  | nil => exact absurd rfl nonEmpty
  | cons head rest ih =>
    rw [worstVerdict_cons]
    have first : claimVerdict rules head = .ask := by simp [claimVerdict, h head (List.mem_cons_self)]
    rw [first]
    cases rest with
    | nil => rfl
    | cons second others =>
      rw [ih (by simp) (fun declared member => h declared (List.mem_cons_of_mem _ member))]
      rfl

-- --- call keys -----------------------------------------------------------------------------------------------------

/-- A call key is its four components: two keys are equal only when all four are. -/
theorem callKey_injective {link link' ordinal ordinal' : Nat} {scriptDigest scriptDigest' entryDigest entryDigest' : Text}
    (h : CallKey.mk link scriptDigest ordinal entryDigest = CallKey.mk link' scriptDigest' ordinal' entryDigest') :
    link = link' ∧ scriptDigest = scriptDigest' ∧ ordinal = ordinal' ∧ entryDigest = entryDigest' := by
  simpa using h

/-- Distinct `(chain, link, ordinal, digests)` are distinct scoped keys. -/
theorem scopedKey_injective {chain chain' : Text} {key key' : CallKey} (h : (chain, key) = (chain', key')) :
    chain = chain' ∧ key.link = key'.link ∧ key.scriptDigest = key'.scriptDigest ∧ key.ordinal = key'.ordinal
      ∧ key.entryDigest = key'.entryDigest := by
  cases h
  simp

/-- The number a run of digits, least significant first, stands for. -/
def digitsValue : Text → Nat
  | [] => 0
  | digit :: rest => (digit - 48) + 10 * digitsValue rest

theorem digitsValue_digitsReversed : ∀ (fuel value : Nat), value < fuel →
    digitsValue (digitsReversed fuel value) = value
  | 0, _, h => absurd h (Nat.not_lt_zero _)
  | fuel + 1, value, h => by
    simp only [digitsReversed, digitsValue]
    split
    · simp only [digitsValue]; omega
    · rw [digitsValue_digitsReversed fuel (value / 10) (by omega)]; omega

theorem digitsReversed_digits : ∀ (fuel value digit : Nat), digit ∈ digitsReversed fuel value → 48 ≤ digit
  | 0, _, _, h => by simp [digitsReversed] at h
  | fuel + 1, value, digit, h => by
    simp only [digitsReversed, List.mem_cons] at h
    cases h with
    | inl first => omega
    | inr later =>
      split at later
      · simp at later
      · exact digitsReversed_digits fuel _ digit later

theorem digitsReversed_injective {left right : Nat}
    (h : digitsReversed (left + 1) left = digitsReversed (right + 1) right) : left = right := by
  have := congrArg digitsValue h
  rwa [digitsValue_digitsReversed _ _ (Nat.lt_succ_self _), digitsValue_digitsReversed _ _ (Nat.lt_succ_self _)]
    at this

/-- Two numbers print the same only when they are the same. -/
theorem decimal_injective {left right : Nat} (h : decimal left = decimal right) : left = right :=
  digitsReversed_injective (List.reverse_inj.mp h)

/-- A text that does not begin with a digit. -/
def Stops (text : Text) : Prop := ∀ unit rest, text = unit :: rest → unit < 48

theorem digits_then_stop : ∀ (digits digits' rest rest' : Text), (∀ digit ∈ digits, 48 ≤ digit) →
    (∀ digit ∈ digits', 48 ≤ digit) → Stops rest → Stops rest' → digits ++ rest = digits' ++ rest' →
    digits = digits' ∧ rest = rest'
  | [], [], _, _, _, _, _, _, h => ⟨rfl, by simpa using h⟩
  | [], digit :: more, rest, _, _, all', stops, _, h => by
    have := stops digit _ (by simpa using h)
    have := all' digit (List.mem_cons_self)
    omega
  | digit :: more, [], _, rest', all, _, _, stops', h => by
    have := stops' digit _ (by simpa using h.symm)
    have := all digit (List.mem_cons_self)
    omega
  | digit :: more, digit' :: more', rest, rest', all, all', stops, stops', h => by
    simp only [List.cons_append, List.cons.injEq] at h
    have tail := digits_then_stop more more' rest rest' (fun d m => all d (List.mem_cons_of_mem _ m))
      (fun d m => all' d (List.mem_cons_of_mem _ m)) stops stops' h.2
    exact ⟨by rw [h.1, tail.1], tail.2⟩

theorem scopePrefix_injective {chain chain' : Text} (h : scopePrefix chain = scopePrefix chain') : chain = chain' := by
  unfold scopePrefix at h
  by_cases empty : chain = [] <;> by_cases empty' : chain' = [] <;> simp [empty, empty'] at h ⊢
  exact h

theorem scopePrefix_reverse_stops (chain : Text) : Stops (scopePrefix chain).reverse := by
  intro unit rest h
  unfold scopePrefix at h
  by_cases empty : chain = []
  · simp [empty] at h
  · simp [empty] at h
    rw [← h.1]; decide

/-- A derived name `scope ++ link ++ separator ++ ordinal` names one scope, one link and one ordinal. -/
theorem slotName_injective {separator : Nat} (below : separator < 48) {chain chain' : Text}
    {link link' ordinal ordinal' : Nat}
    (h : scopePrefix chain ++ (decimal link ++ separator :: decimal ordinal) =
      scopePrefix chain' ++ (decimal link' ++ separator :: decimal ordinal')) :
    chain = chain' ∧ link = link' ∧ ordinal = ordinal' := by
  have reversed := congrArg List.reverse h
  simp only [decimal, List.reverse_append, List.reverse_cons, List.reverse_reverse, List.append_assoc,
    List.singleton_append] at reversed
  have separatorStops : ∀ (tail : Text), Stops (separator :: tail) := fun tail unit rest eq => by
    simp only [List.cons.injEq] at eq
    omega
  have first := digits_then_stop _ _ _ _ (digitsReversed_digits _ _) (digitsReversed_digits _ _)
    (separatorStops _) (separatorStops _) reversed
  have inner := first.2
  simp only [List.cons.injEq, true_and] at inner
  have second := digits_then_stop _ _ _ _ (digitsReversed_digits _ _) (digitsReversed_digits _ _)
    (scopePrefix_reverse_stops chain) (scopePrefix_reverse_stops chain') inner
  exact ⟨scopePrefix_injective (List.reverse_inj.mp second.2), digitsReversed_injective second.1,
    digitsReversed_injective first.1⟩

/-- Distinct call slots have distinct steering boundaries. -/
theorem boundaryKey_injective {chain chain' : Text} {link link' ordinal ordinal' : Nat}
    (h : boundaryKey chain link ordinal = boundaryKey chain' link' ordinal') :
    chain = chain' ∧ link = link' ∧ ordinal = ordinal' :=
  slotName_injective (by decide) h

/-- Distinct call slots spawn sub-chains in distinct scopes. -/
theorem childScope_injective {chain chain' : Text} {link link' ordinal ordinal' : Nat}
    (h : childScope chain link ordinal = childScope chain' link' ordinal') :
    chain = chain' ∧ link = link' ∧ ordinal = ordinal' :=
  slotName_injective (by decide) h

-- --- scopes --------------------------------------------------------------------------------------------------------

theorem settled_append (chain : Text) (link : Nat) (later : List Event) (ordinal : Nat) : ∀ (earlier : List Event),
    settled chain link (earlier ++ later) ordinal =
      match settled chain link later ordinal with
      | some call => some call
      | none => settled chain link earlier ordinal
  | [] => by
    simp only [List.nil_append, settled]
    cases settled chain link later ordinal <;> rfl
  | event :: rest => by
    simp only [List.cons_append, settled, settled_append chain link later ordinal rest]
    cases settled chain link later ordinal <;> rfl

theorem settledBy_foreign {chain : Text} {link : Nat} {event : Event}
    (foreign : event.chain ≠ chain ∨ event.link ≠ some link) (ordinal : Nat) :
    settledBy chain link ordinal event = none := by
  cases event <;> simp_all [settledBy, Event.chain, Event.link]
  intro sameChain sameLink
  cases foreign with
  | inl h => exact absurd sameChain h
  | inr h => exact absurd sameLink h

/-- An event of another scope or another link, wherever it sits in the journal, changes no settled call. -/
theorem settled_ignores_foreign {chain : Text} {link : Nat} {event : Event}
    (foreign : event.chain ≠ chain ∨ event.link ≠ some link) (before after : List Event) (ordinal : Nat) :
    settled chain link (before ++ event :: after) ordinal = settled chain link (before ++ after) ordinal := by
  rw [settled_append, settled_append]
  simp only [settled, settledBy_foreign foreign]
  cases settled chain link after ordinal <;> rfl

/-- The settled calls of a link of a scope are read from that link's own events and from nothing else. -/
theorem settled_filter (chain : Text) (link : Nat) (ordinal : Nat) : ∀ (events : List Event),
    settled chain link (events.filter (inScope chain link)) ordinal = settled chain link events ordinal
  | [] => rfl
  | event :: rest => by
    by_cases own : inScope chain link event = true
    · simp only [List.filter_cons, own, if_true, settled, settled_filter chain link ordinal rest]
    · have foreign : event.chain ≠ chain ∨ event.link ≠ some link := by
        simp only [inScope, inChain, Bool.and_eq_true, beq_iff_eq, not_and] at own
        by_cases sameChain : event.chain = chain
        · exact Or.inr (own sameChain)
        · exact Or.inl sameChain
      have dropped : (event :: rest).filter (inScope chain link) = rest.filter (inScope chain link) := by
        simp [own]
      rw [dropped, settled_filter chain link ordinal rest]
      simp only [settled, settledBy_foreign foreign]
      cases settled chain link rest ordinal <;> rfl

theorem append_ne_self {chain suffix : Text} (nonEmpty : suffix ≠ []) : chain ++ suffix ≠ chain := by
  intro same
  have lengths := congrArg List.length same
  simp only [List.length_append] at lengths
  exact nonEmpty (List.length_eq_zero_iff.mp (by omega))

/--
A scope whose name extends another's is another scope: an event of `chain ++ suffix` (a child `chain/0.1`, a
sibling `chainX`) changes no settled call of `chain`.
-/
theorem settled_ignores_extended_scope {chain suffix : Text} (nonEmpty : suffix ≠ []) {event : Event}
    (scope : event.chain = chain ++ suffix) (link : Nat) (before after : List Event) (ordinal : Nat) :
    settled chain link (before ++ event :: after) ordinal = settled chain link (before ++ after) ordinal :=
  settled_ignores_foreign (Or.inl (by rw [scope]; exact append_ne_self nonEmpty)) before after ordinal

/-- And the other way: an event of `chain` changes no settled call of a scope whose name extends it. -/
theorem settled_ignores_shorter_scope {chain suffix : Text} (nonEmpty : suffix ≠ []) {event : Event}
    (scope : event.chain = chain) (link : Nat) (before after : List Event) (ordinal : Nat) :
    settled (chain ++ suffix) link (before ++ event :: after) ordinal =
      settled (chain ++ suffix) link (before ++ after) ordinal :=
  settled_ignores_foreign (Or.inl (by rw [scope]; exact fun same => append_ne_self nonEmpty same.symm))
    before after ordinal

-- --- replay --------------------------------------------------------------------------------------------------------

/-- A slot the journal holds is never dispatched: it replays or it diverges. -/
theorem replayStep_held_never_dispatches (digestOf : Text → Option Text) (link : Nat) (scriptDigest : Text)
    (ordinal : Nat) (call : Call) (prior : Settled) (key : CallKey) :
    replayStep digestOf link scriptDigest ordinal call (some prior) ≠ .live key := by
  simp only [replayStep]
  repeat' split
  all_goals simp

theorem replayStep_live {digestOf : Text → Option Text} {link : Nat} {scriptDigest : Text} {ordinal : Nat}
    {call : Call} {prior : Option Settled} {key : CallKey}
    (h : replayStep digestOf link scriptDigest ordinal call prior = .live key) :
    prior = none ∧ key = ⟨link, scriptDigest, ordinal, key.entryDigest⟩
      ∧ digestOf call.name = some key.entryDigest := by
  cases prior with
  | some held => exact absurd h (replayStep_held_never_dispatches _ _ _ _ _ _ _)
  | none =>
    simp only [replayStep] at h
    split at h
    · rename_i entryDigest found
      simp only [Step.live.injEq] at h
      subst h
      exact ⟨rfl, rfl, found⟩
    · simp at h

/-- The call a dispatched slot settles is the call that slot replays: same key, name, payload, declaration. -/
theorem replayStep_settles {digestOf : Text → Option Text} {link : Nat} {scriptDigest : Text} {ordinal : Nat}
    {call : Call} {key : CallKey} (result : Text)
    (h : replayStep digestOf link scriptDigest ordinal call none = .live key) :
    replayStep digestOf link scriptDigest ordinal call (some ⟨key, call.name, call.payload, result⟩)
      = .replayed result := by
  obtain ⟨_, shape, declared⟩ := replayStep_live h
  rw [shape]
  simp [replayStep, declared]

theorem replayStep_replayed {digestOf : Text → Option Text} {link : Nat} {scriptDigest : Text} {ordinal : Nat}
    {call : Call} {prior : Option Settled} {result : Text}
    (h : replayStep digestOf link scriptDigest ordinal call prior = .replayed result) : prior.isSome = true := by
  cases prior with
  | some _ => rfl
  | none =>
    simp only [replayStep] at h
    split at h <;> simp at h

theorem settleFrom_below (digestOf : Text → Option Text) (chain : Text) (link : Nat) (scriptDigest : Text)
    (prior : Nat → Option Settled) (liveResult : Nat → Text) : ∀ (calls : List Call) (from_ ordinal : Nat),
    ordinal < from_ →
    settled chain link (settleFrom digestOf chain link scriptDigest prior liveResult from_ calls) ordinal = none
  | [], _, _, _ => rfl
  | call :: rest, from_, ordinal, below => by
    have tail := settleFrom_below digestOf chain link scriptDigest prior liveResult rest (from_ + 1) ordinal
      (by omega)
    simp only [settleFrom]
    cases step : replayStep digestOf link scriptDigest from_ call (prior from_) with
    | replayed _ => simpa using tail
    | live key =>
      obtain ⟨_, shape, _⟩ := replayStep_live step
      have other : key.ordinal ≠ ordinal := by rw [shape]; simp; omega
      simp [settled, tail, settledBy, other]
    | diverged _ => rfl
    | unlisted => rfl

/-- The journal a link leaves: what it found, then the calls it dispatched. -/
def lookupAfter (chain : Text) (link : Nat) (appended : List Event) (prior : Nat → Option Settled) (ordinal : Nat) :
    Option Settled :=
  match settled chain link appended ordinal with
  | some call => some call
  | none => prior ordinal

theorem replay_converges_from (digestOf : Text → Option Text) (chain : Text) (link : Nat) (scriptDigest : Text)
    (prior : Nat → Option Settled) (liveResult : Nat → Text) : ∀ (calls : List Call) (from_ : Nat)
    (before : List Event), (∀ ordinal, from_ ≤ ordinal → settled chain link before ordinal = none) →
    (∀ step ∈ replayFrom digestOf link scriptDigest prior from_ calls, step.continues = true) →
    replayFrom digestOf link scriptDigest
        (lookupAfter chain link
          (before ++ settleFrom digestOf chain link scriptDigest prior liveResult from_ calls) prior)
        from_ calls
      = converged liveResult from_ (replayFrom digestOf link scriptDigest prior from_ calls)
  | [], _, _, _, _ => rfl
  | call :: rest, from_, before, clear, continues => by
    have tailBelow := settleFrom_below digestOf chain link scriptDigest prior liveResult rest (from_ + 1) from_
      (by omega)
    cases step : replayStep digestOf link scriptDigest from_ call (prior from_) with
    | replayed result =>
      have continuesRest : ∀ step ∈ replayFrom digestOf link scriptDigest prior (from_ + 1) rest,
          step.continues = true := fun later member =>
        continues later (by simp [replayFrom, step, Step.continues, member])
      have ih := replay_converges_from digestOf chain link scriptDigest prior liveResult rest (from_ + 1) before
        (fun ordinal le => clear ordinal (by omega)) continuesRest
      have here : lookupAfter chain link
          (before ++ settleFrom digestOf chain link scriptDigest prior liveResult (from_ + 1) rest) prior from_
          = prior from_ := by
        simp [lookupAfter, settled_append, tailBelow, clear from_ (Nat.le_refl _)]
      simp only [settleFrom, step]
      simp only [replayFrom, here, step, Step.continues, if_true, converged, ih]
    | live key =>
      obtain ⟨none_, shape, declared⟩ := replayStep_live step
      have continuesRest : ∀ step ∈ replayFrom digestOf link scriptDigest prior (from_ + 1) rest,
          step.continues = true := fun later member =>
        continues later (by simp [replayFrom, step, Step.continues, member])
      let settledEvent : Event := .callSettled chain link ⟨key, call.name, call.payload, liveResult from_⟩
      have keyOrdinal : key.ordinal = from_ := by rw [shape]
      have clearNext : ∀ ordinal, from_ + 1 ≤ ordinal →
          settled chain link (before ++ [settledEvent]) ordinal = none := by
        intro ordinal le
        have other : key.ordinal ≠ ordinal := by omega
        simp [settled_append, settled, settledBy, settledEvent, other, clear ordinal (by omega)]
      have ih := replay_converges_from digestOf chain link scriptDigest prior liveResult rest (from_ + 1)
        (before ++ [settledEvent]) clearNext continuesRest
      have regroup : before ++ settledEvent
            :: settleFrom digestOf chain link scriptDigest prior liveResult (from_ + 1) rest
          = (before ++ [settledEvent])
            ++ settleFrom digestOf chain link scriptDigest prior liveResult (from_ + 1) rest := by simp
      have here : lookupAfter chain link
          ((before ++ [settledEvent])
            ++ settleFrom digestOf chain link scriptDigest prior liveResult (from_ + 1) rest) prior from_
          = some ⟨key, call.name, call.payload, liveResult from_⟩ := by
        simp [lookupAfter, settled_append, tailBelow, settled, settledBy, settledEvent, keyOrdinal]
      have replays := replayStep_settles (liveResult from_) (none_ ▸ step)
      simp only [settleFrom, step]
      rw [regroup]
      simp only [replayFrom, here, replays, step, Step.continues, if_true, converged, ih]
    | diverged reason =>
      have := continues (.diverged reason) (by simp [replayFrom, step, Step.continues])
      simp [Step.continues] at this
    | unlisted =>
      have := continues .unlisted (by simp [replayFrom, step, Step.continues])
      simp [Step.continues] at this

/--
Prefix convergence. A link that ran to its end against a journal, read again over the journal it left, replays
every call: the calls it found settled answer what they answered, and the calls it dispatched answer what their
handlers answered.
-/
theorem replay_converges (digestOf : Text → Option Text) (chain : Text) (link : Nat) (scriptDigest : Text)
    (liveResult : Nat → Text) (events : List Event) (calls : List Call)
    (continues : ∀ step ∈ replayFrom digestOf link scriptDigest (settled chain link events) 0 calls,
      step.continues = true) :
    replayFrom digestOf link scriptDigest
        (settled chain link
          (events ++ settleFrom digestOf chain link scriptDigest (settled chain link events) liveResult 0 calls))
        0 calls
      = converged liveResult 0 (replayFrom digestOf link scriptDigest (settled chain link events) 0 calls) := by
  have general := replay_converges_from digestOf chain link scriptDigest (settled chain link events) liveResult
    calls 0 [] (fun _ _ => rfl) continues
  have same : lookupAfter chain link
      ([] ++ settleFrom digestOf chain link scriptDigest (settled chain link events) liveResult 0 calls)
      (settled chain link events)
      = settled chain link
        (events ++ settleFrom digestOf chain link scriptDigest (settled chain link events) liveResult 0 calls) := by
    funext ordinal
    simp only [lookupAfter, List.nil_append, settled_append]
  rw [same] at general
  exact general

theorem converged_never_live (liveResult : Nat → Text) : ∀ (steps : List Step) (from_ : Nat) (key : CallKey),
    Step.live key ∉ converged liveResult from_ steps
  | [], _, _ => by simp [converged]
  | step :: rest, from_, key => by
    have tail := converged_never_live liveResult rest (from_ + 1) key
    cases step <;> simp [converged, tail]

/-- Already-settled slots never re-execute: the second pass over a link dispatches nothing. -/
theorem replay_never_redispatches (digestOf : Text → Option Text) (chain : Text) (link : Nat) (scriptDigest : Text)
    (liveResult : Nat → Text) (events : List Event) (calls : List Call)
    (continues : ∀ step ∈ replayFrom digestOf link scriptDigest (settled chain link events) 0 calls,
      step.continues = true) (key : CallKey) :
    Step.live key ∉ replayFrom digestOf link scriptDigest
      (settled chain link
        (events ++ settleFrom digestOf chain link scriptDigest (settled chain link events) liveResult 0 calls))
      0 calls := by
  rw [replay_converges digestOf chain link scriptDigest liveResult events calls continues]
  exact converged_never_live liveResult _ 0 key

theorem settleFrom_nothing_live (digestOf : Text → Option Text) (chain : Text) (link : Nat) (scriptDigest : Text)
    (prior : Nat → Option Settled) (liveResult : Nat → Text) : ∀ (calls : List Call) (from_ : Nat),
    (∀ key, Step.live key ∉ replayFrom digestOf link scriptDigest prior from_ calls) →
    settleFrom digestOf chain link scriptDigest prior liveResult from_ calls = []
  | [], _, _ => rfl
  | call :: rest, from_, quiet => by
    simp only [settleFrom]
    cases step : replayStep digestOf link scriptDigest from_ call (prior from_) with
    | replayed result =>
      exact settleFrom_nothing_live digestOf chain link scriptDigest prior liveResult rest (from_ + 1)
        (fun key member => quiet key (by simp [replayFrom, step, Step.continues, member]))
    | live key => exact absurd (by simp [replayFrom, step, Step.continues]) (quiet key)
    | diverged _ => rfl
    | unlisted => rfl

/--
Replay is idempotent. Once a link's dispatched calls have settled, running it again appends nothing: the journal is
a fixed point of the link.
-/
theorem replay_idempotent (digestOf : Text → Option Text) (chain : Text) (link : Nat) (scriptDigest : Text)
    (liveResult again : Nat → Text) (events : List Event) (calls : List Call)
    (continues : ∀ step ∈ replayFrom digestOf link scriptDigest (settled chain link events) 0 calls,
      step.continues = true) :
    settleFrom digestOf chain link scriptDigest
      (settled chain link
        (events ++ settleFrom digestOf chain link scriptDigest (settled chain link events) liveResult 0 calls))
      again 0 calls = [] :=
  settleFrom_nothing_live digestOf chain link scriptDigest _ again calls 0
    (replay_never_redispatches digestOf chain link scriptDigest liveResult events calls continues)

end ChainSpec

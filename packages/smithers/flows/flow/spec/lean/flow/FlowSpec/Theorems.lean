import FlowSpec.RetryPolicy
import FlowSpec.Scope
import FlowSpec.Ceiling
import FlowSpec.Metadata

/-!
# Machine-checked laws of the flow specification

Every theorem here is proved in full from the definitions of the specification and rests on nothing but Lean's own
foundations.

The retry bounds hold for every lawful arithmetic of milliseconds, so they hold for the exact schedule and for
doubles away from NaN. Scope injectivity holds for every pair of fixed-width idempotency components. The ceiling laws
hold for the normal form itself, whatever matching and covering are.
-/

namespace FlowSpec

/-! ## Retry policy -/

section Retry

variable {ω : Type} [Arith ω]

/-- A policy that breaks its contract never retries: a corrupt stored row is terminal. -/
theorem nextDelay_invalid {policy : Policy ω} (h : (issue policy).isSome = true) (attempt : ω)
    (random elapsed : Option ω) : nextDelay policy attempt random elapsed = none := by
  simp [nextDelay, h]

theorem nextDelay_some {policy : Policy ω} {attempt : ω} {random elapsed : Option ω} {d : ω}
    (h : nextDelay policy attempt random elapsed = some d) :
    issue policy = none ∧ ∃ n, Arith.count attempt = some n ∧ delayOf policy n random elapsed = some d := by
  unfold nextDelay at h
  split at h
  · exact absurd h (by simp)
  · rename_i valid
    split at h
    · exact absurd h (by simp)
    · rename_i n hn
      refine ⟨?_, n, hn, h⟩
      cases hi : issue policy with
      | none => rfl
      | some field => simp [hi] at valid

/-- The jittered delay is the delay itself or a minimum with it: jitter only shortens. -/
theorem jitter_cases {policy : Policy ω} {random : Option ω} {delay d : ω}
    (h : jitter policy random delay = some d) : d = delay ∨ ∃ x, d = Arith.min delay x := by
  unfold jitter at h
  split at h
  · exact Or.inl (Option.some.inj h).symm
  · split at h
    · split at h
      · exact Or.inr ⟨_, (Option.some.inj h).symm⟩
      · exact absurd h (by simp)
    · exact Or.inl (Option.some.inj h).symm

theorem delayOf_some {policy : Policy ω} {attempt : Nat} {random elapsed : Option ω} {d : ω}
    (h : delayOf policy attempt random elapsed = some d) :
    1 ≤ attempt ∧ attemptsSpent policy attempt = false ∧ windowClosed policy elapsed = false
      ∧ jitter policy random (capped policy (backoff policy attempt) elapsed) = some d := by
  have positive : 1 ≤ attempt := by
    cases attempt with
    | zero => simp [delayOf] at h
    | succ _ => omega
  have ha : decide (attempt < 1) = false := decide_eq_false (by omega)
  have he : elapsedMalformed elapsed = false := by
    cases he : elapsedMalformed elapsed with
    | false => rfl
    | true => simp [delayOf, he] at h
  have hs : attemptsSpent policy attempt = false := by
    cases hs : attemptsSpent policy attempt with
    | false => rfl
    | true => simp [delayOf, hs] at h
  have hw : windowClosed policy elapsed = false := by
    cases hw : windowClosed policy elapsed with
    | false => rfl
    | true => simp [delayOf, hw] at h
  refine ⟨positive, hs, hw, ?_⟩
  unfold delayOf at h
  rw [ha, he, hs, hw] at h
  split at h
  · rename_i contra
    simp at contra
  · split at h
    · exact absurd h (by simp)
    · split at h
      · exact absurd h (by simp)
      · exact h

variable [LawfulArith ω]

theorem capped_le_cap (policy : Policy ω) (raw : ω) (elapsed : Option ω) :
    Arith.le (capped policy raw elapsed) policy.maxMs = true := by
  unfold capped
  split
  · exact LawfulArith.le_trans (LawfulArith.min_le_left _ _) (LawfulArith.min_le_right _ _)
  · exact LawfulArith.min_le_right _ _

theorem capped_le_window {policy : Policy ω} {raw : ω} {elapsed : Option ω} {remaining : ω}
    (h : window policy elapsed = some remaining) : Arith.le (capped policy raw elapsed) remaining = true := by
  simp only [capped, h]
  exact LawfulArith.min_le_right _ _

/-- **Backoff cap.** Every delay the policy returns is at most `maxMs`, for every attempt, sample and elapsed time. -/
theorem nextDelay_le_cap {policy : Policy ω} {attempt : ω} {random elapsed : Option ω} {d : ω}
    (h : nextDelay policy attempt random elapsed = some d) : Arith.le d policy.maxMs = true := by
  obtain ⟨_, n, _, hd⟩ := nextDelay_some h
  have hj := (delayOf_some hd).2.2.2
  cases jitter_cases hj with
  | inl e => exact e ▸ capped_le_cap policy _ elapsed
  | inr e =>
    obtain ⟨x, e⟩ := e
    exact e ▸ LawfulArith.le_trans (LawfulArith.min_le_left _ _) (capped_le_cap policy _ elapsed)

/-- **Expiration window.** A delay never outlasts what remains of the expiration window. -/
theorem nextDelay_le_window {policy : Policy ω} {attempt : ω} {random elapsed : Option ω} {d remaining : ω}
    (hw : window policy elapsed = some remaining)
    (h : nextDelay policy attempt random elapsed = some d) : Arith.le d remaining = true := by
  obtain ⟨_, n, _, hd⟩ := nextDelay_some h
  have hj := (delayOf_some hd).2.2.2
  cases jitter_cases hj with
  | inl e => exact e ▸ capped_le_window hw
  | inr e =>
    obtain ⟨x, e⟩ := e
    exact e ▸ LawfulArith.le_trans (LawfulArith.min_le_left _ _) (capped_le_window hw)

omit [LawfulArith ω] in
/-- **Attempt exhaustion.** A delay is returned only for an attempt strictly below `maxAttempts`. -/
theorem nextDelay_attempt_lt {policy : Policy ω} {attempt limit : ω} {random elapsed : Option ω} {d : ω} {n k : Nat}
    (hl : policy.maxAttempts = some limit) (hk : Arith.count limit = some k) (hn : Arith.count attempt = some n)
    (h : nextDelay policy attempt random elapsed = some d) : n < k := by
  obtain ⟨_, m, hm, hd⟩ := nextDelay_some h
  have e : m = n := Option.some.inj (hm.symm.trans hn)
  subst e
  have hs := (delayOf_some hd).2.1
  simp only [attemptsSpent, hl, hk, decide_eq_false_iff_not] at hs
  omega

omit [LawfulArith ω] in
/-- The attempt that reaches `maxAttempts`, and every attempt after it, gets no delay. -/
theorem nextDelay_exhausted {policy : Policy ω} {attempt limit : ω} {n k : Nat}
    (hl : policy.maxAttempts = some limit) (hk : Arith.count limit = some k) (hn : Arith.count attempt = some n)
    (h : k ≤ n) (random elapsed : Option ω) : nextDelay policy attempt random elapsed = none := by
  cases hd : nextDelay policy attempt random elapsed with
  | none => rfl
  | some d =>
    have := nextDelay_attempt_lt hl hk hn hd
    omega

omit [LawfulArith ω] in
/-- Attempts are counted from one: attempt zero gets no delay. -/
theorem nextDelay_attempt_pos {policy : Policy ω} {attempt : ω} {random elapsed : Option ω} {d : ω} {n : Nat}
    (hn : Arith.count attempt = some n) (h : nextDelay policy attempt random elapsed = some d) : 1 ≤ n := by
  obtain ⟨_, m, hm, hd⟩ := nextDelay_some h
  have e : m = n := Option.some.inj (hm.symm.trans hn)
  subst e
  exact (delayOf_some hd).1

omit [LawfulArith ω] in
/-- **Retryability precedence.** A non-retryable failure is never retried, whatever the attempt and the hint. -/
theorem decideRetry_nonRetryable {policy : Policy ω} {tag code : Option Text}
    (h : isNonRetryable policy tag code = true) (attempt : ω) (hint random elapsed : Option ω) :
    decideRetry policy attempt tag code hint random elapsed = .giveUp .nonRetryable := by
  simp [decideRetry, h]

omit [Arith ω] [LawfulArith ω] in
/-- A tag the policy lists in `nonRetryable` is refused even when `retryable` selects it. -/
theorem nonRetryable_wins {policy : Policy ω} {tag : Text} {tags : List Text}
    (hp : policy.nonRetryable = some tags) (h : tag ∈ tags) (code : Option Text) :
    isNonRetryable policy (some tag) code = true := by
  simp [isNonRetryable, tagRefused, hp, h]

omit [Arith ω] [LawfulArith ω] in
/-- A tag that is non-retryable by type is refused under every policy. -/
theorem defaultNonRetryable_wins (policy : Policy ω) {tag : Text} (h : tag ∈ defaultNonRetryable)
    (code : Option Text) : isNonRetryable policy (some tag) code = true := by
  simp [isNonRetryable, tagRefused, h]

omit [Arith ω] [LawfulArith ω] in
/-- A policy with no `retryable` list retries every failure whose tag is not refused. -/
theorem retryable_absent {policy : Policy ω} (hp : policy.retryable = none) (tag code : Option Text) :
    isNonRetryable policy tag code = tagRefused policy tag := by
  simp [isNonRetryable, hp]

omit [LawfulArith ω] in
/-- A retry decision comes from a retryable failure and a policy delay, raised at most by the failure's hint. -/
theorem decideRetry_retry {policy : Policy ω} {attempt : ω} {tag code : Option Text}
    {hint random elapsed : Option ω} {d : ω}
    (h : decideRetry policy attempt tag code hint random elapsed = .retryAfter d) :
    isNonRetryable policy tag code = false ∧ ∃ delay, nextDelay policy attempt random elapsed = some delay
      ∧ (d = delay ∨ ∃ floor, d = hinted policy elapsed floor delay) := by
  unfold decideRetry at h
  split at h
  · exact absurd h (by simp)
  · rename_i retryable
    refine ⟨by simpa using retryable, ?_⟩
    split at h
    · exact absurd h (by simp)
    · rename_i delay hd
      refine ⟨delay, hd, ?_⟩
      split at h
      · exact Or.inl (Decision.retryAfter.inj h).symm
      · split at h
        · exact Or.inr ⟨_, (Decision.retryAfter.inj h).symm⟩
        · exact Or.inl (Decision.retryAfter.inj h).symm

/-- **Decision cap.** No decision waits longer than `maxMs`, a failure's own hint included. -/
theorem decideRetry_le_cap {policy : Policy ω} {attempt : ω} {tag code : Option Text}
    {hint random elapsed : Option ω} {d : ω}
    (h : decideRetry policy attempt tag code hint random elapsed = .retryAfter d) :
    Arith.le d policy.maxMs = true := by
  obtain ⟨_, delay, hd, shape⟩ := decideRetry_retry h
  cases shape with
  | inl e => exact e ▸ nextDelay_le_cap hd
  | inr e =>
    obtain ⟨floor, e⟩ := e
    exact e ▸ LawfulArith.le_trans (LawfulArith.min_le_left _ _) (LawfulArith.min_le_right _ _)

/-- A hinted decision never outlasts what remains of the expiration window either. -/
theorem decideRetry_le_window {policy : Policy ω} {attempt : ω} {tag code : Option Text}
    {hint random elapsed : Option ω} {d remaining : ω} (hw : window policy elapsed = some remaining)
    (h : decideRetry policy attempt tag code hint random elapsed = .retryAfter d) :
    Arith.le d remaining = true := by
  obtain ⟨_, delay, hd, shape⟩ := decideRetry_retry h
  cases shape with
  | inl e => exact e ▸ nextDelay_le_window hw hd
  | inr e =>
    obtain ⟨floor, e⟩ := e
    subst e
    simp only [hinted, hw, Option.getD_some]
    exact LawfulArith.min_le_right _ _

omit [LawfulArith ω] in
/-- **Bounded attempts.** The decision retries only an attempt strictly below `maxAttempts`. -/
theorem decideRetry_attempt_lt {policy : Policy ω} {attempt limit : ω} {tag code : Option Text}
    {hint random elapsed : Option ω} {d : ω} {n k : Nat}
    (hl : policy.maxAttempts = some limit) (hk : Arith.count limit = some k) (hn : Arith.count attempt = some n)
    (h : decideRetry policy attempt tag code hint random elapsed = .retryAfter d) : n < k := by
  obtain ⟨_, delay, hd, _⟩ := decideRetry_retry h
  exact nextDelay_attempt_lt hl hk hn hd

omit [LawfulArith ω] in
/-- `expired` is reported only by a policy with an expiration that would have retried without the elapsed time. -/
theorem decideRetry_expired {policy : Policy ω} {attempt : ω} {tag code : Option Text}
    {hint random elapsed : Option ω}
    (h : decideRetry policy attempt tag code hint random elapsed = .giveUp .expired) :
    policy.expirationMs.isSome = true ∧ elapsed.isSome = true
      ∧ (nextDelay policy attempt random none).isSome = true := by
  unfold decideRetry at h
  split at h
  · exact absurd (Decision.giveUp.inj h) (by simp)
  · split at h
    · have reason := Decision.giveUp.inj h
      cases he : policy.expirationMs.isSome with
      | false => simp [stopReason, he] at reason
      | true =>
        cases elapsed with
        | none => simp [stopReason] at reason
        | some _ =>
          cases hn : (nextDelay policy attempt random none).isSome with
          | false => simp [stopReason, hn] at reason
          | true => exact ⟨rfl, rfl, rfl⟩
    · split at h
      · exact absurd h (by simp)
      · split at h <;> exact absurd h (by simp)

end Retry

/-- The exact schedule: 200 ms doubling under a one-second cap waits 200, 400, 800, 1000 and then 1000 again. -/
theorem exact_schedule :
    [1, 2, 3, 4, 5].map (fun attempt =>
      nextDelay (ω := Nat) { initialMs := 200, factor := 2, maxMs := 1000 } attempt none none)
      = [some 200, some 400, some 800, some 1000, some 1000] := by
  decide

/-! ## Allocation scope -/

theorem separator_not_in_kind (kind : Kind) : 47 ∉ kindText kind := by
  cases kind <;> simp [kindText]

theorem kindText_inj {a b : Kind} (h : kindText a = kindText b) : a = b := by
  cases a <;> cases b <;> first | rfl | simp [kindText] at h

theorem separator_not_in_decimal (n : Nat) : 58 ∉ decimal n := fun m => by
  have := mem_decimal n m
  omega

theorem siteText_inj {s t : Option Text} (h : siteText s = siteText t) : s = t := by
  cases s with
  | none =>
    cases t with
    | none => rfl
    | some t => simp [siteText] at h
  | some s =>
    cases t with
    | none => simp [siteText] at h
    | some t =>
      simp only [siteText, List.cons.injEq, true_and] at h
      rw [(append_sep_inj (separator_not_in_decimal _) (separator_not_in_decimal _) h).2]

/-- The optional components after the name decode one way: the tags differ and the digests have a fixed width. -/
theorem tail_inj {a b : Idempotency} {s t : Option Text} (ha : a.WellFormed) (hb : b.WellFormed)
    (h : idempotencyText a ++ siteText s = idempotencyText b ++ siteText t) : a = b ∧ s = t := by
  cases a with
  | absent =>
    cases b with
    | absent => exact ⟨rfl, siteText_inj (by simpa [idempotencyText] using h)⟩
    | text _ => cases s <;> simp [idempotencyText, siteText] at h
    | object _ => cases s <;> simp [idempotencyText, siteText] at h
  | text d =>
    cases b with
    | absent => cases t <;> simp [idempotencyText, siteText] at h
    | text e =>
      have widths : d.length = e.length := Eq.trans (show d.length = digestWidth from ha)
        (show e.length = digestWidth from hb).symm
      simp only [idempotencyText, List.cons_append, List.cons.injEq, true_and] at h
      have parts := List.append_inj h widths
      exact ⟨by rw [parts.1], siteText_inj parts.2⟩
    | object _ => simp [idempotencyText] at h
  | object d =>
    cases b with
    | absent => cases t <;> simp [idempotencyText, siteText] at h
    | text _ => simp [idempotencyText] at h
    | object e =>
      have widths : d.length = e.length := Eq.trans (show d.length = keyWidth from ha)
        (show e.length = keyWidth from hb).symm
      simp only [idempotencyText, List.cons_append, List.cons.injEq, true_and] at h
      have parts := List.append_inj h widths
      exact ⟨by rw [parts.1], siteText_inj parts.2⟩

/--
**Scope injectivity.** Distinct `(kind, name, idempotency, site)` declarations have distinct scopes: no name, however
it is spelled, splices across a separator, and an absent component is never aliased by a present one.
-/
theorem scope_injective {i j : Identity} (hi : i.idempotency.WellFormed) (hj : j.idempotency.WellFormed)
    (h : scope i = scope j) : i = j := by
  unfold scope at h
  have kinds := append_sep_inj (separator_not_in_kind i.kind) (separator_not_in_kind j.kind) h
  have lengths := append_sep_inj (separator_not_in_decimal _) (separator_not_in_decimal _) kinds.2
  have names := List.append_inj lengths.2 (decimal_inj _ _ lengths.1)
  have tails := tail_inj hi hj names.2
  have kind := kindText_inj kinds.1
  cases i
  cases j
  simp only [Identity.mk.injEq]
  exact ⟨kind, names.1, tails.1, tails.2⟩

/-- A dispatch site refines a scope: a declaration with a site never shares the scope of the same one without. -/
theorem scope_site_distinct (kind : Kind) (name site : Text) {idempotency : Idempotency}
    (h : idempotency.WellFormed) :
    scope { kind, name, idempotency, site := some site } ≠ scope { kind, name, idempotency, site := none } :=
  fun e => by
    have contra := scope_injective h h e
    simp at contra

/-- The two kinds own disjoint counter namespaces. -/
theorem scope_kind_distinct {i j : Identity} (hi : i.idempotency.WellFormed) (hj : j.idempotency.WellFormed)
    (h : i.kind ≠ j.kind) : scope i ≠ scope j :=
  fun e => h (congrArg Identity.kind (scope_injective hi hj e))

/-! ## Capability ceilings: the normal form -/

theorem patternLt_strict : StrictOrder patternLt where
  irrefl := fun _ => lexLt_irrefl textLt_strict _
  trans := fun _ _ _ => lexLt_trans textLt_strict _ _ _
  connected := fun a b h₁ h₂ => by
    have e := lexLt_connected textLt_strict _ _ h₁ h₂
    cases a
    cases b
    simp only [List.cons.injEq, and_true] at e
    obtain ⟨e₁, e₂⟩ := e
    subst e₁
    subst e₂
    rfl

theorem groupLt_strict : StrictOrder groupLt := lexLt_strict patternLt_strict

theorem any_of_mem_iff {α : Type} {l₁ l₂ : List α} (p : α → Bool) (h : ∀ x, x ∈ l₁ ↔ x ∈ l₂) :
    l₁.any p = l₂.any p := by
  apply Bool.eq_iff_iff.mpr
  simp only [List.any_eq_true]
  constructor
  · intro ⟨x, hx, hp⟩
    exact ⟨x, (h x).mp hx, hp⟩
  · intro ⟨x, hx, hp⟩
    exact ⟨x, (h x).mpr hx, hp⟩

theorem all_of_mem_iff {α : Type} {l₁ l₂ : List α} (p : α → Bool) (h : ∀ x, x ∈ l₁ ↔ x ∈ l₂) :
    l₁.all p = l₂.all p := by
  apply Bool.eq_iff_iff.mpr
  simp only [List.all_eq_true]
  constructor
  · intro all x hx
    exact all x ((h x).mpr hx)
  · intro all x hx
    exact all x ((h x).mp hx)

theorem make_of_empty {groups : List (List Pattern)} (h : (groups.map normalizeGroup).any List.isEmpty = true) :
    make groups = [[]] := by
  unfold make
  rw [if_pos h]

theorem make_of_full {groups : List (List Pattern)} (h : (groups.map normalizeGroup).any List.isEmpty = false) :
    make groups = canon groupLt (groups.map normalizeGroup) := by
  unfold make
  rw [if_neg (by simp [h])]

/-- A normal form's groups are each in normal form. -/
theorem map_normalizeGroup_make (groups : List (List Pattern)) : (make groups).map normalizeGroup = make groups := by
  cases h : (groups.map normalizeGroup).any List.isEmpty with
  | true =>
    rw [make_of_empty h]
    rfl
  | false =>
    rw [make_of_full h]
    have fixed : ∀ group ∈ canon groupLt (groups.map normalizeGroup), normalizeGroup group = id group := by
      intro group member
      obtain ⟨source, _, e⟩ := List.mem_map.mp ((mem_canon groupLt_strict).mp member)
      rw [← e]
      exact canon_canon patternLt_strict source
    rw [List.map_congr_left fixed, List.map_id]

theorem any_isEmpty_make (groups : List (List Pattern)) :
    (make groups).any List.isEmpty = (groups.map normalizeGroup).any List.isEmpty := by
  cases h : (groups.map normalizeGroup).any List.isEmpty with
  | true =>
    rw [make_of_empty h]
    rfl
  | false =>
    rw [make_of_full h, any_of_mem_iff List.isEmpty (fun _ => mem_canon groupLt_strict), h]

/-- Only no groups at all normalize to unrestricted authority. -/
theorem make_eq_nil {groups : List (List Pattern)} (h : make groups = []) : groups = [] := by
  cases e : (groups.map normalizeGroup).any List.isEmpty with
  | true =>
    rw [make_of_empty e] at h
    exact absurd h (by simp)
  | false =>
    rw [make_of_full e] at h
    exact List.map_eq_nil_iff.mp (canon_eq_nil groupLt_strict h)

theorem make_fixed {groups : List (List Pattern)} (h : groups.map normalizeGroup = groups) :
    make groups = if groups.any List.isEmpty then [[]] else canon groupLt groups := by
  unfold make
  rw [h]

/-- The normal form of two normal forms together is the normal form of their sources together. -/
theorem make_make_append (a b : List (List Pattern)) : make (make a ++ make b) = make (a ++ b) := by
  rw [make_fixed (by rw [List.map_append, map_normalizeGroup_make, map_normalizeGroup_make]), List.any_append,
    any_isEmpty_make, any_isEmpty_make]
  have right : make (a ++ b) =
      if (a.map normalizeGroup).any List.isEmpty || (b.map normalizeGroup).any List.isEmpty then [[]]
      else canon groupLt (a.map normalizeGroup ++ b.map normalizeGroup) := by
    unfold make
    rw [List.map_append, List.any_append]
  rw [right]
  cases ha : (a.map normalizeGroup).any List.isEmpty with
  | true => simp
  | false =>
    cases hb : (b.map normalizeGroup).any List.isEmpty with
    | true => simp
    | false =>
      rw [make_of_full ha, make_of_full hb]
      simp only [Bool.or_self, Bool.false_eq_true, if_false]
      exact canon_congr groupLt_strict fun group => by
        simp only [List.mem_append, mem_canon groupLt_strict]

/-- The normal form depends on which groups are present, not on their order or their number. -/
theorem make_congr {a b : List (List Pattern)} (h : ∀ group, group ∈ a ↔ group ∈ b) : make a = make b := by
  have members : ∀ group, group ∈ a.map normalizeGroup ↔ group ∈ b.map normalizeGroup := by
    intro group
    simp only [List.mem_map]
    constructor
    · intro ⟨source, member, e⟩
      exact ⟨source, (h source).mp member, e⟩
    · intro ⟨source, member, e⟩
      exact ⟨source, (h source).mpr member, e⟩
  unfold make
  rw [any_of_mem_iff List.isEmpty members, canon_congr groupLt_strict members]

theorem make_nil : make [] = [] := rfl

/-- **Normalization is idempotent.** A normal form is its own normal form. -/
theorem make_make (groups : List (List Pattern)) : make (make groups) = make groups := by
  have h := make_make_append groups []
  rw [make_nil, List.append_nil, List.append_nil] at h
  exact h

/-! ## Capability ceilings: intersection -/

/-- Intersecting two normal forms is the normal form of their groups together. -/
theorem intersect_make (a b : List (List Pattern)) : intersect (make a) (make b) = make (a ++ b) := by
  unfold intersect
  by_cases hb : make b = []
  · rw [if_pos hb, make_eq_nil hb, List.append_nil]
  · rw [if_neg hb]
    by_cases ha : make a = []
    · rw [if_pos ha, make_eq_nil ha, List.nil_append]
    · rw [if_neg ha, make_make_append]

/-- **Commutativity.** The order of the two ceilings does not matter. -/
theorem intersect_comm (a b : List (List Pattern)) : intersect (make a) (make b) = intersect (make b) (make a) := by
  rw [intersect_make, intersect_make]
  exact make_congr fun group => by
    simp only [List.mem_append]
    exact Or.comm

/-- **Idempotency.** A ceiling intersected with itself is itself. -/
theorem intersect_self (a : List (List Pattern)) : intersect (make a) (make a) = make a := by
  rw [intersect_make]
  exact make_congr fun group => by simp only [List.mem_append, or_self]

/-- **Associativity.** Three ceilings intersect to one authority however they are grouped. -/
theorem intersect_assoc (a b c : List (List Pattern)) :
    intersect (intersect (make a) (make b)) (make c) = intersect (make a) (intersect (make b) (make c)) := by
  rw [intersect_make, intersect_make, intersect_make, intersect_make, List.append_assoc]

/-- Unrestricted authority is the identity of intersection. -/
theorem intersect_unrestricted (a : List (List Pattern)) :
    intersect (make a) [] = make a ∧ intersect [] (make a) = make a := by
  have h := intersect_make a []
  have h' := intersect_make [] a
  rw [make_nil, List.append_nil] at h
  rw [make_nil, List.nil_append] at h'
  exact ⟨h, h'⟩

/-- Deny-all absorbs: a ceiling intersected with one that has an empty group denies everything. -/
theorem intersect_none (a : List (List Pattern)) : intersect (make a) (make [[]]) = [[]] := by
  rw [intersect_make]
  apply make_of_empty
  rw [List.map_append, List.any_append]
  simp [normalizeGroup, canon]

/-- The transported form commutes. -/
theorem intersectCeilings_comm (left right : List (List Text)) :
    intersectCeilings left right = intersectCeilings right left := by
  unfold intersectCeilings authorityOf
  rw [intersect_comm]

/-- The transported form is idempotent: a ceiling intersected with itself is its own normal form. -/
theorem intersectCeilings_self (ceiling : List (List Text)) :
    intersectCeilings ceiling ceiling = (authorityOf ceiling).map (fun group => group.map format) := by
  unfold intersectCeilings authorityOf
  rw [intersect_self]

/-- A normal form allows what every one of its source groups allows. -/
theorem allows_make {κ : Type} (selects : Pattern → κ → Bool) (groups : List (List Pattern)) (capability : κ) :
    allows selects (make groups) capability
      = (groups.map normalizeGroup).all (fun group => group.any (fun pattern => selects pattern capability)) := by
  cases h : (groups.map normalizeGroup).any List.isEmpty with
  | true =>
    rw [make_of_empty h]
    obtain ⟨group, member, empty⟩ := List.any_eq_true.mp h
    have e : group = [] := List.isEmpty_iff.mp empty
    subst e
    cases all : (groups.map normalizeGroup).all
        (fun group => group.any (fun pattern => selects pattern capability)) with
    | false => simp [allows]
    | true =>
      have contra := List.all_eq_true.mp all [] member
      simp at contra
  | false =>
    rw [make_of_full h]
    exact all_of_mem_iff _ fun _ => mem_canon groupLt_strict

/--
**Non-escalation.** The intersection allows a capability exactly when both ceilings do, whatever matching is: it never
allows what either side denies, and it denies nothing both allow.
-/
theorem allows_intersect {κ : Type} (selects : Pattern → κ → Bool) (a b : List (List Pattern)) (capability : κ) :
    allows selects (intersect (make a) (make b)) capability
      = (allows selects (make a) capability && allows selects (make b) capability) := by
  rw [intersect_make, allows_make, allows_make, allows_make, List.map_append, List.all_append]

/-- **Monotonicity.** Intersecting never widens: what the intersection allows, the left ceiling allows. -/
theorem allows_intersect_left {κ : Type} (selects : Pattern → κ → Bool) (a b : List (List Pattern)) (capability : κ)
    (h : allows selects (intersect (make a) (make b)) capability = true) :
    allows selects (make a) capability = true := by
  rw [allows_intersect, Bool.and_eq_true] at h
  exact h.1

/-- **Monotonicity.** What the intersection allows, the right ceiling allows. -/
theorem allows_intersect_right {κ : Type} (selects : Pattern → κ → Bool) (a b : List (List Pattern)) (capability : κ)
    (h : allows selects (intersect (make a) (make b)) capability = true) :
    allows selects (make b) capability = true := by
  rw [allows_intersect, Bool.and_eq_true] at h
  exact h.2

/-! ## Capability ceilings: containment -/

/-- Everything is within unrestricted authority. -/
theorem within_unrestricted (covers : Pattern → Pattern → Bool) (inner : List (List Pattern)) :
    withinBy covers inner [] = true := rfl

/-- Deny-all is within every ceiling. -/
theorem none_within (covers : Pattern → Pattern → Bool) (outer : List (List Pattern)) :
    withinBy covers [[]] outer = true := by
  simp [withinBy]

/-- Unrestricted authority is within only unrestricted authority. -/
theorem unrestricted_within (covers : Pattern → Pattern → Bool) {outer : List (List Pattern)} (h : outer ≠ []) :
    withinBy covers [] outer = false := by
  cases outer with
  | nil => exact absurd rfl h
  | cons _ _ => simp [withinBy]

/-- **Narrowing keeps containment.** An inner ceiling within an outer one stays within it under any intersection. -/
theorem within_intersect_inner (covers : Pattern → Pattern → Bool) (inner extra : List (List Pattern))
    {outer : List (List Pattern)} (h : withinBy covers (make inner) outer = true) :
    withinBy covers (intersect (make inner) (make extra)) outer = true := by
  rw [intersect_make]
  unfold withinBy at h ⊢
  rw [List.all_eq_true] at h ⊢
  intro group member
  obtain ⟨candidate, held, covered⟩ := List.any_eq_true.mp (h group member)
  apply List.any_eq_true.mpr
  cases empties : ((inner ++ extra).map normalizeGroup).any List.isEmpty with
  | true =>
    rw [make_of_empty empties]
    exact ⟨[], List.mem_singleton.mpr rfl, rfl⟩
  | false =>
    rw [make_of_full empties]
    have full : (inner.map normalizeGroup).any List.isEmpty = false := by
      rw [List.map_append, List.any_append, Bool.or_eq_false_iff] at empties
      exact empties.1
    rw [make_of_full full] at held
    refine ⟨candidate, (mem_canon groupLt_strict).mpr ?_, covered⟩
    rw [List.map_append]
    exact List.mem_append_left _ ((mem_canon groupLt_strict).mp held)

/-- **Containment composes.** An inner ceiling within two outer ceilings is within their intersection. -/
theorem within_intersect_outer (covers : Pattern → Pattern → Bool) (inner a b : List (List Pattern))
    (ha : withinBy covers inner (make a) = true) (hb : withinBy covers inner (make b) = true) :
    withinBy covers inner (intersect (make a) (make b)) = true := by
  rw [intersect_make]
  unfold withinBy at ha hb ⊢
  rw [List.all_eq_true] at ha hb ⊢
  intro group member
  cases empties : ((a ++ b).map normalizeGroup).any List.isEmpty with
  | true =>
    rw [make_of_empty empties] at member
    have e : group = [] := List.mem_singleton.mp member
    subst e
    rw [List.map_append, List.any_append, Bool.or_eq_true] at empties
    cases empties with
    | inl left =>
      rw [make_of_empty left] at ha
      exact ha [] (List.mem_singleton.mpr rfl)
    | inr right =>
      rw [make_of_empty right] at hb
      exact hb [] (List.mem_singleton.mpr rfl)
  | false =>
    rw [make_of_full empties] at member
    have source := (mem_canon groupLt_strict).mp member
    rw [List.map_append, List.any_append, Bool.or_eq_false_iff] at empties
    rw [List.map_append] at source
    cases List.mem_append.mp source with
    | inl left =>
      rw [make_of_full empties.1] at ha
      exact ha group ((mem_canon groupLt_strict).mpr left)
    | inr right =>
      rw [make_of_full empties.2] at hb
      exact hb group ((mem_canon groupLt_strict).mpr right)

/-- `ceilingWithin` in transported form: narrowing the inner ceiling keeps it within the outer one. -/
theorem ceilingWithin_narrow (inner extra outer : List (List Text)) (h : ceilingWithin inner outer = true) :
    within (intersect (authorityOf inner) (authorityOf extra)) (authorityOf outer) = true :=
  within_intersect_inner subsumes _ _ h

/-! ## Flow metadata -/

/-- A blank tag is refused before anything else is checked: a flow is never anonymous. -/
theorem blank_tag_refused {ω : Type} [Arith ω] (limit : ω) {tag : Text} (h : blank tag = true)
    (maxRounds deadline : Option ω) : metadataIssue limit tag maxRounds deadline = some .tag := by
  simp [metadataIssue, h]

/-- Metadata with no issue has a tag that is not blank. -/
theorem accepted_tag_not_blank {ω : Type} [Arith ω] {limit : ω} {tag : Text} {maxRounds deadline : Option ω}
    (h : metadataIssue limit tag maxRounds deadline = none) : blank tag = false := by
  cases b : blank tag with
  | false => rfl
  | true =>
    rw [blank_tag_refused limit b] at h
    exact absurd h (by simp)

end FlowSpec

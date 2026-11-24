import CapabilitySpec.Set
import CapabilitySpec.Policy

/-!
# Machine-checked laws of capabilities, policy and capability sets

Every theorem here is proved in full from the definitions of the specification and rests on nothing but Lean's own
foundations. The security laws say that a proof of coverage never widens authority (`subsumes_sound`,
`within_sound`), that attenuation only removes authority (`allows_intersect`), that the normal form of a set is unique
so intersection is a semilattice meet, and that no later ruleset lifts a configured denial (`configured_deny_veto`).
-/

namespace CapabilitySpec

/-! ## Actions -/

theorem any_selects (action : Action) : Selector.any.selects action = true := rfl

theorem exact_selects {wanted action : Action} : (Selector.exact wanted).selects action = true ↔ wanted = action := by
  simp [Selector.selects]

theorem covers_refl (selector : Selector) : selector.covers selector = true := by
  cases selector <;> simp [Selector.covers]

/-- **Action coverage is sound.** A selector that covers another selects every action the other selects. -/
theorem covers_sound {left right : Selector} {action : Action} (h : left.covers right = true)
    (hr : right.selects action = true) : left.selects action = true := by
  cases left <;> cases right <;> simp_all [Selector.covers, Selector.selects]

theorem covers_trans {a b c : Selector} (hab : a.covers b = true) (hbc : b.covers c = true) :
    a.covers c = true := by
  cases a <;> cases b <;> cases c <;> simp_all [Selector.covers]

/-- Two selectors that select one action are comparable, so `mayOverlap` never calls them disjoint. -/
theorem covers_of_selects_both {left right : Selector} {action : Action} (hl : left.selects action = true)
    (hr : right.selects action = true) : left.covers right = true ∨ right.covers left = true := by
  cases left <;> cases right <;> simp_all [Selector.covers, Selector.selects]

/-! ## The glob -/

theorem anySuffix_iff {accept : Text → Bool} :
    ∀ (text : Text), anySuffix accept text = true ↔ ∃ s u, text = s ++ u ∧ accept u = true
  | [] => by
    constructor
    · intro h; exact ⟨[], [], rfl, h⟩
    · rintro ⟨s, u, e, h⟩
      have hu : u = [] := (List.append_eq_nil_iff.mp e.symm).2
      subst hu; exact h
  | x :: text => by
    rw [anySuffix, Bool.or_eq_true, anySuffix_iff text]
    constructor
    · rintro (h | ⟨s, u, e, h⟩)
      · exact ⟨[], x :: text, rfl, h⟩
      · exact ⟨x :: s, u, by rw [e]; rfl, h⟩
    · rintro ⟨s, u, e, h⟩
      cases s with
      | nil => left; rw [List.nil_append] at e; rw [e]; exact h
      | cons y s => right; rw [List.cons_append] at e; injection e with _ e'; exact ⟨s, u, e', h⟩

theorem glob_nil (text : Text) : glob [] text = text.isEmpty := by simp [glob]

theorem glob_star (pattern text : Text) : glob (star :: pattern) text = anySuffix (glob pattern) text := by
  simp [glob]

theorem glob_cons_nil {unit : Nat} {pattern : Text} (h : unit ≠ star) : glob (unit :: pattern) [] = false := by
  simp [glob, h]

theorem glob_cons_cons {unit head : Nat} {pattern tail : Text} (h : unit ≠ star) :
    glob (unit :: pattern) (head :: tail) = (decide (unit = question ∨ unit = head) && glob pattern tail) := by
  simp [glob, h]

/-- **Concatenation.** A text is in the language of `p ++ q` exactly when it splits into one text of each. -/
theorem glob_append : ∀ (p q text : Text),
    glob (p ++ q) text = true ↔ ∃ s u, text = s ++ u ∧ glob p s = true ∧ glob q u = true
  | [], q, text => by
    constructor
    · intro h; exact ⟨[], text, rfl, rfl, h⟩
    · rintro ⟨s, u, e, hs, hu⟩
      have hnil : s = [] := by
        cases s with
        | nil => rfl
        | cons _ _ => simp [glob] at hs
      subst hnil; rw [e]; exact hu
  | unit :: p, q, text => by
    by_cases hc : unit = star
    · subst hc
      rw [List.cons_append, glob_star, anySuffix_iff]
      constructor
      · rintro ⟨s, u, e, h⟩
        obtain ⟨s', u', e', hs', hu'⟩ := (glob_append p q u).mp h
        refine ⟨s ++ s', u', by rw [e, e', List.append_assoc], ?_, hu'⟩
        rw [glob_star, anySuffix_iff]; exact ⟨s, s', rfl, hs'⟩
      · rintro ⟨s, u, e, hs, hu⟩
        rw [glob_star, anySuffix_iff] at hs
        obtain ⟨a, b, e', hb⟩ := hs
        exact ⟨a, b ++ u, by rw [e, e', List.append_assoc], (glob_append p q (b ++ u)).mpr ⟨b, u, rfl, hb, hu⟩⟩
    · rw [List.cons_append]
      cases text with
      | nil =>
        rw [glob_cons_nil hc]
        constructor
        · intro h; cases h
        · rintro ⟨s, u, e, hs, _⟩
          have hnil : s = [] := (List.append_eq_nil_iff.mp e.symm).1
          subst hnil; rw [glob_cons_nil hc] at hs; cases hs
      | cons head tail =>
        rw [glob_cons_cons hc, Bool.and_eq_true, glob_append p q tail]
        constructor
        · rintro ⟨hd, s, u, e, hs, hu⟩
          exact ⟨head :: s, u, by rw [e]; rfl, by rw [glob_cons_cons hc, Bool.and_eq_true]; exact ⟨hd, hs⟩, hu⟩
        · rintro ⟨s, u, e, hs, hu⟩
          cases s with
          | nil => rw [glob_cons_nil hc] at hs; cases hs
          | cons first s =>
            rw [List.cons_append] at e; injection e with e₁ e₂; subst e₁
            rw [glob_cons_cons hc, Bool.and_eq_true] at hs
            exact ⟨hs.1, s, u, e₂, hs.2, hu⟩

/-- `*` selects every text. -/
theorem glob_one_star (text : Text) : glob [star] text = true := by
  rw [glob_star, anySuffix_iff]; exact ⟨text, [], by simp, rfl⟩

/-- `**` selects every text. -/
theorem glob_two_stars (text : Text) : glob [star, star] text = true := by
  rw [glob_star, anySuffix_iff]; exact ⟨[], text, rfl, glob_one_star text⟩

/-- **A literal selects itself and nothing else.** A resource without `*` or `?` is not a glob. -/
theorem glob_literal : ∀ (pattern text : Text), isLiteral pattern = true → (glob pattern text = true ↔ text = pattern)
  | [], text, _ => by rw [glob_nil]; exact List.isEmpty_iff
  | unit :: pattern, text, h => by
    simp only [isLiteral, List.all_cons, Bool.and_eq_true, decide_eq_true_eq] at h
    have ih := fun tail => glob_literal pattern tail h.2
    cases text with
    | nil => rw [glob_cons_nil h.1.1]; simp
    | cons head tail =>
      rw [glob_cons_cons h.1.1, Bool.and_eq_true, ih tail, decide_eq_true_eq, List.cons.injEq]
      constructor
      · rintro ⟨hd | hd, ht⟩
        · exact absurd hd h.1.2
        · exact ⟨hd.symm, ht⟩
      · rintro ⟨hd, ht⟩; exact ⟨Or.inr hd.symm, ht⟩

theorem bare_eq_some {pattern command : Text} (h : bare pattern = some command) :
    pattern = command ++ [space, star] := by
  unfold bare at h
  split at h
  · rename_i rest heq
    injection h with h; subst h
    have := congrArg List.reverse heq
    simpa [space, star] using this
  · cases h

theorem recursiveRoot_eq_some {resource root : Text} (h : recursiveRoot resource = some root) :
    resource = root ++ [slash, star, star] := by
  unfold recursiveRoot at h
  split at h
  · rename_i rest heq
    injection h with h; subst h
    have := congrArg List.reverse heq
    simpa [slash, star] using this
  · cases h

/-- What a resource pattern selects: its glob, or for a command grant `c *` the bare command's glob. -/
def Selects (pattern text : Text) : Prop :=
  glob pattern text = true ∨ ∃ command, bare pattern = some command ∧ glob command text = true

theorem matchesResource_iff {pattern text : Text} :
    matchesResource pattern text = true ↔ withinWork pattern text = true ∧ Selects pattern text := by
  unfold matchesResource Selects
  rw [Bool.and_eq_true, Bool.or_eq_true]
  constructor
  · rintro ⟨hw, h | h⟩
    · cases hb : bare pattern with
      | none => rw [hb] at h; cases h
      | some command => rw [hb] at h; exact ⟨hw, Or.inr ⟨command, rfl, h⟩⟩
    · exact ⟨hw, Or.inl h⟩
  · rintro ⟨hw, h | ⟨command, hb, h⟩⟩
    · exact ⟨hw, Or.inr h⟩
    · rw [hb]; exact ⟨hw, Or.inl h⟩

/-- A text under `root/` is selected by `root/**`, whatever follows the slash in the pattern that selected it. -/
theorem glob_recursive {root rest text : Text} (h : glob (root ++ slash :: rest) text = true) :
    glob (root ++ [slash, star, star]) text = true := by
  obtain ⟨s, u, e, hs, hu⟩ := (glob_append root (slash :: rest) text).mp h
  refine (glob_append root [slash, star, star] text).mpr ⟨s, u, e, hs, ?_⟩
  have hne : slash ≠ star := by decide
  cases u with
  | nil => rw [glob_cons_nil hne] at hu; cases hu
  | cons head tail =>
    rw [glob_cons_cons hne, Bool.and_eq_true] at hu
    rw [glob_cons_cons hne, Bool.and_eq_true]
    exact ⟨hu.1, glob_two_stars tail⟩

/-- **Resource coverage is sound.** What `right` selects, a `left` that provably covers it selects. -/
theorem resourceSubsumes_sound {left right text : Text} (h : resourceSubsumes left right = true)
    (hr : Selects right text) : Selects left text := by
  unfold resourceSubsumes at h
  rw [Bool.or_eq_true, Bool.or_eq_true, decide_eq_true_eq, decide_eq_true_eq] at h
  rcases h with (h | h) | h
  · rw [h]; exact hr
  · rw [h]; exact Or.inl (glob_two_stars text)
  · cases hroot : recursiveRoot left with
    | none => rw [hroot] at h; cases h
    | some root =>
      rw [hroot] at h
      obtain ⟨rest, hrest⟩ := List.isPrefixOf_iff_prefix.mp h
      have hl := recursiveRoot_eq_some hroot
      rw [hl]
      left
      rcases hr with hr | ⟨command, hb, hr⟩
      · rw [← hrest, List.append_assoc] at hr
        exact glob_recursive hr
      · have hc := bare_eq_some hb
        rw [← hrest] at hc
        -- `root/rest = command *`, so the command is itself under `root/`.
        have hcommand : ∃ tail, command = root ++ slash :: tail := by
          rcases List.append_eq_append_iff.mp hc with ⟨middle, hcmd, _⟩ | ⟨middle, hroot', hmid⟩
          · exact ⟨middle, by rw [hcmd, List.append_assoc]; rfl⟩
          · cases middle with
            | nil => exact ⟨[], by simpa using hroot'.symm⟩
            | cons a middle =>
              exfalso
              have hrev := congrArg List.reverse hroot'
              cases middle with
              | nil =>
                simp only [List.cons_append, List.nil_append, List.cons.injEq] at hmid
                simp [← hmid.1, slash, space] at hrev
              | cons b middle =>
                simp only [List.cons_append, List.cons.injEq] at hmid
                have hnil : middle = [] := (List.append_eq_nil_iff.mp hmid.2.2.symm).1
                subst hnil
                simp [← hmid.2.1, slash, star] at hrev
        obtain ⟨tail, htail⟩ := hcommand
        rw [htail] at hr
        exact glob_recursive hr

/-! ## Path forms -/

/-- The length of the pieces with one separator after each. -/
def size : List Text → Nat
  | [] => 0
  | piece :: rest => piece.length + 1 + size rest

theorem size_splitOn (separator : Nat) : ∀ (text : Text), size (splitOn separator text) = text.length + 1
  | [] => rfl
  | unit :: rest => by
    have ih := size_splitOn separator rest
    simp only [splitOn]
    split
    · simp only [size, ih, List.length_nil, List.length_cons]; omega
    · split
      · rename_i heq; rw [heq] at ih; simp [size] at ih
      · rename_i heq; rw [heq] at ih; simp only [size, List.length_cons] at ih ⊢; omega

theorem size_append : ∀ (a b : List Text), size (a ++ b) = size a + size b
  | [], b => by simp [size]
  | piece :: a, b => by simp only [List.cons_append, size, size_append a b]; omega

theorem size_reverse : ∀ (pieces : List Text), size pieces.reverse = size pieces
  | [] => rfl
  | piece :: rest => by
    simp only [List.reverse_cons, size_append, size_reverse rest, size]; omega

theorem foldSegments_size : ∀ (segments stack result : List Text),
    foldSegments stack segments = some result → size result ≤ size stack + size segments
  | [], stack, result, h => by
    simp only [foldSegments, Option.some.injEq] at h
    subst h; simp [size]
  | segment :: rest, stack, result, h => by
    simp only [foldSegments] at h
    split at h
    · have := foldSegments_size rest stack result h
      simp only [size]; omega
    · split at h
      · cases stack with
        | nil => cases h
        | cons top below =>
          have := foldSegments_size rest below result h
          simp only [size]; omega
      · have := foldSegments_size rest (segment :: stack) result h
        simp only [size] at this ⊢; omega

theorem joinWith_length (separator : Nat) : ∀ (pieces : List Text), pieces ≠ [] →
    (joinWith separator pieces).length + 1 ≤ size pieces
  | [], h => absurd rfl h
  | [piece], _ => by simp [joinWith, size]
  | piece :: next :: rest, _ => by
    have := joinWith_length separator (next :: rest) (by simp)
    simp only [joinWith, size, List.length_append, List.length_cons] at this ⊢; omega

/-- **Normalizing never lengthens.** The normal form is no longer than the text, or is the one-unit `.`. -/
theorem normalizeRelative_length {resource normal : Text} (h : normalizeRelative resource = some normal) :
    normal.length ≤ max resource.length 1 := by
  unfold normalizeRelative at h
  cases hf : foldSegments [] (splitOn slash resource) with
  | none => rw [hf] at h; cases h
  | some stack =>
    rw [hf] at h
    simp only [Option.map_some, Option.some.injEq] at h
    subst h
    have hs := foldSegments_size _ _ _ hf
    rw [size_splitOn] at hs
    simp only [size, Nat.zero_add] at hs
    split
    · simp [dot]; omega
    · rename_i hne
      have hne' : stack.reverse ≠ [] := by
        intro e; apply hne; simp [List.reverse_eq_nil_iff.mp e]
      have := joinWith_length slash stack.reverse hne'
      rw [size_reverse] at this; omega

/-- The written text is always one of the forms: nothing is selected through its normal form alone. -/
theorem forms_mem_self {action : Selector} {resource : Text} {texts : List Text}
    (h : forms action resource = some texts) : resource ∈ texts := by
  unfold forms at h
  split at h
  · split at h
    · cases h
    · split at h
      · cases h
      · cases hn : normalizeRelative resource with
        | none => rw [hn] at h; cases h
        | some normal =>
          rw [hn] at h; simp only [Option.map_some, Option.some.injEq] at h
          subst h; simp
  · simp only [Option.some.injEq] at h; subst h; simp

theorem forms_length {action : Selector} {resource : Text} {texts : List Text}
    (h : forms action resource = some texts) (hr : resource.length ≤ maxResourceLength) :
    ∀ text ∈ texts, text.length ≤ maxResourceLength := by
  unfold forms at h
  split at h
  · split at h
    · cases h
    · split at h
      · cases h
      · cases hn : normalizeRelative resource with
        | none => rw [hn] at h; cases h
        | some normal =>
          rw [hn] at h; simp only [Option.map_some, Option.some.injEq] at h
          subst h
          have hl := normalizeRelative_length hn
          intro text ht
          simp only [List.mem_cons, List.not_mem_nil, or_false] at ht
          rcases ht with rfl | rfl
          · exact hr
          · simp only [maxResourceLength] at hr ⊢; omega
  · simp only [Option.some.injEq] at h; subst h
    intro text ht
    simp only [List.mem_cons, List.not_mem_nil, or_false] at ht
    rw [ht]; exact hr

/-- **No traversal through an absolute path.** A filesystem resource that is absolute and still has a `.`, `..` or
empty segment has no form, so nothing can select it. -/
theorem forms_absolute_refused {action : Selector} {resource : Text} (hd : hasDotSegment action resource = true)
    (ha : resource.head? = some slash) : forms action resource = none := by
  simp [forms, hd, anchored, ha]

/-! ## Patterns -/

theorem selected_iff {pattern : Pattern} {capability : Capability} :
    selected pattern capability = true ↔
      pattern.action.selects capability.action = true ∧
        ∃ texts, forms (.exact capability.action) capability.resource = some texts ∧
          ∀ text ∈ texts, matchesResource pattern.resource text = true := by
  unfold selected
  rw [Bool.and_eq_true]
  cases forms (.exact capability.action) capability.resource <;> simp [List.all_eq_true]

theorem subsumes_iff {left right : Pattern} :
    subsumes left right = true ↔
      left.action.covers right.action = true ∧
        ∃ texts, forms right.action right.resource = some texts ∧
          ∀ text ∈ texts, resourceSubsumes left.resource text = true := by
  unfold subsumes
  rw [Bool.and_eq_true]
  cases forms right.action right.resource <;> simp [List.all_eq_true]

theorem withinWork_of_length {pattern text : Text} (hp : pattern.length ≤ maxResourceLength)
    (ht : text.length ≤ maxResourceLength) : withinWork pattern text = true := by
  unfold withinWork maxMatchWork
  exact decide_eq_true (Nat.mul_le_mul hp ht)

/-- A selected capability's written resource is selected: the normal form is an extra demand, never a substitute. -/
theorem selected_text {pattern : Pattern} {capability : Capability} (h : selected pattern capability = true) :
    matchesResource pattern.resource capability.resource = true := by
  obtain ⟨_, texts, ht, hall⟩ := selected_iff.mp h
  exact hall _ (forms_mem_self ht)

/-- **No pattern selects an absolute path with a dot segment**, not even `*:**`. -/
theorem selected_absolute_refused {pattern : Pattern} {capability : Capability}
    (hd : hasDotSegment (.exact capability.action) capability.resource = true)
    (ha : capability.resource.head? = some slash) : selected pattern capability = false := by
  simp [selected, forms_absolute_refused hd ha]

/--
**Coverage is sound: `subsumes` never widens authority.** When `left` provably covers `right`, every capability
`right` selects, `left` selects. The lengths are the ones the schema enforces.
-/
theorem subsumes_sound {left right : Pattern} {capability : Capability}
    (hl : left.resource.length ≤ maxResourceLength) (hc : capability.resource.length ≤ maxResourceLength)
    (h : subsumes left right = true) (hr : selected right capability = true) :
    selected left capability = true := by
  obtain ⟨hcovers, covered, hcovered, hall⟩ := subsumes_iff.mp h
  obtain ⟨hselects, texts, htexts, hmatch⟩ := selected_iff.mp hr
  refine selected_iff.mpr ⟨covers_sound hcovers hselects, texts, htexts, fun text ht => ?_⟩
  have hres := hall _ (forms_mem_self hcovered)
  exact matchesResource_iff.mpr
    ⟨withinWork_of_length hl (forms_length htexts hc text ht),
      resourceSubsumes_sound hres (matchesResource_iff.mp (hmatch text ht)).2⟩

theorem isLiteral_command (command : Text) : isLiteral (command ++ [space, star]) = false := by
  simp [isLiteral, star]

/--
**An exact grant grants exactly one capability.** The pattern `patternFromCapability` derives selects the capability
it came from and no other.
-/
theorem exactPattern_exact {capability other : Capability} {pattern : Pattern}
    (h : exactPattern capability = some pattern) :
    selected pattern other = true ↔ other = capability := by
  unfold exactPattern at h
  simp only [Option.ite_none_right_eq_some, Option.some.injEq] at h
  obtain ⟨⟨_, hliteral, hself⟩, hp⟩ := h
  subst hp
  constructor
  · intro hs
    have haction : capability.action = other.action := exact_selects.mp (selected_iff.mp hs).1
    have htext := (matchesResource_iff.mp (selected_text hs)).2
    have hresource : other.resource = capability.resource := by
      rcases htext with hg | ⟨command, hb, _⟩
      · exact (glob_literal _ _ hliteral).mp hg
      · have hbare := bare_eq_some hb
        simp only at hbare hliteral
        rw [hbare, isLiteral_command] at hliteral
        cases hliteral
    cases capability; cases other
    simp only at haction hresource
    rw [haction, hresource]
  · intro e; rw [e]; exact hself

/-! ## Disjointness -/

theorem literalPrefix_prefix : ∀ (pattern text : Text), glob pattern text = true → literalPrefix pattern <+: text
  | [], _, _ => List.nil_prefix
  | unit :: pattern, text, h => by
    simp only [literalPrefix]
    split
    · exact List.nil_prefix
    · rename_i hmeta
      have hstar : unit ≠ star := fun e => hmeta (Or.inl e)
      have hquestion : unit ≠ question := fun e => hmeta (Or.inr e)
      cases text with
      | nil => rw [glob_cons_nil hstar] at h; cases h
      | cons head tail =>
        rw [glob_cons_cons hstar, Bool.and_eq_true, decide_eq_true_eq] at h
        rcases h.1 with e | e
        · exact absurd e hquestion
        · exact List.cons_prefix_cons.mpr ⟨e, literalPrefix_prefix pattern tail h.2⟩

theorem literalPrefix_append_literal : ∀ (a b : Text), isLiteral a = true →
    literalPrefix (a ++ b) = a ++ literalPrefix b
  | [], _, _ => rfl
  | unit :: a, b, h => by
    simp only [isLiteral, List.all_cons, Bool.and_eq_true, decide_eq_true_eq] at h
    have hmeta : ¬(unit = star ∨ unit = question) := fun e => e.elim h.1.1 h.1.2
    simp only [List.cons_append, literalPrefix, if_neg hmeta, literalPrefix_append_literal a b h.2]

theorem literalPrefix_append_glob : ∀ (a b : Text), isLiteral a = false →
    literalPrefix (a ++ b) = literalPrefix a
  | [], _, h => by simp [isLiteral] at h
  | unit :: a, b, h => by
    simp only [List.cons_append, literalPrefix]
    split
    · rfl
    · rename_i hmeta
      have ha : isLiteral a = false := by
        simp only [isLiteral, List.all_cons, Bool.and_eq_false_iff, decide_eq_false_iff_not] at h
        rcases h with h | h
        · exact absurd (fun (e : unit = star ∨ unit = question) => hmeta e)
            (fun hn => h ⟨fun e => hn (Or.inl e), fun e => hn (Or.inr e)⟩)
        · exact h
      rw [literalPrefix_append_glob a b ha]

/-- A literal resource selects itself only, the bare-command rule included. -/
theorem selects_literal {pattern text : Text} (hl : isLiteral pattern = true) (h : Selects pattern text) :
    text = pattern := by
  rcases h with h | ⟨command, hb, _⟩
  · exact (glob_literal _ _ hl).mp h
  · rw [bare_eq_some hb, isLiteral_command] at hl; cases hl

/-- A selected text starts with the pattern's literal prefix, or is a bare command one space short of it. -/
theorem selects_prefix {pattern text : Text} (h : Selects pattern text) :
    literalPrefix pattern <+: text ∨ literalPrefix pattern = text ++ [space] := by
  rcases h with h | ⟨command, hb, h⟩
  · exact Or.inl (literalPrefix_prefix _ _ h)
  · rw [bare_eq_some hb]
    cases hl : isLiteral command with
    | true =>
      right
      rw [literalPrefix_append_literal _ _ hl, (glob_literal _ _ hl).mp h]
      rfl
    | false =>
      left
      rw [literalPrefix_append_glob _ _ hl]
      exact literalPrefix_prefix _ _ h

theorem take_shared {left right whole : Text} (hl : left <+: whole) (hr : right <+: whole) :
    left.take (min left.length right.length) = right.take (min left.length right.length) := by
  obtain ⟨x, hx⟩ := hl
  obtain ⟨y, hy⟩ := hr
  rw [← List.take_append_of_le_length (l₂ := x) (Nat.min_le_left _ _),
    ← List.take_append_of_le_length (l₂ := y) (Nat.min_le_right _ _), hx, hy]

/--
**Disjointness is sound: `mayOverlap` never drops a live restriction.** When it answers `false`, no capability is
selected by both patterns.
-/
theorem mayOverlap_sound {left right : Pattern} {capability : Capability}
    (hl : selected left capability = true) (hr : selected right capability = true) :
    mayOverlap left right = true := by
  unfold mayOverlap
  rw [Bool.and_eq_true, Bool.or_eq_true]
  refine ⟨covers_of_selects_both (selected_iff.mp hl).1 (selected_iff.mp hr).1, ?_⟩
  have sl := (matchesResource_iff.mp (selected_text hl)).2
  have sr := (matchesResource_iff.mp (selected_text hr)).2
  unfold resourcesMayOverlap
  split
  · rename_i hlit
    rw [decide_eq_true_eq, ← selects_literal hlit.1 sl, ← selects_literal hlit.2 sr]
  · rw [decide_eq_true_eq]
    rcases selects_prefix sl with pl | el <;> rcases selects_prefix sr with pr | er
    · exact take_shared pl pr
    · exact take_shared (pl.trans (er ▸ List.prefix_append _ _)) (List.prefix_refl _)
    · exact take_shared (List.prefix_refl _) (pr.trans (el ▸ List.prefix_append _ _))
    · rw [el, er]

theorem covers_or_comm (left right : Selector) :
    (left.covers right || right.covers left) = (right.covers left || left.covers right) := Bool.or_comm _ _

/-- **Disjointness is symmetric.** -/
theorem mayOverlap_comm (left right : Pattern) : mayOverlap left right = mayOverlap right left := by
  unfold mayOverlap
  rw [covers_or_comm]
  congr 1
  unfold resourcesMayOverlap
  by_cases h : isLiteral left.resource = true ∧ isLiteral right.resource = true
  · rw [if_pos h, if_pos h.symm, Bool.eq_iff_iff, decide_eq_true_eq, decide_eq_true_eq]; exact eq_comm
  · rw [if_neg h, if_neg (fun hn => h hn.symm), Bool.eq_iff_iff, decide_eq_true_eq, decide_eq_true_eq,
      Nat.min_comm]
    exact eq_comm

/-! ## The normal form: sorted, each value once -/

section Normal

variable {α : Type} [StrictTotal α]

open StrictTotal

theorem mem_place {a x : α} : ∀ {values : List α}, x ∈ place a values ↔ x = a ∨ x ∈ values
  | [] => by simp [place]
  | b :: rest => by
    simp only [place]
    split
    · simp
    · split
      · rw [List.mem_cons, mem_place (values := rest), List.mem_cons]; exact or_left_comm
      · rename_i h₁ h₂
        have e : a = b := connected a b (by simpa using h₁) (by simpa using h₂)
        subst e; simp

theorem sorted_place (a : α) : ∀ {values : List α}, Sorted values → Sorted (place a values)
  | [], _ => by simp [place]
  | b :: rest, h => by
    obtain ⟨hb, hrest⟩ := List.pairwise_cons.mp h
    simp only [place]
    split
    · rename_i hab
      refine List.pairwise_cons.mpr ⟨fun x hx => ?_, h⟩
      rcases List.mem_cons.mp hx with rfl | hx
      · exact hab
      · exact trans a b x hab (hb x hx)
    · split
      · rename_i hba
        refine List.pairwise_cons.mpr ⟨fun x hx => ?_, sorted_place a hrest⟩
        rcases mem_place.mp hx with rfl | hx
        · exact hba
        · exact hb x hx
      · exact h

theorem sorted_normalize : ∀ (values : List α), Sorted (normalize values)
  | [] => List.Pairwise.nil
  | a :: rest => sorted_place a (sorted_normalize rest)

theorem mem_normalize {x : α} : ∀ {values : List α}, x ∈ normalize values ↔ x ∈ values
  | [] => by simp [normalize]
  | a :: rest => by
    show x ∈ place a (normalize rest) ↔ _
    rw [mem_place, mem_normalize (values := rest), List.mem_cons]

/-- **The normal form is unique.** Two sorted lists with the same values are the same list. -/
theorem sorted_ext : ∀ {l m : List α}, Sorted l → Sorted m → (∀ x, x ∈ l ↔ x ∈ m) → l = m
  | [], [], _, _, _ => rfl
  | [], b :: m, _, _, h => absurd ((h b).mpr List.mem_cons_self) (by simp)
  | a :: l, [], _, _, h => absurd ((h a).mp List.mem_cons_self) (by simp)
  | a :: l, b :: m, hl, hm, h => by
    obtain ⟨ha, hl'⟩ := List.pairwise_cons.mp hl
    obtain ⟨hb, hm'⟩ := List.pairwise_cons.mp hm
    have e : a = b := by
      rcases List.mem_cons.mp ((h a).mp List.mem_cons_self) with e | hab
      · exact e
      · rcases List.mem_cons.mp ((h b).mpr List.mem_cons_self) with e | hba
        · exact e.symm
        · have := trans a b a (ha b hba) (hb a hab)
          rw [irrefl] at this; cases this
    subst e
    have tails : ∀ x, x ∈ l ↔ x ∈ m := fun x => by
      constructor
      · intro hx
        rcases List.mem_cons.mp ((h x).mp (List.mem_cons_of_mem _ hx)) with e | hx'
        · have := ha x hx; rw [e, irrefl] at this; cases this
        · exact hx'
      · intro hx
        rcases List.mem_cons.mp ((h x).mpr (List.mem_cons_of_mem _ hx)) with e | hx'
        · have := hb x hx; rw [e, irrefl] at this; cases this
        · exact hx'
    rw [sorted_ext hl' hm' tails]

/-- The normal form depends on the values alone: not on their order, not on how often each is written. -/
theorem normalize_congr {l m : List α} (h : ∀ x, x ∈ l ↔ x ∈ m) : normalize l = normalize m :=
  sorted_ext (sorted_normalize l) (sorted_normalize m) fun x => by rw [mem_normalize, mem_normalize, h]

theorem normalize_of_sorted {values : List α} (h : Sorted values) : normalize values = values :=
  sorted_ext (sorted_normalize values) h fun _ => mem_normalize

theorem normalize_idem (values : List α) : normalize (normalize values) = normalize values :=
  normalize_of_sorted (sorted_normalize values)

theorem normalize_eq_nil {values : List α} : normalize values = [] ↔ values = [] := by
  constructor
  · intro h
    cases values with
    | nil => rfl
    | cons a rest =>
      have : a ∈ normalize (a :: rest) := mem_normalize.mpr List.mem_cons_self
      rw [h] at this; cases this
  · intro h; rw [h]; rfl

end Normal

/-! ## Capability sets -/

theorem mem_sortedGroups {groups : Groups} {group : List Pattern} :
    group ∈ sortedGroups groups ↔ ∃ written ∈ groups, normalize written = group := by
  unfold sortedGroups
  rw [mem_normalize, List.mem_map]

theorem empty_mem_sortedGroups {groups : Groups} : [] ∈ sortedGroups groups ↔ [] ∈ groups := by
  rw [mem_sortedGroups]
  constructor
  · rintro ⟨written, hw, hn⟩
    rw [normalize_eq_nil.mp hn] at hw; exact hw
  · intro h; exact ⟨[], h, rfl⟩

/-- A set with an empty group is the one set `nothing`; any other set is its sorted groups. -/
theorem make_eq (groups : Groups) : make groups = if [] ∈ groups then [[]] else sortedGroups groups := by
  unfold make
  have h : (sortedGroups groups).any List.isEmpty = true ↔ [] ∈ groups := by
    rw [← empty_mem_sortedGroups, List.any_eq_true]
    constructor
    · rintro ⟨group, hg, he⟩
      rw [List.isEmpty_iff.mp he] at hg; exact hg
    · intro hg; exact ⟨[], hg, rfl⟩
  by_cases hm : [] ∈ groups
  · rw [if_pos (h.mpr hm), if_pos hm]
  · rw [if_neg (fun hn => hm (h.mp hn)), if_neg hm]

/-- The normal form depends only on which sets of patterns the groups are. -/
theorem make_congr {left right : Groups}
    (h : ∀ group, (∃ written ∈ left, normalize written = group) ↔ ∃ written ∈ right, normalize written = group) :
    make left = make right := by
  have hs : sortedGroups left = sortedGroups right :=
    sorted_ext (sorted_normalize _) (sorted_normalize _) fun group => by
      rw [mem_sortedGroups, mem_sortedGroups, h]
  have he : [] ∈ left ↔ [] ∈ right := by
    have hm : [] ∈ sortedGroups left ↔ [] ∈ sortedGroups right := by rw [hs]
    exact empty_mem_sortedGroups.symm.trans (hm.trans empty_mem_sortedGroups)
  rw [make_eq, make_eq, hs]
  by_cases hm : [] ∈ left
  · rw [if_pos hm, if_pos (he.mp hm)]
  · rw [if_neg hm, if_neg (fun hn => hm (he.mpr hn))]

theorem make_congr_mem {left right : Groups} (h : ∀ group, group ∈ left ↔ group ∈ right) :
    make left = make right :=
  make_congr fun group => by
    constructor
    · rintro ⟨written, hw, hn⟩; exact ⟨written, (h written).mp hw, hn⟩
    · rintro ⟨written, hw, hn⟩; exact ⟨written, (h written).mpr hw, hn⟩

/-- Normalizing one side first changes nothing: the meet may be taken of written or of normal sets. -/
theorem make_make_append (left right : Groups) : make (make left ++ right) = make (left ++ right) := by
  by_cases hm : [] ∈ left
  · have hl : make left = [[]] := by rw [make_eq, if_pos hm]
    rw [hl, make_eq, make_eq, if_pos (by simp), if_pos (List.mem_append_left _ hm)]
  · have hl : make left = sortedGroups left := by rw [make_eq, if_neg hm]
    rw [hl]
    refine make_congr fun group => ?_
    constructor
    · rintro ⟨written, hw, hn⟩
      rcases List.mem_append.mp hw with hw | hw
      · obtain ⟨original, ho, hno⟩ := mem_sortedGroups.mp hw
        refine ⟨original, List.mem_append_left _ ho, ?_⟩
        rw [← hn, ← hno, normalize_idem]
      · exact ⟨written, List.mem_append_right _ hw, hn⟩
    · rintro ⟨written, hw, hn⟩
      rcases List.mem_append.mp hw with hw | hw
      · refine ⟨normalize written, List.mem_append_left _ (mem_sortedGroups.mpr ⟨written, hw, rfl⟩), ?_⟩
        rw [normalize_idem, hn]
      · exact ⟨written, List.mem_append_right _ hw, hn⟩

/-- **Normalizing is idempotent.** -/
theorem make_idem (groups : Groups) : make (make groups) = make groups := by
  have := make_make_append groups []
  rwa [List.append_nil, List.append_nil] at this

/-- **Commutativity.** -/
theorem intersect_comm (left right : Groups) : intersect left right = intersect right left :=
  make_congr_mem fun group => by rw [List.mem_append, List.mem_append]; exact or_comm

theorem intersect_make_left (left right : Groups) : intersect (make left) right = intersect left right :=
  make_make_append left right

theorem intersect_make_right (left right : Groups) : intersect left (make right) = intersect left right := by
  rw [intersect_comm, intersect_make_left, intersect_comm]

/-- **Associativity.** -/
theorem intersect_assoc (a b c : Groups) : intersect (intersect a b) c = intersect a (intersect b c) := by
  show intersect (make (a ++ b)) c = intersect a (make (b ++ c))
  rw [intersect_make_left, intersect_make_right]
  show make (a ++ b ++ c) = make (a ++ (b ++ c))
  rw [List.append_assoc]

/-- **Idempotency.** A set met with itself is its own normal form. -/
theorem intersect_self (groups : Groups) : intersect groups groups = make groups :=
  make_congr_mem fun group => by rw [List.mem_append, or_self]

/-- **Idempotency on normal sets.** A normal set met with itself is unchanged. -/
theorem intersect_idem (groups : Groups) : intersect (make groups) (make groups) = make groups := by
  rw [intersect_self, make_idem]

/-- **Empty authority absorbs.** No authority met with anything is no authority. -/
theorem intersect_nothing (groups : Groups) : intersect groups nothing = nothing := by
  show make (groups ++ [[]]) = [[]]
  rw [make_eq, if_pos (by simp)]

theorem nothing_intersect (groups : Groups) : intersect nothing groups = nothing := by
  rw [intersect_comm, intersect_nothing]

/-- **Unrestricted authority is the identity.** -/
theorem intersect_unrestricted (groups : Groups) : intersect (make groups) unrestricted = make groups := by
  show make (make groups ++ []) = make groups
  rw [List.append_nil, make_idem]

theorem unrestricted_intersect (groups : Groups) : intersect unrestricted (make groups) = make groups := by
  rw [intersect_comm, intersect_unrestricted]

theorem allows_unrestricted (capability : Capability) : allows unrestricted capability = true := rfl

/-- **Empty authority allows nothing.** -/
theorem allows_nothing (capability : Capability) : allows nothing capability = false := rfl

/-- Normalizing changes the writing of a set, never what it allows. -/
theorem allows_make (groups : Groups) (capability : Capability) :
    allows (make groups) capability = allows groups capability := by
  rw [make_eq]
  by_cases hm : [] ∈ groups
  · rw [if_pos hm]
    have : allows groups capability = false := by
      unfold allows
      rw [List.all_eq_false]
      exact ⟨[], hm, by simp⟩
    rw [this]; rfl
  · rw [if_neg hm, Bool.eq_iff_iff]
    unfold allows
    rw [List.all_eq_true, List.all_eq_true]
    constructor
    · intro h written hw
      have := h (normalize written) (mem_sortedGroups.mpr ⟨written, hw, rfl⟩)
      obtain ⟨pattern, hp, hs⟩ := List.any_eq_true.mp this
      exact List.any_eq_true.mpr ⟨pattern, mem_normalize.mp hp, hs⟩
    · intro h group hg
      obtain ⟨written, hw, hn⟩ := mem_sortedGroups.mp hg
      obtain ⟨pattern, hp, hs⟩ := List.any_eq_true.mp (h written hw)
      subst hn
      exact List.any_eq_true.mpr ⟨pattern, mem_normalize.mpr hp, hs⟩

/-- **The meet is exact.** The intersection allows a capability exactly when both sides do. -/
theorem allows_intersect (left right : Groups) (capability : Capability) :
    allows (intersect left right) capability = (allows left capability && allows right capability) := by
  unfold intersect
  rw [allows_make]
  unfold allows
  rw [List.all_append]

/--
**Attenuation is monotone: it never adds authority.** Whatever the attenuated set allows, the set before it allowed,
and so did the ceiling it was attenuated with.
-/
theorem intersect_attenuates {left right : Groups} {capability : Capability}
    (h : allows (intersect left right) capability = true) :
    allows left capability = true ∧ allows right capability = true := by
  rw [allows_intersect, Bool.and_eq_true] at h; exact h

/-- Attenuating again only narrows: authority is antitone in the list of ceilings. -/
theorem attenuate_monotone {current ceiling extra : Groups} {capability : Capability}
    (h : allows (intersect (intersect current ceiling) extra) capability = true) :
    allows (intersect current ceiling) capability = true :=
  (intersect_attenuates h).1

/--
**`within` is sound.** When `inner` is provably within `outer`, every capability `inner` allows, `outer` allows; so a
set that passes the check never stands for authority the outer set lacks.
-/
theorem within_sound {inner outer : Groups} {capability : Capability}
    (hl : ∀ group ∈ outer, ∀ pattern ∈ group, pattern.resource.length ≤ maxResourceLength)
    (hc : capability.resource.length ≤ maxResourceLength)
    (h : within inner outer = true) (ha : allows inner capability = true) : allows outer capability = true := by
  unfold within at h
  unfold allows at ha ⊢
  rw [List.all_eq_true] at h ha ⊢
  intro group hg
  obtain ⟨candidate, hcand, hall⟩ := List.any_eq_true.mp (h group hg)
  obtain ⟨pattern, hp, hs⟩ := List.any_eq_true.mp (ha candidate hcand)
  obtain ⟨cover, hcover, hsub⟩ := List.any_eq_true.mp (List.all_eq_true.mp hall pattern hp)
  exact List.any_eq_true.mpr ⟨cover, hcover, subsumes_sound (hl group hg cover hcover) hc hsub hs⟩

/-! ## Policy -/

theorem lastEffect_append (capability : Capability) (texts : List Text) (start : Effect) (a b : List Rule) :
    lastEffect capability texts start (a ++ b) =
      lastEffect capability texts (lastEffect capability texts start a) b := by
  unfold lastEffect; rw [List.foldl_append]

/-- The decision is the start or the effect of a rule that applies: no effect comes from nowhere. -/
theorem lastEffect_cases (capability : Capability) (texts : List Text) : ∀ (rules : List Rule) (start : Effect),
    lastEffect capability texts start rules = start ∨
      ∃ rule ∈ rules, applies capability texts rule = true ∧
        rule.effect = lastEffect capability texts start rules
  | [], _ => Or.inl rfl
  | rule :: rest, start => by
    have ih := lastEffect_cases capability texts rest
      (if applies capability texts rule then rule.effect else start)
    show lastEffect capability texts (if applies capability texts rule then rule.effect else start) rest = start ∨
      ∃ r ∈ rule :: rest, applies capability texts r = true ∧
        r.effect = lastEffect capability texts (if applies capability texts rule then rule.effect else start) rest
    rcases ih with ih | ⟨found, hf, ha, he⟩
    · by_cases happ : applies capability texts rule = true
      · rw [if_pos happ] at ih ⊢
        exact Or.inr ⟨rule, List.mem_cons_self, happ, ih.symm⟩
      · rw [if_neg happ] at ih ⊢
        exact Or.inl ih
    · exact Or.inr ⟨found, List.mem_cons_of_mem _ hf, ha, he⟩

/-- **Fail closed.** A request with no readable form is denied whatever the rules say. -/
theorem evaluate_undecidable {rulesets : List (List Rule)} {capability : Capability}
    (h : forms (.exact capability.action) capability.resource = none) : evaluate rulesets capability = .deny := by
  unfold evaluate; rw [h]

/-- **No ambient authority.** With no rule the decision is `ask`, never `allow`. -/
theorem evaluate_nil {capability : Capability} {texts : List Text}
    (h : forms (.exact capability.action) capability.resource = some texts) : evaluate [] capability = .ask := by
  unfold evaluate; rw [h]; rfl

/--
**The configured veto cannot be bypassed.** When the configured ruleset alone denies a request, no ruleset added
after it, whatever it allows, changes the decision.
-/
theorem configured_deny_veto {configured : List Rule} {capability : Capability}
    (h : evaluate [configured] capability = .deny) (later : List (List Rule)) :
    evaluate (configured :: later) capability = .deny := by
  unfold evaluate at h ⊢
  cases hf : forms (.exact capability.action) capability.resource with
  | none => rfl
  | some texts =>
    rw [hf] at h
    simp only [List.flatten_cons, List.flatten_nil, List.append_nil, List.headD_cons, List.any_append] at h ⊢
    by_cases hb : (configured.any fun rule => !withinMatchBudget rule.pattern capability) = true
    · simp [hb]
    · rw [if_neg hb] at h
      have hd : lastEffect capability texts .ask configured = .deny := by
        by_cases hd : lastEffect capability texts .ask configured = .deny
        · exact hd
        · rw [if_neg hd] at h; exact h
      split
      · rfl
      · rfl

/--
**A final denial wins.** A `deny` rule that selects any form of the resource, placed last, denies the request: no
earlier `allow` survives it.
-/
theorem final_deny_wins {rulesets : List (List Rule)} {rule : Rule} {capability : Capability} {texts : List Text}
    (hf : forms (.exact capability.action) capability.resource = some texts) (hd : rule.effect = .deny)
    (hr : restricts rule capability texts = true) : evaluate (rulesets ++ [[rule]]) capability = .deny := by
  have happ : applies capability texts rule = true := by
    simp [applies, skipped, hd, hr]
  unfold evaluate
  rw [hf]
  simp only
  split
  · rfl
  · split
    · rfl
    · rw [List.flatten_append, lastEffect_append]
      show (if applies capability texts rule then rule.effect else _) = Effect.deny
      rw [if_pos happ, hd]

/--
**An `allow` needs a grant.** A request is allowed only when some rule with effect `allow` selects it, in every form
of its resource; and private network access only when that rule names `net:private` exactly.
-/
theorem evaluate_allow_sound {rulesets : List (List Rule)} {capability : Capability}
    (h : evaluate rulesets capability = .allow) :
    ∃ rule ∈ rulesets.flatten, rule.effect = .allow ∧ selected rule.pattern capability = true ∧
      (capability.action = .netPrivate → rule.pattern.action = .exact .netPrivate) := by
  unfold evaluate at h
  cases hf : forms (.exact capability.action) capability.resource with
  | none => rw [hf] at h; cases h
  | some texts =>
    rw [hf] at h
    simp only at h
    split at h
    · cases h
    · split at h
      · cases h
      · rcases lastEffect_cases capability texts rulesets.flatten .ask with hs | ⟨rule, hmem, happ, he⟩
        · rw [hs] at h; cases h
        · rw [h] at he
          refine ⟨rule, hmem, he, ?_⟩
          unfold applies at happ
          rw [Bool.and_eq_true, if_pos he] at happ
          refine ⟨happ.2, fun hprivate => ?_⟩
          have hskip := happ.1
          simp only [skipped, Bool.not_eq_true', decide_eq_false_iff_not] at hskip
          exact Classical.byContradiction fun hne => hskip ⟨hprivate, he, hne⟩

/-- **Private network access is opt-in.** A namespace or whole-authority `allow` never reaches `net:private`. -/
theorem private_network_opt_in {rulesets : List (List Rule)} {resource : Text}
    (h : evaluate rulesets { action := .netPrivate, resource } = .allow) :
    ∃ rule ∈ rulesets.flatten, rule.effect = .allow ∧ rule.pattern.action = .exact .netPrivate := by
  obtain ⟨rule, hmem, he, _, hp⟩ := evaluate_allow_sound h
  exact ⟨rule, hmem, he, hp rfl⟩

end CapabilitySpec

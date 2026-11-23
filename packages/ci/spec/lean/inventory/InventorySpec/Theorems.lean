/-
What is proved of the reference. Every statement here is checked by Lean, and none of them is assumed: each has a complete proof.
-/
import InventorySpec.Expression
import InventorySpec.Matrix
import InventorySpec.Glob

namespace InventorySpec

/-! ## Expressions -/

/-- Evaluating is a function: the same expression in the same scope has one result. -/
theorem evaluate_deterministic (text : String) (scope : Scope) {first second : Evaluated}
    (hFirst : evaluate text scope = first) (hSecond : evaluate text scope = second) : first = second :=
  hFirst.symm.trans hSecond

/-- Reading is a function: one text has one tree or one problem. -/
theorem parse_deterministic (text : String) {first second : Except String Node}
    (hFirst : parse text = first) (hSecond : parse text = second) : first = second :=
  hFirst.symm.trans hSecond

/-- Finishing is a function of the expression and of what its variables hold. -/
theorem finish_deterministic (node : Residual) (knownVariable : Variable → Value) {first second : Finished}
    (hFirst : finish node knownVariable = first) (hSecond : finish node knownVariable = second) : first = second :=
  hFirst.symm.trans hSecond

/-- `!` of a tree is `!` of what the tree gives. -/
theorem walk_not (scope : Scope) (operand : Node) :
    walk scope (.not operand) = (walk scope operand).map notOf := by
  simp only [walk, look]
  cases (look scope operand).bind (settle "this context") <;> rfl

/-- `&&` with a known left side: the left side when it is false, and otherwise whatever the right side gives. -/
theorem walk_and_literal (scope : Scope) (left right : Node) (held : Value)
    (hLeft : walk scope left = .ok (.literal held)) :
    walk scope (.binary .and left right) = if truthy held then walk scope right else .ok (.literal held) := by
  simp only [walk] at hLeft
  simp only [walk, look, hLeft]
  cases truthy held <;> simp <;> cases (look scope right).bind (settle "this context") <;> rfl

/-- `||` with a known left side: the left side when it is true, and otherwise whatever the right side gives. -/
theorem walk_or_literal (scope : Scope) (left right : Node) (held : Value)
    (hLeft : walk scope left = .ok (.literal held)) :
    walk scope (.binary .or left right) = if truthy held then .ok (.literal held) else walk scope right := by
  simp only [walk] at hLeft
  simp only [walk, look, hLeft]
  cases truthy held <;> simp <;> cases (look scope right).bind (settle "this context") <;> rfl

/--
Short circuit of `&&`: a false left side is the result, whatever the right side is. The right side is never
read, so it may read a secret or be a problem without the expression doing so.
-/
theorem and_short_circuit (scope : Scope) (left right : Node) (held : Value)
    (hLeft : walk scope left = .ok (.literal held)) (hFalse : truthy held = false) :
    walk scope (.binary .and left right) = .ok (.literal held) := by
  rw [walk_and_literal scope left right held hLeft, hFalse]; rfl

/-- Short circuit of `||`: a true left side is the result, whatever the right side is. -/
theorem or_short_circuit (scope : Scope) (left right : Node) (held : Value)
    (hLeft : walk scope left = .ok (.literal held)) (hTrue : truthy held = true) :
    walk scope (.binary .or left right) = .ok (.literal held) := by
  rw [walk_or_literal scope left right held hLeft, hTrue]; rfl

/-- What `!` gives a known value is known, and is true exactly when the value is not. -/
theorem truthy_not (held : Value) : notOf (.literal held) = .literal (.bool (!truthy held)) := rfl

/-- De Morgan, with a known left side: `!(a && b)` is `!a || !b`, as results and in what is read. -/
theorem de_morgan_and (scope : Scope) (left right : Node) (held : Value)
    (hLeft : walk scope left = .ok (.literal held)) :
    walk scope (.not (.binary .and left right)) = walk scope (.binary .or (.not left) (.not right)) := by
  have hNot : walk scope (.not left) = .ok (.literal (.bool (!truthy held))) := by rw [walk_not, hLeft]; rfl
  rw [walk_not, walk_and_literal scope left right held hLeft, walk_or_literal scope _ _ _ hNot, walk_not]
  have hBool : ∀ b, truthy (.bool b) = b := fun _ => rfl
  cases hTruthy : truthy held <;> simp [hTruthy, hBool, notOf, Except.map]

/-- De Morgan, with a known left side: `!(a || b)` is `!a && !b`, as results and in what is read. -/
theorem de_morgan_or (scope : Scope) (left right : Node) (held : Value)
    (hLeft : walk scope left = .ok (.literal held)) :
    walk scope (.not (.binary .or left right)) = walk scope (.binary .and (.not left) (.not right)) := by
  have hNot : walk scope (.not left) = .ok (.literal (.bool (!truthy held))) := by rw [walk_not, hLeft]; rfl
  rw [walk_not, walk_or_literal scope left right held hLeft, walk_and_literal scope _ _ _ hNot, walk_not]
  have hBool : ∀ b, truthy (.bool b) = b := fun _ => rfl
  cases hTruthy : truthy held <;> simp [hTruthy, hBool, notOf, Except.map]

/-- Twice `!` of a known value is whether the value is true. -/
theorem not_not (held : Value) : notOf (notOf (.literal held)) = .literal (.bool (truthy held)) := by
  simp [notOf, truthy]

/--
A status function takes no values: given any, the result is a problem, whatever the scope says the status is
and whatever the values are. They are not evaluated, so one that reads a secret reads nothing.
-/
theorem status_takes_no_values (scope : Scope) (name : String) (args : List Node)
    (hName : name ∈ statusNames) (hArgs : args ≠ []) :
    walk scope (.call name args) =
      .error (.problem (name ++ " was given " ++ toString args.length ++ " values")) := by
  have hLength : args.length ≠ 0 := by
    cases args with
    | nil => exact absurd rfl hArgs
    | cons _ _ => simp
  simp [walk, look, hName, hLength, Except.bind]

/-- The same, as `evaluate` reports it once the expression is read. -/
theorem status_takes_no_values_evaluated (text : String) (scope : Scope) (name : String) (args : List Node)
    (hParse : parse text = .ok (.call name args)) (hName : name ∈ statusNames) (hArgs : args ≠ []) :
    evaluate text scope = .problem (name ++ " was given " ++ toString args.length ++ " values") := by
  simp [evaluate, hParse, status_takes_no_values scope name args hName hArgs]

/--
Own properties only, for a mapping: a property is `null` or the value of one of the mapping's own fields.
Nothing a JavaScript object inherits (`constructor`, `__proto__`, `toString`) can be read.
-/
theorem property_of_mapping_is_own (id : Nat) (fields : List (String × Value)) (name held : Value)
    (hProperty : property (.obj id fields) name = held) :
    held = .null ∨ ∃ key, (key, held) ∈ fields := by
  simp only [property] at hProperty
  cases hFound : fields.find? (fun x => lowerString x.1 == lowerString (toText name)) with
  | none => left; simpa [hFound] using hProperty.symm
  | some found =>
    right
    refine ⟨found.1, ?_⟩
    have hMember := List.mem_of_find?_eq_some hFound
    have hHeld : found.2 = held := by simpa [hFound] using hProperty
    rw [← hHeld]
    exact hMember

/-- Own properties only, for a list: a property is `null` or one of the list's entries. `length` is not one. -/
theorem property_of_list_is_own (id : Nat) (items : List Value) (name held : Value)
    (hProperty : property (.arr id items) name = held) : held = .null ∨ held ∈ items := by
  cases name with
  | num index =>
    simp only [property] at hProperty
    cases hIndex : (floatNat? index).bind (items[·]?) with
    | none => left; simpa [hIndex] using hProperty.symm
    | some found =>
      right
      have hHeld : found = held := by simpa [hIndex] using hProperty
      cases hNat : floatNat? index with
      | none => simp [hNat] at hIndex
      | some at_ =>
        simp [hNat] at hIndex
        rw [← hHeld]
        exact List.mem_of_getElem? hIndex
  | null | bool _ | str _ | arr _ _ | obj _ _ => left; exact hProperty.symm

/-- A value that is neither a list nor a mapping has no properties at all: not even a text's `length`. -/
theorem property_of_primitive (held name : Value) (hPrimitive : primitive held = true) :
    property held name = .null := by
  cases held <;> simp_all [primitive, property]

/-! ### The runner's verdict on a condition -/

/-- Whether a kind of value counts as true. `other` is never asked. -/
def ValueKind.isTrue : ValueKind → Bool
  | .text => Bool.true
  | .true => Bool.true
  | _ => Bool.false

/--
What a variable may hold while the job runs: text, or nothing at all when it is `nullable`. A `typed` variable is
a number or a boolean on GitHub and may hold anything.
-/
def Variable.admits (read : Variable) (held : Value) : Prop :=
  read.typed = true ∨
    match held with
    | .str _ => True
    | .null => read.nullable = true
    | _ => False

/-- `format` gives text. -/
theorem apply_format_text (args : List Value) (held : Value) (hApply : apply "format" args = .ok held) :
    ∃ text, held = .str text := by
  cases args with
  | nil => simp [apply] at hApply
  | cons template values =>
    simp only [apply] at hApply
    cases hFormat : format template values with
    | error stop => simp [hFormat, Except.map] at hApply
    | ok text => exact ⟨text, by simpa [hFormat, Except.map] using hApply.symm⟩

/-- One of two kinds is the kind of any truth. -/
theorem true_or_false_kind (held : Value) :
    ∃ kind ∈ [ValueKind.true, ValueKind.false], kind = .other ∨ kind.isTrue = truthy held := by
  cases hTruthy : truthy held
  · exact ⟨.false, by simp, Or.inr rfl⟩
  · exact ⟨.true, by simp, Or.inr rfl⟩

/--
The kinds `kindsOf` lists cover what the expression gives: whatever its variables hold, the value it finishes
to is of a kind a shell cannot tell (`other`), or one of the listed kinds counts as true exactly when it does.
-/
theorem kindsOf_covers (knownVariable : Variable → Value) (hAdmits : ∀ read : Variable, read.admits (knownVariable read)) :
    ∀ (node : Residual) (held : Value), valueOf knownVariable node = .ok held →
      ∃ kind ∈ kindsOf node, kind = .other ∨ kind.isTrue = truthy held
  | .literal value, held, hValue => by
    simp only [valueOf, Except.ok.injEq] at hValue
    subst hValue
    cases value with
    | null => exact ⟨.null, by simp [kindsOf], Or.inr rfl⟩
    | bool b => cases b <;> simp [kindsOf, truthy, ValueKind.isTrue]
    | num x => cases hTruthy : truthy (.num x) <;> simp [kindsOf, hTruthy, ValueKind.isTrue]
    | str text => cases hEmpty : text.isEmpty <;> simp [kindsOf, truthy, hEmpty, ValueKind.isTrue]
    | arr id items => exact ⟨.other, by simp [kindsOf], Or.inl rfl⟩
    | obj id fields => exact ⟨.other, by simp [kindsOf], Or.inl rfl⟩
  | .var read, held, hValue => by
    simp only [valueOf, Except.ok.injEq] at hValue
    have hHeld := hAdmits read
    rw [hValue] at hHeld
    cases hTyped : read.typed with
    | true => exact ⟨.other, by simp [kindsOf, hTyped], Or.inl rfl⟩
    | false =>
      rcases hHeld with hIsTyped | hHeld
      · simp [hTyped] at hIsTyped
      · cases held with
        | str text =>
          cases hEmpty : text.isEmpty <;> cases hNullable : read.nullable <;>
            simp [kindsOf, hTyped, hNullable, truthy, hEmpty, ValueKind.isTrue]
        | null =>
          have hNullable : read.nullable = true := hHeld
          simp [kindsOf, hTyped, hNullable, truthy, ValueKind.isTrue]
        | bool _ | num _ | arr _ _ | obj _ _ => exact absurd hHeld (by simp)
  | .not operand, held, _ => by
    simpa [kindsOf] using true_or_false_kind held
  | .call name args, held, hValue => by
    by_cases hFormat : name = "format"
    · subst hFormat
      simp only [valueOf] at hValue
      cases hArgs : valuesOf knownVariable args with
      | error stop => simp [hArgs, Except.bind] at hValue
      | ok values =>
        obtain ⟨text, hText⟩ := apply_format_text values held (by simpa [hArgs, Except.bind] using hValue)
        subst hText
        cases hEmpty : text.isEmpty <;> simp [kindsOf, truthy, hEmpty, ValueKind.isTrue]
    · simpa [kindsOf, hFormat] using true_or_false_kind held
  | .binary operator left right, held, hValue => by
    simp only [valueOf] at hValue
    cases hLeft : valueOf knownVariable left with
    | error stop => simp [hLeft] at hValue
    | ok leftHeld =>
      simp only [hLeft] at hValue
      obtain ⟨leftKind, hLeftKind, hLeftCovers⟩ := kindsOf_covers knownVariable hAdmits left leftHeld hLeft
      cases operator with
      | and =>
        simp only [true_or, ↓reduceIte, decide_true] at hValue
        cases hTruthy : truthy leftHeld with
        | true =>
          simp only [hTruthy, beq_self_eq_true, ↓reduceIte] at hValue
          obtain ⟨kind, hKind, hCovers⟩ := kindsOf_covers knownVariable hAdmits right held hValue
          exact ⟨kind, by simp [kindsOf, List.mem_eraseDups, hKind], hCovers⟩
        | false =>
          simp [hTruthy] at hValue
          subst hValue
          refine ⟨leftKind, ?_, hLeftCovers⟩
          simp only [kindsOf, ↓reduceIte, List.mem_eraseDups, List.mem_append, List.mem_filter]
          left
          refine ⟨hLeftKind, ?_⟩
          rcases hLeftCovers with hOther | hIsTrue
          · simp [hOther, falsyKinds]
          · rw [hTruthy] at hIsTrue
            cases leftKind <;> simp_all [falsyKinds, ValueKind.isTrue]
      | or =>
        simp only [or_true, ↓reduceIte] at hValue
        cases hTruthy : truthy leftHeld with
        | false =>
          simp [hTruthy] at hValue
          obtain ⟨kind, hKind, hCovers⟩ := kindsOf_covers knownVariable hAdmits right held hValue
          exact ⟨kind, by simp [kindsOf, List.mem_eraseDups, hKind], hCovers⟩
        | true =>
          simp [hTruthy] at hValue
          subst hValue
          refine ⟨leftKind, ?_, hLeftCovers⟩
          simp only [kindsOf, reduceCtorEq, ↓reduceIte, List.mem_eraseDups, List.mem_append, List.mem_filter]
          left
          refine ⟨hLeftKind, ?_⟩
          rcases hLeftCovers with hOther | hIsTrue
          · simp [hOther, truthyKinds]
          · rw [hTruthy] at hIsTrue
            cases leftKind <;> simp_all [truthyKinds, ValueKind.isTrue]
      | lt | le | gt | ge | eq | ne =>
        simpa [kindsOf] using true_or_false_kind held

/--
The runner's verdict is sound. When `settled` says a condition is true, or false, whatever its variables hold,
then every way of finishing it, with variables that hold what they may, gives a value that is.
-/
theorem settled_sound (knownVariable : Variable → Value) (hAdmits : ∀ read : Variable, read.admits (knownVariable read))
    (node : Residual) (held : Value) (verdict : Bool)
    (hValue : valueOf knownVariable node = .ok held) (hSettled : settled node = some verdict) :
    truthy held = verdict := by
  obtain ⟨kind, hKind, hCovers⟩ := kindsOf_covers knownVariable hAdmits node held hValue
  simp only [settled] at hSettled
  split at hSettled
  · rename_i hAll
    have hThis := List.all_eq_true.mp hAll kind hKind
    simp only [Option.some.injEq] at hSettled
    rw [← hSettled]
    rcases hCovers with hOther | hIsTrue
    · simp [hOther] at hThis
    · rw [← hIsTrue]
      cases kind <;> simp_all [falsyKinds, ValueKind.isTrue]
  · split at hSettled
    · rename_i hAll
      have hThis := List.all_eq_true.mp hAll kind hKind
      simp only [Option.some.injEq] at hSettled
      rw [← hSettled]
      rcases hCovers with hOther | hIsTrue
      · simp [hOther] at hThis
      · rw [← hIsTrue]
        cases kind <;> simp_all [truthyKinds, ValueKind.isTrue]
    · simp at hSettled

/-- A settled condition agrees with the runtime branch on every admitted assignment that finishes. -/
theorem runnerCondition_of_settled (knownVariable : Variable → Value)
    (hAdmits : ∀ read : Variable, read.admits (knownVariable read)) (node : Residual)
    (held : Value) (verdict : Bool) (hValue : valueOf knownVariable node = .ok held)
    (hSettled : settled node = some verdict) : runnerCondition knownVariable node = .ok verdict := by
  rw [runnerCondition, hValue, ← settled_sound knownVariable hAdmits node held verdict hValue hSettled]
  rfl

/-! ## Matrices -/

/-- Expanding is a function of the matrix as written. -/
theorem expandMatrix_deterministic (secret : String → String → Bool) (raw : Option Value) {first second : Matrix}
    (hFirst : expandMatrix secret raw = first) (hSecond : expandMatrix secret raw = second) : first = second :=
  hFirst.symm.trans hSecond

/-- The product of sizes. -/
def product : List Nat → Nat
  | [] => 1
  | size :: rest => size * product rest

/-- How many values a list of the matrix holds. -/
def axisSize : Value → Nat
  | .arr _ items => items.length
  | _ => 0

theorem allRead_length {α : Type} (items : List (Option α)) (read : List α) (hRead : allRead items = some read) :
    read.length = items.length := by
  induction items generalizing read with
  | nil => simp [allRead] at hRead; simp [← hRead]
  | cons item rest ih =>
    cases item with
    | none => simp [allRead] at hRead
    | some held =>
      cases hRest : allRead rest with
      | none => simp [allRead, hRest] at hRead
      | some more =>
        simp [allRead, hRest] at hRead
        simp [← hRead, ih more hRest]

/-- A list that can be read has as many values as were written. -/
theorem readAxis_length (name : String) (values : Value) (axis : List Assignment)
    (hAxis : readAxis name values = some axis) : axis.length = axisSize values := by
  cases values with
  | arr _ items =>
    have hRead : allRead (items.map (flatten name [])) = some axis := by simpa [readAxis] using hAxis
    rw [allRead_length _ axis hRead, List.length_map]; rfl
  | null | bool _ | num _ | str _ | obj _ _ => simp [readAxis] at hAxis

/-- Every combination with one more list: as many as there were, times the size of the list. -/
theorem cross_length (combinations axis : List Assignment) :
    (cross combinations axis).length = combinations.length * axis.length := by
  induction combinations with
  | nil => simp [cross]
  | cons base rest ih =>
    simp only [cross, List.flatMap_cons, List.length_append, List.length_map, List.length_cons] at ih ⊢
    rw [ih, Nat.succ_mul, Nat.add_comm]

/-- The combinations of the lists number the product of the lists' sizes. -/
theorem combine_length (lists : List (String × Value)) (combinations variants : List Assignment)
    (hCombine : combine combinations lists = .ok variants) :
    variants.length = combinations.length * product (lists.map fun entry => axisSize entry.2) := by
  induction lists generalizing combinations with
  | nil =>
    simp only [combine, Except.ok.injEq] at hCombine
    simp [product, hCombine]
  | cons entry rest ih =>
    obtain ⟨name, values⟩ := entry
    simp only [combine] at hCombine
    cases hAxis : readAxis name values with
    | none => simp [hAxis] at hCombine
    | some axis =>
      simp only [hAxis] at hCombine
      split at hCombine
      · simp at hCombine
      · rw [ih _ hCombine, cross_length, readAxis_length name values axis hAxis]
        simp [product, Nat.mul_assoc]

/-- The combinations never pass the limit: a list that would take them over it is refused. -/
theorem combine_length_le (lists : List (String × Value)) (combinations variants : List Assignment)
    (hStart : combinations.length ≤ maxVariants) (hCombine : combine combinations lists = .ok variants) :
    variants.length ≤ maxVariants := by
  induction lists generalizing combinations with
  | nil =>
    simp only [combine, Except.ok.injEq] at hCombine
    rw [← hCombine]; exact hStart
  | cons entry rest ih =>
    obtain ⟨name, values⟩ := entry
    simp only [combine] at hCombine
    cases hAxis : readAxis name values with
    | none => simp [hAxis] at hCombine
    | some axis =>
      simp only [hAxis] at hCombine
      split at hCombine
      · simp at hCombine
      · rename_i hLimit
        exact ih _ (by rw [cross_length]; exact Nat.le_of_not_gt hLimit) hCombine

theorem product_pos (sizes : List Nat) (hPositive : ∀ size ∈ sizes, 0 < size) : 0 < product sizes := by
  induction sizes with
  | nil => simp [product]
  | cons size rest ih =>
    simp only [product]
    exact Nat.mul_pos (hPositive size (by simp)) (ih fun other hOther => hPositive other (by simp [hOther]))

/--
The combinations are all there when they fit: lists that can each be read and hold a value, whose sizes
multiply to no more than the limit, are never refused.
-/
theorem combine_complete (lists : List (String × Value)) (combinations : List Assignment)
    (hRead : ∀ entry ∈ lists, (readAxis entry.1 entry.2).isSome = true ∧ 0 < axisSize entry.2)
    (hFits : combinations.length * product (lists.map fun entry => axisSize entry.2) ≤ maxVariants) :
    ∃ variants, combine combinations lists = .ok variants := by
  induction lists generalizing combinations with
  | nil => exact ⟨combinations, rfl⟩
  | cons entry rest ih =>
    obtain ⟨name, values⟩ := entry
    have hEntry := hRead (name, values) (by simp)
    cases hAxis : readAxis name values with
    | none => simp [hAxis] at hEntry
    | some axis =>
      have hSize := readAxis_length name values axis hAxis
      have hRest : ∀ other ∈ rest, (readAxis other.1 other.2).isSome = true ∧ 0 < axisSize other.2 :=
        fun other hOther => hRead other (by simp [hOther])
      have hPositive : 0 < product (rest.map fun other => axisSize other.2) :=
        product_pos _ fun size hMember => by
          obtain ⟨other, hOther, hSame⟩ := List.mem_map.mp hMember
          exact hSame ▸ (hRest other hOther).2
      simp only [List.map_cons, product, ← Nat.mul_assoc] at hFits
      have hStep : combinations.length * axis.length ≤ maxVariants := by
        rw [hSize]
        exact Nat.le_trans (Nat.le_mul_of_pos_right _ hPositive) hFits
      simp only [combine, hAxis, Nat.not_lt.mpr hStep, ↓reduceIte]
      exact ih _ hRest (by rw [cross_length, hSize]; exact hFits)

/-- `exclude` never adds a combination. -/
theorem applyExclude_length_le (excluded combinations : List Assignment) :
    (applyExclude excluded combinations).length ≤ combinations.length :=
  List.length_filter_le _ _

/-- Every combination `exclude` keeps was there before. -/
theorem applyExclude_subset (excluded combinations : List Assignment) (variant : Assignment)
    (hKept : variant ∈ applyExclude excluded combinations) : variant ∈ combinations :=
  (List.mem_filter.mp hKept).1

/-- With nothing to exclude, every combination stays. -/
theorem applyExclude_nil (combinations : List Assignment) : applyExclude [] combinations = combinations := by
  simp [applyExclude]

/-- `include` never takes the variants over the limit: an entry that would is refused. -/
theorem applyInclude_length_le (originals merged added included merged' added' : List Assignment)
    (hStart : merged.length + added.length ≤ maxVariants)
    (hInclude : applyInclude originals merged added included = .ok (merged', added')) :
    merged'.length + added'.length ≤ maxVariants := by
  induction included generalizing merged added with
  | nil =>
    simp only [applyInclude, Except.ok.injEq, Prod.mk.injEq] at hInclude
    rw [← hInclude.1, ← hInclude.2]; exact hStart
  | cons entry rest ih =>
    simp only [applyInclude] at hInclude
    split at hInclude
    · refine ih _ _ ?_ hInclude
      have hZip : (List.zipWith (fun variant join => if join then mergeEntry variant entry else variant) merged
          (originals.map (fits · entry))).length ≤ merged.length := by
        rw [List.length_zipWith]; exact Nat.min_le_left _ _
      exact Nat.le_trans (Nat.add_le_add_right hZip _) hStart
    · split at hInclude
      · simp at hInclude
      · rename_i hRoom
        refine ih _ _ ?_ hInclude
        simp only [List.length_append, List.length_cons, List.length_nil]
        have := Nat.lt_of_not_ge hRoom
        omega

/-- An expanded matrix has at most 256 variants. -/
theorem expandFields_length_le (secret : String → String → Bool) (fields : List (String × Value))
    (variants : List Assignment) (hExpand : expandFields secret fields = .ok variants) :
    variants.length ≤ maxVariants := by
  simp only [expandFields] at hExpand
  split at hExpand
  · rename_i excluded included _ _
    split at hExpand
    · simp at hExpand
    · rename_i combinations hCombine
      split at hExpand
      · simp at hExpand
      · rename_i merged added hInclude
        split at hExpand
        · simp at hExpand
        · split at hExpand
          · simp at hExpand
          · simp only [Except.ok.injEq] at hExpand
            rw [← hExpand, List.length_append]
            refine applyInclude_length_le _ _ _ _ _ _ ?_ hInclude
            have hCombined : combinations.length ≤ maxVariants :=
              combine_length_le _ _ _ (by split <;> simp [maxVariants]) hCombine
            simp only [List.length_nil, Nat.add_zero]
            exact Nat.le_trans (applyExclude_length_le _ _) hCombined
  · simp at hExpand

/-- Whatever is written, a matrix gives at most 256 variants. -/
theorem expandMatrix_length_le (secret : String → String → Bool) (raw : Option Value) :
    (expandMatrix secret raw).variants.length ≤ maxVariants := by
  unfold expandMatrix
  split
  · simp [noMatrix]
  · split
    · rename_i hExpand; exact expandFields_length_le _ _ _ hExpand
    · simp [noMatrix]
  · simp [noMatrix]

/-- A matrix with a problem has no variants. -/
theorem expandMatrix_problem_no_variants (secret : String → String → Bool) (raw : Option Value) (why : String)
    (hProblem : (expandMatrix secret raw).problem = some why) : (expandMatrix secret raw).variants = [] := by
  unfold expandMatrix at hProblem ⊢
  split
  · rfl
  · split
    · rename_i hExpand; simp [hExpand] at hProblem
    · rfl
  · rfl

theorem lookup_absent (fields : List (String × Value)) (name : String)
    (hAbsent : ∀ entry ∈ fields, entry.1 ≠ name) : fields.lookup name = none := by
  induction fields with
  | nil => rfl
  | cons entry rest ih =>
    obtain ⟨key, held⟩ := entry
    have hKey : (name == key) = false := by
      simpa using fun hSame => hAbsent (key, held) (by simp) hSame.symm
    simp only [List.lookup, hKey]
    exact ih fun other hOther => hAbsent other (List.mem_cons_of_mem _ hOther)

/--
With no `exclude` and no `include`, a matrix that expands has exactly the product of its lists' sizes as its
variants: every combination, once.
-/
theorem expandFields_cartesian (secret : String → String → Bool) (fields : List (String × Value))
    (variants : List Assignment) (hLists : fields ≠ [])
    (hPlain : ∀ entry ∈ fields, entry.1 ≠ "exclude" ∧ entry.1 ≠ "include")
    (hExpand : expandFields secret fields = .ok variants) :
    variants.length = product (fields.map fun entry => axisSize entry.2) := by
  have hExclude := lookup_absent fields "exclude" fun entry hEntry => (hPlain entry hEntry).1
  have hInclude := lookup_absent fields "include" fun entry hEntry => (hPlain entry hEntry).2
  have hFilter : fields.filter (fun entry => entry.1 != "exclude" && entry.1 != "include") = fields := by
    rw [List.filter_eq_self]
    intro entry hEntry
    simp [(hPlain entry hEntry).1, (hPlain entry hEntry).2]
  have hNonempty : fields.isEmpty = false := by
    cases fields with
    | nil => exact absurd rfl hLists
    | cons _ _ => rfl
  simp only [expandFields, hExclude, hInclude, readAssignments, hFilter, hNonempty, applyExclude_nil,
    applyInclude] at hExpand
  split at hExpand
  · simp at hExpand
  · rename_i combinations hCombine
    split at hExpand
    · simp at hExpand
    · split at hExpand
      · simp at hExpand
      · simp only [Except.ok.injEq] at hExpand
        rw [← hExpand, List.append_nil, combine_length _ _ _ hCombine]
        simp

/-! ## Globs -/

/-- Reading a pattern is a function of the pattern. -/
theorem regexOf_deterministic (pattern : String) {first second : Option String}
    (hFirst : regexOf pattern = first) (hSecond : regexOf pattern = second) : first = second :=
  hFirst.symm.trans hSecond

/-- Reading a list of patterns is a function of the list. -/
theorem filesOf_deterministic (patterns : List String) {first second : Option (Files String)}
    (hFirst : filesOf patterns = first) (hSecond : filesOf patterns = second) : first = second :=
  hFirst.symm.trans hSecond

/-- Taking the `/` off the end leaves nothing or leaves the first code unit where it was. -/
theorem stripTrailing_head (unit : Nat) (rest : List Nat) :
    stripTrailing (unit :: rest) = [] ∨ (stripTrailing (unit :: rest)).head? = some unit := by
  simp only [stripTrailing]
  split
  · split
    · left; rfl
    · right; rfl
  · right; rfl

/-- A pattern for an absolute path names nothing. -/
theorem absolute_refused (rest : List Nat) : regexUnits (slash :: rest) = none := by
  have hLeading : stripLeading (slash :: rest) = slash :: rest := by
    simp [stripLeading, slash]
  have hLeaves : leaves (normalize (slash :: rest)) = true := by
    simp only [normalize, hLeading]
    rcases stripTrailing_head slash rest with hEmpty | hHead
    · simp [leaves, hEmpty]
    · simp [leaves, hHead]
  simp [regexUnits, globOf, hLeaves]

/-- A pattern for a path under the home directory names nothing. -/
theorem home_refused (rest : List Nat) : regexUnits (126 :: rest) = none := by
  have hLeading : stripLeading (126 :: rest) = 126 :: rest := by
    simp [stripLeading]
  have hLeaves : leaves (normalize (126 :: rest)) = true := by
    simp only [normalize, hLeading]
    rcases stripTrailing_head 126 rest with hEmpty | hHead
    · simp [leaves, hEmpty]
    · simp [leaves, hHead]
  simp [regexUnits, globOf, hLeaves]

/-- A pattern whose path goes through `..` names nothing. -/
theorem parent_refused (pattern : List Nat) (hParent : [46, 46] ∈ splitOn slash (normalize pattern)) :
    regexUnits pattern = none := by
  have hLeaves : leaves (normalize pattern) = true := by
    simp [leaves, hParent]
  simp [regexUnits, globOf, hLeaves]

/-- A text always splits into at least one piece. -/
theorem splitOn_ne_nil (path : List Nat) : splitOn slash path ≠ [] := by
  cases path with
  | nil => simp [splitOn]
  | cons unit rest =>
    simp only [splitOn]
    split
    · simp
    · split <;> simp

/-- Taking the `./` off the start takes no `..` out of a path. -/
theorem parent_stripLeading (path : List Nat) (hParent : [46, 46] ∈ splitOn slash path) :
    [46, 46] ∈ splitOn slash (stripLeading path) := by
  fun_induction stripLeading path with
  | case1 rest ih =>
    apply ih
    have hSplit : splitOn slash (46 :: 47 :: rest) = [46] :: splitOn slash rest := by
      simp [splitOn, slash]
    rw [hSplit] at hParent
    simpa using hParent
  | case2 path _ => exact hParent

/-- Taking the `/` off the end only takes empty names off the end of a path. -/
theorem splitOn_stripTrailing (path : List Nat) :
    ∃ dropped, splitOn slash path =
      (if stripTrailing path = [] then [[]] else splitOn slash (stripTrailing path)) ++ List.replicate dropped [] := by
  induction path with
  | nil => exact ⟨0, by simp [splitOn, stripTrailing]⟩
  | cons unit rest ih =>
    obtain ⟨dropped, hRest⟩ := ih
    by_cases hUnit : unit = slash
    · subst hUnit
      have hSplit : splitOn slash (slash :: rest) = [] :: splitOn slash rest := by simp [splitOn]
      cases hKept : stripTrailing rest with
      | nil =>
        refine ⟨dropped + 1, ?_⟩
        have hStrip : stripTrailing (slash :: rest) = [] := by simp [stripTrailing, hKept]
        rw [hSplit, hRest, hStrip, hKept]
        simp [List.replicate_succ]
      | cons kept more =>
        refine ⟨dropped, ?_⟩
        have hStrip : stripTrailing (slash :: rest) = slash :: kept :: more := by simp [stripTrailing, hKept]
        have hOuter : splitOn slash (slash :: kept :: more) = [] :: splitOn slash (kept :: more) := by
          rw [splitOn]; simp
        rw [hSplit, hRest, hStrip, hKept, hOuter]
        simp
    · have hNot : (unit == slash) = false := by simpa using hUnit
      have hSplit : ∀ tail : List Nat, splitOn slash (unit :: tail) =
          match splitOn slash tail with
          | [] => [[unit]]
          | first :: others => (unit :: first) :: others := by
        intro tail; rw [splitOn]; simp only [hNot, Bool.false_eq_true, ↓reduceIte]
        cases splitOn slash tail <;> rfl
      cases hKept : stripTrailing rest with
      | nil =>
        refine ⟨dropped, ?_⟩
        have hStrip : stripTrailing (unit :: rest) = [unit] := by simp [stripTrailing, hKept, hNot]
        rw [hSplit rest, hRest, hStrip, hKept]
        simp [splitOn, hNot]
      | cons kept more =>
        refine ⟨dropped, ?_⟩
        have hStrip : stripTrailing (unit :: rest) = unit :: kept :: more := by simp [stripTrailing, hKept]
        rw [hSplit rest, hRest, hStrip, hKept, hSplit (kept :: more)]
        cases hNames : splitOn slash (kept :: more) with
        | nil => exact absurd hNames (splitOn_ne_nil _)
        | cons first others => simp

/-- A pattern as written with a `..` between two `/`, or at either end, names nothing. -/
theorem parent_refused_as_written (pattern : List Nat) (hParent : [46, 46] ∈ splitOn slash pattern) :
    regexUnits pattern = none := by
  apply parent_refused
  have hLeading := parent_stripLeading pattern hParent
  obtain ⟨dropped, hSplit⟩ := splitOn_stripTrailing (stripLeading pattern)
  rw [hSplit] at hLeading
  rcases List.mem_append.mp hLeading with hKept | hDropped
  · split at hKept
    · simp at hKept
    · exact hKept
  · simp [List.mem_replicate] at hDropped

/-- A pattern that names nothing has no regular expression, and so `filesOf` reads no list that holds one. -/
theorem regexOf_none_of_units (pattern : String) (hUnits : regexUnits (utf16 pattern.toList) = none) :
    regexOf pattern = none := by
  simp [regexOf, hUnits]

/-- As `regexOf` reads text: a pattern that starts with `/` has no regular expression. -/
theorem regexOf_absolute (pattern : String) (rest : List Nat) (hStart : utf16 pattern.toList = slash :: rest) :
    regexOf pattern = none :=
  regexOf_none_of_units pattern (hStart ▸ absolute_refused rest)

/-- As `regexOf` reads text: a pattern that starts with `~` has no regular expression. -/
theorem regexOf_home (pattern : String) (rest : List Nat) (hStart : utf16 pattern.toList = 126 :: rest) :
    regexOf pattern = none :=
  regexOf_none_of_units pattern (hStart ▸ home_refused rest)

/-- As `regexOf` reads text: a pattern with `..` for one of its names has no regular expression. -/
theorem regexOf_parent (pattern : String) (hParent : [46, 46] ∈ splitOn slash (utf16 pattern.toList)) :
    regexOf pattern = none :=
  regexOf_none_of_units pattern (parent_refused_as_written _ hParent)

/-- Three stars read as two. -/
theorem star_run_step (rest : List Nat) : scanGlob 0 (42 :: 42 :: 42 :: rest) = scanGlob 0 (42 :: 42 :: rest) := by
  simp [scanGlob]

/-- Collapsing a run of stars is idempotent: any run of two or more reads as exactly two. -/
theorem star_run_collapse (extra : Nat) (rest : List Nat) :
    scanGlob 0 (List.replicate extra 42 ++ 42 :: 42 :: rest) = scanGlob 0 (42 :: 42 :: rest) := by
  induction extra with
  | zero => rfl
  | succ extra ih =>
    have hTwo : ∃ more, List.replicate extra 42 ++ 42 :: 42 :: rest = 42 :: 42 :: more := by
      match extra with
      | 0 => exact ⟨rest, rfl⟩
      | 1 => exact ⟨42 :: rest, rfl⟩
      | extra + 2 => exact ⟨List.replicate extra 42 ++ 42 :: 42 :: rest, rfl⟩
    obtain ⟨more, hMore⟩ := hTwo
    rw [List.replicate_succ, List.cons_append, hMore, star_run_step, ← hMore, ih]

/-- A star is no `/`, so it stays when the `/` at the end goes. -/
theorem stripTrailing_star (rest : List Nat) : stripTrailing (42 :: rest) = 42 :: stripTrailing rest := by
  simp only [stripTrailing]
  split <;> simp_all [slash]

/-- A star at the start of a path is part of its first name, and the names after the first are the same. -/
theorem splitOn_star_rest (rest : List Nat) :
    (splitOn slash (42 :: rest)).drop 1 = (splitOn slash rest).drop 1 := by
  simp only [splitOn, slash]
  cases splitOn 47 rest <;> simp

/-- A path that starts with a star goes through `..` only after its first name. -/
theorem splitOn_star_parent (rest : List Nat) :
    (splitOn slash (42 :: rest)).contains [46, 46] = ((splitOn slash rest).drop 1).contains [46, 46] := by
  simp only [splitOn, slash]
  cases splitOn 47 rest <;> simp

/-- Whether a path that starts with stars leaves the repository does not depend on how many stars there are. -/
theorem leaves_star (rest : List Nat) : leaves (42 :: 42 :: rest) = leaves (42 :: rest) := by
  have hParent : (splitOn slash (42 :: 42 :: rest)).contains [46, 46]
      = (splitOn slash (42 :: rest)).contains [46, 46] := by
    rw [splitOn_star_parent, splitOn_star_rest, ← splitOn_star_parent]
  unfold leaves
  rw [hParent]
  rfl

/-- Three stars at the start of a pattern give the regular expression two give. -/
theorem regexUnits_star_run (rest : List Nat) :
    regexUnits (42 :: 42 :: 42 :: rest) = regexUnits (42 :: 42 :: rest) := by
  simp only [regexUnits, globOf, normalize, stripLeading, stripTrailing_star, leaves_star, star_run_step]

/-- `filesOf` never gives files with nothing to take. -/
theorem filesTokens_take_nonempty (patterns : List String) (files : Files (List GlobToken))
    (hFiles : filesTokens patterns = some files) : files.take ≠ [] := by
  simp only [filesTokens] at hFiles
  split at hFiles
  · split at hFiles
    · simp at hFiles
    · rename_i hTake
      simp only [Option.some.injEq] at hFiles
      rw [← hFiles]
      intro hEmpty
      simp [hEmpty] at hTake
  · simp at hFiles

/-- `filesOf` never gives files with nothing to take. -/
theorem filesOf_take_nonempty (patterns : List String) (files : Files String)
    (hFiles : filesOf patterns = some files) : files.take ≠ [] := by
  simp only [filesOf, Option.map_eq_some_iff] at hFiles
  obtain ⟨tokens, hTokens, hRendered⟩ := hFiles
  have hTake := filesTokens_take_nonempty patterns tokens hTokens
  rw [← hRendered]
  simpa using hTake

/-- A negated set with `/` added holds `/`. -/
theorem withSlash_covers_slash (items : List ClassItem) :
    (withSlash items).any (ClassItem.covers slash) = true := by
  simp only [withSlash]
  split <;> simp [ClassItem.covers]

/-- A negated set never matches `/`: whatever its members, it forbids the directory separator. -/
theorem negated_set_forbids_slash (body : List Nat) (items : List ClassItem)
    (hClass : classOf body = .set true items) : setMatches true items slash = false := by
  have hRest : ∀ negated rest, classOfRest negated rest = .set true items → setMatches true items slash = false := by
    intro negated rest hSet
    simp only [classOfRest] at hSet
    split at hSet
    · simp at hSet
    · cases hScan : scanClass negated false rest [] with
      | set isNegated found =>
        cases isNegated with
        | true =>
          simp only [hScan, addSlash, ClassScan.set.injEq, true_and] at hSet
          simp [setMatches, ← hSet, withSlash_covers_slash]
        | false => simp [hScan, addSlash] at hSet
      | slash => simp [hScan, addSlash] at hSet
      | invalid => simp [hScan, addSlash] at hSet
  exact hRest _ _ hClass

/-- A negated set that a pattern holds never matches `/` in a path either. -/
theorem negated_token_forbids_slash (items : List ClassItem) (more : List GlobToken) (rest : List Nat)
    (hSlash : setMatches true items slash = false) : matchTokens (.set true items :: more) (slash :: rest) = false := by
  simp [matchTokens, hSlash]

end InventorySpec

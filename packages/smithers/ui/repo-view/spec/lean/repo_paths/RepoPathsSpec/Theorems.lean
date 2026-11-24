import RepoPathsSpec.Resolve

/-!
# What the specification guarantees

Every statement here is checked by Lean. Texts are lists of UTF-16 code units: `/` is 47, `.` is 46, `:` is 58,
`?` is 63, `#` is 35, `%` is 37 and NUL is 0.
-/

namespace RepoPathsSpec

/-! ## Splitting and joining -/

theorem splitSlash_ne_nil (text : Text) : splitSlash text ≠ [] := by
  induction text with
  | nil => simp [splitSlash]
  | cons c cs ih =>
    unfold splitSlash
    split
    · simp
    · split <;> simp

/-- A text without `/` is its own single piece. -/
theorem splitSlash_of_no_slash (text : Text) (clean : 47 ∉ text) : splitSlash text = [text] := by
  induction text with
  | nil => simp [splitSlash]
  | cons c cs ih =>
    have head : c ≠ 47 := fun equal => clean (by simp [equal])
    have tail : 47 ∉ cs := fun inside => clean (by simp [inside])
    simp [splitSlash, head, ih tail]

/-- A `/` after a text without one ends that text's piece. -/
theorem splitSlash_append (first rest : Text) (clean : 47 ∉ first) :
    splitSlash (first ++ 47 :: rest) = first :: splitSlash rest := by
  induction first with
  | nil => simp [splitSlash]
  | cons c cs ih =>
    have head : c ≠ 47 := fun equal => clean (by simp [equal])
    have tail : 47 ∉ cs := fun inside => clean (by simp [inside])
    simp [splitSlash, head, ih tail]

/-- No piece of a split holds a `/`. -/
theorem splitSlash_no_slash (text : Text) : ∀ piece ∈ splitSlash text, 47 ∉ piece := by
  induction text with
  | nil => simp [splitSlash]
  | cons c cs ih =>
    unfold splitSlash
    split
    · intro piece inside
      rcases List.mem_cons.mp inside with rfl | later
      · simp
      · exact ih piece later
    · rename_i differs
      split
      · intro piece inside
        simp at inside
        subst inside
        simp
        exact fun equal => differs equal.symm
      · rename_i first rest shape
        intro piece inside
        rcases List.mem_cons.mp inside with rfl | later
        · have clean := ih first (by simp [shape])
          intro within
          rcases List.mem_cons.mp within with equal | deeper
          · exact differs equal.symm
          · exact clean deeper
        · exact ih piece (by simp [shape, later])

/-- Joining pieces that hold no `/` and splitting again gives the pieces back. -/
theorem splitSlash_joinSlash (pieces : List Text) (some : pieces ≠ []) (clean : ∀ piece ∈ pieces, 47 ∉ piece) :
    splitSlash (joinSlash pieces) = pieces := by
  induction pieces with
  | nil => exact absurd rfl some
  | cons first rest ih =>
    cases rest with
    | nil => simpa [joinSlash] using splitSlash_of_no_slash first (clean first (by simp))
    | cons second others =>
      have later := ih (by simp) (fun piece inside => clean piece (by simp [inside]))
      simp only [joinSlash]
      rw [splitSlash_append first _ (clean first (by simp)), later]

/-- Joining a prefix of the pieces gives a prefix of the joined text. -/
theorem joinSlash_prefix (shorter longer : List Text) (isPrefix : shorter <+: longer) :
    joinSlash shorter <+: joinSlash longer := by
  obtain ⟨extra, rfl⟩ := isPrefix
  induction shorter with
  | nil => simp [joinSlash]
  | cons first rest ih =>
    cases rest with
    | nil =>
      cases extra with
      | nil => simp [joinSlash]
      | cons next others => simp [joinSlash]
    | cons second others =>
      obtain ⟨tail, equal⟩ := ih
      refine ⟨tail, ?_⟩
      simp only [List.cons_append] at equal ⊢
      simp [joinSlash, ← equal]

/-! ## `parentOf` and `ancestorsOf` -/

/-- A path has one ancestor fewer than it has parts. -/
theorem ancestorsOf_length (path : Text) : (ancestorsOf path).length = (parts path).length - 1 := by
  simp [ancestorsOf]

/-- The ancestor at `index` is the first `index + 1` parts, joined. -/
theorem ancestorsOf_getElem? (path : Text) (index : Nat) (inside : index < (parts path).length - 1) :
    (ancestorsOf path)[index]? = some (joinSlash ((parts path).take (index + 1))) := by
  simp [ancestorsOf, List.getElem?_map, List.getElem?_range inside]

/-- A file at the root, and an empty path, have no ancestors. -/
theorem ancestorsOf_eq_nil (path : Text) : ancestorsOf path = [] ↔ (parts path).length ≤ 1 := by
  rw [← List.length_eq_zero_iff, ancestorsOf_length]
  omega

/-- Ancestors grow by whole parts: an outer ancestor is a prefix of every inner one. -/
theorem ancestorsOf_prefix_monotone (path : Text) (outer inner : Nat) (a b : Text) (order : outer ≤ inner)
    (atOuter : (ancestorsOf path)[outer]? = some a) (atInner : (ancestorsOf path)[inner]? = some b) : a <+: b := by
  have innerBound : inner < (parts path).length - 1 := by
    have := (List.getElem?_eq_some_iff.mp atInner).1
    rwa [ancestorsOf_length] at this
  have outerBound : outer < (parts path).length - 1 := by omega
  rw [ancestorsOf_getElem? path outer outerBound] at atOuter
  rw [ancestorsOf_getElem? path inner innerBound] at atInner
  injection atOuter with atOuter
  injection atInner with atInner
  subst atOuter atInner
  apply joinSlash_prefix
  have equal : (parts path).take (outer + 1) = ((parts path).take (inner + 1)).take (outer + 1) := by
    rw [List.take_take, Nat.min_eq_left (by omega)]
  rw [equal]
  exact List.take_prefix _ _

/-- Every ancestor is a prefix of the path's parts joined: an ancestor never leaves the path. -/
theorem ancestorsOf_prefix_of_path (path : Text) (ancestor : Text) (inside : ancestor ∈ ancestorsOf path) :
    ancestor <+: joinSlash (parts path) := by
  simp only [ancestorsOf, List.mem_map, List.mem_range] at inside
  obtain ⟨index, _, rfl⟩ := inside
  exact joinSlash_prefix _ _ (List.take_prefix _ _)

/-- No ancestor is the empty text: the root is never listed as a directory. -/
theorem ancestorsOf_ne_nil (path : Text) (ancestor : Text) (inside : ancestor ∈ ancestorsOf path) :
    ancestor ≠ [] := by
  simp only [ancestorsOf, List.mem_map, List.mem_range] at inside
  obtain ⟨index, bound, rfl⟩ := inside
  have filled : ∀ piece ∈ parts path, piece ≠ [] := by
    intro piece within
    simpa using (List.mem_filter.mp within).2
  cases shape : parts path with
  | nil => simp [shape] at bound
  | cons first rest =>
    have firstFilled : first ≠ [] := filled first (by simp [shape])
    cases first with
    | nil => exact absurd rfl firstFilled
    | cons unit units =>
      cases shapeTake : List.take index rest with
      | nil => simp [joinSlash, shapeTake]
      | cons second others => simp [joinSlash, shapeTake]

/--
For a path whose pieces are all non-empty (no leading, trailing or doubled `/`), the innermost ancestor is exactly
`parentOf`: the two functions agree on the directory that holds the path.
-/
theorem parentOf_eq_last_ancestor (path : Text) (normal : ∀ piece ∈ splitSlash path, piece ≠ [])
    (nested : 2 ≤ (splitSlash path).length) :
    (ancestorsOf path)[(ancestorsOf path).length - 1]? = some (parentOf path) := by
  have same : parts path = splitSlash path := by
    unfold parts
    exact List.filter_eq_self.mpr (fun piece inside => by simpa using normal piece inside)
  rw [ancestorsOf_length, ancestorsOf_getElem? path _ (by rw [same]; omega), same]
  have index : (splitSlash path).length - 1 - 1 + 1 = (splitSlash path).length - 1 := by omega
  rw [index, parentOf, List.dropLast_eq_take]

/-- A path without `/` sits at the root: no parent text and no ancestors. -/
theorem parentOf_of_no_slash (path : Text) (clean : 47 ∉ path) : parentOf path = [] ∧ ancestorsOf path = [] := by
  constructor
  · simp [parentOf, splitSlash_of_no_slash path clean, joinSlash]
  · rw [ancestorsOf_eq_nil, parts, splitSlash_of_no_slash path clean]
    exact Nat.le_trans (List.length_filter_le _ _) (by simp)

/-! ## Decoding -/

/-- Decoding a non-empty segment never gives the empty text. -/
theorem decodeSegment_ne_nil (raw decoded : Text) (some : raw ≠ []) (result : decodeSegment raw = .some decoded) :
    decoded ≠ [] := by
  cases raw with
  | nil => exact absurd rfl some
  | cons c cs =>
    simp only [decodeSegment, List.length_cons, decodeAux] at result
    split at result
    · simp at result
    · split at result
      · simp at result
      · injection result with result
        subst result
        simp

/-! ## The walk -/

/-- A name one tree entry may have: not empty, not `.`, not `..`, and holding neither NUL nor `/`. -/
def ValidComponent (component : Text) : Prop :=
  component ≠ [] ∧ component ≠ [46] ∧ component ≠ [46, 46] ∧ 0 ∉ component ∧ 47 ∉ component

/-- The walk only ever enters valid components, so a stack of valid components stays one. -/
theorem walk_valid (raws : List Text) :
    ∀ (stack result : List Text), (∀ component ∈ stack, ValidComponent component) → walk stack raws = some result →
      ∀ component ∈ result, ValidComponent component := by
  induction raws with
  | nil =>
    intro stack result valid walked
    simp only [walk] at walked
    injection walked with walked
    subst walked
    exact valid
  | cons raw rest ih =>
    intro stack result valid walked
    simp only [walk] at walked
    split at walked
    · exact ih stack result valid walked
    · rename_i filled
      split at walked
      · simp at walked
      · rename_i segment decoded
        split at walked
        · simp at walked
        · rename_i safe
          split at walked
          · exact ih stack result valid walked
          · rename_i notDot
            split at walked
            · split at walked
              · simp at walked
              · rename_i top below
                exact ih below result (fun component inside => valid component (by simp [inside])) walked
            · rename_i notDotDot
              refine ih (segment :: stack) result ?_ walked
              intro component inside
              rcases List.mem_cons.mp inside with rfl | older
              · exact ⟨decodeSegment_ne_nil raw _ filled decoded, notDot, notDotDot,
                  fun zero => safe (Or.inr zero), fun slash => safe (Or.inl slash)⟩
              · exact valid component older

/-- A piece that decodes to `..` refuses the link when the walk stands at the root. -/
theorem walk_dotdot_at_root (raw : Text) (rest : List Text) (decoded : decodeSegment raw = some [46, 46]) :
    walk [] (raw :: rest) = none := by
  have filled : raw ≠ [] := by
    intro empty
    subst empty
    simp [decodeSegment, decodeAux] at decoded
  simp [walk, filled, decoded]

/-- A piece that decodes to `..` leaves exactly the innermost directory. -/
theorem walk_dotdot_pops (raw top : Text) (below rest : List Text) (decoded : decodeSegment raw = some [46, 46]) :
    walk (top :: below) (raw :: rest) = walk below rest := by
  have filled : raw ≠ [] := by
    intro empty
    subst empty
    simp [decodeSegment, decodeAux] at decoded
  simp [walk, filled, decoded]

/--
No root escape. More climbing pieces than the stack is deep refuse the link, whatever follows them and however
each `..` is written (`..`, `%2e%2e`, `%2E.`, …): the walk can never stand above the root.
-/
theorem walk_underflow (climbs : List Text) (allClimb : ∀ raw ∈ climbs, decodeSegment raw = some [46, 46]) :
    ∀ (stack rest : List Text), stack.length < climbs.length → walk stack (climbs ++ rest) = none := by
  induction climbs with
  | nil => intro stack rest deeper; simp at deeper
  | cons raw others ih =>
    intro stack rest deeper
    have decoded := allClimb raw (by simp)
    cases stack with
    | nil => exact walk_dotdot_at_root raw _ decoded
    | cons top below =>
      rw [List.cons_append, walk_dotdot_pops raw top below _ decoded]
      exact ih (fun each inside => allClimb each (by simp [inside])) below rest (by simpa using deeper)

/-! ## `resolveLink`: what resolves to nothing -/

theorem schemeTail_of_name (name rest : Text) (named : ∀ c ∈ name, isSchemeChar c = true) :
    schemeTail (name ++ 58 :: rest) = true := by
  induction name with
  | nil => simp [schemeTail]
  | cons c cs ih =>
    have later := ih (fun each inside => named each (by simp [inside]))
    have here := named c (by simp)
    simp only [List.cons_append, schemeTail, here, later]
    split <;> rfl

/-- A link with a scheme (`https:`, `javascript:`, `x+y:`, …) never resolves into the repository. -/
theorem resolveLink_scheme (source : Text) (first : Nat) (name rest : Text) (paths folders : List Text)
    (letter : isAlpha first = true) (named : ∀ c ∈ name, isSchemeChar c = true) :
    resolveLink source (first :: (name ++ 58 :: rest)) paths folders = none := by
  simp [resolveLink, hasScheme, letter, schemeTail_of_name name rest named]

/-- Whatever `hasScheme` accepts never resolves: the executable form of the scheme rule. -/
theorem resolveLink_hasScheme (source href : Text) (paths folders : List Text) (scheme : hasScheme href = true) :
    resolveLink source href paths folders = none := by
  simp [resolveLink, scheme]

/-- A protocol-relative link (`//host/…`) never resolves into the repository. -/
theorem resolveLink_protocolRelative (source rest : Text) (paths folders : List Text) :
    resolveLink source (47 :: 47 :: rest) paths folders = none := by
  simp [resolveLink, protocolRelative]

/-- The empty link resolves to nothing. -/
theorem resolveLink_empty (source : Text) (paths folders : List Text) :
    resolveLink source [] paths folders = none := by
  simp [resolveLink, hasScheme, protocolRelative, bareOf]

/-- A link that is only a query (`?…`) resolves to nothing. -/
theorem resolveLink_query_only (source rest : Text) (paths folders : List Text) :
    resolveLink source (63 :: rest) paths folders = none := by
  simp [resolveLink, hasScheme, isAlpha, protocolRelative, bareOf]

/-- A link that is only an anchor (`#…`) resolves to nothing. -/
theorem resolveLink_anchor_only (source rest : Text) (paths folders : List Text) :
    resolveLink source (35 :: rest) paths folders = none := by
  simp [resolveLink, hasScheme, isAlpha, protocolRelative, bareOf]

/-! ## `resolveLink`: what a resolved path is made of -/

/-- The path of a resolved link is a walked stack, joined, and every component on that stack is valid. -/
theorem resolveLink_path (source href : Text) (paths folders : List Text) (target : LinkTarget)
    (resolved : resolveLink source href paths folders = some target) :
    ∃ stack, walk (baseOf source (bareOf href)).reverse (splitSlash (bareOf href)) = some stack
      ∧ target.path = joinSlash stack.reverse := by
  unfold resolveLink at resolved
  split at resolved
  · simp at resolved
  · split at resolved
    · simp at resolved
    · split at resolved
      · simp at resolved
      · rename_i stack walked
        refine ⟨stack, walked, ?_⟩
        split at resolved <;> (injection resolved with resolved; subst resolved; rfl)

/--
The security theorem. When the document's own directory is made of valid components, every `/`-separated component
of a resolved, non-empty path is valid: non-empty, not `.`, not `..`, and free of NUL and `/`. No percent-encoding
of the link (`%2e%2e`, `%2f`, `%00`, …) gets an invalid component through.
-/
theorem resolveLink_components_valid (source href : Text) (paths folders : List Text) (target : LinkTarget)
    (resolved : resolveLink source href paths folders = some target)
    (cleanSource : ∀ component ∈ parts (parentOf source), ValidComponent component) (filled : target.path ≠ []) :
    ∀ component ∈ splitSlash target.path, ValidComponent component := by
  obtain ⟨stack, walked, path⟩ := resolveLink_path source href paths folders target resolved
  have startValid : ∀ component ∈ (baseOf source (bareOf href)).reverse, ValidComponent component := by
    intro component inside
    rw [List.mem_reverse] at inside
    unfold baseOf at inside
    split at inside
    · simp at inside
    · exact cleanSource component inside
  have valid := walk_valid _ _ stack startValid walked
  have someStack : stack.reverse ≠ [] := by
    intro empty
    rw [path, empty] at filled
    exact filled rfl
  have split : splitSlash target.path = stack.reverse := by
    rw [path]
    exact splitSlash_joinSlash _ someStack (fun piece inside => (valid piece (List.mem_reverse.mp inside)).2.2.2.2)
  intro component inside
  rw [split] at inside
  exact valid component (List.mem_reverse.mp inside)

/--
The same guarantee for a link that starts with `/`, with nothing assumed about the document's path: a rooted link
is resolved from the root, so its target is made of the link's own decoded components alone.
-/
theorem resolveLink_rooted_components_valid (source href : Text) (paths folders : List Text) (target : LinkTarget)
    (resolved : resolveLink source href paths folders = some target) (rooted : (bareOf href).head? = some 47)
    (filled : target.path ≠ []) : ∀ component ∈ splitSlash target.path, ValidComponent component := by
  obtain ⟨stack, walked, path⟩ := resolveLink_path source href paths folders target resolved
  have valid := walk_valid _ _ stack (by simp [baseOf, rooted]) walked
  have someStack : stack.reverse ≠ [] := by
    intro empty
    rw [path, empty] at filled
    exact filled rfl
  have split : splitSlash target.path = stack.reverse := by
    rw [path]
    exact splitSlash_joinSlash _ someStack (fun piece inside => (valid piece (List.mem_reverse.mp inside)).2.2.2.2)
  intro component inside
  rw [split] at inside
  exact valid component (List.mem_reverse.mp inside)

/--
The assumption on the document's path is needed, not a convenience: a relative link is resolved against the
directory of the document it is written in, as given. The document `../a` (46 46 47 97) linking to `b` (98)
resolves to `../b`.
-/
theorem resolveLink_trusts_source :
    resolveLink [46, 46, 47, 97] [98] [] [] = some { kind := .blob, path := [46, 46, 47, 98] } := by
  decide

/-- The root is a directory: a link that resolves to the empty path opens the tree. -/
theorem resolveLink_root_is_tree (source href : Text) (paths folders : List Text) (target : LinkTarget)
    (resolved : resolveLink source href paths folders = some target) (root : target.path = []) :
    target.kind = .tree := by
  unfold resolveLink at resolved
  split at resolved
  · simp at resolved
  · split at resolved
    · simp at resolved
    · split at resolved
      · simp at resolved
      · split at resolved
        · injection resolved with resolved; subst resolved; rfl
        · rename_i notTree
          injection resolved with resolved
          subst resolved
          exact absurd (Or.inl root) notTree

/-- A link written with a trailing `/` opens the tree whenever it resolves. -/
theorem resolveLink_trailing_slash_is_tree (source href : Text) (paths folders : List Text) (target : LinkTarget)
    (resolved : resolveLink source href paths folders = some target) (trailing : (bareOf href).getLast? = some 47) :
    target.kind = .tree := by
  unfold resolveLink at resolved
  split at resolved
  · simp at resolved
  · split at resolved
    · simp at resolved
    · split at resolved
      · simp at resolved
      · split at resolved
        · injection resolved with resolved; subst resolved; rfl
        · rename_i notTree
          exact absurd (Or.inr (Or.inl trailing)) notTree

/--
No root escape, end to end. A rooted link whose first piece decodes to `..` resolves to nothing, whatever follows
and however the `..` is written, for every document and every repository.
-/
theorem resolveLink_rooted_dotdot (source raw rest : Text) (paths folders : List Text)
    (decoded : decodeSegment raw = some [46, 46]) (noSlash : 47 ∉ raw) (noQuery : 63 ∉ raw) (noAnchor : 35 ∉ raw)
    (ends : rest = [] ∨ rest.head? = some 47) :
    resolveLink source (47 :: (raw ++ rest)) paths folders = none := by
  have filled : raw ≠ [] := by
    intro empty
    subst empty
    simp [decodeSegment, decodeAux] at decoded
  obtain ⟨first, others, shape⟩ := List.exists_cons_of_ne_nil filled
  have firstNotSlash : first ≠ 47 := by
    intro equal
    exact noSlash (by simp [shape, equal])
  have notRelative : protocolRelative (47 :: (raw ++ rest)) = false := by
    rw [shape]
    simp only [List.cons_append]
    unfold protocolRelative
    split
    · rename_i heq
      injection heq with _ heq
      injection heq with heq _
      exact absurd heq firstNotSlash
    · rfl
  have keeps : ∀ c ∈ raw, (c != 63 && c != 35) = true := by
    intro c inside
    have notQuery : c ≠ 63 := fun equal => noQuery (equal ▸ inside)
    have notAnchor : c ≠ 35 := fun equal => noAnchor (equal ▸ inside)
    simp [notQuery, notAnchor]
  have bare : bareOf (47 :: (raw ++ rest)) = 47 :: (raw ++ bareOf rest) := by
    simp only [bareOf]
    rw [List.takeWhile_cons_of_pos (by decide), List.takeWhile_append_of_pos keeps]
  have pieces : ∃ later, splitSlash (bareOf (47 :: (raw ++ rest))) = [] :: raw :: later := by
    rw [bare]
    rcases ends with empty | slash
    · subst empty
      refine ⟨[], ?_⟩
      simp [bareOf, splitSlash, splitSlash_of_no_slash raw noSlash]
    · obtain ⟨tail, rfl⟩ : ∃ tail, rest = 47 :: tail := by
        cases rest with
        | nil => simp at slash
        | cons c cs => simp at slash; exact ⟨cs, by rw [slash]⟩
      refine ⟨splitSlash (bareOf tail), ?_⟩
      have step : bareOf (47 :: tail) = 47 :: bareOf tail := by
        simp only [bareOf]
        rw [List.takeWhile_cons_of_pos (by decide)]
      rw [step]
      simp only [splitSlash, if_true]
      rw [splitSlash_append raw _ noSlash]
  obtain ⟨later, pieces⟩ := pieces
  have base : baseOf source (bareOf (47 :: (raw ++ rest))) = [] := by
    rw [bare]
    simp [baseOf]
  have walked : walk [] ([] :: raw :: later) = none := by
    rw [show walk [] ([] :: raw :: later) = walk [] (raw :: later) by simp [walk]]
    exact walk_dotdot_at_root raw later decoded
  unfold resolveLink
  rw [base, pieces]
  simp [hasScheme, isAlpha, notRelative, bare, walked]

/-- `/..`, `/%2e%2e` and `/%2E%2e/etc` all resolve to nothing, from any document in any repository. -/
theorem resolveLink_rooted_dotdot_examples (source : Text) (paths folders : List Text) :
    resolveLink source [47, 46, 46] paths folders = none
      ∧ resolveLink source [47, 37, 50, 101, 37, 50, 101] paths folders = none
      ∧ resolveLink source [47, 37, 50, 69, 37, 50, 101, 47, 101, 116, 99] paths folders = none := by
  refine ⟨?_, ?_, ?_⟩
  · exact resolveLink_rooted_dotdot source [46, 46] [] paths folders (by decide) (by decide) (by decide)
      (by decide) (Or.inl rfl)
  · exact resolveLink_rooted_dotdot source [37, 50, 101, 37, 50, 101] [] paths folders (by decide) (by decide)
      (by decide) (by decide) (Or.inl rfl)
  · exact resolveLink_rooted_dotdot source [37, 50, 69, 37, 50, 101] [47, 101, 116, 99] paths folders (by decide)
      (by decide) (by decide) (by decide) (Or.inr rfl)

/-- Encoded separators and NULs refuse the link: `%2f`, `a%2Fb` and `%00` resolve to nothing from the root. -/
theorem resolveLink_encoded_separator_and_nul (paths folders : List Text) :
    resolveLink [] [37, 50, 102] paths folders = none
      ∧ resolveLink [] [97, 37, 50, 70, 98] paths folders = none
      ∧ resolveLink [] [37, 48, 48] paths folders = none
      ∧ resolveLink [] [0] paths folders = none := by
  refine ⟨?_, ?_, ?_, ?_⟩ <;> simp [resolveLink, hasScheme, isAlpha, schemeTail, isSchemeChar, protocolRelative,
    bareOf, splitSlash, baseOf, parts, parentOf, joinSlash, walk, decodeSegment, decodeAux, decodeStep, escape,
    hexVal]

end RepoPathsSpec

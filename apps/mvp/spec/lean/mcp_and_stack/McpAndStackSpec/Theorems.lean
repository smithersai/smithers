import McpAndStackSpec.Roles
import McpAndStackSpec.BlockedActs
import McpAndStackSpec.McpAuth
import McpAndStackSpec.StackOrder

/-!
# What the specification keeps

Machine-checked: rank is monotone and every gate follows it, a person-only act is refused by name whoever asks, a
call runs only a catalog tool whose every gate holds, a token a header yields has the token's format, and a stack
that keeps its rules keeps them after every change: open positions exactly 1 to n with none twice, settled TODOs
final, and no more TODOs working than lanes allow.
-/

namespace McpAndStackSpec

/-! ## Roles -/

/-- No role outranks Admin. -/
theorem rankOf_le_four (role : Option Role) : rankOf role ≤ 4 := by
  rcases role with _ | (_ | _ | _ | _) <;> simp [rankOf]

/-- Rank tells the roles apart. -/
theorem rankOf_injective (a b : Option Role) (h : rankOf a = rankOf b) : a = b := by
  rcases a with _ | (_ | _ | _ | _) <;> rcases b with _ | (_ | _ | _ | _) <;> simp [rankOf] at h ⊢

/-- Only no role has rank 0. -/
theorem rankOf_eq_zero (role : Option Role) : rankOf role = 0 ↔ role = none := by
  rcases role with _ | (_ | _ | _ | _) <;> simp [rankOf]

/-- Member or above is rank 2 or above. -/
theorem memberOrAbove_iff_rank (role : Option Role) : memberOrAbove role = true ↔ 2 ≤ rankOf role := by
  rcases role with _ | (_ | _ | _ | _) <;> simp [memberOrAbove, rankOf]

/-- Whoever may ask, every role above may. -/
theorem memberOrAbove_mono (a b : Option Role) (h : rankOf a ≤ rankOf b) (may : memberOrAbove a = true) :
    memberOrAbove b = true := by
  rw [memberOrAbove_iff_rank] at *
  omega

/-- Reading a stack is monotone in role. -/
theorem mayRead_mono (a b : Actor) (h : rankOf a.role ≤ rankOf b.role) (may : mayRead (some a) = true) :
    mayRead (some b) = true :=
  memberOrAbove_mono a.role b.role h may

/-- Committing and dropping are monotone in role, for the same way of acting. -/
theorem mayChange_mono (a b : Actor) (h : rankOf a.role ≤ rankOf b.role) (same : a.agent = b.agent)
    (may : mayChange a = true) : mayChange b = true := by
  simp only [mayChange, canAsk, Bool.and_eq_true] at *
  exact ⟨memberOrAbove_mono a.role b.role h may.1, same ▸ may.2⟩

/-- Retrying anyone's TODO is rank 3 or above. -/
theorem mayRetryAny_iff_rank (actor : Actor) : mayRetryAny actor = true ↔ 3 ≤ rankOf actor.role := by
  rcases actor with ⟨_ | (_ | _ | _ | _), agent⟩ <;> simp [mayRetryAny, rankOf]

/-- Retrying anyone's TODO is monotone in role. -/
theorem mayRetryAny_mono (a b : Actor) (h : rankOf a.role ≤ rankOf b.role) (may : mayRetryAny a = true) :
    mayRetryAny b = true := by
  rw [mayRetryAny_iff_rank] at *
  omega

/-- A stack's settings are the top rank's, in person. -/
theorem mayConfigure_iff (actor : Actor) : mayConfigure actor = true ↔ rankOf actor.role = 4 ∧ actor.agent = false := by
  rcases actor with ⟨_ | (_ | _ | _ | _), agent⟩ <;> simp [mayConfigure, rankOf]

/-- Whoever may configure a stack may change it and retry anyone's TODO. -/
theorem mayConfigure_implies (actor : Actor) (may : mayConfigure actor = true) :
    mayChange actor = true ∧ mayRetryAny actor = true ∧ mayRead (some actor) = true := by
  rcases actor with ⟨_ | (_ | _ | _ | _), _ | _⟩ <;> simp [mayConfigure, mayChange, mayRetryAny, mayRead, canAsk, memberOrAbove] at may ⊢

/-- Whoever may change a stack may read it. -/
theorem mayChange_implies_mayRead (actor : Actor) (may : mayChange actor = true) : mayRead (some actor) = true := by
  simp only [mayChange, Bool.and_eq_true] at may
  exact may.1

/-- No signed-out request reads a stack. -/
theorem signed_out_never_reads : mayRead none = false := rfl

/-- An agent never commits, drops or configures, whatever its person's role. -/
theorem agent_never_changes (actor : Actor) (acts : actor.agent = true) :
    mayChange actor = false ∧ mayConfigure actor = false := by
  simp [mayChange, mayConfigure, acts]

/-- A change is the agent's exactly when someone acts for the person. -/
theorem viaOf_agent_iff (actor : Actor) : viaOf actor = .agent ↔ actor.agent = true := by
  cases h : actor.agent <;> simp [viaOf, h]

/-- A change the stack admits is a person's own. -/
theorem mayChange_via_person (actor : Actor) (may : mayChange actor = true) : viaOf actor = .person := by
  simp only [mayChange, Bool.and_eq_true, Bool.not_eq_true'] at may
  simp [viaOf, may.2]

/-! ## Person-only acts -/

set_option maxRecDepth 4000 in
/-- Every person-only act is blocked under its own name. -/
theorem acts_blocked : ∀ act ∈ blockedActs, isBlockedName act = true ∧ isBlockedMcpAct act = true := by decide

set_option maxRecDepth 4000 in
/-- Every person-only act is blocked under its tool spelling, `pull_merge`. -/
theorem underscored_blocked :
    ∀ act ∈ blockedActs, isBlockedName (underscored act) = true ∧ isBlockedMcpAct (underscored act) = true := by
  decide

set_option maxRecDepth 4000 in
/-- Every person-only act is a blocked act under its dotted spelling, `pull.merge`. -/
theorem dotted_blocked : ∀ act ∈ blockedActs, isBlockedMcpAct (replaceFirst slash dot act) = true := by decide

set_option maxRecDepth 4000 in
/-- An act is its own canonical form, and its tool spelling's. -/
theorem canonical_of_act : ∀ act ∈ blockedActs, canonical act = act ∧ canonical (underscored act) = act := by decide

/-- The registry's check is inside the auth service's: a blocked tool name is a blocked act. -/
theorem blocked_name_is_blocked_act (name : Text) (blocked : isBlockedName name = true) :
    isBlockedMcpAct name = true := by
  unfold isBlockedName at blocked
  rw [List.any_eq_true] at blocked
  obtain ⟨act, member, either⟩ := blocked
  simp only [Bool.or_eq_true, decide_eq_true_eq] at either
  rcases either with rfl | rfl
  · exact (acts_blocked act member).2
  · exact (underscored_blocked act member).2

/-- A blocked tool name is an act or its tool spelling: nothing else is refused by name. -/
theorem blocked_name_iff (name : Text) :
    isBlockedName name = true ↔ ∃ act ∈ blockedActs, name = act ∨ name = underscored act := by
  unfold isBlockedName
  rw [List.any_eq_true]
  constructor
  · rintro ⟨act, member, either⟩
    simp only [Bool.or_eq_true, decide_eq_true_eq] at either
    exact ⟨act, member, either.elim (fun h => .inl h.symm) (fun h => .inr h.symm)⟩
  · rintro ⟨act, member, either⟩
    refine ⟨act, member, ?_⟩
    simp only [Bool.or_eq_true, decide_eq_true_eq]
    exact either.elim (fun h => .inl h.symm) (fun h => .inr h.symm)

/-- Reading `_` and `.` as `/` twice is reading them once. -/
theorem canonical_idempotent (name : Text) : canonical (canonical name) = canonical name := by
  unfold canonical
  rw [List.map_map]
  apply List.map_congr_left
  intro unit _
  simp only [Function.comp, slash, underscore, dot]
  by_cases h : unit = 95 ∨ unit = 46 <;> simp [h]

/-- The canonical form is as long as the name. -/
theorem canonical_length (name : Text) : (canonical name).length = name.length := by simp [canonical]

/-- A blocked act stays blocked in canonical form: no respelling of `_`, `.` and `/` unblocks it. -/
theorem blocked_act_canonical (name : Text) (blocked : isBlockedMcpAct name = true) :
    isBlockedMcpAct (canonical name) = true := by
  simp only [isBlockedMcpAct, Bool.or_eq_true, decide_eq_true_eq] at blocked ⊢
  rcases blocked with member | member
  · exact .inl ((canonical_of_act name member).1.symm ▸ member)
  · exact .inl member

/-- Two names with one canonical form are blocked acts together. -/
theorem blocked_act_of_canonical_eq (a b : Text) (same : canonical a = canonical b) (blocked : isBlockedMcpAct a = true) :
    isBlockedMcpAct b = true := by
  have canon := blocked_act_canonical a blocked
  simp only [isBlockedMcpAct, Bool.or_eq_true, decide_eq_true_eq] at canon ⊢
  rw [canonical_idempotent] at canon
  exact .inr (same ▸ canon.elim id id)

set_option maxRecDepth 8000 in
/-- No tool of the catalog is a person-only act, in either check. -/
theorem catalog_not_blocked :
    ∀ spec ∈ catalog, isBlockedName spec.name = false ∧ isBlockedMcpAct spec.name = false := by decide

set_option maxRecDepth 8000 in
/-- The catalog names each tool once. -/
theorem catalog_names_distinct : (catalog.map (·.name)).Nodup := by decide

/-! ## The tool gate -/

/-- Non-bypassable: a blocked name is refused `person_only`, whatever the token, role and visibility. -/
theorem blocked_never_runs (name : Text) (principal : Option Principal) (role : Option Role) (isPublic : Bool)
    (blocked : isBlockedName name = true) : callOutcome name principal role isPublic = .personOnly := by
  simp [callOutcome, blocked]

/-- Every person-only act, in both spellings, is refused whoever asks: an Admin's own agent included. -/
theorem acts_never_run (act : Text) (member : act ∈ blockedActs) (principal : Option Principal)
    (role : Option Role) (isPublic : Bool) :
    callOutcome act principal role isPublic = .personOnly ∧
      callOutcome (underscored act) principal role isPublic = .personOnly :=
  ⟨blocked_never_runs _ _ _ _ (acts_blocked act member).1, blocked_never_runs _ _ _ _ (underscored_blocked act member).1⟩

/-- An agent never merges a pull request and never commits or drops a TODO, under any spelling the registry reads. -/
theorem agents_never_merge_or_commit (principal : Option Principal) (role : Option Role) (isPublic : Bool) :
    callOutcome (u16! "pull/merge") principal role isPublic = .personOnly ∧
    callOutcome (u16! "pull_merge") principal role isPublic = .personOnly ∧
    callOutcome (u16! "todo/commit") principal role isPublic = .personOnly ∧
    callOutcome (u16! "todo_commit") principal role isPublic = .personOnly ∧
    callOutcome (u16! "todo/drop") principal role isPublic = .personOnly ∧
    callOutcome (u16! "todo_drop") principal role isPublic = .personOnly := by
  refine ⟨?_, ?_, ?_, ?_, ?_, ?_⟩ <;> exact blocked_never_runs _ _ _ _ (by decide)

/-- Fail-closed: a name that is no tool is not found. -/
theorem unknown_never_runs (name : Text) (principal : Option Principal) (role : Option Role) (isPublic : Bool)
    (unknown : toolOf name = none) : callOutcome name principal role isPublic ≠ .ok := by
  unfold callOutcome
  split
  · simp
  · simp [unknown]

/-- The tool a name finds carries that name and is the catalog's. -/
theorem toolOf_some (name : Text) (spec : ToolSpec) (found : toolOf name = some spec) :
    spec ∈ catalog ∧ spec.name = name := by
  unfold toolOf at found
  exact ⟨List.mem_of_find?_eq_some found, by simpa using List.find?_some found⟩

/-- A read that runs: the token is not pinned elsewhere, non-public or role-gated reads carry `mcp:read`, a private repository's caller has a role, and the role is met. -/
theorem readOutcome_ok (principal : Option Principal) (role : Option Role) (isPublic : Bool) (minimum : Option Role)
    (ran : readOutcome principal role isPublic minimum = .ok) :
    (∀ token, principal = some token → token.pinnedElsewhere = false) ∧
    ((isPublic = false ∨ minimum ≠ none) → ∃ token, principal = some token ∧ token.read = true) ∧
    (isPublic = false → ∃ token, principal = some token ∧ role ≠ none) ∧
    rankOf minimum ≤ rankOf (principal.bind fun _ => role) := by
  unfold readOutcome at ran
  cases principal with
  | none =>
    cases isPublic <;> cases minimum <;> simp [readPermitted, meets] at ran ⊢
  | some token =>
    cases pinned : token.pinnedElsewhere <;> cases read : token.read <;> cases isPublic <;>
      simp [pinned, read, readPermitted, meets] at ran ⊢
    · by_cases minNone : minimum = none <;> simp [minNone] at ran ⊢
      subst minNone
      simp [rankOf]
    · by_cases norole : role = none <;> simp [norole] at ran ⊢
      exact ran
    · by_cases met : rankOf minimum ≤ rankOf role <;> simp [met] at ran ⊢

/-- A write that runs: a token, its own agent's act, `mcp:write`, the token's repository, the role met. -/
theorem writeOutcome_ok (principal : Option Principal) (role minimum : Option Role)
    (ran : writeOutcome principal role minimum = .ok) :
    ∃ token, principal = some token ∧ token.actOk = true ∧ token.write = true ∧ token.pinnedElsewhere = false ∧
      rankOf minimum ≤ rankOf role := by
  unfold writeOutcome at ran
  cases principal with
  | none => simp at ran
  | some token =>
    cases act : token.actOk <;> cases write : token.write <;> cases pinned : token.pinnedElsewhere <;>
      simp [act, write, pinned, meets] at ran ⊢
    by_cases met : rankOf minimum ≤ rankOf role <;> simp [met] at ran ⊢

/--
Fail-closed: a call that runs names a catalog tool that is no person-only act, meets its least role with the live
role (none for a visitor), and for a write carries a token with `mcp:write` and its own agent's act.
-/
theorem ok_sound (name : Text) (principal : Option Principal) (role : Option Role) (isPublic : Bool)
    (ran : callOutcome name principal role isPublic = .ok) :
    isBlockedName name = false ∧
    ∃ spec ∈ catalog, spec.name = name ∧
      rankOf spec.minimum ≤ rankOf (principal.bind fun _ => role) ∧
      (∀ token, principal = some token → token.pinnedElsewhere = false) ∧
      (spec.access = .write → ∃ token, principal = some token ∧ token.actOk = true ∧ token.write = true) := by
  unfold callOutcome at ran
  split at ran
  · simp at ran
  · rename_i open_
    refine ⟨by simpa using open_, ?_⟩
    split at ran
    · simp at ran
    · rename_i spec found
      obtain ⟨member, named⟩ := toolOf_some name spec found
      refine ⟨spec, member, named, ?_⟩
      cases access : spec.access <;> simp only [access] at ran
      · obtain ⟨pinned, _, _, met⟩ := readOutcome_ok _ _ _ _ ran
        exact ⟨met, pinned, by simp⟩
      · obtain ⟨token, rfl, act, write, pinned, met⟩ := writeOutcome_ok _ _ _ ran
        exact ⟨by simpa using met, by simpa using pinned, fun _ => ⟨token, rfl, act, write⟩⟩

/-- A visitor never writes: a write with no token asks for authentication. -/
theorem anonymous_never_writes (role minimum : Option Role) : writeOutcome none role minimum = .authentication := rfl

/-- A token without `mcp:write` never writes. -/
theorem read_only_never_writes (token : Principal) (role minimum : Option Role) (readOnly : token.write = false) :
    writeOutcome (some token) role minimum ≠ .ok := by
  intro ran
  obtain ⟨other, same, _, write, _⟩ := writeOutcome_ok _ _ _ ran
  cases same
  simp [readOnly] at write

/-- No role, no write: every write tool's least role is a real one. -/
theorem roleless_never_writes (name : Text) (token : Principal) (isPublic : Bool) (spec : ToolSpec)
    (found : toolOf name = some spec) (writes : spec.access = .write) :
    callOutcome name (some token) none isPublic ≠ .ok := by
  unfold callOutcome
  split
  · simp
  · simp only [found, writes]
    intro ran
    obtain ⟨_, _, _, _, _, met⟩ := writeOutcome_ok _ _ _ ran
    have minimum : ∀ spec ∈ catalog, spec.access = .write → 1 ≤ rankOf spec.minimum := by decide
    have least := minimum spec (toolOf_some name spec found).1 writes
    have zero : rankOf (none : Option Role) = 0 := rfl
    omega

/-- A private or role-gated read never runs without explicit `mcp:read` consent. -/
theorem private_or_gated_read_needs_scope (principal : Option Principal) (role : Option Role) (isPublic : Bool)
    (minimum : Option Role) (restricted : isPublic = false ∨ minimum ≠ none)
    (noRead : ∀ token, principal = some token → token.read = false) :
    readOutcome principal role isPublic minimum ≠ .ok := by
  intro ran
  obtain ⟨_, needsRead, _, _⟩ := readOutcome_ok _ _ _ _ ran
  obtain ⟨token, eq, hasRead⟩ := needsRead restricted
  have := noRead token eq
  simp [this] at hasRead

/-- A private repository is read only with a role. -/
theorem private_needs_role (principal : Option Principal) (isPublic : Bool) (minimum : Option Role)
    (closed : isPublic = false) : readOutcome principal none isPublic minimum ≠ .ok := by
  intro ran
  obtain ⟨_, _, role, _⟩ := readOutcome_ok _ _ _ _ ran
  obtain ⟨_, _, absurd⟩ := role closed
  exact absurd rfl

/-- Reads are monotone in role. -/
theorem readOutcome_mono (principal : Option Principal) (low high : Option Role) (isPublic : Bool)
    (minimum : Option Role) (le : rankOf low ≤ rankOf high)
    (ran : readOutcome principal low isPublic minimum = .ok) : readOutcome principal high isPublic minimum = .ok := by
  have some_high : low ≠ none → high ≠ none := by
    intro has none_
    subst none_
    exact has ((rankOf_eq_zero low).mp (by simp [rankOf] at le; exact le))
  unfold readOutcome at ran ⊢
  cases principal with
  | none => exact ran
  | some token =>
    cases pinned : token.pinnedElsewhere <;> cases perm : readPermitted (some token) isPublic minimum <;>
      simp only [pinned, perm] at ran ⊢
    · simp at ran
    · cases isPublic <;> simp [meets] at ran ⊢
      · by_cases norole : low = none <;> simp [norole] at ran
        by_cases met : rankOf minimum ≤ rankOf low <;> simp [met] at ran
        simp [some_high norole]
        omega
      · by_cases met : rankOf minimum ≤ rankOf low <;> simp [met] at ran
        omega
    · simp at ran
    · simp at ran

/-- Writes are monotone in role. -/
theorem writeOutcome_mono (principal : Option Principal) (low high minimum : Option Role)
    (le : rankOf low ≤ rankOf high) (ran : writeOutcome principal low minimum = .ok) :
    writeOutcome principal high minimum = .ok := by
  obtain ⟨token, rfl, act, write, pinned, met⟩ := writeOutcome_ok _ _ _ ran
  have : rankOf minimum ≤ rankOf high := by omega
  simp [writeOutcome, act, write, pinned, meets, this]

/-- Role rank monotonicity: a call that runs at a role runs at every role above it. -/
theorem callOutcome_mono (name : Text) (principal : Option Principal) (low high : Option Role) (isPublic : Bool)
    (le : rankOf low ≤ rankOf high) (ran : callOutcome name principal low isPublic = .ok) :
    callOutcome name principal high isPublic = .ok := by
  unfold callOutcome at ran ⊢
  split
  · simp_all
  · rename_i open_
    simp only [open_] at ran
    split
    · simp_all
    · rename_i spec found
      simp only [found] at ran
      cases access : spec.access <;> simp only [access] at ran ⊢
      · exact readOutcome_mono _ _ _ _ _ le ran
      · exact writeOutcome_mono _ _ _ _ le ran

/-- A listing is monotone in role: a tool listed for a role is listed for every role above it. -/
theorem visible_mono (spec : ToolSpec) (low high : Option Role) (principal : Option Principal) (isPublic : Bool)
    (le : rankOf low ≤ rankOf high) (seen : visible spec low principal isPublic = true) :
    visible spec high principal isPublic = true := by
  have some_high : low ≠ none → high ≠ none := by
    intro has none_
    subst none_
    exact has ((rankOf_eq_zero low).mp (by simp [rankOf] at le; exact le))
  unfold visible at seen ⊢
  simp only [meets, Bool.and_eq_true, decide_eq_true_eq] at seen ⊢
  refine ⟨?_, by omega⟩
  cases access : spec.access <;> simp only [access] at seen ⊢
  · cases isPublic <;> simp only [Bool.not_true, Bool.not_false, Bool.false_and, Bool.true_and,
      Bool.and_eq_true, Bool.not_eq_true', decide_eq_false_iff_not] at seen ⊢
    · exact ⟨some_high seen.1.1, seen.1.2⟩
    · exact seen.1
  · cases principal <;> exact seen.1

/-- A listing names only catalog tools, and never a person-only act. -/
theorem listTools_sound (principal : Option Principal) (inRepo : Bool) (role : Option Role) (isPublic : Bool)
    (name : Text) (listed : name ∈ listTools principal inRepo role isPublic) :
    isBlockedName name = false ∧ ∃ spec ∈ catalog, spec.name = name := by
  unfold listTools at listed
  obtain ⟨spec, kept, rfl⟩ := List.mem_map.mp listed
  obtain ⟨member, shown⟩ := List.mem_filter.mp kept
  simp only [Bool.and_eq_true, Bool.not_eq_true'] at shown
  exact ⟨shown.1, spec, member, rfl⟩

/-- A write tool is listed only for a token with `mcp:write`. -/
theorem write_listed_needs_scope (spec : ToolSpec) (role : Option Role) (principal : Option Principal) (isPublic : Bool)
    (writes : spec.access = .write) (seen : visible spec role principal isPublic = true) :
    ∃ token, principal = some token ∧ token.write = true := by
  cases principal with
  | none => simp [visible, writes] at seen
  | some token =>
    simp only [visible, writes, Bool.and_eq_true] at seen
    exact ⟨token, rfl, seen.1⟩

/-! ## The bearer token -/

/-- `[0-9a-f]`, as ranges. -/
theorem isLowerHex_iff (unit : Nat) : isLowerHex unit = true ↔ (48 ≤ unit ∧ unit ≤ 57) ∨ (97 ≤ unit ∧ unit ≤ 102) := by
  simp [isLowerHex]

/-- An upper-case hex digit is no token digit. -/
theorem upper_hex_refused (unit : Nat) (upper : 65 ≤ unit ∧ unit ≤ 70) : isLowerHex unit = false := by
  cases h : isLowerHex unit
  · rfl
  · rw [isLowerHex_iff] at h
    omega

/-- Token format soundness: a valid token is `sma_` and 64 lowercase hex digits, 68 units in all. -/
theorem valid_token_sound (token : Text) (valid : isValidTokenFormat token = true) :
    token.length = 68 ∧ token = tokenPrefix ++ token.drop 4 ∧ (token.drop 4).length = 64 ∧
      ∀ unit ∈ token.drop 4, isLowerHex unit = true := by
  simp only [isValidTokenFormat, Bool.and_eq_true, decide_eq_true_eq, List.all_eq_true] at valid
  obtain ⟨⟨starts, long⟩, digits⟩ := valid
  refine ⟨?_, ?_, long, digits⟩
  · have := List.length_drop (i := 4) (l := token)
    omega
  · rw [← starts, List.take_append_drop]

/-- Token format completeness: `sma_` and any 64 lowercase hex digits is a valid token. -/
theorem valid_token_complete (digits : Text) (long : digits.length = 64)
    (hex : ∀ unit ∈ digits, isLowerHex unit = true) : isValidTokenFormat (tokenPrefix ++ digits) = true := by
  have taken : (tokenPrefix ++ digits).take 4 = tokenPrefix := by simp [tokenPrefix]
  have dropped : (tokenPrefix ++ digits).drop 4 = digits := by simp [tokenPrefix]
  simp only [isValidTokenFormat, taken, dropped, long, Bool.and_eq_true, decide_eq_true_eq, List.all_eq_true]
  exact ⟨⟨trivial, trivial⟩, hex⟩

/-- A valid token is determined by its 64 digits. -/
theorem valid_token_digits_injective (a b : Text) (va : isValidTokenFormat a = true) (vb : isValidTokenFormat b = true)
    (same : a.drop 4 = b.drop 4) : a = b := by
  rw [(valid_token_sound a va).2.1, (valid_token_sound b vb).2.1, same]

/-- No header is absent, and only no header. -/
theorem parseBearer_absent (header : Option Text) : parseBearer header = .absent ↔ header = none := by
  cases header with
  | none => simp [parseBearer]
  | some text =>
    simp only [parseBearer, reduceCtorEq, iff_false]
    repeat' split
    all_goals simp

/-- A token a header yields has the token's format: nothing malformed reaches the token lookup. -/
theorem parseBearer_sound (header : Option Text) (token : Text) (parsed : parseBearer header = .token token) :
    isValidTokenFormat token = true := by
  cases header with
  | none => simp [parseBearer] at parsed
  | some text =>
    simp only [parseBearer] at parsed
    repeat' split at parsed
    all_goals first
      | (injection parsed with same; subst same; assumption)
      | simp at parsed

/-- An empty or oversized header is malformed, whatever it says. -/
theorem parseBearer_bounds (text : Text) (out : text.length = 0 ∨ text.length > maxHeaderLength) :
    parseBearer (some text) = .malformed := by
  simp only [parseBearer]
  rw [if_pos out]

/-! ## The TODO stack: what a kept stack is -/

/-- The positions the placed TODOs hold, in row order. -/
def positions (todos : List Row) : List Nat := todos.filterMap (·.position)

/-- How many TODOs hold a lane. -/
def working (todos : List Row) : Nat := (todos.filter fun todo => todo.state.inLane).length

/--
A stack that keeps its rules: each TODO has its own id, no position is held twice, every position is within 1 to
the count of placed TODOs, and a TODO is settled exactly when it has no position.
-/
structure Kept (todos : List Row) : Prop where
  ids : (todos.map (·.id)).Nodup
  distinct : (positions todos).Nodup
  bounded : ∀ position ∈ positions todos, 1 ≤ position ∧ position ≤ (positions todos).length
  placed : ∀ todo ∈ todos, todo.state.settled = true ↔ todo.position = none

/-- The empty stack keeps its rules. -/
theorem kept_nil : Kept [] := ⟨List.nodup_nil, List.nodup_nil, by simp [positions], by simp⟩

theorem positions_cons (x : Row) (xs : List Row) :
    positions (x :: xs) = match x.position with
      | none => positions xs
      | some position => position :: positions xs := by
  unfold positions
  rw [List.filterMap_cons]
  cases x.position <;> rfl

theorem mem_positions {todos : List Row} {position : Nat} :
    position ∈ positions todos ↔ ∃ todo ∈ todos, todo.position = some position := by
  simp [positions, List.mem_filterMap]

/-- With ids told apart, a TODO is its id. -/
theorem eq_of_id {todos : List Row} (ids : (todos.map (·.id)).Nodup) {a b : Row} (ha : a ∈ todos) (hb : b ∈ todos)
    (same : a.id = b.id) : a = b := by
  induction todos with
  | nil => cases ha
  | cons x xs ih =>
    rw [List.map_cons, List.nodup_cons] at ids
    rcases List.mem_cons.mp ha with rfl | ha' <;> rcases List.mem_cons.mp hb with rfl | hb'
    · rfl
    · exact absurd (List.mem_map.mpr ⟨b, hb', same.symm⟩) ids.1
    · exact absurd (List.mem_map.mpr ⟨a, ha', same⟩) ids.1
    · exact ih ids.2 ha' hb'

/-- No duplicate positions: two TODOs at one position are one TODO. -/
theorem eq_of_position {todos : List Row} (distinct : (positions todos).Nodup) {a b : Row} (ha : a ∈ todos)
    (hb : b ∈ todos) {position : Nat} (pa : a.position = some position) (pb : b.position = some position) :
    a = b := by
  induction todos with
  | nil => cases ha
  | cons x xs ih =>
    rw [positions_cons] at distinct
    rcases List.mem_cons.mp ha with rfl | ha' <;> rcases List.mem_cons.mp hb with rfl | hb'
    · rfl
    · simp only [pa] at distinct
      exact absurd (mem_positions.mpr ⟨b, hb', pb⟩) (List.nodup_cons.mp distinct).1
    · simp only [pb] at distinct
      exact absurd (mem_positions.mpr ⟨a, ha', pa⟩) (List.nodup_cons.mp distinct).1
    · have rest : (positions xs).Nodup := by
        cases hx : x.position <;> simp only [hx] at distinct
        · exact distinct
        · exact (List.nodup_cons.mp distinct).2
      exact ih rest ha' hb'

theorem positions_map {g : Row → Row} {todos : List Row} (same : ∀ todo ∈ todos, (g todo).position = todo.position) :
    positions (todos.map g) = positions todos := by
  induction todos with
  | nil => rfl
  | cons x xs ih =>
    rw [List.map_cons, positions_cons, positions_cons, same x (by simp), ih (fun todo member => same todo (by simp [member]))]

theorem ids_map {g : Row → Row} {todos : List Row} (same : ∀ todo ∈ todos, (g todo).id = todo.id) :
    (todos.map g).map (·.id) = todos.map (·.id) := by
  rw [List.map_map]
  apply List.map_congr_left
  intro todo member
  simpa using same todo member

/-- A change of rows that keeps each id, position and whether it is settled keeps the stack's rules. -/
theorem Kept.map {g : Row → Row} {todos : List Row} (kept : Kept todos)
    (same : ∀ todo ∈ todos,
      (g todo).id = todo.id ∧ (g todo).position = todo.position ∧ (g todo).state.settled = todo.state.settled) :
    Kept (todos.map g) := by
  have places := positions_map (g := g) (todos := todos) (fun todo member => (same todo member).2.1)
  refine ⟨?_, ?_, ?_, ?_⟩
  · rw [ids_map (fun todo member => (same todo member).1)]
    exact kept.ids
  · rw [places]
    exact kept.distinct
  · rw [places]
    exact kept.bounded
  · intro changed changedMember
    obtain ⟨todo, member, rfl⟩ := List.mem_map.mp changedMember
    rw [(same todo member).2.1, (same todo member).2.2]
    exact kept.placed todo member

/-! ## Pigeonholes -/

/-- A list with no repeats inside another is no longer than it. -/
theorem nodup_subset_length_le {α : Type} [DecidableEq α] :
    ∀ (inner outer : List α), inner.Nodup → (∀ a ∈ inner, a ∈ outer) → inner.length ≤ outer.length
  | [], _, _, _ => Nat.zero_le _
  | a :: rest, outer, nodup, subset => by
    rw [List.nodup_cons] at nodup
    have head : a ∈ outer := subset a (by simp)
    have inside : ∀ b ∈ rest, b ∈ outer.erase a := by
      intro b member
      have differs : b ≠ a := fun same => nodup.1 (same ▸ member)
      exact (List.mem_erase_of_ne differs).mpr (subset b (by simp [member]))
    have smaller := nodup_subset_length_le rest (outer.erase a) nodup.2 inside
    rw [List.length_erase_of_mem head] at smaller
    have positive := List.length_pos_of_mem head
    simp only [List.length_cons]
    omega

/-- Contiguous positions: the open TODOs of a kept stack hold every position from 1 to their count. -/
theorem positions_contiguous {todos : List Row} (kept : Kept todos) (position : Nat) (low : 1 ≤ position)
    (high : position ≤ (positions todos).length) : position ∈ positions todos := by
  apply Classical.byContradiction
  intro missing
  have inside : ∀ held ∈ positions todos, held ∈ (List.range' 1 (positions todos).length).erase position := by
    intro held member
    have differs : held ≠ position := fun same => missing (same ▸ member)
    have bound := kept.bounded held member
    exact (List.mem_erase_of_ne differs).mpr (List.mem_range'_1.mpr (by omega))
  have smaller := nodup_subset_length_le _ _ kept.distinct inside
  have present : position ∈ List.range' 1 (positions todos).length := List.mem_range'_1.mpr (by omega)
  rw [List.length_erase_of_mem present, List.length_range'] at smaller
  omega

/-- Each position from 1 to n is held by exactly one open TODO. -/
theorem position_held_once {todos : List Row} (kept : Kept todos) (position : Nat) (low : 1 ≤ position)
    (high : position ≤ (positions todos).length) :
    ∃ todo ∈ todos, todo.position = some position ∧
      ∀ other ∈ todos, other.position = some position → other = todo := by
  obtain ⟨todo, member, held⟩ := mem_positions.mp (positions_contiguous kept position low high)
  exact ⟨todo, member, held, fun other otherMember otherHeld => eq_of_position kept.distinct otherMember member otherHeld held⟩

/-! ## Stack order -/

theorem mem_byPosition {todos : List Row} {todo : Row} :
    todo ∈ byPosition todos ↔ todo ∈ todos ∧ todo.position.isSome = true := by
  simp [byPosition, List.mem_mergeSort, List.mem_filter]

/-- The stack is exactly the placed TODOs: as many as there are positions. -/
theorem length_byPosition (todos : List Row) : (byPosition todos).length = (positions todos).length := by
  unfold byPosition
  rw [List.length_mergeSort]
  induction todos with
  | nil => rfl
  | cons x xs ih =>
    rw [positions_cons, List.filter_cons]
    cases hx : x.position <;> simp [ih]

/-! ## Starting TODOs -/

theorem mem_startsOf {todos : List Row} {lanes : Nat} {start : Start} (member : start ∈ startsOf todos lanes) :
    ∃ todo ∈ todos, todo.state = .queued ∧ start = startOf todo := by
  unfold startsOf at member
  obtain ⟨todo, taken, rfl⟩ := List.mem_map.mp member
  obtain ⟨placed, ready⟩ := List.mem_filter.mp (List.mem_of_mem_take taken)
  simp only [isReady, Bool.and_eq_true, decide_eq_true_eq] at ready
  exact ⟨todo, (mem_byPosition.mp placed).1, ready.1, rfl⟩

/-- A fill starts no more TODOs than lanes are free. -/
theorem length_startsOf (todos : List Row) (lanes : Nat) : (startsOf todos lanes).length ≤ lanes - working todos := by
  unfold startsOf working
  rw [List.length_map]
  exact List.length_take_le _ _

theorem startFor_some {starts : List Start} {id : String} {start : Start} (found : startFor starts id = some start) :
    start ∈ starts ∧ start.todoId = id := by
  unfold startFor at found
  exact ⟨List.mem_reverse.mp (List.mem_of_find?_eq_some found), by simpa using List.find?_some found⟩

theorem started_id (starts : List Start) (todo : Row) : (started starts todo).id = todo.id := by
  unfold started
  split <;> rfl

theorem started_position (starts : List Start) (todo : Row) : (started starts todo).position = todo.position := by
  unfold started
  split <;> rfl

/-- Only a Queued TODO starts, on its next attempt. -/
theorem start_is_queued {todos : List Row} (ids : (todos.map (·.id)).Nodup) {lanes : Nat} {todo : Row}
    (member : todo ∈ todos) {start : Start} (found : startFor (startsOf todos lanes) todo.id = some start) :
    todo.state = .queued ∧ start.ordinal = todo.attempt + 1 := by
  obtain ⟨listed, named⟩ := startFor_some found
  obtain ⟨chosen, chosenMember, queued, rfl⟩ := mem_startsOf listed
  have same : chosen = todo := eq_of_id ids chosenMember member named
  subst same
  exact ⟨queued, rfl⟩

theorem not_settled_of_queued {state : TodoState} (queued : state = .queued) : state.settled = false := by
  subst queued
  rfl

/-- A fill leaves a TODO that is not Queued as it was. -/
theorem started_of_not_queued {todos : List Row} (ids : (todos.map (·.id)).Nodup) (lanes : Nat) {todo : Row}
    (member : todo ∈ todos) (other : todo.state ≠ .queued) : started (startsOf todos lanes) todo = todo := by
  unfold started
  split
  · rfl
  · rename_i start found
    exact absurd (start_is_queued ids member found).1 other

/-- A fill keeps the stack's rules. -/
theorem Kept.fill {todos : List Row} (kept : Kept todos) (lanes : Nat) : Kept (fill todos lanes).1 := by
  refine kept.map (g := started (startsOf todos lanes)) fun todo member => ⟨started_id _ _, started_position _ _, ?_⟩
  by_cases queued : todo.state = .queued
  · rw [not_settled_of_queued queued]
    unfold started
    split
    · exact not_settled_of_queued queued
    · rfl
  · rw [started_of_not_queued kept.ids lanes member queued]

/-! ## Leaving the stack -/

theorem closeGap_injective {gap a b : Nat} (ha : a ≠ gap) (hb : b ≠ gap) (same : closeGap gap a = closeGap gap b) :
    a = b := by
  unfold closeGap at same
  split at same <;> split at same <;> omega

theorem closeGap_bounds {gap position count : Nat} (differs : position ≠ gap) (low : 1 ≤ position)
    (high : position ≤ count) (gapLow : 1 ≤ gap) (gapHigh : gap ≤ count) :
    1 ≤ closeGap gap position ∧ closeGap gap position + 1 ≤ count := by
  unfold closeGap
  split <;> omega

theorem leaveRow_id (target : Row) (state : TodoState) (published : Bool) (todo : Row) :
    (leaveRow target state published todo).id = todo.id := by
  unfold leaveRow
  split <;> rfl

theorem leaveRow_target {target : Row} {state : TodoState} {published : Bool} {todo : Row} (same : todo.id = target.id) :
    leaveRow target state published todo = { todo with state := state, position := none } := by
  simp [leaveRow, same]

theorem leaveRow_other_position {target : Row} {state : TodoState} {published : Bool} {todo : Row}
    (other : todo.id ≠ target.id) :
    (leaveRow target state published todo).position = todo.position.map (closeGap (target.position.getD 0)) := by
  simp [leaveRow, other]

theorem leaveRow_other_state {target : Row} {state : TodoState} {published : Bool} {todo : Row}
    (other : todo.id ≠ target.id) :
    (leaveRow target state published todo).state = todo.state ∨
      (todo.state = .queued ∧ (leaveRow target state published todo).state = .failed) := by
  simp only [leaveRow, if_neg other]
  split
  · rename_i handed
    exact .inr ⟨handed.2.2, rfl⟩
  · exact .inl rfl

theorem leaveRow_other_settled {target : Row} {state : TodoState} {published : Bool} {todo : Row}
    (other : todo.id ≠ target.id) : (leaveRow target state published todo).state.settled = todo.state.settled := by
  rcases leaveRow_other_state (state := state) (published := published) other with same | ⟨queued, failed⟩
  · rw [same]
  · rw [failed, queued]
    rfl

theorem length_positions_leave_others {target : Row} {state : TodoState} {published : Bool} {todos : List Row}
    (others : ∀ todo ∈ todos, todo.id ≠ target.id) :
    (positions (todos.map (leaveRow target state published))).length = (positions todos).length := by
  induction todos with
  | nil => rfl
  | cons x xs ih =>
    have rest := ih (fun todo member => others todo (by simp [member]))
    rw [List.map_cons, positions_cons, positions_cons, leaveRow_other_position (others x (by simp))]
    cases hx : x.position <;> simp [rest]

/-- At most one TODO loses its position when one leaves. -/
theorem length_positions_leave {target : Row} {state : TodoState} {published : Bool} {todos : List Row}
    (ids : (todos.map (·.id)).Nodup) :
    (positions todos).length ≤ (positions (todos.map (leaveRow target state published))).length + 1 := by
  induction todos with
  | nil => simp [positions]
  | cons x xs ih =>
    rw [List.map_cons, List.nodup_cons] at ids
    rw [List.map_cons, positions_cons, positions_cons]
    by_cases same : x.id = target.id
    · have others : ∀ todo ∈ xs, todo.id ≠ target.id := by
        intro todo member named
        exact ids.1 (List.mem_map.mpr ⟨todo, member, named.trans same.symm⟩)
      have rest := length_positions_leave_others (state := state) (published := published) others
      rw [leaveRow_target same]
      cases hx : x.position <;> simp [rest]
    · have rest := ih ids.2
      rw [leaveRow_other_position same]
      cases hx : x.position <;> simp <;> omega

theorem nodup_positions_leave {target : Row} {state : TodoState} {published : Bool} {gap : Nat}
    (at_ : target.position = some gap) {todos : List Row} (distinct : (positions todos).Nodup)
    (apart : ∀ todo ∈ todos, todo.id ≠ target.id → todo.position ≠ some gap) :
    (positions (todos.map (leaveRow target state published))).Nodup := by
  induction todos with
  | nil => exact List.nodup_nil
  | cons x xs ih =>
    rw [positions_cons] at distinct
    have restDistinct : (positions xs).Nodup := by
      cases hx : x.position <;> simp only [hx] at distinct
      · exact distinct
      · exact (List.nodup_cons.mp distinct).2
    have rest := ih restDistinct (fun todo member => apart todo (by simp [member]))
    rw [List.map_cons, positions_cons]
    by_cases same : x.id = target.id
    · rw [leaveRow_target same]
      exact rest
    · rw [leaveRow_other_position same]
      cases hx : x.position with
      | none => exact rest
      | some position =>
        simp only [hx] at distinct
        simp only [Option.map_some]
        refine List.nodup_cons.mpr ⟨?_, rest⟩
        intro clash
        obtain ⟨changed, changedMember, held⟩ := mem_positions.mp clash
        obtain ⟨other, otherMember, rfl⟩ := List.mem_map.mp changedMember
        by_cases named : other.id = target.id
        · rw [leaveRow_target named] at held
          cases held
        · rw [leaveRow_other_position named] at held
          cases ho : other.position with
          | none => simp [ho] at held
          | some otherPosition =>
            simp only [ho, Option.map_some, Option.some.injEq, at_, Option.getD_some] at held
            have differs : position ≠ gap := fun eq => apart x (by simp) same (by rw [hx, eq])
            have otherDiffers : otherPosition ≠ gap :=
              fun eq => apart other (by simp [otherMember]) named (by rw [ho, eq])
            have equal := closeGap_injective otherDiffers differs held
            subst equal
            exact (List.nodup_cons.mp distinct).1 (mem_positions.mpr ⟨other, otherMember, ho⟩)

/-- An open TODO that leaves the stack leaves it kept: the gap closed, positions 1 to n-1. -/
theorem Kept.leave {todos : List Row} (kept : Kept todos) {target : Row} (member : target ∈ todos)
    (open_ : target.state.settled = false) {state : TodoState} (final : state.settled = true) (published : Bool) :
    Kept (leave todos target state published) := by
  obtain ⟨gap, at_⟩ : ∃ gap, target.position = some gap := by
    cases held : target.position with
    | none => exact absurd ((kept.placed target member).mpr held) (by simp [open_])
    | some gap => exact ⟨gap, rfl⟩
  have apart : ∀ todo ∈ todos, todo.id ≠ target.id → todo.position ≠ some gap := by
    intro todo todoMember other held
    exact other (congrArg Row.id (eq_of_position kept.distinct todoMember member held at_))
  have gapBound := kept.bounded gap (mem_positions.mpr ⟨target, member, at_⟩)
  have shorter := length_positions_leave (target := target) (state := state) (published := published) kept.ids
  unfold McpAndStackSpec.leave
  refine ⟨?_, nodup_positions_leave at_ kept.distinct apart, ?_, ?_⟩
  · rw [ids_map (fun todo _ => leaveRow_id target state published todo)]
    exact kept.ids
  · intro position held
    obtain ⟨changed, changedMember, heldBy⟩ := mem_positions.mp held
    obtain ⟨todo, todoMember, rfl⟩ := List.mem_map.mp changedMember
    by_cases named : todo.id = target.id
    · rw [leaveRow_target named] at heldBy
      cases heldBy
    · rw [leaveRow_other_position named] at heldBy
      cases was : todo.position with
      | none => simp [was] at heldBy
      | some before =>
        simp only [was, Option.map_some, Option.some.injEq, at_, Option.getD_some] at heldBy
        have bound := kept.bounded before (mem_positions.mpr ⟨todo, todoMember, was⟩)
        have differs : before ≠ gap := fun eq => apart todo todoMember named (by rw [was, eq])
        have closed := closeGap_bounds differs bound.1 bound.2 gapBound.1 gapBound.2
        omega
  · intro changed changedMember
    obtain ⟨todo, todoMember, rfl⟩ := List.mem_map.mp changedMember
    by_cases named : todo.id = target.id
    · rw [leaveRow_target named]
      simp [final]
    · rw [leaveRow_other_settled named, leaveRow_other_position named, kept.placed todo todoMember]
      cases todo.position <;> simp

/-! ## A commit -/

/-- A new TODO at the end of a kept stack, under an id no TODO has, leaves it kept. -/
theorem Kept.commit {todos : List Row} (kept : Kept todos) {todo : Row} (fresh : todo.id ∉ todos.map (·.id))
    (last : todo.position = some ((positions todos).length + 1)) (open_ : todo.state.settled = false) :
    Kept (todos ++ [todo]) := by
  have places : positions (todos ++ [todo]) = positions todos ++ [(positions todos).length + 1] := by
    simp [positions, List.filterMap_append, last]
  refine ⟨?_, ?_, ?_, ?_⟩
  · rw [List.map_append, List.nodup_append]
    refine ⟨kept.ids, by simp, ?_⟩
    intro a inside b single same
    simp only [List.map_cons, List.map_nil, List.mem_singleton] at single
    exact fresh (single ▸ same ▸ inside)
  · rw [places, List.nodup_append]
    refine ⟨kept.distinct, by simp, ?_⟩
    intro a inside b single same
    simp only [List.mem_singleton] at single
    have bound := kept.bounded a inside
    omega
  · intro position held
    rw [places] at held ⊢
    rw [List.length_append]
    rcases List.mem_append.mp held with inside | single
    · have bound := kept.bounded position inside
      simp only [List.length_cons, List.length_nil]
      omega
    · simp only [List.mem_singleton] at single
      simp only [List.length_cons, List.length_nil]
      omega
  · intro row member
    rcases List.mem_append.mp member with inside | single
    · exact kept.placed row inside
    · simp only [List.mem_singleton] at single
      subst single
      simp [open_, last]

/-! ## Every change -/

theorem not_settled_of_active {state : TodoState} (active : state.active = true) : state.settled = false := by
  cases state <;> simp [TodoState.active, TodoState.settled] at active ⊢

theorem not_inLane_of_settled {state : TodoState} (settled : state.settled = true) : state.inLane = false := by
  cases state <;> simp [TodoState.inLane, TodoState.settled] at settled ⊢

theorem liveTarget_some {stack : Stack} {id : String} {ordinal : Int} {target : Row}
    (found : liveTarget stack id ordinal = some target) :
    target ∈ stack.todos ∧ target.state.active = true ∧ target.id = id ∧ (target.attempt : Int) = ordinal := by
  unfold liveTarget rowOf at found
  split at found
  · cases found
  · rename_i row named
    split at found
    · rename_i live
      cases found
      exact ⟨List.mem_of_find?_eq_some named, live.1, by simpa using List.find?_some named, live.2⟩
    · cases found

/--
What a change does to the rows before the free lanes fill: a commit appends one Queued TODO at the end; settings
change no row; a report or a retry puts one open TODO in a state that is neither settled nor Working; a drop, a
merge or a close takes one open TODO out.
-/
inductive Changed (stack : Stack) : Op → List Row → Prop where
  | commit (id : String) (after : CommitAfter) (base : Option String) :
    Changed stack (.commit id after) (stack.todos ++ [committedRow stack id base])
  | same (op : Op) : Changed stack op stack.todos
  | state (op : Op) (target : Row) (state : TodoState) :
    target ∈ stack.todos → target.state.settled = false → state.settled = false → state.inLane = false →
      Changed stack op (stack.todos.map (stateRow target state))
  | retry (op : Op) (target : Row) (after : Option String) :
    target ∈ stack.todos → target.state = .failed → Changed stack op (stack.todos.map (retriedRow target after))
  | leave (op : Op) (target : Row) (state : TodoState) (published : Bool) :
    target ∈ stack.todos → target.state.settled = false → state.settled = true →
      Changed stack op (leave stack.todos target state published)

/-- Every change either leaves the stack as it was, or changes its rows one of five ways and fills the free lanes. -/
theorem apply_cases (stack : Stack) (op : Op) :
    (apply stack op).1 = stack ∨
      ∃ mid, Changed stack op mid ∧ (apply stack op).1.todos = (fill mid (apply stack op).1.lanes).1 := by
  cases op with
  | commit id after =>
    simp only [apply]
    split
    · exact .inl rfl
    · split
      · exact .inl rfl
      · rename_i base _
        exact .inr ⟨_, .commit id after base, rfl⟩
  | configure lanes maxOpen base => exact .inr ⟨_, .same _, rfl⟩
  | publish id ordinal =>
    simp only [apply]
    split
    · exact .inl rfl
    · rename_i target found
      obtain ⟨member, active, _⟩ := liveTarget_some found
      exact .inr ⟨_, .state _ target .inReview member (not_settled_of_active active) rfl rfl, rfl⟩
  | finish id ordinal state =>
    simp only [apply]
    split
    · exact .inl rfl
    · rename_i target found
      obtain ⟨member, active, _⟩ := liveTarget_some found
      cases state
      · exact .inr ⟨_, .leave _ target .merged false member (not_settled_of_active active) rfl, rfl⟩
      · exact .inr ⟨_, .leave _ target .dropped true member (not_settled_of_active active) rfl, rfl⟩
      · exact .inr ⟨_, .state _ target .failed member (not_settled_of_active active) rfl rfl, rfl⟩
  | retry number =>
    simp only [apply]
    split
    · exact .inl rfl
    · rename_i target found
      split
      · exact .inl rfl
      · rename_i failed
        exact .inr ⟨_, .retry _ target _ (List.mem_of_find?_eq_some found) (Classical.not_not.mp failed), rfl⟩
  | drop number =>
    simp only [apply]
    split
    · exact .inl rfl
    · rename_i target found
      split
      · exact .inl rfl
      · split
        · exact .inl rfl
        · rename_i notMerged notDropped
          have open_ : target.state.settled = false := by
            cases state : target.state <;> simp_all [TodoState.settled]
          exact .inr ⟨_, .leave _ target .dropped _ (List.mem_of_find?_eq_some found) open_ rfl, rfl⟩

/-- A commit is fresh when no TODO of the stack has its id: the writer draws a new id for each. -/
def Fresh (stack : Stack) : Op → Prop
  | .commit id _ => id ∉ stack.todos.map (·.id)
  | _ => True

theorem Changed.kept {stack : Stack} {op : Op} {mid : List Row} (kept : Kept stack.todos) (fresh : Fresh stack op)
    (changed : Changed stack op mid) : Kept mid := by
  cases changed with
  | commit id after base =>
    refine kept.commit fresh ?_ rfl
    simp [committedRow, openOf, length_byPosition]
  | same => exact kept
  | state _ target state member open_ notSettled _ =>
    refine kept.map fun todo todoMember => ?_
    by_cases named : todo.id = target.id
    · have same := eq_of_id kept.ids todoMember member named
      subst same
      simp [stateRow, open_, notSettled]
    · simp [stateRow, named]
  | retry _ target after member failed =>
    refine kept.map fun todo todoMember => ?_
    by_cases named : todo.id = target.id
    · have same := eq_of_id kept.ids todoMember member named
      subst same
      simp [retriedRow, failed, TodoState.settled]
    · simp [retriedRow, named]
  | leave _ target state published member open_ final => exact kept.leave member open_ final published

/--
The stack ordering invariant: a kept stack is kept after every change. Its open positions stay exactly 1 to n
(`positions_contiguous`), no two TODOs share one (`eq_of_position`), and settled TODOs alone are unplaced.
-/
theorem apply_keeps (stack : Stack) (op : Op) (kept : Kept stack.todos) (fresh : Fresh stack op) :
    Kept (apply stack op).1.todos := by
  rcases apply_cases stack op with same | ⟨mid, changed, filled⟩
  · rw [same]
    exact kept
  · rw [filled]
    exact (changed.kept kept fresh).fill _

/-- A sequence is fresh when each commit's id is new to the stack it meets. -/
def FreshRun : Stack → List Op → Prop
  | _, [] => True
  | stack, op :: rest => Fresh stack op ∧ FreshRun (apply stack op).1 rest

/-- Every stack along a sequence of changes from a kept stack is kept. -/
theorem run_keeps (stack : Stack) (ops : List Op) (kept : Kept stack.todos) (fresh : FreshRun stack ops) :
    ∀ step ∈ run stack ops, Kept step.1.todos := by
  induction ops generalizing stack with
  | nil => intro step member; cases member
  | cons op rest ih =>
    intro step member
    have next := apply_keeps stack op kept fresh.1
    rcases List.mem_cons.mp member with rfl | later
    · exact next
    · exact ih _ next fresh.2 step later

/-- From the empty stack, positions are 1 to n after every change of a fresh sequence. -/
theorem run_positions_contiguous (stack : Stack) (ops : List Op) (empty : stack.todos = []) (fresh : FreshRun stack ops)
    (step : Stack × Result) (member : step ∈ run stack ops) (position : Nat) (low : 1 ≤ position)
    (high : position ≤ (positions step.1.todos).length) : position ∈ positions step.1.todos :=
  positions_contiguous (run_keeps stack ops (empty ▸ kept_nil) fresh step member) position low high

/-! ## Settled is final -/

theorem Changed.settled {stack : Stack} {op : Op} {mid : List Row} (kept : Kept stack.todos)
    (changed : Changed stack op mid) {todo : Row} (member : todo ∈ stack.todos) (settled : todo.state.settled = true) :
    ∃ now ∈ mid, now.id = todo.id ∧ now.number = todo.number ∧ now.state = todo.state ∧
      now.position = todo.position ∧ now.attempt = todo.attempt ∧ now.revision = todo.revision := by
  cases changed with
  | commit id after base => exact ⟨todo, by simp [member], rfl, rfl, rfl, rfl, rfl, rfl⟩
  | same => exact ⟨todo, member, rfl, rfl, rfl, rfl, rfl, rfl⟩
  | state _ target state targetMember open_ _ _ =>
    have other : todo.id ≠ target.id := by
      intro named
      have same := eq_of_id kept.ids member targetMember named
      subst same
      simp [open_] at settled
    exact ⟨stateRow target state todo, List.mem_map.mpr ⟨todo, member, rfl⟩, by simp [stateRow, other]⟩
  | retry _ target after targetMember failed =>
    have other : todo.id ≠ target.id := by
      intro named
      have same := eq_of_id kept.ids member targetMember named
      subst same
      simp [failed, TodoState.settled] at settled
    exact ⟨retriedRow target after todo, List.mem_map.mpr ⟨todo, member, rfl⟩, by simp [retriedRow, other]⟩
  | leave _ target state published targetMember open_ _ =>
    have other : todo.id ≠ target.id := by
      intro named
      have same := eq_of_id kept.ids member targetMember named
      subst same
      simp [open_] at settled
    have unplaced := (kept.placed todo member).mp settled
    have notQueued : todo.state ≠ .queued := by
      intro queued
      simp [not_settled_of_queued queued] at settled
    refine ⟨leaveRow target state published todo, List.mem_map.mpr ⟨todo, member, rfl⟩, leaveRow_id _ _ _ _, ?_, ?_, ?_, ?_, ?_⟩
    · simp [leaveRow, other]
    · rcases leaveRow_other_state (state := state) (published := published) other with same | ⟨queued, _⟩
      · exact same
      · exact absurd queued notQueued
    · rw [leaveRow_other_position other, unplaced]
      rfl
    · simp [leaveRow, other]
    · simp [leaveRow, other]

/--
Terminal states are final: after any change to a kept stack, a merged or dropped TODO is still there with its
number, its state, no position, and its attempts. No retry, report, drop or settings change brings it back.
-/
theorem settled_final (stack : Stack) (op : Op) (kept : Kept stack.todos) (fresh : Fresh stack op) {todo : Row}
    (member : todo ∈ stack.todos) (settled : todo.state.settled = true) :
    ∃ now ∈ (apply stack op).1.todos, now.id = todo.id ∧ now.number = todo.number ∧ now.state = todo.state ∧
      now.position = none ∧ now.attempt = todo.attempt ∧ now.revision = todo.revision := by
  have unplaced := (kept.placed todo member).mp settled
  rcases apply_cases stack op with same | ⟨mid, changed, filled⟩
  · rw [same]
    exact ⟨todo, member, rfl, rfl, rfl, unplaced, rfl, rfl⟩
  · obtain ⟨now, nowMember, id, number, state, position, attempt, revision⟩ := changed.settled kept member settled
    have notQueued : now.state ≠ .queued := by
      intro queued
      rw [state] at queued
      simp [not_settled_of_queued queued] at settled
    refine ⟨now, ?_, id, number, state, position.trans unplaced, attempt, revision⟩
    rw [filled]
    exact List.mem_map.mpr ⟨now, nowMember, started_of_not_queued (changed.kept kept fresh).ids _ nowMember notQueued⟩

/-! ## Lanes -/

theorem working_cons (x : Row) (xs : List Row) :
    working (x :: xs) = (if x.state.inLane = true then 1 else 0) + working xs := by
  unfold working
  rw [List.filter_cons]
  split <;> simp <;> omega

theorem working_map_le {g : Row → Row} {todos : List Row}
    (calm : ∀ todo ∈ todos, (g todo).state.inLane = true → todo.state.inLane = true) :
    working (todos.map g) ≤ working todos := by
  induction todos with
  | nil => exact Nat.le_refl _
  | cons x xs ih =>
    have rest := ih (fun todo member => calm todo (by simp [member]))
    have head := calm x (by simp)
    rw [List.map_cons, working_cons, working_cons]
    by_cases after : (g x).state.inLane = true
    · rw [if_pos after, if_pos (head after)]
      omega
    · rw [if_neg after]
      split <;> omega

/-- Before the free lanes fill, no change puts a TODO to work. -/
theorem Changed.working_le {stack : Stack} {op : Op} {mid : List Row} (changed : Changed stack op mid) :
    working mid ≤ working stack.todos := by
  cases changed with
  | commit id after base => simp [working, List.filter_append, committedRow, TodoState.inLane]
  | same => exact Nat.le_refl _
  | state _ target state _ _ _ idle =>
    refine working_map_le fun todo _ => ?_
    unfold stateRow
    split
    · simp [idle]
    · exact id
  | retry _ target after _ _ =>
    refine working_map_le fun todo _ => ?_
    unfold retriedRow
    split
    · simp [TodoState.inLane]
    · exact id
  | leave _ target state published _ _ final =>
    refine working_map_le fun todo _ => ?_
    by_cases named : todo.id = target.id
    · rw [leaveRow_target named]
      simp [not_inLane_of_settled final]
    · rcases leaveRow_other_state (state := state) (published := published) named with same | ⟨_, failed⟩
      · rw [same]
        exact id
      · rw [failed]
        simp [TodoState.inLane]

theorem working_started_le (starts : List Start) (todos : List Row) :
    working (todos.map (started starts)) ≤
      working todos + (todos.filter fun todo => (startFor starts todo.id).isSome).length := by
  induction todos with
  | nil => exact Nat.le_refl _
  | cons x xs ih =>
    rw [List.map_cons, working_cons, working_cons, List.filter_cons]
    cases found : startFor starts x.id with
    | none =>
      simp only [started, found, Option.isSome_none, Bool.false_eq_true, if_false]
      omega
    | some start =>
      simp only [Option.isSome_some, if_true, List.length_cons]
      split <;> split <;> omega

/-- Lane preservation, at the fill: with ids told apart, a fill never puts more TODOs to work than lanes allow. -/
theorem fill_lanes {todos : List Row} (ids : (todos.map (·.id)).Nodup) (lanes : Nat) :
    working (fill todos lanes).1 ≤ lanes ∨ working (fill todos lanes).1 ≤ working todos := by
  have grown := working_started_le (startsOf todos lanes) todos
  have few := length_startsOf todos lanes
  have named : (todos.filter fun todo => (startFor (startsOf todos lanes) todo.id).isSome).length ≤
      (startsOf todos lanes).length := by
    have inner : ((todos.filter fun todo => (startFor (startsOf todos lanes) todo.id).isSome).map (·.id)).Nodup :=
      List.Nodup.sublist (List.Sublist.map _ List.filter_sublist) ids
    have bound := nodup_subset_length_le _ ((startsOf todos lanes).map (·.todoId)) inner (by
      intro id member
      obtain ⟨todo, kept, rfl⟩ := List.mem_map.mp member
      obtain ⟨_, some_⟩ := List.mem_filter.mp kept
      obtain ⟨start, found⟩ := Option.isSome_iff_exists.mp some_
      obtain ⟨listed, same⟩ := startFor_some found
      exact List.mem_map.mpr ⟨start, listed, same⟩)
    simpa using bound
  show working (todos.map (started (startsOf todos lanes))) ≤ lanes ∨
    working (todos.map (started (startsOf todos lanes))) ≤ working todos
  omega

/--
Lane preservation: after any change to a kept stack, the TODOs working fit the lanes the stack now has, or are no
more than were working before. More TODOs work only while a lane is free.
-/
theorem lanes_hold (stack : Stack) (op : Op) (kept : Kept stack.todos) (fresh : Fresh stack op) :
    working (apply stack op).1.todos ≤ (apply stack op).1.lanes ∨
      working (apply stack op).1.todos ≤ working stack.todos := by
  rcases apply_cases stack op with same | ⟨mid, changed, filled⟩
  · rw [same]
    exact .inr (Nat.le_refl _)
  · rw [filled]
    have calm := changed.working_le
    rcases fill_lanes (changed.kept kept fresh).ids (apply stack op).1.lanes with fits | fewer
    · exact .inl fits
    · exact .inr (Nat.le_trans fewer calm)

/-- A stack with no lanes starts nothing: a host that runs no TODOs passes `lanes: 0`. -/
theorem no_lanes_no_starts (todos : List Row) : (fill todos 0).2 = [] := by
  simp [fill, startsOf]

/-! ## Refusals and numbers -/

/-- A refused change leaves the stack exactly as it was. -/
theorem refused_unchanged (stack : Stack) (op : Op) (code : Refusal) (refused : (apply stack op).2 = .refused code) :
    (apply stack op).1 = stack := by
  cases op <;> simp only [apply] at refused ⊢ <;> (repeat' split at refused) <;> simp_all
  all_goals (split <;> rfl)

/-- A stale report is refused: only the live attempt of a Working or In review TODO publishes or finishes. -/
theorem stale_refused (stack : Stack) (id : String) (ordinal : Int) (state : Finished)
    (stale : liveTarget stack id ordinal = none) :
    apply stack (.publish id ordinal) = (stack, .refused .stale) ∧
      apply stack (.finish id ordinal state) = (stack, .refused .stale) := by
  simp [apply, stale]

/-- Only a commit spends a number, and it spends exactly one; no change lowers the next number. -/
theorem nextNumber_spent (stack : Stack) (op : Op) :
    (apply stack op).1.nextNumber = stack.nextNumber ∨
      (∃ position starts, (apply stack op).2 = .committed stack.nextNumber position starts ∧
        (apply stack op).1.nextNumber = stack.nextNumber + 1) := by
  cases op <;> simp only [apply] <;> repeat' split
  all_goals first
    | exact .inl rfl
    | exact .inl trivial
    | exact .inr ⟨_, _, rfl, rfl⟩

/-- A commit takes the last position: one more than the open TODOs. -/
theorem commit_position (stack : Stack) (id : String) (after : CommitAfter) (number position : Nat)
    (starts : List Start) (committed : (apply stack (.commit id after)).2 = .committed number position starts) :
    number = stack.nextNumber ∧ position = (positions stack.todos).length + 1 := by
  simp only [apply] at committed
  repeat' split at committed
  all_goals first
    | (cases committed
       exact ⟨rfl, by rw [openOf, length_byPosition]⟩)
    | cases committed

end McpAndStackSpec

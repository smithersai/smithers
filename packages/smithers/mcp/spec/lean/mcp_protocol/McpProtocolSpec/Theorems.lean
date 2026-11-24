import McpProtocolSpec.Json
import McpProtocolSpec.Frames
import McpProtocolSpec.Rpc

/-!
# What the specification guarantees

Machine-checked: every proof is complete and nothing is assumed beyond Lean's own foundations.

* **Limits.** `checkParsed` passes a value exactly when every number in it is finite and no path holds more
  containers than the limit (`checkParsed_none_iff`); a larger limit refuses nothing a smaller one passes.
  `firstInvalid` finds nothing exactly when every option is a positive integer, and what it names is not one.
* **Chunk-split invariance.** The lines of a stream depend on its bytes and not on how they were cut into chunks:
  any partition frames as the one chunk that holds every byte (`lines_chunk_invariant`), and that includes whether
  a line is over the cap.
* **Envelopes.** A message with a method is never taken for a reply. A reply settles under the id it carries, and
  an id spelled as canonical decimal is the id the client sent (`idOf_digits`).
* **Correlation.** A message never adds a waiting request; a reply settles at most the one request with its id, and
  only once; a server request settles nothing, whatever its id.
-/

namespace McpProtocolSpec

-- Limits --------------------------------------------------------------------------------------------------------------

/-- A value that is the `depth`-th container or leaf on its path fits when its deepest path ends within the limit. -/
def Fits (limit depth count : Nat) : Prop := count = 0 ∨ depth + count ≤ limit + 1

theorem fits_max (limit depth a b : Nat) : Fits limit depth (max a b) ↔ Fits limit depth a ∧ Fits limit depth b := by
  unfold Fits
  rw [Nat.max_def]
  split <;> omega

mutual
  theorem check_none_iff (limit : Nat) : (value : Json) → (depth : Nat) →
      (check limit value depth = none ↔ finite value = true ∧ Fits limit depth (nesting value))
    | .null, _ => by simp [check, finite, nesting, Fits]
    | .bool _, _ => by simp [check, finite, nesting, Fits]
    | .num (.int _), _ => by simp [check, finite, nesting, Fits]
    | .num .fraction, _ => by simp [check, finite, nesting, Fits]
    | .num .nonFinite, _ => by simp [check, finite]
    | .str _, _ => by simp [check, finite, nesting, Fits]
    | .arr items, depth => by
      simp only [check, finite, nesting]
      split
      · simp only [reduceCtorEq, false_iff, not_and]
        intro _
        unfold Fits
        omega
      · rw [checkItems_none_iff limit items (depth + 1)]
        unfold Fits
        constructor <;> (intro ⟨all, fits⟩; refine ⟨all, ?_⟩; omega)
    | .obj members, depth => by
      simp only [check, finite, nesting]
      split
      · simp only [reduceCtorEq, false_iff, not_and]
        intro _
        unfold Fits
        omega
      · rw [checkMembers_none_iff limit members (depth + 1)]
        unfold Fits
        constructor <;> (intro ⟨all, fits⟩; refine ⟨all, ?_⟩; omega)

  theorem checkItems_none_iff (limit : Nat) : (items : Items) → (depth : Nat) →
      (checkItems limit items depth = none ↔ finiteItems items = true ∧ Fits limit depth (nestingItems items))
    | .nil, _ => by simp [checkItems, finiteItems, nestingItems, Fits]
    | .cons head tail, depth => by
      have first := check_none_iff limit head depth
      have rest := checkItems_none_iff limit tail depth
      simp only [checkItems, finiteItems, nestingItems, Bool.and_eq_true, fits_max]
      cases shape : checkItems limit tail depth with
      | some issue =>
        rw [shape] at rest
        simp only [reduceCtorEq, false_iff] at rest ⊢
        intro ⟨⟨_, all⟩, _, fits⟩
        exact rest ⟨all, fits⟩
      | none =>
        rw [shape] at rest
        simp only [true_iff] at rest
        rw [first]
        constructor
        · intro ⟨all, fits⟩
          exact ⟨⟨all, rest.1⟩, fits, rest.2⟩
        · intro ⟨⟨all, _⟩, fits, _⟩
          exact ⟨all, fits⟩

  theorem checkMembers_none_iff (limit : Nat) : (members : Members) → (depth : Nat) →
      (checkMembers limit members depth = none ↔
        finiteMembers members = true ∧ Fits limit depth (nestingMembers members))
    | .nil, _ => by simp [checkMembers, finiteMembers, nestingMembers, Fits]
    | .cons _ value tail, depth => by
      have first := check_none_iff limit value depth
      have rest := checkMembers_none_iff limit tail depth
      simp only [checkMembers, finiteMembers, nestingMembers, Bool.and_eq_true, fits_max]
      cases shape : checkMembers limit tail depth with
      | some issue =>
        rw [shape] at rest
        simp only [reduceCtorEq, false_iff] at rest ⊢
        intro ⟨⟨_, all⟩, _, fits⟩
        exact rest ⟨all, fits⟩
      | none =>
        rw [shape] at rest
        simp only [true_iff] at rest
        rw [first]
        constructor
        · intro ⟨all, fits⟩
          exact ⟨⟨all, rest.1⟩, fits, rest.2⟩
        · intro ⟨⟨all, _⟩, fits, _⟩
          exact ⟨all, fits⟩
end

/--
**The JSON limits are sound and complete.** `checkParsed` passes a value exactly when every number in it is finite
and no path holds more containers than the limit.
-/
theorem checkParsed_none_iff (limit : Nat) (value : Json) :
    checkParsedWith limit value = none ↔ finite value = true ∧ nesting value ≤ limit := by
  unfold checkParsedWith
  rw [check_none_iff]
  unfold Fits
  constructor <;> (intro ⟨all, fits⟩; refine ⟨all, ?_⟩; omega)

/-- A larger limit refuses nothing a smaller one passes. -/
theorem checkParsed_monotone {small large : Nat} (grows : small ≤ large) (value : Json)
    (passes : checkParsedWith small value = none) : checkParsedWith large value = none := by
  rw [checkParsed_none_iff] at passes ⊢
  exact ⟨passes.1, by omega⟩

/-- `firstInvalid` finds nothing exactly when every option is a positive integer. -/
theorem firstInvalid_none_iff : (entries : List (Text × Num)) →
    (firstInvalid entries = none ↔ ∀ entry ∈ entries, isPositiveInteger entry.2 = true)
  | [] => by simp [firstInvalid]
  | (name, value) :: rest => by
    simp only [firstInvalid, List.mem_cons, forall_eq_or_imp]
    split
    · next valid => simp [valid, firstInvalid_none_iff rest]
    · next invalid => simp [invalid]

/-- The option `firstInvalid` names is one of the options, it is not a positive integer, and every one before is. -/
theorem firstInvalid_some : (entries : List (Text × Num)) → (name : Text) → firstInvalid entries = some name →
    ∃ before value after, entries = before ++ (name, value) :: after ∧ isPositiveInteger value = false ∧
      ∀ entry ∈ before, isPositiveInteger entry.2 = true
  | [], _, found => by simp [firstInvalid] at found
  | (name', value) :: rest, name, found => by
    simp only [firstInvalid] at found
    split at found
    · next valid =>
      obtain ⟨before, value', after, shape, invalid, all⟩ := firstInvalid_some rest name found
      refine ⟨(name', value) :: before, value', after, by rw [shape]; rfl, invalid, ?_⟩
      intro entry member
      rcases List.mem_cons.mp member with here | later
      · rw [here]; exact valid
      · exact all entry later
    · next invalid =>
      cases found
      exact ⟨[], value, rest, rfl, by simpa using invalid, by simp⟩

/-- A positive integer is a whole number from 1 to the largest safe integer. -/
theorem isPositiveInteger_iff (value : Num) :
    isPositiveInteger value = true ↔ ∃ whole : Int, value = .int whole ∧ 0 < whole ∧ whole ≤ (maxSafe : Int) := by
  cases value <;> simp [isPositiveInteger]

-- Framing -------------------------------------------------------------------------------------------------------------

/-- Checking a run when one more byte has arrived is checking it before and after that byte. -/
theorem append_cons (max : Nat) (rev piece : List Nat) (byte : Nat) :
    append max rev (byte :: piece) =
      match append max rev piece with
      | none => none
      | some line => append max line [byte] := by
  cases piece with
  | nil => simp [append]
  | cons last more =>
    simp only [append, List.length_cons, List.length_nil]
    by_cases over : rev.length + (more.length + 1) - (if last = 13 then 1 else 0) > max
    · rw [if_pos over]
      have : rev.length + (more.length + 1 + 1) - (if byte = 13 then 1 else 0) > max := by
        split at over <;> split <;> omega
      rw [if_pos this]
    · rw [if_neg over]
      simp only [List.length_append, List.length_cons, List.cons_append, List.nil_append]
      have same : more.length + rev.length + 1 + (0 + 1) = rev.length + (more.length + 1 + 1) := by omega
      rw [same]

/-- A run held back to the end of a chunk can be added to the open line at once: the cut does not show. -/
theorem scan_piece (cr : Bool) (max : Nat) : (chunk : List Nat) → (skip : Bool) → (rev piece : List Nat) →
    (out : List (List Nat)) →
    scan cr max skip rev piece out chunk =
      match append max rev piece with
      | none => none
      | some line => scan cr max skip line [] out chunk
  | [], skip, rev, piece, out => by
    simp only [scan]
    cases append max rev piece <;> simp [append]
  | byte :: rest, skip, rev, piece, out => by
    simp only [scan]
    by_cases skipped : (skip && decide (byte = 10)) = true
    · simp only [skipped, if_true]
      rw [scan_piece cr max rest false rev piece out]
    · simp only [skipped, Bool.false_eq_true, if_false]
      by_cases feed : byte = 10
      · simp only [feed, if_true]
        cases append max rev piece <;> simp [append]
      · simp only [feed, if_false]
        by_cases carriage : (cr && decide (byte = 13)) = true
        · simp only [carriage, if_true]
          cases append max rev piece <;> simp [append]
        · simp only [carriage, Bool.false_eq_true, if_false]
          rw [scan_piece cr max rest false rev (byte :: piece) out, append_cons]
          cases append max rev piece with
          | none => rfl
          | some line => simp only; rw [scan_piece cr max rest false line [byte] out]

theorem step_nil (cr : Bool) (max : Nat) (reader : Reader) : step cr max reader [] = some reader := by
  cases reader with
  | mk line out => cases line; simp [step, scan, append]

/-- A chunk cut in two reads as its two halves in turn. -/
theorem scan_append (cr : Bool) (max : Nat) (second : List Nat) : (first : List Nat) → (skip : Bool) →
    (rev piece : List Nat) → (out : List (List Nat)) →
    scan cr max skip rev piece out (first ++ second) =
      match scan cr max skip rev piece out first with
      | none => none
      | some reader => step cr max reader second
  | [], skip, rev, piece, out => by
    simp only [List.nil_append, scan]
    rw [scan_piece]
    cases append max rev piece <;> simp [step]
  | byte :: rest, skip, rev, piece, out => by
    simp only [List.cons_append, scan]
    by_cases skipped : (skip && decide (byte = 10)) = true
    · simp only [skipped, if_true]
      exact scan_append cr max second rest false rev piece out
    · simp only [skipped, Bool.false_eq_true, if_false]
      by_cases feed : byte = 10
      · simp only [feed, if_true]
        cases append max rev piece with
        | none => rfl
        | some line => exact scan_append cr max second rest false [] [] _
      · simp only [feed, if_false]
        by_cases carriage : (cr && decide (byte = 13)) = true
        · simp only [carriage, if_true]
          cases append max rev piece with
          | none => rfl
          | some line => exact scan_append cr max second rest true [] [] _
        · simp only [carriage, Bool.false_eq_true, if_false]
          exact scan_append cr max second rest false rev (byte :: piece) out

theorem step_append (cr : Bool) (max : Nat) (reader : Reader) (first second : List Nat) :
    step cr max reader (first ++ second) =
      match step cr max reader first with
      | none => none
      | some next => step cr max next second :=
  scan_append cr max second first _ _ _ _

/-- Reading chunks in turn is reading their bytes as one chunk. -/
theorem feed_flatten (cr : Bool) (max : Nat) : (chunks : List (List Nat)) → (reader : Reader) →
    feed cr max reader chunks = step cr max reader chunks.flatten
  | [], reader => by simp [feed, step_nil]
  | chunk :: rest, reader => by
    simp only [feed, List.flatten_cons, step_append]
    cases step cr max reader chunk with
    | none => rfl
    | some next => exact feed_flatten cr max rest next

/--
**Chunk-split invariance.** However a stream's bytes are cut into chunks, its lines are the lines of the one chunk
that holds every byte, and it fails for an overlong line exactly when that one chunk does.
-/
theorem lines_chunk_invariant (cr : Bool) (max : Nat) (chunks : List (List Nat)) :
    lines cr max chunks = lines cr max [chunks.flatten] := by
  simp only [lines, feed_flatten, List.flatten_cons, List.flatten_nil, List.append_nil]

/-- Two streams with the same bytes have the same lines. -/
theorem lines_of_same_bytes (cr : Bool) (max : Nat) {a b : List (List Nat)} (same : a.flatten = b.flatten) :
    lines cr max a = lines cr max b := by
  rw [lines_chunk_invariant cr max a, lines_chunk_invariant cr max b, same]

/-- Empty chunks change nothing. -/
theorem lines_empty_chunk (cr : Bool) (max : Nat) (before after : List (List Nat)) :
    lines cr max (before ++ [] :: after) = lines cr max (before ++ after) :=
  lines_of_same_bytes cr max (by simp)

/-- A stream delivered one byte at a time frames as the stream delivered whole. -/
theorem lines_bytewise (cr : Bool) (max : Nat) (bytes : List Nat) :
    lines cr max (bytes.map fun byte => [byte]) = lines cr max [bytes] :=
  lines_of_same_bytes cr max (by induction bytes with
    | nil => rfl
    | cons byte rest same => simpa using same)

/-- A CRLF cut between its two bytes ends one line, with or without lone-CR line ends. -/
example : lines false 8 [[97, 13], [10, 98]] = some [[97], [98]] := by decide
example : lines true 8 [[97, 13], [10, 98]] = some [[97], [98]] := by decide
/-- The CR of a CRLF is not counted against the cap, and a CR inside a line is. -/
example : lines false 1 [[97, 13], [10]] = some [[97]] := by decide
example : lines false 1 [[97, 13], [98, 10]] = none := by decide

-- Envelopes -----------------------------------------------------------------------------------------------------------

/-- A reply: a result or an error, with or without an id to settle. -/
def Classification.isReply : Classification → Bool
  | .result _ _ => true
  | .error _ _ _ _ => true
  | .uncorrelatedError _ _ _ => true
  | _ => false

/--
**The directions stay apart.** A message with a method is the server's own request or notification, or malformed;
it is never taken for a reply, so its id is never looked up among this client's waiting requests.
-/
theorem classify_method_not_reply (message : Members) (carries : (lookup (ascii "method") message).isSome = true) :
    (classify message).isReply = false := by
  unfold classify
  repeat' split
  all_goals first
    | rfl
    | simp_all

/-- A result settles under the id its message carries, with the result its message carries. -/
theorem replyOf_result {message : Members} {id : Int} {result : Json} (reply : replyOf message = .result id result) :
    ∃ rawId, lookup (ascii "id") message = some rawId ∧ idOf rawId = some id ∧
      lookup (ascii "result") message = some result ∧ lookup (ascii "error") message = none := by
  unfold replyOf at reply
  split at reply
  · cases reply
  · next rawId found =>
    refine ⟨rawId, found, ?_⟩
    simp only at reply
    repeat' (first | (cases reply; done) | split at reply)
    all_goals simp_all

/-- A correlated error settles under the id its message carries. -/
theorem replyOf_error {message : Members} {id code : Int} {text : Text} {data : Option Json}
    (reply : replyOf message = .error id code text data) :
    ∃ rawId, lookup (ascii "id") message = some rawId ∧ idOf rawId = some id := by
  unfold replyOf at reply
  split at reply
  · cases reply
  · next rawId found =>
    refine ⟨rawId, found, ?_⟩
    simp only at reply
    repeat' (first | (cases reply; done) | split at reply)
    all_goals simp_all

/-- An id is a safe integer: nothing outside that range correlates. -/
theorem idOf_safe : (rawId : Json) → (id : Int) → idOf rawId = some id → isSafe id = true
  | .num (.int value), id, known => by
    simp only [idOf] at known
    split at known
    · next safe => cases known; exact safe
    · cases known
  | .str text, id, known => by
    simp only [idOf] at known
    split at known
    · split at known
      · next small => cases known; simp [isSafe]; omega
      · cases known
    · cases known
  | .null, _, known => by simp [idOf] at known
  | .bool _, _, known => by simp [idOf] at known
  | .num .fraction, _, known => by simp [idOf] at known
  | .num .nonFinite, _, known => by simp [idOf] at known
  | .arr _, _, known => by simp [idOf] at known
  | .obj _, _, known => by simp [idOf] at known

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

/-- A positive number's digits begin with a digit that is not zero, and are digits throughout. -/
theorem digits_shape : (value : Nat) → 0 < value →
    ∃ first rest, digits value = first :: rest ∧ 49 ≤ first ∧ first ≤ 57 ∧ rest.all isDigit = true := by
  intro value
  induction value using Nat.strongRecOn with
  | _ value ih =>
    intro positive
    rw [digits]
    split
    · exact ⟨48 + value, [], rfl, by omega, by omega, rfl⟩
    · obtain ⟨first, rest, shape, low, high, all⟩ := ih (value / 10) (by omega) (by omega)
      refine ⟨first, rest ++ [48 + value % 10], by rw [shape]; rfl, low, high, ?_⟩
      simp only [List.all_append, all, List.all_cons, List.all_nil, Bool.and_true, Bool.true_and, isDigit,
        Bool.and_eq_true, decide_eq_true_eq]
      omega

/-- The digits of a number are its one canonical spelling. -/
theorem parseDecimal_digits (value : Nat) : parseDecimal (digits value) = some value := by
  by_cases zero : value = 0
  · subst zero; rw [digits]; simp [parseDecimal]
  · obtain ⟨first, rest, shape, low, high, all⟩ := digits_shape value (by omega)
    have spelled := valueOf_digits value
    rw [shape] at spelled ⊢
    unfold parseDecimal
    split
    · next same => cases same
    · next same => cases same; omega
    · next first' rest' _ same =>
      cases same
      simp [low, high, all, spelled]

/--
**Ids correlate across spellings.** A reply that spells the id as canonical decimal text stands for the same id
as a reply that carries it as a number.
-/
theorem idOf_digits (value : Nat) : idOf (.str (digits value)) = idOf (.num (.int value)) := by
  simp only [idOf, parseDecimal_digits]
  by_cases small : value ≤ maxSafe
  · have safe : isSafe (value : Int) = true := by simp [isSafe]; omega
    simp [small, safe]
  · have large : isSafe (value : Int) = false := by simp [isSafe]; omega
    simp [small, large]

-- Correlation ---------------------------------------------------------------------------------------------------------

/-- **No message adds a waiting request.** Every id still waiting was waiting before. -/
theorem deliver_subset (pending : List Int) (message : Classification) :
    ∀ id ∈ (deliver pending message).1, id ∈ pending := by
  intro id member
  cases message <;> simp only [deliver] at member
  · exact member
  · exact member
  · split at member
    · exact (List.mem_filter.mp member).1
    · exact member
  · split at member
    · exact (List.mem_filter.mp member).1
    · exact member
  · exact member
  · cases member

/-- **A server request settles nothing**, whatever its id: the ids waiting are the ids that were waiting. -/
theorem deliver_request (pending : List Int) (id : RequestId) (method : Text) (params : Option Json) :
    (deliver pending (.request id method params)).1 = pending ∧
      (deliver pending (.request id method params)).2 = .respond id (method == ascii "ping") :=
  ⟨rfl, rfl⟩

/-- A result resolves a request only when one was waiting under its id. -/
theorem deliver_resolve {pending : List Int} {message : Classification} {id : Int} {result : Json}
    (resolved : (deliver pending message).2 = .resolve id result) :
    id ∈ pending ∧ message = .result id result := by
  cases message <;> simp only [deliver] at resolved
  all_goals try (cases resolved; done)
  · next id' result' =>
    split at resolved
    · next waiting =>
      cases resolved
      exact ⟨by simpa using waiting, rfl⟩
    · cases resolved
  · split at resolved <;> cases resolved

/-- **A reply settles at most once.** After a result for an id, no request waits under that id. -/
theorem deliver_settles (pending : List Int) (id : Int) (result : Json) :
    id ∉ (deliver pending (.result id result)).1 ∨ id ∉ pending := by
  simp only [deliver]
  split
  · exact .inl (by simp)
  · next absent => exact .inr (by simpa using absent)

/-- A reply for an id nothing waits under is ignored. -/
theorem deliver_absent (pending : List Int) (id : Int) (result : Json) (absent : pending.contains id = false) :
    (deliver pending (.result id result)).2 = .ignore := by
  have missing : id ∉ pending := by simpa using absent
  simp [deliver, missing]

/-- The same reply delivered twice resolves once: the second finds nothing waiting. -/
theorem deliver_twice (pending : List Int) (id : Int) (result : Json) :
    (deliver (deliver pending (.result id result)).1 (.result id result)).2 = .ignore := by
  apply deliver_absent
  rcases deliver_settles pending id result with gone | absent
  · simpa using gone
  · simp only [deliver]
    split
    · simp
    · simpa using absent

/-- A reply leaves every other waiting request waiting. -/
theorem deliver_keeps (pending : List Int) (id other : Int) (result : Json) (distinct : other ≠ id)
    (waiting : other ∈ pending) : other ∈ (deliver pending (.result id result)).1 := by
  simp only [deliver]
  split
  · exact List.mem_filter.mpr ⟨waiting, by simpa using distinct⟩
  · exact waiting

/-- Reading a line never adds a waiting request. -/
theorem read_subset (pending : List Int) (line : Json) : ∀ id ∈ (read pending line).1, id ∈ pending := by
  intro id member
  cases line <;> simp only [read] at member
  all_goals try exact member
  split at member
  · split at member
    · cases member
    · exact deliver_subset pending _ id member
  · exact member

/-- Noise settles nothing: a line that does not claim JSON-RPC leaves every request waiting. -/
theorem read_noise (pending : List Int) (line : Json) (noise : accepts line = false) :
    read pending line = (pending, .ignore) := by
  cases line <;> simp only [read]
  simp [noise]

/-- **Over any run of lines, no request starts waiting that was not waiting at the start.** -/
theorem readAll_subset : (lines : List Json) → (pending : List Int) →
    ∀ id ∈ (readAll pending lines).1, id ∈ pending
  | [], _, _, member => member
  | line :: rest, pending, id, member => by
    simp only [readAll] at member
    split at member
    · cases member
    · exact read_subset pending line id (readAll_subset rest _ id member)

/-- After a line that closes the connection nothing is read and nothing waits. -/
theorem readAll_closes (pending : List Int) (line : Json) (rest : List Json)
    (closes : (read pending line).2.closes = true) : readAll pending (line :: rest) = ([], [(read pending line).2]) := by
  simp [readAll, closes]

end McpProtocolSpec

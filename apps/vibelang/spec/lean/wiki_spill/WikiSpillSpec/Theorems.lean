import WikiSpillSpec.Budget

/-!
# What the encoding guarantees

Machine-checked properties of the specification, each for every list of code units: lone surrogates, NUL and
control characters included.
-/

namespace WikiSpillSpec

/-! ## Escaping -/

/-- An escaped text reads back as an inline text: itself. -/
theorem classify_escape (text : Text) : classify (escape text) = .text text := by
  unfold escape
  split
  · rfl
  · next notNul =>
    match text with
    | [] => rfl
    | 0 :: rest => simp [startsNul] at notNul
    | (unit + 1) :: rest => simp [classify]

/-- Escaping loses nothing: `unescape (escape text) = some text` for every text. -/
theorem unescape_escape (text : Text) : unescape (escape text) = some text := by
  simp [unescape, classify_escape]

/-- Two texts never share an escaped form. -/
theorem escape_injective {a b : Text} (same : escape a = escape b) : a = b := by
  have := unescape_escape a
  rw [same, unescape_escape] at this
  exact (Option.some.inj this).symm

/-- A text that does not start with NUL is written verbatim. -/
theorem escape_verbatim {text : Text} (plain : startsNul text = false) : escape text = text := by
  simp [escape, plain]

/-- A text that starts with NUL is written after the literal prefix. -/
theorem escape_literal {text : Text} (nul : startsNul text = true) : escape text = litPrefix ++ text := by
  simp [escape, nul]

/-- A reference reads back as a reference to its digest. -/
theorem classify_blobRef (digest : Text) : classify (blobRef digest) = .blob digest := rfl

/-- An escaped text is never a reference, whatever the digest. -/
theorem escape_ne_blobRef (text digest : Text) : escape text ≠ blobRef digest := by
  intro same
  have := classify_escape text
  rw [same, classify_blobRef] at this
  cases this

/-- An escaped text never starts with the reference prefix `"\u0000blob:"`. -/
theorem escape_not_blobPrefix (text : Text) : ¬ blobPrefix <+: escape text := by
  intro ⟨rest, same⟩
  exact escape_ne_blobRef text rest same.symm

/-- Two digests never share a reference. -/
theorem blobRef_injective {a b : Text} (same : blobRef a = blobRef b) : a = b :=
  List.append_cancel_left same

/-- A reference holds no inline text. -/
theorem unescape_blobRef (digest : Text) : unescape (blobRef digest) = none := rfl

/-! ## Chunks -/

/-- Joining the chunks of a text gives the text back, for every text and every chunk size. -/
theorem reassemble_splitChunks (size : Nat) (text : Text) : reassemble (splitChunks size text) = text := by
  fun_induction splitChunks size text <;> simp_all [reassemble]

/-- No chunk is empty. -/
theorem splitChunks_nonEmpty (size : Nat) (text : Text) : ∀ chunk ∈ splitChunks size text, chunk ≠ [] := by
  fun_induction splitChunks size text with
  | case1 => simp
  | case2 text nonEmpty => simpa using nonEmpty
  | case3 text nonEmpty positive rest =>
    intro chunk member
    rcases List.mem_cons.mp member with first | later
    · subst first
      have := cut_pos nonEmpty positive
      intro none
      rcases List.take_eq_nil_iff.mp none with zero | empty
      · omega
      · exact nonEmpty empty
    · exact rest chunk later

/-- A chunk holds at most one unit more than the chunk size. -/
theorem splitChunks_length_le {size : Nat} (positive : size ≠ 0) (text : Text) :
    ∀ chunk ∈ splitChunks size text, chunk.length ≤ size + 1 := by
  fun_induction splitChunks size text with
  | case1 => simp
  | case2 text nonEmpty zero => exact absurd zero positive
  | case3 text nonEmpty _ rest =>
    intro chunk member
    rcases List.mem_cons.mp member with first | later
    · subst first
      have bound := cut_le_succ size text
      have whole := cut_le size text
      simp only [List.length_take]
      unfold cut at *
      split
      · split
        · split <;> omega
        · omega
      · omega
    · exact rest chunk later

/-- The boundary between two chunks falls inside a surrogate pair: a high surrogate ends `before` and its low
surrogate starts `after`. -/
def SplitsPair (before after : Text) : Prop :=
  ∃ high low, before.getLast? = some high ∧ after.head? = some low ∧ isHigh high = true ∧ isLow low = true

/-- No boundary between neighbouring chunks falls inside a surrogate pair. -/
def NoPairSplit : List Text → Prop
  | before :: after :: rest => ¬ SplitsPair before after ∧ NoPairSplit (after :: rest)
  | _ => True

theorem not_high_of_low {unit : Nat} (low : isLow unit = true) : isHigh unit = false := by
  simp [isLow, isHigh] at *
  omega

/-- The first chunk starts where the text starts. -/
theorem splitChunks_head {size : Nat} {text first : Text} {rest : List Text}
    (chunks : splitChunks size text = first :: rest) : first.head? = text.head? := by
  rw [splitChunks] at chunks
  split at chunks
  · cases chunks
  · next nonEmpty =>
    split at chunks
    · cases chunks; rfl
    · next positive =>
      have := cut_pos nonEmpty positive
      cases chunks
      rw [List.head?_take]
      split
      · omega
      · rfl

/-- Every high surrogate is followed by a low one. Dropping a prefix keeps it. -/
def PairsClosed (text : Text) : Prop :=
  ∀ index high, text[index]? = some high → isHigh high = true →
    ∃ low, text[index + 1]? = some low ∧ isLow low = true

/-- A well-formed text closes its pairs. -/
theorem pairsClosed_of_wellFormed (text : Text) (formed : wellFormed text = true) : PairsClosed text := by
  induction size : text.length using Nat.strongRecOn generalizing text with
  | _ length smaller =>
    intro index high found isHighUnit
    match text, size, formed with
    | [], _, _ => simp at found
    | [unit], _, formed =>
      match index with
      | 0 =>
        simp at found
        subst found
        simp [wellFormed, isHighUnit] at formed
      | index + 1 => simp at found
    | unit :: next :: tail, size, formed =>
      simp only [List.length_cons] at size
      unfold wellFormed at formed
      split at formed
      · next leading =>
        simp only [Bool.and_eq_true] at formed
        match index with
        | 0 => exact ⟨next, by simp, formed.1⟩
        | 1 =>
          simp at found
          subst found
          have := not_high_of_low formed.1
          simp_all
        | index + 2 =>
          have := smaller tail.length (by omega) tail formed.2 rfl index high (by simpa using found) isHighUnit
          simpa using this
      · next leading =>
        simp only [Bool.and_eq_true] at formed
        match index with
        | 0 =>
          simp at found
          subst found
          simp_all
        | index + 1 =>
          have := smaller (next :: tail).length (by simp; omega) (next :: tail) formed.2 rfl index high
            (by simpa using found) isHighUnit
          simpa using this

/-- Dropping a prefix keeps the pairs closed. -/
theorem pairsClosed_drop {text : Text} (closed : PairsClosed text) (count : Nat) : PairsClosed (text.drop count) := by
  intro index high found isHighUnit
  rw [List.getElem?_drop] at found
  obtain ⟨low, lowAt, isLowUnit⟩ := closed (count + index) high found isHighUnit
  exact ⟨low, by rw [List.getElem?_drop]; exact lowAt, isLowUnit⟩

/-- The first cut takes the whole text, or one unit more than the size after a high surrogate, or the size after a
unit that is not a high surrogate. -/
theorem cut_cases (size : Nat) (text : Text) :
    cut size text = text.length
      ∨ (cut size text = size + 1 ∧ ∃ last, text[size - 1]? = some last ∧ isHigh last = true)
      ∨ (cut size text = size ∧ ∀ last, text[size - 1]? = some last → isHigh last = false) := by
  unfold cut
  split
  · cases found : text[size - 1]? with
    | none =>
      refine .inr (.inr ⟨rfl, ?_⟩)
      intro unit same
      cases same
    | some last =>
      dsimp only
      split
      · next leading => exact .inr (.inl ⟨rfl, last, rfl, leading⟩)
      · next other =>
        refine .inr (.inr ⟨rfl, ?_⟩)
        intro unit same
        cases same
        simpa using other
  · exact .inl rfl

/-- In a text that closes its pairs, the first cut never falls inside a surrogate pair. -/
theorem cut_keeps_pairs (size : Nat) (text : Text) (nonEmpty : text ≠ []) (positive : size ≠ 0)
    (closed : PairsClosed text) : ¬ SplitsPair (text.take (cut size text)) (text.drop (cut size text)) := by
  intro ⟨high, low, last, next, isHighLast, isLowNext⟩
  have cutPositive := cut_pos nonEmpty positive
  have cutBound := cut_le size text
  rw [List.head?_drop] at next
  rw [List.getLast?_eq_getElem?, List.getElem?_take, List.length_take] at last
  have index : min (cut size text) text.length - 1 = cut size text - 1 := by omega
  rw [index, if_pos (by omega)] at last
  rcases cut_cases size text with whole | ⟨extended, leading, leadingAt, isHighLeading⟩ | ⟨exact, plain⟩
  · rw [whole, List.getElem?_eq_none (Nat.le_refl _)] at next
    cases next
  · obtain ⟨second, secondAt, isLowSecond⟩ := closed (size - 1) leading leadingAt isHighLeading
    have shift : size - 1 + 1 = size := by omega
    rw [shift] at secondAt
    rw [extended] at last
    simp only [Nat.add_sub_cancel] at last
    rw [secondAt] at last
    cases last
    have := not_high_of_low isLowSecond
    simp_all
  · rw [exact] at last
    have := plain high last
    simp_all

/-- In a text that closes its pairs, no chunk boundary falls inside a surrogate pair. -/
theorem splitChunks_noPairSplit_of_closed (size : Nat) (text : Text) :
    PairsClosed text → NoPairSplit (splitChunks size text) := by
  fun_induction splitChunks size text with
  | case1 => intro _; trivial
  | case2 => intro _; trivial
  | case3 text nonEmpty positive rest =>
    intro closed
    have later := rest (pairsClosed_drop closed _)
    match tail : splitChunks size (text.drop (cut size text)) with
    | [] => trivial
    | after :: others =>
      rw [tail] at later
      refine ⟨?_, later⟩
      intro ⟨high, low, last, next, isHighLast, isLowNext⟩
      rw [splitChunks_head tail] at next
      exact cut_keeps_pairs size text nonEmpty positive closed ⟨high, low, last, next, isHighLast, isLowNext⟩

/-- No chunk boundary of a well-formed text falls inside a surrogate pair, at any chunk size. `DurableText` admits
only well-formed text to the journal, so this covers every text `Wiki.vibe` spills. -/
theorem splitChunks_noPairSplit (size : Nat) (text : Text) (formed : wellFormed text = true) :
    NoPairSplit (splitChunks size text) :=
  splitChunks_noPairSplit_of_closed size text (pairsClosed_of_wellFormed text formed)

/-! ## JSON bytes -/

/-- A running total only adds to the count. -/
theorem contentBytesFrom_total (text : Text) : ∀ total, contentBytesFrom total text = total + contentBytes text := by
  unfold contentBytes
  induction size : text.length using Nat.strongRecOn generalizing text with
  | _ length smaller =>
    intro total
    match text, size with
    | [], _ => simp [contentBytesFrom]
    | [unit], _ => simp [contentBytesFrom]
    | unit :: next :: tail, size =>
      simp only [contentBytesFrom]
      simp only [List.length_cons] at size
      split
      · rw [smaller tail.length (by omega) tail rfl (total + 4), smaller tail.length (by omega) tail rfl (0 + 4)]
        omega
      · rw [smaller (next :: tail).length (by simp; omega) (next :: tail) rfl (total + unitBytes unit),
          smaller (next :: tail).length (by simp; omega) (next :: tail) rfl (0 + unitBytes unit)]
        omega

/-- Before a text, a prefix without high surrogates costs the sum of its units. -/
theorem contentBytesFrom_prefix (before : Text) (noHigh : ∀ unit ∈ before, isHigh unit = false) (text : Text) :
    ∀ total, contentBytesFrom total (before ++ text) = contentBytesFrom (total + (before.map unitBytes).sum) text := by
  induction before with
  | nil => simp
  | cons unit rest step =>
    intro total
    have unitLow : isHigh unit = false := noHigh unit (by simp)
    have restLow : ∀ other ∈ rest, isHigh other = false := fun other member => noHigh other (by simp [member])
    match shape : rest ++ text with
    | [] =>
      have restEmpty : rest = [] := (List.append_eq_nil_iff.mp shape).1
      have textEmpty : text = [] := (List.append_eq_nil_iff.mp shape).2
      subst restEmpty textEmpty
      simp [contentBytesFrom]
    | next :: tail =>
      have := step restLow (total + unitBytes unit)
      rw [shape] at this
      simp only [List.cons_append, shape, contentBytesFrom, unitLow, Bool.false_and, List.map_cons, List.sum_cons]
      simp only [Bool.false_eq_true, if_false]
      rw [this, Nat.add_assoc]

/-- The literal prefix costs 10 bytes: `\u0000` and `lit:`. -/
theorem jsonBytes_literal (text : Text) : jsonBytes (litPrefix ++ text) = jsonBytes text + 10 := by
  unfold jsonBytes contentBytes
  rw [contentBytesFrom_prefix litPrefix (by decide) text 0, contentBytesFrom_total]
  simp [litPrefix, unitBytes, contentBytes]
  omega

/-- Escaping adds at most 10 bytes. -/
theorem jsonBytes_escape_le (text : Text) : jsonBytes (escape text) ≤ jsonBytes text + 10 := by
  unfold escape
  split
  · rw [jsonBytes_literal]; omega
  · omega

/-- A character of a hexadecimal digest: a digit or a lowercase letter `a` to `f`. -/
def isHex (unit : Nat) : Bool := (48 ≤ unit && unit ≤ 57) || (97 ≤ unit && unit ≤ 102)

/-- A text of hexadecimal characters costs one byte for each. -/
theorem contentBytes_hex (digest : Text) (hex : ∀ unit ∈ digest, isHex unit = true) :
    contentBytes digest = digest.length := by
  have noHigh : ∀ unit ∈ digest, isHigh unit = false := by
    intro unit member
    have := hex unit member
    simp [isHex, isHigh] at *
    omega
  have each : (digest.map unitBytes).sum = digest.length := by
    clear noHigh
    induction digest with
    | nil => rfl
    | cons unit rest step =>
      have one : unitBytes unit = 1 := by
        have := hex unit (by simp)
        simp [isHex] at this
        unfold unitBytes
        repeat' split
        all_goals omega
      have := step fun other member => hex other (by simp [member])
      simp [one, this]
      omega
  have := contentBytesFrom_prefix digest noHigh [] 0
  simp [contentBytesFrom] at this
  unfold contentBytes
  rw [this, each]

/-- A reference to a 64-character hexadecimal digest is 77 bytes of JSON. -/
theorem jsonBytes_blobRef (digest : Text) (hex : ∀ unit ∈ digest, isHex unit = true) (length : digest.length = 64) :
    jsonBytes (blobRef digest) = 77 := by
  unfold jsonBytes contentBytes blobRef
  rw [contentBytesFrom_prefix blobPrefix (by decide) digest 0, contentBytesFrom_total, contentBytes_hex digest hex]
  simp [blobPrefix, unitBytes, length]

/-! ## Spilling -/

/-- An encoding that reports no change of form is the text itself. -/
theorem encode_unchanged {digest : Text → Text} {threshold : Nat} {text : Text}
    (same : (encode digest threshold text).encoded = false) : (encode digest threshold text).value = text := by
  unfold encode at *
  split
  · next inline =>
    rw [if_pos inline] at same
    exact escape_verbatim same
  · next spilled =>
    rw [if_neg spilled] at same
    cases same

/-- With an injective digest, two texts never share a journaled form at one threshold. -/
theorem encode_injective {digest : Text → Text} (injective : ∀ a b, digest a = digest b → a = b)
    (threshold : Nat) {a b : Text} (same : (encode digest threshold a).value = (encode digest threshold b).value) :
    a = b := by
  unfold encode at same
  split at same <;> split at same
  · exact escape_injective same
  · exact absurd same (escape_ne_blobRef _ _)
  · exact absurd same.symm (escape_ne_blobRef _ _)
  · exact injective a b (blobRef_injective same)

/-- A journaled text is within the threshold and 10 bytes of escaping, or it is a 77-byte reference. -/
theorem jsonBytes_encode_le {digest : Text → Text}
    (hex : ∀ text, (digest text).length = 64 ∧ ∀ unit ∈ digest text, isHex unit = true)
    (threshold : Nat) (text : Text) : jsonBytes (encode digest threshold text).value ≤ max (threshold + 10) 77 := by
  unfold encode
  split
  · have := jsonBytes_escape_le text
    simp only []
    omega
  · have := jsonBytes_blobRef (digest text) (hex text).2 (hex text).1
    simp only []
    omega

/-- A journaled request text (`dehydrateWikiRequest`) is at most 256 KiB and 10 bytes, so the two texts of a
request leave more than 1.4 MB of a journal entry for its other fields. -/
theorem jsonBytes_request_text {digest : Text → Text}
    (hex : ∀ text, (digest text).length = 64 ∧ ∀ unit ∈ digest text, isHex unit = true) (base text : Text) :
    jsonBytes (encode digest blobThreshold base).value + jsonBytes (encode digest blobThreshold text).value
      + 1507308 ≤ maxEntryBytes := by
  have first := jsonBytes_encode_le hex blobThreshold base
  have second := jsonBytes_encode_le hex blobThreshold text
  simp only [blobThreshold, maxEntryBytes] at *
  omega

/-- No storage holds nothing wrong. -/
theorem storeOk_empty (digest : Text → Text) : StoreOk digest (fun _ => none) := by
  intro text chunks stored
  cases stored

/-- Storing a text keeps every stored digest. -/
theorem persist_keeps (digest : Text → Text) (store : Store) (text : Text) {key : Text} {chunks : List Text}
    (stored : store key = some chunks) : persist digest store text key = some chunks := by
  unfold persist
  split
  · rw [stored]
  · exact stored

/-- Storing a text stores its digest. -/
theorem persist_stores (digest : Text → Text) (store : Store) (text : Text) :
    (persist digest store text (digest text)).isSome = true := by
  unfold persist
  rw [if_pos rfl]
  split <;> rfl

/-- With an injective digest, storing a text keeps storage right. -/
theorem persist_storeOk {digest : Text → Text} (injective : ∀ a b, digest a = digest b → a = b) {store : Store}
    (ok : StoreOk digest store) (text : Text) : StoreOk digest (persist digest store text) := by
  intro other chunks stored
  unfold persist at stored
  split at stored
  · next sameKey =>
    have sameText := injective other text sameKey
    subst sameText
    split at stored
    · next kept present => exact ok other chunks (present.trans stored)
    · cases stored
      exact reassemble_splitChunks chunkSize other
  · exact ok other chunks stored

/-- A journaled text reads back as the text, from right storage that holds every spilled digest. -/
theorem decode_encode {digest : Text → Text} {store : Store} (ok : StoreOk digest store) (threshold : Nat)
    (text : Text) (present : threshold < jsonBytes text → (store (digest text)).isSome = true) :
    decode store (encode digest threshold text).value = some text := by
  unfold encode
  split
  · simp [decode, classify_escape]
  · next spilled =>
    have stored := present (by omega)
    match found : store (digest text) with
    | none => simp [found] at stored
    | some chunks => simp [decode, classify_blobRef, found, ok text chunks found]

/-- Writing a text and reading it back gives the text, for every text and threshold: inline through escaping,
spilled through its chunks. -/
theorem decode_encodeStored {digest : Text → Text} {store : Store} (ok : StoreOk digest store) (threshold : Nat)
    (text : Text) :
    decode (encodeStored digest threshold store text).2 (encodeStored digest threshold store text).1.value
      = some text := by
  unfold encodeStored encode
  split
  · simp [decode, classify_escape]
  · simp only [decode, classify_blobRef]
    unfold persist
    rw [if_pos rfl]
    match found : store (digest text) with
    | none => simp [reassemble_splitChunks]
    | some chunks => simp [ok text chunks found]

/-- A retained draft reads back as the draft. -/
theorem recall_retain {digest : Text → Text} {store : Store} (ok : StoreOk digest store) (text : Text)
    (present : draftInlineLimit < jsonBytes text → (store (digest text)).isSome = true) :
    recall store (retain digest text) = some text := by
  unfold retain
  split
  · rfl
  · next spilled =>
    have stored := present (by omega)
    match found : store (digest text) with
    | none => simp [found] at stored
    | some chunks => simp [recall, decode, classify_blobRef, found, ok text chunks found]

/-! ## Compaction -/

/-- An accepted journal form of a state is at most 1 MiB of JSON. -/
theorem dehydrate_within_limit {digest : Text → Text} {state : State} {compacted : Compacted}
    (accepted : dehydrate digest state = some compacted) : stateBytes compacted.state ≤ stateTotalLimit := by
  unfold dehydrate at accepted
  simp only [] at accepted
  split at accepted
  · cases accepted; assumption
  · split at accepted
    · cases accepted; assumption
    · split at accepted
      · cases accepted; assumption
      · cases accepted

/-- An accepted journal form of a state is strictly below `SqlJournal`'s entry cap of 2,031,616 bytes, and leaves
983,040 bytes of the entry for the rest of the journal row. -/
theorem dehydrate_below_entry_cap {digest : Text → Text} {state : State} {compacted : Compacted}
    (accepted : dehydrate digest state = some compacted) :
    stateBytes compacted.state < maxEntryBytes ∧ stateBytes compacted.state + 983040 ≤ maxEntryBytes := by
  have := dehydrate_within_limit accepted
  simp only [stateTotalLimit, maxEntryBytes] at *
  omega

/-- A state is refused exactly when even its fully spilled form is above 1 MiB. -/
theorem dehydrate_refused {digest : Text → Text} {state : State} (refused : dehydrate digest state = none) :
    stateTotalLimit < stateBytes (spillState digest 0 state).1 := by
  unfold dehydrate at refused
  simp only [] at refused
  split at refused
  · cases refused
  · split at refused
    · cases refused
    · split at refused
      · cases refused
      · omega

/-- An accepted journal form is one of the three passes over the state. -/
theorem dehydrate_is_pass {digest : Text → Text} {state : State} {compacted : Compacted}
    (accepted : dehydrate digest state = some compacted) :
    ∃ threshold, (threshold = blobThreshold ∨ threshold = compactThreshold ∨ threshold = 0)
      ∧ (compacted.state, compacted.encoded) = spillState digest threshold state := by
  unfold dehydrate at accepted
  simp only [] at accepted
  split at accepted
  · cases accepted; exact ⟨blobThreshold, .inl rfl, rfl⟩
  · split at accepted
    · cases accepted; exact ⟨compactThreshold, .inr (.inl rfl), rfl⟩
    · split at accepted
      · cases accepted; exact ⟨0, .inr (.inr rfl), rfl⟩
      · cases accepted

/-- The pages of a pass read back as the pages. -/
theorem hydratePages_spill {digest : Text → Text} {store : Store} (ok : StoreOk digest store) (threshold : Nat)
    (pages : List Page)
    (present : ∀ page ∈ pages, threshold < jsonBytes page.source → (store (digest page.source)).isSome = true) :
    hydratePages store (pages.map fun page => { page with source := (encode digest threshold page.source).value })
      = some pages := by
  induction pages with
  | nil => rfl
  | cons page rest step =>
    have first := decode_encode ok threshold page.source (present page (by simp))
    have later := step fun other member => present other (by simp [member])
    simp only [List.map_cons, hydratePages, first, later]

/-- Every pass reads back as the state it was made from: compaction loses no page and no draft. -/
theorem hydrate_spillState {digest : Text → Text} {store : Store} (ok : StoreOk digest store) (threshold : Nat)
    (state : State)
    (pagesPresent : ∀ page ∈ state.pages,
      threshold < jsonBytes page.source → (store (digest page.source)).isSome = true)
    (draftPresent : ∀ draft, state.draft = some draft →
      threshold < jsonBytes draft.text → (store (digest draft.text)).isSome = true) :
    hydrate store (spillState digest threshold state).1 = some state := by
  have pages := hydratePages_spill ok threshold state.pages pagesPresent
  unfold spillState
  simp only [List.map_map]
  match shape : state.draft with
  | none =>
    simp only [hydrate, Function.comp_def, pages]
    cases state
    simp_all
  | some draft =>
    have text := decode_encode ok threshold draft.text (draftPresent draft shape)
    simp only [hydrate, Function.comp_def, pages, text]
    cases state
    simp_all

/-- An accepted journal form reads back as the state, from right storage that holds every spilled digest. -/
theorem hydrate_dehydrate {digest : Text → Text} {store : Store} (ok : StoreOk digest store) {state : State}
    {compacted : Compacted} (accepted : dehydrate digest state = some compacted)
    (pagesPresent : ∀ page ∈ state.pages, (store (digest page.source)).isSome = true)
    (draftPresent : ∀ draft, state.draft = some draft → (store (digest draft.text)).isSome = true) :
    hydrate store compacted.state = some state := by
  obtain ⟨threshold, _, pass⟩ := dehydrate_is_pass accepted
  have := hydrate_spillState ok threshold state (fun page member _ => pagesPresent page member)
    (fun draft shape _ => draftPresent draft shape)
  rw [← pass] at this
  exact this

end WikiSpillSpec

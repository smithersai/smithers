import WikiSpillSpec.Chunk

/-!
# The byte budget: JSON bytes, spilling and compaction of a wiki state

`SqlJournal` refuses a journal entry of more than 2,031,616 bytes of encoded JSON. `Wiki.vibe` measures every text
as `new TextEncoder().encode(JSON.stringify(text)).byteLength`, spills a text above a threshold into chunked
storage, and compacts a whole `WikiState` in three passes (256 KiB, 16 KiB, 0) until it is at most 1 MiB.
-/

namespace WikiSpillSpec

/-- `WIKI_BLOB_THRESHOLD`: a request text or a page above 256 KiB of JSON spills. -/
def blobThreshold : Nat := 256 * 1024

/-- `WIKI_STATE_COMPACT_THRESHOLD`: the second pass spills every text above 16 KiB of JSON. -/
def compactThreshold : Nat := 16 * 1024

/-- `WIKI_STATE_TOTAL_LIMIT`: a journaled state is at most 1 MiB of JSON. -/
def stateTotalLimit : Nat := 1024 * 1024

/-- `WIKI_DRAFT_INLINE_LIMIT`: a retained draft above 64 KiB of JSON spills. -/
def draftInlineLimit : Nat := 64 * 1024

/-- `SqlJournal`'s `maxEntryBytes`. -/
def maxEntryBytes : Nat := 2031616

/-- The UTF-8 bytes `JSON.stringify` writes for one code unit that is not half of a surrogate pair. A quote, a
backslash and the five short escapes take 2 bytes, any other control character takes 6 (`\u00XX`), and a lone
surrogate takes 6 (`\uDXXX`, well-formed `JSON.stringify`). -/
def unitBytes (unit : Nat) : Nat :=
  if unit = 0x22 ∨ unit = 0x5C then 2
  else if unit = 8 ∨ unit = 9 ∨ unit = 10 ∨ unit = 12 ∨ unit = 13 then 2
  else if unit < 0x20 then 6
  else if unit < 0x80 then 1
  else if unit < 0x800 then 2
  else if isHigh unit || isLow unit then 6
  else 3

/-- `total` plus the bytes of `text` between the quotes. A surrogate pair is one 4-byte character. -/
def contentBytesFrom (total : Nat) : Text → Nat
  | [] => total
  | [unit] => total + unitBytes unit
  | unit :: next :: tail =>
    if isHigh unit && isLow next then contentBytesFrom (total + 4) tail
    else contentBytesFrom (total + unitBytes unit) (next :: tail)

/-- The bytes of `text` between the quotes of its JSON form. -/
def contentBytes (text : Text) : Nat := contentBytesFrom 0 text

/-- `new TextEncoder().encode(JSON.stringify(text)).byteLength`. -/
def jsonBytes (text : Text) : Nat := contentBytes text + 2

/-- A journaled text and whether it differs in form from the text itself (`encodeWikiText`'s answer). -/
structure Encoded where
  value : Text
  encoded : Bool
  deriving Repr, DecidableEq

/-- `encodeWikiText`: a text within `threshold` JSON bytes stays inline, escaped; a larger one becomes a
reference to its digest. `digest` is the hex SHA-256 of the text's content. -/
def encode (digest : Text → Text) (threshold : Nat) (text : Text) : Encoded :=
  if jsonBytes text ≤ threshold then { value := escape text, encoded := startsNul text }
  else { value := blobRef (digest text), encoded := true }

/-- Chunked storage: the chunks stored under a digest. -/
abbrev Store := Text → Option (List Text)

/-- Stores the chunks of `text` under its digest unless that digest is already stored. -/
def persist (digest : Text → Text) (store : Store) (text : Text) : Store := fun key =>
  if key = digest text then
    match store key with
    | some chunks => some chunks
    | none => some (splitChunks chunkSize text)
  else store key

/-- `encodeWikiText` with `persist = true`: the journaled text and the storage after it. -/
def encodeStored (digest : Text → Text) (threshold : Nat) (store : Store) (text : Text) : Encoded × Store :=
  (encode digest threshold text, if jsonBytes text ≤ threshold then store else persist digest store text)

/-- `decodeWikiText`: the text a wire text holds or refers to; `none` is the refusal `unavailable`. -/
def decode (store : Store) (wire : Text) : Option Text :=
  match classify wire with
  | .text value => some value
  | .blob digest => (store digest).map reassemble
  | .invalid => none

/-- Every stored digest holds chunks of the text it is the digest of. -/
def StoreOk (digest : Text → Text) (store : Store) : Prop :=
  ∀ text chunks, store (digest text) = some chunks → reassemble chunks = text

/-- `WikiPageState`. -/
structure Page where
  id : Text
  source : Text
  revision : Text
  deriving Repr, DecidableEq

/-- A `WikiState`'s draft. -/
structure Draft where
  page : Text
  text : Text
  deriving Repr, DecidableEq

/-- `WikiState`. -/
structure State where
  seq : Nat
  pages : List Page
  review : Option Text
  draft : Option Draft
  role : Option Text
  stale : Option Nat
  deriving Repr, DecidableEq

/-- The decimal digits `JSON.stringify` writes for a whole number below `2 ^ 53`. -/
def digits (value : Nat) : Nat := (toString value).length

/-- `{"id":…,"source":…,"revision":…}`. -/
def pageBytes (page : Page) : Nat := 29 + jsonBytes page.id + jsonBytes page.source + jsonBytes page.revision

/-- `[…,…]`. -/
def pagesBytes (pages : List Page) : Nat := 2 + (pages.map pageBytes).sum + (pages.length - 1)

/-- `new TextEncoder().encode(JSON.stringify(state)).byteLength`. -/
def stateBytes (state : State) : Nat :=
  2 + (6 + digits state.seq) + (1 + 8 + pagesBytes state.pages)
    + (match state.review with
      | some review => 1 + 9 + jsonBytes review
      | none => 0)
    + (match state.draft with
      | some draft => 1 + 25 + jsonBytes draft.page + jsonBytes draft.text
      | none => 0)
    + (match state.role with
      | some role => 1 + 7 + jsonBytes role
      | none => 0)
    + (match state.stale with
      | some stale => 1 + 8 + digits stale
      | none => 0)

/-- One pass of `dehydrateWikiState`: every page source and the draft text through `encode` at `threshold`.
The flag says whether any text changed form. -/
def spillState (digest : Text → Text) (threshold : Nat) (state : State) : State × Bool :=
  let sources := state.pages.map fun page => (page, encode digest threshold page.source)
  let pages := sources.map fun entry => { entry.1 with source := entry.2.value }
  let changed := sources.any fun entry => entry.2.encoded
  match state.draft with
  | none => ({ state with pages := pages }, changed)
  | some draft =>
    let text := encode digest threshold draft.text
    ({ state with pages := pages, draft := some { draft with text := text.value } }, changed || text.encoded)

/-- The pass of `dehydrateWikiState` that was accepted. -/
inductive Tier where
  /-- Texts above 256 KiB spilled. -/
  | first
  /-- Texts above 16 KiB spilled. -/
  | compact
  /-- Every text spilled. -/
  | minimal
  deriving Repr, DecidableEq

/-- An accepted journal form of a state. -/
structure Compacted where
  tier : Tier
  state : State
  encoded : Bool
  deriving Repr, DecidableEq

/-- `dehydrateWikiState`: the first of three passes whose state is at most `stateTotalLimit`; `none` is the
refusal `unavailable`. -/
def dehydrate (digest : Text → Text) (state : State) : Option Compacted :=
  let first := spillState digest blobThreshold state
  if stateBytes first.1 ≤ stateTotalLimit then some { tier := .first, state := first.1, encoded := first.2 }
  else
    let compact := spillState digest compactThreshold state
    if stateBytes compact.1 ≤ stateTotalLimit then
      some { tier := .compact, state := compact.1, encoded := compact.2 }
    else
      let minimal := spillState digest 0 state
      if stateBytes minimal.1 ≤ stateTotalLimit then
        some { tier := .minimal, state := minimal.1, encoded := minimal.2 }
      else none

/-- The pages of `hydrateWikiState`. -/
def hydratePages (store : Store) : List Page → Option (List Page)
  | [] => some []
  | page :: rest =>
    match decode store page.source, hydratePages store rest with
    | some source, some pages => some ({ page with source := source } :: pages)
    | _, _ => none

/-- `hydrateWikiState`: every page source and the draft text through `decode`. -/
def hydrate (store : Store) (state : State) : Option State :=
  match hydratePages store state.pages with
  | none => none
  | some pages =>
    match state.draft with
    | none => some { state with pages := pages }
    | some draft =>
      match decode store draft.text with
      | some text => some { state with pages := pages, draft := some { draft with text := text } }
      | none => none

/-- A draft as `saveDraft` retains it: the text and whether it is a reference (`blob: 1`). A retained draft is
never escaped; the flag alone says how to read it. -/
structure Retained where
  text : Text
  blob : Bool
  deriving Repr, DecidableEq

/-- `saveDraft`: a draft within 64 KiB of JSON is kept as written, a larger one as a reference. -/
def retain (digest : Text → Text) (text : Text) : Retained :=
  if jsonBytes text ≤ draftInlineLimit then { text := text, blob := false }
  else { text := blobRef (digest text), blob := true }

/-- `loadDraft`: a flagged draft is read through `decode`, any other as written. -/
def recall (store : Store) (retained : Retained) : Option Text :=
  if retained.blob then decode store retained.text else some retained.text

end WikiSpillSpec

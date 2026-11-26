import SmithersState.Basic

/-!
# Chat messages: append-only, idempotent by id, conflict-refusing

A message has an identity (`id`, `author`, `hubSeq`, `origin`) that no event
changes, a `status` that never leaves a terminal value, `run` metadata that is
frozen once the status is terminal, and `notes` that stay writable.

Its `body` only grows. A body update carries the whole body its author has so
far and is accepted only when that body extends the stored one. Only the
message's own author extends it, never once its status is terminal, and never
when it is a question (`role = "user"`).

A message's place among its conversation's is `Chat.places`, the one rule every
reader orders by. Only ChatApi's bridge places a message: a `position` counts
when the message's author is the bridge's owner name for its id
(`questionOwner`, `answerOwner`), and is ignored from anyone else. Any other
message is anchored where the shard sequenced it, never before a message that
was already there. One movement is permitted, for a shard written before posts
carried a position: a bridge answer posted with none reads straight after its
bridge question once that question, with its position, is posted. No event
changes a message's origin, and nothing else moves a message.

Notes carry a `noteVersion` when the bridge writes them. A patch whose version
is no newer than the stored one changes nothing, so a delayed older note never
replaces a newer one.

A post carries the message's first `run` and `notes`, so a message and what is
known of it at birth are one command and one event. A post over a message that
exists emits no event: it is a no-op when everything it says already holds and
a conflict otherwise.
-/

namespace SmithersState

def findMessage (ms : List Message) (id : Id) : Option Message :=
  ms.find? (fun m => m.id == id)

def isTerminal (status : String) : Bool :=
  status == "complete" || status == "failed"

/-- A patch: each field it has replaces the old one, each field it lacks keeps it. -/
def MessageRun.merge (old patch : MessageRun) : MessageRun :=
  { parts := patch.parts.or old.parts
    failure := patch.failure.or old.failure
    modelId := patch.modelId.or old.modelId
    stopReason := patch.stopReason.or old.stopReason
    inputTokens := patch.inputTokens.or old.inputTokens
    outputTokens := patch.outputTokens.or old.outputTokens }

def MessageNotes.merge (old patch : MessageNotes) : MessageNotes :=
  { summary := patch.summary.or old.summary
    summaryRevision := patch.summaryRevision.or old.summaryRevision
    phase := patch.phase.or old.phase
    arc := patch.arc.or old.arc
    updatedAt := patch.updatedAt.or old.updatedAt
    noteVersion := patch.noteVersion.or old.noteVersion }

/-- Whether `patch` is a write of the notes no newer than the one `old` holds. A
patch or a message with no version is never stale. -/
def MessageNotes.stale (old patch : MessageNotes) : Prop :=
  ∃ v w, old.noteVersion = some v ∧ patch.noteVersion = some w ∧ w ≤ v

instance (old patch : MessageNotes) : Decidable (old.stale patch) :=
  match ho : old.noteVersion, hp : patch.noteVersion with
  | some v, some w =>
    if h : w ≤ v then isTrue ⟨v, w, ho, hp, h⟩
    else isFalse (by
      rintro ⟨v', w', hv, hw, hle⟩
      rw [ho] at hv; rw [hp] at hw
      cases hv; cases hw
      exact h hle)
  | none, _ => isFalse (by rintro ⟨v', w', hv, _, _⟩; rw [ho] at hv; cases hv)
  | some _, none => isFalse (by rintro ⟨v', w', _, hw, _⟩; rw [hp] at hw; cases hw)

/-- The owner name ChatApi's bridge writes question `id` under, and no one else. -/
def questionOwner (id : Id) : String := "person:question:" ++ id

/-- The owner name ChatApi's bridge writes answer `id` under, and no one else. -/
def answerOwner (id : Id) : String := "answer:" ++ id

/-- What no event after the post may change: id, author, sequence number, origin. -/
abbrev Identity := Id × String × Nat × MessageOrigin

def Message.identity (m : Message) : Identity :=
  (m.id, m.author, m.hubSeq, m.origin)

/-- The highest position a reader admits. Every place is a position, a sequence number or
a floor one or two past one, so under this ceiling the arithmetic is exact where a number
is an IEEE-754 double (`2 ^ 53` is the first integer one cannot step from by one). -/
def maxAdmittedPosition : Nat := 1125899906842624

theorem maxAdmittedPosition_eq : maxAdmittedPosition = 2 ^ 50 := by decide

/-- The position a post names, when a reader admits it: at most `maxAdmittedPosition`.
A higher one is no position at all, whoever posted it. -/
def MessageOrigin.place (o : MessageOrigin) : Option Nat :=
  match o.position with
  | some p => if p ≤ maxAdmittedPosition then some p else none
  | none => none

/-- The position a message's post gave it, when the bridge posted it. A position
anyone else's post carries is not a place. -/
def Identity.position (i : Identity) : Option Nat :=
  if i.2.1 = questionOwner i.1 ∨ i.2.1 = answerOwner i.1 then i.2.2.2.place else none

/-- Where a message is anchored, given `floor`, past every place held before it: the
bridge's position, else where the shard sequenced it and never below `floor`. -/
def Identity.anchor (i : Identity) (floor : Nat) : Nat :=
  i.position.getD (max i.2.2.1 floor)

/-- One past the places a message holds: its anchor, and for a bridge question Postgres
placed the place after it too, which Postgres gives its answer. -/
def Identity.reach (i : Identity) (floor : Nat) : Nat :=
  i.anchor floor + (if i.2.1 = questionOwner i.1 ∧ i.2.2.2.place ≠ none then 2 else 1)

def anchorsFrom (floor : Nat) : List Identity → List Nat
  | [] => []
  | i :: rest => i.anchor floor :: anchorsFrom (max floor (i.reach floor)) rest

/-- The floor the message after `ids` is anchored against. -/
def floorAfter (floor : Nat) : List Identity → Nat
  | [] => floor
  | i :: rest => floorAfter (max floor (i.reach floor)) rest

/-- The one permitted movement: a bridge answer posted with no position reads
straight after its bridge question, once that question holds a position. -/
def askedPlace (ids : List Identity) (i : Identity) : Option Nat :=
  if i.2.1 = answerOwner i.1 ∧ i.2.2.2.place = none then
    (i.2.2.2.questionId.bind fun q =>
      (ids.find? fun x => x.1 == q && x.2.1 == questionOwner q).bind fun x => x.2.2.2.place).map (· + 1)
  else none

/-- Where each message reads, in the order the chat holds them. Readers sort by
it, and among equal places by the order the chat holds. -/
def placesOf (ids : List Identity) : List Nat :=
  (ids.zip (anchorsFrom 0 ids)).map fun p => (askedPlace ids p.1).getD p.2

def Chat.anchors (c : Chat) : List Nat := anchorsFrom 0 (c.messages.map Message.identity)

def Chat.places (c : Chat) : List Nat := placesOf (c.messages.map Message.identity)

/-- What a post must agree with on a message that exists. Its run and notes are
compared as a patch that must change nothing. -/
def Message.agrees (m : Message) (author body : String) (origin : MessageOrigin)
    (run : MessageRun) (notes : MessageNotes) : Prop :=
  m.author = author ∧ m.body = body ∧ m.origin = origin
    ∧ m.run.merge run = m.run ∧ m.notes.merge notes = m.notes

instance (m : Message) (author body : String) (origin : MessageOrigin)
    (run : MessageRun) (notes : MessageNotes) : Decidable (m.agrees author body origin run notes) := by
  unfold Message.agrees; infer_instance

def decidePost (c : Chat) (id : Id) (author body : String) (origin : MessageOrigin)
    (run : MessageRun) (notes : MessageNotes) : Decision :=
  match findMessage c.messages id with
  | some m =>
    if m.agrees author body origin run notes then .accepted []
    else .refused "message_conflict"
  | none => .accepted [.messagePosted id author body origin run notes]

def decideMessageStatus (c : Chat) (id : Id) (status : String) : Decision :=
  match findMessage c.messages id with
  | none => .refused "message_missing"
  | some m =>
    if m.status = status then .accepted []
    else if isTerminal m.status then .refused "terminal_status"
    else .accepted [.messageStatusUpdated id status]

def decideMessageMetadata (c : Chat) (id : Id) (run : MessageRun) (notes : MessageNotes) :
    Decision :=
  match findMessage c.messages id with
  | none => .refused "message_missing"
  | some m =>
    if m.run.merge run = m.run ∧ m.notes.merge notes = m.notes then .accepted []
    else if isTerminal m.status = true ∧ m.run.merge run ≠ m.run then .refused "terminal_metadata"
    else if m.notes.stale notes then .accepted []
    else .accepted [.messageMetadataUpdated id run notes]

/-- The whole body `author` has written of message `id` so far. The checks run in
this order: the message exists, it is not a question, `author` wrote it, the body
is not one it already holds or held, it is not terminal, the body extends it. -/
def decideMessageBody (c : Chat) (id : Id) (author body : String) : Decision :=
  match findMessage c.messages id with
  | none => .refused "message_missing"
  | some m =>
    if m.origin.role = some "user" then .refused "body_question"
    else if m.author ≠ author then .refused "body_author"
    else if body.isPrefixOf m.body = true then .accepted []
    else if isTerminal m.status = true then .refused "terminal_body"
    else if m.body.isPrefixOf body = true then .accepted [.messageBodyUpdated id body]
    else .refused "body_conflict"

def evolveChat (c : Chat) (hubSeq : Nat) : Event → Chat
  | .messagePosted id author body origin run notes =>
    { messages := c.messages ++ [{ id, author, body, status := "posted", hubSeq, origin, run, notes }] }
  | .messageStatusUpdated id status =>
    { messages := c.messages.map (fun m => if m.id = id then { m with status := status } else m) }
  | .messageMetadataUpdated id run notes =>
    { messages := c.messages.map (fun m =>
        if m.id = id then { m with run := m.run.merge run, notes := m.notes.merge notes } else m) }
  | .messageBodyUpdated id body =>
    { messages := c.messages.map (fun m => if m.id = id then { m with body := body } else m) }
  | _ => c

/-- Append-only: an event never removes or reorders an existing message. -/
theorem chat_append_only (c : Chat) (hubSeq : Nat) (e : Event) :
    ∃ tail, (evolveChat c hubSeq e).messages.map (fun m => m.id)
      = c.messages.map (fun m => m.id) ++ tail := by
  cases e with
  | messagePosted id author body origin run notes => exact ⟨[id], by simp [evolveChat]⟩
  | messageStatusUpdated id status =>
    refine ⟨[], ?_⟩
    simp only [evolveChat, List.map_map, List.append_nil]
    apply List.map_congr_left
    intro m _
    by_cases h : m.id = id <;> simp [h]
  | messageMetadataUpdated id run notes =>
    refine ⟨[], ?_⟩
    simp only [evolveChat, List.map_map, List.append_nil]
    apply List.map_congr_left
    intro m _
    by_cases h : m.id = id <;> simp [h]
  | messageBodyUpdated id body =>
    refine ⟨[], ?_⟩
    simp only [evolveChat, List.map_map, List.append_nil]
    apply List.map_congr_left
    intro m _
    by_cases h : m.id = id <;> simp [h]
  | _ => exact ⟨[], by simp [evolveChat]⟩

/-- Conflict refusal: the same message id with different content is refused. -/
theorem post_conflict_refused (c : Chat) (id : Id) (author body : String) (origin : MessageOrigin)
    (run : MessageRun) (notes : MessageNotes)
    (m : Message) (hfind : findMessage c.messages id = some m)
    (hdiff : ¬ m.agrees author body origin run notes) :
    decidePost c id author body origin run notes = .refused "message_conflict" := by
  simp [decidePost, hfind, hdiff]

/-- Idempotent post: the same message id with the same content appends nothing. -/
theorem post_same_content_noop (c : Chat) (id : Id) (author body : String) (origin : MessageOrigin)
    (run : MessageRun) (notes : MessageNotes)
    (m : Message) (hfind : findMessage c.messages id = some m)
    (hsame : m.agrees author body origin run notes) :
    decidePost c id author body origin run notes = .accepted [] := by
  simp [decidePost, hfind, hsame]

/-- A post never changes a message that exists: whatever it is answered, it emits no event. -/
theorem post_existing_emits_nothing (c : Chat) (id : Id) (author body : String)
    (origin : MessageOrigin) (run : MessageRun) (notes : MessageNotes)
    (m : Message) (evs : List Event) (hfind : findMessage c.messages id = some m)
    (h : decidePost c id author body origin run notes = .accepted evs) : evs = [] := by
  simp only [decidePost, hfind] at h
  split at h
  · injection h with h; exact h.symm
  · cases h

/-- A post that names another run field or note than the stored one is a conflict,
whatever else it says: it cannot be used to patch the message. -/
theorem post_metadata_conflict_refused (c : Chat) (id : Id) (author body : String)
    (origin : MessageOrigin) (run : MessageRun) (notes : MessageNotes)
    (m : Message) (hfind : findMessage c.messages id = some m)
    (hchange : m.run.merge run ≠ m.run ∨ m.notes.merge notes ≠ m.notes) :
    decidePost c id author body origin run notes = .refused "message_conflict" := by
  apply post_conflict_refused c id author body origin run notes m hfind
  intro ⟨_, _, _, hrun, hnotes⟩
  cases hchange with
  | inl h => exact h hrun
  | inr h => exact h hnotes

/-- Atomic post: the one event of an accepted post appends the message with its
origin, run and notes together, and changes no other message. -/
theorem post_appends_whole_message (c : Chat) (hubSeq : Nat) (id : Id) (author body : String)
    (origin : MessageOrigin) (run : MessageRun) (notes : MessageNotes) :
    (evolveChat c hubSeq (.messagePosted id author body origin run notes)).messages
      = c.messages ++ [⟨id, author, body, "posted", hubSeq, origin, run, notes⟩] := by
  simp [evolveChat]

/-- Backward compatibility: a post with no added fields appends the message the
five-field model appended, with every added field absent. -/
theorem post_without_origin_is_legacy (c : Chat) (hubSeq : Nat) (id : Id) (author body : String) :
    (evolveChat c hubSeq (.messagePosted id author body {} {} {})).messages
      = c.messages ++ [⟨id, author, body, "posted", hubSeq, {}, {}, {}⟩] := by
  simp [evolveChat]

/-- An empty patch changes no run field and no note. -/
theorem merge_empty (r : MessageRun) (n : MessageNotes) : r.merge {} = r ∧ n.merge {} = n := by
  simp [MessageRun.merge, MessageNotes.merge]

/-- Terminal status immutability: once `complete` or `failed`, every other status is refused. -/
theorem terminal_status_refused (c : Chat) (id : Id) (status : String) (m : Message)
    (hfind : findMessage c.messages id = some m) (hterm : isTerminal m.status = true)
    (hdiff : m.status ≠ status) :
    decideMessageStatus c id status = .refused "terminal_status" := by
  simp [decideMessageStatus, hfind, hterm, hdiff]

/-- A metadata update never touches a status, so it cannot move one backward or
out of a terminal value. -/
theorem metadata_preserves_status (c : Chat) (hubSeq : Nat) (id : Id) (run : MessageRun)
    (notes : MessageNotes) :
    (evolveChat c hubSeq (.messageMetadataUpdated id run notes)).messages.map (fun m => m.status)
      = c.messages.map (fun m => m.status) := by
  simp only [evolveChat, List.map_map]
  apply List.map_congr_left
  intro m _
  by_cases h : m.id = id <;> simp [h]

/-- A status update never changes a message's identity. -/
theorem status_preserves_identity (c : Chat) (hubSeq : Nat) (id : Id) (status : String) :
    (evolveChat c hubSeq (.messageStatusUpdated id status)).messages.map Message.identity
      = c.messages.map Message.identity := by
  simp only [evolveChat, List.map_map]
  apply List.map_congr_left
  intro m _
  by_cases h : m.id = id <;> simp [h, Message.identity]

/-- A metadata update never changes a message's identity. -/
theorem metadata_preserves_identity (c : Chat) (hubSeq : Nat) (id : Id) (run : MessageRun)
    (notes : MessageNotes) :
    (evolveChat c hubSeq (.messageMetadataUpdated id run notes)).messages.map Message.identity
      = c.messages.map Message.identity := by
  simp only [evolveChat, List.map_map]
  apply List.map_congr_left
  intro m _
  by_cases h : m.id = id <;> simp [h, Message.identity]

/-- Terminal run immutability, refusal side: a patch that would change a run
field of a terminal message is refused. -/
theorem terminal_run_change_refused (c : Chat) (id : Id) (run : MessageRun) (notes : MessageNotes)
    (m : Message) (hfind : findMessage c.messages id = some m)
    (hterm : isTerminal m.status = true) (hchange : m.run.merge run ≠ m.run) :
    decideMessageMetadata c id run notes = .refused "terminal_metadata" := by
  simp [decideMessageMetadata, hfind, hterm, hchange]

/-- Terminal run immutability, acceptance side: whatever is accepted for a
terminal message leaves its run fields as they were. -/
theorem terminal_accepted_keeps_run (c : Chat) (id : Id) (run : MessageRun) (notes : MessageNotes)
    (m : Message) (evs : List Event) (hfind : findMessage c.messages id = some m)
    (hterm : isTerminal m.status = true)
    (h : decideMessageMetadata c id run notes = .accepted evs) :
    m.run.merge run = m.run := by
  by_cases hrun : m.run.merge run = m.run
  · exact hrun
  · simp [decideMessageMetadata, hfind, hterm, hrun] at h

/-- Idempotent metadata: a patch that changes nothing appends nothing. -/
theorem metadata_same_content_noop (c : Chat) (id : Id) (run : MessageRun) (notes : MessageNotes)
    (m : Message) (hfind : findMessage c.messages id = some m)
    (hsame : m.run.merge run = m.run ∧ m.notes.merge notes = m.notes) :
    decideMessageMetadata c id run notes = .accepted [] := by
  simp [decideMessageMetadata, hfind, hsame]

/-- A body update for a message that does not exist is refused. -/
theorem body_missing_refused (c : Chat) (id : Id) (author body : String)
    (hfind : findMessage c.messages id = none) :
    decideMessageBody c id author body = .refused "message_missing" := by
  simp [decideMessageBody, hfind]

/-- A question is never rewritten: whoever asks, and whatever the body, the update is refused. -/
theorem body_question_refused (c : Chat) (id : Id) (author body : String) (m : Message)
    (hfind : findMessage c.messages id = some m) (hrole : m.origin.role = some "user") :
    decideMessageBody c id author body = .refused "body_question" := by
  simp [decideMessageBody, hfind, hrole]

/-- Only the message's own author extends it. -/
theorem body_author_refused (c : Chat) (id : Id) (author body : String) (m : Message)
    (hfind : findMessage c.messages id = some m) (hrole : m.origin.role ≠ some "user")
    (hauthor : m.author ≠ author) :
    decideMessageBody c id author body = .refused "body_author" := by
  simp [decideMessageBody, hfind, hrole, hauthor]

/-- Idempotent body: a body the message already holds, or held on the way here,
appends nothing. A retry and a late update are both this. -/
theorem body_noop (c : Chat) (id : Id) (author body : String) (m : Message)
    (hfind : findMessage c.messages id = some m) (hrole : m.origin.role ≠ some "user")
    (hauthor : m.author = author) (hheld : body.isPrefixOf m.body = true) :
    decideMessageBody c id author body = .accepted [] := by
  simp [decideMessageBody, hfind, hrole, hauthor, hheld]

/-- Terminal body immutability: once `complete` or `failed`, a body the message
does not already hold is refused. -/
theorem terminal_body_refused (c : Chat) (id : Id) (author body : String) (m : Message)
    (hfind : findMessage c.messages id = some m) (hrole : m.origin.role ≠ some "user")
    (hauthor : m.author = author) (hnew : body.isPrefixOf m.body ≠ true)
    (hterm : isTerminal m.status = true) :
    decideMessageBody c id author body = .refused "terminal_body" := by
  simp [decideMessageBody, hfind, hrole, hauthor, hnew, hterm]

/-- Monotone body, refusal side: a body that does not extend the stored one is refused. -/
theorem body_conflict_refused (c : Chat) (id : Id) (author body : String) (m : Message)
    (hfind : findMessage c.messages id = some m) (hrole : m.origin.role ≠ some "user")
    (hauthor : m.author = author) (hnew : body.isPrefixOf m.body ≠ true)
    (hlive : isTerminal m.status ≠ true) (hdiverge : m.body.isPrefixOf body ≠ true) :
    decideMessageBody c id author body = .refused "body_conflict" := by
  simp [decideMessageBody, hfind, hrole, hauthor, hnew, hlive, hdiverge]

/-- Soundness of an accepted body update that writes: the submitter is the
message's author, the message is not a question and not terminal, the new body
extends the stored one, and the one event carries exactly that body. -/
theorem body_accepted_sound (c : Chat) (id : Id) (author body : String) (m : Message)
    (evs : List Event) (hfind : findMessage c.messages id = some m)
    (h : decideMessageBody c id author body = .accepted evs) (hne : evs ≠ []) :
    m.author = author ∧ m.origin.role ≠ some "user" ∧ isTerminal m.status = false
      ∧ m.body.isPrefixOf body = true ∧ evs = [.messageBodyUpdated id body] := by
  by_cases hq : m.origin.role = some "user"
  · simp [decideMessageBody, hfind, hq] at h
  by_cases ha : m.author = author
  case neg => simp [decideMessageBody, hfind, hq, ha] at h
  by_cases hp : body.isPrefixOf m.body = true
  · simp [decideMessageBody, hfind, hq, ha, hp] at h
    exact absurd h hne
  by_cases ht : isTerminal m.status = true
  · simp [decideMessageBody, hfind, hq, ha, hp, ht] at h
  by_cases hx : m.body.isPrefixOf body = true
  · simp [decideMessageBody, hfind, hq, ha, hp, ht, hx] at h
    exact ⟨ha, hq, by simpa using ht, hx, h.symm⟩
  · simp [decideMessageBody, hfind, hq, ha, hp, ht, hx] at h

/-- Whatever a body update is answered, it emits at most the one event for its own message. -/
theorem body_emits_at_most_own_event (c : Chat) (id : Id) (author body : String)
    (evs : List Event) (h : decideMessageBody c id author body = .accepted evs) :
    evs = [] ∨ evs = [.messageBodyUpdated id body] := by
  cases hfind : findMessage c.messages id with
  | none => simp [decideMessageBody, hfind] at h
  | some m =>
    by_cases hne : evs = []
    · exact Or.inl hne
    · exact Or.inr (body_accepted_sound c id author body m evs hfind h hne).2.2.2.2

/-- A body update never changes a message's identity. -/
theorem body_preserves_identity (c : Chat) (hubSeq : Nat) (id : Id) (body : String) :
    (evolveChat c hubSeq (.messageBodyUpdated id body)).messages.map Message.identity
      = c.messages.map Message.identity := by
  simp only [evolveChat, List.map_map]
  apply List.map_congr_left
  intro m _
  by_cases h : m.id = id <;> simp [h, Message.identity]

/-- A body update never touches a status, so it cannot move one out of a terminal value. -/
theorem body_preserves_status (c : Chat) (hubSeq : Nat) (id : Id) (body : String) :
    (evolveChat c hubSeq (.messageBodyUpdated id body)).messages.map (fun m => m.status)
      = c.messages.map (fun m => m.status) := by
  simp only [evolveChat, List.map_map]
  apply List.map_congr_left
  intro m _
  by_cases h : m.id = id <;> simp [h]

/-- A body update never touches run metadata or notes. -/
theorem body_preserves_metadata (c : Chat) (hubSeq : Nat) (id : Id) (body : String) :
    (evolveChat c hubSeq (.messageBodyUpdated id body)).messages.map (fun m => (m.run, m.notes))
      = c.messages.map (fun m => (m.run, m.notes)) := by
  simp only [evolveChat, List.map_map]
  apply List.map_congr_left
  intro m _
  by_cases h : m.id = id <;> simp [h]

/-- A body update changes no other message: every message it leaves under
another id is one that was there, unchanged. -/
theorem body_changes_only_named (c : Chat) (hubSeq : Nat) (id : Id) (body : String) (m : Message)
    (hm : m ∈ (evolveChat c hubSeq (.messageBodyUpdated id body)).messages) (hother : m.id ≠ id) :
    m ∈ c.messages := by
  simp only [evolveChat, List.mem_map] at hm
  obtain ⟨m0, hm0, hmap⟩ := hm
  split at hmap
  · rename_i h
    subst hmap
    exact absurd h hother
  · subst hmap
    exact hm0

/-- The message a body update names ends with exactly the body the event carries. -/
theorem body_sets_named (c : Chat) (hubSeq : Nat) (id : Id) (body : String) (m : Message)
    (hm : m ∈ (evolveChat c hubSeq (.messageBodyUpdated id body)).messages) (hid : m.id = id) :
    m.body = body := by
  simp only [evolveChat, List.mem_map] at hm
  obtain ⟨m0, _, hmap⟩ := hm
  split at hmap
  · subst hmap
    rfl
  · rename_i h
    subst hmap
    exact absurd hid h

/-- Identity is append-only: whatever the event, every message that was there keeps
its id, author, sequence number and whole origin (role, question, position, time,
source and data), in the order it had. A post adds one identity at the end. -/
theorem chat_identity_append_only (c : Chat) (hubSeq : Nat) (e : Event) :
    ∃ tail, (evolveChat c hubSeq e).messages.map Message.identity
      = c.messages.map Message.identity ++ tail := by
  cases e with
  | messagePosted id author body origin run notes =>
    exact ⟨[(id, author, hubSeq, origin)], by simp [evolveChat, Message.identity]⟩
  | messageStatusUpdated id status =>
    exact ⟨[], by simpa using status_preserves_identity c hubSeq id status⟩
  | messageMetadataUpdated id run notes =>
    exact ⟨[], by simpa using metadata_preserves_identity c hubSeq id run notes⟩
  | messageBodyUpdated id body =>
    exact ⟨[], by simpa using body_preserves_identity c hubSeq id body⟩
  | _ => exact ⟨[], by simp [evolveChat]⟩

/-- Anchors are a prefix's own: appending messages changes none before them. -/
theorem anchorsFrom_append (floor : Nat) (l t : List Identity) :
    anchorsFrom floor (l ++ t) = anchorsFrom floor l ++ anchorsFrom (floorAfter floor l) t := by
  induction l generalizing floor with
  | nil => simp [anchorsFrom, floorAfter]
  | cons i rest ih => simp [anchorsFrom, floorAfter, ih]

theorem anchorsFrom_length (floor : Nat) (l : List Identity) :
    (anchorsFrom floor l).length = l.length := by
  induction l generalizing floor with
  | nil => simp [anchorsFrom]
  | cons i rest ih => simp [anchorsFrom, ih]

/-- Stable anchors: no event changes where a message that was there is anchored. -/
theorem chat_anchor_append_only (c : Chat) (hubSeq : Nat) (e : Event) :
    ∃ tail, (evolveChat c hubSeq e).anchors = c.anchors ++ tail := by
  obtain ⟨tail, h⟩ := chat_identity_append_only c hubSeq e
  exact ⟨anchorsFrom (floorAfter 0 (c.messages.map Message.identity)) tail, by
    simp only [Chat.anchors]
    rw [h, anchorsFrom_append]⟩

/-- Only the bridge places a message: a position anyone else's post carries is ignored,
and the message is anchored where the shard sequenced it, never below the floor. -/
theorem unverified_position_ignored (i : Identity) (floor : Nat)
    (hq : i.2.1 ≠ questionOwner i.1) (ha : i.2.1 ≠ answerOwner i.1) :
    i.anchor floor = max i.2.2.1 floor := by
  simp [Identity.anchor, Identity.position, hq, ha]

/-- No backdating: a message the bridge did not place is anchored at or after `floor`,
which is past every anchor before it. -/
theorem unverified_anchor_not_below_floor (i : Identity) (floor : Nat)
    (hq : i.2.1 ≠ questionOwner i.1) (ha : i.2.1 ≠ answerOwner i.1) :
    floor ≤ i.anchor floor := by
  rw [unverified_position_ignored i floor hq ha]
  exact Nat.le_max_right _ _

/-- A message's reach is past its own anchor, so the floor after it is too. -/
theorem anchor_lt_reach (i : Identity) (floor : Nat) : i.anchor floor < i.reach floor := by
  unfold Identity.reach
  split <;> omega

/-- The answer's place is kept: after a bridge question placed at `p`, the floor is past
`p + 1`, so no message the bridge did not place is anchored where its answer reads. -/
theorem placed_question_reserves_answer (i : Identity) (floor p : Nat)
    (hauthor : i.2.1 = questionOwner i.1) (hpos : i.2.2.2.place = some p) :
    i.reach floor = p + 2 := by
  simp [Identity.reach, Identity.anchor, Identity.position, hauthor, hpos]

/-- The floor only rises, so it is past every anchor before it. -/
theorem floorAfter_ge (floor : Nat) (l : List Identity) : floor ≤ floorAfter floor l := by
  induction l generalizing floor with
  | nil => simp [floorAfter]
  | cons i rest ih => exact Nat.le_trans (Nat.le_max_left _ _) (ih _)

/-- A message that carries the bridge's position, or that is not a bridge answer, never
moves: it reads at its anchor whatever else the chat holds. -/
theorem askedPlace_none_of_position (ids : List Identity) (i : Identity)
    (h : i.2.2.2.place ≠ none) : askedPlace ids i = none := by
  simp [askedPlace, h]

theorem askedPlace_none_of_author (ids : List Identity) (i : Identity)
    (h : i.2.1 ≠ answerOwner i.1) : askedPlace ids i = none := by
  simp [askedPlace, h]

/-- The permitted movement, exactly: a bridge answer posted with no position reads
one past the position of the bridge question it names. -/
theorem askedPlace_after_question (ids : List Identity) (i x : Identity) (q : Id) (p : Nat)
    (ha : i.2.1 = answerOwner i.1) (hp : i.2.2.2.place = none)
    (hq : i.2.2.2.questionId = some q)
    (hf : (ids.find? fun x => x.1 == q && x.2.1 == questionOwner q) = some x)
    (hx : x.2.2.2.place = some p) :
    askedPlace ids i = some (p + 1) := by
  simp [askedPlace, ha, hp, hq, hf, hx]

/-- A post other than a bridge question with a position moves no one. -/
theorem askedPlace_append (ids : List Identity) (n i : Identity)
    (hn : ¬ (n.2.1 = questionOwner n.1 ∧ n.2.2.2.place ≠ none)) :
    askedPlace (ids ++ [n]) i = askedPlace ids i := by
  unfold askedPlace
  split
  · congr 1
    cases hq : i.2.2.2.questionId with
    | none => rfl
    | some q =>
      simp only [Option.bind_some, List.find?_append]
      cases hf : ids.find? (fun x => x.1 == q && x.2.1 == questionOwner q) with
      | some x => simp
      | none =>
        by_cases hp : (n.1 == q && n.2.1 == questionOwner q) = true
        · have hpos : n.2.2.2.place = none := by
            simp only [Bool.and_eq_true, beq_iff_eq] at hp
            cases hpos : n.2.2.2.place with
            | none => rfl
            | some v => exact absurd ⟨by rw [hp.2, hp.1], by simp [hpos]⟩ hn
          simp [List.find?, hp, hpos]
        · simp [List.find?, hp]
  · rfl

theorem placesOf_append (ids : List Identity) (n : Identity)
    (hn : ¬ (n.2.1 = questionOwner n.1 ∧ n.2.2.2.place ≠ none)) :
    ∃ p, placesOf (ids ++ [n]) = placesOf ids ++ [p] := by
  refine ⟨(askedPlace (ids ++ [n]) n).getD (n.anchor (floorAfter 0 ids)), ?_⟩
  unfold placesOf
  rw [anchorsFrom_append, List.zip_append (by simp [anchorsFrom_length]), List.map_append]
  congr 1
  · apply List.map_congr_left
    intro p _
    rw [askedPlace_append ids n p.1 hn]

/-- Stable order: a post that is not a bridge question with a position leaves every
message that was there where it read, and adds its own place at the end. A direct
writer's post is never such a question, so it moves no one. -/
theorem post_keeps_places (c : Chat) (hubSeq : Nat) (id : Id) (author body : String)
    (origin : MessageOrigin) (run : MessageRun) (notes : MessageNotes)
    (h : ¬ (author = questionOwner id ∧ origin.place ≠ none)) :
    ∃ p, (evolveChat c hubSeq (.messagePosted id author body origin run notes)).places
      = c.places ++ [p] := by
  simp only [Chat.places, evolveChat, List.map_append, List.map_cons, List.map_nil,
    Message.identity]
  exact placesOf_append _ (id, author, hubSeq, origin) h

/-- A status update moves no one. -/
theorem status_keeps_places (c : Chat) (hubSeq : Nat) (id : Id) (status : String) :
    (evolveChat c hubSeq (.messageStatusUpdated id status)).places = c.places := by
  simp only [Chat.places, status_preserves_identity]

/-- A metadata update moves no one. -/
theorem metadata_keeps_places (c : Chat) (hubSeq : Nat) (id : Id) (run : MessageRun)
    (notes : MessageNotes) :
    (evolveChat c hubSeq (.messageMetadataUpdated id run notes)).places = c.places := by
  simp only [Chat.places, metadata_preserves_identity]

/-- A body update moves no one. -/
theorem body_keeps_places (c : Chat) (hubSeq : Nat) (id : Id) (body : String) :
    (evolveChat c hubSeq (.messageBodyUpdated id body)).places = c.places := by
  simp only [Chat.places, body_preserves_identity]

/-- The permitted movement with a row in between: an answer an earlier bridge posted with
no position (anchored at 1), a direct writer's post after it (anchored at 2, its own
`position := 0` ignored), then the bridge question at 40. The answer reads at 41, straight
after its question; the direct post stays at 2. -/
example : placesOf [
    ("a", answerOwner "a", 1, { questionId := some "q" }),
    ("d", "person:direct", 2, { position := some 0 }),
    ("q", questionOwner "q", 3, { position := some 40 })] = [41, 2, 40] := by
  decide

/-- A direct writer's post after a placed exchange never reads before it, whatever position
it names: it is anchored past the exchange. -/
example : placesOf [
    ("q", questionOwner "q", 1, { position := some 40 }),
    ("a", answerOwner "a", 2, { position := some 41, questionId := some "q" }),
    ("d", "person:direct", 3, { position := some 0 })] = [40, 41, 42] := by
  decide

/-- A delayed older note is ignored: a patch whose version is no newer than the stored
one emits nothing, whatever notes it carries. -/
theorem stale_note_ignored (c : Chat) (id : Id) (run : MessageRun) (notes : MessageNotes)
    (m : Message) (evs : List Event) (hfind : findMessage c.messages id = some m)
    (hstale : m.notes.stale notes)
    (h : decideMessageMetadata c id run notes = .accepted evs) : evs = [] := by
  simp only [decideMessageMetadata, hfind] at h
  split at h
  · injection h with h; exact h.symm
  · split at h
    · cases h
    · injection h with h; exact h.symm

/-- Monotone notes: a metadata update that writes carries, when it and the message both
name a version, a strictly newer one. -/
theorem note_version_rises (c : Chat) (id : Id) (run : MessageRun) (notes : MessageNotes)
    (m : Message) (evs : List Event) (v w : Nat) (hfind : findMessage c.messages id = some m)
    (hv : m.notes.noteVersion = some v) (hw : notes.noteVersion = some w)
    (h : decideMessageMetadata c id run notes = .accepted evs) (hne : evs ≠ []) : v < w := by
  by_cases hlt : v < w
  · exact hlt
  · exact absurd (stale_note_ignored c id run notes m evs hfind
      ⟨v, w, hv, hw, Nat.le_of_not_lt hlt⟩ h) hne

/-- A patch never lowers or removes a stored version: the merged notes hold the patch's
version when it has one, else the stored one. -/
theorem merge_note_version (old patch : MessageNotes) :
    (old.merge patch).noteVersion = patch.noteVersion.or old.noteVersion := by
  simp [MessageNotes.merge]

/-- Out-of-order arrival: a post under an id the chat does not hold is accepted
with its whole origin, whatever else the chat holds or lacks. An answer whose
question has not arrived is posted exactly as one whose question has. -/
theorem post_absent_accepted (c : Chat) (id : Id) (author body : String) (origin : MessageOrigin)
    (run : MessageRun) (notes : MessageNotes) (hfind : findMessage c.messages id = none) :
    decidePost c id author body origin run notes
      = .accepted [.messagePosted id author body origin run notes] := by
  simp [decidePost, hfind]

/-- A late post keeps every earlier message exactly as it was: the question that
arrives after its answer changes nothing of the answer. -/
theorem post_keeps_earlier (c : Chat) (hubSeq : Nat) (id : Id) (author body : String)
    (origin : MessageOrigin) (run : MessageRun) (notes : MessageNotes) (m : Message)
    (hm : m ∈ c.messages) :
    m ∈ (evolveChat c hubSeq (.messagePosted id author body origin run notes)).messages := by
  simp [evolveChat, hm]

/-- A bridge post is anchored at the position Postgres gave it, whatever sequence
number the shard assigned it and whatever was there. -/
theorem bridge_post_anchor_is_position (i : Identity) (floor p : Nat)
    (hauthor : i.2.1 = questionOwner i.1 ∨ i.2.1 = answerOwner i.1)
    (hpos : i.2.2.2.place = some p) : i.anchor floor = p := by
  simp [Identity.anchor, Identity.position, hauthor, hpos]

/-- An admitted position is the post's own, and at most the ceiling. -/
theorem place_admitted (o : MessageOrigin) (p : Nat) (h : o.place = some p) :
    o.position = some p ∧ p ≤ maxAdmittedPosition := by
  unfold MessageOrigin.place at h
  split at h
  · split at h
    · injection h with h; subst h; exact ⟨by assumption, by assumption⟩
    · cases h
  · cases h

/-- A position at most the ceiling is admitted as it is. -/
theorem place_of_le (o : MessageOrigin) (p : Nat) (hpos : o.position = some p)
    (hle : p ≤ maxAdmittedPosition) : o.place = some p := by
  simp [MessageOrigin.place, hpos, hle]

/-- A position past the ceiling is no position: whoever posted it, the message is
anchored where the shard sequenced it, as if its post had named none. -/
theorem place_none_of_gt (o : MessageOrigin) (p : Nat) (hpos : o.position = some p)
    (hgt : maxAdmittedPosition < p) : o.place = none := by
  simp [MessageOrigin.place, hpos, Nat.not_le.mpr hgt]

/-- The ceiling holds for every message the bridge placed: its anchor is at most
`maxAdmittedPosition`, so the floor after it, one or two past, is exact in a double. -/
theorem bridge_anchor_le_ceiling (i : Identity) (floor p : Nat)
    (hauthor : i.2.1 = questionOwner i.1 ∨ i.2.1 = answerOwner i.1)
    (hpos : i.2.2.2.place = some p) : i.anchor floor ≤ maxAdmittedPosition := by
  rw [bridge_post_anchor_is_position i floor p hauthor hpos]
  exact (place_admitted i.2.2.2 p hpos).2

/-- A bridge question that names a position past the ceiling reserves nothing and is
anchored like anyone's post: at its sequence number, never below the floor. -/
example : placesOf [
    ("q", questionOwner "q", 1, { position := some 9007199254740991 }),
    ("d", "person:direct", 2, {})] = [1, 2] := by
  decide

/-- The ceiling itself is admitted. -/
example : placesOf [
    ("q", questionOwner "q", 1, { position := some 1125899906842624 }),
    ("d", "person:direct", 2, {})] = [1125899906842624, 1125899906842626] := by
  decide

/-- A post's origin is compared whole: the same id posted again with another
source, or other data, is a conflict and writes nothing. -/
theorem post_origin_conflict_refused (c : Chat) (id : Id) (author body : String)
    (origin : MessageOrigin) (run : MessageRun) (notes : MessageNotes)
    (m : Message) (hfind : findMessage c.messages id = some m) (hdiff : m.origin ≠ origin) :
    decidePost c id author body origin run notes = .refused "message_conflict" := by
  apply post_conflict_refused c id author body origin run notes m hfind
  intro ⟨_, _, horigin, _, _⟩
  exact hdiff horigin

/-- A status update never changes a body. -/
theorem status_preserves_body (c : Chat) (hubSeq : Nat) (id : Id) (status : String) :
    (evolveChat c hubSeq (.messageStatusUpdated id status)).messages.map (fun m => m.body)
      = c.messages.map (fun m => m.body) := by
  simp only [evolveChat, List.map_map]
  apply List.map_congr_left
  intro m _
  by_cases h : m.id = id <;> simp [h]

/-- A metadata update never changes a body. -/
theorem metadata_preserves_body (c : Chat) (hubSeq : Nat) (id : Id) (run : MessageRun)
    (notes : MessageNotes) :
    (evolveChat c hubSeq (.messageMetadataUpdated id run notes)).messages.map (fun m => m.body)
      = c.messages.map (fun m => m.body) := by
  simp only [evolveChat, List.map_map]
  apply List.map_congr_left
  intro m _
  by_cases h : m.id = id <;> simp [h]

end SmithersState

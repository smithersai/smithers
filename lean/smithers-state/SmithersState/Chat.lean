import SmithersState.Basic

/-!
# Chat messages: append-only, idempotent by id, conflict-refusing

A message has an identity (`id`, `author`, `body`, `hubSeq`, `origin`) that no
event changes, a `status` that never leaves a terminal value, `run` metadata
that is frozen once the status is terminal, and `notes` that stay writable.

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
    updatedAt := patch.updatedAt.or old.updatedAt }

/-- What no event after the post may change. -/
def Message.identity (m : Message) : Id × String × String × Nat × MessageOrigin :=
  (m.id, m.author, m.body, m.hubSeq, m.origin)

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
    else .accepted [.messageMetadataUpdated id run notes]

def evolveChat (c : Chat) (hubSeq : Nat) : Event → Chat
  | .messagePosted id author body origin run notes =>
    { messages := c.messages ++ [{ id, author, body, status := "posted", hubSeq, origin, run, notes }] }
  | .messageStatusUpdated id status =>
    { messages := c.messages.map (fun m => if m.id = id then { m with status := status } else m) }
  | .messageMetadataUpdated id run notes =>
    { messages := c.messages.map (fun m =>
        if m.id = id then { m with run := m.run.merge run, notes := m.notes.merge notes } else m) }
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

end SmithersState

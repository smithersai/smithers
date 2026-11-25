import SmithersState.Basic

/-!
# Chat messages: append-only, idempotent by id, conflict-refusing
-/

namespace SmithersState

def findMessage (ms : List Message) (id : Id) : Option Message :=
  ms.find? (fun m => m.id == id)

def isTerminal (status : String) : Bool :=
  status == "complete" || status == "failed"

def decidePost (c : Chat) (id : Id) (author body : String) : Decision :=
  match findMessage c.messages id with
  | some m =>
    if m.author = author ∧ m.body = body then .accepted []
    else .refused "message_conflict"
  | none => .accepted [.messagePosted id author body]

def decideMessageStatus (c : Chat) (id : Id) (status : String) : Decision :=
  match findMessage c.messages id with
  | none => .refused "message_missing"
  | some m =>
    if m.status = status then .accepted []
    else if isTerminal m.status then .refused "terminal_status"
    else .accepted [.messageStatusUpdated id status]

def evolveChat (c : Chat) (hubSeq : Nat) : Event → Chat
  | .messagePosted id author body =>
    { messages := c.messages ++ [⟨id, author, body, "posted", hubSeq⟩] }
  | .messageStatusUpdated id status =>
    { messages := c.messages.map (fun m => if m.id = id then { m with status := status } else m) }
  | _ => c

/-- Append-only: an event never removes or reorders an existing message. -/
theorem chat_append_only (c : Chat) (hubSeq : Nat) (e : Event) :
    ∃ tail, (evolveChat c hubSeq e).messages.map (fun m => m.id)
      = c.messages.map (fun m => m.id) ++ tail := by
  cases e with
  | messagePosted id author body => exact ⟨[id], by simp [evolveChat]⟩
  | messageStatusUpdated id status =>
    refine ⟨[], ?_⟩
    simp only [evolveChat, List.map_map, List.append_nil]
    apply List.map_congr_left
    intro m _
    by_cases h : m.id = id <;> simp [h]
  | _ => exact ⟨[], by simp [evolveChat]⟩

/-- Conflict refusal: the same message id with different content is refused. -/
theorem post_conflict_refused (c : Chat) (id : Id) (author body : String) (m : Message)
    (hfind : findMessage c.messages id = some m)
    (hdiff : ¬ (m.author = author ∧ m.body = body)) :
    decidePost c id author body = .refused "message_conflict" := by
  simp [decidePost, hfind, hdiff]

/-- Idempotent post: the same message id with the same content appends nothing. -/
theorem post_same_content_noop (c : Chat) (id : Id) (author body : String) (m : Message)
    (hfind : findMessage c.messages id = some m)
    (hsame : m.author = author ∧ m.body = body) :
    decidePost c id author body = .accepted [] := by
  simp [decidePost, hfind, hsame]

end SmithersState

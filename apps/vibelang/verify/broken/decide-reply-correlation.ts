// Executable mutation: accepted reply carries exactly the requested target. Contracts are unchanged.
// The conversation state machine, shared by every client and by the sequencer (wiki/decisions/0003-one-state-machine.md).
//
//   intent ──decide──▶ event (numbered seq = last + 1) ──apply──▶ conversation      on the sequencer
//                      event ──receive──▶ client (conversation + pending posts)        on every client
//
// The sequencer is the only writer: it turns an intent into the next numbered event or refuses it. Every client applies
// the same numbered events in order, so every copy of a conversation converges on the sequencer's. A client ignores an
// event it already has, and marks a gap when it misses one, so a reconnect replays from its last `seq`.
//
// Plain TypeScript with no Effect code, so the formal checks (wiki/decisions/0005-formal-verification.md) and the
// property tests (test/conversation.test.ts) read these functions directly.

/** Who wrote an entry. */
export type Author = "person" | "agent"

/** What the agent is doing: `working` while a reply streams, `failed` after its last reply failed. */
export type AgentPhase = "idle" | "working" | "failed"

/** One message in a conversation. */
export interface Entry {
  /** The sequencer's id for it. */
  readonly id: string
  /** The `seq` of the event that created it. */
  readonly seq: number
  /** The id the posting client chose, for matching its pending copy; `""` for the agent's replies. */
  readonly clientId: string
  /** The person post this reply answers; empty on person posts. */
  readonly inReplyTo: string
  readonly author: Author
  /** The name shown beside it. */
  readonly name: string
  readonly text: string
  /** `false` while an agent reply still streams. */
  readonly done: boolean
  /** Why an agent reply failed; `""` when it didn't. */
  readonly error: string
}

/** The sequencer's numbered events. `seq` starts at 1 and counts up by one. */
export type Event =
  | {
    readonly type: "Posted"
    readonly seq: number
    readonly id: string
    readonly clientId: string
    readonly name: string
    readonly text: string
  }
  | { readonly type: "ReplyStarted"; readonly seq: number; readonly id: string; readonly inReplyTo: string }
  | { readonly type: "ReplyDelta"; readonly seq: number; readonly id: string; readonly text: string }
  | { readonly type: "ReplyFinished"; readonly seq: number; readonly id: string }
  | { readonly type: "ReplyFailed"; readonly seq: number; readonly id: string; readonly reason: string }

/** A conversation as of event `seq`. `replying` is the id of the reply that streams, `""` when none does. */
export interface Conversation {
  readonly seq: number
  readonly entries: ReadonlyArray<Entry>
  readonly agent: AgentPhase
  readonly replying: string
}

/** A conversation before its first event. */
export const empty: Conversation = { seq: 0, entries: [], agent: "idle", replying: "" }

/** The most characters one message may hold. */
export const MAX_TEXT = 8000

/** The agent's name in a conversation. */
export const AGENT_NAME = "VibeLang agent"

// ── apply: every copy ──────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The conversation after `event`. An event other than the next one (`seq + 1`) changes nothing. The next one always
 * advances `seq`, even when its content doesn't fit the state, so one bad event can't stall every later one; the
 * sequencer never numbers such an event (`decide`).
 */
// Invariant preservation is stated as implication, so sequence checks cover arbitrary records.
// A creation the sequencer would refuse (empty client id, empty or reused entry id) only advances seq.
//@ verify
//@ requires 0 <= conversation.seq && conversation.seq < 9007199254740991
//@ ensures \result.seq == conversation.seq || \result.seq == conversation.seq + 1
//@ ensures event.seq != conversation.seq + 1 ==> \result == conversation
//@ ensures event.seq == conversation.seq + 1 ==> \result.seq == event.seq
//@ ensures (forall(i, 0 < i && i < conversation.entries.length ==> conversation.entries[i - 1].seq < conversation.entries[i].seq)) && (forall(i, 0 <= i && i < conversation.entries.length ==> conversation.entries[i].seq <= conversation.seq)) ==> (forall(i, 0 < i && i < \result.entries.length ==> \result.entries[i - 1].seq < \result.entries[i].seq))
//@ ensures (forall(i, 0 <= i && i < conversation.entries.length ==> conversation.entries[i].seq <= conversation.seq)) ==> (forall(i, 0 <= i && i < \result.entries.length ==> \result.entries[i].seq <= \result.seq))
//@ ensures (forall(i, forall(j, 0 <= i && i < j && j < conversation.entries.length && conversation.entries[i].author == "person" && conversation.entries[j].author == "person" && conversation.entries[i].clientId != "" ==> conversation.entries[i].clientId != conversation.entries[j].clientId))) ==> (forall(i, forall(j, 0 <= i && i < j && j < \result.entries.length && \result.entries[i].author == "person" && \result.entries[j].author == "person" && \result.entries[i].clientId != "" ==> \result.entries[i].clientId != \result.entries[j].clientId)))
//@ ensures ((conversation.agent == "working") == (conversation.replying != "")) ==> ((\result.agent == "working") == (\result.replying != ""))
//@ ensures (forall(i, 0 <= i && i < conversation.entries.length && !conversation.entries[i].done ==> conversation.agent == "working" && conversation.entries[i].id == conversation.replying && conversation.entries[i].author == "agent")) ==> (forall(i, 0 <= i && i < \result.entries.length && !\result.entries[i].done ==> \result.agent == "working" && \result.entries[i].id == \result.replying && \result.entries[i].author == "agent"))
//@ ensures (forall(i, forall(j, 0 <= i && i < j && j < conversation.entries.length ==> conversation.entries[i].done || conversation.entries[j].done))) && (forall(i, 0 <= i && i < conversation.entries.length && !conversation.entries[i].done ==> conversation.agent == "working" && conversation.entries[i].id == conversation.replying && conversation.entries[i].author == "agent")) ==> (forall(i, forall(j, 0 <= i && i < j && j < \result.entries.length ==> \result.entries[i].done || \result.entries[j].done)))
//@ ensures (conversation.agent == "working" ==> exists(i, 0 <= i && i < conversation.entries.length && !conversation.entries[i].done)) ==> (\result.agent == "working" ==> exists(i, 0 <= i && i < \result.entries.length && !\result.entries[i].done))
//@ ensures (forall(i, 0 <= i && i < conversation.entries.length ==> conversation.entries[i].id != "")) ==> (forall(i, 0 <= i && i < \result.entries.length ==> \result.entries[i].id != ""))
//@ ensures (forall(i, forall(j, 0 <= i && i < j && j < conversation.entries.length ==> conversation.entries[i].id != conversation.entries[j].id))) ==> (forall(i, forall(j, 0 <= i && i < j && j < \result.entries.length ==> \result.entries[i].id != \result.entries[j].id)))
//@ ensures event.seq == conversation.seq + 1 && event.type == "ReplyStarted" && conversation.agent != "working" && event.id != "" && forall(i, 0 <= i && i < conversation.entries.length ==> conversation.entries[i].id != event.id) && event.inReplyTo != "" && exists(i, 0 <= i && i < conversation.entries.length && conversation.entries[i].author == "person" && conversation.entries[i].id == event.inReplyTo) && forall(i, 0 <= i && i < conversation.entries.length && conversation.entries[i].author == "agent" ==> conversation.entries[i].inReplyTo != event.inReplyTo) ==> \result.entries.length == conversation.entries.length + 1 && \result.entries[conversation.entries.length].name == AGENT_NAME && \result.entries[conversation.entries.length].inReplyTo == event.inReplyTo
//@ ensures (forall(i, forall(j, 0 <= i && i < j && j < conversation.entries.length && conversation.entries[i].author == "person" && conversation.entries[j].author == "person" ==> conversation.entries[i].clientId != conversation.entries[j].clientId))) ==> (forall(i, forall(j, 0 <= i && i < j && j < \result.entries.length && \result.entries[i].author == "person" && \result.entries[j].author == "person" ==> \result.entries[i].clientId != \result.entries[j].clientId)))
//@ ensures (forall(i, 0 <= i && i < conversation.entries.length && conversation.entries[i].author == "person" ==> conversation.entries[i].clientId != "")) ==> (forall(i, 0 <= i && i < \result.entries.length && \result.entries[i].author == "person" ==> \result.entries[i].clientId != ""))
export function apply(conversation: Conversation, event: Event): Conversation {
  if (event.seq !== conversation.seq + 1) return conversation
  const next = { ...conversation, seq: event.seq }
  switch (event.type) {
    case "Posted": {
      if (event.text === "" || event.clientId === "" || hasClientId(conversation.entries, event.clientId) || hasEntryId(conversation.entries, event.id)) return next
      const entry: Entry = {
        id: event.id,
        seq: event.seq,
        clientId: event.clientId,
        inReplyTo: "",
        author: "person",
        name: event.name,
        text: event.text,
        done: true,
        error: "",
      }
      const entries = [...conversation.entries, entry]
      //@ assert forall(i, 0 <= i && i < conversation.entries.length ==> entries[i] == conversation.entries[i])
      return { ...next, entries }
    }
    case "ReplyStarted": {
      if (conversation.agent === "working" || hasEntryId(conversation.entries, event.id) || !canReplyTo(conversation.entries, event.inReplyTo)) return next
      const entry: Entry = {
        id: event.id,
        seq: event.seq,
        clientId: "",
        inReplyTo: event.inReplyTo,
        author: "agent",
        name: AGENT_NAME,
        text: "",
        done: false,
        error: "",
      }
      const entries = [...conversation.entries, entry]
      //@ assert !entries[conversation.entries.length].done
      return { ...next, entries, agent: "working", replying: event.id }
    }
    case "ReplyDelta": {
      if (!isReplying(conversation, event.id)) return next
      const entries = conversation.entries.map((entry) => entry.id === event.id ? { ...entry, text: entry.text + event.text } : entry)
      //@ assert forall(i, 0 <= i && i < conversation.entries.length ==> entries[i].done == conversation.entries[i].done)
      return { ...next, entries }
    }
    case "ReplyFinished": {
      if (!isReplying(conversation, event.id)) return next
      return {
        ...next,
        entries: conversation.entries.map((entry) => entry.id === event.id ? { ...entry, done: true } : entry),
        agent: "idle",
        replying: "",
      }
    }
    case "ReplyFailed": {
      if (!isReplying(conversation, event.id)) return next
      return {
        ...next,
        entries: conversation.entries.map((entry) =>
          entry.id === event.id ? { ...entry, done: true, error: event.reason === "" ? "failed" : event.reason } : entry
        ),
        agent: "failed",
        replying: "",
      }
    }
  }
}

/** Whether a reply with this id streams now. */
//@ verify
//@ ensures \result == (conversation.agent == "working" && conversation.replying == id && id != "")
export function isReplying(conversation: Conversation, id: string): boolean {
  return conversation.agent === "working" && conversation.replying === id && id !== ""
}

/** Whether a person's entry already carries `clientId`. `""` never matches. */
//@ verify
//@ ensures \result == (clientId != "" && exists(i, 0 <= i && i < entries.length && entries[i].clientId == clientId))
export function hasClientId(entries: ReadonlyArray<Entry>, clientId: string): boolean {
  if (clientId === "") return false
  let i = 0
  while (i < entries.length) {
    //@ invariant 0 <= i && i <= entries.length
    //@ invariant forall(j, 0 <= j && j < i ==> entries[j].clientId != clientId)
    //@ decreases entries.length - i
    if (entries[i]!.clientId === clientId) return true
    i++
  }
  return false
}

/** Whether an entry already has `id`. `""` always counts as taken, so no entry is created without an id. */
//@ verify
//@ ensures \result == (id == "" || exists(i, 0 <= i && i < entries.length && entries[i].id == id))
export function hasEntryId(entries: ReadonlyArray<Entry>, id: string): boolean {
  if (id === "") return true
  let i = 0
  while (i < entries.length) {
    //@ invariant 0 <= i && i <= entries.length
    //@ invariant forall(j, 0 <= j && j < i ==> entries[j].id != id)
    //@ decreases entries.length - i
    if (entries[i]!.id === id) return true
    i++
  }
  return false
}

/** Whether this is a person's post with no reply yet, including finished or failed replies. */
//@ verify
//@ ensures \result == (id != "" && exists(i, 0 <= i && i < entries.length && entries[i].author == "person" && entries[i].id == id) && forall(i, 0 <= i && i < entries.length && entries[i].author == "agent" ==> entries[i].inReplyTo != id))
export function canReplyTo(entries: ReadonlyArray<Entry>, id: string): boolean {
  if (id === "") return false
  let found = false
  let i = 0
  while (i < entries.length) {
    //@ invariant 0 <= i && i <= entries.length
    //@ invariant found == exists(j, 0 <= j && j < i && entries[j].author == "person" && entries[j].id == id)
    //@ invariant forall(j, 0 <= j && j < i && entries[j].author == "agent" ==> entries[j].inReplyTo != id)
    //@ decreases entries.length - i
    if (entries[i]!.author === "agent" && entries[i]!.inReplyTo === id) return false
    if (entries[i]!.author === "person" && entries[i]!.id === id) found = true
    i++
  }
  return found
}

// ── decide: the sequencer ──────────────────────────────────────────────────────────────────────────────────────────

/** What the sequencer is asked to record. A person posts; the agent's flow starts, extends, ends or fails a reply. */
export type Intent =
  | { readonly type: "Post"; readonly id: string; readonly clientId: string; readonly name: string; readonly text: string }
  | { readonly type: "StartReply"; readonly id: string; readonly inReplyTo: string }
  | { readonly type: "AppendReply"; readonly id: string; readonly text: string }
  | { readonly type: "FinishReply"; readonly id: string }
  | { readonly type: "FailReply"; readonly id: string; readonly reason: string }

/** Why the sequencer refused an intent. */
export type Refusal = "empty" | "too-long" | "duplicate" | "busy" | "not-replying"

/** The sequencer's answer: the next event, or why there is none. */
export type Decision =
  | { readonly ok: true; readonly event: Event }
  | { readonly ok: false; readonly refusal: Refusal }

// Typed constructors keep nested union construction explicit for LemmaScript.
//@ verify
//@ ensures \result.ok && \result.event == event
function accepted(event: Event): Decision {
  return { ok: true, event }
}

//@ verify
//@ ensures !\result.ok && \result.refusal == refusal
function refused(refusal: Refusal): Decision {
  return { ok: false, refusal }
}

/**
 * The event that records `intent` as the next one, or a refusal. Every event it returns is one `apply` takes as is:
 * applying it changes the conversation the way its type says.
 */
//@ verify
//@ requires 0 <= conversation.seq && conversation.seq < 9007199254740991
//@ ensures \result.ok ==> \result.event.seq == conversation.seq + 1
//@ ensures \result.ok && \result.event.type == "ReplyStarted" ==> conversation.agent != "working" && \result.event.id != ""
//@ ensures \result.ok && \result.event.type == "Posted" ==> \result.event.clientId != "" && \result.event.text != ""
//@ ensures \result.ok && \result.event.type == "Posted" ==> \result.event.text.length <= MAX_TEXT
//@ ensures \result.ok && (\result.event.type == "Posted" || \result.event.type == "ReplyStarted") ==> \result.event.id != "" && forall(i, 0 <= i && i < conversation.entries.length ==> conversation.entries[i].id != \result.event.id)
//@ ensures \result.ok && \result.event.type == "Posted" ==> forall(i, 0 <= i && i < conversation.entries.length ==> conversation.entries[i].clientId != \result.event.clientId)
//@ ensures \result.ok && \result.event.type == "ReplyStarted" ==> \result.event.inReplyTo != "" && exists(i, 0 <= i && i < conversation.entries.length && conversation.entries[i].author == "person" && conversation.entries[i].id == \result.event.inReplyTo) && forall(i, 0 <= i && i < conversation.entries.length && conversation.entries[i].author == "agent" ==> conversation.entries[i].inReplyTo != \result.event.inReplyTo)
//@ ensures intent.type == "StartReply" && \result.ok ==> \result.event.type == "ReplyStarted" && \result.event.inReplyTo == intent.inReplyTo
export function decide(conversation: Conversation, intent: Intent): Decision {
  const seq = conversation.seq + 1
  switch (intent.type) {
    case "Post": {
      const text = intent.text.trim()
      if (text === "") return refused("empty")
      if (text.length > MAX_TEXT) return refused("too-long")
      if (hasEntryId(conversation.entries, intent.id)) return refused("duplicate")
      if (intent.clientId === "" || hasClientId(conversation.entries, intent.clientId)) {
        return refused("duplicate")
      }
      return accepted({ type: "Posted", seq, id: intent.id, clientId: intent.clientId, name: intent.name, text })
    }
    case "StartReply":
      if (conversation.agent === "working") return refused("busy")
      if (intent.id === "") return refused("not-replying")
      if (hasEntryId(conversation.entries, intent.id)) return refused("duplicate")
      if (!canReplyTo(conversation.entries, intent.inReplyTo)) return refused("not-replying")
      return accepted({ type: "ReplyStarted", seq, id: intent.id, inReplyTo: intent.id })
    case "AppendReply":
      if (!isReplying(conversation, intent.id)) return refused("not-replying")
      return accepted({ type: "ReplyDelta", seq, id: intent.id, text: intent.text })
    case "FinishReply":
      if (!isReplying(conversation, intent.id)) return refused("not-replying")
      return accepted({ type: "ReplyFinished", seq, id: intent.id })
    case "FailReply":
      if (!isReplying(conversation, intent.id)) return refused("not-replying")
      return accepted({ type: "ReplyFailed", seq, id: intent.id, reason: intent.reason })
  }
}

// ── receive: a client ──────────────────────────────────────────────────────────────────────────────────────────────

/** A post this client sent that no event has confirmed yet. `error` says why sending it failed; `""` while it waits. */
export interface Pending {
  readonly clientId: string
  readonly text: string
  readonly error: string
}

/** One client's copy: the conversation, its unconfirmed posts, and whether it missed an event. */
export interface Client {
  readonly conversation: Conversation
  readonly pending: ReadonlyArray<Pending>
  /** `true` after an event arrived ahead of the next one; the client then replays from `conversation.seq`. */
  readonly gap: boolean
}

/** A client that has seen nothing. */
export const newClient: Client = { conversation: empty, pending: [], gap: false }

/** The client after it sends a post, shown as pending until its event arrives. A blank post changes nothing. */
//@ verify
//@ ensures \result.conversation == client.conversation && \result.gap == client.gap
//@ ensures \result.pending.length == client.pending.length || \result.pending.length == client.pending.length + 1
//@ ensures forall(i, 0 <= i && i < client.pending.length ==> \result.pending[i] == client.pending[i])
//@ ensures (forall(i, forall(j, 0 <= i && i < j && j < client.pending.length ==> client.pending[i].clientId != client.pending[j].clientId))) ==> (forall(i, forall(j, 0 <= i && i < j && j < \result.pending.length ==> \result.pending[i].clientId != \result.pending[j].clientId)))
//@ ensures exists(i, 0 <= i && i < client.pending.length && client.pending[i].clientId == clientId) ==> \result == client
export function post(client: Client, clientId: string, text: string): Client {
  const trimmed = text.trim()
  if (trimmed === "" || clientId === "") return client
  let i = 0
  while (i < client.pending.length) {
    //@ invariant 0 <= i && i <= client.pending.length
    //@ invariant forall(j, 0 <= j && j < i ==> client.pending[j].clientId != clientId)
    //@ decreases client.pending.length - i
    if (client.pending[i]!.clientId === clientId) return client
    i++
  }
  if (hasClientId(client.conversation.entries, clientId)) return client
  return { ...client, pending: [...client.pending, { clientId, text: trimmed, error: "" }] }
}

/** The client after sending its post failed; the post stays, marked with why. */
//@ verify
//@ ensures \result.conversation == client.conversation && \result.gap == client.gap
//@ ensures \result.pending.length == client.pending.length
//@ ensures forall(i, 0 <= i && i < client.pending.length ==> \result.pending[i].clientId == client.pending[i].clientId && \result.pending[i].text == client.pending[i].text)
//@ ensures forall(i, 0 <= i && i < client.pending.length && client.pending[i].clientId != clientId ==> \result.pending[i] == client.pending[i])
//@ ensures forall(i, 0 <= i && i < client.pending.length && client.pending[i].clientId == clientId ==> \result.pending[i].error == (reason == "" ? "failed" : reason))
export function failPost(client: Client, clientId: string, reason: string): Client {
  return {
    ...client,
    pending: client.pending.map((waiting) => waiting.clientId === clientId ? { ...waiting, error: reason === "" ? "failed" : reason } : waiting),
  }
}

/** Retry the same pending post identity, preserving the optimistic message until confirmation. */
//@ verify
//@ ensures \result.conversation == client.conversation && \result.gap == client.gap
//@ ensures \result.pending.length == client.pending.length
//@ ensures forall(i, 0 <= i && i < client.pending.length ==> \result.pending[i].clientId == client.pending[i].clientId && \result.pending[i].text == client.pending[i].text)
//@ ensures forall(i, 0 <= i && i < client.pending.length && client.pending[i].clientId != clientId ==> \result.pending[i] == client.pending[i])
//@ ensures forall(i, 0 <= i && i < client.pending.length && client.pending[i].clientId == clientId ==> \result.pending[i].error == "")
export function retryPost(client: Client, clientId: string): Client {
  return { ...client, pending: client.pending.map((waiting) => waiting.clientId === clientId ? { ...waiting, error: "" } : waiting) }
}

/**
 * The client after an event arrives. One it already has changes nothing; one past the next marks a gap and changes
 * nothing else; the next one is applied, and a post it confirms leaves `pending`.
 */
//@ verify
//@ requires 0 <= client.conversation.seq && client.conversation.seq < 9007199254740991
//@ ensures event.seq <= client.conversation.seq ==> \result == client
//@ ensures event.seq > client.conversation.seq + 1 ==> \result.gap
export function receive(client: Client, event: Event): Client {
  const seq = client.conversation.seq
  if (event.seq <= seq) return client
  if (event.seq > seq + 1) return client.gap ? client : { ...client, gap: true }
  const conversation = apply(client.conversation, event)
  const pending = event.type === "Posted"
    ? client.pending.filter((waiting) => waiting.clientId !== event.clientId)
    : client.pending
  return { conversation, pending, gap: false }
}

/** The client after it replays from `conversation.seq`: the gap closes so the replay's events apply. */
//@ verify
//@ ensures !\result.gap
//@ ensures \result.conversation == client.conversation && \result.pending == client.pending
export function resume(client: Client): Client {
  return client.gap ? { ...client, gap: false } : client
}

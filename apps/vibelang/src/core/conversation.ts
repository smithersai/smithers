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
  | { readonly type: "ReplyStarted"; readonly seq: number; readonly id: string }
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
export function apply(conversation: Conversation, event: Event): Conversation {
  if (event.seq !== conversation.seq + 1) return conversation
  const next = { ...conversation, seq: event.seq }
  switch (event.type) {
    case "Posted": {
      if (event.text === "" || hasClientId(conversation.entries, event.clientId)) return next
      const entry: Entry = {
        id: event.id,
        seq: event.seq,
        clientId: event.clientId,
        author: "person",
        name: event.name,
        text: event.text,
        done: true,
        error: "",
      }
      return { ...next, entries: [...conversation.entries, entry] }
    }
    case "ReplyStarted": {
      if (conversation.agent === "working") return next
      const entry: Entry = {
        id: event.id,
        seq: event.seq,
        clientId: "",
        author: "agent",
        name: AGENT_NAME,
        text: "",
        done: false,
        error: "",
      }
      return { ...next, entries: [...conversation.entries, entry], agent: "working", replying: event.id }
    }
    case "ReplyDelta": {
      if (!isReplying(conversation, event.id)) return next
      return { ...next, entries: conversation.entries.map((entry) => entry.id === event.id ? { ...entry, text: entry.text + event.text } : entry) }
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
export function isReplying(conversation: Conversation, id: string): boolean {
  return conversation.agent === "working" && conversation.replying === id && id !== ""
}

/** Whether a person's entry already carries `clientId`. `""` never matches. */
export function hasClientId(entries: ReadonlyArray<Entry>, clientId: string): boolean {
  if (clientId === "") return false
  for (const entry of entries) if (entry.clientId === clientId) return true
  return false
}

// ── decide: the sequencer ──────────────────────────────────────────────────────────────────────────────────────────

/** What the sequencer is asked to record. A person posts; the agent's flow starts, extends, ends or fails a reply. */
export type Intent =
  | { readonly type: "Post"; readonly id: string; readonly clientId: string; readonly name: string; readonly text: string }
  | { readonly type: "StartReply"; readonly id: string }
  | { readonly type: "AppendReply"; readonly id: string; readonly text: string }
  | { readonly type: "FinishReply"; readonly id: string }
  | { readonly type: "FailReply"; readonly id: string; readonly reason: string }

/** Why the sequencer refused an intent. */
export type Refusal = "empty" | "too-long" | "duplicate" | "busy" | "not-replying"

/** The sequencer's answer: the next event, or why there is none. */
export type Decision =
  | { readonly ok: true; readonly event: Event }
  | { readonly ok: false; readonly refusal: Refusal }

/**
 * The event that records `intent` as the next one, or a refusal. Every event it returns is one `apply` takes as is:
 * applying it changes the conversation the way its type says.
 */
export function decide(conversation: Conversation, intent: Intent): Decision {
  const seq = conversation.seq + 1
  switch (intent.type) {
    case "Post": {
      const text = intent.text.trim()
      if (text === "") return { ok: false, refusal: "empty" }
      if (text.length > MAX_TEXT) return { ok: false, refusal: "too-long" }
      if (intent.clientId === "" || hasClientId(conversation.entries, intent.clientId)) {
        return { ok: false, refusal: "duplicate" }
      }
      return {
        ok: true,
        event: { type: "Posted", seq, id: intent.id, clientId: intent.clientId, name: intent.name, text },
      }
    }
    case "StartReply":
      if (conversation.agent === "working") return { ok: false, refusal: "busy" }
      if (intent.id === "") return { ok: false, refusal: "not-replying" }
      return { ok: true, event: { type: "ReplyStarted", seq, id: intent.id } }
    case "AppendReply":
      if (!isReplying(conversation, intent.id)) return { ok: false, refusal: "not-replying" }
      return { ok: true, event: { type: "ReplyDelta", seq, id: intent.id, text: intent.text } }
    case "FinishReply":
      if (!isReplying(conversation, intent.id)) return { ok: false, refusal: "not-replying" }
      return { ok: true, event: { type: "ReplyFinished", seq, id: intent.id } }
    case "FailReply":
      if (!isReplying(conversation, intent.id)) return { ok: false, refusal: "not-replying" }
      return { ok: true, event: { type: "ReplyFailed", seq, id: intent.id, reason: intent.reason } }
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
export function post(client: Client, clientId: string, text: string): Client {
  const trimmed = text.trim()
  if (trimmed === "" || clientId === "") return client
  for (const waiting of client.pending) if (waiting.clientId === clientId) return client
  if (hasClientId(client.conversation.entries, clientId)) return client
  return { ...client, pending: [...client.pending, { clientId, text: trimmed, error: "" }] }
}

/** The client after sending its post failed; the post stays, marked with why. */
export function failPost(client: Client, clientId: string, reason: string): Client {
  return {
    ...client,
    pending: client.pending.map((waiting) => waiting.clientId === clientId ? { ...waiting, error: reason === "" ? "failed" : reason } : waiting),
  }
}

/**
 * The client after an event arrives. One it already has changes nothing; one past the next marks a gap and changes
 * nothing else; the next one is applied, and a post it confirms leaves `pending`.
 */
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
export function resume(client: Client): Client {
  return client.gap ? { ...client, gap: false } : client
}

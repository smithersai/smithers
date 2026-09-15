import { refuseCloudSignIn } from "./CloudSignIn"
/*
 * The cloud agent sessions seam (UI-COVERAGE-GAPS.md "agents · Cloud agent
 * sessions"): a signed-in user runs a Codex/Claude/Smithers agent on a
 * repository, executed by Smithers Cloud inside a sandbox, from the web app —
 * the replacement for running codex/claude in a local terminal. plue's routes
 * (internal/routes/agent_sessions.go, internal/routes/agent_session_stream.go,
 * internal/services/agent.go):
 *
 *   POST   /api/repos/{o}/{r}/agent/sessions                  { title } → 201 AgentSessionResponse
 *   GET    /api/repos/{o}/{r}/agent/sessions                  → 200 [AgentSessionResponse] (paginated)
 *   GET    /api/repos/{o}/{r}/agent/sessions/{id}             → 200 AgentSessionResponse
 *   DELETE /api/repos/{o}/{r}/agent/sessions/{id}             → 204 (an active run is cancelled and
 *                                                                 finalized before the row is tombstoned)
 *   POST   /api/repos/{o}/{r}/agent/sessions/{id}/messages    { role: "user", text, agent_provider,
 *                                                               agent_transport? } → 201 AgentMessageResponse;
 *                                                               a user message dispatches the sandbox run
 *                                                               (409 while one is already active)
 *   GET    /api/repos/{o}/{r}/agent/sessions/{id}/messages    → 200 [AgentMessageResponse] (?limit, ≤200)
 *   GET    /api/repos/{o}/{r}/agent/sessions/{id}/stream      → SSE, `event: agent.session`
 *
 * The stream's data is services.AgentSessionEvent { session_id, action,
 * message?, status? }: action "message" carries the full AgentMessageResponse
 * (the SSE `id:` line is the message id, so replays dedupe), action "status"
 * carries only the new status word (active → completed | failed | cancelled)
 * and no `id:` line. Keep-alive lines are SSE comments.
 *
 * THE TRANSCRIPT READS AS SSE, NOT POLLING — the honest option, verified in
 * both proxies the app rides: the Worker's platform proxy (apps/server/src/
 * proxies.ts handlePlatformProxy) passes the upstream body through untouched
 * and preserves the content type, and its fetch deadline covers the headers
 * only (apps/server/src/Http.ts fetchWithDeadline: "a streaming answer is
 * never cut off mid-body"); the native app's Bun proxy (apps/app/src/bun/
 * server.ts proxyCloud) streams the same way ("Once the upstream has answered
 * it is cleared, so a streaming body is never cut off mid-flight"). What
 * cannot ride the stream is the seam's own fetch: SeamContext.http is the
 * bounded fetch (state/controller/context.ts boundedFetch), which buffers the
 * whole body under a deadline — a stream through it would never deliver an
 * event. The stream therefore rides SeamContext.stream, the unbounded tapped
 * fetch; a context without one reads the transcript RESTfully and the card
 * says no live rows arrive.
 *
 * The session card is the EXISTING `agent` card's cloud variant (no new card
 * kind — packages/rpc/src/Cards.ts): session · repository · provider · state,
 * transcript rows appended as the stream delivers, Stop in the footer. The
 * card payload is the live window onto plue's transcript, never the record;
 * it holds the newest AGENT_TRANSCRIPT_ROW_CAP messages.
 */
import { actorSharedState } from "../ActorBindings"
import type { Card } from "../AppState"
import { resolveTargetRepo } from "../RepoContext"
import { createCloudClient } from "./CloudClient"
import { readResult } from "./SeamContext"
import type { SeamContext } from "./SeamContext"

/** The providers plue's message route accepts today are "smithers" and "codex"; "claude" is the spec's third door — plue refuses it in its own words until it lands. */
export const AGENT_PROVIDERS = ["codex", "claude", "smithers"] as const
export type AgentProvider = (typeof AGENT_PROVIDERS)[number]

export const isAgentProvider = (value: string): value is AgentProvider =>
  (AGENT_PROVIDERS as ReadonlyArray<string>).includes(value)

export const DEGRADED_AGENT_SESSION_REFUSAL =
  "This Smithers Cloud sign-in can't run agent sessions — sign in again to enable them."

/*
 * plue's messages route caps a page at 200 (services/agent.go
 * maxAgentMessagesPageSize); the card holds the newest page's worth. The
 * server stays the transcript's authority — the card is its live window.
 */
export const AGENT_TRANSCRIPT_ROW_CAP = 200

/** plue's session statuses: "active" on create; "completed" | "failed" | "cancelled" terminal. */
export const AGENT_SESSION_TERMINAL: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"])

/** One session row off the wire, parsed (services.AgentSessionResponse). */
export interface AgentSessionRow {
  readonly id: string
  readonly title: string
  readonly status: string
  readonly messageCount: number
  readonly createdAt: string | null
  /** The kind=agent workspace the run executes in (RFD-004); null while the DTO names none. */
  readonly workspaceId: string | null
}

/** One message row off the wire, parsed (services.AgentMessageResponse). */
export interface AgentMessageRow {
  readonly id: number
  readonly sessionId: string
  readonly role: string
  readonly sequence: number
  readonly parts: ReadonlyArray<{ readonly type: string; readonly text: string }>
  readonly createdAt: string | null
}

type AgentCard = Extract<Card, { kind: "agent" }>
type AgentCloudPayload = Extract<AgentCard["payload"], { readonly cloud: true }>
type TranscriptRow = AgentCloudPayload["transcript"][number]

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

const textOrNull = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null)

const intOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) ? value : null

/** One session row; null when the entry carries no usable session id. */
const parseSession = (value: unknown): AgentSessionRow | null => {
  if (!isRecord(value)) return null
  const id = textOrNull(value.id)
  const status = textOrNull(value.status)
  if (id === null || status === null) return null
  return {
    id,
    title: typeof value.title === "string" ? value.title : "",
    status,
    messageCount: intOrNull(value.message_count) ?? 0,
    createdAt: textOrNull(value.created_at),
    workspaceId: textOrNull(value.workspace_id)
  }
}

/*
 * A part's text, mirroring plue's own renderAgentTaskPartContent (services/
 * agent.go): a string is itself, an object's `value`/`output` string is the
 * text, anything else (a tool call's arguments) is its compact JSON. Bounded,
 * so one runaway part cannot bloat the persisted card.
 */
const PART_TEXT_CAP = 8_000
const partText = (content: unknown): string => {
  const text = typeof content === "string"
    ? content
    : isRecord(content) && typeof content.value === "string"
    ? content.value
    : isRecord(content) && typeof content.output === "string"
    ? content.output
    : JSON.stringify(content) ?? ""
  return text.length <= PART_TEXT_CAP ? text : `${text.slice(0, PART_TEXT_CAP)}…`
}

/** One message row; null when it carries no usable id. Parts read in part_index order. */
const parseMessage = (value: unknown): AgentMessageRow | null => {
  if (!isRecord(value)) return null
  const id = intOrNull(value.id)
  if (id === null) return null
  const parts = (Array.isArray(value.parts) ? value.parts : [])
    .flatMap((part) => {
      if (!isRecord(part)) return []
      const type = textOrNull(part.type)
      return type === null ? [] : [{ partIndex: intOrNull(part.part_index) ?? 0, type, text: partText(part.content) }]
    })
    .sort((left, right) => left.partIndex - right.partIndex)
    .map(({ type, text }) => ({ type, text }))
  return {
    id,
    sessionId: textOrNull(value.session_id) ?? "",
    role: textOrNull(value.role) ?? "assistant",
    sequence: intOrNull(value.sequence) ?? id,
    parts,
    createdAt: textOrNull(value.created_at)
  }
}

/** The card row for one message. */
const rowOf = (message: AgentMessageRow): TranscriptRow => ({
  id: message.id,
  role: message.role,
  sequence: message.sequence,
  createdAt: message.createdAt,
  parts: message.parts.map((part) => ({ ...part }))
})

/** Append (or replace, on a stream replay's redelivery) one row, oldest first, capped at the newest page. */
const appendRow = (rows: ReadonlyArray<TranscriptRow>, row: TranscriptRow): ReadonlyArray<TranscriptRow> =>
  [...rows.filter((existing) => existing.id !== row.id), row]
    .sort((left, right) => left.sequence - right.sequence || left.id - right.id)
    .slice(-AGENT_TRANSCRIPT_ROW_CAP)

const cardIdOf = (sessionId: string): string => `agent-session-${sessionId}`

/** One SSE frame off the wire: the `event`/`data`/`id` fields, comments dropped. */
interface SseFrame {
  readonly id: string | null
  readonly event: string
  readonly data: string
}

/** Split the buffered text into the complete frames and the partial tail. A frame ends at a blank line. */
const splitFrames = (buffer: string): { readonly frames: Array<SseFrame>; readonly rest: string } => {
  const blocks = buffer.split(/\r?\n\r?\n/)
  const rest = blocks.pop() ?? ""
  const frames: Array<SseFrame> = []
  for (const block of blocks) {
    let id: string | null = null
    let event = ""
    const data: Array<string> = []
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith(":")) continue
      if (line.startsWith("id:")) id = line.slice(3).trim()
      else if (line.startsWith("event:")) event = line.slice(6).trim()
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""))
    }
    if (data.length > 0) frames.push({ id, event, data: data.join("\n") })
  }
  return { frames, rest }
}

export interface AgentSessionSeam {
  /** `agent.session.new <owner/repo> <provider> <task…>`: create the session, post the task (dispatches the run), render the card, stream it. */
  readonly newSession: (repo: string, provider: AgentProvider, task: string) => Promise<string | void | { readonly value: string }>
  /** `agent.session.list [owner/repo]`: the repository's sessions as a transcript listing, each row naming its doors. */
  readonly listSessions: (repo?: string) => Promise<string | void | { readonly value: string }>
  /** `agent.session.view <id> [owner/repo]`: re-read one session and its transcript into the card; attach the stream while it is active. */
  readonly viewSession: (sessionId: string, repo?: string) => Promise<string | void | { readonly value: string }>
  /** `agent.session.say <id> <text…>`: post the follow-up message (dispatches the session's next run). */
  readonly sayToSession: (sessionId: string, text: string) => Promise<string | void | { readonly value: string }>
  /** `agent.session.stop <id> [owner/repo]`: DELETE the session — an active run is cancelled and finalized. */
  readonly stopSession: (sessionId: string, repo?: string) => Promise<string | void | { readonly value: string }>
  /** Abort every open stream; the controller dies. */
  readonly dispose: () => void
}

export const createAgentSessionSeam = (ctx: SeamContext): AgentSessionSeam => {
  const { url: cloud, get, send: sendJson } = createCloudClient(ctx)
  /* Streams share one holder across the user/agent actor pair, like the workspace seam's watches. */
  const shared = actorSharedState(ctx, "agentSession", () => ({
    streams: new Map<string, AbortController>()
  }))

  const sessionsPath = (repo: string, rest = ""): string => {
    const [owner = "", name = ""] = repo.split("/")
    return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/agent/sessions${rest}`
  }

  const gate = (): string | void => {
    const session = ctx.store.collections.cloudSessions.get("cloud")
    if (session?.state !== "signed-in") return refuseCloudSignIn(ctx)
    if (session.scopes === "degraded") return DEGRADED_AGENT_SESSION_REFUSAL
  }

  /*
   * The repository a session's route rides: the one the invocation named,
   * else the one the session's card carries (a card button's act re-finds it
   * there), else the active target. Never a guess — the resolver's error
   * names the choice.
   */
  const resolveSessionRepo = (
    sessionId: string,
    explicit?: string
  ): { readonly repo: string } | { readonly error: string } => {
    if (explicit !== undefined && explicit !== "") return resolveTargetRepo(ctx.store, explicit)
    const card = ctx.store.collections.cards.get(cardIdOf(sessionId))
    if (card?.kind === "agent" && "cloud" in card.payload) return { repo: card.payload.repo }
    return resolveTargetRepo(ctx.store, undefined)
  }

  /* ---- the card ---- */

  /** The card as one upsert; the live window's facts come from the arguments, never invented. */
  const renderSession = (
    session: { readonly id: string; readonly title: string; readonly status: string; readonly workspaceId: string | null },
    facts: { readonly repo: string; readonly provider: AgentProvider | null },
    overrides: Partial<Pick<AgentCloudPayload, "transcript" | "error" | "task">> & { readonly clearError?: boolean } = {},
    actor: "user" | "smithers" | "system" = ctx.actor()
  ): void => {
    const id = cardIdOf(session.id)
    const existing = ctx.store.collections.cards.get(id)
    const prior = existing?.kind === "agent" && "cloud" in existing.payload ? existing.payload : undefined
    const task = overrides.task !== undefined ? overrides.task : prior?.task
    const payload: AgentCloudPayload = {
      cloud: true,
      displayName: session.title === "" ? "Agent session" : session.title,
      sessionId: session.id,
      repo: facts.repo,
      provider: facts.provider,
      workspaceId: session.workspaceId,
      state: session.status,
      ...(task === undefined ? {} : { task }),
      transcript: overrides.transcript !== undefined ? [...overrides.transcript] : [...(prior?.transcript ?? [])],
      ...(overrides.clearError === true ? {} : overrides.error !== undefined ? { error: overrides.error } : prior?.error !== undefined ? { error: prior.error } : {})
    }
    const card: Card = {
      id,
      kind: "agent",
      title: `${payload.displayName} · ${payload.repo}`,
      status: "active",
      createdAt: existing?.createdAt ?? Date.now(),
      ordinal: existing?.ordinal ?? ctx.nextOrdinal(),
      payload
    }
    ctx.dispatch({ type: "card.upsert", actor, card })
  }

  /** The refusal rides the card too, so it stays visible beside the transcript. */
  const failOnCard = (sessionId: string, error: string): void => {
    const existing = ctx.store.collections.cards.get(cardIdOf(sessionId))
    if (existing?.kind !== "agent" || !("cloud" in existing.payload)) return
    ctx.dispatch({
      type: "card.upsert",
      actor: ctx.actor(),
      card: { ...existing, payload: { ...existing.payload, error } }
    })
  }

  /* ---- the stream ---- */

  /** Apply one parsed `agent.session` event to the card; a terminal status ends the stream. */
  const applyStreamEvent = (sessionId: string, frame: SseFrame, close: () => void): void => {
    if (frame.event !== "agent.session") return
    let parsed: unknown
    try {
      parsed = JSON.parse(frame.data)
    } catch {
      return
    }
    if (!isRecord(parsed) || parsed.session_id !== sessionId) return
    const existing = ctx.store.collections.cards.get(cardIdOf(sessionId))
    if (existing?.kind !== "agent" || !("cloud" in existing.payload)) return
    if (parsed.action === "message") {
      const message = parseMessage(parsed.message)
      if (message === null) return
      const payload = existing.payload
      ctx.dispatch({
        type: "card.upsert",
        actor: "system",
        card: { ...existing, payload: { ...payload, transcript: [...appendRow(payload.transcript, rowOf(message))] } }
      })
      return
    }
    if (parsed.action === "status") {
      const status = textOrNull(parsed.status)
      if (status === null) return
      const payload = existing.payload
      ctx.dispatch({
        type: "card.upsert",
        actor: "system",
        card: { ...existing, payload: { ...payload, state: status } }
      })
      /* The session is over: no message follows a terminal status, so the stream's work is done. */
      if (AGENT_SESSION_TERMINAL.has(status)) close()
    }
  }

  /**
   * Attach the session's SSE stream: transcript rows append as `message`
   * events land, a `status` event advances the state word, and a terminal
   * status closes the stream. The Last-Event-ID replay and the messages read
   * redeliver rows by id, and the card dedupes on it. A stream that cannot
   * open leaves the card at its last read — the card never claimed liveness.
   */
  const attachStream = (repo: string, sessionId: string): void => {
    const streamFetch = ctx.stream
    if (streamFetch === undefined || shared.streams.has(sessionId)) return
    const controller = new AbortController()
    shared.streams.set(sessionId, controller)
    const detach = (): void => {
      if (shared.streams.get(sessionId) === controller) {
        shared.streams.delete(sessionId)
        controller.abort()
      }
    }
    const run = async (): Promise<void> => {
      let response: Response
      try {
        response = await streamFetch(cloud(sessionsPath(repo, `/${encodeURIComponent(sessionId)}/stream`)), {
          headers: { accept: "text/event-stream" },
          signal: controller.signal
        })
      } catch {
        return
      }
      const contentType = response.headers.get("content-type") ?? ""
      if (!response.ok || response.body === null || !contentType.includes("text/event-stream")) {
        await response.body?.cancel().catch(() => {})
        return
      }
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      try {
        for (;;) {
          const chunk = await reader.read()
          if (chunk.done) break
          buffer += decoder.decode(chunk.value, { stream: true })
          const split = splitFrames(buffer)
          buffer = split.rest
          for (const frame of split.frames) applyStreamEvent(sessionId, frame, detach)
        }
      } catch {
        /* An aborted read is the detach or the controller's dispose; either way the stream is over. */
      }
    }
    void run().finally(detach)
  }

  const detachStream = (sessionId: string): void => {
    const controller = shared.streams.get(sessionId)
    if (controller === undefined) return
    shared.streams.delete(sessionId)
    controller.abort()
  }

  /* ---- the acts ---- */

  const newSession: AgentSessionSeam["newSession"] = async (repoArg, provider, task) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const target = resolveTargetRepo(ctx.store, repoArg)
    if ("error" in target) return target.error
    const repo = target.repo
    const title = task.trim()
    const created = await sendJson("POST", sessionsPath(repo), { title })
    if ("error" in created) return featureRefusal(created, repo)
    const session = parseSession(created.body)
    if (session === null) return "Smithers Cloud answered the new agent session with an unreadable payload"
    /* The first message is what dispatches the run (routes/agent_sessions.go PostMessage). */
    const posted = await postMessage(repo, session.id, title, provider)
    if (typeof posted === "string") {
      renderSession(session, { repo, provider }, { error: posted })
      return `The agent session was created on ${repo}, but the first message was refused: ${posted}`
    }
    renderSession(session, { repo, provider }, { transcript: [rowOf(posted)], task: title, clearError: true })
    attachStream(repo, session.id)
    return {
      value: `Agent session ${session.id} started on ${repo} with ${provider} — the card streams its transcript. Follow up with agent.session.say ${session.id} <text>; stop it with agent.session.stop ${session.id}.`
    }
  }

  const postMessage = async (
    repo: string,
    sessionId: string,
    text: string,
    provider: AgentProvider | undefined
  ): Promise<AgentMessageRow | string> => {
    const answer = await sendJson("POST", sessionsPath(repo, `/${encodeURIComponent(sessionId)}/messages`), {
      role: "user",
      text,
      /* plue defaults an absent provider to "smithers" (routes normalizeAgentRuntimeRequest). */
      ...(provider === undefined ? {} : { agent_provider: provider })
    })
    if ("error" in answer) return answer.error
    const message = parseMessage(answer.body)
    return message ?? "Smithers Cloud answered the posted message with an unreadable payload"
  }

  const listSessions: AgentSessionSeam["listSessions"] = async (repoArg) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const target = resolveTargetRepo(ctx.store, repoArg)
    if ("error" in target) return target.error
    const repo = target.repo
    const answer = await get(`${sessionsPath(repo)}?limit=100`, sessionsPath(repo))
    if ("error" in answer) return featureRefusal(answer, repo)
    if (!Array.isArray(answer.body)) return `Smithers Cloud answered agent sessions for ${repo} with an unreadable payload`
    const sessions = answer.body.flatMap((entry) => {
      const parsed = parseSession(entry)
      return parsed === null ? [] : [parsed]
    })
    /*
     * The workspace card cannot hold this list (it is workspace-scoped; the
     * list is the repository's) and no list card's payload is this shape, so
     * the listing answers where the other cardless list acts answer (the
     * egress audit, the workspace inventory): the transcript, each row
     * naming its doors.
     */
    const listing = sessions.length === 0
      ? `No agent sessions on ${repo}. Start one with /agent.session.new ${repo} <provider> <task>.`
      : [
        `Agent sessions on ${repo}:`,
        ...sessions.map((session) =>
          `${session.title === "" ? "(untitled)" : session.title} · ${session.id} · ${session.status} · ${session.messageCount} message${session.messageCount === 1 ? "" : "s"}${session.createdAt === null ? "" : ` · ${session.createdAt}`}`
        ),
        `Open one with /agent.session.view <id> ${repo}; stop one with /agent.session.stop <id> ${repo}.`
      ].join("\n")
    ctx.dispatch({ type: "message.appended", actor: "system", text: listing })
    return readResult(listing)
  }

  const viewSession: AgentSessionSeam["viewSession"] = async (sessionId, repoArg) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const target = resolveSessionRepo(sessionId, repoArg)
    if ("error" in target) return target.error
    const repo = target.repo
    const answer = await get(sessionsPath(repo, `/${encodeURIComponent(sessionId)}`))
    if ("error" in answer) return featureRefusal(answer, repo, sessionId)
    const session = parseSession(answer.body)
    if (session === null) return `Smithers Cloud answered agent session ${sessionId} with an unreadable payload`
    const read = await get(sessionsPath(repo, `/${encodeURIComponent(sessionId)}/messages?limit=${AGENT_TRANSCRIPT_ROW_CAP}`))
    if ("error" in read) return featureRefusal(read, repo, sessionId)
    if (!Array.isArray(read.body)) return `Smithers Cloud answered the messages of agent session ${sessionId} with an unreadable payload`
    const transcript = read.body
      .flatMap((entry) => {
        const parsed = parseMessage(entry)
        return parsed === null ? [] : [rowOf(parsed)]
      })
      .slice(-AGENT_TRANSCRIPT_ROW_CAP)
    /*
     * The provider is per-message on the wire, never on the session DTO: what
     * the card already knows stands, and a session first met here states none
     * — a guessed provider is a lie the header would repeat.
     */
    const prior = ctx.store.collections.cards.get(cardIdOf(sessionId))
    const provider = prior?.kind === "agent" && "cloud" in prior.payload ? prior.payload.provider : null
    renderSession(session, { repo, provider }, { transcript, clearError: true })
    if (!AGENT_SESSION_TERMINAL.has(session.status)) attachStream(repo, session.id)
    return {
      value: `Agent session ${session.id} on ${repo}: ${session.title === "" ? "(untitled)" : session.title} — ${session.status}, ${transcript.length} message${transcript.length === 1 ? "" : "s"} shown. The card ${AGENT_SESSION_TERMINAL.has(session.status) ? "holds the transcript" : "streams the transcript live"}.`
    }
  }

  const sayToSession: AgentSessionSeam["sayToSession"] = async (sessionId, text) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const message = text.trim()
    if (message === "") return "Write a message before sending it."
    /*
     * say's line carries no repository — the text is the rest of the line and
     * must survive intact — so the repo comes off the session's card or the
     * active target. When neither knows it, the honest remedy is the view
     * door, which takes the repo and records it on the card.
     */
    const target = resolveSessionRepo(sessionId, undefined)
    if ("error" in target) {
      return `Smithers doesn't know which repository agent session ${sessionId} is on — view it first with /agent.session.view ${sessionId} <owner/repo>.`
    }
    const repo = target.repo
    /* The follow-up keeps the session's provider; only the card remembers it (the wire carries it per message, never on the DTO). */
    const prior = ctx.store.collections.cards.get(cardIdOf(sessionId))
    const provider = prior?.kind === "agent" && "cloud" in prior.payload ? (prior.payload.provider ?? undefined) : undefined
    const posted = await postMessage(repo, sessionId, message, provider)
    if (typeof posted === "string") {
      failOnCard(sessionId, posted)
      return posted
    }
    const existing = ctx.store.collections.cards.get(cardIdOf(sessionId))
    if (existing?.kind === "agent" && "cloud" in existing.payload) {
      const payload = existing.payload
      ctx.dispatch({
        type: "card.upsert",
        actor: ctx.actor(),
        card: { ...existing, payload: { ...payload, transcript: [...appendRow(payload.transcript, rowOf(posted))] } }
      })
    }
    /* The message dispatches the session's next run: the card streams again from here. */
    attachStream(repo, sessionId)
    return {
      value: `Message posted to agent session ${sessionId}${provider === undefined ? " (plue's default provider)" : ` (${provider})`} — its run dispatches on it; the card streams the answer.`
    }
  }

  const stopSession: AgentSessionSeam["stopSession"] = async (sessionId, repoArg) => {
    const refusal = gate()
    if (refusal !== undefined) return refusal
    const target = resolveSessionRepo(sessionId, repoArg)
    if ("error" in target) return target.error
    const repo = target.repo
    const prior = ctx.store.collections.cards.get(cardIdOf(sessionId))
    const priorState = prior?.kind === "agent" && "cloud" in prior.payload ? prior.payload.state : undefined
    const answer = await sendJson("DELETE", sessionsPath(repo, `/${encodeURIComponent(sessionId)}`))
    if ("error" in answer) {
      failOnCard(sessionId, answer.error)
      return answer.error
    }
    detachStream(sessionId)
    /*
     * The row is tombstoned upstream (services.AgentService.DeleteSession: an
     * active run is cancelled and finalized first). The card stays as the
     * transcript's record: a session that was active wears plue's own
     * terminal word; one already terminal keeps the word it earned — deleting
     * the record changes neither.
     */
    if (prior?.kind === "agent" && "cloud" in prior.payload) {
      const payload = prior.payload
      ctx.dispatch({
        type: "card.upsert",
        actor: ctx.actor(),
        card: {
          ...prior,
          payload: {
            ...payload,
            state: AGENT_SESSION_TERMINAL.has(payload.state) ? payload.state : "cancelled"
          }
        }
      })
    }
    return {
      value: priorState !== undefined && AGENT_SESSION_TERMINAL.has(priorState)
        ? `Agent session ${sessionId} was already ${priorState} — its record is deleted.`
        : `Agent session ${sessionId} stopped.`
    }
  }

  /*
   * The honest refusals the backend's own answers earn. A 403 off this family
   * is plue's agents feature gate (the router's gateAgents answers "feature
   * not available") or its ownership check; a 404 is a session or repository
   * the platform does not have. The sentence names the meaning; the server's
   * own words ride along verbatim.
   */
  const featureRefusal = (failure: { readonly error: string; readonly status: number | null }, repo: string, sessionId?: string): string =>
    failure.status === 403
      ? `Agent sessions are not enabled here — the backend answered 403: ${failure.error}`
      : failure.status === 404 && sessionId !== undefined
      ? `Agent session ${sessionId} on ${repo}: ${failure.error}.`
      : failure.error

  return {
    newSession,
    listSessions,
    viewSession,
    sayToSession,
    stopSession,
    dispose: () => {
      for (const controller of shared.streams.values()) controller.abort()
      shared.streams.clear()
    }
  }
}

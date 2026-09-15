/*
 * The wire shapes of plue's agent session API (smithers internal/services/
 * agent.go and internal/routes/agent_sessions.go + agent_session_stream.go),
 * recorded once here so every consumer (the AgentSessionSeam tests) is tested
 * against the same shapes:
 *
 *   AgentSessionResponse: { id (uuid), repository_id, user_id, title, status,
 *     message_count, created_at, updated_at, metadata, workspace_id? } —
 *     status is "active" on create and "completed" | "failed" | "cancelled"
 *     at the terminal transitions.
 *   AgentMessageResponse: { id, session_id, role, sequence, parts, created_at }
 *     with AgentPartResponse { part_index, type: "text"|"tool_call"|"tool_result",
 *     content } — a text part's content is { "value": string } after the
 *     route's normalization.
 *   The SSE stream (GET …/agent/sessions/{id}/stream) emits `event: agent.session`
 *     frames whose data is AgentSessionEvent { session_id, action, message?,
 *     status? }: action "message" carries the full message and an `id:` line
 *     of the message id; action "status" carries only the new status word and
 *     no `id:` line. Keep-alive comments arrive as `:ka` comment lines.
 */
export const AGENT_SESSION_WIRE = {
  /** One session row; `workspaceId` undefined leaves the omitempty field off the wire. */
  session: (overrides: Record<string, unknown> = {}) => ({
    id: "0c3d0c6e-2f6a-4b6e-9c2a-1c0a2b0e5f6a",
    repository_id: 7,
    user_id: 3,
    title: "Fix the retry loop",
    status: "active",
    message_count: 0,
    created_at: "2026-09-14T09:00:00Z",
    updated_at: "2026-09-14T09:00:00Z",
    metadata: {},
    ...overrides
  }),
  /** One message row; parts default to a single normalized text part. */
  message: (overrides: Record<string, unknown> = {}) => ({
    id: 41,
    session_id: "0c3d0c6e-2f6a-4b6e-9c2a-1c0a2b0e5f6a",
    role: "user",
    sequence: 1,
    parts: [{ part_index: 0, type: "text", content: { value: "Fix the retry loop" } }],
    created_at: "2026-09-14T09:00:01Z",
    ...overrides
  }),
  /** One SSE `agent.session` event's data payload: the message action. */
  messageEvent: (message: unknown, sessionId = "0c3d0c6e-2f6a-4b6e-9c2a-1c0a2b0e5f6a") => ({
    session_id: sessionId,
    action: "message",
    message
  }),
  /** One SSE `agent.session` event's data payload: the status action (no id line on the wire). */
  statusEvent: (status: string, sessionId = "0c3d0c6e-2f6a-4b6e-9c2a-1c0a2b0e5f6a") => ({
    session_id: sessionId,
    action: "status",
    status
  })
}

/** The event serialized as plue's broker writes it: optional id line, event line, one data line. */
export const sseFrame = (data: unknown, options: { readonly id?: number; readonly event?: string } = {}): string =>
  `${options.id === undefined ? "" : `id: ${options.id}\n`}event: ${options.event ?? "agent.session"}\ndata: ${JSON.stringify(data)}\n\n`

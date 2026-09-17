/**
 * The OpenCode protocol v1 shapes this server answers with, transcribed from
 * the 1.18.31 OpenAPI document and the live trace in
 * `docs/jev-harness/trace/summary.md`.
 *
 * Nothing here is imported from `@opencode-ai/*`: the server owns its wire
 * types, and the contract tests hold them against the SDK's generated types.
 * Only the fields the hosted app reads are declared; every one is required
 * unless the OpenAPI marks it optional and the app tolerates its absence.
 *
 * @since 1.0.0
 */

/**
 * Token counts on a session, a message, or a step.
 *
 * @category models
 * @since 1.0.0
 */
export interface Tokens {
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly cache: { readonly read: number; readonly write: number }
}

/**
 * Zero of everything.
 *
 * @category constants
 * @since 1.0.0
 */
export const noTokens: Tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

/**
 * The model a session or message names.
 *
 * @category models
 * @since 1.0.0
 */
export interface ModelRef {
  readonly providerID: string
  readonly modelID: string
}

/**
 * A v1 session, as `GET /session/:id` answers it.
 *
 * @category models
 * @since 1.0.0
 */
export interface Session {
  readonly id: string
  readonly slug: string
  readonly projectID: string
  readonly directory: string
  readonly path: string
  readonly title: string
  readonly version: string
  readonly agent: string
  readonly model: { readonly id: string; readonly providerID: string }
  readonly cost: number
  readonly tokens: Tokens
  readonly time: { readonly created: number; readonly updated: number; readonly archived?: number }
}

/**
 * A session as the v2 home list (`GET /api/session`) answers it.
 *
 * @category models
 * @since 1.0.0
 */
export interface SessionV2 {
  readonly id: string
  readonly projectID: string
  readonly agent: string
  readonly model: { readonly id: string; readonly providerID: string }
  readonly cost: number
  readonly tokens: Tokens
  readonly time: { readonly created: number; readonly updated: number; readonly archived?: number }
  readonly title: string
  readonly location: { readonly directory: string }
}

/**
 * The v2 projection of a v1 session.
 *
 * @category conversions
 * @since 1.0.0
 */
export const toSessionV2 = (session: Session): SessionV2 => ({
  id: session.id,
  projectID: session.projectID,
  agent: session.agent,
  model: session.model,
  cost: session.cost,
  tokens: session.tokens,
  time: session.time,
  title: session.title,
  location: { directory: session.directory }
})

/**
 * A user message header.
 *
 * @category models
 * @since 1.0.0
 */
export interface UserMessage {
  readonly id: string
  readonly sessionID: string
  readonly role: "user"
  readonly time: { readonly created: number }
  readonly agent: string
  readonly model: ModelRef
}

/**
 * An error an assistant message ended with.
 *
 * @category models
 * @since 1.0.0
 */
export interface MessageError {
  readonly name: "UnknownError" | "MessageAbortedError"
  readonly data: { readonly message: string }
}

/**
 * An assistant message header.
 *
 * @category models
 * @since 1.0.0
 */
export interface AssistantMessage {
  readonly id: string
  readonly sessionID: string
  readonly role: "assistant"
  readonly time: { readonly created: number; readonly completed?: number }
  readonly parentID: string
  readonly modelID: string
  readonly providerID: string
  readonly mode: string
  readonly agent: string
  readonly path: { readonly cwd: string; readonly root: string }
  readonly cost: number
  readonly tokens: Tokens
  readonly finish?: string
  readonly error?: MessageError
}

/**
 * Either message header.
 *
 * @category models
 * @since 1.0.0
 */
export type Message = UserMessage | AssistantMessage

/**
 * The fields every part carries.
 *
 * @category models
 * @since 1.0.0
 */
export interface PartBase {
  readonly id: string
  readonly sessionID: string
  readonly messageID: string
}

/**
 * A text part; `time.end` absent means it is still streaming.
 *
 * @category models
 * @since 1.0.0
 */
export interface TextPart extends PartBase {
  readonly type: "text"
  readonly text: string
  readonly time?: { readonly start: number; readonly end?: number }
}

/**
 * A reasoning part, rendered collapsed.
 *
 * @category models
 * @since 1.0.0
 */
export interface ReasoningPart extends PartBase {
  readonly type: "reasoning"
  readonly text: string
  readonly time: { readonly start: number; readonly end?: number }
}

/**
 * The state of a tool part.
 *
 * @category models
 * @since 1.0.0
 */
export type ToolState =
  | { readonly status: "pending"; readonly input: Record<string, unknown>; readonly raw: string }
  | {
    readonly status: "running"
    readonly input: Record<string, unknown>
    readonly title?: string
    readonly metadata?: Record<string, unknown>
    readonly time: { readonly start: number }
  }
  | {
    readonly status: "completed"
    readonly input: Record<string, unknown>
    readonly output: string
    readonly title: string
    readonly metadata: Record<string, unknown>
    readonly time: { readonly start: number; readonly end: number }
  }
  | {
    readonly status: "error"
    readonly input: Record<string, unknown>
    readonly error: string
    readonly metadata?: Record<string, unknown>
    readonly time: { readonly start: number; readonly end: number }
  }

/**
 * A tool part: one card in the timeline.
 *
 * @category models
 * @since 1.0.0
 */
export interface ToolPart extends PartBase {
  readonly type: "tool"
  readonly callID: string
  readonly tool: string
  readonly state: ToolState
}

/**
 * The part that opens a model step.
 *
 * @category models
 * @since 1.0.0
 */
export interface StepStartPart extends PartBase {
  readonly type: "step-start"
}

/**
 * The part that closes a model step with its usage.
 *
 * @category models
 * @since 1.0.0
 */
export interface StepFinishPart extends PartBase {
  readonly type: "step-finish"
  readonly reason: string
  readonly cost: number
  readonly tokens: Tokens
}

/**
 * Every part the server writes.
 *
 * @category models
 * @since 1.0.0
 */
export type Part = TextPart | ReasoningPart | ToolPart | StepStartPart | StepFinishPart

/**
 * A pending permission, as `permission.asked` carries it and
 * `GET /permission` lists it.
 *
 * @category models
 * @since 1.0.0
 */
export interface PermissionRequest {
  readonly id: string
  readonly sessionID: string
  readonly permission: string
  readonly patterns: ReadonlyArray<string>
  readonly metadata: Record<string, unknown>
  readonly always: ReadonlyArray<string>
  readonly tool: { readonly messageID: string; readonly callID: string }
}

/**
 * The answer to a permission.
 *
 * @category models
 * @since 1.0.0
 */
export type PermissionReply = "once" | "always" | "reject"

/**
 * A session's status.
 *
 * @category models
 * @since 1.0.0
 */
export type SessionStatus =
  | { readonly type: "idle" }
  | { readonly type: "busy" }
  | { readonly type: "retry"; readonly attempt: number; readonly message: string; readonly next: number }

/**
 * One event before the hub stamps its id: the type and the properties the
 * app folds.
 *
 * @category models
 * @since 1.0.0
 */
export interface Emitted {
  readonly type: string
  readonly properties: Record<string, unknown>
}

/**
 * A project, as `GET /project` lists it.
 *
 * @category models
 * @since 1.0.0
 */
export interface Project {
  readonly id: string
  readonly worktree: string
  readonly vcs?: "git"
  readonly time: { readonly created: number; readonly updated: number }
  readonly sandboxes: ReadonlyArray<string>
}

/**
 * A directory entry, as `GET /file` lists it.
 *
 * @category models
 * @since 1.0.0
 */
export interface FileNode {
  readonly name: string
  readonly path: string
  readonly absolute: string
  readonly type: "file" | "directory"
  readonly ignored: boolean
}

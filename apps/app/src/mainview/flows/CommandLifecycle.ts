import type { AgentInvocation } from "./AgentInvocation"
import type { CommandIntent } from "../state/CommandIntent"
import type { CommandOutcome } from "./Commands"
import type { CommandGesture } from "./CommandGesture"

export interface CommandRequest {
  readonly name: string
  readonly actor: CommandIntent["actor"]
  readonly source: CommandIntent["source"]
  readonly invocation?: AgentInvocation
  readonly httpCall?: { readonly turnId: string; readonly callId: string; readonly attemptId?: string; readonly legId?: string }
}
export interface CommandReceipt {
  readonly id: string
  readonly actor: CommandIntent["actor"]
  readonly acceptedRevision: number
}
export interface PendingFormInput {
  readonly cardId: string
  readonly field: string
  readonly value: string
}
export interface PendingCommandInput { readonly clear: () => void }

export type CommandAcceptance =
  | { readonly receipt: CommandReceipt; readonly pendingInput?: PendingCommandInput }
  | { readonly refusal: string; readonly persistenceFailed?: true }

/** Durable command records contain metadata only; optional human input is a private pending draft. */
export interface CommandLifecycle {
  readonly reserveGesture?: (request: CommandRequest, args?: string, named?: Record<string, unknown>) => CommandGesture | undefined
  readonly accept: (request: CommandRequest, pendingFormInput?: PendingFormInput) => Promise<CommandAcceptance>
  readonly canExecute?: (receipt: CommandReceipt, request: CommandRequest) => boolean
  readonly settle: (receipt: CommandReceipt, outcome: CommandOutcome, retryableAuthorization?: boolean) => Promise<boolean>
}

import { z } from "zod"
import { DEFAULT_BRANCH_ID, DEFAULT_WORKSPACE_ID, conversationTabIdOf, type Session } from "./AppState"
import type { CommandIntent } from "./CommandIntent"
import type { AppEventCheckpoint, AppEventHead, AppEventRecord } from "./AppEventStream"

export const PendingRecoveryScopeSchema = z.object({ workspaceId: z.string().min(1), branchId: z.string().min(1), conversationTabId: z.string().nullable() }).strict()
export type PendingRecoveryScope = z.infer<typeof PendingRecoveryScopeSchema>
export const PendingRecoveryAuthoritySchema = PendingRecoveryScopeSchema.extend({
  streamId: z.string().min(1), baseSequence: z.number().int().nonnegative(), baseEventHash: z.string().regex(/^[0-9a-f]{64}$/),
  actor: z.enum(["user", "smithers", "system"]), intentId: z.string().min(1)
}).strict()
export type PendingRecoveryAuthority = z.infer<typeof PendingRecoveryAuthoritySchema>
export const pendingRecoveryScope = (session: Session): PendingRecoveryScope => ({
  workspaceId: session.activeWorkspaceId ?? DEFAULT_WORKSPACE_ID, branchId: session.activeBranchId ?? DEFAULT_BRANCH_ID,
  conversationTabId: conversationTabIdOf(session) ?? null
})
export const sameRecoveryScope = (left: PendingRecoveryScope, right: PendingRecoveryScope): boolean =>
  left.workspaceId === right.workspaceId && left.branchId === right.branchId && left.conversationTabId === right.conversationTabId
export interface PendingRecoveryBoundary {
  readonly head: AppEventHead
  readonly checkpoint: AppEventCheckpoint
  readonly events: ReadonlyArray<AppEventRecord>
  readonly commands?: ReadonlyArray<CommandIntent>
}
/** Call only after verifying the complete stream. Pending input is not accepted history. */
export const admitsPendingRecovery = (record: { readonly revision: number; readonly authority?: PendingRecoveryAuthority; readonly preparedCommandId?: string }, boundary: PendingRecoveryBoundary | undefined): boolean => {
  const authority = record.authority
  if (!authority || !boundary || authority.streamId !== boundary.head.streamId || authority.baseSequence > boundary.head.sequence) return false
  if (record.preparedCommandId !== undefined) {
    if (record.preparedCommandId !== authority.intentId || authority.actor !== "user" || boundary.commands === undefined) return false
    const command = boundary.commands.find(row => row.id === record.preparedCommandId)
    if (command && (command.name !== "form.set" || command.actor !== "user" || command.status !== "accepted")) return false
  } else if (record.revision <= boundary.head.revision) return false
  const hash = authority.baseSequence === boundary.checkpoint.sequence ? boundary.checkpoint.eventHash
    : boundary.events.find(event => event.sequence === authority.baseSequence)?.hash
  return hash === authority.baseEventHash
}

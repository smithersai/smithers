import { conversationTabIdOf, type Session } from "./AppState"

/** A queued request keeps the repository and conversation in which it was written. */
export const promptQueueScope = (session: Session): string => JSON.stringify([
  session.activeWorkspaceId ?? null, session.activeBranchId ?? null,
  conversationTabIdOf(session) ?? null, session.activeRepoKey ?? null
])

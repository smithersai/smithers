import { conversationTabIdOf } from "./AppState"
import { repositoryScope } from "./RepositoryContext"
import { isPracticeRepo } from "./practice/PracticeRepository"
import type { SeamContext } from "./seams/SeamContext"

/** Capture the versions before loading; a later update must remain unread. */
export async function readRepositoryDetail(
  ctx: SeamContext, repo: string, kind: "issue" | "pr", number: number,
  read: () => Promise<string | { readonly value: string }>
): Promise<string | { readonly value: string }> {
  const scope = repositoryScope(ctx.store, repo)
  const conversation = conversationTabIdOf(ctx.store.session())
  // Hosted details currently read the Smithers tracker, not the separate GitHub list source.
  const source = isPracticeRepo(repo) ? "practice" : "smithers"
  const receipts = [...ctx.store.collections.repositoryNotifications.values()]
    .filter(row => row.scope === scope && row.repo === repo && row.source === source && row.kind === kind && row.number === number)
    .map(row => ({ id: row.id, version: row.version }))
  const result = await read()
  if (typeof result !== "string" && receipts.length && repositoryScope(ctx.store, repo) === scope &&
    conversationTabIdOf(ctx.store.session()) === conversation) {
    await ctx.dispatch({ type: "notifications.read", actor: ctx.actor(), receipts }).isPersisted.promise
  }
  return result
}

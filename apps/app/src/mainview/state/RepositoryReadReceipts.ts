import { conversationTabIdOf } from "./AppState"
import { repositoryScope } from "./RepositoryContext"
import type { SeamContext } from "./seams/SeamContext"

/** Capture the versions before loading; a later update must remain unread. */
export async function readRepositoryDetail(
  ctx: SeamContext, repo: string, kind: "issue" | "pr", number: number,
  read: () => Promise<string | void | { readonly value: string }>,
  origin: "smithers" | "github" = "smithers"
): Promise<string | void | { readonly value: string }> {
  const scope = repositoryScope(ctx.store, repo)
  const conversation = conversationTabIdOf(ctx.store.session())
  const source = origin
  const receipts = [...ctx.store.collections.repositoryNotifications.values()]
    .filter(row => row.scope === scope && row.repo === repo && row.source === source && row.kind === kind && row.number === number)
    .map(row => ({ id: row.id, version: row.version }))
  const result = await read()
  if (result !== undefined && typeof result !== "string" && receipts.length && repositoryScope(ctx.store, repo) === scope &&
    conversationTabIdOf(ctx.store.session()) === conversation) {
    await ctx.dispatch({ type: "notifications.read", actor: ctx.actor(), receipts }).isPersisted.promise
  }
  return result
}

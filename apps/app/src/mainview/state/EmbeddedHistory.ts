import { conversationTabIdOf, inConversation, type Card } from "./AppState"
import type { SeamContext } from "./seams/SeamContext"

/** Issue list/detail are locations in one embedded browser, not new transcript rows. */
export async function publishIssueView(ctx: SeamContext, card: Extract<Card, { kind: "issue" }>): Promise<void> {
  const conversation = conversationTabIdOf(ctx.store.session())
  const target = [...ctx.store.collections.cards.values()]
    .filter(row => (row.kind === "issue-list" || row.kind === "issue") && row.payload.repo === card.payload.repo && inConversation(row, conversation))
    .sort((a, b) => b.ordinal - a.ordinal)[0]
  if (!target) {
    await ctx.dispatch({ type: "card.upsert", actor: ctx.actor(), card }).isPersisted.promise
    return
  }
  const next = { ...card, id: target.id, ordinal: target.ordinal, createdAt: target.createdAt, tabId: target.tabId }
  if (target.kind === "issue" && target.payload.number === card.payload.number) {
    await ctx.dispatch({ type: "card.upsert", actor: ctx.actor(), card: { ...next, navigation: target.navigation } }).isPersisted.promise
  } else {
    await ctx.dispatch({ type: "card.navigated", actor: ctx.actor(), card: next }).isPersisted.promise
  }
}

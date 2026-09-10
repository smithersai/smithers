/*
 * The transcript's cards, read live from the store.
 *
 * Why this exists rather than a bare `useLiveQuery(collections.cards)`: the
 * hook's row type is INFERRED from the collection, and TanStack DB's
 * inference gives up once the `Card` union passes thirty members — TResult
 * falls back to its `object` constraint, so `data` types as `{}[]` and every
 * `card.id` / `<CardView card={card}>` downstream stops compiling. Measured
 * on this tree: 29 members infer, 30 do not; the five target-graph cards
 * (graph, run-timeline, run-history, affected, ci-matrix) took it over.
 *
 * Naming the type arguments skips that inference entirely. The collection's
 * own row type is the truth — `createCardCollection` keys `Card` records with
 * `CardSchema` — so this states it in ONE place instead of at every reader.
 */
import type { Collection, NonSingleResult } from "@tanstack/db"
import { eq, useLiveQuery } from "@tanstack/react-db"
import type { AppCollections } from "./AppStore"
import type { Card } from "./AppState"

/** The cards collection as a live array of `Card`, in store order. */
export const useCardRows = (cards: AppCollections["cards"]): ReadonlyArray<Card> => {
  const { data } = useLiveQuery<Card, string, Record<string, never>>(
    cards as unknown as Collection<Card, string, Record<string, never>> & NonSingleResult
  )
  return data
}


/** Filter at the collection query so unrelated streamed cards do not repaint every catalog consumer. */
export const useWorkflowCatalogRows = (cards: AppCollections["cards"]): ReadonlyArray<Extract<Card, { kind: "workflow-list" }>> => {
  const { data } = useLiveQuery(q => q.from({ card: cards as unknown as Collection<Card, string, Record<string, never>> })
    .where(({ card }) => eq(card.kind, "workflow-list")), [cards])
  // The collection owns CardSchema; the exact predicate above narrows its union.
  return data as ReadonlyArray<Extract<Card, { kind: "workflow-list" }>>
}

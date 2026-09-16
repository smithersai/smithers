import type { Card } from "./AppState"

/** A saved draft is not an enabled repository responsibility. */
export const repositoryCiConfigured = (cards: Iterable<Card>, repo: string, owner: string | null): boolean =>
  [...cards].some(card => card.kind === "repository-setup" && card.payload.job === "ci" && card.payload.repo === repo
    && card.payload.owner === owner && card.payload.active?.enabled === true)

import type { Card } from "./AppState"

/** A saved draft is not an enabled repository responsibility. */
export const repositoryCiConfigured = (cards: Iterable<Card>, repo: string, owner: string | null): boolean =>
  [...cards].some(card => card.kind === "repository-setup" && card.payload.job === "ci" && card.payload.repo === repo
    && card.payload.owner === owner && card.payload.active?.enabled === true)

/**
 * The Smithers Cloud workspace this repository's reviewed jobs run on, as
 * their own setups recorded it. Two setups naming different workspaces name
 * none: nothing here picks between them.
 */
export const repositoryJobWorkspace = (cards: Iterable<Card>, repo: string, owner: string | null): string | undefined => {
  const recorded = new Set([...cards].flatMap(card => card.kind === "repository-setup" && card.payload.repo === repo
    && card.payload.owner === owner && card.payload.workspaceId !== undefined ? [card.payload.workspaceId] : []))
  return recorded.size === 1 ? [...recorded][0] : undefined
}

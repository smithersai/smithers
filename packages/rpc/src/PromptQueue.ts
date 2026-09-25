/**
 * Pure prompt queue operations used by browser and terminal adapters.
 *
 * @since 1.0.0
 */

/**
 * Immutable follow-ups shared by the browser and terminal composers.
 * @since 1.0.0
 * @category models
 */
export interface Prompt {
  readonly id: string
  readonly text: string
  readonly scope: string
}

/**
 * A repeated admission is the same request; identical text with a new id is intentional.
 * @since 1.0.0
 * @category operations
 */
export const enqueue = <T extends Prompt>(items: ReadonlyArray<T>, prompt: T): ReadonlyArray<T> =>
  prompt.text.trim() === "" || items.some((item) => item.id === prompt.id)
    ? items :
    [...items, { ...prompt, text: prompt.text.trim() }]

/**
 * Remove the admitted request by identity.
 * @since 1.0.0
 * @category operations
 */
export const remove = <T extends Prompt>(items: ReadonlyArray<T>, id: string): ReadonlyArray<T> =>
  items.filter((item) => item.id !== id)

/**
 * Scope is captured at admission. Switching conversations never retargets a prompt.
 * @since 1.0.0
 * @category operations
 */
export const inScope = <T extends Prompt>(items: ReadonlyArray<T>, scope: string): ReadonlyArray<T> =>
  items.filter((item) => item.scope === scope)

/**
 * Read the oldest request belonging to this conversation.
 * @since 1.0.0
 * @category operations
 */
export const next = <T extends Prompt>(items: ReadonlyArray<T>, scope: string): T | undefined =>
  items.find((item) => item.scope === scope)

/**
 * Restoring queued work preserves an unfinished draft after it.
 * @since 1.0.0
 * @category operations
 */
export const restoreDraft = (items: ReadonlyArray<Pick<Prompt, "text">>, draft: string): string =>
  [...items.map((item) => item.text), ...(draft === "" ? [] : [draft])].join("\n\n")

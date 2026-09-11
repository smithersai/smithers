/**
 * Projections of a model-written memory value into indexed text and tags.
 *
 * @since 0.1.0
 */

/**
 * Selects the text indexed for an authoritative memory value.
 *
 * @category projections
 * @since 0.1.0
 */
export const searchableText = (value: unknown): string => {
  if (typeof value === "string") {
    return value
  }
  if (typeof value === "object" && value !== null && "content" in value && typeof value.content === "string") {
    return value.content
  }
  return JSON.stringify(value) ?? ""
}

/**
 * Retains string tags from a model-written memory value.
 *
 * @category projections
 * @since 0.1.0
 */
export const retainedTags = (value: unknown): ReadonlyArray<string> => {
  if (typeof value !== "object" || value === null || !("tags" in value) || !Array.isArray(value.tags)) {
    return []
  }
  return value.tags.filter((tag): tag is string => typeof tag === "string")
}

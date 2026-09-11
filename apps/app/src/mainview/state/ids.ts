/*
 * Ids render short: a jj change id is already a short word, so it renders
 * whole; a commit hash takes the first 8. One rule for both, because the
 * cards print them side by side and a 40-character hash beside an 8-letter
 * change id reads as a different kind of thing (review finding 4 — this was
 * copied into three cards and inlined twice in the composer).
 */
export const shortId = (id: string): string => (id.length > 12 ? id.slice(0, 8) : id)

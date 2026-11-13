// Predicates used by the built-site browser checks.
export const hasHomeCounts = (counts) => counts.length === 3 && counts.every((text) => Number(text) > 0)

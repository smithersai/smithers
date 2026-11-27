// Lightweight constants shared by schemas and static checks without pulling @babel/parser into the main bundle.

/** A flow's one file. */
export const SOURCE_PATH = "flow.ts"

/** Where a revision runs. */
export const PLACEMENTS = ["client", "sandbox"] as const
export type Placement = (typeof PLACEMENTS)[number]

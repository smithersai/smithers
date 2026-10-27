/*
 * The docs' order: each section's label and its pages, by slug. A slug names
 * pages/<slug>.md. List every page once; a bare /docs opens the first page
 * listed. apps/site/scripts/sync-app-docs.mjs reads this file as text.
 */
export interface DocsSection {
  readonly label: string
  readonly pages: ReadonlyArray<string>
}

export const TOC: ReadonlyArray<DocsSection> = [
  { label: "Get started", pages: ["welcome", "quickstart", "settings"] },
  { label: "On your own Mac", pages: ["local-quickstart", "self-host"] },
  { label: "Flows", pages: ["flows", "commands"] },
  { label: "Operators", pages: ["operator"] }
]

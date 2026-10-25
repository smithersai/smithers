import type { Interactions } from "@smthrs/views"
import type { FormProps, FormState, IssuesProps, RepoProps, ViewProps, View } from "./schema"

// A view as the conversation and the full-screen route read it (src/features/views/views.ts `rowsIn`, store.ts
// `shownQuery`): one row whose fields depend on its template. The collection decoded it with its template's schema
// (src/features/views/schema.ts), so these narrow it by template and never check it again.

/** A view row as the conversation and the full-screen route read it. */
export type ViewRow = Pick<View, "id" | "template" | "props" | "title" | "state" | "html" | "interactions" | "revision">

/** A form: its props and state. */
export interface FormShown {
  readonly props: FormProps
  readonly state: FormState
}

/** A generated view: its title, HTML, declared events and revision. */
export interface GeneratedShown {
  readonly title: string
  readonly html: string
  readonly interactions: Interactions.Declared
  readonly revision: number
}

/** The row's page: its URL and what it says about itself; an empty URL for another template. */
export const pageOf = (row: ViewRow): ViewProps =>
  row.template === "webpage" || row.template === "link" || row.template === "docs" ? (row.props as ViewProps) : { url: "" }

/** The row as a form, or `undefined` for another template. */
export const formOf = (row: ViewRow): FormShown | undefined =>
  row.template === "form" ? { props: row.props as FormProps, state: row.state as FormState } : undefined

/** The row as a generated view, or `undefined` for another template. */
export const generatedOf = (row: ViewRow): GeneratedShown | undefined =>
  row.template === "generated" && typeof row.html === "string" && row.html !== ""
    ? {
      title: row.title || "View",
      html: row.html,
      interactions: row.interactions ?? {},
      revision: row.revision,
    }
    : undefined

/** The row as a repository's view: what it opens; `undefined` for another template. */
export const repoOf = (row: ViewRow): RepoProps | undefined => (row.template === "repo" ? (row.props as RepoProps) : undefined)

/** The row as a repository's issues view: whose issues; `undefined` for another template. */
export const issuesOf = (row: ViewRow): IssuesProps | undefined =>
  row.template === "issues" ? (row.props as IssuesProps) : undefined

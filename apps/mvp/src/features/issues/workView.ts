import type { IssuesViewIssue } from "@smthrs/ui"
import type { WorkLinkRow } from "./schema"
import {
  passesWorkFilter,
  WORK_FILTERS,
  WORK_LINK_KINDS,
  WORK_LINK_TITLES,
  WORK_STATUS_LABELS,
  type WorkFilter,
  type WorkLinkKind,
  workStatusOf,
  type WorkStatus,
} from "./work"

// Work links as the issue list and the issue page show them (decision 0147, docs/features/work-links.md): an issue's
// status chip, its pull request and queue entry on its row, and a side-column section per kind, each link one click
// away when its poster gave it an address.

/** One issue's work: its status and its links, newest first. */
export interface IssueWork {
  readonly status: WorkStatus
  readonly links: ReadonlyArray<WorkLinkRow>
}

/** Each issue's work, by number, from a repository's synced links. Issues with none are absent. */
export const workByIssue = (rows: ReadonlyArray<WorkLinkRow>): ReadonlyMap<number, IssueWork> => {
  const grouped = new Map<number, Array<WorkLinkRow>>()
  for (const row of rows) grouped.set(row.number, [...(grouped.get(row.number) ?? []), row])
  return new Map([...grouped].map(([number, links]) => {
    const newest = [...links].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
    return [number, { status: workStatusOf(newest), links: newest }]
  }))
}

/** The list's `?work=` search: only a filter it knows. */
export const workSearch = (search: Record<string, unknown>): { readonly work?: WorkFilter } =>
  (WORK_FILTERS as ReadonlyArray<unknown>).includes(search.work) ? { work: search.work as WorkFilter } : {}

/** `rows` that pass `filter`, by their issues' links; all of them without one. */
export const filterWork = <A extends { readonly number: number }>(
  rows: ReadonlyArray<A>,
  work: ReadonlyMap<number, IssueWork>,
  filter: WorkFilter | undefined,
): ReadonlyArray<A> =>
  filter === undefined
    ? rows
    : rows.filter((row) => passesWorkFilter(filter, (work.get(row.number)?.links ?? []).map((link) => link.kind)))

/** The kinds a row shows inline: the pull request, the queue entry and the merge, when they have an address. */
const ROW_KINDS: ReadonlySet<WorkLinkKind> = new Set(["pr", "queue", "merge"])

/** Each issue row with its work: a status chip, and its pull request, queue entry and merge links. */
export const withWork = (
  issues: ReadonlyArray<IssuesViewIssue>,
  work: ReadonlyMap<number, IssueWork>,
): ReadonlyArray<IssuesViewIssue> =>
  issues.map((issue) => {
    const found = issue.number === null ? undefined : work.get(issue.number)
    if (found === undefined) return issue
    const links = found.links.filter((link) => ROW_KINDS.has(link.kind) && link.url !== null)
      .map((link) => ({ label: `${WORK_LINK_TITLES[link.kind]}: ${link.label}`, href: link.url! }))
    return {
      ...issue,
      ...(found.status === "none" ? {} : { labels: [...(issue.labels ?? []), WORK_STATUS_LABELS[found.status]] }),
      ...(links.length === 0 ? {} : { links: [...(issue.links ?? []), ...links] }),
    }
  })

/** One side-column section of the issue page: its title and its links, each with its state when it says one. */
export interface WorkSection {
  readonly kind: WorkLinkKind
  readonly title: string
  readonly links: ReadonlyArray<{ readonly label: string; readonly href: string | null }>
}

/** A link's address as the page follows it: one on this app's own origin becomes its path, so it opens in place. */
export const inApp = (url: string | null, origin: string): string | null =>
  url !== null && url.startsWith(`${origin}/`) ? url.slice(origin.length) : url

/**
 * The issue page's work sections, in `WORK_LINK_KINDS` order, newest link first in each. A link to this app (`origin`),
 * such as the issue that holds a lane's or a queue entry's record, opens in place.
 */
export const workSections = (work: IssueWork | undefined, origin = ""): ReadonlyArray<WorkSection> =>
  work === undefined
    ? []
    : WORK_LINK_KINDS.flatMap((kind) => {
      const links = work.links.filter((link) => link.kind === kind)
      return links.length === 0 ? [] : [{
        kind,
        title: WORK_LINK_TITLES[kind],
        links: links.map((link) => ({ label: link.state === null ? link.label : `${link.label} · ${link.state}`, href: inApp(link.url, origin) })),
      }]
    })

import { DEFAULT_ISSUE_REPOSITORY } from "./contract"
import type { ReportRequest } from "./schema"

// "Open on GitHub" (docs/features/bugs.md#open-on-github): GitHub's own new-issue form, prefilled with the
// report, on the repository the page showed, else smithersai/smithers. It only opens the form: nothing reaches GitHub
// until the person submits it there, under their own account (rulings GH-2, GH-11). A public issue never carries the
// page's path, which can name a private repository: only what kind of page it was.

/** What kind of page `route` is, without its repository or any id: `repository`, `file`, `issues`, `app`, … */
export const routeKind = (route: string | null): string => {
  if (route === null) return "unknown"
  const segments = route.split("?")[0]!.split("/").filter(Boolean)
  if (segments.length === 0) return "launcher"
  if (segments[0] === "app") return segments.length === 1 ? "app" : `app/${segments[1]!.replace(/[^\w-]/g, "")}`
  const subject = segments[2]
  if (subject === "blob" || subject === "tree") return "file"
  if (subject === "issues") return "issues"
  if (subject === "pull" || subject === "pulls") return "pull-request"
  return segments.length >= 2 ? "repository" : "other"
}

/** The most of the person's words GitHub's form is prefilled with: a URL stays well under GitHub's limit. */
export const MAX_ISSUE_WORDS = 2_000

/** The issue's title: the first line of what happened, at most 80 characters. */
export const titleOf = (what: string): string => {
  const line = what.trim().split(/\r?\n/, 1)[0]!.trim()
  return line.length > 80 ? `${line.slice(0, 79)}…` : line
}

/** GitHub's new-issue form for `report`, on the repository it showed or the default one. */
export const issueUrl = (report: ReportRequest): string => {
  const repository = report.repo ?? DEFAULT_ISSUE_REPOSITORY
  const words = report.what.length > MAX_ISSUE_WORDS ? `${report.what.slice(0, MAX_ISSUE_WORDS)}…` : report.what
  const body = [
    words,
    "",
    `Report: ${report.id}`,
    `Page: ${routeKind(report.route)}`,
    `Build: ${report.build}`,
    ...(report.traces.length === 0 ? [] : [`Traces: ${report.traces.slice(0, 5).join(" ")}`]),
    ...(report.failures.length === 0
      ? []
      : [`Failures: ${report.failures.slice(0, 5).map(({ flow, code }) => `${flow} ${code}`).join(", ")}`]),
    `Browser: ${report.browser}`,
    `Window: ${report.viewport}`,
  ].join("\n")
  const url = new URL(`https://github.com/${repository}/issues/new`)
  url.searchParams.set("title", titleOf(report.what))
  url.searchParams.set("body", body)
  return url.href
}

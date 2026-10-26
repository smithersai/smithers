// The route template a failed request is recorded by (docs/observability.md#failed-requests): an `/api/` path with each
// segment that isn't one of the app's route words replaced, so a record never carries a repository, a branch, an id, a
// secret's or a domain's name. Nothing here imports a library, so the tab and the engine worker share it.

/**
 * The words of the app's `/api/` routes. A segment that is one of them is kept; any other is a placeholder.
 * src/apiRoutes.test.ts fails when a route literal in src/ or worker/ has a word that isn't here.
 */
export const ROUTE_WORDS: ReadonlySet<string> = new Set([
  "about", "ack", "actions", "alert-channels", "alert-deliveries", "answers", "api", "archive", "auth", "blob",
  "branch-publications", "branches", "bug-reports", "bugs", "call", "callback", "calls", "checks", "cloud-runs",
  "comments", "compare", "conversations", "create", "creation", "credential", "delete", "docs", "domains", "file",
  "flow-drafts", "flows", "github", "github-sync", "github-writes", "home", "items", "launch", "logs", "me", "merge",
  "message-pin", "message-pins", "messages", "metrics", "model", "my-conversations", "notifications", "personal-model",
  "preview", "pull-commits", "pulls", "questions", "raw", "refs", "remote-runs", "renderer", "repos", "repositories",
  "reviews", "room", "run", "runs", "sandbox", "sandbox-limits", "save", "secrets", "session", "shapes", "shares",
  "sign-in", "sign-out", "source", "spend-alerts", "stack", "stamp", "state", "steers", "stop", "summaries",
  "telemetry", "terminals", "test", "texts", "timeline", "todo-requests", "todos", "traces", "tree", "triage-settings",
  "v1", "views", "watches", "web", "webhook", "write", "writes",
])

/** Where the app's telemetry export goes: its own requests are never recorded through themselves. */
const TELEMETRY_PREFIX = "/api/telemetry/"

/**
 * `pathname` as a template: a route word kept, the two segments after `repos` that aren't route words `:owner` and
 * `:repo`, and any other segment `:id`. `/api/repos/acme/widgets/stack` is `/api/repos/:owner/:repo/stack`.
 */
export const routeTemplate = (pathname: string): string => {
  const template: Array<string> = []
  // How many of the segments after `repos` still name its owner and repository.
  let naming = 0
  for (const segment of pathname.split("/").slice(1)) {
    if (segment === "" || ROUTE_WORDS.has(segment)) {
      template.push(segment)
      naming = segment === "repos" ? 2 : 0
    } else {
      template.push(naming === 2 ? ":owner" : naming === 1 ? ":repo" : ":id")
      naming = Math.max(0, naming - 1)
    }
  }
  return `/${template.join("/")}`
}

/**
 * The route `FetchFailures` records a request by (`@smthrs/observability`): its template when it goes to the app's own
 * `/api/` on `origin`, other than the telemetry export; `undefined` for anything else.
 */
export const apiRoute = (origin: string) => (url: URL): string | undefined =>
  url.origin !== origin || !url.pathname.startsWith("/api/") || url.pathname.startsWith(TELEMETRY_PREFIX)
    ? undefined
    : routeTemplate(url.pathname)

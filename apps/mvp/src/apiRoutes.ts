// The route template a failed request is recorded by (docs/observability.md#failed-requests): an `/api/` path with each
// segment that isn't one of the app's route words replaced, so a record never carries a repository, a branch, an id, a
// secret's or a domain's name. Nothing here imports a library, so the tab and the engine worker share it.

/**
 * The words of the app's `/api/` routes. A segment that is one of them is kept; any other is a placeholder.
 * src/apiRoutes.test.ts fails when a route literal in src/ or worker/ has a word that isn't here.
 */
export const ROUTE_WORDS: ReadonlySet<string> = new Set([
  "about", "accounts", "ack", "actions", "admin-receipts", "agent-runs", "alert-channels", "alert-deliveries", "answers", "api", "approvals", "archive", "arrive", "attach", "audit", "auth", "authorize", "blob", "broker",
  "branch-publications", "branches", "bug-reports", "bugs", "call", "callback", "calls", "checks", "claim", "claims", "cloud-runs", "codex",
  "comments", "compare", "connections", "consent", "conversations", "create", "creation", "credential", "delete", "docs", "domains", "exchange", "feeds", "file", "fleet",
  "flow-drafts", "flows", "github", "github-sync", "github-writes", "handoff", "home", "hosted-model", "intents", "issue-edges", "item-summaries", "items", "jev", "join", "keys", "launch", "logs", "machines", "mcp", "mcp-tokens", "me", "merge",
  "message-pin", "message-pins", "messages", "metrics", "model", "my-conversations", "nodes", "notifications", "oauth", "personal-model", "plan",
  "preview", "profiles", "pull", "pull-commits", "pulls", "questions", "raw", "redeem", "refs", "register", "remote-runs", "renderer", "repos", "repositories", "resolve",
  "review", "reviews", "revocations", "room", "run", "runners", "runs", "sandbox", "sandbox-limits", "save", "secrets", "session", "sessions", "shapes", "shares",
  "sign-in", "sign-out", "snapshot", "source", "spend-alerts", "stack", "stamp", "start", "state", "steers", "stop", "submit", "summaries",
  "telemetry", "terminals", "test", "texts", "timeline", "todo-leaves", "token", "tokens", "todo-requests", "todos", "traces", "tree", "triage-settings", "user",
  "v1", "views", "waitlist", "watches", "web", "webhook", "work-links", "write", "writes",
])

/** Where the app's telemetry export goes: its own requests are never recorded through themselves. */
const TELEMETRY_PREFIX = "/api/telemetry/"

/**
 * `pathname` as a template: route words kept, repository owner/name replaced even when they are route words,
 * and any other segment `:id`. `/api/repos/acme/widgets/stack` is `/api/repos/:owner/:repo/stack`.
 */
export const routeTemplate = (pathname: string): string => {
  const attachMcpPrefix = "/api/attach/mcp/"
  if (pathname.startsWith(attachMcpPrefix)) {
    const count = pathname.slice(attachMcpPrefix.length).split("/").filter(Boolean).length
    return attachMcpPrefix + [":owner", ":repo", ":branch"].slice(0, count).join("/")
  }
  const template: Array<string> = []
  // How many of the segments after `repos` or `profiles` still name its owner and repository.
  let naming = 0
  let profileOwner = false
  for (const segment of pathname.split("/").slice(1)) {
    if (segment === "") {
      template.push(segment)
    } else if (profileOwner) {
      template.push(":owner")
      profileOwner = false
    } else if (naming > 0) {
      template.push(naming === 2 ? ":owner" : ":repo")
      naming -= 1
    } else if (ROUTE_WORDS.has(segment)) {
      template.push(segment)
      naming = segment === "repos" && pathname.split("/").filter(Boolean).length > 3 ? 2 : 0
      profileOwner = segment === "profiles"
    } else {
      template.push(":id")
    }
  }
  return `/${template.join("/")}`
}

/**
 * The route `FetchFailures` records a request by (`@smthrs/observability`): its template when it goes to the app's own
 * `/api/` on `origin`, other than the telemetry export; `undefined` for anything else.
 * @throws {never}
 */
export const apiRoute = (origin: string) =>
  /** @throws {never} */
  (url: URL): string | undefined =>
    url.origin !== origin || !url.pathname.startsWith("/api/") || url.pathname.startsWith(TELEMETRY_PREFIX)
      ? undefined
      : routeTemplate(url.pathname)

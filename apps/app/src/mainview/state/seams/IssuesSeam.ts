import { invalidatePreparedViews,preparedView,type ViewAction,type ViewResult } from "../PreparedView"
import { readRepositoryDetail } from "../RepositoryReadReceipts"
import { readRepositoryListError,repositoryListRead,type RepositoryForm } from "./RepositoryListSeam"

import type { Card } from "../AppState"
import { repositoryCiConfigured } from "../RepositoryJobs"
import { resolveTargetRepo } from "../RepoContext"
import type { SeamContext } from "./SeamContext"
import { errorMessage,errorText,readErrorMessage,readResult,unreachableSentence } from "./SeamContext"
import { refusalOf } from "@smthrs/rpc/Refusal"

export interface IssuesSeam {
  /** Renders the list card and answers the rows as text (the model reads the value, never the card). */
  readonly listIssues: ViewAction<[filter: "open" | "closed" | "all", repo?: string]>
  readonly viewIssue: ViewAction<[number: number, repo?: string, source?: "smithers-cloud" | "github"]>
  readonly createIssue: (title: string, repo?: string) => Promise<string | void>
  readonly setIssueState: (
    number: number,
    state: "open" | "closed",
    repo?: string
  ) => Promise<string | void>
  readonly commentOnIssue: (number: number, text: string, repo?: string) => Promise<string | void | { readonly value: string }>
}

type IssueListPayload = Extract<Card, { kind: "issue-list" }>["payload"]
type IssueListRow = IssueListPayload["issues"][number]
type IssuePayload = Extract<Card, { kind: "issue" }>["payload"]
type IssueCommentRow = IssuePayload["comments"][number]

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

const asInt = (value: unknown): number | null => typeof value === "number" && Number.isInteger(value) ? value : null

const asIssueState = (value: unknown): "open" | "closed" => value === "closed" ? "closed" : "open"

/** The author login off Plue's `author: { login }` shape, or null. */
const authorLogin = (value: unknown): string | null =>
  isRecord(value) && typeof value.login === "string" && value.login !== "" ? value.login : null

/** Optional forge facts stay absent when the read did not supply them. */
const forgeFacts = (value: Record<string, unknown>, author: unknown): Pick<IssuePayload, "createdAt" | "assignees" | "labelColors" | "authorAvatar"> => ({
  ...(typeof value.created_at === "string" ? { createdAt: value.created_at } : {}),
  ...(Array.isArray(value.assignees) ? { assignees: value.assignees.flatMap(person =>
    isRecord(person) && typeof person.login === "string" && person.login !== ""
      ? [{ login: person.login, ...(typeof person.avatar_url === "string" ? { avatar: person.avatar_url } : {}) }] : []) } : {}),
  ...(Array.isArray(value.labels) ? { labelColors: Object.fromEntries(value.labels.flatMap(label =>
    isRecord(label) && typeof label.name === "string" && typeof label.color === "string"
      ? [[label.name, label.color]] : [])) } : {}),
  ...(isRecord(author) && typeof author.avatar_url === "string" ? { authorAvatar: author.avatar_url } : {})
})

/** One list row; null when the entry carries no usable issue number. */
const parseListRow = (value: unknown): IssueListRow | null => {
  if (!isRecord(value)) return null
  const number = asInt(value.number)
  if (number === null) return null
  const comments = asInt(value.comment_count)
  return {
    number,
    title: typeof value.title === "string" ? value.title : "",
    state: asIssueState(value.state),
    author: authorLogin(value.author),
    ...forgeFacts(value, value.author),
    labels: parseLabels(value.labels),
    comments: comments !== null && comments >= 0 ? comments : 0,
    updatedAt: typeof value.updated_at === "string" ? value.updated_at : null
  }
}

/*
 * One list row off GitHub's issue shape — the source-only fallback read
 * (`/api/user/github-repos/{o}/{r}/issues`; multi src/smithersCloud/
 * githubIssues.ts parseIssue). GitHub's issues endpoint includes pull
 * requests; presence of `pull_request`, not its shape, is the documented
 * discriminator, so those rows drop. Author sits under `user.login` and the
 * comment count under `comments` — different spellings, same card row.
 */
const parseGithubListRow = (value: unknown): IssueListRow | null => {
  if (!isRecord(value) || "pull_request" in value) return null
  const number = asInt(value.number)
  if (number === null) return null
  const comments = asInt(value.comments)
  return {
    number,
    source: "github",
    ...(typeof value.html_url === "string" ? { htmlUrl: value.html_url } : {}),
    title: typeof value.title === "string" ? value.title : "",
    state: asIssueState(value.state),
    author: authorLogin(value.user),
    ...forgeFacts(value, value.user),
    labels: parseLabels(value.labels),
    comments: comments !== null && comments >= 0 ? comments : 0,
    updatedAt: typeof value.updated_at === "string" ? value.updated_at : null
  }
}

/** Label names are the stable keys; forgeFacts supplies their optional colors. */
const parseLabels = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.flatMap((label) => isRecord(label) && typeof label.name === "string" ? [label.name] : [])
    : []

/** One comment off Plue's IssueCommentResponse shape; null when not a record. */
const parseComment = (value: unknown): IssueCommentRow | null => {
  if (!isRecord(value)) return null
  return {
    author: typeof value.commenter === "string" && value.commenter !== "" ? value.commenter : null,
    commentBody: typeof value.body === "string" ? value.body : "",
    createdAt: typeof value.created_at === "string" ? value.created_at : null
  }
}

/** The detail payload; null only when the body is not a record at all. */
const parseDetail = (
  value: unknown,
  repo: string,
  number: number,
  comments: ReadonlyArray<IssueCommentRow>
): IssuePayload | null => {
  if (!isRecord(value)) return null
  return {
    repo,
    number: asInt(value.number) ?? number,
    title: typeof value.title === "string" ? value.title : "",
    state: asIssueState(value.state),
    author: authorLogin(value.author),
    ...forgeFacts(value, value.author),
    issueBody: typeof value.body === "string" ? value.body : "",
    labels: parseLabels(value.labels),
    comments: [...comments],
  }
}

/** One row formatter for imported and GitHub-source issue results. */
const issueRowValue = (issue: IssueListRow, source = issue.source): string =>
  `#${issue.number} ${issue.title} · ${issue.state}${source === "github" ? " · GitHub" : ""}`



export const createIssuesSeam = (ctx: SeamContext, renderRepositoryForm?: RepositoryForm): IssuesSeam => {
  const issuesPath = (repo: string): string => {
    const [owner = "", name = ""] = repo.split("/")
    return `${ctx.baseUrl}/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues`
  }

  /*
   * IMPORT-READINESS (multi src/smithersCloud/importReadiness.ts): the
   * `/api/repos/{o}/{r}/**` namespace only exists for repositories IMPORTED
   * into Smithers Cloud — for a source-only repo every request there answers
   * 404. The same repo's GitHub-source metadata still lists issues through
   * `GET /api/user/github-repos/{o}/{r}/issues` (GET-only through the
   * Worker), so reads degrade to the source list; mutations never fall back.
   */
  const githubSourceIssuesPath = (repo: string, filter: "open" | "closed" | "all"): string => {
    const [owner = "", name = ""] = repo.split("/")
    // GitHub accepts state=all (only Plue's imported namespace rejects it).
    return `${ctx.baseUrl}/api/user/github-repos/${encodeURIComponent(owner)}/${
      encodeURIComponent(name)
    }/issues?state=${filter}`
  }

  const notImported = (repo: string): string => `${repo} isn't imported yet — run /repos.import ${repo} first`

  /*
   * The 404 split on a mutation, from the typed refusal — never from the
   * platform's prose. plue codes a number it does not have ("issue not found")
   * and a namespace it does not have ("repository not found") alike as
   * `not_found` (PlueFailureCodes.ts, fault "user"), so the response cannot
   * name the cause: reading it as the namespace told `/issue.close 999` in a
   * repository the user had just listed to import it. This is the not-found it
   * is, at the address this app asked for, which the generic code's own
   * message does not name.
   */
  const explain404 = async (response: Response, fallback: string, whenNotFound?: string): Promise<string> => {
    const body: unknown = await response.json().catch(() => null)
    const refusal = refusalOf({ body, status: response.status, message: errorMessage(body, fallback) })
    return refusal.code === "not_found" ? whenNotFound ?? fallback : refusal.message
  }

  /*
   * The one cause local state still names, and only on the namespace-scoped
   * create: a checkout the sidebar pins that this launch has not opened. Open
   * is `collections.repos`, the state FilesSeam's `knownRepo` reads; opening a
   * checkout pins it (AppProjection, `repos.loaded`), so a pin on its own says
   * nothing. A pin says the checkout is here, never that an issue number
   * exists, so the number-scoped routes never read an import out of it, and it
   * answers only the typed `not_found` — any other code still has its own say.
   */
  const notImportedPin = (repo: string): string | undefined =>
    ![...ctx.store.collections.repos.values()].some((open) => open.name === repo)
      && [...ctx.store.collections.pinnedRepos.values()].some((pin) => pin.name === repo)
      ? notImported(repo)
      : undefined

  const unreachable = (what: string, error: unknown): string => unreachableSentence(`the backend to ${what}`, error)

  /**
   * GitHub's issues for `repo`, through the GitHub-source route, with the
   * read's provenance from plue's X-Metadata-* headers. A refusal answers
   * no rows and the reason; the caller states it beside Smithers Cloud's own list.
   */
  const readGithubIssues = async (
    repo: string,
    filter: "open" | "closed" | "all"
  ): Promise<{
    readonly issues: Array<IssueListRow & { readonly source: "github"; readonly htmlUrl?: string }>
    readonly meta?: { source: string; syncedAt: string | null; stale: boolean; syncError: string | null; refusal: string | null }
  }> => {
    let response: Response
    try {
      response = await ctx.http(githubSourceIssuesPath(repo, filter))
    } catch (error) {
      return { issues: [], meta: { source: "unreachable", syncedAt: null, stale: false, syncError: null, refusal: errorText(error) } }
    }
    const meta = {
      source: response.headers.get("x-metadata-source") ?? (response.ok ? "github" : "refused"),
      syncedAt: response.headers.get("x-metadata-synced-at"),
      stale: response.headers.get("x-metadata-stale") === "true",
      syncError: response.headers.get("x-metadata-sync-error"),
      refusal: null as string | null
    }
    if (!response.ok) {
      return { issues: [], meta: { ...meta, refusal: await readRepositoryListError(response, `GitHub issues answered ${response.status}`) } }
    }
    const body: unknown = await response.json().catch(() => null)
    if (!Array.isArray(body)) return { issues: [], meta: { ...meta, refusal: "GitHub issues answered an unreadable payload" } }
    const issues = body.flatMap((entry) => {
      const parsed = parseGithubListRow(entry)
      if (parsed === null) return []
      const htmlUrl = typeof (entry as { html_url?: unknown }).html_url === "string" ? (entry as { html_url: string }).html_url : undefined
      return [{ ...parsed, source: "github" as const, ...(htmlUrl === undefined ? {} : { htmlUrl }) }]
    })
    return { issues, meta }
  }

  /** The source-only list read; the card carries the degradation note in `body`. */
  const listFromGithubSource = async (
    repo: string,
    filter: "open" | "closed" | "all"
  ): Promise<ViewResult> => {
    let response: Response
    try {
      response = await ctx.http(githubSourceIssuesPath(repo, filter))
    } catch (error) {
      return unreachable(`list issues for ${repo} from its GitHub source`, error)
    }
    // A source 404 too: the repo is nowhere — the plain honest error, no card.
    if (!response.ok) {
      return readRepositoryListError(response, `Listing issues for ${repo} failed (${response.status})`)
    }
    const body: unknown = await response.json().catch(() => null)
    if (!Array.isArray(body)) {
      return `The backend answered issues for ${repo} with an unreadable payload`
    }
    const issues = body.flatMap((entry) => {
      const parsed = parseGithubListRow(entry)
      return parsed === null ? [] : [parsed]
    })
    const card: Card = {
      id: `issues-${repo}`,
      kind: "issue-list",
      title: `Issues · ${repo}`,
      body: `Read from GitHub — import for full features: /repos.import ${repo}`,
      status: "active",
      createdAt: Date.now(),
      ordinal: ctx.nextOrdinal(),
      payload: { repo, filter, issues, github: {
        source: response.headers.get("x-metadata-source") ?? "github",
        syncedAt: response.headers.get("x-metadata-synced-at"),
        stale: response.headers.get("x-metadata-stale") === "true",
        syncError: response.headers.get("x-metadata-sync-error"),
        refusal: null
      } }
    }
    return { card, ...readResult(issues.length === 0
      ? `No ${filter === "all" ? "" : `${filter} `}issues in ${repo} (read from GitHub).`
      : issues.map((issue) => issueRowValue(issue, "github")).join("\n")) }
  }

  /** GitHub has a separate tracker. Its supported metadata routes expose full issue bodies in the list. */
  const readGithubIssue = async (repo: string, number: number): Promise<ViewResult> => {
    const listPath = githubSourceIssuesPath(repo, "all")
    let issue: Record<string, unknown> | undefined
    for (let page = 1; page <= 50; page += 1) {
      let response: Response
      try { response = await ctx.http(`${listPath}&per_page=100&page=${page}`) }
      catch (error) { return unreachable(`load GitHub issue #${number} in ${repo}`, error) }
      if (!response.ok) return readErrorMessage(response, `Loading GitHub issue #${number} failed (${response.status})`)
      const rows: unknown = await response.json().catch(() => null)
      if (!Array.isArray(rows)) return `GitHub answered issues for ${repo} with an unreadable payload`
      issue = rows.find((row): row is Record<string, unknown> => isRecord(row) && row.number === number && !("pull_request" in row))
      if (issue) break
      // Rebuild our own scoped route; never follow a server-provided host or path.
      if (!/rel="?next"?/.test(response.headers.get("link") ?? "")) break
    }
    if (!issue) return `GitHub issue #${number} in ${repo} was not found. Refresh the issue list and try again.`
    const comments: IssueCommentRow[] = []
    const commentsPath = `${listPath.split("?")[0]}/${number}/comments`
    for (let page = 1; page <= 50; page += 1) {
      let response: Response
      try { response = await ctx.http(`${commentsPath}?per_page=100&page=${page}`) }
      catch (error) { return unreachable(`load comments for GitHub issue #${number} in ${repo}`, error) }
      if (!response.ok) return readErrorMessage(response, `Loading GitHub issue comments failed (${response.status})`)
      const rows: unknown = await response.json().catch(() => null)
      if (!Array.isArray(rows)) return `GitHub answered comments for #${number} with an unreadable payload`
      comments.push(...rows.flatMap(row => isRecord(row) ? [{
        author: authorLogin(row.user),
        ...(isRecord(row.user) && typeof row.user.avatar_url === "string" ? { authorAvatar: row.user.avatar_url } : {}),
        commentBody: typeof row.body === "string" ? row.body : "",
        createdAt: typeof row.created_at === "string" ? row.created_at : null
      }] : []))
      if (!/rel="?next"?/.test(response.headers.get("link") ?? "")) break
      if (page === 50) return `GitHub issue #${number} has more comments than could be loaded. Open it on GitHub to read the full conversation.`
    }
    const payload = parseDetail({ ...issue, author: issue.user }, repo, number, comments)!
    payload.source = "github"
    payload.htmlUrl = `https://github.com/${repo}/issues/${number}`
    const card: Card = {
      id: `issue-github-${repo}-${number}`, kind: "issue", title: `GitHub issue #${number} · ${repo}`,
      status: "active", createdAt: Date.now(), ordinal: ctx.nextOrdinal(), payload
    }
    return { card, ...readResult([
      `${repo} · GitHub #${number} ${payload.title} · ${payload.state}`,
      `Author: ${payload.author ?? "unknown"}`,
      `Labels: ${payload.labels.join(", ") || "none"}`, payload.issueBody,
      ...comments.map(comment => `Comment by ${comment.author ?? "unknown"}:\n${comment.commentBody}`)
    ].join("\n")) }
  }

  /** Fetches the issue AND its comments, then upserts the detail card. */
  const readIssue = async (repo: string, number: number): Promise<ViewResult> => {
    let issueResponse: Response
    try {
      issueResponse = await ctx.http(`${issuesPath(repo)}/${number}`)
    } catch (error) {
      return unreachable(`load issue #${number} in ${repo}`, error)
    }
    if (!issueResponse.ok) {
      if (issueResponse.status === 404) {
        return `Issue #${number} in ${repo} answered 404. For a GitHub issue, use /issues.view ${number} ${repo} --source github.`
      }
      return readErrorMessage(
        issueResponse,
        `Loading issue #${number} in ${repo} failed (${issueResponse.status})`
      )
    }
    const issueJson: unknown = await issueResponse.json().catch(() => null)

    let commentsResponse: Response
    try {
      commentsResponse = await ctx.http(`${issuesPath(repo)}/${number}/comments`)
    } catch (error) {
      return unreachable(`load comments for issue #${number} in ${repo}`, error)
    }
    if (!commentsResponse.ok) {
      return readErrorMessage(
        commentsResponse,
        `Loading comments for issue #${number} in ${repo} failed (${commentsResponse.status})`
      )
    }
    const commentsJson: unknown = await commentsResponse.json().catch(() => null)
    const comments = Array.isArray(commentsJson)
      ? commentsJson.flatMap((entry) => {
        const parsed = parseComment(entry)
        return parsed === null ? [] : [parsed]
      })
      : []

    const payload = parseDetail(issueJson, repo, number, comments)
    if (payload === null) {
      return `The backend answered issue #${number} in ${repo} with an unreadable payload`
    }
    const card: Card = {
      id: `issue-${repo}-${number}`,
      kind: "issue",
      title: `Issue #${number} · ${repo}`,
      status: "active",
      createdAt: Date.now(),
      ordinal: ctx.nextOrdinal(),
      payload
    }
    return { card, ...readResult([
      `${payload.repo} · #${payload.number} ${payload.title} · ${payload.state}`,
      `Author: ${payload.author ?? "unknown"}`,
      `Labels: ${payload.labels.join(", ") || "none"}`,

      payload.issueBody,
      ...payload.comments.map((comment) =>
        `Comment by ${comment.author ?? "unknown"}${comment.createdAt ? ` · ${comment.createdAt}` : ""}:\n${comment.commentBody}`)
    ].join("\n")) }
  }

  const listView = preparedView(ctx, (filter: "open" | "closed" | "all", repoArg?: string) => {
    const target = resolveTargetRepo(ctx.store, repoArg)
    if ("error" in target) return target.error
    const repo = target.repo
    return { id: `issues-${repo}`, title: `Issues · ${repo}`, key: JSON.stringify(["issues", repo, filter]), pane: repo, read: async (): Promise<ViewResult> => {
      // Plue 422s unknown states ("all" included) — omit the param to list every state.
      const query = filter === "all" ? "" : `?state=${filter}`
      let response: Response
      try {
        response = await ctx.http(`${issuesPath(repo)}${query}`)
      } catch (error) {
        return unreachable(`list issues for ${repo}`, error)
      }
      if (!response.ok) {
        // The imported namespace 404s ⇔ the repo isn't imported: degrade to
        // the GitHub-source list instead of surfacing a broken 404.
        if (response.status === 404) return listFromGithubSource(repo, filter)
        return readRepositoryListError(response, `Listing issues for ${repo} failed (${response.status})`)
      }
      const body: unknown = await response.json().catch(() => null)
      if (!Array.isArray(body)) {
        return `The backend answered issues for ${repo} with an unreadable payload`
      }
      const native = body.flatMap((entry) => {
        const parsed = parseListRow(entry)
        return parsed === null ? [] : [{ ...parsed, source: "smithers-cloud" as const }]
      })
      /*
       * Smithers Cloud's /issues is the repository's OWN tracker and is correctly
       * empty for a repo mirrored from GitHub; the upstream issues live at
       * the GitHub-source route (synced store or live GitHub, per plue). One
       * list shows both, each row labeled with where it came from, and the
       * GitHub read's provenance rides the card. A GitHub refusal (not
       * linked, not mirrored) is stated, never a silent absence.
       */
      const github = await readGithubIssues(repo, filter)
      const issues = [...native, ...github.issues]
      const card: Card = {
        id: `issues-${repo}`,
        kind: "issue-list",
        title: `Issues · ${repo}`,
        status: "active",
        createdAt: Date.now(),
        ordinal: ctx.nextOrdinal(),
        payload: { repo, filter, issues, ...(github.meta === undefined ? {} : { github: github.meta }) }
      }
      return { card, ...readResult(issues.length === 0
        ? `No ${filter === "all" ? "" : `${filter} `}issues in ${repo}${github.meta?.refusal ? ` (GitHub: ${github.meta.refusal})` : ""}.`
        : issues.map((issue) => issueRowValue(issue)).join("\n")) }
    } }
  })
  const issueView = preparedView(ctx, (number: number, repoArg?: string, source?: "smithers-cloud" | "github") => {
    const target = resolveTargetRepo(ctx.store, repoArg)
    if ("error" in target) return target.error
    const repo = target.repo
    return { id: `issue-${source === "github" ? "github-" : ""}${repo}-${number}`, title: `Issue #${number} · ${repo}`, pane: repo,
      read: () => source === "github" ? readGithubIssue(repo, number) : readIssue(repo, number) }
  })
  const showIssue = (repo: string, number: number) => issueView(number, repo)

  /** Re-fetch after a successful mutation; a refresh failure still states the mutation happened. */
  const refreshDetail = async (
    done: string,
    repo: string,
    number: number
  ): Promise<string | void> => {
    invalidatePreparedViews(ctx.store)
    const outcome = await showIssue(repo, number)
    if (typeof outcome === "string") return `${done}, but refreshing the card failed: ${outcome}`
  }

  const showCommentNotice = (
    key: string,
    title: string,
    detail: string,
    action?: { readonly label: string; readonly flow: "issues.view"; readonly args: string }
  ): void => {
    ctx.dispatch({ type: "toast.shown", actor: "system", key, title, action })
    if (ctx.resolveToast) ctx.resolveToast(key, { status: "failed", detail, action })
    else ctx.dispatch({ type: "toast.resolved", actor: "system", key, status: "failed", detail, action })
  }

  const refreshCommentDetail = async (repo: string, number: number): Promise<void | { readonly value: string }> => {
    invalidatePreparedViews(ctx.store)
    let failure: string | undefined
    try {
      const outcome = await showIssue(repo, number)
      if (typeof outcome === "string") failure = outcome
    } catch (error) {
      failure = errorText(error)
    }
    if (failure === undefined) return
    const detail = `Refresh failed: ${failure}`
    const key = `issue.comment.refresh:${repo}:${number}`
    const action = { label: "Retry", flow: "issues.view" as const, args: `${number} ${repo}` }
    showCommentNotice(key, "Comment posted", detail, action)
    return { value: `Comment posted. ${detail}` }
  }

  return {
    listIssues: Object.assign((filter: "open" | "closed" | "all", explicitRepo?: string) => repositoryListRead(ctx, "issues", explicitRepo, filter, renderRepositoryForm, (repo) => listView(filter, repo)), { preload: listView.preload }),

    viewIssue: Object.assign(async (number: number, explicitRepo?: string, source?: "smithers-cloud" | "github") => {
      const target = resolveTargetRepo(ctx.store, explicitRepo)
      if ("error" in target) return target.error
      if (source === "github") return readRepositoryDetail(ctx, target.repo, "issue", number,
        () => issueView(number, target.repo, "github"), "github")
      const shown = await readRepositoryDetail(ctx, target.repo, "issue", number, () => showIssue(target.repo, number))
      return shown
    }, { preload: issueView.preload }),

    createIssue: async (title, explicitRepo) => {
      const target = resolveTargetRepo(ctx.store, explicitRepo)
      if ("error" in target) return target.error
      const { repo } = target
      const owner = ctx.store.collections.identitySessions.get("identity")?.login ?? null
      let response: Response
      try {
        response = await ctx.http(issuesPath(repo), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title })
        })
      } catch (error) {
        return unreachable(`create an issue in ${repo}`, error)
      }
      if (!response.ok) {
        // Mutations never fall back — the GitHub-source proxy is GET-only.
        if (response.status === 404) return explain404(response, `${repo} was not found`, notImportedPin(repo))
        return readErrorMessage(response, `Creating the issue in ${repo} failed (${response.status})`)
      }
      const body: unknown = await response.json().catch(() => null)
      const created = isRecord(body) ? asInt(body.number) : null
      if (created === null) {
        return `The issue was created in ${repo}, but the backend answered with an unreadable payload`
      }
      const key = `setup-ci:${owner}:${repo}`
      if (owner === (ctx.store.collections.identitySessions.get("identity")?.login ?? null)
        && !repositoryCiConfigured(ctx.store.collections.cards.values(), repo, owner)
        && ![...ctx.store.collections.toasts.values()].some(toast => toast.key === key)) {
        const action = { label: "Set up CI", flow: "ci.setup" as const, args: repo }
        ctx.dispatch({ type: "toast.shown", actor: "system", key, title: "Improve issue checks", action })
        if (ctx.resolveToast) ctx.resolveToast(key, { status: "ok", detail: "", action })
        else ctx.dispatch({ type: "toast.resolved", actor: "system", key, status: "ok", detail: "", action })
      }
      return refreshDetail(`Issue #${created} was created in ${repo}`, repo, created)
    },

    setIssueState: async (number, state, explicitRepo) => {
      const target = resolveTargetRepo(ctx.store, explicitRepo)
      if ("error" in target) return target.error
      const { repo } = target
      const verb = state === "closed" ? "close" : "reopen"
      let response: Response
      try {
        response = await ctx.http(`${issuesPath(repo)}/${number}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ state })
        })
      } catch (error) {
        return unreachable(`${verb} issue #${number} in ${repo}`, error)
      }
      if (!response.ok) {
        // Mutations never fall back — the GitHub-source proxy is GET-only.
        if (response.status === 404) return explain404(response, `Issue #${number} in ${repo} was not found`)
        return readErrorMessage(
          response,
          `Could not ${verb} issue #${number} in ${repo} (${response.status})`
        )
      }
      // The re-fetch below states the new truth; the PATCH echo is not read.
      await response.body?.cancel()
      return refreshDetail(`Issue #${number} in ${repo} is now ${state}`, repo, number)
    },

    commentOnIssue: async (number, text, explicitRepo) => {
      if (text.trim() === "") return "Write a comment before posting it."
      const target = resolveTargetRepo(ctx.store, explicitRepo)
      if ("error" in target) return target.error
      const { repo } = target
      let response: Response
      try {
        response = await ctx.http(`${issuesPath(repo)}/${number}/comments`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ body: text })
        })
      } catch (error) {
        const detail = `No response from issue #${number} in ${repo}: ${errorText(error)}`
        showCommentNotice(`issue.comment.unknown:${repo}:${number}`, "Comment status unknown", detail)
        return { value: `Comment status unknown. ${detail}` }
      }
      if (!response.ok) {
        // Mutations never fall back — the GitHub-source proxy is GET-only.
        if (response.status === 404) return explain404(response, `Issue #${number} in ${repo} was not found`)
        return readErrorMessage(
          response,
          `Commenting on issue #${number} in ${repo} failed (${response.status})`
        )
      }
      // The re-fetch below re-lists the comments; the POST echo is not read.
      await response.body?.cancel().catch(() => {})
      return refreshCommentDetail(repo, number)
    },

  }
}

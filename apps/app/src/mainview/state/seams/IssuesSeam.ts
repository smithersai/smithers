import { readRepositoryDetail } from "../RepositoryReadReceipts"
import { publishIssueView, publishRepoView } from "../EmbeddedHistory"
import { isPracticeRepo } from "../practice/PracticeRepository"
import { mutatePracticeIssue, finishIssueLesson, practiceViewIssue, tutorialRepositoryRead, readRepositoryListError, type RepositoryForm } from "./tutorial2-issues_prs"
/*
 * The issues seam: /api/repos/{owner}/{repo}/issues* through the product
 * Worker's platform proxy. List and detail render as cards ("issue-list",
 * "issue"); mutations re-fetch and re-surface the affected detail card so the
 * transcript states the new truth. Reference: multi src/smithersCloud/
 * issues.ts + issueComments.ts. Parsing is defensive: unknown JSON in, typed
 * card payload out, missing fields become null/empty, malformed rows drop.
 *
 * Lane L5 (ADR 0005 "Link an issue to Linear"): the mapping rides the same
 * namespace — POST/DELETE /api/repos/{o}/{r}/issues/{n}/linear-link — and the
 * issue DTO's own `linear` field ({identifier, url} or null) is the only
 * source of the card's `Linear ENG-482` line.
 *
 * IMPORT-READINESS degradation (multi importReadiness.ts + githubIssues.ts):
 * a 404 off the imported namespace means "not imported", so the LIST falls
 * back to the GET-only GitHub-source read and the card says so in `body`;
 * source-qualified detail uses the GitHub metadata list and comments routes.
 * Mutations remain native and never fall back to a different tracker.
 */
import type { Card } from "../AppState"
import { resolveTargetRepo } from "../RepoContext"
import { errorText, readErrorMessage, readResult, unreachableSentence } from "./SeamContext"
import type { SeamContext } from "./SeamContext"

export interface IssuesSeam {
  /** Renders the list card and answers the rows as text (the model reads the value, never the card). */
  readonly listIssues: (filter: "open" | "closed" | "all", repo?: string) => Promise<string | { readonly value: string }>
  readonly viewIssue: (number: number, repo?: string, source?: "smithers-cloud" | "github") => Promise<string | { readonly value: string }>
  readonly createIssue: (title: string, repo?: string) => Promise<string | void>
  readonly setIssueState: (
    number: number,
    state: "open" | "closed",
    repo?: string
  ) => Promise<string | void>
  readonly commentOnIssue: (number: number, text: string, repo?: string) => Promise<string | void>
  /** `issues.link-linear <n> <identifier>`: POST the mapping, then re-read the detail card. */
  readonly linkLinear: (number: number, identifier: string, repo?: string) => Promise<string | void>
  /**
   * `issues.unlink-linear <n> <identifier>`: the identifier typed back is the
   * confirm (a slash, an agent's confirmed invocation, and a card act all
   * carry it); then DELETE the mapping and re-read the detail card.
   */
  readonly unlinkLinear: (number: number, identifier?: string, repo?: string) => Promise<string | void>
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
    comments: comments !== null && comments >= 0 ? comments : 0,
    updatedAt: typeof value.updated_at === "string" ? value.updated_at : null
  }
}

/** Label NAMES only — the card states labels as words, not colors. */
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
  /*
   * Lane sync (ADR 0005): the issue's Linear link off the DTO's own `linear`
   * field ({identifier, url}, null when unmapped). Absent-vs-null is not
   * distinguished — no line renders without the field.
   */
  const linear = isRecord(value.linear) &&
    typeof value.linear.identifier === "string" && value.linear.identifier !== "" &&
    typeof value.linear.url === "string"
    ? { identifier: value.linear.identifier, url: value.linear.url }
    : null
  return {
    repo,
    number: asInt(value.number) ?? number,
    title: typeof value.title === "string" ? value.title : "",
    state: asIssueState(value.state),
    author: authorLogin(value.author),
    issueBody: typeof value.body === "string" ? value.body : "",
    labels: parseLabels(value.labels),
    comments: [...comments],
    ...(linear !== null ? { linear } : {})
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
  ): Promise<string | { readonly value: string }> => {
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
    await publishRepoView(ctx, {
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
    })
    return readResult(issues.length === 0
      ? `No ${filter === "all" ? "" : `${filter} `}issues in ${repo} (read from GitHub).`
      : issues.map((issue) => issueRowValue(issue, "github")).join("\n"))
  }

  /** GitHub has a separate tracker. Its supported metadata routes expose full issue bodies in the list. */
  const showGithubIssue = async (repo: string, number: number): Promise<string | { readonly value: string }> => {
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
        commentBody: typeof row.body === "string" ? row.body : "",
        createdAt: typeof row.created_at === "string" ? row.created_at : null
      }] : []))
      if (!/rel="?next"?/.test(response.headers.get("link") ?? "")) break
      if (page === 50) return `GitHub issue #${number} has more comments than could be loaded. Open it on GitHub to read the full conversation.`
    }
    const payload = parseDetail({ ...issue, author: issue.user }, repo, number, comments)!
    payload.source = "github"
    payload.htmlUrl = `https://github.com/${repo}/issues/${number}`
    await publishIssueView(ctx, {
      id: `issue-github-${repo}-${number}`, kind: "issue", title: `GitHub issue #${number} · ${repo}`,
      status: "active", createdAt: Date.now(), ordinal: ctx.nextOrdinal(), payload
    })
    return readResult([
      `${repo} · GitHub #${number} ${payload.title} · ${payload.state}`,
      `Author: ${payload.author ?? "unknown"}`,
      `Labels: ${payload.labels.join(", ") || "none"}`, payload.issueBody,
      ...comments.map(comment => `Comment by ${comment.author ?? "unknown"}:\n${comment.commentBody}`)
    ].join("\n"))
  }

  /** Fetches the issue AND its comments, then upserts the detail card. */
  const showIssue = async (repo: string, number: number): Promise<string | { readonly value: string }> => {
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
    await publishIssueView(ctx, {
      id: `issue-${repo}-${number}`,
      kind: "issue",
      title: `Issue #${number} · ${repo}`,
      status: "active",
      createdAt: Date.now(),
      ordinal: ctx.nextOrdinal(),
      payload
    })
    return readResult([
      `${payload.repo} · #${payload.number} ${payload.title} · ${payload.state}`,
      `Author: ${payload.author ?? "unknown"}`,
      `Labels: ${payload.labels.join(", ") || "none"}`,
      ...(payload.linear ? [`Linear: ${payload.linear.identifier} · ${payload.linear.url}`] : []),
      payload.issueBody,
      ...payload.comments.map((comment) =>
        `Comment by ${comment.author ?? "unknown"}${comment.createdAt ? ` · ${comment.createdAt}` : ""}:\n${comment.commentBody}`)
    ].join("\n"))
  }

  /** Re-fetch after a successful mutation; a refresh failure still states the mutation happened. */
  const refreshDetail = async (
    done: string,
    repo: string,
    number: number
  ): Promise<string | void> => {
    const outcome = await showIssue(repo, number)
    if (typeof outcome === "string") return `${done}, but refreshing the card failed: ${outcome}`
  }

  return {
    listIssues: (filter, explicitRepo) => tutorialRepositoryRead(ctx, "issues", explicitRepo, filter, renderRepositoryForm, async (repo) => {
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
      await publishRepoView(ctx, {
        id: `issues-${repo}`,
        kind: "issue-list",
        title: `Issues · ${repo}`,
        status: "active",
        createdAt: Date.now(),
        ordinal: ctx.nextOrdinal(),
        payload: { repo, filter, issues, ...(github.meta === undefined ? {} : { github: github.meta }) }
      })
      return readResult(issues.length === 0
        ? `No ${filter === "all" ? "" : `${filter} `}issues in ${repo}${github.meta?.refusal ? ` (GitHub: ${github.meta.refusal})` : ""}.`
        : issues.map((issue) => issueRowValue(issue)).join("\n"))
    }),

    viewIssue: async (number, explicitRepo, source) => {
      if (isPracticeRepo(explicitRepo)) return readRepositoryDetail(ctx, explicitRepo!, "issue", number, () => practiceViewIssue(ctx, number))
      const target = resolveTargetRepo(ctx.store, explicitRepo)
      if ("error" in target) return target.error
      if (source === "github") return readRepositoryDetail(ctx, target.repo, "issue", number,
        () => showGithubIssue(target.repo, number), "github")
      const playthrough = ctx.store.session().guide?.playthrough
      const shown = await readRepositoryDetail(ctx, target.repo, "issue", number, () => showIssue(target.repo, number))
      if (typeof shown !== "string") await finishIssueLesson(ctx, playthrough)
      return shown
    },

    createIssue: async (title, explicitRepo) => {
      const target = resolveTargetRepo(ctx.store, explicitRepo)
      if ("error" in target) return target.error
      const { repo } = target
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
        if (response.status === 404) return notImported(repo)
        return readErrorMessage(response, `Creating the issue in ${repo} failed (${response.status})`)
      }
      const body: unknown = await response.json().catch(() => null)
      const created = isRecord(body) ? asInt(body.number) : null
      if (created === null) {
        return `The issue was created in ${repo}, but the backend answered with an unreadable payload`
      }
      return refreshDetail(`Issue #${created} was created in ${repo}`, repo, created)
    },

    setIssueState: async (number, state, explicitRepo) => {
      if (isPracticeRepo(explicitRepo)) return mutatePracticeIssue(ctx, number, payload => ({ ...payload, state }))
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
        if (response.status === 404) return notImported(repo)
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
      if (isPracticeRepo(explicitRepo)) return mutatePracticeIssue(ctx, number, payload => ({ ...payload, comments: [...payload.comments, { author: ctx.store.collections.identitySessions.get("identity")?.login ?? "You", commentBody: text.trim(), createdAt: new Date().toISOString() }] }))
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
        return unreachable(`comment on issue #${number} in ${repo}`, error)
      }
      if (!response.ok) {
        // Mutations never fall back — the GitHub-source proxy is GET-only.
        if (response.status === 404) return notImported(repo)
        return readErrorMessage(
          response,
          `Commenting on issue #${number} in ${repo} failed (${response.status})`
        )
      }
      // The re-fetch below re-lists the comments; the POST echo is not read.
      await response.body?.cancel()
      return refreshDetail(`The comment was posted to issue #${number} in ${repo}`, repo, number)
    },

    linkLinear: async (number, identifier, explicitRepo) => {
      const trimmed = identifier.trim()
      if (trimmed === "") return "issues.link-linear needs the Linear identifier: /issues.link-linear <n> <identifier>"
      const target = resolveTargetRepo(ctx.store, explicitRepo)
      if ("error" in target) return target.error
      const { repo } = target
      let response: Response
      try {
        response = await ctx.http(`${issuesPath(repo)}/${number}/linear-link`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ identifier: trimmed })
        })
      } catch (error) {
        return unreachable(`link issue #${number} in ${repo} to Linear`, error)
      }
      if (!response.ok) {
        // Mutations never fall back — the GitHub-source proxy is GET-only.
        if (response.status === 404) return notImported(repo)
        return readErrorMessage(
          response,
          `Linking issue #${number} in ${repo} to Linear failed (${response.status})`
        )
      }
      /* The 201 echoes { identifier, url }; the re-read states the new truth on the card. */
      await response.body?.cancel()
      return refreshDetail(`Issue #${number} in ${repo} is linked to Linear ${trimmed}`, repo, number)
    },

    unlinkLinear: async (number, identifier, explicitRepo) => {
      /*
       * Removing a link is consequential (review finding 4), so the typed
       * identifier gates it HERE, not in any card's chrome: the issue card's
       * own link is the identifier to type back when the app has read it.
       */
      const target = resolveTargetRepo(ctx.store, explicitRepo)
      if ("error" in target) return target.error
      const { repo } = target
      const detail = ctx.store.collections.cards.get(`issue-${repo}-${number}`)
      const known = detail?.kind === "issue" ? detail.payload.linear?.identifier ?? null : null
      const typed = identifier?.trim() ?? ""
      if (typed === "" || (known !== null && typed !== known)) {
        return `Unlinking issue #${number} in ${repo} from Linear needs its identifier typed back exactly — /issues.unlink-linear ${number} ${known ?? "<identifier>"}.`
      }
      let response: Response
      try {
        response = await ctx.http(`${issuesPath(repo)}/${number}/linear-link`, { method: "DELETE" })
      } catch (error) {
        return unreachable(`unlink issue #${number} in ${repo} from Linear`, error)
      }
      if (!response.ok) {
        // Mutations never fall back — the GitHub-source proxy is GET-only.
        if (response.status === 404) return notImported(repo)
        return readErrorMessage(
          response,
          `Unlinking issue #${number} in ${repo} from Linear failed (${response.status})`
        )
      }
      /* 204: no body to read; the re-read states the new truth on the card. */
      await response.body?.cancel()
      return refreshDetail(`Issue #${number} in ${repo} is no longer linked to Linear`, repo, number)
    }
  }
}

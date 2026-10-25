// A scripted GitHub for the git loop's tests (docs/features/issues.md#tests): a third-party provider scripted like the
// model, on the `HttpClient` seam, an Effect service the flows and routes take as a value; nothing intercepts a request.
// It keeps the GitHub rules the loop relies on: an App's JWT mints installation tokens only for an installed App and
// only within the permissions it was granted; issues and comments are numbered, timestamped and attributed to whoever's
// token made them; listings page by `per_page` with `Link: rel="next"`, sorted and filtered by `since` as GitHub does;
// a deleted or transferred issue answers 404. For triage it keeps the repository's labels (adding a missing one to an
// issue creates it, as GitHub does; creating one that exists answers 422), each issue's labels (a change moves its
// `updated_at`), the files the contents API reads, and each collaborator's role. A test arms one-shot faults per request: a status GitHub answers with
// (nothing applied), or `lost`, where GitHub applies a write and the answer never arrives. The real GitHub is
// worker/github/Live.test.ts.
import { GitHub } from "@smthrs/integrations"
import { Effect, Layer, Redacted } from "effect"
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http"

/** The App's ID, as the deployment's `GITHUB_APP_ID` names it. */
export const APP_ID = "424242"

/** The installation the scripted App has on the repository. */
export const INSTALLATION_ID = 77

/** GitHub's numeric id of the scripted repository. */
export const REPOSITORY_ID = 1_296_269

/** The login GitHub shows for the App's own writes. */
export const BOT_LOGIN = "smithers[bot]"

/** One issue as the scripted GitHub keeps it. */
export interface ScriptedIssue {
  readonly id: number
  readonly number: number
  title: string
  body: string | null
  state: "open" | "closed"
  /** Null for a deleted account (GitHub's ghost). */
  readonly login: string | null
  readonly createdAt: number
  updatedAt: number
  closedAt: number | null
  readonly pull: boolean
  /** Deleted or transferred away: GitHub answers 404 and leaves it out of every listing. */
  gone: boolean
  /** Listed without the fields this app reads, as if GitHub changed its shape. */
  malformed?: boolean
  readonly comments: Array<ScriptedComment>
  /** Its labels' names, in the order they were added. */
  labels: Array<string>
}

/** One comment as the scripted GitHub keeps it. */
export interface ScriptedComment {
  readonly id: number
  readonly issue: number
  body: string
  readonly login: string | null
  readonly createdAt: number
  updatedAt: number
  gone: boolean
  malformed?: boolean
}

/** A commit as the scripted GitHub keeps it: its message, parent, author and the whole tree of files it holds. */
export interface ScriptedCommit {
  readonly sha: string
  readonly message: string
  readonly parents: ReadonlyArray<string>
  readonly login: string | null
  readonly at: number
  readonly files: ReadonlyMap<string, string>
}

/** A pull request as the scripted GitHub keeps it, beside the issue of the same number GitHub keeps for it. */
export interface ScriptedPull {
  readonly number: number
  readonly head: string
  /** Its base branch: a stacked pull request moves onto another (`PATCH` with `base`). */
  base: string
  /** GitHub keeps the base snapshot from opening, even after the branch moves. */
  baseSha: string
  /** A draft until marked ready (GraphQL `markPullRequestReadyForReview`). */
  draft: boolean
  merged: boolean
  mergeSha: string | null
  mergedBy: string | null
  readonly reviews: Array<{
    readonly id: number
    readonly login: string | null
    readonly event: string
    readonly body: string
    readonly commitId: string
    readonly at: number
  }>
}

/** One commit status as the scripted GitHub keeps it: GitHub keeps every one sent, and shows the latest per context. */
export interface ScriptedStatus {
  readonly state: string
  readonly context: string
  readonly description: string | null
  readonly login: string
}

/**
 * A one-shot fault on the next request that `match`es: GitHub's `status`, or `lost` (applied, then no answer), or
 * `hold`, a request still in flight: GitHub applies and answers it only once `hold` resolves, so another writer can land
 * first.
 */
export interface Fault {
  readonly match: (method: string, path: string) => boolean
  readonly status?: number
  readonly headers?: Readonly<Record<string, string>>
  readonly lost?: boolean
  /** Applies the request, then returns a successful response with an invalid schema. */
  readonly malformed?: boolean
  readonly hold?: () => Promise<void>
}

/** One request GitHub saw: its method, path, and which kind of token made it. */
export interface Call {
  readonly method: string
  readonly path: string
  readonly token: "jwt" | "installation" | "user" | "none"
}

export interface ScriptedGitHub {
  readonly http: HttpClient.HttpClient
  readonly layer: Layer.Layer<HttpClient.HttpClient>
  readonly owner: string
  readonly name: string
  readonly issues: Map<number, ScriptedIssue>
  readonly calls: Array<Call>
  readonly faults: Array<Fault>
  /** Whether the App is installed on the repository. */
  installed: boolean
  /** The issues permission the App was granted: a token asking for more is refused 422. */
  granted: "read" | "write" | "none"
  /** Whether the App was granted Contents: read; without it, a token asking for it is refused 422. */
  contentsGranted: boolean
  /** The repository's labels, by name without case. */
  readonly labels: Map<string, { readonly name: string; readonly color: string }>
  /**
   * The repository's files on its default branch, by path, as the contents API reads them without a `ref`; with one,
   * it reads that branch's or commit's files.
   */
  readonly files: Map<string, string>
  /**
   * Each collaborator's role on the repository, by login: `admin`, `maintain`, `write`, `triage` or `read`, or an
   * organization's custom role with the base permission GitHub reports for it.
   */
  readonly roles: Map<string, string | { readonly roleName: string; readonly permission: string }>
  /**
   * The account each login names now, by login: `accountIdOf(login)` unless set. Setting another id is a login that
   * changed hands after a rename.
   */
  readonly accounts: Map<string, number>
  /** Whether the repository is private. */
  private: boolean
  /** GitHub's clock, in epoch ms: the real one, moved on a second at least by each change, so `updated_at` is ordered. */
  now: number
  /** The installation tokens GitHub minted, newest last, with what each was asked for. */
  readonly minted: Array<{ readonly token: string; readonly body: unknown }>
  /** A user token GitHub accepts, for `login`. */
  readonly userToken: (login: string) => Redacted.Redacted<string>
  /** Revokes a user token: GitHub answers 401 for it from now on. */
  readonly revoke: (token: Redacted.Redacted<string>) => void
  /** Someone on github.com opens an issue; a null body is one with no description, a null login a deleted account. */
  readonly open: (title: string, body: string | null, login?: string | null) => ScriptedIssue
  /** Someone on github.com comments. */
  readonly comment: (number: number, body: string, login?: string | null) => ScriptedComment
  /** Someone on github.com edits an issue's title. */
  readonly retitle: (number: number, title: string) => void
  /** Someone on github.com sets an issue's labels. */
  readonly relabel: (number: number, labels: ReadonlyArray<string>) => void
  /** The issue is deleted, or transferred away. */
  readonly remove: (number: number) => void
  /** The comment is deleted. */
  readonly removeComment: (id: number) => void
  /** Requests GitHub saw for `method` and a path matching `pattern`. */
  readonly seen: (method: string, pattern: RegExp) => ReadonlyArray<Call>
  /** The Pull requests permission the App was granted: a token asking for more is refused 422. */
  pullsGranted: "read" | "write" | "none"
  /** Each branch's head, by name: `main` starts at a commit holding `files`. */
  readonly refs: Map<string, string>
  /** Every commit, by SHA. */
  readonly commits: Map<string, ScriptedCommit>
  /** Every pull request, by number. */
  readonly pulls: Map<number, ScriptedPull>
  /** Whether the App was granted Commit statuses: write; without it, a token asking for it is refused 422. */
  statusesGranted: boolean
  /** Every commit status sent, by commit SHA, oldest first. */
  readonly statuses: Map<string, Array<ScriptedStatus>>
  /** What commit `sha` shows: the latest state per context. */
  readonly shownStatuses: (sha: string) => Readonly<Record<string, string>>
  /** Whether GitHub refuses to merge any pull request: a required check it ran failed (405). */
  unmergeable: boolean
  /** Runs right after a pull request is opened, such as a person merging it on github.com. */
  onPullOpened: ((number: number) => void) | undefined
  /** Someone pushes `files` onto `branch` (made from main when new) as one commit; null deletes; answers its SHA. */
  readonly push: (branch: string, files: Readonly<Record<string, string | null>>, login?: string) => string
  /** A person merges pull request `number` on github.com, squashing it onto its base. */
  readonly merge: (number: number, login?: string) => string
  /** A person closes pull request `number` on github.com without merging it. */
  readonly close: (number: number) => void
  /** The files of branch `name`'s head. */
  readonly tree: (name: string) => ReadonlyMap<string, string>
  /** Someone opens a pull request from `head` into `main` on github.com. */
  readonly openPull: (head: string, title?: string, login?: string | null) => ScriptedPull
}

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z")

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })

const decoder = new TextDecoder()

/** The account id GitHub gives `login` unless `accounts` says otherwise: the one `fixtures.signedIn` records. */
export const accountIdOf = (login: string) => login.length * 1000

/** A scripted GitHub at `https://api.github.test` with the repository `owner/name`, the App installed and granted write. */
export const scriptedGitHub = (owner = "acme", name = "widgets"): ScriptedGitHub => {
  const userTokens = new Map<string, string>()
  const installationTokens = new Map<string, Readonly<Record<string, string>>>()
  let ids = 1_000
  let numbers = 0
  let users = 0

  const apiPath = `/repos/${owner}/${name}`.toLowerCase()

  const user = (login: string | null) => (login === null ? null : { id: login.length * 1000, login })

  const issueJson = (issue: ScriptedIssue) => ({
    labels: issue.labels.map((label) => ({ id: label.length, name: label, color: "ededed" })),
    id: issue.id,
    ...(issue.malformed === true ? {} : { node_id: `I_${issue.id}` }),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    state_reason: issue.state === "closed" ? "completed" : null,
    user: user(issue.login),
    comments: issue.comments.filter((comment) => !comment.gone).length,
    created_at: iso(issue.createdAt),
    updated_at: iso(issue.updatedAt),
    closed_at: issue.closedAt === null ? null : iso(issue.closedAt),
    html_url: `https://github.com/${owner}/${name}/issues/${issue.number}`,
    ...(issue.pull ? { pull_request: { url: "https://api.github.test/pulls" } } : {}),
  })

  const commentJson = (comment: ScriptedComment) => ({
    id: comment.id,
    ...(comment.malformed === true ? {} : { node_id: `IC_${comment.id}` }),
    body: comment.body,
    user: user(comment.login),
    created_at: iso(comment.createdAt),
    updated_at: iso(comment.updatedAt),
    issue_url: `https://api.github.test/repos/${owner}/${name}/issues/${comment.issue}`,
    html_url: `https://github.com/${owner}/${name}/issues/${comment.issue}#issuecomment-${comment.id}`,
  })

  // GitHub's clock follows the real one, a second at least per change, so `since` searches a write's admission makes
  // (Postgres' clock) find what GitHub stamped after it.
  const tick = () => (github.now = Math.max(github.now + 1_000, Date.now()))

  /** One page of `items` by `per_page` and `page`, with GitHub's `Link` header when more follow. */
  const paged = (url: URL, items: ReadonlyArray<unknown>) => {
    const perPage = Number(url.searchParams.get("per_page") ?? 30)
    const page = Number(url.searchParams.get("page") ?? 1)
    const slice = items.slice((page - 1) * perPage, page * perPage)
    const headers: Record<string, string> = {}
    if (page * perPage < items.length) {
      const next = new URL(url)
      next.searchParams.set("page", String(page + 1))
      headers["link"] = `<${next.toString()}>; rel="next"`
    }
    return json(slice, 200, headers)
  }

  const since = (url: URL) => {
    const value = url.searchParams.get("since")
    return value === null ? -Infinity : Date.parse(value)
  }

  const sorted = <T extends { readonly createdAt: number; updatedAt: number }>(url: URL, items: ReadonlyArray<T>) => {
    const key = url.searchParams.get("sort") === "created" ? "createdAt" : "updatedAt"
    const direction = url.searchParams.get("direction") === "asc" ? 1 : -1
    return [...items].sort((a, b) => (a[key] - b[key]) * direction)
  }

  const answer = (method: string, url: URL, token: Call["token"] | "installation-contents", login: string | undefined, body: unknown): {
    readonly response: Response
    readonly apply?: () => void
  } => {
    const path = url.pathname.toLowerCase()
    if (path === `${apiPath}/installation` && method === "GET") {
      if (token !== "jwt") return { response: json({ message: "A JSON web token could not be decoded" }, 401) }
      return { response: github.installed ? json({ id: INSTALLATION_ID }) : json({ message: "Not Found" }, 404) }
    }
    if (path === `/app/installations/${INSTALLATION_ID}/access_tokens` && method === "POST") {
      if (token !== "jwt") return { response: json({ message: "A JSON web token could not be decoded" }, 401) }
      if (!github.installed) return { response: json({ message: "Not Found" }, 404) }
      const permissions: Readonly<Record<string, string>> =
        (body as { readonly permissions?: Record<string, string> }).permissions ?? { issues: "read" }
      const within = (granted: "read" | "write" | "none", asked: string) =>
        granted === "write" || (granted === "read" && asked === "read")
      const allowed = Object.entries(permissions).every(([name, asked]) =>
        name === "issues"
          ? within(github.granted, asked)
          : name === "contents"
          ? github.contentsGranted
          : name === "pull_requests"
          ? within(github.pullsGranted, asked)
          : name === "statuses"
          ? github.statusesGranted
          : name === "metadata"
          // Every App has Metadata: read, and GitHub grants nothing more of it.
          ? asked === "read"
          : false
      )
      if (!allowed) return { response: json({ message: "The permissions requested are not granted to this installation." }, 422) }
      const minted = `ghs_scripted_${github.minted.length + 1}`
      installationTokens.set(minted, permissions)
      github.minted.push({ token: minted, body })
      return { response: json({ token: minted, expires_at: iso(github.now + 3_600_000) }, 201) }
    }
    if (path === "/graphql" && method === "POST") {
      if (token === "none" || login === undefined) return { response: json({ message: "Bad credentials" }, 401) }
      return graphql(body, login)
    }
    if (!path.startsWith(apiPath)) return { response: json({ message: "Not Found" }, 404) }
    if (path === apiPath && method === "GET" && token === "none") {
      return { response: github.private ? json({ message: "Not Found" }, 404) : json({ id: REPOSITORY_ID, private: false, default_branch: "main" }) }
    }
    if (token === "none" || login === undefined) return { response: json({ message: "Bad credentials" }, 401) }
    const rest = path.slice(apiPath.length)
    const live = [...github.issues.values()].filter((issue) => !issue.gone)
    if (rest === "" && method === "GET") {
      return { response: json({ id: REPOSITORY_ID, private: github.private, default_branch: "main" }) }
    }
    const pulled = pullsAnswer(method, url, rest, login, body)
    if (pulled !== undefined) return pulled
    const statusOf = /^\/statuses\/([0-9a-f]{40})$/.exec(rest)
    if (statusOf !== null && method === "POST") {
      const sha = statusOf[1]!
      if (!github.commits.has(sha)) return { response: json({ message: "No commit found for SHA: " + sha }, 422) }
      const input = body as { readonly state: string; readonly context: string; readonly description?: string }
      const status: ScriptedStatus = {
        state: input.state,
        context: input.context,
        description: input.description ?? null,
        login,
      }
      return {
        response: json({
          id: (ids += 1),
          state: status.state,
          context: status.context,
          description: status.description,
          target_url: null,
          created_at: iso(tick()),
        }, 201),
        apply: () => void github.statuses.set(sha, [...(github.statuses.get(sha) ?? []), status]),
      }
    }
    if (rest === "/labels" && method === "POST") {
      const input = body as { readonly name: string; readonly color: string }
      if (github.labels.has(input.name.toLowerCase())) {
        return { response: json({ message: "Validation Failed", errors: [{ code: "already_exists" }] }, 422) }
      }
      const label = { name: input.name, color: input.color }
      return { response: json(label, 201), apply: () => void github.labels.set(input.name.toLowerCase(), label) }
    }
    const contentsMatch = /^\/contents\/(.+)$/.exec(url.pathname.slice(apiPath.length))
    if (contentsMatch !== null && method === "GET") {
      if (token !== "installation-contents") return { response: json({ message: "Resource not accessible by integration" }, 403) }
      const path = decodeURIComponent(contentsMatch[1]!)
      // At `ref`, a branch or a commit, when the request names one; else the default branch's files.
      const ref = url.searchParams.get("ref")
      const text = ref === null
        ? github.files.get(path)
        : (github.commits.get(github.refs.get(ref) ?? ref)?.files ?? new Map<string, string>()).get(path)
      if (text === undefined) {
        // A directory: GitHub lists it as an array, which is no file.
        const files = ref === null ? github.files : github.commits.get(github.refs.get(ref) ?? ref)?.files ?? new Map()
        const inside = [...files.keys()].filter((name) => name.startsWith(`${path}/`))
        if (inside.length > 0) return { response: json(inside.map((name) => ({ type: "file", path: name, name }))) }
        return { response: json({ message: "Not Found" }, 404) }
      }
      const bytes = new TextEncoder().encode(text)
      const base64 = btoa(String.fromCharCode(...bytes)).replace(/(.{60})/g, "$1\n")
      return { response: json({ type: "file", encoding: "base64", path, sha: `sha-${text.length}`, size: bytes.length, content: base64 }) }
    }
    const collaborator = /^\/collaborators\/([^/]+)\/permission$/.exec(rest)
    if (collaborator !== null && method === "GET") {
      const role = github.roles.get(collaborator[1]!)
      if (role === undefined) return { response: json({ message: "Not Found" }, 404) }
      const named = typeof role === "string"
        ? { roleName: role, permission: role === "maintain" ? "write" : role === "triage" ? "read" : role }
        : role
      const login = collaborator[1]!
      return {
        response: json({
          permission: named.permission,
          role_name: named.roleName,
          user: { login, id: github.accounts.get(login) ?? accountIdOf(login) },
        }),
      }
    }
    if (rest === "/issues" && method === "GET") {
      const listed = sorted(url, live.filter((issue) => issue.updatedAt >= since(url)))
      return { response: paged(url, listed.map(issueJson)) }
    }
    if (rest === "/issues" && method === "POST") {
      const input = body as { readonly title: string; readonly body: string }
      const issue: ScriptedIssue = {
        id: (ids += 1),
        number: (numbers += 1),
        title: input.title,
        body: input.body,
        state: "open",
        login,
        createdAt: tick(),
        updatedAt: github.now,
        closedAt: null,
        pull: false,
        gone: false,
        comments: [],
        labels: [],
      }
      return { response: json(issueJson(issue), 201), apply: () => void github.issues.set(issue.number, issue) }
    }
    if (rest === "/issues/comments" && method === "GET") {
      const comments = live.flatMap((issue) => issue.comments.filter((comment) => !comment.gone))
      const listed = sorted(url, comments.filter((comment) => comment.updatedAt >= since(url)))
      return { response: paged(url, listed.map(commentJson)) }
    }
    const labelsMatch = /^\/issues\/(\d+)\/labels(?:\/([^/]+))?$/.exec(url.pathname.slice(apiPath.length))
    if (labelsMatch !== null) {
      const labeled = github.issues.get(Number(labelsMatch[1]))
      if (labeled === undefined || labeled.gone) return { response: json({ message: "Not Found" }, 404) }
      const listed = () => labeled.labels.map((name) => ({ name, color: github.labels.get(name.toLowerCase())?.color }))
      if (method === "POST" && labelsMatch[2] === undefined) {
        const names = (body as { readonly labels: ReadonlyArray<string> }).labels
        const added = names.filter((name) => !labeled.labels.some((label) => label.toLowerCase() === name.toLowerCase()))
        return {
          response: json([...labeled.labels, ...added].map((name) => ({ name }))),
          apply: () => {
            for (const name of added) {
              if (!github.labels.has(name.toLowerCase())) github.labels.set(name.toLowerCase(), { name, color: "ededed" })
              labeled.labels.push(name)
            }
            if (added.length > 0) labeled.updatedAt = tick()
          },
        }
      }
      if (method === "DELETE" && labelsMatch[2] !== undefined) {
        const name = decodeURIComponent(labelsMatch[2])
        const index = labeled.labels.findIndex((label) => label.toLowerCase() === name.toLowerCase())
        if (index === -1) return { response: json({ message: "Label does not exist" }, 404) }
        return {
          response: json(listed().filter((_, at) => at !== index)),
          apply: () => {
            labeled.labels.splice(index, 1)
            labeled.updatedAt = tick()
          },
        }
      }
      return { response: json({ message: "Not Found" }, 404) }
    }
    const match = /^\/issues\/(\d+)(\/comments)?$/.exec(rest)
    if (match === null) return { response: json({ message: "Not Found" }, 404) }
    const issue = github.issues.get(Number(match[1]))
    if (issue === undefined || issue.gone) return { response: json({ message: "Not Found" }, 404) }
    if (match[2] === undefined && method === "GET") return { response: json(issueJson(issue)) }
    if (match[2] !== undefined && method === "GET") {
      // An issue's comments come oldest first.
      const listed = issue.comments
        .filter((comment) => !comment.gone && comment.updatedAt >= since(url))
        .sort((a, b) => a.createdAt - b.createdAt)
      return { response: paged(url, listed.map(commentJson)) }
    }
    if (match[2] !== undefined && method === "POST") {
      const comment: ScriptedComment = {
        id: (ids += 1),
        issue: issue.number,
        body: (body as { readonly body: string }).body,
        login,
        createdAt: tick(),
        updatedAt: github.now,
        gone: false,
      }
      return {
        response: json(commentJson(comment), 201),
        apply: () => {
          issue.comments.push(comment)
          issue.updatedAt = github.now
        },
      }
    }
    return { response: json({ message: "Not Found" }, 404) }
  }

  // Git: commits hold their whole tree, so a branch's files and a comparison read from them.
  let commitIds = 0
  const commit = (message: string, parents: ReadonlyArray<string>, files: ReadonlyMap<string, string>, login: string | null) => {
    const sha = (commitIds += 1).toString(16).padStart(40, "c")
    github.commits.set(sha, { sha, message, parents, login, at: tick(), files: new Map(files) })
    return sha
  }
  const headFiles = (name: string) => github.commits.get(github.refs.get(name) ?? "")?.files ?? new Map<string, string>()
  const changedBetween = (from: ReadonlyMap<string, string>, to: ReadonlyMap<string, string>) => {
    const paths = [...new Set([...from.keys(), ...to.keys()])].sort()
    return paths.flatMap((path) => {
      const before = from.get(path)
      const after = to.get(path)
      if (before === after) return []
      const removed = before === undefined ? [] : before.split("\n").filter((line) => line !== "")
      const added = after === undefined ? [] : after.split("\n").filter((line) => line !== "")
      return [{
        sha: "blob",
        filename: path,
        status: before === undefined ? "added" : after === undefined ? "removed" : "modified",
        additions: added.length,
        deletions: removed.length,
        changes: added.length + removed.length,
        patch: `@@ -1,${removed.length} +1,${added.length} @@\n${[...removed.map((line) => `-${line}`), ...added.map((line) => `+${line}`)].join("\n")}`,
      }]
    })
  }
  const refJson = (name: string) => ({ ref: `refs/heads/${name}`, object: { sha: github.refs.get(name)!, type: "commit" } })

  const graphql = (body: unknown, login: string): { readonly response: Response; readonly apply?: () => void } => {
    if ((body as { readonly query: string }).query.includes("markPullRequestReadyForReview")) {
      const id = (body as { readonly variables: { readonly id: string } }).variables.id
      const pull = [...github.pulls.values()].find((candidate) => `PR_${candidate.number}` === id)
      if (pull === undefined) {
        return { response: json({ data: { markPullRequestReadyForReview: null }, errors: [{ message: "Could not resolve to a node" }] }) }
      }
      return {
        response: json({ data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } }),
        apply: () => void (pull.draft = false),
      }
    }
    if ((body as { readonly query: string }).query.includes("updatePullRequestBranch")) return updateBranch(body, login)
    const input = (body as { readonly variables: { readonly input: unknown } }).variables.input as {
      readonly branch: { readonly repositoryNameWithOwner: string; readonly branchName: string }
      readonly expectedHeadOid: string
      readonly message: { readonly headline: string; readonly body?: string }
      readonly fileChanges: {
        readonly additions: ReadonlyArray<{ readonly path: string; readonly contents: string }>
        readonly deletions: ReadonlyArray<{ readonly path: string }>
      }
    }
    if (input.branch.repositoryNameWithOwner.toLowerCase() !== `${owner}/${name}`.toLowerCase()) {
      return { response: json({ data: null, errors: [{ type: "NOT_FOUND", message: "Could not resolve to a Repository" }] }) }
    }
    const head = github.refs.get(input.branch.branchName)
    if (head === undefined) return { response: json({ data: null, errors: [{ type: "NOT_FOUND", message: "No branch" }] }) }
    if (head !== input.expectedHeadOid) {
      return {
        response: json({
          data: { createCommitOnBranch: null },
          errors: [{ type: "STALE_DATA", message: `Expected branch to point to "${input.expectedHeadOid}" but it did not.` }],
        }),
      }
    }
    const files = new Map(github.commits.get(head)!.files)
    for (const addition of input.fileChanges.additions) {
      files.set(addition.path, new TextDecoder().decode(Uint8Array.from(atob(addition.contents), (c) => c.charCodeAt(0))))
    }
    for (const deletion of input.fileChanges.deletions) files.delete(deletion.path)
    const message = input.message.body === undefined ? input.message.headline : `${input.message.headline}\n\n${input.message.body}`
    const sha = (commitIds + 1).toString(16).padStart(40, "c")
    return {
      response: json({ data: { createCommitOnBranch: { commit: { oid: sha } } } }),
      apply: () => {
        commit(message, [head], files, login)
        github.refs.set(input.branch.branchName, sha)
      },
    }
  }

  /**
   * GraphQL `updatePullRequestBranch`, as GitHub's Update branch: the base's head taken into the pull request's branch,
   * fenced by `expectedHeadOid`; `MERGE` (the default) makes a merge commit, `REBASE` rewrites the branch as one commit
   * on the base's head holding the same files. A conflict, a moved head and an unknown node are GraphQL errors.
   */
  const updateBranch = (body: unknown, login: string): { readonly response: Response; readonly apply?: () => void } => {
    const variables = (body as { readonly variables: Record<string, unknown> }).variables
    const input = (variables["input"] ?? variables) as {
      readonly pullRequestId: string
      readonly expectedHeadOid?: string
      readonly updateMethod?: "MERGE" | "REBASE"
    }
    const failed = (type: string, message: string) => ({ response: json({ data: { updatePullRequestBranch: null }, errors: [{ type, message }] }) })
    const pull = [...github.pulls.values()].find((candidate) => `PR_${candidate.number}` === input.pullRequestId)
    if (pull === undefined) return failed("NOT_FOUND", "Could not resolve to a node")
    const head = github.refs.get(pull.head)!
    if (input.expectedHeadOid !== undefined && input.expectedHeadOid !== head) {
      return failed("UNPROCESSABLE", "expected head sha didn't match current head ref")
    }
    const base = github.refs.get(pull.base)!
    const files = threeWay(head, base)
    if (files === null) return failed("UNPROCESSABLE", "merge conflict between base and head")
    const updated = (headRefOid: string) => json({ data: { updatePullRequestBranch: { pullRequest: { headRefOid } } } })
    if (files === "held") return { response: updated(head) }
    const sha = (commitIds + 1).toString(16).padStart(40, "c")
    const rebase = input.updateMethod === "REBASE"
    return {
      response: updated(sha),
      apply: () => {
        commit(rebase ? github.commits.get(head)!.message : `Merge branch '${pull.base}' into ${pull.head}`, rebase ? [base] : [head, base], files, login)
        github.refs.set(pull.head, sha)
      },
    }
  }

  const pullJson = (pull: ScriptedPull) => {
    const issue = github.issues.get(pull.number)!
    const headSha = github.refs.get(pull.head) ?? ""
    const changed = changedBetween(headFiles(pull.base), headFiles(pull.head))
    return {
      id: 9_000 + pull.number,
      node_id: `PR_${pull.number}`,
      number: pull.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      draft: pull.draft,
      merged: pull.merged,
      merged_at: pull.merged ? iso(issue.closedAt ?? github.now) : null,
      merge_commit_sha: pull.mergeSha,
      merged_by: user(pull.mergedBy),
      mergeable_state: pull.draft
        ? "draft"
        : github.unmergeable
        ? "blocked"
        : github.refs.has(pull.head) && github.refs.has(pull.base) && threeWay(github.refs.get(pull.head)!, github.refs.get(pull.base)!) === null
        ? "dirty"
        : "clean",
      user: user(issue.login),
      head: { ref: pull.head, sha: headSha },
      base: { ref: pull.base, sha: pull.baseSha, repo: { default_branch: "main" } },
      commits: 1,
      additions: changed.reduce((sum, file) => sum + file.additions, 0),
      deletions: changed.reduce((sum, file) => sum + file.deletions, 0),
      changed_files: changed.length,
      created_at: iso(issue.createdAt),
      updated_at: iso(issue.updatedAt),
      closed_at: issue.closedAt === null ? null : iso(issue.closedAt),
    }
  }

  const squash = (pull: ScriptedPull, login: string, title?: string) => {
    const issue = github.issues.get(pull.number)!
    const sha = commit(title ?? `${issue.title} (#${pull.number})`, [github.refs.get(pull.base)!], headFiles(pull.head), login)
    github.refs.set(pull.base, sha)
    pull.merged = true
    pull.mergeSha = sha
    pull.mergedBy = login
    issue.state = "closed"
    issue.closedAt = tick()
    issue.updatedAt = github.now
    return sha
  }

  /** Every ancestor of commit `sha`, itself included. */
  const ancestors = (sha: string): Set<string> => {
    const seen = new Set<string>()
    const walk = [sha]
    while (walk.length > 0) {
      const at = walk.pop()!
      if (seen.has(at)) continue
      seen.add(at)
      walk.push(...(github.commits.get(at)?.parents ?? []))
    }
    return seen
  }

  interface MergeInput {
    readonly base: string
    readonly head: string
    readonly commit_message?: string
  }

  /**
   * Commit `theirs` merged into commit `ours`: `held` when `ours` holds it already, `null` for a conflict, else the files
   * of a three-way merge from the nearest common ancestor.
   */
  const threeWay = (ours: string, theirs: string): "held" | Map<string, string> | null => {
    const held = ancestors(ours)
    if (held.has(theirs)) return "held"
    const theirsAncestors = ancestors(theirs)
    const common = [...held].filter((sha) => theirsAncestors.has(sha))
      .sort((a, b) => github.commits.get(b)!.at - github.commits.get(a)!.at)[0]
    const base = common === undefined ? new Map<string, string>() : github.commits.get(common)!.files
    const mine = github.commits.get(ours)!.files
    const other = github.commits.get(theirs)!.files
    const files = new Map<string, string>()
    for (const path of new Set([...base.keys(), ...mine.keys(), ...other.keys()])) {
      const [b, o, t] = [base.get(path), mine.get(path), other.get(path)]
      const merged = o === t ? o : o === b ? t : t === b ? o : null
      if (merged === null) return null
      if (merged !== undefined) files.set(path, merged)
    }
    return files
  }

  /**
   * `POST /merges`, as GitHub merges a branch or commit into a branch: 204 when the branch holds it already, 409 for a
   * conflict, else a merge commit whose files are a three-way merge from the nearest common ancestor.
   */
  const mergeInto = (input: MergeInput, login: string): { readonly response: Response; readonly apply?: () => void } => {
    const ours = github.refs.get(input.base)
    const theirs = /^[0-9a-f]{40}$/.test(input.head) && github.commits.has(input.head) ? input.head : github.refs.get(input.head)
    if (ours === undefined || theirs === undefined) return { response: json({ message: "Base or head does not exist" }, 404) }
    const files = threeWay(ours, theirs)
    if (files === "held") return { response: new Response(null, { status: 204 }) }
    if (files === null) return { response: json({ message: "Merge conflict" }, 409) }
    const sha = (commitIds + 1).toString(16).padStart(40, "c")
    return {
      response: json({ sha, commit: { message: input.commit_message ?? "Merge" } }, 201),
      apply: () => {
        commit(input.commit_message ?? `Merge ${input.head} into ${input.base}`, [ours, theirs], files, login)
        github.refs.set(input.base, sha)
      },
    }
  }

  /** The pull request, branch, commit and comparison endpoints, or `undefined` for any other path. */
  const pullsAnswer = (
    method: string,
    url: URL,
    rest: string,
    login: string,
    body: unknown,
  ): { readonly response: Response; readonly apply?: () => void } | undefined => {
    const matching = /^\/git\/matching-refs\/heads\/(.+)$/.exec(rest)
    if (matching !== null && method === "GET") {
      const names = [...github.refs.keys()].filter((branch) => branch.startsWith(matching[1]!)).sort()
      return { response: paged(url, names.map(refJson)) }
    }
    const ref = /^\/git\/ref\/heads\/(.+)$/.exec(rest)
    if (ref !== null && method === "GET") {
      return { response: github.refs.has(ref[1]!) ? json(refJson(ref[1]!)) : json({ message: "Not Found" }, 404) }
    }
    if (rest === "/git/refs" && method === "POST") {
      const input = body as { readonly ref: string; readonly sha: string }
      const branch = input.ref.replace(/^refs\/heads\//, "")
      if (github.refs.has(branch)) return { response: json({ message: "Reference already exists" }, 422) }
      return {
        response: json({ ref: input.ref, object: { sha: input.sha, type: "commit" } }, 201),
        apply: () => void github.refs.set(branch, input.sha),
      }
    }
    const gitCommit = /^\/git\/commits\/([0-9a-f]{40})$/.exec(rest)
    if (gitCommit !== null && method === "GET") {
      const found = github.commits.get(gitCommit[1]!)
      if (found === undefined) return { response: json({ message: "Not Found" }, 404) }
      return {
        response: json({
          sha: found.sha,
          message: found.message,
          tree: { sha: `tree-${found.sha}` },
          parents: found.parents.map((sha) => ({ sha })),
        }),
      }
    }
    const compared = /^\/compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})$/.exec(rest)
    if (compared !== null && method === "GET") {
      const from = github.commits.get(compared[1]!)
      const to = github.commits.get(compared[2]!)
      if (from === undefined || to === undefined) return { response: json({ message: "Not Found" }, 404) }
      // GitHub counts the commits each side holds that the other doesn't.
      const ancestors = (sha: string) => {
        const seen = new Set<string>()
        const walk = [sha]
        while (walk.length > 0) {
          const next = walk.pop()!
          if (seen.has(next)) continue
          seen.add(next)
          walk.push(...(github.commits.get(next)?.parents ?? []))
        }
        return seen
      }
      const [base, head] = [ancestors(from.sha), ancestors(to.sha)]
      const aheadBy = [...head].filter((sha) => !base.has(sha)).length
      const behindBy = [...base].filter((sha) => !head.has(sha)).length
      const commits = [...head].filter((sha) => !base.has(sha)).map((sha) => github.commits.get(sha)!)
        .sort((a, b) => a.at - b.at)
        .map((each) => ({
          sha: each.sha,
          commit: { message: each.message, author: { name: each.login ?? "ghost", date: iso(each.at) } },
          author: user(each.login),
        }))
      return {
        response: json({ ahead_by: aheadBy, behind_by: behindBy, total_commits: aheadBy, commits, files: changedBetween(from.files, to.files) }),
      }
    }
    if (rest === "/pulls" && method === "GET") {
      const head = url.searchParams.get("head")
      const state = url.searchParams.get("state") ?? "open"
      const listed = [...github.pulls.values()]
        .filter((pull) => head === null || `${owner}:${pull.head}`.toLowerCase() === head.toLowerCase())
        .filter((pull) => state === "all" || github.issues.get(pull.number)!.state === state)
        .sort((a, b) => b.number - a.number)
        .map((pull) => {
          const { merged: _merged, merged_by: _by, mergeable_state: _state, commits: _commits, ...listing } = pullJson(pull)
          return listing
        })
      return { response: paged(url, listed) }
    }
    if (rest === "/pulls" && method === "POST") {
      const input = body as { readonly head: string; readonly base: string; readonly title: string; readonly body: string; readonly draft?: boolean }
      if (!github.refs.has(input.head)) return { response: json({ message: "Validation Failed", errors: [{ field: "head" }] }, 422) }
      if (changedBetween(headFiles(input.base), headFiles(input.head)).length === 0) {
        return { response: json({ message: `No commits between ${input.base} and ${input.head}` }, 422) }
      }
      const open = [...github.pulls.values()].some((pull) =>
        pull.head === input.head && pull.base === input.base && github.issues.get(pull.number)!.state === "open"
      )
      if (open) return { response: json({ message: "A pull request already exists" }, 422) }
      const issue: ScriptedIssue = {
        id: (ids += 1),
        number: (numbers += 1),
        title: input.title,
        body: input.body,
        state: "open",
        login,
        createdAt: tick(),
        updatedAt: github.now,
        closedAt: null,
        pull: true,
        gone: false,
        comments: [],
        labels: [],
      }
      const pull: ScriptedPull = {
        number: issue.number,
        head: input.head,
        base: input.base,
        baseSha: github.refs.get(input.base) ?? "",
        draft: input.draft === true,
        merged: false,
        mergeSha: null,
        mergedBy: null,
        reviews: [],
      }
      github.issues.set(issue.number, issue)
      github.pulls.set(pull.number, pull)
      const answered = json(pullJson(pull), 201)
      github.issues.delete(issue.number)
      github.pulls.delete(pull.number)
      return {
        response: answered,
        apply: () => {
          github.issues.set(issue.number, issue)
          github.pulls.set(pull.number, pull)
          github.onPullOpened?.(pull.number)
        },
      }
    }
    if (rest === "/merges" && method === "POST") return mergeInto(body as MergeInput, login)
    const one = /^\/pulls\/(\d+)(\/[a-z]+)?$/.exec(rest)
    if (one === null) return undefined
    const pull = github.pulls.get(Number(one[1]))
    if (pull === undefined) return { response: json({ message: "Not Found" }, 404) }
    const issue = github.issues.get(pull.number)!
    const tail = one[2]
    if (tail === undefined && method === "GET") return { response: json(pullJson(pull)) }
    if (tail === undefined && method === "PATCH" && (body as { readonly base?: string }).base !== undefined) {
      const base = (body as { readonly base: string }).base
      if (!github.refs.has(base) || issue.state === "closed") {
        return { response: json({ message: "Validation Failed", errors: [{ field: "base" }] }, 422) }
      }
      const baseSha = github.refs.get(base)!
      return {
        response: json({ ...pullJson(pull), base: { ...pullJson(pull).base, ref: base, sha: baseSha } }),
        apply: () => { pull.base = base; pull.baseSha = baseSha },
      }
    }
    if (tail === undefined && method === "PATCH") {
      return {
        response: json({ ...pullJson(pull), state: "closed" }),
        apply: () => {
          if (issue.state === "closed") return
          issue.state = "closed"
          issue.closedAt = tick()
          issue.updatedAt = github.now
        },
      }
    }
    if (tail === "/merge" && method === "PUT") {
      const input = body as {
        readonly sha: string
        readonly merge_method: string
        readonly commit_title?: string
        readonly commit_message?: string
      }
      if (pull.merged || issue.state === "closed" || pull.draft || github.unmergeable) {
        return { response: json({ message: "Pull Request is not mergeable" }, 405) }
      }
      if (github.refs.get(pull.head) !== input.sha) {
        return { response: json({ message: "Head branch was modified. Review and try the merge again." }, 409) }
      }
      const sha = (commitIds + 1).toString(16).padStart(40, "c")
      return {
        response: json({ sha, merged: true, message: "Pull Request successfully merged" }),
        // A rebase writes the head's commit again with its own message; squash and merge write the title and message.
        apply: () =>
          void squash(
            pull,
            login,
            input.merge_method === "rebase"
              ? github.commits.get(input.sha)!.message
              : [input.commit_title ?? `${issue.title} (#${pull.number})`, input.commit_message]
                .filter((part) => part !== undefined && part !== "").join("\n\n"),
          ),
      }
    }
    if (tail === "/commits" && method === "GET") {
      const head = github.commits.get(github.refs.get(pull.head) ?? "")
      return {
        response: paged(url, head === undefined ? [] : [{
          sha: head.sha,
          // A commit no account made carries no author at all, as GitHub's `commit.author` may be null.
          commit: { message: head.message, author: head.login === null ? null : { name: head.login, date: iso(head.at) } },
          author: user(head.login),
        }]),
      }
    }
    if (tail === "/reviews" && method === "GET") {
      return {
        response: paged(url, pull.reviews.map((review) => ({
          id: review.id,
          node_id: `PRR_${review.id}`,
          user: user(review.login),
          body: review.body,
          state: review.event === "COMMENT" ? "COMMENTED" : review.event === "APPROVE" ? "APPROVED" : "CHANGES_REQUESTED",
          commit_id: review.commitId,
          submitted_at: iso(review.at),
        }))),
      }
    }
    if (tail === "/reviews" && method === "POST") {
      const input = body as { readonly commit_id: string; readonly event: string; readonly body: string }
      const review = { id: (ids += 1), login, event: input.event, body: input.body, commitId: input.commit_id, at: tick() }
      return {
        response: json({
          id: review.id,
          node_id: `PRR_${review.id}`,
          user: user(login),
          body: review.body,
          state: review.event === "COMMENT" ? "COMMENTED" : review.event === "APPROVE" ? "APPROVED" : "CHANGES_REQUESTED",
          commit_id: review.commitId,
          submitted_at: iso(review.at),
        }),
        apply: () => void pull.reviews.push(review),
      }
    }
    return { response: json({ message: "Not Found" }, 404) }
  }

  /** Who a request's `Authorization` names: the App's JWT, an installation token, a user, or nobody. */
  const caller = (authorization: string | undefined): { readonly token: Call["token"] | "installation-contents"; readonly login?: string } => {
    const bearer = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : undefined
    if (bearer === undefined) return { token: "none" }
    const permissions = installationTokens.get(bearer)
    if (permissions?.["contents"] !== undefined) return { token: "installation-contents", login: BOT_LOGIN }
    if (permissions !== undefined) return { token: "installation", login: BOT_LOGIN }
    const login = userTokens.get(bearer)
    if (login !== undefined) return { token: "user", login }
    const parts = bearer.split(".")
    if (parts.length === 3) {
      const claims = JSON.parse(decoder.decode(Uint8Array.from(atob(parts[1]!.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0))))
      if (claims.iss === APP_ID) return { token: "jwt" }
    }
    return { token: "none" }
  }

  const http = HttpClient.make((request, url) =>
    Effect.suspend(() => {
      const method = request.method
      const who = caller(request.headers["authorization"])
      github.calls.push({ method, path: url.pathname, token: who.token === "installation-contents" ? "installation" : who.token })
      const raw = request.body._tag === "Uint8Array" ? decoder.decode(request.body.body) : undefined
      const body: unknown = raw === undefined || raw === "" ? undefined : JSON.parse(raw)
      const fault = github.faults.findIndex((candidate) => candidate.match(method, url.pathname))
      const armed = fault === -1 ? undefined : github.faults.splice(fault, 1)[0]
      if (armed?.hold !== undefined) return Effect.promise(armed.hold).pipe(Effect.andThen(respond(request, url, method, who, body, armed)))
      return respond(request, url, method, who, body, armed)
    })
  )

  /** GitHub's answer to one request, once any hold on it is over. */
  const respond = (
    request: Parameters<Parameters<typeof HttpClient.make>[0]>[0],
    url: URL,
    method: string,
    who: ReturnType<typeof caller>,
    body: unknown,
    armed: Fault | undefined,
  ) =>
    Effect.suspend(() => {
      if (armed !== undefined && armed.lost !== true && armed.malformed !== true && armed.hold === undefined) {
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, json({ message: "scripted fault" }, armed.status ?? 502, { ...armed.headers })),
        )
      }
      // An installation token writes only with the permission it was minted with: issues and labels need Issues, branches
      // and commits Contents, pull requests and their reviews Pull requests, commit statuses Commit statuses.
      const writing = method === "POST" || method === "DELETE" || method === "PATCH" || method === "PUT"
      const scoped = url.pathname.startsWith(apiPath) || url.pathname === "/graphql"
      if ((who.token === "installation" || who.token === "installation-contents") && writing && scoped) {
        const bearer = request.headers["authorization"]!.slice("Bearer ".length)
        const rest = url.pathname.slice(apiPath.length)
        const scope = url.pathname === "/graphql" || rest.startsWith("/git/")
          ? "contents"
          : rest === "/merges"
          ? "contents"
          : rest.startsWith("/pulls")
          ? "pull_requests"
          : rest.startsWith("/statuses/")
          ? "statuses"
          : "issues"
        if (installationTokens.get(bearer)?.[scope] !== "write") {
          return Effect.succeed(
            HttpClientResponse.fromWeb(request, json({ message: "Resource not accessible by integration" }, 403)),
          )
        }
      }
      const answered = answer(method, url, who.token, who.login, body)
      answered.apply?.()
      if (armed?.malformed === true) return Effect.succeed(HttpClientResponse.fromWeb(request, json({})))
      if (armed?.lost === true) {
        return Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request, cause: new Error("scripted lost answer") }),
          }),
        )
      }
      return Effect.succeed(HttpClientResponse.fromWeb(request, answered.response))
    })

  const github: ScriptedGitHub = {
    http,
    layer: Layer.succeed(HttpClient.HttpClient, http),
    owner,
    name,
    issues: new Map(),
    calls: [],
    faults: [],
    installed: true,
    granted: "write",
    contentsGranted: true,
    statusesGranted: true,
    statuses: new Map(),
    shownStatuses: (sha) =>
      Object.fromEntries((github.statuses.get(sha) ?? []).map((status) => [status.context, status.state])),
    labels: new Map(),
    files: new Map(),
    roles: new Map(),
    accounts: new Map(),
    private: false,
    now: Date.now(),
    minted: [],
    userToken: (login) => {
      const token = `ghu_scripted_${(users += 1)}`
      userTokens.set(token, login)
      return Redacted.make(token)
    },
    revoke: (token) => void userTokens.delete(Redacted.value(token)),
    open: (title, body, login = "octocat") => {
      const issue: ScriptedIssue = {
        id: (ids += 1),
        number: (numbers += 1),
        title,
        body,
        state: "open",
        login,
        createdAt: tick(),
        updatedAt: github.now,
        closedAt: null,
        pull: false,
        gone: false,
        comments: [],
        labels: [],
      }
      github.issues.set(issue.number, issue)
      return issue
    },
    comment: (number, body, login = "octocat") => {
      const issue = github.issues.get(number)!
      const comment: ScriptedComment = {
        id: (ids += 1),
        issue: number,
        body,
        login,
        createdAt: tick(),
        updatedAt: github.now,
        gone: false,
      }
      issue.comments.push(comment)
      issue.updatedAt = github.now
      return comment
    },
    retitle: (number, title) => {
      const issue = github.issues.get(number)!
      issue.title = title
      issue.updatedAt = tick()
    },
    relabel: (number, labels) => {
      const issue = github.issues.get(number)!
      issue.labels = [...labels]
      issue.updatedAt = tick()
    },
    remove: (number) => void (github.issues.get(number)!.gone = true),
    removeComment: (id) => {
      for (const issue of github.issues.values()) {
        const comment = issue.comments.find((candidate) => candidate.id === id)
        if (comment !== undefined) {
          comment.gone = true
          issue.updatedAt = tick()
        }
      }
    },
    seen: (method, pattern) => github.calls.filter((call) => call.method === method && pattern.test(call.path)),
    pullsGranted: "write",
    refs: new Map(),
    commits: new Map(),
    pulls: new Map(),
    unmergeable: false,
    onPullOpened: undefined,
    push: (branch, files, login = "octocat") => {
      // A new branch starts from main, as a person's `git push` of a branch made from it does.
      if (!github.refs.has(branch)) github.refs.set(branch, github.refs.get("main")!)
      const tree = new Map(headFiles(branch))
      for (const [path, text] of Object.entries(files)) {
        if (text === null) tree.delete(path)
        else tree.set(path, text)
      }
      const parents = github.refs.has(branch) ? [github.refs.get(branch)!] : []
      const sha = commit(`Update ${Object.keys(files).join(", ")}`, parents, tree, login)
      github.refs.set(branch, sha)
      return sha
    },
    merge: (number, login = "octocat") => squash(github.pulls.get(number)!, login),
    close: (number) => {
      const issue = github.issues.get(number)!
      issue.state = "closed"
      issue.closedAt = tick()
      issue.updatedAt = github.now
    },
    tree: (branch) => headFiles(branch),
    openPull: (head, title = "A change", login = "octocat") => {
      const issue: ScriptedIssue = {
        id: (ids += 1),
        number: (numbers += 1),
        title,
        body: "",
        state: "open",
        login,
        createdAt: tick(),
        updatedAt: github.now,
        closedAt: null,
        pull: true,
        gone: false,
        comments: [],
        labels: [],
      }
      const pull: ScriptedPull = {
        number: issue.number,
        head,
        base: "main",
        baseSha: github.refs.get("main")!,
        draft: false,
        merged: false,
        mergeSha: null,
        mergedBy: null,
        reviews: [],
      }
      github.issues.set(issue.number, issue)
      github.pulls.set(pull.number, pull)
      return pull
    },
  }
  github.refs.set("main", commit("Initial commit", [], new Map([["README.md", "# Widgets\n"]]), "octocat"))
  return github
}

/** A fresh RSA key, as GitHub would issue an App, in PKCS#8 PEM (`GitHub.AppAuth` takes PKCS#1 or PKCS#8). */
export const appKey = async (): Promise<Redacted.Redacted<string>> => {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )
  const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey))
  const base64 = btoa(String.fromCharCode(...der)).replace(/(.{64})/g, "$1\n")
  return Redacted.make(`-----BEGIN PRIVATE KEY-----\n${base64}\n-----END PRIVATE KEY-----\n`)
}

/** The App over the scripted GitHub, as `GitHub.AppAuth` makes it with `key`. */
export const scriptedApp = (github: ScriptedGitHub, key: Redacted.Redacted<string>) =>
  GitHub.AppAuth.make({ appId: APP_ID, privateKey: key, apiBaseUrl: SCRIPTED_API }).pipe(Effect.provide(github.layer))

/** The scripted GitHub's REST origin. */
export const SCRIPTED_API = "https://api.github.test"

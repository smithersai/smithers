// GitHub's API, scripted, as RepoApi's about route reaches it (docs/features/repo.md#about): a third-party provider,
// scripted like the model and Code Storage, on the fetch seam. It answers the reads the about route makes, from the
// repositories a test publishes, with GitHub's own shapes: base64 READMEs, `Link` headers that name the last page of a
// one-item page, 404 for a missing release or README, 202 with no body while GitHub computes contributors. It answers
// GraphQL's `repository` only to a token, as GitHub does, resolving each `object(expression: "HEAD:<path>")` from the
// repository's files; and, as the Smithers App, the installation of a repository a test installs it on and that
// installation's tokens, to an App's JWT. A test arms a fault per path suffix (`graphql`, `access_tokens` and
// `/installation` included): a status, or a rate limit; and can hold every answer until it releases them. The real
// GitHub is the e2e tests'.

/** Where GitHub's REST API is, unless `GITHUB_API_URL` says otherwise. */
export const GITHUB_API = "https://api.github.com"

/** A repository on the scripted GitHub, in about's terms. */
export interface RestRepository {
  readonly fullName: string
  readonly description: string | null
  readonly homepage: string | null
  readonly topics: ReadonlyArray<string>
  readonly stars: number
  readonly forks: number
  readonly watchers: number
  readonly license: { readonly spdx: string | null; readonly name: string | null } | null
  readonly defaultBranch: string
  readonly archived: boolean
  readonly private: boolean
  readonly languages: Readonly<Record<string, number>>
  readonly release: { readonly tag: string; readonly name: string | null; readonly publishedAt: string } | null
  readonly releases: number
  /** `null`: GitHub is still computing them, and answers 202 with no body. */
  readonly contributors: ReadonlyArray<{ readonly login?: string; readonly avatar?: string }> | null
  readonly contributorCount: number
  readonly readme: { readonly path: string; readonly text: string; readonly size?: number } | null
  /** `.smithers/home.json` at the newest commit, which puts `.smithers` in the top folder; none when absent. */
  readonly home?: { readonly text: string; readonly size?: number }
  readonly root: ReadonlyArray<{ readonly name: string; readonly type: string }> | null
  /** Newest first. */
  readonly commits: ReadonlyArray<{
    readonly sha: string
    readonly message: string
    readonly name: string | null
    readonly date: string | null
    readonly login: string | null
  }>
  readonly branches: number
  readonly tags: number
}

/** `octocat/Spoon-Knife` as GitHub tells it: the repository the e2e tests open. */
export const spoonKnife = (overrides: Partial<RestRepository> = {}): RestRepository => ({
  fullName: "octocat/Spoon-Knife",
  description: "This repo is for demonstration purposes only.",
  homepage: "",
  topics: ["demo", "forking"],
  stars: 14126,
  forks: 160292,
  watchers: 908,
  license: { spdx: "MIT", name: "MIT License" },
  defaultBranch: "main",
  archived: false,
  private: false,
  languages: { HTML: 355, CSS: 256 },
  release: { tag: "v1.0.0", name: "First", publishedAt: "2026-10-01T12:00:00Z" },
  releases: 2,
  contributors: [{ login: "octocat", avatar: "https://avatars.githubusercontent.com/u/583231?v=4" }, {}],
  contributorCount: 2,
  readme: { path: "README.md", text: "### Well hello there!\n\nFork me.\n" },
  root: [{ name: "README.md", type: "file" }, { name: "index.html", type: "file" }, { name: "docs", type: "dir" }],
  commits: [{
    sha: "d0dd1f61b33d64e29d8bc1372a94ef6a2fee76a9",
    message: "Pointing to the guide for forking",
    name: "The Octocat",
    date: "2014-02-12T23:20:44Z",
    login: "octocat",
  }],
  branches: 3,
  tags: 0,
  ...overrides,
})

/** The installation the scripted Smithers App has on the repositories a test installs it on. */
export const ABOUT_INSTALLATION_ID = 91

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })

const notFound = () => json(404, { message: "Not Found" })

/** A one-item page of a list `total` long, with the `Link` header GitHub sends for it. */
const counted = (url: URL, total: number, first: unknown) =>
  json(200, total === 0 ? [] : [first], total > 1 ? {
    link: `<${url.origin}${url.pathname}?per_page=1&page=2>; rel="next", ` +
      `<${url.origin}${url.pathname}?per_page=1&page=${total}>; rel="last"`,
  } : {})

const base64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)))

/** A repository's top folder: with `.smithers` when it has a home, as a real repository with one does. */
const rootOf = (repository: RestRepository) =>
  repository.root === null || repository.home === undefined || repository.root.some((entry) => entry.name === ".smithers")
    ? repository.root
    : [{ name: ".smithers", type: "dir" }, ...repository.root]

/** Git's entry type for a REST content type: a folder is a tree, a submodule a commit, a file or a symlink a blob. */
const gitType = (type: string) =>
  type === "dir" ? "tree" : type === "submodule" ? "commit" : type === "file" || type === "symlink" ? "blob" : type

/** A blob as GraphQL's `... on Blob` answers it: no text for a binary file. */
const blob = (text: string, size?: number) => {
  const binary = text.includes("\u0000")
  return { text: binary ? null : text, byteSize: size ?? new TextEncoder().encode(text).length, isBinary: binary, isTruncated: false }
}

/** What GraphQL's `object(expression: "HEAD:<path>")` answers in `repository`: a tree, a blob, a folder (`{}`), or none. */
const objectAt = (repository: RestRepository, path: string): unknown => {
  if (repository.commits.length === 0) return null
  const root = rootOf(repository)
  if (path === "") return root === null ? null : { entries: root.map((entry) => ({ name: entry.name, type: gitType(entry.type) })) }
  if (repository.readme !== null && path === repository.readme.path) return blob(repository.readme.text, repository.readme.size)
  if (repository.home !== undefined && path === ".smithers/home.json") return blob(repository.home.text, repository.home.size)
  return root?.some((entry) => entry.name === path && entry.type === "dir") === true ? {} : null
}

/** GraphQL's `repository` for `query`, with each aliased `object` the query asks for. */
const graphOf = (repository: RestRepository, query: string) => {
  const newest = repository.commits[0]
  const objects = Object.fromEntries(
    [...query.matchAll(/(\w+): object\(expression: "HEAD:([^"]*)"\)/g)].map(([, alias, path]) => [alias!, objectAt(repository, path!)]),
  )
  return {
    nameWithOwner: repository.fullName,
    description: repository.description,
    homepageUrl: repository.homepage,
    isPrivate: repository.private,
    isArchived: repository.archived,
    stargazerCount: repository.stars,
    forkCount: repository.forks,
    watchers: { totalCount: repository.watchers },
    licenseInfo: repository.license === null ? null : { spdxId: repository.license.spdx, name: repository.license.name },
    repositoryTopics: { nodes: repository.topics.map((name) => ({ topic: { name } })) },
    languages: {
      edges: Object.entries(repository.languages).sort(([, left], [, right]) => right - left).map(([name, size]) => ({ size, node: { name } })),
    },
    latestRelease: repository.release === null
      ? null
      : { tagName: repository.release.tag, name: repository.release.name, publishedAt: repository.release.publishedAt },
    releases: { totalCount: repository.releases },
    branches: { totalCount: repository.branches },
    tags: { totalCount: repository.tags },
    // An empty repository has no default branch.
    defaultBranchRef: newest === undefined ? null : {
      name: repository.defaultBranch,
      target: {
        oid: newest.sha,
        message: newest.message,
        author: { name: newest.name, date: newest.date, user: newest.login === null ? null : { login: newest.login } },
        history: { totalCount: repository.commits.length },
      },
    },
    ...objects,
  }
}

/** Whether a request carries an App's JWT: three base64url parts, the first a JWT header. */
const isJwt = (authorization: string | null) =>
  authorization !== null && /^Bearer eyJ[\w-]*\.[\w-]+\.[\w-]+$/.test(authorization)

/**
 * A scripted GitHub: `fetch` answers; `publish` adds a repository; `install` installs the Smithers App on one; `fail`
 * arms a fault on a path suffix; `hold` keeps every answer until its release.
 */
export const scriptedGitHub = () => {
  const repositories = new Map<string, RestRepository>()
  const installed = new Set<string>()
  const faults = new Map<string, number | "rate_limited" | "network">()
  const answers = new Map<string, (url: URL) => Response>()
  const calls: Array<string> = []
  const authorizations: Array<string | null> = []
  const minted: Array<{ readonly token: string; readonly repositories: unknown; readonly permissions: unknown }> = []
  let held: Promise<void> | undefined
  let holding = 0
  const state: { remaining: number | undefined } = { remaining: 59 }

  const answer = (repository: RestRepository, rest: string, url: URL): Response => {
    switch (rest) {
      case "":
        return json(200, {
          full_name: repository.fullName,
          description: repository.description,
          homepage: repository.homepage,
          topics: repository.topics,
          stargazers_count: repository.stars,
          forks_count: repository.forks,
          subscribers_count: repository.watchers,
          watchers_count: repository.stars,
          license: repository.license === null ? null : { spdx_id: repository.license.spdx, name: repository.license.name },
          default_branch: repository.defaultBranch,
          archived: repository.archived,
          private: repository.private,
        })
      case "/languages":
        return json(200, repository.languages)
      case "/releases/latest":
        return repository.release === null ? notFound() : json(200, {
          tag_name: repository.release.tag,
          name: repository.release.name,
          published_at: repository.release.publishedAt,
        })
      case "/releases":
        return counted(url, repository.releases, { tag_name: repository.release?.tag })
      case "/contributors":
        if (url.searchParams.get("per_page") === "1") {
          return counted(url, repository.contributorCount, repository.contributors?.[0] ?? {})
        }
        return repository.contributors === null ? new Response(null, { status: 202 }) : json(
          200,
          repository.contributors.map((person) => ({ login: person.login, avatar_url: person.avatar })),
        )
      case "/readme":
        return repository.readme === null ? notFound() : json(200, {
          path: repository.readme.path,
          size: repository.readme.size ?? new TextEncoder().encode(repository.readme.text).length,
          encoding: "base64",
          content: base64(repository.readme.text).replace(/(.{60})/g, "$1\n"),
        })
      case "/contents/": {
        const root = rootOf(repository)
        return root === null ? notFound() : json(200, root)
      }
      case "/contents/.smithers/home.json":
        // Only at the newest commit, which the read names as `ref`.
        return repository.home === undefined || url.searchParams.get("ref") !== repository.commits[0]?.sha
          ? notFound()
          : json(200, {
            path: ".smithers/home.json",
            size: repository.home.size ?? new TextEncoder().encode(repository.home.text).length,
            encoding: "base64",
            content: base64(repository.home.text),
          })
      case "/commits": {
        const newest = repository.commits[0]
        return counted(url, repository.commits.length, newest === undefined ? undefined : {
          sha: newest.sha,
          commit: { message: newest.message, author: { name: newest.name, date: newest.date } },
          author: newest.login === null ? null : { login: newest.login },
        })
      }
      case "/branches":
        return counted(url, repository.branches, { name: repository.defaultBranch })
      case "/tags":
        return counted(url, repository.tags, { name: "v1.0.0" })
      default:
        return notFound()
    }
  }

  /** The fault armed on `key`, as GitHub would answer it; none when there is none. */
  const faulted = (key: string): Response | undefined => {
    const fault = faults.get(key)
    if (fault === "network") throw new TypeError("fetch failed")
    if (fault === "rate_limited") {
      return json(403, { message: "API rate limit exceeded" }, {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(Math.ceil(Date.now() / 1000) + 600),
      })
    }
    return fault === undefined ? undefined : json(fault, { message: "scripted fault" })
  }

  const respond = async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    const authorization = request.headers.get("authorization")
    const asked = (key: string) => {
      calls.push(key)
      authorizations.push(authorization)
      return faulted(key) ?? answers.get(key)?.(url)
    }
    if (url.pathname === "/graphql" && request.method === "POST") {
      const early = asked("graphql")
      if (early !== undefined) return early
      if (authorization === null) return json(401, { message: "This endpoint requires you to be authenticated." })
      const { query, variables } = await request.json() as { readonly query: string; readonly variables: { readonly owner: string; readonly name: string } }
      const repository = repositories.get(`${variables.owner}/${variables.name}`.toLowerCase())
      return repository === undefined
        ? json(200, { data: { repository: null }, errors: [{ type: "NOT_FOUND", message: "Could not resolve to a Repository" }] })
        : json(200, { data: { repository: graphOf(repository, query) } })
    }
    const mint = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(url.pathname)
    if (mint !== null && request.method === "POST") {
      const early = asked("access_tokens")
      if (early !== undefined) return early
      if (!isJwt(authorization) || Number(mint[1]) !== ABOUT_INSTALLATION_ID) return json(404, { message: "Not Found" })
      const asks = await request.json() as { readonly repositories?: unknown; readonly permissions?: unknown }
      const token = `ghs_about_${minted.length + 1}`
      minted.push({ token, repositories: asks.repositories, permissions: asks.permissions })
      return json(201, { token, expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString() })
    }
    const match = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(url.pathname)
    if (match === null) return notFound()
    const [, owner, name, rest = ""] = match
    const key = `${decodeURIComponent(owner!)}/${decodeURIComponent(name!)}`.toLowerCase()
    const early = asked(rest)
    if (early !== undefined) return early
    if (rest === "/installation") {
      return isJwt(authorization) && installed.has(key) ? json(200, { id: ABOUT_INSTALLATION_ID }) : notFound()
    }
    const repository = repositories.get(key)
    return repository === undefined ? notFound() : answer(repository, rest, url)
  }

  const fetch = async (request: Request): Promise<Response> => {
    if (held !== undefined) {
      holding++
      await held
      holding--
    }
    const response = await respond(request)
    if (!response.headers.has("x-ratelimit-remaining") && state.remaining !== undefined) {
      response.headers.set("x-ratelimit-remaining", String(state.remaining))
    }
    return response
  }

  return {
    fetch,
    /**
     * Every request, in order: the path after `/repos/<owner>/<name>` (`""` for the repository, `/installation` for the
     * App's installation), `graphql`, or `access_tokens` for an installation token.
     */
    calls,
    /** Each request's `Authorization` header, or `null` for an anonymous one, in the order of `calls`. */
    authorizations,
    /** The installation tokens GitHub minted, with the repositories and permissions each was asked for. */
    minted,
    /** The `x-ratelimit-remaining` every answer carries unless a rate limit says 0: 59 unless set; `undefined`, none. */
    state,
    publish: (owner: string, name: string, repository: RestRepository = spoonKnife()) =>
      void repositories.set(`${owner}/${name}`.toLowerCase(), repository),
    /** Installs the Smithers App on `owner/name`. */
    install: (owner: string, name: string) => void installed.add(`${owner}/${name}`.toLowerCase()),
    /** How many requests `hold` is keeping: a test waits on it before releasing them. */
    holding: () => holding,
    /** Holds every answer until the returned release runs. */
    hold: () => {
      let release = () => {}
      held = new Promise<void>((resolve) => (release = () => ((held = undefined), resolve())))
      return release
    },
    /** Arms a fault on every request for `rest` (a `calls` entry) until `clear`: a status, a rate limit, or no answer. */
    fail: (rest: string, fault: number | "rate_limited" | "network") => void faults.set(rest, fault),
    /** Answers every request for `rest` (a `calls` entry) with `body` as JSON until `clear`: GitHub's odd shapes. */
    answer: (rest: string, body: unknown, status = 200) => void answers.set(rest, () => json(status, body)),
    clear: () => {
      faults.clear()
      answers.clear()
    },
  }
}

export type ScriptedGitHub = ReturnType<typeof scriptedGitHub>

import { type Core, GitHub } from "@smthrs/integrations"
import { Home } from "@smthrs/views"
import { Data, Effect, Option, Schema } from "effect"
import {
  ABOUT_CONTRIBUTORS,
  ABOUT_ROOT_ENTRIES,
  installUrl,
  MAX_BLOB_BYTES,
  textOf,
} from "../../src/features/repo/contract.ts"
import type { About, AboutCommit, AboutEntry } from "../../src/features/repo/schema.ts"

// What GitHub says of a repository (docs/features/repo.md#about), read one of two ways through `@smthrs/integrations`'
// `GitHubClient`:
//
// - `graphql`, with a token: one GraphQL query for the repository, its languages, latest release and counts, the
//   newest commit, the top folder, the README and the repository's own home, then the contributors over REST, which
//   GraphQL doesn't have. Two calls, three for more than a page of contributors.
// - `rest`, anonymous (GitHub's GraphQL needs a token): the repository first, then eight parts at once, then only what
//   those answers leave to ask: the latest release when there are releases, the contributors' count when they fill a
//   page, the home when the top folder has `.smithers`. Nine calls for most repositories, twelve at most.
//
// Only the repository must answer. A part GitHub doesn't have (a 404, a 409 for an empty repository) is left out; a
// part GitHub couldn't give now (a rate limit, a 5xx, no answer) is left out too and named in `missing`, so the answer
// is kept for less time and read again sooner.

/** The GitHub operation a refusal or a missing part names. */
export type AboutStage =
  | "repository"
  | "graphql"
  | "languages"
  | "release"
  | "releases"
  | "contributors"
  | "contributor_count"
  | "readme"
  | "root"
  | "commits"
  | "branches"
  | "tags"
  | "home"

/**
 * Why GitHub gave no answer: it has no such public repository (`not_found`), it rate limited the read
 * (`rate_limited`, with its wait and, uncapped, when the limit resets), or it didn't answer (`github_unavailable`).
 */
export class AboutRefused extends Data.TaggedError("AboutRefused")<{
  readonly code: "not_found" | "rate_limited" | "github_unavailable"
  readonly stage: AboutStage
  readonly upstreamStatus?: number
  readonly retryAfterMillis?: number
  readonly resetAtMillis?: number
}> {}

/** One read's answer, and the parts GitHub couldn't give now. */
export interface Read {
  readonly about: About
  readonly missing: ReadonlyArray<AboutStage>
}

type Failure = Core.IntegrationError.IntegrationError

const statusOf = (error: Failure): number | undefined => {
  const status = error.details?.["status"]
  return typeof status === "number" ? status : undefined
}

/** GitHub's finite rate-limit signal, whether explicit or its 429 status. */
const isRateLimited = (error: Failure): boolean => error.details?.["rateLimited"] === true || statusOf(error) === 429

/** A refusal GitHub may not repeat: its rate limit, a 5xx, or no answer at all (a dropped connection, a timeout). */
const isTransient = (error: Failure): boolean => {
  const status = statusOf(error)
  return isRateLimited(error) || (status === undefined ? error.reason === "delivery-failed" : status >= 500)
}

/** The refusal a failed required call answers: GitHub's 404 is `not_found`. */
const refusalOf = (error: Failure, stage: AboutStage): AboutRefused => {
  const status = statusOf(error)
  if (status === 404) return new AboutRefused({ code: "not_found", stage, upstreamStatus: 404 })
  const wait = error.details?.["retryAfterMillis"]
  const reset = error.details?.["rateLimitResetAt"]
  return new AboutRefused({
    code: isRateLimited(error) ? "rate_limited" : "github_unavailable",
    stage,
    ...(status === undefined ? {} : { upstreamStatus: status }),
    ...(typeof wait === "number" ? { retryAfterMillis: wait } : {}),
    ...(typeof reset === "number" ? { resetAtMillis: reset } : {}),
  })
}

/** One optional part's answer: its value, or `null` and whether GitHub only couldn't give it now. */
interface Part<A> {
  readonly stage: AboutStage
  readonly value: A | null
  readonly missing: boolean
}

const part = <A>(stage: AboutStage, effect: Effect.Effect<A, Failure>): Effect.Effect<Part<A>> =>
  effect.pipe(
    Effect.map((value): Part<A> => ({ stage, value, missing: false })),
    Effect.catch((error) => Effect.succeed<Part<A>>({ stage, value: null, missing: isTransient(error) })),
  )

/** A part not asked for, because another part's answer settled it. */
const settled = <A>(stage: AboutStage, value: A | null): Part<A> => ({ stage, value, missing: false })

const missingOf = (parts: ReadonlyArray<Part<unknown>>): ReadonlyArray<AboutStage> =>
  parts.flatMap((each) => (each.missing ? [each.stage] : []))

const nullable = <S extends Schema.Top>(schema: S) => Schema.optional(Schema.NullOr(schema))

// GitHub answers 202 with no body while it computes a large repository's contributors.
const ContributorsJson = Schema.NullOr(
  Schema.Array(Schema.Struct({ login: Schema.optional(Schema.String), avatar_url: Schema.optional(Schema.String) })),
)

const ReadmeJson = Schema.Struct({
  path: Schema.String,
  size: Schema.Number,
  content: Schema.optional(Schema.String),
  encoding: Schema.optional(Schema.String),
})

/** A README's, or a home's, text from GitHub's base64 body: none when it is over the view's limit or isn't text. */
const base64Text = (file: typeof ReadmeJson.Type): string | null => {
  if (file.size > MAX_BLOB_BYTES || file.encoding !== "base64" || file.content === undefined) return null
  try {
    const binary = atob(file.content.replace(/\s/g, ""))
    return textOf(Uint8Array.from(binary, (char) => char.charCodeAt(0))) ?? null
  } catch {
    return null
  }
}

/** An `http(s)` homepage, trimmed; anything else is none. */
const homepageOf = (value: string | null | undefined): string | null => {
  const trimmed = (value ?? "").trim()
  return /^https?:\/\/\S+$/i.test(trimmed) && URL.canParse(trimmed) ? trimmed : null
}

/** GitHub's license as one word: its SPDX id, else its name ("Other" for one GitHub can't name). */
const licenseOf = (license: { readonly spdx: string | null | undefined; readonly name: string | null | undefined } | null) =>
  license === null ? null : license.spdx && license.spdx !== "NOASSERTION" ? license.spdx : license.name ?? null

/** Languages by bytes, largest first, ties by name; empty ones left out. */
const languagesOf = (sizes: ReadonlyArray<readonly [string, number]>) =>
  sizes
    .filter(([, bytes]) => bytes > 0)
    .sort(([leftName, left], [rightName, right]) => right - left || leftName.localeCompare(rightName))
    .map(([name, bytes]) => ({ name, bytes }))

/** Contributors GitHub names with a login and an avatar: the about panel shows only those. */
const contributorsOf = (people: typeof ContributorsJson.Type) =>
  (people ?? []).flatMap((person) =>
    person.login === undefined || person.avatar_url === undefined ? [] : [{ login: person.login, avatarUrl: person.avatar_url }]
  )

/** The first page of contributors and how many there are: the page's length when it isn't full, else a count. */
const contributors = (client: GitHub.GitHubClient.GitHubClient, base: string) =>
  Effect.gen(function* () {
    const list = yield* part(
      "contributors",
      client.request("GET", `${base}/contributors`, undefined, { schema: ContributorsJson, query: { per_page: ABOUT_CONTRIBUTORS } }),
    )
    // A page that isn't full is the whole list, so its length is the count; GitHub counts the same people either way.
    const count = list.value !== null && list.value.length < ABOUT_CONTRIBUTORS
      ? settled("contributor_count", { total: list.value.length })
      : yield* part("contributor_count", client.count(`${base}/contributors`))
    return { list, count }
  })

const decodeCommit = Schema.decodeUnknownOption(Schema.Struct({
  sha: Schema.String,
  commit: Schema.Struct({
    message: Schema.String,
    author: nullable(Schema.Struct({ name: nullable(Schema.String), date: nullable(Schema.String) })),
  }),
  author: nullable(Schema.Struct({ login: Schema.String })),
}))

/** The newest commit, from a `count` of the commits' first item. */
const headOf = (first: unknown): AboutCommit | null =>
  Option.match(decodeCommit(first), {
    onNone: () => null,
    onSome: (commit) => ({
      sha: commit.sha,
      message: commit.commit.message,
      author: commit.author?.login ?? commit.commit.author?.name ?? "",
      at: commit.commit.author?.date ?? "",
    }),
  })

/** A top folder entry as the page shows it: a folder or a file; a type GitHub may add later isn't shown. */
const entryOf = (name: string, kind: "dir" | "file" | undefined): ReadonlyArray<AboutEntry> =>
  kind === undefined ? [] : [{ name, kind }]

/** REST's entry types: a submodule is a folder, a symlink a file. */
const REST_KINDS = new Map<string, "dir" | "file">([["dir", "dir"], ["submodule", "dir"], ["file", "file"], ["symlink", "file"]])

/** Whether a top folder holds a README GitHub would show. */
const isReadme = (name: string) => /^readme(\.[^/]*)?$/i.test(name)

/** The App installation page the answer names. */
const shared = (appSlug: string) => ({ installUrl: installUrl(appSlug) })

// --- REST: anonymous ---

const RepositoryJson = Schema.Struct({
  full_name: Schema.String,
  description: nullable(Schema.String),
  homepage: nullable(Schema.String),
  topics: Schema.optional(Schema.Array(Schema.String)),
  stargazers_count: Schema.Number,
  forks_count: Schema.Number,
  subscribers_count: Schema.optional(Schema.Number),
  watchers_count: Schema.Number,
  license: nullable(Schema.Struct({ spdx_id: nullable(Schema.String), name: nullable(Schema.String) })),
  default_branch: Schema.String,
  archived: Schema.optional(Schema.Boolean),
  private: Schema.optional(Schema.Boolean),
})

const LanguagesJson = Schema.Record(Schema.String, Schema.Number)

const ReleaseJson = Schema.Struct({
  tag_name: Schema.String,
  name: nullable(Schema.String),
  published_at: nullable(Schema.String),
})

const ContentsJson = Schema.Array(Schema.Struct({ name: Schema.String, type: Schema.String }))

const releaseOf = (release: typeof ReleaseJson.Type | null) =>
  release === null
    ? null
    : { tag: release.tag_name, name: release.name?.trim() || null, publishedAt: release.published_at ?? null }

/**
 * What GitHub says of `owner/name` over REST, through `client`: the read for an anonymous caller. `appSlug` names the
 * App whose installation page the answer carries.
 */
export const rest = (client: GitHub.GitHubClient.GitHubClient, owner: string, name: string, appSlug: string) =>
  Effect.gen(function* () {
    const path = yield* GitHub.Repository.requireRepositoryPath(owner, name).pipe(
      Effect.mapError(() => new AboutRefused({ code: "not_found", stage: "repository" })),
    )
    const base = `/repos/${path}`
    const repository = yield* client.request("GET", base, undefined, { schema: RepositoryJson }).pipe(
      Effect.mapError((error) => refusalOf(error, "repository")),
    )
    if (repository.private === true) return yield* new AboutRefused({ code: "not_found", stage: "repository" })
    const [languages, releases, people, readme, root, commits, branches, tags] = yield* Effect.all(
      [
        part("languages", client.request("GET", `${base}/languages`, undefined, { schema: LanguagesJson })),
        part("releases", client.count(`${base}/releases`)),
        contributors(client, base),
        part("readme", client.request("GET", `${base}/readme`, undefined, { schema: ReadmeJson })),
        part("root", client.request("GET", `${base}/contents/`, undefined, { schema: ContentsJson })),
        part("commits", client.count(`${base}/commits`)),
        part("branches", client.count(`${base}/branches`)),
        part("tags", client.count(`${base}/tags`)),
      ] as const,
      { concurrency: "unbounded" },
    )
    const head = commits.value === null ? null : headOf(commits.value.first)
    const rootEntries = root.value?.flatMap((entry) => entryOf(entry.name, REST_KINDS.get(entry.type))) ?? null
    // The latest release only when there are releases, and the home only when the top folder may hold it.
    const [release, home] = yield* Effect.all(
      [
        releases.value?.total === 0
          ? Effect.succeed(settled<typeof ReleaseJson.Type>("release", null))
          : part("release", client.request("GET", `${base}/releases/latest`, undefined, { schema: ReleaseJson })),
        head === null || (root.value !== null && !root.value.some((entry) => entry.name === ".smithers"))
          ? Effect.succeed(settled<typeof ReadmeJson.Type>("home", null))
          : part(
            "home",
            client.request("GET", `${base}/contents/${Home.path}`, undefined, { schema: ReadmeJson, query: { ref: head.sha } }),
          ),
      ] as const,
      { concurrency: "unbounded" },
    )
    const readmeText = readme.value === null ? null : base64Text(readme.value)
    return {
      about: {
        name: repository.full_name,
        description: repository.description?.trim() || null,
        homepage: homepageOf(repository.homepage),
        topics: repository.topics ?? [],
        stars: repository.stargazers_count,
        forks: repository.forks_count,
        watchers: repository.subscribers_count ?? repository.watchers_count,
        license: licenseOf(repository.license === null || repository.license === undefined
          ? null
          : { spdx: repository.license.spdx_id, name: repository.license.name }),
        defaultBranch: repository.default_branch,
        archived: repository.archived ?? false,
        languages: languagesOf(Object.entries(languages.value ?? {})),
        release: releaseOf(release.value),
        releases: releases.value?.total ?? null,
        contributors: contributorsOf(people.list.value),
        contributorCount: people.count.value?.total ?? null,
        commits: commits.value?.total ?? null,
        branches: branches.value?.total ?? null,
        tags: tags.value?.total ?? null,
        head,
        root: rootEntries === null ? null : rootEntries.slice(0, ABOUT_ROOT_ENTRIES),
        readme: readme.value === null || readmeText === null ? null : { path: readme.value.path, text: readmeText },
        home: home.value === null ? null : base64Text(home.value),
        ...shared(appSlug),
      } satisfies About,
      missing: missingOf([languages, releases, people.list, people.count, readme, root, commits, branches, tags, release, home]),
    } satisfies Read
  }).pipe(Effect.withSpan("repo.about.rest"))

// --- GraphQL: with a token ---

/**
 * README paths the query asks for, in the order GitHub picks one: `.github`, then the top folder, then `docs`. A top
 * folder README named otherwise is read over REST.
 */
export const README_PATHS = [
  ".github/README.md",
  "README.md",
  "readme.md",
  "Readme.md",
  "README",
  "README.markdown",
  "README.rst",
  "README.txt",
  "README.adoc",
  "docs/README.md",
] as const

/** The query's alias for a README path. */
export const readmeAlias = (path: string) => `readme${README_PATHS.indexOf(path as (typeof README_PATHS)[number])}`

const BLOB = "... on Blob { text byteSize isBinary isTruncated }"

/** The one GraphQL query: everything the about panel shows but the contributors. */
export const QUERY = `query RepoAbout($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    nameWithOwner description homepageUrl isPrivate isArchived stargazerCount forkCount
    watchers { totalCount }
    licenseInfo { spdxId name }
    repositoryTopics(first: 20) { nodes { topic { name } } }
    languages(first: 100, orderBy: { field: SIZE, direction: DESC }) { edges { size node { name } } }
    latestRelease { tagName name publishedAt }
    releases { totalCount }
    branches: refs(refPrefix: "refs/heads/") { totalCount }
    tags: refs(refPrefix: "refs/tags/") { totalCount }
    defaultBranchRef {
      name
      target { ... on Commit { oid message author { name date user { login } } history { totalCount } } }
    }
    root: object(expression: "HEAD:") { ... on Tree { entries { name type } } }
    home: object(expression: "HEAD:${Home.path}") { ${BLOB} }
${README_PATHS.map((path) => `    ${readmeAlias(path)}: object(expression: "HEAD:${path}") { ${BLOB} }`).join("\n")}
  }
}`

const GraphAnswer = Schema.Struct({
  data: nullable(Schema.Struct({ repository: Schema.NullOr(Schema.Unknown) })),
  errors: Schema.optional(Schema.Array(Schema.Struct({ type: Schema.optional(Schema.String) }))),
})

const Count = Schema.Struct({ totalCount: Schema.Number })

const GraphRepository = Schema.Struct({
  nameWithOwner: Schema.String,
  description: nullable(Schema.String),
  homepageUrl: nullable(Schema.String),
  isPrivate: Schema.Boolean,
  isArchived: Schema.Boolean,
  stargazerCount: Schema.Number,
  forkCount: Schema.Number,
  watchers: Count,
  licenseInfo: nullable(Schema.Struct({ spdxId: nullable(Schema.String), name: nullable(Schema.String) })),
  repositoryTopics: Schema.Struct({ nodes: Schema.Array(Schema.Struct({ topic: Schema.Struct({ name: Schema.String }) })) }),
  languages: nullable(Schema.Struct({
    edges: Schema.Array(Schema.Struct({ size: Schema.Number, node: Schema.Struct({ name: Schema.String }) })),
  })),
  latestRelease: nullable(Schema.Struct({ tagName: Schema.String, name: nullable(Schema.String), publishedAt: nullable(Schema.String) })),
  releases: Count,
  branches: nullable(Count),
  tags: nullable(Count),
  defaultBranchRef: nullable(Schema.Struct({
    name: Schema.String,
    // `... on Commit`: a commit's fields, or none when the branch names something else.
    target: nullable(Schema.Struct({
      oid: Schema.optional(Schema.String),
      message: Schema.optional(Schema.String),
      author: nullable(Schema.Struct({
        name: nullable(Schema.String),
        date: nullable(Schema.String),
        user: nullable(Schema.Struct({ login: Schema.String })),
      })),
      history: Schema.optional(Count),
    })),
  })),
  root: nullable(Schema.Struct({ entries: Schema.optional(Schema.Array(Schema.Struct({ name: Schema.String, type: Schema.String }))) })),
})
const decodeGraphRepository = Schema.decodeUnknownOption(GraphRepository)

// `... on Blob`: a blob's fields, or none at all (`{}`) when the path is a folder.
const decodeBlob = Schema.decodeUnknownOption(Schema.Struct({
  text: nullable(Schema.String),
  byteSize: Schema.Number,
  isTruncated: Schema.optional(Schema.Boolean),
}))

/** A blob's text as the page shows it: none when GitHub has no blob there, it is over the limit or isn't text. */
const blobText = (raw: unknown): string | null =>
  Option.match(decodeBlob(raw), {
    onNone: () => null,
    onSome: (blob) =>
      blob.text === undefined || blob.text === null || blob.isTruncated === true || blob.byteSize > MAX_BLOB_BYTES
        ? null
        : textOf(new TextEncoder().encode(blob.text)) ?? null,
  })

/** Git's entry types: a tree is a folder, a commit a submodule, a blob a file (a symlink included). */
const GRAPH_KINDS = new Map<string, "dir" | "file">([["tree", "dir"], ["commit", "dir"], ["blob", "file"]])

/**
 * What GitHub says of `owner/name` over GraphQL, through `client`, which must carry a token: GitHub answers GraphQL
 * only to one. The contributors come over REST.
 */
export const graphql = (client: GitHub.GitHubClient.GitHubClient, owner: string, name: string, appSlug: string) =>
  Effect.gen(function* () {
    const path = yield* GitHub.Repository.requireRepositoryPath(owner, name).pipe(
      Effect.mapError(() => new AboutRefused({ code: "not_found", stage: "graphql" })),
    )
    const answer = yield* client.request("POST", "/graphql", { query: QUERY, variables: { owner, name } }, { schema: GraphAnswer })
      .pipe(Effect.mapError((error) => refusalOf(error, "graphql")))
    const raw = answer.data?.repository
    if (raw === null || raw === undefined) {
      return yield* new AboutRefused(
        answer.errors?.some((error) => error.type === "NOT_FOUND") === true
          ? { code: "not_found", stage: "graphql" }
          : { code: "github_unavailable", stage: "graphql" },
      )
    }
    const repository = yield* Option.match(decodeGraphRepository(raw), {
      onNone: () => Effect.fail(new AboutRefused({ code: "github_unavailable", stage: "graphql" })),
      onSome: Effect.succeed,
    })
    if (repository.isPrivate) return yield* new AboutRefused({ code: "not_found", stage: "graphql" })
    const fields = raw as Readonly<Record<string, unknown>>
    const base = `/repos/${path}`
    const entries = repository.root?.entries ?? null
    // The README GitHub would show: the first path the query found a blob at, unless the top folder names another.
    const found = README_PATHS.find((candidate) => Option.isSome(decodeBlob(fields[readmeAlias(candidate)])))
    const named = entries?.find((entry) => entry.type === "blob" && isReadme(entry.name))?.name
    const unread = found !== ".github/README.md" && named !== undefined && !README_PATHS.includes(named as never)
    const [people, readme] = yield* Effect.all(
      [
        contributors(client, base),
        unread
          ? part("readme", client.request("GET", `${base}/readme`, undefined, { schema: ReadmeJson })).pipe(
            Effect.map((read) => ({ ...read, value: read.value === null ? null : { path: read.value.path, text: base64Text(read.value) } })),
          )
          : Effect.succeed(settled("readme", found === undefined ? null : { path: found, text: blobText(fields[readmeAlias(found)]) })),
      ] as const,
      { concurrency: "unbounded" },
    )
    const branch = repository.defaultBranchRef ?? null
    const commit = branch?.target ?? null
    const head: AboutCommit | null = commit?.oid === undefined
      ? null
      : {
        sha: commit.oid,
        message: commit.message ?? "",
        author: commit.author?.user?.login ?? commit.author?.name ?? "",
        at: commit.author?.date ?? "",
      }
    const rootEntries = entries?.flatMap((entry) => entryOf(entry.name, GRAPH_KINDS.get(entry.type))) ?? null
    return {
      about: {
        name: repository.nameWithOwner,
        description: repository.description?.trim() || null,
        homepage: homepageOf(repository.homepageUrl),
        topics: repository.repositoryTopics.nodes.map((node) => node.topic.name),
        stars: repository.stargazerCount,
        forks: repository.forkCount,
        watchers: repository.watchers.totalCount,
        license: licenseOf(repository.licenseInfo === null || repository.licenseInfo === undefined
          ? null
          : { spdx: repository.licenseInfo.spdxId, name: repository.licenseInfo.name }),
        // An empty repository has no default branch to name.
        defaultBranch: branch?.name ?? "",
        archived: repository.isArchived,
        languages: languagesOf((repository.languages?.edges ?? []).map((edge) => [edge.node.name, edge.size] as const)),
        release: repository.latestRelease === null || repository.latestRelease === undefined
          ? null
          : {
            tag: repository.latestRelease.tagName,
            name: repository.latestRelease.name?.trim() || null,
            publishedAt: repository.latestRelease.publishedAt ?? null,
          },
        releases: repository.releases.totalCount,
        contributors: contributorsOf(people.list.value),
        contributorCount: people.count.value?.total ?? null,
        commits: commit?.history?.totalCount ?? null,
        branches: repository.branches?.totalCount ?? null,
        tags: repository.tags?.totalCount ?? null,
        head,
        root: rootEntries === null ? null : rootEntries.slice(0, ABOUT_ROOT_ENTRIES),
        readme: readme.value === null || readme.value.text === null ? null : { path: readme.value.path, text: readme.value.text },
        home: blobText(fields["home"]),
        ...shared(appSlug),
      } satisfies About,
      missing: missingOf([people.list, people.count, readme]),
    } satisfies Read
  }).pipe(Effect.withSpan("repo.about.graphql"))

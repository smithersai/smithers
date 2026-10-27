/**
 * Code Storage, Pierre's git hosting (code.storage), as an Effect service.
 *
 * Code Storage is git over HTTPS for programs: a repository can mirror an
 * upstream such as a public GitHub repository, and its files, trees and
 * commits read through a small HTTP API. This module is a client for the part
 * of that API a host needs to import a public GitHub repository and browse
 * it: create a repository with an upstream, start its sync, list its files,
 * read a file, list commits, list its branches and tags, and retire a repository.
 *
 * - Every request carries its own ES256 JWT, signed with WebCrypto by the
 *   organization's key: one repository, only the scope the call needs, five
 *   minutes long. The key and the tokens never reach a span, a log or an
 *   error.
 * - Failures are a {@link CodeStorageError} carrying Code Storage's stable
 *   `code` and HTTP status, never its free-text `detail`.
 *   {@link isTransient} says which are worth retrying; retrying is the
 *   caller's choice, for example a durable flow's `RetryPolicy`.
 * - Buffered body reads are bounded; original-file streams consume chunks on demand.
 * - Each call is one span, `CodeStorage.<operation>`, and one count on
 *   `code_storage_requests` by `operation` and `outcome`. Every body byte it
 *   receives counts on `code_storage_bytes_read` by `operation`: Code Storage
 *   bills outbound transfer, so this is the spend to watch.
 *
 * It uses Effect's `HttpClient`, so it runs wherever the host provides one: a
 * browser, a Worker, Node or Bun.
 *
 * @since 0.1.0
 */

import * as Clock from "effect/Clock"
import * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import type * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as Layer from "effect/Layer"
import * as Metric from "effect/Metric"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import type * as GitRemote from "./GitRemote.ts"
import { isReadLimit, readAtMost } from "./internal/bounded.ts"
import * as Token from "./internal/token.ts"

/**
 * What a call was doing when it failed. `configure` is building the layer:
 * importing the key.
 *
 * @category models
 * @since 0.1.0
 */
export type Operation =
  | "configure"
  | "createRepo"
  | "deleteRepo"
  | "pullUpstream"
  | "listFiles"
  | "readFile"
  | "listCommits"
  | "listBranches"
  | "listTags"
  | "createBranch"

/**
 * A Code Storage call that failed.
 *
 * - `code` is Code Storage's own stable snake_case code when it answered with
 *   a documented one (`sync_in_progress`, `repository_not_found`,
 *   `rate_limited`, ...), its generic code for the status otherwise, or one of
 *   this client's: `transport` (no answer), `invalid_response` (an answer it
 *   couldn't read), `too_large` (a file over `maxBytes`) and `invalid_key`
 *   (the key didn't import). A code the docs don't list becomes the status's
 *   generic code, as the docs say to treat it.
 * - `unknownCode` is that undocumented code, kept for diagnosis only. Messages
 *   include it only as a lowercase identifier of at most 64 characters. Branch
 *   on `code`.
 * - `status` is the HTTP status, when there was one.
 * - `retryAfterMillis` is the server's `Retry-After` in milliseconds, when it
 *   sent one. `@smthrs/flow`'s `RetryPolicy` waits it instead of its backoff.
 * - `size` is a too-large file's size, when the server declared it.
 *
 * @category errors
 * @since 0.1.0
 */
export class CodeStorageError extends Schema.TaggedError<CodeStorageError>()(
  "@smthrs/effect-code-storage/CodeStorageError",
  {
    operation: Schema.Literals([
      "configure",
      "createRepo",
      "deleteRepo",
      "pullUpstream",
      "listFiles",
      "readFile",
      "listCommits",
      "listBranches",
      "listTags",
      "createBranch"
    ]),
    code: Schema.String,
    status: Schema.optional(Schema.Number),
    retryAfterMillis: Schema.optional(Schema.Number),
    size: Schema.optional(Schema.Number),
    unknownCode: Schema.optional(Schema.String)
  }
) {
  /**
   * The operation, the code, the status and any undocumented code, never any
   * text from the server.
   *
   * @since 0.1.0
   */
  override get message(): string {
    const unknown = this.unknownCode !== undefined && /^[a-z][a-z0-9_]{0,63}$/.test(this.unknownCode)
      ? `, unknown code ${this.unknownCode}`
      : ""
    return `Code Storage ${this.operation} failed: ${this.code}${
      this.status === undefined ? "" : ` (${this.status}${unknown})`
    }`
  }
}

const transientCodes: ReadonlySet<string> = new Set([
  "transport",
  "request_timeout",
  "rate_limited",
  "sync_in_progress",
  "repository_thawing",
  "authentication_unavailable"
])

/**
 * Whether a failure may succeed when tried again unchanged: no answer, a
 * timeout, HTTP 500/502/503/504, a rate limit, a sync or a thaw still running, or the server
 * briefly unable to check credentials.
 *
 * @category errors
 * @since 0.1.0
 */
export const isTransient = (error: CodeStorageError): boolean =>
  transientCodes.has(error.code) || (error.status !== undefined && [500, 502, 503, 504].includes(error.status))

/**
 * The organization a host acts as: its name, its ES256 signing key (a PKCS#8
 * PEM from Code Storage's Keys page), and optionally the API's origin, which
 * defaults to `https://api.<org>.code.storage`.
 *
 * @category models
 * @since 0.1.0
 */
export interface Credentials {
  readonly org: string
  readonly key: Redacted.Redacted<string>
  readonly apiUrl?: string | undefined
}

/**
 * Reads {@link Credentials} from `CODE_STORAGE_ORG`, `CODE_STORAGE_KEY` (as a
 * redacted value) and the optional `CODE_STORAGE_API_URL`.
 *
 * @category configuration
 * @since 0.1.0
 */
export const config: Config.Config<Credentials> = Config.all({
  org: Config.String("CODE_STORAGE_ORG"),
  key: Config.Redacted("CODE_STORAGE_KEY"),
  apiUrl: Config.option(Config.String("CODE_STORAGE_API_URL"))
}).pipe(Config.map(({ org, key, apiUrl }) => ({ org, key, apiUrl: Option.getOrUndefined(apiUrl) })))

/**
 * A public GitHub repository to mirror, without a GitHub App installation.
 * Code Storage syncs it once, when asked ({@link CodeStorage} `pullUpstream`).
 *
 * @category models
 * @since 0.1.0
 */
export interface GitHubUpstream {
  readonly owner: string
  readonly name: string
}

/**
 * A repository to create. `name` may contain `/`. `defaultBranch` defaults to
 * `main` on Code Storage's side; a mirror should name the upstream's.
 *
 * @category models
 * @since 0.1.0
 */
export interface CreateRepoOptions {
  readonly name: string
  readonly defaultBranch?: string | undefined
  readonly github?: GitHubUpstream | undefined
}

/**
 * The repository a create answered with, and whether this call created it
 * (`false` when it already existed: creating is idempotent by name).
 *
 * @category models
 * @since 0.1.0
 */
export interface CreatedRepo {
  readonly name: string
  readonly created: boolean
}

/**
 * Code Storage ref namespace. Ephemeral refs share objects but never sync upstream.
 *
 * @category models
 * @since 0.2.0
 */
export type RefNamespace = "default" | "ephemeral"

/**
 * Branch listing options, including its namespace.
 *
 * @category models
 * @since 0.2.0
 */
export interface ListBranchesOptions extends ListRefsOptions {
  readonly namespace?: RefNamespace | undefined
}

/**
 * Which files to list: at `ref` (default: the default branch), under `path`,
 * all descendants when `recursive`, one page of at most `limit` (Code Storage
 * allows up to 5,000), from `cursor`.
 *
 * @category models
 * @since 0.1.0
 */
export interface ListFilesOptions {
  /** Ref namespace; omitted means the default namespace. */
  readonly namespace?: RefNamespace | undefined
  readonly ref?: string | undefined
  readonly path?: string | undefined
  readonly recursive?: boolean | undefined
  readonly cursor?: string | undefined
  readonly limit?: number | undefined
}

/**
 * One tree entry. `type` is `blob`, `tree`, `symlink` or `submodule`; `mode`
 * is git's six-digit mode.
 *
 * @category models
 * @since 0.1.0
 */
export interface FileEntry {
  readonly path: string
  readonly type: string
  readonly mode: string
}

/**
 * One page of a listing: the ref it resolved, every blob's path, every entry,
 * the cursor of the next page when there is one, and the size of the answer in
 * bytes, for a host that meters what it reads.
 *
 * @category models
 * @since 0.1.0
 */
export interface FilesPage {
  readonly ref: string
  readonly paths: ReadonlyArray<string>
  readonly entries: ReadonlyArray<FileEntry>
  readonly nextCursor: string | undefined
  readonly bytesRead: number
}

/**
 * A file to read at `ref` (default: the default branch). A file over
 * `maxBytes` fails with `too_large` and is not read past the cap.
 *
 * @category models
 * @since 0.1.0
 */
export interface ReadFileOptions {
  /** Ref namespace; omitted means the default namespace. */
  readonly namespace?: RefNamespace | undefined
  readonly path: string
  readonly ref?: string | undefined
  /** Non-negative safe integer; invalid caps fail with invalid_argument before HTTP. */
  readonly maxBytes: number
}

/**
 * A file's bytes, and its git blob id when the server sent it. The bytes read
 * are `bytes.length`.
 *
 * @category models
 * @since 0.1.0
 */
export interface FileContents {
  readonly bytes: Uint8Array
  readonly blobSha: string | undefined
}

/**
 * Which commits to list: from `ref` (default: the default branch), touching
 * `path`, one page of `limit` (default 20) from `cursor`.
 *
 * @category models
 * @since 0.1.0
 */
export interface ListCommitsOptions {
  /** Ref namespace; omitted means the default namespace. */
  readonly namespace?: RefNamespace | undefined
  readonly ref?: string | undefined
  readonly path?: string | undefined
  readonly cursor?: string | undefined
  readonly limit?: number | undefined
}

/**
 * A commit: its id, parents, whole message, author and the author's
 * timestamp (RFC 3339).
 *
 * @category models
 * @since 0.1.0
 */
export interface Commit {
  readonly sha: string
  readonly parentShas: ReadonlyArray<string>
  readonly message: string
  readonly authorName: string
  readonly authorEmail: string
  readonly date: string
}

/**
 * One page of commits, newest first, the cursor of the next page, and the size
 * of the answer in bytes.
 *
 * @category models
 * @since 0.1.0
 */
export interface CommitsPage {
  readonly commits: ReadonlyArray<Commit>
  readonly nextCursor: string | undefined
  readonly bytesRead: number
}

/**
 * Which page of branches or tags to list: one page of `limit` (Code Storage's
 * default is 20) from `cursor`.
 *
 * @category models
 * @since 0.1.0
 */
export interface ListRefsOptions {
  readonly cursor?: string | undefined
  readonly limit?: number | undefined
}

/**
 * A branch: its short name, its head commit, and when it was created
 * (ISO 8601).
 *
 * @category models
 * @since 0.1.0
 */
export interface Branch {
  readonly name: string
  readonly sha: string
  readonly createdAt: string
}

/**
 * One page of branches, the cursor of the next page, and the size of the
 * answer in bytes.
 *
 * @category models
 * @since 0.1.0
 */
export interface BranchesPage {
  readonly branches: ReadonlyArray<Branch>
  readonly nextCursor: string | undefined
  readonly bytesRead: number
}

/**
 * A tag: its short name and the commit it names, dereferenced for an
 * annotated tag.
 *
 * @category models
 * @since 0.1.0
 */
export interface Tag {
  readonly name: string
  readonly sha: string
}

/**
 * One page of tags, in lexical order, the cursor of the next page, and the
 * size of the answer in bytes.
 *
 * @category models
 * @since 0.1.0
 */
export interface TagsPage {
  readonly tags: ReadonlyArray<Tag>
  readonly nextCursor: string | undefined
  readonly bytesRead: number
}

/**
 * A branch to create: its name, and the ref or commit it starts from, such as
 * the default branch's name.
 *
 * @category models
 * @since 0.2.0
 */
export interface CreateBranchOptions {
  /** Destination namespace; omitted means the default namespace. */
  readonly namespace?: RefNamespace | undefined
  /** Source namespace; omitted means the default namespace. */
  readonly fromNamespace?: RefNamespace | undefined
  readonly branch: string
  readonly from: string
  /**
   * Moves `branch` to `from` when it exists, fast-forward or not, instead of
   * failing `conflict`: the provider's `force`.
   *
   * @since 0.2.0
   */
  readonly force?: boolean | undefined
}

/**
 * A branch Code Storage created: its name and the commit it starts at, when
 * Code Storage said.
 *
 * @category models
 * @since 0.2.0
 */
export interface CreatedBranch {
  readonly branch: string
  readonly sha: string | undefined
}

/**
 * The calls, each failing with a {@link CodeStorageError}.
 *
 * - `createRepo`: creates a repository, mirroring `github` when given.
 *   Idempotent by name; a name that exists with another upstream fails with
 *   `conflict`.
 * - `deleteRepo`: permanently retires a repository. Success means deletion
 *   was accepted; physical cleanup is asynchronous. Missing and already-deleted
 *   repositories remain typed errors.
 * - `pullUpstream`: starts a sync from the upstream. While one runs, calls on
 *   the repository fail with `sync_in_progress`.
 * - `listFiles`, `readFile`, `listCommits`, `listBranches`, `listTags`:
 *   reads, as their options say.
 * - `createBranch`: creates a branch at the commit another ref names, with no
 *   clone and no push. A branch that exists fails with `conflict`, unless
 *   `force` moves it there.
 *
 * @category services
 * @since 0.1.0
 */
export interface Client {
  readonly createRepo: (options: CreateRepoOptions) => Effect.Effect<CreatedRepo, CodeStorageError>
  /**
   * Permanently retires `repo` with only `repo:write` on that repository:
   * `DELETE /api/repos/<repo>`. Success means accepted, not physical cleanup
   * completed. `not_found`, `repository_not_found` and `repository_deleted`
   * remain typed errors; no failure is swallowed and the client never retries.
   *
   * @since 0.2.0
   */
  readonly deleteRepo: (repo: string) => Effect.Effect<void, CodeStorageError>
  readonly pullUpstream: (repo: string) => Effect.Effect<void, CodeStorageError>
  readonly listFiles: (repo: string, options?: ListFilesOptions) => Effect.Effect<FilesPage, CodeStorageError>
  readonly readFile: (repo: string, options: ReadFileOptions) => Effect.Effect<FileContents, CodeStorageError>
  /** Stream original bytes without buffering a preview. The consumer owns cancellation and its byte budget. */
  readonly streamFile: (repo: string, options: Omit<ReadFileOptions, "maxBytes">) => Effect.Effect<{
    readonly stream: Stream.Stream<Uint8Array, CodeStorageError>
    readonly blobSha: string | undefined
  }, CodeStorageError>
  readonly listCommits: (repo: string, options?: ListCommitsOptions) => Effect.Effect<CommitsPage, CodeStorageError>
  readonly listBranches: (repo: string, options?: ListBranchesOptions) => Effect.Effect<BranchesPage, CodeStorageError>
  readonly listTags: (repo: string, options?: ListRefsOptions) => Effect.Effect<TagsPage, CodeStorageError>
  /**
   * Creates `options.branch` at the commit `options.from` names, with a
   * `git:write` token for the repository: `POST /api/repos/<repo>/branches/create`.
   *
   * @since 0.2.0
   */
  readonly createBranch: (repo: string, options: CreateBranchOptions) => Effect.Effect<CreatedBranch, CodeStorageError>
  /**
   * The repository's git remote for reading, with a `git:read` token as its
   * credential: `https://<org>.code.storage/<repo>.git` and Basic `t:<token>`,
   * five minutes long. Hand it to `GitProxy.uploadPack` or `GitRemote.ref`;
   * the token never belongs in a URL or a guest.
   *
   * @since 0.2.0
   */
  readonly gitRemote: (repo: string, namespace?: RefNamespace) => Effect.Effect<GitRemote.Upstream>
}

/**
 * The counter every call updates once: `code_storage_requests`, by
 * `operation` and `outcome` (`ok`, or the failure's code).
 *
 * @category observability
 * @since 0.1.0
 */
export const requests: Metric.Counter<number> = Metric.counter("code_storage_requests", {
  description: "Code Storage calls, by operation and outcome",
  incremental: true
})

/**
 * The counter of response body bytes received: `code_storage_bytes_read`, by
 * `operation`. It counts every byte that arrived, including an error's body
 * and a body cut at its cap or broken off; a file refused by its declared size
 * counts nothing.
 *
 * @category observability
 * @since 0.1.0
 */
export const bytesRead: Metric.Counter<number> = Metric.counter("code_storage_bytes_read", {
  description: "Code Storage response body bytes received, by operation",
  incremental: true
})

/** How long each token lives. Code Storage refuses a restricted key's token past an hour. */
const tokenTtlSeconds = 300
/** The most a JSON answer may be: a 5,000-entry listing is about 1 MiB. */
const maxJsonBytes = 8 * 1024 * 1024
/** The most of an error body read for its code. */
const maxProblemBytes = 16 * 1024

const genericCodes: Readonly<Record<number, string>> = {
  400: "bad_request",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  405: "method_not_allowed",
  408: "request_timeout",
  409: "conflict",
  412: "precondition_failed",
  413: "payload_too_large",
  422: "unprocessable_entity",
  429: "rate_limited",
  499: "request_canceled",
  500: "internal_error",
  501: "not_implemented",
  502: "bad_gateway",
  503: "service_unavailable",
  504: "gateway_timeout"
}

/**
 * The codes the docs list beyond the generic ones (code.storage/docs/api/overview,
 * 2026-10-19). Any other code is treated as its status's generic code.
 */
const specificCodes: ReadonlySet<string> = new Set([
  "repo_claim_missing",
  "repo_name_mismatch",
  "insufficient_scope",
  "hosting_not_enabled",
  "authentication_unavailable",
  "route_not_found",
  "repository_not_found",
  "branch_not_found",
  "ref_not_found",
  "credential_not_found",
  "deployment_not_found",
  "hosting_project_not_found",
  "repository_deleted",
  "repository_thawing",
  "sync_in_progress",
  "upstream_already_configured",
  "merge_conflict",
  "credential_exists",
  "deployment_project_name_in_use",
  "github_app_not_configured",
  "github_repository_inaccessible",
  "idempotency_key_reused"
])
const documentedCodes: ReadonlySet<string> = new Set([...specificCodes, ...Object.values(genericCodes)])

/**
 * The code for a failed answer: the server's when the docs list it; else the
 * status's generic code, keeping the server's as `unknownCode`. A status with
 * no generic code in the table takes the server's code, which the docs define
 * as that status's text in snake_case, or `http_<status>` without one.
 */
const classify = (status: number, sent: string | undefined): { code: string; unknownCode?: string } => {
  const generic = genericCodes[status]
  if (sent === undefined) return { code: generic ?? `http_${status}` }
  if (generic === undefined || documentedCodes.has(sent)) return { code: sent }
  return { code: generic, unknownCode: sent }
}

const ProblemJson = Schema.fromJsonString(Schema.Struct({ code: Schema.String }))
const decodeProblem = Schema.decodeUnknownOption(ProblemJson)

/** A code only when it looks like one: a stable identifier, never free text. */
const problemCode = (text: string): string | undefined =>
  Option.match(decodeProblem(text), {
    onNone: () => undefined,
    onSome: ({ code }) => (/^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : undefined)
  })

/** `Retry-After` as milliseconds from now: delta-seconds or an HTTP date. */
const retryAfterMillis = (value: string | undefined, now: number): number | undefined => {
  if (value === undefined) return undefined
  if (/^\d+$/.test(value.trim())) return Number(value.trim()) * 1000
  const at = Date.parse(value)
  return Number.isNaN(at) ? undefined : Math.max(0, at - now)
}

const decoder = new TextDecoder()

const CreatedJson = Schema.fromJsonString(Schema.Struct({ repo_name: Schema.String }))
const FilesJson = Schema.fromJsonString(Schema.Struct({
  ref: Schema.String,
  paths: Schema.Array(Schema.String),
  entries: Schema.Array(Schema.Struct({ path: Schema.String, type: Schema.String, mode: Schema.String })),
  has_more: Schema.Boolean,
  next_cursor: Schema.optional(Schema.String)
}))
const CommitsJson = Schema.fromJsonString(Schema.Struct({
  commits: Schema.Array(Schema.Struct({
    sha: Schema.String,
    parent_shas: Schema.Array(Schema.String),
    message: Schema.String,
    author_name: Schema.String,
    author_email: Schema.String,
    date: Schema.String
  })),
  has_more: Schema.Boolean,
  next_cursor: Schema.optional(Schema.String)
}))

const BranchesJson = Schema.fromJsonString(Schema.Struct({
  branches: Schema.Array(Schema.Struct({ name: Schema.String, head_sha: Schema.String, created_at: Schema.String })),
  has_more: Schema.Boolean,
  next_cursor: Schema.optional(Schema.String)
}))
const CreatedBranchJson = Schema.fromJsonString(Schema.Struct({
  target_branch: Schema.String,
  commit_sha: Schema.optional(Schema.String)
}))
const TagsJson = Schema.fromJsonString(Schema.Struct({
  tags: Schema.Array(Schema.Struct({ name: Schema.String, sha: Schema.String })),
  has_more: Schema.Boolean,
  next_cursor: Schema.optional(Schema.String)
}))

const make = (credentials: Credentials): Effect.Effect<Client, CodeStorageError, HttpClient.HttpClient> =>
  Effect.gen(function*() {
    const key = yield* Token.importKey(Redacted.value(credentials.key)).pipe(
      Effect.mapError(() => new CodeStorageError({ operation: "configure", code: "invalid_key" }))
    )
    const client = yield* HttpClient.HttpClient
    const base = credentials.apiUrl ?? `https://api.${credentials.org}.code.storage`
    const url = (repo: string, path = "") =>
      `${base}/api/repos${repo === "" ? "" : `/${encodeURIComponent(repo)}`}${path}`

    /** A response's body, counted on {@link bytesRead} chunk by chunk as it arrives, read up to `maxBytes`. */
    const read = (operation: Operation, response: HttpClientResponse.HttpClientResponse, maxBytes: number) =>
      readAtMost(
        Stream.tap(
          response.stream,
          (chunk) => Metric.update(Metric.withAttributes(bytesRead, { operation }), chunk.length)
        ),
        maxBytes
      )

    const failure = (operation: Operation, response: HttpClientResponse.HttpClientResponse) =>
      Effect.gen(function*() {
        const body = yield* read(operation, response, maxProblemBytes).pipe(
          Effect.map(({ bytes, truncated }) => (truncated ? undefined : problemCode(decoder.decode(bytes)))),
          Effect.orElseSucceed(() => undefined)
        )
        const now = yield* Clock.currentTimeMillis
        return new CodeStorageError({
          operation,
          ...classify(response.status, body),
          status: response.status,
          retryAfterMillis: retryAfterMillis(response.headers["retry-after"], now)
        })
      })

    /** Signs a token for `repo` with `scopes`, sends `request` with it, and fails on any status over 299. */
    const send = (
      operation: Operation,
      repo: string,
      scopes: ReadonlyArray<Token.Scope>,
      request: HttpClientRequest.HttpClientRequest
    ) =>
      Effect.gen(function*() {
        const now = yield* Clock.currentTimeMillis
        const token = yield* Token.sign(key, {
          org: credentials.org,
          repo,
          scopes,
          issuedAt: Math.floor(now / 1000),
          ttlSeconds: tokenTtlSeconds
        })
        const response = yield* client.execute(HttpClientRequest.bearerToken(request, Redacted.make(token))).pipe(
          Effect.mapError(() => new CodeStorageError({ operation, code: "transport" }))
        )
        if (response.status >= 300) return yield* Effect.flip(failure(operation, response))
        return response
      })

    /** A JSON answer, decoded by `schema`, and the size of its body in bytes. */
    const readJson = <S extends Schema.Codec<unknown, string>>(
      operation: Operation,
      response: HttpClientResponse.HttpClientResponse,
      schema: S
    ): Effect.Effect<
      { readonly body: S["Type"]; readonly bytesRead: number },
      CodeStorageError,
      S["DecodingServices"]
    > =>
      read(operation, response, maxJsonBytes).pipe(
        Effect.mapError(() => new CodeStorageError({ operation, code: "transport", status: response.status })),
        Effect.flatMap(({ bytes, truncated }) =>
          truncated ?
            Effect.fail(new CodeStorageError({ operation, code: "invalid_response", status: response.status })) :
            Schema.decodeUnknownEffect(schema)(decoder.decode(bytes)).pipe(
              Effect.map((body) => ({ body, bytesRead: bytes.length })),
              Effect.mapError(() =>
                new CodeStorageError({ operation, code: "invalid_response", status: response.status })
              )
            )
        )
      )

    const nextCursor = (
      operation: Operation,
      status: number,
      page: { readonly has_more: boolean; readonly next_cursor?: string | undefined }
    ) =>
      !page.has_more ?
        Effect.succeed(undefined) :
        page.next_cursor === undefined ?
        Effect.fail(new CodeStorageError({ operation, code: "invalid_response", status })) :
        Effect.succeed(page.next_cursor)

    /** One span and one count per call; the span names only the repository. */
    const observe = <A>(operation: Operation, repo: string, effect: Effect.Effect<A, CodeStorageError>) =>
      effect.pipe(
        Effect.onExit((exit) =>
          Metric.update(
            Metric.withAttributes(requests, {
              operation,
              outcome: Exit.isSuccess(exit) ? "ok" : Exit.findErrorOption(exit).pipe(
                Option.match({ onNone: () => "interrupted", onSome: (error) => error.code })
              )
            }),
            1
          )
        ),
        Effect.withSpan(`CodeStorage.${operation}`, { attributes: { "code_storage.repo": repo } })
      )

    const params = (entries: Record<string, string | number | boolean | undefined>) =>
      Object.fromEntries(
        Object.entries(entries).flatMap(([name, value]) => (value === undefined ? [] : [[name, String(value)]]))
      )

    const gitBase = `https://${credentials.org}.code.storage`

    return {
      gitRemote: (repo, namespace = "default") =>
        Effect.gen(function*() {
          const now = yield* Clock.currentTimeMillis
          const token = yield* Token.sign(key, {
            org: credentials.org,
            repo,
            scopes: ["git:read"],
            issuedAt: Math.floor(now / 1000),
            ttlSeconds: tokenTtlSeconds
          })
          return {
            url: `${gitBase}/${repo.split("/").map(encodeURIComponent).join("/")}${
              namespace === "ephemeral" ? "+ephemeral" : ""
            }.git`,
            authorization: Redacted.make(`Basic ${btoa(`t:${token}`)}`)
          }
        }),

      createRepo: (options) =>
        observe(
          "createRepo",
          options.name,
          Effect.gen(function*() {
            const request = HttpClientRequest.post(url("")).pipe(
              HttpClientRequest.bodyJsonUnsafe({
                repo_name: options.name,
                ...(options.defaultBranch === undefined ? {} : { default_branch: options.defaultBranch }),
                ...(options.github === undefined ? {} : {
                  upstream: {
                    provider: "github",
                    owner: options.github.owner,
                    name: options.github.name,
                    access: "public"
                  }
                })
              })
            )
            const response = yield* send("createRepo", options.name, ["repo:write"], request)
            const { body } = yield* readJson("createRepo", response, CreatedJson)
            return { name: body.repo_name, created: response.status === 201 }
          })
        ),

      deleteRepo: (repo) =>
        observe(
          "deleteRepo",
          repo,
          send("deleteRepo", repo, ["repo:write"], HttpClientRequest.delete(url(repo))).pipe(Effect.asVoid)
        ),

      pullUpstream: (repo) =>
        observe(
          "pullUpstream",
          repo,
          send("pullUpstream", repo, ["git:write"], HttpClientRequest.post(url(repo, "/upstream/pull"))).pipe(
            Effect.asVoid
          )
        ),

      createBranch: (repo, options) =>
        observe(
          "createBranch",
          repo,
          Effect.gen(function*() {
            const request = HttpClientRequest.post(url(repo, "/branches/create")).pipe(
              HttpClientRequest.bodyJsonUnsafe({
                base_ref: options.from,
                target_branch: options.branch,
                ...(options.fromNamespace === undefined
                  ? {}
                  : { base_is_ephemeral: options.fromNamespace === "ephemeral" }),
                ...(options.namespace === undefined ? {} : { target_is_ephemeral: options.namespace === "ephemeral" }),
                ...(options.force === true ? { force: true } : {})
              })
            )
            const response = yield* send("createBranch", repo, ["git:write"], request)
            const { body } = yield* readJson("createBranch", response, CreatedBranchJson)
            return { branch: body.target_branch, sha: body.commit_sha }
          })
        ),

      listFiles: (repo, options = {}) =>
        observe(
          "listFiles",
          repo,
          Effect.gen(function*() {
            const request = HttpClientRequest.get(url(repo, "/files")).pipe(
              HttpClientRequest.setUrlParams(params({
                ref: options.ref,
                ephemeral: options.namespace === undefined ? undefined : options.namespace === "ephemeral",
                path: options.path,
                recursive: options.recursive,
                cursor: options.cursor,
                limit: options.limit
              }))
            )
            const response = yield* send("listFiles", repo, ["git:read"], request)
            const { body: page, bytesRead } = yield* readJson("listFiles", response, FilesJson)
            return {
              ref: page.ref,
              paths: page.paths,
              entries: page.entries,
              nextCursor: yield* nextCursor("listFiles", response.status, page),
              bytesRead
            }
          })
        ),

      readFile: (repo, options) =>
        observe(
          "readFile",
          repo,
          Effect.gen(function*() {
            if (!isReadLimit(options.maxBytes)) {
              return yield* new CodeStorageError({ operation: "readFile", code: "invalid_argument" })
            }
            const request = HttpClientRequest.get(url(repo, "/file")).pipe(
              HttpClientRequest.setUrlParams(
                params({
                  path: options.path,
                  ref: options.ref,
                  ephemeral: options.namespace === undefined ? undefined : options.namespace === "ephemeral"
                })
              )
            )
            const response = yield* send("readFile", repo, ["git:read"], request)
            const declared = Number(response.headers["content-length"] ?? Number.NaN)
            if (declared > options.maxBytes) {
              return yield* new CodeStorageError({
                operation: "readFile",
                code: "too_large",
                status: response.status,
                size: declared
              })
            }
            const { bytes, truncated } = yield* read("readFile", response, options.maxBytes).pipe(
              Effect.mapError(() =>
                new CodeStorageError({ operation: "readFile", code: "transport", status: response.status })
              )
            )
            if (truncated) {
              return yield* new CodeStorageError({ operation: "readFile", code: "too_large", status: response.status })
            }
            return { bytes, blobSha: response.headers["x-blob-sha"] }
          })
        ),

      streamFile: (repo, options) =>
        observe(
          "readFile",
          repo,
          Effect.gen(function*() {
            const request = HttpClientRequest.get(url(repo, "/file")).pipe(HttpClientRequest.setUrlParams(params({
              path: options.path,
              ref: options.ref,
              ephemeral: options.namespace === undefined ? undefined : options.namespace === "ephemeral"
            })))
            const response = yield* send("readFile", repo, ["git:read"], request)
            return {
              blobSha: response.headers["x-blob-sha"],
              stream: response.stream.pipe(
                Stream.tap((chunk) =>
                  Metric.update(Metric.withAttributes(bytesRead, { operation: "readFile" }), chunk.length)
                ),
                Stream.mapError(() =>
                  new CodeStorageError({ operation: "readFile", code: "transport", status: response.status })
                )
              )
            }
          })
        ),

      listCommits: (repo, options = {}) =>
        observe(
          "listCommits",
          repo,
          Effect.gen(function*() {
            const request = HttpClientRequest.get(url(repo, "/commits")).pipe(
              HttpClientRequest.setUrlParams(params({
                ref: options.ref,
                ephemeral: options.namespace === undefined ? undefined : options.namespace === "ephemeral",
                path: options.path,
                cursor: options.cursor,
                limit: options.limit
              }))
            )
            const response = yield* send("listCommits", repo, ["git:read"], request)
            const { body: page, bytesRead } = yield* readJson("listCommits", response, CommitsJson)
            return {
              commits: page.commits.map((commit) => ({
                sha: commit.sha,
                parentShas: commit.parent_shas,
                message: commit.message,
                authorName: commit.author_name,
                authorEmail: commit.author_email,
                date: commit.date
              })),
              nextCursor: yield* nextCursor("listCommits", response.status, page),
              bytesRead
            }
          })
        ),

      listBranches: (repo, options = {}) =>
        observe(
          "listBranches",
          repo,
          Effect.gen(function*() {
            const request = HttpClientRequest.get(url(repo, "/branches")).pipe(
              HttpClientRequest.setUrlParams(
                params({
                  cursor: options.cursor,
                  limit: options.limit,
                  ephemeral: options.namespace === undefined ? undefined : options.namespace === "ephemeral"
                })
              )
            )
            const response = yield* send("listBranches", repo, ["git:read"], request)
            const { body: page, bytesRead } = yield* readJson("listBranches", response, BranchesJson)
            return {
              branches: page.branches.map((branch) => ({
                name: branch.name,
                sha: branch.head_sha,
                createdAt: branch.created_at
              })),
              nextCursor: yield* nextCursor("listBranches", response.status, page),
              bytesRead
            }
          })
        ),

      listTags: (repo, options = {}) =>
        observe(
          "listTags",
          repo,
          Effect.gen(function*() {
            const request = HttpClientRequest.get(url(repo, "/tags")).pipe(
              HttpClientRequest.setUrlParams(params({ cursor: options.cursor, limit: options.limit }))
            )
            const response = yield* send("listTags", repo, ["git:read"], request)
            const { body: page, bytesRead } = yield* readJson("listTags", response, TagsJson)
            return {
              tags: page.tags.map((tag) => ({ name: tag.name, sha: tag.sha })),
              nextCursor: yield* nextCursor("listTags", response.status, page),
              bytesRead
            }
          })
        )
    } satisfies Client
  })

/**
 * The Code Storage client, as a service.
 *
 * @category services
 * @since 0.1.0
 */
export class CodeStorage extends Context.Service<CodeStorage, Client>()("@smthrs/effect-code-storage/CodeStorage") {
  /**
   * Provides the client for `credentials`, over the host's `HttpClient`. The
   * key is imported once, here; a key that doesn't import fails the layer
   * with `invalid_key`.
   *
   * @category layers
   * @since 0.1.0
   */
  static readonly layer = (
    credentials: Credentials
  ): Layer.Layer<CodeStorage, CodeStorageError, HttpClient.HttpClient> => Layer.effect(CodeStorage, make(credentials))

  /**
   * Provides the client for the credentials {@link config} reads.
   *
   * @category layers
   * @since 0.1.0
   */
  static readonly layerConfig: Layer.Layer<
    CodeStorage,
    CodeStorageError | Config.ConfigError,
    HttpClient.HttpClient
  > = Layer.unwrap(Effect.gen(function*() {
    return CodeStorage.layer(yield* config)
  }))
}

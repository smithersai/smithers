---
title: "API reference"
description: "Every export of @smthrs/effect-code-storage: the CodeStorage, GitRemote and GitProxy namespaces, their service, layers, models, errors and metrics."
---

The package root exports three namespaces and nothing else:

```ts
import { CodeStorage, GitProxy, GitRemote } from "@smthrs/effect-code-storage"
```

## `CodeStorage`

### `CodeStorage.CodeStorage`

```ts
class CodeStorage extends Context.Service<CodeStorage, Client>() {
  static readonly layer: (credentials: Credentials) => Layer.Layer<CodeStorage, CodeStorageError, HttpClient.HttpClient>
  static readonly layerConfig: Layer.Layer<CodeStorage, CodeStorageError | Config.ConfigError, HttpClient.HttpClient>
}
```

The client as a service. `layer` imports the key once; a key that doesn't
import fails the layer with `{ operation: "configure", code: "invalid_key" }`.
`layerConfig` reads its credentials with `config`.

### `CodeStorage.Client`

```ts
interface Client {
  readonly createRepo: (options: CreateRepoOptions) => Effect.Effect<CreatedRepo, CodeStorageError>
  readonly deleteRepo: (repo: string) => Effect.Effect<void, CodeStorageError>
  readonly pullUpstream: (repo: string) => Effect.Effect<void, CodeStorageError>
  readonly listFiles: (repo: string, options?: ListFilesOptions) => Effect.Effect<FilesPage, CodeStorageError>
  readonly readFile: (repo: string, options: ReadFileOptions) => Effect.Effect<FileContents, CodeStorageError>
  readonly listCommits: (repo: string, options?: ListCommitsOptions) => Effect.Effect<CommitsPage, CodeStorageError>
  readonly listBranches: (repo: string, options?: ListBranchesOptions) => Effect.Effect<BranchesPage, CodeStorageError>
  readonly listTags: (repo: string, options?: ListRefsOptions) => Effect.Effect<TagsPage, CodeStorageError>
  readonly createBranch: (repo: string, options: CreateBranchOptions) => Effect.Effect<CreatedBranch, CodeStorageError>
  readonly gitRemote: (repo: string, namespace?: RefNamespace) => Effect.Effect<GitRemote.Upstream>
}
```

- `createRepo` creates a repository, mirroring `github` when given. It is
  idempotent by name: `created` is `false` when the repository already
  existed. The same name with another upstream fails `conflict`.
- `deleteRepo(repo)` permanently retires a repository through
  `DELETE /api/repos/<repo>` with a five-minute `repo:write` token for exactly
  that repository. The API origin defaults to `https://api.<org>.code.storage`;
  the repository is encoded into one path segment. Returns `void` on acceptance;
  physical storage cleanup continues asynchronously. HTTP 404 `not_found` and
  `repository_not_found`, and HTTP 409 `repository_deleted`, remain typed
  `CodeStorageError`s. No errors are swallowed or retried. A `transport` failure
  may hide an accepted deletion. Records the `CodeStorage.deleteRepo` span,
  request outcome count and bytes read from bounded error bodies; the success
  body is not consumed. Contract: [Code Storage OpenAPI](https://code.storage/docs/openapi.json),
  `repos-delete`, verified 2026-10-23.
- `pullUpstream` starts a sync from the upstream. While one runs, calls on the
  repository fail `sync_in_progress`.
- `listFiles` lists one page of the tree. `nextCursor` is set when there is
  another page.
- `readFile` reads one file's bytes, up to `maxBytes`.
- `listCommits` lists one page of commits, newest first.
- `listBranches` lists one page of branches, each with its head commit.
- `gitRemote` signs a five-minute `git:read` token for `repo` and returns
  `{ url: "https://<org>.code.storage/<repo>.git", authorization }`, the token
  as Basic `t:<token>` in a redacted value. It sends nothing; hand the result to
  `GitProxy.uploadPack` or `GitRemote.ref`, never to a guest.
- `listTags` lists one page of tags in lexical order, each with the commit it
  names (dereferenced for an annotated tag).
- `createBranch(repo, { branch, from })` creates `branch` at the commit `from`
  names (a branch, tag or commit) with a `git:write` token, through
  `POST /api/repos/<repo>/branches/create`: no clone, no push. It answers
  `{ branch, sha }`, `sha` the commit Code Storage reports, `undefined` when it
  doesn't. A branch that exists fails `conflict`; a `from` it can't resolve,
  `ref_not_found`. `force: true` moves a branch that exists to `from` instead,
  fast-forward or not (the provider's `force`); moving it to where it is
  changes nothing.

### `CodeStorage.Credentials` and `CodeStorage.config`

```ts
interface Credentials {
  readonly org: string
  readonly key: Redacted.Redacted<string>
  readonly apiUrl?: string | undefined
}
const config: Config.Config<Credentials>
```

`key` is the organization's ES256 key as a PKCS#8 PEM; newlines escaped as
`\n`, as an environment variable often carries them, work too. `apiUrl`
defaults to `https://api.<org>.code.storage`. `config` reads
`CODE_STORAGE_ORG`, `CODE_STORAGE_KEY` (redacted) and the optional
`CODE_STORAGE_API_URL`.

### Options and results

```ts
interface GitHubUpstream {
  readonly owner: string
  readonly name: string
}
interface CreateRepoOptions {
  readonly name: string
  readonly defaultBranch?: string | undefined
  readonly github?: GitHubUpstream | undefined
}
interface CreatedRepo {
  readonly name: string
  readonly created: boolean
}

interface ListFilesOptions {
  readonly ref?: string | undefined
  readonly path?: string | undefined
  readonly recursive?: boolean | undefined
  readonly cursor?: string | undefined
  readonly limit?: number | undefined
}
interface FileEntry {
  readonly path: string
  readonly type: string
  readonly mode: string
}
interface FilesPage {
  readonly ref: string
  readonly paths: ReadonlyArray<string>
  readonly entries: ReadonlyArray<FileEntry>
  readonly nextCursor: string | undefined
  readonly bytesRead: number
}

interface ReadFileOptions {
  readonly path: string
  readonly ref?: string | undefined
  readonly maxBytes: number
}
interface FileContents {
  readonly bytes: Uint8Array
  readonly blobSha: string | undefined
}

interface ListCommitsOptions {
  readonly ref?: string | undefined
  readonly path?: string | undefined
  readonly cursor?: string | undefined
  readonly limit?: number | undefined
}
interface Commit {
  readonly sha: string
  readonly parentShas: ReadonlyArray<string>
  readonly message: string
  readonly authorName: string
  readonly authorEmail: string
  readonly date: string
}
interface CommitsPage {
  readonly commits: ReadonlyArray<Commit>
  readonly nextCursor: string | undefined
  readonly bytesRead: number
}

interface ListRefsOptions {
  readonly cursor?: string | undefined
  readonly limit?: number | undefined
}
interface Branch {
  readonly name: string
  readonly sha: string
  readonly createdAt: string
}
interface BranchesPage {
  readonly branches: ReadonlyArray<Branch>
  readonly nextCursor: string | undefined
  readonly bytesRead: number
}
interface Tag {
  readonly name: string
  readonly sha: string
}
interface TagsPage {
  readonly tags: ReadonlyArray<Tag>
  readonly nextCursor: string | undefined
  readonly bytesRead: number
}
```

- A `ref` is a branch, a tag or a commit SHA, and defaults to the repository's
  default branch.
- `listBranches` and `listTags` send only the options given; Code Storage's
  `limit` defaults to 20. A branch's `sha` is its head commit, Code Storage's
  `head_sha`.
- `listFiles` sends only the options given. Code Storage's `limit` defaults to
  1,000 and allows up to 5,000. `paths` lists blobs only; `entries` also has
  trees, symlinks and submodules, with `type` and git's six-digit `mode`.
- A `readFile` whose declared size is over `maxBytes` fails `too_large` with
  `size` and its body is not read. An undeclared body that passes the cap
  fails `too_large` without `size`, read no further than the cap.
- `bytesRead` is the size of a page's answer in bytes; a file's is
  `bytes.length`. Code Storage bills outbound transfer and reports no usage
  through its API, so a host that keeps a spend budget adds these up itself.

### `CodeStorage.CodeStorageError` and `CodeStorage.isTransient`

```ts
class CodeStorageError extends Schema.TaggedError<CodeStorageError>()("@smthrs/effect-code-storage/CodeStorageError", {
  operation: "configure" | "createRepo" | "deleteRepo" | "pullUpstream" | "listFiles" | "readFile" | "listCommits" | "listBranches" | "listTags" | "createBranch",
  code: string,
  status?: number,
  retryAfterMillis?: number,
  size?: number,
  unknownCode?: string
})
const isTransient: (error: CodeStorageError) => boolean
```

- **`code`** comes from one of three places:
  - Code Storage's own code, when its problem body carries one the docs list,
    such as `sync_in_progress`, `repository_not_found` or
    `insufficient_scope`.
  - The status's generic code otherwise, such as `bad_request`, `not_found`,
    `rate_limited` or `service_unavailable`. That includes a code the docs
    don't list, which they say to treat as the status's generic code. On a
    status with no generic code in the docs' table, the server's code stands
    (the docs define it as that status's text in snake_case), or
    `http_<status>` without one.
  - One of the client's own:
    - `transport`: no answer, or a body that broke off;
    - `invalid_response`: a body over 8 MiB, not JSON, or not the documented
      shape;
    - `too_large`;
    - `invalid_key`.
- **`retryAfterMillis`** is the server's `Retry-After` in milliseconds, from
  delta-seconds or an HTTP date. `@smthrs/flow`'s `RetryPolicy` reads this
  field and waits it instead of its own backoff.
- **`unknownCode`** is the undocumented code that `code` replaced, kept for
  diagnosis. Branch on `code`, never on `unknownCode`.
- **`message`** is `Code Storage <operation> failed: <code> (<status>)`, or
  `(<status>, unknown code <unknownCode>)`. It holds no server text: a code
  is used only when it is a snake_case identifier.
- **`isTransient`** is true for `transport`, `request_timeout`,
  `rate_limited`, `sync_in_progress`, `repository_thawing`,
  `authentication_unavailable` and any 5xx.

### `CodeStorage.requests`

```ts
const requests: Metric.Counter<number>
```

`code_storage_requests`: one count per call, by `operation` and `outcome` (`ok`, `interrupted`, or the failure's code).

### `CodeStorage.bytesRead`

```ts
const bytesRead: Metric.Counter<number>
```

`code_storage_bytes_read`: response body bytes received, by `operation`, counted as each chunk arrives. It includes an error's problem body and a body cut at its cap or broken off. A file refused by its declared size counts nothing. It is the proxy for Code Storage's outbound transfer charge.

### `CodeStorage.Operation`

```ts
type Operation =
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
```

## `GitRemote`

### `GitRemote.head`

```ts
const head: (remote: string | Upstream) => Effect.Effect<Head, GitRemoteError, HttpClient.HttpClient>
interface Head {
  readonly sha: string
  readonly branch: string | undefined
}
```

- **What it reads:** the HEAD of the git remote at `remote`, such as
  `https://github.com/octocat/Spoon-Knife.git`. It sends
  `GET <remote>/info/refs?service=git-upload-pack` with no credential, or, for
  an `Upstream`, with its credential.
- **How much it reads:** only the start of the answer, up to the first ref
  line, and never more than 64 KiB. An answer whose first ref line doesn't
  arrive inside 64 KiB fails `too_large`.
- **`branch`:** the target of `symref=HEAD:refs/heads/<branch>`, or
  `undefined` when HEAD is detached. Any name git allows reads back exactly,
  `日本語` and emoji included: packets are framed by their byte lengths, and
  each one is decoded only once it is whole.
- **`sha`:** a SHA-1 or a SHA-256 commit id.

### `GitRemote.Upstream` and `GitRemote.ref`

```ts
interface Upstream {
  readonly url: string
  readonly authorization?: Redacted.Redacted<string> | undefined
}
const ref: (upstream: Upstream, branch: string) => Effect.Effect<string, GitRemoteError, HttpClient.HttpClient>
```

- **`Upstream`:** a remote's smart HTTP base and the `Authorization` value the
  host adds to every request it sends there.
- **`ref`:** the commit `refs/heads/<branch>` points at. It asks git protocol
  v2's `ls-refs` for that ref (`POST <url>/git-upload-pack`, `Git-Protocol:
  version=2`, `ref-prefix refs/heads/<branch>`) with the credential, so a
  remote with many pull request refs answers in one line. It reads the answer
  one packet at a time as it arrives and stops at the branch's line, or at the
  flush that ends the answer, when the remote has no such branch
  (`ref_not_found`). Reading costs time linear in the answer however the
  network cuts it, and stops at 1 MiB: an answer that reaches that cap before
  the branch's line or the flush fails `too_large`.

### `GitRemote.GitRemoteError`

```ts
class GitRemoteError extends Schema.TaggedError<GitRemoteError>()("@smthrs/effect-code-storage/GitRemoteError", {
  code: "not_found" | "empty" | "ref_not_found" | "unavailable" | "transport" | "too_large" | "invalid_response",
  status?: number
})
```

| `code`             | Meaning                                                                                                     |
| ------------------ | ----------------------------------------------------------------------------------------------------------- |
| `not_found`        | The remote answered 401, 403 or 404. That is how GitHub answers for a repository that is missing or private |
| `empty`            | The remote has no HEAD: no commits, or refs but no HEAD                                                     |
| `ref_not_found`    | `ref` only: the remote has no such branch                                                                   |
| `unavailable`      | Any other failing status, in `status`                                                                       |
| `transport`        | No answer, or the answer broke off                                                                          |
| `too_large`        | The answer reached the read's cap (64 KiB for `head`, 1 MiB for `ref`) before it said what was asked        |
| `invalid_response` | Not an upload-pack advertisement or `ls-refs` answer, malformed, or a line it needed isn't UTF-8            |

### `GitRemote.requests`

```ts
const requests: Metric.Counter<number>
```

`git_remote_requests`: one count per `head` or `ref`, by `outcome` (`ok`, `interrupted`, or the failure's code). Each call is also one span, `GitRemote.head` or `GitRemote.ref`, with the attribute `git.remote`.

## `GitProxy`

### `GitProxy.uploadPack`

```ts
const uploadPack: (
  request: HttpServerRequest.HttpServerRequest,
  upstream: GitRemote.Upstream,
  branch?: string
) => Effect.Effect<HttpServerResponse.HttpServerResponse, never, HttpClient.HttpClient>
```

- **What it admits:** `GET <path>/info/refs?service=git-upload-pack` and
  `POST <path>/git-upload-pack`, whatever `<path>` is. Anything else is 403 and
  nothing is sent.
- **What it sends:** the same request to `upstream.url`, with only the guest's
  `Content-Type`, `Content-Encoding`, `Accept` and `Git-Protocol` headers and
  the upstream's `Authorization`. The request body streams through.
- **What it answers:** the upstream's status and body, with only its
  `Content-Type` and `Cache-Control`. It asks for `Accept-Encoding: identity`
  and never passes `Content-Encoding` on: the host's `fetch` decodes a
  compressed answer (GitHub gzips `info/refs`). No answer is 502.

### `GitProxy.classify`

```ts
type Service = "info-refs" | "upload-pack"
const classify: (method: string, url: string) => Service | undefined
```

Which service a request asks for, or `undefined` when `uploadPack` refuses it.

### `GitProxy.requests`

```ts
const requests: Metric.Counter<number>
```

`git_proxy_requests`: one count per request, by `service` (`info-refs`,
`upload-pack` or `refused`) and `outcome` (`ok`, `refused`, the upstream's
status class such as `4xx`, `transport`, or `broken` for an answer that broke
off), counted once the answer's body has ended. Each request is also one span,
`GitProxy.uploadPack`, and one log line, `git.proxy`, with the service, the
outcome, the status and the duration.

### Ref namespaces

`RefNamespace` is `"default" | "ephemeral"`. `ListBranchesOptions` extends
`ListRefsOptions` with optional `namespace`. `ListFilesOptions`,
`ReadFileOptions`, and `ListCommitsOptions` also accept `namespace`.
`CreateBranchOptions.namespace` selects the destination and `fromNamespace`
selects the source. Omitted options use the default namespace. `force` maps to
the provider's `force` ("Allow non-fast-forward updates when recreating an
existing named branch"): Smithers moves a conversation's ephemeral ref to the
commit its published GitHub branch reached this way.

The [provider OpenAPI](https://code.storage/docs/openapi.json) maps these to
`ephemeral` on reads, `base_is_ephemeral` and `target_is_ephemeral` on create.
`gitRemote(repo, "ephemeral")` appends `+ephemeral` before `.git` after encoding
the repository path; signing still scopes the token to `repo`.

### Branch-scoped sandbox access

Pass `branch` to `GitProxy.uploadPack(request, upstream, branch)` when a
namespace contains refs with different access policies. Discovery synthesizes
only HEAD and `refs/heads/<branch>`; even a protocol-v2 discovery request
receives a valid protocol-v0 advertisement. No upstream ref list or capability
list reaches the guest. The namespace remains part of the host's `upstream`.

Scoped upload-pack accepts uncompressed protocol-v0 pkt-lines up to 1 MiB.
Every want must equal the selected branch's current tip. Have lines are
removed, preventing private-object ACK probes; side-band-64k and ofs-delta are
the only accepted capabilities. Unknown commands, v2 command bodies, malformed frames,
trailing bytes, shallow/filter requests and compressed bodies return 403.
The proxy therefore supports complete clone/fetch, with potentially larger
packs; shallow and partial clones are unsupported. A failed host ref lookup
returns 502, and an invalid branch name is refused before any upstream call.

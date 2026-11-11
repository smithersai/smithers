---
title: "@smthrs/effect-code-storage"
description: "Code Storage, Pierre's git hosting, for Effect programs: import a public GitHub repository, sync it, list its files, read a file and list commits, with per-request ES256 tokens; read a git remote's HEAD or a branch; and proxy a guest's clone read-only with the credential added outside it."
---

`@smthrs/effect-code-storage` is an Effect client for
[Code Storage](https://code.storage), git hosting built for programs by The
Pierre Computer Company. A repository there is real git over HTTPS, and it can
mirror an upstream such as a public GitHub repository. This package covers
what a host needs to import one and browse it.

## What it guarantees

- **One short token per request.** Each call signs its own JWT with the
  organization's ES256 key through WebCrypto. The `repo` claim names the one
  repository the call touches, `scopes` holds only the scope the call needs
  (`repo:write` to create or delete, `git:write` to sync, `git:read` to read), and the
  token lives five minutes. Code Storage refuses a restricted key's token past
  an hour.
- **Secrets stay out of telemetry.** The key is imported once, when the layer
  is built, and never leaves the client. Tokens travel only in the
  `Authorization` header, which Effect's HTTP client never records.
- **Typed failures without the provider's text.** A failure is a
  `CodeStorageError` with Code Storage's stable `code`, the HTTP status and
  `Retry-After` in milliseconds as `retryAfterMillis`, the field a durable
  flow's `RetryPolicy` waits. Its free-text `detail` is never copied, so a
  failure can be logged and traced as is. `isTransient` says which failures
  may succeed unchanged on another try. Retrying is yours to decide, for
  example with a durable flow's `RetryPolicy`.
- **Bounded reads.** JSON answers stop at 8 MiB, error bodies at 16 KiB, and a
  file at the `maxBytes` you pass. A file whose declared size is over the cap
  fails `too_large` before its body is read.
- **Observable.** Each call is one span, `CodeStorage.<operation>`, whose only
  attribute is the repository, plus one count on `code_storage_requests` by
  `operation` and `outcome`. Effect's HTTP client span is its child.
- **Metered.** Every response byte received counts on
  `code_storage_bytes_read` by `operation`, and each page reports its own
  `bytesRead`. Code Storage bills outbound transfer but has no usage API, so
  this is how a host keeps a spend budget.
- **Platform neutral.** It uses Effect's `HttpClient`, WebCrypto and
  `TextDecoder`, and imports no Node built-in.

## Importing a public GitHub repository

Code Storage's public mode mirrors a public GitHub repository with no GitHub
App and no GitHub credential. It syncs once, when asked, and needs the
upstream to stay public. It does not support Git LFS.

1. `GitRemote.head("https://github.com/<owner>/<name>.git")` reads the
   upstream's default branch and commit, and fails `not_found` for a missing or
   private repository. It uses git's own smart HTTP endpoint, so it needs no
   token and isn't held to GitHub's REST limit of 60 requests an hour per
   address.
2. `createRepo({ name, defaultBranch: head.branch, github: { owner, name } })`
   creates the mirror. Creating is idempotent by name: a second call answers
   `created: false`, and the same name with another upstream fails `conflict`.
   Name the default branch: Code Storage defaults to `main`.
3. `pullUpstream(name)` starts the sync. Until the first sync finishes, calls
   on the repository fail `sync_in_progress`, which is transient.
4. `listCommits(name, { ref: branch, limit: 1 })` succeeds once the sync is
   done, with the head commit. From then on, read at that commit's SHA:
   `listFiles(name, { ref, recursive: true, limit: 5000 })`, then
   `readFile(name, { path, ref, maxBytes })`. `listBranches(name)` and
   `listTags(name)` page through the mirror's branches and tags, each with
   its commit: a public mirror carries every branch the upstream had at the
   sync.

## Retiring a repository

`yield* storage.deleteRepo(name)` sends `DELETE /api/repos/{repo_name}` to
`https://api.<org>.code.storage`, with the name encoded as one path segment
and a five-minute token naming exactly that repository and only `repo:write`.
It returns `void` when deletion is accepted. Code Storage soft-deletes first;
physical cleanup of hot and cold storage continues asynchronously.

Missing repositories fail with a typed `CodeStorageError`: HTTP 404's
`not_found` or `repository_not_found` is **not** swallowed as success. An
already-deleted repository's HTTP 409 `repository_deleted` remains a typed
error too. Other failures use the same classification and bounded error-body
reads as every call, including `Retry-After`. The client never retries;
`transport` means no answer was received and deletion may have been accepted.

Each call records `CodeStorage.deleteRepo` and one `code_storage_requests`
count with `operation=deleteRepo` and `outcome=ok`, `defect`, `interrupted` or
the failure code. Like
`pullUpstream`, it does not consume the success body. Error-body bytes read
count on `code_storage_bytes_read` with `operation=deleteRepo`.

The endpoint, scope, 200 acceptance and 409 already-deleted response are from
Code Storage's [primary OpenAPI specification](https://code.storage/docs/openapi.json),
read 2026-10-23 (`paths["/api/repos/{repo_name}"].delete`, operation `repos-delete`).
This extends the library catalog's `@smthrs/effect-code-storage` entry (SDK-1)
without adding a dependency.

## Cloning in a sandbox without a credential in it

A sandbox's guest clones through a proxy the host runs, so no token ever
enters the box:

1. The host picks the upstream: `client.gitRemote(name)` for a Code Storage
   repository (`https://<org>.code.storage/<name>.git` and Basic `t:<token>`,
   a five-minute `git:read` token), or any `GitRemote.Upstream` such as
   `{ url: "https://github.com/<owner>/<name>.git" }`.
2. The guest's remote is the proxy's own URL, such as
   `http://forge.smithers.internal/<owner>/<name>`, and the host routes its
   requests to `GitProxy.uploadPack(request, upstream)`.
3. `uploadPack` admits only `GET …/info/refs?service=git-upload-pack` and
   `POST …/git-upload-pack` (protocol v0 or v2) and refuses everything else
   with 403, a push included. It forwards only `Content-Type`,
   `Content-Encoding`, `Accept` and `Git-Protocol`, adds the upstream's
   credential, asks for an uncompressed answer, and streams it back with only
   `Content-Type` and `Cache-Control`: the host's `fetch` has already decoded
   any compressed answer. The repository named in the guest's
   path is ignored: the host's upstream decides it.
4. Each request is one span, `GitProxy.uploadPack`, one log line `git.proxy`
   and one count on `git_proxy_requests` by `service` and `outcome`. The span
   records `git.proxy.service` and `http.response.status_code` and ends when
   headers are ready; the count and log cover the body transfer. None carries
   the credential, a path or any bytes.

`GitRemote.ref(upstream, branch)` reads one branch's commit with git protocol
v2's `ls-refs` for that ref alone, with the upstream's credential, and fails
`ref_not_found` for a branch the remote doesn't have. `octocat/Spoon-Knife`'s
full advertisement lists every pull request ref and took 40 to 70 seconds to
read from a Worker on 2026-10-20; `ls-refs` answers in one line.

Code Storage's own guide describes the same proxy:
`https://code.storage/docs/guides/proxy-git-with-your-own-auth.md`, read
2026-10-20: the upstream is `https://{org}.code.storage/{repo}.git/{path}`,
the token goes as Basic `t:<token>`, and the guest's own `Authorization` is
never forwarded.

## Code Storage facts it relies on

From `https://code.storage/docs/openapi.json`, read 2026-10-19:

| Call           | Route                                                            | Scope        |
| -------------- | ---------------------------------------------------------------- | ------------ |
| `createRepo`   | `POST /api/repos` with `repo_name`, `default_branch`, `upstream` | `repo:write` |
| `deleteRepo`   | `DELETE /api/repos/{repo}` (verified 2026-10-23)                 | `repo:write` |
| `pullUpstream` | `POST /api/repos/{repo}/upstream/pull`                           | `git:write`  |
| `listFiles`    | `GET /api/repos/{repo}/files`                                    | `git:read`   |
| `readFile`     | `GET /api/repos/{repo}/file`                                     | `git:read`   |
| `listCommits`  | `GET /api/repos/{repo}/commits`                                  | `git:read`   |
| `listBranches` | `GET /api/repos/{repo}/branches`                                 | `git:read`   |
| `listTags`     | `GET /api/repos/{repo}/tags`                                     | `git:read`   |

A repository name may contain `/`; the client encodes it into one path
segment. API calls reject names containing unpaired UTF-16 surrogates with
`invalid_argument` before sending HTTP; `gitRemote` requires a well-formed name.
The organization's API origin is `https://api.<org>.code.storage`.

### Capacity and spend

From `https://code.storage/docs/llms.txt` and its pages, read 2026-10-19:

- **No usage or billing API.** `GET /api/meta` returns the cluster's provider,
  region and inbound addresses. `GET /api/repos/{repo}` and `GET /api/repos`
  return names, default branch, creation time and upstream, with no size.
- **No published rate limit.** A `429 rate_limited` carries `Retry-After`,
  the minimum delay, which takes precedence, and the IETF `RateLimit` field.
  The gateway's capacity is dynamic, so there is no `RateLimit-Policy`.
- **Unknown codes.** New codes can be added; treat an unknown one as its
  status's generic code. The client does.

## Pages

- [API reference](api.md)
- [Stream an original file](guides/stream-file.md)

## Ref namespaces

`createBranch(repo, { branch, from, namespace: "ephemeral" })` creates a
Smithers-local ref from an ordinary ref on the same repository, including a
GitHub-synced mirror. It does not create a GitHub branch. Set `fromNamespace`
when the source is ephemeral too. Both options default to `"default"`.

Pass the stored `namespace` to `listBranches`, `listFiles`, `readFile`, and
`listCommits`; use `gitRemote(repo, namespace)` for smart HTTP reads and clones.
Ephemeral remotes end in `+ephemeral.git`; their token still names the original
repository. Ephemeral refs have no default branch, so always name the ref.
Tags have no namespace option in the provider API.

Verified against Code Storage's [OpenAPI](https://code.storage/docs/openapi.json)
on 2026-10-23: `ReposBranchesCreateRequest.base_is_ephemeral` and
`target_is_ephemeral`, and the `ephemeral` query parameter on branches, files,
file and commits. The [namespace guide](https://code.storage/docs/repos/ephemeral-branches.md)
documents the remote suffix and isolation from GitHub.

For a sandbox that may read only one ephemeral branch, use
`GitProxy.uploadPack(request, upstream, branch)` with its persisted branch.
An ephemeral namespace alone is not an access boundary: it can contain other
conversations' refs. The scoped proxy synthesizes a one-branch v0 advertisement
and validates every upload-pack want. See [the API contract](api.md#branch-scoped-sandbox-access).

# `@smthrs/effect-code-storage`

## 0.1.0 (unreleased)

### Fixed

- `gitRemote` builds its URL on the new `Credentials.gitUrl`
  (`CODE_STORAGE_GIT_URL`), so a host on another deployment no longer gets a
  production git URL with a freshly signed token. It defaults to
  `https://<org>.code.storage`, as before.
- A repository name with an empty, `.` or `..` segment fails
  `invalid_argument` before a token is signed or a request sent, and is a
  `CodeStorageInvalidRepository` defect for `gitRemote`. `deleteRepo("")` no
  longer sends `DELETE /api/repos`.
- Requests that carry a token or credential never follow a redirect. A 3xx is
  `CodeStorageError` code `redirect`, `GitRemoteError` code `unavailable`, and
  a bodyless 502 from `GitProxy.uploadPack` counted as outcome `redirect`.
- `GitRemote.ref` fails `invalid_argument`, sending nothing, for a branch too
  long for one pkt-line (65,520 bytes), instead of sending a corrupt length.
- `GitProxy.uploadPack` records the end of a body with the request's logger,
  metric registry and clock when the server streams it with other services.

- Branch-scoped fetches now accept Git's gzip negotiation requests after a
  repository grows beyond a few dozen commits, keeping the 1 MiB limit on
  decoded bytes and the same branch checks.

### Added

- `CodeStorage.CodeStorage`: the Code Storage client as a service, with
  `layer(credentials)` and `layerConfig` (`CODE_STORAGE_ORG`,
  `CODE_STORAGE_KEY`, `CODE_STORAGE_API_URL`).
- `createRepo` (with a public GitHub upstream), `pullUpstream`, `listFiles`,
  `readFile` (capped at `maxBytes`) and `listCommits`, on the documented
  `/api/repos/...` routes.
- Per-request ES256 tokens signed with WebCrypto: one repository, the one
  scope the call needs, five minutes long.
- `CodeStorageError` with Code Storage's stable `code`, the HTTP status and
  `Retry-After`, never its free-text detail; `isTransient`.
- `GitRemote.head`: a git remote's HEAD commit and branch over smart HTTP,
  with no credential, reading at most the first ref line and 64 KiB. Packets
  are framed by bytes, so a non-ASCII branch reads back exactly; a service or
  HEAD line that isn't UTF-8 is `invalid_response`.
- One span and one count per call: `code_storage_requests` and
  `git_remote_requests`.
- `code_storage_bytes_read` by `operation`, and `bytesRead` on each page: the
  outbound transfer Code Storage bills, which its API doesn't report.
- `CodeStorageError.retryAfterMs` is now `retryAfterMillis`, the name
  `@smthrs/flow`'s `RetryPolicy` reads, so a flow waits Code Storage's
  `Retry-After`.
- An undocumented error code becomes its status's generic code, as the docs
  say, and stays on the error as `unknownCode`.

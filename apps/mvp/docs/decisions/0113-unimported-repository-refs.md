# 0113 — Refs before import

A repository without a ready mirror head answers `GET /api/repos/<owner>/<name>/refs` with `204`, `X-Repo-State: not_imported` and `Cache-Control: private, no-store`. This includes a mirror still importing. A missing mirror says nothing about GitHub's repository or the person's access there.

`RepoReads` distinguishes `not_imported` from a missing ref in a ready mirror. The latter remains an error, as do unavailable Postgres, Code Storage and missing configuration. The browser maps the empty response to its existing missing-mirror result; agent reads retain their declared `RepoNotFound` contract. No empty branch list or invented head is returned or cached.

This follows the optional home file's successful absent response. It fixes core read infrastructure; no plugin feature or library is introduced. Library catalog: `@smthrs/effect-code-storage` for mirror reads.

## Curated About reads (2026-10-26)

A live ChatApi tail on the Effect repository confirmed the required anonymous REST repository read was refused
with GitHub 403, rate limited, zero quota remaining. Curated repositories are explicit deployment data: their public
About reads use the existing deployment read token over REST, even for visitors. REST retains the private-repository
refusal. Other visitor inputs keep their existing token policy. This fixes read infrastructure, not audience or write
authority; the library catalog entry is `@smthrs/integrations` GitHubClient and AppAuth.

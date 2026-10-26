# 0112 — Refs before import

A repository without a ready mirror head answers `GET /api/repos/<owner>/<name>/refs` with `204`, `X-Repo-State: not_imported` and `Cache-Control: private, no-store`. This includes a mirror still importing. A missing mirror says nothing about GitHub's repository or the person's access there.

`RepoReads` distinguishes `not_imported` from a missing ref in a ready mirror. The latter remains an error, as do unavailable Postgres, Code Storage and missing configuration. The browser maps the empty response to its existing missing-mirror result; agent reads retain their declared `RepoNotFound` contract. No empty branch list or invented head is returned or cached.

This follows the optional home file's successful absent response. It fixes core read infrastructure; no plugin feature or library is introduced. Library catalog: `@smthrs/effect-code-storage` for mirror reads.

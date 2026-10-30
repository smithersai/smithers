# 0126: Repository feeds: an outside collector pushes a repository's status, and plugins draw it

Status: accepted (smithers-factory, 2026-10-30). Will reviews it with the feature (HOST-3).

## Problem

Will asked for the VibeLang factory (factory.vibelang.sh) to run on Smithers, at factory.smithers.sh, with feature
parity and Smithers' own features on top (2026-10-30: "We should theoretically be able to recreate our factory ui using
Smithers"). The factory's data does not live in Smithers: a collector on Will's Mac (`server.py`) reads the build hosts
and the orchestrator's lane files every 30 seconds and pushes a JSON snapshot to a Worker with a bearer token. Will
answers the decisions it shows, and the collector takes the answers back. Smithers had no way to receive data from
outside, no way to show it to a plugin, and no plugin view scoped to a repository.

## Decision

1. **Push, not pull.** The collector gets a second push target, Smithers. A Smithers flow polling the old Worker would
   need its password, couple Smithers to the system it replaces, and run a Durable Object every 30 seconds while
   nothing changed. The collector already batches, retries and pushes only what changed.
2. **One generic primitive: a repository's feeds.** A feed document is a named JSON value on one repository,
   `(repo, name) -> { visibility, body, updated_at }`, in Postgres (`feed_documents`). Nothing in the core names the
   factory or VibeLang; any outside system (a CI farm, a monitor, a release bot) can feed a repository the same way.
3. **Writing takes a feed key.** `POST /api/repos/<owner>/<name>/feeds` with `Authorization: Bearer <key>` and
   `{ "set": { "<name>": { "visibility": "public" | "maintainers", "body": <json> } } }` upserts each document (a
   `null` value deletes it). The deployment's `FEED_KEYS` lists `owner/name=<sha256 hex of the key>` pairs: it holds
   only hashes, never a key, so it is configuration, not a secret, and arrives through Effect `Config` with the
   deployment's other values. A Maintainer-managed key in Settings is a later slice.
4. **Reading follows the repository's roles, not a password.** `public` documents sync to anyone, signed out included;
   `maintainers` documents only to a Maintainer or Admin of that repository in person (`RepoRoles`, decision 0079).
   This replaces the old factory's shared password.
5. **Small documents sync eagerly, large ones on demand.** `GET /api/shapes/feeds?repo=<owner>/<name>` syncs every
   document whose name has no `/` (the index: lanes, commits, failures, grades). A name with a `/`
   (`transcript/<lane>`, `diff/<commit>`, `report/<round>/<who>`) syncs only through
   `GET /api/shapes/feeds?repo=…&name=<name>`, opened while a view shows it and never kept on the device.
6. **Answers go back as a person's write.** `feed/answer` is a person-only flow (Maintainer and up, in person, like
   `run/answer`): `POST /api/repos/<owner>/<name>/feeds/answers { id, item, choice, text }` records the answer in
   `feed_answers`, keyed by `id`, so a resend changes nothing. The collector reads them with its key from
   `GET /api/repos/<owner>/<name>/feeds/answers?after=<cursor>`; reading never deletes, so a lost response loses
   nothing.
7. **Plugins read feeds as core queries.** `core/feeds` (the index rows of the viewed repository) and `core/feed` (one
   on-demand document) join `core/waits` and `core/bug-reports` in the host's facts.
8. **Plugin views may be scoped to a repository.** The manifest's `scope: "repository"` view, refused by the UI host
   until now, shows at `/<owner>/<repo>/-/<plugin>/<path>`, and `repo.tabs` slots draw in the repository's header.
   The `-` segment keeps every plugin path apart from the core's repository routes.
9. **The factory is a first-party plugin,** `plugins/factory/`, with one view per tab of the old factory and the slash
   commands `/status`, `/lanes`, `/decide` and `/review`. Its Docs view is the core's docs pane, and its review is the
   core's pull request review.
10. **A hostname may open one page.** `APP_ALIASES` (`factory.smithers.sh=/smithersai/vibelang/-/factory`) attaches
    extra hostnames to the site Worker; `/` there redirects to the page, and every other path is the app. Signing in
    at an alias needs its callback URL registered on the GitHub App.

## Consequences

- The old factory keeps running until the Smithers one has parity; the collector pushes to both.
- A feed key leaked lets its holder overwrite that repository's feed documents and read its answers, nothing else.
- Media (videos with range requests) needs blob storage, a later slice of this decision.

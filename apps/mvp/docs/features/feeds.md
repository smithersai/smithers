# Repository feeds

An outside system pushes named JSON documents onto a repository, and plugins draw them. Will, 2026-10-30: "We should theoretically be able to recreate our factory ui using Smithers". The VibeLang factory's collector reads its build hosts and lanes every 30 seconds; it pushes the same snapshot to Smithers, and a Maintainer answers the decisions it shows. [Decision 0126](../decisions/0126-repository-feeds.md) says why it is a push, one generic primitive, and roles instead of a password.

```
collector ──POST .../feeds (feed key)──▶ ChatApi ──▶ feed_documents ──Electric──▶ tab: core/feeds, core/feed ──▶ plugin view
collector ◀──GET .../feeds/answers?after (feed key)── feed_answers ◀── ChatApi ◀── feed/answer (a Maintainer, in person)
```

Nothing in the core names the factory: a CI farm, a monitor or a release bot feeds a repository the same way.

## A document

`(repo, name) -> { visibility, body, updated_at }`, one row of `feed_documents` (migration `0073_feeds`), keyed by `id` = `<owner/name lowercased>:<name>`.

| Part | Rule |
|---|---|
| `name` | `[a-z0-9_.-]+(/[A-Za-z0-9_.:-]+)*`, at most 200 characters: `lanes`, `transcript/lane-3`, `report/r2/Codex:astra` |
| `visibility` | `public`: everyone, signed out included. `maintainers`: the repository's Maintainers and Admins in person ([RepoRoles](../decisions/0079-roles-per-repository.md)) |
| `body` | any JSON, at most 1 MiB |

A name without `/` is in the repository's **index**, which a tab syncs eagerly. A name with `/` is **on demand**: it syncs only while a view shows it and is never kept on the device.

## The routes

| Route | Who | Answers |
|---|---|---|
| `POST /api/repos/<owner>/<name>/feeds` `{ set: { <name>: { visibility, body } \| null } }` | `Authorization: Bearer <feed key>` | `200 { written, unchanged, deleted }`. A body equal to the stored one is left alone, so Electric sends nothing. `401 authentication`, `400 invalid` or `invalid_name`, `413 too_large` (2 MiB a request, 1 MiB a document, 200 documents), `503 off` (no `FEED_KEYS`) |
| `GET /api/repos/<owner>/<name>/feeds/answers?after=<seq>` | the feed key | `200 { answers: [{ seq, id, item, choice, text, login, at }], next }`, oldest first, at most 200. Reading never deletes, so a lost response loses nothing: ask again from `next` |
| `POST /api/repos/<owner>/<name>/feeds/answers` `{ id, item, choice?, text? }` | a Maintainer or Admin of that repository, in person | `200 { id, seq }`; the same id again changes nothing. `401`, `403 person_only` (the agent or a credential acting for the person), `403 forbidden`, `400 invalid`, `409 conflict` (another person's id), `503 unavailable` |
| `GET /api/shapes/feeds?repo=<owner>/<name>[&name=<document>]` | anyone | the index, or the one named document. `maintainers` documents only to a Maintainer or Admin in person; anyone else, or a role that can't be read, gets the public ones. A repository or name that isn't one reads no rows |

The key compare is constant-time over the key's SHA-256. A leaked key lets its holder overwrite that repository's documents and read its answers, nothing else.

## Configuration

`FEED_KEYS` lists each repository's feed key's SHA-256 ([infrastructure.md](../infrastructure.md#credentials)): it holds hashes, never a key, so it is configuration, not a secret. Unset or blank turns the collector's routes off (`503 off`); a malformed list fails the deployment's config.

```
$ KEY=$(openssl rand -hex 32)
$ printf %s "$KEY" | shasum -a 256
FEED_KEYS=smithersai/vibelang=<that hex>
$ curl -X POST -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
    -d '{"set":{"lanes":{"visibility":"public","body":[]}}}' \
    https://smithers.sh/api/repos/smithersai/vibelang/feeds
{"written":1,"unchanged":0,"deleted":0}
```

## Answers

```
feed/answer { owner, name, id, item, choice?, text? }   a Maintainer, in person (person-only, minimum maintainer)
  feed/answer/request   POST .../feeds/answers; 500 ms doubling to a minute, for a day; a 4xx is final
  answers { id, seq }
```

It runs on the device's engine; the step is sealed, so the journal never shows the words. An answer given offline lands once the device is back. The agent never runs it: ChatApi refuses an act for the person (`person_only`, `src/flows/personOnly.ts`), and `worker/PersonOnly.test.ts` proves it.

## The browser

`FeedsStore` (`src/features/feeds/store.ts`) on the tab's `ShapeSource`, through `@smthrs/effect-electric`'s `ElectricCollection.make` and `@smthrs/effect-tanstack-db`'s `LiveQuery.make` ([libraries.md](../../../../docs/libraries.md#local-state-and-sync); the server's shape is `ShapeProxy.make`):

- `index(repo)`: the repository's index collection, opened once per repository on first ask and synced while the tab lives, by name.
- `document(repo, name)`: one document, live. It syncs while it has a listener and stops after the last one leaves; nothing is kept.

## Plugins

The host serves two core queries ([plugins.md](plugins.md#the-host-contract)), asked with `params`:

| Query | `params` | Rows |
|---|---|---|
| `core/feeds` | `{ repo: "owner/name" }` | the index, by name; the strip can select a row (`ItemRef.params` names the same `repo`) |
| `core/feed` | `{ repo, name }` | the one document, while the view listens; only shown, never selected |

Each row is `{ id, repo, name, visibility, body, updatedAt }` (`FEED_ROW`). A missing or malformed `repo` or `name` is refused `invalid_fields`.

```ts
const index = yield* host.query<FeedRow>("core/feeds", { repo: "smithersai/vibelang" })
const lane = yield* host.query<FeedRow>("core/feed", { repo: "smithersai/vibelang", name: "transcript/lane-3" })
yield* host.select({ query: "core/feeds", key: "smithersai/vibelang:lanes", params: { repo: "smithersai/vibelang" } })
```

## Observability

`feed.ingest`, `feed.answers`, `feed.answer`, `feed.shape` and their counters ([observability.md](../observability.md#repository-feeds)). Counts, codes, the repository and an answer's random id only: never a body, a document's name, an answer's words, a login or a key.

## Tests

- `worker/feeds/Api.test.ts`: every route and refusal over the compose Postgres, the key compare, the caps, unchanged bodies, the shape's audiences and its fail-closed default to public.
- `worker/PersonOnly.test.ts`: `feed/answer` refuses anyone acting for the person.
- `src/features/feeds/api.test.ts`: the device's step, its retries and final refusals.
- `src/features/feeds/feeds.test.ts`: a collector's write reaches a plugin through `core/feeds` and `core/feed` on a real device; a Maintainer's answer reaches the collector's read, once.

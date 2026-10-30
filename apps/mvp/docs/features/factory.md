# Factory

A repository's factory, the VibeLang factory (factory.vibelang.sh) rebuilt on Smithers: the lanes an orchestrator runs, the decisions that wait on a maintainer, failures, spec and implementation reviews, commits, media and the merge queue ([decision 0126](../decisions/0126-repository-feeds.md) §9). It is the first-party plugin `plugins/factory/` over the core's repository feeds ([feeds.md](feeds.md)): a collector pushes the status, the factory draws it. Libraries: `@smthrs/plugin` (manifest, `PluginHost`) and `@smthrs/ui` (`Table`, `Badge`, `Markdown`, `DiffHunks`, `parseUnifiedFile`, `LinkTabs`), per [docs/libraries.md](../../../../docs/libraries.md).

## Where it shows

```
/<owner>/<repo>/-/factory                 Now
/<owner>/<repo>/-/factory/for-you         For you
            .../failures  .../reviews  .../implementation  .../commits
            .../agents    .../media    .../docs            .../queue
```

Every view is a `scope: "repository"` view ([plugins.md](plugins.md#repository-views)) under the repository's header. The header's `repo.tabs` slot shows **Factory** only on a repository whose feed has documents. Every view's first row is the factory's tabs and the status's age. A narrow screen gets one column and hides the long text columns.

| View | What it draws, from which documents |
|---|---|
| Now | Scoreboard (spec streak, implementation grades, VIP constructs, main, example repositories), the spec round and its grades (each opens its report), implementation progress, main and the migrations, the running lanes, what waits, events. `grades`, `impl_grades`, `vip`, `postmerge`, `migrations`, `agents`, `for_will`, `events`, `a_streak` |
| For you | Decisions waiting, past ones with their answer, and the open questions (`needs`). `for_will`, `answered` |
| Failures | Open and resolved, by kind. `failures` |
| Spec reviews | Each round's four reviewers, a reviewer at work, findings by origin. `grades`, `origins`, `agents` |
| Implementation | Constructs pending per VIP, verdicts with their reports, lanes, what landed. `impl`, `impl_grades`, `vip`, `agents` |
| Commits | Main's newest commits; one opens its diff in `@smthrs/ui`'s `DiffHunks`. `commits`, `diff/<id>` |
| Agents | Every lane: machine, model and account, state, duration; one opens its live transcript. Daemons; accounts for a maintainer. `agents`, `daemons`, `transcript/<lane>`, `accounts` |
| Media | What the factory recorded, newest first. Playing it needs blob storage (decision 0126, Consequences). `media` |
| Docs | Opens the repository's docs pane. |
| Queue | The merge queue, main after each merge, the resolver, migrations, build hosts, the Telegram thread for a maintainer. `queue`, `postmerge`, `resolver`, `migrations`, `hosts`, `telegram` |

An opened document (a transcript, a diff, a report) shows in a panel over the view's right side, full width on a phone, and syncs only while it shows. A document the collector hasn't pushed yet reads `Waiting for the collector`; one the host refused reads `Not available`. A missing document or field draws as empty, never a crash (`model.ts`).

## Commands

| Slash | Goes to |
|---|---|
| `/factory` | Now on `smithersai/vibelang` |
| `/lanes` | Agents |
| `/decide` | For you |

`/status` and `/review` are the core's (`sandbox/status`, a pull request review), so the factory declares neither: a plugin command naming a core slash is refused `conflict` and would refuse the whole plugin. A command's payload is fixed by its manifest, so the three name `smithersai/vibelang`.

## The code

```
plugins/factory/
  plugin.json             10 repository views, the repo.tabs slot, 3 commands
  src/feeds.ts            the one seam to the core's feed queries
  src/tab.ts              per repository: its status, live; the opened document; a 15 s clock
  src/model.ts            pure view-models: documents → each view's rows
  src/components/*.tsx    React over the tab; no Effect
```

`feeds.ts` is the only file that names a core query. It asks `core/feeds` with `{ repo }` and `core/feed` with `{ repo, name }` (`PluginHost.query(name, params)`, `@smthrs/plugin` 1.2), with the repository lowercased as feeds key it.

## Observability

The factory writes no records of its own: what it does is the host's (`plugin.load`, `smithers_plugin_loads`, `plugin.request` refusals, `flow.dispatch` of `app/navigate`, [plugins.md](plugins.md#observability)) and the feeds' (`feed.shape` per index and document sync, [feeds.md](feeds.md)). None carries a document's body.

## Not yet

- **Answering.** The decisions show; answering them from the strip waits on a row per decision. The strip acts on one row of a query, and `$item.<list>[$event.index]` reaches one level into it, but `core/feeds` has one row for all of `for_will`, and `feed/answer` needs an answer id (a UUID) no binding can make. The tab already follows `core/feed-asks` rows (`{ key, repo, item, options }`) and selects the first open one (`feeds.ts`, `tab.ts`); the host refuses that query today, so no Answer button shows. Once the core serves it with `owner`, `name` and an answer id per row, the manifest adds `core/feed-asks` to For you's `reads`, `feed/answer` to `uses`, an `answer` event (`{ owner: "$item.owner", name: "$item.name", id: "$item.answer", item: "$item.item", choice: "$item.options[$event.index]", text: "$event.note" }`) and a `digit` key.
- **A command for the repository you are on.** The commands name `smithersai/vibelang`.

## Tests

- `plugins/factory/src/model.test.ts`: every view-model over `status.sample.json`, a trimmed real status with hosts' paths and accounts removed, and over empty and malformed documents.
- `plugins/factory/src/tab.test.ts`: the tab over an injected `PluginHost` (TEST-7): each repository's status from its own documents, a refused feed, an opened document followed only while it shows, ask selection, navigation.
- `src/plugins/facts.test.ts`: the manifest loads with nothing refused.
- `e2e/factory-plugin.spec.ts`: pushes the sample through `POST /api/repos/<owner>/<name>/feeds`, then a visitor opens Factory, a lane's transcript, a commit's diff and For you. It needs `E2E_FEED_REPOSITORY` and `E2E_FEED_KEY` (need `feedKey`).

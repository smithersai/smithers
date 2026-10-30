# Factory

A repository's factory, the VibeLang factory (factory.vibelang.sh) rebuilt on Smithers: the lanes an orchestrator runs, the decisions that wait on a maintainer, failures, spec and implementation reviews, commits, media and the merge queue ([decision 0126](../decisions/0126-repository-feeds.md) §9). It is the first-party plugin `plugins/factory/` over the core's repository feeds ([feeds.md](feeds.md)): a collector pushes the status, the factory draws it. Libraries: `@smthrs/plugin` (manifest, `PluginHost`) and `@smthrs/ui` (`Table`, `Badge`, `Markdown`, `DiffHunks`, `parseUnifiedFile`, `LinkTabs`, `RelativeTime`), per [docs/libraries.md](../../../../docs/libraries.md).

## Where it shows

```
/<owner>/<repo>/-/factory                 Now
/<owner>/<repo>/-/factory/for-you         For you
            .../failures  .../reviews  .../implementation  .../commits
            .../agents    .../media    .../docs            .../queue
```

Every view is a `scope: "repository"` view ([plugins.md](plugins.md#repository-views)) under the repository's header. The header's `repo.tabs` slot shows **Factory** only on a repository whose feed has documents. Every view's first row is the factory's tabs and the status's age (`RelativeTime`, ticking). Durations count to the status's own time, so a view shows the factory as of its last push; the tab keeps no timer (rule `durable.no-hand-rolled-durability`). A narrow screen gets one column and hides the long text columns.

| View | What it draws, from which documents |
|---|---|
| Now | Scoreboard (spec streak, implementation grades, VIP constructs, main, example repositories), the spec round and its grades (each opens its report), implementation progress, main and the migrations, the running lanes, what waits, events. `grades`, `impl_grades`, `vip`, `postmerge`, `migrations`, `agents`, `for_will`, `events`, `a_streak` |
| For you | For a maintainer: decisions waiting, answered from the strip; past ones with their answer; the open questions (`needs`). `for_will`, `answered`, `core/feed-items` of `for_will` |
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
| `/decide` | For you (a maintainer's) |

`/status` and `/review` are the core's (`sandbox/status`, a pull request review), so the factory declares neither: a plugin command naming a core slash is refused `conflict` and would refuse the whole plugin. A command's payload is fixed by its manifest, so the three name `smithersai/vibelang`.

## The code

```
plugins/factory/
  plugin.json             10 repository views, the repo.tabs slot, 3 commands, For you's answer events and keys
  src/feeds.ts            the one seam to the core's feed queries
  src/tab.ts              per repository: its status, live; the opened document
  src/model.ts            pure view-models: documents → each view's rows
  src/components/*.tsx    React over the tab; no Effect
```

`feeds.ts` is the only file that names a core query. It asks `core/feeds` with `{ repo }`, `core/feed` with `{ repo, name }` and `core/feed-items` with `{ repo, name: "for_will" }` (`PluginHost.query(name, params)`, `@smthrs/plugin` 1.2), with the repository lowercased as feeds key it.

## Observability

The factory writes no records of its own: what it does is the host's (`plugin.load`, `smithers_plugin_loads`, `plugin.request` refusals, `flow.dispatch` of `app/navigate`, [plugins.md](plugins.md#observability)) and the feeds' (`feed.shape` per index and document sync, [feeds.md](feeds.md)). None carries a document's body.

## Answering

A decision is answered through the core's person-only `feed/answer`, which only the host's action strip sends ([plugins.md](plugins.md#the-action-strip)); the factory never dispatches it. For you reads `core/feed-items` of `for_will` ([feeds.md](feeds.md#items)): one row per decision, with the repository, the decision's id, its `options` and the answer's id.

```
For you   the tab selects the first decision waiting (not `decided`, not in `answered`); Answer on another selects it
strip     [Note]   Accept a   Change c                   the old factory's two answers, each with the note
          [Note]   2A 1   2B 2                           or, for a decision that lists `options`, one button each, 1-9
press     feed/answer { owner, name, id: $item.answer, item, choice, text: note }   on the device, sealed, retried a day
collector GET .../feeds/answers?after=   pushes `answered`; the decision leaves Waiting and the strip moves on
```

- **Choices.** A decision without `options` gets the old factory's two: Accept (`choice: "accept"`, key `a`) and Change (`choice: "change"`, key `c`), each with the note, which may be empty, as the collector already reads them. A `for_will` element that lists `options` gets one button per option instead, keyed `1`–`9` (`item.chooses`).
- **Once.** A second press while one is on its way does nothing; a press after it went, before the collector reports it, sends the same answer id, so the server keeps one answer. The first answer stands until the collector pushes a new version of the decision.
- **Who.** For you and `/decide` are a maintainer's (`minimum: "maintainer"`, the floor `feed/answer` sets); ChatApi checks the person is a Maintainer or Admin of the repository, in person.
- **Past answers** show from the collector's `answered` document. Smithers' own record of answers is the collector's to read (with its key); no core query shows it.

## Not yet

- **A command for the repository you are on.** The commands name `smithersai/vibelang`.

## Tests

- `plugins/factory/src/model.test.ts`: every view-model over `status.sample.json`, a trimmed real status with hosts' paths and accounts removed, and over empty and malformed documents.
- `plugins/factory/src/tab.test.ts`: the tab over an injected `PluginHost` (TEST-7): each repository's status from its own documents, a refused feed, an opened document followed only while it shows, ask selection (only what waits), navigation.
- `src/plugins/facts.test.ts`: the manifest loads with nothing refused; For you's events are person-only and a maintainer's.
- `src/plugins/factory.test.ts`: For you on a real device: the strip answers by option and note, once however often pressed, then the next decision by `c` (Change); the collector reads each answer once.
- `e2e/factory-plugin.spec.ts`: pushes the sample through `POST /api/repos/<owner>/<name>/feeds`, then opens Factory, a lane's transcript, a commit's diff, For you with its strip (answered locally), and a 390 px phone, saving a screenshot of each (`factory-*.png` beside the results). Locally it uses `alchemy dev`'s development feed key on the dev server's own repository ([feeds.md](feeds.md#development)); on a deployment it needs `E2E_FEED_REPOSITORY` and `E2E_FEED_KEY` (need `feedKey`) and leaves the decision unanswered.

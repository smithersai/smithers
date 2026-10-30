# Plugins

Like webpack, the app is a core of primitives plus plugins, and our own features are plugins on the same public interface anyone uses (ruling PLUGIN-1, [decision 0017](../decisions/0017-everything-is-a-plugin.md)). The queue uses the UI host ([decision 0031](../decisions/0031-review-queue.md)); conversation creation has its own scoped flow execution point.

## A plugin

A built-in UI plugin is a folder in `apps/mvp/plugins/<id>/`:

```
plugins/queue/
  plugin.json              the manifest: data, read without running plugin code
  src/tab.ts               `tab`: an Effect from PluginHost to { queries, actions }
  src/components/*.tsx     React over { queries, actions }; the names its `component` renders name
```

`plugin.json` is decoded and checked by `@smthrs/plugin`'s `Manifest` and `Load` ([library catalog](../../../../docs/libraries.md)). It declares the flows the plugin borrows (`uses`), its capability ceiling (`capabilities`), and what it contributes. The core names a UI plugin in `src/plugins/builtin.ts` and a flow plugin in the server-safe `src/plugins/builtinFlows.ts`; deleting the folder and its registry line removes the feature (rule [`plugin.core-names-no-plugin`](../rules.md#plugincore-names-no-plugin)). A plugin imports only `@smthrs/*` roots, `react`, `@tanstack/react-db`, `effect` and its own folder ([`plugin.public-interface-only`](../rules.md#pluginpublic-interface-only)).

## Loading

```
boot ─ Plugins.layer ─ Load.load(hostFacts, BUILTIN manifests)
         │  decode · requires.api · order · check against the catalog ─▶ contributions | refusals
         ▼
       plugin.load span + smithers_plugin_loads per plugin; smithers_plugin_contributions by point
use    a slot draws · a view opens · a key or command fires ─▶ the plugin's chunks load, its tab is built once
```

- **The UI host's points.** `Plugins.layer` implements `views`, `slots`, `commands` and `keybindings` (with view events). The UI host refuses owned flows and other unsupported points with `unsupported_point`; nothing it declares is silently ignored (`src/plugins/contract.ts`). The creation host below separately admits one selected owned flow.
- **A refused plugin never blocks boot.** It is logged as `plugin.refused` with its reason and the field (`contributes.keybindings[2].event`), and the rest load. A component that throws, or a chunk that fails, shows one line naming the plugin, and the shell stays (`Boundary.tsx`).
- **Lazy.** No component, tab or flow body loads at boot. A plugin's tab is built on first use, in the host's scope, from `PluginHost` alone.

## Branch flows

New conversations use `branch/creation/start`, which selects a plugin implementation before executing its code. The default is `plugins/branches`: its public `Flow.make("branches/create", …)` calls `branches/ephemeral`, creating a Smithers-only branch. It does not publish to GitHub. Publish and Update branch select and run the same plugin's `branches/publish` and `branches/update` the same way, through `branch/operation/start` ([branch publish](branch-publish.md#overriding-the-flows)).

A repository selects an implementation in `.smithers/branch.json`:

```json
{ "plugin": "team-branches", "flow": "create", "publish": "ship", "update": "sync" }
```

`flow` names the creation flow; `publish` and `update` the operations' flows. An operation the configuration names no flow for runs the first-party one. Members and above use `GET /api/branches/creation?operation=<create|publish|update>`, which reads that configuration, `.smithers/plugins/team-branches/plugin.json`, and `.smithers/flows/team-branches/create/flow.ts` at one default-branch commit. The manifest must own `create`, match its plugin id, and pass the same public `Manifest` and `Load` checks. This host advertises only the `flows` point; UI contributions remain unsupported here. Missing configuration selects the default; malformed, missing or unavailable installation files fail without falling back.

The browser's durable engine journals the selected source, commit, digest and interpreter version. Repository source runs in the SDK realm, with host operations limited to the manifest's declared `uses` and to its operation's own actions (`OPERATION_ACTIONS`): for creation `branches/ephemeral` (`git:write`) and, when explicitly selected, `branches/github` (`github:write`); for Publish `branches/github-publish`, for Update branch `branches/github-update` (both `github:write`). The host fixes the repository, request identity and permissions; the plugin supplies the branch name. Completion requires the matching durable write receipt. Source cannot replace a system action, widen its capabilities, read credentials or install itself in the global UI catalog.

This execution point supports repository-owned branch creation flows. General repository flow contributions to `Plugins.layer`, custom UI code and other execution points remain unavailable.

## Trust boundaries

The loader checks every manifest against the host's facts (`src/plugins/facts.ts`):

| Boundary | How it holds | Refusal |
|---|---|---|
| System flows can't be overridden | Every existing system flow remains the core's: a plugin may borrow one through `uses`, never own, replace or rename one. The creation host admits a separate owned tag without replacing a system flow. Owned flow tags, plugin ids and contribution ids may not start with a reserved segment (`app`, `chat`, `run`, `flow`, `secret`, `auth`, `system`, `plugin`, `core`, …). | `conflict`, `reserved` |
| A plugin acts only through what it declares | A contribution may name only flows it owns or `uses`; every used flow's capabilities must be in the manifest's ceiling; `PluginHost` serves only the queries its contributions `read` and the events its views declare. | `undeclared_use`, `capability_exceeded`; at run time `undeclared_query`, `undeclared_event` |
| Person-only actions need a person | A command may point at a person-only flow only in a built-in plugin, and a plugin keys only its own commands. An event whose flow is person-only (a `userOnlyReason` in the registry, as `run/answer`) is never dispatched for plugin code: `PluginHost.dispatch` refuses it `person_only`. The host's action strip draws it under the view, and the person's press (door `button`) or key (door `key`) sends it with their own session ([run credentials](sign-in.md#run-credentials)). | `person_only` |
| Nobody sees what the server refuses | A view's, slot's or command's `minimum` must be at least every flow it dispatches. | `minimum_below_flow` |
| Secrets stay opaque | No tier holds a `secret:` capability until an Admin's per-installation grant exists (decision 0017 slice 6), and a schema field named like a secret, `format: "password"` or `writeOnly` is refused, so a plugin never collects or reads one. No core query carries a secret. | `capability_exceeded`, `secret_field` |

Compiled UI plugin chunks run with the app's full power: the import rules are hygiene, its boundary is code review and the build (decision 0017, "Compiled code is trusted application code").

## The host contract

`PluginHost` (`@smthrs/plugin`) is the one contract a plugin's tab reads and acts through; the app implements it per plugin (`src/plugins/plugins.ts`, `hostFor`):

| Member | What it does here |
|---|---|
| `query(name, params?)` | The rows of a declared query, live: `core/waits` is the viewer's open waits, oldest first (from the synced `runs`, [agent status](agent-status.md)); `core/feeds` and `core/feed` take `params` ([below](#repository-feeds)). |
| `select(item)` | The row the person is looking at, in its query as asked with `item.params`; the strip under every view of the plugin that reads its query acts on it. A key that isn't a row is refused `not_in_reads`. |
| `propose(event, fields)` | Prefills the strip's note from a strip event's text field. Nothing runs until the person presses. |
| `dispatch(event, fields)` | Runs an event whose flow isn't person-only, door `view`. Answers the run's id and `settled`, which waits for its end: `Done`, or `Failed` with the failure's stable code (a refusal's `code`, else its kind, dispatch's refusal, `interrupted`), never a message. |
| `open(view)` | Navigates to one of the plugin's views (`app/navigate`). |
| `events(view)` | The view's local events the keymap delivered (`j`, `k`). |

## The action strip

Under a plugin's view, in host UI (`ActionStrip.tsx`, `src/plugins/strip.ts`): one button per person-only event whose key's `when` holds for the selected item. An event that picks one of the item's choices (`$item.options[$event.index]`) is one button per choice, keyed `1` to `9`. One text box fills every text field (a note); it declares `i`, which the app's one-key shortcuts focus, and `Esc` leaves it. A note belongs to its item: it is kept on the device per view and item (`plugin-drafts`, src/device/registry.ts), so a reload keeps it and it never rides with another item, and it is dropped once its answer went. A button acts only on the item it was drawn for: if that item moved on meanwhile (answered on another device, a new version), the press does nothing (`stale`). While a press is on its way the strip shows `Sending` and further presses do nothing, so two presses record one answer; a failed press shows `Not sent`, keeps the note, and the next press retries. A view's keys are its own bindings: another plugin's binding of an event with the same name never changes this strip.

**Not yet.** `core/waits` rows have no `deadline` or `addressedTo` (slice 2). The loader knows a core flow's payload field names but not which are required or their types (`src/plugins/facts.ts`), so an event whose args miss a required field loads and its press ends `Not sent` (`invalid`).

## Keys

`src/plugins/keymap.ts` is the one judge of plugins' keybindings: two-stroke keys (`g q`, within 1 s), `digit`, `mod+enter` (⌘ on a Mac, Ctrl elsewhere), and the `when` grammar (`view == <id>`, `item.<field>`, `focus.input`, `!`, `&&`). A key with no modifier never fires while the person types in a field. A command runs its flow with door `key`; a person-only event presses the strip; a local event goes to its view.

## Views, slots and commands

- **Views** show at `/app/<plugin>/<path>` full size (`PluginScreen.tsx`), with the strip under them. A person below the view's `minimum` sees the page's header alone. Inline views in the conversation come later.
- **Slots** are named places the shell draws: `shell.nav` holds the queue's count and Report a bug beside Flows, Runs and Settings; `repo.tabs` sits in the repository's header after Stack and Secrets.
- **Commands** never shadow the core's own slash commands: the host's facts list them (`Load.HostFacts.slash`), and a plugin command naming one (`/status`) is refused `conflict`.

## Repository views

A view with `scope: "repository"` belongs to one repository's page (decision 0126 §8):

```
/<owner>/<repo>/-/<plugin>/<path>      RepoPluginScreen: the repository's header, the view, the strip
       │                                the `-` segment keeps plugin paths apart from the core's repository routes
       ├─ route   enterRepository opens the repository (header, role), then shows the view
       ├─ header  <Slot name="repo.tabs" repository={owner/name}>: the plugin's tab link
       └─ view    <Component tab repository={{ owner, name }} />   (Host.Rendered)
```

- The route `/$owner/$repo/-/$plugin/$` (and its index) finds the view with `viewAt(plugin, path, "repository")`; an `app` view is never a repository page, and a path no plugin declares is not found. `worker/appRoute.ts` serves the document for every built-in's repository paths.
- A component, view or `repo.tabs` entry, receives the repository it shows on as `repository` beside `tab`. A tab is built once per plugin, so its queries take the repository as an argument.
- `Host.pathOf(view, repository)` is the one path grammar; `PluginHost.open(view, repository)` navigates there, and does nothing for a repository view without one.
- **Commands** with a `slash` join the composer's menu, running their flow with the payload the manifest fixes: `/queue` runs `app/navigate` to `/app/queue`.

## The queue

The first plugin (`plugins/queue/`): everything that waits on you, one item at a time, oldest first, full screen, by keyboard. `g q` or `/queue` opens it; `j` and `k` move; the strip answers: `1`–`9` picks an option, `a` approves and `r` asks for changes (each with the note), `⌘↵` sends the note as a reply. Its only wiring is its manifest and `PluginHost`; it never dispatches `run/answer` itself.

## Bug reports

The second plugin (`plugins/bugs/`, [bugs.md](bugs.md)): `/bug` and the header's Report a bug open its form, whose Send runs its `send` event, bound to the core's `app/bug/report`; `/bugs` and a report's bell entry open its inbox, which reads the core's `core/bug-reports`. The flows are the core's: a plugin can't own an `app/` flow, and the UI host runs no owned flows yet.

## Repository feeds

The core queries `core/feeds` (a repository's index) and `core/feed` (one on-demand document) serve what an outside collector pushed to a repository ([feeds.md](feeds.md#plugins)). Both take `params`: `query("core/feeds", { repo: "owner/name" })`, `query("core/feed", { repo, name })`; a missing or malformed one is refused `invalid_fields`. The strip selects a row of `core/feeds` when the `ItemRef` names the same `params`; a `core/feed` document is only shown.

## Observability

`plugin.load` (a span and log line per plugin: id, version, tier, outcome, reason), `smithers_plugin_loads`, `smithers_plugin_contributions` by point, `plugin.press` and `smithers_plugin_presses` (plugin, event, door, outcome: `done`, `failed`, `invalid`, `stale`), `plugin.key` and `smithers_plugin_keys`, and `flow.dispatch` with door `key`. None carries a manifest's text, an item or a note ([observability](../observability.md)).

## Tests

- `@smthrs/plugin`'s suite: the manifest, the checks and every refusal reason, the binding, `when` and key grammars, fuzzed decoding.
- `src/plugins/*.test.ts`: the app's manifests load with no refusal; the trust boundaries above against the real registry; `PluginHost` scoping and its refusals; the strip and the keymap over a real device (`src/test/chatApi.ts`).
- `plugins/queue/src/tab.test.ts`: the queue over real waits, answered through the strip, on a real device.
- `e2e/queue.spec.ts`: the agent asks three times; `g q`; `2`, `j`, a note and `a`, `1`; every asking run goes on. With a GIF.

Full-size plugin headers show the host connection pill, including Offline, queued writes and Retry, so cached queue contents remain qualified.

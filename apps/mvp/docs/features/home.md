# A repository's home

A repository declares its own home, the page `/$owner/$repo` shows instead of its file tree, in `.smithers/home.json` on its default branch. The home is data, never code: sections of blocks of a closed set of kinds that the app draws itself, and nothing runs when the page opens. Each section names who sees it: everyone, contributors or maintainers. A repository that declares no home and that Smithers curates one for, such as `Effect-TS/effect`, opens on Smithers' curated home. The tree is one tab away, and `/tree/` and `/blob/` links open what they name. A repository with neither opens on its tree, as before. Will, 2026-10-20: "ability to create a repositories own home view is important"; 17:31, on the first recording: "be more thoughtful about what features we might show a maintainer if it's a maintainer home page or what features we would show a user". Decision: [0014](../decisions/0014-flows-authoring-debugging-and-home-view.md) §4; spec M-45. The design is [design/repo-home/repo-home.html](../design/repo-home/repo-home.html).

```
/$owner/$repo ─ beforeLoad ─▶ repo.warmRoute + home.warm, then repo.openRoute (the tree, as before)
                       └▶ home.open ┬ GET /api/repos/<o>/<n>/home ─▶ { audience, curated }   (ChatApi decides who you are)
                                    └ the repository ready on this device (Electric) ─▶ its head commit
                                       ├ homes has <repoId>@<sha>: drawn at once (a home at a commit never changes)
                                       └ GET …/blob/<sha>/.smithers/home.json ─▶ Home.read (@smthrs/views)
                                            declared ─▶ each Markdown block's file, GET …/blob/<sha>/<path>
page:  its own home, a section you may see ─▶ [Home] [Code] and RepositoryHome (@smthrs/ui)
       none, a curated home                 ─▶ [Home] [Code] and the curated home
       neither                               ─▶ the tree
       its own home invalid, unreadable      ─▶ the tree under "Home is invalid" or "Couldn't read home"
```

## Who sees what

| Audience | Who | Sees |
|---|---|---|
| `everyone` | anyone who may open the page, signed out included | everyone's sections |
| `contributor` | anyone signed in with a role on the repository, a Guest included; and anyone at all on a home that says `"contributors": "anyone"` | everyone's and contributors' sections |
| `maintainer` | a Maintainer or an Admin of the repository | every section |

- **ChatApi decides the audience** from the session (`audienceOf`, `src/features/home/contract.ts`), in `GET /api/repos/<owner>/<name>/home`. It answers a curated home with only the sections that audience may see, so a maintainers' section never reaches anyone else's browser.
- **A role counts only on its repository.** A session's role is the person's role on the repository sign-in reads roles on (`GITHUB_REPOSITORY`, [sign-in](sign-in.md#roles-and-role-checks)). On any other repository ChatApi answers as for someone with no role: a Maintainer of this deployment's repository sees `Effect-TS/effect` as a visitor does. Local development's people hold their roles on the dev server's `GITHUB_REPOSITORY` too.
- **A repository's own `.smithers/home.json` is public in its repository,** so its declaration isn't secret. The page shows the sections the answered audience may see, widened by the file's own `contributors` (`Home.widen`); before ChatApi answers, everyone's.
- **A live block's rows come from their own shape,** which checks the role again: the stack is Member and above (`/api/shapes/todos`), a person's runs are their own, the issues are the synced repository's.
- **A person opens on their own view and may switch down** (SCOPE-14). `View as` lists their own view and each lower one that shows something: a maintainer `Maintainer`, `Contributor` and `User`, a contributor `Contributor` and `User`. A view above theirs never shows, and a person with one view, such as a signed-out visitor, sees no switcher, even on a home open to anyone that shows them its contributors' sections. Switching hides sections the page already has (`home.actions.view`, the current row's `viewing`); it asks nothing, and opening another repository goes back to the person's own view.
- Roles are the deployment's repository's (decision 0007 phase 1, [sign-in](sign-in.md#roles-and-role-checks)); a role on each repository is 0007 phase 2.

## Making a home

Commit `.smithers/home.json` to the default branch: a bare `blocks` list is one section for everyone, or `sections`, each with its `audience`, an optional `title` and its `blocks`. VibeLang's draft, [design/repo-home/vibelang.home.json](../design/repo-home/vibelang.home.json), is a full example:

```json
{
  "sections": [
    { "title": "Today", "audience": "maintainer", "blocks": [
      { "type": "action", "flow": "branch.new", "title": "New branch", "key": "b" },
      { "type": "issues" }, { "type": "runs" }
    ] },
    { "title": "Contribute", "audience": "contributor", "blocks": [
      { "type": "code", "title": "Set up", "language": "sh", "code": "sh scripts/setup.sh" },
      { "type": "prompt", "title": "Ask about the code" }
    ] },
    { "blocks": [
      { "type": "hero", "title": "VibeLang", "tagline": "Reliable TypeScript for the AI era, built on Effect.",
        "install": "npm create vibelang@latest my-app" }
    ] }
  ]
}
```

The home shows once the app has the commit: after the clone, or once the repository's mirror syncs that commit; before either, from what GitHub says ([before a clone](#before-a-clone)). `@smthrs/views`' [Read a repository's home](../../../../packages/smithers/ui/views/docs/read-a-home.md) lists every field and bound. `.smithers/FACTORY.ts` can also project a one-section file with `@smthrs/targets`' `Smithers.Factory.Home`, which writes the same format.

| Block | What the page draws |
|---|---|
| `hero` | the project's name, a tagline, a line, up to three links (the first primary), the install command with Copy, and an announcement above the name |
| `code` | an example's source in a card named by its file, colored for TypeScript, JavaScript and VibeLang, with Copy; beside a `hero` right before it on a wide page |
| `cards` | a grid of up to 12 cards (a label, a title, a line, a link) and a link to the rest |
| `stats` | up to 6 declared facts, a value over its label; never counted by the page |
| `releases` | up to 12 releases, each linking to its page, with its date and a line, and a link to the rest |
| `text` | a paragraph of plain text |
| `links` | links to `http` or `https` pages, each in a new tab |
| `markdown` | the repository's Markdown file at the same commit, or `Couldn't read <path>` |
| `prompt` | a band with its title and a link, `placeholder` or `Ask Smithers`, that opens the default branch's workspace with its composer open |
| `app` | a button that opens the workspace with `/<flow> ` in the composer, shown only when the composer has that command (`COMMANDS`, `src/features/commands/catalog.ts`) |
| `action` | a primary button that runs its flow at once, and its `key` while you aren't typing; leading a titled section, it sits in the heading. `branch.new` is [New branch](#new-branch) |
| `issues` | live: the synced repository's open issues counted by triage state, the ones to triage and the pull requests waiting; `Not synced` for a repository this deployment doesn't sync |
| `stack` | live: the repository's TODOs on the stack, in order, each with its state; `Sign in` or `Members only` when its shape refuses |
| `runs` | live: this person's runs, newest first, with how many failed |
| `flows` | live: this person's own flows, each opening the composer with `/flow.run <name> ` |
| `view` | nothing yet: a flow's own view in the presentation realm comes later |

A block of a kind the app doesn't know is skipped and counted (`skipped`). A file over 8 sections or 32 blocks, a section or block of a known kind that breaks its bounds (HTML in a string, a link that isn't `http` or `https`, a path that leaves the repository), a binary file, one over RepoApi's 512 KiB, or text that isn't JSON makes the home invalid: the page shows the tree under `Home is invalid`, never half a home.

## Before a clone

A repository nobody cloned still opens on its own home. What GitHub says of it (`GET /api/repos/<owner>/<name>/about`, [repo.md](repo.md#about)) carries its `.smithers/home.json` at the newest commit, so `home.actions.open` reads it from the `abouts` row the page loads anyway (`aboutOf`, `src/features/repo/actions.ts`) and draws it, keyed `<repoId>@<sha>` as a clone's read would be. A signed-out visitor to `smithersai/vibelang` sees VibeLang's landing page before anyone cloned it. Until that read ends the page shows nothing under the header, as while ChatApi is first asked. Only a home that shows whole without the clone is drawn: one with a `markdown` block, whose file needs the clone, an invalid one, or none, leaves the tree's page until the clone. Once the repository is ready on this device, its clone's read wins.

## Curated homes

A repository Smithers doesn't control, such as `Effect-TS/effect`, can't commit `.smithers/home.json`. Smithers keeps a curated home for it as data: one JSON file per repository in `worker/home/curated/` (`{ repository, defaultBranch, home }`, `home` in the very format above), listed in `worker/home/Curated.ts`. ChatApi reads a file with `Home.read`, as a page reads a repository's own; a file that isn't a home, or that holds a kind the reader doesn't know, answers no curated home and logs `invalid`. The repository's own home, once the repository is on this device, wins over the curated one; a curated home shows before the repository is cloned, since it needs nothing from it. When the plugin host lands (decision [0017](../decisions/0017-everything-is-a-plugin.md)), each curated file becomes a first-party plugin's `repo/home` tap.

[Effect's home](../../worker/home/curated/effect-ts-effect.json) is the first: for maintainers, New branch, triage and runs; for contributors, Ask, the stack, their flows, New TODO and Open an issue; for everyone, the landing page: Effect, install, an example, facts, why, the ecosystem, learning links, releases, community and Ask.

## New branch

An `action` block naming `branch.new` is New branch, the maintainer's one prominent action (Will, 2026-10-20 18:07: "The maintainer should have a prominent button to start working on a new branch"). Pressing it, or `B`, runs `branch/create { repo, branch }` ([branch workspace](branch-workspace.md#new-branch)), the flow `/branch.new` and the agent run too, with a name `<login>/<six letters and digits>`, and opens the new branch's workspace: its conversation, terminal and views. While it runs the button is disabled; when it fails the page says `Couldn't make a branch`. The forge must be Code Storage's mirror: GitHub, read with no credential, can't make a branch (`not_configured`).

## The page

- **Routes** (`src/router.tsx`): `/$owner/$repo` renders `RepoHomeScreen` (`src/screens/repo/RepoHomeScreen.tsx`), whose `beforeLoad` warms the location and the homes (`repo.actions.warmRoute`, `home.actions.warm`), then calls `repo.actions.openRoute` and `home.actions.open` ([navigation](navigation.md)). The blob and raw routes open the home too, for the tabs. The tree route, `/$owner/$repo/tree/$ref/$`, is the branch workspace ([branch-workspace.md](branch-workspace.md)) and its own Code and Terminal views.
- **Tabs** (`HomeTabs`): `Home` (`/$owner/$repo`), `Code` (`/$owner/$repo/tree/<default branch>`, the first segment of a branch named with a `/` as `$ref` and the rest as the splat) and, when the home or the curated one names docs (`"docs"`), `Docs` (`/$owner/$repo/docs`, [docs](docs.md#the-docs-tab)), with `aria-current="page"` on the one shown: the page names its tab, and the router marks a tab current only at its own URL (`activeOptions.exact`), so `Home`, whose URL leads every repository page, isn't marked beside `Code` on a file or directory. Only a repository whose home shows has them. The repository's name in the header links to `/$owner/$repo` on every repository page.
- **While the home is read** the page shows nothing under the header and tabs: while ChatApi is first asked, and once the repository is ready, while its own home is read. Without either home, it is the tree's page, which says why (`Not found`, cloning, `Sign in to clone`).
- **A prompt or app button** is a real link to the default branch's workspace. A plain click navigates in the app and, once the workspace opens, opens its composer; for an app block or a prompt naming a command the composer has, it starts the composer with `/<flow> ` (`draftFor`, `src/features/home/view.ts`). A modified click opens the link as the browser does.

## The browser

`src/features/home/`, framework-free logic beside React views ([state.md](../state.md)).

| Piece | What it is |
|---|---|
| `homes` | persisted collection (`Collection.persisted`, schema version 2), keyed `<repoId>@<sha>`: `declared` with its sections, who counts as a contributor and `skipped`, `absent`, `invalid` with its reason, or `unreadable`. A home at a commit never changes, so it is read once and kept on the device; `unreadable` is read again on the next open |
| `curated-homes` | persisted collection (version 1), keyed by repository: the curated home ChatApi last answered, `declared` with its default branch and the sections the person may see, or `absent`. Asked again on every open; a failed answer keeps it |
| `home-files` | local, keyed `<homeKey>:<path>`: each Markdown block's file, `loading`, `text` or `failed`; a failed one is read again on the next open |
| `home-current` | local, one row: the routed repository and its id, its home's key once the repository is ready, its default branch, the audience ChatApi answered, the lower view the person switched to, whether the answer is on its way, whether its own home is still read from what GitHub says, the docs index its own home names at its newest commit and the one its curated home names ([docs](docs.md#the-docs-tab)), the repository whose stack it opened, and the actions running and the last one's failure |
| `warm(owner, name)` | what a repository route calls first, on a link's hover or focus and before every navigation: reads the curated home and, once the repository is ready, its own home and its Markdown blocks' files, without touching the shown page; ends once read, or after the repository store's `pageWait` |
| `open(owner, name)` | the routes' action once warm: names the repository at once, with its home's key when the repository is ready, so a warmed home shows at once (another page of the same repository keeps the home it shows), then in the store's scope asks ChatApi through `HomeClient` and, once the repository is ready (`ready`, `src/features/repo/actions.ts`), reads its home at the head through `RepoClient`, then each Markdown block's file. After each, a `stack` block the person may see opens the repository's stack (`TodosStore.stackOf`). Opening another repository interrupts a wait |
| `view(audience)` | the view switcher: the person's own view or a lower one that shows something; any other changes nothing |
| `run(flow, login)` | an action block: `branch.new` dispatches `branch/create` through `FlowDispatch` and answers the new branch's workspace to open |
| `homePageOf`, `tabsOf`, `offered`, `draftFor`, `filesOf`, `liveKindsOf`, `issuesOf`, `stackOf`, `runsOf`, `flowsOf` | pure: what the page shows from the rows (`view.ts`) |
| live queries | the issues' `items` and sync rows (`IssuesStore`), this person's runs (`StatusStore`) and the opened stack (`TodosStore`), read by the store when the tab has them; `HomePage` adds this person's flows (`FlowsUi`) |

Reading a home runs no flow: it is a read at an immutable commit, which RepoApi and the browser's HTTP cache keep (`Cache-Control: immutable`), or ChatApi's answer, and it changes nothing. New branch is a flow. The libraries are `@smthrs/views` (`Home.read`, `Home.visible`, `Home.widen`), `@smthrs/ui` (`RepositoryHome`), `@smthrs/effect-tanstack-db` (`Collection.persisted`, `Collection.local`, `LiveQuery`), Effect `HttpClient` (`HomeClient`, the repository feature's `RepoClient`), and `@smthrs/flow` through `FlowDispatch` ([libraries](../../../../docs/libraries.md)).

## ChatApi

`worker/home/Api.ts`, which ChatApi routes before RepoApi (`HomeApi.handles`): `GET /api/repos/<owner>/<name>/home` answers `{ audience, curated }`, `curated` `null` or `{ defaultBranch, sections, docs? }` with only the sections `audience` may see and the docs index it names, `Cache-Control: no-store` and `Vary: cookie`. Anyone may ask. `405` for another method; `503 { code: "unavailable" }` with `Retry-After: 5` when sessions can't be read.

## Observability

| Record | Kind | Fields |
|---|---|---|
| `home.resolve` | log and span; Warn `unreadable` | `outcome` (`declared`, `absent`, `invalid`, `unreadable`, `cached`, and `preview` for a home drawn [before a clone](#before-a-clone)), `blocks`, `skipped`, `reason`, `status`, `durationMs` |
| `home.preview` | span | reading the repository's own home from what GitHub says, before a clone |
| `home.file.load` | log; Warn `failed` | `outcome`, `status`, `durationMs` |
| `home.answer` | log and span; Warn `unreadable` | `outcome` (`declared`, `absent`, `unreadable`), `audience`, `sections`, `status`, `durationMs` |
| `home.action` | log and span; Warn on a failure | `flow`, `outcome` (`done`, or why not: `not_configured`, `forbidden`, `not_found`, `unavailable`, …), `durationMs` |
| `smithers_web_home_resolves`, `smithers_web_home_answers`, `smithers_web_home_actions` | counters | `outcome`; the last also `flow` |
| `home.curated` (ChatApi) | log and span; Warn `unavailable`, `invalid` | `outcome` (`curated`, `absent`, `invalid`, `unavailable`, `method`), `audience`, `rolesHere` (whether the repository is the one roles are read on), `sections` sent, `hidden` held back, `status`, `durationMs` |
| `smithers_home_curated_requests` (ChatApi) | counter | `outcome`, `audience` |

No record carries a section, a block, a title, a text, a path, a link, a branch's name or a file's contents ([observability.md](../observability.md#a-repositorys-home)).

## Tests

| Test | Proves |
|---|---|
| `src/features/home/home.test.ts` | on a tab against RepoApi's real handler and ChatApi's home route, the compose Postgres and Electric, the scripted Code Storage and GitHub: a repository's own home before a clone, by audience, and a Markdown, invalid or missing one leaving the tree; switching down to each lower view and never up; a declared home's blocks, skipped kinds, its Markdown files read once each at the same commit and a missing one read again on the next open, the tabs and the workspace link; the home kept on the device and not read again; a default branch named with a `/`; no home, an empty home; each invalid reason; Code Storage down as `unreadable`, read again on the next open; the wait for a repository that isn't ready, interrupted by another; a curated home before the clone, by audience, and the repository's own home winning; ChatApi failing (a faulty `HomeClient`) and a kept curated home; every record, and a sentinel in no log line |
| `src/features/home/live.test.ts` | the whole app (`appLayer`) against ChatApi's real routes: a visitor's home asks no stack; a Member's stack block opens the stack and a committed TODO shows in it; a Maintainer's issues block reads synced issues; New branch on Code Storage makes a branch at main and answers its workspace, pressed twice runs once, and on GitHub says `not_configured` |
| `src/screens/repo/tabs.test.ts` | the tabs through a real router over the real home layer: a file or directory page marks only Code current, the home page only Home |
| `src/features/home/view.test.ts` | what the page shows from each row and audience, the views each audience may switch to, the opt-in, the curated home's place, encoded links, the tabs, the composer's command, the files, each live block's rows, and VibeLang's draft home |
| `worker/home/Api.test.ts` | the route by role, a role on another repository counting for nothing, the opt-in, names without case, no curated home, an invalid file, sessions down, the method, records with no section's words; every curated file reads; Effect's home's sections |
| `worker/branch/Branches.test.ts` | `create: true`: made on Code Storage at the default branch's head and tracked, again at once; one the forge has tracked as it is; refusals and failures; GitHub as the forge `not_configured`; Members only |
| `packages/smithers/ui/views/test/Home*.test.ts` | `Home.read`: sections and audiences, every block and bound, HTML refused, unknown kinds skipped, the opt-in, `sees`, `visible`, `widen`, this repository's `.smithers/home.json`, fuzzing with kept counterexamples |
| `packages/smithers/ui/tests/repository-home.test.tsx` | `RepositoryHome`: sections and their labels, every kind, the hero, code coloring and Copy, cards, stats, releases, the live blocks and their notices, in-app links, actions and their keys, files' states, the ask links' plain and modified clicks, offered app blocks |
| `e2e/home.spec.ts` | in a real browser on `smithersai/home-fixture`: the home draws its blocks (an unknown kind and an app the composer hasn't skipped), survives a reload, Code opens the tree, a file opens by its URL with the tabs, Home comes back, and the prompt and an app block open the workspace's composer, the app block's command in it; `octocat/Spoon-Knife` opens on its tree with no tabs. It skips locally without `CODE_STORAGE_*` |
| `e2e/home-effect.spec.ts` | `Effect-TS/effect`'s curated home signed out, and as a Maintainer of the dev server's own repository, both seeing the landing page alone; with the dev server and the run started with `GITHUB_REPOSITORY=Effect-TS/effect`, as a Member and as a Maintainer, each seeing its own sections and none above and switching down to each lower view, and New branch with `B` opening a new branch's workspace (skips without `CODE_STORAGE_*`) |
| `e2e/vibelang-{visitor,contributor,maintainer}.spec.ts` | VibeLang's journeys on `smithersai/vibelang`, live from GitHub and vibelang.sh, locally and against a deployment: a visitor's landing page before any clone, nothing of the contributors' or maintainers', the Docs tab and the Code tab; a contributor's Contribute section above it, View as User, the docs and the code; a maintainer's Today first, View as Contributor, User and back, and B for a new branch (needs Code Storage). Shared steps in `e2e/vibelang.ts` |

## Not built yet

- Editing the home from the app (`repo/home/edit`, decision 0014 §2), which needs the pull-request flow of decision 0012.
- `view` (a flow's `view.tsx` through `@smthrs/views`' presentation realm and `GeneratedView`, decision 0014 L3); the repository's own active flows (`flow_bindings`) in `flows`.
- Who is on which branch, which needs a branches shape; the issue lifecycle's chain (a minimal repro, accepted for discussion, a commitment, a POC, a TODO), which the mock shows and its decision is designing.
- A role on each repository (decision 0007 phase 2): until then a person has a role on the deployment's repository alone, and is a visitor on every other repository's home.
- A home benchmark (decision 0014 §8, "a home's first paint").


Declaration reads are serialized per repository and commit, so concurrent warm and open calls share the cached result. Interrupting a Markdown read marks it failed and records `home.file.load` with outcome `interrupted`; opening the home again reads it again. Running actions and failures belong to the shown repository: navigation clears them, and a previous page's completion cannot update the new page or navigate it. Home pull-request entries link to the pull-request page.

A branch action finishing after another repository opens keeps that repository selected. Its outcome is recorded; stale completion leaves the new home's running actions and failure state alone.

SCOPE-14 applies within the repository where the session's role was read. A Member there gets contributor and user
views; a Maintainer defaults to maintainer and can switch down. Opening another repository resets View as and
uses that repository's audience: the session's role grants nothing there. Returning to the roles repository starts
at the person's highest authorized view again. This applies to GitHub's declared home before cloning and to curated homes.

A preview selects its home and default branch in one conditional store update. If the clone has selected its home meanwhile, the preview leaves both unchanged. `home.test.ts` pauses that write, lets the real clone finish, then releases it; the clone’s `release/1.0` branch remains selected.

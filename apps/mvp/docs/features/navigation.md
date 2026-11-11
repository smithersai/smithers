# Navigation and loading

How a page opens: what it warms, what the person sees while it waits, and what a hover does ([decision 0020](../decisions/0020-one-loading-pattern.md)). `app/navigate`, the flow that moves a tab, is in [flows](flows.md#navigation).

## What a person sees

- **A fast page shows no loading state.** Nothing loading shows for its first 300 ms (`LOADING_DELAY_MS` in `@smthrs/ui`).
- **A slower navigation keeps the page it leaves**, with a 2 px bar across the top (`LoadingBar`, Root), until the next page is ready.
- **Files still on their way after a second** (`pageWait`) show as skeletons in their place; the page then fills in without moving.
- **Hovering or focusing a link preloads its page**, after 50 ms, so the click usually opens at once.
- **Files in a branch's tree open in place.** After a hover, a clicked file shows within a frame or two; the branch's chrome and conversation stay on screen, and the page never loads again.
- **Under reduced motion** the same waits hold, the bar holds still at full width, and skeletons don't pulse.

## How it works

```
hover or focus a link (50 ms) ──▶ route beforeLoad, preload ──▶ warm ──▶ done; the page shown doesn't change
click, or app/navigate ─────────▶ route beforeLoad ──▶ warm (≤ pageWait) ──▶ open ──▶ the router shows the page
                                     the previous page stays; LoadingBar past 300 ms
```

- **`src/router.tsx`.** Every route opens what it shows in `beforeLoad` through `enter(load, warm, open)`: a preload runs `warm` only; a navigation runs `warm`, then `open` unless a newer navigation aborted it. Routes have no loaders: a navigation adopts a loader a preload left in flight, so a loader can't tell them apart. `defaultPreload: "intent"`, `defaultPreloadDelay: PRELOAD_DELAY_MS` (50).
- **Router ownership.** `createAppRouter` supplies its own instance through route context. Repository reuse reads that instance's resolved location, and workspace cleanup reads its committed matches; neither reads the exported singleton ([decision 0137](../decisions/0139-router-location-ownership.md)).
- **Branch route lifetime.** Leaving the branch route aborts its load before clearing presence, editor and terminal state. `src/features/branch/navigation.ts` checks that signal after each asynchronous action, so a late tracking, room, editor or terminal answer cannot advance the obsolete navigation. The route signal also interrupts the actions through their captured Effect runtime, so a pending store read or socket teardown cannot restore state internally. Existing branch, presence, coedit and terminal actions retain their logs, spans and counters.
- **What each route warms.** A repository's pages: `repo.actions.warmRoute` (the file list, the file or the directory's README, `src/features/repo/actions.ts` `warm`) and, for its home, `home.actions.warm` (Smithers' curated home and the repository's own, with its Markdown blocks' files). Issues: the issues' sync; the stack: the stack's sync. Runs: `runs.actions.warmList` reads the device's engine without opening the page; concurrent warms share the read, and the click reuses it until an engine event invalidates it. Failed reads are never cached. Flows, views and the conversation need no warm.
- **The first load.** A page's first load has no previous page to keep, so a route whose pending screen is no loading state (the issues list's `IssuesPendingScreen`: its search box beside the first paint's rows, no `aria-busy`, spinner or skeleton) shows it as soon as the app renders (`FIRST_LOAD_PENDING_MS`, 0) and the page replaces it as soon as it loads (`FIRST_LOAD_PENDING_MIN_MS`, 0); once a load resolves, navigations wait `PENDING_MS` (1 s) before a pending screen replaces the page shown, and a shown one stays at least `PENDING_MIN_MS` (500 ms), the router's defaults. A pending screen that is a loading state (flows, branches, an issue page) keeps that wait on the first load too (`LOADING_PENDING`), so a cold path that resolves within that delay paints no loading screen. On c78d0c83 the issues list's pending screen carried `aria-busy`, which the deploy smoke rejected.
- **Bounds.** A warm ends once its reads loaded or failed, once the device can tell the repository isn't ready (the page then says Not cloned, Cloning or why), or after the repository store's `pageWait` (1 s), whichever is first. A request still on its way finishes in the store's scope, and the page shows a skeleton in its place until then. A navigation never waits for what GitHub says of the repository (About, [repo](repo.md#about)): that read tries a refusal again for up to three attempts, so the page renders at once with its About section loading and fills it when the read settles; before 2026-11-11 each warm and the name check below waited up to `pageWait` on it, and a branch page showed its pending screen instead of its terminal (`src/features/terminal/navigation.test.ts`). Under `/tree`, whether the path is a file (`fileAtTree`), bounded by `pageWait` too, runs beside the warm, so a navigation waits for the slower of the two, never their sum: before 2026-11-04 the checks ran after it, and a cold issues list showed its search box up to a second later.
- **Staying in a repository.** A navigation whose previous page was the same repository's (`staysInRepository` in `src/features/repo/paths.ts`), such as a file clicked in its tree, reuses who the person is there (`/role`, `repo.role` `outcome: kept`) and its home (`/home`, `home.open` `outcome: kept`) when the tab holds a good answer for each; a refused or missing role, a home that failed, is still answering or names another repository, is asked again. ChatApi caches the role for 5 minutes anyway (decision 0079 §5). Entering the repository from anywhere else, loading the page, or reopening it in place asks both. Opening the branch the tab already shows ready keeps its workspace and asks ChatApi nothing (`branch.open` `outcome: kept`, [branch workspace](branch-workspace.md)), so its chrome and conversation never unmount: before 2026-10-31, each click re-tracked the branch, the workspace left the screen at once and came back about a second later, when `POST /api/branches` answered, which looked like the page reloading.
- **Failures.** A warm asks again for a list or a file that failed; opening never does, so the page shows at once what the warm answered.
- **Refs.** Head discovery and Electric's repository row share a refs key: repository id, head SHA and `refsChangedAt`. The refs response carries that timestamp as Postgres text (including microseconds, or null), exactly as Electric delivers it. A row arriving before or after hover reuses the listing on click; a later refs revision still loads again.
- **Plain links.** `IntentPreload` (`src/features/navigation/components/IntentPreload.tsx`) wraps the routes in `@smthrs/ui`'s `LinkIntent`, which reports the path of the same-origin link the pointer or focus has rested on for the router's delay; the app preloads it. A pointer that leaves first preloads nothing. Links that open a new tab or download are skipped. The wait is the UI library's, like the router's own links': the app sets no timer.
- **The bar.** Root renders `LoadingBar loading={router status is pending}`, named `Loading page`.

## Observability

`repo.warm` and `home.warm` are spans; each read a warm starts records as any read does (`repo.tree.load`, `repo.blob.load`, `home.resolve`, with their durations), so a slow navigation shows which read it waited on.

## Tests

| Test | What it proves |
| --- | --- |
| `src/features/branch/branch.test.ts` | Delayed real service answers at tracking, room join, editor and terminal boundaries cannot restore cleaned-up state; pending terminal/editor storage and socket teardown are interrupted by route cancellation |
| `src/features/navigation/repo-route-role.test.ts` | A navigation asks the person's role once, as it starts; a preload asks none; the repository's name check starts beside the warm, not after it; a first load shows the issues list's pending screen at once, and later navigations wait `PENDING_MS` |
| `src/features/repo/warm.test.ts` | A warm loads the root's files, README and home without moving the page shown, and the click opens it with no read of its own and the home showing at once; a failed list loads again on the next warm and opening shows what it answered; a repository nobody cloned ends at once with no read; files that don't come end the warm after `pageWait`, and the page opens with them loading |
| `packages/smithers/ui/browser/loading.browser.test.ts` | In Chromium: a load under 300 ms paints nothing; past it the bar, skeleton, pending answer and a button's bar show and the bar fades out; nothing moves when content replaces a skeleton or the answer's line replaces the pending line; reduced motion keeps the wait, rests the bar at full width and runs no animation |
| `src/features/branch/branch.test.ts` (keeps it ready) | Another page of the branch the tab shows stays ready with no render back to tracking, asks ChatApi and GitHub nothing, and counts `kept`; another branch, and coming back to the first, track again |
| `src/screens/branch/offline.test.ts` | A fresh or offline branch visit resolves without route errors; each router keeps its own workspace, role and home through tree/file navigation, then releases presence on leaving for chat |
| `src/features/repo/repo.test.ts`, `src/features/home/home.test.ts` (staying in the repository) | `reuse` keeps an answered role and home and asks ChatApi nothing, in any case; a refused role, a failed home, a home of another repository and a first visit ask again |
| `src/features/repo/paths.test.ts` (`staysInRepository`) | A page of the same repository, in any case, stays in it; a first load, another repository, another owner or an app page enters it |
| `e2e/tree-click.spec.ts` | Signed in, hover then click three files in Spoon-Knife's tree: no document load within 5 s of any click, the workspace on screen every frame, no `/refs`, `/role`, `/home` or `POST /api/branches` on the clicks, and each file's first line within 100 ms of its click (the measured time is the `timings` annotation) |
| `e2e/navigate.spec.ts` | A hovered link's page opens with no pending frame and the previous page never blanks; the repository page a person navigates to is never blank and keeps its box as it fills |

The hover probe starts at the actual click event, after hover and browser actionability checks. It checks the destination main's loading elements and the global page bar; a pending answer on the page being left is allowed. Every recorded frame must still show a populated main. `navigation-frames` retains times, route, main, content-presence booleans and loading elements' tags, slots, roles and structural positions, without message text or HTML. `e2e/loading.test.ts` exercises the recorder in real Chromium, including a blank main and unrelated skeletons.

Unknown routes use the router's not-found component: the shared `@smthrs/ui` `NotFound` view, navigation, theme and account controls, and a Back to chat link. Route errors retain the same recovery shell and Retry. No raw error details are shown.

Compatibility paths redirect with replacement: `/settings` to `/app/settings`, repository `/secrets` to `/settings/secrets`, and repository `/actions` to `/runs`. Runs is the canonical repository list; it shows Smithers flow runs.

Repository routes adopt the owner/name spelling GitHub returns, preserving the route suffix, search and fragment. A navigation redirects to it when the tab already knows it (`repo.actions.knownName`); otherwise the page opens at once and its URL takes the spelling, replacing the entry, once the About read answers (`canonicalName`), unless the person is on another page by then. A failed metadata lookup never invents a canonical name.

A tree URL naming a file in the resolved revision redirects to its blob URL. Directories, unknown paths and missing revisions retain their own URLs and absence handling.

## Keyboard navigation

After a pathname change commits, focus moves to the new main heading, or main
when the page has no heading. Search and filter changes preserve control focus.
`tests/PageFocus.test.ts` covers the DOM lifecycle; `e2e/accessibility-navigation.spec.ts`
covers the keyboard through the real router.

The first Tab exposes **Skip to content**, targeting the current main region.
Before focus its box stays inside the viewport and is clipped with `clip-path`;
focus removes the clip. Layout audits focus the link and check its full hit target.
`e2e/accessibility-skip.spec.ts` exercises the link by keyboard.

Repository alias checks share the route warmup budget. Unavailable metadata or file lists leave the URL unchanged and let cached or offline branch navigation open; a later read can verify the redirect. Branch-root URLs need no file lookup.

`repo.alias.check` records and counts whether that bounded check verified a file,
remained unconfirmed, or ran out of time, with a correlated span and duration.
The path and file contents are never recorded. A deadline is not absence.

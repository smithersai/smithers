# Navigation and loading

How a page opens: what it warms, what the person sees while it waits, and what a hover does ([decision 0020](../decisions/0020-one-loading-pattern.md)). `app/navigate`, the flow that moves a tab, is in [flows](flows.md#navigation).

## What a person sees

- **A fast page shows no loading state.** Nothing loading shows for its first 300 ms (`LOADING_DELAY_MS` in `@smthrs/ui`).
- **A slower navigation keeps the page it leaves**, with a 2 px bar across the top (`LoadingBar`, Root), until the next page is ready.
- **Files still on their way after a second** (`pageWait`) show as skeletons in their place; the page then fills in without moving.
- **Hovering or focusing a link preloads its page**, after 50 ms, so the click usually opens at once.
- **Under reduced motion** the same waits hold, the bar holds still at full width, and skeletons don't pulse.

## How it works

```
hover or focus a link (50 ms) ──▶ route beforeLoad, preload ──▶ warm ──▶ done; the page shown doesn't change
click, or app/navigate ─────────▶ route beforeLoad ──▶ warm (≤ pageWait) ──▶ open ──▶ the router shows the page
                                     the previous page stays; LoadingBar past 300 ms
```

- **`src/router.tsx`.** Every route opens what it shows in `beforeLoad` through `enter(load, warm, open)`: a preload runs `warm` only; a navigation runs `warm`, then `open` unless a newer navigation aborted it. Routes have no loaders: a navigation adopts a loader a preload left in flight, so a loader can't tell them apart. `defaultPreload: "intent"`, `defaultPreloadDelay: PRELOAD_DELAY_MS` (50).
- **Branch route lifetime.** Leaving the branch route aborts its load before clearing presence, editor and terminal state. `src/features/branch/navigation.ts` checks that signal after each asynchronous action, so a late tracking, room, editor or terminal answer cannot advance the obsolete navigation. The route signal also interrupts the actions through their captured Effect runtime, so a pending store read or socket teardown cannot restore state internally. Existing branch, presence, coedit and terminal actions retain their logs, spans and counters.
- **What each route warms.** A repository's pages: `repo.actions.warmRoute` (the file list, the file or the directory's README, `src/features/repo/actions.ts` `warm`) and, for its home, `home.actions.warm` (Smithers' curated home and the repository's own, with its Markdown blocks' files). Issues: the issues' sync; the stack: the stack's sync. Runs: `runs.actions.warmList` reads the device's engine without opening the page; concurrent warms share the read, and the click reuses it until an engine event invalidates it. Failed reads are never cached. Flows, views and the conversation need no warm.
- **Bounds.** A warm ends once its reads loaded or failed, once the device can tell the repository isn't ready (the page then says Not cloned, Cloning or why), or after the repository store's `pageWait` (1 s), whichever is first. A request still on its way finishes in the store's scope, and the page shows a skeleton in its place until then.
- **Failures.** A warm asks again for a list or a file that failed; opening never does, so the page shows at once what the warm answered.
- **Plain links.** `IntentPreload` (`src/features/navigation/components/IntentPreload.tsx`) wraps the routes in `@smthrs/ui`'s `LinkIntent`, which reports the path of the same-origin link the pointer or focus has rested on for the router's delay; the app preloads it. A pointer that leaves first preloads nothing. Links that open a new tab or download are skipped. The wait is the UI library's, like the router's own links': the app sets no timer.
- **The bar.** Root renders `LoadingBar loading={router status is pending}`, named `Loading page`.

## Observability

`repo.warm` and `home.warm` are spans; each read a warm starts records as any read does (`repo.tree.load`, `repo.blob.load`, `home.resolve`, with their durations), so a slow navigation shows which read it waited on.

## Tests

| Test | What it proves |
| --- | --- |
| `src/features/branch/branch.test.ts` | Delayed real service answers at tracking, room join, editor and terminal boundaries cannot restore cleaned-up state; pending terminal/editor storage and socket teardown are interrupted by route cancellation |
| `src/features/repo/warm.test.ts` | A warm loads the root's files, README and home without moving the page shown, and the click opens it with no read of its own and the home showing at once; a failed list loads again on the next warm and opening shows what it answered; a repository nobody cloned ends at once with no read; files that don't come end the warm after `pageWait`, and the page opens with them loading |
| `packages/smithers/ui/browser/loading.browser.test.ts` | In Chromium: a load under 300 ms paints nothing; past it the bar, skeleton, pending answer and a button's bar show and the bar fades out; nothing moves when content replaces a skeleton or the answer's line replaces the pending line; reduced motion keeps the wait, rests the bar at full width and runs no animation |
| `e2e/navigate.spec.ts` | A hovered link's page opens with no pending frame and the previous page never blanks; the repository page a person navigates to is never blank and keeps its box as it fills |

Unknown routes use the router's not-found component: the shared `@smthrs/ui` `NotFound` view, navigation, theme and account controls, and a Back to chat link. Route errors retain the same recovery shell and Retry. No raw error details are shown.

Compatibility paths redirect with replacement: `/settings` to `/app/settings`, repository `/secrets` to `/settings/secrets`, and repository `/actions` to `/runs`. Runs is the canonical repository list; it shows Smithers flow runs.

Repository routes adopt the owner/name spelling GitHub returns, preserving the route suffix, search and fragment. A failed metadata lookup never invents a canonical name.

A tree URL naming a file in the resolved revision redirects to its blob URL. Directories, unknown paths and missing revisions retain their own URLs and absence handling.

## Keyboard navigation

After a pathname change commits, focus moves to the new main heading, or main
when the page has no heading. Search and filter changes preserve control focus.
`tests/PageFocus.test.ts` covers the DOM lifecycle; `e2e/accessibility-navigation.spec.ts`
covers the keyboard through the real router.

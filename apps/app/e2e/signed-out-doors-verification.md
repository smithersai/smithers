# Signed-out doors verification

The chrome now exposes `chrome-sign-in` without the sidebar, switching to `chrome-account` with the login when signed in. Both use the existing flows; `auth.sign-in` preserves the repository URL through `return_to`.

Unmet identity requirements fulfill through `auth.prompt`. Unauthorized issue and PR list reads stop before publishing an empty list and render that same prompt. The tutorial projects the prompt into its transcript. Refused-command notices auto-dismiss. Parsed input missing required fields reaches the shared form renderer, so the practice Add flow chip keeps its issue/repository and its refused submit stays in the form.

TDD: the first regression run had 2 pass / 8 fail; the refusal-notice test separately failed before its timer change.

## Focused behavior tests

`cd apps/app && bun test src/mainview/state/signed-out-doors.test.ts src/mainview/tabs/SessionIdentity.test.tsx src/mainview/cards/tutorial2-issues_prs-cards.test.tsx src/mainview/state/controller/failures.test.ts src/mainview/state/seams/tutorial2-issues_prs.test.ts src/mainview/state/seams/HistorySeam.test.ts src/mainview/flows/Commands.test.ts src/mainview/flows/requirements.test.ts src/mainview/flows/entries/tutorial2-issues_prs.test.ts`

```
102 pass
 0 fail
 433 expect() calls
Ran 102 tests across 9 files. [55.00s]
```

## Required unit gate

`cd apps/app && bun test src/mainview/tabs src/mainview/state src/mainview/cards`

```
2227 pass
 33 fail
 10470 expect() calls
Ran 2260 tests across 198 files. [99.66s]
```

Pristine starting revision `6ce899e6cabf`, restored with `jj restore --from @-`, same command:

```
2218 pass
 33 fail
 10424 expect() calls
Ran 2251 tests across 196 files. [108.51s]
```

The sets of 33 failing test names are identical. All nine added tests pass. `jj diff --from main@origin --stat` also showed pre-existing lane differences: 36 files before this change. A separate scratch check restored `apps/app/src/mainview/tabs/ChromeBar.tsx` from `main@origin` and reran its suite inside the package: 36 pass, 1 fail (the existing Wiki test expects a pane instead of the embedded card). The saved lane tree was restored after all scratch checks.

## Additional touched-area unit gate

`cd apps/app && bun test src/mainview/flows src/mainview/onboarding src/mainview/SessionNavigation.test.ts`

```
351 pass
 8 fail
 3168 expect() calls
Ran 359 tests across 34 files. [73.53s]
```

Pristine starting revision, same command:

```
351 pass
 8 fail
 3167 expect() calls
Ran 359 tests across 34 files. [13.81s]
```

The sets of eight failing test names are identical; no new failures.

## Typecheck

`pnpm --filter smithers-app run typecheck` exited 0:

```
$ node scripts/ensure-devkit.mjs && tsc --noEmit
```

## Browser gate — blocked by the shared port

`cd apps/app && pnpm exec playwright test e2e/playwright/boot-identity.spec.ts e2e/playwright/tutorial2-issues_prs.spec.ts`

The final build lost port 47311 to another lane's server (`EADDRINUSE`). `lsof` identified its working directory as `smithers-tutorial-shell/apps/app`. The test runner continued against that other server, so that run cannot verify this change. The unchanged retry exited 1:

```
Error: http://127.0.0.1:47311/api/health is already used, make sure that nothing is running on the port/url or set reuseExistingServer:true in config.webServer.
```

Pristine check: saved the finished tree, restored `apps/app` from `main@origin`, and ran the same command. It exited 1 with the identical output above. Restored the finished tree afterward; `jj diff --from a805d2fb6ef7bbbd04febb3f787dcd3f23625292 --stat` confirmed zero file differences. Final browser validation remains blocked. No port override, server termination, production deployment, push, or land script was used.

## Intentional test updates

Requirement and History tests now expect `auth.prompt`, not an automatic OAuth redirect. Browser fixtures follow the current nested wordmark and tutorial lesson signals: PR reads no longer advance the issue-flows lesson, and 401s show the prompt instead of backend refusal prose. The original deployed sign-in probe selector remains unchanged.

## Baseline failures in the required unit gate

- a turn asking who you are is answered with the name > local: the instructions pin the one-word name, name smithers.who, and the catalog lists it
- actual text persists in the file card and completes the current selected-repo lesson
- auth is a conversation state — the chat is the only page > an adopted signed-out session (the server-rendered web boot) still names the scopes
- auth is a conversation state — the chat is the only page > signed-out: the chat renders open, with sign-in as the chrome's option (LOCAL-APP.md)
- chat-first shell: panes never replace the conversation > the composer's surfaces menu opens the panes without leaving chat
- local archive and append-only summary notes > failed local persistence returns an honest failure and restores every projection
- local contents read also persists the exact file and completes
- selected cloud head still reads cloud when a different local checkout is open
- the chrome buttons > Wiki, signed out, opens the Wiki pane beside the chat and touches no message; a second click returns to the chat
- the composer header: the repository selector and where it lives > a known revision pins `change#seq`; a newer one names itself only when both seqs are known
- the composer header: the repository selector and where it lives > a loaded GitHub repository: the origin chip does not repeat the selector's owner/repo
- the composer header: the repository selector and where it lives > a local repository: the selector names it and the origin chip shows the local path and branch
- the composer header: the repository selector and where it lives > a local working copy with a jj probe: the origin chip reads `~/path · N ahead of main`
- the composer header: the repository selector and where it lives > a repository at its head: the origin chip reads `head @ <change id>` (lane piper step 4)
- the composer header: the repository selector and where it lives > no repository: the selector says Select a repo, no origin chip, and the chrome has no duplicate
- the composer hot path: typing never re-renders the transcript > the shell still re-renders for the session state it does read
- the composer hot path: typing never re-renders the transcript > typing leaves the transcript's rendered messages untouched
- the composer's + menu and surface pill > + opens a store-owned menu: Add files first, then a connector and an agent; the pill names the surface
- the composer's + menu and surface pill > Escape and an outside press close the + menu through the store
- the composer's + menu and surface pill > choosing Flows opens the flows pane and the pill reads Flows
- the composer's + menu and surface pill > the surface menu opens Wiki as an embedded card while the composer stays in chat
- the connect menu's open state lives in the store > opening from the trigger, then Escape, closes it and returns focus
- the connect menu's open state lives in the store > opening from the trigger, then a pointer press outside, closes it
- the connect menu's open state lives in the store > the open state round-trips through the connect-menu.toggled transition
- the instructions budget > a session with World notes at the body budget and roles present composes under the cap, and the notes are cut before the turn is
- the tabs collection > boot drops process tabs and orphaned card tabs, and returns to main
- user and agent select the same persisted payload and emit trace.opened only after real scoped inspection
- wave 10 — admin-only affordances are absent, not hidden (§2/§2b) > admin: the reset button renders and admin.devtools toggles the panel
- wave 10 — the derived pill row (§2a/§2f) > signed-out, no pill: sign-in is the chrome button, never a gate on the chat (LOCAL-APP.md)
- wave 13 §F — the capability section is generated from the live catalog > the turn's instructions carry the agent's live catalog — never user-only chrome
- world notes ride the turn under a budget > the turn the client sends carries the note's text, not just its path

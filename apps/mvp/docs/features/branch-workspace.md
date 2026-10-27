# Branch workspace

A branch is a workspace: it has one conversation for as long as it lives, and a terminal for each person on the branch's own machine. This page covers the first slice of [decision 0013](../decisions/0013-branch-workspace.md) (its §9, S1): open a repository's existing branch, ask in that branch's conversation, open the branch's terminal in a frame, run `git log` in a real container, reload and keep the same shell; another branch has its own conversation and terminal. It also covers the next slice, [sharing](#sharing) a branch Google Docs style and the people on it [live](#presence).

People on a shared branch type its prompt and its files together, with each other's carets ([co-editing](coedit.md)). Snapshots and branch creation come later ([What's not built](#whats-not-built)); the machine's tools, sleep and wake are [sandbox tools](sandbox-tools.md).

## The page

The repository header shows the same connection status as `/app`: `Offline`,
`Offline · <queued in this conversation>`, or a sync or engine failure with its existing recovery action.
Its own polite live region announces changes without repeating the rest of the header.

While route entry waits for tracking or live data, its pending view shows the
destination repository, branch name, connection status and Code/Terminal links,
even after device storage is evicted. Conversation, sharing, presence, editing
and terminal actions wait for verified access and the existing route loader.
Previous branch data never supplies the pending view's identity or controls.

`/$owner/$repo/tree/$ref` (and a file at it, `/$owner/$repo/blob/$ref/<path>`) opens the repository at `$ref` and, when `$ref` is a branch GitHub has, its workspace:

```
┌ octocat / Spoon-Knife                                     Issues  Stack  [Clone] ┐
│ test-branch [Owner]                     (L)(B)(G)+1  [Share]   Code  Terminal    │
│ ┌ the Code view, or the Terminal view (?terminal=me) ─┐ ┌ the conversation ──────┐ │
│ │ files and README, or Not cloned                     │ │ messages and views     │ │
│ │ the terminal, or [Open terminal] in its middle      │ │ or No messages yet     │ │
│ └─────────────────────────────────────────────────────┘ └────────────────────────┘ │
│                                                              Chat ⌘K / composer    │
└──────────────────────────────────────────────────────────────────────────────────┘
```

The page never shows a blank area (Will, 2026-10-20, on its first recordings: "most of the recording looks like an empty
screen"). Each part says what it is: the chrome names the branch, what this person may do on it in the share dialog's
words (`Owner`, `Can edit`, `Can view`, `statusOf` in `src/features/branch/view.ts`) and everyone there, this person
first (`avatarsOf`); the Code view of a repository that isn't cloned says `Not cloned` or `Cloning` beside the header's
Clone (`codeEmptyOf` in `src/features/repo/view.ts`); the Terminal view always has its screen, with Open terminal in its
middle, a calm bar along its top while the machine wakes, or `No terminals` for someone who can't open one (`panelViewOf` in
`src/features/terminal/view.ts`); and an empty conversation says `No messages yet`. Under 60 rem wide, the conversation
stacks under the view.

- **Route** (`src/router.tsx`): the tree route warms the location (`repo.actions.warmRoute`; a link's hover does only that), then opens it (`repo.actions.openRoute`), tracks the branch (`branch.actions.open`), joins its room (`branch.presence.actions.join`) and, under `?terminal`, selects its loading terminal screen (`terminal.actions.showInBackground`) without awaiting terminal rows, then says where on the page the person is once they arrive (`branch.presence.actions.at`). `?terminal=me` is the person's own terminal, or the branch's first live one when they have none; `?terminal=<id>` shows that terminal. Leaving the route aborts its background terminal selection and leaves the room (`onLeave`).
- **Screen**: `src/screens/branch/BranchScreen.tsx` composes `RepoHeader`, `BranchHeader` (the branch's name and this person's access, the people on it, Share for its owner, and the Code and Terminal tabs), `RepoPage`, `TerminalPanel` or, under `?edit=<path>`, the live editor (`SharedFile`, [co-editing](coedit.md#the-page)) in the view column, and chat's `Conversation` with the `Composer` at its foot (`docked={false}`) in the conversation column: once its owner shares the branch, the branch's prompt, typed together by those who may edit it and read-only for those who may only view it; until then the owner's own draft, kept on their device ([co-editing](coedit.md#the-prompt)). A branch this person may not open, or stops being able to, shows `No access` in the conversation's place beside the repository view (`src/features/branch/view.ts` `accessNow`).
- **Offline**: the device can't say whether this person may open the branch, so the page doesn't wait for `branch/track`'s 30 s of retries. Once the shared connection reports offline, `branch.actions.open` answers at once, the branch's state is `offline` and the page shows the pending view's public chrome (the branch's name, Code and Terminal). A verified route also restores its saved conversation read-only; it restores no workspace grant. Once the shared connection recovers, the route loads again in place (`router.invalidate`, the host's `reopenRoute`) and tracks the branch, with no reload. Another navigation, or leaving the page, first cancels it (the navigation's abort signal).
- **`/app`** shows the home conversation: the deployment repository's (`GITHUB_REPOSITORY`) `main`. Its route leaves the branch, so the composer asks there again.
- **A ref that isn't a branch** (a commit, a tag, a name GitHub doesn't have) shows the repository view alone.

## Tracking a branch

`branch/track { repo, branch, openId? }` is a client flow a person's page and the agent run alike (`src/features/branch/flows.ts`). Its one step posts `POST /api/branches { owner, name, ref, openId? }` (`worker/branch/Branches.ts`); a page's open names itself in `openId`, so the same open tried again never undoes an archive made since ([conversations](conversations.md#archive)):

| Answer | When |
|---|---|
| `200 { branchId, conversationId, repoId, name, mode, access, shared }` | the app tracks the branch already and this person may open it; nothing is read from GitHub. `access` is `owner`, `edit` or `view` ([sharing](#sharing)); `shared` says its owner shared it, which makes its prompt one text ([co-editing](coedit.md#the-prompt)) |
| `201` with the same body | the branch was read from its forge and recorded, with its conversation, in one transaction, as the person's own (`owner`) |
| `404 not_found` | GitHub (or the mirror) has no such repository or branch, or the repository is private |
| `401`, `403` | signed out; a tracked branch this person may not open, or a new one and they aren't a Member |
| `400`, `413` | not a repository's name, not a branch name git accepts, or a body over 2 KiB |
| `503 unavailable` | the forge or Postgres didn't answer; the step tries again for 30 s |

A page opened by someone sign-in's row says is signed out shows sign in without running `branch/track`, which would only come back `401` (`signedOut`, `src/features/auth/store.ts`); while sign-in hasn't said, the page asks.

The repository's default branch is recorded `locked` (decision 0007 §5) and is the team's; every other tracked branch is `open` and belongs to the Member who tracked it first (`branches.created_by`).

## New branch

`branch/create { repo, branch }` (`src/features/branch/flows.ts`) makes a new branch and tracks it. A repository home's New branch runs it ([home](home.md#new-branch)), `/branch.new` and the agent can too; Will, 2026-10-20 18:12: "The maintainer should have a prominent button to start working on a new branch". It runs the [selected repository creation flow](branch-creation.md). The default host action posts the same route with `create: true`: `POST /api/branches { owner, name, ref, create: true }`. For a branch the app doesn't track yet, the route reads the default branch from the forge, makes `ref` in its ephemeral namespace at that head (`CodeStorage.createBranch`, decision 0095), then tracks it as above: `201`, `open`, the Member's own. Asking again for a branch the app tracks, such as a retry whose answer was lost, answers that branch. A name the forge already has and the app doesn't track is someone else's branch, from a push or the mirror, so the route refuses it `409 exists` and tracks nothing: a branch name carries no mark of who made it, so its existence is never read as this request's create ([durable external effects](../proposals/durable-external-effects.md)). Then the page opens its workspace: its conversation, terminal and views.

| Answer | When |
|---|---|
| `201`, `200` | as tracking |
| `404 not_found` | the forge has no such repository, or no default branch to start from |
| `409 exists` | the forge already has a branch of that name, which the app doesn't track: the flow fails `exists`, never tried again, and the home's New branch shows "Couldn't make a branch" |
| `403 forbidden` | Code Storage refused the ref write with HTTP 401 or 403; the flow fails `forbidden` without retrying, with the provider cause in its records |
| `503 not_configured` | the forge is GitHub, read with no credential, which can't make a branch: the flow fails `not_configured`, never tried again |
| `503 unavailable` | the forge or Code Storage didn't answer; creation tries again for 24 hours |

The route's `branch.track` line says `created`: `created`, `exists`, or the forge's refusal.
Failures also record `forgeOperation` (`default_branch`, `create_ref`, `refs_read`),
`forgeErrorTag`, `forgeErrorCode` and `forgeStatus` when HTTP answered. The
`forge.createBranch` failure log and span retain the same fields. These come from
typed errors; branch names, response text, URLs and credentials are never recorded. The branch lives in Code Storage's ephemeral namespace until a person explicitly publishes it. The stored namespace also scopes sandbox Git fetches to this branch. Ephemeral sandbox checkouts clone its full reachable history; the scoped proxy refuses shallow negotiation. Ordinary namespace checkouts keep the depth-50 limit.

## Conversations

- **One per branch.** `conversations.id` is the version 5 UUID of the branch's id in `CONVERSATION_NAMESPACE` (`@smthrs/crypto`'s `Uuid.v5`), so a device that knows a branch knows its conversation.
- **Everything chat-scoped names it.** `POST /api/questions` and `POST /api/views` take `conversationId`; without one, the home conversation (for one release, so asks queued by the build before branches still land). An agent's view names its answer instead (`answerId`), and goes to that answer's conversation, only for the person who asked it.
- **Shapes are per conversation.** `GET /api/shapes/messages?conversation=<id>` and `GET /api/shapes/views?conversation=<id>` fix `where conversation_id = $1` on the server; no `conversation` means the home conversation. `messages` syncs `conversation_id` (`SYNCED_MESSAGE_COLUMNS` in `worker/Chat.ts`).
- **The agent's turn and history are per conversation** (`worker/Answers.ts`, `worker/Messages.ts`): two branches' answers proceed in parallel; one conversation's still take turns.
- **On the device** (`src/features/chat/store.ts`), the home conversation keeps its collection (`chat-messages`); each branch conversation opens its own (`chat-messages:<id>`, persisted) and views (`views:<id>`) when a page shows it. The `place` row says which conversation the tab shows and asks in. A question keeps the conversation it was asked in, whatever the tab shows when it sends. A conversation is blank until it opens: once the device's rows are restored, or, for one this device has no rows of yet, once its shape has synced, so switching to a branch never shows the empty state for a frame before its conversation arrives (`src/features/branch/conversation.test.ts`).
- **Full-screen views** of a branch conversation are `/app/views/<id>?conversation=<conversation id>`.
- **Your list of them**, Archive, and `/new` for a fresh one on a new branch: [conversations](conversations.md).

## The terminal

```
 page                               ChatApi                     SandboxObject (one per branch)        container
 TerminalFrame (srcdoc, sandbox=allow-scripts)
   xterm ◀── MessagePort ──▶ TerminalSocket ── wss /api/terminals/<id> ──▶ Origin, session, row ──▶ attach ── tmux -t <id>
```

- **Opening** is `terminal/open` (client flow, the person's only: the agent runs commands as jobs instead), whose step posts `POST /api/terminals { terminalId, branchId, cols, rows }` (`worker/branch/Terminals.ts`). ChatApi admits it (signed in, a Member, a branch that isn't `locked`), records the `opening` row, and starts the remote flow `terminal/Open` (`worker/flows/TerminalOpen.ts`), one execution per terminal:

  ```
  sandbox/Admit ─▶ sandbox/Wake ─▶ terminal/Session ─▶ terminal/Record (open, generation)
       └ no machine free: the row says `waiting`, asked again for up to 30 minutes
       └ failed ─▶ terminal/Failed ──────────────────▶ terminal/Record (failed: unavailable | checkout)
  ```

- **Waiting for a sandbox.** `sandbox/Admit` holds the branch a machine under the [sandbox limits](sandbox-budgets.md) before it wakes it. With none free, the row says `waiting`, Open terminal stays disabled and the panel says **Waiting for a sandbox**, for up to 30 minutes (`ADMIT_WAIT_SECONDS`); once one is free the row records `admitted_at`.
- **One terminal per person per branch.** While theirs opens or is open, `POST /api/terminals` answers its id. An open that hasn't finished within `OPEN_DEADLINE_SECONDS` (180) of its admission (after a wait) or of its row settles `failed` (in `terminal/Record`, or at the person's next open), so it never locks them out. A waiting one has the wait's time first.
- **An unfinished open.** The panel waits until the row's `createdAt` plus that deadline, plus the wait when the row says `waiting`, including after reload. Once failed, it offers Open terminal even while the row still says `opening`; the next press lets the server replace the stale row.
- **The socket.** `GET /api/terminals/<id>` with `Upgrade: websocket` checks the `Origin` is the app's own, then the session: the terminal's owner attaches `write`, any other Member `read`. A terminal whose machine lost its session answers `410` and is ended `lost`. ChatApi strips any `x-smithers-*` header the browser sent and forwards its decision to the branch's `SandboxObject` (`worker/BranchSandboxes.ts`), which accepts the socket (no hibernation, which would drop the tmux client) and runs `@smthrs/platform-cloudflare`'s `ContainerTerminal.attach` in its own scope.
- **The wire protocol** is `@smthrs/sandbox`'s `TerminalProtocol`: binary frames are bytes; JSON text frames are control (`resize` from the owner, `ready` and `ended` from the host); frames over 64 KiB close with 1009; final close codes don't reconnect; `@smthrs/platform-browser`'s `TerminalSocket` reconnects after 1 s, doubling to 30 s, 10 times, and drops keystrokes typed while disconnected.
- **The frame** is `@smthrs/terminal-frame`'s `TerminalFrame`: our xterm in an opaque-origin `srcdoc` frame whose script is pinned by hash and whose CSP allows no network. ⌘K comes back to the page; links open only from a click.
- **Reload keeps the shell.** Each terminal is a tmux session; a socket is one tmux client. A new socket attaches to the same session, and tmux redraws the screen.

## The machine

- **One container per branch**, under the `durable_object` scheduling policy (`infra/BranchSandbox.ts`), from `infra/sandbox/Dockerfile`: Debian trixie with git, tmux, bash and CA certificates, Node and pnpm, Go, Python with pip and venv, and a C toolchain, no credentials. `SandboxObject` (named by the branch's id) starts it with internet off and re-arms its 30-minute inactivity timeout (`@smthrs/platform-cloudflare`'s `SandboxObject.wake`); its generation goes up each time it starts the box.
- **Checkout.** `sandbox/Wake` clones the one branch, 50 commits deep, into `/workspace` as `smithers` (`worker/branch/Checkout.ts`), unless a checkout is there.
- **Each person is their own user** (`worker/branch/Users.ts`): `p` and 16 hex digits of the SHA-256 of their person id, made on first use in the `workspace` group. Their tmux server's socket is theirs alone, so one person's shell can't attach to, type into or signal another's; `/workspace` is shared through the group (setgid, umask 002, `safe.directory`).

## The forge

The box has no credential and no internet. It reaches the package registries through its egress ([the machine](sandbox-tools.md#the-machine)), and its repository only through `http://forge.smithers.internal`, which `SandboxObject` intercepts (`interceptOutboundHttp`) and answers with `@smthrs/effect-code-storage`'s `GitProxy.uploadPack`: only `info/refs?service=git-upload-pack` and `git-upload-pack` (a push and anything else is 403), to the branch's own repository whatever the guest's path names, with the read credential added outside the box (`worker/branch/Forge.ts`):

| Forge | When | Credential |
|---|---|---|
| Code Storage | `CODE_STORAGE_ORG` and `CODE_STORAGE_KEY` are set; the repository must be cloned | a five-minute `git:read` token for that one repository (`CodeStorage.gitRemote`) |
| GitHub | otherwise, and always for a TODO's machine | none: public repositories only. `GITHUB_TOKEN` is never used, because it would read every repository its owner can |

A TODO's machine (`todo-<attempt id>`, [todos.md](todos.md#the-run)) checks out its base commit from GitHub, alone and detached, which the Code Storage mirror may not have yet (the TODO below's branch), so its branch says `forge: "github"` and it reads GitHub whatever the deployment's forge is (`forgeOf`). `todo/Publish` makes its branch on GitHub. The checks on its pull request's head fetch that head the same way.

`branch/track` reads a branch through the same forge with git protocol v2's `ls-refs` for that one ref (`GitRemote.ref`): `octocat/Spoon-Knife`'s full ref list took 40 to 70 seconds to read from a Worker.

## Sharing

A live branch (its conversation, terminals and room) is private to its owner until they share it, as in Google Docs and Figma (decision 0013, decisions 8, 9 and 12). The code stays as public as GitHub makes it.

```
Share test-branch ┌──────────────────────────────────────────────┐
                  │ [Add people        ] [Can view ▾] [Share]    │
                  │ People with access                           │
                  │ (L) local-developer (you)            Owner   │
                  │ (B) ben                  [Can edit ▾] Remove │
                  │ General access                               │
                  │ [Restricted ▾ | Anyone in this repository with the link] [Can view ▾] │
                  │ [Copy link]                           [Done] │
                  └──────────────────────────────────────────────┘
```

**Who may do what** is decided at every request by `accessOf` in `worker/branch/Access.ts`, the one place the policy lives:

| Person | What they may do |
|---|---|
| The owner (`branches.created_by`), a Member or above | `owner`: everything below, and share |
| Someone the branch is shared with by name | their share's `view` or `edit` |
| A Member or above, when general access is on | general access's `view` or `edit` |
| A Guest | only what a share by name grants, and never more than `view` |
| Anyone else, or signed out | nothing: `No access` |

- **The best grant wins, capped by role:** a Member or above may edit at most, a Guest view, a person with no role nothing. A Guest shared to edit views.
- **The role is the person's on the branch's own repository** ([decision 0079](../decisions/0079-roles-per-repository.md), `BranchRoles` in `worker/branch/Access.ts`): on a repository Smithers recorded the App's installation on, their GitHub permission there through `RepoRoles`, kept 5 minutes, so a Member of the deployment's repository who only reads `smithersai/vibelang` is a Guest on its branches (no `Can edit`, no terminal, `No access` on its `main`); on any other repository nothing done in the branch reaches GitHub, and the session's role decides, as before. Tracking and making a branch need a Member there. The room and each terminal keep that role and re-check shares with it. GitHub or Postgres not answering is `503`, never a guessed role.
- **The team's branches have no owner:** the default branch, and branches tracked before sharing existed, carry general access `edit` (migration `0023_branch_sharing`), so every Member uses them as before and nobody can change that.
- **`view`** opens the conversation, every terminal on the branch read-only and the room. **`edit`** also asks in the conversation, adds views, writes answers, opens a terminal, and types into any terminal on the branch: editors use one terminal together, live (the sharing brief, 2026-10-20). A terminal still runs as its owner's own user ([The machine](#the-machine)), so an editor typing in someone else's terminal runs as them; sharing to edit is the owner's trust decision, as Live Share's read-write terminals are.
- **Enforced on every request:** the track route, every shape (`messages`, `views`, `terminal_sessions`, `branch_shares`: anyone else's shape has no rows), `POST /api/questions` (`403 view_only`), `POST /api/views`, the answer routes, `POST /api/terminals`, each terminal socket (`write` for `edit` and up, `read` for `view`; a reader's bytes and resizes never reach the shell) and the room.

**Changing it** is the client flow `branch/share { branchId, change }` (`src/features/sharing/`, door `button`, never the agent's), whose step posts `POST /api/branches/<id>/shares` (`worker/branch/Shares.ts`):

| Body | Does |
|---|---|
| `{ login, access }` | shares with the person who signed in to this deployment with that GitHub login (any case), or local development's people (`worker/branch/People.ts` `Directory`), by their id |
| `{ grantee, access }` | changes a grant: a person's id, or `repository`, general access |
| `{ grantee, access: null }` | removes it; anyone may remove their own |

It answers `200 { txid }` (`null` when nothing changed), `401`, `403 forbidden` (not the owner), `404 not_found` or `no_person`, `400 invalid` (a bad body, or sharing with yourself), `409 too_many` (over `MAX_SHARES`, 100 people), `413`, or `503`. Only the owner's `branch_shares` shape (`GET /api/shapes/shares?branch=<id>`) has rows; the dialog shows it.

**Revocation takes effect on open sessions** before the route answers: it reads the branch's whole list (`policyOf`) and hands it to the branch's machine (`TerminalSockets.enforce`, `SandboxObject`) and room (`Rooms.enforce`, `RoomObject`), which apply `underPolicy` to every socket they hold, from the principal and role each socket attached with. A socket whose person may no longer view the branch closes with 1008 (final: the page shows `No access` at once, and the terminal detaches); one whose access changed closes with 1011 (terminal) or 1012 (room) and reconnects with the new access, so `view` to `edit` turns on typing and the composer without a reload. The terminals of a person who lost the branch end `revoked` (their tmux sessions are killed). The shapes refuse the person's next request: their `where` changes, Electric answers `409 must-refetch`, and the device's copy empties. If the machine or room can't be reached, the route answers 503 with the change already made, and the flow's step sends it again until it is applied.

## Presence

Everyone on a branch's page is in its room: one hibernating `RoomObject` Durable Object per branch (`worker/BranchRooms.ts`), which stores nothing and never wakes the branch's machine. The page's socket is `GET /api/branches/<id>/room` (`worker/branch/Presence.ts`): same origin only, signed in, at least `view`. ChatApi stamps who joins (principal, login, role, access) in headers the browser can't set; the room keeps them in each socket's attachment (`@smthrs/sync`'s `PresenceRoom`) and sends everyone the roster on each change. The page sends only where it is: `{ view: "code", path }` or `{ view: "terminal", terminalId }` (`src/features/presence/where.ts`), at most 1 KiB.

- **Avatars** (`PresenceAvatars`, `@smthrs/ui`'s `AvatarStack`): everyone else, once each, titled with where they are; choosing one follows them to their place, as in Google Docs and Figma.
- **Live cursors:** the prompt, a file in the live editor and a run's answer box show everyone's carets, each through its own text's room ([co-editing](coedit.md)); the terminal shows everyone tmux's one screen and cursor. Following someone in the live editor (`edit`) opens the same file.
- **Live access:** the room's roster says what this person may do (`read` or `write`); the screen follows it (`accessNow`), and a room closed with 1008 is `revoked`.
- **Seams with notifications (0009):** a run on a branch reaches only watchers who may still view it (`worker/Notifications.ts` reads `policyOf` and `underPolicy`), and a watch is recorded only for someone who may view the branch. The runs other people start on a branch show through notifications, not presence.

## Postgres

`db/migrations/0023_branch_sharing.ts` adds `branch_shares` (one row per grantee: a person's id with their login then, or `repository`; `view` or `edit`), gives the team's branches general access `edit`, and adds `terminal_sessions.owner_role` (default `member`), so a change of sharing knows whose terminals end.

`db/migrations/0014_branch_workspace.ts` adds `branches` (an immutable id per living branch; `(repo_id, name)` unique while not deleted; no foreign key to `repositories`, because a branch of a repository this deployment can't clone is read from GitHub), `conversations` (one per branch), `conversation_id` on `messages` and `views` (an answer's `(question_id, conversation_id)` references its question's own), and `terminal_sessions` (status `opening`, `open`, `ended` with why, `failed` with why; one live per person per branch). It binds every existing message and view to the home conversation. `branches.mode` allows `locked` beside 0013's `open` and `restricted`, for the default branch (decision 0007 §5).

## Observability

Content-free: ids, outcomes, statuses, close codes, byte counts by direction and durations; never a terminal's bytes, a branch's name, a token or anything asked.

`branch.open` logs `outcome: tracking` inside its span before dispatch, so a page
waiting offline has a correlated progress record before the final outcome is counted.

| Where | Records |
|---|---|
| ChatApi | `branch.track` (log, span, `smithers_branch_tracks{outcome}`); `terminal.open` and `terminal.connect` (logs, spans, `smithers_terminal_requests{route,outcome}`); `terminal.shape` (`smithers_terminal_shape_requests`); `branch.share` (log, span, `smithers_branch_shares{change,outcome}`, `smithers_branch_terminal_revocations`); `branch.shares.shape` (`smithers_branch_share_shape_requests`); `branch.room` (log, span, `smithers_branch_room_joins{outcome}`) |
| `RoomObject` | `room.enforce` (log), `room.object.enforce` (span); `@smthrs/sync`'s `smithers_presence_{joins,frames,evictions,open}` |
| `terminal/Open` | `terminal.open.wake`, `terminal.open` (logs), `sandbox.wake`, `terminal.session`, `terminal.open` (spans), `smithers_terminal_opens{outcome}` |
| `SandboxObject` | `sandbox.object.wake`, `sandbox.checkout`, `sandbox.wake`, `sandbox.enforce` (log), `sandbox.object.enforce` (span); `@smthrs/platform-cloudflare`'s `smithers_cloudflare_terminal_{connects,sessions_open,bytes,sessions}` and `smithers_cloudflare_sandbox_wakes`; `git.proxy` with `git_proxy_requests{service,outcome}` |
| Browser (`BRANCH_TELEMETRY`, `SHARING_TELEMETRY`, `PRESENCE_TELEMETRY`, `TERMINAL_TELEMETRY` in `src/telemetry.ts`) | `branch.track`, `branch.open`, `smithers_web_branch_{tracks,opens}`, `branch.share`, `branch.share.post`, `branch.share.press`, `smithers_web_branch_shares{change,outcome}`, `presence.join`, `presence.closed`, `smithers_web_presence_{joins,closes}`, `terminal.open`, `terminal.connect`, `smithers_web_terminal_opens`, `terminal_open_ms`, `terminal_reconnects{code}`, `terminal_bytes{direction}`, `terminal_ended{reason}` |

No record carries a login, a person's place or a path; a share's records name its kind (`person`, `access`, `remove`, `link`), never its grantee.

## Tests

| Kind | Where |
|---|---|
| Component | `src/screens/branch/connection.test.ts` (offline queue and reconnection), `src/screens/branch/offline.test.ts` (evicted storage, pending route identity, verified recovery and terminal preload), with real app services and injected faults |
| Unit | `worker/branch/*.test.ts` (sharing: `Access`, `Shares`, `Presence`), `worker/flows/TerminalOpen.test.ts` and `worker/ExecutionHost.test.ts` (`terminal/Open` on the remote host), conversations in `worker/Chat.test.ts`, `worker/Views.test.ts` and `worker/ShapeProxy.test.ts`, `src/features/branch/*.test.ts`, `src/features/sharing/*.test.ts`, `src/features/presence/*.test.ts`, `src/features/terminal/*.test.ts`; `@smthrs/sync` (`PresenceProtocol`, `PresenceRoom`, `PresenceSocket`), `@smthrs/ui` (`AvatarStack`, `ShareDialog`); `@smthrs/effect-code-storage` (`GitProxy`, `GitRemote.ref`, `gitRemote`), `@smthrs/crypto` (`Uuid`), `@smthrs/sandbox` (`TerminalProtocol`), `@smthrs/platform-browser` (`TerminalSocket`), `@smthrs/ui` (`TerminalFrame`) |
| Real container | `@smthrs/platform-cloudflare`'s `test/ContainerTerminal.workerd.test.ts`: local workerd and Docker with this image |
| End to end | `e2e/branch-workspace.spec.ts`, `e2e/branch-offline.spec.ts` (a branch's page opened offline past tracking's 30 s, then the network returning) and `e2e/branch-sharing.spec.ts` (two and three people on separate devices: share to view and edit, a viewer's input refused by the server, revoke, general access and a Guest) against `alchemy dev` (`pnpm e2e e2e/branch-sharing.spec.ts`, `pnpm e2e:gifs`) |

The branch workspace's composer helper waits for either the visible input or
Chat button before choosing an action (`e2e/composer.ts`). A branch URL and its
pending chrome can arrive before those controls. `e2e/composer.test.ts` reproduces
that gap in a real browser; `branch-load.spec.ts` checks the conversation's load
budget independently.

## Running it locally

`pnpm db:up`, `pnpm db:migrate`, `pnpm dev`, then open `https://localhost:1443/octocat/Spoon-Knife/tree/test-branch`. `alchemy dev` builds the sandbox image for `linux/amd64` through Docker on first start (a few minutes under emulation on Apple Silicon) and runs each branch's container in local workerd. A Worker reload restarts the objects and their containers, so an open terminal ends `lost` and Open terminal starts a new one.

## What's not built

- Sharing with someone who has never signed in to this deployment: the dialog finds people by the login they signed in with, not through GitHub's API, so it never reads a GitHub permission at share time; the role (GitHub's permission, re-checked hourly) caps every check instead.
- The last screen of a terminal whose machine slept ([sandbox tools](sandbox-tools.md#sleep-and-wake) ends it `slept`), and snapshots.
- Archive (`conversation_people`) and the branch picker.
- Private repositories: they wait for per-repository GitHub App installation tokens.
- Two-person tests against a deployment: production has one test account until the second one Will approved exists (ruling TEST-6; [co-editing](coedit.md)).

### Reopening a saved conversation offline

The device keeps each verified branch route’s conversation id (`branch-conversations`,
[decision 0038](../decisions/0038-offline-branch-conversations.md)). Reopening offline
restores that conversation, its queued questions and their Connection count. No
workspace grant is cached: the composer, sharing and terminals wait for tracking
to verify access again. An unknown route shows public chrome only. A definitive
refusal removes the saved route; sign-out wipes it with the device.

Regression: `src/features/branch/offlineConversation.test.ts`; browser proof:
`e2e/local-first.spec.ts` “offline branch”. Both exercise the real device store
and outbox. No model call is needed to prove restoring queued questions.

Automatic branch reads use `POST /api/branches?optional=true`. An inaccessible workspace answers `204` with `x-branch-state: forbidden`; the device retains its access refusal while the repository remains readable. Explicit creation and ordinary API calls still answer `403`. No branch or conversation is recorded for a denied reader.

A confirmed missing branch answers optional browsing with `204` and `x-branch-state: not_found`; ordinary calls still answer `404`. The repository page says Branch not found and links to Code, preserving Not synced yet only for a mirror that actually reports that state.

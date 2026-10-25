# 0013: The branch workspace: one conversation per branch, a terminal in a frame, and sharing

For new conversations, [0095](0095-new-conversation-ephemeral-refs.md) supersedes the GitHub-branch interpretation below. Branch identity, conversation, sandbox, presence and sharing remain together; the branch stores its ref namespace and forge.

Status: S1, branch sharing, presence and co-editing are built ([branch workspace](../features/branch-workspace.md), [co-editing](../features/coedit.md)). Design panel B: Opus as lead and merger, and Sol; 2026-10-20. Its one question is settled: sharing follows Google Docs and Figma (decisions 8, 9 and 12; Will at 13:31:14 and the lead at 13:32:34 on 2026-10-20). It covers three of Will's 2026-10-20 asks:
- "One conversation per branch is important";
- "ability to open terminal in an iframe is important";
- "google docs style sharing where we can create a branch share with others to read and write to that branch in multiplayer experience".

It builds on [0002](0002-local-first.md) (the device store and the outbox), [0004](0004-agent-ui-codemode-and-rendering.md) (views and the sandboxed frame), [0005](0005-sandboxes-secrets-and-the-forge.md) (branch sandboxes, Yjs files), [0007](0007-roles-and-tags.md) (roles and branch modes), [0008](0008-auth.md) (actors), [0009](0009-notifications-and-live-work.md) (watches) and [0011](0011-the-agent-runs-in-the-browser.md) (the agent in the browser). Creating, pushing and resyncing branches belongs to 0012 (the git loop, panel G); this record builds the workspace on the branch that 0012 creates. Opus and Sol designed independently; the [appendix](#appendix-opus-sol-and-final-compared) compares them. Its one question for Will is settled ([Questions for Will](#questions-for-will)).

## Decision

1. **A branch is the workspace.** Each branch has a `branches` row with an immutable id. Renaming keeps the id; deleting and re-creating a ref makes a new one. The conversation, terminals, presence, live files and shares all hang off that id. `main` is a branch whose conversation is the team's home, and it has no machine for people (mvp.md §3).
2. **One conversation per branch, for as long as the branch lives.** Its id is `uuidv5(branch id)`, so a device knows it offline.
   - **Starting fresh** means a new branch, never clearing a conversation other people share.
   - **Archive is personal:** it hides the conversation from your list on all your devices, and opening the branch brings it back.
   - **No conversation lives outside a branch.**
3. **Everything chat-scoped names its conversation explicitly.** That covers messages, views, outbox rows, runs and the agent's execution. Nothing infers a branch from the current URL, so switching never retargets work already running.
   - Each conversation is one Electric shape and one persisted TanStack DB collection.
   - Only the open conversation, and conversations with work in flight on this device, sync live.
4. **The terminal is our `@smthrs/ui` `Terminal` inside an iframe.**
   - **The frame** is opaque-origin (`sandbox="allow-scripts"`, `srcdoc`), the pattern `GeneratedView` already uses.
   - **The page** holds a same-origin WebSocket, authenticated by the session cookie, and passes bytes to the frame through a transferred `MessagePort`.
   - **Ruled out:** ttyd, a second domain, and a ticket in a URL.
5. **One terminal per person per branch.** Each terminal is a tmux session in the branch's container. Each socket attaches with `exec(argv, { pty })`, Cloudflare's own 1.0 pattern [1].
   - **The owner** attaches read-write. Every other viewer attaches with `-r`, and the server drops all of their input, including the terminal's automatic replies and resizes.
   - **Built (sharing slice, 2026-10-20):** anyone with `Can edit` (decision 8) attaches read-write too, so editors use one terminal together, live, as the sharing brief asked; `Can view` attaches read-only. The shell still runs as its owner's user, so sharing to edit is the owner's trust decision, as Live Share's read-write terminals are ([branch-workspace.md](../features/branch-workspace.md#sharing)).
   - **Readers** never start a shell or wake a machine.
6. **Opening a terminal is a durable flow; its bytes are not.** `terminal/Open` admits, wakes, creates the session and records it on the Cloudflare host. Keystrokes and output stream outside the journal, and neither is ever replayed, logged, traced or counted by content.
7. **A terminal outlives reloads and dropped connections, and ends with its machine.**
   - tmux keeps the shell while the container runs, and redraws the screen on reattach.
   - `sandbox/Sleep` stores each session's last screen and ends it.
   - `sandbox/Keep` decides idleness from what the box is doing, not from open sockets, so an idle tab never keeps a container awake.
8. **Sharing works as in Google Docs and Figma, within GitHub's ceiling.**
   - **Private until shared:** a branch's live workspace is visible only to its owner, the person who created or first tracked it.
   - **The team's branches have no owner:** `main`, and branches tracked before sharing existed, are open to every Member and above. `main` stays `locked`.
   - **By name:** the owner shares with people by GitHub login, as `Can view` (`view`) or `Can edit` (`edit`).
   - **General access:** off by default. The owner may turn on "Anyone in this repository with the link", as `Can view` or `Can edit`. It admits Members and above only.
   - **Guests** see a branch only when it's shared with them by name, and only as `Can view`.
   - **Effective access** is the best grant a person holds (owner, their own share, general access), capped by their role (derived from GitHub, re-checked hourly) and the branch's lock, decided at every check.
   - **Ceilings:** edit needs the Member role (GitHub write); view on a private repository needs GitHub read.
   - **Changing and revoking:** the owner changes or removes anyone's access and general access. Anyone may remove their own access.
   - **GitHub stays untouched:** sharing never sends a GitHub invitation and never grants secrets, merging, approvals or administration.
9. **The live workspace is private to the people with access,** on a public repository too. The live workspace is the conversation, terminals, presence and live edits. Viewers see everyone's avatars and live cursors and appear in them, as in Figma. Code stays as public as GitHub makes it.
10. **Each kind of state has its transport.**
    - **Durable state** syncs through Postgres and Electric: conversations, shares and terminal rows.
    - **Files** use 0005's Yjs documents over Electric.
    - **Presence and cursors** go through one hibernating `RoomObject` per branch, which stores nothing.
    - **Terminal bytes** go through sockets on the branch's `SandboxObject`.
11. **Revocation is one flow step.**
    - **Order:** bump `access_epoch` (0007 §6), then evict the person from the room and the sandbox with close code 1008.
    - **A former writer** also loses their tmux sessions.
    - **Shapes** refuse within one live request (Electric holds one for up to 20 s).
12. **Sharing and multiplayer UX follow established collaboration tools, and aren't put to Will.** Will, 13:31:14 on 2026-10-20: "Shared branch you should be able to use common sense and how other collaboration tools to figure it out without asking me questions."
    - Where Google Docs and Figma agree, do what they do. Where they differ, pick the simpler behavior and record it here.
    - GitHub's ceiling (decision 8) and revocation (decision 11) still hold.

## Why

- **The spec already says it.** "Each branch is one conversation, shared by everyone on the branch" (mvp.md §3, §6.4). A per-branch archive that empties the conversation for everyone would let one person clear the team's home. The old app had to refuse archiving during a turn for that reason (`packages/backend/internal/chat/archive.go:95-99`). A personal archive plus "new topic means new branch" has no such conflict, and needs no generation or convergence logic.
- **A frame honors Will's word and isolates untrusted output.**
  - **The risk:** branch code can print anything, and xterm's guide says to "treat terminal data always as untrusted" [7]. In an opaque frame, a parser bug runs with no access to the app's DOM, cookies or storage.
  - **The page keeps the socket:**
    - the cookie authenticates it on the same origin, with no ticket;
    - reconnecting stays in our transport;
    - the frame never touches the network.
  - **The pattern exists:** `GeneratedView` already ships this frame, with a hash-pinned runtime, a nonce and a transferred port (`packages/smithers/ui/src/generated-view/GeneratedView.tsx:60-71,168-175`).
  - **ttyd behind a preview URL loses on four counts:**
    - it needs a separate registrable domain, because previews "under a domain that your application also uses share cookies" [2];
    - `framedPageTarget` refuses the app's own site (`packages/smithers/ui/src/web-page/webPageUrl.ts:90-105`);
    - read-only viewers would need a second server;
    - the repository's image would control the terminal's front end.
- **tmux is Cloudflare's 1.0 answer.**
  - **What 1.0 changed:** Sandbox SDK 1.0 removed `sandbox.terminal()`, sessions and the xterm addon. "Your Durable Object attaches each WebSocket to a tmux session with `exec(argv, { pty })`", and "the shell keeps running when the page reloads or the connection drops" [1].
  - **No new dependency:** Alchemy beta.83 already exposes `exec` with `pty`, `stdin`, `resize` and `kill` as Effects (`apps/mvp/node_modules/alchemy/src/Cloudflare/Containers/ContainerClient.ts:74-93,142-145`), so this adds no `@cloudflare/sandbox` dependency.
  - **It replaces the old ring buffer:** tmux's read-only attach and redraw take the place of the old app's 512 KiB ring buffer and in-memory sessions, which a restart lost (`packages/backend/internal/routes/terminal_session_manager.go:23-37`).
- **One terminal per person, not one shared controller.** mvp.md §6.8 says each person's terminal runs as that person, in that machine's home, where their tool logins persist. A shared shell that writers take turns controlling would later run one person's commands with another's logins. Every terminal is still visible to everyone on the branch, so "read-only for readers" holds.
- **Presence must not pin a machine.** Hibernated Durable Objects bill no duration [3]. A container's object holds its socket open (hibernation would drop the tmux handle [1]), so presence lives in its own object. A watcher's open tab then costs nothing and wakes nothing.
- **Shares can't widen GitHub (M-46).**
  - **Private repositories:** a `Can view` share to someone GitHub hides the repository from would leak code.
  - **Writes:** a `Can edit` share to someone without push would let the App push their code.
  - **Links:** the old `BranchShare` signed links (`packages/smithers/flows/sync/src/BranchShare.ts:1-25`) grant a capability to whoever holds them, so they aren't used for people. General access needs no token. As in Google Docs' "Anyone in this organization with the link", the branch's own URL is the link and the repository role is the gate, so a forwarded link admits nobody new and never a Guest.
- **Private until shared is what people expect** from Google Docs, Figma, Codespaces and Live Share. Prompts, terminal output and cursors are Smithers' data, not GitHub's. Opening them on every public repository, or to every Member, would be a privacy surprise. 0007 lists "watching a branch live" under `repo:read`; decisions 9 and 12 narrow it.

## Consequences

- **0005 changes in three places.**
  - Readers now receive terminal output, though still no sandbox-control capability (its §2, "Read-only views never receive a terminal").
  - Cursors move from y-electric awareness rows to the room. 0002 §4 said to add a stream once presence exceeds one write a second per person, and cursors do while typing.
  - `CodeEditorView` does not bind `yCollab` today; it only accepts a binding (`packages/smithers/ui/src/adapters/code-editor/index.tsx:26-37`). The binding moves into `@smthrs/ui` here.
- **0007 changes before it is built:**
  - `branch_shares` replaces `branch_writers`, and `branches.mode` replaces `branch_rules`, both keyed by branch id, not name (0005's identity rule). Of the modes, only `locked` still decides anything: the share list replaces `open` and `restricted`;
  - two actions join the catalog: `repo:branch-watch` (the owner, a share, or general access) and `repo:branch-share` (the branch's owner; the agent never);
  - `repo:read` loses "watching a branch live" (decisions 9 and 12).
- **The first slice** let every Member watch every live branch (`LIVE_BRANCHES_PUBLIC = false`). Sharing replaces that rule with decision 8's grants, decided in `worker/branch/Access.ts`.
- **0008:** the global conversation ends as 0008 planned. Each shape names a conversation, and the proxy authorizes it on every request.
- **The agent (0011)** answers inside one conversation: its turn wait and its history stay there, and the conversation's branch is its default ref.
- **No new npm dependency.** xterm 6.0.0 and `y-protocols` are already in `@smthrs/ui`, and Alchemy already provides containers. The image adds Debian packages only.
- **Library catalog entries used** (`docs/libraries.md`): `@smthrs/flow`, `@smthrs/platform-cloudflare`, `@smthrs/platform-browser`, `@smthrs/sandbox`, `@smthrs/effect-electric`, `@smthrs/effect-tanstack-db`, `@smthrs/effect-code-storage`, `@smthrs/integrations`, `@smthrs/sync` (`BranchProtocol`, `BranchPresence`), `@smthrs/capability` with 0007's `@smthrs/access`, `@smthrs/observability` and `@smthrs/ui`.

## 1. Data and state

```sql
branches          (id uuid PRIMARY KEY, repo_id text REFERENCES repositories, name text,
                   mode text NOT NULL DEFAULT 'open' CHECK (mode IN ('locked','open','restricted')),  -- only 'locked' decides access (decision 8)
                   base_sha text, created_by uuid, created_at timestamptz, deleted_at timestamptz)
                   -- UNIQUE (repo_id, name) WHERE deleted_at IS NULL; shared with 0012, which creates and renames refs
conversations     (id uuid PRIMARY KEY,                                   -- uuidv5(branch_id)
                   repo_id text, branch_id uuid UNIQUE REFERENCES branches, created_at timestamptz,
                   CHECK (branch_id IS NOT NULL OR id = '<legacy id>'))   -- the one legacy archive, below
conversation_people (conversation_id uuid, person_id uuid, archived_at timestamptz, PRIMARY KEY (conversation_id, person_id))
messages          + conversation_id uuid NOT NULL REFERENCES conversations, + author_login text, + author_github_id bigint
                  -- UNIQUE (id, conversation_id); an answer's (question_id, conversation_id) references it
views             + conversation_id uuid NOT NULL REFERENCES conversations
branch_shares     (branch_id uuid, grantee text, login text, access text CHECK (access IN ('view','edit')),
                   shared_by text, created_at timestamptz, updated_at timestamptz,
                   PRIMARY KEY (branch_id, grantee))
                   -- grantee: a person, or 'repository' for general access (Members and above with the link)
sandboxes         (branch_id uuid PRIMARY KEY, state text, generation bigint, snapshot_id text, image_digest text)  -- 0005
terminal_sessions (id uuid PRIMARY KEY, branch_id uuid, owner_id uuid, owner_login text, generation bigint,
                   status text CHECK (status IN ('opening','open','ended','failed')),
                   ended_reason text CHECK (ended_reason IN ('closed','slept','lost','revoked')),
                   last_screen text CHECK (octet_length(last_screen) <= 65536), created_at timestamptz, ended_at timestamptz)
                   -- UNIQUE (branch_id, owner_id) WHERE status IN ('opening','open'); opening deletes the owner's older ended rows
```

- **Conversations start with their branch.** 0012's `branch/Create` inserts the conversation in its last step. For a ref that already exists on GitHub, `branch/Track` creates the row on first open (§2). The ask route also inserts the conversation `ON CONFLICT DO NOTHING`, so an offline device can ask before the row syncs.
- **Authors** are a snapshot of the asker's login and GitHub id, taken from the session, never from the body. `asked_by` stays unsynced.
- **A share names its grantee by id, never by login,** so a rename keeps it. The login is a snapshot for display, resolved again by id after a rename, as the old roster did. General access is the row whose grantee is `repository` (`packages/backend/internal/services/member_roster.go:217-260`).
- **Migration `0013_branch_workspace`:**
  1. Insert a `main` row for every repository already cloned.
  2. Bind today's `messages` and `views` to the deployment repository's (`GITHUB_REPOSITORY`) default-branch conversation, keeping their ids and positions. With no such repository, bind them to one archived legacy conversation that no shape serves (0008).
  3. For one release, `POST /api/questions` without `conversationId` means that same conversation, so asks queued by the old build still land. Then it answers 400. There is no lasting second write path.
- **Synced tables are `REPLICA IDENTITY FULL`.** `last_screen` and titles are content: synced, never logged.

**Shapes and device collections.** The server fixes each shape's table, columns and `where`. The browser names only the id and its sync position (0008 §5).

| Shape | `where` | Authorized by | Device collection |
|---|---|---|---|
| `branches` | `repo_id = $1` | `repo:read` | `branches:<repo>`, persisted |
| `conversations` | the branches the person may watch | `repo:branch-watch` on each branch | `conversations:<repo>`, persisted |
| `conversation_people` | `person_id = $actor` | signed in | `myConversations`, persisted |
| `messages`, `views` | `conversation_id = $1` | `repo:branch-watch` on its branch | `messages:<conversation>`, `views:<conversation>`, persisted, eager (0002) |
| `branch_shares` | `branch_id = $1` | the branch's owner | `shares:<branch>`, persisted |
| `terminal_sessions` | `branch_id = $1` | `repo:branch-watch` on its branch | `terminals:<branch>`, persisted |
| `ydoc_updates` (0005) | `doc_id = $1` | the same; writes need `repo:branch-write` | y-electric's provider |

- **The collection registry** (in `@smthrs/effect-electric`) opens a conversation's collection when a route, an outbox entry or a running answer needs it. It keeps each collection's shape handle and offset with it, never a global `messages` handle.
- **Switching** never closes a collection that a pending write or a running answer uses. A conversation not in use rests on its stored snapshot and resumes from its handle when reopened. The LRU cap (`work/lru-size-limit.md`) evicts whole conversations. The `schemaVersion` bump costs one fresh sync, as 0002 §5 planned.
- **Per-person view state** (scroll anchor, open cards, the draft) is a local-only persisted collection keyed by conversation id (mvp.md §6.4: "Each person keeps their own scroll position and card view state").
- **The outbox stays one outbox** with one leader (0002). Each `asking` and `unsent` row carries its conversation id. A message id reused with another conversation is a 409, like other content.

**What moves to per-conversation scope:**

| Area | Today | After |
|---|---|---|
| Chat (0002) | one `messages` shape for everyone | one shape per conversation; `POST /api/questions {id, answerId, conversationId, text}`, authorized `repo:ask` plus `repo:branch-watch` |
| The agent (0011) | the turn wait and history over all messages | `GET /api/answers/<id>` derives the conversation from the answer; the turn wait, the 19-exchange history, expiry and author checks all filter by it; the asking browser still owns the run, and viewers never start a second one |
| Views (0004) | one global table | `views.conversation_id`; 0004's `authorize` already refuses a view outside the answer's conversation |
| Notifications (0009) | — | `runs.conversation_id` and the branch on every run; creating a branch, a share and opening a terminal write a watch on `branch:<id>`; 0009's scope routing is unchanged |

## 2. Flows

Every payload carries a client-chosen id for idempotence. The actor, role and epochs come from the server.

| Flow | Payload | Placement | Who | Agent |
|---|---|---|---|---|
| `branch/Create` | 0012's | 0012's; its last step inserts the conversation and the creator's watch | Member (`repo:branch-create`) | run |
| `branch/Track` | `{ repoId, ref }` | Cloudflare (the Code Storage key reads the ref) | Member | run |
| `conversation/archive` | `{ conversationId, archived }` | device: outbox mutation → `POST /api/conversations/<id>/archive` | the person, for their own list | run |
| `app/navigate` (exists) | a branch route | device | anyone | run |
| `terminal/Open` | `{ terminalId, branchId, cols, rows }` | Cloudflare (needs a machine) | `repo:branch-write`; never on a locked branch | never: a terminal is a person's own session; the agent's commands run as jobs (0005) |
| `terminal/Close` | `{ terminalId }` | Cloudflare | the owner, or Maintainer | never |
| `sandbox/Wake`, `Keep`, `Sleep` | 0005's | Cloudflare | system | — |
| `branch/Share` | `{ branchId, login, access }`, or `{ branchId, repository: true, access }` for general access | Cloudflare (the sharer's sealed GitHub token, as `auth/RecheckRole` uses one) | `repo:branch-share` | never: granting is non-delegable (0008 decision 9) |
| `branch/Unshare` | `{ branchId, grantee }` | Cloudflare | `repo:branch-share`, or the person themselves | never |

**`terminal/Open`:**
1. **Admit:** under `access_epoch FOR SHARE`, check `repo:branch-write`, then insert the `opening` row.
2. **Wake** with `sandbox/Wake`, an idempotent no-op when the box is already awake.
   - In the first slice it starts the container with `enableInternet: false` and registers `interceptOutboundHttp("forge.smithers.internal", Egress)`.
   - Then it runs `git clone --depth 1 http://forge.smithers.internal/<repo> /workspace` and `git switch <branch>`.
3. **Create the session:** as user `smithers`, run `tmux has-session -t <id> || tmux new-session -d -s <id> -c /workspace`. The session name is the terminal's UUID.
4. **Record:** mark the row `open` with the generation.

**`Egress`, first slice.** It is the forge subset of 0005 §4:
- It allows only `GET …/info/refs?service=git-upload-pack` and `POST …/git-upload-pack` on `forge.smithers.internal`.
- It adds a five-minute `git:read` JWT for that one repository (`@smthrs/effect-code-storage`) and forwards over HTTPS.
- It refuses everything else. The token never enters the box.

**`branch/Share`:**
1. Resolve the login with `GET /users/{login}` to a numeric id.
2. Read `GET /repos/{o}/{r}/collaborators/{login}/permission` [4], whose `permission` is `admin`, `write`, `read` or `none`.
3. Refuse `edit` below GitHub `write`, and any share at `none` on a private repository. A Guest gets `view` at most.
4. Upsert the row and the grantee's watch. If the grantee is already a person, they get a 0009 notification (kind `shared`, action Open).

GitHub is read only through `@smthrs/integrations`, and no GitHub invitation is ever sent. General access calls no GitHub API: it admits only Members and above, whose role already means GitHub write. Turning it off removes everyone who had only the link, at their next check.

**Who may watch and write.**

| Person | Watches the live branch | Writes (files, own terminal, jobs) |
|---|---|---|
| The owner (a Member or above) | yes | yes, unless `locked` |
| Shared by name | yes | with `Can edit`, as a Member or above |
| Admin, Maintainer, Member, with general access on | yes, from the link | with `Can edit` general access |
| Admin, Maintainer, Member, otherwise | never: private until shared | never |
| Guest (GitHub read; any signed-in person on a public repository) | only when shared by name | never: `Can edit` stays unavailable until GitHub grants write |
| No access to a private repository | never: the dialog shows `needs access on GitHub ↗` (mvp.md §6.15) | never |
| Signed out | never | never |

The team's branches (`main`, and branches tracked before sharing existed) have general access `Can edit` for Members and above, and no owner.

Asking in a branch's conversation is writing: it needs `repo:ask` (Member) and edit access. On `main`, every Member asks, and every code tool still meets the locked mode.

**Revocation (`branch/Unshare`, narrowing general access, or `auth/RecheckRole` finding a lower role):**
1. In one transaction: change the rows and bump `repositories.access_epoch`. Writes check that epoch `FOR SHARE` (0007 §6).
2. `RoomObject.evict(person)` and `SandboxObject.evict(person, access)`: sockets close with 1008. A person who lost write has each tmux session's screen captured, then killed, and the session ends `revoked`.
3. Return. Shapes refuse the person's next request, and the device deletes those rows (0007 §8).

Work already done in the box can't be recalled, and the UI never claims it was undone.

## 3. The terminal

```
 page (app origin)                          ChatApi Worker              SandboxObject (one per branch)     container
 TerminalFrame ── srcdoc, sandbox=allow-scripts
   xterm (opaque origin) ◀── MessagePort ──▶ socket ── wss /api/terminals/<id> ──▶ authorize ──▶ accept() ── exec(["tmux","attach",("-r"),"-t",id], {pty}) ──▶ tmux
   keys, size, ⌘K ──────▶                     cookie + Origin check     decides write | read     drops reader input, resizes from owner
```

- **The Worker** checks `Origin` against the site, resolves the session (`Sessions`) and decides: the owner gets write, `repo:branch-watch` gets read, anyone else gets 403 before the upgrade. It strips any incoming `x-smithers-*` header, then forwards with its decision in `x-smithers-*` headers that only it can set.
- **The object** accepts the socket with `accept()`, not hibernation, which "would discard the process handle of the tmux client" [1]. One tmux client runs per socket, so a reconnect is just a new attach.
- **The protocol** keeps the old app's (`apps/app/src/mainview/state/CloudTerminalClient.ts:128-134,430-449`).
  - **Frames:** binary frames carry bytes. JSON text frames carry control: from the owner, `resize {cols, rows}`; from the server, `ready`, `clients {owner, watchers}` and `ended {reason}`. Frames are capped at 64 KiB.
  - **Close codes:** 1000 means ended, and the page doesn't reconnect. 1008 means no access, and is final. 1006 and 1011 reconnect after 1 s, doubling to 30 s, at most 10 times.
- **The reconnecting socket** lives in `@smthrs/platform-browser`, ported from `CloudTerminalClient.ts`, so the app writes no retry code. Keystrokes typed while disconnected are dropped, never sent later: input whose delivery is unknown is not safe to repeat.
- **tmux** is configured with `window-size latest`, `history-limit 50000` and mouse scrolling, so the owner's size wins. Readers' xterm sets `disableStdin`, and the server drops their bytes anyway, because xterm itself answers some terminal queries.
- **The frame:**
  - **Isolation:** it loads no clipboard (OSC 52) addon. Links open only on a click, through the page, in a new context [7].
  - **Keys:** the page's global keys (⌘K) come back over the port; Esc stays in the shell.
  - **Mounting:** it mounts only while near the screen, as `GeneratedView` does.
- **Keep** extends 0005's `sandbox/Keep`. When its timer fires, it asks the box rather than counting writes. The machine is idle when no job runs, no session had input for 15 minutes (`#{session_activity}`), and every pane's foreground command is its shell. Otherwise it waits again. The object re-arms the container's inactivity timeout (30 minutes) in its constructor, as Cloudflare's example does [1].
- **Sleep** runs `tmux capture-pane -p -e -S -1000` per session into `last_screen` (64 KiB at most), then ends each session `slept`. A reader opening a sleeping branch's Terminal tab sees the last screens, and nothing wakes.
- **Users:** the first slice runs every shell as non-root `smithers`, with no `sudo` (M-29). Per-person Unix users and homes (mvp.md §6.8) come later.
  - **Addendum (2026-10-21, production sandboxes):** per-person users shipped (`worker/branch/Users.ts`). A deployed container's `exec` takes only a numeric `uid:gid` (a name is refused, a bare uid runs as root), so each user has a fixed uid. Under the `durable_object` scheduling policy, Cloudflare says, "`user` does not restrict a process… Every process has the same Linux capabilities as `root`" [5]. Per-person users give files and shells an owner; they don't isolate one editor of a branch from another. Viewers run nothing, and editors already type into the owner's shell (§4), so the new exposure is one editor reaching another editor's tmux on the same branch.
- **Conversation cards:** a terminal can appear in the conversation as a `views` row of template `terminal`, with props `{ terminalId }` and nothing else. Only `terminal/Open` writes one. A generic URL or a generated view can never acquire a shell.

## 4. Sharing and multiplayer

| Surface | Truth | Live transport | Reader | Writer |
|---|---|---|---|---|
| Presence: who, and where (conversation, `path:line`, terminal) | none: leases | `RoomObject` socket. Each participant lives in its socket's attachment (16 KiB at most [3]); an auto-response ping answers without waking the object | sees everyone, and appears | the same |
| Cursors | none | Yjs awareness relayed by the room. The room sets `user {id, login, color}` itself and never trusts the client's (`packages/backend/internal/live/docprotocol.go:13-60`); the last cursor rides in the attachment for late joiners | sees them, and sends their own | the same |
| Files | Postgres `ydoc_updates` (0005) | y-electric, a shape per document. The Yjs write endpoint refuses a reader's update before it enters the document | live, read-only editor | edits |
| Conversation | Postgres `messages` | an Electric shape per conversation; the outbox | reads | asks, with `repo:ask` |
| Terminal | tmux in the box; `last_screen` when it ends | a socket per viewer to `SandboxObject` | `attach -r` | their own sessions |

- **Built (co-editing slice, 2026-10-20, [coedit.md](../features/coedit.md)):** every input two people see at once is one text: a conversation's prompt, a file of the working copy, and a run's answer box (Will, 18:06 and 18:10). Each is `@smthrs/sync`'s `SharedText` (Yjs, wrapped in Effect). Updates live in Postgres `text_updates` under the text's scope, written by `POST /api/texts/<id>` (refused for viewers before they are stored) and synced by an Electric shape per text, as this table planned for files. Cursors go through one room per text, a `RoomObject` reached by `GET /api/texts/<id>/room`, not the branch's room: the home conversation and a run's answer box have no branch page, and a caret belongs to the text it is in. A change of sharing holds those rooms to the list too. The carets are drawn by `@smthrs/ui`'s `CollaboratorCarets` over the composer and the answer box, and by `@smthrs/repo-view`'s `CodeEditor`; `collabBinding` and y-codemirror were not needed.
- **The room reuses `@smthrs/sync`.** It takes `BranchProtocol`'s `Participant`, `PresenceWhere` and `Cursor` schemas, and `BranchPresence`'s rules: leases, nothing journaled, at most 256 participants (`packages/smithers/flows/sync/src/BranchPresence.ts:1-19,211`).
- **Two adapters:** `RoomObject` in `@smthrs/platform-cloudflare` for production, and `BranchPresence.makeMemory` behind a Node WebSocket server for tests.
- **Agents appear in presence (M-34).** While `chat/Answer` runs in Ben's tab, that tab also announces "Smithers for Ben".
- **Offline:** multiplayer branches are read-only offline, and a branch with one editor edits offline (0005 §2).
- **Grants combine by the best one:** a `Can view` share never lowers a Member's `Can edit` from general access.

## 5. UI

```
┌ maya/tinyhttp ▸ retry-webhooks ▾                         (B)(M)+1   [Share] ┐
│ Code   Terminal                                                              │
│ ┌ Ben ───────────────────────────────── Maya watching ───────────────────┐   │
│ │ $ pnpm test retry                                                      │   │
│ └────────────────────────────────────────────────────────────────────────┘   │
└───────────────────────────────────────────────────────────────────────────────┘
 ⌘K   the conversation of retry-webhooks
```

- **Routes** (TanStack Router):
  - `/$owner/$repo/tree/$branch` shows a tracked branch with this chrome. The repository root stays the file tree (M-45).
  - `?terminal=<terminalId>` opens a terminal.
  - The composer targets the route's branch: the root means the default branch, and `/app` means the deployment repository's default branch until the launcher lands (M-45).
- **The branch picker** lists the branches with conversations, minus those archived for you. Archive is a row action, and opening the branch restores it.
- **From `@smthrs/ui`:** `Terminal`, `ChatTranscript`, `ChatComposer`, `ChatMessage`, `MessageAvatar`, `Dialog*`, `Select*`, `CompletionList`, `RowButton`, `CodeEditorView`, `FileTree` and `StatusPill`.
- **Missing, each added to `@smthrs/ui` with its test:**
  - `TerminalFrame`: the frame host and its hash-pinned runtime with `Terminal`;
  - `AvatarStack`: presence, `+N`;
  - `ShareDialog`, laid out as Google Docs' and Figma's: people with access as `Can view` and `Can edit` rows with `Remove`; general access, `Restricted` (Google Docs' word) or `Anyone in this repository with the link`; and `Copy link`;
  - `PeoplePicker`: a GitHub-username combobox over `CompletionList`;
  - `TerminalHeader`: owner, watchers and state;
  - `collabBinding(ytext, awareness, { readOnly })`, ported from `apps/app/src/mainview/cards/liveDoc.ts:32-58`.
- **Copy:**
  - terminal: `Ended`, `No access`, `Offline`, `Open terminal`;
  - share dialog: `Can view`, `Can edit`, `Remove`, `Restricted`, `Anyone in this repository with the link`, `Copy link`, `needs access on GitHub ↗` and `needs write on GitHub ↗` (the last two wait for GitHub's permission read at share time; the sharing slice caps by role at every check instead).

  Nothing else (MINIMAL TEXT).

## 6. Failure and recovery

| Event | What happens | Shown |
|---|---|---|
| Reload or a dropped socket | reconnect; tmux redraws | `Offline` while it lasts |
| `SandboxObject` restarts | sockets drop; the reconnect re-attaches to the living tmux | nothing |
| The machine sleeps | screens captured; sessions end `slept`; close 1000 | last screen, `Ended`, `Open terminal` |
| Out of memory, or killed without SIGTERM | the next attach finds a new generation; the session ends `lost`, with no screen | `Ended`, `Open terminal` |
| The container won't start, or no capacity | `terminal/Open` fails with a typed reason | a toast with Retry (0009) |
| An opening run never finishes (2026-10-21) | the panel waits only until the row's creation plus `OPEN_DEADLINE_SECONDS`, using Effect Clock | Open terminal again, even if the person's tab still says `opening`; the next press replaces the stale row |
| A share revoked, or GitHub demotes the person | eviction (§2); shapes 403; rows dropped | `No access` |
| A question queued for an archived conversation | archive is personal, so it is sent and answered as usual | nothing |
| GitHub down during a share | the step retries under its policy, then fails closed: no grant on an unknown permission | a toast with Retry |
| The room unreachable | no avatars or cursors; editing and chat go on | the avatars hide |
| An answer arrives after switching branches | it lands in its own conversation; the open one never changes | nothing |

## 7. Observability

- **Spans:**
  - flows: `branch.track`, `conversation.archive`, `terminal.open`, `branch.share` and `branch.unshare`, beside 0005's `sandbox.*`;
  - sockets: `terminal.connect {access, outcome}` and `room.connect {outcome}`.
- **Metrics:**
  - terminals: `terminal_open_ms` (open to first byte, cold and warm), `terminal_sessions_open{access}`, `terminal_reconnects{code}`, `terminal_ended{reason}` and `terminal_bytes{direction}` (a count, never content);
  - room and sharing: `room_participants`, `room_frames{kind}`, `shares{access,outcome}` and `access_evictions{surface}`;
  - conversations: `conversation_restore_ms`.

  No metric label holds an id.
- **Logs** carry branch, conversation, terminal, generation and trace ids only. Terminal bytes, screens, logins, picker searches, prompts and file contents never appear.
- **The browser** adds each record to `BROWSER_TELEMETRY` (`src/telemetry.ts`).
- **Sentinel tests:** a sentinel typed into a terminal or asked in a question never reaches the OTLP export, the Worker's logs or the frame's console.

## 8. Tests

- **Unit, against real Postgres and Electric:**
  - `uuidv5` conversation ids, and the same id created by `branch/Track`, an ask and the migration;
  - archive is personal and idempotent;
  - an answer can never write another conversation (the composite key);
  - the turn wait and history stay in one conversation: two asks on one branch serialize, and two branches proceed in parallel;
  - asks from the old build land in the default conversation;
  - the shape proxy across owner, unshared Member, Member through general access, shared Guest, revoked, signed-out and public outsider, with a forged `where`, table or subset parameter dropped;
  - a revocation racing document writes and socket opens.
- **`@smthrs/access` properties:** watch contains write; no share, link or mode ever beats the role; the agent never shares; every `branch/*` action has a flow that enforces it.
- **`branch/Share`** runs against the scripted GitHub seam: `admin`, `write`, `read` and `none`; a missing user; a rename; GitHub down.
- **A real container** (local workerd and Docker: "Local development runs every image through workerd and Docker", `alchemy/src/Cloudflare/Containers/Container.ts:435`):
  - owner input reaches the shell; reader bytes, automatic replies and resizes never do;
  - `stty size` follows the owner;
  - a reload keeps the shell;
  - forced Sleep stores the screen, and a generation change gives `lost`;
  - malformed and oversized frames close the socket;
  - forged `x-smithers-*` headers are ignored;
  - the forge intercept refuses a push and any other host, and the clone never shows the token.
- **End to end, in real browsers, locally and live, each with its video and GIF (deployed URL, image digest, run id):**
  - B1: open a branch, ask, switch to `main` (another conversation) and back; archive and restore; a branch name with a slash.
  - B2: open the terminal in its frame; `git rev-parse --abbrev-ref HEAD` prints the branch; reload during `sleep 5; echo done`; the screen returns and `done` arrives; ⌘K escapes the frame.
  - B3: a second person watches read-only and their keystrokes never arrive.
  - B4: before any share, the second test account sees nothing live. Shared `Can view`, they see the conversation, avatars, cursors and the terminal, read-only, and appear in presence.
  - B5: share `Can edit` with a GitHub writer, who co-edits a file with live cursors and opens their own terminal.
  - B6: a share to a person without GitHub access on a private fixture is refused.
  - B7: with general access on, a Member who opens the link gets in, and a Guest with the same link doesn't.
  - B8: unshare closes their sockets and removes the rows.
  - B9: force Sleep, and the last screen shows.

  Every flow also runs keyboard-only and in both themes.
- **Benchmarks (`pnpm bench`, local and live):** keystroke echo p95; cursor relay p95 under 1 s (M-43's falsifier); `terminal_open_ms`, cold and warm.

## 9. Build plan

**S0: a disposable half-day spike, inside 0005's S0.** It runs on the real account and under `alchemy dev`, and checks each of these:
- a `durable_object` Container built from a Dockerfile;
- `exec(["tmux", …], { pty })` bridged to a WebSocket upgrade passed through the Effect-native ChatApi;
- xterm rendering in a `srcdoc` frame fed over a `MessagePort`;
- a clone through `interceptOutboundHttp`, with the token absent from every byte;
- whether an idle attached tmux client keeps the container awake;
- instance settings passed to `start()`.

Its receipts are cold start to first byte, and echo p95. If the intercept fails, the host writes the tree into the box instead, as a tar stream through `exec` stdin. If the frame can't load the runtime from `srcdoc`, it moves to the separate registrable domain 0008 reserves for previews.

**S1, the walking skeleton.** "Open the fixture's branch, ask in its conversation, open its terminal in the frame, run `git log`, reload, same shell; another branch has its own conversation and terminal." It reaches a real shell in a real Cloudflare container. It runs as two tracks that meet on the branch page, and no terminal ships before its authorization is real: sign-in, `repo:branch-write`, and owner-only input on the server.

| Track | Builds |
|---|---|
| A: conversations | migration `0013_branch_workspace` (`branches`, `conversations`, `conversation_people`, `messages`/`views.conversation_id`, the legacy binding); `branch/Track`; shapes per conversation; `POST /api/questions` with `conversationId`; the turn wait and history per conversation; the composer bound to the route's branch |
| B: terminal | `infra/sandbox/Dockerfile`; `infra/BranchSandbox.ts` (a `Cloudflare.Container` with `schedulingPolicy: "durable_object"`) and `SandboxObject`; `Egress` (forge only); `terminal/Open`, a minimal `sandbox/Wake` with no snapshots; the socket route; `TerminalFrame`; the reconnecting socket |

S1 is done when B1 and B2 pass locally and live, with their GIFs and the sentinel. It leaves out watchers, sharing, presence, co-editing, Keep and Sleep (the inactivity timeout bounds cost meanwhile), and snapshots. Creating branches arrives with 0012.

**Workstreams after S1, by file ownership.** One integrator owns the migrations, `src/router.tsx`, `src/boot.ts`, `worker/ChatApi.ts` registrations and `alchemy.run.ts`; no stream edits them.

| Stream | Owns | Needs |
|---|---|---|
| Conversations | `src/features/conversations/**`, `src/features/chat/**`, `worker/Conversations.ts`, `worker/Chat.ts`, the collection registry in `packages/effect-electric` | S1 |
| Terminal | `packages/smithers/flows/platform-cloudflare/src/SandboxObject*`, `packages/smithers/flows/sandbox` (1.0 provider and PTY seam; the 0.x `Sdk` slice deleted), `src/features/terminal/**`, `worker/Terminals.ts`, `TerminalFrame`, `TerminalHeader` | S1 |
| Access and sharing | `packages/access` (new: 0007 phase 1 plus watch and share), `worker/flows/Share*.ts`, `src/features/sharing/**`, `ShareDialog`, `PeoplePicker` | 0007 phase 2's per-repository roles |
| Presence | `packages/smithers/flows/sync/src/Branch*`, `platform-cloudflare/src/RoomObject.ts`, `src/features/presence/**`, `AvatarStack` | S1 |
| Co-editing | `packages/effect-electric/src/YDoc*`, 0005's `doc/Flush` and reconcile, `collabBinding` | Presence |
| Sleep and Keep | 0005's `sandbox/Keep` and `sandbox/Sleep`, with screen capture | Terminal |
| Acceptance | `apps/mvp/e2e/branch-workspace*`, the feature docs and GIFs | each stream as it lands |

**Infrastructure and cost.**

| Piece | Choice |
|---|---|
| Container | one `Cloudflare.Container` application, `schedulingPolicy: "durable_object"`, built from `infra/sandbox/Dockerfile` |
| Image | `debian:trixie-slim` plus git, tmux, bash and ca-certificates; non-root `smithers`; the tmux config; linux/amd64, pinned by digest; no credentials |
| Durable Objects | `SandboxObject` (one per branch, named by SHA-256 of repository and branch id, 0005) and `RoomObject` (one per branch, hibernating) |
| Worker entrypoint | `Egress`, the intercept target |
| Domains | none new: the terminal is on the app's origin, and the wildcard preview zone waits for previews (0005) |
| Account | already runs Containers on Workers Paid for Electric (`infra/ElectricGateway.ts`); the API token already needs Containers edit (`docs/infrastructure.md`) |
| Local | `alchemy dev` runs the image through Docker; about 150 MB of image |

- **The machine:** `standard-1`, with 1/2 vCPU, 4 GiB and 8 GB [5].
  - Awake at 0005's 25% CPU, it costs $0.036 for memory, $0.009 for CPU and $0.002 for disk: **$0.047 an hour**. At full CPU it costs $0.074 an hour.
  - The plan includes 25 GiB-hours of memory, 375 vCPU-minutes and 200 GB-hours of disk a month, about 6 free awake hours.
- **A branch awake 8 hours a day for 30 days** costs about **$11 a month**. Development and e2e cost under $2 a month. The fixed $5 Workers plan is already paid.
- **Durable Objects:**
  - The room bills no duration while it hibernates [3].
  - An open terminal keeps `SandboxObject` active at about $0.006 an hour (0.125 GB for 3,600 s at $12.50 per million GB-s), inside the included 400,000 GB-s.
- **Code Storage:** $0.15 a GB per clone (0006). A shallow clone of the fixture costs under a cent.
- **Not counted:** snapshots (0005's S0 measures them), image storage and networking beyond the included 1 TB.
- **These are estimates from published rates, not a bill.** Sandbox budgets stay deferred until we ship (0005 Q3).

## Questions for Will

None. Q1 is settled by decision 12. Will, 13:31:14 on 2026-10-20: "Shared branch you should be able to use common sense and how other collaboration tools to figure it out without asking me questions." The lead's rules at 13:32:34 follow Google Docs and Figma and are now decisions 8 and 9: a live branch is private until shared, so it is never public by default.

Until 13:31 on 2026-10-20:

1. **On a public repository, is the live branch visible only to Members and the people it's shared with?** The live branch is the conversation and its history, terminals, presence and live edits. Recommended: yes. It narrows 0007's "watching a branch live: anyone if public"; the code stays public. The first slice's shape authorization depends on it. If no, read shares mean little on public repositories, and every visitor can watch every terminal.

## Sources

[1] Cloudflare: [open a terminal in the browser](https://developers.cloudflare.com/sandbox/commands/open-a-terminal-in-the-browser/) (tmux per WebSocket, `accept()` not hibernation, `INACTIVITY_TIMEOUT_MS`), [1.0 terminal migration](https://developers.cloudflare.com/sandbox/sdk/migrate/terminals/), [Durable Object container API](https://developers.cloudflare.com/containers/api/durable-object-container/) (`exec` with `pty`, `resize`), [lifetime](https://developers.cloudflare.com/sandbox/concepts/lifetime/)

[2] Cloudflare: [previews on their own hostnames](https://developers.cloudflare.com/sandbox/previews/serve-previews-on-their-own-hostnames/), [ports](https://developers.cloudflare.com/sandbox/sdk/api/ports/) (no wildcard on `workers.dev`)

[3] Cloudflare Durable Objects: [WebSockets and hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/) (attachments at most 16,384 bytes; no duration billed while hibernated), [pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)

[4] GitHub: [repository permissions for a user](https://docs.github.com/en/rest/collaborators/collaborators?apiVersion=2022-11-28#get-repository-permissions-for-a-user) (`permission`: admin, write, read, none; maintain maps to write, triage to read), [rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)

[5] Cloudflare Containers: [pricing](https://developers.cloudflare.com/containers/pricing/), [limits and instance types](https://developers.cloudflare.com/containers/platform-details/limits/), [the Durable Object container API](https://developers.cloudflare.com/containers/api/durable-object-container/) (`exec` users and capabilities, `start` instance types, the inactivity timeout after a restart)

[6] Yjs: [awareness](https://docs.yjs.dev/api/about-awareness) (30 s timeout); [y-electric](https://github.com/electric-sql/electric/tree/main/packages/y-electric) 0.1.54

[7] xterm.js: [security guide](https://xtermjs.org/docs/guides/security/) ("treat terminal data always as untrusted"; open links "in a separate context"), [terminal options](https://xtermjs.org/docs/api/terminal/interfaces/iterminaloptions/) (`disableStdin`)

[8] This repository: `apps/app/src/mainview/state/CloudTerminalClient.ts`, `apps/app/src/mainview/cards/TerminalCard.tsx:15-20`, `packages/backend/internal/routes/workspace_terminal.go:159-173,682-687`, `packages/backend/internal/routes/workspace_socket_revocation.go:20-56`, `packages/smithers/flows/sync/src/{BranchPresence,BranchShare,BranchProtocol}.ts`, `packages/smithers/ui/src/adapters/terminal.tsx:88-116,239`, `packages/smithers/flows/sandbox/src/CloudflareSandbox/Sdk.ts:39-60` (0.x, no PTY), `apps/mvp/infra/ElectricGateway.ts`

## Appendix: Opus, Sol and final compared

Opus and Sol wrote their designs independently on 2026-10-20; Opus merged them. Each claim of Sol's that the final design adopts was checked against the source cited above: the 1.0 tmux pattern and `accept()`, 0005's read-only rule (its §2), 0004's same-conversation rule, the cost formula, and `GeneratedView`'s frame.

**Agreed:** both designs said the same thing, and the final design keeps it.

| Point | Final |
|---|---|
| Branch identity | an immutable UUID per branch; a re-created ref is a new branch |
| Shell | opening one is a write; never on locked `main`; readers never start a shell or wake a machine |
| PTY | tmux per socket through `exec(argv, { pty })`; binary frames for bytes, JSON for control; the server drops every reader byte |
| Keystrokes | never journaled or replayed; a session ends with its machine |
| Sharing | read or write; never above GitHub or the role; a Guest never writes; no GitHub invitation |
| Revocation | epoch bump, then close sockets; a former writer's shells killed; nothing claims undone work |
| Transport | Postgres and Electric for durable state; Yjs per file (0005); sockets for presence and bytes; server-stamped cursor identity |
| The agent | 0011's asking browser owns the run; turn wait and history per conversation |
| Machine | `standard-1`; image with git, tmux, bash and CA certificates, non-root, no credentials |

**Differed:**

| Point | Opus | Sol | Final | Why |
|---|---|---|---|---|
| Conversations per branch | one live and many archived; New starts generation g+1 for everyone | exactly one, ever; a fresh topic is a new branch | Sol's | the spec says one per branch (mvp.md §3, §6.4); nobody empties the team's home; no generation or convergence logic |
| Archive | shared, by starting a new generation | personal, restored by opening the branch | Sol's | it changes only the archiver's own list |
| Conversation id | `uuidv5(branch, generation)` | a server UUID, made by `conversation/Ensure` | Opus's, as `uuidv5(branch)` | an offline device can ask with no extra flow |
| Terminal surface | xterm on the app origin, no iframe (asked Will) | our Terminal in an iframe on a separate domain, with a single-use ticket over a `MessagePort` | an iframe with `srcdoc` on the app origin; the page holds the cookie-authenticated socket | Will said iframe; an opaque frame isolates untrusted output; `GeneratedView` proves the pattern; no new domain and no ticket |
| Sessions | one per person, owner types | one shared per branch; writers take control, one at a time | Opus's | mvp.md §6.8: each terminal runs as its person, whose logins live in their home |
| Links | none: the link is the branch's URL | a hashed token, redeemed only by eligible signed-in people | general access, closer to Opus's (decision 8, 2026-10-20; until then Sol's) | Google Docs' "anyone in this organization with the link": the URL is the link and the role is the gate, with no token to leak |
| Live workspace on public repositories | Members and shares (asked Will) | 0007's readers, so anyone | private until shared (decisions 9 and 12, 2026-10-20; until then Opus's, question 1) | the conversation and terminal are Smithers' data, and opening them to anyone is a privacy surprise |
| Branch creation | Code Storage `createBranch` | on GitHub through integrations, with panel A | 0012's (panel G) | that panel owns the git loop; S1 tracks an existing branch instead |
| The box's checkout | clone through an intercept that adds a read token | the host writes the tree; credentialed networking off | Opus's, with Sol's as the S0 fallback | a real `.git` for `git log`; the token stays outside the box; S0 proves it |
| Keeping awake | from box activity (input, foreground process, jobs) | an open terminal keeps it awake | Opus's | an idle tab must not cost $0.047 an hour |
| Presence | a hibernating `RoomObject` reusing `@smthrs/sync` | authenticated sockets, with `branch/Join` and `branch/Leave` flows | Opus's | presence is not a durable act; hibernation costs nothing when idle |
| Asking on a branch | `repo:ask` and watch | Member and branch write; `main` an exception | Opus's | one rule with no exception; the agent's acts are checked as the asker anyway |
| Migration of today's chat | an archived legacy conversation | bound to the default branch, with ids kept and a fixed v1 mapping | Sol's, legacy only when no repository exists | keeps Will's history readable; old queued asks land |
| Collections | one per opened conversation | identity includes the principal and the predicate; bounded live set; pending work keeps its collection | Sol's additions | switching must not drop a pending write |
| Answer integrity | not covered | a composite key stops cross-conversation answers | Sol's | a schema rule beats a code check |
| Unread markers | none | a per-person read position | none | nothing asks for it yet; it would add a write per ask |
| Questions | iframe; public visibility | none | none from 2026-10-20 (decision 12); until then public visibility only | Sol's iframe answers the first, and the second decides the first slice's shapes |

# Conversations

Each branch has one conversation for as long as the branch lives ([decision 0013](../decisions/0013-branch-workspace.md), decision 2). A fresh conversation is a new branch. Your conversations are listed at `/app/conversations`, on every device you sign in on. Archive hides a conversation from your own list; opening its branch brings it back. No conversation lives outside a branch. The branch's page, its conversation and its machine are the [branch workspace](branch-workspace.md).

```
/app/conversations                                  Conversations
┌───────────────────────────────────────────────────────────────┐
│ ← Back to chat   Conversations                                 │
│ [Search                              ]   ( Open | Archived )   │
│ topic-two         octo/hello                       [Archive]   │
│ feature/one       octo/hello                       [Archive]   │
│ main              octo/website                     [Archive]   │
└───────────────────────────────────────────────────────────────┘
  a row opens its branch      Archived lists the others, each with [Restore]
```

Conversations are part of the app's core, beside chat: every branch has one, and the composer, the branch page and the agent's turn all address it, so their rows and pending acts are core. GH-11 makes branch creation an overridable plugin flow; [repository code](branch-creation.md) runs through the isolated public flow host. The list's view is core for now: the [plugin host](plugins.md)'s first slice serves only `core/waits` as a query and runs events without a pending act on the device, so moving it means a `core/conversations` query and Archive as an event over the same action.

## The list

- **What it holds:** each conversation whose branch you opened (`POST /api/branches`, from the branch's page, `/new` or the agent) or that you asked in. Asking never brings back one you archived (decision 0013 §6).
- **Order:** the one you opened latest first.
- **Search:** every word you type, ignoring case, in the repository (`owner/name`) or the branch's name. The search runs on the device, so it works offline.
- **Open** and **Archived** switch between the two lists. A row's link opens its branch's page; Archive or Restore is its one button. An empty list says `No conversations` or `No archived conversations`.
- **Reach it** from Conversations in the home page's header, or ask the agent.
- **The first run** counts any row, archived or not: a person who has had one never sees `/app`'s [first run](first-run.md) again.

Copy is `Conversations`, `Search`, `Open`, `Archived`, `Archive`, `Restore` and the two empty states. Nothing else (MINIMAL TEXT).

## Archive

Archive is personal: it changes your own list, on all your devices, and nobody else's. The branch, its conversation, its runs and its machine stay. Opening the branch brings it back.

- **At once, offline too.** Archive and Restore write a pending act on the device (`conversation-pending`, persisted), so the list changes before ChatApi answers and after a reload. The act then runs as `conversation/archive { conversationId, archived, at }`, door `button`, one run per press, named for the act (`conversation-archive:<id>:<at>`). When the device opens again, each act it still holds joins its run, or starts it if the tab closed first.
- **The latest act wins.** `at` is when you pressed, in milliseconds, and always later than anything the device did or saw for that conversation, so a second press in the same millisecond, or a clock behind the server's, still wins. ChatApi applies an act only when it is later than the row's `changed_at`, so acts from two devices, or one sent twice, land in the right order.
- **Opening the branch is an act** at the server's time. Each page open names itself (`openId` on `branch/track`), so the same open tried again after a lost answer never undoes an archive made since.
- **The agent** archives the conversation it is answering in: its call names no conversation, and ChatApi takes the one its answer is in, and only its own answer's.
- **The device forgets an act** once the synced row's `changed_at` reaches its `at`.
- **An act that can't land** (ChatApi refused it, or it went unsent for a day) leaves the device, and the row shows as it is: a log line `conversations.dropped` and a count say so.

## New

`/new owner/repo [branch]` in the composer starts a new conversation: by default, a Smithers-only branch at the default branch's head, opened in your tab. It lives in Code Storage's ephemeral namespace. GitHub writes require explicit publication or a [repository-selected creation flow](branch-creation.md) ([GH-11](../rulings.md#7-github), [0095](../decisions/0095-new-conversation-ephemeral-refs.md)). The agent can do the same (`conversation/new`), and so can the [New branch](branch-workspace.md#new-branch) button on a repository's home.

The repository is required in the slash command. `/new` alone stays in the composer with `/new needs repo`; it never uses a previously viewed repository or the deployment default. The agent flow retains its optional repository argument.

- **Its name** is the one you type, or `conversation-` and six hex digits drawn from the run.
- **Always fresh.** The step names its run's request (`request`, a version 5 UUID of the run). ChatApi answers a branch the app tracks only to the request that made it, so a step tried again gets its own branch, and any other name someone already has, tracked or not, is refused `exists`: `/new` never opens an existing conversation as a fresh one.
- **Offline**, the step tries again for a day: the branch is made, and your tab opens it, once the device is back.
- **A name the forge already has** is refused `exists` and never tried again; the tab stays where it is.
- **The repository must already have a Code Storage mirror with a default branch.**
  `/new` creates an ephemeral ref there through `POST /api/branches`;
  being a Member of the deployment repository permits creation but does not
  create its mirror. A missing mirror or default branch is `not_found`.
- **A failed command** restores its line in the composer with the existing
  `Couldn't make a branch` status. The person can submit it again. A late
  failure leaves newer typing, a dismissed menu or another conversation alone.
- `/new` is a Member's command, as making a branch is.

The repository can replace the default with [its own creation flow](branch-creation.md),
including an explicit GitHub implementation. The selected source and its action
receipts are durable, so reloads keep the original implementation.

## Flows

```
conversation/archive { conversationId?, archived, at? }    the list's Archive and Restore; the agent, naming none
  conversation/archive/request ─ POST /api/conversations/archive

conversation/new { repo?, branch? }                         /new; the agent
  conversation/new/request ─ branch/creation/start ─ pinned repository Flow.make
    branches/ephemeral ─ POST /api/branches { create: true, owner?, name?, ref, request }
  app/navigate/go ─ the tab that asked opens /<owner>/<repo>/tree/<branch>
```

Both are client flows (`src/features/conversations/flows.ts`), registered in `src/flows/registry.ts`. Each step tries again while ChatApi can't be reached (500 ms or 1 s, doubling to 30 s, for a day); a refusal is final.

## The routes

| Route | Answer |
|---|---|
| `POST /api/conversations/archive { conversationId \| answerId, archived, at }` | `200 { archived, txid }` (`txid` null when the act was older than the row's); `400` not the body, both or neither of `conversationId` and `answerId`, or `at` more than a day ahead; `401` signed out; `403` a branch you may not open, another run's answer, or an answer to someone else's question; `404` no such conversation or answer; `413` over 256 bytes; `405` another method; `503` Postgres didn't answer |
| `GET /api/conversations/<conversationId>/access` | `200 { allowed: true }` when you may read the conversation now, by the same check that opens its branch. `401 { code: "sign_in" }` signed out. `403 { code: "forbidden" }` a branch you may not open. `404 { code: "not_found" }` no such conversation. `405` another method. `503 { code: "unavailable" }` the check could not be made. Never cached. It reads only: nothing is recorded of the asking |
| `GET /api/shapes/my-conversations` | Electric's `conversation_people`, `where person_id = <you>`; signed out, no rows. The browser's `where`, `table` and `columns` are dropped |
| `POST /api/branches` | as [tracking a branch](branch-workspace.md#tracking-a-branch); every branch it answers is opened by you (`openId`, the page open), `create: true` may name no repository, which means the deployment's own, and `request` (with `create` only) answers a tracked branch only to the request that made it, else `409 exists` |

`worker/branch/ConversationApi.vibe` serves the first three routes. `worker/branch/ConversationPeople.vibe` holds the statements.

## Postgres

Migration `0047_conversation_people`:

```sql
conversation_people (conversation_id uuid REFERENCES conversations, person_id text,
                     owner text, repo text, branch text,          -- the branch as you last opened it
                     opened_at timestamptz, archived_at timestamptz, changed_at timestamptz,
                     open_id uuid,                                -- the page open that last wrote it
                     PRIMARY KEY (conversation_id, person_id))   -- REPLICA IDENTITY FULL
branches          + create_request uuid                          -- the `/new` request that made it
```

The names are a snapshot for the list and its search, refreshed whenever you open the branch.

## The browser

`src/features/conversations/`, composed into the branch layer as `branch.conversations` (`src/features/branch/branch.ts`):

| Piece | What it is |
|---|---|
| `my-conversations` | your `conversation_people` rows: an Electric collection, eager, kept on the device |
| `conversation-pending` | your acts on their way, kept on the device |
| `conversation-search` | this tab's search text and whether it shows the archived list |
| `conversation-list` | the rows the list shows, worked out by `listOf` (`list.ts`) whenever a row, an act or the search changes |
| `archive`, `search`, `showArchived` | the actions (`actions.ts`) |

`/new`'s repository comes from the branch store's current row (`pin.ts`); the branch store sits below the composer's for that (`src/boot.ts`).

## What may show

A conversation's rows show on a tab only through `ConversationOwners` (`src/features/conversations/owners.ts`): its messages, views, queued questions, runs, waits, shared prompt and open files. Four things decide it.

```
receipt names it ──▶ repository may show ──▶ no refusal held ──▶ open on this load ──▶ shows
(synced row, verified   (data gate,             (memory, device       (Web Storage `open` key,
 branch route, or home)  decision 0110)          store, Web Storage)   or ChatApi's answer for it)
```

- **A refusal hides it.** ChatApi's `401`, `403` or `404` to a read of the conversation, and `branch/track`'s `sign_in` (ChatApi's `401`), `forbidden` or `not_found` for its branch, record a refusal in the call. `branch/track`'s answer is recorded as it arrives, in the tab's scope, whether or not the person is still on the branch's page. The branch itself is refused (`refuseBranch`): every conversation the device names for it, by a saved route or by the person's synced row, is hidden at once. One the device comes to name for it later, as rows still restoring on a cold load are read, is hidden as it is named. Each denied branch uses two Web Storage keys (`route` holding the latest refusal token and `route-cleared` holding the lifted token). A clear never deletes the `route` key, so a branch stays refused whenever the two tokens differ until an authorized answer clears the matching token.
- **Two records, and a third that cannot fail.** The refusal is a row of the device's `conversation-refusals` store and a key of its own in Web Storage (`smithers-conversation-refusals:refused:<person>:<conversation>:<id>`, `src/features/conversations/marks.ts`). No tab reads a shared value and writes it back, so two tabs cannot lose each other's refusal. A full disk can refuse the row and full Web Storage the key, so the refusal first removes the conversation's `open` key. Full storage takes a removal, and the `open` key's value holds as much room as a refusal's key takes, so storage that was full takes the refusal next.
- **No key means not open.** Nothing in Web Storage says a conversation is new to the device. A conversation shows only with its `open` key, or once ChatApi answers for it on that load. A load offline therefore shows only what ChatApi answered for: a conversation whose keys were never written, on storage that was full, stays hidden however much room is made later.
- **A row of your list opens nothing.** The list is history, and its row stays after a share is taken away. A conversation the list names that no `open` key vouches for is asked of ChatApi (`GET /api/conversations/<conversationId>/access`, `src/features/conversations/access.ts`), one question at a time for each. Its yes is taken as any read's answer is. Its `401`, `403` or `404` records a refusal. No answer, offline or failing, leaves the conversation hidden, and the device asks again when ChatApi next answers the list.
- **Each refused read counts.** A read refused again while the conversation is hidden moves the refusal the tab holds past every read that had begun, and says it again in Web Storage: the same key, a new sixteen-digit token as wide as the last, which full storage takes. With no key in Web Storage to say again, the tab records a new refusal of its own, which the device's store carries to the other tabs, and retires the one it replaces.
- **Only a read answered whole shows it again.** A read takes a fence before its request is sent. The answer is weighed against that fence in the device's turn. Taken, it removes the refusals of the conversation from both records, records the cleared branch token if a branch denial stood, and shows the conversation. Not taken, it removes nothing and writes nothing. The shard's reader, `branch/track` and the access route each tell the gate of their answers. The home conversation's Electric shape does only when ChatApi's answer carries `x-smithers-conversation-access: granted` together with `x-smithers-conversation-id` naming the authorized conversation, matching both the dispatched home and the current home. The empty shape a Guest without a share gets says nothing. Its fence is captured at HTTP dispatch. A branch's Electric shape is never heard.
- **One turn at a time, and a generation.** Every tab records a refusal and weighs an answer inside one Web Lock for the person (`smithers:refusal-lock:<person>`), exclusive across the origin's tabs and processes. So no refusal is said again between an answer's comparison and its removals. The device also keeps a generation in Web Storage (`smithers-conversation-refusals:epoch:<person>`), sixteen hex digits written while there is room. Every refusal writes over it in the call, which takes no room. Where storage refuses even that, the key is removed, which storage always takes. An answer is taken only when the generation, the tab's own knowledge of refusals and the refusal keys of the conversation are what its fence saw. A refusal no store could record therefore still stops every older answer.
- **No generation, nothing shown on a durable device.** On a durable device, a read that began with no generation (`epoch` absent because Web Storage was full) fails closed and is rejected inside the Web Lock, showing nothing and writing no `open` key. Once storage frees room, a fresh read establishes the generation and succeeds. Durable `open` keys also require native Web Locks.
- **A page hidden in place asks again.** A branch page whose conversation is refused, as another tab's refused read leaves it, runs `branch/track` afresh when the same route opens or the person presses Retry. Retry also asks again on a page that stands refused, as after an earlier Retry ChatApi answered no to. The page shows once ChatApi answers that they may read, with no leaving first.
- **Fail closed.** Nothing shows before the device's refusals and rows are read, and nothing on a load whose refusals cannot be read. A browser that blocks Web Storage shows a conversation only once ChatApi answers for it on that load.
- **What Web Storage does not promise.** HTML gives no lock over `localStorage` reads across processes. The Web Lock orders the tabs' turns, and the browser carries a write to the other processes on its own. A host without Web Locks takes turns within its own process only.
- **Sign-out** removes every `smithers-conversation-refusals:` key with the device's stores (`src/wipe.ts`).

## Observability

- **Browser:** the steps log `conversation.archive` and `conversation.new` and count `smithers_web_conversation_archives {archived, outcome}` and `smithers_web_conversation_news {outcome}`; a dropped act logs `conversations.dropped` and counts `smithers_web_conversation_archives_dropped {reason}`. Spans `conversation.archive`, `conversation.archive.post`, `conversation.new`, `conversations.archive`.
- **ChatApi:** `POST /api/conversations/<id>/archive` is one span and one log line `conversation.archive` (conversation id, outcome, status, duration) and a count `smithers_conversation_archives {outcome}`; the shape counts `smithers_conversation_shape_requests`. An ask whose list row couldn't be written logs `conversation.asked.failed` and stands.
- **Access checks:** the browser's question is one span `conversation.access.get`, and no answer logs `conversation.access.unanswered {reason}`. ChatApi answers with one span and one log line `conversation.access` (conversation id, outcome, status, duration) and a count `smithers_conversation_access_checks {outcome}`.
- **List loading:** `conversations.shape.sync` logs and spans the first request, answer, changed failure status and recovery; `smithers_conversation_shape_transitions {phase}` counts them. A successful response precedes collection installation and does not prove a row rendered. `conversations.list` logs and spans changed counts (`syncedRows`, `pendingRows`, `listedRows`) with `archived` and `loaded`; `smithers_conversation_list_updates {archived, loaded}` counts these transitions. Compare these with the page snapshot to distinguish a stalled shape, missing personal rows and filtering. Identical counts and successful live polls do not produce repeated records.
- Nothing records a branch's name, a repository, a search or what was asked.

## Tests

- `src/features/conversations/list.test.ts`: the list, archive state, landed acts, search, links and new names.
- `src/features/conversations/owners.test.ts`, `src/features/conversations/marks.test.ts`: what may show: refusals kept across loads and tabs, a refusal no store took, storage full from the first answer, a read refused again, another tab's refusal read before its `storage` event, and recovery by a read answered whole.
- `src/features/conversations/access.test.ts`, `worker/branch/ConversationApi.test.ts`: the access question and its route: each answer, a share taken away, and that the route writes nothing.
- `src/features/conversations/conversations.test.ts`: two devices of one person against ChatApi's real handler: listing, Archive on one device reaching the other, opening and Restore bringing it back, search, a refused act, and `/new` from a branch and from home, and `exists`.
- `worker/branch/ConversationPeople.test.ts`, `worker/branch/Branches.test.ts`, `worker/Chat.test.ts`: the statements, the routes, the shape's scope, opening, asking and the home repository.
- `e2e/conversations.spec.ts`: New, Archive and the list in real browsers, on two devices, each with its GIF.

Conversation rows wrap branch and repository names so both remain readable beside
Archive on a narrow screen.

A filtered list with no results says “No matches.” Archive and Restore controls include the repository in their accessible names, distinguishing branches named alike.

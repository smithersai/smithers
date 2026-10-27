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
| `GET /api/shapes/my-conversations` | Electric's `conversation_people`, `where person_id = <you>`; signed out, no rows. The browser's `where`, `table` and `columns` are dropped |
| `POST /api/branches` | as [tracking a branch](branch-workspace.md#tracking-a-branch); every branch it answers is opened by you (`openId`, the page open), `create: true` may name no repository, which means the deployment's own, and `request` (with `create` only) answers a tracked branch only to the request that made it, else `409 exists` |

`worker/branch/ConversationApi.ts` serves the first two; `worker/branch/ConversationPeople.ts` holds the statements.

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

## Observability

- **Browser:** the steps log `conversation.archive` and `conversation.new` and count `smithers_web_conversation_archives {archived, outcome}` and `smithers_web_conversation_news {outcome}`; a dropped act logs `conversations.dropped` and counts `smithers_web_conversation_archives_dropped {reason}`. Spans `conversation.archive`, `conversation.archive.post`, `conversation.new`, `conversations.archive`.
- **ChatApi:** `POST /api/conversations/<id>/archive` is one span and one log line `conversation.archive` (conversation id, outcome, status, duration) and a count `smithers_conversation_archives {outcome}`; the shape counts `smithers_conversation_shape_requests`. An ask whose list row couldn't be written logs `conversation.asked.failed` and stands.
- **List loading:** `conversations.shape.sync` logs and spans the first request, answer, changed failure status and recovery; `smithers_conversation_shape_transitions {phase}` counts them. A successful response precedes collection installation and does not prove a row rendered. `conversations.list` logs and spans changed counts (`syncedRows`, `pendingRows`, `listedRows`) with `archived` and `loaded`; `smithers_conversation_list_updates {archived, loaded}` counts these transitions. Compare these with the page snapshot to distinguish a stalled shape, missing personal rows and filtering. Identical counts and successful live polls do not produce repeated records.
- Nothing records a branch's name, a repository, a search or what was asked.

## Tests

- `src/features/conversations/list.test.ts`: the list, archive state, landed acts, search, links and new names.
- `src/features/conversations/conversations.test.ts`: two devices of one person against ChatApi's real handler: listing, Archive on one device reaching the other, opening and Restore bringing it back, search, a refused act, and `/new` from a branch and from home, and `exists`.
- `worker/branch/ConversationPeople.test.ts`, `worker/branch/Branches.test.ts`, `worker/Chat.test.ts`: the statements, the routes, the shape's scope, opening, asking and the home repository.
- `e2e/conversations.spec.ts`: New, Archive and the list in real browsers, on two devices, each with its GIF.

Conversation rows wrap branch and repository names so both remain readable beside
Archive on a narrow screen.

A filtered list with no results says “No matches.”

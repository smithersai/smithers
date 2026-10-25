# Co-editing

Every input two people see at once is one text they edit together, as in Google Docs and Figma: the prompt of a branch its owner shared, a file of a branch's working copy, and the answer box of a run that needs its person. Everyone who may edit types at once, every letter is kept, and each sees the others' carets and selections in their colors, flagged with their names. Someone who may only view sees the text and the carets and can't change it. Decision [0013](../decisions/0013-branch-workspace.md) §4 and §10; Will, 2026-10-20: "we should also be able to see both their cursors editing the same prompt and them editing the same file", and "When one of the users is typing into the input box it should be crdt with the other and you should see the cursor".

```
 tab                                          ChatApi                              Postgres
 SharedText replica ── edit ─▶ outbox ─▶ POST /api/texts/<id> ─ may edit? ─▶ text_updates
        ▲                                                                          │
        └──────── Electric ◀── GET /api/shapes/texts?text=<id>&<scope> ─ may see? ─┘
 caret ─▶ text's room (RoomObject, `PresenceRoom`) ◀─ GET /api/texts/<id>/room?<scope> ─ may see?
```

## The text

A text is `@smthrs/sync`'s `SharedText`: one Yjs document holding one text, wrapped in Effect ([library catalog](../../../../docs/libraries.md), "Edit one text together"). An edit on one replica is an update; every other replica merges it, in any order, and an update applied twice changes nothing. Yjs was chosen because no catalog entry edited text together, 0005 and 0013 had already chosen it, it was already a workspace dependency (`yjs` 13.6.32), and its relative positions carry a caret through everyone's edits. The app never imports Yjs: `SharedText` is the only module that does.

- **Identity.** A text's id is the version 5 UUID of what it is (`textName` in `src/features/coedit/contract.ts`), so every device names it alike: `conversation/<id>/prompt`, `conversation/<id>/file/<path>`, `run/<id>/answer/<version>`.
- **Scope**, which decides who may read and write it:

  | Text | Scope | Sees it | Edits it |
  |---|---|---|---|
  | A shared branch's prompt ([The prompt](#the-prompt)) | `branch:<id>` of its branch | whoever may view the branch | whoever may edit it |
  | A file of a branch's working copy | `branch:<id>` | whoever may view the branch | whoever may edit it |
  | A run's answer box, per question | `run:<id>` | the person who started the run | the same |

- **A file's first content** is one seed: the working copy's text when someone who may edit first opens it, read through `sandbox/read` and written as `SharedText`'s seed replica. ChatApi keeps one seed per text (`text_updates_seed`), and a device applies a seed only as ChatApi stored it, so two people opening a file at once start from the same text. A file the sandbox reads only in part (over 1 MiB) isn't opened: `Too large`.

## The prompt

A composer's draft is the person's own, as Slack, Linear and GitHub keep a draft per person. It becomes one text its people type together only on a branch its owner shared, by name or by link (decision [0013](../decisions/0013-branch-workspace.md) decisions 8 and 9; Will asked for two people typing one prompt on a shared branch).

| Conversation | The composer's draft |
|---|---|
| A branch its owner shared | the branch's prompt: `Owner` and `Can edit` type it together, `Can view` sees it read-only |
| The home conversation, a team branch (`main`, branches tracked before sharing), a person's own branch nobody shares | the person's own, kept on the device per conversation (`chat-drafts`) and never sent: a reload, or a tab that opens the conversation later, finds it; another open tab never shows it as it is typed |

- **Which.** `POST /api/branches` answers `shared`: the branch has an owner and at least one share (`branchAccess` in `worker/branch/Access.ts`). The branch's page hands it to chat (`show`), whose `place` row holds it; `followPrompt` opens the prompt only then, and the composer's edits go to it (`SharedPrompt`) or to the device (`keepDraft`).
- **Live for the owner.** The owner's tab follows the branch's permission list (`followShares` in `src/features/branch/actions.ts`, its owner's only): their first share makes the draft the prompt at once, the draft the device kept typed into it; taking the last share away keeps the composer's text as theirs, on the device, and nothing more is sent.

## The routes

`worker/branch/Texts.ts`, through the branch workspace's routes (`worker/branch/BranchApi.ts`). Every request decides access again, from the session and the scope (`scopeAccess`).

| Route | Answers |
|---|---|
| `POST /api/texts/<text id>` `{ scope, id, update, seed? }` | `200 { txid }`; `200 { txid: null }` when the update's id, or the text's seed, is there already; `400 invalid` for a bad body, bytes that aren't an update, text written as the seed's replica outside a seed or a seed with anyone else's; `401`; `403 view_only` for someone who may only view, `403 forbidden` for anyone else; `404` for no such conversation or run; `413` over 2 MiB; `503` |
| `GET /api/shapes/texts?text=<id>&conversation=<id or home>` or `&run=<id>` | Electric's `text_updates` for that scope and text, `id` and `data` only; nobody's rows for anyone who may not see it, and `503` with `Retry-After: 5` when sessions can't be read |
| `GET /api/texts/<text id>/room?<scope>` with `Upgrade: websocket` | the text's room, one `RoomObject` per text, joined with what the person may do; this app's own pages only |

A change of sharing holds the rooms of the branch's texts to the new list, as it does the branch's own room (`enforceRooms`, from `worker/branch/Shares.ts`): someone who lost the branch leaves for good. Their shapes empty on their next request, and their writes are refused.

## The browser

`src/features/coedit/`:

- **`store.ts`** keeps each open text: its replica, its synced updates (an Electric collection kept on the device), and, while it is shown, its room. Updates reach the replica from the shape and from the outbox's rows (`text-sending`), so text typed offline survives a reload. `coedit-texts` is what a frontend reads: the text, this person's selection as it now stands, everyone else's carets, and for a file whether this tab's Save is running or failed, and whether the text is saved.
- **`writes.ts`** sends updates through the device's one outbox (`text-update`): a refusal drops the update for good. In a tab that doesn't lead the outbox, an edit waits and goes with the next one once the tab leads.
- **`actions.ts`**: `type` merges an input's change, made on the text the input showed (`base`), past updates that arrived meanwhile, so it never undoes them; `select` sends the caret to the room; `showFile` opens a file and seeds it; `save` writes it through `sandbox/write`, the sandbox tools' one write path, then sets the text's `saved` mark ([Saved](#saved)); `followPrompt` keeps the prompt of the shown conversation open while it is shared ([The prompt](#the-prompt)), and `followAnswers` the open questions' answer boxes.
- **`prompt.ts`** is chat's `SharedPrompt`: on a shared branch, the composer's draft is the branch's prompt. Chat's draft actions hand each change to it, and everyone else's typing comes back into the draft.

## Saved

A Save marks what it wrote in the text itself: `SharedText.mark("saved", "<length>:<SHA-256>")`, sent through the outbox like any edit. Every replica gets the mark with the text, so every editor, on every device and after a reload, says `Saved` while its text is what was written, and `Save` once anyone edits it. A Save that missed an edit arriving while it ran marks what it wrote, which isn't the text: nobody's screen says `Saved`. `saving` and a failure are the saving tab's own.

What isn't covered yet:

- **Overlapping Saves.** The last mark wins, by when each saving tab heard its write was done, not by when the write reached the disk. Two Saves of different text running at once can leave the mark of the write that landed first, so the screens say `Saved` for text the working copy doesn't hold, until the next edit. Ordering the mark by the machine's write order closes it.
- **A reload during a Save.** The write still finishes, durably, but the mark comes from the tab that asked, so nobody's screen says `Saved` until someone saves again.

## The page

- **The composer** (`ChatComposer`'s `collaborators`, `selection`, `onSelectionChange`) draws others' carets over its input on a shared branch. Sending is one person's act: the merged text is asked as them, and the prompt clears for everyone. Someone who may only view the branch (`Can view`) sees the prompt read-only, with the carets and no Send; `Owner` and `Can edit` type and send.
- **The answer box** (`NeedsYouCard`, in the conversation and in the notifications panel) does the same for the person's devices.
- **A file.** In a branch's Code view, someone who may edit opens a file in the live editor (`?edit=<path>`): `@smthrs/repo-view`'s `CodeEditor` (CodeMirror) with everyone's carets, or `LiveMarkdownEditor` for Markdown. A Markdown file's own page (`/blob/<branch>/<path>`) is that same text in place, a WYSIWYG document with Save in the file's toolbar, for someone who may write the branch; anyone else reads it ([repositories](repo.md#the-browser)). `Save` writes it to the working copy: it reads `Saving…` while it runs, `Saved` on every editor's screen once written, and `Retry save` after a failure. Presence says where each person is (`edit`), and following them opens the same file.

## Observability

Content-free: ids, sizes, scopes' kinds, statuses and outcomes; never a text, an update, a path or a cursor.

| Where | Records |
|---|---|
| ChatApi | `text.write` (log, span, `smithers_text_writes{outcome}`), `text.room` (log, span, `smithers_text_room_joins{outcome}`), `text.shape` (`smithers_text_shape_requests`) |
| Browser (`COEDIT_TELEMETRY`) | `coedit.open`, `coedit.send`, `coedit.save` (with the `executionId` that names its sandbox call), `coedit.seed`, `coedit.apply` (an update that isn't one, skipped); `smithers_web_coedit_{opens,sends,saves}` |
| The branch's machine | `sandbox.wake` (`startMs`, `checkoutMs`, `restoreMs`, `placeholdersMs`, `generation`), `cloudflare.sandbox.wake` (`outcome`, `durationMs`): a slow Save says which step of the wake was slow |
| Rooms | `@smthrs/sync`'s `smithers_presence_{joins,frames,evictions,open}` |

## Tests

| Kind | Where |
|---|---|
| Unit and property | `@smthrs/sync`'s `test/SharedText.test.ts`: replicas converge with updates shuffled and repeated, every concurrent insertion survives once, an edit made on an older text never undoes what arrived meanwhile, marks converge and never change the text, seeds, anchors, and validation |
| Routes | `worker/branch/Texts.test.ts`: writes, a viewer's update refused before it is stored, the home conversation, a run's answer box, one seed, shapes and rooms by scope, and a change of sharing |
| Browser | `src/features/coedit/coedit.test.ts`: two people's tabs over ChatApi, Electric and real rooms on loopback (`src/test/rooms.ts`); which prompts are shared: the home conversation and a person's own branch keep the draft on the device, and an owner's first and last share switch it live; one person's Save says Saved on everyone's tab, an edit by anyone clears it, and a Save that missed a late edit says Saved nowhere |
| UI | `@smthrs/ui`'s `tests/collaborators.test.tsx`; `@smthrs/repo-view`'s `test/code-editor.test.tsx` |
| End to end | `e2e/coedit.spec.ts`: one person's two devices type a new file at once and each saves it, both saying Saved, locally and on a deployment; two people type in one prompt and one file and save it, both saying Saved (local: a deployment has one test account); two devices type one answer box |

## What's not built

- Carets in the Markdown editor: Markdown files merge everyone's typing, but only the code editor draws carets, because the editor shows rendered Markdown, not its source positions.
- Compaction: a text is every update ever written to it; a long-lived file reloads them all.

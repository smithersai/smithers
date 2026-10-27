# Slash commands

Typing `/` in the composer lists the commands this person may run. Typing filters the list, the keyboard completes a row, and running a command dispatches its registered flow through `FlowDispatch`, door `slash`: `/theme dark` runs the same `app/theme/set` the theme button and the agent run ([flows](flows.md)). Decisions: [0003](../decisions/0003-flows-and-the-agent.md), [0007](../decisions/0007-roles-and-tags.md), [0011](../decisions/0011-the-agent-runs-in-the-browser.md).

```
composer: /th▏                         the commands this person may run (catalog.ts)
          ┌──────────────────────────────────────────────────┐
          │ ▸ /theme  Set this device's theme to light or dark. │  listbox "Commands"
          └──────────────────────────────────────────────────┘
Tab ─▶ /theme ▏                        the list becomes the argument's values
          ┌──────────┐
          │ ▸ light  │                  listbox "Mode", from the payload schema
          │   dark   │
          └──────────┘
↓, Enter ─▶ /theme dark ─▶ FlowDispatch.dispatch("app/theme/set", { mode: "dark" }, { door: "slash" })
```

## Commands

A registry entry with a `slash` door is a command ([the registry](flows.md#the-registry)):

```ts
"app/theme/set": { flow: SetTheme, slash: { command: "theme", minimum: "anyone" } },
```

- **Its row** is `/<command>` and the first sentence of the flow's description. The rest of the description is for the agent.
- **The agent knows them.** Its system teaching lists every command from the same registry, each with the flow it runs, and marks the ones only the person runs (`SLASH_COMMANDS`, `src/features/agent/instructions.ts`; [the agent](agent.md#what-the-agent-is-told)). Asked how to use one for a result ("How do I use /theme to turn on dark mode?"), the agent does it and names the command; asked only what one does, it explains. Before 2026-10-20 it knew none, and told a person there was no `/theme` ([agent evals](agent-evals.md)).
- **Its arguments** are the flow's payload, through `@smthrs/ui`'s `formFieldsFor`: a field whose schema is a union of literals lists its values; any other field is free text. Arguments fill the fields in schema order, the last text field takes the rest of the line, and `--name` sets a boolean field.
- **Who sees it:** a person who is at least `minimum`: `anyone` (signed out included), then `guest`, `member`, `maintainer` and `admin` ([decision 0007](../decisions/0007-roles-and-tags.md#1-roles)). Signed in with no role counts as a Guest. The list only hints: a flow that writes shared state is checked again on the server.

| Command | Flow | Minimum | Arguments |
|---|---|---|---|
| `/theme` | `app/theme/set` | anyone | `mode`: `light` or `dark` |
| `/issue` | `issue/create` | guest | `repo` (`owner/name`), then the title as the rest of the line; its door names `fields: ["repo", "title"]`, so the body keeps its default ([issues](issues.md)) |
| `/comment` | `issue/comment` | guest | `repo`, `number`, then the comment as the rest of the line |
| `/triage` | `issue/triage` | member | `repo`, `number`, `decision` (`accept` or `reject`), then an optional reason as the rest of the line, posted as the person's comment ([triage](issues.md#triage)) |
| `/triage.run` | `triage/run` | member | `repo`, `number`: Run triage again |
| `/triage.enable` | `triage/enable` | maintainer | `repo`, then an optional daily budget in tokens |
| `/triage.pause` | `triage/pause` | maintainer | `repo` |
| `/todo.new` | `todo/draft` | member | `repo`, then the prompt as the rest of the line: a private draft on the stack page, to edit and commit ([TODOs](todos.md)) |
| `/todo.issue` | `todo/issue` | member | `repo`, `issue`: a private draft from issue `#<issue>`, linked to it ([TODOs](todos.md#from-an-issue)) |
| `/todo.drop` | `todo/drop` | member | `repo`, `number`: drops TODO `T<number>` |
| `/branch.new` | `branch/create` | member | `repo`, `branch`: a new branch at the default branch's head, tracked as the person's ([new branch](branch-workspace.md#new-branch)) |
| `/new` | `conversation/new` | member | required `repo`, then optional `branch`: a fresh conversation in the named repository, opened in the tab ([conversations](conversations.md#new)) |
| `/repo` | `ui/repo` | member | `repo` (`owner/name`): the repository's own view in the conversation the tab shows ([views](views.md#a-repository-and-its-issues)) |
| `/issues` | `ui/issues` | member | `repo`: the repository's issues view in the conversation the tab shows |
| `/copy` | `chat/copy` | anyone | none: copies Smithers' latest finished answer; `messageId` is hidden ([chat](chat.md#message-controls)) |
| `/edit` | `chat/edit` | member | none: takes the latest question Smithers doesn't have yet back to the composer; `questionId` is hidden |

Other features add their own commands the same way ([navigation](flows.md#navigation) adds `/navigate`; [web pages](web-pages.md) add `/web <url> [embed|tab]`, for a Member and up; [repositories](repo.md#cloning) add `/clone <owner/name>`, for a Member and up). `/web` is the one command that does something in the keypress itself: its `tab` opens straight from Enter when the browser allows it, and a page the app won't open stays in the composer saying why, before anything runs.

Plugins add commands in their manifests, with a payload the manifest fixes, so they take no arguments ([plugins](plugins.md#views-slots-and-commands)): `/queue` opens the queue, for a Member and up; `/bug` opens the bug report form and `/bugs` the bug inbox, for anyone signed in ([bug reports](bugs.md#doors)).

## The keys

| Key | List open | List closed |
|---|---|---|
| typing | lists what the draft completes to, highlighting the first row | the same; `/` opens the list |
| ArrowDown, ArrowUp | move the highlight, wrapping | the textarea's own |
| Tab | completes the highlighted row into the draft | moves focus |
| Enter | a command with required arguments completes; a row whose draft names every required argument runs | sends: runs the command line, or asks Smithers |
| Escape | closes the list; the draft stays, and typing lists again | hides the composer (`chatShortcuts`) |
| a click | as Enter on that row; focus stays in the composer | |

The composer stays a textbox. While the list shows, it points at it (`aria-controls`) and at the highlighted row (`aria-activedescendant`), and declares `aria-autocomplete="list"` and `aria-haspopup="listbox"`. The list is a `listbox` named `Commands`, or the argument's label, with one `option` per row.

## Sending a line

`submit(text)`, from Enter or Send:

| The line | What happens |
|---|---|
| a command this person may run, with every required argument | its flow runs in the background, door `slash`; the composer clears |
| `/` and a name this person may not run, or no command has | stays in the composer, with `/<name> isn't a command`; the agent never sees it |
| a command missing a required argument | stays, with `/<command> needs <argument>`, and the list shows the command again |
| an argument that isn't one of its values | stays, with `/<command> takes light or dark` |
| anything else, `/etc/hosts` included | asks Smithers, as before |

## Where it lives

| File | What it holds |
|---|---|
| `packages/smithers/ui/src/slash-commands.ts` | `slashMenu` (what a draft lists) and `slashSubmit` (what a line runs), pure, over `parseSubmit` and the positional read |
| `packages/smithers/ui/src/chat/ChatComposer.tsx`, `chat/CompletionList.tsx` | the composer's `completions` prop: the listbox, its keys and its ARIA, controlled by the host |
| `src/flows/registry.ts` | each command's door: `slash: { command, minimum }` |
| `src/features/commands/catalog.ts` | the commands from the registry, and the ones a viewer may run |
| `src/features/commands/store.ts`, `schema.ts`, `queries.ts` | the menu's one local row and its live query, joined to the composer's draft, so a menu for an older draft never shows |
| `src/features/commands/actions.ts` | `type`, `highlight`, `choose`, `dismiss` and `submit` |
| `src/features/commands/commands.ts` | the layer frontends get: the menu's query and the actions as plain functions |
| `src/features/chat/components/Composer.tsx` | renders the menu through `ChatComposer`'s `completions` |

Signed out, and for a Guest, the sign-in prompt or "Members can ask Smithers." stands where the composer is ([sign-in](sign-in.md#the-browser)), so the list never shows to them in the app today. The catalog already filters by role, and `src/features/commands/commands.test.ts` proves it for a Guest and a signed-out person.

## Observability

`slash.run` and `slash.refused`, and the counters `smithers_slash_choices` and `smithers_slash_submits` ([observability](../observability.md#browser)). None carries what was typed: a name the app doesn't offer is counted without it.

## Tests

| Test | Proves |
|---|---|
| `packages/smithers/ui/tests/slash-commands.test.ts` | ranking, argument values, disabled options, flags, every submit outcome, and that a value row's draft submits what it promised |
| `packages/smithers/ui/tests/chat-composer-completions.test.tsx` | the listbox and its ARIA, wrapping arrows, Enter, Tab, Escape before Stop, modifiers and IME left alone, the pointer keeping focus |
| `src/features/commands/commands.test.ts` | the catalog and the role filter; the menu, completion, dismissal and stale menus on the app's own layer; `/theme dark` setting the device's theme through dispatch on a real engine leader; refusals; prose asking; a Guest and a signed-out person never offered a member-only command |
| `src/features/chat/chat.test.ts` "shortcuts" | an Escape the menu handled leaves the composer open |
| `e2e/slash-commands.spec.ts` | in a real browser: `/` lists, typing filters, Tab and the arrows complete, Enter runs `/theme dark` and the page turns dark, a typed line runs, an unknown one stays; Escape closes the list then the composer; signed out, no list opens and a typed member-only command does nothing |

GIFs: `pnpm e2e:gifs` writes `slash-commands-complete-and-run.gif`, `slash-commands-escape.gif` and `slash-commands-roles.gif`.

# Flows

Every action a person or the agent takes is one `Flow.make` declaration, listed once in the app's registry. A button, a slash command, a view and the composer dispatch a registered name; the agent calls the same declarations from its cells. Every registered flow runs on this device's durable engine; a flow that needs something the device lacks is a [remote flow](remote-flows.md), started by the route that admits it. Decisions: [0003](../decisions/0003-flows-and-the-agent.md), [0011](../decisions/0011-the-agent-runs-in-the-browser.md).

## How a dispatch runs

```
the tab: names and references only (registry.ts)
  button · slash · view · composer · key ─▶ FlowDispatch.dispatch(name, payload, { door })
     ─▶ ClientEngine ─▶ BrowserEngine.start(reference) ─────────┐ the reference's tag and schemas
                                                                │
the engine worker: every declaration, the agent's included      ▼
  engine.worker.ts ─▶ declarations.ts (clientFlows) + registrations.ts (steps, AgentHost)
     the leader tab's worker runs the run (SQLite on OPFS)
        └─ a step that writes this device's state ─▶ tab port ─▶ tabAnswers ─▶ its tab's collection
        └─ app/navigate's step ─▶ <name>/navigate (BroadcastChannel) ─▶ the tab that asked ─▶ its router

agent cell: await ctx.call("app/theme/set", { mode: "dark" })
   ─▶ a child execution of the same declaration on the same engine; its result is the receipt
```

The tab never imports `@smthrs/agent`: it dispatches by each flow's reference (`BrowserEngine.FlowReference`, its tag and schemas), and only the engine worker and the Node host import the declarations and what their steps run on. `src/flows/tab.test.ts` holds the line.

| File | What it holds |
|---|---|
| `src/flows/registry.ts` | The registry the tab loads: each flow's reference (its tag and schemas), and why only a person runs it (`userOnlyReason`). `FlowName` is the only thing the UI dispatches. |
| `src/flows/declarations.ts` | Each registered flow's declaration, body and steps included, one per registry entry with the same schema objects: `clientFlows` for the engine, and `modelInvocable`. Never loaded by the tab. |
| `src/features/agent/reference.ts` | `chat/Answer`'s reference: its tag and schemas, from which `src/features/agent/flows.ts` declares it. |
| `src/flows/dispatch.ts` | `FlowDispatch`, and the port it runs through: `ClientEngine` (the browser's `BrowserEngine`, or `layerRuntime(flows)`, a `FlowRuntime` running the declarations a reference names, for the Node host and the native app). |
| `src/flows/catalog.ts` | The agent's catalog: the registry's model-invocable client flows, bound for `ctx.call`. |
| `src/flows/tabPort.ts` | The engine worker's line to its own tab. |
| `src/flows/requests.ts` | Which tab a step reaches: `TabRequests`, the executions this tab dispatched with their doors, which `FlowDispatch` fills and provides, and `requesterOf`, the run an execution belongs to ([navigation](#navigation)). |
| `src/flows/engine.ts` | The tab's side: `tabEngine` (starts the worker; provides `BrowserEngine`, `ClientEngine` and `TabWorker`), `tabAnswers` (answers the worker's calls), and `engineTelemetry`, the worker's exporter. |
| `src/flows/registrations.ts` | Every client flow's registration with its steps, the agent's included (`registrations`, `workerRegistrations`), and the repository's flows over RepoApi's routes (`repoFlows`). |
| `src/flows/engine.worker.ts` | The engine worker each tab starts: `BrowserRuntime.run` over every client flow. A program boundary, like `src/main.tsx`. |
| `worker/Body.ts` | The bounded body reader every ChatApi route that takes a body uses. |

## The registry

`FlowRegistry` is an Effect service tag (`Context.Service` in Effect 4). The tab and engine hosts provide its default `layer`; dispatch, credentials and the agent catalog read it with `yield* FlowRegistry`. A host may inject another registry layer. The reference table remains the single declaration list used to derive static command metadata and types; flow bodies stay out of the tab.

| Name | Placement | Agent | Doors |
|---|---|---|---|
| `app/theme/set { mode }` | client | yes | the theme button, `/theme`, the agent |
| `app/navigate { to }` | client | yes | `/navigate`, the agent ([navigation](#navigation)) |
| `app/web/open { url, mode? }` | client | yes | `/web` (Member and up), the agent ([web pages](web-pages.md)) |
| `chat/Answer { answerId }` | client | no: asking starts it, and the agent is what answers | the composer: chat's outbox, once ChatApi takes the question |
| `chat/Close { answerId }` | client | no: the tab that asked settles an answer whose run can no longer finish | the composer: chat's outbox, when `chat/Answer` ended refused `plan_changed` ([agent](agent.md#settling)) |
| `repo/tree { repo, revision }` | client | yes | the agent ([repo](repo.md#flows)) |
| `repo/read { repo, revision, path }` | client | yes | the agent ([repo](repo.md#flows)) |
| `issue/create { repo, title, body? }` | client | yes | New issue, `/issue owner/repo <title>` (Guest and up), the agent ([issues](issues.md#the-browser)) |
| `issue/comment { repo, number, body }` | client | yes | Comment, `/comment owner/repo <n> <text>` (Guest and up), the agent ([issues](issues.md#the-browser)) |
| `issue/triage { repo, number, decision, reason? }` | client | no: overriding triage is a person's call | Accept, Not accepted, `/triage owner/repo <n> accept\|reject [reason]` (Member and up) ([triage](issues.md#triage)) |
| `triage/run { repo, number }` | client | no | Run triage again, `/triage.run owner/repo <n>` (Member and up) |
| `triage/enable { repo, dailyTokens? }`, `triage/pause { repo }` | client | no | Enable triage, Pause triage, `/triage.enable`, `/triage.pause` (Maintainer and up) |
| `todo/draft { repo, prompt, title?, acceptance? }` | client | yes | the agent, `/todo.new owner/repo <prompt>` (Member and up): a private draft on the device ([TODOs](todos.md#flows)) |
| `todo/commit { repo, title, prompt, acceptance? }`, `todo/drop { repo, number }` | client | no: a person commits and drops; the agent drafts | Commit on a draft card; Drop, `/todo.drop` (Member and up) |
| `repo/refs { repo }` | client | yes | the agent ([repo](repo.md#flows)) |
| `repo/about { repo }` | client | no: a repository's page loads it; the agent reads a repository with `repo/refs`, `repo/tree` and `repo/read` | opening or warming a repository's page ([repo](repo.md#about)) |
| `repo/clone { repo }` | client | yes | Clone and Try again, `/clone` for a Member or above, the agent ([repo](repo.md#cloning)) |
| `repo/copy { repo, what, … }` | client | yes | the repository view's Copy buttons, the agent ([repo](repo.md#copy)) |
| `app/jev/classify { question, items, labels? }` | client | yes | the agent ([Jev](jev.md)) |
| `app/jev/evaluate { text, criteria }` | client | yes | the agent ([Jev](jev.md)) |
| `app/agent/ask { kind, prompt, options? }` | client | yes | the agent, when it needs the person ([agent status](agent-status.md)) |
| `run/answer { runId, version, execution, value }` | client | no: only the person answers what the agent asks them | the question's card ([agent status](agent-status.md#flows)) |
| `run/deliver { execution, value }` | client | no: the device that holds a run delivers an answer already recorded | sync, when an answered question reaches the device ([agent status](agent-status.md#flows)) |
| `auth/refresh {}` | client | no: a tab whose session check failed starts it, and it grants nothing | sync, when ChatApi couldn't say who is signed in ([sign-in](sign-in.md#when-chatapi-cant-say)) |

An entry's `slash` door (`{ command, minimum }`) puts it in the composer's slash menu for a person who is at least `minimum`, with the first sentence of its description and its payload as arguments ([slash commands](slash-commands.md)).

Its laws, enforced by `src/flows/registry.test.ts`:
- **Anything a person can do, the agent can do.** A registered flow is model-invocable, or carries a `userOnlyReason` and declares `modelInvocable: false`.
- **The UI dispatches only registered names.** The test reads every `.dispatch("<name>"` in `src/` and finds each in the registry.
- **Every flow runs here.** Each declaration's `Flow.Placement` annotation is `client`. A flow that needs something the device lacks is a remote flow, which the route that admits it starts ([no remote door](remote-flows.md#no-remote-door)). How long a flow takes never decides (`flows.local-first-placement` in [rules.md](../rules.md)).
- **One namespace.** App flows are named under `app/`, `chat/`, `repo/`, `ui/` and `view/`, and each is registered under its own tag.
- **One declaration per flow.** `declarations.ts` has exactly the registry's names, in its order, and each declaration carries the very tag and schema objects of its entry's reference.
- **One person-only list.** The server's person-only flows (`worker/Actor.ts` `PERSON_ONLY_FLOWS`) are exactly the entries with a `userOnlyReason`, and its agents (`AGENT_FLOWS`) exactly those marked `acts: "agent"`; the compiler and the test hold both.

## Dispatch

`FlowDispatch.dispatch(name, payload, { door, executionId?, admitted? })` starts the run on this device's engine (`ClientEngine.start`, which returns once the engine recorded it), then waits for it to end (`ClientEngine.result`), and answers:
- `Done { value }`: a client flow's success;
- `Failed { error }`: a client flow's declared failure, as a value;
- or fails with `DispatchFailed { flow, reason, refusal? }`: `refused` (the engine refused it, or nothing answered), `unavailable` (this tab's engine worker failed), `invalid` (its payload doesn't encode), `defect` or `interrupted`. A run the engine's interpreter refused died with its code as `refusal` (`Interpreter.refusalCode` from `@smthrs/flow`), such as `plan_changed` for a run parked under one build of the app and resumed under the next. An engine in this process (`ClientEngine.layerRuntime`) answers its own refusals as `refused` with their code, never as the flow's failure: a start of an execution again with another input is `refused` `execution_identity_conflict`, and a run that ends with a failure its flow doesn't declare is `refused` with that failure's code, such as `flow_cycle_detected`.

The execution id is minted once per dispatch unless the caller passes one. A door is `button`, `slash`, `view`, `composer`, `agent`, `sync` or `key` (a key the person pressed in host UI, decision 0017). The person's doors (`PERSON_DOORS`) are `button`, `slash`, `composer` and `key`: a root run of a person's flow started through one runs with the person's session, and every other run, nested ones included, with a credential the server mints for it, which the tab answers for on `<name>/door` ([run credentials](sign-in.md#run-credentials)). An entry's `acts` mark says who its run is when nobody pressed it: `agent` (`chat/Answer`, `flow/new`, `flow/run/prompt`) or `flow` (`run/deliver`, `auth/refresh`); absent, the person's. `admitted`, a `Deferred`, completes once the engine recorded the run, or fails with the dispatch's `DispatchFailed` (`interrupted` when the dispatch was interrupted first), so a caller can wait for the run to exist without waiting for it to end: chat's outbox keeps a question until the run that answers it is recorded ([state.md](../state.md#chat-2026-10-20)).

## The theme

A worker write failure retains the tab call’s typed cause (`timeout`, `unknown_method`, or `refused`) in `PreferencesUnavailable`, including in durable step receipts. Older receipts without a cause remain readable.

`app/theme/set { mode: "light" | "dark" }` is a setter, never a toggle, so a repeated delivery can't flip the theme twice. Its one step, `app/theme/write`, writes this device's `preferences` collection through `Preferences`, which each host provides:

| Host | `Preferences` |
|---|---|
| a tab | the tab's `ThemeStore` (`tabPreferences`) |
| the engine worker | a call to the tab that started it (`workerPreferences`, over the tab port) |
| the Node host in tests | the `ThemeStore` in Node |

- **The store.** `ThemeStore` keeps `preferences` on the device (`Collection.persisted`, never synced), with one row, `{ id: "theme", mode }`.
- **First paint.** Before any route or store opens, `index.html` sets `<html data-theme>` to a valid mirrored mode or the system's mode. Missing, invalid or blocked storage falls back to the system. This default paints the page without saving a preference.
- **The follower.** It paints each change onto `<html data-theme>`, the `@smthrs/ui` palette's attribute, and mirrors the mode into `localStorage` (`smithers.theme`). A deleted preference removes the attribute and mirror, so later system mode changes and reloads keep following the system. No component owns the theme.
- **Before paint.** `index.html` paints from the mirror before the store opens.
- **The button.** `ThemeButton` (`src/features/theme/components/ThemeButton.tsx`) is an icon button labelled for assistive tech only. It reads the mode the page shows (the preference; before the device's row is restored, what index.html painted from the mirror; else the system's) and calls `toggle`, which dispatches `app/theme/set` with the other mode, door `button`.

## Navigation

`app/navigate { to }` takes the tab that asked to a page of the app. A person runs it with `/navigate <path>`; the agent runs it for "open octocat/Spoon-Knife", "show me README.md" or "go to line 12 of …", finding a file's path with `repo/tree` first. Its description teaches the agent the app's paths, which are GitHub's (decision [0006](../decisions/0006-repo-clone-and-view.md) §2): `/<owner>/<repo>`, `/<owner>/<repo>/tree/<ref>/<dir>`, `/<owner>/<repo>/blob/<ref>/<file>`, and `?L=12` or `?L=10-20` after a file for lines.

```
the tab (FlowDispatch, door slash) ─┐                 ┌─ the agent's cell: ctx.call("app/navigate", { to })
                                    ▼                 ▼
          app/navigate/go, in the leader tab's engine worker
             appPath(to, origin) ── another origin or scheme ─▶ NavigationRefused; no tab moves
             requesterOf(executionId) ─▶ <name>/navigate ─▶ every tab ─▶ only the tab whose TabRequests holds it
                                                                          ─▶ appPath again ─▶ router.navigate
             no answer within 5 s ─▶ { path, moved: false }: the tab that asked is gone
```

- **Where it may go.** `appPath` (`src/features/navigation/paths.ts`): an app path, with or without its leading slash, or a full URL on the app's own origin, reduced to its path, query and fragment kept. Leading slashes collapse to one. Any other origin, any other scheme (`javascript:`, `data:`, `mailto:`) and anything that isn't a URL fail `NavigationRefused { reason }` (`origin`, `scheme`, `invalid`), and the tab stays. An agent that a page or a file talked into a link never sends a person to an outside site; a person still follows ordinary links. `to` is 1 to 2,048 characters.
- **Which tab moves.** The step runs in the leader tab's engine worker, which may not be the tab that asked. It asks on the engine's navigation channel (`<name>/navigate`, a `BroadcastChannel`, through `Tabs`) for the tab that started the run its execution belongs to (`requesterOf`). A tab's own dispatch is its own requester; the agent's call (`<answerId>/chat/Respond@…/call/<frame>.<ordinal>`) belongs to its answer, which the asking tab's composer dispatched. Each tab remembers the executions it dispatched (`TabRequests`, its latest 1,024), so only that tab answers (`tabNavigation`, `src/features/navigation/tab.ts`). It checks the path once more and moves through TanStack Router's `navigate` (`Host.navigate`: main.tsx's router, outside React), never `history` or `location`. Every other tab, and every other device, stays.
- **Completion.** The tab awaits the router before answering `moved: true`; synchronous throws and Promise rejections answer `moved: false` and record `failed`. The tab call independently bounds a supplied path to 2,048 characters.
- **What it answers.** `{ path, moved }`: the app path, and whether the tab moved. A tab that doesn't answer within 5 seconds (`NAVIGATE_WITHIN`) is gone, closed or reloaded: the step settles `moved: false` without error and moves no other tab. A router that throws leaves the tab where it was, also `moved: false`.
- **Durability.** One local action, durable as the theme is: the step's result is journaled, and a step run again after a crash asks for the same path, a setter. A run resumed in another tab after the asking tab closed finds no tab and settles.

## File tabs

`file/open { path, lines? }` opens a file of the repository the asking tab shows as a tab, its lines highlighted, and `file/close { path }` closes one. Each asks the tab that asked over the engine's files channel (`<name>/files`), as `app/navigate` does; the strip's clicks and keys and the agent's cell run the same two. See [file tabs](files.md).

## The tab that asked

A step that acts on the tab whose request started its run asks over one of the engine's channels through `src/flows/askingTab.ts`: `app/navigate` (`<name>/navigate`), `repo/copy` (`<name>/clipboard`), the issue writes (`<name>/issues`), chat's `chat/copy` and `chat/edit` (`<name>/chat-copy`, `<name>/chat-edit`, [chat](chat.md#message-controls)), and sign-in's `auth/refresh` (`<name>/auth-session`, [sign-in](sign-in.md#when-chatapi-cant-say)). Each feature declares only its input and answer schemas.

```
step (engine worker) ── asker({ channel, output, within }) ── { requester, input } ─▶ every tab on the channel
tab ── answerAskingTab({ channel, input, answer }) ── TabRequests.doorOf(requester)? ── answer(input, door)
     ◀── { door, output } ── only the tab that started the requester; nothing within `within` ─▶ none: the tab is gone
```

- The step subscribes before it asks, so the answer can't come first, and takes only the answer with its own call id whose output its schema accepts.
- A tab answers only a call whose input its schema accepts, for a requester it started, one call at a time, until its scope closes.

## The agent's catalog

The agent's cells reach the registry's model-invocable client flows and nothing else: no file system, no shell. The catalog is scoped to the run whose agent asks (`scopeOf` and `scopeFor`, `src/flows/catalog.ts`): `flow/new`'s drafting agent sees only `repo/tree` and `repo/read`, and an agent running one of [your own flows](#your-own-flows) sees only the flows that revision lists, read from its pinned payload; a call to any other is refused as unknown. Every other agent sees the whole catalog. Today those are `app/theme/set`, `app/navigate`, `app/web/open`, `chat/copy`, `repo/tree`, `repo/read`, `repo/refs`, `repo/clone`, `repo/copy`, `app/jev/classify`, `app/jev/evaluate` and `app/agent/ask`. `ctx.call("app/theme/set", { mode })` runs the declaration as a child execution on the same engine, named by the call's replay-stable identity (`<session>/call/<frame>.<ordinal>`), so a resumed cell finds the child it started. The cell call is a journaled step of the agent's run. A flow's declared failure reaches the cell as a failed call naming the failure's kind (`PreferencesUnavailable`), never its message.

Each flow the catalog binds says whether it changes something (`catalogDescription`): a registry entry that changes something declares what in product words (`changes`, such as "clones the repository, which spends the deployment's storage"), and the agent reads its description followed by `Side effect: <changes>; only when the person asks for that.` A read declares nothing and reads its description alone. `src/flows/registry.test.ts` holds every model-invocable flow to one or the other, so a new flow is classified on purpose. A flow whose side effect only the person decides on also declares `confirm`, the question they Approve or Deny: the agent's call to it first asks through `app/agent/ask`, as a child of the answer's run (`<call>/confirm`), and runs the flow only on Approve; a Deny, or no answer in time, fails the call `NotApproved` before the flow runs. A person's own button or slash command doesn't ask. Today `flow/save` ("Save this draft as your flow?") and `flow/delete` ("Delete this flow?") ask. Before 2026-10-20 nothing told the agent a flow had a side effect, and the [agent evals](agent-evals.md) caught it cloning a repository it was only asked to open, and saving and running a flow it was only asked to create.

## The engine and the tab port

Each tab starts an engine worker (`src/flows/engine.worker.ts`); the one whose tab holds the engine's Web Lock runs every client flow over SQLite in OPFS, and the others wait their turn ([`@smthrs/platform-browser`](../../../../packages/smithers/flows/platform-browser/docs/guides/run-flows-in-a-tab.md)). The engine's name is `smithers` (`ENGINE_NAME`).

`appLayer` (`src/boot.ts`) builds every tab's dispatch over `tabEngine(host.engineWorker, host.engineName)`. `tabEngine` needs nothing of the tab, so it builds before the device store, since the leading tab's worker serves the store's SQLite; `tabAnswers` attaches the tab's answers once the theme's store is open. A call the worker makes before then goes unanswered and fails `timeout`; its step fails or runs again by its own retry policy. The host starts the worker: main.tsx with `new Worker(new URL("./flows/engine.worker.ts", import.meta.url), { type: "module" })`, a Node test with `nodeDevice` (src/test/chatApi.ts), whose worker never leads unless the device runs its `agent`.

This device's collections live in the tab, so a step that writes one asks the tab that started the worker, which is open for as long as its worker runs. A call is `postMessage` both ways (`TabPort` in the worker, `answer` in the tab). A call the tab doesn't answer within 10 seconds fails `TabCallFailed { reason: "timeout" }`; a handler's failure is answered as `refused`, and a method the tab lacks as `unknown_method`. Every handler is a setter, so a step run again after a crash is harmless.

## Your own flows

Everything is a flow, and a person's own flow is flow source: one `flow.ts` module whose default export is `Flow.make("<name>", { ... })` from `@smthrs/flow`, the shape a repository's `.smithers/flows/<name>/flow.ts` has. A flow drafted from a prompt is that same kind of module, written by the system, never a second kind. Will, 2026-10-20: "No everything is a flow this ruling is clear prompt flows are just a type of code flow" ([decision 0014](../decisions/0014-flows-authoring-debugging-and-home-view.md) §1). A person's flows and a repository's differ only in where they live and who may run them. Yours are stored in Postgres and synced to every device you sign in on; a repository's aren't built yet.

**A drafted flow's module** (`renderSource`, `src/features/flows-ui/source.ts`): its instructions, one typed agent step (`<name>/agent`, seat `agent`) whose `prompt` renders them with the run's input, and the `Flow.make` declaration with its description, `flows` (what it may call), payload `{ input }`, success `string`, error and body. `src/features/flows-ui/source.test.ts` type-checks it against `@smthrs/flow` and `@smthrs/agent`. A person may edit it like any code: Smithers runs the drafted module and an edited one the same way.

```ts
const Agent = AgentAction.make("release-notes/agent", { payload: { input: Schema.String }, output: Schema.String,
  seat: "agent", prompt: ({ input }) => (input === "" ? instructions : `${instructions}\n\nInput: ${input}`) })

export default Flow.make("release-notes", { description: "…", capabilities: [], flows: ["repo/read"],
  payload: { input: Schema.String }, success: Schema.String, error: Agent.errorSchema,
  body: ({ input }) => Agent.call({ input }) })
```

**Where a revision runs** is its placement, read from its source (`placementOf`). Will answered decision [0017](../decisions/0017-everything-is-a-plugin.md#wills-answers-2026-10-20-1703) question 2: "quickjs is a sandbox" ([FLOW-2 addendum](../rulings.md#10-flows)).

| Placement | Source | Runs |
|---|---|---|
| `client` | any code that doesn't need a machine: the drafted module, as drafted or edited by hand | on your device's engine, in a fresh QuickJS realm per step (`RealmFlow`, `@smthrs/harness`; decision 0017 slice 5). The realm gives code only `Flow` and `Action` (`@smthrs/flow`), `Node` (`@smthrs/plan`), `AgentAction` (`@smthrs/agent`) and `Schema` (`effect`); everything else it does is a host call the run journals |
| `sandbox` | code that needs a machine: a static import of a module only a machine provides (`node:*`, `bun`, `bun:*`, `@smthrs/platform-node`, `@smthrs/platform-bun`, `@smthrs/sandbox`), or a `capabilities` list that starts a line and names `fs:*`, `proc:*`, `net:*`, `jj:*` or `*` (`needsMachine`) | No host runs a person's code on a machine yet (decision 0005), so `flow/run/load` fails `FlowNeedsSandbox` before anything runs, and the Flows page turns Run off and says `Needs a sandbox` (`src/features/flows-ui/steps.ts`, `components/FlowsPage.tsx` in that folder) |

The static scan decides only the page's line and the load's refusal; the realm decides what code may do. A module neither the realm nor a machine provides (`effect/Function`, a relative file) is `client` and its run fails `FlowImportRefused`. Migration `0061_flow_placement_machine` read every stored `sandbox` placement again from its latest revision, so a hand edit saved before this runs here now.

**A run of a person's code** mirrors how branch creation runs a repository's flow (`src/features/branch/creationFlows.ts`): `flow/run/load` pins the revision's code, its digest, `RealmFlow.version` and its list; `flow/run/code` is a lineage of rounds, each one realm evaluation (`flow/run/evaluate`) and, unless the code answered, one host call (`flow/run/call`) whose receipt starts the next round (`Flow.to`). Every evaluation replays the receipts before it, so a crash or reload resumes from them and never asks the model again for a sealed call; Stop cancels the lineage between steps. An evaluation under a realm version other than the pinned one fails `FlowCodeFailed { code: "version" }`, which Retry fixes.

- **An agent step** (`AgentAction.make(tag, { payload, output, seat, prompt })`, the drafted module's own form) renders its prompt in the realm from its payload and crosses as `RealmFlow.agentAction` with `{ step, seat, prompt }`. The host refuses any seat but `agent` and runs `flow/run/prompt` on that prompt: the agent with `chat/Answer`'s seat, policies and `FLOW_SYSTEM`, its catalog the revision's list. Its answer is the step's receipt; an agent that can't finish fails the run `FlowAgentFailed`.
- **A flow the list names** (`Action.make("app/theme/set", { payload, success, error })` with the registry's name) runs as a child execution the way the agent's catalog runs it (`callFlow`, `src/flows/catalog.ts`): a `confirm` flow asks the person first. Its encoded success is the receipt; a failure is a receipt carrying its kind only (`NavigationRefused`), which code may catch. A payload the flow won't read fails `FlowCallRefused { code: "payload" }`.
- **Limits** are the realm's (64 MiB, 1 s and 2,000 interrupts per evaluation, 256 KiB of source and output) and 8 host calls per run (`MAX_REALM_CALLS`: each call is one more round, and each round's run credential is minted under the one before it, inside the server's chain of 16).
- **The answer** is the code's success value as text: a string as it is, anything else as its JSON. A run's payload is `{ input }`.

How a run of code fails, by the tag the run page shows (`src/features/flows-ui/reference.ts`), each with a closed `code`:

| Failure | `code` | When |
|---|---|---|
| `FlowLimitExceeded` | `limit_exceeded`, `too_many_calls` | the realm's time, memory or size; a ninth host call |
| `FlowImportRefused` | `forbidden_import` | the code loaded a module the realm doesn't provide |
| `FlowCallRefused` | `action_not_allowed`, `seat`, `payload` | a call its list doesn't name, an agent step on another seat, a payload the flow won't read |
| `FlowCodeFailed` | `invalid_source`, `execution_failed`, `runtime_failed`, `version` | it doesn't compile or its bytes changed, it threw or failed, the realm couldn't start, the realm changed since the run began |

```
/app/flows/new: Name + What it should do ─ Draft ─▶ flow/new { name, request }   execution <draftId>:<round>
  flow/new/open   the draft row (drafting); a name you have edits that flow, from its latest source
  flow/new/draft  AgentAction, role agent: description, instructions, flows, questions ≤ 5 (corrected twice at most)
  flow/new/write  the flow.ts it makes, the static checks, the row: ready, needs_you (a blocking question), or failed with a closed code
/app/flows/drafts/<id>: the draft card
  Answer ─▶ flow/answer ─▶ changed answers + each unanswered blocking question's shown value (its default)
                        ─▶ records them, starts <draftId>:<round + 1>
  Draft again ─▶ flow/new at <draftId>:<next free round>
  Delete ─▶ flow/draft/delete ─▶ stops this device's round, deletes the draft
  Save ─▶ flow/save ─▶ POST /api/flows/save ─▶ flows + flow_revisions
/app/flows: Code ─▶ /app/flows/code/<name> ─ beforeLoad ─▶ flow/read { name } ─▶ GET /api/flows/source
                    the flow.ts to edit; Needs a sandbox while it needs a machine
                  ─ Save ─▶ flow/write { name, revision, source } ─▶ POST /api/flows/write ─▶ next revision
/app/flows: Run ─▶ flow/run { name, input?, revision, flowId? } ─▶ /app/runs/<runId>
  flow/run/load   the revision's flow.ts through GET /api/flows/source: digest, checks, then placement
                  (sandbox ─▶ FlowNeedsSandbox; client ─▶ its code, RealmFlow.version and its list, pinned)
  flow/run/code   a child lineage, one round per host call, every round replaying the receipts before it:
    flow/run/evaluate  the code in a fresh QuickJS realm ─▶ its answer (Done) or its next call
    flow/run/call      agent step ─▶ flow/run/prompt { prompt, allowed } ─▶ flow/run/agent (the agent, role agent)
                       listed flow ─▶ its child execution (a confirm flow asks first)
                       ─▶ the receipt ─▶ flow/run/code.to({ ...pin, receipts })
```

The form and card dispatch through `src/features/flows-ui/actions.ts`; `flows.ts` declares the flows from `reference.ts` in that folder. The agent's confirmation questions come from `src/flows/registry.ts`.

The New flow form explains an invalid name or overlong request beside its field and associates that hint with the input. Draft appears once both fields meet the form contract.

The New flow form, unsent answers and code editor are kept in this device's SQLite store through `@smthrs/effect-tanstack-db` (`flow-form`, `flow-answers` and `flow-code`; [0092](../decisions/0092-flow-editors-survive-reload.md)). Rows are keyed by a tab id claimed with a Web Lock and retained in session storage across reloads, so tabs keep separate edits. A PWA update waits for editor persistence receipts before reloading, and waits while an open or hidden chat draft is unsaved or a secret value remains in its field; a rejected editor receipt prevents automatic reload and asks the person to copy the edit before reloading. If the tab id cannot survive reload, flow editors refuse edits. Opening New flow without a name resumes typed text, and a typed request survives a different Edit link; only an untouched name supplied by Edit is cleared. Draft clears the form only after its run is admitted, and Answer clears its unsent answers only after admission; submitting a blocking default without typed answers leaves the empty answer store alone. Switching code pages keeps an unsent edit per flow in this tab. Reopening edited code reads its current server revision: a match keeps the text; a changed revision keeps the text, adopts the current base and requires an explicit “Overwrite newer revision” press; and an unavailable read keeps the text with a refusal. A failed device-database open or editor-store restore leaves retained rows untouched and shows "Device storage unavailable" on the flow editors while chat and navigation remain usable. The editor checks the persistence service itself because the collection SDK falls back to memory when the database cannot open.

| Flow | Doors | What it does |
|---|---|---|
| `flow/new { name, request }` | `/flow.new <name> <what>`, Draft, Draft again, the agent | One draft round. The execution id `<draftId>:<round>` names the draft; any other id starts round 0 of a new draft. Two Draft presses before admission start the same execution, which runs once. Draft again starts the first round after the draft's current round that this device's engine holds no run of, skipping rounds whose runs here failed or stopped; while a later round started here is still going or its row hasn't arrived, a second press starts nothing |
| `flow/answer { draftId, round, answers }` | Answer (user only) | Sends the changed answers plus each unanswered blocking question at the value its field shows, its default until changed. Records them on the draft and starts the next round as a run of its own |
| `flow/save { draftId }` | Save, the agent | A ready draft whose checks all pass becomes your flow, or its next revision; `NameTaken`, `DraftNotReady { code }`. Save stays busy until this device has the saved revision, then opens the list; one Electric doesn't deliver within `confirmWithin` (15 s) opens the list anyway, logged `flow.save.unconfirmed` |
| `flow/read { name, revision? }` | Code, the agent | A revision's source, the latest unless set, and its placement; `FlowNotFound` |
| `flow/write { name, revision, source }` | Save on the code page, the agent | Checks the source as every revision is checked, then saves it as the next revision while `revision` is still the latest; `FlowInvalid { check }`, `FlowsRefused { code: "stale" }`, `FlowNotFound`. Answers the new revision and its placement |
| `flow/run { name, input?, revision?, flowId? }` | `/flow.run <name> <input>`, Run, the agent | Runs your flow at `revision`, the latest unless set; with `flowId`, that flow's revision even after it was deleted and its name reused (a pinned Retry sets both); answers its answer as text; `FlowNotFound`, `FlowInvalid { check }`, `FlowNeedsSandbox`, `FlowAgentFailed`, and the code's failures above |
| `flow/run/prompt` | none (user only) | The agent an agent step of the pinned code asks, on the prompt the code rendered |
| `flow/delete { flowId }`, `flow/list {}` | Delete, the agent | Deletes one; lists them, each with its placement |
| `flow/drafts {}` | The agent | Your drafts not saved yet, newest first, each `{ draftId, name, request, status }`: how the agent finds the draft a person names, to delete it (`GET /api/flow-drafts`) |
| `flow/draft/delete { draftId }` | Delete on the card and each Drafts row, the agent | The agent asks first, "Delete this draft?". Stops the draft's round on this device's engine, then deletes the draft. Answers `deleted: false` when the draft is gone or is not yours |

**The static checks** run when a round writes its draft, when Save or a write admits a revision, and when a run loads one (`checkSource`, `src/features/flows-ui/checks.ts`, over `@smthrs/registry`'s `ModuleFlow`, which reads a repository's `flow.ts` the same way, without importing it): it `parses` (a `Flow.make` default export, no warning); its `name`, the tag `Flow.make` declares, follows the pattern, stays outside the app's names (`RESERVED_NAMES`) and is the flow's name; its `description` is 1 to 1,024 characters; its `calls` (`flows`) are at most 20 of the flows a person's flow may call (the agent's catalog minus `flow/*` and `run/*`, `PROMPT_CALLABLE`); its `model` is absent or `agent`, with no placement directive of its own; its `size` is at most 64 KiB. A failing check fails the round with code `checks`; its file and checks stay shown, and Save is off (`roundOutcome`, `src/features/flows-ui/steps.ts`). A failing check also refuses a write.

**ChatApi's routes** (`worker/PersonalFlows.ts`) are the person's own: signed out is 401, a Guest 403, and another person's draft or flow is 403 or 404. `POST /api/flow-drafts/<id>` takes a round and refuses an older round (`409 stale_round`) or a saved or proposed draft (`409 settled`); `POST /api/flow-drafts/<id>/answers` lands answers on the round's questions. `POST /api/flow-drafts/<id>/delete` [deletes a draft](#delete-a-draft). `POST /api/flows/save` admits only the draft's own file, unchanged, with its SHA-256, under a free name (`409 name_taken`). Save locks the draft inside its transaction and checks the locked row again, so two saves at once make one revision and both answer it, and a round written meanwhile is what gets checked: a draft no longer ready by then is `409 not_ready`, one whose file changed is `409 not_draft`, and one deleted is `404 not_found`.

`POST /api/flows/write` admits source with its SHA-256 as the next revision of a live flow while `revision` is its latest (`409 stale`, `404 not_found`, `409 name`, `409 digest`, `413 too_large`), and the same bytes again answer the revision they made, so a step tried again after its answer was lost isn't refused; both save and write record the revision's placement on `flows`, read from the source. `GET /api/flows/source` reads a revision, of a deleted flow too, so a pinned run can be retried; with `flowId` it reads that flow's revision only, whatever now holds its name. `GET /api/shapes/flows` and `/api/shapes/flow-drafts` sync the person's rows without the owner's id; when sessions can't be read they answer `503` with `Retry-After: 5`, never another scope under the device's handle.

**Tables** (migrations `0015_flows`, `0025_flow_source`, `0040_flow_draft_deleted` and `0061_flow_placement_machine` in `db/migrations/`): `flows` (one live name per person, with the latest revision's `placement`), `flow_revisions` (append-only source, each with its digest) and `flow_drafts`. 0025 converted every `SKILL.md` the first slice stored into the module drafting writes, with its new digest. 0040 adds `flow_drafts.deleted_at`; the drafts shape reads `actor_id = $1 AND deleted_at IS NULL` (`worker/PersonalFlows.ts`). Devices sync no new column.

On the device, `flows` and `flow_drafts` are Electric collections kept on the device (`flows` at schema version 2, for `placement`). The form, unsent answers and shown code are locally persisted; the shown draft and `flow-round` are in memory (`src/features/flows-ui/store.ts`). The form row holds the draft id its Draft starts. `flow-round` holds the shown draft's round as this device's engine last read it. The store reads it again on engine events for that draft and on draft changes, at most once every 200 ms (`FOLLOW_EVERY`).

**Not built yet:** a host that runs a person's code on a machine (`sandbox` placement), a repository's flows (`flow_bindings`, `flow/refresh`, `flow/propose`), Try, a draft card in the conversation (the card has its own page), and personal flows as their own slash commands (`/<name>`). A repository's home view is [its own feature](home.md).

### Why a draft failed

`flow/new/write` reduces the drafting agent's failure to a code from `DRAFT_FAILURES` (`src/features/flows-ui/failure.ts`), reading tags and codes only, never a message. The card uses `DRAFT_FAILURE_WORDS` (`src/features/flows-ui/contract.ts`).

| Code | Card words | Comes from |
|---|---|---|
| `no_model` | No model available | The agent: no model route or authentication, or an unresolved or unrouted seat |
| `quota` | Model credit or quota used up | The agent: quota exceeded, out of credit (the person's provider, or, with hosted inference on, the deployment's daily budget), a budget exceeded or a call skipped for budget |
| `rate_limited` | Model busy. Try again. | The agent: the model's `rate_limited` code |
| `undecodable` | The draft didn't come out right | The agent: structured output never decoded |
| `frames` | Ran out of steps | The agent: exhausted its frames |
| `model_error` | The model failed | The agent: any failure without a recognized tag or code |
| `checks` | A check failed | The round: its static checks failed (`roundOutcome`, `src/features/flows-ui/steps.ts`) |
| `stopped` | Stopped | This device's engine: the round's run was cancelled before writing the draft (`shownRound`, `src/features/flows-ui/round.ts`) |
| `ended` | Ended before it finished | This device's engine: the round's run failed before writing the draft (`shownRound`) |

Older rows carry `draft`, shown as "Couldn't draft". A failed round offers Draft again. If the round runs on another device, the card keeps the row's status and offers Delete; this engine's absence of the run says nothing about its outcome (`shownRound`, `src/features/flows-ui/round.ts`; `src/features/flows-ui/components/DraftCard.tsx`).

### Delete a draft

`POST /api/flow-drafts/<id>/delete` deletes only the author's draft: another person's is `403 forbidden`, an unknown or deleted draft is `404 not_found`, and a saved or proposed draft is `409 settled` (`worker/PersonalFlows.ts`). After deletion, GET, answers, save and a round's write answer 404, so a round still running cannot bring the draft back. The card and each Drafts row dispatch `flow/draft/delete` (`src/features/flows-ui/components/DraftCard.tsx`, `FlowsPage.tsx` in that folder).

## Observability

Nothing records a flow's payload, a cell's code, a person's flow's source or a flow's result.

| Record | Kind | Fields |
|---|---|---|
| `flow.dispatch` | log, span | `flow`, `door`, `outcome` (`done`, `failed`, `error`), `executionId`, `durationMs`, `reason` on an error, and `refusal` when the engine refused the run, with the refusal's code (such as `plan_changed` or `execution_identity_conflict`) |
| `smithers_flow_dispatches` | counter | `flow`, `door`, `outcome` |
| `web.navigate` | log, span | `door`, `outcome`, `executionId`, `durationMs`, `reason` on a refusal; the span's `smithers.navigation.door` and `smithers.navigation.outcome`. Info, Warn for `refused`, Error for `failed` |
| `smithers_web_navigations` | counter | `door` (the dispatch's; `agent` for the agent's call; `unknown` when the tab that dispatched it is gone), `outcome` (`navigated`, `refused`, `gone`, `failed`) |
| `flow.author` | log | `draftId`, `round`, `scope`, `target`, `outcome` (`ready`, `needs_you`, `failed`), `failure` on a failed round, `checks` (failing codes), `questions` (a count), `durationMs` |
| Round span | span attributes | `smithers.flow.outcome`, and `smithers.flow.failure` on a failed round (`src/features/flows-ui/metrics.ts`) |
| `smithers_flow_author_rounds` | counter | `scope`, `outcome`, `failure` on a failed round |
| `flow.save` | log | `draftId`, `outcome` (`saved`, or the refusal's code) |
| `smithers_flow_saves` | counter | `outcome` |
| `flow.save.unconfirmed` | log, Warn | `feature`: Save's flow is saved, but Electric didn't deliver it to this device within `confirmWithin` |
| `flow.write` | log | `outcome` (`written`, `check:<check>`, or ChatApi's code), `placement` |
| `smithers_flow_writes` | counter | `outcome`, `placement` |
| `flow.run.load` | log | `outcome` (`realm`, the failing check, or `sandbox`) |
| `flow.run.evaluate` | log, span | `outcome` (`call`, `agent`, `complete`, or the failure's `code`), `receipts` (a count); the span's `smithers.flow.outcome` |
| `smithers_flow_realm_evaluations` | counter | `outcome` |
| `flow.run.call` | log, span | `kind` (`agent`, `flow`), `outcome` (`ok`, `failed`, or the refusal's `code`) |
| `smithers_flow_realm_calls` | counter | `kind`, `outcome` |
| `flow.client.*` | span | one per route a `flow/*` step calls, with its status |
| `flow.client.delete_draft` | span | the draft-delete request (`src/features/flows-ui/api.ts`) |
| `flow.route` | log, span (ChatApi) | `route` (`draft_delete` for deleting a draft), `status`, `draftId`, `flowId`, `round`, `code`, `durationMs`; never a request, a file, a question, an answer, a description or a name (`worker/PersonalFlows.ts`) |
| `smithers_flow_route_requests` | counter (ChatApi) | `route`, `status` |

Navigation's records come from the engine worker, where its step runs, and never carry the path, which can carry content; the agent's call is also its own `execute_tool app/navigate` span (`NAVIGATION_TELEMETRY`, `src/features/navigation/contract.ts`). `app/web/open` records `web.page.open` and `smithers_web_pages_opened` by mode, door and outcome, never the page ([web pages](web-pages.md#observability)).

## Tests

| Test | Proves |
|---|---|
| `src/flows/registry.test.ts` | The parity law, every flow on this device, the UI's dispatched names, the namespaces, one declaration per flow with its reference's schemas, and the agent's catalog |
| `src/flows/tab.test.ts` | The tab's module graph (esbuild, from `src/main.tsx`, the `?faults` entry included) reaches no `@smthrs/agent` or Node built-in, and `@smthrs/std` only through code intelligence's `LanguageServer` seam; the engine worker's registrations reach the agent |
| `src/flows/dispatch.test.ts` | The theme on the Node host's engine over the compose Postgres; declared failures, defects, interrupts and refusals by injected faults; every record without the payload (a sentinel) |
| `src/flows/engine.test.ts` | The browser's architecture in Node: a tab's `BrowserEngine` and the leader's engine worker over Node's Web Locks and `BroadcastChannel`, the tab port over a `MessageChannel`. A person's button and the agent both set the theme through `app/theme/set`. `tabEngine` builds with nothing of the tab, and `tabAnswers` answers only while attached |
| `src/flows/tabPort.test.ts` | Calls, refusals, unknown methods, timeouts and stray messages over a real `MessageChannel` |
| `src/flows/askingTab.test.ts` | The channel to the tab that asked, over Node's `BroadcastChannel`: only that tab answers, with its door; a request no tab started, a call with another input, stray messages and other calls' answers, and a tab whose scope closed |
| `src/features/theme/theme.test.ts` | The store, the follower, the system's mode, both `Preferences`, and the toggle through dispatch |
| `src/features/navigation/navigation.test.ts` | `appPath` for paths, same-origin URLs, other origins however written, other schemes and non-URLs; the step on the Node host's engine with real tabs on Node's `BroadcastChannel`: only the tab that asked moves (a person's door and the agent's call), a gone tab settles `moved: false`, a router that throws, refusals, a rogue call the tab checks again, and records without the path (a sentinel); then the whole device: a second tab's dispatch moves only it, and the agent's call moves the tab whose composer asked |
| `src/flows/requests.test.ts` | A tab's requests: their doors, its latest only, one per tab; an execution's requester |
| `worker/Body.test.ts` | Every bound of the body reader |
| `src/flows/catalog.test.ts` | The catalog's scope: reads while drafting, a person's flow's own list, and nothing when its list can't be read |
| `src/flows/registry.test.ts` "side effects" | Every model-invocable flow is a read or says what it changes, and no person-only flow does; `flow/save`, `flow/delete` and `flow/draft/delete` ask first; the catalog shows a side effect after the description and nothing more for a read |
| `src/features/agent/agent.test.ts` "a call the person must approve" | The agent's `flow/save` asks the person first: denied, the flow never runs and the cell reads `NotApproved`; approved, it runs |
| `src/features/flows-ui/source.test.ts` | A drafted flow's module; the drafted module and any edit of it are `client`; every machine import and capability is `sandbox`; text that only looks like an import or a capability inside the instructions isn't; the module type-checks against `@smthrs/flow` and `@smthrs/agent` |
| `src/features/flows-ui/checks.test.ts` | Reading a flow's source through `ModuleFlow`, and every static check's refusal, for a drafted module and one written by hand |
| `src/features/flows-ui/flows.test.ts` | Every `flow/*` flow on the Node host's engine against ChatApi with a scripted model: a round, a new draft from any id, a blocking question answered into round 1, `undecodable` when a draft never decodes, `no_model` from an injected refusing model without its message reaching the draft, failing checks that fail the round with its file shown, an edit into revision 2, Save and `NameTaken`, a run that calls its list, a call outside it refused, an agent that never finishes, a missing or tampered revision, `flow/read`, `flow/write` (a failed check, a stale revision, a missing flow), `flow/draft/delete` stopping a live round, list and delete, and the whole catalog outside a run. Code in the realm: a relabelled step runs to Done with the agent asked the prompt its code rendered, its run's steps `flow/run/evaluate`, `flow/run/call`, `flow/run/agent`; code calling a listed flow and the agent, answering a value as text; a listed flow's failure caught by the code; a call outside its list, an infinite loop, a forbidden import, code that throws, another seat and payloads the host won't read, each refused by its tag and code before any model call and without the code's text; machine imports and capabilities failing `FlowNeedsSandbox`; a killed engine resuming from receipts without asking the model again for a sealed call; Stop between steps; and `flow/run/evaluate` and `flow/run/call` directly: another realm version, changed bytes, source that won't compile, an injected faulty QuickJS build (`runtime_failed`, nothing private said), the ninth call, and a call the pin doesn't list |
| `src/features/flows-ui/failure.test.ts` | Failure codes from agent tags and model codes, including failures read back through the journal codec; nested causes, cycles, the 16-level bound, unreadable fields, unknown failures and no message content in a code |
| `src/features/flows-ui/api.test.ts` | `FlowsClient` against every kind of answer: refusals, 404s, 5xx, an unreadable body, no network and the deadline |
| `worker/PersonalFlows.test.ts` | Every route and refusal, draft deletion (author only, gone after deletion, saved draft settled, concurrent deletes and a late round unable to restore it), two saves at once making one revision and both answering it, a save that finds the draft drafting, deleted, or ready with another file once it holds the row, each refused and writing nothing, `POST /api/flows/write` and the placement it records, the shapes excluding deleted drafts, and no content in any record (a sentinel) |
| `e2e/flows.spec.ts` | Requires `member` and `liveModel` (`e2e/target.ts`); opens `/app/flows` directly. In a real browser with the real model, drafts and saves, runs to Done, checks the run graph's `<name>/load, Done` and `<name>/code, Done`, then stops and retries a run. A round ending Failed or Stopped fails at once with the card's words. Also opens the flow's code (a `Flow.make` module), runs it to Done, relabels its step in code and saves, and the edited code runs to Done in the realm, its graph showing `<name>/evaluate` and `<name>/call`. GIF: `flows-flows-draft-a-flow-from-a-prompt-open-its-code-run-it-relabe.gif` (needs a live model; the previous GIF shows the old refusal) |
| `e2e/flows.spec.ts` "flows: delete a draft while it drafts, and it leaves your drafts" | Deletes from the card, returns to Flows without the draft and checks it stays absent after reload. GIF: `flows-flows-delete-a-draft-while-it-drafts-and-it-leaves-your-draf.gif` (`e2e/gifs.mjs` truncates the title slug to 60 characters) |
| `db/Database.test.ts` "0025_flow_source" | Every stored `SKILL.md` revision and draft becomes the drafted module with its new digest; a draft that doesn't read fails `migrated` unless saved; a revision that doesn't read fails the migration by id, never by text |
| `db/Database.test.ts` "0061_flow_placement_machine" | A `sandbox` flow whose latest revision needs no machine becomes `client`; one that needs a machine stays `sandbox`; a `client` flow stays |
| `packages/smithers/agent/harness/test/RealmFlow.test.ts` | The realm's agent step: the prompt rendered in the realm, the same key every evaluation, a receipt for another prompt refused, an agent step the host didn't offer refused; host options, a blank seat or a non-text prompt refused; raw callbacks replaying; `forbidden_import` even when caught; `action_not_allowed` in a branch never taken; limits |
| `src/features/flows-ui/tab.test.ts` | The whole app on a Node device whose engine leads: Draft, Save, Run, the run page following the run, Retry, the list, Edit and Delete; Answer with a blocking question's shown default and with an edited answer; two Draft presses making one draft with one model call; Stop the round then Draft again to Ready; Delete a drafting draft; `shownRound` and failure words; `Name taken`; Stop on a live run, and Resume refused once it settled; Code: a failed check, a relabelled step saved as `client` that runs in the realm to its answer with its run page showing `hello/code`, `hello/evaluate`, `hello/call` and `hello/agent`, machine code saved as `sandbox` whose run fails before the model, a flow not found, and a read that ends after the tab moved on |

Run them with the compose Postgres up (`pnpm db:up`): `pnpm exec vitest run src/flows src/features/theme src/features/navigation worker/Body.test.ts`.

`src/features/chat/chat.test.ts` "the agent" runs the whole app on a Node device whose engine leads: the asking tab dispatches `chat/Answer`, the agent answers through ChatApi, and a resend dispatches the same execution without a second run. `e2e/agent.spec.ts` runs the engine in a real browser: the agent answering through the model endpoint, the theme set by its button and by the agent, and a killed tab whose answer resumes on the same device without paying again for a sealed model call. `e2e/navigate.spec.ts` asks the agent to open `octocat/Spoon-Knife`, which takes the asking tab there while the device's other tab stays, and never clones (`e2e/repo-clone.spec.ts` asks it to clone, and it does); sends `/navigate /octocat/Spoon-Knife` from the composer, which does the same without the model; and asks the agent to open an outside site, which is refused while the page stays put. Locally it reads the agent's `web.navigate` lines from ChatApi's relay.

The theme's transient `theme-display` collection publishes system color-scheme changes to `useShownMode` and the theme button while there is no saved preference. These changes clear the page's paint override without saving a choice; deleting the preference clears the mirror too. `theme.system_changed` logs and spans, and `smithers_theme_system_changes` counts them. The React action boundary contains unexpected toggle defects, recording `theme.toggle.defect` and `smithers_theme_toggle_defects` without defect content. All four records pass through the browser telemetry contract. Regression coverage lives in `theme.test.ts`, `tests/ThemeButton.test.ts` and `e2e/theme-system.spec.ts`.

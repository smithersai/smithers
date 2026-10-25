# The agent talks through UI

The agent asks with forms and shows things as views: a form or a small view inline in the chat, which a person can open full screen. Will (feature 3, rulings SCOPE-6): "The agent has the ability to talk to us in forms. Note the agent uses codemode for everything … It should have the ability to render a small view what you see in chat and a big full screen view … if I ask for a tic tac toe board it shouldn't have issues doing that. This should be safe." Decision: [0004](../decisions/0004-agent-ui-codemode-and-rendering.md), with the agent in the browser ([0011](../decisions/0011-the-agent-runs-in-the-browser.md)). The SDK half is `@smthrs/views` and `@smthrs/ui`'s `GeneratedView` and `FlowFormView` ([render a view](../../../../packages/smithers/ui/views/docs/render-a-view.md), [security](../../../../packages/smithers/ui/views/docs/security.md)).

```
agent's cell ─ ctx.call("ui/form", { title, schema, submitLabel? })
                 ui/form/check (sealed: fields, no secret; the view's id) ─ ui/form/show ─ POST /api/views {template: form}
             └ ctx.call("ui/render", { description, size?, data? })
                 ui/render/plan (sealed: id, size)
                 ui/render/write ─ ModelStep on the `renderer` role ─ {title, state} + TSX module
                                 ─ POST /api/views {template: generated, code, props, state}
                                     ChatApi: ViewCode.check ─ PresentationRealm.render (QuickJS) ─ keeps its own HTML
                                     422 { detail } ─▶ back to the renderer, at most twice
Postgres views ─▶ Electric ─▶ every device's `views` ─▶ the conversation, by id
  form:      FlowFormView ─ Send ─▶ ask { text: submit label, source: {viewId, event: "submit"}, data: values } (outbox)
               ChatApi, one transaction: the question + the form `submitted` ─▶ the next answer reads the values
  generated: GeneratedView (iframe sandbox="allow-scripts", srcdoc, CSP pinned to the frame runtime)
               a click on a `state` event ─▶ view/set-state { viewId, revision, event }
                 ─▶ POST /api/views/<id>/state { moveId: the run's execution id, revision, event }
                 ChatApi runs the module's reduce from the state it keeps, renders, bumps the revision ─▶ every device
               a click on a `message` event ─▶ ask { text: its label, source, data } (outbox)
  Full screen ─▶ /app/views/<id>: the same component, from the same row, at full size
```

## Forms

`ui/form { title, schema, submitLabel? }` adds a form to the conversation. `schema` is a JSON Schema object; its fields come from `@smthrs/ui`'s `declaredInput` and `formFieldsFor`, as `FlowFormView` renders them, so a field the form can't render never shows. The flow's description tells the agent to ask for any input this way, never in prose, and that the form ends its answer.

Missing required input uses that form even when the person didn't explicitly ask
for a form. The agent ends with “Form ready.” and leaves the question to the
fields. An explicit request to ask and act in the same answer still uses
`app/agent/ask`. Forms and generated views are visible to the person; other flow
results must be included in the answer when requested.

- **The submission is the person's next question.** Its text is the submit label (`Send` unless set), and it carries `source: { viewId, event: "submit" }` and `data`, the values. It goes through chat's outbox like any question, so it is durable: offline, it waits and is sent once; refused, it shows Not sent with Retry, which sends the values again (`chat-unsent` v2).
- **Submitted once, everywhere.** ChatApi stores the question and marks the form `{ submitted: true, values, questionId }` in one transaction. The same question again changes nothing; another submission of the same form is `409`. Every device then shows the form answered: its values, disabled, with no button. It never parks the answer ([0004 §3](../decisions/0004-agent-ui-codemode-and-rendering.md#3-templates)): the agent goes on in the next answer.
- **The agent reads the values.** The answer's turn and the history give the model the question's text, then `The values the person sent with it: {…}` (`SENT_VALUES`, `worker/Messages.ts`).
- **Checked on both sides.** The step and ChatApi refuse a schema with no field the form renders (`no_fields`) or a write-only or password field anywhere in it, a referenced definition included (`secret`): a form's values are synced to everyone in the conversation, so it never asks for a secret. ChatApi takes only values the form's own schema decodes, with no extra field (`400`).
- **One question, one submission.** The same question id again is the same question only with the same view, event and values; anything else is `409`. The model reads the values within the history's character budget, which counts them.

## Generated views

`ui/render { description, size?, data? }` shows something the agent describes: a comparison, a table, or a board such as tic-tac-toe. A renderer, the model endpoint's `renderer` role, writes one TSX module ([the module contract](../../../../packages/smithers/ui/views/docs/render-a-view.md#the-module-a-renderer-writes)): a pure `View`, its declared `interactions`, and a `reduce` for `state` events. Its system prompt (`src/features/views/renderer.ts`) names the presentation subset's components and shows one example, the tic-tac-toe board the tests use.

- **One renderer call per attempt.** `ui/render/write` makes each call a sealed `ModelStep` (`ui/render/model/<n>`), so a resumed run never pays for one twice. A reply with no module, or a module ChatApi refuses (`422 { code: "not_rendered", detail }`), goes back with what failed, at most twice; then the step fails `ViewNotRendered`.
- **A move is a click, never a model call.** A `state` event runs `view/set-state`, which ChatApi makes from the state it keeps. A move made against a board another device already changed is `409 stale`, and the device shows the synced board. The agent may make a move too (`view/set-state` is in its catalog).
- **A move happens once.** Its id is its flow execution's, the same on every retry and after a restart. ChatApi keeps it with the revision it made (`view_moves`), in the move's transaction, so a move whose answer was lost and is sent again answers that revision, never `409 stale`.
- **A `message` event** sends its label as the person's next question, with the frame's form values, like a form.
- **Sizes.** `inline` in the message, 80 to 480 pixels high from the frame's reported height; **Full screen** opens `/app/views/<id>`, the same `GeneratedView` at `full`. A form opens full screen the same way.

## Where a view runs

Generated code never runs in the browser's JavaScript engine, and never with the person's credentials.

| Layer | What it does |
|---|---|
| ChatApi's realm (`worker/ViewRealm.ts`) | The only place the module runs: `@smthrs/views`' `PresentationRealm` in QuickJS, a fresh runtime per render and move, with no clock, network, storage or host object, bounded in time, steps, memory, stack and output. It loads on the first generated view an isolate sees. On Cloudflare it uses the `.wasm` the bundler compiled, as the cell sandbox does; Node loads the same build's file |
| `ViewCode.check` | Before the module runs: imports only `react`, `smithers:view` and the presentation subset; no `eval`, network, storage, navigation, `script`, `iframe`, `a` or `style` |
| The row | ChatApi keeps the HTML its realm rendered, never HTML a device sent. The module (`code`) stays on the server: the views shape leaves it out (`SYNCED_VIEW_COLUMNS`) |
| The frame (`GeneratedView`) | `<iframe sandbox="allow-scripts" srcdoc>`: an opaque origin, so no cookies, storage or parent DOM; a CSP that admits only the frame runtime by hash; the runtime copies only allowlisted elements and attributes. It receives the view's HTML and theme, nothing else |
| The bridge | Only declared events, from a real click, at most 10 a second, each through `Bridge.receive` |

So a view can't read the person's session, the conversation, other views or the app's state, and can't load or send anything. The browser probes for the frame are `@smthrs/ui`'s (`browser/generated-view.browser.test.ts`).

## Routes

In ChatApi (`worker/Views.ts`, routed by `worker/Chat.ts`). Adding and moving take a Member or above who may edit the conversation, like asking.

| Route | Answers |
|---|---|
| `POST /api/views` `{ id, template: "form", props: { title, schema, submitLabel } }` | `202 { txid }`; `200` the same form again; `400 refused` for `no_fields` or `secret`; `413` over 8 KiB; the rest as for a page ([web pages](web-pages.md#the-views-table)) |
| `POST /api/views` `{ id, template: "generated", title, size, code, props, state }` | `202 { txid, interactions }`; `200 { txid: null, interactions }` the same module again, not rendered twice; `422 { code: "not_rendered", detail }` a module that fails its check or render, a state over 16 KiB, or HTML over 256 KiB; `413` over 96 KiB |
| `POST /api/views/<id>/state` `{ moveId, revision, event: { name, arg? } }` | `200 { txid, revision }`; `200 { txid: null, revision }` the same move again; `409 { code: "stale", revision }`; `400 undeclared` an event the module doesn't declare as `state`; `404` no such generated view; `422` a move the module can't make, or whose state or HTML is over its bound; `401`, `403`, `413`, `503` |
| `POST /api/questions` `{ …, source?: { viewId, event }, data? }` | as asking ([chat](chat.md)), and: `400` a view not in the question's conversation (never `404`, which the outbox would send again forever), an event the view doesn't take, or values its form doesn't; `409` a form already sent |

## The table

`db/migrations/0052_agent_views.ts` adds to `views`: `title`, `size` (`inline` or `full`), `state`, `code`, `html`, `interactions`, `revision` and `updated_at`, and the templates `form` and `generated`, each with the columns it needs (a CHECK). `messages` gains `source` and `data`, on questions only. `view_moves` keeps each move by its id with the revision it made.

## The browser

| File | Holds |
|---|---|
| `src/features/views/flows.ts`, `steps.ts` | the three flows and their steps; `RendererSeat` |
| `src/features/views/renderer.ts` | the renderer's system prompt, its task and correction, how its reply is read, and the presentation subset's component names (`renderer.test.ts` pins them to `@smthrs/ui`'s) |
| `src/features/views/form.ts` | the form rules ChatApi and the step share, read with Effect's JSON Schema importer |

The modules the engine worker runs import no UI library (`units.test.ts` holds them to it): a worker has no DOM, and loading `@smthrs/ui` there stopped the engine worker from starting.
| `src/features/views/schema.ts`, `rows.ts` | the `views` row (one flat struct, checked per template) and its reading by template |
| `src/features/views/views.ts` | `queries.rowsIn` (a conversation's views, by id), `actions.move` |
| `src/features/views/components/ConversationView.tsx` | a view in the conversation; `AgentView`, the form or generated view at either size |
| `src/screens/view/ViewScreen.tsx` | `/app/views/<id>` at full size |
| `src/features/chat/actions.ts` | `ask(text, from?)`: a question from a view, in the view's own conversation |

## Observability

None of these carries a schema, values, a description, a module, props, state, HTML or an event's name. `VIEWS_TELEMETRY` (`src/features/views/contract.ts`) adds the browser's records to the relay's allowlist.

| Record | Where | Fields |
|---|---|---|
| `views.form`, `views.render`, `views.move` | log, engine worker | `template`, `outcome` (`shown`, `refused`, `not_rendered`, `forbidden`, `unavailable`, `moved`, `stale`), `corrections` |
| `smithers_views_shown`, `smithers_renderer_corrections`, `smithers_view_moves` | counters, engine worker | the same |
| `views.form.check`, `views.form.show`, `views.render.write`, `views.move` | spans | `smithers.view.size` |
| `chat.view.add`, `chat.view.state` | log, ChatApi | `viewId`, `template`, `status`, `reason` (a refusal's, or the check's reason or limit), `revision`, `existing`; never a move's event, which a module names |
| `chat.question` | log, ChatApi | `source: view` for a question sent from a view, never its event |
| `smithers_view_requests`, `smithers_view_state_requests`, `smithers_view_renders` | counters, ChatApi | `status`; `outcome` and `door` (`add`, `state`) |
| `PresentationRealm.render`, `realm.limit_hit` | `@smthrs/views` | reason and limit only |

## Tests

| Test | Proves |
|---|---|
| `worker/AgentViews.test.ts` | ChatApi with its real realm: a form added open, refused for a secret (a referenced one too) or no field; its submission is the next question, marks it submitted once, and the turn reads the values; the same id with other values or another form `409`; values counted in the history's budget; wrong values, events and views refused; a generated view checked and rendered by ChatApi, not rendered twice, its module never synced; four hostile modules `422` with nothing logged; a move from the kept state, the same move again answering its revision, stale, undeclared, throwing and oversized moves refused; every refusal of the route; no record carrying an event's name; a `message` event as a question |
| `worker/ViewRealm.workerd.test.ts` | the realm in local workerd, bundled as Alchemy bundles ChatApi: QuickJS as one compiled `.wasm`, the board rendered and moved, a throwing module refused |
| `src/features/views/steps.test.ts`, `api.test.ts`, `units.test.ts` | each step's refusals and retries with faulty clients and renderers; the client over failing transports; rows, the renderer's reply and the form rules |
| `src/features/views/agentViews.test.ts` | the agent's own `chat/Answer` on the Node host: asks with a form, and the next answer reads the submission; a secret form refused before anything is added; the renderer corrected once, then the board rendered and played, a stale move refused; a renderer that never renders fails after two corrections |
| `db/Database.test.ts` "0052_agent_views" | each template's columns, and `source` on questions only |
| `src/device/*.test.ts` | `asking` v2, `chat-unsent` v2 and `views` v4, migrated or synced afresh |
| `evals/cases.test.ts`, `checks.test.ts` | the four [agent eval](agent-evals.md) cases `form-ask`, `form-clone-no-url`, `board` and `view-loads-script`, calibrated |
| `e2e/forms.spec.ts` | scripted, two devices: submit once, sync and reload; live model: ask to clone without a URL, fill the repository form and see the next reply finish |
| `e2e/generated-view.spec.ts` | scripted, two devices: play to a win, sync and reload; live model: ask for a board, see nine cells inline, open that view full screen, play a move and see it again inline |

The original e2e cases script the models in the asking browser (`/app?agent=form`, `/app?agent=board`, `src/test/scriptedAgent.ts`); everything else is real. Run them with the compose Postgres and Electric up: `pnpm exec vitest run worker/AgentViews.test.ts src/features/views`, and `pnpm e2e forms.spec.ts generated-view.spec.ts` against `pnpm dev`.

The same specs also declare `member`, `ownConversation` and `liveModel` for their live cases. On a deployment they use the test account's own branch; locally they skip with the `liveModel` reason when no model key is configured. The form request collects a URL afresh even when earlier runs left one in the conversation. The board request specifies nine empty buttons with text X/O marks. They observe newly created view ids and submitted values, successful answer completion and a persisted board move, without fixing the model's reply, form title, submit label or cell labels. Run only these cases with `pnpm e2e forms.spec.ts generated-view.spec.ts --grep 'Live (forms|generated views)'`, or the same arguments to `pnpm e2e:prod` for the deployment setup and session.

## Not yet

- A move waits for ChatApi and Electric before the board changes; 0004 §6's instant local render (a realm in the tab) is not built.
- The renderer's system prompt is hand-written, not generated from `@smthrs/ui`'s docs, and saves no `@smthrs/ui` version with the view.
- The four new eval cases have no baseline: no model key was configured where they were written.

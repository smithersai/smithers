# OpenCode route and event trace (engineering doc phase S0)

Date: 2026-09-17. Hosted app: https://app.opencode.ai (bundle `/assets/index-DVnnwhTV.js`, embeds commit hash `5a8335857b0ebec44ef6aa1d52b339cf25c329ca` and version strings `1.18.31` and `1.17.19`; its v2 client is the vendored tarball `@opencode-ai/client` `vendor/opencode-ai-client-1.17.13-v2.tgz` from `packages/app/package.json`). Servers: installed CLI `opencode 1.18.31` on 127.0.0.1:4098 and `main` at 5a83358 run from source (`bun run packages/opencode/src/index.ts serve`) on 127.0.0.1:4099. Proxy: `proxy.mjs` on 127.0.0.1:4096 (node stdlib). Driver: `drive.mjs` (Playwright 1.62.1, chromium 151 headless, fresh context per run). Project: a scratch git repo with `opencode.json` pinning `"model": "opencode/big-pickle"` and `"permission": {"bash": "ask"}` (copied here as `trace-repo-opencode.json`; keys verified in `packages/core/src/v1/config/permission.ts` and the 1.18.31 OpenAPI `Config` schema).

## Files in this directory

| File | What it is |
| --- | --- |
| `requests.ndjson`, `events.ndjson`, `shots/v1-passthrough/` | Run A. Pure passthrough proxy. This is what the hosted app does against a real server today. Protocol chosen: v1. |
| `requests-v2-forced-1.18.31.ndjson`, `events-v2-forced-1.18.31.ndjson`, `shots/v2-forced-1.18.31/` | Run B. Proxy answers `/global/health` with 404 and adds `pid` to `/api/health` so the app picks v2, against 1.18.31. The app never gets past bootstrap. |
| `requests-v2-forced-main.ndjson`, `events-v2-forced-main.ndjson`, `shots/v2-forced-main/` | Run C. Same forcing against main from source. Same bootstrap failure. |
| `requests-v2-forced-main-shimmed.ndjson`, `events-v2-forced-main-shimmed.ndjson`, `shots/v2-forced-main-shimmed/` | Run F. Forced v2 against main plus proxy shims (listed below). The app boots, creates a session, and posts prompts; main cannot run a turn because the free tier refuses non-official builds. |
| `openapi-1.18.31.json` | `GET /doc` from the installed CLI, 162 paths. |
| `proxy.mjs`, `drive.mjs`, `analyze.py` | The tooling. |

Every ndjson line is one request `{seq, step, at, method, path, query, origin, reqBody, status, resContentType, resBody, ms}` or one SSE line `{seq, idx, step, at, path, event}`; marker lines `{marker: true, step, note, at}` bound the steps. The proxy stripped `accept-encoding` so bodies are logged as JSON. Bodies over 8 KiB (request) or 16 KiB (response) are logged as `{_truncated, _bytes, preview}`.

Event counts in run A are inflated by a factor of up to 5 because the app keeps every `/global/event` stream it ever opened alive (one per home view and per project view, plus the reload); each proxy stream logged every event. Dedupe on `event.payload.id`.

## Steps and what was possible

| Step | What ran | Notes |
| --- | --- | --- |
| a | Open the app, wait for the connection | Headless chromium first refused every fetch to localhost with `Permission was denied for this request to access the loopback address space` (Chrome Local Network Access). Fixed by launching with `--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessChecks,BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults`. A real browser shows a permission prompt instead. |
| b | Create a new session | The hosted app opens with no project. Clicking Add project opens a directory picker (traced: `/find/file`, `/file?path=&directory=...` per typed path segment in v1; `/api/fs/list` in v2). Pressing Enter in the picker chose the first fuzzy match, a foreign directory, so the driver closes the picker and navigates to the app's own project route `/<base64url(directory)>`, which lands on `/new-session?draftId=...`. The session itself is created by the first prompt submit; there is no separate create action in the UI. |
| c | Prompt: Read package.json and tell me the name field. | v1: works. The free model answered with a wrong name, which is a model issue, not a protocol one. |
| d | Prompt: Run `ls -la` and summarize., click Allow once | v1: the card reads Permission required / Run shell commands / ls -la with buttons Deny, Allow always, Allow once. Clicked Allow once. |
| e | Prompt: Say done. | v1: works. |
| f | Reload | v1: history renders (8 messages from `/session/:id/message?limit=20`). |
| g | Rename | Clicking the session title heading turns it into an input; Enter commits. v1 sends `PATCH /session/:id {title}`. v2 sends `POST /api/session/:id/rename {title}`, which main answers with the SPA index.html (route absent on main). |
| h | Sidebar session list | At 1400x900 the hosted app has no sidebar toggle button; the session list is the Home view (button Home, keybind Cmd+B), which calls `GET /api/session?limit=5000&order=desc` in both protocols. Extra step h2 pressed Toggle review, which calls `GET /vcs/diff?mode=git&directory=...` in v1. |

## Protocol the app chose

`packages/app/src/utils/server-protocol.ts` probes `GET /global/health` first. If it returns `{healthy: true}` the app is v1. Only then does it probe `GET /api/health`, and it needs a numeric `pid` in that answer to pick v2; `{healthy: true}` alone means v1. Both 1.18.31 and main answer `/global/health` with `{healthy: true, version}` and `/api/health` with `{healthy: true}` and no `pid`, so against every real OpenCode server that exists today the hosted app runs v1 legacy routes. Run A is that trace. The app never fell back from v2 to v1 mid-session; it decides once per connection and re-probes on reload.

Even in v1 mode the app calls three v2 routes: `GET /api/health` (polled every 10 s as the health check), `GET /api/session?limit=5000&order=desc` (home list), and `GET /api/reference?directory=...&location[directory]=...`.

In forced v2 mode (runs B, C, F) the app uses the vendored 1.17.13-v2 client, whose route table (from the bundle) is: `/api/agent`, `/api/command`, `/api/credential/{credentialID}`, `/api/debug/location`, `/api/event`, `/api/experimental/integration/wellknown`, `/api/form/request`, `/api/fs/find`, `/api/fs/list`, `/api/fs/read/*`, `/api/generate`, `/api/health`, `/api/integration...`, `/api/location`, `/api/mcp`, `/api/mcp/resource`, `/api/model`, `/api/model/default`, `/api/permission/request`, `/api/permission/saved`, `/api/plugin`, `/api/project`, `/api/project/current`, `/api/provider`, `/api/provider/{providerID}`, `/api/pty...`, `/api/question/request`, `/api/reference`, `/api/server`, `/api/service/stop`, `/api/session`, `/api/session/active`, `/api/session/{sessionID}` plus `/agent /compact /context /event /history /interrupt /message /message/{messageID} /model /permission /permission/{requestID} /permission/{requestID}/reply /prompt /question /question/{requestID}/reject /question/{requestID}/reply /revert/clear /revert/commit /revert/stage /wait`, `/api/shell`, `/api/skill`, `/api/vcs/diff`, `/api/vcs/status`. Neither 1.18.31 nor main serves `/api/model/default`, `/api/project`, `/api/project/current`, `/api/mcp`, `/api/mcp/resource`; both answer them with the SPA `index.html` (200 text/html). The app's bootstrap then throws `Failed to finish bootstrap instance TypeError: Cannot read properties of undefined (reading 'temperature')` (agent normalization reads `agent.request.settings`, which main's `/api/agent` does not include) and the composer has no model, so nothing can be sent. Run F added these proxy shims to get further: `/api/model/default` -> `{location, data: null}`, `/api/project` -> `[]`, `/api/project/current` -> `{id, directory}`, `/api/mcp` -> `{location, data: []}`, `/api/mcp/resource` -> `{location, data: {resources: [], templates: []}}`, `/api/agent` entries patched with `name` and `request.settings: {}`, `POST /api/session` model rewritten to `opencode/big-pickle` (the app picked `google/gemini-3.8-flash` on its own because config is not consulted in v2), and the prompt body wrapped (see discrepancies).

## Run A: routes per step (v1, the live behavior)

Query `directory=...` is the absolute project directory. Counts are per step after removing OPTIONS preflights (the browser sends one before every POST and PATCH; the server answers 204 with `access-control-allow-origin: <origin>`, `access-control-allow-methods: GET, HEAD, PUT, PATCH, POST, DELETE`, `access-control-allow-headers: content-type`, `access-control-max-age: 86400`).

Step a (open, home view):

| Route | Count | Response top-level keys |
| --- | --- | --- |
| GET /global/health | 1 | healthy, version |
| GET /api/health | 1 | healthy |
| GET /api/session?limit=5000&order=desc | 1 | data (SessionV2.Info list across all projects), cursor |
| GET /global/config | 1 | $schema, mcp |
| GET /path | 1 | home, state, config, worktree, directory |
| GET /session/status | 1 | {} (map of sessionID to status) |
| GET /project | 1 | list of Project {id, worktree, vcs, time, sandboxes} |
| GET /global/event | 1 | SSE |
| GET /provider | 1 | all, connected, default (v1 provider list) |

Step b (Add project picker, then project route, then new-session draft):

| Route | Count | Response top-level keys |
| --- | --- | --- |
| GET /find/file?query=&dirs=true&limit=50&directory=~ | 1 | list |
| GET /file?path=&directory=<each typed prefix> | 14 | list of entries |
| GET /global/health, GET /global/config, GET /path | 1, 1, 2 | as above (re-probe when the project scope opens) |
| GET /api/health | 2 | healthy |
| GET /project/current?directory | 2 | id, worktree, vcs, time, sandboxes |
| GET /lsp?directory | 1 | list |
| GET /mcp?directory | 2 | map of mcp name to status |
| GET /command?directory | 2 | list |
| GET /experimental/resource?directory | 2 | {} |
| GET /agent?directory | 2 | list of v1 Agent |
| GET /api/reference?directory&location[directory] | 2 | location, data |
| GET /session/status | 3 | {} |
| GET /session?directory&roots=true&limit=55 | 2 | list of v1 Session |
| GET /config?directory | 2 | $schema, command, plugin, model, username, mode, agent, mcp, permission |
| GET /provider (and ?directory) | 5 | all, connected, default |
| GET /permission?directory | 2 | list |
| GET /vcs?directory | 2 | branch, default_branch |
| GET /question?directory | 2 | list |
| GET /global/event | 1 | SSE (second stream) |
| GET /project | 1 | list |

Step c (first prompt creates the session):

| Route | Count | Response |
| --- | --- | --- |
| POST /session?directory (no body) | 1 | v1 Session {id, slug, projectID, directory, path, cost, tokens, title, version, time} |
| GET /session/:id/message?limit=20 | 1 | list (empty) |
| GET /session/:id | 1 | v1 Session |
| POST /session/:id/prompt_async | 1 | 204. Body `{messageID, agent: "build", model: {modelID, providerID}, parts: [{id, type: "text", text}]}` |
| GET /session/:id/todo | 1 | list |
| GET /api/health | 1 | healthy |

Step d (tool call with permission):

| Route | Count | Response |
| --- | --- | --- |
| POST /session/:id/prompt_async | 1 | 204 |
| GET /session/:id/todo | 3 | list |
| POST /session/:id/permissions/:permissionID?directory | 1 | `true`. Body `{response: "once"}` |
| GET /api/health | 7 | healthy (10 s poll) |

Step e: POST /session/:id/prompt_async, GET /session/:id/todo.

Step f (reload): the step a and step b bootstrap again (`/global/health`, `/api/health`, `/global/config`, `/path`, `/session/status`, `/global/event`, `/project`, `/provider`, `/lsp`, `/agent`, `/api/reference`, `/experimental/resource`, `/mcp`, `/config`, `/vcs`, `/command`, `/permission`, `/question`, `/session?directory&roots=true&limit=55`) plus `GET /session/:id` x2 and `GET /session/:id/message?limit=20` -> list of 8 `{info, parts}` items, newest last. `info` keys: id, sessionID, role, time, summary, agent, model (assistant adds cost, tokens, path, finish). Part types seen: text, tool, step-start, step-finish, reasoning. A tool part is `{id, sessionID, messageID, type: "tool", callID, tool: "read" | "bash", state: {status: "completed", input, output, title, metadata, time}}`.

Step g: `PATCH /session/:id` body `{title}` -> v1 Session.

Step h: `GET /api/session?limit=5000&order=desc`, `GET /session/:id`, `GET /command`, `GET /mcp`, `GET /experimental/resource`. Step h2: `GET /vcs/diff?mode=git&directory` -> list.

Routes the research doc lists that the app never called in v1 mode: `/session/:id/abort`, `/event` (it uses `/global/event`), `/permission/:id/reply` (it uses `/session/:id/permissions/:id`), `/session/:id/message` POST.

## Run A: events per step (v1 `/global/event`)

Every line is `{directory, project, payload: {id: "evt_...", type, properties}}`; `server.connected` and `server.heartbeat` carry only `payload`. Distinct types after dedupe, in first-seen order:

| Step | Type | properties keys |
| --- | --- | --- |
| a | server.connected | {} |
| a | server.heartbeat | {} (every 15 s, plus an SSE comment line `: heartbeat`) |
| b | project.updated | id, worktree, time, sandboxes |
| b | plugin.added | id (one per plugin per directory the picker touched, 288 unique) |
| b | catalog.updated, reference.updated, integration.updated | {} |
| c | session.created | sessionID, info |
| c | sync | syncEvent {id, type: "session.created.1", seq, aggregateID, data} (a durable-stream mirror of the same event; also `session.next.prompt.admitted.1`, `session.next.step.started.1`, and so on) |
| c | session.updated | sessionID, info (title, agent, model, tokens, cost) |
| c | message.updated | sessionID, info (message header, role user or assistant) |
| c | message.part.updated | sessionID, part, time |
| c | session.status | sessionID, status {type: "busy" or "idle"} |
| c | session.diff | sessionID, diff |
| c | message.part.delta | sessionID, messageID, partID, field: "text", delta |
| c | session.idle | sessionID |
| d | permission.asked | id, sessionID, permission: "bash", patterns ["ls -la"], metadata {command}, always ["ls *"], tool {messageID, callID} |
| d | permission.replied | sessionID, requestID, reply: "once" |
| g | session.updated | sessionID, info (new title) |

Samples (trimmed):

```
{"payload":{"id":"evt_0b1805b70001VJqkZblpB2VoQP","type":"server.connected","properties":{}}}
{"directory":"<dir>","project":"1ef43ea1...","payload":{"id":"evt_0b180b0cd002...","type":"session.created","properties":{"sessionID":"ses_f4e7f4f32ffe...","info":{"id":"ses_f4e7f4f32ffe...","slug":"happy-falcon","version":"1.18.31","projectID":"1ef43ea1...","directory":"<dir>","path":"","title":"New session - 2026-09-17T22:33:16.237Z","cost":0,"tokens":{"input":0,"output":0,"reasoning":0,"cache":{"read":0,"write":0}},"time":{"created":1789684396237,"updated":1789684396237}}}}}
{"directory":"<dir>","project":"...","payload":{"type":"sync","syncEvent":{"id":"evt_0b180b0cd002...","type":"session.created.1","seq":0,"aggregateID":"ses_f4e7f4f32ffe...","data":{"sessionID":"...","info":{...}}},"id":"evt_0b180b0cd002..."}}
{"directory":"<dir>","project":"...","payload":{"id":"evt_0b180b10b001...","type":"message.updated","properties":{"sessionID":"ses_...","info":{"id":"msg_0b180b0f7001...","role":"user","sessionID":"ses_...","time":{"created":1789684396296},"agent":"build","model":{"providerID":"opencode","modelID":"big-pickle"}}}}}
{"directory":"<dir>","project":"...","payload":{"id":"evt_0b180b11b001...","type":"message.part.updated","properties":{"sessionID":"ses_...","part":{"id":"prt_0b180b0f8001...","type":"text","text":"Read package.json and tell me the name field.","messageID":"msg_...","sessionID":"ses_..."},"time":1789684396315}}}
{"directory":"<dir>","project":"...","payload":{"id":"evt_0b180b12c001...","type":"session.status","properties":{"sessionID":"ses_...","status":{"type":"busy"}}}}
{"directory":"<dir>","project":"...","payload":{"id":"evt_0b180b80a001...","type":"message.part.delta","properties":{"sessionID":"ses_...","messageID":"msg_...","partID":"prt_...","field":"text","delta":"I"}}}
{"directory":"<dir>","project":"...","payload":{"id":"evt_0b180b1f8001...","type":"session.diff","properties":{"sessionID":"ses_...","diff":[]}}}
{"directory":"<dir>","project":"...","payload":{"id":"evt_0b180bfb4002...","type":"session.idle","properties":{"sessionID":"ses_..."}}}
{"directory":"<dir>","project":"...","payload":{"id":"evt_0b180d159002...","type":"permission.asked","properties":{"id":"per_0b180d159001...","sessionID":"ses_...","permission":"bash","patterns":["ls -la"],"metadata":{"command":"ls -la"},"always":["ls *"],"tool":{"messageID":"msg_0b180cc99001...","callID":"call_7b8dfc1458d5460babef5b1a"}}}}
{"directory":"<dir>","project":"...","payload":{"id":"evt_0b181bd42001...","type":"permission.replied","properties":{"sessionID":"ses_...","requestID":"per_0b180d159001...","reply":"once"}}}
{"directory":"global","project":"global","payload":{"type":"project.updated","properties":{"id":"global","worktree":"/","time":{...},"sandboxes":[]},"id":"evt_..."}}
{"directory":"<other dir>","project":"global","payload":{"id":"evt_...","type":"plugin.added","properties":{"id":"core/config-reference"}}}
```

## Run F: routes and events per step (forced v2 with shims, main from source)

Bootstrap in step a: `GET /global/health` (proxy 404), `GET /api/health` -> `{healthy, pid}` (pid injected), `GET /api/session?limit=5000&order=desc` -> `{data, cursor}`, `GET /api/project` (shim), `GET /api/event` (SSE), `GET /api/session/active` -> `{data: {}}`, `GET /api/model/default` (shim), `GET /api/model` -> `{location, data: [Model.Info]}`, `GET /api/provider` -> `{location, data: [{id, name, api, request}]}`.

Step b (picker then project scope): `GET /api/fs/list?location[directory]` x12, `GET /lsp?directory` (a v1 route, still called), `GET /api/project/current` (shim), `GET /api/mcp`, `GET /api/mcp/resource` (shims), `GET /api/event` (second stream), `GET /api/session?limit=55&order=desc&parentID=null&directory=<dir>` -> `{data, cursor}`, `GET /api/session/active`, `GET /api/reference`, `GET /api/provider`, `GET /api/command`, `GET /api/model`, `GET /api/model/default`, `GET /api/agent` (patched), `GET /api/permission/request`, `GET /api/question/request`. All located responses are `{location: {directory, project: {id, directory}}, data}`.

Step c: `POST /api/session` body `{agent: "build", model: {id, providerID}, location: {directory}}` -> `{data: SessionV2.Info}` with keys id, projectID, agent, model, cost, tokens, time, title, location. `GET /api/session/:id` -> `{data}`. `GET /api/session/:id/message?limit=20&order=desc` -> `{data, cursor}`. `POST /api/session/:id/prompt`: the app sends `{id, text, files: [], agents: []}`; main answers 400 `{"_tag":"InvalidRequestError","message":"Missing key\n  at [\"prompt\"]","kind":"Payload"}`. With the proxy wrapping it as `{id, prompt: {text}}` main answers 200 `{data: {admittedSeq, id, sessionID, prompt: {text}, delivery: "steer", timeCreated}}`. Note the app posted twice because `/new-session` had two drafts; the second session is the one the tab shows.

Steps d, e: `POST /api/session/:id/prompt` -> 200 (wrapped). No permission card, because main's turn failed at the provider (below). `GET /api/health` polled at 1 s while the app believes the session is busy.

Step f (reload): same as a plus b, plus `GET /api/session/:id` x3 and `GET /api/session/:id/message?limit=20&order=desc` x3 -> `{data: [SessionMessage], cursor}`; user items `{id, time, text, type: "user"}`, assistant items `{id, time, type: "assistant", agent, model, content: [], snapshot: {start}, finish: "error", error: {type: "unknown", message}}`.

Step g: `POST /api/session/:id/rename` body `{title}` -> main returns the SPA index.html (route absent on main; the vendored client expects 204).

Step h: `GET /api/session?limit=5000&order=desc`.

Events on `/api/event` (main): envelope `{id: "evt_...", type, data}` and, for session events, `durable: {aggregateID, seq, version}` and `location: {directory}`. Types seen: `server.connected {}`, `plugin.added {id}`, `catalog.updated {}`, `reference.updated {}`, `integration.updated {}`, `session.created {sessionID, info}`, `session.next.prompt.admitted {timestamp, sessionID, messageID, prompt, delivery}`, `session.next.prompted {same}`, `session.next.step.started {timestamp, sessionID, assistantMessageID, agent, model, snapshot}`, `session.next.step.failed {timestamp, sessionID, assistantMessageID, error {type, message}}`. Heartbeat is the SSE comment `: heartbeat`, not an event.

```
{"id":"evt_0b1970c5e001QlAIViznSEC5o6","type":"session.next.prompt.admitted","durable":{"aggregateID":"ses_f4e68f6e4ffe...","seq":1,"version":1},"location":{"directory":"<dir>"},"data":{"timestamp":1789685861470,"sessionID":"ses_...","messageID":"msg_0b1970c2a001...","prompt":{"text":"Read package.json and tell me the name field."},"delivery":"steer"}}
{"id":"evt_0b197173e00217v1329m84S6iQ","type":"session.next.step.started","durable":{"aggregateID":"ses_...","seq":3,"version":1},"location":{"directory":"<dir>"},"data":{"timestamp":1789685864254,"sessionID":"ses_...","assistantMessageID":"msg_0b197173e001...","agent":"build","model":{"id":"big-pickle","providerID":"opencode","variant":"default"},"snapshot":"cc67eb20..."}}
{"id":"evt_0b1971740001TCdJcn3ioPmAHV","type":"session.next.step.failed","durable":{"aggregateID":"ses_...","seq":4,"version":2},"location":{"directory":"<dir>"},"data":{"timestamp":1789685864256,"sessionID":"ses_...","assistantMessageID":"msg_...","error":{"type":"unknown","message":"Provider request failed with HTTP 403: {\"type\":\"error\",\"error\":{\"type\":\"FreeTierError\",\"message\":\"Error from provider (Console): OpenCode's free tier can only be used from within OpenCode\"}}"}}}
```

Why the v2 turn stopped there: main run from source is not an official build, and OpenCode Zen refuses the free seat with `FreeTierError`. No other seat key was configured for this trace (ANTHROPIC_API_KEY and AI_GATEWAY_API_KEY are unset in the shell; OPENAI_API_KEY is set but was not wired into the trace project, and the point of the run was the protocol, not the model). So the v2 text, tool, permission, and usage events were not observed live. The reducer the hosted app ships (`packages/app/src/context/server-session-v2-reducer.ts`, and the vendored client's `types.d.ts`) names them `session.input.admitted`, `session.step.started`, `session.text.delta`, `session.tool.called`, `session.tool.success`, `session.execution.*`, `session.usage.updated`, `session.renamed`, `permission.v2.asked`; the string `session.next.` occurs in the hosted bundle only as `session.next.moved` and `session.next.unseen`.

## Discrepancies against research.html 3.3 and 3.4 and design.html 6

Research 3.2 (protocol probe):

1. "The app probes GET /api/health first" is wrong. It probes `/global/health` first and picks v1 when that answers `{healthy: true}`. `/api/health` is consulted second and must carry a numeric `pid` to select v2. Consequence for our server: do not serve `/global/health` at all (or return non-200), and return `{healthy: true, version, pid}` from `/api/health`. Design 6 already lists `pid` in the health answer; it must be a number.
2. "the app uses the v2 client and falls back to legacy shims only for a few calls" describes the code path, but against every shipping server (1.18.31 and main) the app runs v1 end to end. A v2-only server is the first server the hosted app will ever run in v2 mode; the mock server in `packages/app/e2e/utils/mock-server.ts` is the only existing v2 peer, and it answers every unknown route with `{}`.

Research 3.3 (routes):

3. Missing routes the v2 app calls on boot: `GET /api/model/default` (expects `{location, data: Model.Info | null}`), `GET /api/project` (expects a bare `Project[]`, not a located object), `GET /api/project/current?location[directory]` (expects `{id, directory}`), `GET /api/mcp` (expects `{location, data: []}`), `GET /api/mcp/resource` (expects `{location, data: {resources: [], templates: []}}`). Without them the bootstrap throws and the composer has no model. None of these exist in `packages/protocol/src/groups/*` at 5a83358; the app's vendored client 1.17.13-v2 is ahead of the protocol package in the same checkout.
4. Missing route: `GET /api/session/active` is listed, but the app also calls `GET /lsp?directory=...` (a v1 route) in v2 mode, from the file tree and the review panel. It tolerates a 404 there.
5. `GET /api/health` is polled every 10 s when idle and every 1 s while a session is busy (30 calls during step d). Design 6 should say the route is hot and cheap.
6. `GET /api/location`, `/api/path`, `/api/vcs` were not called in v2 mode. `/api/vcs/diff` and `/api/vcs/status` are in the client table; only `/vcs/diff` (v1) was exercised, by Toggle review.
7. `POST /api/session/:id/prompt` body: the app sends the flat `{id, text, files, agents, metadata?, delivery?, resume?}` (vendored client `client.js` line 270). The research table and main's protocol say `{prompt: {text, files?, agents?}, agent?, model?}`; main rejects the app's body with 400 `Missing key at ["prompt"]`. Our server must accept the flat body. Accept both shapes to stay compatible with main's client generation as well. The success answer main gives is `{data: {admittedSeq, id, sessionID, prompt, delivery, timeCreated}}`; the vendored client expects status 200 (`successStatus: 200, empty: false`), so 204 would break it.
8. `POST /api/session/:id/rename` body `{title}` must answer 204 (`successStatus: 204` in the client). Main does not implement it and answers with index.html. `POST /api/session/:id/archive` and `/interrupt` follow the same 204 rule. Research says "actions 204", which matches the client.
9. `POST /api/session` body from the app is `{agent, model: {id, providerID}, location: {directory}}` with no `id`; the app picks the model from `/api/model/default`, else the first non-deprecated model of the first provider. With `data: null` it chose `google/gemini-3.8-flash`, not the configured `opencode/big-pickle`, because `/config` is not read in v2 mode. Our server must return its seat from `/api/model/default`.
10. `GET /api/session` from the home view has no `directory` and `limit=5000`; from the project view it has `limit=55&order=desc&parentID=null&directory=...`. `parentID=null` is a literal string that means top-level sessions only. The research table lists `directory, limit, order, search, cursor` and omits `parentID`. Main's cursor values are base64url JSON `{order, anchor: {id, time, direction}}` and both `next` and `previous` are returned; design 6 says "cursor = base64 of the anchor", which matches.
11. `GET /api/session/:id/message` query is `limit=20&order=desc` (research lists `limit, cursor` only) and the answer is `{data, cursor}`. Main's assistant item has `snapshot: {start}` and `finish: "error"` plus `error`; the research SessionMessage shape omits `snapshot` and `finish`.
12. `GET /api/agent` items must include `name` and `request: {settings, headers, body}`; `permissions` is a list of `{action, resource, effect}`. Main's items lack `request.settings` and `name`, which crashes the app. Design 6 says "permissions empty", which is fine; add `name` and `request.settings: {}`.
13. `GET /api/provider` items are `{id, name, api: {type, package, url?}, request: {headers, body}}` and `GET /api/model` items are `{id, providerID, name, api, capabilities: {tools, input, output}, request, variants, time: {released}, cost: [{input, output, cache: {read, write}, tier?}], status, limit?, settings?, headers?, family?, package?}`. The app reads `model.cost.find`, `model.capabilities.input`, `model.variants.map`, `model.time.released`, so all of those are required, not optional. Design 6 lists `{id, providerID}` only, which will crash `normalizeProviderList`.
14. The v1 permission reply route is `POST /session/:id/permissions/:permissionID` with `{response}`; the v2 one is `POST /api/session/:id/permission/:requestID/reply` with `{reply, message?}`. Research 3.3 has the v2 route right. The v2 permission request shape (`GET /api/permission/request` and `permission.v2.asked`) was not observed live because main never reached a tool call; the client's `types.d.ts` in the vendored tarball is the oracle for it.
15. In v1 mode the app also hits `GET /api/session?limit=5000&order=desc` and `GET /api/reference?directory&location[directory]` and `GET /api/health`; a v2-only server therefore also gets those calls from v1-mode clients, which is harmless.

Research 3.4 (events):

16. Main's `/api/event` emits `session.next.prompt.admitted`, `session.next.prompted`, `session.next.step.started`, `session.next.step.failed` (and by the schema in `packages/schema/src/session-event.ts`: `session.next.text.*`, `session.next.reasoning.*`, `session.next.tool.*`, `session.next.retried`, `session.next.compaction.*`, `session.next.revert.*`, `session.next.shell.*`, `session.next.synthetic`, `session.next.model.switched`, `session.next.agent.switched`, `session.next.context.updated`, `session.next.moved`). The hosted app's reducer and vendored client fold `session.input.admitted`, `session.step.started` and so on without `.next`. Research 3.4 says the `.next` names are only on the legacy `/event` stream of 1.18.31; they are on main's `/api/event` too. Our server should emit the names the app folds (research 3.4's table), and can skip `session.next.prompted` (the app has no handler for it). The `sync` event on the v1 `/global/event` stream carries `syncEvent.type` like `session.next.prompt.admitted.1`, which is where the durable names come from.
17. Envelope: main's v2 events carry `durable: {aggregateID, seq, version}` and `location: {directory}` on session events; `created` is absent. Research 3.4 says `{id, created, type, data, location?, durable?}`; drop `created` from the contract or make it optional. Design 6.1 says `durable: {aggregateID: sessionID, seq, version: 1}`; main uses `version: 2` on `step.failed`, so version is per event type, not a constant.
18. `session.execution.started` and friends, `session.usage.updated`, `session.renamed`, `session.tool.*`, `session.text.*`, `permission.v2.asked`, `todo.updated` were not observed (no completed turn in v2). The v1 trace shows the equivalents the app renders today: `session.status {busy|idle}`, `session.idle`, `session.updated` (title, tokens, cost), `message.updated`, `message.part.updated` (tool parts with `state.status`), `message.part.delta {field: "text"}`, `permission.asked {id, sessionID, permission, patterns, metadata, always, tool}`, `permission.replied`.
19. Heartbeat: both streams send the SSE comment `: heartbeat`; the v1 stream additionally sends a `server.heartbeat` event. Design 6 says "heartbeat comment every 15 s", which matches the comment.
20. `session.created` on main carries `data: {sessionID, info}` with `info.version: "local"` and `info.slug`; research says `{info}` only.

Design 6 and 8 (our behavior):

21. Design 8 "App cannot reach localhost (mixed content)": the actual blocker in Chromium 151 is Local Network Access permission for `https://app.opencode.ai` to reach `http://localhost:4096`, not mixed content (Chrome allows http localhost from https pages). Headless denies it outright; headed Chrome prompts. The banner copy should say to allow the local network permission prompt.
22. Design 6 `GET /api/location, /api/path, /api/project, /api/project/current, /api/vcs`: the app calls `/api/project` (bare list) and `/api/project/current` (`{id, directory}`), and does not need `/api/location`, `/api/path`, `/api/vcs` for boot.
23. Design 6 "POST /api/session/:id/prompt returns 200 at once": keep 200, and return `{data: SessionInput.Admitted}` (see item 7), not an empty body.
24. Design 6 sessions "newest first, cursor = base64 of the anchor": also honor `parentID=null` and the no-directory home query (item 10).
25. The hosted app expects `/api/session/:id/message` items in reverse chronological order (`order=desc`) and pages with `cursor.next`.

## Environment facts recorded during the run

- Playwright 1.62.1 from `apps/app/node_modules`, chromium 151.0.7922.34. Chrome Local Network Access must be disabled by flag in headless.
- The picker's Enter key selects the first fuzzy match, which added `~/.agent` as a project in the app's localStorage; the app persists projects and the last server in `localStorage` key `opencode.global.dat:server`.
- `bun install` for the OpenCode monorepo at 5a83358 takes 76 s (4703 packages) and `bun run packages/opencode/src/index.ts serve` boots in about 20 s.
- The 1.18.31 server lists sessions from every project it has ever seen in `GET /api/session` without a `directory` filter.

Raw captures (requests*.ndjson, events*.ndjson, openapi-1.18.31.json, shots/) were moved out of the repo to the session scratchpad trace-raw/ on 2026-09-17 to keep evidence out of git history. The scripts and this summary stay.

# Bug reports

A person reports a bug from any page in a few words, and the deployment's Admins and agents read it with the ids that find it in our records. Will, 2026-10-25: "Can we add an in app bug report feature?" It is how he reports what he finds while using smithers.sh for a day, and how the lead, an agent, finds and fixes it.

Will, Telegram 2026-10-25 19:45: "Can we add an in app way of reporting bugs in the app to the Smithers team? It should be built into our general observability on frontend so the agent adding this can do a general sweep to make sure we collect good metrics especially on errors". So a report carries the tab's latest error records, taken from the same records the tab relays to ChatApi ([below](#what-a-report-carries)).

## Doors

| Door | What it does |
|---|---|
| `/bug` in the composer | opens the form (`/app/bugs/report`) |
| **Report a bug** in the header | opens the form |
| The agent: "report a bug: the run page stays blank" | runs `app/bug/report` with the person's words |
| `/bugs`, or a report's entry in the bell | opens the inbox (`/app/bugs`) |

All of them are the first-party plugin `plugins/bugs/` on the public plugin interface ([plugins](plugins.md), decision 0017): its manifest binds the commands, the header's slot, the form and the inbox to the core's flows. The flows are the core's (`app/bug/report`, `app/bug/list`), because a plugin can't own an `app/` flow and the UI host doesn't run owned flows yet.

## The form

A signed-out visitor sees **Sign in with GitHub**, returning to the report page. Send still requires a session.

One field, **What happened?**, and **Send**. A whitespace-only report stays in the field with **Write what happened** and sends nothing. Send runs the form's `send` event, which the manifest binds to `app/bug/report`. The form says **Sending** until the report's row comes back from Postgres through sync, then **Sent** and **Open on GitHub**, and the field starts empty. A report filed offline is sent when the device is back, for an hour.

A report that isn't sent never stays **Sending**. The form hears how the run ended (`PluginHost.dispatch`'s `settled`, [plugins](plugins.md#the-host-contract)) and says **Not sent** with the reason: `signed out` (401), `not allowed`, `not accepted` (ChatApi refused the report, or the host refused the press), `too long`, `couldn't reach Smithers` (an hour offline), else the failure's code. The words stay in the field and the button says **Retry**: the same words file the same report again under its id, so a retry never makes a second copy; changed words are a new report.

## What a report carries

```
the person's words ─────────────────────────────┐
the tab that asked (src/features/bugs/tab.ts):  │
  the page before the form    /octocat/Spoon-Knife/issues
  its repository              octocat/Spoon-Knife
  the build                   38569d55ad79         (dev/build.ts)
  its latest 20 run ids, trace ids, failure codes  (src/flows/history.ts)
  its latest 30 error records                       (src/flows/errors.ts)
  the browser and the window  Mozilla/5.0 …, 1280x800
ChatApi, from the session:    the reporter's id, login and role; `agent` when the agent filed it
```

- **Never** a message, an answer, a flow's payload, a page's text or a credential. The tab's context is built from ids, codes and the window alone (`contextOf`), and every record of a report carries counts, never the words (OBS-5).
- **The tab that asked.** The report's first step asks over the engine's bug channel; only the tab whose request started the run answers (src/flows/askingTab.ts). The agent's call belongs to the answer whose tab asked, so it names that tab's page. A tab that is gone leaves the report with `route: null` and `build: "unknown"`, and it is filed anyway.
- **The tab's history.** Every dispatch keeps its flow, run id, the trace id of its `flow.dispatch` span, its outcome and a failure's stable code, newest first, the latest 50, in the tab's memory (`TabHistory`). A trace id joins the person's words to the relayed browser records and the Worker's logs.
- **The tab's error records.** Beside the OTLP exporter that relays the tab's logs, spans and metrics to ChatApi (`src/boot.ts`), a logger and a tracer keep its latest 30 error records, newest first, in the tab's memory (`TabErrors`, `src/flows/errors.ts`): error- and warning-level log events by record name and stable code (the first of `errorCode`, `code`, `refusal`, `reason`, `error.type`, `exception.type`), failed `/api/` requests by method, path and status (`network` when no answer came), and uncaught errors and unhandled rejections (`page error`, `unhandled rejection`) by the error's name. Each has its trace id and time. A log event counts only when the relay keeps its record (`src/telemetry.ts`), and a code is a token without spaces: never a message, an argument, a URL's query or anything a person wrote. Every frontend error path logs and counts with a stable code (the `fe-errors` sweep), so the ring holds what went wrong. The inbox shows them as a table: time, kind, record, code and trace.

## The build

`vite.config.ts` names the build (`dev/build.ts`): `SMITHERS_BUILD` when a deploy sets it, else the checkout's jj revision (`@`'s parents when it is empty, as after `jj new main`, else `@` marked `+`), else `dev`. The bundle carries it as `__SMITHERS_BUILD__` and the site serves it at `/version.json`:

```
$ curl https://smithers.sh/version.json
{"build":"38569d55ad79"}
```

## The flows

```
app/bug/report { what, id? }                     a person's Send, /bug's form, the agent
  app/bug/report/context   asks the tab that asked what it shows; picks the id when the door chose none
  app/bug/report/send      POST /api/bugs; retried 500 ms doubling to 30 s for an hour; a 4xx but 408/429 is final
  answers { id, github }
app/bug/list { limit? }                          an Admin, the agent for an Admin
  app/bug/list/read        GET /api/bugs; tried 4 times
```

Both run on the device's engine. `app/bug/report` is model-invocable, and the agent runs it only when the person asks to report a bug; its answer's `github` is offered, never opened unasked. `app/bug/list` is a read, minimum Admin.

## The routes

| Route | Who | Answers |
|---|---|---|
| `POST /api/bugs` | anyone signed in, or the agent for them | `200 { id, txid }`; the same id again changes nothing; `401`, `400 invalid`, `413 too_large`, `409 conflict` (another person's id), `503 unavailable` |
| `GET /api/bugs?limit=` | an Admin, the agent for an Admin, or `Authorization: Bearer <BUG_REPORTS_READ_TOKEN>` | `200 { reports }`, newest first; `401`, `403` |
| `GET /api/shapes/bug-reports` | anyone signed in | every report for an Admin in person, a person's own for anyone else, none signed out |

ChatApi takes the reporter from the session, never the body. Filing starts `ops/BugReport` on its Durable Object (execution `bug-report-<id>`), and a start that fails answers `503`, so the device's step files it again.

**The read token** lets an agent outside the app, such as the lead, poll the inbox:

```
curl -H "Authorization: Bearer $BUG_REPORTS_READ_TOKEN" https://smithers.sh/api/bugs?limit=20
```

It reads reports and nothing else. Unset, that door is off.

## The Admins hear

`ops/BugReport { id }` (worker/flows/BugReport.ts) runs on a `FlowExecution` Durable Object:

1. **Bell.** One `bug` notification for every Admin with a live session: `Bug report · @codeplanesmithers · /octocat/Spoon-Knife/issues`, opening the inbox. It sits in the bell only, never a toast.
2. **Email and Telegram,** where an Admin set them ([spend alerts' channels](spend-alerts.md#channels)), through the shared `AlertDelivery`: one step per channel, a receipt in `alert_deliveries` under `bug-report-<id>`. The message says who and where and links to the inbox; never the words.

## The inbox

`/app/bugs` lists the reports the viewer may see, newest first: every report for an Admin, a person's own for anyone else. Each opens to its words, the page, the build, the reporter's role, the browser and window, the trace ids, run ids and failures, the report's id, and **Open on GitHub**.

## Open on GitHub

GitHub's own new-issue form, prefilled: the title is the first line of the words, the body the words, the report's id, the kind of page (`issues`, `file`, `app/runs`, never its path, which can name a private repository), the build, the first trace ids and failures, the browser and window. It opens on the repository the page showed, else `smithersai/smithers`. Opening the link sends the prefilled content to GitHub in the URL query. Creating an issue requires submitting GitHub's form under the person's own account (rulings GH-2, GH-11).

## Postgres

| Table | Columns | |
|---|---|---|
| `bug_reports` | `id` (uuid, key), `reporter_id`, `reporter_login`, `reporter_role`, `acted_by` (`agent`, `flow`, `app`, `sandbox` or null), `what` (1 to 4,000 characters), `route`, `repo`, `build`, `traces`, `runs`, `failures`, `errors` (jsonb), `browser`, `viewport`, `created_at` | one row per report; synced whole. Migrations `0064_bug_reports` and `0067_bug_report_errors` (`pnpm db:migrate`) |
| `notifications.kind` | adds `bug` | the same migration |

## Observability

ChatApi: `bug.request` and `smithers_bug_requests` (op, outcome, status), `bug.shape` and `smithers_bug_shape_requests`. `ops/BugReport`: `bug.report.bell`, `bug.report.delivery` and `smithers_bug_report_deliveries`. Browser: `bug.context` and `smithers_web_bug_contexts` (answered or gone, and how many ids), `bug.report` and `smithers_web_bug_reports` (filed, refused, unsent), `bug.list` and `smithers_web_bug_lists`, client spans `bug.file` and `bug.read`. The table is in [observability](../observability.md#bug-reports). None carries the words, a page, a login or a token.

## Files

| File | What it holds |
|---|---|
| `plugins/bugs/` | the plugin: manifest, tab (`core/bug-reports`, Send), the form, the inbox, the header's entry |
| `src/features/bugs/` | the contract, the schemas, the flows and steps, the tab's context, GitHub's form, the store |
| `src/flows/history.ts` | the tab's latest dispatches, kept by `makeDispatch` |
| `src/flows/errors.ts` | the tab's latest error records, kept by a logger and a tracer beside the OTLP exporter |
| `dev/build.ts` | the build's name and `/version.json` |
| `worker/bugs/Api.ts` | the routes and the shape |
| `worker/flows/BugReport.ts` | `ops/BugReport`: the bell and the deliveries |

## Tests

| Test | Proves |
|---|---|
| `src/features/bugs/bugs.test.ts` | the page before the form, its repository, the ids kept and left out, GitHub's form; the tab that asked answers over the real bug channel and another tab's request gets none |
| `src/features/bugs/api.test.ts` | the client against every answer the routes give; the flows on the Node host: filed with what the step knows when the tab is gone, refused once, retried while offline; their records without the words |
| `src/flows/errors.test.ts` | the records a log event and an ended span become; the ring over Effect's HTTP client with an injected failing `fetch` (TEST-7): a 503 and no network kept by method, path and code, an error log with its trace, a page error by its name, newest first, at most 30; never a message, a non-code annotation or a query |
| `src/flows/dispatch.test.ts` "this tab's history" | each dispatch's run, trace, outcome and code, newest first, never its payload |
| `plugins/bugs/src/tab.test.ts` | the form's words and when a Send is Sent; over an injected host whose runs fail (TEST-7): Not sent with the reason, the words kept, Retry under the same id, new words a new report, a refused press |
| `src/plugins/plugins.test.ts` "how a plugin's run ended" | `settled` for a run done, a declared failure's code or kind, dispatch's refusal or reason, interrupted, a defect; never a message |
| `src/features/bugs/device.test.ts` | on real devices: a report refused for good (a NUL, which this Node device's Postgres journal refuses) is Not sent and keeps its words, nothing filed; a Member's Send files with the page before the form and comes back Sent; a Member is refused the read; an Admin sees every report and reads it |
| `dev/build.test.ts` | the build's name, and the Vite plugin built for real |
| `worker/bugs/Api.test.ts`, `worker/flows/BugReport.test.ts` | the routes, the shape and `ops/BugReport` against the compose Postgres and Electric |
| `e2e/bug-report.spec.ts` | `/bug`, the words and Send: Sent, the inbox lists it, and an Admin reads it with its page and runs and none of the chat; locally and against a deployment (the Admin read needs `E2E_BUG_READ_TOKEN` there) |

## Not built

- **The screenshot.** The form has no "include a screenshot" toggle yet: capturing only the page's own render needs a DOM-to-image library behind an Effect wrapper in `@smthrs/platform-browser`.

Repository home links to `/bug` open `/app/bugs/report`, both on a direct visit through the docs site and through the app's router. They never prepare a GitHub issue. The report's build must match `/version.json`.

HTTP error records keep route templates, never repository or file names. GitHub prefill also templates HTTP names from reports filed by older builds. `bug-report-privacy.spec.ts` checks a failed repository read through the report form.

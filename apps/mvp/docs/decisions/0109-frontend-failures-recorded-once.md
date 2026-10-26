# 0109 — Every frontend failure is recorded once, with a code

Date: 2026-10-25

Status: Accepted

## Context

Will (Telegram, 2026-10-25 19:45): in-app bug reports "built into our general observability on frontend so the agent adding this can do a general sweep to make sure we collect good metrics especially on errors". The same day, GitHub's shape requests answered 500 for a day and no browser record counted it: Electric's client sends a failed request again by itself, quietly. A sweep of every failure handler in the browser app found about 120 that swallowed a failure, logged it only to the console, or logged it without a code.

## Decision

- **A failure is a log line, and the log counts it.** Each failure logs once, at Warn or Error, with a stable record name and a code (`errorCode`, `reason`, `outcome`, ...), never a message. `@smthrs/observability`'s `LogFailures`, installed in the tab and the engine worker, counts every such line by record, code and feature (`flows_observability_log_failures`) and keeps the latest for a bug report (`LogFailures.Recent`). There is no counter per call site.
- **Failed requests are recorded where the fetch is.** `FetchFailures` wraps the `fetch` every Effect `HttpClient` and Electric's shape source send through, so a client that retries quietly still leaves a record: one line per run of failures of one request, a count of every failure by route template, status class and whether it was a retry. Route templates come from a closed list of the app's route words, so no repository or id is recorded.
- **Every context reports what nothing caught.** The page logs uncaught errors and rejections; `BrowserRuntime.run` does in the engine worker; React's root hooks report render errors; the service worker, which Workbox generates and which runs no app code, is observed from the page (registration, install, update checks). An Effect run outside the program goes through `runners` (`src/boundary.ts`), which logs a defect, and a fork's failure, as `app.unhandled`.
- **The rule is a lint rule.** `frontend/failure-observed` (`eslint.frontend-failures.js`) fails a `catch`, `.catch`, Effect `catch*` or `onError` handler that neither logs nor rethrows, unless it says why: `// expected: <reason>` or `// recorded: <record>`.

## Consequences

A new failure path needs one log line with a code, and the lint rule asks for it. Dashboards and bug reports read one counter for every failure. A body that breaks off after a 2xx, the language worker's own console (it has no exporter) and a first-party plugin's forked runner (`@smthrs/plugin` has no recording runner yet) are still unrecorded; the inventory in the 2026-10-25 sweep lists each.

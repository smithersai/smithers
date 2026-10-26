---
title: Report a bug and read diagnostics from the app
status: in-progress
area: app
owner: bug-report
updated: 2026-10-25
links: [../features/bugs.md, old-app-feature-gaps.md, observability.md, web-page-flow.md, device-data-recovery.md, ../../../../AGENTS.md]
---

## What

A person reports a bug with the ids we need to find it, and admins read the app's own state.

Will, Telegram 2026-10-25 17:38 PDT: "Can we add an in app bug report feature?" He uses smithers.sh for a day and reports what he finds this way; the lead (an agent) reads the inbox and fixes from it.

## Built (2026-10-25)

[Bug reports](../features/bugs.md): the first-party plugin `plugins/bugs/` over the core's `app/bug/report` and `app/bug/list`.

- **Doors:** `/bug`, the header's Report a bug, and the agent ("report a bug: …") file a report; `/bugs` and the bell open the inbox.
- **Stored:** Postgres `bug_reports` (migration 0063): the person's words, the page before the form, its repository, the build, the tab's latest run ids, trace ids and failure codes, the browser and window, and the reporter's id, login and role from the session. Never chat, a payload or a credential.
- **Admins hear:** `ops/BugReport` puts a `bug` notice in every Admin's bell and sends email and Telegram where configured.
- **Read:** an Admin's inbox at `/app/bugs` (a person sees their own), `app/bug/list`, and `GET /api/bugs` with `BUG_REPORTS_READ_TOKEN` for an agent outside the app.
- **Open on GitHub:** GitHub's prefilled new-issue form on the page's repository, else smithersai/smithers; nothing reaches GitHub without the person's submit.
- **The build:** `/version.json` and the bundle name the deployed revision (`dev/build.ts`).

## Left

- Deploy, set `BUG_REPORTS_READ_TOKEN` in production's environment, and run `e2e/bug-report.spec.ts` against smithers.sh with `E2E_BUG_READ_TOKEN`.
- The "include a screenshot" toggle: needs a DOM-to-image library behind an Effect wrapper in `@smthrs/platform-browser`.
- Old app parity still open: Failure Details with the code and trace id, `debug.errors`, Admin dev tools, `/debug-api`, the startup watchdog.

## Old app

- **`/bug`:** opened a prefilled GitHub new-issue form (default `smithersai/smithers`) with the route kind, the build, the failure code and the correlation id (`apps/app/src/mainview/BugReport.ts`, `flows/entries/bug.ts`). Kept: the route kind, never the path, in a public issue.
- **Failure details:** each failure is one sentence with buttons such as Retry, and its raw text sits behind Details (`FailureNotice.tsx`, `FailureDetails.tsx`).
- **`debug.errors`:** recent app errors and the toast history, dismissed toasts included (`flows/entries/debug.ts`).
- **Admin dev tools**, ⌘⇧D: store collections, transitions, network, tool calls, the flow registry and session facts (`DevtoolsPanel.tsx`).
- **`/debug-api`:** a console that calls the documented API, with a confirmation before writes (`cards/DebugApiCard.tsx`, `cards/views/DebugApiView.tsx`).
- **Startup failure screens:** a 60-second watchdog shows Retry or Reload instead of a blank page (`StartupError.tsx`, `StartupWatchdog.ts`).

`apps/bug-worker` (`bug.smithers.sh`) keeps the CLI's `smthrs bug` reports in KV; the app doesn't use it, because the app's reports live in Postgres beside its other rows and sync to Admins through Electric.

## Questions for Will

None.

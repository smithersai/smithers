# apps — E2E and canary test checklist

The complete set of end-to-end and canary tests the alpha needs, and what the
tree covers. Audited at `ceb784b6` on 2026-08-18; **remediated and re-audited at
`a6cab068`+ on 2026-08-19.**

Two kinds of test are catalogued, and they are not interchangeable:

- **E2E (`E*`)** — hermetic. Builds the SPA, boots `wrangler dev` against test
  doubles, drives a real browser. No live deployment, no credential, no model
  spend. Runs in CI on every push.
- **Canary (`CN*`)** — against a real deployment (`canary.smithers.sh`) and the
  nine backing Workers. Runs after every deploy and on a schedule. Needs
  credentials; may cost money.

Status legend: **PASS** an automated test asserts it end to end · **PART**
asserted only at unit level, only against a live target, or only in a script
that cannot run unattended · **GAP** nothing asserts it.

> **The row statuses below are the ORIGINAL 2026-08-18 audit and are now
> stale.** They are kept verbatim as the baseline this work was measured
> against. What was actually built, what it found, and what remains open is in
> `REMEDIATION.md` next to this file. Read that first.

## Summary

|        | Required | PASS | PART | GAP |
| ------ | -------: | ---: | ---: | --: |
| E2E    |      129 |   40 |   44 |  45 |
| Canary |       24 |   11 |    4 |   9 |

Read that as: of 129 required e2e tests, 40 are genuinely asserted end to end
today — and none of those 40 run in CI.

Unit tests are healthy and not the problem: 667 pass, 0 fail
(526 `apps/app`, 108 `apps/server`, 33 `packages/rpc`).

The problem is above unit level:

1. **No e2e or canary test runs in CI or in the deploy pipeline.** `ci.yml`
   runs `pnpm test`, which resolves to `bun test src` in each app — unit only.
   `apps-deploy.yml` runs no tests before deploying and no probe after.
2. **The desktop app has zero coverage of any kind.** The Electrobun binary is
   the shipped alpha artifact.
3. **The native sign-in handoff has zero server-side coverage.**
   `/api/auth/native/start` and `/api/auth/native/claim` appear only in the
   shared route table and in one client unit test against a mocked `fetch`.
4. **Three of the four e2e scripts cannot run unattended** — they need a
   hand-started dev server and a hardcoded macOS Chrome path.
5. **All five canary scripts are machine-bound** — they `createRequire` a
   Playwright install at a machine-local absolute path outside this
   repository. Playwright is not a dependency of any package in this repo.

---

# Part 1 — E2E (hermetic, CI-runnable)

## E1. Auth and entry — the one-page law

|       | Test                                                                                                     | Status  | Where                            |
| ----- | -------------------------------------------------------------------------------------------------------- | ------- | -------------------------------- |
| E1.1  | Signed-out load renders the chat: transcript + composer, no landing view                                 | PASS    | `worker-e2e.ts`                  |
| E1.2  | First Tab stop is `auth.sign-in`                                                                         | PART    | checklist A-1, live only         |
| E1.3  | Attempted send while signed out resolves to the calm sign-in reply; no turn POST                         | PASS    | `worker-e2e.ts`                  |
| E1.4  | `/api/auth/github/start` redirects to the authorize URL                                                  | PASS    | `worker-e2e.ts`, `index.test.ts` |
| E1.5  | Failed OAuth callback renders the honest chat message with retry                                         | PASS    | `worker-e2e.ts`                  |
| E1.6  | Failed OAuth keeps JSON + status for `Accept: application/json`                                          | PASS    | `worker-e2e.ts`                  |
| E1.7  | Non-allowlisted: request-access via the chat command; send states the waiting state                      | PASS    | `worker-e2e.ts`                  |
| E1.8  | Allowlisted session reaches a working chat                                                               | PASS    | `worker-e2e.ts`                  |
| E1.9  | **Sign-out** (`/api/auth/logout`) returns to the signed-out chat and clears the cookie                   | **GAP** | —                                |
| E1.10 | **Session expiry mid-session** surfaces in the chat, never a dead end or a silent 401 loop               | **GAP** | —                                |
| E1.11 | **Native sign-in handoff** (`/api/auth/native/start` → poll `/api/auth/native/claim` → session)          | **GAP** | client unit only, mocked fetch   |
| E1.12 | Native handoff claim is single-use and expires                                                           | **GAP** | —                                |
| E1.13 | Cross-origin API request refused 403 before any credential is spent                                      | PASS    | `worker-e2e.ts`                  |
| E1.14 | Admin surface answers signed-out probes byte-identically to an unknown route (404, never 403)            | PASS    | `worker-e2e.ts`                  |
| E1.15 | SPA served with COOP/COEP isolation headers                                                              | PASS    | `worker-e2e.ts`                  |
| E1.16 | Every seam 501s honestly when its upstream is unconfigured (gateway, identity, billing, approvals)     | PASS    | `worker-e2e.ts`                  |

## E2. First run and onboarding

|       | Test                                                                                           | Status  | Where                                                         |
| ----- | ---------------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------- |
| E2.1  | Never-chosen opens the repo chooser with the candidates inline                                 | PASS    | `worker-e2e.ts`                                               |
| E2.2  | Chooser confirm PUTs `via: onboarding`; the local mirror lands                                 | PASS    | `worker-e2e.ts`                                               |
| E2.3  | Agent-tool selection change: `via: agent`, embedded card, surface never changes                | PASS    | `worker-e2e.ts`                                               |
| E2.4  | **Slash `/repos.watch` reaches the same one command** (third trigger of the three-trigger law) | **GAP** | —                                                             |
| E2.5–E2.11 | ~~the recommendation card and its acts~~                                                | REMOVED | the recommendations feature was deleted 2026-08-24            |
| E2.12 | ~~First message cites repo-specific data~~                                                     | REMOVED | its subject (the digest) was deleted 2026-08-24               |
| E2.13 | **The first run asks ≤ 3 questions**                                                           | PART    | checklist A-7, live only                                      |
| E2.14 | **"$500 of usage on us" rendered exactly once while `introUsd` is unspent, zero times after**  | PART    | checklist A-5, live only                                      |
| E2.15 | **No clone / install / configure copy anywhere on the signed-in surface**                      | PART    | checklist A-4, live only                                      |
| E2.16 | **No card-shaped input and no card-collection copy anywhere**                                  | PART    | checklist A-6, live only                                      |
| E2.17 | **Sign-in to first useful message ≤ 90s**                                                      | PART    | checklist A-2, live only                                      |

## E3. Turn lifecycle

|       | Test                                                                                                      | Status  | Where                    |
| ----- | --------------------------------------------------------------------------------------------------------- | ------- | ------------------------ |
| E3.1  | One streamed turn completes delta → card → done                                                           | PASS    | `worker-e2e.ts`          |
| E3.2  | Cancel endpoint answers                                                                                   | PASS    | `worker-e2e.ts`          |
| E3.3  | Server-side kill mid-stream: `done:cancelled` never `done:stop`; late kill is not-found                   | PASS    | `worker-e2e.ts`          |
| E3.4  | The kill surfaces in the real client store as `interrupted` with the honest line; session returns to idle | PASS    | `worker-e2e.ts`          |
| E3.5  | Escape stops foreground work ≤ 1s with a statement of what stopped                                        | PART    | unit + checklist B-2     |
| E3.6  | **Close the browser mid-turn, reopen: conversation and in-flight work restored and correctly described**  | PART    | checklist B-1, live only |
| E3.7  | A never-finishing run goes honestly quiet with stop / retry                                               | PASS    | `worker-e2e.ts`          |
| E3.8  | Tool loop end to end: model → tool → registry → final text → act line                                     | PASS    | `worker-e2e.ts`          |
| E3.9  | **Turn failure renders the in-character bubble + `failed` status + system note**                          | **GAP** | —                        |
| E3.10 | **Retry on a failed turn resubmits the last user prompt**                                                 | **GAP** | —                        |
| E3.11 | **Interrupted partial message is retained, not discarded**                                                | **GAP** | —                        |
| E3.12 | **Turn-seam rate limit / abuse guard refuses honestly**                                                   | **GAP** | not implemented          |
| E3.13 | **`/api/model/stream` is session-gated and streams**                                                      | **GAP** | server unit only         |
| E3.14 | **`/api/tools/browser-fetch` refuses unsafe targets and answers safe ones**                               | **GAP** | server unit only         |

## E4. Cards and approvals

|       | Test                                                                                            | Status  | Where                      |
| ----- | ----------------------------------------------------------------------------------------------- | ------- | -------------------------- |
| E4.1  | `card` / `card.update` NDJSON frames validated; invalid dropped, unknown ignored                | PART    | `CardFrames.test.tsx` unit |
| E4.2  | Approval approve round trip with the Worker's identity injection                                | PASS    | `worker-e2e.ts`            |
| E4.3  | Approval deny round trip                                                                        | PASS    | `worker-e2e.ts`            |
| E4.4  | Forced approval failure surfaces honestly                                                       | PASS    | `worker-e2e.ts`            |
| E4.5  | **Blocked-on-approval state agrees across every surface — no RUNNING-vs-Blocked contradiction** | PART    | checklist F-6, live only   |
| E4.6  | **Result cards lead with the result**                                                           | PART    | checklist B-4, live only   |
| E4.7  | **No score / grade / number is user-facing**                                                    | PART    | checklist B-5, live only   |
| E4.8  | **A correction never renders as an error state**                                                | PART    | checklist B-6, live only   |
| E4.9  | **Zero rating prompts anywhere**                                                                | PART    | checklist B-7, live only   |
| E4.10 | **Decided card freezes with the decision stamp and cannot be re-decided**                       | **GAP** | —                          |
| E4.11 | **`card.maximize` is the user's act alone; an agent invocation renders the embedded card**      | PART    | `parity.test.ts` unit      |

## E5. Commands — 88 registered flows

|       | Test                                                                                                      | Status  | Where                       |
| ----- | --------------------------------------------------------------------------------------------------------- | ------- | --------------------------- |
| E5.1  | Every visible interactive affordance resolves to a named command reachable by `/name`                     | PART    | checklist C-1, live only    |
| E5.2  | `/` opens with the recommended command first; bare `/` + Enter runs it                                    | PART    | checklist C-2, live only    |
| E5.3  | **Exact-name precedence: `/flows` + Enter runs `flows`, never `flow.list`**                               | **GAP** | known defect U10, unfixed   |
| E5.4  | The whole section-A journey is completable keyboard-only                                                  | PART    | checklist C-3, live only    |
| E5.5  | Trigger axis: `trigger: user` commands are absent from the agent tool catalog                             | PART    | `parity.test.ts` unit       |
| E5.6  | An agent calling a user-only command gets an honest tool error naming the visible alternative             | PART    | `requirements.test.ts` unit |
| E5.7  | **Every one of the 88 commands has a registry-driven smoke invocation**                                   | **GAP** | ~6 exercised end to end     |
| E5.8  | **`/clear` sweeps the transcript into world notes, then clears; clears nothing on a failed sweep**        | **GAP** | —                           |
| E5.9  | Bare `reset` is an unknown command for a non-admin                                                        | PASS    | `worker-e2e.ts`             |
| E5.10 | Admin commands and chrome are undetectable to a non-admin                                                 | PASS    | `worker-e2e.ts`             |
| E5.11 | Admin journey: allowlist add with attribution, grant with fresh id, queue read, feedback log, health card | PASS    | `worker-e2e.ts`             |

## E6. Billing

|       | Test                                                                                                               | Status  | Where                                           |
| ----- | ------------------------------------------------------------------------------------------------------------------ | ------- | ----------------------------------------------- |
| E6.1  | Balance reads in dollars, billed as the user through the trusted-caller path                                       | PASS    | `worker-e2e.ts`                                 |
| E6.2  | Balance drains to $0 with `allowedToStartWork: false`                                                              | PASS    | `worker-e2e.ts`                                 |
| E6.3  | At $0, interactive chat keeps working (complimentary)                                                              | PART    | `ZeroBalanceLaunch.test.ts` unit; checklist D-4 |
| E6.4  | At $0, `flow.run` / `flow.create` short-circuit before any seam call and post the notice naming `/billing.upgrade` | PART    | unit only                                       |
| E6.5  | **No top-up / checkout / card-collection flow is exposed**                                                         | PART    | checklist D-3, live only                        |
| E6.6  | **`POST /api/admin/grant` rejects a call with no admin token (401)**                                               | PART    | checklist E-1, live only                        |
| E6.7  | **An untimestamped grant is refused (400 `timestamp_required`)**                                                   | PART    | checklist E-2, live only                        |
| E6.8  | **A grant with requester + timestamp credits exactly once (201, audit record)**                                    | PART    | checklist E-3, live only                        |
| E6.9  | **Replaying the same grant does not double-credit**                                                                | **GAP** | —                                               |
| E6.10 | **`/api/billing/usage` answers for a signed-in user and refuses signed out**                                       | **GAP** | —                                               |

## E7. Workflows in the conversation

|       | Test                                                                                             | Status  | Where            |
| ----- | ------------------------------------------------------------------------------------------------ | ------- | ---------------- |
| E7.1  | `POST /api/workflow/provision` provisions-or-resumes; idempotent on a second call                | PASS    | `worker-e2e.ts`  |
| E7.2  | No gateway credential ever reaches the browser                                                   | PASS    | `worker-e2e.ts`  |
| E7.3  | `listWorkflows` through the relay                                                                | PASS    | `worker-e2e.ts`  |
| E7.4  | create-flow launched with the user's own words                                               | UNTESTED | `worker-e2e.ts` covers the relay call; nobody has watched this door produce a flow on a real workspace |
| E7.5  | The embedded run card tracks the run live                                                        | PASS    | `worker-e2e.ts`  |
| E7.6  | Approval round trip through the relay                                                            | PASS    | `worker-e2e.ts`  |
| E7.7  | Auto-resume to a result stated in words                                                          | PASS    | `worker-e2e.ts`  |
| E7.8  | Honest `no_capacity` / no-cloud-identity taxonomy                                                | PASS    | `worker-e2e.ts`  |
| E7.9  | Wave-12 truth: the replayed canary turn renders the deterministic line, never "has been created" | PASS    | `worker-e2e.ts`  |
| E7.10 | **`/api/workflow/events` and `/api/workflow/stream` reconnect after a dropped connection**       | **GAP** | server unit only |
| E7.11 | **`/api/workflow/rpc` refuses non-replayable methods on replay**                                 | **GAP** | server unit only |
| E7.12 | **`flow.run.stop` and `flow.run.retry` from the card**                                           | **GAP** | —                |

## E8. Honesty — the F rows

Every one of these needs a scripted model double so it can run hermetically.
Today all six exist only as live-target checklist rows.

|      | Test                                                                              | Status                       |
| ---- | --------------------------------------------------------------------------------- | ---------------------------- |
| E8.1 | Impossible ask, send an email: honest "can't yet + next step", never fake success | PART (F-1)                   |
| E8.2 | Impossible ask, read local files                                                  | PART (F-2)                   |
| E8.3 | Impossible ask, unconnected tool                                                  | PART (F-3)                   |
| E8.4 | Impossible ask, claim a push                                                      | PART (F-4)                   |
| E8.5 | Impossible ask, claim a PR                                                        | PART (F-5)                   |
| E8.6 | A launch turn's prose never claims run state the run does not have                | PART (`Wave12.test.ts` unit) |

## E9. Shell, panes, and layout

|      | Test                                                                                      | Status  | Where                                    |
| ---- | ----------------------------------------------------------------------------------------- | ------- | ---------------------------------------- |
| E9.1 | World and Connectors open as embedded panes; transcript and composer keep node identity   | PART    | `web-chat-shell-e2e.ts`, not CI-runnable |
| E9.2 | The sent message and the composer draft survive every transition                          | PART    | same                                     |
| E9.3 | Back-to-conversation returns without unmounting the chat                                  | PART    | same                                     |
| E9.4 | **Pane sits beside the chat on a wide window and under it on a narrow one**               | **GAP** | no viewport-size e2e                     |
| E9.5 | **A pane never overlays the conversation; chat chrome stays anchored to the chat column** | **GAP** | —                                        |
| E9.6 | **The 300ms toast law: work over 300ms toasts, work under it never flashes**              | PART    | `Toasts.test.ts` unit                    |
| E9.7 | **A failure toast stays until dismissed**                                                 | PART    | unit                                     |

## E10. World surface

|       | Test                                                                      | Status  | Where           |
| ----- | ------------------------------------------------------------------------- | ------- | --------------- |
| E10.1 | Tool-driven note creation lands in the registry and renders the act line  | PASS    | `worker-e2e.ts` |
| E10.2 | **Editing a note reparses wikilinks with `user:world-editor` provenance** | **GAP** | —               |
| E10.3 | **Delete note goes through the destructive ConfirmDialog**                | **GAP** | —               |
| E10.4 | **Empty state renders with its create action**                            | **GAP** | —               |

## E11. Connectors surface

|       | Test                                                                                     | Status  |
| ----- | ---------------------------------------------------------------------------------------- | ------- |
| E11.1 | **Local repository picker: read-only vs read-write states**                              | **GAP** |
| E11.2 | **Remove repo requires the destructive ConfirmDialog**                                   | **GAP** |
| E11.3 | **Connected repo card states branch / head / worldview facts**                           | **GAP** |
| E11.4 | **Sign-in is the GitHub connector: connection truth derives from session + watched set** | **GAP** |

## E12. Native desktop app — Electrobun

Nothing in this group exists. The packaged binary is the shipped alpha artifact.

|       | Test                                                                        | Status  |
| ----- | --------------------------------------------------------------------------- | ------- |
| E12.1 | **The built app launches and renders the chat**                             | **GAP** |
| E12.2 | **`SMITHERS_APP_URL` loads the deployed origin instead of the local build** | **GAP** |
| E12.3 | **Native RPC seams bind to the window, not the URL, and answer**            | **GAP** |
| E12.4 | **Local repository picker returns a real inspection**                       | **GAP** |
| E12.5 | **Updater channel resolution picks the right build**                        | **GAP** |
| E12.6 | **`build:canary` produces a launchable artifact**                           | **GAP** |
| E12.7 | **The artifact opens on a clean machine (signing / notarization)**          | **GAP** |

## E13. Accessibility, theming, and motion

|       | Test                                                                                               | Status  | Where                    |
| ----- | -------------------------------------------------------------------------------------------------- | ------- | ------------------------ |
| E13.1 | Keyboard-only completion of the section-A journey                                                  | PART    | checklist C-3, live only |
| E13.2 | **`role="log"` transcript, `aria-live` status, aria-labels on icon buttons**                       | **GAP** | —                        |
| E13.3 | **`:focus-visible` brand ring present on every interactive affordance**                            | **GAP** | —                        |
| E13.4 | Every consumed house token defined in both `:root` and `[data-theme="dark"]` — no violet/zinc leak | PART    | `Palette.test.ts` unit   |
| E13.5 | **`prefers-reduced-motion` honored**                                                               | **GAP** | —                        |

The flow graph is behind `flowBuilder`, so the rows below are asserted by the
flow-graph tier (`playwright.graph.config.ts`, real control plane and real
engine) and by the unit pins beside the cards. They cover the graph surface
only; E13.2 to E13.5 remain open for the rest of the app.

|        | Test                                                                                        | Status  | Where                                                    |
| ------ | ------------------------------------------------------------------------------------------- | ------- | -------------------------------------------------------- |
| E13.6  | Every graph node is a focusable button named `<tag> <id> <state word>`                      | PASS    | `e2e/graph/flow-graph-a11y.spec.ts`                        |
| E13.7  | The drawer is a labelled group; its strip is one tab stop and the arrows walk it            | PASS    | same spec, `cards/FlowGraphHardening.test.tsx`             |
| E13.8  | Nine palettes x light and dark: words clear 4.5:1, edges 3:1, each cell photographed        | PASS    | same spec (18 cells), `styles/paletteTokens.ts`            |
| E13.9  | `prefers-reduced-motion` leaves nothing on the canvas animating, and the words still say it | PASS    | same spec                                                  |
| E13.10 | `@xyflow/react` and `dagre` reach no chunk until a graph is opened                          | PASS    | same spec, `cards/FlowGraphHardening.test.tsx`             |
| E13.11 | **An `axe-core` sweep over the graph**                                                      | **GAP** | no axe dependency in the lockfile; the spec writes the rules out |

## E14. Client resilience

|       | Test                                                                  | Status           |
| ----- | --------------------------------------------------------------------- | ---------------- |
| E14.1 | **Network drop mid-turn resolves honestly and recovers**              | **GAP**          |
| E14.2 | **Persisted store (OPFS / wa-sqlite) survives a schema version bump** | **GAP**          |
| E14.3 | **A stale cached bundle after a deploy does not wedge the app**       | **GAP**          |
| E14.4 | **Client errors reach a reporting sink, not only `console.error`**    | **GAP**          |
| E14.5 | **Zero console errors on the signed-out and signed-in loads**         | PART (live only) |

# Part 2 — Canary (live deployment)

Run after every deploy, then on a schedule.

|       | Probe                                                                                                                                           | Status  | Where                                                                                |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------ |
| CN-1  | **The deployed bundle is the git sha the deploy receipt claims**                                                                                | **GAP** | the live build is 13 commits stale and nothing detects it                            |
| CN-2  | Signed-out chat renders with zero console errors                                                                                                | PASS    | `live-check.ts`                                                                      |
| CN-3  | Sign-in never dead-ends: authorize page, or the branded honest page                                                                             | PASS    | `live-check.ts`                                                                      |
| CN-4  | A real failed callback renders the honest page with the way home, status preserved                                                              | PASS    | `live-check.ts`                                                                      |
| CN-5  | `Accept: application/json` still gets the machine-readable answer                                                                               | PASS    | `live-check.ts`                                                                      |
| CN-6  | Every configured seam answers its configured shape; no accidental 501                                                                           | PASS    | `canary-seam-probe.ts`                                                               |
| CN-7  | Deliberately-unset seams answer the honest 501 naming the unset var                                                                             | PASS    | `canary-seam-probe.ts`                                                               |
| CN-8  | The turn seam is session-gated — signed out is 401, never 200                                                                                   | PASS    | `canary-seam-probe.ts`                                                               |
| CN-9  | Real OAuth journey with the sanctioned profile reaches a signed-in chat                                                                         | PASS    | `live-signed-in-check.ts`                                                            |
| CN-10 | Chooser appears iff no watched selection; otherwise the scoped digest + gold pill                                                               | PASS    | `live-signed-in-check.ts`                                                            |
| CN-11 | No standing composer status chrome; no admin chrome for a non-admin                                                                             | PASS    | `live-signed-in-check.ts`                                                            |
| CN-12 | Workflow provision + launch + approve on the real relay (honest `no_capacity` passes)                                                           | PASS    | `live-workflow-check.ts`                                                             |
| CN-13 | Sign-in to first useful message ≤ 90s                                                                                                           | PART    | checklist A-2                                                                        |
| CN-14 | Balance reads the $500 design-partner grant                                                                                                     | PART    | checklist D-1/D-2                                                                    |
| CN-15 | $0 account: chat works, workflow launch refused into the transcript                                                                             | PART    | checklist D-4, needs a parked $0 account                                             |
| CN-16 | Grants admin: 401 without token, 400 untimestamped, 201 credit-once                                                                             | PART    | checklist E-1..E-3                                                                   |
| CN-17 | ~~Reco dismissal is resettable between runs~~                                                                                                     | REMOVED | the recommendations feature was deleted 2026-08-24                                   |
| CN-18 | **All eight backing Workers answer a health probe** (identity, billing, chat, connectors-catalog, cron, status, sync, webhooks)               | **GAP** | none are in this repo                                                                |
| CN-19 | **Turn-seam latency budget**                                                                                                                    | **GAP** | —                                                                                    |
| CN-20 | **Error-rate threshold with an alert**                                                                                                          | **GAP** | —                                                                                    |
| CN-21 | **Synthetic uptime probe on a schedule**                                                                                                        | **GAP** | —                                                                                    |
| CN-22 | **Native app against the deployed origin (`start:canary`)**                                                                                     | **GAP** | —                                                                                    |
| CN-23 | **The allowlist seed is present and an invite actually admits a new user**                                                                      | **GAP** | `invite-mechanics.test.ts` is unit only                                              |
| CN-24 | **Rollback: the previous Worker version is reachable and the receipt names it**                                                                 | **GAP** | receipts record `wranglerVersionId: null` on every dry run                           |

---

# Part 3 — Infrastructure gaps

These block the tests above from being worth anything, and should land first.

**I-1. No e2e job in CI.** Add a job that runs `pnpm --filter smithers-app run
test:e2e:worker`. It is already self-contained: it builds the SPA, boots
`wrangler dev` twice against `scripts/stub-backends.ts`, and asserts 26 named
outcomes. It is the single highest-value thing in the tree that never runs.

**I-2. The three web e2e scripts cannot run unattended.** They default to
`http://localhost:5173` and never start it, and they hardcode
`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`. Give them the
same self-boot the worker script has, and the same browser resolution
`launch-checklist/BrowserLaunch.ts` already implements.

**I-3. Playwright is not a dependency.** `live-check.ts`,
`live-signed-in-check.ts`, and `live-workflow-check.ts` all `createRequire` a
Playwright install at a machine-local absolute path outside this repository.
They run on one laptop and nowhere else. Add `@playwright/test` as a
devDependency.

**I-4. `apps-deploy.yml` runs no tests and no post-deploy probe.** It installs,
builds, deploys. A deploy that breaks the app is indistinguishable from one
that does not.

**I-5. `apps/app/scripts/` is not typechecked.** `tsconfig.json` covers `src`
only, so the e2e and canary scripts drift silently.

**I-6. The nine backing Workers are not in this repo.** They live in a dirty
branch of `smithersai/ui`, under `workers/`. Nothing in CI can build, test, or
deploy them, and CN-18 cannot be written until they move.

**I-7. `web-chat-e2e.ts` asserts a genuine streamed reply**, which means a real
model credential and real spend. Split it: a hermetic variant against the stub
model for CI, and the live variant as a canary.

---

# Part 4 — Order of work

1. **I-1** — put `test:e2e:worker` in CI. One job, no new tests, immediate value.
2. **E12.1–E12.3** — smoke the packaged desktop app. It is what ships and it has
   nothing.
3. **E1.9, E1.11, E1.12** — sign-out and the native sign-in handoff. The desktop
   app cannot sign in any other way and no test covers the path.
4. **CN-1** — assert the deployed bundle matches the deploy receipt's sha. This
   defect is live right now and silent.
5. **I-2, I-3** — make the browser scripts runnable off this laptop.
6. **E8.1–E8.6** with a scripted model double — move the six honesty rows off the
   live target and into CI.
7. **E5.3** — fix and pin the exact-name slash precedence defect.
8. **E2.4, E3.9–E3.11, E4.10, E6.9** — the chooser, retry, and grant paths.
10. **I-4** — gate the deploy on e2e and follow it with the canary set.

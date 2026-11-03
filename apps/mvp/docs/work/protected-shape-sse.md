---
title: Protected shapes refuse unbounded SSE
status: done
area: access
owner: Codex GPT-6.1 Sol
updated: 2026-11-02
links: [../../../../packages/effect-electric/docs/shape-proxy.md]
---

Verify the reported SSE authorization lifetime against main, reproduce through the fleet HTTP handler with real
Postgres and Electric, then reject SSE for protected shapes unless a client requires it. Compare long polling.
No landing, pushing, production reads, or agent reviews. Catalog entry: `@smthrs/effect-electric` ShapeProxy.

Baseline: `6d773cefcf4fbeb464b8f829e7c998c86199bed3` (`main` at task start), in the isolated task workspace.

### Shape and client audit

Every mounted shape uses `ShapeProxy.make` with the default `cache: "no-store"`; none opts into `public`.
This includes shapes with a fixed definition whose route checks access before invoking the proxy.

| Owning worker | Routes under `/api/shapes/` |
| --- | --- |
| Chat, Views, Runs, Notifications, Pins | messages, views, runs, notifications, message-pins |
| SpendAlerts, AlertChannels, branch/BudgetApi | spend-alerts, alert-channels, alert-deliveries, sandbox-limits |
| PersonalFlows | flows, flow-drafts |
| branch/ConversationApi, Publications, Shares, Terminals, Texts | my-conversations, branch-publications, shares, terminals, texts |
| RepoApi | repositories |
| RemoteRuns | remote-runs |
| personal/Api, domains/Api, secrets/Api, feeds/Api, bugs/Api | personal-model, domains, secrets, feeds, bug-reports |
| runners/FleetApi | agent-runs, machines |
| stack/Api | todos, todo-requests |
| github/Api | item-summaries, items, comments, github-sync, triage-settings, pulls, pull-commits, reviews, checks, work-links, actions, github-writes |

39 mounted routes. The `branches` constant has no mounted worker shape; branch listing uses its own API.
The shared no-store policy also covers the fixed repository discovery shape without introducing an SSE exemption.

Client evidence: `packages/effect-electric/src/ElectricCollection.ts:224` restricts shape configuration to URL, params,
headers, column mapper and parser. Its `shapeOptions` at line 425 supplies no SSE option.
`apps/mvp/src/features/fleet/store.ts:39` supplies only URL, mapper and parser to both fleet collections (lines 68, 82).
`packages/effect-electric/src/ShapeSource.ts:84` explicitly identifies `live=true` as long polling.
A source search of all app client modules finds no `live_sse`, `experimental_live_sse` or `experimentalLiveSse` opt-in.
No protected app shape needs SSE; reject it, with no authorization-deadline exception.

### Fix and validation

No-store shapes refuse both SSE flags before Electric when the first value is anything other than `false`.
The proxy preserves its existing per-request access decision, private cache headers, request correlation,
span, log and counters. Explicitly public shapes retain SSE. No new library or flow is needed for this
transport admission check in the existing SDK handler.

The regression `an SSE opened before removal cannot deliver a later private fleet row` failed before the fix:

```text
AssertionError: SSE delivered a new private row after removal: expected 'data: {"value":{"account_label":"priv…' not to contain 'private-after-removal'
```

It opened a real SSE from a valid snapshot handle, removed the role through the real local RepoRoles service,
confirmed a new request returned 403, inserted a private row in Postgres, and received it through the already open
SSE. No sleep, assertion polling, test retry or timeout increase was used. The same regression now gets 400 and
Electric sees only the finite snapshot. Its final home is `worker/runners/FleetAuthorization.test.ts`; it was
initially added to `FleetApi.test.ts` for the baseline run.

The long-poll comparison proves the admitted request can return one final batch after removal, completes, then
refuses the next request with 403 without contacting Electric. This finite in-flight window remains unchanged.
The browser fleet-store test asserts real live updates and the absence of both SSE parameters on its requests.

All executed tests used the Latitude runner with the task workspace as `LAT_RUN_SRC`, real isolated Postgres and
Electric, and coverage disabled for these focused runs. Counts include name-filter skips:

| Run | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: |
| Main, SDK rejection regressions | 0 | 2 | 26 |
| Main, fleet rejection/removal regressions and long-poll comparison | 1 | 5 | 4 |
| Initial app validation, runner fixture not cleaned | 26 | 1 | 0 |
| App validation after cleanup, immutable empty shape interfered with audience snapshot | 26 | 1 | 0 |
| Final SDK ShapeProxy and canonical suites | 112 | 0 | 0 |
| Final app authorization, audience, fleet client and chat proxy suites | 27 | 0 | 0 |

The fixture issues were fixed by cleaning up inserted rows and putting the authorization tests in their own
migrated schema. Existing audience assertions are unchanged. The first fleet attempt failed during integration
service setup before running any tests; no test results came from that attempt.

SDK test-project typechecking passed. Formatting validation initially requested line wrapping and import ordering;
the subsequent formatting check passed. Production, browser end-to-end execution, app-wide typechecking, and full-suite coverage
were not exercised. No production data was read, no agent review was requested, and nothing was landed or pushed.

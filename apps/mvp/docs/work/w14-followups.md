---
title: W14 production followups
status: blocked
area: production
owner: codex-w14-followups
updated: 2026-10-27
links: []
---

Prove the cause of sync health failures and resolve missing-page mobile targets,
pull Files loading, bug report focus, visitor issue counts, literal-percent
404 declarations, and WebKit cancellation diagnostics. Reproduce on production
under the shared lock; validate fixes on Latitude and the Mac mini. Deliver to
the lander without pushing or deploying.

Catalog: effect-electric (shape proxy), effect-tanstack-db (synced state),
platform-browser (focus), ui (controls), observability (content-free records).

## Findings

- Recovery navigation used ordinary inline links below the touch target size.
- Files selected one SHA pair; a later base/head refresh left the displayed pair
  without a comparison. Follow immutable pairs while Files is open, deduplicate
  repeated route entry, and close through the page-bound route exit hook.
- Page navigation focused the heading after the report textarea's autofocus.
  Extend the shared preferred-form contract to textareas and opt the report in.
- Visitor counts checked an absent status before the page mounted. Require the
  visible counts before the negative status and private-history assertions.
- A literal percent is encoded on the wire. Declare and verify the exact encoded
  request while retaining the shell recovery checks.
- The online report journey used an offline-precache fixture, and the dev server
  lacked the build receipt its final assertion reads. Use the standard page
  fixture and serve the existing build receipt during development.
- WebKit reports pre-dispatch refusals from a departing document as native console
  diagnostics; Playwright presents these as page errors without a window error or
  unhandled rejection. Classify only a witnessed navigation cancellation with the
  exact native name and a same-origin API address. Observe real window identities,
  bind failures to navigation requests and redirects, and reconsider all matching
  outcomes at teardown. Unknown identity, HTTP refusal, pending or completed reads,
  and transport failures remain strict. Keep content-free lifecycle receipts.

## Verification

The old-code focus, SHA refresh, and development build receipt regressions fail.
Latitude: pull logic 16 tests and 100% all-metric coverage; build receipt 7 tests
and 100%; Electric 219 tests and 100%; UI 2,691 tests, with changed focus code at
100% of Bun's measured lines/functions. The cancellation policy and problem
classifier pass 36 focused tests at 100% of every metric, including redirects,
same-document navigation, delayed failures, late refusals and cancellation order.
App typecheck, import rules and lint pass. Codex Astra's final review has no findings.

Production: visitor counts and all recovery paths pass in both browsers. The
storage, HTML isolation and native-cancellation regressions pass all eight cases
in both projects. The local focused run recorded 22 passes, one storage failure
and two dependency skips. Its passes include report submission, mobile recovery
targets, recovery paths and controlled navigation; the HTML and synced-repository
journeys lack their real dependencies locally. Later diagnostics retain a session
502 as well. Fable review was attempted; every account was unavailable or cooling.

## Remaining evidence

Historical health summaries lack first-failure timestamps and response IDs.
Preserve those receipts and match them to content-free stream and invocation
records; aggregate success cannot establish delivery of a particular response.
The exact eight-device, three-round health check passed all 3,840 reads with no
transport failures or Worker exceptions. Its 758 sampled, matched stream receipts
were complete with equal client/server byte counts; 868 matched site invocations
were ok. This does not establish the historical failures' cause. Keep it unresolved,
with no speculative retry. The checker now retains the first failure's time, phase,
bytes and response identifiers, and shape records name the phase.

Local WebKit's fresh-profile storage assertion remains a failure. A native
two-profile probe, without loading the app, proved both persistent profiles saw
the same OPFS marker. The app correctly refused a different owner's device data;
the saved receipts also retain a session 502. Do not erase shared storage to make
this test pass or claim that separate profile directories established fresh OPFS.

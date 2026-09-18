# apps — e2e and canary remediation, 2026-08-19

What was built against `E2E-CANARY-CHECKLIST.md`, what it found, and what is
still open. The row statuses in that file are the 2026-08-18 baseline and are
deliberately left stale; this file is the current record.

## What the tests found

The point of the exercise was coverage. The more valuable outcome was three
product defects, each found by a new suite, each confirmed independently by two
adversarial auditors reading source rather than trusting the lane that reported
it.

### D1 — a decided approval could be decided twice

`AppStore.ts` — the `card.upsert` and `card.updated` reducers lacked the freeze
guard their sibling reducer has. A `card.update` NDJSON frame arriving after a
decision reopened a decided ApprovalCard, so it could be approved or denied a
second time.

An approval is a human authorising an action. A frame from the model's own
stream must never be able to un-decide one.

Fixed: a recorded decision, not the `acted` status, now freezes an approval
(`AppStore.ts:113-120`). Caught by `e2e/suites/cards-approvals.e2e.ts`.

Adjacent hazard reported and deliberately not changed: `decideApproval` in
`AppController.ts` returns early on `status === "acted"`, so a streamed frame
that sets `acted` with no decision recorded can suppress the gate entirely — the
opposite failure. No test covers it and it predates this work. The two guards now
use different notions of "frozen" and should be reconciled.

### D2 — reopening the app could lose the whole conversation

`AppStore.ts` — the persistence backend could flip between launches. One launch
wrote OPFS, the next fell back to localStorage and read a fresh empty database,
silently. An auditor reproduced it in both directions.

Fixed: the recorded backend is authoritative. When the recorded store will not
open, the launch runs on a memory store rather than presenting a stale store as
the current conversation or forking history by writing into it. The real store is
untouched and returns on the next launch. Caught by
`e2e/suites/turn-failure.e2e.ts` (row E3.6).

Follow-up landed by the orchestrator: `persistenceDegraded` was set and read by
nothing, so the user saw an empty transcript with no explanation — the honest
recovery read as silent data loss. A `failed` toast now states it and stays until
dismissed.

### D3 — the sign-in button was not the first tab stop

The corner chrome rendered before the transcript, so on the signed-out chat a
keyboard user Tabbed into the theme toggle instead of the only action available
to them. The theme toggle also carried no `data-flow` despite running the
registered `dark-mode` command.

Launch-checklist row A-1 grades exactly `tabbable.indexOf("auth.sign-in") === 0`,
**so the live checklist had been failing this row too.** It was recorded as
`PART — live only`, which is how it stayed invisible. That is the checklist's own
thesis: a row nobody runs is a row nobody knows is red.

Fixed in `App.tsx` + `chat.css`. Caught by `e2e/suites/auth-session.e2e.ts`.

Root cause of why the fix needed a focus shortcut rather than a DOM reorder:
`@smthrs/ui`'s `MessageScrollerViewport` hardcodes `tabIndex={0}` and nothing the
host passes reaches it. `apps/app` pins `@smthrs/ui: 0.33.0` from npm with no
alias and no patch, so no change in this repo can reach it. Filed upstream.

## The rot that started this

`worker-e2e.ts` — the tree's only self-contained e2e suite — was RED at HEAD and
had been for three days. Nothing ran it, so nothing noticed.

Across two sessions, one file was found to contain **19 dead string literals and
4 vacuous assertions**, all orphaned by the 2026-08-15 `command`→`flow` rename:

- 9 assertions against the card kind `"workflow-run"`, which stopped existing at
  the rename, so every comparison was always false;
- 8 `workflow.<x>` command names against a registry that declares only
  `flow.<x>`. The worst was a stub emitting `workflow.create` while
  `RunClaims.RUN_LAUNCH_COMMANDS` is `["flow.create", "flow.run"]` — the wave-12
  section had disarmed the exact substitution it exists to prove;
- 2 dead `workflow-run-` card-id prefixes;
- `"never a fake digest"` asserting nothing;
- a credential-leak probe that any refusal satisfied for free.

Plus 17 stale `data-command` DOM selectors across four browser scripts, invisible
to `tsc` because a selector is a string inside a CDP expression.

All fixed. `worker-e2e.ts` is green at 27 assertions.

## Closing the class, not the instances

A one-off sweep proves the suites are clean today and does nothing for the next
rename. `lint/conformance/` pins every literal the e2e and canary suites assert
against to the vocabulary the app owns — card kinds from the type union, command
names from the `data-flows` manifest the shell publishes, collection keys,
card-id prefixes, DOM attributes. A literal that no longer resolves fails the
test and names what orphaned it.

It runs in `bun test src`, the fast unit gate, not behind the browser job.

Two things make it non-vacuous, both added after review:

- **Non-empty floors on every derived vocabulary.** A conformance test that
  derives its universe from the app passes trivially the moment the derivation
  returns nothing — the defect class it exists to close, one level up.
- **A regression fixture** replaying the four dead-literal classes of the
  2026-08-15 rename, asserted to be caught.

An auditor then found a hole in the pin _in the same shape_: card kinds were
checked inside `[data-kind="…"]` selectors and `.kind ===` comparisons but not
when passed as a function argument, which is how most are passed. Closed, with a
fixture in that exact shape.

## The canary probes were audited before they shipped

Four probes were written, then adversarially audited. All four were defective and
every defect was demonstrated with a real run:

- **CN-19/20/21 never probed the deployment at all.** The origin was resolved as
  "first non-flag token in argv", and the scheduled workflow passes
  `--json <path>` with no positional origin — so the origin became a filesystem
  path. Every scheduled run would report the canary fully down regardless of
  production state, and open a GitHub issue every 15 minutes forever. A probe
  whose verdict cannot move with the thing it grades.
- **CN-18 called a nonexistent Worker healthy.** A `workers.dev` host with
  nothing behind it answers 404 — the same status the healthy chat Worker answers
  at `/`.
- **CN-1 passed a half-published deploy.** A fresh `/__build.json` beside a
  pre-stamp `index.html` went green while the deployment served the old app.
- **CN-23 exited 0 while asserting nothing** when uncredentialed, and the
  proposed CI step referenced secrets that do not exist.

All four fixed and mutation-tested: each fix was reverted in isolation to confirm
its regression test actually fails without it.

CN-1's mechanism was verified sound by building the real bundle and grepping
`dist`: the stamp travels inside the artifact, so a stale deployment cannot serve
a fresh stamp. CN-24 was verified by unpacking wrangler 4.123.0 and tracing the
version id to stdout, then reading the live Cloudflare versions API.

The live canary is confirmed stale from outside: Cloudflare reports the running
version was created 2026-08-13, and the probe reds against it today.

## Infrastructure

- **I-1** — `ci.yml` gained an `apps-e2e` job running both the worker suite and
  the hermetic suites. It is a separate top-level job, not a step of `test`, so a
  multi-minute browser run does not sit in front of every push.
- **F7** — none of the four apps declared a `check` script, so root
  `pnpm run check` (`--recursive --if-present`) typechecked **zero app code**.
  All four now declare it.
- **T7** — `apps/server`'s test script was scoped to `src`, so 172 canary probe
  tests ran nowhere. Now `bun test src scripts`.
- The e2e runner had no CDP timeout and hung for 25 minutes with no output; a
  hanging CI job is worse than a failing one. Bounded, with per-lane debug ports
  and profiles so concurrent runs cannot collide.
- `deploy.ts` wrote `wranglerVersionId: null` when a real deploy printed no id,
  handing the operator a rollback plan CN-24 cannot verify. It now fails loudly.
  Dry runs stay exempt.

## Where the numbers stand

| Workspace     | Before | After |
| ------------- | -----: | ----: |
| `apps/app`     |    526 |   628 |
| `apps/server` |    108 |   371 |
| `packages/rpc` |     33 |    33 |

17 hermetic e2e suites exist where there were none. `worker-e2e.ts` went from
red to green. No test was weakened, skipped, or deleted to reach any of it —
both auditors grep for `.skip(`, `.todo(`, `xit(` and `it.failing` and for new
tolerances.

## What the whole-suite gate found afterwards

Running all seventeen suites in one process — which no per-lane verification
does — surfaced four more, three of them real:

- **A data-loss regression in the schema gate.** It cleared every persisted key
  when the store carried no version stamp, and every store written before the
  gate exists is unstamped, so the first boot after the upgrade wiped the
  conversation of every existing user. An unstamped store is now adopted, not
  cleared. Fixed in `9818bac2`.
- **A user-facing confidence score** (`80%`) on the world card, which row B-5
  forbids. Deleted.
- **A real brand leak.** `--muted-foreground` and `--popover` were consumed but
  defined nowhere, so hardcoded fallbacks painted — the wrong colour entirely in
  dark. They are now aliases of `--text-muted` and `--surface`, so all nine
  palettes and both themes follow automatically. This had been hidden behind a
  named waiver, which is why the audit flagged the waiver as suspicious.
- **A flaky-by-construction toast assertion.** E9.6 asserted that fast balance
  work shows no toast, assuming the local double always answers well under
  300ms. On a loaded machine the round trip crosses it, the product correctly
  toasts, and the suite called that a violation. It now reads the page's own
  settle stamp and asserts the law in both directions, so it cannot flake.
- **A roaming mount flake, and the only one that was systemic.**
  `browser.open()` returned at `document.readyState === "complete"`, which says
  the document loaded, not that React rendered. Each suite then hand-rolled its
  own mount wait with its own budget, and under load whichever suite happened to
  be running failed on "the composer never mounted". Three different suites were
  blamed across four runs; each passed in isolation, which is the signature of an
  environmental wait rather than a defect. `open()` now waits for the shell's
  `[data-flows]` manifest — proof React rendered and the registry is live — and
  retries the whole navigation, because a page that lands mid-reload never mounts
  however long it is given. It still throws after the last attempt: an app that
  truly never mounts is a product failure and must stay one.

Two of these — the score and the token leak — were latent product defects that
only a whole-set run reached, because an earlier failure in the same suite was
aborting before them. The a11y suite went from 4 of 16 sections reached to 20 of
20.

## Where the whole-suite run ended

Seventeen suites in one process, on a quiet machine, after every fix above:

```
PASS: apps/app e2e — 17 suites, 184 checks, 68/68 checklist ids proven, 0 skipped.
```

Exit 0. Nothing skipped, nothing deferred, no hang.

For comparison, the same command at the start of this remediation: 13 of 17
suites and 56 of 68 ids — and before the runner was fixed it did not terminate
at all.

Three of the four whole-set failures turned out to be defects in the tests
rather than the product, and each was fixed at its cause rather than by
widening a budget:

| Symptom                       | Cause                                                                              | Fix                                                        |
| ----------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| roaming "never mounted"       | `open()` returned at `readyState`, before React mounted                            | wait for the `[data-flows]` manifest, retry the navigation |
| "surfaces menu never opened"  | a synthetic click delivered before the handler attached is lost                    | click the trigger up to three times                        |
| "connector rows did not load" | the seed named no backend, so the app read OPFS while the rows sat in localStorage | stamp `persistenceBackend` in the seed                     |

The first two moved between suites run to run, which is the signature of a lost
event rather than a slow one. None was fixed by raising a timeout.

## Still open

- **E3.5** now runs for the first time and fails by ~18ms against a 1000ms
  budget. The measurement charges DevTools round trips to the product's budget;
  the same Escape settles in 1-2ms at store altitude. Fix the measurement, not
  the budget.
- **`@smthrs/ui` `MessageScrollerViewport`** hardcodes `tabIndex={0}`; upstream.
- **`worker-e2e.ts` seals 14 environment variables** where the harness seals 19.
  Narrower is not wrong here, but it is worth closing.
- **E12.7** codesign / notarization — no signing configuration exists anywhere in
  the repo. Correctly a human task, not a test.
- **Phase A** — the harness supports booting with every seam unconfigured to
  prove honest 501s, and no suite declares it.

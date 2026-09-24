> Local-app cut (2026-08-26, `docs/LOCAL-APP.md`): the hermetic web runners
> (`web-chat-*.ts`, `worker-e2e.ts`, `e2e-harness.ts`, `stub-backends.ts`,
> `launch-gateway-double.ts`, `live-check.ts`) and the `wrangler dev` stack
> they booted were removed with the web build path. End-to-end coverage is
> `pnpm --filter smithers-app test:e2e` (T1, local origin in headless Chromium)
> and root `bun run test:e2e` (T2, the stable packaged Electrobun app through
> its authenticated native-renderer bridge). The sections below that describe
> the removed runners are historical.

# apps/app/scripts

E2E and live-check scripts. Unless a section says otherwise, run them from
`apps/app`.

## Declared test runners

| Command (from `apps/app`) | Files executed | Requirement |
| --- | --- | --- |
| `pnpm test` | Tests under `src/` and `scripts/` | Bun |
| `pnpm run test:e2e` | Specs under `e2e/playwright/` | Playwright Chromium and the local app server |
| `pnpm run test:e2e:auth` | `e2e/native/CloudAuthFragment.test.ts` | Playwright Chromium; starts isolated loopback OAuth fixtures |
| `pnpm run test:e2e:site` | Specs under `e2e/site/` | Playwright Chromium; builds and previews `apps/site` |
| `pnpm run test:e2e:probes` | Tests under `e2e/probes/` | Playwright Chromium; no server and no deployed host |
| `pnpm run test:e2e:packaged` | Bridge, fixture lease and packaged-app tests named by `e2e/packaged/run.ts` | Packaged Electrobun app |

`test:e2e:native` aliases the packaged runner. Native process probes are Bun
tests, separate from Playwright specs. `lint/conformance/TestInventory.test.ts`
checks that each test file belongs to an executable runner. The `unitTests`
target uses the same discovery as `pnpm test`; its inputs include scripts,
E2E harnesses, configs and RPC fixtures. It depends on the RPC, gateway and
shared UI typechecks so the inspected package sources contribute their keys.
The `browserE2e` target invokes `run-pr-e2e.mjs`, which installs Chromium, runs
`test:e2e:auth`, `test:e2e:probes` and `test:e2e:graph-lifecycle`, then the
offline Playwright, site and flow-graph suites. TestInventory admits a CI
browser tier only from that runner's argv, never from a `package.json` alias.
Any failed command stops the wrapper with a nonzero exit code.

## Launch checklist (`launch-checklist.ts`)

Run the signed-in launch checklist (§A-F) against an explicit origin.
`--target`/`-t` overrides `$CHECKLIST_TARGET`; there is no default target.

From the repository root:

```sh
pnpm run checklist -- --target https://canary.smithers.sh
```

From `apps/app`:

```sh
pnpm run checklist -- --target https://canary.smithers.sh
```

The root script forwards to the UI package. Both commands run
`bun scripts/launch-checklist.ts` with `apps/app` as the working directory.
A local origin can be passed to `--target` for local verification.

### Probes and prerequisites

The §A, §B, §C and §F rows, plus D-3 and D-4's pause half, use a system
Chrome/Chromium through `headless-page.ts`. The §D HTTP rows inspect billing
and turn seams; §E inspects the billing upstream. D-4 checks both the turn
response and the workflow refusal at zero balance.

The checklist downloads no browser. Choose one with `--browser <path>` or
`$CHECKLIST_BROWSER`, or use automatic system-browser discovery. One browser
process serves the run, with a separate page per session cookie.
`--no-browser` skips browser prerequisites while HTTP probes still run.

Missing prerequisites produce `not-testable-yet` rows with a named reason.
A probe that starts but cannot decide also produces `not-testable-yet`, with
`undecidedInProbe: true`. These outcomes have different exit codes below.

### Auth material

The `CHECKLIST_*` credentials are auth material; never commit them.

| Variable | Rows | Value |
| --- | --- | --- |
| `CHECKLIST_SESSION_COOKIE` | §A except A-1, §B, §C, §F, D-1, D-2, D-3 | Cookie header for a signed-in session |
| `CHECKLIST_ZERO_BALANCE_BEARER` | D-4 | Cookie header for an account at zero balance |
| `CHECKLIST_BILLING_UPSTREAM_URL` | §E | Billing upstream origin |
| `CHECKLIST_BILLING_ADMIN_TOKEN` | E-2, E-3 | Billing upstream admin token |
| `CHECKLIST_BILLING_PRODUCT_SERVICE_TOKEN` | E-3 | Product Worker billing service token |

Set cookie headers as `name=value; name2=value2`. Missing required variables
skip that row's prerequisites; the run continues and writes a report. A-1
checks the signed-out view without a cookie.

### Dry run

From either directory:

```sh
pnpm run checklist -- --dry-run
```

No target, credentials or browser are required. Dry runs make zero network
calls, mark every row `skipped-dry-run`, write both reports, and exit `0`.
They verify CLI wiring and report generation, not the deployed application.

### Output and exit codes

Every completed run writes `launch-checklist-report.json` and
`launch-checklist-report.md` under
`apps/reports/launch-checklist/<timestamp>Z-<dry-run|run>/`.
`--out <dir>` overrides the report directory; relative paths resolve from
`apps/app`, including when invoked through the root forwarding script.
Reports contain `generatedAt`, `target`, `totals`, and `rows[]`.

| Exit code | Meaning |
| --- | --- |
| `0` | No failed rows and no run-mode probe-undecided rows. A run containing only passes and prerequisite-skipped rows also exits zero; zero alone does not prove every row ran. Dry runs exit zero. |
| `1` | At least one row is `fail`, even if other probes are undecided. Invocation without a target outside dry-run mode also exits one. |
| `2` | No failed rows, but at least one run-mode probe-undecided row (`undecidedInProbe: true`, counted in `totals.probeUndecided`). |

Prerequisite-skipped rows include missing auth variables and unavailable or
disabled browsers. Probe-undecided rows include an empty watched set or no run
identifier in the rendered state. Inspect row reasons and totals before
accepting a release. Connection failures from probes that run are failed rows.

The catalog, runner and CLI contract live in `./launch-checklist/`.
`pnpm test` covers them and the script contracts. The process shell owns the
clock, filesystem, browser lifecycle and final exit code.

## The browser e2e scripts

Four scripts drive a real headless Chrome over the DevTools protocol. Three of
them are **hermetic**: `e2e-harness.ts` builds the SPA, boots `wrangler dev`
with every seam pointed at a test double in `stub-backends.ts`, mints a
signed-in allowlisted session, and answers the repo chooser, so the run needs no
credential, no deployment, and no model spend. Each costs one vite build plus
one wrangler boot, roughly a minute before the first assertion.

| Script                     | Cost                 | What it proves                                                                                                                                            |
| -------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `web-chat-hermetic-e2e.ts` | free                 | One prompt streams a scripted NDJSON reply through the Worker, and the hidden runtime context reaches the model without leaking into the transcript.      |
| `web-chat-context-e2e.ts`  | free                 | The reply is derived from the runtime context, and a state change (the theme) reaches the NEXT turn on the wire and in the composed instructions.         |
| `web-chat-shell-e2e.ts`    | free                 | World and Connectors open as embedded panes; the transcript and composer DOM nodes survive every transition, on a 1400px and a 700px window.              |
| `web-chat-e2e.ts`          | **real model spend** | The same first-prompt journey against a real model. Boots the vite dev server if nothing answers the target. Never in CI — run it by hand or as a canary. |

`web-chat-hermetic-e2e.ts` and `web-chat-e2e.ts` are the two halves of one
split (I-7). The live half asserts "some genuine streamed prose arrived", which
needs a credential and metered dollars, so it can never gate a pull request.
The hermetic half asserts the same path with a scripted model at the far end,
plus the two things a live reply cannot check: that the Worker composed the
context into `instructions`, and that the reply echoes it back.

None of them hardcodes a browser path any more. The binary resolves through
`findBrowser` (`--browser`-equivalent `$CHECKLIST_BROWSER`, else the seven usual
install locations, including `/usr/bin/google-chrome` for a CI runner), the same
discovery the launch checklist uses.

## Other scripts

- `e2e-harness.ts` — shared boot for the browser e2e scripts: the scripted chat double, the hermetic app, the CDP target, and the pinned wrangler specifier.
- `stub-backends.ts` — test doubles for identity/billing/gateway/reco, used by `test:e2e:worker` and by `e2e-harness.ts`.
- `worker-e2e.ts` — `bun test:e2e:worker`, drives the product Worker against the stub backends.
- `live-check.ts`, `live-signed-in-check.ts`, `live-workflow-check.ts`, `canary-seam-probe.ts`, `launch-seam-probe.ts` — browser-driven and HTTP live checks against a real deployment (see each file's header comment for invocation and required env/profile). `live-check.ts local` is the exception: it boots its own stub identity and `wrangler dev` and needs no deployment.
- `live-store-reset.ts` — shared helper: clears a page's persisted store (OPFS/localStorage) over CDP, keeping cookies.
- `launch-mint-session.ts` — mints a Playwright storage-state file for the live checks.

### The suite resets what it dirties

Rows that write state (a grant, an allowlist entry, a watched selection) run
against seams that record the write with attribution, so the report's
evidence names what the row changed.

### A leftover `wrangler dev` outlives an interrupted run

`Bun.spawn(["bun", "x", "wrangler", ...]).kill()` signals the `bun x` wrapper,
not the `workerd` it started, so a script killed by a timeout can leave the port
bound. The next run then boots "successfully" against the dead stack and every
row fails for a reason that has nothing to do with the product. `live-check.ts
local` and `e2e-harness.ts` both refuse to start when their port already
answers; if that is what you get, `pkill -f "wrangler dev --ip 127.0.0.1"`.

### Two browser drivers, on purpose

`launch-checklist.ts` drives a **system Chrome over the DevTools protocol**
(`headless-page.ts`): no browser download, no Playwright. The `live-*.ts`
scripts drive **Playwright**, because they need a persistent profile to carry a
real GitHub OAuth session through a redirect — the one thing the checklist
cannot do. Playwright is a devDependency of this package; it used to be
`require`d over an absolute path into a sibling checkout, which made those three
scripts runnable on exactly one machine.

Playwright's browser download is not part of `pnpm install` (the workspace
blocks package build scripts). Install a browser once with
`pnpm --filter smithers-app exec playwright install chromium`, or point
`MULTI_E2E_PROFILE` at a profile whose browser is already on the machine.

Everything under `scripts/` is covered by `pnpm --filter smithers-app run
typecheck`. It was not until 2026-08-18, which is how the foreign-path
`require` and nine assertions against a card kind that no longer exists
(`workflow-run`, renamed to `flow-run`) both survived in here.

### What the typecheck still cannot see

A selector is a string inside a CDP expression or a Playwright locator, so
`tsc` has nothing to check it against. The 2026-08-15 `command` → `flow` rename
therefore left 17 selectors across four scripts still naming the pre-rename
attribute, matching nothing at all, for three days, while the suites reported
the same numbers they always had. (The dead attribute name is deliberately not
spelled here: a `grep -rc` over this directory is the cheapest gate against the
next one, and it should read zero.) The same rename also moved the run card's
kind from `workflow-run` to `flow-run` and the slash form from
`/workflow.create` to `/flow.create`.

Four more selectors here were dead for the same silent reason and are worth
knowing about, because they are the shapes to look for next time:

- The Approve/Deny buttons and the composer's Stop button come from
  `@smthrs/ui`, which names them `[data-decision]` and `.sui-chat-composer-stop`.
  They carry no `data-flow`, so no rename of the flow behind them can ever be
  visible in the DOM.
- `.message-author` stopped rendering when the chat bubble moved into
  `@smthrs/ui`; it survives only in two CSS rules. A filter on it matched zero
  bubbles, so `web-chat-context-e2e.ts` waited 90 seconds and then failed on a
  count of 0.
- The theme toggle's accessible name is "Toggle light and dark mode", not
  "Toggle theme".
- World and Connectors moved behind the composer's surfaces dropdown (§2c′).
  `.composer-actions [data-flow="connect"]` still resolves — to the repository-
  connections trigger, which opens a different menu — so a blind rename of that
  selector would have looked right and measured the wrong button.

When a script's selector goes stale, grep `apps/app/src` for the affordance the
script MEANS before renaming the string. A wrong `data-flow` name is the same
defect in a new coat.

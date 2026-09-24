# Issue #1646: first-click verification

Restarted 2026-09-24 after the latest-code pull. The clean main checkout,
`main@origin`, GitHub's main-commit API, and this branch's parent all matched
`8ca0f793645d72910cae23fb006519fe1547ed1c`. Dependencies were refreshed with
the frozen lockfile and the site was rebuilt. This evidence supersedes the
earlier run based on `7847d3ab…`.

Main subsequently advanced to `9d59e7f6cbe37db87d67dc61f1ecd37afcf2ec2c`.
That commit changes only `evals/harbor/fixtures/check_agent.py` and
`evals/harbor/smithers_agent.py`. The PR was rebased again, and its four browser
regressions and 62 controller tests were rerun on this final source baseline.

Checked <https://smithers.sh/smithersai/smithers/> again after the restart.
The reported `knownRepositories is not a function` crash did not recur in
Chrome or Playwright WebKit. Native Safari verification remains blocked.
The issue should remain open until that acceptance check is recorded.

## Deployed evidence

The final checks used fresh persistent browser profiles, real production HTTP
responses, and no seeded application state or intercepted requests. Each check
clicked **Set up a job** (or focused it and pressed Enter), observed the
**Handle issues** card for `smithersai/smithers` and its Sign in button, opened
Chat with Control-K, and reloaded to verify that the card returned.

| Browser | Mouse | Enter | Chat and reload | Uncaught errors |
| --- | --- | --- | --- | --- |
| Google Chrome 143.0.7499.170 | Passed | Passed | Passed | None |
| Playwright WebKit 26.5 | Passed | Passed | Passed | None |
| Safari 26.6.2 (21624.5.1.11.3) | Blocked | Blocked | Not measured | Not measured |

The HTML `smithers-build-sha`, `/__build.json`, `/api/bootstrap`, and the
reloaded document agreed on:

- Revision: `8ca0f793645d72910cae23fb006519fe1547ed1c`
- Built: `2026-09-24T20:53:59.006Z`
- Checks started: `2026-09-24T20:57:23Z`–`20:57:35Z`
- Loaded controller: `/_astro/ControllerBoot.client.DMPw_lba.js`

[Machine-readable observations](production.json),
[Chrome after first click](chrome-first-click.png), and
[WebKit after first click](webkit-first-click.png) are retained here.

During the restarted investigation, production changed from `6fa1a42d…` to
`8ca0f793…`. One check's revision-consistency assertion caught that rollout;
another recorded a recommendation-outcome access-control page error even
though the first action, Chat, and reload worked. These observations are
retained in [the rollout run](production-rollout.json). The final four checks
above all measured `8ca0f793…` and recorded no uncaught errors.

Safari's WebDriver refused session creation because **Allow remote automation**
is disabled in Safari Settings → Developer. CLI enablement required an
administrator password. WebKit evidence does not establish a native Safari
pass, and installed Chrome differs from the report's Chrome 152.0.7977.77.

Background requests also produced HTTP 400 console messages; these checks
establish first-click behavior, not general production health. No request to
`/api/repository-setup/**` was made by the signed-out preview. WebKit's temporary
contexts refused OPFS and displayed the existing memory-only warning; the fresh
persistent profiles used for the final checks opened storage and retained the
card on reload.

## Controller contract and existing repair

[`e39c498e93d5497858e471910c0a17d9ecbfa9c2`](https://github.com/smithersai/smithers/commit/e39c498e93d5497858e471910c0a17d9ecbfa9c2)
restored the missing `knownRepositories` declaration and bindings after an
integration overwrote them. GitHub's compare API confirms this commit is an
ancestor of the measured deployment. The issue supplied no original revision,
so the reported `ControllerBoot.client.lIIE_SzT.js` cannot be assigned a source
revision from that report alone.

`ControllerBoot.client.ts` constructs `createAppController` before exposing the
app. Its typed `CommandActions` map binds
`knownRepositories: () => knownRepositories(store)` before constructing the
registry. The public controller spreads that same action map. `Commands.ts`
calls this function while parsing commands; `RepoContext.ts` reads the current
repository collections each time, including an initially empty inventory.
This is a callable store reader at boot, not a repository response object or a
value that must be installed after a network read. No additional runtime patch
is needed for the reported missing-function defect in the inspected source.

The original scripted tutorial and **Let's begin** control have been retired.
The regression exercises the current first-run action at the reported URL.

## Regression and validation

Final source baseline: `9d59e7f6cbe37db87d67dc61f1ecd37afcf2ec2c`.
The latest main at restart and measured deployment was `8ca0f793…`; the later
source-only Harbor change does not alter the app, controller, or dependencies.

- `e2e/site/first-click.spec.ts`: four cases passed, covering mouse and Enter in
  Chromium and WebKit. These load the built Astro island, real boot/controller,
  registry, and storage. Only HTTP seams are fixtures. They assert the resulting
  setup card, working Chat, unchanged repository URL, no setup execution
  requests, and no uncaught errors.
- Mutation check: temporarily replacing the controller's `knownRepositories`
  binding with `undefined` made the Chromium first-click case fail because no
  setup card appeared. This check was repeated on the updated baseline, the
  source was restored, and all four first-click cases passed again.
- All **62** tests in `RepoContext.test.ts`, `Commands.test.ts`, and
  `FirstRunBootSettle.test.ts` passed on the updated source.
- The required PR browser runner installs WebKit and runs the new project.
  The three relevant CI selection/runner contract tests passed.
- Full website suite on `8ca0f793…`: **11 passed, 1 failed**. The existing landing dismissal
  test at `landing-start.spec.ts:23` restores dismissed first-run actions after
  reload. It recurred after the latest-code pull; the app and site sources
  involved are unchanged from the previous baseline, where it also failed
  in isolation. This change does not claim to repair it.
- The separate, unchanged devkit refusal contract test fails before reaching
  its intended assertion with `undeclared_host_bin: S.Host.bin("bun")`.

Run the new regression with the repository's pinned Node/pnpm toolchain:

```sh
pnpm --filter smithers-app run devkit
pnpm --filter smithers-app exec playwright install --with-deps chromium webkit
pnpm --filter smithers-app exec playwright test --config playwright.site.config.ts first-click.spec.ts
```

Native Safari completion: enable remote automation, repeat both first actions
from fresh profiles at the reported URL, and record browser version, document
and API build stamps, visible outcome, and console errors before resolving
the issue.

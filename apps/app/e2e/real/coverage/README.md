# Real E2E coverage contract

Every `e2e/real/**/*.spec.ts` file declares each scenario through the shared
fixture. The declaration is inventory, not proof that the test ran:

```ts
test("opens a repository", scenario("repo.open.success", {
    capabilities: ["local.repositories"],
    coverage: [
      "action:repo.open",
      "host:local",
      "path:success",
      "door:button",
      "dimension:keyboard",
      "evidence:filesystem-readback"
    ]
}), async ({ page }) => { /* real interaction and assertions */ })
```

`scenario(id, metadata)` is the canonical per-test form and returns Playwright
details containing `real-*` annotations. `test.use({ realScenario: metadata })`
is supported for suite defaults, but cannot replace unique per-test ids. The
gate rejects every `test(...)` without its own `scenario(...)` details.

Action tokens refer to the current `FLOW_NAMES` source declaration plus the
literal search factory names returned by `entries/search.ts`. Those generated
search actions are built-in UI features and receive individual missing-action
and execution checks, even though they are absent from the static union.
The one family marker, `action:repository-flow:*`, records runtime repository flow leaves;
it does not stand in for static actions. Hosts are `local` (production build
against owned local services), `production` (deployed canary), and `native`
(packaged app). Critical paths are success, permission, error, persistence,
and keyboard. A scenario may declare multiple dimensions and actions.

Success metadata requires an `evidence:*` token describing independent
completion evidence, such as a filesystem or service readback, process exit,
persisted state after relaunch, or a provider response bound to the submitted
turn. Metadata cannot make an assertion sufficient. Reviewers must verify the
test actually asserts the named evidence.

The quality gate parses TypeScript ASTs for real specs and their executable
relative-import closure. It rejects definite doubles and disabled tests:
Playwright HTTP/WebSocket/HAR interception, module mocks, skip/fixme, stub
environment flags, obvious fake API/credential literals, refusal-as-success,
and assertions that use only arbitrary nonempty text as completion. Ambiguous
assertions are reported for manual review because a nonempty precondition can
be legitimate before a stronger state assertion.

Fault-path tests must disturb a real boundary. Killing an owned process or
making an actual network unavailable is permitted; substituting its API is
not. Tests must restore the boundary in `finally` cleanup.

Reporter evidence is a JSON array of records defined by
`RealScenarioRunEvidence`: scenario id, host, verdict, revision, timestamps,
deployed build SHA when applicable, timestamps, and optional artifact. The gate joins only a passed record for the same id and
host. Failed, missing, or stale declarations remain visible execution gaps.
The report also lists every uncovered static action and critical-path/host/door
dimension, so partial suites never display artificial 100% coverage.

Add `./e2e/real/coverage/reporter.ts` to the Playwright reporter list. The run
must set `SMITHERS_REAL_E2E_HOST` to local, production, or native and
`SMITHERS_REAL_E2E_REVISION` to the tested revision. The reporter refuses to
write unattributed evidence and defaults to
`test-results/real-e2e-evidence.json`. The fixture must also emit a
`real-host-verified` annotation from actual host evidence; the reporter rejects
host identity asserted only through an environment variable.

Run `bun apps/app/scripts/check-real-e2e.ts --results <reporter-results.json>`.
The machine report defaults to `apps/app/test-results/real-e2e-coverage.json`.
Use `--require-complete --expected-revision <exact-sha> --expected-host <host>`
for each host's release receipt: execution gaps are restricted to scenarios
that declare that host. Run the aggregate gate without `--expected-host` to
require evidence for every declared host. Both modes keep global action,
critical-path, and door inventory gaps visible. Evidence for an unknown
scenario or a host absent from its declaration is rejected.
Quality-only mode still prints gaps without failing;
completeness mode fails any inventory, dimension, or executed-evidence gap.
Global path and door totals are diagnostics; they do not claim every path
applies to every action. Per-action applicability stays explicit in scenario
tokens.

Browser-only features such as Wiki notes, drafts, and appearance declare
`capabilities: []`: they still use real browser storage and verified bootstrap,
and must run on every declared applicable host. Do not invent a local-only
service dependency to exclude them from production. Use `openApp(page)` from
`support` instead of navigating to `/`: the deployed root is the marketing
site. `SMITHERS_REAL_APP_PATH` selects a same-origin app repository path; its
production default is `/codeplanesmithers/canary-sandbox`.

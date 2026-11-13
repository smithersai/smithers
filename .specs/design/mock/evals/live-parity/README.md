# Live parity

Compares the deployed port with the stage 1 mock, one view per case. Imports
mock-fidelity's views, state/route selection, crawl audit, DOM collector, crawl
scoring, rubric criteria, judge seat, retry policy and evidence budgets.
No browser launches, credentials are read, or artifacts are written on import.

Run from `.specs/design/mock` after a deploy (orchestrator only):

```sh
export PATH="$HOME/.nvm/versions/node/v26.5.0/bin:$PATH"
export LIVE_PARITY_RUN="port-$(date -u +%Y%m%dT%H%M%SZ)"
smthrs eval run evals/live-parity/live-parity.eval.ts --root . --run-id "$LIVE_PARITY_RUN"
node evals/live-parity/gaps.mjs "$LIVE_PARITY_RUN"
```

| Input | Default | Meaning |
| --- | --- | --- |
| `MOCK_DIST` | `dist-default-ui` | Built stage 1 mock, relative to mock root or absolute |
| `LIVE_BASE` | `https://smithers.sh` | Live HTTP(S) base; may include an install prefix |
| `LIVE_REPO` | `smithers-canary/smithers` | Live owner/repository |
| `LIVE_AUTH` | unset | Optional Playwright storage-state path for member observations |
| `LIVE_PARITY_RUN` | UTC timestamp + PID | Artifact directory ID; set to the CLI run ID for correlation |
| `MOCK_JUDGE_MODEL` | character eval judge seat | Shared mock-fidelity judge override |

Only maya/tinyhttp stories supply stage 1 screens, even if a default build also
registers later-stage product demos. All applicable stage 1 rows are cases.
Only ready and signed-out stories run. No auth means no member browser context;
signed-out observations always use a fresh context without storage state. A
member-only row without a public story reports `auth required`, never zero.

Edit `live-routes.json` when fixture records differ from the deployed repo:
exact repository-relative paths win over longest `/*` prefixes. A null path or
view means `not deployed`. Unmapped record paths also report `not deployed`;
no random live issue, PR, commit or run is silently substituted. Existing file
and issue mappings are candidates, not live verification. A live 404/410 or
rendered not-found page is `not deployed`; transport/500 failures are
`inconclusive`. Member 401/403 or login redirects require fresh auth. A 200
signed-out permission page is compared as an observable access-state delta.
Only `q` and `page` survive mapping. Uncut mock dialogs/act/ask/todo/preview/evidence
stories have no GET-only equivalent and report `not deployed`.

Each story is observed at 1440×900 and 390×844, light. Canonical ready (or first public) screenshots are named
`<view>-{mock,live}-{1440,390}.png`; additional stories use
`<view>--<screen>-{mock,live}-{1440,390}.png`, under
`.flows/evals/live-parity/<run>/`. A mock screenshot remains available for
unmapped stories; no live screenshot is invented. `<view>.json` retains paired
full DOM evidence, route/status, outcome and visibility limits. Scorer records
are `<view>.<scorer>.json`, including judge gaps and omission audits. The gap
script prints one Markdown table per view, top five deltas and every screenshot
pair, with incomplete coverage and Unobservable recorded separately. Missing
scorer records never report parity. The collector never copies cookies or
the storage-state file into its artifacts. Treat rendered member content as private.

Three scorers bind to every case:

- `live-clean`: imported crawl score, `max(0, 1 - findings/20)`, on comparable live
  observations. Dedupes repeated findings within a screen, as mock-fidelity does.
- `structure-parity`: matching checks / checks, normally eight per pair: ordered tab set,
  each of three header pieces, sidebar region set, primary count (or list-link presence), primary action
  label classes, and state-copy keys. Counts and repository content may differ.
  Content primaries exclude the Ask surface when DOM partitions are available.
- `parity-judge`: shared Rubric criteria for anatomy, primary and powers, against
  both bounded evidence sets and the complete spec row. Its `Gaps` and
  `Unobservable` are separate string lists. Each side gets half the shared budget;
  context overflow halves it once. Shared transient retries use 2s/8s backoff.

Each scorer must supply a finite numeric `score` from `0` to `1` before a view
can count as green. Missing or invalid results remain `inconclusive` and appear
in the report’s unobservable notes.

Scores apply to comparable pairs only. A partial view retains every unpaired
outcome; it is never proof that the whole view shipped. All-unavailable cases
fail scoring as inconclusive and keep the distinct collected outcome.

The collector never clicks, types, submits, or follows observed links. A context
request firewall allows GET only, blocks known action/logout/callback URLs and
all WebSockets, and disables service workers. Blocked background calls are
Unobservable: apps using POST for read RPCs may need a read-only port to supply
that evidence. The live audit imports `auditPage` and drops its mock-only link
format rules (hash-router registration and external-target conventions do not
apply to live relative links); it still checks dead/unnamed links, inert buttons,
field labels and overflow, plus live URL protocols. Link destinations and actual
button effects are not exercised; no claim of successful writes or working
closed menus is made. DOM evidence collection temporarily inserts/removes a
color probe, as mock-fidelity does; it makes no live product writes.

Report regression tests, from the workspace root:

```sh
node --test .specs/design/mock/evals/live-parity/gaps.test.ts
```

Offline tests, from workspace root, with fake collectors/executors and judges:

```sh
node --import ./.specs/design/mock/evals/mock-fidelity/test-runtime.mjs --test ./.specs/design/mock/evals/live-parity/live-parity.test.ts
bun test --preload ./.specs/design/mock/evals/mock-fidelity/test-runtime.mjs ./.specs/design/mock/evals/live-parity/live-parity.test.ts
```

## Monday scope (PM d-voicuo, 2026-10-18)

`monday-cuts.json` is the editable launch policy, not a change to the full mock.
It names cut views, tabs, header pieces and sidebar blocks, and assigns each
kept view to increment 1 or 2. Set `activeIncrement` to 1 for the first walk;
it defaults to 2 for the complete Monday target. Flows and Settings tabs are
excluded until increment 2. To cut Search at 20:00, add `search` to both
`cut.views` and `cut.headerPieces`. Search otherwise stays required.

Both scorers compare against the Monday policy. An absent cut tab, inbox or
Releases sidebar is recorded as `cut`, with no deduction. A visible cut feature
is a gap named `cut feature visible`, including links to cut subjects. The judge
receives the policy and Monday spec overrides for read-only Flows/Branches,
minimal Settings and held hosted acts. Raw paired evidence remains intact.
Structure primary comparisons for ready Flows/Settings are delegated to this
Monday judge contract because their full-mock primaries do not ship.

Cut views return outcome `cut` before auth, route mapping or browser launch;
this is a scope exclusion, **not verification that their live routes 404**.
Stack stories inside the shared `pulls-stack` case also report `cut`; the Pull
requests stories remain increment 1. `viewAliases` maps that existing case ID
to the PM's `pulls`. An uncut route without an equivalent remains `not deployed`.
The gap report includes an Increment column and totals for increments 1 and 2
plus cuts outside the increments. Missing scores, auth and partial observations
are never counted green; cut stories do not make an otherwise paired view partial.

`live-routes.json` defaults to the dogfood repo `smithers-canary/smithers`.
`LIVE_REPO=smithersai/smithers` retains the upstream mappings. Repository entries
can override shared paths and declare `declaredTabs: ["Docs"]`; leave this empty
unless that live repo declares Docs. Undeclared Docs is cut, including its view.
The upstream issue 4022 is not silently substituted for a canary issue: its
canary mapping is null until a real equivalent is supplied. File equivalents
remain candidates, subject to the normal HTTP/not-found checks.

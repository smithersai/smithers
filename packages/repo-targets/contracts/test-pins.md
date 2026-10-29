# Test-pin register and release-candidate posture

This file is the register every test pin must appear in, and the one-page
ledger of the 1.0.0-rc.0 posture and limits a reader would otherwise have to
discover from the test tree. The release train packs the `engine`, `agent` and
`tooling` groups at one synchronized version, and `publishedPackages` in
`.smithers/flows/release/pack-release.mjs` is the roster. These are statements of current
behavior, not promises of planned behavior.

## Support posture

The supported durable target is **Node.js with local SQLite**. Published
manifests declare `engines.node` as `>=26.4.0`, and the release workflow
runs the candidate tarballs on `26.4.0`. That floor is the Node the published packages support, and it is a
separate fact from the Node the toolchain runs: `.node-version` at the root
holds one exact release, `ci.yml` reads it through `node-version-file`,
`.github/scripts/ci/cloud.sh` bootstraps a Cloud runner from it, and
`packages/repo-targets/contracts/check-toolchain-pins.mjs` fails when it drops below the declared
floor or when a workflow names a release of its own. The durable database backend is
`@effect/sql-sqlite-node`; see
[SQLite only](../../../packages/smithers/flows/database/docs/concepts/sqlite-only.md)
before placing a database file on disk.

**PostgreSQL is supported; PGlite is not.** PostgreSQL is selected by
`SMITHERS_POSTGRES_URL` or `DATABASE_URL`, per the
[storage boundaries](../../../apps/site/docs/reference/support-matrix.md#storage).

Bun is a second runtime rather than a second support claim. `BunRuntime`
composes the durable engine on the native Bun SQL driver, the adapter declares
`engines.bun` as `>=1.4.0` while CI pins `1.4.1`, ten packages declare
`bunTest` targets, and `NativeRuntimeParity` covers a Node/Bun restart in both
directions; that is package and parity evidence, not a claim that every
application runs on Bun. Browsers bundle only and no browser execution suite
exists, so bundling establishes no durable-engine support. The
[support matrix](../../../apps/site/docs/reference/support-matrix.md#runtimes) states
the status of each runtime, platform and storage combination.

The repository is built and tested on one Effect release: every development
dependency, both override blocks and both lockfiles pin `effect` to exactly
`4.0.5`. A published library accepts the version `4.0.5` from its application
as a peer. `packages/repo-targets/contracts/check-single-effect-version.mjs` enforces the one tested
version across the workspace and the range in the published peers, and a
candidate that moves either records the move in
[CHANGELOG.md](../../../CHANGELOG.md).

The alpha control server defaults to loopback (`127.0.0.1`). A non-loopback
bind requires the explicit `--listen`/`listen: true` opt-in and does not add
TLS, token rotation, or multi-principal authorization. Keep ordinary alpha
use localhost-only; if an operator opts into a network bind, they must provide
the bearer-token and TLS/ingress protections described in the
[serve beyond loopback](../../../packages/smithers/gateway/docs/guides/serve-beyond-loopback.md).

### Advisory CI lanes

The required workspace, repository (flows, apps and evals), script, and
package-documentation gates run independently in `test`, `repository`,
`scripts`, and `docs`. Release retains all four selections.
Two lanes are advisory: the macOS
and Windows legs of the one `package suites (${{ matrix.os }})` matrix carry
`advisory: true` and inherit `continue-on-error: ${{ matrix.advisory }}`, while
its `ubuntu-latest` leg is required. An advisory failure establishes no support
for that host and does not block the required Node/Linux target.

The Windows lane remains red. On Windows, the `jj` package's symlink/dirent
assertions do not yet match Windows behavior. This is a tracked
CI-portability gap, not a waived required check; promote the Windows lane only
after its failures are fixed and repeated main-branch runs are green.

## Not in 1.0.0-rc.0

The release train packs the `engine`, `agent` and `tooling` groups together at
one synchronized version: the 49 names `publishedPackages` restates in
`.smithers/flows/release/pack-release.mjs` and checks against what the workspace declares. Four
tooling packages are public, `@smthrs/build`, `@smthrs/build-cli`,
`@smthrs/targets`; deployment and repository-local
tooling stays out of the roster through its manifest `private` flag.
Membership is not a proxy for feature scope, so a package can ship and still
not be a release-candidate feature. `@smthrs/triggers`, `@smthrs/evals` and
`@smthrs/scorers` publish as libraries an application wires itself; no CLI verb
composes them. Memory semantic recall and observability OTLP export are not
rc.0 features either, and `@smthrs/gateway` publishes because consumers need
its wire schemas while its supervision runtime is still a noop. The
[known limitations](../../../apps/site/docs/reference/support-matrix.md#known-limitations)
table records what each limit rests on; in particular, the published OTLP layer
is application-wired rather than a shipped default.

## Cutting a release

Start from a clean `main` checkout and run
`node .smithers/flows/release/cut-release.mjs <version> --commit`, without a `v` prefix.
The cut refuses detached HEADs, existing release tags, and branches other than
`main` unless `--allow-branch` explicitly permits a named branch.

The sequence bumps manifests and internal ranges, generates the changelog,
refreshes `pnpm-lock.yaml` with `pnpm install --lockfile-only --ignore-scripts`,
and refreshes a tracked `bun.lock` with
`bun install --lockfile-only --ignore-scripts`. It then checks the version and
runs `node .smithers/flows/release/generate-changelog.mjs --check --version <version>`.
`--commit` records the manifests and lockfiles, checks the changelog again on
the exact release commit, and creates an annotated `v<version>` tag locally.

The generated changelog must be regenerated for the exact release commit;
do not refresh it on a preparation branch and assume its commit count will
still match after integration. A stale block fails the cut before tagging.
Without `--commit`, the script prints the remaining commit, check, and tag
commands. Publishing requires a separate operator push.

The tag workflow uses `secrets.NPM_TOKEN` for `NODE_AUTH_TOKEN`, including the
first publication of names that cannot yet configure trusted publishing.
It retains provenance, publishes detached tag checkouts with `--no-git-checks`,
and waits two seconds between packages. Registry 404 responses allow a first
publication; 429 and 5xx responses retry, while other precheck failures stop.
Publication and transient prechecks get an initial attempt followed by at most
three retries after 10, 30, and 60 seconds.

The shipped-links gate builds the site before checking links:
`//apps/site:smithersLinks` depends on `//apps/site:build`. The link gate can also run by its own label
from a clean checkout; no earlier workflow step must supply `apps/site/dist`.

## Known test pins

A **pin** is a test the default gate does not run to a pass. Three forms count:

- `it.fails` / `test.fails`. The test asserts that current behavior is wrong, so
  the suite goes red on the day it starts passing.
- `.skip` / `.todo`. The test does not execute at all.
- `.skipIf` / `.runIf` on an environment variable nothing in the repo sets. The
  test executes only for someone who remembers it exists.

A `.skipIf` / `.runIf` on a platform, an installed binary, or a built artifact
is a capability gate rather than a pin, because it runs on the supported
configuration. `describe.skipIf(process.platform === "win32")`,
`describe.skipIf(!jjInstalled)` and `describe.skipIf(wasmBytes === undefined)`
are all capability gates, and CI installs `jj`, so the jj-gated suites execute
there. `process.env.CI` is a capability gate for the same reason.

Every pin in every package group (`smthrs.group` in each manifest) must appear
in the table below. `packages/repo-targets/contracts/check-test-pins.mjs` enforces that and CI runs it,
so a new pin fails the build until it is either fixed or written down here. The
1.0 release train packs the `engine` and `agent` groups together, so the
register covers `agent` as well; before 1.0 it covered `engine` and `tooling`
only.

### Surviving pins

| Package                       | Test                                                                                               | Form                                                        |
| ----------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `smithers/flows/platform-bun` | `executes the declared Bun lane in a Bun worker`                                                   | `it.skipIf(process.env.SMITHERS_PLATFORM_BUN_LANE === "1")` |
| `smithers/agent/harness`      | `workerd smoke`                                                                                    | `describe.skipIf(FLOWS_WORKERD_SMOKE !== "1")`              |
| `smithers/flows/platform-cloudflare` | `workerd smoke (FLOWS_WORKERD_SMOKE=1, ${Postgres.direct.label})`                         | `describe.skipIf(FLOWS_WORKERD_SMOKE !== "1")`              |
| `smithers/flows/database`     | `skipped: ${absent}`                                                                               | `it.skip` when nothing listens on the endpoint              |
| `smithers/agent/integrations` | `GitHub live contract (GITHUB_TOKEN)`                                                              | `describe.skipIf(GITHUB_TOKEN === undefined)`               |
| `smithers/build/targets`      | `SecretProxy brokered origins over the network`                                                    | `describe.runIf(SMITHERS_E2E_NETWORK === "1")`              |
| `smithers/agent/model`        | `OpenAIChatCompletions over Gemini`                                                                | `describe.skipIf(SMITHERS_LIVE_MODEL_TESTS !== "1"          |
| `smithers/migrate`            | `migrates a single-file JSX project through the bin (${reason})`                                   | `it.skip` when `SMITHERS_MIGRATE_SEAT` names no funded seat |
| `smithers/migrate`            | `records what a single-file project could not settle (${reason})`                                  | `it.skip` when `SMITHERS_MIGRATE_SEAT` names no funded seat |
| `smithers/migrate`            | `refuses what it cannot translate in a multi-workflow pack (${reason})`                            | `it.skip` when `SMITHERS_MIGRATE_SEAT` names no funded seat |
| `smithers`                    | `the smthrs init scaffold on a funded seat`                                                        | `describe.skipIf(SMITHERS_OPENAI_AUTH !== "chatgpt")`       |
| `smithers/build/build-cli`    | `answers the envelope contract through a real codex session`                                       | `it.skipIf(SMTHRS_CODEX_SMOKE !== "1")`                     |
| `smithers/agent/std`          | `streams a file larger than available memory (skipped: a hermetic test cannot exhaust its runner)` | `it.skip`                                                   |
| `testing`                     | `registers a skipped layered Effect body`                                                          | `test.skip`                                                 |
| `smithers`                    | `runs a prompt on the Codex subscription with no provider keys`                                    | `it.skipIf(SMITHERS_LIVE_MODEL_TESTS !== "1")`              |
| `smithers`                    | `ClaudeCode against the installed Claude Code`                                                     | `describe.runIf(SMITHERS_CLAUDE_CODE_SMOKE === "1")`        |
| `smithers`                    | `a flow on the installed Claude Code`                                                              | `describe.runIf(SMITHERS_CLAUDE_CODE_SMOKE === "1")`        |
| `smithers`                    | `GPT-6 Luna as the completion judge`                                                               | `describe.runIf(SMITHERS_LIVE_MODEL_TESTS === "1")`         |
| `smithers`                    | `Claude Haiku as the completion judge`                                                             | `describe.runIf(SMITHERS_CLAUDE_CODE_SMOKE === "1")`        |
| `smithers` | `Jev as the completion judge` | `describe.runIf(process.env.SMITHERS_JEV_CALIBRATION === "1")` |
| `smithers`                    | `CloudSandbox live workspace lifecycle`                                                            | `it.skipIf(SMITHERS_CLOUD_SANDBOX_SMOKE !== "1")`           |
| `smithers`                    | `PostgreSQL retains one native ancestry snapshot across a committed writer on a separate connection` | `it.skipIf(process.env.SMITHERS_TEST_PG_URL === undefined)` |
| `smithers`                    | `observing host over PostgreSQL`                                                                   | `describe.skipIf(!postgres)`                               |
| `smithers`                    | `C-INS-06 / C-INS-03 real CLI, launchd, bundled launcher and public origin`                        | `it.skipIf(!enabled && !required)`                          |
| `smithers/agent/harness`      | `ExternalTranscript with the installed CLIs`                                                       | `describe.skipIf(!enabled)`                                 |
| `smithers/agent/std`          | `C-COL-01 production dispatcher ${available ? "installed batch/delete/move" : "unavailable provider"}` | `test.skipIf(available && !installed)`                      |
| `smithers/agent`              | `runs the real OpenAI stack (requires SMITHERS_LIVE_EXAMPLES=1 and OPENAI_API_KEY)`                | `it.effect.skipIf(!liveEnabled \|\| !hasKey)`                |
| `smithers/agent`              | `decodes each local agent answer (requires SMITHERS_LIVE_EXAMPLES=1 and Ollama qwen2.5:7b)`         | `it.skipIf(!liveEnabled)`                                   |
| `smithers/agent`              | `isolates the deterministic suite from every ambient provider key`                                 | `it.skipIf(SMITHERS_LIVE_EXAMPLES === "1")`                 |
| `smithers` | `preserves an external writer's update after source validation` | `it.fails` |
| `smithers` | `a fresh clone of this repository (needs tracked-source inventory from jj/Git or SMITHERS_TEST_TRACKED_SOURCE_FILE)` | `it.skipIf` without checkout metadata or supplied inventory |
| `smithers/agent/model-host` | `known broken: a completed selection replays after the answer fails` | `test.fails` |
| `smithers/flows/platform-cloudflare` | `the command latency benchmark` | `describe.runIf` with `COMMAND_LATENCY_BENCH` and direct Postgres |
| `smithers/flows/sandbox` | `a job runs a ${LONG_SECONDS}-second command past SandboxTools' 600 s to its result (SANDBOX_LONG_COMMAND_SECONDS)` | `it.runIf(LONG_SECONDS > 0)` |

**Configuration ownership and callback replay:** `16d282b8981a` retained the
configuration writer race as known broken: another writer can replace the file
after validation because this filesystem path has no portable compare-and-swap.
Avoid concurrent external configuration writers. `b2ebc9fba284` retained the
model host's completed-selection replay defect: its legacy callback host has no
persistent replay port, so a failed answer can cause selection to run again.
Use the durable agent host for recovery. Both tests remain executable expected
failures; these rows record existing defects rather than introducing pins.

**Source inventory:** `49b08081d1cc` made the fresh-clone test require real
checkout metadata or `SMITHERS_TEST_TRACKED_SOURCE_FILE` in a source mirror.
Supply that inventory when testing a mirror; an ordinary checkout runs the test.
Without it the test cannot verify which source files a clone contains.

**Command duration measurements:** `38558f6db1e2` added the opt-in command
latency benchmark. Run the platform-cloudflare suite with direct Postgres and
`COMMAND_LATENCY_BENCH=1`; its ordinary timing regression cases remain enabled.
`52f15934` added the sandbox's long-command container proof; run its container
suite with `SANDBOX_LONG_COMMAND_SECONDS=660` and a reachable container host.
The default suite covers short commands; these explicit measurements establish
latency and completion beyond the 600-second tool budget when requested.

**`agent`: the live examples.** `test/examples/12-agent-live-smoke.test.ts`
calls OpenAI and `13-agent-live-smoke-local.test.ts` calls a local Ollama
`qwen2.5:7b`; both run only with `SMITHERS_LIVE_EXAMPLES=1` and their
provider. `environment.test.ts` asserts the default run sees no provider key,
so it steps aside when that opt-in hands the keys in. What breaks if it
regresses: the examples a user copies first could stop reaching a real model.
Workaround: run them with `SMITHERS_LIVE_EXAMPLES=1` and the provider set up.

**`smithers`: host service on launchd (C-INS-06, C-INS-03).**
`host-service.integration.test.ts` installs a real T-INS-01 bundle as a
per-user launchd agent and checks the public origin. It runs only on macOS, as
a non-root user, with `SMITHERS_HOST_TEST_BUNDLE` naming a built bundle. A
qualification run sets `SMITHERS_REQUIRE_HOST_SERVICE_TESTS=1` (C-INS-06) so a
missing bundle or host fails instead of skipping. What breaks if it regresses: `smthrs host install`
could stop starting the backend on a Mac. Workaround: build a bundle and run
it on a Mac with both variables set.

**`harness`: ExternalTranscript with the installed CLIs.**
`ExternalTranscript.live.test.ts` runs the person's installed Claude Code and
Codex CLIs and reads the transcripts they write. It needs those CLIs and their
logins, which CI does not have, so it runs only with
`SMITHERS_REAL_AGENT_CLI=1`. What breaks if it regresses: imported external
sessions could lose or misread tool calls. Workaround: run it on a machine with
both CLIs signed in.

**`std`: C-COL-01 installed dispatcher.** `StaleRead.integration.test.ts`
runs the production coding edit-atom bindings twice. The unavailable-provider
case always runs and proves the refusal. The installed batch/delete/move case
needs a broker-registered guest coding session with `/workspace`, so it runs
only with `SMITHERS_COL10_INSTALLED=1` inside one. What breaks if it
regresses: a stale read could overwrite an outside edit in a real session.
Workaround: run the command in the file's header inside a guest session.

**PostgreSQL storage.** The `smithers` history and database adapter tests
run with declared PostgreSQL services in their Linux test targets. The
database target sets `SMITHERS_TEST_PG_URL`, which moves every `TestDatabase`
case onto PostgreSQL. The `smithers` target's `env` sets only
`SMITHERS_HISTORY_TEST_PG_URL`, read by the history and observe-mode
PostgreSQL cases, because the CLI announces `SMITHERS_TEST_PG_URL` as an
ignored 0.x setting on stderr. A suite gated on a variable its package's test
target sets is a capability gate. The two conditionally run native-read and
observe-mode cases are registered above so an offline run's skipped PostgreSQL
coverage stays explicit.

**`migrate`: apply against a real model.** The three cases in
`packages/smithers/migrate/test/flow/MigrateFlow.live.e2e.test.ts` drive the migration
tool against a real model: they rewrite a 0.x JSX workflow, record what the
run could not settle, and refuse a multi-workflow pack the tool cannot
translate. Everything else under `test/flow` scripts the seat, so these are
the only cases that prove the contract, the prompt, and the captured sources
are enough for a model to produce a flow the registry discovers. They cost
real money and real minutes, and the package hard-codes no model id on
purpose, so the operator names the seat: set `SMITHERS_MIGRATE_SEAT` to a
`provider:model` seat and set that provider's key
(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `OPENROUTER_API_KEY`), then run
`pnpm --filter @smthrs/migrate test`. Without both, each case skips and says
which variable is missing rather than passing without doing the work. What
breaks if it regresses: an operator's migration could
stop producing a compiling flow and only the release rehearsal would find out.
Closing it for the default gate means paying for a model seat in CI, which
the RC does not do.
The GitHub live contract requires an explicit test repository and credentials.

**`harness` — workerd smoke.** The suite boots a real `workerd` process to
prove the QuickJS cell runtime runs unchanged on the Cloudflare runtime.
`workerd` is not a repository dependency and CI installs no binary for it, so
the suite is gated off the default run rather than failing on every machine
without one. What breaks if it regresses: the cell runtime could acquire a
Node-only dependency and nothing would notice until an edge deployment. Run it
with `FLOWS_WORKERD_SMOKE=1 pnpm --filter @smthrs/harness test` after
installing `workerd`. Closing it for the default gate means adding `workerd` to
the toolchain the CI lane installs, which the RC does not claim (see the
[support matrix](../../../apps/site/docs/reference/support-matrix.md#runtimes)).

**`migrate` — the three live-model cases.** `MigrateFlow.live.e2e.test.ts`
runs the migration flow against a real provider, and a real provider costs
money: the suite reads `SMITHERS_MIGRATE_SEAT` for a `provider:model` seat and
requires that provider's key, and skips with the reason in the test title when
either is missing. It is written as `it.skip` inside the no-seat branch rather
than `describe.skipIf` so the skipped titles carry the reason an operator has
to act on, which is why the register scanner counts three pins here. Everything
the flow does with the seat scripted is covered by the rest of `test/flow`;
what only a live call proves is that a real model's output still translates.
Run it with `SMITHERS_MIGRATE_SEAT=anthropic:<model> ANTHROPIC_API_KEY=... pnpm
--filter @smthrs/migrate test`. What breaks if it regresses: `smithers migrate`
could stop producing a flow the registry discovers, and only a paid run would
notice.

**`smithers`: the funded-seat init scaffold.** `Bin.test.ts` gates one suite
on a signed-in ChatGPT seat. It runs `smthrs init hello` and then
`smthrs up hello` against a real provider, which is the only way to hold the
claim `smthrs init` makes about the directory it writes. A real agent run
costs three to four minutes and real tokens, so the suite requires
`SMITHERS_OPENAI_AUTH=chatgpt` and the Codex auth file the CLI suite already
stages, and skips when either is absent. Every other `init` case asserts the
scaffold's contents against a scripted seat. What breaks if it regresses:
`smthrs init` writes a project `smthrs up` cannot run, and only a funded run
notices. Run it with `codex login`, then
`SMITHERS_OPENAI_AUTH=chatgpt pnpm --filter @smthrs/cli test`. Closing it for
the default gate means paying for a model seat in CI, which the RC does not do.

**`smithers`: the subscription host.** `SubscriptionHost.test.ts` starts the
real native host with an allowlisted environment that carries no provider API
keys, runs a one-prompt flow on the Codex subscription transport
(`SMITHERS_OPENAI_AUTH=chatgpt`), and asserts the run completed in both
databases, the requested model, the reply, and the completion judge's
decision. The host has no `AI_GATEWAY_API_KEY` and its environment reaches
no Claude Code login, so GPT-6 Luna judges on the same subscription through
the model-to-judge adapter, and the test asserts the decision says
`decidedBy: "seat"` and was metered on `gpt-6-luna`. A host that also has
Claude Code signed in judges on Claude Haiku first. Only a
real subscription call proves a user with no API key can run
a flow end to end. It spends subscription quota and minutes, so it requires
`SMITHERS_LIVE_MODEL_TESTS=1`, the same intent flag the Gemini contract uses,
plus a signed-in `CODEX_HOME`. What breaks if it regresses: the keyless
subscription path stops completing runs and only a funded run notices. Run it
with `codex login`, then
`SMITHERS_LIVE_MODEL_TESTS=1 pnpm --filter @smthrs/cli test`. Closing it for
the default gate means paying for a model seat in CI, which the RC does not do.

**`smithers`: the installed Claude Code seat.** `ClaudeCode.test.ts` gates
one suite on `SMITHERS_CLAUDE_CODE_SMOKE=1`: it sends three cell frames through
the real, signed-in Claude Code on one session, the last carrying a steering
message, and asserts the seat keeps the session and obeys the steer. Every
other case in that file drives the seat through a scripted `query`, so they
prove the options and the parse; only a real session proves Claude Code still
answers the way those scripts encode. It spends the operator's Claude
subscription, so it never runs by default. What breaks if it regresses: a
Claude Code release changes its session or streaming behavior and a user's
subscription seat stops completing runs. Run it with Claude Code signed in,
then `SMITHERS_CLAUDE_CODE_SMOKE=1 pnpm --filter @smthrs/cli test`
(`SMITHERS_CLAUDE_CODE_SMOKE_MODEL` picks the model; the default is `sonnet`).
Closing it for the default gate means spending subscription quota on every
run, which the RC does not do.

**`smithers`: a flow on the installed Claude Code.** `ClaudeCodeHost.test.ts`
gates one suite on `SMITHERS_CLAUDE_CODE_SMOKE=1`. It starts the real native
host with an allowlisted environment that carries no provider API key, no
Codex login and none of a parent Claude Code's session variables, and runs a
one-prompt flow on the `claude-code:sonnet` seat through the CLI
(`SMITHERS_CLAUDE_CODE_SMOKE_MODEL` picks the model). The first case passes
`AI_GATEWAY_API_KEY` to the host and asserts the run completed in both
databases, every model request on the `claude-code` route, the reply, and
Jev's `completion/claim` decision (`decidedBy: "jev"`). The second case
withholds that key and asserts what a host with a Claude subscription and
nothing else does: the run completes the same way, and Claude Haiku on the
same Claude Code judged it through the model-to-judge adapter
(`decidedBy: "seat"`, metered on `haiku`). `ClaudeCode.test.ts`
proves the seat alone; only this suite proves a flow reaches the signed-in
Claude Code through the CLI, the host and the judge. It spends the operator's
Claude subscription, so it never runs by default. What breaks if it
regresses: flows on a Claude subscription stop completing, or complete
unjudged, and only a signed-in run notices. Run it with Claude Code signed in
and `AI_GATEWAY_API_KEY` exported, then
`SMITHERS_CLAUDE_CODE_SMOKE=1 pnpm --filter @smthrs/cli exec vitest run test/ClaudeCodeHost.test.ts --coverage.enabled=false`.
A source checkout also needs the `smithers-jj-export` helper
(`cargo build --locked --release -p smithers-ffi --bin smithers-jj-export`).
The same gate opens one case in `.smithers/flows/test/wrapped.test.ts`, whose other
cases launch a fake `claude` script. It runs the `wrapped` flow against the
real `claude -p` under `plan` permission on a one-file working copy and
asserts the answer read from that file, the recorded session, and unchanged
sources. That launch runs under the operator's own settings, so their Claude
Code hooks fire. Run it with
`SMITHERS_CLAUDE_CODE_SMOKE=1 node --experimental-strip-types --test --test-name-pattern='installed Claude Code' .smithers/flows/test/wrapped.test.ts`.
Closing either for the default gate means spending subscription quota on
every run, which the RC does not do.

**`smithers`: the subscription judges, calibrated.**
`SubscriptionJudgeCalibration.test.ts` gates one suite per subscription judge:
GPT-6 Luna on `SMITHERS_LIVE_MODEL_TESTS=1`, Claude Haiku on
`SMITHERS_CLAUDE_CODE_SMOKE=1`, and Jev on
`SMITHERS_JEV_CALIBRATION=1` with the operator’s `AI_GATEWAY_API_KEY`.
Each reads completions through the path a run
takes, `CompletionClaim.read` over the judge a host with no
`AI_GATEWAY_API_KEY` binds, and holds every reading to the brake's own
thresholds. Four completions are read ten times each
(`SMITHERS_JUDGE_CALIBRATION_READINGS` changes the count): an honest
completion that says it was blocked and an honest refusal must never read
`invented` at 0.85 or more, a completion reporting a fix and a test run it
never made must always read there, and an honest finished completion must
stand without a bounce. Then every case of the harness's retained corpus is
read once: no honest case refused, every lie the evidence decides refused.
The scripted suites pin the adapter's prompt and the note the completion
classifiers send a seat; only real readings show where a model puts an honest
claim and a lie. Each suite spends about sixty judgments of the operator's
subscription or gateway account, so none runs by default. What breaks if it regresses: on a
host with no gateway key an honest completion ends `claim_unproven`, as GPT-6
Luna ended five honest shapes before #3825, or a lie stands. Run one with
`codex login`, then
`SMITHERS_LIVE_MODEL_TESTS=1 pnpm --filter @smthrs/cli exec vitest run test/SubscriptionJudgeCalibration.test.ts --coverage.enabled=false`,
or with Claude Code signed in and `SMITHERS_CLAUDE_CODE_SMOKE=1` in its place.
Closing it for the default gate means spending subscription quota on every
run, which the RC does not do.

**`smithers`: the live Cloud workspace.** `CloudSandbox.test.ts` gates one
case on `SMITHERS_CLOUD_SANDBOX_SMOKE=1`: it provisions a real Smithers Cloud
workspace for `SMITHERS_CLOUD_SANDBOX_REPOSITORY`, runs a command over SSH,
round-trips binary bytes, and releases the scope. Every other case in that file
drives `CloudSandbox` against a local HTTP double, so they prove the request
sequence and cancellation; only a live workspace proves the service still
provisions, grants SSH and deletes the way that double encodes. It needs a
Cloud login and a disposable repository, and each run starts a billable
workspace, so it never runs by default. What breaks if it regresses: scoped
sandboxes stop provisioning or leak workspaces for a user first. Run it as the
[Cloud sandbox guide](../../../packages/smithers/docs/guides/cloud-sandbox.md)
shows. Closing it for the default gate means a Cloud account and workspace
spend on every run, which the RC does not do.

**`build-cli`: the real codex session.** `AgentSession.test.ts` gates one case
on `SMTHRS_CODEX_SMOKE=1`: it opens a session through the installed `codex`
binary and asserts the envelope contract on what comes back. Every other case
in that file drives the same factory against a stub binary, so the stubs prove
the argv and the parse, and only a real session proves the CLI still answers
the shape those stubs encode. What breaks if it regresses: a `codex` release
changes its output and the build agent's envelope parse fails for a user
first. Run it with
`SMTHRS_CODEX_SMOKE=1 pnpm --filter @smthrs/build-cli test` on a machine with
`codex` signed in. Closing it for the default gate means spending model tokens
on every run, which the RC does not do.

**`model`: the Gemini chat-completions contract.** `GeminiChatCompletions.integration.test.ts`
runs the OpenAI-compatible Chat Completions protocol against Google's endpoint,
which is billable provider traffic. Two conditions gate it, and both are
deliberate: `GEMINI_API_KEY` supplies the credential, and
`SMITHERS_LIVE_MODEL_TESTS=1` states the intent, so a developer who merely has
a key exported does not turn an ordinary suite run into provider spend. The
fixture suites next to it prove the request shaping and the event decoding;
only a live call proves the endpoint still serves the protocol the route
assumes. What breaks if it regresses: Google changes the compatible endpoint
and a user's Gemini seat stops streaming. Run it with
`SMITHERS_LIVE_MODEL_TESTS=1 GEMINI_API_KEY=... pnpm --filter @smthrs/model test`.
Closing it for the default gate means paying for provider traffic on every
run, which the RC does not do.

**`std`: the larger-than-memory stream.** `SearchConformance.test.ts` pins one
`it.skip` whose title says why: the conformance suite proves `Grep` streams a
file instead of reading it whole, and the only direct proof is a file larger
than the runner's memory, which a hermetic test cannot create without
exhausting the process that runs it. The bounded-window and truncation cases
around it prove the same property on files that fit. What breaks if it
regresses: a search over a large file reads it whole and the runner, not the
caller, runs out of memory. Closing it means a dedicated runner with a
tmpfs larger than its heap, which the RC does not provision.

**`testing`: the skip registration case.** `Vitest.test.ts` pins one
`test.skip` on purpose: `@smthrs/testing/Vitest` wraps vitest's `test` with
Effect bodies, and the case proves that `.skip` on that wrapper registers a
skipped test rather than running the `Effect.die` it is handed. It is a test
of the skip form itself, so it can never execute. What breaks if it regresses:
a `.skip` on the wrapper runs the body, and a suite that parked a live case
starts paying for it. It stays a pin because vitest reports a skipped test
only by skipping it.

### Resolved: the database open-retry pin

`packages/smithers/flows/database` pinned "dies with the original lock defect after the fixed
open-retry budget is exhausted" behind `FLOWS_SLOW_TESTS=1` because every open
attempt blocked inside SQLite's own WAL-conversion wait, and exhausting the
retry ladder cost 220-240 s against the package's 30 s per-test budget.
`ef7ee4d0c0` gave the open path a read-only probe that exhausts the ladder
first. Against a lock nobody releases the case now costs 8.9 s, so it runs on
every gate as `reports database_locked after the fixed guard-retry budget is
exhausted` in `packages/smithers/flows/database/test/NodeDatabaseConcurrentOpen.test.ts`. A
resolved title does not authorize re-pinning the test: the guard reads the
Surviving pins table only, so a pin here again needs a new row above.

### Resolved: the audit's `it.fails` count

A 2026-08-16 readiness audit recorded "`it.fails` pins: 29
remain", distributed across engine-store, flow, kernel, time-travel,
capability, database, harness, jj, platform-node, sync, targets and
build-cli. That count was stale at the commit it was filed against. There are
no `it.fails` pins anywhere in `packages/` at `3fcf5fcd`:

```sh
git grep -n 'it\.fails\|test\.fails' -- packages   # no output
```

The last commit carrying any was `c890e65d`, with 12. All 12 were closed by
fixing the defect and flipping the pin, not by deleting the test — each one
still exists as a live assertion in the same file, and each of those suites is
green:

| Package      | Test                                                                                        | Now at                                 |
| ------------ | ------------------------------------------------------------------------------------------- | -------------------------------------- |
| `canonical`  | has no canonical form for a lone surrogate returned by `toJSON`                             | `test/Canonical.test.ts`               |
| `canonical`  | has no canonical form for a lone surrogate key returned by `toJSON`                         | `test/Canonical.test.ts`               |
| `capability` | bounds wall time for adversarial repeated-star patterns against long non-matching resources | `test/Capability.property.test.ts`     |
| `capability` | completes a 10k-character non-match for a repeated-star grant pattern                       | `test/Capability.test.ts`              |
| `flow`       | normalizes Windows and POSIX separator spellings when comparing overlaps                    | `test/FileBoundary.test.ts`            |
| `flow`       | rejects separator variants of the same written and removed path                             | `test/FileBoundary.test.ts`            |
| `flow`       | rejects a very deep `AndThen` graph with a typed error instead of overflowing the stack     | `test/Graph.test.ts`                   |
| `flow`       | rejects a cyclic unknown payload with a typed error instead of overflowing the stack        | `test/Graph.test.ts`                   |
| `flow`       | rejects a very deep unknown payload with a typed error instead of overflowing the stack     | `test/Graph.test.ts`                   |
| `kernel`     | rejects an envelope carrying request-only payload fields                                    | `test/GrantEvent.test.ts`              |
| `kernel`     | fails closed when a page repeats its last sequence with `hasMore`                           | `test/JournalGrantStoreReplay.test.ts` |
| `keys`       | rejects an unsupported `key2_` key until its complete format is implemented                 | `test/Key.test.ts`                     |

Agent-group packages are outside this register and outside the guard; F4's
`harness` entry belongs to that group.

## Known limitations

The agent gateway does **not** automatically recover abandoned runs in the
private alpha (audit P1-2). `@smthrs/gateway` has no supervision port; no
production gateway layer connects to the durable engine's run-driver sweep.

Consequently, a run abandoned by its gateway host is not discovered, reclaimed,
or resumed by the gateway. Operators must recover it explicitly, or use a host
composition that runs the durable engine driver with the relevant flows
registered. Do not rely on unattended gateway recovery for alpha workloads.

This limitation can be retired after a production gateway composition wires
the engine recovery path and a crash-recovery test proves that a stale owner is
reclaimed and the run makes progress automatically.

The rest of what release 1 declines to do is documented where the behavior
lives. The items an alpha operator hits first:

- **Recovery has no deadline.** Inside a process that is already running the
  engine, the 30-second stale cutoff is an eligibility floor, not a
  recovery-time objective: a run becomes eligible only after its heartbeat is
  older than the cutoff, the sweep re-drives at most 64 stale rows per
  one-second tick, and a caller-supplied `isAlive` can refuse the steal for
  unbounded time. See the
  [known limitations](../../../apps/site/docs/reference/support-matrix.md#known-limitations)
  table.
- **Flow registrations are in-memory.** A restarted process resumes nothing
  until it re-registers the handlers for its stored runs, because registration
  is what re-arms durable clocks and deferred wakes.
- **The production layer packages two levels, and only one of them is
  complete.** `NodeRuntime.layer` from `@smthrs/platform-node` composes database, migrations,
  stores, and the engine, and leaves host services, the step boundary, and the
  workspace sandbox to the caller. `NodeRuntime.layerHost` adds the rest: the
  contained Node host, the guarded `HostServices` kernel over an unattended
  grant store, the default step boundary and filesystem workspace sandbox, the
  liveness probe, and `SIGINT`/`SIGTERM` shutdown bounded by
  `shutdownTimeoutMs`. A program that composes `layer` still owes `Crypto`,
  `FileSystem`, and `Jj`, and installs its own signal handlers.
  `packages/smithers/flows/platform-node/src/TestNodeRuntime.ts` is the worked composition, and
  [the platform-node API page](../../../packages/smithers/flows/platform-node/docs/api.md#noderuntime)
  lists both entry points.
- **Detached child flows need a composed child port.** A host that composes
  `EngineChildren` runs `agent/spawn`, `agent/send` and `agent/await` as real
  linked runs; a composition that supplies no child port refuses all three with
  `ChildError` code `unsupported`, and `agent/await` polls the child's run row
  rather than parking the caller
  ([subagents](../../../packages/smithers/agent/docs/guides/subagents.md)).
- **Cross-process wake is polled.** The in-process `WakeBus` completes a
  resume signal directly; a wake published from another process still lands
  through polling and the stale sweep.
- **Copy-back applies without a human gate.** The engine applies a settled
  diff bundle to the host itself. The pending-diff review gate is a spec, not
  shipped behavior.

The [support matrix](../../../apps/site/docs/reference/support-matrix.md) is the
authoritative list; this section names only the limits that change how an
alpha pilot is operated.

## Adding a pin

Prefer fixing the defect. If a pin is genuinely the right call:

1. Keep the test executable in some configuration — an env-gated `runIf` beats
   a bare `.skip`, because a skipped test rots silently.
2. Add a comment on the pin pointing at this file.
3. Add a row to **Surviving pins** and a paragraph saying why it is pinned,
   what breaks if the behavior regresses, and the workaround.

`node --test packages/repo-targets/contracts/check-test-pins.test.mjs` enforces step 3. Steps 1 and 2
are review conventions; nothing checks them.

**`database` — transaction-pooling endpoints.** `test/PostgresPooling.test.ts`
runs its suite against PgBouncer in transaction-pooling mode (`apps/mvp`'s
compose service on port 54322), which stands in for Cloudflare Hyperdrive, and
against direct Postgres. An endpoint with nothing listening registers one
`it.skip` that names the missing service and how to start it, instead of
failing the package. If this regresses, a store that sets session state outside
a transaction breaks behind Hyperdrive in production. The workaround is to run
`pnpm db:up` in `apps/mvp` first. Retire the pin by having the package's
`testProgram` start PgBouncer beside its PostgreSQL.

**`platform-cloudflare` — workerd smoke.** `FLOWS_WORKERD_SMOKE=1` runs a real
Durable Object with a real alarm and `ctx.abort()` mid-step against local
Hyperdrive, as `harness`'s smoke does. It needs workerd and Postgres, which the
default gate does not start.

**`platform-bun` — nested runner guard.** The ordinary Node suite starts the
declared Bun test runner and asserts that its selected test runs inside Bun.
`SMITHERS_PLATFORM_BUN_LANE=1` prevents that child from starting another child;
the verification still runs in the default Node suite. This is a recursion
guard, not an unexecuted compatibility case.

### Burndown infrastructure recovery (#3367)

`packages/smithers/test/faults/burndown-infrastructure.test.ts` is discovered by
`//packages/smithers:faults`. It drives real CLI admission, durable SQLite runs,
N=2 children per fault, and an N=3 control with external processes and serial
per-child landing. Ordinary tests validate setup, exact fault signatures,
child identities/content/uniqueness/order, and cleanup. The former capability
ceiling expected-failure pin is retired explicitly: its assertion asked generic
execute to invent a new work identity after a terminal refusal. That behavior
belongs to the caller, which decides whether repeating work is appropriate.
The generic refusal is now an ordinary control requiring the exact typed
`Fail/capabilities/completed` conflict and unchanged unique original work.

The actual issue-sweep terminal-only policy is copied byte-for-byte into a
public CLI fixture. Terminal children permit fresh identities after their old
workers exit; a live running conflict is refused without duplicate children.
A separate status/error table covers suspended, pending, unknown and malformed
refusals. Identity/capability admission is unchanged. This is replacement with
owning-boundary acceptance, not conversion of the old raw failure into a pass.
The original raw expected-failure receipts remain linked in
[the suite README](../../../packages/smithers/test/faults/README-burndown.md).

The new host-SIGKILL/restart fixture joins one retained keyed ExternalJob without
resume, and edits the entry/layer/imported helper to verify approved bytes survive
restart. Ready-timer recovery is tracked in #3408. Current qualification retains
a disk setup failure (`hdiutil: Device not configured`), before guard execution;
historical disk passes do not qualify the current host. #3367 remains open for
these limits and provider/full campaign evidence.

Host stalls, slow catalog loads, typed agent/action DNS recovery, source edits
are ordinary regression cases; the disk guard retains historical green
evidence and a current host capability failure. [#3372](https://github.com/smithersai/smithers/issues/3372)
reconfirms ownership after a real 23-second SIGSTOP; the same workers finish
without manual resume. The slow load retries through first-use catalog loading, and the owning landing
policy from [#3369](https://github.com/smithersai/smithers/issues/3369) retries real DNS after restoration. The generic agent-facing probe is
a separate keyed durable action after successful irreversible Work; its real
`Unreachable` faults use default engine transient retries, preserving Work and
all once-only worker exit codes. Historical pre-fix red receipts are
retained in the README. Disk pressure uses a dedicated 32MiB macOS HFS+ volume;
a visible platform capability receipt accompanies its Linux capability skip.
No SDK replacement, virtual clock, fabricated journal, host-wide DNS change,
or host-disk filling is used. These bounded faults do not claim a 75-minute
outage, real provider calls, microVM boot, or actual git fetch/push/apply.

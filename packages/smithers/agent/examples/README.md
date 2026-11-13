# Agent examples

The agent examples run in the package suite: run `pnpm run check` and
`pnpm exec vitest run test/examples` in `packages/smithers/agent`. Live model
examples require explicit opt-in with `SMITHERS_LIVE_EXAMPLES=1`. An ambient
provider key or a running Ollama daemon never selects them on its own.

To run a live test from `packages/smithers/agent`:

```sh
# Also requires OPENAI_API_KEY in the environment.
SMITHERS_LIVE_EXAMPLES=1 pnpm exec vitest run test/examples/12-agent-live-smoke.test.ts

# Requires Ollama at localhost:11434 and ollama pull qwen2.5:7b.
SMITHERS_LIVE_EXAMPLES=1 pnpm exec vitest run test/examples/13-agent-live-smoke-local.test.ts

# Also requires GEMINI_API_KEY in the environment.
SMITHERS_LIVE_EXAMPLES=1 pnpm exec vitest run test/examples/14-agent-live-smoke-gemini.test.ts
```

All three tests allow 300 seconds for model work. Without opt-in they report
skipped with their requirements in the test titles. The OpenAI and Gemini
tests also skip without their provider key; the local test reports a skip
reason if its daemon or model is missing. All three declarations defer loading
their native agent implementations until the
test bodies execute. The selection fixture verifies the real opt-in gates and
rejects eager implementation imports while collecting the declarations.

## Use cases

`use-cases/` holds 1.0 ports of the 0.x examples that patterns.smithers.sh
links to, one file per old example, named after it. Each runs offline on
`use-cases/kit.ts`, which answers every agent seat from a script. To run
one test:

```sh
pnpm exec vitest run test/examples/use-cases/triage.test.ts
```

The shared kit uses stable callback admission. Declare every semantic capture
with `Node.capture` and read the frozen snapshot through `this` in a function
expression. Include an implementation version when a callback delegates to a
helper; bump it when that helper changes. Raw callbacks are refused before
dispatch.

The first use-case collection declares literal catalog descriptions, capability
ceilings and effect envelopes. The scripted agents have no tools, so their
resource lists are empty. Examples with host-specific command, repository or
publishing actions declare `modelInvocable: false`. A live host supplies those
implementations and the tools and resource declarations its work requires.

`branch-doctor` reports `executed` when at least one command ran and `succeeded`
when those commands all succeeded. An empty safe-command list dispatches no
executor. The command watchdog, flake hunter and Bun port accept agent-reported
command evidence and explicitly set `claimCap: 0` for those steps. A positive
host `claimCap` arms completion verification for steps that do not override it;
omitting it leaves that brake off.

`dstack.main(input, executionId, env, database)` requires an execution id. Reuse
that id and database to resume the recorded run; choose a new id for new work.
The standalone command takes the input JSON followed by the execution id.

The calendar example uses an explicit `idempotencyKey` first, then `threadId`.
When neither is supplied, it derives the write key from the complete parsed
scheduling request. The event and reply share that key; repeating the same
request retains it.

The ETL port is sample-only: it passes at most five records to transform and at
most five transformed records to load. Omitted records are never processed by
later stages. Counts are agent reports, not verified loads.

The Bun port validates `.zig` paths before any phase starts and reports
`partial` if a requested phase returns `partial`, `failed` or no report.
`unknownApprovalThreshold` belongs to the parent approval gate, not the
lifetime child. Branch selection and worktree placement belong to the host.

Runbook ratification shows the proposed rule and rationale. Its count comes from
the same supersession list saved with the proposal, so retries and unrelated
memory writes do not change it.

Use-case fan-outs key their members by input position, so repeated requirement
ids, ticket ids, item ids, or check names still run separately. The service-desk
classifier preserves each ticket's `description` and `submitter`; triage
preserves the full source item in `content`. Social action agents receive the
normalized inbox item beside its classification.

`retry-budget-manager.ts` stops when the policy sets `shouldRetry: false`,
even with budget remaining. `monitor-workflow.ts` persists the previous
`Health` and matching count between beats. Healing waits for two consecutive
samples of the same condition, target, and ownership state; a missed sample
resets that evidence. The interpreter supplies the examples' human tasks.

`tweet-thread.ts` bounds each irreversible post to 30 seconds and aborts the
HTTP request on cancellation. A malformed successful response fails with
`PostRefused`: the posting outcome is uncertain, so the engine never retries
it automatically.

The `tweet-thread` implementation takes the host's Effect `HttpClient`
(for example, `FetchHttpClient.layer` from `effect/http`) and reads
`X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN` and `X_ACCESS_SECRET`
through redacted Effect `Config` on each post. Tests supply a
`ConfigProvider` and recording HTTP service; they never replace global
`fetch` or change the process environment.

`rfp-response-room` counts drafts against `confidenceThreshold` and
counts a rejected review with no listed reasons as one blocker.

## Sandbox filesystem tools

`25-agent-tools-in-sandbox.ts` exposes only `read` and `write`, with
capabilities restricted to the scratch root. Tool paths are relative to that
root. The host filesystem service rejects absolute paths, `..` components,
symlinks (including dangling links), and hard-linked files. Nested file creation
and replacement remain supported. Root names cannot contain capability glob
characters (`*` or `?`).

On POSIX the scratch root must belong to the running user and grant no group or
other permissions (mode `0700`); `main` creates it that way and refuses any other
root, so no other user can reach the tree whatever its inner modes. Windows skips
this check because it has no POSIX owner or mode bits.
The host must still exclusively own the scratch tree during the run. Path checks
do not provide an OS boundary against another process of the same user racing
filesystem mutations. QuickJS bounds cell evaluation; the supplied host service confines
tool access. The optional third `main` argument supplies a model for exercising
other cells; the default model is scripted and requires no API key.

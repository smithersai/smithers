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

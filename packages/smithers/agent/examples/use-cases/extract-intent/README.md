# extract-intent

Pulls your own strategy and spec statements out of your coding-agent history. It reads the prompts you typed into
Claude Code and Codex, keeps the ones that state strategy, a spec or a standing process rule, and writes them per
project in your own words.

```
history.jsonl, rollouts ─ collect ─▶ filter ─▶ Jev, 64 per step: keep / unsure / drop
   ─▶ keep + unsure, chunked by project ─▶ Claude Code or Codex labels each chunk ─▶ assemble ─▶ <out>/
```

Jev is `@smthrs/model`'s `Classifier` over an `Evaluator`: one cheap yes-or-no reading per prompt, so the agent CLI
reads only what Jev kept or could not settle. The agent CLI runs read-only in a temporary directory and replies with
ids and labels; the script joins them with your exact text.

## Run it

You need Claude Code or Codex signed in, and `AI_GATEWAY_API_KEY` (a Vercel AI Gateway key) for Jev. From
`packages/smithers/agent`, after the workspace install:

```sh
run() { VIBELANG_PROJECT=tsconfig.test.json node --import vibelang/register examples/use-cases/extract-intent/src/main.vibe "$@"; }
run --out /tmp/intent --last 150 --chunk-chars 40000   # a small first slice
run --out ~/intent                                     # every prompt in ~/.claude, $CLAUDE_CONFIG_DIR, ~/.codex, $CODEX_HOME
run --out ~/intent --worker codex --model <model id>
run --out ~/intent --claude ~/other/claude-home --codex ~/other/codex-home
```

`VIBELANG_PROJECT` names the package's test tsconfig, which includes `examples/` and opts in to VibeLang's
experimental modules.

## Durable and incremental

The flow runs on VibeLang's `Experimental.Durable`. Each collect, Jev batch, worker chunk and assemble is one journaled
step in `<out>/durable.sqlite`. Kill the run, or let it stop on a usage limit, then run the same command: finished steps
replay from the journal, and the run continues at the step that stopped, with whichever `--worker` you name now. A
finished run writes `<out>/state.json`; the next run takes only prompts newer than its watermark and adds them to the
output.

The number of Jev and worker steps depends on what collect found. A `@smthrs/flow` body fixes its topology at plan
time, so on that engine this flow would be a lineage of rounds, each carrying the earlier rounds' results in its
payload ([trampoline rounds](../../../../flows/flow/docs/concepts/trampoline-rounds.md)).

## Output

- `<out>/projects/<project>.md`: the core messages of each project with 8 or more.
- `<out>/projects/<project> (supporting).md`: its messages that are mostly a task but carry some intent.
- `<out>/projects/other projects.md`: every project with fewer than 8.
- `<out>/all.jsonl`: every item, one JSON object per line.

Credentials and phone numbers are redacted. The script never opens `auth.json`, `.credentials.json` or a keychain.

## Tests

`test/examples/use-cases/extract-intent/` runs collect, filter, chunk, redact and assemble on invented histories in
both tools' formats, and the whole flow on the real durable engine with Jev and the worker scripted: a run stopped at
chunk 2 resumes there, and a later run takes only newer prompts.

```sh
pnpm exec vitest run test/examples/use-cases/extract-intent
```

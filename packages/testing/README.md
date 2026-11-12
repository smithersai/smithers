# @smthrs/testing

Release candidate scope, host requirements and compatibility review are defined in the [library support policy](https://github.com/smithersai/smithers/blob/main/RELEASE_SUPPORT.md).

This package declares `effect` as an exact `4.1.1` peer dependency. Install one
`effect` release at that version so all Smithers packages share one Effect
runtime.

**Documentation:** https://github.com/smithersai/smithers/tree/main/packages/testing/docs

Testing and conformance library for Smithers flows. It provides layered engine
and model doubles, pure plan and journal assertions, restart and parity suites,
Vitest adapters, and deterministic score gates.

`@smthrs/testing/ScoreGate` re-exports the pure grading contract from
`@smthrs/scorers/ScoreGate` and adds the fixed-suite runner and `ciGrade`
report helper. Runtime applications import scorers directly; testing stays a
development dependency. `TestingError.ScoreGateError`, `ScoreGateCode`, and
`InvalidScoreSample` re-export the same class and schemas from scorers, so
constructor identity, tags, fields, and existing test imports are preserved.

## Install

```bash
npm install @smthrs/testing@next effect
```

`effect` is a required peer at exactly `4.1.1`. `vitest` and
`@effect/vitest` are optional peers, needed only by the `Vitest` adapter.
Everything else runs under any runner, because an assertion is an ordinary
`Effect` and a conformance case is a plain value. Node.js 26.4.0 or later is
required.

## What is in it

- **Assertions** over the artifacts a flow produces: `PlanAssertions` for a
  built plan, `JournalAssertions` for a journal, `Divergence` for the first
  attributable difference between two journals, `ScoreGate` for graded eval
  suites.
- **Layer bundles** that make a tier explicit: `TestLayers.unit` for the unit
  tier, `TestLayers.poisoned` for plan-time purity, and `TestHost` for a fully
  deterministic host surface.
- **Conformance suites** an implementation must pass: `Conformance.coreSuite`
  for any engine, `HostSuite.hostSuite` for any Host bundle.
- **Doubles**: `MemoryEngine` and `RestartableEngine` as reference engines,
  `FlowEngineLike` as the adapter that runs the same pins against the real
  engine, `RecordedModel`, `RecordingModel`, `CachedModel` and
  `CachedEvaluator` as the record-and-replay model loop, `TurnGate` to hold a
  turn, and `ModelServer` to serve all of it over HTTP.

`@smthrs/testing/TestHost` supplies the deterministic host services a run
needs, while `@smthrs/journal` supplies `TestJournal`. This package also
supplies what a test says about the run those services produced and the doubles
the run executes against.

Every module, every export, and the contract of each is at
<https://github.com/smithersai/smithers/blob/main/packages/testing/docs/api.md>.

## Inspect real processes

`@smthrs/testing/ProcessTable` queries explicit POSIX `ps` columns with a
64 MiB buffer. Select a PID for resident-size and state probes, or scan the
table for containment checks. Use `comm` for executable names and `args`
when a script marker must be distinguished from its interpreter. Spawn
failures throw; an absent selected PID returns empty text. This Node-only
helper stays off the main barrel so browser test hosts remain portable.

## Certify an engine in fifteen lines

```ts
import { Conformance, EngineSubject, FlowEngineLike } from "@smthrs/testing"
import { describe, it } from "@smthrs/testing/Vitest"
import * as Effect from "effect/Effect"

const subject = FlowEngineLike.layerMemory

describe("engine conformance", () => {
  for (const conformanceCase of Conformance.coreSuite()) {
    it.scoped(conformanceCase.name, () =>
      Effect.flatMap(EngineSubject.EngineSubject, conformanceCase.run).pipe(
        Effect.provide(subject)
      ))
  }
})
```

Nine black-box pins run: identity, interruption, replay, and race. The race and
interrupt cases advance a `TestClock`, which is why they are registered through
`it.scoped` rather than `it.live`.

## Record, then replay

A model test runs the same code twice. The first run has no fixture, so it
calls the provider and writes what came back. Every run after it reads that file
and never touches the network. `CachedModel` is both halves.

```ts
import { CachedModel, FixtureStore } from "@smthrs/testing"
import { Effect, Layer } from "effect"
import { fileURLToPath } from "node:url"

const fixture = fileURLToPath(new URL("./fixtures/balance.json", import.meta.url))

const modelLayer = Layer.unwrap(
  Effect.map(
    Effect.acquireRelease(FixtureStore.makeFile(fixture), (store) => store.flush()),
    (store) => CachedModel.layer({ live: liveModel(), fixture: store })
  )
)
```

The library modules read no environment variable, so how a suite decides to
record stays the suite's business. Two rules the recorder follows, because a fixture is
executable state: an interrupted or dead call is not recorded, because a
truncated stream would replay as an aborted turn; and a call the `@smthrs/kernel`
permission kernel refused is not recorded either, because the provider never saw
it.

`RecordedModel` is the strict double instead: it claims each recorded call once,
matches by request shape with `modelId` erased, and dies on a request the
fixture does not describe.

## Serve a recorded model over HTTP

An install under test calls its model from another process, so a layer cannot
replace it. `smthrs-model-server` serves a fixture as a local OpenAI-compatible
endpoint: Chat Completions turns and AI Gateway judgments, recorded once
against a real provider and replayed with no network after.

```bash
# Record. The key is read from the named variable and never written.
AI_GATEWAY_API_KEY=... npx smthrs-model-server --fixture test/fixtures/install.json \
  --record --upstream https://ai-gateway.vercel.sh --key-env AI_GATEWAY_API_KEY
# Replay. A request the fixture does not hold is a 501.
npx smthrs-model-server --fixture test/fixtures/install.json
```

It prints `{"url":"http://127.0.0.1:<port>"}`; point the install's provider at
it. `--hold <regex>` holds a matching turn until `POST /__testing/release/<key>`.
See the [guide](./docs/guides/serve-a-recorded-model.md).

## Script the turns a recording cannot make

A recording replays what a real model said. A test that needs a planner to ask
a question, an edit to break the build once, or a turn to wait on cue scripts
those turns instead. `ScriptedModel` answers from a script and hands every
other turn to a fallback, usually a `CachedModel`. `BuiltinScript` is the
script for Smithers' own built-in flows, steered by directive tags in a TODO's
prompt:

```bash
npx smthrs-model-server --script builtin --trace evidence/turns.jsonl
```

```ts
import { BuiltinScript } from "@smthrs/testing"

const prompt = `${BuiltinScript.tag({ ask: true, hold: "t2" })} Add a greeting to JOURNEY.md`
```

See the [guide](./docs/guides/script-a-model.md).

## Seven modules stay off the root barrel

The root entry point exports module namespaces, including `RealCliDriver`
and `TerminalRecording`. Seven additional modules are reachable only by subpath.

`TestHost` is the deterministic host bundle: an in-memory filesystem, scripted
interpreter, `TestClock`, and seeded PRNG. It remains a subpath so importing
generic assertion helpers does not initialize test-only platform services.

`Vitest` is ESM only. `vitest` refuses to load through `require()`, so a barrel
that carried it would break `require("@smthrs/testing")` for every CommonJS
consumer of the assertion helpers.

`Faults` is not a double: it is a set of real, machine-global fault primitives.
`killProcess` sends a real signal to a real pid and waits for the operating
system to reap it, `parentPid` and `waitForReparent` read the orphan a kill
leaves behind, and `skewClock` moves the wall clock a durable timer is measured
against. Importing it by subpath keeps that decision visible at the import site.

```ts
import { isAlive, killProcess, waitForReparent } from "@smthrs/testing/Faults"

await killProcess(engine.process)
const reparented = await waitForReparent(orphan, engine.process.pid!)
```

Pids, process groups, and ports are machine global, so give a suite that uses
`Faults` its own tree and its own runner config: `fileParallelism: false`, a
finite timeout, and coverage off.

`ProcessTable` spawns `ps` through `node:child_process`, which browser test
hosts cannot load, so it stays at `@smthrs/testing/ProcessTable`. See
[Inspect real processes](#inspect-real-processes).

`ModelServer` listens through `node:http`, and `ModelServerCli` and `TurnLog`
write files through `node:fs`, so they stay at `@smthrs/testing/ModelServer`,
`@smthrs/testing/ModelServerCli` and `@smthrs/testing/TurnLog`. See
[Serve a recorded model over HTTP](#serve-a-recorded-model-over-http).

`@smthrs/testing/package.json` is also exported. `internal/*` and nested
`*/index` subpaths are not public.

## Integration test tools

The full `pnpm test --run` suite uses real loopback servers, private file
publication, and GIF rendering. It requires no TTY, credentials, or live model.
Provide these tools explicitly on every runner, including a Cloudflare box:

- `smithers-jj-export` from the same Smithers source revision
  (`smithers-ffi` 0.1.0, Rust toolchain from `rust-toolchain.toml`). Build at
  the repository root with
  `cargo build --locked --release --package smithers-ffi --bin smithers-jj-export`.
  The host resolves `target/release/smithers-jj-export`; an absolute
  `SMITHERS_WORKSPACE_JJ_EXPORT_BINARY` overrides it.
- FFmpeg 7+ and ffprobe on PATH, with drawtext, fontconfig, palettegen and paletteuse,
  plus a monospace font (for example `fonts-dejavu-core` 2.37).
  `SMITHERS_TEST_FFMPEG` and `SMITHERS_TEST_FFPROBE` select explicit
  executables for the integration cases; the public default renderer is also
  exercised from PATH. `FONTCONFIG_FILE` selects a font configuration and is passed
  to the real renderer along with PATH.

Global setup resolves these tools before workers start. Privacy tests first
publish a readable control with the same native service, so a missing helper
cannot pass a refusal case. Conversion failures still use faulty Effect
services; successful rendering always uses FFmpeg and is decoded by ffprobe.

A source-only `run-heavy` upload omits ignored native builds. Include the
built helper with `--add target/release/smithers-jj-export`, and include or
install the renderer and fonts as declared job inputs. The node26 image
currently supplies neither the native helper nor FFmpeg. Merely installing
the pnpm workspace does not install those host tools.

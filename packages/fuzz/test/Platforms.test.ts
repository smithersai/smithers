// Vitest collects this TypeScript test tooling; the entry under test is the published root.
import { build } from "esbuild"
import { execFileSync } from "node:child_process"
import { TextDecoder, TextEncoder } from "node:util"
import { runInNewContext } from "node:vm"
import { assert, it } from "vitest"

it("the complete root imports and runs without Node globals", async () => {
  const built = await build({
    stdin: {
      contents:
        `import {Fuzz,FuzzSimulation} from './src/index.ts'; import {Arbitrary,Effect} from 'effect'; globalThis.result=Effect.runPromise(Fuzz.run(Arbitrary.Constant(1), n=>n===1, { executions: 3, execution: FuzzSimulation.execution() }));`,
      resolveDir: process.cwd()
    },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: "es2022"
  })
  const realm = { TextEncoder, TextDecoder, setTimeout, clearTimeout, queueMicrotask, console }
  runInNewContext(built.outputFiles[0]!.text, realm)
  const report = await (realm as typeof realm & { result: Promise<{ _tag: string; stats: { executions: number } }> })
    .result
  assert.strictEqual(report._tag, "Passed")
  assert.strictEqual(report.stats.executions, 3)
})

it("Bun runs the published root with virtual time", () => {
  const output = execFileSync("bun", [
    "--eval",
    `import { Fuzz, FuzzSimulation } from './src/index.ts'; import { Arbitrary, Effect } from 'effect'; const r = await Effect.runPromise(Fuzz.run(Arbitrary.Constant(1), () => Effect.as(Effect.sleep('1 second'), true), { executions: 3, execution: FuzzSimulation.execution() })); console.log(r._tag, r.stats.executions);`
  ], { encoding: "utf8" })
  assert.strictEqual(output.trim(), "Passed 3")
})

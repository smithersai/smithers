import { execFile } from "node:child_process"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"
import { describe, expect, it } from "vitest"
import { bundle, coverageBundlePath } from "./fixtures/bundle.ts"

const execute = promisify(execFile)

// Vitest's subprocess coverage measures this real, freezable V8 realm. Inline
// source maps attribute the emitted script's execution to the authored source.
const program = `
import { readFileSync } from 'node:fs';
import { constants, createContext, Script, SourceTextModule } from 'node:vm';
const url = process.argv[1];
const realm = createContext(constants.DONT_CONTEXTIFY);
let refusal;
try {
  const module = new SourceTextModule(readFileSync(new URL(url), 'utf8'), { identifier: url, context: realm });
  await module.link(() => { throw new Error('The presentation bundle must contain every import'); });
  await module.evaluate({ timeout: 5000 });
}
catch (error) { refusal = String(error); }
const evaluate = source => new Script(source).runInContext(realm, { timeout: 5000 });
const installed = evaluate('typeof __smithersPresentation');
const result = { refusal, installed };
if (!refusal) {
  result.frozen = evaluate('Object.isFrozen(globalThis) && Object.isFrozen(Object.prototype)');
  result.guardEnumerable = evaluate("Object.getOwnPropertyDescriptor(globalThis, '__smithersHostGuard').enumerable");
  result.components = JSON.parse(evaluate('JSON.stringify(__smithersPresentation.components)'));
  result.html = evaluate("__smithersPresentation.render((require, module, exports) => { exports.default = () => require('react').createElement('p', null, 'installed') }, '{}', 'null')");
}
process.stdout.write(JSON.stringify(result));
`

const run = async (name: string) => {
  const coverage = process.env.NODE_V8_COVERAGE
  const result = await execute(process.execPath, [
    "--experimental-vm-modules",
    "--input-type=module",
    "--eval",
    program,
    pathToFileURL(coverageBundlePath(name)).href
  ], {
    // A built bundle needs no credentials or loader from the parent process.
    env: coverage === undefined ? {} : { NODE_V8_COVERAGE: coverage },
    timeout: 10_000,
    maxBuffer: 64 * 1024
  })
  return JSON.parse(result.stdout)
}

describe("presentation installation in a freezable realm", () => {
  it("publishes the guarded renderer and freezes the realm it exposes", async () => {
    await bundle({ sourcemap: true })
    expect(await run("guarded")).toEqual({
      installed: "object",
      frozen: true,
      guardEnumerable: false,
      components: ["Badge", "Button", "Card"],
      html: "<p>installed</p>"
    })
  })

  it("refuses a real renderer that does not guard forged elements", async () => {
    await bundle({ guarded: false, sourcemap: true })
    expect(await run("unguarded")).toEqual({
      installed: "undefined",
      refusal: expect.stringContaining("does not guard what it emits")
    })
  })

  for (const rendererFailure of ["value", "message"] as const) {
    it(`refuses a renderer's ${rendererFailure} failure that does not prove the guard ran`, async () => {
      await bundle({ rendererFailure, sourcemap: true })
      expect(await run(rendererFailure)).toEqual({
        installed: "undefined",
        refusal: expect.stringContaining("does not guard what it emits")
      })
    })
  }
})

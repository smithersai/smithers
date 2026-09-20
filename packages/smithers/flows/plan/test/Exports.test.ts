import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const packageRoot = fileURLToPath(new URL("../", import.meta.url))

/**
 * Runs a resolution probe in a cold Node process. A consumer's import goes
 * through Node's package resolver and the export map, not through the test
 * runner's, so only a real process proves what a consumer sees.
 */
const probe = (args: ReadonlyArray<string>): Record<string, string> =>
  JSON.parse(execFileSync(process.execPath, [...args], { cwd: packageRoot, encoding: "utf8" })) as Record<
    string,
    string
  >

describe("package exports", () => {
  it("exposes the scheduling policy through its explicit subpath under ESM and CommonJS", () => {
    const evaluate = `const policy = scheduling.make({ steps: 1 });
      const result = policy.admit([
        { node: { id: "low", kind: "step", priority: 0 }, order: 0, waited: 0 },
        { node: { id: "high", kind: "step", priority: 1 }, order: 1, waited: 0 }
      ], { steps: 0, agents: 0 });
      console.log(JSON.stringify({ admitted: result.admitted[0].node.id }));`
    expect(
      probe(["--input-type=module", "--eval", `import * as scheduling from "@smthrs/plan/Scheduling"; ${evaluate}`])
    )
      .toEqual({ admitted: "high" })
    expect(probe(["--eval", `const scheduling = require("@smthrs/plan/Scheduling"); ${evaluate}`]))
      .toEqual({ admitted: "high" })
  })
})

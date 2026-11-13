import { execFile } from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { expect, it } from "vitest"

// Enough probes that one missed stamp branch stays above every global floor,
// while ten unexercised probes fall below all four.
const actions = 200

it("rejects coverage below the measured floors and accepts complete behavioral coverage", async ({ signal }) => {
  const root = await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-coverage-policy-"))
  const config = new URL("../vitest.config.ts", import.meta.url).href
  const bin = fileURLToPath(new URL("../node_modules/vitest/vitest.mjs", import.meta.url))
  try {
    await Fs.mkdir(Path.join(root, "src"))
    await Fs.symlink(
      fileURLToPath(new URL("../node_modules", import.meta.url)),
      Path.join(root, "node_modules"),
      "junction"
    )
    await Fs.writeFile(Path.join(root, "package.json"), JSON.stringify({ type: "module" }))
    await Fs.writeFile(
      Path.join(root, "vitest.config.mjs"),
      `import original from ${JSON.stringify(config)}
export default {
  ...original,
  plugins: [],
  test: {
    ...original.test,
    include: ["probe.test.js"],
    coverage: { ...original.test.coverage, reportsDirectory: "coverage", reporter: ["text"] }
  }
}
`
    )
    await Fs.writeFile(
      Path.join(root, "src/probe.js"),
      Array.from(
        { length: actions },
        (_, index) => `export const action${index} = (value) => {\n  return value ? "accepted" : "refused"\n}`
      ).join("\n")
    )
    const run = async (count: number, completeStamp?: boolean) => {
      if (completeStamp !== undefined) {
        await Fs.writeFile(
          Path.join(root, "src/StampExec.ts"),
          "export const metadata = (tagged) => tagged ? \"\" : \"dev\""
        )
      }
      await Fs.writeFile(
        Path.join(root, "probe.test.js"),
        `import { expect, it } from "vitest"
import * as probe from "./src/probe.js"
${completeStamp === undefined ? "" : "import { metadata } from \"./src/StampExec.ts\""}
it("exercises both outcomes of every admitted action", () => {
  for (let index = 0; index < ${count}; index++) {
    expect(probe["action" + index](true)).toBe("accepted")
    expect(probe["action" + index](false)).toBe("refused")
  }
  ${completeStamp === undefined ? "" : "expect(metadata(false)).toBe(\"dev\")"}
  ${completeStamp === true ? "expect(metadata(true)).toBe(\"\")" : ""}
})
`
      )
      try {
        const result = await promisify(execFile)(process.execPath, [bin, "run", "--config", "vitest.config.mjs"], {
          cwd: root,
          env: process.env,
          encoding: "utf8",
          maxBuffer: 4 * 1024 * 1024,
          signal
        })
        return { code: 0, output: result.stdout + result.stderr }
      } catch (error) {
        const failure = error as { code: number; stdout: string; stderr: string }
        return { code: failure.code, output: failure.stdout + failure.stderr }
      }
    }
    const incomplete = await run(actions - 10)
    expect(incomplete.code, incomplete.output).toBe(1)
    for (
      const [metric, floor] of Object.entries({ branches: 99.28, functions: 99.48, lines: 99.8, statements: 99.71 })
    ) {
      expect(incomplete.output).toContain(`Coverage for ${metric}`)
      expect(incomplete.output).toContain(`threshold (${floor}%)`)
    }
    const complete = await run(actions)
    expect(complete.code, complete.output).toBe(0)
    expect(complete.output).toContain("1 passed")
    // Every global probe is fully covered, but one stamp branch is missing.
    // The stamp-specific 100% floor must fail independently of the global floors.
    const incompleteStamp = await run(actions, false)
    expect(incompleteStamp.code, incompleteStamp.output).toBe(1)
    expect(incompleteStamp.output).toContain("Coverage for branches")
    expect(incompleteStamp.output).toContain("\"src/StampExec.ts\" threshold (100%)")
    expect(incompleteStamp.output).not.toContain("global threshold")
    const completeStamp = await run(actions, true)
    expect(completeStamp.code, completeStamp.output).toBe(0)
    expect(completeStamp.output).toContain("1 passed")
  } finally {
    await Fs.rm(root, { recursive: true, force: true })
  }
})

/**
 * A durable flow loads code from the repository it works on (#4718): the
 * issue's reproduction runs through the real CLI host and returns the
 * target's TypeScript version, and a load of an unmeasured file beside the
 * flow fails the run with an error that names the file.
 */
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const executable = fileURLToPath(new URL("../src/bin.ts", import.meta.url))
const scriptedHost = fileURLToPath(new URL("./fixtures/scripted-native-host.ts", import.meta.url))
const nodeModules = fileURLToPath(new URL("../node_modules", import.meta.url))

/** The issue's `tool.mjs`, byte for byte. */
const tool = `import { createRequire } from "node:module"
import { join } from "node:path"
// The repository the flow works on brings its own TypeScript.
export const version = (target) => createRequire(join(target, "package.json"))("typescript").version
`

/** The issue's `flow.ts`, with the flow name and the tool it calls as the only parameters. */
const flow = (name: string, call: string) =>
  `import { Action, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, Schema } from "effect"
import { version } from "./tool.mjs"
const Version = Action.make("${name}/Version", { implementationVersion: "1", payload: { target: Schema.String }, success: Schema.String })
export const layer = Version.toLayer(({ target }) => Effect.sync(() => ${call}), { implementationVersion: "1" })
export default Flow.make("${name}", {
  description: "Report the TypeScript version the target repository installs",
  capabilities: [], effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize" },
  payload: { target: Schema.String }, success: Schema.String,
  body: Node.capture({ implementationVersion: "1" }, (input: { target: string }) => Version.call(input))
})
`

/** Loads a file beside the flow that no import names, so nothing measured it. */
const sneakTool = `import { createRequire } from "node:module"
export const version = () => createRequire(import.meta.url)("./unmeasured.cjs").version
`

describe("a durable flow loading code by a computed path", () => {
  it("returns the target repository's TypeScript version and refuses an unmeasured file beside the flow", () => {
    const base = realpathSync(mkdtempSync(join(process.env.SMITHERS_TEST_SCRATCH ?? tmpdir(), "smithers-load-target-")))
    const cwd = join(base, "project")
    const target = join(base, "target")
    try {
      for (const directory of [".smithers/flows/load", ".smithers/flows/sneak", ".flows"]) {
        mkdirSync(join(cwd, directory), { recursive: true })
      }
      symlinkSync(nodeModules, join(cwd, "node_modules"), "dir")
      writeFileSync(join(cwd, ".smithers/flows/load/tool.mjs"), tool)
      writeFileSync(join(cwd, ".smithers/flows/load/flow.ts"), flow("load", "version(target)"))
      writeFileSync(join(cwd, ".smithers/flows/sneak/tool.mjs"), sneakTool)
      writeFileSync(join(cwd, ".smithers/flows/sneak/flow.ts"), flow("sneak", "version(target)"))
      writeFileSync(join(cwd, ".smithers/flows/sneak/unmeasured.cjs"), `exports.version = "unmeasured"`)
      // A version no host installs, so the answer can only be the target's.
      mkdirSync(join(target, "node_modules/typescript"), { recursive: true })
      writeFileSync(join(target, "package.json"), JSON.stringify({ name: "target" }))
      writeFileSync(join(target, "node_modules/typescript/package.json"), JSON.stringify({ main: "index.js" }))
      writeFileSync(join(target, "node_modules/typescript/index.js"), `exports.version = "9.9.9-target"`)

      const smthrs = (...args: ReadonlyArray<string>) => {
        const result = spawnSync(
          process.execPath,
          ["--no-warnings", "--import", scriptedHost, executable, ...args, "--format", "json"],
          {
            cwd,
            encoding: "utf8",
            timeout: 300_000,
            maxBuffer: 16 * 1024 * 1024,
            env: {
              ...process.env,
              HOME: cwd,
              XDG_CONFIG_HOME: join(cwd, "config"),
              NODE_OPTIONS: "",
              SMITHERS_REMOTE: ""
            }
          }
        )
        expect(result.error, result.stderr).toBeUndefined()
        return { status: result.status, text: result.stdout + result.stderr }
      }
      const input = JSON.stringify({ target })

      const started = smthrs("flow", "start", "load", "--data", input, "--wait")
      expect(started.text).not.toContain("cannot pin")
      expect(JSON.parse(started.text), started.text).toMatchObject({ _tag: "Accepted", status: "completed" })
      const shown = smthrs("runs", "show", (JSON.parse(started.text) as { runId: string }).runId)
      expect(shown.text).toContain("\"finalOutput\": \"9.9.9-target\"")

      const refused = smthrs("flow", "start", "sneak", "--data", input, "--wait")
      const outcome = JSON.parse(refused.text) as { status: string; runId: string }
      expect(outcome.status, refused.text).toBe("failed")
      const evidence = refused.text + smthrs("runs", "logs", outcome.runId).text
      expect(evidence).toContain("UnmeasuredLoadError")
      expect(evidence).toContain(join(cwd, ".smithers/flows/sneak/unmeasured.cjs"))
      expect(evidence).not.toContain("\"finalOutput\": \"unmeasured\"")
      // Every measured copy the loads wrote is gone.
      for (const name of ["load", "sneak"]) {
        expect(readdirSync(join(cwd, ".smithers/flows", name)).filter((file) => file.startsWith("smithers-"))).toEqual(
          []
        )
      }
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  }, 900_000)
})

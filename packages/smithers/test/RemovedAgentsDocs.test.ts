import { spawnSync } from "node:child_process"
import { expect, it } from "vitest"
import { makeCli } from "../src/Cli.ts"

it("keeps removed agents out of discovery while explicit help explains removal", async () => {
  const cli = makeCli({ environment: { NO_COLOR: "1" } }, { humanHelp: true })
  const run = async (args: string[]) => {
    let output = "", status = 0
    await cli.serve(args, {
      stdout: (text) => {
        output += text
      },
      exit: (code) => {
        status = code
      }
    })
    return { output, status }
  }
  const root = await run(["--help"])
  expect(root.status).toBe(0)
  expect(root.output).not.toMatch(/^\s+agents\s/m)
  const manifest = await run(["--llms-full", "--format", "json"])
  expect(JSON.parse(manifest.output).commands.some((command: { name: string }) => command.name === "agents")).toBe(
    false
  )
  const explicit = spawnSync(process.execPath, ["bin/smithers.mjs", "agents", "--help"], { encoding: "utf8" })
  expect(explicit.status, explicit.stderr).toBe(0)
  expect(explicit.stdout).toMatch(/removed in 1\.0\.0-rc\.0/i)
})

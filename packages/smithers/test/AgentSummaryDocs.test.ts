import { expect, it } from "vitest"
import { makeCli } from "../src/Cli.ts"

it("sd4-cli-ref-4: agent discovery and explicit help share the configuration summary", async () => {
  const cli = makeCli({ environment: { NO_COLOR: "1" } }, { humanHelp: true })
  const run = async (args: string[]) => {
    let output = ""
    await cli.serve(args, {
      stdout: (text) => {
        output += text
      }
    })
    return output
  }
  const explicit = await run(["agent", "--help"])
  expect(explicit).toContain("Configure an agent")
  const root = await run(["--help"])
  expect(root).toMatch(/^\s+agent\s+Configure an agent$/m)
})

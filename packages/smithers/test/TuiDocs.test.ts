import { expect, it } from "vitest"
import { makeCli } from "../src/Cli.ts"

it("documents the token override without claiming the TUI default is unbounded", async () => {
  let output = ""
  await makeCli({ environment: { NO_COLOR: "1" } }).serve(["tui", "--help"], {
    stdout: (text) => {
      output += text
    }
  })
  expect(output).toContain("--budget-tokens")
  expect(output).toContain("Override the token ceiling per turn and worker")
  expect(output).not.toContain("unbounded by default")
})

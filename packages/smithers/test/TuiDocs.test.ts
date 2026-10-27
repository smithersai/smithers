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
  expect(output).toContain("Token cap per turn and worker (default 200M; 0 or none disables)")
  expect(output).toContain("--budget-daily-tokens")
  expect(output).toContain("Token cap per UTC day on this machine (default 2B; 0 or none disables)")
  expect(output).not.toContain("unbounded by default")
})

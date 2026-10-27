import { readFileSync } from "node:fs"
import { expect, it } from "vitest"

it("the generator reference lists implemented resources", () => {
  const reference = readFileSync(new URL("../docs/reference/cli/README.md", import.meta.url), "utf8")
  const source = readFileSync(new URL("../src/cli/Generate.ts", import.meta.url), "utf8")
  const commands = reference.match(/generate ([a-z/]+)/)![1]!.split("/")
  for (const command of commands) expect(source).toContain(`.command("${command}",`)
})

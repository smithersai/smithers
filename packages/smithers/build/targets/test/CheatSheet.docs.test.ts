import { readFileSync } from "node:fs"
import { expect, it } from "vitest"
import { Smithers as S } from "../src/index.ts"

it("sd4-samples-4: cheat-sheet references resolve on the public factories", () => {
  const guide = readFileSync(new URL("../docs/reference/cheat-sheet.md", import.meta.url), "utf8")
  const flags = S.Flags({ production: "--production" })
  const agents = S.Agents({ codex: S.Agent.Codex({ model: "gpt-6-luna" }), reviewers: S.Agent.Pool(["codex"]) })
  const production = guide.match(/const productionFlag = ([^\n]+)/)![1]!
  const reviewer = guide.match(/const reviewer = ([^\n]+)/)![1]!
  expect(Function("S", "flags", `return ${production}`)(S, flags)).toEqual(S.Flags.production)
  expect(Function("S", "agents", `return ${reviewer}`)(S, agents)).toEqual(S.Agents.reviewers)
})

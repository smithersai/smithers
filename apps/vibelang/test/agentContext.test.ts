// @vitest-environment node
// The agent's system context is VibeLang's own skill, generated into worker/agentContext.ts (decision 0010). It must
// match the installed `vibelang`, so a VibeLang upgrade can't leave the agent teaching an older language.
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"
import { AGENT_CONTEXT } from "../worker/agentContext.ts"

it("is generated from the installed VibeLang skill", () => {
  const script = fileURLToPath(new URL("../scripts/agent-context.mjs", import.meta.url))
  const check = spawnSync(process.execPath, [script, "--check"], { encoding: "utf8" })
  expect(check.status, check.stderr).toBe(0)
  expect(AGENT_CONTEXT).toContain("You are the VibeLang agent on vibelang.smithers.sh")
  expect(AGENT_CONTEXT).toContain("`effect` goes exactly where `async` goes")
  expect(AGENT_CONTEXT).not.toMatch(/^---/)
})

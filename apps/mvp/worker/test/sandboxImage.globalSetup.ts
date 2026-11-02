// Sandbox suites build the deployment image once per Vitest invocation. Packing
// before any workers start also prevents concurrent suites replacing cli/ while
// Docker reads it. A targeted run without these suites does no image work.
import { execFileSync, spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import type { TestProject } from "vitest/node"

export const sandboxImage = "smithers-branch-sandbox:test"
const context = fileURLToPath(new URL("../../infra/sandbox/", import.meta.url))
const suites = ["branch/Probe", "flows/CiJob", "personal/AgentCli", "secrets/Setup"]

export const setup = (project: TestProject) => {
  // Vitest registers selected paths before global setup. Re-globbing here
  // would lose CLI filters and pack even for unrelated targeted tests.
  const selected = project.vitest.state.getPaths().filter(file => suites.some(suite => file.endsWith(`/worker/${suite}.docker.test.ts`)))
  const engines = new Set(selected.map(file => file.endsWith("/personal/AgentCli.docker.test.ts") ? process.env["SANDBOX_TEST_ENGINE"] ?? "docker" : "docker"))
  const available = [...engines].filter(engine => spawnSync(engine, ["version", "--format", "{{.Server.Version}}"], { stdio: "ignore" }).status === 0)
  if (available.length === 0) return
  // Always pack this checkout, just as deploy does. --if-missing would allow a
  // previous invocation's CLI to stand in for the code under test.
  execFileSync(process.execPath, [fileURLToPath(new URL("../../infra/sandbox/pack-cli.mjs", import.meta.url))], { stdio: "inherit", timeout: 900_000 })
  for (const engine of available) execFileSync(engine, ["build", "-t", sandboxImage, context], { stdio: "inherit", timeout: 900_000 })
}

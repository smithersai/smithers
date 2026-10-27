import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import * as Host from "../src/internal/backend/HostService.ts"

it("reports an absent installation without probing launchd or disclosing the home path", async () => {
  const root = await mkdtemp(join(tmpdir(), "smthrs-host-absent-"))
  const system: Host.Launchd = {
    agentsDir: join(root, "Library", "LaunchAgents"),
    domain: "gui/501",
    launchctl: () => {
      throw new Error("An absent installation must not invoke launchctl")
    }
  }
  try {
    await expect(Host.status(system, join(root, "state"))).rejects.toMatchObject({
      fault: "dependency",
      code: "host_not_installed",
      message: "Host is not installed"
    })
    expect(() => Host.installedBundle(system)).toThrow("Host is not installed")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

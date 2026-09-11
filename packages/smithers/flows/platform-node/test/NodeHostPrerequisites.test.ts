import { describe, expect, it } from "@effect/vitest"
import { readFileSync } from "node:fs"

const installation = readFileSync(new URL("../docs/installation.md", import.meta.url), "utf8")
const quickstart = readFileSync(new URL("../docs/quickstart.md", import.meta.url), "utf8")

describe("NodeHost prerequisite documentation", () => {
  it("requires supported jj when constructing every complete host bundle", () => {
    const requirements = installation.split("## Host requirements")[1]?.split("###")[0]
    expect(requirements).toMatch(/\|[^\n]*jj[^\n]*0\.39\.0[^\n]*construction/)
    for (const factory of ["layer", "layerAt", "layerContained", "layerContainedAt"]) {
      expect(installation).toContain(`\`NodeHost.${factory}\``)
    }
    expect(installation).toContain("`not_installed`")
    expect(installation).toContain("`unsupported_version`")
    expect(installation).not.toContain("every other tag works without it")
    expect(installation).not.toContain("Nothing else in the bundle is affected")
  })

  it("lists supported jj before the quickstart constructs the raw host", () => {
    const prerequisites = quickstart.split("## Prerequisites")[1]?.split("## ")[0]
    expect(prerequisites).toMatch(/jj[^\n]*0\.39\.0/)
    expect(prerequisites).toContain("jj --version")
  })

  it("shows individual filesystem, spawner and HTTP layers without a complete bundle", () => {
    const example = installation.split("## Individual services without jj")[1]?.split("## ")[0]
    expect(example).toContain("NodeHost.AtomicFileSystem.layer")
    expect(example).toContain("NodeHost.NodeChildProcessSpawner.layer")
    expect(example).toContain("NodeHost.NodeHttpClient.layerUndici")
    expect(example).toContain("Layer.provide(platform)")
    expect(example).not.toContain("NodeHost.layer")
  })

  it("marks the allow-all grant store as a test seam wherever a page composes it", () => {
    for (const page of [installation, quickstart]) {
      expect(page).toContain("Layer.provide(GrantStore.layerNoop)")
      expect(page).toContain("not a production policy")
      expect(page).toContain("https://kernel.smithers.sh/guides/write-a-capability-policy/")
    }
  })
})

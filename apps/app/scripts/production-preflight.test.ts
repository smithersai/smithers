import { describe, expect, test } from "bun:test"
import { productionBuild } from "./production-preflight"

const deployed = "b".repeat(40)
const serving = (body: unknown, status = 200) => async () => Response.json(body, { status })
const cloud = (buildSha: string) => ({ apiVersion: 1, host: "cloud", buildSha })

describe("production preflight", () => {
  test("names the build the deployment serves", async () => {
    expect(await productionBuild("https://example.test", undefined, serving(cloud(deployed)))).toBe(deployed)
  })

  test("a build pinned by matrix readiness must still be the one served", async () => {
    expect(await productionBuild("https://example.test", deployed, serving(cloud(deployed)))).toBe(deployed)
    await expect(productionBuild("https://example.test", "c".repeat(40), serving(cloud(deployed))))
      .rejects.toThrow(`Production deployment changed since readiness: ${"c".repeat(40)} is now ${deployed}.`)
  })

  test("refuses a host that is not a stamped cloud deployment", async () => {
    await expect(productionBuild("https://example.test", undefined, serving({ host: "local", buildSha: deployed })))
      .rejects.toThrow("Production preflight requires a cloud host with an exact deployed revision.")
    await expect(productionBuild("https://example.test", undefined, serving(cloud("dev"))))
      .rejects.toThrow("Production preflight requires a cloud host with an exact deployed revision.")
    await expect(productionBuild("https://example.test", undefined, serving({}, 503))).rejects.toThrow("Production bootstrap failed: HTTP 503")
  })
})

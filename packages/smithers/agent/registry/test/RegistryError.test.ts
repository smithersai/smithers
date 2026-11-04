import { describe, expect, it } from "vitest"
import * as Errors from "../src/RegistryError.vibe"

describe("registry errors", () => {
  it("formats discovery and registry operation data", () => {
    const cause = new Error("permission denied")
    expect(
      Errors.discoveryError({ code: "read_failed", method: "scan", description: "permission denied", cause })
    ).toMatchObject({
      _tag: "flows/registry/DiscoveryError",
      code: "read_failed",
      module: "Discovery",
      method: "scan",
      message: "read_failed: Discovery.scan: permission denied",
      cause
    })
    expect(Errors.registryError({ code: "not_found", module: "Lookup", method: "get" })).toMatchObject({
      _tag: "flows/registry/RegistryError",
      code: "not_found",
      module: "Lookup",
      method: "get",
      message: "not_found: Lookup.get"
    })
  })

  it("retains a structured path without changing the formatted message", () => {
    const discoveryPath = "/project/flows"
    const registryPath = "/project/packs/review/pack.json"
    const discovery = Errors.discoveryError({
      code: "read_failed",
      method: "scan",
      path: discoveryPath,
      description: `source at "${discoveryPath}" could not be read`
    })
    const registry = Errors.registryError({
      code: "invalid_pack",
      module: "Pack",
      method: "read",
      path: registryPath,
      description: `the pack manifest at "${registryPath}" is not valid`
    })

    expect(discovery.path).toBe(discoveryPath)
    expect(discovery.message).toBe(
      `read_failed: Discovery.scan: source at "${discoveryPath}" could not be read`
    )
    expect(registry.path).toBe(registryPath)
    expect(registry.message).toBe(
      `invalid_pack: Pack.read: the pack manifest at "${registryPath}" is not valid`
    )
  })
})

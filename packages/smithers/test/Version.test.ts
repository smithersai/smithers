/**
 * The version the entrypoint reports.
 *
 * `--version` is the one answer a packaging mistake can silently corrupt, so
 * the module refuses to load metadata that does not declare a string version
 * rather than printing `undefined` to an operator.
 */
import { describe, expect, it } from "vitest"
import { packageVersion, readVersion } from "../src/Version.ts"

describe("Version.packageVersion", () => {
  it("refuses package metadata that declares no version string", () => {
    expect(() => readVersion({ name: "@smthrs/cli" } as { readonly version?: unknown })).toThrow(
      "@smthrs/cli package metadata does not declare a version"
    )
    expect(typeof packageVersion).toBe("string")
    expect(packageVersion.length).toBeGreaterThan(0)
  })
})

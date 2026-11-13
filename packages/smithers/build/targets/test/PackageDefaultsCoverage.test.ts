import { expect, it } from "vitest"
import * as Input from "../src/Input.ts"
import * as PackageDefaults from "../src/PackageDefaults.ts"

it("recognizes and applies a dense nonempty exclusion list", () => {
  const declaration = PackageDefaults.PackageDefaults({
    directories: Input.glob("packages/*", { exclude: ["packages/vendor", "packages/legacy"] }),
    macro: () => ({})
  })
  expect(PackageDefaults.isPackageDefaults(declaration)).toBe(true)
  expect(PackageDefaults.matches(declaration, "", "packages/current")).toBe(true)
  expect(PackageDefaults.matches(declaration, "", "packages/vendor")).toBe(false)
  expect(PackageDefaults.matches(declaration, "", "packages/legacy")).toBe(false)
})

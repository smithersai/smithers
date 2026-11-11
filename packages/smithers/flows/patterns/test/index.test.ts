import { describe, it } from "@effect/vitest"
import { readdirSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect } from "vitest"
import * as Patterns from "../src/index.ts"

const sourceDirectory = fileURLToPath(new URL("../src/", import.meta.url))

const moduleNames = (directory: string): ReadonlyArray<string> =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) {
      return entry.name === "internal" ? [] : moduleNames(join(directory, entry.name))
    }
    // A module is a `.ts` or `.vibe` source; `x.d.vibe.ts` is VibeLang's generated sidecar.
    const module = /^(?<name>[^.]+)\.(?:ts|vibe)$/.exec(entry.name)?.groups?.name
    if (!entry.isFile() || module === undefined || module === "index") return []
    return [module]
  })

describe("package barrel", () => {
  it("exports every public source module as a defined namespace", () => {
    const barrel: Readonly<Record<string, unknown>> = Patterns

    for (const name of moduleNames(sourceDirectory)) {
      expect(barrel).toHaveProperty(name)
      expect(typeof barrel[name]).toBe("object")
    }
    for (const namespace of Object.values(barrel)) {
      expect(namespace).not.toBeUndefined()
    }
  })
})

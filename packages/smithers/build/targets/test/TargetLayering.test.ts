import { describe, expect, it } from "@effect/vitest"
import * as NodeFs from "node:fs"
import * as NodePath from "node:path"
import { fileURLToPath } from "node:url"

const srcDir = fileURLToPath(new URL("../src/", import.meta.url))

/** Runtime import specifiers of one module; `import type` lines carry no runtime edge. */
const runtimeImports = (file: string): ReadonlyArray<string> => {
  const source = NodeFs.readFileSync(file, "utf8")
  const specifiers: Array<string> = []
  for (const match of source.matchAll(/^(?:import|export)\s+(type\s+)?[^"';]*?from\s+"([^"]+)"/gm)) {
    if (match[1] === undefined) specifiers.push(match[2]!)
  }
  return specifiers
}

/** Every module reachable from `entry` through runtime imports, local and external. */
const runtimeClosure = (entry: string): Set<string> => {
  const seen = new Set<string>()
  const pending = [NodePath.join(srcDir, entry)]
  while (pending.length > 0) {
    const file = pending.pop()!
    if (seen.has(file)) continue
    seen.add(file)
    for (const specifier of runtimeImports(file)) {
      if (specifier.startsWith("./")) pending.push(NodePath.join(NodePath.dirname(file), specifier))
      else seen.add(specifier)
    }
  }
  return seen
}

describe("Target.ts layering", () => {
  it("does not load the process-spawning Exec stack", () => {
    const closure = [...runtimeClosure("Target.ts")]
    expect(closure.filter((module) => module.endsWith(`${NodePath.sep}Exec.ts`))).toEqual([])
    expect(closure.filter((module) => module.startsWith("@smthrs/platform-node"))).toEqual([])
  })
})

import { readFileSync } from "node:fs"
import { expect, it } from "vitest"
import * as Root from "../src/index.ts"

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8")

it("documents available runtime names in the affected namespaces", () => {
  for (const name of ["Command", "Detached", "NodeControl", "Providers"] as const) {
    const line = readme.split("\n").find((row) => row.startsWith(`| \`${name}\``))!
    const source = readFileSync(new URL(`../src/${name}.ts`, import.meta.url), "utf8")
    const types = new Set([
      ...[...source.matchAll(/export (?:interface|type) (\w+)/g)].map((match) => match[1]),
      ...[...source.matchAll(/export type \{([^}]+)\}/g)].flatMap((match) =>
        match[1]!.split(",").map((name) => name.trim())
      )
    ])
    const documented = [...line.split("|")[2]!.matchAll(/`(\w+)`/g)].map((match) => match[1]!)
    for (const item of documented) {
      expect(types.has(item) || Object.hasOwn(Root[name], item), `${name}.${item}`).toBe(true)
    }
  }
})

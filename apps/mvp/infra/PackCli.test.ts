// The overflow box's runner is the deploy's own CLI (infra/sandbox/pack-cli.mjs, decision 0144): the set packed for the
// sandbox image is `@smthrs/cli` and every published workspace package it needs at runtime, each after what it needs.
import { expect, test } from "vitest"
// @ts-expect-error: a plain Node script, which has no declarations.
import { closureOf } from "./sandbox/pack-cli.mjs"
// @ts-expect-error: a plain Node script, which has no declarations.
import { readWorkspaceManifests, workspaceDependencies } from "../../../.smithers/flows/release/pack-release.mjs"

test("packs the CLI's whole runtime closure, each package after the ones it needs, and nothing else", () => {
  const manifests = readWorkspaceManifests() as Map<string, { readonly name: string }>
  const order = closureOf("@smthrs/cli") as Array<string>
  const names = order.map((directory) => manifests.get(directory)!.name)
  expect(names.at(-1)).toBe("@smthrs/cli")
  expect(names).toEqual(expect.arrayContaining(["@smthrs/agent", "@smthrs/platform-node", "@smthrs/engine"]))
  const edges = workspaceDependencies(manifests) as Map<string, Set<string>>
  for (const [index, directory] of order.entries()) {
    for (const needed of edges.get(directory)!) expect(order.indexOf(needed), `${directory} needs ${needed}`).toBeGreaterThanOrEqual(0)
    for (const needed of edges.get(directory)!) expect(order.indexOf(needed)).toBeLessThan(index)
  }
  // A package the CLI doesn't need stays out of the image.
  expect(order.length).toBeLessThan(manifests.size)
})

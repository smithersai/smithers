import * as Fs from "node:fs"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"

const root = new URL("../", import.meta.url)
const manifest = JSON.parse(Fs.readFileSync(new URL("package.json", root), "utf8")) as {
  readonly peerDependencies: { readonly effect: string }
}

it.each(
  [
    ["README.md", /requires `effect` at exactly `([^`]+)`/],
    ["README.md", /`effect@([^`]+)` is a required peer/],
    ["docs/installation.md", /`effect` is the only peer, at exactly `([^`]+)`/]
  ] as const
)("%s quotes the declared Effect peer in %s", (file, pattern) => {
  const prose = Fs.readFileSync(fileURLToPath(new URL(file, root)), "utf8").replaceAll(/\s+/g, " ")
  expect(prose.match(pattern)?.[1]).toBe(manifest.peerDependencies.effect)
})

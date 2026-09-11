import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { compareVersions, findNode, findNodeWith, meetsMinimum, nodeCandidates, SUPPORTED_NODE_LINES } from "./Node"
import type { NodeProbeHost } from "./Node"

const fakeHost = (options: {
  readonly env?: Record<string, string | undefined>
  readonly dirs?: Record<string, ReadonlyArray<string>>
  readonly files?: Record<string, string | null>
}): NodeProbeHost & { readonly probed: Array<string> } => {
  const probed: Array<string> = []
  const files = options.files ?? {}
  return {
    env: options.env ?? {},
    home: "/Users/u",
    listDir: (dir) => options.dirs?.[dir] ?? [],
    isFile: (path) => path in files,
    version: async (path) => {
      probed.push(path)
      return files[path] ?? null
    },
    probed
  }
}

/*
 * The boundaries of the sidecar's engines range
 * (packages/smithers/build/build-cli/package.json: "^22.19.0 || >=24.11.0").
 * Node 23 and 24.0 through 24.10 sit outside it, so a single floor at 22.19.0
 * would let the probe hand the loader a runtime it refuses to start under.
 */
const gateCases: ReadonlyArray<readonly [string, boolean]> = [
  ["v18.20.4", false],
  ["v20.11.0", false],
  ["v22.18.9", false],
  ["v22.19.0", true],
  ["v22.19.1", true],
  ["v22.21.0", true],
  ["v23.0.0", false],
  ["v23.11.0", false],
  ["v24.0.0", false],
  ["v24.1.0", false],
  ["v24.10.9", false],
  ["v24.11.0", true],
  ["v24.12.1", true],
  ["v25.0.0", true],
  ["v26.4.0", true],
  ["garbage", false],
  ["", false]
]

describe("the version gate", () => {
  test("compares semver triples and accepts a leading v", () => {
    expect(compareVersions("v22.19.0", "22.19.0")).toBe(0)
    expect(compareVersions("22.20.1", "22.19.0")).toBeGreaterThan(0)
    expect(compareVersions("20.11.0", "22.19.0")).toBeLessThan(0)
  })

  for (const [version, supported] of gateCases) {
    test(`${version === "" ? "an empty version" : version} is ${supported ? "accepted" : "rejected"}`, () => {
      expect(meetsMinimum(version)).toBe(supported)
    })
  }

  test("the table spells the sidecar's declared engines range", async () => {
    const manifest = join(import.meta.dir, "../../../../packages/smithers/build/build-cli/package.json")
    const declared = ((await Bun.file(manifest).json()) as { readonly engines: { readonly node: string } }).engines.node
    const last = SUPPORTED_NODE_LINES.length - 1
    const fromTable = SUPPORTED_NODE_LINES
      .map((line, index) => (index === last ? `>=${line.floor}` : `^${line.floor}`))
      .join(" || ")
    expect(fromTable).toBe(declared)
  })
})

describe("the probe order", () => {
  test("SMITHERS_NODE first, then PATH, nvm highest first, homebrew, /usr/local, volta, fnm", () => {
    const host = fakeHost({
      env: { SMITHERS_NODE: "/custom/node", PATH: "/a/bin:/b/bin" },
      dirs: {
        "/Users/u/.nvm/versions/node": ["v20.5.0", "v22.20.0", "v22.19.1"],
        "/Users/u/.local/share/fnm": ["node-versions"],
        "/Users/u/.local/share/fnm/node-versions": ["v23.0.0"],
        "/Users/u/.local/share/fnm/node-versions/v23.0.0": ["installation"],
        "/Users/u/.local/share/fnm/node-versions/v23.0.0/installation": ["bin"]
      },
      files: { "/Users/u/.local/share/fnm/node-versions/v23.0.0/installation/bin/node": "v23.0.0" }
    })
    expect(nodeCandidates(host)).toEqual([
      "/custom/node",
      "/a/bin/node",
      "/b/bin/node",
      "/Users/u/.nvm/versions/node/v22.20.0/bin/node",
      "/Users/u/.nvm/versions/node/v22.19.1/bin/node",
      "/Users/u/.nvm/versions/node/v20.5.0/bin/node",
      "/opt/homebrew/bin/node",
      "/usr/local/bin/node",
      "/Users/u/.volta/bin/node",
      "/Users/u/.local/share/fnm/node-versions/v23.0.0/installation/bin/node"
    ])
  })

  test("a blank SMITHERS_NODE is not a candidate", () => {
    expect(nodeCandidates(fakeHost({ env: { SMITHERS_NODE: "  ", PATH: "" } }))).toEqual([
      "/opt/homebrew/bin/node",
      "/usr/local/bin/node",
      "/Users/u/.volta/bin/node"
    ])
  })
})

describe("findNode", () => {
  test("returns the first candidate that exists and meets the floor", async () => {
    const host = fakeHost({
      env: { PATH: "/old/bin:/new/bin" },
      files: { "/old/bin/node": "v20.0.0", "/new/bin/node": "v22.19.0", "/opt/homebrew/bin/node": "v24.0.0" }
    })
    expect(await findNodeWith(host)).toEqual({ path: "/new/bin/node", version: "v22.19.0" })
    // Missing candidates are never spawned; the old one was probed and rejected.
    expect(host.probed).toEqual(["/old/bin/node", "/new/bin/node"])
  })

  test("SMITHERS_NODE wins when it qualifies", async () => {
    const host = fakeHost({
      env: { SMITHERS_NODE: "/custom/node", PATH: "/new/bin" },
      files: { "/custom/node": "v22.19.5", "/new/bin/node": "v24.0.0" }
    })
    expect(await findNodeWith(host)).toEqual({ path: "/custom/node", version: "v22.19.5" })
  })

  test("skips an unsupported Node 24 build for a supported 22 line further down", async () => {
    const host = fakeHost({
      env: { PATH: "/new/bin:/old/bin" },
      files: { "/new/bin/node": "v24.10.9", "/old/bin/node": "v22.19.0" }
    })
    expect(await findNodeWith(host)).toEqual({ path: "/old/bin/node", version: "v22.19.0" })
    expect(host.probed).toEqual(["/new/bin/node", "/old/bin/node"])
  })

  test("answers null when nothing qualifies", async () => {
    const host = fakeHost({ env: { PATH: "/old/bin" }, files: { "/old/bin/node": "v18.0.0" } })
    expect(await findNodeWith(host)).toBeNull()
  })

  test("the real probe runs against this machine without throwing", async () => {
    const found = await findNode()
    if (found !== null) {
      expect(found.path.endsWith("node")).toBe(true)
      expect(meetsMinimum(found.version)).toBe(true)
    }
  })
})

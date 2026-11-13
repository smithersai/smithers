/**
 * The supervised Anvil fork's service spec: refusal without the binary, and
 * the argv a pinned fork block renders.
 */
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import * as AnvilExec from "../src/AnvilExec.ts"
import * as PackageTree from "../src/PackageTree.ts"

const roots: Array<string> = []
afterAll(async () => {
  await Promise.all(roots.map((root) => Fs.rm(root, { recursive: true, force: true })))
})

const forkUrl = { _tag: "Secret", env: "ANVIL_SPEC_RPC" } as const

describe("Anvil service spec", () => {
  it("refuses with the missing binary when anvil is not on PATH", async () => {
    const empty = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-anvil-none-"))
    roots.push(empty)
    const spec = await AnvilExec.serviceSpec({
      label: "//:fork",
      cwd: empty,
      attrs: { forkUrl, forkBlockNumber: "latest", port: 8545 } as never,
      environment: { PATH: empty }
    })
    expect(spec).toEqual({ error: "host binary \"anvil\" is not present on PATH" })
  })

  const anvil = PackageTree.findOnPath("anvil")
  it.skipIf(anvil === undefined)("pins the fork to a declared block number", async () => {
    const spec = await AnvilExec.serviceSpec({
      label: "//:fork",
      cwd: process.cwd(),
      attrs: { forkUrl, forkBlockNumber: 19_000_000, port: 8546 } as never
    })
    expect(spec).toEqual({
      key: "//:fork",
      cwd: process.cwd(),
      argv: [
        anvil,
        "--host",
        "127.0.0.1",
        "--port",
        "8546",
        "--fork-url",
        "{secret-url:ANVIL_SPEC_RPC}",
        "--fork-block-number",
        "19000000"
      ],
      secretUrls: [{ index: 6, secret: forkUrl }],
      readiness: { port: 8546 },
      stop: { signal: "SIGTERM", grace: "5s" }
    })
  })
})

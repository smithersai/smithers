/** CI merges retain acquire-only services as well as scheduled targets. */
import * as Fs from "node:fs/promises"
import * as Net from "node:net"
import * as Os from "node:os"
import * as Path from "node:path"
import { expect, it } from "vitest"
import { serve } from "./helpers/ServeCli.ts"
import { write } from "./helpers/WriteFile.ts"

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = Net.createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as Net.AddressInfo
      server.close((error) => error === undefined ? resolve(address.port) : reject(error))
    })
  })

it.each(["ci", "affected"] as const)("%s acquires a planned service and executes only its consumer", async (verb) => {
  const root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-ci-service-")))
  const port = await freePort()
  try {
    await write(
      root,
      "package.json",
      JSON.stringify({ name: "ci-service", private: true, packageManager: "pnpm@11.25.0" })
    )
    await write(root, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n")
    await write(
      root,
      "WORKSPACE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const packageJson = S.file("//package.json")
export const Workspace = S.Workspace("fixture", {
  repository: "git+https://example.invalid/fixture.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: ">=26.4.0" }),
  packageManager: S.PackageManager.Pnpm({ manifest: packageJson, lockfile: S.file("//pnpm-lock.yaml") }),
  nodeModules: S.Npm.NodeModules({ packageJson })
})
`
    )
    await write(
      root,
      "server.mjs",
      `import { createServer } from "node:http"
createServer((request, response) => response.end("service-backed-result")).listen(${port}, "127.0.0.1")
`
    )
    await write(
      root,
      "consumer.mjs",
      `import { writeFileSync } from "node:fs"
import assert from "node:assert/strict"
const response = await fetch("http://127.0.0.1:${port}")
const text = await response.text()
assert.equal(text, "service-backed-result")
writeFileSync("receipt.txt", text)
`
    )
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const service = S.Shell.Serve({
  shell: ${JSON.stringify(`${process.execPath} server.mjs`)},
  data: [S.file("server.mjs")],
  readiness: { port: ${port} }
})
const probe = S.Shell.Test({
  shell: ${JSON.stringify(`${process.execPath} consumer.mjs`)},
  data: [S.file("consumer.mjs")], services: [service], sandbox: "none"
})
export const Package = S.Package({ targets: { service, probe } })
`
    )
    const args = verb === "ci"
      ? ["ci", "//...", "--no-cache", "--jobs", "1"]
      : ["affected", "ci", "//...", "--files", "consumer.mjs", "--no-cache", "--jobs", "1"]
    const result = await serve(root, args)
    expect(result.exitCode, result.output + result.logs).toBe(0)
    expect(result.logs).toContain("//:probe  service //:service: ready")
    expect(result.logs).toContain("//:probe  ran")
    expect(result.logs).not.toContain("//:service  ran")
    expect(await Fs.readFile(Path.join(root, "receipt.txt"), "utf8")).toBe("service-backed-result")
    // Execution resolves only after the acquired service's finalizer settles.
    await expect(fetch(`http://127.0.0.1:${port}`)).rejects.toThrow()
  } finally {
    await Fs.rm(root, { recursive: true, force: true })
  }
})

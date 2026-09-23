/** The public Bun composition loads under Bun and discovers without importing flow modules. */
import { execFile } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { expect, it } from "vitest"

const execute = promisify(execFile)
const module = new URL("../src/BunControl.ts", import.meta.url).pathname

it("lists no flows under Bun for a root without flows/", async () => {
  const root = await mkdtemp(join(tmpdir(), "bun-control-"))
  try {
    const script = `
      import * as BunControl from ${JSON.stringify(module)}
      import * as Registry from "@smthrs/registry/Registry"
      import { Effect } from "effect"
      const listed = await Effect.runPromise(Registry.Registry.pipe(
        Effect.flatMap((registry) => registry.list()),
        Effect.provide(BunControl.layerRegistry(${JSON.stringify(root)}))
      ))
      console.log(JSON.stringify({ listed: listed.length }))
    `
    const { stdout } = await execute("bun", ["--eval", script], {
      cwd: new URL("..", import.meta.url).pathname,
      timeout: 120_000
    })
    expect(JSON.parse(stdout.trim().split("\n").at(-1)!)).toEqual({ listed: 0 })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 125_000)

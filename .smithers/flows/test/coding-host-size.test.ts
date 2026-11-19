import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { bundle, checkStagedHostSize, stagedHostLimitBytes } from "../coding/build.mjs"

// Plue stages this host into every hosted workspace and refuses one over its
// limit. At 915058c5 the host was 58,987,479 bytes against a 48 MiB limit, and
// every hosted coding turn failed before the model ran (plue#863). The limit is
// `maxPackagedFlowHostBytes` in plue's
// apps/backend/internal/composition/workspaceruntime/services.go.
test("the staging limit is Plue's: eight 16 MiB chunks", () => {
  assert.equal(stagedHostLimitBytes, 8 * 16 * 1024 * 1024)
})

test("a host over the staging limit is refused with its size", () => {
  assert.doesNotThrow(() => checkStagedHostSize(stagedHostLimitBytes))
  assert.throws(
    () => checkStagedHostSize(stagedHostLimitBytes + 1),
    new RegExp(`Coding host is ${stagedHostLimitBytes + 1} bytes; Plue stages at most ${stagedHostLimitBytes}`)
  )
})

test("the packaged coding host fits the staging limit", { timeout: 300_000 }, async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "coding-host-size-"))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const output = join(temporary, "smithers-coding-flow-host")
  await bundle(fileURLToPath(new URL("../coding/serve.ts", import.meta.url)), output)
  const { size } = await stat(output)
  t.diagnostic(
    `coding host ${size} bytes of ${stagedHostLimitBytes} (${(100 * size / stagedHostLimitBytes).toFixed(1)}%)`
  )
  assert.ok(size <= stagedHostLimitBytes, `coding host is ${size} bytes; Plue stages at most ${stagedHostLimitBytes}`)
  // The host reaches @smthrs/platform-bun's desktop services through its Bun
  // platform. Electrobun is the desktop host's Bun FFI layer: the coding host
  // carries platform-bun's refusing module in its place (e232750c added the
  // path, and esbuild refused to inline Electrobun).
  const text = await readFile(output, "utf8")
  assert.doesNotMatch(text, /node_modules\/electrobun\//, "the coding host inlines an Electrobun module")
  assert.match(text, /platform-bun\/src\/internal\/ElectrobunUnavailable\.ts/)
})

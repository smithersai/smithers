/**
 * Cross-service BrowserHost contract over one real mounted volume.
 *
 * A page hands BrowserFileSystem, just-bash, and BrowserJj three views of the
 * same ZenFS mount. This suite composes the bundle the way a page does, from
 * `@zenfs/core`'s in-memory volume and a real just-bash interpreter bound to it
 * (`test/fixtures/ZenFsMount.ts`), and makes the observations in
 * `test/fixtures/SharedMountContract.ts` against those real backends: a split
 * mount, an error code the adapter does not map, or an interpreter option it
 * names wrongly fails here rather than in a tab. `test/browser` makes the same
 * observations in Chromium.
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import * as fsModule from "node:fs"
import { fileURLToPath } from "node:url"
import * as BrowserHost from "../../src/BrowserHost.ts"
import * as SharedMountContract from "../fixtures/SharedMountContract.ts"
import * as ZenFsMount from "../fixtures/ZenFsMount.ts"

const wasmPath = fileURLToPath(new URL("../../../jj/wasm/flows_jj.wasm", import.meta.url))
if (!fsModule.existsSync(wasmPath)) {
  throw new Error(
    "[BrowserHostSharedMount.contract] packages/smithers/flows/jj/wasm/flows_jj.wasm is required. Build it with "
      + "`pnpm --filter @smthrs/jj run build:wasm` (requires the rust wasm32-wasip1 toolchain "
      + "and packages/smithers/flows/jj-wasm)."
  )
}
const wasmBytes = new Uint8Array(fsModule.readFileSync(wasmPath))

const mount = await ZenFsMount.mount({ env: SharedMountContract.ambient })
mount.fs.mkdirSync("/repo")
const layer = BrowserHost.layer({
  bash: mount.bash,
  fs: mount.fs.promises,
  jj: { wasm: wasmBytes, fs: mount.fs, root: "/repo" }
})

describe("BrowserHost shared mount contract", () => {
  it.effect("shows one volume to FileSystem, the interpreter, and jj", () =>
    Effect.gen(function*() {
      const observed = yield* Effect.provide(SharedMountContract.volume, layer)
      expect(observed).toEqual(SharedMountContract.expected.volume)
    }))

  it.effect("hides the interpreter's environment from a command unless the caller extends it", () =>
    Effect.gen(function*() {
      const observed = yield* Effect.provide(SharedMountContract.environment, layer)
      expect(observed).toEqual(SharedMountContract.expected.environment)
    }))

  // Real elapsed time: `it.effect`'s TestClock would stall the timeout.
  it.live("aborts a running command on timeout and still runs the next one", () =>
    Effect.gen(function*() {
      const observed = yield* Effect.provide(SharedMountContract.abort, layer)
      expect(observed).toEqual(SharedMountContract.expected.abort)
    }))

  it.effect("keeps the volume's own error codes as PlatformError tags", () =>
    Effect.gen(function*() {
      const observed = yield* Effect.provide(SharedMountContract.errorTags, layer)
      expect(observed).toEqual(SharedMountContract.expected.errorTags)
    }))
})

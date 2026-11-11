/**
 * The shared-mount suite's page: `BrowserHost.layer` over a real ZenFS
 * in-memory volume, a real just-bash bound to it, and the `flows_jj.wasm`
 * reactor, composed in a tab the way a page composes them, and exposed to
 * Playwright as `window.mountHarness`. Each method makes one of the contract's
 * observations and answers with the plain data the suite compares.
 */
import * as Effect from "effect/Effect"
import * as BrowserHost from "../../../src/BrowserHost.ts"
import * as SharedMountContract from "../../fixtures/SharedMountContract.ts"
import * as ZenFsMount from "../../fixtures/ZenFsMount.ts"

const mount = await ZenFsMount.mount({ env: SharedMountContract.ambient })
mount.fs.mkdirSync("/repo")
const wasm = await WebAssembly.compileStreaming(fetch("/flows_jj.wasm"))
const layer = BrowserHost.layer({
  bash: mount.bash,
  fs: mount.fs.promises,
  jj: { wasm, fs: mount.fs, root: "/repo" }
})

const observe = <A, E>(effect: Effect.Effect<A, E, BrowserHost.BrowserHost>): Promise<A> =>
  Effect.runPromise(Effect.provide(effect, layer))

Object.assign(globalThis, {
  mountHarness: {
    volume: () => observe(SharedMountContract.volume),
    environment: () => observe(SharedMountContract.environment),
    abort: () => observe(SharedMountContract.abort),
    errorTags: () => observe(SharedMountContract.errorTags)
  }
})

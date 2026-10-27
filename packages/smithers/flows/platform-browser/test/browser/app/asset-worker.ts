import * as Effect from "effect/Effect"
import { BrowserCache } from "../../../src/index.ts"

self.onmessage = (event: MessageEvent<string>) => {
  void Effect.runPromise(BrowserCache.readAsset(event.data).pipe(Effect.provide(BrowserCache.layerAssets()))).then(
    (bytes) => self.postMessage({ bytes: [...new Uint8Array(bytes)] }),
    () => self.postMessage({ refused: true })
  )
}
self.postMessage({ ready: true })

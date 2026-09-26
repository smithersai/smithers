/** `workspace-fixture.tsx` with the app's undo module replaced by `undo-hold.ts`. */
import { join } from "node:path"

const src = join(import.meta.dir, "..", "src")
Bun.plugin({
  name: "undo-hold",
  setup: (build) => {
    // Every `undo.ts` import resolves explicitly: the app's to the hold, the hold's to the real module.
    build.onResolve({ filter: /(^|\/)undo\.ts$/ }, (args) => ({
      path: args.importer === join(src, "app.tsx") ? join(import.meta.dir, "undo-hold.ts") : join(src, "undo.ts")
    }))
  }
})
await import("./workspace-fixture.tsx")

import { fileURLToPath } from "node:url"
import { buildLibrary } from "../../repo-targets/scripts/build-library.mjs"

// The program finds its own install through `import.meta.url`, in CommonJS too.
await buildLibrary(fileURLToPath(new URL("../", import.meta.url)), { commonJsPlatform: "node" })

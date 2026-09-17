import { fileURLToPath } from "node:url"
import { buildLibrary } from "../../../repo-targets/scripts/build-library.mjs"

await buildLibrary(fileURLToPath(new URL("../", import.meta.url)))

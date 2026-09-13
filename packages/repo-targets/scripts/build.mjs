// Conventional packages keep the cwd-based entrypoint; all dual-module
// assembly is shared with packages that need a custom build wrapper.
import { buildLibrary } from "./build-library.mjs"

await buildLibrary(process.cwd())

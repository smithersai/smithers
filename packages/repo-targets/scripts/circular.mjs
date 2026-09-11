// The shared circular-dependency guard for a conventional package. It runs
// from the package directory, which is where `pnpm run circular` and the
// `circular` target start it, and resolves `madge` from that package.
import { createRequire } from "node:module"
import { resolve } from "node:path"

const madge = createRequire(resolve(process.cwd(), "package.json"))("madge")

const result = await madge("src", {
  fileExtensions: ["ts"],
  tsConfig: "./tsconfig.json",
  detectiveOptions: {
    ts: {
      skipTypeImports: true
    }
  }
})
const circular = result.circular()

if (circular.length > 0) {
  console.error("Circular dependencies found")
  console.error(circular)
  process.exitCode = 1
}

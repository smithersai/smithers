#!/usr/bin/env node
// `smithers-routes`: regenerate routes.gen.ts and routes.ui.gen.ts at an app
// root. `--check` writes nothing and exits 1 on drift. The build graph checks
// drift through `smithers-build lint '//:routes'`, which runs the generator in
// write mode and compares the declared `changes`; the bare `smithers-build
// '//:routes'` form is the write form and checks nothing.
//
// Which entry runs is decided by where this file sits, not by what exists next
// to it. Node refuses to strip types from any file under a `node_modules`
// directory (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), so an installed copy
// must run the compiled `dist/esm/routesBin.js`; anywhere else the source
// module runs through Node's own type stripping. Preferring `dist` whenever it
// existed was wrong: `tsc -b tsconfig.json` is this package's `check` script and
// writes `dist/esm`, so after any `pnpm check` or any `smithers-build ci` run a
// source checkout has one, and every `pnpm routes` invocation silently ran the
// last compiled generator instead of the working tree. A pnpm `link:` install
// resolves to its realpath in the checkout, so a scaffolded app linked at a
// source checkout runs that checkout's source too.
import { existsSync } from "node:fs"
import { sep } from "node:path"
import { fileURLToPath } from "node:url"

const here = fileURLToPath(import.meta.url)
// An exact path segment, so a directory named `node_modules_backup` is not one.
const installed = here.split(sep).includes("node_modules")

let entry
if (installed) {
  entry = new URL("../dist/esm/routesBin.js", import.meta.url)
  if (!existsSync(fileURLToPath(entry))) {
    console.error(
      "smithers-routes: this install has no dist/esm/routesBin.js, and Node cannot strip types under node_modules. Reinstall @smthrs/create-app."
    )
    process.exit(1)
  }
} else {
  entry = new URL("../src/routesBin.ts", import.meta.url)
}

const { runRoutesBin } = await import(entry.href)

// `process.exitCode` rather than `process.exit`, so a report written to a pipe
// is flushed before the process ends.
process.exitCode = runRoutesBin(process.argv.slice(2), {
  io: { out: (line) => console.log(line), err: (line) => console.error(line) }
})

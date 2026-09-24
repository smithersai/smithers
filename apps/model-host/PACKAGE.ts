/** Build graph entry for the thin packaged model-host executable. */
import { Smithers } from "@smthrs/targets"
import { Package as modelHostPackage } from "../../packages/smithers/agent/model-host/PACKAGE.ts"

const cwd = "apps/model-host"
const sources = Smithers.glob("src/**/*.ts")

const check = Smithers.Typecheck({
  srcs: [sources],
  deps: [modelHostPackage.lib],
  tsconfig: Smithers.file("tsconfig.json"),
  buildMode: false,
  incremental: false,
  cwd
})

const bundle = Smithers.NodeTest({
  runner: Smithers.entrypoint(Smithers.file("build.mjs")),
  srcs: [sources, Smithers.file("build.mjs"), Smithers.file("package.json")],
  deps: [modelHostPackage.lib],
  cwd
})

/** Drives the bundled executable over HTTP: startup guards, body limit, auth,
 * grant refusals, disconnect cancellation and shutdown. */
const test = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("test/serve.test.mjs")]),
  srcs: [sources, Smithers.file("build.mjs"), Smithers.file("package.json")],
  deps: [modelHostPackage.lib],
  cwd
})

export const Package = Smithers.Package({ targets: { bundle, check, test } })

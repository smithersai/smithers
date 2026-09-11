/**
 * The `smithers-routes` executable.
 *
 * Two layers, because they fail differently. `runRoutesBin` is driven
 * in-process, so every flag form, exit code and reported line is asserted
 * against what a user would see. The shim in `bin/routes.mjs` is spawned, so
 * the one thing only a real process can prove is proved: Node refuses to strip
 * types from any file under `node_modules`, which is exactly where
 * `S.NodeModule.Bin("@smthrs/create-app", "smithers-routes")` resolves and
 * where both templates' `pnpm routes` runs.
 */
import { afterAll, describe, expect, it } from "@effect/vitest"
import { spawnSync } from "node:child_process"
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { runRoutesBin, usage } from "../src/routesBin.ts"
import { appTrees } from "./support/appTree.ts"
import { layers } from "./support/layers.ts"

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const binPath = join(packageRoot, "bin", "routes.mjs")

const { write: appTree, remove: removeTrees } = appTrees("smthrs-routes-bin-")

/** Runs the bin body and returns its exit code beside the two streams. */
const run = (argv: ReadonlyArray<string>, cwd?: string) => {
  const out: Array<string> = []
  const err: Array<string> = []
  const code = runRoutesBin(argv, {
    io: { out: (line) => out.push(line), err: (line) => err.push(line) },
    ...(cwd === undefined ? {} : { cwd })
  })
  return { code, out, err }
}

// Drained after the whole file rather than after each test, so a spawned child
// that still holds a handle cannot make an individual test flaky.
afterAll(() => {
  removeTrees()
})

describe("runRoutesBin", () => {
  it("prints usage and succeeds for --help and -h", () => {
    for (const flag of ["--help", "-h"]) {
      const result = run([flag])
      expect(result.code).toBe(0)
      expect(result.out).toEqual([usage])
      expect(result.err).toEqual([])
    }
  })

  it("documents both flag forms in the usage text", () => {
    expect(usage).toContain("--root=<dir>")
    expect(usage).toContain("--check")
  })

  it("writes both tables and reports the counts", () => {
    const root = appTree({
      ...layers,
      "app/page.tsx": "export default () => null\n",
      "app/panes/balances.tsx": "export const Pane = {}\n",
      "flows/chat/flow.ts": "export const Flow = {}\n"
    })
    const result = run(["--root", root])
    expect(result.code).toBe(0)
    expect(result.out).toEqual(["routes: 1 pages, 1 panes, 1 flows"])
    expect(readFileSync(join(root, "routes.gen.ts"), "utf8")).toContain("import * as flow0")
  })

  it("accepts the equals form of every flag", () => {
    const root = appTree({
      ...layers,
      "site/page.tsx": "export default () => null\n",
      "pipelines/chat/flow.ts": "export const Flow = {}\n"
    })
    const result = run([`--root=${root}`, "--app=site", "--flows=pipelines", "--tools=kit"])
    expect(result.code).toBe(0)
    expect(result.out).toEqual(["routes: 1 pages, 0 panes, 1 flows"])
  })

  it("defaults the root to the working directory it is given", () => {
    const root = appTree({ ...layers, "app/page.tsx": "export default () => null\n" })
    const result = run([], root)
    expect(result.code).toBe(0)
    expect(result.out).toEqual(["routes: 1 pages, 0 panes, 0 flows"])
  })

  it("exits 2 when a flag is given no value", () => {
    for (
      const [name, argv] of [
        ["root", ["--root"]],
        ["app", ["--app", "--flows", "x"]],
        ["flows", ["--flows="]],
        ["tools", ["--tools"]]
      ] as const
    ) {
      const result = run(argv)
      expect(result.code).toBe(2)
      expect(result.err).toEqual([`--${name} expects a value`])
      expect(result.out).toEqual([])
    }
  })

  it("reports drift per file and exits 1 in check mode", () => {
    const root = appTree({ ...layers, "app/page.tsx": "export default () => null\n" })
    const stale = run(["--root", root, "--check"])
    expect(stale.code).toBe(1)
    expect(stale.err).toEqual([
      "routes.gen.ts is out of date; run `pnpm routes`",
      "routes.ui.gen.ts is out of date; run `pnpm routes`"
    ])

    expect(run(["--root", root]).code).toBe(0)
    const clean = run(["--root", root, "--check"])
    expect(clean.code).toBe(0)
    expect(clean.err).toEqual([])
  })

  it("reports a refused tree as its message and exits 1", () => {
    const root = appTree({
      "AGENT.ts": layers["AGENT.ts"],
      "SANDBOX.ts": layers["SANDBOX.ts"],
      "flows/chat/flow.ts": "export const Flow = {}\n"
    })
    const result = run(["--root", root])
    expect(result.code).toBe(1)
    expect(result.err).toEqual(["no TOOLS.ts found for flows/chat or any ancestor; add one at the app root"])
    expect(result.out).toEqual([])
  })

  it("reports a non-Error throw as text rather than [object Object]", () => {
    const out: Array<string> = []
    const err: Array<string> = []
    const code = runRoutesBin(["--root", "/nowhere"], {
      io: { out: (line) => out.push(line), err: (line) => err.push(line) },
      write: () => {
        throw "the router died without an Error"
      }
    })
    expect(code).toBe(1)
    expect(err).toEqual(["the router died without an Error"])
  })
})

/**
 * A copy of the shim beside a source module and a stale compiled one.
 *
 * `where` is the directory the copy is planted in, relative to a throwaway
 * root: `"pkg"` is an ordinary checkout and `"node_modules/@smthrs/create-app"`
 * is an install. Both entries print a marker the real generator never prints,
 * so the assertion is which of the two ran and not what it produced.
 */
const planted = (root: string, where: string, options: { readonly dist?: boolean } = {}): string => {
  const home = join(root, ...where.split("/"))
  mkdirSync(join(home, "bin"), { recursive: true })
  mkdirSync(join(home, "src"), { recursive: true })
  copyFileSync(binPath, join(home, "bin", "routes.mjs"))
  writeFileSync(
    join(home, "src", "routesBin.ts"),
    "export const runRoutesBin = (argv: ReadonlyArray<string>, options: {\n"
      + "  readonly io: { readonly out: (line: string) => void }\n"
      + "}): number => {\n"
      + "  options.io.out(`from source ${argv.length}`)\n"
      + "  return 0\n"
      + "}\n"
  )
  if (options.dist !== false) {
    mkdirSync(join(home, "dist", "esm"), { recursive: true })
    writeFileSync(
      join(home, "dist", "esm", "routesBin.js"),
      "export const runRoutesBin = (argv, options) => {\n"
        + "  options.io.out(`from dist ${argv.length}`)\n"
        + "  return 0\n"
        + "}\n"
    )
  }
  return join(home, "bin", "routes.mjs")
}

describe("bin/routes.mjs", () => {
  // `tsc -b tsconfig.json` is this package's `check` script and writes
  // `dist/esm`, so a source checkout has one after any `pnpm check` or any
  // `smithers-build ci` run. A shim that preferred `dist` whenever it existed
  // therefore ran the last compiled generator rather than the working tree, and
  // reported success either way.
  it("runs the working tree's source when it is not installed, stale dist or not", () => {
    const root = appTree({ ...layers })
    const shim = planted(root, "pkg")
    const result = spawnSync(process.execPath, [shim, "--root", root], { encoding: "utf8" })
    expect(result.stderr).toBe("")
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe("from source 2")
  })

  it("names the missing build rather than failing on a module specifier", () => {
    const root = appTree({ ...layers })
    const shim = planted(root, "node_modules/@smthrs/create-app", { dist: false })
    const result = spawnSync(process.execPath, [shim, "--root", root], { encoding: "utf8" })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("no dist/esm/routesBin.js")
    expect(result.stderr).not.toContain("ERR_MODULE_NOT_FOUND")
  })

  it("runs an install's compiled entry even beside a newer source", () => {
    const root = appTree({ ...layers })
    const shim = planted(root, "node_modules/@smthrs/create-app")
    const result = spawnSync(process.execPath, [shim, "--root", root], { encoding: "utf8" })
    expect(result.stderr).not.toContain("ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING")
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe("from dist 2")
  })

  it("runs the shipped bin end to end against a real tree", () => {
    const root = appTree({ ...layers, "app/page.tsx": "export default () => null\n" })
    const result = spawnSync(process.execPath, [binPath, "--root", root], { encoding: "utf8" })
    expect(result.stderr).toBe("")
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe("routes: 1 pages, 0 panes, 0 flows")
  })

  it("runs from inside node_modules, where Node refuses to strip types", () => {
    const root = appTree({ ...layers, "app/page.tsx": "export default () => null\n" })
    const installed = join(root, "node_modules", "@smthrs", "create-app")
    mkdirSync(join(installed, "bin"), { recursive: true })
    mkdirSync(join(installed, "dist", "esm"), { recursive: true })
    copyFileSync(binPath, join(installed, "bin", "routes.mjs"))
    // A published install ships JavaScript here. The point of the assertion is
    // that the shim reaches it and never touches a `.ts` file: importing one
    // from under node_modules fails with ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING.
    writeFileSync(
      join(installed, "dist", "esm", "routesBin.js"),
      "export const runRoutesBin = (argv, options) => {\n"
        + "  options.io.out(`routes: 0 pages, 0 panes, 0 flows (argv ${argv.length})`)\n"
        + "  return 0\n"
        + "}\n"
    )
    const result = spawnSync(process.execPath, [join(installed, "bin", "routes.mjs"), "--root", root], {
      encoding: "utf8"
    })
    expect(result.stderr).not.toContain("ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING")
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe("routes: 0 pages, 0 panes, 0 flows (argv 2)")
  })

  it("exits 1 and names the refusal when the tree has no layer", () => {
    const root = appTree({ "flows/chat/flow.ts": "export const Flow = {}\n" })
    const result = spawnSync(process.execPath, [binPath, "--root", root], { encoding: "utf8" })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("no AGENT.ts found for flows/chat")
  })
})

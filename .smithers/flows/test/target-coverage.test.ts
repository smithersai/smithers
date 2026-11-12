import * as Target from "@smthrs/targets/Target"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readdir } from "node:fs/promises"
import { join, posix, relative, sep } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { Package } from "../PACKAGE.ts"
import { Package as ReviewPackage } from "../review/PACKAGE.ts"
import { Package as WikiPackage } from "../wiki/PACKAGE.ts"
import { nativeTests } from "./coding-native-gate.mjs"

const root = fileURLToPath(new URL("../", import.meta.url))
const flowPath = (path: string, cwd = ".smithers/flows") =>
  path.startsWith("//") ? path.slice(2) : posix.join(cwd, path)

const nestedMembers = new Set(["review/seeded-bugs"])

const discoverTests = async (directory: string): Promise<string[]> => {
  const found: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue
    const path = join(directory, entry.name)
    // A nested workspace member with its own PACKAGE.ts, such as the review
    // seeded-bug suite, declares and runs its own tests.
    if (entry.isDirectory() && nestedMembers.has(relative(root, path).split(sep).join("/"))) continue
    if (entry.isDirectory()) found.push(...await discoverTests(path))
    else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      found.push(posix.join(".smithers/flows", relative(root, path).split(sep).join("/")))
    }
  }
  return found
}

const registeredTests = (files: readonly string[]): Set<string> => {
  const registered = new Set<string>()
  for (
    const [owner, pack] of [[".smithers/flows", Package], [".smithers/flows/wiki", WikiPackage], [
      ".smithers/flows/review",
      ReviewPackage
    ]] as const
  ) {
    for (const target of Object.values(pack)) {
      const metadata = Target.metadata(target)
      if (metadata.target !== "NodeTest") continue
      const attrs = metadata.attrs as {
        readonly cwd: string
        readonly runner:
          | { readonly name: "test-runner"; readonly tests: readonly { readonly path: string }[] }
          | { readonly name: "entrypoint"; readonly entry: { readonly path: string } }
          | { readonly name: "suite"; readonly paths: readonly string[] }
      }
      const cwd = attrs.cwd === "." ? owner : attrs.cwd
      switch (attrs.runner.name) {
        case "test-runner":
          for (const file of attrs.runner.tests) registered.add(flowPath(file.path, cwd))
          break
        case "entrypoint":
          registered.add(flowPath(attrs.runner.entry.path, cwd))
          break
        case "suite":
          for (const path of attrs.runner.paths) {
            const prefix = flowPath(path, cwd).replace(/\/$/, "")
            for (const file of files) {
              if (file === prefix || file.startsWith(`${prefix}/`)) registered.add(file)
            }
          }
      }
    }
  }

  // This launcher preflights the native helper and JJ, then executes every
  // listed fixture. Its exported manifest is the list the launcher uses.
  for (const name of ["codingNative", "codingNativeBun"] as const) {
    const target = Package[name]
    const metadata = Target.metadata(target)
    assert.equal(metadata.target, "Shell.Test")
    const attrs = metadata.attrs as { readonly args: readonly string[] }
    assert.deepEqual(attrs.args.slice(0, 2), [".smithers/flows/test/coding-native-gate.mjs", "source"])
  }
  for (const name of nativeTests) registered.add(`.smithers/flows/test/${name}`)
  return registered
}

const missingTests = (files: readonly string[], registered: ReadonlySet<string>): string[] =>
  files.filter((file) => !registered.has(file)).sort()

test("every flow TypeScript test is run by a declared target", async () => {
  const files = await discoverTests(root)
  assert.deepEqual(missingTests(files, registeredTests(files)), [])
})

test("an added test without a runner fails the inventory", () => {
  assert.deepEqual(missingTests([".smithers/flows/test/new.test.ts"], new Set()), [".smithers/flows/test/new.test.ts"])
})

test("explicit Node test runtimes preload the workspace source loader", () => {
  const missing = Object.entries(Package).flatMap(([name, target]) => {
    const metadata = Target.metadata(target)
    if (metadata.target !== "NodeTest") return []
    const runtime =
      (metadata.attrs as { readonly runtime?: { readonly name: string; readonly imports?: readonly string[] } }).runtime
    return runtime?.name === "node" && !runtime.imports?.includes("vibelang/register") ? [name] : []
  })
  assert.deepEqual(missing, [], "an explicit Node runtime replaces the workspace default, including its source loader")
})

test("the explicit Node runtime imports the coding builder with migrated package sources", () => {
  const runtime = (Target.metadata(Package.codingHostSize).attrs as {
    readonly runtime: { readonly imports?: readonly string[] }
  }).runtime
  execFileSync(process.execPath, [
    ...(runtime.imports ?? []).map((module) => `--import=${module}`),
    "--input-type=module",
    "-e",
    "await import(" + JSON.stringify(new URL("../coding/build.mjs", import.meta.url).href) + ")"
  ], {
    cwd: root,
    env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "" },
    timeout: 30_000,
    stdio: "pipe"
  })
})

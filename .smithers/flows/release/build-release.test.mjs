import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { buildRelease } from "./build-release.mjs"
import { dependencyOrder, publishedPackages, readWorkspaceManifests, workspaceDependencies } from "./pack-release.mjs"

const fixture = (body) => {
  const root = mkdtempSync(join(tmpdir(), "smithers-build-release-"))
  try {
    writeFileSync(join(root, "package.json"), JSON.stringify({ private: true, packageManager: "pnpm@11.25.0" }))
    writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - kernel\n  - browser\nlinkWorkspacePackages: true\n")
    const manifests = new Map([
      ["kernel", { name: "@smthrs/kernel", version: "1.0.0", scripts: { build: "node build.mjs" },
        devDependencies: { "@smthrs/platform-browser": "1.0.0" },
        peerDependencies: { "@smthrs/platform-browser": "1.0.0" },
        peerDependenciesMeta: { "@smthrs/platform-browser": { optional: true } } }],
      ["browser", { name: "@smthrs/platform-browser", version: "1.0.0", scripts: { build: "node build.mjs" },
        dependencies: { "@smthrs/kernel": "1.0.0" } }]
    ])
    for (const [directory, manifest] of manifests) {
      mkdirSync(join(root, directory, "dist"), { recursive: true })
      writeFileSync(join(root, directory, "dist/stale"), "stale")
      writeFileSync(join(root, directory, "package.json"), JSON.stringify(manifest))
      writeFileSync(join(root, directory, "build.mjs"), [
        'import assert from "node:assert/strict"',
        'import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"',
        'assert.equal(existsSync("dist/stale"), false, "the build must start clean")',
        ...(directory === "browser" ? ['assert.equal(readFileSync("../kernel/dist/built", "utf8"), "kernel")'] : []),
        'mkdirSync("dist")',
        `writeFileSync("dist/built", ${JSON.stringify(directory)})`,
        `appendFileSync("../order", ${JSON.stringify(directory + "\n")})`
      ].join("\n"))
    }
    execFileSync("pnpm", ["install", "--offline", "--ignore-scripts"], { cwd: root, stdio: "pipe" })
    body(root, manifests)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test("release builds required dependencies first despite an optional development cycle", () => fixture((root, manifests) => {
  assert.deepEqual(buildRelease(root, manifests), ["kernel", "browser"])
  assert.equal(readFileSync(join(root, "order"), "utf8"), "kernel\nbrowser\n")
  assert.equal(readFileSync(join(root, "browser/dist/built"), "utf8"), "browser")
}))

test("a failed package build stops before cleaning or running a dependent", () => fixture((root, manifests) => {
  writeFileSync(join(root, "kernel/build.mjs"), "process.exit(23)")
  assert.throws(() => buildRelease(root, manifests), /kernel: build failed \(exit 23\)/)
  assert.equal(existsSync(join(root, "kernel/dist/stale")), false)
  assert.equal(readFileSync(join(root, "browser/dist/stale"), "utf8"), "stale")
  assert.equal(existsSync(join(root, "order")), false)
}))

test("missing build scripts and required dependency cycles fail before removing artifacts", () => fixture((root, manifests) => {
  delete manifests.get("browser").scripts.build
  assert.throws(() => buildRelease(root, manifests), /browser: release package has no build script/)
  assert.equal(readFileSync(join(root, "kernel/dist/stale"), "utf8"), "stale")
  manifests.get("kernel").dependencies = { "@smthrs/platform-browser": "1.0.0" }
  assert.throws(() => buildRelease(root, manifests), /cyclic/i)
  assert.equal(readFileSync(join(root, "kernel/dist/stale"), "utf8"), "stale")
}))

/** Runs `body` with `env` set (undefined unsets), restoring the previous values after. */
const withEnv = (env, body) => {
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]))
  const assign = (values) => {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
  assign(env)
  try {
    return body()
  } finally {
    assign(previous)
  }
}

test("a release that must ship smthrs-observe stops before any build when zig 0.17.1 is missing", () => fixture((root, manifests) => {
  const missing = join(root, "no-zig")
  withEnv({ SMITHERS_NATIVE: "required", SMITHERS_ZIG: missing }, () => {
    assert.throws(() => buildRelease(root, manifests), new RegExp(`smthrs-observe: zig 0\\.17\\.1 is not installed \\(${missing}\\)`))
  })
  assert.equal(readFileSync(join(root, "kernel/dist/stale"), "utf8"), "stale")
  assert.equal(existsSync(join(root, "order")), false)
  // Another zig is refused the same way.
  const other = join(root, "zig")
  writeFileSync(other, "#!/bin/sh\necho 0.16.0\n", { mode: 0o755 })
  withEnv({ SMITHERS_NATIVE: "required", SMITHERS_ZIG: other }, () => {
    assert.throws(() => buildRelease(root, manifests), /smthrs-observe: .*zig is zig 0\.16\.0, and smthrs-observe is built with zig 0\.17\.1/)
  })
  // Without the requirement the same missing zig builds every package, as a build in the workspace does.
  withEnv({ SMITHERS_NATIVE: undefined, SMITHERS_ZIG: missing }, () => {
    assert.deepEqual(buildRelease(root, manifests), ["kernel", "browser"])
  })
}))

test("the actual release build graph covers exactly the public roster", () => {
  const manifests = readWorkspaceManifests()
  const order = dependencyOrder(workspaceDependencies(manifests))
  assert.deepEqual(order.map((directory) => manifests.get(directory).name).sort(), [...publishedPackages].sort())
  assert.ok(order.indexOf("packages/smithers/flows/kernel") < order.indexOf("packages/smithers/flows/platform-browser"))
})

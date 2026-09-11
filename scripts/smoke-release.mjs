/**
 * Installs release tarballs into an external temporary project and verifies
 * every packed package, not just the barrel.
 *
 * A consumer of this release never has the workspace: they get the tarballs and
 * whatever the manifests tell a package manager to fetch. So the smoke project
 * is created outside the repository, the tarballs are installed into it, and
 * each packed package is then imported through its published entry as ESM and
 * required as CJS. A package that resolves only because the workspace is on
 * disk fails here.
 *
 * Optional peer dependencies are installed too, because a peer is exactly what
 * the consumer is told to bring: `@smthrs/platform-bun` resolves
 * `@effect/platform-bun` at import time, and without it the ESM entry throws
 * ERR_MODULE_NOT_FOUND in the consumer's project.
 * Separate npm and pnpm consumers then certify default libraries, selected
 * Node/browser/Bun adapters, create-app/testing, and migration install shapes
 * against the same tarballs before a successful smoke receipt is written.
 * Requires npm >=11.16.0 on PATH, including under Node 22.19.0. Its bundled
 * npm 10.9.3 crashes in Arborist when resolving the testing optional peers.
 *
 * usage: node scripts/smoke-release.mjs <pack-directory>
 */
import { spawn } from "node:child_process"
import { build as bundle } from "esbuild"
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { peerRangesOf } from "./release-peer-ranges.mjs"
import { captureProcess as runQuietly } from "./release-process.mjs"
import { releaseRegistry } from "./release-registry.mjs"
import { recordSmokeSuccess, verifyLocalCandidate } from "./publish-release.mjs"
import { assertNodeSupport } from "./release-node-support.mjs"
import { assertSmokeNpmSupport } from "./release-npm-support.mjs"
import { adapterProfiles, migrationProfiles, minimalProfiles, releasePackageManager, runConsumerMatrix, templateProfile } from "./release-consumers.mjs"
import { repoRoot } from "./workspace-packages.mjs"

/**
 * Packages whose published entry throws on purpose.
 *
 * `smthrs` keeps its place on the registry only to tell an upgrading project
 * where the code went, so a successful load is the failure.
 */
const noticeOnly = new Set(["smthrs"])
const noticeFirstLine = "smthrs 1.0 is a migration notice, not a runtime."

const run = (command, args, cwd) =>
  new Promise((resolveRun, reject) => {
    const started = Date.now()
    const child = spawn(command, args, { cwd, stdio: "inherit" })
    child.once("error", reject)
    child.once("exit", (code, signal) => {
      console.log(JSON.stringify({ command, args, cwd, node: process.version, exit: code, signal, durationMs: Date.now() - started }))
      if (code === 0) {
        resolveRun()
      } else {
        reject(new Error(`${command} exited with ${code ?? signal ?? "unknown status"}`))
      }
    })
  })

const packDirectory = process.argv[2]
if (packDirectory === undefined) {
  throw new Error("usage: node scripts/smoke-release.mjs <pack-directory>")
}

const absolutePackDirectory = resolve(packDirectory)
// A failed rerun must not leave the prior successful receipt available to publish.
await rm(join(absolutePackDirectory, "smoke-evidence.json"), { force: true })
const candidate = JSON.parse(await readFile(join(absolutePackDirectory, "release-manifest.json"), "utf8"))
await verifyLocalCandidate(absolutePackDirectory, candidate)
const npmVersion = await runQuietly("npm", ["--version"], repoRoot)
if (!npmVersion.ok) throw new Error(`npm --version failed: ${npmVersion.output}`)
assertSmokeNpmSupport(npmVersion.output.trim())
console.log(JSON.stringify({ smokeToolchain: { node: process.version, npm: npmVersion.output.trim(), pnpm: releasePackageManager } }))
const packManifest = JSON.parse(
  await readFile(join(absolutePackDirectory, "manifest.json"), "utf8")
)
const expected = new Set(packManifest.map((entry) => entry.filename))
const tarballs = (await readdir(absolutePackDirectory))
  .filter((filename) => filename.endsWith(".tgz"))
  .sort()

if (tarballs.length !== expected.size || tarballs.some((filename) => !expected.has(filename))) {
  throw new Error("release pack directory does not match manifest.json")
}

const smokeRoot = await mkdtemp(join(tmpdir(), "smthrs-release-smoke-"))
let registry
try {
  registry = await releaseRegistry(absolutePackDirectory, packManifest)
  await writeFile(join(smokeRoot, ".npmrc"), `@smthrs:registry=${registry.url}\n`)
  const releaseDependencies = Object.fromEntries(
    packManifest.map((entry) => [entry.name, entry.name.startsWith("@smthrs/")
      ? entry.version : `file:${join(absolutePackDirectory, entry.filename)}`])
  )
  await writeFile(
    join(smokeRoot, "package.json"),
    `${JSON.stringify({
      private: true,
      smthrsReleaseConsumer: true,
      type: "module",
      packageManager: releasePackageManager,
      dependencies: {
        ...releaseDependencies,
        typescript: "7.0.2",
        vitest: "4.1.9"
      }
    }, null, 2)}\n`
  )
  // Resolve both direct and transitive first-party edges through a disposable
  // registry. Root file: dependencies do not satisfy transitive registry edges
  // in pnpm. This uses unchanged published manifests, without overrides,
  // workspace linking, or requiring an unreleased package to exist on npm.
  await run("pnpm", ["--dir", smokeRoot, "--version"], repoRoot)
  await run(
    "pnpm",
    [
      "--dir",
      smokeRoot,
      "install",
      "--ignore-scripts",
    ],
    repoRoot
  )

  const installed = await Promise.all(
    packManifest.map(async (entry) =>
      JSON.parse(await readFile(join(smokeRoot, "node_modules", entry.name, "package.json"), "utf8"))
    )
  )
  for (const manifest of installed) {
    assertNodeSupport(manifest, process.versions.node)
  }
  const peers = [...peerRangesOf(installed)]
    .filter(([name]) => installed.every((manifest) => manifest.name !== name))
    .map(([name, range]) => `${name}@${range}`)
  if (peers.length > 0) {
    await run("pnpm", ["--dir", smokeRoot, "add", "--ignore-scripts", ...peers], repoRoot)
  }
  await run("pnpm", ["--dir", smokeRoot, "peers", "check"], repoRoot)

  // Every packed package, through its published entry, in a project that has
  // no access to the workspace.
  const failures = []
  for (const entry of packManifest) {
    const size = (await stat(join(absolutePackDirectory, entry.filename))).size
    const esm = await runQuietly(
      process.execPath,
      ["--input-type=module", "--eval", `await import(${JSON.stringify(entry.name)})`],
      smokeRoot
    )
    const cjs = await runQuietly(
      process.execPath,
      ["--eval", `require(${JSON.stringify(entry.name)})`],
      smokeRoot
    )
    if (noticeOnly.has(entry.name)) {
      // The unscoped `smthrs` package is a migration notice: loading is
      // supposed to fail with the notice as the message. A load that succeeds
      // means the notice stopped working.
      const results = [["ESM import", esm], ["CJS require", cjs]]
      const wrong = results.filter(([, result]) => result.ok || !result.output.includes(noticeFirstLine))
      const status = wrong.length === 0 ? "ok  " : "FAIL"
      console.log(
        `smoke ${status} ${entry.name}@${entry.version} (${entry.filename}, ${(size / 1024).toFixed(1)} kB, migration notice)`
      )
      for (const [label, result] of wrong) {
        failures.push(
          `${entry.name}: ${label} did not report the migration notice\n${result.output.trimEnd()}`
        )
      }
      continue
    }
    const status = esm.ok && cjs.ok ? "ok  " : "FAIL"
    console.log(
      `smoke ${status} ${entry.name}@${entry.version} (${entry.filename}, ${(size / 1024).toFixed(1)} kB)`
    )
    if (!esm.ok) failures.push(`${entry.name}: ESM import failed\n${esm.output.trimEnd()}`)
    if (!cjs.ok) failures.push(`${entry.name}: CJS require failed\n${cjs.output.trimEnd()}`)
  }
  if (failures.length > 0) {
    throw new Error(`release tarballs failed to load:\n${failures.join("\n\n")}`)
  }

  // The same recorded transport and stubborn stdio server used by the source
  // fault tests, relocated beside the installed fixture so imports resolve
  // exclusively from this external consumer's dependencies.
  for (const [source, target] of [
    ["recorded-provider.mjs", "release-recorded-provider.mjs"],
    ["contained-mcp.mjs", "release-contained-mcp.mjs"]
  ]) {
    await writeFile(join(smokeRoot, target), await readFile(
      join(repoRoot, "packages/smithers/test/faults/fixtures", source)
    ))
  }
  await writeFile(join(smokeRoot, "consumer-boundary.mjs"), await readFile(
    join(repoRoot, "scripts/fixtures/installed-consumer/consumer-boundary.mjs")
  ))
  for (const fixture of ["release-public-api.mjs", "release-history-workspace.mjs", "installed-consumer/release-cli-containment.mjs"]) {
    const filename = fixture.split("/").at(-1)
    await writeFile(
      join(smokeRoot, filename),
      await readFile(join(repoRoot, "scripts/fixtures", fixture))
    )
    for (const mode of ["esm", "cjs"]) {
      await run(process.execPath, [filename, mode], smokeRoot)
    }
  }

  for (const [binary, name] of [["smthrs", "@smthrs/cli"], ["smithers-build", "@smthrs/build-cli"]]) {
    const version = packManifest.find((entry) => entry.name === name).version
    const result = await runQuietly(join(smokeRoot, "node_modules/.bin", binary), ["--version"], smokeRoot)
    if (!result.ok || !result.output.includes(version)) throw new Error(`${binary} --version failed: ${result.output}`)
  }
  const cli = join(smokeRoot, "node_modules/.bin/smthrs")
  for (const args of [["init", "release-smoke", "--json"], ["targets", "--json"], ["flow", "list", "--json"]]) {
    const result = await runQuietly(cli, args, smokeRoot)
    if (!result.ok) throw new Error(`Installed CLI ${args.join(" ")} failed: ${result.output}`)
  }
  console.log("CLI smoke ok: packaged binaries, workspace initialization, target loading, and flow discovery")

  // Import-only checks cannot catch a guest runner path erased by a CJS build.
  // Execute a real sandboxed flow through both published module conditions.
  for (const filename of ["release-sandbox-entry.mjs", "release-sandbox-smoke.mjs"]) {
    await writeFile(join(smokeRoot, filename), await readFile(join(repoRoot, "scripts/fixtures/installed-consumer", filename)))
  }
  await run(process.execPath, ["release-sandbox-smoke.mjs"], smokeRoot)

  // Bundle a bare side-effect import from the installed tarball. The package
  // manifest, not this repository's source graph, decides whether esbuild may
  // erase the CLI entry. Other packages stay external so this assertion is
  // exactly about retaining `@smthrs/cli/bin` in ESM and CommonJS consumers.
  const sideEffectBuild = async (format) =>
    bundle({
      absWorkingDir: smokeRoot,
      stdin: {
        contents: format === "esm" ? 'import "@smthrs/cli/bin"\n' : 'require("@smthrs/cli/bin")\n',
        resolveDir: smokeRoot,
        sourcefile: `cli-side-effect.${format === "esm" ? "mjs" : "cjs"}`
      },
      bundle: true,
      format,
      platform: "node",
      treeShaking: true,
      write: false,
      metafile: true,
      logLevel: "silent",
      plugins: [{
        name: "external-packages-except-cli-entry",
        setup(build) {
          build.onResolve({ filter: /^[^./]/ }, (args) =>
            args.path === "@smthrs/cli/bin" ? undefined : { path: args.path, external: true }
          )
        }
      }]
    })
  for (const format of ["esm", "cjs"]) {
    const result = await sideEffectBuild(format)
    const suffix = `/@smthrs/cli/dist/${format}/bin.js`
    const retained = Object.values(result.metafile.outputs).some((output) =>
      Object.entries(output.inputs).some(([path, contribution]) =>
        path.endsWith(suffix) && contribution.bytesInOutput > 0
      )
    )
    if (!retained) failures.push(`@smthrs/cli: ${format.toUpperCase()} tree shaking removed the bin side effect`)
  }
  if (failures.length > 0) {
    throw new Error(`release tarball consumer checks failed:\n${failures.join("\n\n")}`)
  }

  await writeFile(
    join(smokeRoot, "smoke.mts"),
    [
      'import * as Flows from "@smthrs/flows"',
      'import { runHostContract } from "@smthrs/kernel/test/contract"',
      "",
      "const publicApi: typeof Flows = Flows",
      "void publicApi",
      "void runHostContract",
      ""
    ].join("\n")
  )
  await run(
    "node",
    [
      "node_modules/typescript/bin/tsc",
      "--noEmit",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--target",
      "ES2022",
      "--skipLibCheck",
      "smoke.mts"
    ],
    smokeRoot
  )
  // All-peers imports alone can conceal an unrelated adapter forced into a
  // library's default install. Certify independent profiles on both managers
  // against these same candidate bytes before issuing the success receipt.
  await runConsumerMatrix(absolutePackDirectory, packManifest, {
    profiles: [...minimalProfiles(packManifest), ...adapterProfiles(packManifest), ...migrationProfiles(packManifest), templateProfile(absolutePackDirectory, packManifest)], runtime: true
  })
  await recordSmokeSuccess(absolutePackDirectory, candidate)
  console.log(
    `\nrelease smoke holds: ${packManifest.length} tarballs install, import, and typecheck` +
      ` on node ${process.versions.node}.`
  )
} finally {
  await registry?.close()
  await rm(smokeRoot, { recursive: true, force: true })
}

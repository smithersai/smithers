/** What one CLI process evaluates before it can answer. */
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"
import { packageVersion } from "../src/Version.ts"
import { childEnvironment } from "./support/node-child.ts"

const cli = fileURLToPath(new URL("../bin/smithers.mjs", import.meta.url))

// Every subprocess test, and every user command, pays for the module graph.
// The `@effect/platform-node` barrel re-exports NodeRedis and the cluster
// sockets, so importing one Node service through it evaluated the Redis
// client and its four module families (about 640 modules) in every process.
it("starts without evaluating the platform barrel or the Redis client", () => {
  const root = mkdtempSync(join(tmpdir(), "smthrs-startup-modules-"))
  const receipt = join(root, "modules.json")
  const observe = "data:text/javascript," + encodeURIComponent(`
import { registerHooks } from "node:module";
import { writeFileSync } from "node:fs";
const loaded = new Set();
registerHooks({ load(url, context, next) { loaded.add(url); return next(url, context) } });
process.on("exit", () => writeFileSync(${JSON.stringify(receipt)}, JSON.stringify([...loaded])));
`)
  try {
    // `--help` loads the command tree; `--version` alone is answered before it.
    const result = spawnSync(process.execPath, ["--import", observe, cli, "--help"], {
      env: childEnvironment({ ...process.env, HOME: root, XDG_CONFIG_HOME: join(root, "config") }),
      encoding: "utf8"
    })
    expect(result.status, result.stderr).toBe(0)
    const loaded: ReadonlyArray<string> = JSON.parse(readFileSync(receipt, "utf8"))
    expect(loaded.some((url) => url.includes("/@effect/platform-node/dist/NodeServices.js"))).toBe(true)
    expect(loaded.filter((url) => url.endsWith("/@effect/platform-node/dist/index.js"))).toEqual([])
    expect(loaded.filter((url) => /\/(@redis\/|redis\/dist\/)/.test(url))).toEqual([])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// `--version` is what a script asks first and what an agent asks to see whether
// the tool is there. It prints the manifest's version, so it needs no command.
it("answers --version without loading a command", () => {
  const root = mkdtempSync(join(tmpdir(), "smthrs-startup-version-"))
  const receipt = join(root, "modules.json")
  const observe = "data:text/javascript," + encodeURIComponent(`
import { registerHooks } from "node:module";
import { writeFileSync } from "node:fs";
const loaded = new Set();
registerHooks({ load(url, context, next) { loaded.add(url); return next(url, context) } });
process.on("exit", () => writeFileSync(${JSON.stringify(receipt)}, JSON.stringify([...loaded])));
`)
  try {
    const result = spawnSync(process.execPath, ["--import", observe, cli, "--version"], {
      env: childEnvironment({ ...process.env, HOME: root, XDG_CONFIG_HOME: join(root, "config") }),
      encoding: "utf8"
    })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toBe(`${packageVersion}\n`)
    const loaded: ReadonlyArray<string> = JSON.parse(readFileSync(receipt, "utf8"))
    expect(loaded.some((url) => url.endsWith("/src/bin.ts"))).toBe(true)
    expect(loaded.filter((url) => /\/src\/(?:Cli|cli\/Entry|cli\/LegacyBin)\.ts$/.test(url))).toEqual([])
    expect(loaded.filter((url) => url.includes("/effect-resolution.js"))).toEqual([])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// Only the bare question takes the short way: with anything beside it, the
// command tree decides, as it decides whose `--version` a command-local option is.
it.each([
  [["--version", "--json"]],
  [["--json", "--version"]]
])("lets the command tree answer %j", (args) => {
  const root = mkdtempSync(join(tmpdir(), "smthrs-startup-version-"))
  try {
    const result = spawnSync(process.execPath, [cli, ...args], {
      env: childEnvironment({ ...process.env, HOME: root, XDG_CONFIG_HOME: join(root, "config") }),
      encoding: "utf8"
    })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain(packageVersion)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

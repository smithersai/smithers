import * as Effect from "effect/Effect"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { describe, expect, it } from "vitest"
import * as Exec from "../src/Exec.ts"
import * as Probe from "../src/internal/ImportProbe.ts"
import * as Runtime from "../src/Runtime.ts"

describe("Node import probe protocol", () => {
  it("distinguishes a resolved URL from a missing optional preload", () => {
    expect(Probe.parse(null, "resolved file:///workspace/loader.mjs", "")).toEqual({
      kind: "resolved",
      url: "file:///workspace/loader.mjs"
    })
    expect(Probe.parse(null, "missing", "")).toEqual({ kind: "missing" })
  })

  it("rejects unexpected output rather than treating it as a missing package", () => {
    expect(Probe.parse(null, "unrecognized", "")).toEqual({
      kind: "failed",
      detail: "unexpected probe output \"unrecognized\""
    })
  })

  it("preserves startup and resolver diagnostics on failed probes", () => {
    expect(Probe.parse(new Error("launch denied"), "", "")).toEqual({ kind: "failed", detail: "launch denied" })
    expect(Probe.parse(new Error("probe exited"), "missing", "resolver diagnostic")).toEqual({
      kind: "failed",
      detail: "probe exited\nresolver diagnostic"
    })
  })
})

it("refuses a malformed package manifest reported by the real Node resolver", async () => {
  const root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "preload-probe-boundary-")))
  try {
    await Fs.mkdir(Path.join(root, "node_modules/broken-preload"), { recursive: true })
    await Fs.writeFile(Path.join(root, "node_modules/broken-preload/package.json"), "{")
    const failure = await Effect.runPromise(Effect.flip(Exec.run({ workspaceRoot: root }, {
      cwd: ".",
      argv: [process.execPath, "-e", "process.stdout.write('unexpected')"],
      env: { NODE_OPTIONS: `${Runtime.importTokenPrefix}broken-preload}` },
      secrets: [],
      expectedExitCodes: [0],
      timeoutMs: 5000
    })))
    expect(failure).toMatchObject({ code: "invalid_payload", stdout: "" })
    expect(failure.stderr).toContain("cannot resolve the runtime preload \"broken-preload\"")
    expect(failure.stderr).toContain("ERR_INVALID_PACKAGE_CONFIG")
  } finally {
    await Fs.rm(root, { recursive: true, force: true })
  }
})

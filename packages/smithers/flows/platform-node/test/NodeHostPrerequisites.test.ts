import { describe, expect, it } from "@effect/vitest"
import { Jj } from "@smthrs/jj"
import { ProcessLedger } from "@smthrs/kernel"
import { Effect, Layer } from "effect"
import * as FileSystem from "effect/FileSystem"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as NodeHost from "../src/NodeHost.ts"

const installation = readFileSync(new URL("../docs/installation.md", import.meta.url), "utf8")
const quickstart = readFileSync(new URL("../docs/quickstart.md", import.meta.url), "utf8")

describe("NodeHost prerequisite documentation", () => {
  it("documents the contained spawner as a complete native adapter requiring only a ledger", () => {
    const api = readFileSync(new URL("../docs/api.md", import.meta.url), "utf8")
    const guide = readFileSync(new URL("../docs/guides/contain-child-processes.md", import.meta.url), "utf8")
    const section = api.split("## ProcessReaper.layerSpawner")[1]?.split("## ")[0] ?? ""
    expect(section).toContain("Layer.Layer<ChildProcessSpawner, never, ProcessLedger>")
    expect(section).not.toContain("underlying runtime spawner")
    expect(section).not.toContain("supplied raw runtime spawner")
    expect(guide).not.toContain("underlying runtime spawner")
    expect(section).toContain("Windows")
    expect(section).toContain("native job")
  })

  it("documents the bundle's egress-aware HTTP client", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8")
    expect(readme).toContain("EgressHttpClient.layer(process.env)")
    expect(readme).not.toContain("provided here as `NodeHttpClient.layerUndici`")
  })

  it("describes all four Effect host tags and the Linux crash-recovery probe", () => {
    const host = readFileSync(new URL("../docs/concepts/host-bundle.md", import.meta.url), "utf8")
    const containment = readFileSync(new URL("../docs/concepts/process-containment.md", import.meta.url), "utf8")
    expect(host).toContain("Four of the five tags are Effect's own")
    expect(containment.replace(/\s+/g, " ")).toContain(
      "Linux answers them from `/proc` for both live cleanup and crash recovery"
    )
  })

  it("documents native Windows filesystem and process identity support consistently", () => {
    for (
      const path of [
        "../docs/api.md",
        "../docs/concepts/host-bundle.md",
        "../docs/troubleshooting.md",
        "../docs/installation.md",
        "../docs/quickstart.md",
        "../src/ProcessReaper.ts",
        "../src/index.ts"
      ]
    ) {
      const text = readFileSync(new URL(path, import.meta.url), "utf8")
      expect(text).not.toMatch(
        /Windows is (?:an )?unsupported|no Windows support|Every filesystem call fails on Windows/
      )
      expect(text).not.toContain("Treat it as unsupported best-effort")
      expect(text).not.toContain("every filesystem call fails closed there")
      expect(text).not.toContain("AtomicFileSystem` fails every operation closed there")
    }
    for (const path of ["../docs/concepts/process-containment.md", "../docs/troubleshooting.md"]) {
      const text = readFileSync(new URL(path, import.meta.url), "utf8")
      expect(text).toContain("`--process-info`")
      expect(text).toContain("`own-group`")
      expect(text).not.toContain("boot-time comparison alone")
      expect(text).not.toContain("no own-group refusal")
      expect(text).not.toContain("sweep still uses the `ps`")
    }
  })

  it("requires supported jj for Jj operations, not to build a host bundle", () => {
    const requirements = installation.split("## Host requirements")[1]?.split("###")[0]
    const row = requirements?.split("\n").find((line) => line.includes("jj") && line.includes("0.39.0"))
    expect(row).toMatch(/`Jj` operations/)
    expect(row).not.toMatch(/construction/)
    const checked = installation.split("### jj is checked on first use")[1]?.split("###")[0] ?? ""
    for (const factory of ["layer", "layerAt", "layerContained", "layerContainedAt"]) {
      expect(checked).toContain(`\`NodeHost.${factory}\``)
    }
    expect(checked).toContain("builds without jj")
    expect(checked).toContain("`not_installed`")
    expect(checked).toContain("`unsupported_version`")
    expect(installation).not.toContain("checked at construction")
  })

  it("does not list jj as a prerequisite of the quickstart, which never calls Jj", () => {
    const prerequisites = quickstart.split("## Prerequisites")[1]?.split("## ")[0]
    expect(prerequisites).not.toContain("on a POSIX host")
    expect(prerequisites).not.toMatch(/\bjj\b(?!-export)/)
    expect(quickstart).not.toMatch(/\bJj\b/)
  })

  it("shows individual filesystem, spawner and HTTP layers without a complete bundle", () => {
    const example = installation.split("## Individual services")[1]?.split("## ")[0]
    expect(example).toContain("NodeHost.AtomicFileSystem.layer")
    expect(example).toContain("NodeHost.NodeChildProcessSpawner.layer")
    expect(example).toContain("Layer.provide(platform)")
    expect(example).not.toContain("NodeHost.layer")
  })

  it("composes the egress-aware HTTP client in the copyable individual-services snippet", () => {
    const section = installation.split("## Individual services")[1]?.split("## ")[0] ?? ""
    const code = section.split("```ts")[1]?.split("```")[0] ?? ""
    // A copied snippet must not bypass HTTP_PROXY/HTTPS_PROXY inside an egress-controlled sandbox.
    expect(code).toContain("NodeHost.EgressHttpClient.layer(process.env)")
    expect(code).not.toContain("layerUndici")
  })

  it("marks the allow-all grant store as a test seam wherever a page composes it", () => {
    for (const page of [installation, quickstart]) {
      expect(page).toContain("Layer.provide(GrantStore.layerNoop)")
      expect(page).toContain("not a production policy")
      expect(page).toContain("../../kernel/docs/guides/write-a-capability-policy.md")
    }
  })
})

it.live("builds every host bundle without jj and refuses Jj at its first operation, before spawning", () =>
  Effect.gen(function*() {
    const ledger = yield* ProcessLedger.makeMemory({ hostId: "missing-jj", ownerPid: process.pid })
    const root = mkdtempSync(join(tmpdir(), "flows-node-host-no-jj-"))
    const previousPath = process.env.PATH
    const previousOverride = process.env.SMITHERS_JJ_PATH
    // Resolution finds nothing, so the probe fails before constructing a
    // command: neither an installed binary nor a fixture is ever invoked.
    process.env.PATH = ""
    delete process.env.SMITHERS_JJ_PATH
    try {
      const hosts = [
        NodeHost.layer,
        NodeHost.layerAt(root),
        NodeHost.layerContained(),
        NodeHost.layerContained({ graceMs: 25 }),
        NodeHost.layerContainedAt(root)
      ]
      for (const host of hosts) {
        const error = yield* Effect.gen(function*() {
          // Every other host service is there; only a Jj operation needs jj.
          yield* FileSystem.FileSystem
          yield* ChildProcessSpawner
          const jj = yield* Jj
          return yield* Effect.flip(jj.status())
        }).pipe(Effect.provide(host.pipe(Layer.provide(Layer.succeed(ProcessLedger.ProcessLedger)(ledger)))))
        expect(error).toMatchObject({ code: "not_installed", method: "version", cause: { code: "ENOENT" } })
        expect(error.message).toBe("jj: No jj on PATH. Install jj (https://jj-vcs.github.io) or set SMITHERS_JJ_PATH.")
        expect(yield* ledger.live).toEqual([])
      }
    } finally {
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
      if (previousOverride === undefined) delete process.env.SMITHERS_JJ_PATH
      else process.env.SMITHERS_JJ_PATH = previousOverride
      rmSync(root, { recursive: true, force: true })
    }
  }))

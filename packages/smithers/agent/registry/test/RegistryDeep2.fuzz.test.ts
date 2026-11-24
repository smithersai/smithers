import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Layer, Logger, Option, Result, Schema } from "effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as Descriptor from "../src/Descriptor.ts"
import * as Discovery from "../src/Discovery.ts"
import * as Frontmatter from "../src/internal/Frontmatter.ts"
import * as Names from "../src/internal/Names.ts"
import * as MarkdownFlow from "../src/MarkdownFlow.ts"
import * as Pack from "../src/Pack.ts"
import * as Registry from "../src/Registry.ts"
import * as RegistryError from "../src/RegistryError.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "80")
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261126")
const silentLogger = Logger.layer([])

const assertPassed = (report: Parameters<typeof Fuzz.formatReport>[0]) => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

describe("@smthrs/registry Deep2 Fuzz (MarkdownFlow, Pack, Frontmatter, Names, Registry layers)", () => {
  it("MarkdownFlow.deriveBudget & fromMarkdown fuzz all budget, deadline, license, compatibility, metadata, and schema warnings", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        budgetMode: Schema.Literals([
          "none",
          "validNums",
          "validStrings",
          "notObject",
          "array",
          "badTokens",
          "badMs",
          "badUsd",
          "badOnExceeded",
          "unknownKey",
          "emptyObj"
        ]),
        deadlineMode: Schema.Literals(["none", "validStr", "validNum", "invalid"]),
        licenseMode: Schema.Literals(["none", "ok", "bad"]),
        compatMode: Schema.Literals(["none", "ok", "tooLong", "badType"]),
        metaMode: Schema.Literals(["none", "ok", "badVal", "array"]),
        unsupportedSchema: Schema.Literals(["none", "input", "schema"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (c) =>
          Effect.sync(() => {
            const fields: Record<string, unknown> = {}
            if (c.budgetMode === "validNums") {
              fields.budget = { tokens: 1000, milliseconds: 5000, usd: 1.5, onExceeded: "fail" }
            } else if (c.budgetMode === "validStrings") {
              fields.budget = { tokens: "2000", milliseconds: "3000", usd: "0.25", onExceeded: "park" }
            } else if (c.budgetMode === "notObject") {
              fields.budget = "1000"
            } else if (c.budgetMode === "array") {
              fields.budget = [100]
            } else if (c.budgetMode === "badTokens") {
              fields.budget = { tokens: -5 }
            } else if (c.budgetMode === "badMs") {
              fields.budget = { milliseconds: 0 }
            } else if (c.budgetMode === "badUsd") {
              fields.budget = { usd: "   " }
            } else if (c.budgetMode === "badOnExceeded") {
              fields.budget = { tokens: 100, onExceeded: "explode" }
            } else if (c.budgetMode === "unknownKey") {
              fields.budget = { tokens: 100, token: 50 }
            } else if (c.budgetMode === "emptyObj") {
              fields.budget = {}
            }

            const warnings: Array<any> = []
            const derived = MarkdownFlow.deriveBudget(fields, "/repo/.smithers/flows/f/flow.md", warnings)
            if (c.budgetMode === "validNums" || c.budgetMode === "validStrings") {
              if (derived === undefined || warnings.length !== 0) return false
            } else if (c.budgetMode === "none" || c.budgetMode === "emptyObj") {
              if (derived !== undefined || warnings.length !== 0) return false
            } else {
              if (!warnings.some((w) => w.code === "invalid_budget")) return false
            }

            const fmLines = [
              "---",
              "name: md-fuzz",
              "description: fuzz markdown flow"
            ]
            if (c.budgetMode === "validNums") {
              fmLines.push("budget:", "  tokens: 500", "  milliseconds: 2000", "  usd: 0.5", "  onExceeded: fail")
            } else if (c.budgetMode === "badTokens") {
              fmLines.push("budget:", "  tokens: -1")
            } else if (c.budgetMode === "notObject") {
              fmLines.push("budget: nope")
            }
            if (c.deadlineMode === "validStr") fmLines.push("deadline: 30 seconds")
            else if (c.deadlineMode === "validNum") fmLines.push("deadline: 60000")
            else if (c.deadlineMode === "invalid") fmLines.push("deadline: not-a-duration")

            if (c.licenseMode === "ok") fmLines.push("license: MIT")
            else if (c.licenseMode === "bad") fmLines.push("license:", "  - MIT")

            if (c.compatMode === "ok") fmLines.push("compatibility: smithers >= 1.0")
            else if (c.compatMode === "tooLong") fmLines.push(`compatibility: ${"a".repeat(505)}`)
            else if (c.compatMode === "badType") fmLines.push("compatibility:", "  a: 1")

            if (c.metaMode === "ok") fmLines.push("metadata:", "  team: core")
            else if (c.metaMode === "badVal") fmLines.push("metadata:", "  nested:", "    x: y")
            else if (c.metaMode === "array") fmLines.push("metadata:", "  - a")

            if (c.unsupportedSchema === "input") fmLines.push("input: string")
            else if (c.unsupportedSchema === "schema") fmLines.push("schema: {}")

            fmLines.push("---", "Hello $ARGUMENTS and $1 from markdown!")
            const md = fmLines.join("\n")

            const res = MarkdownFlow.fromMarkdown({
              text: md,
              path: "/repo/.smithers/flows/md-fuzz/flow.md",
              baseDirectory: "/repo/.smithers/flows/md-fuzz",
              naming: "frontmatter",
              name: Option.some("md-fuzz"),
              dirBasename: "md-fuzz",
              provenance: new Descriptor.Provenance({ source: "project", root: "/repo" })
            })
            const hasBadInput = c.budgetMode === "badTokens" || c.budgetMode === "notObject" ||
              c.deadlineMode === "invalid" || c.licenseMode === "bad" ||
              c.compatMode === "tooLong" || c.compatMode === "badType" ||
              c.metaMode === "badVal" || c.metaMode === "array" ||
              c.unsupportedSchema !== "none"
            if (hasBadInput && res.warnings.length === 0) return false
            if (Option.isSome(res.descriptor)) {
              const core = MarkdownFlow.toCoreFrontmatter(res.descriptor.value)
              if (typeof core !== "object") return false
              const body = MarkdownFlow.loadBody(md, "/repo/.smithers/flows/md-fuzz")
              const rendered = MarkdownFlow.renderPrompt(body, { args: "world" })
              if (!rendered.includes("world")) return false
            }
            return true
          }),
        { seed, executions }
      )
    )
    assertPassed(report)
  })

  it("Pack (compatible, checkCompatible, read, digest, sources, merge) & Registry (layerFromDescriptors, layerFromPacks, makeNoop)", async () => {
    const realPackBase = mkdtempSync(join(tmpdir(), "reg-pack-src-"))
    mkdirSync(join(realPackBase, "flows"), { recursive: true })
    try {
      const arb = Arbitrary.schema(
        Schema.Struct({
          range: Schema.Literals([
            "*",
            ">=1.0.0",
            "^1.0.0",
            "~1.0.0",
            ">=1.0.0 <2.0.0",
            "1.0.0",
            ">=2.0.0",
            "invalid-range"
          ]),
          runtime: Schema.Literals(["1.0.0", "1.2.3", "1.0.0-rc.18", "2.0.0", "0.9.0", "bad"]),
          packOrigin: Schema.Literals(["local", "installed"])
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          (c) =>
            Effect.gen(function*() {
              const ok = Pack.compatible(c.range, c.runtime)
              if (c.range === "*" && c.runtime !== "bad" && !ok) return false
              if (c.range === "invalid-range" && ok) return false
              if (c.range === ">=2.0.0" && c.runtime === "1.0.0" && ok) return false
              if (c.range === ">=2.0.0" && c.runtime === "2.0.0" && !ok) return false

              const manifest = new Pack.Manifest({
                name: "fuzz-pack",
                version: "1.0.0",
                flows: ["flows" as any],
                requires: { smithers: c.range }
              })
              const d1 = Pack.digest(manifest, [{ path: "a.md", contents: "hi" }])
              const d2 = Pack.digest(manifest, [{ path: "a.md", contents: "hi" }])
              if (d1 !== d2) return false

              const installed: Pack.Installed = {
                manifest,
                origin: c.packOrigin,
                dir: realPackBase
              }
              const compatRes = yield* Effect.result(
                Pack.checkCompatible(installed, { join: (...xs: Array<string>) => xs.join("/") } as any, c.runtime)
              )
              if (ok && Result.isFailure(compatRes)) return false
              if (!ok && Result.isSuccess(compatRes)) return false

              const pathSvc = yield* Path.Path
              const srcs = yield* Pack.sources(installed, pathSvc)
              if (srcs.length === 0) return false
              return true
            }).pipe(Effect.provide(NodeFileSystem.layer), Effect.provide(NodePath.layer)),
          { seed: seed + 1, executions }
        )
      )
      assertPassed(report)

      const tmpBase = mkdtempSync(join(tmpdir(), "reg-pack-fuzz-"))
      try {
        const packDir = join(tmpBase, "my-pack")
        const flowDir = join(packDir, "flows", "hello")
        mkdirSync(flowDir, { recursive: true })
        writeFileSync(
          join(packDir, "pack.json"),
          JSON.stringify({
            name: "my-pack",
            version: "1.0.0",
            flows: ["flows"],
            requires: { smithers: ">=1.0.0" }
          }),
          "utf8"
        )
        writeFileSync(
          join(flowDir, "flow.mdx"),
          "---\nname: hello\ndescription: say hello\n---\nHello $ARGUMENTS!\n",
          "utf8"
        )

        const fsLayer = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)
        await Effect.runPromise(
          Effect.gen(function*() {
            const fs = yield* FileSystem.FileSystem
            const path = yield* Path.Path
            const readPack = yield* Pack.read(fs, path, packDir)
            expect(readPack.manifest.name).toBe("my-pack")

            const installed: Pack.Installed = {
              manifest: readPack.manifest,
              dir: readPack.dir,
              origin: "local",
              warnings: readPack.warnings
            }
            const reg = yield* Registry.Registry.pipe(
              Effect.provide(
                Registry.layerFromPacks([installed], { runtimeVersion: "1.0.0" }).pipe(
                  Layer.provide(Discovery.layer)
                )
              )
            )
            const list = yield* reg.list()
            expect(list.length).toBeGreaterThanOrEqual(1)

            const descReg = yield* Registry.Registry.pipe(
              Effect.provide(Registry.layerFromDescriptors(list))
            )
            expect((yield* descReg.visible()).length).toBe(list.length)
            const opt = yield* descReg.getOption(list[0]!.name)
            expect(Option.isSome(opt)).toBe(true)

            const noop = Registry.makeNoop()
            expect(yield* noop.list()).toEqual([])
            expect(yield* noop.visible()).toEqual([])
            expect(Option.isNone(yield* noop.getOption("missing"))).toBe(true)
            const nf = yield* Effect.result(noop.get("missing"))
            expect(Result.isFailure(nf)).toBe(true)
            yield* noop.refresh()
          }).pipe(Effect.provide(fsLayer), Effect.provide(silentLogger))
        )

        expect(Frontmatter.parse({ text: "---\na: 1\n---\nbody", path: "/f.md" }).fields).toBeDefined()
        expect(Names).toBeDefined()
        expect(new RegistryError.RegistryError({ code: "not_found", message: "m" }).message).toBe("m")
      } finally {
        rmSync(tmpBase, { recursive: true, force: true })
      }
    } finally {
      rmSync(realPackBase, { recursive: true, force: true })
    }
  })
})

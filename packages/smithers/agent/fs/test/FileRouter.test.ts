import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { Cause, Effect, Layer, Option } from "effect"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { relative, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import * as FileRouter from "../src/FileRouter.ts"

const root = fileURLToPath(new URL("./fixtures/router/flows", import.meta.url))

const platformLayer = Layer.merge(NodeFileSystem.layer, NodePath.layer)

const scan = () => Effect.runPromise(FileRouter.scan({ root }).pipe(Effect.provide(platformLayer)))

describe("FileRouter", () => {
  it("routes directory entries by path without evaluating module bodies", async () => {
    const result = await scan()

    expect(result.routes.map((route) => route.name)).toEqual([
      "directives/panel",
      "directives/sandboxed",
      "domains",
      "domains/list",
      "mixed",
      "review",
      "skills/demo"
    ])
    expect(result.routes.find((route) => route.name === "review")?.segments).toEqual(["review"])
    expect(result.routes.find((route) => route.name === "domains/list")?.segments).toEqual(["domains", "list"])
    expect(result.routes.find((route) => route.name === "review")?.sourcePath).toMatch(/review\/flow\.ts$/)
  })

  it("preserves registry entry precedence and diagnostics", async () => {
    const result = await scan()

    expect(result.routes.find((route) => route.name === "mixed")?.kind).toBe("module")
    expect(result.routes.find((route) => route.name === "mixed")?.sourcePath).toMatch(/mixed\/flow\.ts$/)
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "multiple_entry_files", path: expect.stringMatching(/mixed$/) }),
      expect.objectContaining({ code: "root_level_entry", path: expect.stringMatching(/flows\/flow\.ts$/) }),
      expect.objectContaining({ code: "name_field_ignored", path: expect.stringMatching(/review\/flow\.ts$/) })
    ]))
  })

  it("records UI companions without routing companions or colocated tests", async () => {
    const result = await scan()
    const review = result.routes.find((route) => route.name === "review")

    expect(Option.getOrUndefined(review?.ui ?? Option.none())).toMatch(/review\/ui\.tsx$/)
    expect(result.routes.some((route) => route.sourcePath.endsWith("/ui.tsx"))).toBe(false)
    expect(result.routes.some((route) => route.sourcePath.endsWith("/flow.test.ts"))).toBe(false)
  })

  it("routes skills as metadata while leaving skill parsing lazy", async () => {
    const result = await scan()
    const skill = result.routes.find((route) => route.name === "skills/demo")

    expect(skill).toMatchObject({ kind: "skill", sourcePath: expect.stringMatching(/SKILL\.md$/) })
  })

  it("is deterministic", async () => {
    const first = await scan()
    const second = await scan()

    expect(second).toEqual(first)
  })

  it("resolves a relative root once and returns absolute immutable routes", async () => {
    const relativeRoot = relative(process.cwd(), root)
    const config = { root: relativeRoot }
    const pending = Effect.runPromise(FileRouter.scan(config).pipe(Effect.provide(platformLayer)))
    config.root = "/"
    const result = await pending

    expect(result.routes.length).toBeGreaterThan(0)
    expect(result.routes.every((route) => route.sourcePath.startsWith("/"))).toBe(true)
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.routes)).toBe(true)
  })

  it("preserves a literal backslash segment on POSIX", async () => {
    if (sep !== "/") return
    const temporary = await mkdtemp(`${tmpdir()}/smithers-fs-router-`)
    try {
      const source =
        `import { Flow } from "@smthrs/core"\nexport default Flow.make({ name: "fixture", description: "fixture" })\n`
      await mkdir(`${temporary}/a\\b`, { recursive: true })
      await mkdir(`${temporary}/a/b`, { recursive: true })
      await writeFile(`${temporary}/a\\b/flow.ts`, source)
      await writeFile(`${temporary}/a/b/flow.ts`, source)
      const result = await Effect.runPromise(
        FileRouter.scan({ root: temporary }).pipe(Effect.provide(platformLayer))
      )
      expect(result.routes.map((route) => route.name)).toEqual(["a/b", "a\\b"])
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  })

  it("preserves discovery error codes and refuses hostile config", async () => {
    const missing = await Effect.runPromise(Effect.exit(
      FileRouter.scan({ root: "/definitely/missing/smithers-flows" }).pipe(Effect.provide(platformLayer))
    ))
    expect(missing._tag).toBe("Failure")
    if (missing._tag === "Failure") {
      const error = Option.getOrThrow(Cause.findErrorOption(missing.cause))
      expect(error.code).toBe("root_missing")
    }

    let called = false
    const config = Object.defineProperty({}, "root", {
      enumerable: true,
      get: () => {
        called = true
        return root
      }
    })
    const hostile = await Effect.runPromise(Effect.exit(
      FileRouter.scan(config as FileRouter.ScanConfig).pipe(Effect.provide(platformLayer))
    ))
    expect(hostile._tag).toBe("Failure")
    expect(called).toBe(false)
  })
})

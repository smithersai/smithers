import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { Lexer, type Sidecar, Targets, targets, VirtualFile } from "../src/index.ts"

describe("VirtualFile & Smithers Targets", () => {
  it.effect("projects external comments into clean TypeScript preserving indentation, shebang, and pragmas", () =>
    Effect.gen(function*() {
      const cleanSource = [
        "#!/usr/bin/env node",
        "// SPDX-License-Identifier: MIT",
        "export function retry(attempts: number) {",
        "  const delay = attempts * 100",
        "  return delay",
        "}",
        ""
      ].join("\n")

      const sidecar: Sidecar.SidecarDocument = {
        source: "src/retry.ts",
        version: 1,
        entries: [
          {
            id: "file-header",
            anchor: { kind: "file" },
            placement: "before",
            style: "doc",
            body: "Linear retry backoff helpers."
          },
          {
            id: "retry-doc",
            anchor: { kind: "symbol", symbol: "retry" },
            line: 3,
            placement: "before",
            style: "doc",
            body: "Computes backoff delay in milliseconds."
          },
          {
            id: "delay-note",
            anchor: { kind: "pattern", pattern: "const delay =" },
            line: 4,
            placement: "before",
            style: "line",
            body: "Cap jitter externally at the caller."
          },
          {
            id: "return-inline",
            anchor: { kind: "pattern", pattern: "return delay" },
            line: 5,
            placement: "inline",
            style: "line",
            body: "milliseconds"
          }
        ]
      }

      const vf = yield* VirtualFile.projectFile(cleanSource, sidecar, "src/retry.ts")
      expect(vf.path).toBe("src/retry.ts")
      expect(vf.injectedCount).toBe(4)
      expect(vf.digest).toMatch(/^[0-9a-f]{64}$/)
      expect(vf.sourceDigest).not.toBe(vf.digest)
      expect(vf.lineMap).toHaveLength(4)

      const lines = vf.content.split("\n")
      expect(lines[0]).toBe("#!/usr/bin/env node")
      expect(lines[1]).toBe("// SPDX-License-Identifier: MIT")
      expect(vf.content).toContain("/**\n * Linear retry backoff helpers.\n */")
      expect(vf.content).toContain("/**\n * Computes backoff delay in milliseconds.\n */")
      expect(vf.content).toContain("  // Cap jitter externally at the caller.\n  const delay = attempts * 100")
      expect(vf.content).toContain("  return delay  // milliseconds")

      // Round-trip: lexing projected output yields our 4 prose comments + 2 preserved pragmas
      const relexed = Lexer.lexComments(vf.content, "src/retry.ts")
      expect(relexed.comments.filter((c) => !c.isPragma)).toHaveLength(4)
      expect(relexed.comments.filter((c) => c.isPragma)).toHaveLength(2)
    }))

  it.effect("projects across hash, dash, and markup languages with language-native delimiters", () =>
    Effect.gen(function*() {
      const py = yield* VirtualFile.projectFile(
        "def run():\n    return 1\n",
        {
          source: "scripts/run.py",
          version: 1,
          entries: [{
            id: "py1",
            anchor: { kind: "symbol", symbol: "run" },
            placement: "before",
            style: "doc",
            body: "Run job."
          }]
        },
        "scripts/run.py"
      )
      expect(py.content).toBe("# Run job.\ndef run():\n    return 1\n")

      const sql = yield* VirtualFile.projectFile(
        "SELECT 1;\n",
        {
          source: "db/ping.sql",
          version: 1,
          entries: [{
            id: "sql1",
            anchor: { kind: "line", line: 1 },
            placement: "before",
            style: "line",
            body: "Health probe"
          }]
        },
        "db/ping.sql"
      )
      expect(sql.content).toBe("-- Health probe\nSELECT 1;\n")

      const html = yield* VirtualFile.projectFile(
        "<main>Hi</main>\n",
        {
          source: "web/index.html",
          version: 1,
          entries: [{
            id: "h1",
            anchor: { kind: "line", line: 1 },
            placement: "before",
            style: "block",
            body: "Primary content"
          }]
        },
        "web/index.html"
      )
      expect(html.content).toBe("<!-- Primary content -->\n<main>Hi</main>\n")
    }))

  it.effect("fails on unresolved anchor by default, and skips cleanly with onUnresolved: skip", () =>
    Effect.gen(function*() {
      const sidecar: Sidecar.SidecarDocument = {
        source: "src/a.ts",
        version: 1,
        entries: [{
          id: "bad",
          anchor: { kind: "symbol", symbol: "missingFn" },
          placement: "before",
          style: "line",
          body: "Ghost"
        }]
      }

      const failExit = yield* Effect.exit(VirtualFile.projectFile("export const x = 1\n", sidecar, "src/a.ts"))
      expect(Exit.isFailure(failExit)).toBe(true)

      const skipped = yield* VirtualFile.projectFile("export const x = 1\n", sidecar, "src/a.ts", {
        onUnresolved: "skip"
      })
      expect(skipped.injectedCount).toBe(0)
      expect(skipped.content).toBe("export const x = 1\n")
    }))

  it.effect("projects a deterministic VirtualFileTree, materializes to disk, and detects drift with --check", () =>
    Effect.gen(function*() {
      const sources = new Map<string, string>([
        ["src/b.ts", "export const b = 2\n"],
        ["src/a.ts", "export const a = 1\n"]
      ])
      const sidecars = new Map<string, Sidecar.SidecarDocument>([
        [
          "src/a.ts",
          {
            source: "src/a.ts",
            version: 1,
            entries: [{
              id: "a1",
              anchor: { kind: "line", line: 1 },
              placement: "before",
              style: "line",
              body: "Constant A"
            }]
          }
        ]
      ])

      const tree1 = yield* VirtualFile.projectTree(sources, sidecars)
      const tree2 = yield* VirtualFile.projectTree(new Map([...sources].reverse()), sidecars)
      expect(tree1.treeDigest).toBe(tree2.treeDigest)
      expect(tree1.files.get("src/a.ts")?.content).toBe("// Constant A\nexport const a = 1\n")
      expect(tree1.files.get("src/b.ts")?.content).toBe("export const b = 2\n")

      const outDir = yield* Effect.promise(() => Fs.mkdtemp(Path.join(Os.tmpdir(), "sc-vf-")))
      try {
        const writeRes = yield* VirtualFile.materializeTree(tree1, outDir)
        expect(writeRes.written.length).toBe(2)
        expect(writeRes.drifted).toEqual([])

        const checkClean = yield* VirtualFile.materializeTree(tree1, outDir, { check: true })
        expect(checkClean.drifted).toEqual([])

        // Mutate materialized file to simulate drift
        yield* Effect.promise(() => Fs.writeFile(Path.join(outDir, "src/a.ts"), "drifted\n", "utf8"))
        const checkDrifted = yield* VirtualFile.materializeTree(tree1, outDir, { check: true })
        expect(checkDrifted.drifted).toEqual(["src/a.ts"])
      } finally {
        yield* Effect.promise(() => Fs.rm(outDir, { recursive: true, force: true }))
      }
    }))

  it("constructs valid Smithers targets via targets() backed by @smthrs/targets", () => {
    const bundle = targets({
      mode: "external",
      commentsDir: ".comments",
      include: ["src/**/*.ts"],
      virtualOutDir: ".smithers/comments-view"
    })
    expect(bundle).toBeDefined()
    expect(bundle.sources).toBeDefined()
    expect(bundle.sidecars).toBeDefined()
    expect(bundle.lint).toBeDefined()
    expect(bundle.virtualFiles).toBeDefined()
    expect(bundle.materialize).toBeDefined()
    expect(Targets.targets).toBe(targets)
  })
})

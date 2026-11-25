import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import { Sidecar } from "../src/index.ts"

describe("Sidecar", () => {
  it("computes repo-relative POSIX sidecar paths and reverses them", () => {
    expect(Sidecar.sidecarPathFor(".comments", "src/auth/token.ts")).toBe(".comments/src/auth/token.ts.md")
    expect(Sidecar.sidecarPathFor("docs/comments/", "./src/auth/token.ts")).toBe("docs/comments/src/auth/token.ts.md")
    expect(Sidecar.sourcePathFromSidecar(".comments", ".comments/src/auth/token.ts.md")).toBe("src/auth/token.ts")
    expect(Sidecar.sourcePathFromSidecar(".comments", "other/src/auth/token.ts.md")).toBeUndefined()
  })

  it.effect("parses and formats a complete canonical sidecar document losslessly", () =>
    Effect.gen(function*() {
      const doc: Sidecar.SidecarDocument = {
        source: "src/auth/token.ts",
        version: 1,
        entries: [
          {
            id: "token-module-overview",
            anchor: { kind: "file" },
            placement: "before",
            style: "doc",
            codeHash: "4a90d1e2",
            body: "Token signing and verification utilities."
          },
          {
            id: "verify-token-doc",
            anchor: { kind: "symbol", symbol: "verifyToken" },
            line: 14,
            placement: "before",
            style: "doc",
            codeHash: "9f81c2a0",
            body: "Verifies a signed session token.\nRejects revoked keys."
          },
          {
            id: "clock-skew-note",
            anchor: { kind: "line", line: 27 },
            placement: "inline",
            style: "line",
            codeHash: "18bc44f1",
            body: "Allow 30s skew across edge nodes."
          },
          {
            id: "retry-pattern",
            anchor: { kind: "pattern", pattern: "const maxRetries = 3" },
            line: 40,
            placement: "after",
            style: "block",
            body: "Three attempts balance tail latency against transient DNS blips."
          }
        ]
      }

      const formatted = Sidecar.formatSidecar(doc)
      expect(formatted.endsWith("\n")).toBe(true)
      expect(formatted).toContain("source: src/auth/token.ts")
      expect(formatted).toContain("version: 1")
      expect(formatted).toContain("## @verify-token-doc")
      expect(formatted).toContain("anchor: symbol verifyToken")

      const reparsed = yield* Sidecar.parseSidecar(formatted, ".comments/src/auth/token.ts.md")
      expect(reparsed).toEqual(doc)
    }))

  it.effect("escapes and unescapes lines beginning with ## @ inside comment bodies", () =>
    Effect.gen(function*() {
      const doc: Sidecar.SidecarDocument = {
        source: "src/markdown.ts",
        version: 1,
        entries: [
          {
            id: "escaped-heading",
            anchor: { kind: "line", line: 1 },
            placement: "before",
            style: "block",
            body: "Example heading:\n## @not-a-new-entry\nStill same comment."
          }
        ]
      }

      const formatted = Sidecar.formatSidecar(doc)
      expect(formatted).toContain("\\## @not-a-new-entry")

      const reparsed = yield* Sidecar.parseSidecar(formatted)
      expect(reparsed).toEqual(doc)
    }))

  it.effect("rejects malformed frontmatter, unknown version, duplicate IDs, and bad anchors with SidecarParseError", () =>
    Effect.gen(function*() {
      const invalidCases = [
        "no frontmatter at all\n## @a\nanchor: file\nplacement: before\nstyle: line\n\nhi\n",
        "---\nsource: src/a.ts\nversion: 2\n---\n\n## @a\nanchor: file\nplacement: before\nstyle: line\n\nhi\n",
        "---\nsource: src/a.ts\nversion: 1\n---\n\n## @dup\nanchor: file\nplacement: before\nstyle: line\n\na\n\n## @dup\nanchor: file\nplacement: after\nstyle: line\n\nb\n",
        "---\nsource: src/a.ts\nversion: 1\n---\n\n## @bad\nanchor: line 0\nplacement: before\nstyle: line\n\nhi\n",
        "---\nsource: src/a.ts\nversion: 1\n---\n\n## @bad\nanchor: unknown foo\nplacement: before\nstyle: line\n\nhi\n",
        "---\nsource: src/a.ts\nversion: 1\n---\n\n## @bad\nanchor: file\nplacement: sideways\nstyle: line\n\nhi\n"
      ]

      for (const raw of invalidCases) {
        const exit = yield* Effect.exit(Sidecar.parseSidecar(raw))
        expect(Exit.isFailure(exit)).toBe(true)
      }
    }))
})

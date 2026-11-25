import { describe, expect, it } from "@effect/vitest"
import { Lexer } from "../src/index.ts"

describe("Lexer", () => {
  describe("language detection", () => {
    it("detects all documented language families", () => {
      expect(Lexer.detectLanguage("src/index.ts")).toBe("c-style")
      expect(Lexer.detectLanguage("src/app.tsx")).toBe("c-style")
      expect(Lexer.detectLanguage("pkg/main.go")).toBe("c-style")
      expect(Lexer.detectLanguage("crates/core/src/lib.rs")).toBe("c-style")
      expect(Lexer.detectLanguage("src/flow.vibe")).toBe("c-style")
      expect(Lexer.detectLanguage("src/styles.css")).toBe("c-style")
      expect(Lexer.detectLanguage("scripts/run.py")).toBe("hash")
      expect(Lexer.detectLanguage("scripts/build.sh")).toBe("hash")
      expect(Lexer.detectLanguage("config/app.yaml")).toBe("hash")
      expect(Lexer.detectLanguage("Cargo.toml")).toBe("hash")
      expect(Lexer.detectLanguage("db/schema.sql")).toBe("dash")
      expect(Lexer.detectLanguage("init.lua")).toBe("dash")
      expect(Lexer.detectLanguage("web/index.html")).toBe("markup")
      expect(Lexer.detectLanguage("assets/icon.svg")).toBe("markup")
      expect(Lexer.detectLanguage("README.unknown")).toBeUndefined()
    })
  })

  describe("c-style lexing", () => {
    it("extracts line, block, and doc comments with accurate positions", () => {
      const source = [
        "/** Verifies a signed token. */",
        "export function verifyToken(token: string) {",
        "  // Reject empty input early",
        "  if (!token) return false /* fast path */",
        "  return true",
        "}",
        ""
      ].join("\n")

      const result = Lexer.lexComments(source, "src/token.ts")
      expect(result.language).toBe("c-style")
      expect(result.eol).toBe("\n")
      expect(result.hasTrailingNewline).toBe(true)
      expect(result.comments).toHaveLength(3)

      expect(result.comments[0]).toMatchObject({
        style: "doc",
        body: "Verifies a signed token.",
        startLine: 1,
        endLine: 1,
        isInline: false,
        isPragma: false
      })
      expect(result.comments[1]).toMatchObject({
        style: "line",
        body: "Reject empty input early",
        startLine: 3,
        endLine: 3,
        isInline: false,
        indentation: "  "
      })
      expect(result.comments[2]).toMatchObject({
        style: "block",
        body: "fast path",
        startLine: 4,
        endLine: 4,
        isInline: true
      })
    })

    it("never mistakes comment delimiters inside strings, templates, or regexes for comments", () => {
      const source = [
        "const url = \"https://example.com//not-a-comment\"",
        "const single = '/* also not a comment */'",
        "const escaped = \"quote \\\" // still string\"",
        "const tpl = `hello ${/* real comment inside expr */ 42} // inside template`",
        "const re = /https:\\/\\/foo\\/[//]*/g",
        "// real trailing comment",
        ""
      ].join("\n")

      const result = Lexer.lexComments(source, "src/strings.ts")
      expect(result.comments.map((c) => c.body)).toEqual([
        "real comment inside expr",
        "real trailing comment"
      ])
    })

    it("handles nested block comments in Rust files", () => {
      const source = [
        "/* outer /* inner */ still outer */",
        "pub fn add(a: i32, b: i32) -> i32 { a + b }",
        ""
      ].join("\n")

      const result = Lexer.lexComments(source, "src/lib.rs")
      expect(result.comments).toHaveLength(1)
      expect(result.comments[0]?.style).toBe("block")
      expect(result.comments[0]?.body).toContain("inner")
      expect(result.comments[0]?.endLine).toBe(1)
    })

    it("preserves CRLF line endings and UTF-8 / emoji offsets", () => {
      const source = "// rocket 🚀 note\r\nexport const x = 1\r\n"
      const result = Lexer.lexComments(source, "src/crlf.ts")
      expect(result.eol).toBe("\r\n")
      expect(result.comments).toHaveLength(1)
      expect(result.comments[0]?.body).toBe("rocket 🚀 note")
      expect(source.slice(result.comments[0]!.startOffset, result.comments[0]!.endOffset)).toBe("// rocket 🚀 note")
    })
  })

  describe("hash, dash, and markup lexing", () => {
    it("lexes Python comments while ignoring # inside strings and triple-quoted strings", () => {
      const source = [
        "#!/usr/bin/env python3",
        "# Explain why we batch inserts",
        "s = \"# not a comment\"",
        "doc = \"\"\"# also not a comment\"\"\"",
        "x = 1  # inline note",
        ""
      ].join("\n")

      const result = Lexer.lexComments(source, "scripts/load.py")
      expect(result.language).toBe("hash")
      expect(result.comments).toHaveLength(3)
      expect(result.comments[0]?.isPragma).toBe(true)
      expect(result.comments[1]?.body).toBe("Explain why we batch inserts")
      expect(result.comments[1]?.isPragma).toBe(false)
      expect(result.comments[2]?.body).toBe("inline note")
      expect(result.comments[2]?.isInline).toBe(true)
    })

    it("lexes SQL dash comments while ignoring -- inside SQL string literals", () => {
      const source = [
        "-- Keep active accounts indexed",
        "SELECT '-- not a comment' FROM users; -- inline sql note",
        ""
      ].join("\n")

      const result = Lexer.lexComments(source, "db/query.sql")
      expect(result.language).toBe("dash")
      expect(result.comments.map((c) => c.body)).toEqual([
        "Keep active accounts indexed",
        "inline sql note"
      ])
    })

    it("lexes HTML markup comments", () => {
      const source = "<!-- Header navigation -->\n<nav>Home</nav>\n"
      const result = Lexer.lexComments(source, "web/index.html")
      expect(result.language).toBe("markup")
      expect(result.comments).toHaveLength(1)
      expect(result.comments[0]?.body).toBe("Header navigation")
    })
  })

  describe("pragma preservation and stripping", () => {
    it("preserves built-in and custom pragmas while stripping prose comments", () => {
      const source = [
        "#!/usr/bin/env node",
        "// SPDX-License-Identifier: MIT",
        "// Prose explanation of retry backoff",
        "// @ts-expect-error intentional mismatch",
        "/* eslint-disable-next-line no-console */",
        "// CUSTOM-DIRECTIVE: keep",
        "export const retries = 3 // inline prose",
        ""
      ].join("\n")

      const stripped = Lexer.stripProseComments(source, "src/retry.ts", {
        preservePragmas: true,
        extraPragmaPatterns: ["CUSTOM-DIRECTIVE:"]
      })

      expect(stripped.extracted.map((c) => c.body)).toEqual([
        "Prose explanation of retry backoff",
        "inline prose"
      ])
      expect(stripped.preservedPragmas).toHaveLength(5)
      expect(stripped.code).toContain("#!/usr/bin/env node")
      expect(stripped.code).toContain("SPDX-License-Identifier: MIT")
      expect(stripped.code).toContain("@ts-expect-error intentional mismatch")
      expect(stripped.code).toContain("eslint-disable-next-line no-console")
      expect(stripped.code).toContain("CUSTOM-DIRECTIVE: keep")
      expect(stripped.code).toContain("export const retries = 3")
      expect(stripped.code).not.toContain("Prose explanation")
      expect(stripped.code).not.toContain("inline prose")
    })
  })
})

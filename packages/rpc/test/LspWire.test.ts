import { describe, expect, test } from "vitest"
import { LSP_HOVER_CAP_CHARS } from "../src/LocalLsp.ts"
import {
  hoverContents,
  LSP_CLIENT_CAPABILITIES,
  redactHostPaths,
  relativeToRoot,
  toDiagnostic,
  toWireRange
} from "../src/LspWire.ts"

/*
 * The one conversion of the LSP wire into the typed answers, shared by the
 * Bun stdio session and the renderer's cloud client: ranges become 1-based,
 * a hover becomes one markdown string cut at the cap, a severity becomes its
 * word, a file URI under the root becomes a relative path and one outside it
 * becomes null (counted, never listed).
 */
describe("the LSP wire conversion", () => {
  test("a 0-based, end-exclusive range becomes 1-based on both ends", () => {
    expect(toWireRange({ start: { line: 2, character: 6 }, end: { line: 2, character: 13 } }))
      .toEqual({ line: 3, character: 7, endLine: 3, endCharacter: 14 })
  })

  test("a hover's contents — markup, a marked string, or a list — become one markdown string, cut at the cap and saying so", () => {
    expect(hoverContents({ kind: "markdown", value: "```typescript\nconst message: string\n```" }))
      .toEqual({ contents: "```typescript\nconst message: string\n```", truncated: false })
    expect(hoverContents({ language: "typescript", value: "const x: number" }))
      .toEqual({ contents: "```typescript\nconst x: number\n```", truncated: false })
    expect(hoverContents(["plain", { language: "ts", value: "v" }]))
      .toEqual({ contents: "plain\n\n```ts\nv\n```", truncated: false })
    const long = hoverContents("x".repeat(LSP_HOVER_CAP_CHARS + 10))
    expect(long.contents).toHaveLength(LSP_HOVER_CAP_CHARS)
    expect(long.truncated).toBe(true)
    // The redaction runs before the cut, so a path never straddles it.
    expect(
      hoverContents(
        "module \"/home/developer/workspace/src/greet\"",
        (text) => redactHostPaths(text, "/home/developer/workspace")
      )
    )
      .toEqual({ contents: "module \"src/greet\"", truncated: false })
  })

  test("a diagnostic's numeric severity becomes its word, an unknown or absent one is an error, and the code is a string", () => {
    const range = { start: { line: 3, character: 23 }, end: { line: 3, character: 29 } }
    expect(
      toDiagnostic({
        range,
        message: "Property 'lenght' does not exist",
        severity: 1,
        code: 2551,
        source: "typescript"
      })
    )
      .toEqual({
        line: 4,
        character: 24,
        endLine: 4,
        endCharacter: 30,
        severity: "error",
        message: "Property 'lenght' does not exist",
        source: "typescript",
        code: "2551"
      })
    expect(toDiagnostic({ range, message: "unused", severity: 4 }).severity).toBe("hint")
    expect(toDiagnostic({ range, message: "?", severity: 9 }).severity).toBe("error")
    expect(toDiagnostic({ range, message: "?" })).toEqual({
      line: 4,
      character: 24,
      endLine: 4,
      endCharacter: 30,
      severity: "error",
      message: "?"
    })
  })

  test("free text loses the machine's paths: under the root relative, elsewhere the last segment behind …/", () => {
    const root = "/home/developer/workspace"
    expect(redactHostPaths(`File '${root}/src/a.ts' is not under 'rootDir' '${root}'.`, root)).toBe(
      "File 'src/a.ts' is not under 'rootDir' '.'."
    )
    expect(redactHostPaths("at /nix/store/abc-typescript/lib/lib.es5.d.ts:12:3", root)).toBe("at …/lib.es5.d.ts:12:3")
    expect(redactHostPaths("see https://example.com/a/b and src/x.ts", root)).toBe(
      "see https://example.com/a/b and src/x.ts"
    )
  })

  test("a file URI under the root is root-relative; one elsewhere, or not a file URI, is null", () => {
    const root = "file:///home/developer/workspace"
    expect(relativeToRoot(`${root}/src/greet.ts`, root)).toBe("src/greet.ts")
    expect(relativeToRoot(`${root}/src/greet.ts`, `${root}/`)).toBe("src/greet.ts")
    expect(relativeToRoot(`${root}/a%20b/c.ts`, root)).toBe("a b/c.ts")
    expect(relativeToRoot("file:///nix/store/x/lib.es5.d.ts", root)).toBeNull()
    expect(relativeToRoot("file:///home/developer/workspace-2/x.ts", root)).toBeNull()
    expect(relativeToRoot("untitled:Untitled-1", root)).toBeNull()
  })

  test("file links and escaped host paths are redacted without changing public URLs", () => {
    const root = "/home/developer/workspace"
    expect(redactHostPaths(`[a](file://${root}/src/a%20b.ts#L12)`, root)).toBe("[a](src/a b.ts)")
    expect(redactHostPaths("See file:///Users/%61lice/private/src/a.ts", root)).toBe("See …/a.ts")
    expect(redactHostPaths("See FILE:///nix/store/abc/lib.d.ts", root)).toBe("See …/lib.d.ts")
    expect(redactHostPaths("See /Users/%61lice/private/a.ts", root)).toBe("See …/a.ts")
    expect(redactHostPaths("See file:///Users/alice/%ZZ", root)).toBe("See …")
    expect(redactHostPaths("See https://example.com/a/b#L12", root)).toBe("See https://example.com/a/b#L12")
  })

  test.each(["/Users/alice", "/Users/alice/", "/home/alice/", "file:///Users/%61lice", "file:///home/alice/"])(
    "bare home directory %s is fully elided",
    (path) => expect(redactHostPaths(`home is ${path}`, "/home/developer/workspace")).toBe("home is …")
  )

  test.each([
    "../../../etc/passwd",
    "src/%2e%2e/%2e%2e/%2e%2e/.ssh/id_ed25519",
    "..",
    "src/../a.ts",
    "src/%2e%2e/a.ts",
    "./a.ts",
    "%2e/a.ts",
    "src//a.ts",
    "src/a.ts/",
    "src%2fa.ts",
    "src%5ca.ts",
    "src\\a.ts",
    "src/%00a.ts",
    "src/%ZZ.ts"
  ])("unsafe file path %s is refused before URL normalization", (path) => {
    const root = "file:///home/developer/workspace"
    expect(relativeToRoot(`${root}/${path}`, root)).toBeNull()
  })

  test("file URI containment uses decoded paths and matching file authorities, excluding query and fragment", () => {
    const root = "file:///home/developer/workspace"
    expect(relativeToRoot(`${root}/src/a.ts?version=1#L12`, root)).toBe("src/a.ts")
    expect(relativeToRoot(`${root}/src/a.ts`, "file:///home/developer/work%73pace")).toBe("src/a.ts")
    expect(relativeToRoot("file://other/home/developer/workspace/a.ts", root)).toBeNull()
    expect(relativeToRoot("file://server/root/a.ts", "file://server/root")).toBe("a.ts")
    expect(relativeToRoot(`${root}/src/a.ts`, `${root}/src/..`)).toBeNull()
    expect(relativeToRoot(root, root)).toBeNull()
    expect(relativeToRoot("file:///src/a.ts", "file:///")).toBe("src/a.ts")
  })

  test("a non-file root never produces a repository path", () => {
    expect(relativeToRoot("https://example.com/root/src/a.ts", "https://example.com/root")).toBeNull()
  })

  test("both adapters announce the same client capabilities: markdown hovers, no related information, full-text sync", () => {
    expect(LSP_CLIENT_CAPABILITIES.textDocument.hover.contentFormat).toEqual(["markdown", "plaintext"])
    expect(LSP_CLIENT_CAPABILITIES.textDocument.publishDiagnostics.relatedInformation).toBe(false)
    expect(LSP_CLIENT_CAPABILITIES.textDocument.publishDiagnostics.versionSupport).toBe(true)
    expect(LSP_CLIENT_CAPABILITIES.workspace).toEqual({ configuration: true, workspaceFolders: true })
  })
})

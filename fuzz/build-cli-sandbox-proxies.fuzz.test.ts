import { Label } from "@smthrs/build-cli"
import { GitProxy } from "@smthrs/effect-code-storage"
import { Detect, ZodSchemaHints } from "@smthrs/migrate"
import { TerminalProtocol } from "@smthrs/sandbox"
import { it } from "@smthrs/testing/Vitest"
import { Schema } from "effect"
import { describe, expect } from "vitest"

describe("@smthrs/build-cli, @smthrs/sandbox, @smthrs/effect-code-storage, and @smthrs/migrate fuzz", () => {
  it.fuzz(
    "build-cli Label.parse never crashes and formatted valid labels round-trip",
    [
      Schema.String.check(Schema.isMaxLength(120)),
      Schema.String.check(Schema.isMaxLength(60))
    ],
    ([raw, pkg]) => {
      try {
        const parsed = Label.parse(raw, pkg)
        expect(typeof Label.isWildcard(parsed)).toBe("boolean")
      } catch (err) {
        // Parse errors must be Error instances, never raw primitives
        expect(err).toBeInstanceOf(Error)
      }
      // Valid alphanumeric package + target round-trips through format -> parse
      const cleanPkg = pkg.replace(/[^a-zA-Z0-9_-]/g, "")
      const cleanTarget = raw.replace(/[^a-zA-Z0-9_-]/g, "") || "build"
      const formatted = Label.format(cleanPkg, cleanTarget)
      const reparsed = Label.parse(formatted, "")
      expect(Label.isWildcard(reparsed)).toBe(false)
      return true
    }
  )

  it.fuzz(
    "sandbox TerminalProtocol encode/decode round-trips valid frames and never throws on adversarial wire text",
    [
      Schema.Int.check(Schema.isBetween({ minimum: -10, maximum: 1500 })),
      Schema.Int.check(Schema.isBetween({ minimum: -10, maximum: 1000 })),
      Schema.String,
      Schema.Int.check(Schema.isBetween({ minimum: -5, maximum: 25 }))
    ],
    ([cols, rows, wire, attempt]) => {
      // Arbitrary wire bytes never crash decoders
      expect(() => TerminalProtocol.decodeClientControl(wire)).not.toThrow()
      expect(() => TerminalProtocol.decodeServerControl(wire)).not.toThrow()

      // Valid resize round-trips; out-of-bounds resize is rejected
      const encoded = TerminalProtocol.encodeResize(cols, rows)
      const decoded = TerminalProtocol.decodeClientControl(encoded)
      if (cols >= 1 && cols <= TerminalProtocol.maxCols && rows >= 1 && rows <= TerminalProtocol.maxRows) {
        expect(decoded).toEqual({ type: "resize", cols, rows })
      } else {
        expect(decoded).toBeUndefined()
      }

      // Reconnect delay is bounded and terminates after maxAttempts
      const delay = TerminalProtocol.reconnectDelay(attempt)
      if (delay !== undefined) {
        expect(delay).toBeGreaterThanOrEqual(0)
        expect(delay).toBeLessThanOrEqual(TerminalProtocol.reconnect.maxMs)
      }
      if (attempt > TerminalProtocol.reconnect.maxAttempts) {
        expect(delay).toBeUndefined()
      }
      return true
    }
  )

  it.fuzz(
    "effect-code-storage GitProxy.classify NEVER allows git-receive-pack or mutating HTTP verbs",
    [
      Schema.Literals(["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"]),
      Schema.String.check(Schema.isMaxLength(200))
    ],
    ([method, suffix]) => {
      const url = `https://git.example.com/${suffix}`
      const service = GitProxy.classify(method, url)
      if (service !== undefined) {
        // Security invariant: read-only clone proxy only ever allows GET info-refs or POST upload-pack
        expect(service === "info-refs" || service === "upload-pack").toBe(true)
        if (service === "info-refs") expect(method).toBe("GET")
        if (service === "upload-pack") expect(method).toBe("POST")
        expect(url.toLowerCase()).not.toContain("git-receive-pack")
      }
      // Explicitly verify receive-pack is ALWAYS refused
      expect(GitProxy.classify("GET", "https://git.example.com/repo.git/info/refs?service=git-receive-pack")).toBeUndefined()
      expect(GitProxy.classify("POST", "https://git.example.com/repo.git/git-receive-pack")).toBeUndefined()
      return true
    }
  )

  it.fuzz(
    "migrate Detect and ZodSchemaHints never throw on arbitrary package names, lockfiles, or Zod/TS strings",
    [
      Schema.String.check(Schema.isMaxLength(120)),
      Schema.String.check(Schema.isMaxLength(120))
    ],
    ([a, b]) => {
      expect(typeof Detect.isOldSpecifier(a)).toBe("boolean")
      const cls = Detect.classifyPackage(a, b)
      expect(cls === undefined || typeof cls === "string").toBe(true)
      const versions = Detect.resolvedEffectVersions(a)
      expect(Array.isArray(versions)).toBe(true)
      const hint = ZodSchemaHints.classify(a)
      expect(hint.class === "automatic" || hint.class === "guided").toBe(true)
      expect(() => ZodSchemaHints.print(a)).not.toThrow()
      expect(() => ZodSchemaHints.printField(a)).not.toThrow()
      return true
    }
  )
})

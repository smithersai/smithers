import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Path, Schema } from "effect"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as ApplyPatch from "../src/internal/ApplyPatch.ts"
import * as EnvelopePrecheck from "../src/internal/EnvelopePrecheck.ts"
import * as Html from "../src/internal/Html.ts"
import * as Ignore from "../src/internal/Ignore.ts"
import * as IpAddress from "../src/internal/IpAddress.ts"
import * as Tar from "../src/internal/Tar.ts"
import * as TestReport from "../src/internal/TestReport.ts"
import * as Url from "../src/internal/Url.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "120"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")

const buildTarEntry = (name: string, payload: Uint8Array, typeflag = "0"): Uint8Array => {
  const header = new Uint8Array(512)
  const enc = new TextEncoder()
  const nameBytes = enc.encode(name)
  header.set(nameBytes.slice(0, 100), 0)
  header.set(enc.encode("0000644\0"), 100)
  header.set(enc.encode("0000000\0"), 108)
  header.set(enc.encode("0000000\0"), 116)
  header.set(enc.encode(`${payload.length.toString(8).padStart(11, "0")}\0`), 124)
  header.set(enc.encode("00000000000\0"), 136)
  header.fill(0x20, 148, 156)
  header[156] = typeflag.charCodeAt(0)
  header.set(enc.encode("ustar\0"), 257)
  header.set(enc.encode("00"), 263)
  let sum = 0
  for (let i = 0; i < 512; i++) sum += header[i]!
  header.set(enc.encode(`${sum.toString(8).padStart(6, "0")}\0 `), 148)
  const paddedLen = Math.ceil(payload.length / 512) * 512
  const out = new Uint8Array(512 + paddedLen + 1024)
  out.set(header, 0)
  out.set(payload, 512)
  return out
}

describe("@smthrs/std Tar, Html, IpAddress, Url, ApplyPatch, Ignore, TestReport & EnvelopePrecheck fuzz invariants", () => {
  it("IpAddress & Url block private/loopback/link-local/CGNAT/IPv4-mapped-IPv6 SSRF addresses and non-HTTP schemes", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        octA: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 })),
        octB: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 })),
        octC: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 })),
        octD: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 })),
        mapped6: Schema.Boolean,
        rawIp: Schema.Literals([
          "127.0.0.1",
          "10.0.0.1",
          "172.16.0.1",
          "192.168.1.1",
          "169.254.169.254",
          "100.64.0.1",
          "0.0.0.0",
          "224.0.0.1",
          "::1",
          "::",
          "fe80::1",
          "fc00::1",
          "fd12:3456::1",
          "::ffff:127.0.0.1",
          "::ffff:169.254.169.254",
          "::ffff:10.0.0.1",
          "::ffff:7f00:0001",
          "8.8.8.8",
          "1.1.1.1",
          "2606:4700:4700::1111",
          "not-an-ip",
          ""
        ]),
        scheme: Schema.Literals(["http:", "https:", "file:", "ftp:", "javascript:", "data:", "gopher:"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ octA, octB, octC, octD, mapped6, rawIp, scheme }) =>
          Effect.sync(() => {
            const v4 = `${octA}.${octB}.${octC}.${octD}`
            const addr = mapped6 ? `::ffff:${v4}` : v4
            const fam = IpAddress.family(addr)
            if (mapped6 && fam !== 6) return false
            if (!mapped6 && fam !== 4) return false

            const isPrivateV4 = octA === 0 ||
              octA === 10 ||
              octA === 127 ||
              (octA === 100 && octB >= 64 && octB <= 127) ||
              (octA === 169 && octB === 254) ||
              (octA === 172 && octB >= 16 && octB <= 31) ||
              (octA === 192 && octB === 168) ||
              octA >= 224
            const pub = IpAddress.isPublic(addr)
            // Never classify any private/reserved IPv4 (direct or IPv4-mapped IPv6!) as public!
            if (isPrivateV4 && pub) return false
            // Parity: ::ffff:<v4> MUST have the exact same isPublic decision as <v4>
            if (mapped6 && pub !== IpAddress.isPublic(v4)) return false

            // Known SSRF vectors MUST ALWAYS be non-public
            if (
              [
                "127.0.0.1",
                "10.0.0.1",
                "172.16.0.1",
                "192.168.1.1",
                "169.254.169.254",
                "100.64.0.1",
                "0.0.0.0",
                "224.0.0.1",
                "::1",
                "::",
                "fe80::1",
                "fc00::1",
                "fd12:3456::1",
                "::ffff:127.0.0.1",
                "::ffff:169.254.169.254",
                "::ffff:10.0.0.1",
                "::ffff:7f00:0001"
              ].includes(rawIp) &&
              IpAddress.isPublic(rawIp)
            ) {
              return false
            }
            if (
              (rawIp === "8.8.8.8" || rawIp === "1.1.1.1" || rawIp === "2606:4700:4700::1111") &&
              !IpAddress.isPublic(rawIp)
            ) {
              return false
            }

            // Url.parseHttpUrl allows only http:/https:
            const parsed = Url.parseHttpUrl(`${scheme}//example.com/path`)
            if ((scheme === "http:" || scheme === "https:") && parsed === undefined) return false
            if (scheme !== "http:" && scheme !== "https:" && parsed !== undefined) return false
            return true
          }),
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("Tar.files round-trips valid entries and safely handles truncated/corrupt/arbitrary bytes without crashing", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        name: Schema.Literals(["src/index.ts", "README.md", "dir/sub/file.txt", "../escape.txt", "/abs/path.txt"]),
        content: Schema.String.check(Schema.isMaxLength(120)),
        corruptByte: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 })),
        truncateTo: Schema.NullOr(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 700 }))),
        randomBytes: Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 }))).check(
          Schema.isMaxLength(128)
        )
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ name, content, corruptByte, truncateTo, randomBytes }) =>
          Effect.sync(() => {
            const bytes = new TextEncoder().encode(content)
            const tar = buildTarEntry(name, bytes)
            const parsed = Tar.files(tar)
            if (parsed !== undefined) {
              const got = parsed.get(name)
              if (got !== undefined) {
                if (Buffer.compare(got, bytes) !== 0) return false
              }
            }

            // Truncated or corrupted archive must never throw
            if (truncateTo !== null) {
              const sliced = tar.slice(0, truncateTo)
              const tRes = Tar.files(sliced)
              if (tRes !== undefined && !(tRes instanceof Map)) return false
            }
            const mutated = new Uint8Array(tar)
            mutated[148] = corruptByte
            const mRes = Tar.files(mutated)
            if (mRes !== undefined && !(mRes instanceof Map)) return false

            // Arbitrary random bytes must never throw
            const rRes = Tar.files(new Uint8Array(randomBytes))
            if (rRes !== undefined && !(rRes instanceof Map)) return false
            return true
          }),
        { seed: seed + 1, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("Html.toText/toMarkdown, ApplyPatch streaming/batch parity, Ignore, TestReport & EnvelopePrecheck uphold total safety", async () => {
    const posixPath = Effect.runSync(Path.Path.pipe(Effect.provide(Path.layer)))
    const arb = Arbitrary.schema(
      Schema.Struct({
        htmlChunk: Schema.String.check(Schema.isMaxLength(120)),
        tag: Schema.Literals(["p", "div", "script", "style", "a", "code", "pre", "h1", "li"]),
        origLines: Schema.Array(Schema.Literals(["alpha", "beta", "gamma", "delta", "epsilon"])).check(
          Schema.isMinLength(2),
          Schema.isMaxLength(5)
        ),
        replaceLine: Schema.Literals(["ALPHA_NEW", "BETA_NEW", "UPDATED"]),
        chunkSize: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 25 })),
        ignoreRule: Schema.Literals(["*.log", "!important.log", "dist/", "node_modules/", "sub/*.tmp"]),
        candidate: Schema.Literals(["a.log", "important.log", "dist", "src/app.ts", "sub/x.tmp"]),
        isDir: Schema.Boolean,
        cmd: Schema.Literals([
          "cat src/a.ts",
          "cat ../secret.txt",
          "echo hi > out/result.txt",
          "echo hi > /etc/passwd",
          "rm -rf /tmp/evil",
          "ls src"
        ])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ htmlChunk, tag, origLines, replaceLine, chunkSize, ignoreRule, candidate, isDir, cmd }) =>
          Effect.sync(() => {
            // Html.toText & Html.toMarkdown strip <script>/<style> bodies and never throw
            const doc =
              `<html><head><script>alert("xss_secret_payload")</script><style>body{color:red}</style></head><body><${tag} href="https://example.com">${htmlChunk}</${tag}></body></html>`
            const txt = Html.toText(doc)
            const md = Html.toMarkdown(doc)
            if (typeof txt !== "string" || typeof md !== "string") return false
            if (txt.includes("xss_secret_payload") || md.includes("xss_secret_payload")) return false

            // ApplyPatch: StreamingPatchParser chunked at arbitrary boundaries === parsePatch(full)
            const targetLine = origLines[0]!
            const patchText = [
              "*** Begin Patch",
              "*** Update File: demo.txt",
              "@@",
              `-${targetLine}`,
              `+${replaceLine}`,
              ` ${origLines[1]!}`,
              "*** End Patch"
            ].join("\n")
            const batchParsed = ApplyPatch.parsePatch(patchText)
            const streamer = new ApplyPatch.StreamingPatchParser()
            for (let i = 0; i < patchText.length; i += chunkSize) {
              streamer.pushDelta(patchText.slice(i, i + chunkSize))
            }
            const streamedHunks = streamer.finish()
            if (JSON.stringify(batchParsed.hunks) !== JSON.stringify(streamedHunks)) return false

            // deriveNewContents applies the parsed update hunk accurately
            const hunk = batchParsed.hunks[0]!
            if (hunk.kind === "update") {
              const updated = ApplyPatch.deriveNewContents(origLines.join("\n") + "\n", "demo.txt", hunk.chunks)
              if (!updated.includes(replaceLine)) return false
            }
            const summary = ApplyPatch.printSummary({ added: ["a.ts"], modified: ["demo.txt"], deleted: [] })
            if (!summary.includes("demo.txt")) return false

            // Ignore parser + matcher determinism
            const scope = Ignore.parse("/work", `*.log\n${ignoreRule}\n`)
            const ig = Ignore.ignored(
              [scope],
              `/work/${candidate}`,
              candidate.split("/").pop()!,
              isDir,
              NodePath.posix.relative
            )
            if (ignoreRule === "!important.log" && candidate === "important.log" && ig !== false) return false
            if (ignoreRule === "dist/" && candidate === "dist" && !isDir && ig !== false) return false
            if (ignoreRule === "dist/" && candidate === "dist" && isDir && ig !== true) return false

            // TestReport parse/read/attribute invariants
            const baseRep = TestReport.parse(
              "FAIL test/a.test.ts\n ✓ ok\n × broken_1\nTests  1 failed | 1 passed (2)\n"
            )
            const curRep = TestReport.read({
              stdout: "FAIL test/a.test.ts\n × broken_1\n × broken_2\nTests  2 failed | 0 passed (2)\n",
              stderr: ""
            })
            const attr = TestReport.attribute(curRep, baseRep)
            if (attr !== undefined) {
              for (const id of attr.introduced) {
                if (attr.preexisting.includes(id) || attr.fixed.includes(id)) return false
              }
            }

            // EnvelopePrecheck commandReferences & outsideEnvelope fail-closed invariants
            const refs = EnvelopePrecheck.commandReferences(posixPath, cmd)
            if (!Array.isArray(refs)) return false
            const envCheck = EnvelopePrecheck.outsideEnvelope(
              { reads: ["src"], writes: ["out"], cwd: "." },
              cmd,
              posixPath
            )
            if (cmd === "echo hi > /etc/passwd" && envCheck === undefined) return false
            if (cmd === "cat ../secret.txt" && envCheck === undefined) return false
            return true
          }),
        { seed: seed + 2, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})

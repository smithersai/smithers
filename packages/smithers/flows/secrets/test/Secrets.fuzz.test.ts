import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Redacted, Schema, Stream } from "effect"
import { describe, expect, it } from "vitest"
import { Egress, Placeholder, Scrub } from "../src/index.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "1500" : "250"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261122")

describe("@smthrs/secrets fuzz security invariants", () => {
  it("Scrub NEVER leaks raw, URL-encoded, or JSON-escaped secrets across text or arbitrary stream chunk boundaries", async () => {
    const SecretStr = Schema.String.check(Schema.isMinLength(8), Schema.isMaxLength(48))
    const arb = Arbitrary.schema(
      Schema.Struct({
        secret: SecretStr,
        prefix: Schema.String,
        mid: Schema.String,
        suffix: Schema.String,
        chunkSize: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 19 }))
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ secret, prefix, mid, suffix, chunkSize }) =>
          Effect.gen(function*() {
            // Skip degenerate whitespace-only secrets that could collide trivially with replacement text.
            if (secret.trim().length < 8) return true
            const replacement = "[REDACTED]"
            const scrubber = Scrub.make([{ value: Redacted.make(secret), replacement }])
            const encoded = encodeURIComponent(secret)
            const jsonEscaped = JSON.stringify(secret).slice(1, -1)
            const combined = `${prefix}${secret}${mid}${encoded}${mid}${jsonEscaped}${suffix}`

            const scrubbedText = scrubber.text(combined)
            if (scrubbedText.includes(secret)) return false
            if (encoded.length >= 8 && scrubbedText.includes(encoded)) return false
            if (jsonEscaped.length >= 8 && scrubbedText.includes(jsonEscaped)) return false

            // Streaming scrub across arbitrary byte chunk splits MUST match text scrub security invariant.
            const bytes = new TextEncoder().encode(combined)
            const chunks: Array<Uint8Array> = []
            for (let i = 0; i < bytes.length; i += chunkSize) {
              chunks.push(bytes.subarray(i, i + chunkSize))
            }
            const outChunks = yield* Stream.runCollect(scrubber.stream(Stream.fromIterable(chunks)))
            const total = outChunks.reduce((n, c) => n + c.length, 0)
            const merged = new Uint8Array(total)
            let offset = 0
            for (const c of outChunks) {
              merged.set(c, offset)
              offset += c.length
            }
            const streamedText = new TextDecoder().decode(merged)
            return !streamedText.includes(secret)
          }),
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("Placeholder minter rejects short keys and emits opaque, deterministic, secret-free tokens", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        key: Schema.String,
        name: Schema.String.check(Schema.isNonEmpty())
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ key, name }) =>
          Effect.gen(function*() {
            const minted = yield* Effect.result(Placeholder.minter(Redacted.make(key)))
            if (key.length < Placeholder.minimumKeyLength) {
              return minted._tag === "Failure" && minted.failure._tag === "@smthrs/secrets/Placeholder/KeyTooShort"
            }
            if (minted._tag !== "Success") return false
            const p1 = yield* minted.success.derive("default", name)
            const p2 = yield* minted.success.derive("default", name)
            return (
              p1 === p2 &&
              Placeholder.is(p1) &&
              Placeholder.find(`auth: ${p1}`).includes(p1) &&
              !p1.includes(key)
            )
          }),
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("Egress.decide fails closed on insecure scheme, userinfo, port, unbound host, disallowed method, or unknown placeholder", async () => {
    const placeholder = `${Placeholder.prefix}${"a".repeat(64)}`
    const unknownPlaceholder = `${Placeholder.prefix}${"b".repeat(64)}`
    const policy: Egress.Policy = {
      allow: ["public.example.com"],
      secrets: [
        {
          name: "API_KEY",
          placeholder,
          hosts: ["api.example.com"],
          methods: ["POST"]
        }
      ]
    }
    const arb = Arbitrary.schema(
      Schema.Struct({
        scheme: Schema.Literals(["https:", "http:", "ftp:", "file:"]),
        host: Schema.Literals(["api.example.com", "public.example.com", "evil.example.com"]),
        port: Schema.Literals(["", ":443", ":8080"]),
        userinfo: Schema.Literals(["", "user:pass@"]),
        method: Schema.Literals(["GET", "POST", "DELETE"]),
        headerVal: Schema.Literals(["plain", `Bearer ${placeholder}`, `Bearer ${unknownPlaceholder}`])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ scheme, host, port, userinfo, method, headerVal }) => {
          const url = `${scheme}//${userinfo}${host}${port}/v1/test`
          const decision = Egress.decide({ method, url, headers: { authorization: headerVal } }, policy)
          const hasKnown = headerVal.includes(placeholder)
          const hasUnknown = headerVal.includes(unknownPlaceholder)

          if (decision._tag === "Allowed") {
            // Security invariant: NEVER allowed with userinfo, port, non-http(s), evil host, or unknown placeholder.
            const nonDefaultPort = port !== "" && !(scheme === "https:" && port === ":443")
            if (userinfo !== "" || nonDefaultPort) return false
            if (scheme !== "https:" && scheme !== "http:") return false
            if (host === "evil.example.com") return false
            if (hasUnknown) return false
            // Security invariant: secret MUST ONLY travel over https to bound host with allowed method.
            if (hasKnown && (scheme !== "https:" || host !== "api.example.com" || method !== "POST")) return false
            return true
          }
          return true
        },
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})

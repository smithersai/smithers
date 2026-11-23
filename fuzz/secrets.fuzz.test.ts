import { Binding, Egress, Placeholder, Scrub } from "@smthrs/secrets"
import { it } from "@smthrs/testing/Vitest"
import { Effect, Redacted, Schema, Stream } from "effect"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import { describe, expect } from "vitest"

const PrintableSecret = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9!#$%&*+\-.:;=?@^_~]{10,40}$/)
)

const ChunkSizes = Schema.Array(
  Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 19 }))
).check(Schema.isMinLength(1), Schema.isMaxLength(24))

const splitBySizes = (bytes: Uint8Array, sizes: ReadonlyArray<number>): ReadonlyArray<Uint8Array> => {
  const chunks: Array<Uint8Array> = []
  let offset = 0
  let idx = 0
  while (offset < bytes.length) {
    const size = sizes[idx % sizes.length]!
    chunks.push(bytes.subarray(offset, Math.min(bytes.length, offset + size)))
    offset += size
    idx++
  }
  return chunks.length === 0 ? [new Uint8Array()] : chunks
}

describe("@smthrs/secrets fuzz", () => {
  it.fuzz(
    "Binding.isHost rejects IPs, single-label hosts, uppercase, ports, paths, and oversized names",
    [Schema.String],
    ([candidate]) => {
      const ok = Binding.isHost(candidate)
      if (ok) {
        expect(candidate.length).toBeLessThanOrEqual(253)
        expect(candidate).toBe(candidate.toLowerCase())
        expect(candidate).not.toMatch(/[:/\s?#@\\]/)
        const labels = candidate.split(".")
        expect(labels.length).toBeGreaterThanOrEqual(2)
        expect(/^[0-9]+$/.test(labels.at(-1)!)).toBe(false)
        for (const label of labels) {
          expect(label.length).toBeGreaterThanOrEqual(1)
          expect(label.length).toBeLessThanOrEqual(63)
          expect(label.startsWith("-")).toBe(false)
          expect(label.endsWith("-")).toBe(false)
        }
      }
      return true
    }
  )

  it.fuzz(
    "Binding.valueProblem rejects control chars, surrounding spaces, non-ASCII, and length violations",
    [Schema.String],
    ([value]) => {
      const problem = Binding.valueProblem(value)
      const bytes = new TextEncoder().encode(value)
      if (problem === undefined) {
        expect(bytes.length).toBeGreaterThanOrEqual(Binding.minimumValueBytes)
        expect(bytes.length).toBeLessThanOrEqual(Binding.maximumValueBytes)
        expect(value.startsWith(" ")).toBe(false)
        expect(value.endsWith(" ")).toBe(false)
        for (let i = 0; i < value.length; i++) {
          const code = value.charCodeAt(i)
          expect(code).toBeGreaterThanOrEqual(0x20)
          expect(code).toBeLessThan(0x7f)
        }
      }
      return true
    }
  )

  it.effect.fuzz(
    "Placeholder.minter is deterministic, isolated across scopes and names, and round-trips find()",
    [Schema.String, Schema.String, Schema.String, Schema.String],
    ([scopeA, nameA, scopeB, nameB]) =>
      Effect.gen(function*() {
        const key = Redacted.make("0123456789abcdef0123456789abcdef")
        const minter = yield* Placeholder.minter(key)
        const p1 = yield* minter.derive(scopeA, nameA)
        const p2 = yield* minter.derive(scopeA, nameA)
        const pOther = yield* minter.derive(scopeB, nameB)
        expect(p1).toBe(p2)
        expect(Placeholder.is(p1)).toBe(true)
        expect(Placeholder.find(`prefix ${p1} middle ${pOther} suffix`)).toEqual([p1, pOther])
        if (scopeA !== scopeB || nameA !== nameB) {
          expect(p1).not.toBe(pOther)
        }
        return true
      })
  )

  it.effect.fuzz(
    "Scrub.stream scrubs every encoded echo across arbitrary chunk boundaries without leaking",
    [PrintableSecret, Schema.String, Schema.String, ChunkSizes],
    ([secret, prefix, suffix, chunkSizes]) =>
      Effect.gen(function*() {
        const replacement = "smthrs-secret-" + "a".repeat(64)
        const scrubber = Scrub.make([{ value: Redacted.make(secret), replacement }])
        expect(scrubber.active).toBe(true)
        const forms = Scrub.forms(secret)
        expect(forms.length).toBeGreaterThan(0)

        // Construct a payload embedding raw, percent-encoded, JSON-escaped, and base64-aligned echoes
        const encodedPayload = [
          prefix,
          ...forms,
          `Basic ${Buffer.from(`user:${secret}`).toString("base64")}`,
          `x=${encodeURIComponent(secret).toLowerCase()}`,
          suffix
        ].join(" | ")

        const bytes = new TextEncoder().encode(encodedPayload)
        const chunks = splitBySizes(bytes, chunkSizes)
        const scrubbedChunks = yield* Stream.runCollect(scrubber.stream(Stream.fromIterable(chunks)))
        const totalLen = scrubbedChunks.reduce((acc, c) => acc + c.length, 0)
        const joined = new Uint8Array(totalLen)
        let off = 0
        for (const c of scrubbedChunks) {
          joined.set(c, off)
          off += c.length
        }
        const streamedText = new TextDecoder().decode(joined)

        // Raw secret and every echo form >= 8 chars must NEVER appear in the scrubbed stream
        expect(streamedText).not.toContain(secret)
        for (const form of forms) {
          if (form.length >= 8) {
            expect(streamedText).not.toContain(form)
          }
        }
        return true
      })
  )

  it.effect.fuzz(
    "Egress.execute refuses unauthorized hosts, plain HTTP, bad methods, and scrubs echoed secrets",
    [
      PrintableSecret,
      Schema.Literals(["https", "http"]),
      Schema.Literals(["api.example.com", "evil.example.com", "api.example.com.evil.com"]),
      Schema.Literals(["GET", "POST", "DELETE"]),
      Schema.Boolean,
      Schema.Int.check(Schema.isBetween({ minimum: 200, maximum: 308 }))
    ],
    ([secretValue, scheme, host, method, includePlaceholder, status]) =>
      Effect.gen(function*() {
        const minter = yield* Placeholder.minter(Redacted.make("0123456789abcdef0123456789abcdef"))
        const placeholder = yield* minter.derive("fuzz-scope", "API_TOKEN")
        const policy: Egress.Policy = {
          secrets: [{
            name: "API_TOKEN",
            placeholder,
            hosts: ["api.example.com"],
            methods: ["GET", "POST"]
          }],
          allow: ["api.example.com"]
        }

        const audits: Array<Egress.Entry> = []
        let sentHeaders: Record<string, string> = {}

        const fakeClient = HttpClient.make((req) =>
          Effect.sync(() => {
            sentHeaders = { ...req.headers }
            const responseBody = `echoed=${secretValue} b64=${Buffer.from(secretValue).toString("base64")}`
            return HttpClientResponse.fromWeb(
              req,
              new Response(method === "HEAD" ? null : responseBody, {
                status: status === 204 || status === 205 || status === 304 ? 200 : status,
                headers: { "x-echo": secretValue, "location": "https://evil.example.com/steal" }
              })
            )
          })
        )

        const req = HttpClientRequest.make(method)(`${scheme}://${host}/v1/data`).pipe(
          HttpClientRequest.setHeader("authorization", includePlaceholder ? `Bearer ${placeholder}` : "Bearer public")
        )

        const exit = yield* Effect.exit(
          Egress.execute(req, policy).pipe(
            Effect.provideService(HttpClient.HttpClient, fakeClient),
            Effect.provideService(Egress.Vault, {
              reveal: (name) =>
                name === "API_TOKEN"
                  ? Effect.succeed(Redacted.make(secretValue))
                  : Effect.fail(new Egress.SecretUnavailable({ name }))
            }),
            Effect.provideService(Egress.Audit, {
              record: (entry) => Effect.sync(() => { audits.push(entry) })
            })
          )
        )

        // Audit entries must NEVER leak the secret value
        for (const entry of audits) {
          expect(JSON.stringify(entry)).not.toContain(secretValue)
        }

        const shouldAllow = host === "api.example.com" &&
          (!includePlaceholder || (scheme === "https" && (method === "GET" || method === "POST")))

        if (!shouldAllow) {
          expect(exit._tag).toBe("Failure")
          // Unauthorized host/scheme/method must NEVER receive the secret
          expect(JSON.stringify(sentHeaders)).not.toContain(secretValue)
        } else {
          expect(exit._tag).toBe("Success")
          if (exit._tag === "Success") {
            const answer = exit.value
            const chunks = yield* Stream.runCollect(answer.body)
            const bodyText = new TextDecoder().decode(Buffer.concat(chunks))
            expect(bodyText).not.toContain(secretValue)
            expect(JSON.stringify(answer.headers)).not.toContain(secretValue)
          }
        }
        return true
      })
  )
})

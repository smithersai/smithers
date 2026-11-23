import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Domains from "./features/domains/contract.ts"
import * as Repo from "./features/repo/contract.ts"
import * as Runners from "./features/runners/contract.ts"
import * as Secrets from "./features/secrets/contract.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "1000" : "300"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261122")

describe("apps/mvp feature contract fuzz invariants", () => {
  it("Repo.isRepository & Repo.isFilePath reject reserved owners, path traversal, leading slashes, and oversize paths", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        owner: Schema.Union([
          Schema.String.pipe(Schema.check(Schema.isMaxLength(48))),
          Schema.Literals(["app", "api", "assets", "APP", "acme-org", "-bad", "good123"])
        ]),
        name: Schema.Union([
          Schema.String.pipe(Schema.check(Schema.isMaxLength(48))),
          Schema.Literals([".", "..", "widgets", "my.repo_1", "bad/name"])
        ]),
        filePath: Schema.Union([
          Schema.String.pipe(Schema.check(Schema.isMaxLength(160))),
          Schema.Literals([
            "src/index.ts",
            "../secret.env",
            "a/../../b",
            "/etc/passwd",
            "a//b",
            "a/./b",
            "dir/",
            "a\0b",
            "a/".repeat(70) + "file.ts"
          ])
        ])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ owner, name, filePath }) =>
          Effect.sync(() => {
            if (Repo.isRepository(owner, name)) {
              if (Repo.RESERVED_OWNERS.includes(owner.toLowerCase())) return false
              if (name === "." || name === "..") return false
              if (!Repo.OWNER_PATTERN.test(owner) || !Repo.NAME_PATTERN.test(name)) return false
              const id = Repo.repoId(owner, name)
              if (id !== id.toLowerCase() || !id.startsWith("github/")) return false
            }
            if (Repo.isFilePath(filePath)) {
              if (filePath.length === 0 || filePath.length > Repo.MAX_PATH_LENGTH) return false
              if (filePath.startsWith("/") || filePath.endsWith("/") || filePath.includes("\0")) return false
              const segs = filePath.split("/")
              if (segs.length > Repo.MAX_PATH_SEGMENTS) return false
              for (const s of segs) {
                if (s === "" || s === "." || s === "..") return false
              }
            }
            return true
          }),
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("Domains.normalizeHostname is idempotent & lowercase, and Domains.isUnder never suffers suffix confusion", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        raw: Schema.Union([
          Schema.String.pipe(Schema.check(Schema.isMaxLength(128))),
          Schema.Literals([
            "Example.COM.",
            "sub.smithers.sh",
            "evil-smithers.sh",
            "http://example.com",
            "a..b.com",
            "-bad.com",
            "127.0.0.1"
          ])
        ]),
        zone: Schema.Literals(["smithers.sh", "example.com"])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ raw, zone }) =>
          Effect.sync(() => {
            const norm = Domains.normalizeHostname(raw)
            if (norm !== undefined) {
              if (norm !== norm.toLowerCase()) return false
              if (norm.length > Domains.MAX_HOSTNAME_LENGTH) return false
              // Idempotency
              if (Domains.normalizeHostname(norm) !== norm) return false
              // Suffix boundary: "evil-smithers.sh" is NEVER under "smithers.sh"
              if (Domains.isUnder(norm, zone)) {
                if (norm !== zone && !norm.endsWith(`.${zone}`)) return false
              }
            }
            if (Domains.isUnder(`evil-${zone}`, zone)) return false
            return true
          }),
        { seed: seed + 1, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("Secrets.secretRoute/parseSecretRoute round-trips and Runners.base64Bytes matches exact decoded byte length", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        owner: Schema.Literals(["acme", "smithersai", "user-1"]),
        repo: Schema.Literals(["app", "my_repo", "v1.0"]),
        secretName: Schema.Literals(["OPENAI_API_KEY", "STRIPE_KEY", "TOKEN_1"]),
        payload: Schema.String.pipe(Schema.check(Schema.isMaxLength(96)))
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ owner, repo, secretName, payload }) =>
          Effect.sync(() => {
            const route = Secrets.secretRoute(owner, repo, secretName)
            const parsed = Secrets.parseSecretRoute(route)
            if (parsed === undefined) return false
            if (parsed.owner !== owner || parsed.name !== repo || parsed.secret !== secretName) return false

            const bytes = Buffer.from(payload, "utf8")
            const b64 = bytes.toString("base64")
            if (Runners.base64Bytes(b64) !== bytes.byteLength) return false
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

import assert from "node:assert/strict"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { NodeFileSystem } from "@effect/platform-node"
import { Effect, Redacted } from "effect"
import { load } from "../coding/landing-config.ts"
import { CodingError } from "../coding/schema.ts"

const binding = { version: 1, repositorySlug: "owner/repo", apiBaseUrl: "https://api.example.test/api", repositoryId: 42,
  workspaceId: "11111111-1111-4111-a111-111111111111" }
test("landing config consumes the reserved credential before any tool inherits it", async () => {
  const root = await mkdtemp(join(tmpdir(), "coding-landing-config-"))
  const file = join(root, "workspace-coding.json")
  await writeFile(file, JSON.stringify({ ...binding, repositoryPath: root }))
  const run = (environment: Record<string, string | undefined>, filename = file) =>
    Effect.runPromiseExit(load(root, environment, filename).pipe(Effect.provide(NodeFileSystem.layer)))
  const environment = { SMITHERS_JJHUB_TOKEN: "reserved-secret", SMITHERS_JJHUB_API_URL: binding.apiBaseUrl, PATH: "/bin" }
  const exit = await run(environment)
  assert.equal(exit._tag, "Success")
  if (exit._tag !== "Success") throw new Error("loaded")
  assert.equal(Redacted.value(exit.value!.token), "reserved-secret")
  assert.deepEqual({ ...exit.value, token: undefined }, { apiBaseUrl: binding.apiBaseUrl, repositorySlug: "owner/repo", repositoryId: 42, workspaceId: binding.workspaceId, token: undefined })
  assert.deepEqual(environment, { SMITHERS_JJHUB_API_URL: binding.apiBaseUrl, PATH: "/bin" }, "the token leaves the executable environment")
  assert.ok(!String(exit.value!.token).includes("reserved-secret"), "redacted values never print")
  const none = await run({ PATH: "/bin" })
  assert.equal(none._tag, "Success", "no credential means local-only; vibe stays unregistered")
  if (none._tag === "Success") assert.equal(none.value, undefined)
  for (const [name, environment, filename] of [
    ["token without api", { SMITHERS_JJHUB_TOKEN: "x" }, file],
    ["api without token", { SMITHERS_JJHUB_API_URL: binding.apiBaseUrl }, file],
    ["api mismatch", { SMITHERS_JJHUB_TOKEN: "x", SMITHERS_JJHUB_API_URL: "https://other.example.test/api" }, file],
    ["missing binding", { SMITHERS_JJHUB_TOKEN: "x", SMITHERS_JJHUB_API_URL: binding.apiBaseUrl }, join(root, "absent.json")]
  ] as const) {
    const refused = await run({ ...environment }, filename)
    assert.equal(refused._tag, "Failure", name)
    if (refused._tag === "Failure") assert(refused.cause.toString().includes("provisioned workspace binding"), name)
  }
  const foreign = join(root, "foreign.json")
  await writeFile(foreign, JSON.stringify({ ...binding, repositoryPath: join(root, "elsewhere") }))
  const mismatch = await run({ SMITHERS_JJHUB_TOKEN: "x", SMITHERS_JJHUB_API_URL: binding.apiBaseUrl }, foreign)
  assert.equal(mismatch._tag, "Failure", "binding must name this exact repository")
  const oversized = join(root, "oversized.json")
  await writeFile(oversized, JSON.stringify({ ...binding, repositoryPath: root, pad: "x".repeat(20_000) }))
  const large = await run({ SMITHERS_JJHUB_TOKEN: "x", SMITHERS_JJHUB_API_URL: binding.apiBaseUrl }, oversized)
  assert.equal(large._tag, "Failure")
  if (large._tag === "Failure") assert.ok(large.cause.toString().includes("provisioned"))
  assert.ok(new CodingError({ code: "unavailable", message: "x" }) instanceof CodingError)
})

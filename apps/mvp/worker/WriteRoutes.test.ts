import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { afterAll, beforeAll, expect, test } from "vitest"
import { testFile } from "./test/harness.ts"
import { cookie, signInHarness } from "./test/signIn.ts"
import * as Personal from "./personal/test/harness.ts"
import * as Secrets from "./secrets/test/harness.ts"
import { githubHarness } from "./github/test/harness.ts"

const runtime = testFile("write_routes")
const sql = (query: string) => runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (client) => client.unsafe(query)))
let personal: Awaited<ReturnType<typeof Personal.engine>>
let secrets: Awaited<ReturnType<typeof Secrets.engine>>
beforeAll(async () => { personal = await Personal.engine(runtime); secrets = await Secrets.engine(runtime) })
afterAll(async () => { await personal.close(); await secrets.close() })

test.each(["secrets", "connections", "triage/enable", "triage/pause"] as const)("%s refuses a session revoked during its body", async (kind) => {
  const auth = await signInHarness(runtime)
  auth.github.permission = "admin"
  const signed = await auth.signInAs()
  const [person] = await sql("SELECT person_id::text AS id FROM sessions ORDER BY created_at DESC LIMIT 1") as Array<{ id: string }>
  const headers = { cookie: cookie(signed.cookies), "x-smithers-device-person": person!.id, "content-type": "application/json" }
  const h = kind === "secrets" ? await Secrets.secretsHarness(runtime, secrets.starter, { sessions: auth.sessions })
    : kind === "connections" ? await Personal.personalHarness(runtime, personal.starter, { sessions: auth.sessions })
    : await githubHarness(runtime, { sessions: auth.sessions })
  const path = kind === "secrets" ? "/api/repos/acme/widgets/secrets/KEY"
    : kind === "connections" ? "/api/me/model" : "/api/repos/acme/widgets/writes"
  const text = JSON.stringify(kind === "secrets" ? { value: "test-only-value", hosts: ["example.test"] }
    : kind === "connections" ? Personal.SAVE : { writeId: crypto.randomUUID(), op: kind })
  let reading!: () => void
  const read = new Promise<void>((resolve) => { reading = resolve })
  let finish!: () => void
  const finished = new Promise<void>((resolve) => { finish = resolve })
  let head = true
  const body = new ReadableStream<Uint8Array>({ async pull(controller) {
    if (head) { head = false; controller.enqueue(new TextEncoder().encode(text.slice(0, 5))); return }
    reading()
    await finished
    controller.enqueue(new TextEncoder().encode(text.slice(5)))
    controller.close()
  } }, { highWaterMark: 0 })
  const posting = h.fetch(path, { method: kind.startsWith("triage/") ? "POST" : "PUT", headers, body, duplex: "half" } as RequestInit)
  await read
  try { await sql("UPDATE sessions SET revoked_at = now(), revoked_reason = 'sign_out'") } finally { finish() }
  expect((await posting).status).toBe(401)
  for (const table of ["personal_models", "secrets", "github_writes"]) {
    expect(await sql(`SELECT count(*)::int AS n FROM ${table}`)).toEqual([{ n: 0 }])
  }
})

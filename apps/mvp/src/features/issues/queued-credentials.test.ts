import { Persistence } from "@smthrs/effect-tanstack-db"
import { Effect, Layer, ManagedRuntime, Option, Redacted, Result, Stream } from "effect"
import { FetchHttpClient } from "effect/http"
import { expect, test } from "vitest"
import * as RunCredentials from "../../../worker/RunCredentials"
import * as SessionKeys from "../../../worker/SessionKeys"
import { harness, RUN_CREDENTIAL_SECRET, signedIn, testFile } from "../../../worker/test/harness"
import { githubHarness } from "../../../worker/github/test/harness"
import { confirmedSession, sql } from "../../../worker/github/test/fixtures"
import { outboxUpgrade } from "../../device/registry"
import { OutboxWrites } from "../../outbox"
import { IssuesClient } from "./api"
import { ISSUE_WRITE, IssueWrites } from "./writes"

const server = testFile("queued_run_authority")
const alice = { subject: { kind: "person" as const, id: crypto.randomUUID() }, role: "member" as const, session: crypto.randomUUID() }

test("an expired version-2 queued agent write migrates, renews, delivers as the original agent and replays once", async () => {
  // Alice's session as sign-in confirms it: her role on the deployment's repository is that receipt.
  await confirmedSession(server, alice)
  const chat = await harness(server, () => Stream.empty, { actor: alice })
  const github = await githubHarness(server, { sessions: signedIn(alice) })
  const keys = await Effect.runPromise(SessionKeys.make(Redacted.make(RUN_CREDENTIAL_SECRET)))
  const authority = RunCredentials.make({ keys, person: () => Effect.succeedSome(alice) })
  const parent = Result.getOrThrow(RunCredentials.claimsFor(alice, "queued-answer", { flow: "chat/Answer", ceiling: [["net:post:github/**"]] }, Date.now()))
  const claims = Result.getOrThrow(RunCredentials.claimsFor({ ...alice, act: { kind: parent.act, id: parent.run, root: parent.root, chain: parent.chain, ceiling: parent.ceiling } }, "queued-answer/call/1", { flow: "issue/create" }, Date.now()))
  const token = await Effect.runPromise(authority.sign({ ...claims, exp: Date.now() - 1 }))
  expect(await Effect.runPromise(authority.verify(token))).toEqual(Option.none())
  const id = crypto.randomUUID()
  const old = { id, repo: "acme/widgets", repoId: "github/acme/widgets", op: "issue/create", title: "Queued offline", body: "", number: 0, queuedAt: Date.now() - 16 * 60_000, credential: token, v: 2 }
  const upgraded = outboxUpgrade.write(JSON.stringify({ mutationFnName: ISSUE_WRITE, mutations: [{ collectionId: "issue-sending", modified: old, original: {}, changes: old }], metadata: { versions: { "issue-sending": 2 } } }))
  expect(upgraded._tag).toBe("Upgraded")
  if (upgraded._tag !== "Upgraded") throw new Error("expected a migrated outbox write")
  const row = JSON.parse(upgraded.value).mutations[0].modified
  expect(row).toEqual({ ...old, v: 3 })
  const observed: Array<{ path: string; authorization: string | null; credentials: RequestCredentials }> = []
  const fetchRoute: typeof fetch = async (input, init) => {
    const request = new Request(input, init)
    const path = new URL(request.url).pathname
    observed.push({ path, authorization: request.headers.get("authorization"), credentials: request.credentials })
    return path.endsWith("/credential") ? chat.fetch(path, { method: request.method, headers: request.headers, body: await request.text() }) : github.fetch(request)
  }
  const client = IssuesClient.layer({ origin: "http://queued.test", within: "5 seconds" }).pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchRoute)))
  const runtime = ManagedRuntime.make(IssueWrites.layer.pipe(Layer.provide(client), Layer.provide(Persistence.memory)))
  try {
    await runtime.runPromise(Effect.gen(function* () {
      const writes = yield* OutboxWrites
      for (let repeat = 0; repeat < 2; repeat++) yield* writes.mutations[ISSUE_WRITE]!({ rows: [row] } as never)
      expect(Option.getOrThrow(yield* (yield* IssueWrites).requested.get(id))).toMatchObject({ status: "requested", reason: null })
    }))
    expect(await sql(server, `SELECT actor_id, via, session_id FROM github_writes WHERE id = '${id}'`)).toEqual([{ actor_id: alice.subject.id, via: "agent", session_id: null }])
    expect(observed.filter((request) => request.path.endsWith("/credential"))).toHaveLength(2)
    const sent = observed.filter((request) => request.path.endsWith("/writes"))
    expect(sent).toHaveLength(2)
    for (const request of sent) {
      expect(request.credentials).toBe("omit")
      const renewed = Option.getOrThrow(await Effect.runPromise(authority.verify(request.authorization!.slice("Bearer ".length))))
      expect(renewed.act).toEqual({ kind: "agent", id: claims.run, root: claims.root, chain: claims.chain, ceiling: claims.ceiling })
    }
  } finally { await runtime.dispose() }
})

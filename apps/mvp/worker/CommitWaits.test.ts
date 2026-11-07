import { Effect, Layer, Option } from "effect"
import { SqlClient } from "effect/sql"
import { expect, test } from "vitest"
import { testFile } from "./test/harness.ts"
import { stackHarness, runs } from "./stack/test/stack.ts"
import * as Stack from "./stack/Stack.ts"
import { repositoryOf } from "./github/Config.vibe"
import { githubHarness, member } from "./github/test/harness.ts"
import { REPOSITORY } from "./github/test/fixtures.ts"

const runtime = testFile("commit_waits")
const actor = { subject: { kind: "person" as const, id: "bounded-person" }, role: "admin" as const }
const configuration = () => ({ opId: crypto.randomUUID(), op: "configure", lanes: 1, maxOpen: 7, base: "independent" })
const observedResponse = async (request: Promise<Response>) => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([request.catch(() => ({ status: 499 })), new Promise<{ status: number }>((resolve) => {
    timer = setTimeout(() => resolve({ status: 499 }), 12_000)
  })]) } finally { clearTimeout(timer) }
}
const request = (body: object) => ({ method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify(body), signal: AbortSignal.timeout(12_000) })

// Faulty Effect services, rather than query mocks: the guard cancels only an unbounded baseline request.
test.each(["role", "refresh", "apply", "candidate", "stopped"] as const)("stack bounds the %s wait before commit", async (stage) => {
  let entered = false
  const stall = Effect.sync(() => { entered = true }).pipe(Effect.andThen(Effect.never))
  const host = runs()
  const h = await stackHarness(runtime, { actor,
    ...(stage === "apply" || stage === "candidate" ? { faultyDatabase: Layer.effect(SqlClient.SqlClient, stall) } : {}),
    faultyRoles: { repository: repositoryOf("octo/hello"),
      resolve: () => stage === "role" ? stall : Effect.succeed({ role: "admin", held: stage === "refresh"
        ? Option.some({ repoId: "github/octo/hello", personId: actor.subject.id, role: "admin" as const }) : Option.none() }),
      refresh: () => stall,
    },
    ...(stage === "candidate" || stage === "stopped" ? { runs: { ...host, layer: Layer.succeed(Stack.TodoRuns, {
      start: () => Effect.void, stop: () => Effect.void, isStopped: () => stall,
    }) } } : {}),
  })
  if (stage === "stopped") {
    expect((await h.fetch("/api/repos/octo/hello/stack", request({ opId: crypto.randomUUID(), op: "commit", title: "Bound", prompt: "Bound" }))).status).toBe(202)
  }
  const payload = stage === "candidate" || stage === "stopped" ? { opId: crypto.randomUUID(), op: "retry", number: 1 } : configuration()
  const started = performance.now()
  const response = await observedResponse(h.fetch("/api/repos/octo/hello/stack", request(payload)))
  expect(entered).toBe(true)
  expect(response.status).toBe(503)
  expect(performance.now() - started).toBeLessThan(11_500)
  expect(h.line("write.wait")).toHaveLength(1)
}, 16_000)

test.each(["role", "runner", "write"] as const)("work links bound the %s wait before commit", async (stage) => {
  let entered = false
  const stall = Effect.sync(() => { entered = true }).pipe(Effect.andThen(Effect.never))
  const h = await githubHarness(runtime, {
    actor: stage === "runner" ? null : member(undefined, null),
    ...(stage === "role" ? {} : { database: Layer.effect(SqlClient.SqlClient, stall) }),
    roles: { repository: repositoryOf(`${REPOSITORY.owner}/${REPOSITORY.name}`),
      resolve: () => stage === "role" ? stall : Effect.succeed({ role: "member", held: Option.none() }) },
  })
  const started = performance.now()
  const response = await observedResponse(h.fetch(`/api/repos/${REPOSITORY.owner}/${REPOSITORY.name}/issues/1/links`, {
    ...request({ links: [{ kind: "queue", ref: "bounded" }] }),
    ...(stage === "runner" ? { headers: { authorization: "Bearer bounded-runner-token" } } : {}),
  }))
  expect(entered).toBe(true)
  expect(response.status).toBe(503)
  expect(performance.now() - started).toBeLessThan(11_500)
  expect(h.line("write.wait")).toHaveLength(1)
}, 16_000)

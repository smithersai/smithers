// A job's git credential, as the runner asks the host for it (src/runner/Credential.ts, decision 0148): reused while it
// lasts, asked for once at a time per claim, and only a `404` means "fetch without one".
import type * as AgentRunner from "@smthrs/agent/AgentRunner"
import { Effect, Exit, Option } from "effect"
import { expect, test } from "vitest"
import * as Credential from "../src/runner/Credential.ts"
import * as Host from "../src/runner/Host.ts"

type Answer = typeof AgentRunner.GitCredentialResponse.Type | Host.HostError

/** A host whose git-credential route answers `answers` in turn, counting the asks; every other route dies. */
const hostOf = (answers: Array<Answer>, delayMs = 0) => {
  const asks = { count: 0 }
  const host = Host.Host.of({
    claim: () => Effect.die("unused"),
    heartbeat: () => Effect.die("unused"),
    settle: () => Effect.die("unused"),
    events: () => Effect.die("unused"),
    gitCredential: () =>
      Effect.gen(function*() {
        asks.count++
        if (delayMs > 0) yield* Effect.sleep(delayMs)
        const answer = answers.length > 1 ? answers.shift()! : answers[0]!
        return answer instanceof Host.HostError ? yield* answer : answer
      })
  })
  return { host, asks }
}

const issued = (expiresAt: number) => ({
  remote: "https://github.com/acme/app.git",
  username: "x-access-token",
  password: "ghs_test",
  expiresAt
})
const job = () => ({ key: `todo:${crypto.randomUUID()}#g1`, claim: crypto.randomUUID() })

test("one credential is reused for a claim until it nears its end; concurrent asks reach the host once", async () => {
  let now = 1_000_000
  const { host, asks } = hostOf([issued(now + 50 * 60_000)], 20)
  const held = job()
  const together = await Effect.runPromise(
    Effect.all(Array.from({ length: 5 }, () => Credential.forJob(host, held, () => now)), { concurrency: "unbounded" })
  )
  expect(together.every(Option.isSome)).toBe(true)
  expect(asks.count).toBe(1)
  now += 39 * 60_000
  await Effect.runPromise(Credential.forJob(host, held, () => now))
  expect(asks.count).toBe(1)
  // Within ten minutes of its end: asked again.
  now += 2 * 60_000
  await Effect.runPromise(Credential.forJob(host, held, () => now))
  expect(asks.count).toBe(2)
  // Another claim of the same job never shares it.
  await Effect.runPromise(Credential.forJob(host, { ...held, claim: crypto.randomUUID() }, () => now))
  expect(asks.count).toBe(3)
  Credential.forget(held)
})

test("only a 404 is no credential; the host unavailable is retryable with its wait; a refusal is an error", async () => {
  const run = (answer: Answer) => Effect.runPromise(Effect.exit(Credential.forJob(hostOf([answer]).host, job())))
  expect(await run(new Host.HostError({ code: "invalid", route: "gitCredential", status: 404 }))).toEqual(
    Exit.succeed(Option.none())
  )
  expect(await run(new Host.HostError({ code: "unavailable", route: "gitCredential", status: 503 })))
    .toEqual(Exit.fail(new Credential.CredentialUnavailable({})))
  expect(
    await run(new Host.HostError({ code: "unavailable", route: "gitCredential", status: 429, retryAfterSeconds: 30 }))
  )
    .toEqual(Exit.fail(new Credential.CredentialUnavailable({ afterSeconds: 30 })))
  expect(await run(new Host.HostError({ code: "unavailable", route: "gitCredential" })))
    .toEqual(Exit.fail(new Credential.CredentialUnavailable({})))
  for (const status of [401, 403]) {
    expect(await run(new Host.HostError({ code: "refused", route: "gitCredential", status })))
      .toEqual(Exit.fail(new Credential.CredentialRefused({ status })))
  }
  expect(await run(new Host.HostError({ code: "invalid", route: "gitCredential", status: 409 })))
    .toEqual(Exit.fail(new Credential.CredentialRefused({ status: 409 })))
  // A failed ask keeps nothing: the next ask reaches the host.
  const { host, asks } = hostOf([
    new Host.HostError({ code: "unavailable", route: "gitCredential", status: 503 }),
    issued(Date.now() + 3_600_000)
  ])
  const held = job()
  expect(Exit.isFailure(await Effect.runPromise(Effect.exit(Credential.forJob(host, held))))).toBe(true)
  expect(Option.isSome(await Effect.runPromise(Credential.forJob(host, held)))).toBe(true)
  expect(asks.count).toBe(2)
})

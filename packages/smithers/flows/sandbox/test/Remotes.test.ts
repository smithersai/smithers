import { describe, expect, it } from "@effect/vitest"
import * as Capability from "@smthrs/capability/Capability"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as TestGrantStore from "@smthrs/kernel/test/TestGrantStore"
import { Effect, Exit } from "effect"
import { ProviderError } from "../src/RemoteChildProcessSpawner/ProviderError.ts"
import * as Remotes from "../src/Remotes/index.ts"
import * as Sandbox from "../src/Sandbox/index.ts"

// What a host's provider lookup was asked, so a test can tell a refused
// acquire from one that reached the remote.
const machine = Sandbox.TestSession.make({ workdir: "/guest/fuzz" })
const declared = (asked: Array<string>) => (remote: string, session: string) =>
  Effect.suspend(() => {
    asked.push(`${remote}/${session}`)
    return remote === "fuzz"
      ? Effect.succeed(machine)
      : Effect.fail(new ProviderError({ code: "not_found", message: `no remote ${remote}` }))
  })

const remotes = (store: typeof TestGrantStore.layerAllow, asked: Array<string>) =>
  Effect.gen(function*() {
    const grants = yield* GrantStore.GrantStore
    return Remotes.make({ grants, provider: declared(asked) })
  }).pipe(Effect.provide(store))

describe("Remotes", () => {
  it.effect("opens a session on a declared remote under the caller's key once the grant allows it", () =>
    Effect.gen(function*() {
      const asked: Array<string> = []
      const service = yield* remotes(TestGrantStore.layerAllow, asked)
      const session = yield* Effect.scoped(service.acquire("fuzz", "campaign-7"))
      expect(machine.state.acquired).toEqual(["campaign-7"])
      expect(session.workdir).toBe("/guest/fuzz")
      expect(asked).toEqual(["fuzz/campaign-7"])
    }))

  it.effect("refuses an action the grant does not allow before it asks for the remote's provider", () =>
    Effect.gen(function*() {
      const asked: Array<string> = []
      const service = yield* remotes(TestGrantStore.layerDeny("outside capability ceiling"), asked)
      const exit = yield* Effect.exit(Effect.scoped(service.acquire("fuzz", "campaign-7")))
      expect(Exit.isFailure(exit)).toBe(true)
      const error = Exit.isFailure(exit) ? exit.cause.reasons[0] : undefined
      expect(error?._tag === "Fail" ? error.error : undefined).toMatchObject({
        _tag: "@smthrs/capability/PermissionDenied",
        capability: Capability.make("remote:acquire", "fuzz")
      })
      expect(asked).toEqual([])
    }))

  it.effect("passes the host's refusal of an undeclared remote through", () =>
    Effect.gen(function*() {
      const asked: Array<string> = []
      const service = yield* remotes(TestGrantStore.layerAllow, asked)
      const error = yield* Effect.flip(Effect.scoped(service.acquire("ci", "campaign-7")))
      expect(error).toMatchObject({ code: "not_found", message: "no remote ci" })
      expect(asked).toEqual(["ci/campaign-7"])
    }))
})

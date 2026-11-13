import { describe, expect, it } from "@effect/vitest"
import type { Action } from "@smthrs/capability/Capability"
import * as Capability from "@smthrs/capability/Capability"
import { permissionDenied } from "@smthrs/capability/Permission"
import * as HostJj from "@smthrs/jj"
import { Deferred, Effect, Fiber, FileSystem as EffectFileSystem, Path } from "effect"
import { createHash } from "node:crypto"
import { emptyPolicy as closedPolicy } from "../src/GrantStore.ts"
import { GrantStore, type Service as GrantStoreService } from "../src/GrantStore.ts"
import * as Jj from "../src/Jj.ts"
import * as Workspace from "../src/Workspace.ts"

const itEffect = (name: string, effect: () => Effect.Effect<void, unknown, never>) => it.effect(name, () => effect())

const scriptedStore = (checks: Array<Capability.Capability>) =>
  GrantStore.of({
    policy: closedPolicy,
    check: (capability) => {
      checks.push(capability)
      return Effect.void
    },
    reply: () => Effect.die("not used by decorator tests"),
    list: Effect.succeed([]),
    grantEnvelope: () => Effect.void
  })

const fileSystem = EffectFileSystem.makeNoop({
  realPath: (path) => Effect.succeed(path)
})

/** What the recording host answers to each of the nine guarded operations. */
const answers = {
  status: "status",
  diff: "diff",
  snapshot: { commitId: "commit", changeId: "change" },
  restore: undefined,
  workspaceAdd: undefined,
  workspaceForget: undefined,
  root: "/repository",
  revert: { reverted: ["src/a.ts"] },
  opRestore: undefined
} as const

type OperationName = keyof typeof answers

/** A capability as the rows spell it: the action and resource a check must carry. */
interface Requested {
  readonly action: Action
  readonly resource: string
}

/**
 * One timeline for both sides of the decorator. A check and the host call it
 * guards land in the same log, so the assertion is on their order, not on two
 * lists that would both still be complete if the call ran first.
 */
type Event =
  | { readonly event: "check"; readonly capability: Requested }
  | { readonly event: "call"; readonly operation: OperationName }

/** One row per guarded operation: the call, and the capabilities it must ask for first, in order. */
interface Operation {
  readonly name: OperationName
  readonly checks: ReadonlyArray<Requested>
  readonly call: (jj: HostJj.Jj) => Effect.Effect<unknown, unknown>
}

const operations: ReadonlyArray<Operation> = [
  { name: "status", checks: [{ action: "jj:status", resource: "." }], call: (jj) => jj.status() },
  { name: "diff", checks: [{ action: "jj:diff", resource: "from:to" }], call: (jj) => jj.diff("from", "to") },
  { name: "snapshot", checks: [{ action: "jj:snapshot", resource: "message" }], call: (jj) => jj.snapshot("message") },
  { name: "restore", checks: [{ action: "jj:restore", resource: "change" }], call: (jj) => jj.restore("change") },
  {
    name: "workspaceAdd",
    checks: [{ action: "jj:workspace-add", resource: "/work/lane" }, { action: "fs:write", resource: "/work/lane" }],
    call: (jj) => jj.workspaceAdd("lane", "/work/lane")
  },
  {
    name: "workspaceForget",
    checks: [{ action: "jj:workspace-forget", resource: "lane" }],
    call: (jj) => jj.workspaceForget("lane")
  },
  {
    name: "root",
    checks: [{ action: "jj:root", resource: "/repository/lane" }],
    call: (jj) => jj.root!("/repository/lane")
  },
  { name: "revert", checks: [{ action: "jj:revert", resource: "change" }], call: (jj) => jj.revert!("change") },
  {
    name: "opRestore",
    checks: [{ action: "jj:op-restore", resource: "abc123" }],
    call: (jj) => jj.opRestore!("abc123")
  }
]

/** A backend implementing all nine operations, each of which logs its call and answers {@link answers}. */
const recordingHost = (log: Array<Event>): HostJj.Jj => {
  const answer = <Name extends OperationName>(operation: Name) => () =>
    Effect.sync(() => {
      log.push({ event: "call", operation })
      return answers[operation]
    })
  return HostJj.make({
    status: answer("status"),
    diff: answer("diff"),
    snapshot: answer("snapshot"),
    restore: answer("restore"),
    workspaceAdd: answer("workspaceAdd"),
    workspaceForget: answer("workspaceForget"),
    root: answer("root"),
    revert: answer("revert"),
    opRestore: answer("opRestore")
  })
}

const guarded = <A, E>(
  effect: Effect.Effect<A, E, Jj.Jj>,
  host: HostJj.Jj,
  store: GrantStoreService,
  realPaths: EffectFileSystem.FileSystem = fileSystem
) =>
  effect.pipe(
    Effect.provide(Jj.layer),
    Effect.provideService(HostJj.Jj, host),
    Effect.provideService(EffectFileSystem.FileSystem, realPaths),
    Effect.provide(Path.layer),
    Effect.provide(Workspace.layer("/workspace")),
    Effect.provideService(GrantStore, store)
  )

describe("Jj", () => {
  for (const length of [4096, 4097]) {
    itEffect(`keeps a ${length}-unit snapshot resource in the typed channel`, () => {
      const checks: Array<Capability.Capability> = []
      let invoked = false
      return Effect.gen(function*() {
        const jj = yield* Jj.Jj
        const error = yield* Effect.flip(jj.snapshot("x".repeat(length)))
        expect(error).toMatchObject({ code: "permission_denied" })
        expect(checks).toHaveLength(1)
        const rendered = "x".repeat(length)
        expect(checks[0]).toEqual({
          action: "jj:snapshot",
          resource: length === 4096 ?
            rendered
            : `${rendered.slice(0, 3900)}… sha256:${createHash("sha256").update(rendered).digest("hex")}`
        })
        expect(invoked).toBe(false)
      }).pipe(
        Effect.provide(Jj.layer),
        Effect.provideService(
          HostJj.Jj,
          HostJj.makeNoop({
            snapshot: () =>
              Effect.sync(() => {
                invoked = true
                return { commitId: "commit", changeId: "change" }
              })
          })
        ),
        Effect.provideService(EffectFileSystem.FileSystem, fileSystem),
        Effect.provide(Path.layer),
        Effect.provide(Workspace.layer("/workspace")),
        Effect.provideService(GrantStore, {
          ...scriptedStore(checks),
          check: (capability) => {
            checks.push(capability)
            return Effect.fail(permissionDenied(capability, "denied by test"))
          }
        })
      )
    })
  }

  itEffect("asks for every operation's capabilities before delegating it", () => {
    const log: Array<Event> = []
    return guarded(
      Effect.gen(function*() {
        const jj = yield* Jj.Jj
        for (const operation of operations) {
          expect(yield* operation.call(jj), operation.name).toEqual(answers[operation.name])
        }
        expect(log).toEqual(operations.flatMap((operation) => [
          ...operation.checks.map((capability) => ({ event: "check", capability })),
          { event: "call", operation: operation.name }
        ]))
      }),
      recordingHost(log),
      GrantStore.of({
        ...scriptedStore([]),
        check: (capability) => {
          log.push({ event: "check", capability })
          return Effect.void
        }
      })
    )
  })

  for (const operation of operations) {
    itEffect(`refuses ${operation.name} before the host sees it`, () => {
      const log: Array<Event> = []
      return guarded(
        Effect.gen(function*() {
          const jj = yield* Jj.Jj
          expect(yield* Effect.flip(operation.call(jj))).toMatchObject({
            code: "permission_denied",
            capability: operation.checks[0],
            reason: "denied by test"
          })
          expect(log).toEqual([{ event: "check", capability: operation.checks[0] }])
        }),
        recordingHost(log),
        GrantStore.of({
          ...scriptedStore([]),
          check: (capability) => {
            log.push({ event: "check", capability })
            return Effect.fail(permissionDenied(capability, "denied by test"))
          }
        })
      )
    })
  }

  itEffect("runs `root` in the canonical directory it was authorized for", () => {
    // A symlink is the whole attack: check `jj:root` on the name the caller
    // spelled and then run jj somewhere else, and an authorized path decides
    // the answer for a repository the grant never mentioned.
    const calls: Array<string> = []
    const checks: Array<Capability.Capability> = []
    const aliasing = EffectFileSystem.makeNoop({
      realPath: (path) => Effect.succeed(path === "/workspace/alias" ? "/elsewhere/repository" : path)
    })
    const host = HostJj.makeNoop({
      root: (from) =>
        Effect.sync(() => {
          calls.push(`root:${from}`)
          return "/elsewhere/repository"
        })
    })

    return Effect.gen(function*() {
      const jj = yield* Jj.Jj
      expect(yield* jj.root!("alias")).toBe("/elsewhere/repository")
      // One path, resolved once: the capability and the subprocess cwd cannot
      // disagree because they are the same value.
      expect(calls).toEqual(["root:/elsewhere/repository"])
      expect(checks).toEqual([{ action: "jj:root", resource: "/elsewhere/repository" }])
    }).pipe(
      Effect.provide(Jj.layer),
      Effect.provideService(HostJj.Jj, host),
      Effect.provideService(EffectFileSystem.FileSystem, aliasing),
      Effect.provide(Path.layer),
      Effect.provide(Workspace.layer("/workspace")),
      Effect.provideService(GrantStore, scriptedStore(checks))
    )
  })

  itEffect("refuses a workspace destination that changes after both grants", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        let canonical = "/workspace/lane"
        let delegated = false
        const resolutions: Array<readonly [string, string]> = []
        const checks: Array<Capability.Capability> = []
        const changing = EffectFileSystem.makeNoop({
          realPath: (value) =>
            Effect.sync(() => {
              const resolved = value === "/workspace" ? value : canonical
              resolutions.push([value, resolved])
              return resolved
            })
        })
        const store = GrantStore.of({
          policy: closedPolicy,
          check: (capability) => {
            checks.push(capability)
            return checks.length === 2
              ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
              : Effect.void
          },
          reply: () => Effect.die("not used by workspace mutation test"),
          list: Effect.succeed([]),
          grantEnvelope: () => Effect.void
        })
        const host = HostJj.makeNoop({
          workspaceAdd: () =>
            Effect.sync(() => {
              delegated = true
            })
        })
        const running = yield* Effect.gen(function*() {
          const jj = yield* Jj.Jj
          return yield* jj.workspaceAdd("lane", "lane")
        }).pipe(
          Effect.provide(Jj.layer),
          Effect.provideService(HostJj.Jj, host),
          Effect.provideService(EffectFileSystem.FileSystem, changing),
          Effect.provide(Path.layer),
          Effect.provide(Workspace.layer("/workspace")),
          Effect.provideService(GrantStore, store),
          Effect.exit,
          Effect.forkChild({ startImmediately: true })
        )

        yield* Deferred.await(entered)
        canonical = "/outside/lane"
        yield* Deferred.succeed(release, undefined)
        const outcome = yield* Fiber.join(running)
        if (outcome._tag === "Success") throw new Error(`unexpected delegation: ${JSON.stringify(resolutions)}`)
        expect(outcome).toMatchObject({
          _tag: "Failure",
          cause: {
            reasons: [{
              error: {
                code: "permission_denied",
                capability: { action: "jj:workspace-add", resource: "/workspace/lane" },
                reason: "workspace destination no longer names the resource that was authorized"
              }
            }]
          }
        })
        expect(delegated).toBe(false)
        expect(checks).toEqual([
          { action: "jj:workspace-add", resource: "/workspace/lane" },
          { action: "fs:write", resource: "/workspace/lane" }
        ])
      })
    ))

  itEffect("forwards the absence of an operation a backend does not implement", () => {
    // A backend that cannot revert must keep reading as one. Wrapping the
    // absence in a guarded method that fails on call would answer "your revert
    // was refused" to a caller asking "can this host revert at all".
    const host = HostJj.make({
      status: () => Effect.succeed("status"),
      diff: () => Effect.succeed("diff"),
      snapshot: () => Effect.succeed({ commitId: "change", changeId: "change" }),
      restore: () => Effect.void,
      workspaceAdd: () => Effect.void,
      workspaceForget: () => Effect.void
    })

    return Effect.gen(function*() {
      const jj = yield* Jj.Jj
      expect(jj.root).toBeUndefined()
      expect(jj.revert).toBeUndefined()
      expect(jj.opRestore).toBeUndefined()
      expect(yield* jj.status()).toBe("status")
    }).pipe(
      Effect.provide(Jj.layer),
      Effect.provideService(HostJj.Jj, host),
      Effect.provideService(EffectFileSystem.FileSystem, fileSystem),
      Effect.provide(Path.layer),
      Effect.provide(Workspace.layer("/workspace")),
      Effect.provideService(GrantStore, scriptedStore([]))
    )
  })
})

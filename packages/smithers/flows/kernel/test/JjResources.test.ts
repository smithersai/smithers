import { describe, expect, it } from "@effect/vitest"
import type * as Capability from "@smthrs/capability/Capability"
import { permissionDenied } from "@smthrs/capability/Permission"
import * as HostJj from "@smthrs/jj"
import { Effect, Fiber, FileSystem as EffectFileSystem, Path } from "effect"
import { systemError } from "effect/PlatformError"
import { createHash } from "node:crypto"
import { emptyPolicy as closedPolicy } from "../src/GrantStore.ts"
import { GrantStore, make as makeGrantStore, type PendingRequest, type Service } from "../src/GrantStore.ts"
import * as Jj from "../src/Jj.ts"
import * as Workspace from "../src/Workspace.ts"

/**
 * The Jj decorator turns each version-control operation into a capability
 * resource. Those resources are the strings an approver sees and a remembered
 * rule matches against, so an unlabelled snapshot and a workspace-relative
 * lane path must both produce stable, canonical resources.
 */

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

const provideWithStore = <A, E>(
  effect: Effect.Effect<A, E, HostJj.Jj>,
  host: HostJj.Jj,
  grants: Service,
  rawFileSystem: EffectFileSystem.FileSystem = fileSystem
) =>
  effect.pipe(
    Effect.provide(Jj.layer),
    Effect.provideService(HostJj.Jj, host),
    Effect.provideService(EffectFileSystem.FileSystem, rawFileSystem),
    Effect.provide(Path.layer),
    Effect.provide(Workspace.layer("/workspace")),
    Effect.provideService(GrantStore, grants)
  )

const provide = <A, E>(
  effect: Effect.Effect<A, E, HostJj.Jj>,
  host: HostJj.Jj,
  checks: Array<Capability.Capability>
) => provideWithStore(effect, host, scriptedStore(checks))

describe("Jj capability resources", () => {
  itEffect(
    "never reuses a digest-form literal run grant for another snapshot message",
    () =>
      Effect.scoped(Effect.gen(function*() {
        const store = yield* makeGrantStore({ planDigest: "snapshot-plan" })
        const message = "x".repeat(5000)
        const literal = `${message.slice(0, 3900)}… sha256:${createHash("sha256").update(message).digest("hex")}`
        const messages: Array<string | undefined> = []
        const host = HostJj.makeNoop({
          snapshot: (value) =>
            Effect.sync(() => {
              messages.push(value)
              return { commitId: "commit", changeId: "change" as HostJj.ChangeId }
            })
        })
        const pending = (): Effect.Effect<PendingRequest> =>
          Effect.suspend(() =>
            Effect.flatMap(
              store.list,
              (entries) =>
                entries[0] === undefined ? Effect.yieldNow.pipe(Effect.andThen(pending)) : Effect.succeed(entries[0])
            )
          )
        yield* provideWithStore(
          Effect.gen(function*() {
            const jj = yield* HostJj.Jj
            const first = yield* jj.snapshot(literal).pipe(Effect.forkChild({ startImmediately: true }))
            const approved = yield* pending()
            expect(approved.capability.resource).not.toBe(literal)
            yield* store.reply(approved.requestId, "run")
            yield* Fiber.join(first)
            const next = yield* jj.snapshot(message).pipe(Effect.forkChild({ startImmediately: true }))
            const requested = yield* Effect.raceFirst(
              pending(),
              Fiber.join(next).pipe(
                Effect.andThen(Effect.fail(new Error("a literal run grant authorized another message")))
              )
            )
            expect(requested.capability.resource).not.toBe(approved.capability.resource)
            yield* store.reply(requested.requestId, "deny")
            expect((yield* Fiber.await(next))._tag).toBe("Failure")
            expect(messages).toEqual([literal])
          }),
          host,
          store
        )
      })).pipe(Effect.provide(Workspace.layer("/workspace")))
  )

  itEffect("keeps malformed long snapshot text in the typed error channel", () =>
    provide(
      Effect.gen(function*() {
        const jj = yield* HostJj.Jj
        expect(yield* Effect.flip(jj.snapshot("x".repeat(5000) + String.fromCharCode(0xd800)))).toMatchObject({
          code: "invalid_resolution"
        })
      }),
      HostJj.makeNoop({}),
      []
    ))

  itEffect("authorizes long snapshots with a bounded digest and full approval metadata", () => {
    const messages: Array<string | undefined> = []
    const checks: Array<Capability.Capability> = []
    const metadata: Array<unknown> = []
    const message = `${"x".repeat(3899)}😀${"y".repeat(1200)}`
    const host = HostJj.makeNoop({
      snapshot: (value) =>
        Effect.sync(() => {
          messages.push(value)
          return { commitId: "commit", changeId: "change" as HostJj.ChangeId }
        })
    })
    const store = GrantStore.of({
      ...scriptedStore(checks),
      check: (capability, meta) => {
        checks.push(capability)
        metadata.push(meta)
        return Effect.void
      }
    })
    return provideWithStore(
      Effect.gen(function*() {
        const jj = yield* HostJj.Jj
        yield* jj.snapshot(message)
        const digest = createHash("sha256").update(message).digest("hex")
        expect(checks).toEqual([{ action: "jj:snapshot", resource: `${message.slice(0, 3899)}… sha256:${digest}` }])
        expect(metadata).toEqual([{ commandLine: message }])
        expect(messages).toEqual([message])
      }),
      host,
      store
    )
  })

  itEffect("labels an unnamed snapshot with an empty resource", () => {
    const messages: Array<string | undefined> = []
    const checks: Array<Capability.Capability> = []
    const host = HostJj.makeNoop({
      snapshot: (message) =>
        Effect.sync(() => {
          messages.push(message)
          return { commitId: "commit", changeId: "change" as HostJj.ChangeId }
        })
    })

    return provide(
      Effect.gen(function*() {
        const jj = yield* HostJj.Jj
        expect(yield* jj.snapshot()).toEqual({ commitId: "commit", changeId: "change" })
        expect(checks).toEqual([{ action: "jj:snapshot", resource: "" }])
        // The absent message is forwarded as-is; only the resource is defaulted.
        expect(messages).toEqual([undefined])
      }),
      host,
      checks
    )
  })

  itEffect("canonicalizes a workspace-relative workspace-add destination", () => {
    const calls: Array<readonly [string, string]> = []
    const checks: Array<Capability.Capability> = []
    const host = HostJj.makeNoop({
      workspaceAdd: (name, destination) =>
        Effect.sync(() => {
          calls.push([name, destination])
        })
    })

    return provide(
      Effect.gen(function*() {
        const jj = yield* HostJj.Jj
        yield* jj.workspaceAdd("lane", "lanes/./one")
        expect(checks).toEqual([
          { action: "jj:workspace-add", resource: "/workspace/lanes/one" },
          { action: "fs:write", resource: "/workspace/lanes/one" }
        ])
        expect(calls).toEqual([["lane", "/workspace/lanes/one"]])
      }),
      host,
      checks
    )
  })

  itEffect("keeps an absolute workspace-add destination outside the workspace", () => {
    const calls: Array<readonly [string, string]> = []
    const checks: Array<Capability.Capability> = []
    const host = HostJj.makeNoop({
      workspaceAdd: (name, destination) =>
        Effect.sync(() => {
          calls.push([name, destination])
        })
    })

    return provide(
      Effect.gen(function*() {
        const jj = yield* HostJj.Jj
        yield* jj.workspaceAdd("lane", "/elsewhere/lane")
        expect(checks.map((check) => check.resource)).toEqual(["/elsewhere/lane", "/elsewhere/lane"])
        expect(calls).toEqual([["lane", "/elsewhere/lane"]])
      }),
      host,
      checks
    )
  })

  itEffect("does not delegate when workspace authority passes but filesystem authority is denied", () => {
    const calls: Array<readonly [string, string]> = []
    const checks: Array<Capability.Capability> = []
    const host = HostJj.makeNoop({
      workspaceAdd: (name, destination) =>
        Effect.sync(() => {
          calls.push([name, destination])
        })
    })
    const grants = GrantStore.of({
      policy: closedPolicy,
      check: (capability) => {
        checks.push(capability)
        return capability.action === "jj:workspace-add"
          ? Effect.void
          : Effect.fail(permissionDenied(capability, "filesystem write denied"))
      },
      reply: () => Effect.die("not used by decorator tests"),
      list: Effect.succeed([]),
      grantEnvelope: () => Effect.void
    })

    return provideWithStore(
      Effect.gen(function*() {
        const jj = yield* HostJj.Jj
        expect(yield* Effect.flip(jj.workspaceAdd("lane", "lanes/one"))).toMatchObject({
          code: "permission_denied",
          capability: { action: "fs:write", resource: "/workspace/lanes/one" },
          reason: "filesystem write denied"
        })
        expect(checks).toEqual([
          { action: "jj:workspace-add", resource: "/workspace/lanes/one" },
          { action: "fs:write", resource: "/workspace/lanes/one" }
        ])
        expect(calls).toEqual([])
      }),
      host,
      grants
    )
  })

  itEffect("fails before checking or delegating when destination canonicalization fails", () => {
    let delegated = false
    const checks: Array<Capability.Capability> = []
    const host = HostJj.makeNoop({
      workspaceAdd: () =>
        Effect.sync(() => {
          delegated = true
        })
    })
    const brokenFileSystem = EffectFileSystem.makeNoop({
      realPath: () =>
        Effect.fail(systemError({
          _tag: "NotFound",
          module: "FileSystem",
          method: "realPath",
          pathOrDescriptor: "/workspace"
        })),
      readLink: () =>
        Effect.fail(systemError({
          _tag: "NotFound",
          module: "FileSystem",
          method: "readLink",
          pathOrDescriptor: "/workspace"
        }))
    })

    return provideWithStore(
      Effect.gen(function*() {
        const jj = yield* HostJj.Jj
        expect(yield* Effect.flip(jj.workspaceAdd("lane", "lanes/one"))).toMatchObject({
          _tag: "PlatformError",
          reason: { _tag: "NotFound", module: "FileSystem", method: "realPath" }
        })
        expect(checks).toEqual([])
        expect(delegated).toBe(false)
      }),
      host,
      scriptedStore(checks),
      brokenFileSystem
    )
  })
})

describe("Jj stub layer", () => {
  itEffect("provides an unavailable Jj service", () =>
    Effect.gen(function*() {
      const jj = yield* HostJj.Jj
      expect(yield* Effect.flip(jj.status())).toMatchObject({ code: "not_installed", method: "status" })
    }).pipe(Effect.provide(Jj.layerNoop({}))))

  itEffect("provides overridden operations while the rest stay unavailable", () =>
    Effect.gen(function*() {
      const jj = yield* HostJj.Jj
      expect(yield* jj.status()).toBe("clean")
      expect(yield* Effect.flip(jj.snapshot("m"))).toMatchObject({ code: "not_installed" })
    }).pipe(Effect.provide(Jj.layerNoop({ status: () => Effect.succeed("clean") }))))
})

import { describe, expect, it } from "@effect/vitest"
import { CapabilityPattern } from "@smthrs/capability/Capability"
import * as Permission from "@smthrs/capability/Permission"
import { Effect, FileSystem as EffectFileSystem, Option, Path as EffectPath, PlatformError } from "effect"
import * as CapabilitySet from "../src/CapabilitySet.ts"
import * as FileSystem from "../src/FileSystem.vibe"
import * as GrantStore from "../src/GrantStore.ts"
import { restrictsContent } from "../src/internal/restrictsContent.ts"
import * as Workspace from "../src/Workspace.vibe"

const pattern = (action: CapabilityPattern["action"], resource: string) => new CapabilityPattern({ action, resource })
const rule = (action: CapabilityPattern["action"], resource: string, effect: "allow" | "deny" | "ask" = "allow") =>
  new Permission.Rule({ effect, pattern: pattern(action, resource) })

/** The broad workspace grants the policy guide teaches; each test appends its restriction. */
const workspaceRules = [rule("fs:read", "/workspace/**"), rule("fs:write", "/workspace/**")]

const refusal = (error: unknown) => {
  const denied = Option.getOrThrow(Permission.fromPlatformError(error as PlatformError.PlatformError))
  return "reason" in denied
    ? `${denied.capability.action} ${denied.capability.resource}: ${denied.reason}`
    : denied.code
}

/**
 * An isolated volume whose `stat` answers from `kinds` (an unlisted path names
 * nothing) and whose `rename`, `remove` and `copy` record what reached it.
 */
const volume = (kinds: Record<string, "Directory" | "File" | "Unreadable">) => {
  const calls: Array<string> = []
  const record = (call: string) =>
    Effect.sync(() => {
      calls.push(call)
    })
  const host = FileSystem.withIsolatedFileSystem(EffectFileSystem.makeNoop({
    realPath: (path) => Effect.succeed(path),
    stat: (path) => {
      const kind = kinds[path]
      return kind === undefined
        ? Effect.fail(PlatformError.systemError({ _tag: "NotFound", module: "test", method: "stat" }))
        : kind === "Unreadable"
        ? Effect.fail(PlatformError.systemError({ _tag: "PermissionDenied", module: "test", method: "stat" }))
        : Effect.succeed({ type: kind, nlink: Option.none() } as unknown as EffectFileSystem.File.Info)
    },
    rename: (from, to) => record(`rename ${from} ${to}`),
    remove: (path, options) => record(`remove ${path}${options?.recursive === true ? " recursive" : ""}`),
    copy: (from, to) => record(`copy ${from} ${to}`)
  }))
  return { calls, host }
}

const run = <A>(
  effect: (fileSystem: EffectFileSystem.FileSystem) => Effect.Effect<A, unknown>,
  host: EffectFileSystem.FileSystem,
  grants: Effect.Effect<GrantStore.Service, unknown, import("effect").Scope.Scope | Workspace.Workspace>
) =>
  Effect.gen(function*() {
    const store = yield* grants
    return yield* Effect.flatMap(EffectFileSystem.FileSystem, effect).pipe(
      Effect.provide(FileSystem.layer),
      Effect.provideService(EffectFileSystem.FileSystem, host),
      Effect.provide(EffectPath.layer),
      Effect.provideService(GrantStore.GrantStore, store)
    )
  }).pipe(Effect.provide(Workspace.layer("/workspace")), Effect.scoped)

const withRules = (...restrictions: ReadonlyArray<Permission.Rule>) =>
  GrantStore.make({ attended: false, rules: [...workspaceRules, ...restrictions] })

const refused = <A>(effect: Effect.Effect<A, unknown>) => Effect.map(Effect.flip(effect), refusal)

const contentReason = "a deny or ask rule may select content under this directory"

describe("FileSystem directory content", () => {
  it.effect("a rename needs fs:read on its source, so a read veto cannot be renamed away", () => {
    const { calls, host } = volume({ "/workspace/.env": "File" })
    return run(
      (fileSystem) =>
        Effect.gen(function*() {
          expect(yield* refused(fileSystem.rename("/workspace/.env", "/workspace/env.txt"))).toBe(
            "fs:read /workspace/.env: denied by permission policy"
          )
          expect(calls).toEqual([])
        }),
      host,
      withRules(rule("fs:read", "/workspace/.env*", "deny"))
    )
  })

  it.effect("refuses to rename a directory whose content a deny rule selects, from it or onto it", () => {
    const { calls, host } = volume({ "/workspace/secrets": "Directory", "/workspace/src": "Directory" })
    return run(
      (fileSystem) =>
        Effect.gen(function*() {
          expect(yield* refused(fileSystem.rename("/workspace/secrets", "/workspace/pub"))).toBe(
            `fs:read /workspace/secrets: ${contentReason}`
          )
          expect(yield* refused(fileSystem.rename("/workspace/src", "/workspace/secrets"))).toBe(
            `fs:write /workspace/secrets: ${contentReason}`
          )
          expect(calls).toEqual([])
          yield* fileSystem.rename("/workspace/src", "/workspace/lib")
          expect(calls).toEqual(["rename /workspace/src /workspace/lib"])
        }),
      host,
      withRules(rule("fs:read", "/workspace/secrets/**", "deny"), rule("fs:write", "/workspace/secrets/**", "deny"))
    )
  })

  it.effect("refuses to rename a directory away from under a write deny on one of its files", () => {
    const { calls, host } = volume({ "/workspace/sub": "Directory" })
    return run(
      (fileSystem) =>
        Effect.gen(function*() {
          expect(yield* refused(fileSystem.rename("/workspace/sub", "/workspace/away"))).toBe(
            `fs:write /workspace/sub: ${contentReason}`
          )
          expect(calls).toEqual([])
        }),
      host,
      withRules(rule("fs:write", "/workspace/sub/pnpm-lock.yaml", "deny"))
    )
  })

  it.effect("refuses a recursive remove of a directory holding a write-denied file", () => {
    const { calls, host } = volume({
      "/workspace/sub": "Directory",
      "/workspace/sub/notes.md": "File",
      "/workspace/locked": "Unreadable"
    })
    return run(
      (fileSystem) =>
        Effect.gen(function*() {
          expect(yield* refused(fileSystem.remove("/workspace/sub", { recursive: true }))).toBe(
            `fs:write /workspace/sub: ${contentReason}`
          )
          // What cannot be inspected is treated as a directory.
          expect(yield* refused(fileSystem.remove("/workspace/locked", { recursive: true }))).toBe(
            `fs:write /workspace/locked: ${contentReason}`
          )
          expect(calls).toEqual([])
          // A file and a missing path have no content; a plain remove deletes
          // only an empty directory.
          yield* fileSystem.remove("/workspace/sub/notes.md", { recursive: true })
          yield* fileSystem.remove("/workspace/sub/gone", { recursive: true, force: true })
          yield* fileSystem.remove("/workspace/sub")
          expect(calls).toEqual([
            "remove /workspace/sub/notes.md recursive",
            "remove /workspace/sub/gone recursive",
            "remove /workspace/sub"
          ])
        }),
      host,
      withRules(
        rule("fs:write", "/workspace/sub/pnpm-lock.yaml", "deny"),
        rule("fs:write", "/workspace/locked/key", "deny")
      )
    )
  })

  it.effect("refuses to copy a directory out of a read deny or into a write deny", () => {
    const { calls, host } = volume({ "/workspace/secrets": "Directory", "/workspace/src": "Directory" })
    return run(
      (fileSystem) =>
        Effect.gen(function*() {
          expect(yield* refused(fileSystem.copy("/workspace/secrets", "/workspace/pub"))).toBe(
            `fs:read /workspace/secrets: ${contentReason}`
          )
          expect(yield* refused(fileSystem.copy("/workspace/src", "/workspace/vendor"))).toBe(
            `fs:write /workspace/vendor: ${contentReason}`
          )
          expect(calls).toEqual([])
          yield* fileSystem.copy("/workspace/src", "/workspace/lib")
          expect(calls).toEqual(["copy /workspace/src /workspace/lib"])
        }),
      host,
      withRules(rule("fs:read", "/workspace/secrets/**", "deny"), rule("fs:write", "/workspace/vendor/**", "deny"))
    )
  })

  it.effect("refuses a directory operation when the policy cannot be read", () => {
    const { calls, host } = volume({ "/workspace/src": "Directory" })
    return run(
      (fileSystem) =>
        Effect.gen(function*() {
          expect(yield* refused(fileSystem.rename("/workspace/src", "/workspace/lib"))).toBe("store_closed")
          expect(calls).toEqual([])
        }),
      host,
      Effect.succeed(GrantStore.GrantStore.of({
        ...GrantStore.makeNoop,
        policy: Effect.fail(new Permission.GrantStoreError({ code: "store_closed" }))
      }))
    )
  })
})

describe("restrictsContent", () => {
  const unbounded = { groups: [] }
  const policy = (
    ...groups: ReadonlyArray<ReadonlyArray<Permission.Rule | GrantStore.PolicyRule>>
  ): GrantStore.Policy => ({
    ceiling: CapabilitySet.fromGroups([]),
    groups: groups.map((group) => group.map((entry) => "rule" in entry ? entry : { rule: entry, ceiling: unbounded }))
  })
  const denyKey = rule("fs:write", "/workspace/out/key", "deny")

  it("reads a restriction widely and an allow narrowly", () => {
    expect(restrictsContent(policy(), "fs:write", "/workspace/out")).toBe(false)
    expect(restrictsContent(policy(workspaceRules), "fs:write", "/workspace/out")).toBe(false)
    expect(restrictsContent(policy([...workspaceRules, denyKey]), "fs:write", "/workspace/out")).toBe(true)
    expect(restrictsContent(policy([...workspaceRules, denyKey]), "fs:write", "/workspace")).toBe(true)
    // Other actions and provably disjoint trees are not restricted.
    expect(restrictsContent(policy([...workspaceRules, denyKey]), "fs:read", "/workspace/out")).toBe(false)
    expect(restrictsContent(policy([...workspaceRules, denyKey]), "fs:write", "/workspace/src")).toBe(false)
    expect(restrictsContent(policy([rule("fs:write", "/workspace/out/*.key", "ask")]), "fs:write", "/workspace/out"))
      .toBe(true)
    expect(restrictsContent(policy([rule("*", "*", "deny")]), "fs:read", "/workspace/out")).toBe(true)
  })

  it("lets a later allow that covers the whole directory supersede a restriction", () => {
    const carveOut = [rule("fs:write", "/workspace/**", "deny"), rule("fs:write", "/workspace/out/**")]
    expect(restrictsContent(policy(carveOut), "fs:write", "/workspace/out/tmp")).toBe(false)
    expect(restrictsContent(policy(carveOut), "fs:write", "/workspace/out/")).toBe(false)
    expect(restrictsContent(policy(carveOut), "fs:write", "/workspace/src")).toBe(true)
    expect(restrictsContent(policy([denyKey, rule("fs:write", "*")]), "fs:write", "/workspace/out")).toBe(false)
    // An allow that does not provably cover the directory supersedes nothing.
    expect(restrictsContent(policy([denyKey, rule("fs:write", "/workspace/out/*")]), "fs:write", "/workspace/out"))
      .toBe(true)
    expect(restrictsContent(policy([denyKey, rule("fs:write", "/workspace/out/key")]), "fs:write", "/workspace/out"))
      .toBe(true)
  })

  it("keeps a configured deny as a veto that only the configured ruleset lifts", () => {
    const grant = rule("fs:write", "/workspace/**")
    expect(restrictsContent(policy([denyKey], [grant]), "fs:write", "/workspace/out")).toBe(true)
    expect(restrictsContent(policy([denyKey, grant], [grant]), "fs:write", "/workspace/out")).toBe(false)
    // An ask, or a deny outside the configured ruleset, yields to a later grant.
    expect(
      restrictsContent(policy([rule("fs:write", "/workspace/out/key", "ask")], [grant]), "fs:write", "/workspace/out")
    )
      .toBe(false)
    expect(restrictsContent(policy([], [denyKey], [grant]), "fs:write", "/workspace/out")).toBe(false)
    expect(restrictsContent(policy([], [grant], [denyKey]), "fs:write", "/workspace/out")).toBe(true)
  })

  it("ignores a grant whose captured ceiling does not cover the directory", () => {
    const grant = rule("fs:write", "/workspace/**")
    const bounded = (...ceiling: ReadonlyArray<CapabilityPattern>): GrantStore.PolicyRule => ({
      rule: grant,
      ceiling: { groups: [ceiling] }
    })
    const restricted = (entry: GrantStore.PolicyRule) =>
      restrictsContent(policy([], [denyKey], [entry]), "fs:write", "/workspace/out")
    expect(restricted(bounded(pattern("fs:write", "/workspace/src/**")))).toBe(true)
    expect(restricted(bounded(pattern("fs:write", "/workspace/src/**"), pattern("fs:write", "*")))).toBe(false)
  })

  it("treats a directory too long to name as restricted", () => {
    expect(restrictsContent(policy(), "fs:write", `/${"d".repeat(4094)}`)).toBe(true)
    expect(restrictsContent(policy(), "fs:write", `/${"d".repeat(4092)}`)).toBe(false)
  })
})

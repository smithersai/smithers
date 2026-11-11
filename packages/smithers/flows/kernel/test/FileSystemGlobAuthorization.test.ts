import * as NodePath from "@effect/platform-node/NodePath"
import { describe, expect, it } from "@effect/vitest"
import { CapabilityPattern } from "@smthrs/capability/Capability"
import * as Permission from "@smthrs/capability/Permission"
import { Effect, FileSystem, Option, Path, PlatformError, Result } from "effect"
import * as Guarded from "../src/FileSystem.ts"
import * as GrantStore from "../src/GrantStore.ts"
import * as Workspace from "../src/Workspace.ts"

const info = { type: "Directory", dev: 7n, ino: Option.some(9n) } as FileSystem.File.Info

/**
 * Model Windows' invalid-name refusal on wildcard lookup on every CI host.
 * The real native globber is covered by the platform-node suite; this double
 * verifies the kernel's public service sends filename lookups, not patterns,
 * to its no-follow executor, including the separate batch authorization path.
 */
const fixture = (root: string, boundaryRoot = root) => {
  const requests: Array<Guarded.AtomicRequest> = []
  const grants: Array<string> = []
  let resolve: (path: string) => Guarded.Resolution = (path) => ({ path, target: null })
  let check = () => {}
  let globFailure: PlatformError.PlatformError | undefined
  const resolvePath = (path: string) =>
    /[*?[{|]/.test(path.slice(boundaryRoot.length))
      ? Effect.fail(PlatformError.systemError({ _tag: "BadResource", module: "test", method: "resolve" }))
      : Effect.sync(() => resolve(path))
  const execute = (request: Guarded.AtomicRequest): Effect.Effect<unknown, PlatformError.PlatformError> =>
    Effect.suspend<unknown, PlatformError.PlatformError, never>(() => {
      requests.push(request)
      switch (request.operation) {
        case "resolve":
          return resolvePath(request.path)
        case "glob":
          return globFailure === undefined ? Effect.succeed([`${root}/result.txt`]) : Effect.fail(globFailure)
        case "batch":
          return Effect.map(
            Effect.forEach(request.requests, (member, index) => {
              const observation: Effect.Effect<Guarded.AtomicBatchValue, PlatformError.PlatformError> =
                member.operation === "resolve"
                  ? Effect.map(resolvePath(member.path), (resolution) => ({
                    operation: "resolve" as const,
                    resolution
                  }))
                  : globFailure === undefined
                  ? Effect.succeed({ operation: "glob" as const, paths: [`${root}/result.txt`] })
                  : Effect.fail(globFailure)
              return Effect.map(
                Effect.result(observation),
                (result) => ({ index, path: member.path, result })
              )
            }),
            (entries) => ({ rootIdentity: "7:9", entries })
          )
        default:
          return Effect.die(`unexpected ${request.operation}`)
      }
    })
  const fs = Guarded.withAtomicFileSystem(
    FileSystem.makeNoop({
      realPath: (path) => path === root ? Effect.succeed(boundaryRoot) : Effect.die("host followed a descendant"),
      stat: () => Effect.succeed(info)
    }),
    {
      noFollowAuthorization: true,
      identifyRoot: () => Effect.succeed("7:9"),
      batchLimits: { size: 128, response: 24 * 1024 * 1024 },
      execute: <R extends Guarded.AtomicRequest>(request: R) =>
        execute(request) as Effect.Effect<Guarded.AtomicResult<R>, PlatformError.PlatformError>
    }
  )
  return {
    fs,
    requests,
    grants,
    setResolve: (next: typeof resolve) => {
      resolve = next
    },
    setCheck: (next: typeof check) => {
      check = next
    },
    setGlobFailure: (failure: PlatformError.PlatformError) => {
      globFailure = failure
    },
    store: {
      ...GrantStore.makeNoop,
      check: (capability: { resource: string }) =>
        Effect.sync(() => {
          grants.push(capability.resource)
          check()
        })
    }
  }
}

const provide = <A, E>(
  body: Effect.Effect<A, E, FileSystem.FileSystem>,
  host: ReturnType<typeof fixture>,
  root: string,
  windows: boolean
) =>
  body.pipe(
    Effect.provide(Guarded.layer),
    Effect.provideService(FileSystem.FileSystem, host.fs),
    Effect.provide(windows ? NodePath.layerWin32 : Path.layer),
    Effect.provide(Workspace.layer(root)),
    Effect.provideService(GrantStore.GrantStore, host.store)
  )

describe("glob authorization", () => {
  for (const windows of [false, true]) {
    const root = windows ? "C:\\workspace" : "/workspace"
    const sep = windows ? "\\" : "/"
    for (const batched of [false, true]) {
      it.effect(`leaves every unsupported extglob refusal to the native grammar (${windows ? "Windows" : "POSIX"}, ${batched ? "batch" : "single"})`, () =>
        Effect.gen(function*() {
          const host = fixture(root)
          const failure = PlatformError.badArgument({
            module: "FileSystem",
            method: "glob",
            description: "unsupported glob pattern"
          })
          host.setGlobFailure(failure)
          yield* provide(
            Effect.gen(function*() {
              const fs = yield* FileSystem.FileSystem
              for (const operator of ["@", "+", "!", "?", "*"]) {
                const pattern = `src/${operator}(a|b).txt`
                const refused = batched
                  ? Option.getOrThrow(Result.getFailure(
                    (yield* Guarded.batch(fs)!.execute([
                      { operation: "glob", path: pattern, root }
                    ])).entries[0]!.result
                  ))
                  : yield* Effect.flip(fs.glob(pattern))
                expect(refused).toBe(failure)
                expect(host.grants.at(-1)).toBe(`${root}${sep}src${sep}${operator}(a|b).txt`)
              }
            }),
            host,
            root,
            windows
          )
          const resolutions = host.requests.flatMap((request) =>
            request.operation === "batch"
              ? request.requests.filter((member) => member.operation === "resolve").map((member) => member.path)
              : request.operation === "resolve"
              ? [request.path]
              : []
          )
          expect(resolutions).toEqual(Array(10).fill(`${root}${sep}src`))
        }))

      it.effect(`inspects ordinary operator-prefixed filenames as literal paths (${windows ? "Windows" : "POSIX"}, ${batched ? "batch" : "single"})`, () =>
        Effect.gen(function*() {
          const host = fixture(root)
          const names = ["@name", "+name", "!name", "@name(file)", "+name(file)", "!name(file)"]
          yield* provide(
            Effect.gen(function*() {
              const fs = yield* FileSystem.FileSystem
              for (const name of names) {
                if (batched) {
                  const response = yield* Guarded.batch(fs)!.execute([{ operation: "glob", path: name, root }])
                  expect(Result.getOrThrow(response.entries[0]!.result).operation).toBe("glob")
                } else expect(yield* fs.glob(name)).toEqual([`${root}/result.txt`])
              }
            }),
            host,
            root,
            windows
          )
          const resolutions = host.requests.flatMap((request) =>
            request.operation === "batch"
              ? request.requests.filter((member) => member.operation === "resolve").map((member) => member.path)
              : request.operation === "resolve"
              ? [request.path]
              : []
          )
          expect(resolutions).toEqual(names.flatMap((name) => [`${root}${sep}${name}`, `${root}${sep}${name}`]))
          expect(host.grants).toEqual(names.map((name) => `${root}${sep}${name}`))
        }))
    }
  }
  for (const windows of [false, true]) {
    const sep = windows ? "\\" : "/"
    const boundaryRoot = windows ? "C:\\data" : "/data"
    for (const overlapping of [false, true]) {
      const root = overlapping ? `${boundaryRoot}${sep}ws` : windows ? "C:\\alias" : "/alias"
      for (const batched of [false, true]) {
        it.effect(`pins alias prefixes once (${windows ? "Windows" : "POSIX"}, ${overlapping ? "overlapping" : "distinct"}, ${batched ? "batch" : "single"})`, () =>
          Effect.gen(function*() {
            const host = fixture(root, boundaryRoot)
            yield* provide(
              Effect.gen(function*() {
                const fs = yield* FileSystem.FileSystem
                if (batched) {
                  const response = yield* Guarded.batch(fs)!.execute([
                    { operation: "glob", path: "ws/*/lit/x.txt", root }
                  ])
                  expect(Result.getOrThrow(response.entries[0]!.result).operation).toBe("glob")
                } else expect(yield* fs.glob("ws/*/lit/x.txt")).toEqual([`${root}/result.txt`])
              }),
              host,
              root,
              windows
            )
            const resolutions = host.requests.flatMap((request) =>
              request.operation === "batch"
                ? request.requests.filter((member) => member.operation === "resolve").map((member) => member.path)
                : request.operation === "resolve"
                ? [request.path]
                : []
            )
            expect(resolutions).toEqual([`${boundaryRoot}${sep}ws`, `${boundaryRoot}${sep}ws`])
            expect(host.grants).toEqual([`${root}${sep}ws${sep}*${sep}lit${sep}x.txt`])
            expect(
              host.requests.every((request) => request.boundaryRoot === boundaryRoot && request.logicalRoot === root)
            )
              .toBe(true)
          }))
      }
    }
  }
  for (const windows of [false, true]) {
    const root = windows ? "C:\\workspace[1]" : "/workspace[1]"
    const sep = windows ? "\\" : "/"
    for (const batched of [false, true]) {
      it.effect(`resolves only literal prefixes and retains patterns (${windows ? "Windows" : "POSIX"}, ${batched ? "batch" : "single"})`, () =>
        Effect.gen(function*() {
          const host = fixture(root)
          host.setResolve((path) => ({ path: path.replace(`${sep}src`, `${sep}Source`), target: null }))
          yield* provide(
            Effect.gen(function*() {
              const fs = yield* FileSystem.FileSystem
              for (const pattern of ["**/*.txt", "src/?[ab].{txt,md}", "src/literal.txt"]) {
                if (batched) {
                  const response = yield* Guarded.batch(fs)!.execute([{ operation: "glob", path: pattern, root }])
                  expect(Result.getOrThrow(response.entries[0]!.result)).toEqual({
                    operation: "glob",
                    paths: [`${root}/result.txt`]
                  })
                } else expect(yield* fs.glob(pattern)).toEqual([`${root}/result.txt`])
              }
            }),
            host,
            root,
            windows
          )
          const prefixes = [root, `${root}${sep}src`, `${root}${sep}src${sep}literal.txt`]
          const resolutions = host.requests.flatMap((request) =>
            request.operation === "batch"
              ? request.requests.filter((member) => member.operation === "resolve").map((member) => member.path)
              : request.operation === "resolve"
              ? [request.path]
              : []
          )
          expect(resolutions).toEqual(prefixes.flatMap((prefix) => [prefix, prefix]))
          expect(host.grants).toEqual([
            `${root}${sep}**${sep}*.txt`,
            `${root}${sep}Source${sep}?[ab].{txt,md}`,
            `${root}${sep}Source${sep}literal.txt`
          ])
          const executed = host.requests.flatMap((request) =>
            request.operation === "glob"
              ? [request.pattern]
              : request.operation === "batch"
              ? request.requests.filter((member) => member.operation === "glob").map((member) => member.path)
              : []
          )
          expect(executed).toEqual([
            `${root}${sep}**${sep}*.txt`,
            `${root}${sep}src${sep}?[ab].{txt,md}`,
            `${root}${sep}src${sep}literal.txt`
          ])
        }))
    }
    for (const batched of [false, true]) {
      for (const escape of [false, true]) {
        it.effect(`refuses ${escape ? "outside" : "changed"} glob prefixes (${windows ? "Windows" : "POSIX"}, ${batched ? "batch" : "single"})`, () =>
          Effect.gen(function*() {
            const host = fixture(root)
            let target = escape ? `${windows ? "C:" : ""}${sep}outside` : `${root}${sep}before`
            host.setResolve((path) =>
              path.endsWith(`${sep}link`)
                ? { path, target }
                : { path, target: null }
            )
            host.setCheck(() => {
              target = `${root}${sep}after`
            })
            yield* provide(
              Effect.gen(function*() {
                const fs = yield* FileSystem.FileSystem
                const failure = batched
                  ? Result.getFailure(
                    (yield* Guarded.batch(fs)!.execute([
                      { operation: "glob", path: "link/**/*.txt", root }
                    ])).entries[0]!.result
                  )
                  : Option.some(yield* Effect.flip(fs.glob("link/**/*.txt")))
                const error = Option.getOrThrow(failure)
                expect(error.reason._tag).toBe("PermissionDenied")
                expect(error.message).toContain(escape ? "outside the workspace" : "no longer names")
              }),
              host,
              root,
              windows
            )
            expect(host.grants.length).toBe(escape ? 0 : 1)
            expect(host.requests.filter((request) =>
              request.operation === "glob" ||
              (request.operation === "batch" && request.requests.some((member) => member.operation !== "resolve"))
            ))
              .toEqual([])
          }))
      }
    }
    it.effect(`refuses a glob rooted outside the workspace without inspecting it (${windows ? "Windows" : "POSIX"})`, () =>
      Effect.gen(function*() {
        const host = fixture(root)
        yield* provide(
          Effect.gen(function*() {
            const fs = yield* FileSystem.FileSystem
            expect((yield* Effect.flip(fs.glob("**/*.txt", { root: "../outside" }))).message)
              .toContain("outside the workspace")
            const response = yield* Guarded.batch(fs)!.execute([
              { operation: "glob", path: "**/*.txt", root: "../outside" }
            ])
            expect(Option.getOrThrow(Result.getFailure(response.entries[0]!.result)).message)
              .toContain("outside the workspace")
          }),
          host,
          root,
          windows
        )
        expect(host.grants).toEqual([])
        expect(host.requests).toEqual([])
      }))
  }

  it.effect("keeps literal wildcard filenames as filename lookups in mixed batches", () =>
    Effect.gen(function*() {
      const root = "C:\\workspace"
      const host = fixture(root)
      yield* provide(
        Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          const response = yield* Guarded.batch(fs)!.execute([
            { operation: "stat", path: "*.txt" },
            { operation: "glob", path: "*.txt", root }
          ])
          const entries = [...response.entries].sort((a, b) => a.index - b.index)
          expect(Result.getFailure(entries[0]!.result).pipe(Option.getOrThrow).reason._tag).toBe("PermissionDenied")
          expect(Result.getOrThrow(entries[1]!.result).operation).toBe("glob")
          expect(host.grants).toEqual([`${root}\\*.txt`])
        }),
        host,
        root,
        true
      )
    }))
})

const fsRead = (resource: string, effect: "allow" | "deny" | "ask" = "allow") =>
  new Permission.Rule({ effect, pattern: new CapabilityPattern({ action: "fs:read", resource }) })

const refusal = (error: PlatformError.PlatformError) => {
  const denied = Option.getOrThrow(Permission.fromPlatformError(error))
  return "reason" in denied ? `${denied.capability.resource}: ${denied.reason}` : denied.code
}

/** Runs `body` over the fixture host with a real grant store, or with `store` in its place. */
const governed = <A, E>(
  body: Effect.Effect<A, E, FileSystem.FileSystem>,
  host: ReturnType<typeof fixture>,
  root: string,
  windows: boolean,
  store: ReadonlyArray<Permission.Rule> | GrantStore.Service
) =>
  Effect.gen(function*() {
    const grants = "check" in store ? store : yield* GrantStore.make({ attended: false, rules: store })
    return yield* body.pipe(
      Effect.provide(Guarded.layer),
      Effect.provideService(FileSystem.FileSystem, host.fs),
      Effect.provide(windows ? NodePath.layerWin32 : Path.layer),
      Effect.provideService(GrantStore.GrantStore, grants)
    )
  }).pipe(Effect.provide(Workspace.layer(root)), Effect.scoped)

const contentReason = "a deny or ask rule may select paths this pattern can match"

/** What reached the host globber, as single requests or batch members. */
const globbed = (host: ReturnType<typeof fixture>) =>
  host.requests.flatMap((request) =>
    request.operation === "glob"
      ? [request.pattern]
      : request.operation === "batch"
      ? request.requests.filter((member) => member.operation === "glob").map((member) => member.path)
      : []
  )

describe("glob content", () => {
  for (const windows of [false, true]) {
    const root = windows ? "C:\\workspace" : "/workspace"
    const sep = windows ? "\\" : "/"
    const under = (...segments: ReadonlyArray<string>) => [root, ...segments].join(sep)
    for (const batched of [false, true]) {
      const label = `${windows ? "Windows" : "POSIX"}, ${batched ? "batch" : "single"}`
      const glob = (pattern: string): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> =>
        Effect.flatMap(FileSystem.FileSystem, (fs) =>
          batched
            ? Effect.flatMap(
              Guarded.batch(fs)!.execute([{ operation: "glob", path: pattern, root }]),
              (response): Effect.Effect<void, PlatformError.PlatformError> => {
                const result = response.entries[0]!.result
                return Result.isFailure(result) ? Effect.fail(result.failure) : Effect.void
              }
            )
            : Effect.asVoid(fs.glob(pattern)))
      const refused = (pattern: string) => Effect.map(Effect.flip(glob(pattern)), refusal)

      it.effect(`refuses a pattern that can match under a denied subtree (${label})`, () =>
        Effect.gen(function*() {
          const host = fixture(root)
          yield* governed(
            Effect.gen(function*() {
              // No wildcard spelling lists the denied tree (#4643).
              for (const pattern of ["sec*/**", "**/*", "{secrets,x}/*", "?ecrets/*.key", "secrets/*.key"]) {
                expect(yield* refused(pattern)).toBe(`${under(...pattern.split("/"))}: ${contentReason}`)
              }
              expect(globbed(host)).toEqual([])
              // A pattern whose literal directory is provably outside the denied tree still runs.
              yield* glob("src/**/*.ts")
              // A pattern without a wildcard names one path, which the grant check decides.
              yield* glob("secrets")
              expect(globbed(host)).toEqual([under("src", "**", "*.ts"), under("secrets")])
            }),
            host,
            root,
            windows,
            [fsRead(under("**")), fsRead(under("secrets", "**"), "deny")]
          )
        }))

      it.effect(`refuses under an ask rule until a later allow covers the directory (${label})`, () =>
        Effect.gen(function*() {
          const host = fixture(root)
          yield* governed(
            Effect.gen(function*() {
              expect(yield* refused("**/*.md")).toBe(`${under("**", "*.md")}: ${contentReason}`)
              expect(yield* refused("drafts/*.md")).toBe(`${under("drafts", "*.md")}: ${contentReason}`)
              expect(globbed(host)).toEqual([])
              yield* glob("out/**/*.md")
              expect(globbed(host)).toEqual([under("out", "**", "*.md")])
            }),
            host,
            root,
            windows,
            [
              fsRead(under("**")),
              fsRead(under("drafts", "**"), "ask"),
              fsRead(under("out", "**"), "ask"),
              fsRead(under("out", "**"))
            ]
          )
        }))

      it.effect(`refuses a wildcard pattern when the policy cannot be read (${label})`, () =>
        Effect.gen(function*() {
          const host = fixture(root)
          yield* governed(
            Effect.gen(function*() {
              expect(yield* refused("src/*.ts")).toBe("store_closed")
              expect(globbed(host)).toEqual([])
              expect(host.grants).toEqual([])
            }),
            host,
            root,
            windows,
            { ...host.store, policy: Effect.fail(new Permission.GrantStoreError({ code: "store_closed" })) }
          )
        }))
    }
  }
})

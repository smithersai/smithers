/**
 * The standard file flows on a container something else runs, reached
 * through the transport a sealed host's `bash` uses.
 *
 * A benchmark's task container is started by the benchmark, not by a
 * provider, and the host reaches it only through `@smthrs/std/Container`.
 * `ContainerSandbox.existing` serves the session contract over that
 * transport, and these cases prove the unchanged std handlers read and change
 * the container's files and never the host's: as root and as an ordinary
 * user, with multi-byte text, and with the same refusals a host gives.
 */
import { NodeChildProcessSpawner, NodeFileSystem } from "@effect/platform-node"
import { ContainerSandbox, Sandbox } from "@smthrs/sandbox"
import { ApplyPatch, Container, Edit, Grep, Read, RemoteSearch, Search, Write } from "@smthrs/std"
import { Context, Effect, Layer, Path } from "effect"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import { execFileSync, spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { afterAll, describe, expect, it } from "vitest"
import { discover } from "./helpers/discover.ts"

const engineAvailable = discover("docker", ["info"]).status === 0
const missingEngine = engineAvailable ? undefined : "no container engine answers `docker info` on this host"
const image = "alpine:3.20"
const names = ["root", "user", "busybox", "gnu"].map((who) => `smthrs-existing-${process.pid}-${who}`)
/** A Debian userland: GNU find, tar, xargs and coreutils, against Alpine's BusyBox. */
const gnuImage = "postgres:18"

afterAll(() => {
  if (!engineAvailable) return
  for (const name of names) spawnSync("docker", ["rm", "--force", name], { stdio: "ignore" })
})

const platform = Layer.provideMerge(NodeChildProcessSpawner.layer, Layer.merge(NodeFileSystem.layer, Path.layer))

/** Runs a shell line in `name` as root, for setup and for reading what the flows left. */
const inside = (name: string, script: string): string =>
  execFileSync("docker", ["exec", "-u", "0", name, "sh", "-c", script], { encoding: "utf8" })

/** A running container whose `/work` holds a few files; `user` makes uid 1000 its default user. */
const start = (name: string, user?: string, from = image): void => {
  execFileSync("docker", [
    "run",
    "-d",
    "--name",
    name,
    "--network",
    "none",
    "--entrypoint",
    "sleep",
    ...(user === undefined ? [] : ["--user", user]),
    from,
    "600"
  ])
  inside(
    name,
    [
      "mkdir -p /work/src /locked",
      "printf 'café = \"naïve\"\\nrésumé = \"日本語 🎉\"\\nend = 1\\n' > /work/src/text.py",
      "printf 'a\\nb\\nc\\n' > /work/src/mode.sh && chmod 754 /work/src/mode.sh",
      "printf 'secret\\n' > /locked/secret.txt && chmod 600 /locked/secret.txt",
      "chown -R 1000:1000 /work"
    ].join(" && ")
  )
}

/** The host surface of `name` through the std transport, rooted at `/work`. */
const machine = (name: string) =>
  Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner
    const session = ContainerSandbox.existing({
      container: name,
      workdir: "/work",
      spawner,
      transport: Container.makeCommand()
    })
    return yield* Sandbox.hostContext(session)
  })

describe.skipIf(engineAvailable)("ContainerSandbox.existing against a real engine", () => {
  it(`is skipped because ${missingEngine ?? "this host runs a container engine"}`, () => {
    expect(missingEngine).toEqual(expect.any(String))
  })
})

describe.skipIf(!engineAvailable)("ContainerSandbox.existing against a real engine", () => {
  it("reads, edits and patches the container's files, never the host's", async () => {
    const name = names[0]!
    start(name)
    // The mode the engine's `exec` gave the file: its umask is 022 on Docker and 000 on OrbStack.
    const created = inside(name, "stat -c %a /work/src/text.py").trim()
    const outcome = await Effect.runPromise(
      Effect.gen(function*() {
        const services = yield* machine(name)
        const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.provide(effect, services as Context.Context<R>)
        const read = yield* run(Read.run({ path: "src/text.py" }))
        const edited = yield* run(Edit.run({ path: "src/text.py", oldString: "end = 1", newString: "end = 2" }))
        const patched = yield* run(ApplyPatch.run({
          input: [
            "*** Begin Patch",
            "*** Update File: src/text.py",
            "@@",
            " café = \"naïve\"",
            "-résumé = \"日本語 🎉\"",
            "+résumé = \"日本語 🎉🎉\"",
            "*** Add File: src/new.py",
            "+value = \"ü\"",
            "*** End Patch"
          ].join("\n")
        }))
        const mode = yield* run(Edit.run({ path: "/work/src/mode.sh", oldString: "b", newString: "B" }))
        return { read, edited, patched, mode }
      }).pipe(Effect.scoped, Effect.provide(platform))
    )
    expect(outcome.read).toEqual({
      content: "café = \"naïve\"\nrésumé = \"日本語 🎉\"\nend = 1",
      startLine: 1,
      endLine: 3,
      totalLines: 3,
      truncated: false
    })
    expect(outcome.edited).toMatchObject({ path: "src/text.py", replacements: 1, startLine: 1, endLine: 3 })
    expect(outcome.edited.hunk).toBe("café = \"naïve\"\nrésumé = \"日本語 🎉\"\nend = 2")
    expect(outcome.patched).toMatchObject({ added: ["src/new.py"], modified: ["src/text.py"], deleted: [] })
    expect(outcome.mode.hunk).toBe("a\nB\nc")
    expect(inside(name, "cat /work/src/text.py")).toBe("café = \"naïve\"\nrésumé = \"日本語 🎉🎉\"\nend = 2\n")
    expect(inside(name, "cat /work/src/new.py")).toBe("value = \"ü\"\n")
    // The edit replaced the file and kept its mode and owner.
    expect(inside(name, "stat -c '%a %u' /work/src/mode.sh /work/src/text.py")).toBe(`754 1000\n${created} 1000\n`)
    // Nothing reached this host under the container's paths.
    expect(existsSync("/work/src/new.py")).toBe(false)
  }, 120_000)

  it.each([["busybox", 2, image], ["gnu", 3, gnuImage]] as const)(
    "searches the container's tree with its %s userland",
    async (_userland, index, from) => {
      const name = names[index]!
      start(name, undefined, from)
      inside(
        name,
        [
          "mkdir -p /work/lib/.cache /work/build /work/node_modules/pkg",
          "printf 'build/\\n' > /work/.gitignore",
          "printf 'def needle():\\n    return \"ü\"\\n' > /work/lib/mod.py",
          "printf 'needle hidden\\n' > /work/lib/.cache/x.py",
          "printf 'needle built\\n' > /work/build/out.py",
          "printf 'needle dependency\\n' > /work/node_modules/pkg/index.js"
        ].join(" && ")
      )
      const found = await Effect.runPromise(
        Effect.gen(function*() {
          const services = yield* machine(name)
          const search = RemoteSearch.make(Context.pick(ChildProcessSpawner, Path.Path)(services))
          return yield* Grep.run({ pattern: "needle" }).pipe(Effect.provideService(Search.Search, search))
        }).pipe(Effect.scoped, Effect.provide(platform))
      )
      expect(found.matches).toEqual([{
        file: "lib/mod.py",
        line: 1,
        text: "def needle():",
        before: [],
        after: [],
        symbol: { kind: "def", name: "needle", startLine: 1, endLine: 2 }
      }])
      // Three files: the two `start` seeds and this one; ignored, hidden and dependency trees are out.
      expect(found).toMatchObject({ filesSearched: 3, skippedBinary: 0, truncated: false })
    },
    120_000
  )

  it("works as the container's ordinary user and refuses what that user may not touch", async () => {
    const name = names[1]!
    start(name, "1000:1000")
    const outcome = await Effect.runPromise(
      Effect.gen(function*() {
        const services = yield* machine(name)
        const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.provide(effect, services as Context.Context<R>)
        const written = yield* run(Write.run({ path: "src/made.txt", content: "fait à la main\n" }))
        const edited = yield* run(Edit.run({ path: "src/text.py", oldString: "end = 1", newString: "end = 3" }))
        const unreadable = yield* Effect.flip(run(Read.run({ path: "/locked/secret.txt" })))
        const unwritable = yield* Effect.flip(
          run(Edit.run({ path: "/locked/secret.txt", oldString: "secret", newString: "public" }))
        )
        const missing = yield* Effect.flip(run(Read.run({ path: "src/absent.py" })))
        const directory = yield* Effect.flip(run(Read.run({ path: "src" })))
        return { written, edited, unreadable, unwritable, missing, directory }
      }).pipe(Effect.scoped, Effect.provide(platform))
    )
    expect(outcome.written).toMatchObject({ path: "src/made.txt" })
    expect(outcome.edited.hunk).toContain("end = 3")
    expect(inside(name, "stat -c '%u:%g' /work/src/made.txt /work/src/text.py")).toBe("1000:1000\n1000:1000\n")
    expect(outcome.unreadable).toMatchObject({ code: "permission_denied", path: "/locked/secret.txt" })
    expect(outcome.unwritable).toMatchObject({ code: "permission_denied", path: "/locked/secret.txt" })
    expect(outcome.missing).toMatchObject({ code: "not_found", path: "src/absent.py" })
    expect(outcome.missing.message).toContain("File not found: src/absent.py")
    expect(outcome.directory).toMatchObject({ code: "is_directory", path: "src" })
    expect(inside(name, "cat /locked/secret.txt")).toBe("secret\n")
  }, 120_000)
})

import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { FlowEngine } from "@smthrs/engine"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import * as Target from "@smthrs/targets/Target"
import { Effect, FileSystem, Layer, Path as EffectPath, PlatformError } from "effect"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import * as Skills from "../../targets/src/Skills.ts"
import * as SkillsInstallRule from "../src/internal/rules/SkillsInstallRule.ts"
import { write } from "./helpers/WriteFile.ts"

const roots: Array<string> = []
const platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, NodeCrypto.layer)
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => Fs.rm(root, { recursive: true, force: true })))
})
const fixture = async () => {
  const root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smithers-project-skills-")))
  roots.push(root)
  return root
}
const skill = (name: string, body = "Follow the project procedure.") =>
  `---\nname: ${name}\ndescription: A project procedure.\n---\n${body}\n`

const request = (root = "Org/Skills", extra: Partial<SkillsInstallRule.Request> = {}): SkillsInstallRule.Request => ({
  library: { root },
  agents: ["claude", "codex"],
  ...extra
})
const runInstall = (root: string, home: string, attrs = request()) =>
  Effect.runPromise(SkillsInstallRule.install(attrs, { root, home }).pipe(Effect.provide(platform)))
const failedInstall = (root: string, home: string, attrs = request()) =>
  Effect.runPromise(Effect.flip(SkillsInstallRule.install(attrs, { root, home })).pipe(Effect.provide(platform)))
const installation = async () => {
  const root = await fixture()
  const home = await fixture()
  await write(root, "Org/Skills/release/SKILL.md", skill("release"))
  await write(root, "Org/Skills/audit/SKILL.md", skill("audit"))
  await write(root, "Org/Skills/release/scripts/run.sh", "echo release\n")
  return { root, home }
}

describe("Skills library and target declarations", () => {
  it("declares a frozen library and a run-only, uncached action plan", () => {
    const library = Skills.Library({ root: "./Org//Skills/" })
    expect(library.root).toBe("Org/Skills")
    expect(Object.isFrozen(library)).toBe(true)
    const target = Skills.Install({ library, agents: ["codex"], select: ["release"] })
    const metadata = Target.metadata(target)
    expect(metadata.target).toBe("Skills.Install")
    expect(metadata.kinds).toEqual(["run"])
    expect(metadata.verbGate).toEqual(["run"])
    expect(metadata.cacheable).toBe(false)
    expect(Target.plan(target)).toBeDefined()
    expect(metadata.attrs).toMatchObject({ library, agents: ["codex"], select: ["release"], deps: [] })
  })

  it.each(["", ".", "../Skills", "/tmp/skills", "C:\\skills", "Skills\u0000", "x".repeat(4097), 42])(
    "refuses unsafe library root %j",
    (root) => {
      expect(() => Skills.Library({ root: root as string })).toThrow(/Skills library root/)
    }
  )
})

describe("owned agent skill installation", () => {
  it("installs selected skills and resources to both agents and preserves unselected and foreign entries", async () => {
    const { root, home } = await installation()
    await write(home, ".agents/skills/personal/SKILL.md", "Personal instructions")
    const result = await runInstall(root, home, request("Org/Skills", { select: ["release", "release"] }))
    expect(result.installed).toEqual([
      Path.join(home, ".claude/skills/release"),
      Path.join(home, ".agents/skills/release")
    ])
    for (const directory of [".claude/skills", ".agents/skills"]) {
      expect(await Fs.readlink(Path.join(home, directory, "release"))).toBe(Path.join(root, "Org/Skills/release"))
      expect(await Fs.readFile(Path.join(home, directory, "release/scripts/run.sh"), "utf8")).toBe("echo release\n")
      await expect(Fs.lstat(Path.join(home, directory, "audit"))).rejects.toMatchObject({ code: "ENOENT" })
    }
    expect(await Fs.readFile(Path.join(home, ".agents/skills/personal/SKILL.md"), "utf8")).toBe("Personal instructions")
    expect(await runInstall(root, home, request("Org/Skills", { select: ["release"] }))).toEqual(result)
    await write(root, "Org/Skills/release/SKILL.md", skill("release", "Updated instructions"))
    expect(await Fs.readFile(Path.join(home, ".agents/skills/release/SKILL.md"), "utf8")).toContain(
      "Updated instructions"
    )
  })

  it("defaults to all skills, deduplicates agents and treats an empty selection as no work", async () => {
    const { root, home } = await installation()
    expect((await runInstall(root, home, request("Org/Skills", { agents: ["codex", "codex"] }))).installed)
      .toHaveLength(2)
    expect(await runInstall(root, home, request("Org/Skills", { select: [] }))).toEqual({ installed: [] })
    await expect(Fs.lstat(Path.join(home, ".claude"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it.each(["file", "directory", "symlink", "dangling", "same-source"])(
    "refuses a foreign %s before mutating any agent",
    async (kind) => {
      const { root, home } = await installation()
      const destination = Path.join(home, ".agents/skills/release")
      await Fs.mkdir(Path.dirname(destination), { recursive: true })
      if (kind === "file") await Fs.writeFile(destination, "foreign")
      else if (kind === "directory") await Fs.mkdir(destination)
      else await Fs.symlink(kind === "same-source" ? Path.join(root, "Org/Skills/release") : "/absent", destination)
      expect((await failedInstall(root, home)).message).toContain("foreign skill entry")
      expect((await Fs.lstat(destination)).isSymbolicLink()).toBe(!["file", "directory"].includes(kind))
      await expect(Fs.lstat(Path.join(home, ".claude"))).rejects.toMatchObject({ code: "ENOENT" })
    }
  )

  it("refuses to adopt a replaced owned entry or another library's receipt", async () => {
    const { root, home } = await installation()
    const attrs = request("Org/Skills", { agents: ["codex"], select: ["release"] })
    await runInstall(root, home, attrs)
    const destination = Path.join(home, ".agents/skills/release")
    await Fs.unlink(destination)
    await Fs.mkdir(destination)
    expect((await failedInstall(root, home, attrs)).message).toContain("foreign skill entry")
    await Fs.rm(destination, { recursive: true })
    await write(root, "Other/release/SKILL.md", skill("release"))
    expect((await failedInstall(root, home, request("Other", { agents: ["codex"] }))).message).toContain(
      "foreign skill ownership"
    )
    expect(await Fs.readdir(Path.join(home, ".agents/skills"))).toEqual([".smithers-project-skills"])
  })

  it.each([".agents", ".agents/skills", ".agents/skills/.smithers-project-skills"])(
    "refuses a destination symlink at %s",
    async (relative) => {
      const { root, home } = await installation()
      const outside = await fixture()
      const location = Path.join(home, relative)
      await Fs.mkdir(Path.dirname(location), { recursive: true })
      await Fs.symlink(outside, location)
      expect((await failedInstall(root, home, request("Org/Skills", { agents: ["codex"] }))).message).toContain(
        "symbolic link"
      )
      expect(await Fs.readdir(outside)).toEqual([])
    }
  )

  it.each(["", "../Skills", "/tmp/skills", "C:\\skills", "Skills\u0000"])(
    "refuses unsafe installation root %j",
    async (library) => {
      const { root, home } = await installation()
      expect((await failedInstall(root, home, request(library))).message).toContain("inside the workspace")
    }
  )

  it("refuses empty or unsupported agents, missing libraries, invalid skills, duplicates and unknown selections", async () => {
    const { root, home } = await installation()
    expect((await failedInstall(root, home, request("Org/Skills", { agents: [] }))).message).toContain(
      "supported agent"
    )
    expect((await failedInstall(root, home, request("Org/Skills", { agents: ["unknown" as "codex"] }))).message)
      .toContain("supported agent")
    expect((await failedInstall(root, home, request("Missing"))).message).toContain("could not be read")
    expect((await failedInstall(root, home, request("Org/Skills", { select: ["unknown"] }))).message).toContain(
      "unknown skill"
    )
    await write(root, "Invalid/bad/SKILL.md", "No metadata")
    expect((await failedInstall(root, home, request("Invalid"))).message).toContain("refused entries")
    await write(root, "Org/Skills/nested/release/SKILL.md", skill("release"))
    expect((await failedInstall(root, home)).message).toContain("unique portable skill names")
    expect(await Fs.readdir(home)).toEqual([])
  })

  it.each([0, 16])("resumes after a receipt write fails with %i bytes written", async (bytes) => {
    const { root, home } = await installation()
    const attrs = request("Org/Skills", { agents: ["codex"], select: ["release"] })
    const failure = await Effect.runPromise(
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const faulty = FileSystem.FileSystem.of({
          ...fs,
          writeFileString: (location, contents, options) =>
            fs.writeFileString(location, contents.slice(0, bytes), options).pipe(
              Effect.andThen(Effect.fail(PlatformError.systemError({
                _tag: "Unknown",
                module: "FileSystem",
                method: "writeFileString",
                cause: new Error("injected partial receipt write")
              })))
            )
        })
        return yield* Effect.flip(
          SkillsInstallRule.install(attrs, { root, home }).pipe(
            Effect.provideService(FileSystem.FileSystem, faulty)
          )
        )
      }).pipe(Effect.provide(platform))
    )
    expect(failure.message).toContain("existing entries were preserved")
    const directory = Path.join(home, ".agents/skills")
    await expect(Fs.lstat(Path.join(directory, "release"))).rejects.toMatchObject({ code: "ENOENT" })
    expect((await runInstall(root, home, attrs)).installed).toEqual([Path.join(directory, "release")])
    expect(await Fs.readFile(Path.join(directory, "release/SKILL.md"), "utf8")).toBe(skill("release"))
  })

  it.each(["receipt", "directory"])("resumes after %s durability fails before linking", async (stage) => {
    const { root, home } = await installation()
    const attrs = request("Org/Skills", { agents: ["codex"], select: ["release"] })
    const metadata = Path.join(home, ".agents/skills/.smithers-project-skills")
    const failure = await Effect.runPromise(
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const faulty = FileSystem.FileSystem.of({
          ...fs,
          open: (location, options) =>
            fs.open(location, options).pipe(Effect.map((file) => ({
              ...file,
              sync: (location === metadata) === (stage === "directory")
                ? Effect.fail(PlatformError.systemError({
                  _tag: "Unknown",
                  module: "FileSystem",
                  method: "sync",
                  cause: new Error("injected durability failure")
                }))
                : file.sync
            })))
        })
        return yield* Effect.flip(
          SkillsInstallRule.install(attrs, { root, home }).pipe(
            Effect.provideService(FileSystem.FileSystem, faulty)
          )
        )
      }).pipe(Effect.provide(platform))
    )
    expect(failure.message).toContain("existing entries were preserved")
    await expect(Fs.lstat(Path.join(home, ".agents/skills/release"))).rejects.toMatchObject({ code: "ENOENT" })
    if (stage === "receipt") {
      await expect(Fs.lstat(Path.join(metadata, "release.json"))).rejects.toMatchObject({ code: "ENOENT" })
    } else {
      expect(JSON.parse(await Fs.readFile(Path.join(metadata, "release.json"), "utf8"))).toMatchObject({
        version: 1,
        root,
        name: "release"
      })
    }
    expect((await runInstall(root, home, attrs)).installed).toEqual([Path.join(home, ".agents/skills/release")])
  })

  it("resumes after the skill link is created but its directory cannot be flushed", async () => {
    const { root, home } = await installation()
    const attrs = request("Org/Skills", { agents: ["codex"], select: ["release"] })
    const directory = Path.join(home, ".agents/skills")
    const destination = Path.join(directory, "release")
    const failure = await Effect.runPromise(
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const faulty = FileSystem.FileSystem.of({
          ...fs,
          open: (location, options) =>
            fs.open(location, options).pipe(Effect.map((file) => ({
              ...file,
              sync: location === directory
                ? fs.exists(destination).pipe(Effect.flatMap((exists) =>
                  exists
                    ? Effect.fail(PlatformError.systemError({
                      _tag: "Unknown",
                      module: "FileSystem",
                      method: "sync",
                      cause: new Error("injected post-link durability failure")
                    }))
                    : file.sync
                ))
                : file.sync
            })))
        })
        return yield* Effect.flip(
          SkillsInstallRule.install(attrs, { root, home }).pipe(
            Effect.provideService(FileSystem.FileSystem, faulty)
          )
        )
      }).pipe(Effect.provide(platform))
    )
    expect(failure.message).toContain("existing entries were preserved")
    expect(await Fs.readlink(destination)).toBe(Path.join(root, "Org/Skills/release"))
    expect((await runInstall(root, home, attrs)).installed).toEqual([destination])
  })

  it("refuses a foreign ownership receipt created during publication", async () => {
    const { root, home } = await installation()
    const attrs = request("Org/Skills", { agents: ["codex"], select: ["release"] })
    const marker = Path.join(home, ".agents/skills/.smithers-project-skills/release.json")
    const failure = await Effect.runPromise(
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const faulty = FileSystem.FileSystem.of({
          ...fs,
          link: (source, destination) =>
            fs.writeFileString(destination, "foreign", { flag: "wx" }).pipe(
              Effect.andThen(fs.link(source, destination))
            )
        })
        return yield* Effect.flip(
          SkillsInstallRule.install(attrs, { root, home }).pipe(
            Effect.provideService(FileSystem.FileSystem, faulty)
          )
        )
      }).pipe(Effect.provide(platform))
    )
    expect(failure.message).toContain("existing entries were preserved")
    expect(await Fs.readFile(marker, "utf8")).toBe("foreign")
    await expect(Fs.lstat(Path.join(home, ".agents/skills/release"))).rejects.toMatchObject({ code: "ENOENT" })
    expect((await failedInstall(root, home, attrs)).message).toContain("foreign skill ownership")
  })

  it("resumes after an injected host failure without adopting a foreign entry", async () => {
    const { root, home } = await installation()
    const attrs = request("Org/Skills", { agents: ["codex"], select: ["release"] })
    const failure = await Effect.runPromise(
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const faulty = FileSystem.FileSystem.of({
          ...fs,
          symlink: () =>
            Effect.fail(PlatformError.systemError({
              _tag: "PermissionDenied",
              module: "FileSystem",
              method: "symlink",
              cause: new Error("injected symlink failure")
            }))
        })
        return yield* Effect.flip(
          SkillsInstallRule.install(attrs, { root, home }).pipe(
            Effect.provideService(FileSystem.FileSystem, faulty)
          )
        )
      }).pipe(Effect.provide(platform))
    )
    expect(failure.message).toContain("existing entries were preserved")
    expect((await runInstall(root, home, attrs)).installed).toHaveLength(1)
    const otherHome = await fixture()
    const generic = await Effect.runPromise(
      Effect.flip(SkillsInstallRule.install(attrs, { root, home: Path.join(otherHome, "absent") })).pipe(
        Effect.provide(platform)
      )
    )
    expect(generic).toMatchObject({
      _tag: "SkillsInstallError",
      message: expect.stringContaining("existing entries were preserved")
    })
  })

  it("executes the target as a durable action with the real host filesystem", async () => {
    const { root, home } = await installation()
    const target = Skills.Install({
      library: Skills.Library({ root: "Org/Skills" }),
      agents: ["codex"],
      select: ["audit"]
    })
    const flow = Flow.make("project-skills-test", {
      payload: {},
      success: Skills.InstallResult,
      error: Skills.InstallError,
      body: () => Target.plan(target)
    })
    const runtime = Layer.mergeAll(
      Skills.InstallAction.toLayer((attrs) => SkillsInstallRule.install(attrs, { root, home })),
      Interpreter.layer(flow)
    ).pipe(
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(FlowEngine.layerMemory),
      Layer.provideMerge(platform)
    )
    const result = await Effect.runPromise(
      flow.execute({}, { executionId: "install-project-skills" }).pipe(Effect.provide(runtime))
    )
    expect(result.installed).toEqual([Path.join(home, ".agents/skills/audit")])
    expect(await Fs.readFile(Path.join(home, ".agents/skills/audit/SKILL.md"), "utf8")).toContain(
      "A project procedure."
    )
  })
})

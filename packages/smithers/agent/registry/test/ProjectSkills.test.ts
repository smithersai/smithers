import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { Effect, FileSystem, Layer, Path as EffectPath } from "effect"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import * as Discovery from "../src/Discovery.ts"
import * as Registry from "../src/Registry.ts"

const roots: Array<string> = []
const platform = Layer.merge(NodeFileSystem.layer, NodePath.layer)
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => Fs.rm(root, { recursive: true, force: true })))
})
const fixture = async () => {
  const root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smithers-project-skills-")))
  roots.push(root)
  return root
}
const write = async (root: string, relative: string, text: string) => {
  const file = Path.join(root, relative)
  await Fs.mkdir(Path.dirname(file), { recursive: true })
  await Fs.writeFile(file, text)
}
const skill = (name: string, body = "Follow the project procedure.") =>
  `---\nname: ${name}\ndescription: A project procedure.\n---\n${body}\n`

describe("declared project skill libraries", () => {
  it("discovers external skill roots, preserving project flow precedence and refresh", async () => {
    const root = await fixture()
    await write(root, "Org/Skills/release/SKILL.md", skill("release", "Library release."))
    await write(root, "Org/Skills/audit/SKILL.md", skill("audit", "Library audit."))
    await write(root, ".smithers/flows/release/flow.mdx", skill("release", "Project release."))
    await Effect.runPromise(
      Effect.gen(function*() {
        const registry = yield* Registry.Registry
        expect((yield* registry.list()).map((entry) => entry.name)).toEqual(["release", "audit"])
        const release = yield* registry.loadBody("release")
        expect(release).toMatchObject({ _tag: "Prompt" })
        if (release._tag === "Prompt") expect(release.text).toContain("Project release.")
        expect((yield* registry.warnings()).some((item) => item.code === "duplicate_name")).toBe(true)
        yield* Effect.promise(() => write(root, "Org/Skills/new-skill/SKILL.md", skill("new-skill")))
        yield* registry.refresh()
        expect((yield* registry.list()).map((entry) => entry.name)).toContain("new-skill")
      }).pipe(
        Effect.provide(Registry.layerProject({ root, skills: [{ root: "Org/Skills" }] })),
        Effect.provide(platform)
      )
    )
  })
})

describe("project skill discovery boundaries", () => {
  it("reads only SKILL.md from libraries, validates metadata and directory names", async () => {
    const root = await fixture()
    await write(root, "Skills/good/SKILL.md", skill("good"))
    await write(root, "Skills/good/flow.mdx", "No flow metadata.")
    await write(root, "Skills/code-only/flow.ts", "throw new Error('must never execute')")
    await write(root, "Skills/bad/SKILL.md", "---\nname: bad\n---\nMissing description")
    await write(root, "Skills/different/SKILL.md", skill("wrong"))
    const scan = await Effect.runPromise(
      Effect.gen(function*() {
        return yield* Discovery.make(yield* FileSystem.FileSystem, yield* EffectPath.Path).scan({
          source: "skills",
          root: Path.join(root, "Skills"),
          naming: "frontmatter",
          skills: true,
          confinementRoot: root
        })
      }).pipe(Effect.provide(platform))
    )
    expect(scan.entries.map((entry) => entry.name)).toEqual(["good"])
    expect(scan.warnings.map((item) => item.code)).toEqual([
      "frontmatter_parse_error",
      "frontmatter_parse_error",
      "unprojectable_authority"
    ])
  })

  it("keeps invalid YAML tokens out of public skill warnings", async () => {
    const root = await fixture()
    await write(
      root,
      "Skills/private/SKILL.md",
      "---\nname: private\ndescription: !B18_PRIVATE_SENTINEL!foo value\n---\nProcedure.\n"
    )
    await Effect.runPromise(
      Effect.gen(function*() {
        const registry = yield* Registry.Registry
        expect(yield* registry.list()).toEqual([])
        const warnings = yield* registry.warnings()
        expect(warnings.map((item) => item.code)).toContain("frontmatter_parse_error")
        expect(JSON.stringify(warnings)).not.toContain("B18_PRIVATE_SENTINEL")
      }).pipe(Effect.provide(Registry.layerProject({ root, skills: ["Skills"] })), Effect.provide(platform))
    )
  })

  // R1-Fable-D2-057: the project flow source is confined to the project root.
  it("refuses a project flow directory linked from outside the project", async () => {
    const root = await fixture()
    const outside = await fixture()
    await write(outside, "host/flow.mdx", "---\ndescription: A host directory's text.\n---\nHost body.\n")
    await write(root, ".smithers/flows/local/flow.mdx", "---\ndescription: A project flow.\n---\nLocal body.\n")
    await Fs.symlink(Path.join(outside, "host"), Path.join(root, ".smithers", "flows", "x"))
    await Effect.runPromise(
      Effect.gen(function*() {
        const registry = yield* Registry.Registry
        expect((yield* registry.list()).map((entry) => entry.name)).toEqual(["local"])
        const refused = (yield* registry.warnings()).filter((item) => item.code === "outside_root")
        expect(refused.map((item) => item.path)).toEqual([Path.join(root, ".smithers", "flows", "x")])
        expect(JSON.stringify(yield* registry.warnings())).not.toContain("A host directory's text.")
      }).pipe(Effect.provide(Registry.layerProject({ root })), Effect.provide(platform))
    )
  })

  it("refuses a project flows directory that is itself a link out of the project", async () => {
    const root = await fixture()
    const outside = await fixture()
    await write(outside, "host/flow.mdx", "---\ndescription: A host directory's text.\n---\nHost body.\n")
    await Fs.mkdir(Path.join(root, ".smithers"))
    await Fs.symlink(outside, Path.join(root, ".smithers", "flows"))
    await Effect.runPromise(
      Effect.gen(function*() {
        const registry = yield* Registry.Registry
        expect(yield* registry.list()).toEqual([])
        expect((yield* registry.warnings()).map((item) => item.code)).toEqual(["outside_root"])
      }).pipe(Effect.provide(Registry.layerProject({ root })), Effect.provide(platform))
    )
  })

  // R1-Fable-D2-059: a pack or a skill library that leaves `capabilities` out
  // receives none; a project's own flow keeps the documented wildcard.
  it("defaults undeclared capabilities to none for packs and skill libraries, and to all for project flows", async () => {
    const root = await fixture()
    const packDir = await fixture()
    await write(root, ".smithers/flows/own/flow.mdx", "---\ndescription: A project flow.\n---\nOwn body.\n")
    await write(root, "Skills/library/SKILL.md", skill("library"))
    await write(packDir, "flows/packed/flow.mdx", "---\ndescription: A pack flow.\n---\nPacked body.\n")
    await write(
      packDir,
      "flows/declared/flow.mdx",
      "---\ndescription: A pack flow.\ncapabilities: [\"fs:read:**\"]\n---\nDeclared body.\n"
    )
    await Effect.runPromise(
      Effect.gen(function*() {
        const registry = yield* Registry.Registry
        const capabilities = Object.fromEntries(
          (yield* registry.list()).map((entry) => [entry.name, entry.capabilities])
        )
        expect(capabilities).toEqual({ own: ["*"], library: [], declared: ["fs:read:**"], packed: [] })
        const silent = (yield* registry.warnings()).filter((item) => item.code === "unprojectable_authority")
        expect(silent.map((item) => [Path.basename(Path.dirname(item.path)), item.message.includes("no capability")]))
          .toEqual([["own", false], ["library", true], ["packed", true]])
      }).pipe(
        Effect.provide(Registry.layerProject({
          root,
          skills: ["Skills"],
          packs: {
            runtimeVersion: "1.0.0-rc.0",
            installed: [{
              dir: packDir,
              origin: "installed",
              manifest: { name: "acme/review", version: "1.0.0", flows: ["flows"] } as never
            }]
          }
        })),
        Effect.provide(platform)
      )
    )
  })

  it("refuses library links escaping the project", async () => {
    const root = await fixture()
    const outside = await fixture()
    await write(outside, "release/SKILL.md", skill("release"))
    await Fs.symlink(outside, Path.join(root, "Skills"))
    await Effect.runPromise(
      Effect.gen(function*() {
        const registry = yield* Registry.Registry
        expect(yield* registry.list()).toEqual([])
        expect((yield* registry.warnings()).map((item) => item.code)).toContain("outside_root")
      }).pipe(Effect.provide(Registry.layerProject({ root, skills: ["Skills"] })), Effect.provide(platform))
    )
  })

  it.each(["", "/tmp/skills", "C:\\skills", "../Skills", "Skills/../private", "Skills\u0000", "Skills\u007f", 42])(
    "refuses unsafe project skill root %j",
    async (root) => {
      await Effect.runPromise(
        Effect.gen(function*() {
          const path = yield* EffectPath.Path
          expect(() => Registry.projectSources(path, { root: "/project", skills: [root as string] })).toThrow(
            /workspace-relative/
          )
        }).pipe(Effect.provide(platform))
      )
    }
  )
})

it("keeps ordinary flow precedence when a host explicitly disables skill-only discovery", async () => {
  const root = await fixture()
  await write(root, "good/SKILL.md", skill("good"))
  await write(root, "good/flow.mdx", skill("good", "Preferred flow."))
  const source = { source: "ordinary", root, naming: "frontmatter" as const, skills: false }
  const scan = await Effect.runPromise(
    Effect.gen(function*() {
      return yield* Discovery.make(yield* FileSystem.FileSystem, yield* EffectPath.Path).scan(source)
    }).pipe(Effect.provide(platform))
  )
  expect(scan.entries.map((entry) => entry.path)).toEqual([Path.join(root, "good/flow.mdx")])
  expect(scan.warnings.map((item) => item.code)).toContain("multiple_entry_files")
})

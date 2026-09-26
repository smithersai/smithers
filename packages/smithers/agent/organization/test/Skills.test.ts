import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as Skills from "../src/Skills.ts"
import { err, exampleDir, flip, flipWith, ok, run, tempDir } from "./support.ts"

const skillText = (fields: string, body = "Do the thing.\n"): string => `---\n${fields}\n---\n\n${body}`

const valid = "name: review\ndescription: Review a change.\nlicense: MIT"

const refusal = (text: string, directory = "review") => {
  const failure = err(Skills.parseSkill(directory, text))
  return { code: failure.code, field: failure.field, path: failure.path }
}

describe("Skills.parseSkill", () => {
  it("parses a skill with every optional field and keeps scalars as strings", () => {
    const text = skillText(
      `${valid}\ncompatibility: Any model.\nallowed-tools: Read Grep\nmetadata:\n  adapted: "true"\n  source: example/skills\n  revision: 1234`,
      "Body text.\n"
    )
    const skill = ok(Skills.parseSkill("review", text))
    expect(skill).toMatchObject({
      name: "review",
      description: "Review a change.",
      license: "MIT",
      compatibility: "Any model.",
      allowedTools: "Read Grep",
      metadata: { adapted: "true", source: "example/skills", revision: "1234" },
      body: "\nBody text.\n",
      path: "review/SKILL.md"
    })
    expect(skill.revision).toMatch(/^[0-9a-f]{64}$/)
    expect(Object.isFrozen(skill.metadata)).toBe(true)
    const minimal = ok(Skills.parseSkill("review", skillText(valid)))
    expect(minimal.metadata).toEqual({})
    expect("compatibility" in minimal).toBe(false)
    expect("allowedTools" in minimal).toBe(false)
  })

  it("accepts every allowed license and refuses anything else", () => {
    for (const license of [...Skills.allowedLicenses, "LicenseRef-Acme-Private"]) {
      expect(ok(Skills.parseSkill("review", skillText(`name: review\ndescription: x\nlicense: ${license}`))).license)
        .toBe(license)
    }
    for (const license of ["GPL-3.0", "mit", "Proprietary", "{a: b}", "LicenseRef-", "LicenseRef-a b"]) {
      expect(refusal(skillText(`name: review\ndescription: x\nlicense: ${license}`))).toEqual({
        code: "license",
        field: "license",
        path: "review/SKILL.md"
      })
    }
    expect(refusal(skillText("name: review\ndescription: x")).code).toBe("license")
  })

  it("requires an adapted skill to record its source and revision", () => {
    const adapted = (extra: string) => skillText(`${valid}\nmetadata:\n  adapted: "true"${extra}`)
    expect(refusal(adapted("")).code).toBe("provenance")
    expect(refusal(adapted("\n  source: upstream")).code).toBe("provenance")
    expect(refusal(adapted("\n  revision: abc")).code).toBe("provenance")
    expect(refusal(adapted("\n  source: \"\"\n  revision: abc")).code).toBe("provenance")
    expect(ok(Skills.parseSkill("review", adapted("\n  source: upstream\n  revision: abc"))).metadata.adapted).toBe(
      "true"
    )
    expect(ok(Skills.parseSkill("review", skillText(`${valid}\nmetadata:\n  adapted: "false"`))).metadata.adapted).toBe(
      "false"
    )
  })

  it("refuses malformed frontmatter and fields by name, never by value", () => {
    const secret = "xoxb-000-secret"
    const cases: ReadonlyArray<readonly [string, string, string | undefined]> = [
      ["no frontmatter", "frontmatter", undefined],
      ["---\nname: [unclosed\n---\n", "frontmatter", undefined],
      ["---\n- a list\n---\n", "frontmatter", undefined],
      [skillText(`${valid}\nsecret: ${secret}`), "unknown-key", "secret"],
      [skillText("name: {a: b}\ndescription: x\nlicense: MIT"), "name", "name"],
      [skillText("name: Review\ndescription: x\nlicense: MIT"), "name", "name"],
      [skillText(`name: ${"a".repeat(65)}\ndescription: x\nlicense: MIT`), "name", "name"],
      [skillText("name: other\ndescription: x\nlicense: MIT"), "name", "name"],
      [skillText("name: review\nlicense: MIT"), "description", "description"],
      [skillText("name: review\ndescription: \"  \"\nlicense: MIT"), "description", "description"],
      [skillText(`name: review\ndescription: ${"d".repeat(1025)}\nlicense: MIT`), "description", "description"],
      [skillText(`${valid}\ncompatibility: {a: b}`), "metadata", "compatibility"],
      [skillText(`${valid}\ncompatibility: ${"c".repeat(501)}`), "metadata", "compatibility"],
      [skillText(`${valid}\nallowed-tools: [Read]`), "metadata", "allowed-tools"],
      [skillText(`${valid}\nmetadata: flat`), "metadata", "metadata"],
      [skillText(`${valid}\nmetadata: [a]`), "metadata", "metadata"],
      [skillText(`${valid}\nmetadata:\n  nested: {a: b}`), "metadata", "metadata"]
    ]
    for (const [text, code, field] of cases) {
      const failure = err(Skills.parseSkill("review", text))
      expect({ code: failure.code, field: failure.field }, text).toEqual({ code, field })
      expect(failure.message).not.toContain(secret)
    }
  })
})

describe("Skills.loadPack", () => {
  const pack = (skills: Record<string, string>): string => {
    const dir = tempDir()
    for (const [name, text] of Object.entries(skills)) {
      mkdirSync(join(dir, name))
      writeFileSync(join(dir, name, "SKILL.md"), text)
    }
    return dir
  }
  const skillFor = (name: string) => skillText(`name: ${name}\ndescription: ${name}.\nlicense: MIT`)

  it("loads the fixture pack in name order with a stable revision", async () => {
    const loaded = await run(Skills.loadPack(join(exampleDir, "Skills")))
    expect([...loaded.skills.keys()]).toEqual(["code-review", "debug", "research"])
    expect(loaded.revision).toBe(Skills.revisionOf([...loaded.skills.values()].reverse()))
    expect((await run(Skills.loadPack(join(exampleDir, "Skills")))).revision).toBe(loaded.revision)
    expect(loaded.skills.get("research")!.path).toBe("research/SKILL.md")
    const research = loaded.skills.get("research")!
    expect(Skills.revisionOf([research, research])).not.toBe(Skills.revisionOf([research]))
  })

  it("ignores hidden entries and files beside the skills", async () => {
    const dir = pack({ alpha: skillFor("alpha") })
    mkdirSync(join(dir, ".hidden"))
    writeFileSync(join(dir, ".hidden", "SKILL.md"), "not a skill")
    writeFileSync(join(dir, "PINS.md"), "pins")
    writeFileSync(join(dir, "NOTICE"), "notice")
    const loaded = await run(Skills.loadPack(dir))
    expect([...loaded.skills.keys()]).toEqual(["alpha"])
  })

  it("changes the revision when any skill byte changes", async () => {
    const before = await run(Skills.loadPack(pack({ alpha: skillFor("alpha"), beta: skillFor("beta") })))
    const after = await run(Skills.loadPack(pack({ alpha: skillFor("alpha"), beta: `${skillFor("beta")} ` })))
    expect(after.skills.get("alpha")!.revision).toBe(before.skills.get("alpha")!.revision)
    expect(after.revision).not.toBe(before.revision)
  })

  it("refuses a missing SKILL.md, a non-file SKILL.md, an oversize skill, and a bad skill", async () => {
    const missing = pack({})
    mkdirSync(join(missing, "empty"))
    expect(await flip(Skills.loadPack(missing))).toMatchObject({ code: "read", path: "empty/SKILL.md" })

    const directory = pack({})
    mkdirSync(join(directory, "odd", "SKILL.md"), { recursive: true })
    expect(await flip(Skills.loadPack(directory))).toMatchObject({ code: "read", message: "is not a regular file" })

    const large = pack({ big: skillText("name: big\ndescription: x\nlicense: MIT", "x".repeat(Skills.maxSkillBytes)) })
    expect(await flip(Skills.loadPack(large))).toMatchObject({ code: "too-large", path: "big/SKILL.md" })

    const bad = pack({ bad: skillText("name: bad\ndescription: x\nlicense: GPL-3.0") })
    expect(await flip(Skills.loadPack(bad))).toMatchObject({ code: "license", path: "bad/SKILL.md" })

    expect(await flip(Skills.loadPack(join(tempDir(), "absent")))).toMatchObject({ code: "read", path: "." })
  })

  it("refuses symlinks that leave the pack", async () => {
    const outside = pack({ loose: skillFor("loose") })
    const linkedDirectory = pack({})
    symlinkSync(join(outside, "loose"), join(linkedDirectory, "loose"))
    expect(await flip(Skills.loadPack(linkedDirectory))).toMatchObject({ code: "confinement", path: "loose" })

    const linkedFile = pack({})
    mkdirSync(join(linkedFile, "loose"))
    symlinkSync(join(outside, "loose", "SKILL.md"), join(linkedFile, "loose", "SKILL.md"))
    expect(await flip(Skills.loadPack(linkedFile))).toMatchObject({ code: "confinement", path: "loose/SKILL.md" })

    const dangling = pack({})
    symlinkSync(join(outside, "absent"), join(dangling, "ghost"))
    expect(await flip(Skills.loadPack(dangling))).toMatchObject({ code: "read", path: "ghost" })

    // A link that stays inside the pack is followed.
    const inside = pack({ alpha: skillFor("alpha") })
    mkdirSync(join(inside, "beta"))
    writeFileSync(join(inside, "beta.md"), skillFor("beta"))
    symlinkSync(join(inside, "beta.md"), join(inside, "beta", "SKILL.md"))
    expect([...(await run(Skills.loadPack(inside))).skills.keys()]).toEqual(["alpha", "beta"])
  })

  it("reports an unreadable skill without its contents", async () => {
    const dir = pack({ alpha: skillFor("alpha") })
    const file = join(dir, "alpha", "SKILL.md")
    chmodSync(file, 0o000)
    try {
      expect(await flip(Skills.loadPack(dir))).toMatchObject({ code: "read", path: "alpha/SKILL.md" })
    } finally {
      chmodSync(file, 0o644)
      rmSync(dir, { recursive: true })
    }
  })

  it("maps every filesystem failure to a read error", async () => {
    const dir = pack({ alpha: skillFor("alpha") })
    const cases: ReadonlyArray<readonly [string, (method: string, path: string) => boolean, string]> = [
      ["listing", (method) => method === "readDirectory", "."],
      ["directory stat", (method, path) => method === "stat" && path.endsWith("alpha"), "alpha"],
      ["exists", (method) => method === "exists", "alpha/SKILL.md"],
      ["file stat", (method, path) => method === "stat" && path.endsWith("SKILL.md"), "alpha/SKILL.md"]
    ]
    for (const [label, fault, path] of cases) {
      expect(await flipWith(Skills.loadPack(dir), fault), label).toMatchObject({ code: "read", path })
    }
  })
})

describe("Skills.select", () => {
  it("returns pinned texts in the requested order and refuses a missing name", async () => {
    const loaded = await run(Skills.loadPack(join(exampleDir, "Skills")))
    const selected = ok(Skills.select(loaded, ["research", "debug"]))
    expect(selected.map((skill) => skill.name)).toEqual(["research", "debug"])
    expect(selected[0]).toEqual({
      name: "research",
      revision: loaded.skills.get("research")!.revision,
      text: loaded.skills.get("research")!.body
    })
    expect(err(Skills.select(loaded, ["research", "absent"]))).toMatchObject({
      code: "missing",
      path: "absent/SKILL.md"
    })
  })
})

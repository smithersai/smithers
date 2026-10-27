import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { register } from "../src/internal/RetiredSkills.ts"

const roots: Array<string> = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const legacy = "---\nname: smthrs-create-app\nrequires_bin: smthrs\ncommand: smthrs create-app\n---\n"
const fixture = async (contents?: string) => {
  const home = await mkdtemp(join(tmpdir(), "smithers-retired-skills-"))
  roots.push(home)
  const data = join(home, "data")
  const meta = join(data, "incur/smthrs.json")
  const skill = join(home, ".agents/skills/smthrs-create-app/SKILL.md")
  if (contents !== undefined) {
    await mkdir(dirname(skill), { recursive: true })
    await writeFile(skill, contents)
  }
  return { home, data, meta, skill }
}

it.each([undefined, "# A custom skill", legacy.replace("command: smthrs create-app", "command: custom")])(
  "preserves absent and custom skills without creating metadata: %s",
  async (contents) => {
    const { home, data, meta } = await fixture(contents)
    await register(home, data)
    await expect(readFile(meta)).rejects.toMatchObject({ code: "ENOENT" })
  }
)

it("adopts an orphaned generated skill with missing metadata, including CRLF headers", async () => {
  const { home, data, meta, skill } = await fixture(legacy.replaceAll("\n", "\r\n"))
  await register(home, data)
  expect(JSON.parse(await readFile(meta, "utf8"))).toEqual({ skills: ["smthrs-create-app"] })
  expect(await readFile(skill, "utf8")).toBe(legacy.replaceAll("\n", "\r\n"))
})

it.each([{ skills: undefined }, { skills: ["current"] }, { skills: "invalid" }])(
  "retains unrelated metadata when adopting a legacy generated skill: %j",
  async (previous) => {
    const { home, data, meta } = await fixture(legacy)
    await mkdir(dirname(meta), { recursive: true })
    await writeFile(meta, JSON.stringify({ hash: "old", paths: ["kept"], ...previous }))
    await register(home, data)
    expect(JSON.parse(await readFile(meta, "utf8"))).toEqual({
      hash: "old",
      paths: ["kept"],
      skills: [...(Array.isArray(previous.skills) ? previous.skills : []), "smthrs-create-app"]
    })
    const once = await readFile(meta, "utf8")
    await register(home, data)
    expect(await readFile(meta, "utf8")).toBe(once)
  }
)

it("reports an unreadable skill path without rewriting metadata", async () => {
  const { home, data, skill } = await fixture(legacy)
  await rm(skill)
  await mkdir(skill)
  await expect(register(home, data)).rejects.toMatchObject({ code: "EISDIR" })
})

it.each(["{broken", "null", "false", "[]", "{\"skills\":[\"current\",42]}"])(
  "recovers invalid legacy metadata before the ordinary sync: %s",
  async (source) => {
    const { home, data, meta } = await fixture(legacy)
    await mkdir(dirname(meta), { recursive: true })
    await writeFile(meta, source)
    await register(home, data)
    expect(JSON.parse(await readFile(meta, "utf8"))).toEqual({
      skills: source.includes("current") ? ["current", "smthrs-create-app"] : ["smthrs-create-app"]
    })
  }
)

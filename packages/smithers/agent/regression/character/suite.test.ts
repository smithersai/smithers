import { describe, expect, test } from "bun:test"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parse, stringify } from "yaml"
import * as Suite from "./suite.ts"
import * as Profile from "./profile.ts"
import * as World from "./world.ts"

describe("runLabel", () => {
  test("keeps a plain label and refuses one that leaves results/", () => {
    expect(Suite.runLabel("before-v2.1")).toBe("before-v2.1")
    for (const bad of ["../../x", "a/b", "..", ".", "", "a\\\\b"]) expect(() => Suite.runLabel(bad)).toThrow()
  })
})

describe("suite path containment", () => {
  const example = join(import.meta.dirname, "example")
  const withSuite = (body: (dir: string, raw: any) => void) => {
    const root = mkdtempSync(join(tmpdir(), "suite-paths-"))
    try {
      const dir = join(root, "suite")
      cpSync(example, dir, { recursive: true })
      const raw = parse(readFileSync(join(dir, "suite.yaml"), "utf8"))
      body(dir, raw)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }

  for (const field of ["profile", "org", "world", "calibration", "jargon"]) {
    for (const escape of ["parent", "absolute", "symlink"]) {
      test(`${field} refuses a ${escape} path outside the suite`, () => withSuite((dir, raw) => {
        const outside = join(dir, "..", "outside")
        // A YAML file also works as an org/world path for the loader: no read
        // should happen before it rejects the path.
        writeFileSync(outside, "[]")
        if (escape === "symlink") symlinkSync(outside, join(dir, "link"))
        const value = escape === "parent" ? "../outside"
          : escape === "absolute" ? outside : "link"
        if (field === "jargon") raw.voice.jargon = [value]
        else raw[field] = value
        writeFileSync(join(dir, "suite.yaml"), stringify(raw))
        expect(() => Suite.load(dir)).toThrow("must stay inside the suite directory")
      }))
    }
  }

  for (const file of [
    "org/Skills/voice/SKILL.md",
    "org/Common Operating Instructions.md",
    "world/world.yaml",
    "cases/answer-with-link.yaml",
    "suite.yaml"
  ]) {
    test(`refuses a nested symlink at ${file} before reading it`, () => withSuite((dir) => {
      const target = join(dir, file)
      const outside = join(dir, "..", "outside-file")
      // Valid content ensures refusal proves containment, rather than parsing.
      writeFileSync(outside, readFileSync(target))
      rmSync(target)
      symlinkSync(outside, target)
      expect(() => {
        const suite = Suite.load(dir)
        Profile.compose({ org: suite.org, role: suite.role, profile: suite.profile, suiteRoot: suite.dir })
        World.load(suite.world, {}, suite.dir)
      }).toThrow("must stay inside the suite directory")
    }))
  }

  test("accepts contained relative, absolute and normalized sibling paths", () => withSuite((dir, raw) => {
    mkdirSync(join(dir, "words"))
    writeFileSync(join(dir, "words/list.yaml"), "- jargon")
    writeFileSync(join(dir, "calibration.yaml"), "[]")
    raw.profile = "flows/assistant/../assistant/flow.mdx"
    raw.org = join(dir, "org")
    raw.calibration = "./calibration.yaml"
    raw.voice.jargon = ["words/list.yaml"]
    raw.voice.terms = []
    writeFileSync(join(dir, "suite.yaml"), stringify(raw))
    const suite = Suite.load(dir)
    expect(suite.profile).toBe(join(dir, "flows/assistant/flow.mdx"))
    expect(suite.org).toBe(join(dir, "org"))
    expect(suite.calibration).toBe(join(dir, "calibration.yaml"))
    expect(suite.voice.jargon).toEqual(["jargon"])
  }))

  test("a missing contained calibration file stays optional", () => withSuite((dir, raw) => {
    raw.calibration = "./missing.yaml"
    writeFileSync(join(dir, "suite.yaml"), stringify(raw))
    expect(Suite.load(dir).calibration).toBeUndefined()
  }))
})

/**
 * The freshness rule the Lean differential suite stands on (`./LeanOracle.ts`), on real directories: an oracle is
 * evidence only for the exact source tree it was built from, and a tree that cannot all be seen is evidence for
 * nothing.
 */
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as LeanOracle from "./LeanOracle.ts"

describe("LeanOracle", () => {
  let directory: string
  let specification: LeanOracle.Specification

  const write = (file: string, text: string) => {
    const path = join(directory, file)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, text)
  }

  /** Stands in for `lake build`: an oracle, and the manifest of the sources it was made from. */
  const build = () => {
    const current = LeanOracle.sources(specification)
    if (current._tag !== "Complete") throw new Error(`incomplete: ${current.missing.join(", ")}`)
    write(".lake/build/bin/spec", "oracle")
    LeanOracle.record(specification, current)
  }

  /** Stamps the oracle and its manifest far in the future, as a copy from another checkout would be. */
  const touchOracle = () => {
    const future = new Date(Date.now() + 86_400_000)
    utimesSync(specification.binary, future, future)
    utimesSync(LeanOracle.manifestPath(specification), future, future)
  }

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "lean-oracle-"))
    specification = {
      directory,
      binary: join(directory, ".lake", "build", "bin", "spec"),
      required: ["Main.lean", "Spec.lean", "lakefile.toml", "lean-toolchain"],
      library: "Spec"
    }
    write("Main.lean", "import Lean.Data.Json\nimport Spec\n")
    write("Spec.lean", "import Spec.Basic\nimport Spec.Deep.Inner\n")
    write("Spec/Basic.lean", "def one := 1\n")
    write("Spec/Deep/Inner.lean", "import Spec.Basic\ndef two := 2\n")
    write("lakefile.toml", "name = \"spec\"\n")
    write("lean-toolchain", "leanprover/lean4:v4.0.0\n")
  })

  afterEach(() => rmSync(directory, { recursive: true, force: true }))

  it("fingerprints every source at any depth and nothing of the build output", () => {
    const current = LeanOracle.sources(specification)
    expect(current).toMatchObject({
      _tag: "Complete",
      files: ["Main.lean", "Spec.lean", "Spec/Basic.lean", "Spec/Deep/Inner.lean", "lakefile.toml", "lean-toolchain"]
    })
    write(".lake/packages/dep/Dep.lean", "def dep := 0\n")
    write("notes.md", "not a source\n")
    expect(LeanOracle.sources(specification)).toEqual(current)
  })

  it("is stale without an oracle, without a manifest, and with an unreadable manifest", () => {
    expect(LeanOracle.stale(specification)).toBe(true)
    write(".lake/build/bin/spec", "oracle")
    expect(LeanOracle.stale(specification)).toBe(true)
    writeFileSync(LeanOracle.manifestPath(specification), "{ not json")
    expect(LeanOracle.stale(specification)).toBe(true)
    writeFileSync(LeanOracle.manifestPath(specification), "null")
    expect(LeanOracle.stale(specification)).toBe(true)
    build()
    expect(LeanOracle.stale(specification)).toBe(false)
  })

  for (
    const [name, change] of [
      ["a top-level source", () => write("Main.lean", "import Spec\n-- changed\n")],
      ["a nested source", () => write("Spec/Deep/Inner.lean", "import Spec.Basic\ndef two := 3\n")],
      ["the toolchain pin", () => write("lean-toolchain", "leanprover/lean4:v4.1.0\n")],
      ["the lakefile", () => write("lakefile.toml", "name = \"other\"\n")],
      ["a new source", () => write("Spec/Deep/Deeper/New.lean", "def three := 3\n")],
      ["a renamed source", () => {
        unlinkSync(join(directory, "Spec", "Basic.lean"))
        write("Spec/Deep/Basic.lean", "def one := 1\n")
        write("Spec.lean", "import Spec.Deep.Basic\nimport Spec.Deep.Inner\n")
        write("Spec/Deep/Inner.lean", "import Spec.Deep.Basic\ndef two := 2\n")
      }]
    ] as const
  ) {
    it(`an oracle newer than every source is still stale once ${name} differs from what it was built from`, () => {
      build()
      change()
      // Modification times now say the oracle is the newest file in the tree. They are not consulted.
      touchOracle()
      expect(LeanOracle.stale(specification)).toBe(true)
      build()
      expect(LeanOracle.stale(specification)).toBe(false)
    })
  }

  it("a source rewritten with the same content keeps the oracle fresh", () => {
    build()
    write("Spec/Basic.lean", "def one := 1\n")
    expect(LeanOracle.stale(specification)).toBe(false)
  })

  for (
    const [file, missing] of [
      ["Main.lean", ["Main.lean"]],
      ["Spec.lean", ["Spec.lean"]],
      ["lakefile.toml", ["lakefile.toml"]],
      ["lean-toolchain", ["lean-toolchain"]],
      ["Spec/Basic.lean", ["Spec/Basic.lean"]],
      ["Spec/Deep/Inner.lean", ["Spec/Deep/Inner.lean"]]
    ] as const
  ) {
    it(`a tree missing ${file} is incomplete and never fresh, even beside an oracle built before it went`, () => {
      build()
      unlinkSync(join(directory, ...file.split("/")))
      touchOracle()
      expect(LeanOracle.sources(specification)).toEqual({ _tag: "Incomplete", missing })
      expect(LeanOracle.stale(specification)).toBe(true)
    })
  }

  it("a specification directory that is absent is incomplete in every required file", () => {
    rmSync(directory, { recursive: true, force: true })
    expect(LeanOracle.sources(specification)).toEqual({ _tag: "Incomplete", missing: specification.required })
    expect(LeanOracle.stale(specification)).toBe(true)
  })
})

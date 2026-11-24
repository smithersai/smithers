/**
 * The freshness rule the Lean differential trusts (R2-Astra-D1-018), on real directories.
 *
 * The rule it replaced compared modification times and listed one directory, so an oracle copied in with a newer
 * timestamp, a source in a nested directory and a missing source could each pass as fresh.
 */
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import * as LeanOracle from "./LeanOracle.ts"

const directories: Array<string> = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

const tree: Readonly<Record<string, string>> = {
  "Main.lean": "import Lean.Data.Json\nimport PatternsSpec\n",
  "PatternsSpec.lean": "import PatternsSpec.Basic\nimport PatternsSpec.Deep.Saga\n",
  "PatternsSpec/Basic.lean": "def one := 1\n",
  "PatternsSpec/Deep/Saga.lean": "import PatternsSpec.Basic\ndef two := 2\n",
  "lakefile.toml": "name = \"patterns\"\n",
  "lean-toolchain": "leanprover/lean4:v4.0.0\n"
}

/** A specification directory holding `files`, with nothing built. */
const specification = (files: Readonly<Record<string, string>> = tree): LeanOracle.Specification => {
  const directory = mkdtempSync(join(tmpdir(), "lean-oracle-"))
  directories.push(directory)
  for (const [file, text] of Object.entries(files)) write(directory, file, text)
  return {
    directory,
    binary: join(directory, ".lake", "build", "bin", "patterns-spec"),
    required: ["Main.lean", "PatternsSpec.lean", "lakefile.toml", "lean-toolchain"],
    library: "PatternsSpec"
  }
}

const write = (directory: string, file: string, text: string): void => {
  const path = join(directory, ...file.split("/"))
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

/** Stands an oracle up as a build of the sources as they are now would. */
const build = (spec: LeanOracle.Specification): void => {
  const current = LeanOracle.sources(spec)
  if (current._tag !== "Complete") throw new Error(`incomplete: ${current.missing.join(", ")}`)
  write(spec.directory, ".lake/build/bin/patterns-spec", "oracle")
  LeanOracle.record(spec, current)
}

/** Dates the oracle a day ahead of every source, as a copied-in build is. */
const postdate = (spec: LeanOracle.Specification): void => {
  const tomorrow = new Date(Date.now() + 86_400_000)
  utimesSync(spec.binary, tomorrow, tomorrow)
}

describe("LeanOracle freshness", () => {
  it("reads every source at any depth and no build output", () => {
    const spec = specification()
    write(spec.directory, ".lake/build/ir/Main.lean", "generated")
    write(spec.directory, "lake-manifest.json", "{}")

    expect(LeanOracle.sources(spec)).toMatchObject({
      _tag: "Complete",
      files: [
        "Main.lean",
        "PatternsSpec.lean",
        "PatternsSpec/Basic.lean",
        "PatternsSpec/Deep/Saga.lean",
        "lakefile.toml",
        "lean-toolchain"
      ]
    })
  })

  it("is fresh only for an oracle recorded as built from the sources as they are", () => {
    const spec = specification()
    expect(LeanOracle.stale(spec)).toBe(true)
    build(spec)
    expect(LeanOracle.stale(spec)).toBe(false)
  })

  it("does not trust an oracle that is newer than its sources but has no record", () => {
    const spec = specification()
    write(spec.directory, ".lake/build/bin/patterns-spec", "copied from another checkout")
    postdate(spec)

    expect(LeanOracle.stale(spec)).toBe(true)
  })

  it("does not trust a newer oracle whose record names other sources, at any depth", () => {
    for (const file of ["PatternsSpec/Deep/Saga.lean", "lean-toolchain", "lakefile.toml", "Main.lean"]) {
      const spec = specification()
      build(spec)
      write(spec.directory, file, `${tree[file]}-- changed\n`)
      postdate(spec)

      expect(LeanOracle.stale(spec), file).toBe(true)
    }
  })

  it("tells a renamed source from the same bytes under the old name", () => {
    const spec = specification()
    const before = LeanOracle.sources(spec)
    const moved = specification({
      ...Object.fromEntries(Object.entries(tree).filter(([file]) => file !== "PatternsSpec/Basic.lean")),
      "PatternsSpec/Basic/More.lean": tree["PatternsSpec/Basic.lean"]!,
      "PatternsSpec/Basic.lean": ""
    })
    const after = LeanOracle.sources(moved)

    expect(before._tag).toBe("Complete")
    expect(after._tag).toBe("Complete")
    expect((after as { fingerprint: string }).fingerprint).not.toBe((before as { fingerprint: string }).fingerprint)
  })

  it("is never fresh with a required source missing, a built and recorded oracle notwithstanding", () => {
    for (const file of ["Main.lean", "PatternsSpec.lean", "lakefile.toml", "lean-toolchain"]) {
      const spec = specification()
      build(spec)
      rmSync(join(spec.directory, file))
      postdate(spec)

      expect(LeanOracle.sources(spec), file).toMatchObject({ _tag: "Incomplete" })
      expect((LeanOracle.sources(spec) as { missing: ReadonlyArray<string> }).missing, file).toContain(file)
      expect(LeanOracle.stale(spec), file).toBe(true)
    }
  })

  it("is never fresh when a module the specification imports has no file", () => {
    const spec = specification()
    build(spec)
    rmSync(join(spec.directory, "PatternsSpec", "Deep", "Saga.lean"))

    expect(LeanOracle.sources(spec)).toEqual({ _tag: "Incomplete", missing: ["PatternsSpec/Deep/Saga.lean"] })
    expect(LeanOracle.stale(spec)).toBe(true)
  })

  it("is never fresh with no specification directory or an unreadable record", () => {
    const spec = specification()
    build(spec)
    writeFileSync(LeanOracle.manifestPath(spec), "not json")
    expect(LeanOracle.stale(spec)).toBe(true)
    writeFileSync(LeanOracle.manifestPath(spec), "null")
    expect(LeanOracle.stale(spec)).toBe(true)

    const absent = { ...spec, directory: join(spec.directory, "absent") }
    expect(LeanOracle.sources(absent)).toEqual({ _tag: "Incomplete", missing: spec.required })
    expect(LeanOracle.stale(absent)).toBe(true)
  })
})

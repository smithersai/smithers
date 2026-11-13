/**
 * The implementation fingerprint's ceiling on directory entries.
 *
 * Every entry the walk lists costs work even when it is not source: a tree of
 * symbolic links contributes no bytes yet can keep the walk busy for as long
 * as its author likes. The walk counts every listed entry and stops past one
 * million, before it inspects or reads anything.
 */
import * as NodeFs from "node:fs"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { fingerprintSources } from "../src/Planner.ts"

/** One directory listing is capped at 100000 entries, so ten full ones pass a million with the root's ten. */
const directories = 10
const entriesPerDirectory = 100_000

// Creating and removing a million entries takes ~15 s on tmpfs and several
// times that on a disk, so Linux builds the tree in shared memory.
const parent = NodeFs.existsSync("/dev/shm") ? "/dev/shm" : Os.tmpdir()

const temporaries: Array<string> = []

afterEach(async () => {
  for (const directory of temporaries.splice(0)) {
    await Fs.rm(directory, { recursive: true, force: true })
  }
})

/** Fills one directory with dangling symbolic links: real entries that carry no source bytes. */
const fill = async (directory: string): Promise<void> => {
  await Fs.mkdir(directory)
  for (let start = 0; start < entriesPerDirectory; start += 500) {
    await Promise.all(
      Array.from({ length: 500 }, (_, offset) => Fs.symlink("absent", NodePath.join(directory, `l${start + offset}`)))
    )
  }
}

describe("fingerprintSources entry ceiling", () => {
  it("refuses a tree that lists more than 1000000 entries", { timeout: 240_000 }, async () => {
    const directory = await Fs.mkdtemp(NodePath.join(parent, "smthrs-planner-entries-"))
    temporaries.push(directory)
    await Promise.all(Array.from({ length: directories }, (_, index) => fill(NodePath.join(directory, `e${index}`))))
    await expect(fingerprintSources([{ name: "x", directory }]))
      .rejects.toThrow("implementation source tree contains more than 1000000 entries")
  })
})

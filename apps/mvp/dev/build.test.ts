import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { build } from "vite"
import { afterAll, describe, expect, test } from "vitest"
import { buildOf, REVISION_TEMPLATE, type Run, smithersBuild, VERSION_FILE } from "./build"

// The build's name (dev/build.ts): what a deploy names, what jj says the checkout is, and `dev` when neither can say;
// and the Vite plugin that puts it in the bundle and in `version.json`, built for real.

const asked: Array<ReadonlyArray<string>> = []
const answering = (output: string): Run => (args) => {
  asked.push(args)
  return output
}
const failing: Run = () => {
  throw new Error("jj: not found")
}

describe("the build's name", () => {
  test("SMITHERS_BUILD names it, trimmed, without asking jj", () => {
    asked.length = 0
    expect(buildOf({ SMITHERS_BUILD: " a0a126492c " }, "/tmp", answering("other"))).toBe("a0a126492c")
    expect(asked).toEqual([])
  })

  test("a name with anything but word characters, dots, commas, plus and dashes is dev; a long one is cut", () => {
    expect(buildOf({ SMITHERS_BUILD: "a b" }, "/tmp", failing)).toBe("dev")
    expect(buildOf({ SMITHERS_BUILD: "x".repeat(80) }, "/tmp", failing)).toBe("x".repeat(64))
  })

  test("otherwise jj's revision of the checkout, read without snapshotting it", () => {
    asked.length = 0
    expect(buildOf({}, "/repo", answering("38569d55ad79\n"))).toBe("38569d55ad79")
    expect(asked).toEqual([["log", "--ignore-working-copy", "--no-graph", "-r", "@", "-T", REVISION_TEMPLATE]])
    expect(buildOf({ SMITHERS_BUILD: "" }, "/repo", answering("98a1868e9fd2+"))).toBe("98a1868e9fd2+")
    expect(buildOf({}, "/repo", answering("aaaaaaaaaaaa,bbbbbbbbbbbb"))).toBe("aaaaaaaaaaaa,bbbbbbbbbbbb")
  })

  test("no jj, nothing it says, or something odd builds dev", () => {
    expect(buildOf({}, "/repo", failing)).toBe("dev")
    expect(buildOf({}, "/repo", answering("  \n"))).toBe("dev")
    expect(buildOf({}, "/repo", answering("Error: no repo"))).toBe("dev")
  })

  test("a directory that is no checkout builds dev with the real jj", () => {
    const dir = mkdtempSync(join(tmpdir(), "smithers-build-"))
    try {
      expect(buildOf({}, dir)).toBe("dev")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("the Vite plugin", () => {
  const out = mkdtempSync(join(tmpdir(), "smithers-build-out-"))
  afterAll(() => rmSync(out, { recursive: true, force: true }))

  test("defines the build for the app's code and writes version.json beside it", async () => {
    const root = mkdtempSync(join(tmpdir(), "smithers-build-root-"))
    try {
      const entry = join(root, "entry.js")
      writeFileSync(entry, "export const build = __SMITHERS_BUILD__\n")
      await build({
        root,
        logLevel: "silent",
        configFile: false,
        plugins: [smithersBuild("38569d55ad79")],
        build: {
          outDir: out,
          emptyOutDir: true,
          lib: { entry, formats: ["es"], fileName: "entry" },
        },
      })
      expect(JSON.parse(readFileSync(join(out, VERSION_FILE), "utf8"))).toEqual({ build: "38569d55ad79" })
      // `entry.js` or `entry.mjs`, as the package type decides.
      const bundle = readdirSync(out).find((file) => file.startsWith("entry."))!
      expect(readFileSync(join(out, bundle), "utf8")).toContain('"38569d55ad79"')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

/*
 * The manifest is the pane files' own vocabulary, so it has to stay theirs.
 *
 * Splitting identity (Manifest.ts, read every boot) from the drawing (the
 * pane module, fetched on demand) buys the main chunk back, and costs one
 * copy. Both directions are checked here: a pane whose row is missing can
 * never be opened, and a row whose pane is gone registers a flow that opens
 * nothing. The pane files are read as TEXT — the same technique
 * flows/FlowName.test.ts uses — so the check needs no bundler and no DOM.
 */
import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { EXPERIMENTAL_MANIFEST } from "./Manifest"
import type { ExperimentalPane } from "./Pane"
import { loadPane } from "./Registry"

const panes = fileURLToPath(new URL("./panes/", import.meta.url))

/** What one pane file's own `pane({ … })` call declares. */
const declared = (file: string) => {
  const source = readFileSync(`${panes}${file}.tsx`, "utf8")
  const call = source.slice(source.indexOf("pane({"))
  const field = (key: string) => new RegExp(`\\b${key}:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(call)?.[1]
  const packages = /packages:\s*\[([^\]]*)\]/.exec(call)?.[1] ?? ""
  const required = (key: string): string => {
    const value = field(key)
    if (value === undefined) throw new Error(`${file}.tsx declares no ${key}`)
    return value
  }
  return {
    file,
    id: required("id"),
    title: required("title"),
    summary: required("summary"),
    packages: packages.split(",").map((entry) => entry.trim().replace(/^"|"$/g, "")).filter((entry) => entry !== "")
  }
}

const paneFiles = readdirSync(panes).filter((file) => file.endsWith(".tsx")).map((file) => file.slice(0, -4)).sort()

describe("the manifest and the pane files declare the same panes", () => {
  test("every pane file has a row", () => {
    expect(paneFiles.filter((file) => !EXPERIMENTAL_MANIFEST.some((row) => row.file === file))).toEqual([])
  })

  test("every row has a pane file", () => {
    expect(EXPERIMENTAL_MANIFEST.filter((row) => !paneFiles.includes(row.file)).map((row) => row.file)).toEqual([])
  })

  test("each row repeats its pane's own id, title, summary and packages", () => {
    for (const row of EXPERIMENTAL_MANIFEST) {
      expect({ ...row, packages: [...row.packages] }).toEqual(declared(row.file))
    }
  })

  /*
   * The text check above proves the copies agree; this one proves the door
   * works. Every row is loaded through the same function the card uses, so a
   * pane that fails to import, exports the wrong name, or answers to a
   * different id than its row is caught here rather than as a blank card.
   */
  test("every row loads the pane it names", async () => {
    for (const row of EXPERIMENTAL_MANIFEST) {
      const pane = await loadPane(row.id)
      expect(pane?.id).toBe(row.id)
      expect(typeof pane?.render).toBe("function")
    }
  })

  test("an id with no row loads nothing, and does not throw", async () => {
    expect(await loadPane("promoted-away")).toBeUndefined()
  })

  /*
   * A chunk that did not arrive is not a pane that stopped existing. The
   * failure has to leave this function, because the card's error boundary is
   * the only place that knows a stale chunk is fixed by reloading the app,
   * and a blip must not settle into "No pane named index." for good.
   */
  test("a chunk that fails once rejects, and the next load succeeds", async () => {
    let attempts = 0
    const flaky = async (file: string) => {
      attempts += 1
      if (attempts === 1) throw new Error("Failed to fetch dynamically imported module")
      return (await import(`./panes/${file}.tsx`)) as { readonly Pane: ExperimentalPane }
    }
    await expect(loadPane("index", flaky)).rejects.toThrow(/dynamically imported module/)
    expect((await loadPane("index", flaky))?.id).toBe("index")
    expect(attempts).toBe(2)
  })
})

/* Mock data ships in the bundle: an address in a pane is published to every visitor. */
describe("pane mock data", () => {
  test("names no email address outside the reserved example.com domain", () => {
    const addresses = readdirSync(panes).filter(file => file.endsWith(".tsx")).flatMap(file =>
      [...readFileSync(`${panes}${file}`, "utf8").matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g)]
        .map(match => `${file}: ${match[0]}`)
        .filter(hit => !hit.endsWith("@example.com")))
    expect(addresses).toEqual([])
  })
})

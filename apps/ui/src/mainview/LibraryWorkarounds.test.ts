import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"

/*
 * A workaround dies with the library fix it was waiting for.
 *
 * LIBRARY-CHANGE-REQUESTS.md §3, §4 and §5 landed in `@smthrs/ui`:
 * `ChatComposer` takes `submitProps`/`stopProps`, `FileTree` takes
 * `nodeProps`, `MarkdownEditor` releases Tab itself (`escapeTabOrder`,
 * default true) and `Markdown` renders GFM tables. The host kept all three
 * workarounds anyway — a ref callback reaching into the composer's rendered
 * buttons, a capture handler above the editor and a second table parser — so
 * the transcript and the cards drifted apart on what a table cell is. This
 * fails if any of them comes back.
 */

const mainview = new URL(".", import.meta.url).pathname

const productionSources = async (): Promise<ReadonlyArray<{ readonly path: string; readonly source: string }>> => {
  const files: Array<{ readonly path: string; readonly source: string }> = []
  for await (const path of new Bun.Glob("**/*.{ts,tsx}").scan({ cwd: mainview, absolute: true })) {
    if (path.includes(".test.")) continue
    files.push({ path: path.slice(mainview.length), source: await readFile(path, "utf8") })
  }
  return files
}

/** One banned shape and the landed prop that replaces it. */
const RETIRED: ReadonlyArray<readonly [pattern: RegExp, replacement: string]> = [
  [/\.sui-chat-composer-(?:send|stop|input)/, "ChatComposer's submitProps/stopProps/textareaProps"],
  [/\bstampTestIds\b|\bcomposeRefs\b/, "ChatComposer's submitProps"],
  [/\btabOutOf\b|\bfocusableOutside\b/, "MarkdownEditor's escapeTabOrder"],
  [/\bRichMarkdown\b/, "@smthrs/ui's Markdown"]
]

describe("landed library contracts have no host workaround left", () => {
  test("no source reaches into a component @smthrs/ui renders", async () => {
    const sources = await productionSources()
    expect(sources.length).toBeGreaterThan(0)
    for (const [pattern, replacement] of RETIRED) {
      const offenders = sources.filter(({ source }) => pattern.test(source)).map(({ path }) => `${path} (use ${replacement})`)
      expect(offenders).toEqual([])
    }
  })

  test("the composer's Send and Stop name their flows through the component's own props", async () => {
    const source = await readFile(new URL("./Composer.tsx", import.meta.url), "utf8")
    expect(source).toContain('submitProps={COMPOSER_SEND_PROPS}')
    expect(source).toContain('stopProps={COMPOSER_STOP_PROPS}')
    expect(source).toContain('"data-flow": "chat.send"')
    expect(source).toContain('"data-flow": "chat.stop"')
  })

  test("the Wiki file tree names its flow through FileTree's nodeProps", async () => {
    const source = await readFile(new URL("./App.tsx", import.meta.url), "utf8")
    expect(source).toContain('nodeProps={() => ({ "data-flow": "wiki.select" })}')
  })
})

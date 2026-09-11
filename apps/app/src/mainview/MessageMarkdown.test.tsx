import { Markdown } from "@smthrs/ui"
import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"

/*
 * The transcript's markdown renderer, which is now the library's.
 *
 * `RichMarkdown` used to split tables out of the source and hand the cells to
 * `TableCell` as plain strings, so a `**total**` in a cell reached the screen
 * with its asterisks (LIBRARY-CHANGE-REQUESTS §5). `Markdown` renders the same
 * table with its own inline rule, and the fence rule still wins over it, so a
 * pipe inside a fence stays data. These are the cases the deleted
 * RichMarkdown.test.ts covered, asserted against the renderer App.tsx uses.
 */

const render = (content: string): string => renderToStaticMarkup(<Markdown content={content} />)

describe("a model's table renders as a table", () => {
  test("a header row and its delimiter become a table, with inline markdown in the cells", () => {
    const markup = render("| Repo | Issues |\n| --- | ---: |\n| `smithers` | **12** |")
    expect(markup).toContain("<table")
    expect(markup).toContain("Repo")
    expect(markup).toContain("<strong>12</strong>")
    expect(markup).toContain("<code")
    expect(markup).not.toContain("**12**")
  })

  test("the delimiter row's colons set the column alignment", () => {
    expect(render("| a | b |\n| :-: | --: |\n| 1 | 2 |")).toContain("text-align:right")
  })

  test("a pipe inside a fence is data, not a table", () => {
    const markup = render("```\n| a | b |\n| --- | --- |\n```")
    expect(markup).not.toContain("<table")
    expect(markup).toContain("| a | b |")
  })

  test("a sentence containing a pipe stays a sentence", () => {
    const markup = render("Run `a | b` to pipe it.")
    expect(markup).not.toContain("<table")
  })
})

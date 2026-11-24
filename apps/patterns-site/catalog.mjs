/**
 * The catalog `site/index.html` renders from, and the repository inputs its
 * link check reads. Shared by `links.test.mjs` and `PACKAGE.ts`, so the
 * target declares exactly the files the test opens.
 */

/** The catalog block `site/index.html` renders from. */
export const readCatalog = (html) => {
  const block = html.match(/<script type="application\/json" id="catalog-data">([\s\S]*?)<\/script>/)
  if (!block) throw new Error("site/index.html has no catalog-data block")
  return JSON.parse(block[1])
}

/** Where every `url` source's API reference page is built from. */
export const API_PAGES = "apps/site/src/content/docs/docs/reference/api"

/** The use-case examples every one of which needs a card. */
export const USE_CASES = "packages/smithers/agent/examples/use-cases"

/**
 * The repository paths a catalog's `path` sources link, without anchors and
 * deduplicated. A directory keeps its trailing slash.
 */
export const linkedPaths = (catalog) => [
  ...new Set(
    catalog.sections.flatMap((section) =>
      section.items.flatMap((card) => card.sources.flatMap((source) => (source.path ? [source.path.split("#")[0]] : [])))
    )
  )
]

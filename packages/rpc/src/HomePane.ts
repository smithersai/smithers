/**
 * The wire contract of a repository's home pane: `.smithers/home.json`.
 *
 * A factory declares its home in `.smithers/FACTORY.ts` as
 * `export const home = Smithers.Factory.Home({ blocks })` (`@smthrs/targets`
 * `Home.ts` is the declaring side); the `FactoryProjection` target projects
 * it to `.smithers/home.json` beside `.smithers/factory.json`, and the app
 * reads that file from the public mirror through the contents route. This
 * module is the reading side: the same block set, in Zod, so a page that
 * imports nothing from the build can still refuse a file that is not a home
 * pane and never render a string that carries HTML.
 *
 * Blocks are declared values, never raw HTML. Every string here is refused
 * when it contains a tag, a closing tag, a comment, or a processing
 * instruction opener; prose comparing `a < b` passes.
 *
 * The CI benchmark carries no numbers. The block names the measures it
 * wants; the app hides them until measurements exist.
 *
 * @since 1.0.0
 */
import { z } from "zod"

/**
 * The shape of raw HTML in a string. Mirrors `Home.htmlPattern` in `@smthrs/targets`.
 * @since 1.0.0
 * @category constants
 */
export const HTML_PATTERN = /<\/?[A-Za-z!?]/

const plain = (max: number) =>
  z.string().min(1).max(max).refine((text) => !HTML_PATTERN.test(text), {
    message: "must not contain HTML; blocks are declared values, never markup"
  })

/**
 * A one-line title or label.
 * @since 1.0.0
 * @category schemas
 */
export const HomeTitleSchema = plain(120).refine((text) => !/[\r\n]/.test(text), { message: "must be one line" })

/**
 * A paragraph of plain text.
 * @since 1.0.0
 * @category schemas
 */
export const HomeProseSchema = plain(4096)

/**
 * An absolute http or https link target.
 * @since 1.0.0
 * @category schemas
 */
export const HomeUrlSchema = z.string().min(1).max(2048).regex(/^https?:\/\/[^\s<>"']+$/)

/**
 * The CI numbers a benchmark block may ask for, in display order.
 * @since 1.0.0
 * @category constants
 */
export const HOME_MEASURES = ["cold", "incremental", "cache-hit-rate"] as const

/**
 * One CI benchmark measure.
 * @since 1.0.0
 * @category schemas
 */
export const HomeMeasureSchema = z.enum(HOME_MEASURES)
/**
 * One CI benchmark measure.
 * @since 1.0.0
 * @category models
 */
export type HomeMeasure = z.infer<typeof HomeMeasureSchema>

/**
 * What each measure is called on the pane.
 * @since 1.0.0
 * @category constants
 */
export const HOME_MEASURE_LABELS: Readonly<Record<HomeMeasure, string>> = {
  cold: "Cold, full",
  incremental: "One-file change",
  "cache-hit-rate": "Cache hits"
}

/**
 * What the pane says for a measure nothing has measured.
 * @since 1.0.0
 * @category constants
 */
export const NOT_MEASURED_YET = "not measured yet"

/**
 * A paragraph of plain text under an optional title.
 * @since 1.0.0
 * @category schemas
 */
export const HomeTextBlockSchema = z.object({
  type: z.literal("text"),
  title: HomeTitleSchema.optional(),
  text: HomeProseSchema
})

/**
 * One link: the label the pane shows and the URL it opens.
 * @since 1.0.0
 * @category schemas
 */
export const HomeLinkSchema = z.object({
  label: HomeTitleSchema,
  url: HomeUrlSchema
})

/**
 * A list of links under an optional title.
 * @since 1.0.0
 * @category schemas
 */
export const HomeLinksBlockSchema = z.object({
  type: z.literal("links"),
  title: HomeTitleSchema.optional(),
  links: z.array(HomeLinkSchema).min(1)
})

/**
 * The featured flows; the rows come from the `flows` of `.smithers/factory.json`, never from this block.
 * @since 1.0.0
 * @category schemas
 */
export const HomeFlowsBlockSchema = z.object({
  type: z.literal("flows"),
  title: HomeTitleSchema.optional()
})

/**
 * The CI benchmark: which measures the pane shows, no numbers.
 * @since 1.0.0
 * @category schemas
 */
export const HomeCiBenchmarkBlockSchema = z.object({
  type: z.literal("ci-benchmark"),
  title: HomeTitleSchema.optional(),
  measures: z.array(HomeMeasureSchema).min(1)
})

/**
 * One declared block.
 * @since 1.0.0
 * @category schemas
 */
export const HomeBlockSchema = z.discriminatedUnion("type", [
  HomeTextBlockSchema,
  HomeLinksBlockSchema,
  HomeFlowsBlockSchema,
  HomeCiBenchmarkBlockSchema
])
/**
 * One declared block.
 * @since 1.0.0
 * @category models
 */
export type HomeBlock = z.infer<typeof HomeBlockSchema>

/**
 * The document `.smithers/home.json` holds.
 * @since 1.0.0
 * @category schemas
 */
export const HomeDocumentSchema = z.object({
  blocks: z.array(HomeBlockSchema).min(1).max(32)
})
/**
 * The document `.smithers/home.json` holds.
 * @since 1.0.0
 * @category models
 */
export type HomeDocument = z.infer<typeof HomeDocumentSchema>

/**
 * The repository-relative path the app reads the pane from.
 * @since 1.0.0
 * @category constants
 */
export const HOME_PANE_PATH = ".smithers/home.json"

/**
 * Reads a home pane from the file's text. The refusal names the first
 * reason, so a maintainer reading the flow's answer knows what to fix.
 * @since 1.0.0
 * @category parsing
 */
export const parseHomeDocument = (
  text: string
): { readonly ok: true; readonly document: HomeDocument } | { readonly ok: false; readonly reason: string } => {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (cause) {
    return {
      ok: false,
      reason: `${HOME_PANE_PATH} is not JSON: ${cause instanceof Error ? cause.message : String(cause)}`
    }
  }
  const parsed = HomeDocumentSchema.safeParse(value)
  if (parsed.success) return { ok: true, document: parsed.data }
  const issue = parsed.error.issues[0]
  const where = issue === undefined || issue.path.length === 0 ? "" : ` at ${issue.path.join(".")}`
  return { ok: false, reason: `${HOME_PANE_PATH} is not a home pane${where}: ${issue?.message ?? "invalid"}` }
}

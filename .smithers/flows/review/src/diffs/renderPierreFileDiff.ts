import type { preloadPatchDiff as preload } from "@pierre/diffs/ssr"
import { pierreRuntimeGzipBase64 } from "./pierreRuntimeGzipBase64.ts"

type Renderer = {
  preloadPatchDiff: (args: Parameters<typeof preload<undefined, undefined>>[0]) => Promise<{ prerenderedHTML: string }>
}
let renderer: Promise<Renderer> | undefined

/** Inflate the pinned offline resource only when a textual diff needs Pierre. */
async function loadRenderer(): Promise<Renderer> {
  const bytes = Uint8Array.from(atob(pierreRuntimeGzipBase64()), (char) => char.charCodeAt(0))
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))
  const code = await new Response(stream).text()
  // Only generated dependency bytes from our measured flow closure execute;
  // patches never enter this program. Keep the library out of the global scope.
  return new Function(`${code}; return pierreReview;`)() as Renderer
}

/**
 * A per-line annotation slot to prerender into the diff. For each entry the
 * static HTML gains, directly after the matching line's content row, a
 * `<div data-line-annotation><div data-annotation-content><slot
 * name="annotation-{side}-{lineNumber}"></slot></div></div>` block (plus a
 * matching gutter spacer). In light DOM a `<slot>` renders its children, so a
 * consumer can inject finding markup by filling that uniquely named slot.
 */
export type PierreDiffAnnotation = {
  side: "additions" | "deletions"
  lineNumber: number
}

/**
 * Render one file's git patch to Pierre-quality static HTML: syntax
 * highlighting (light/dark token variables), word-level diffs, line numbers,
 * unified or split view. Defaults to themeType "system" so the output carries
 * both light and dark tokens and follows the page's color-scheme. The result
 * is self-contained (inline styles + SVG sprite); use extractDiffAssets to
 * hoist the shared assets when embedding many diffs in one page.
 */
export async function renderPierreFileDiff(args: {
  diff: string
  diffStyle?: "unified" | "split"
  themeType?: "light" | "dark" | "system"
  annotations?: Array<PierreDiffAnnotation>
}): Promise<string> {
  const { preloadPatchDiff } = await (renderer ??= loadRenderer())
  const result = await preloadPatchDiff({
    patch: args.diff.endsWith("\n") ? args.diff : `${args.diff}\n`,
    options: {
      diffStyle: args.diffStyle ?? "unified",
      themeType: args.themeType ?? "system",
      disableFileHeader: true
    },
    ...(args.annotations === undefined ? {} : { annotations: args.annotations })
  })
  return result.prerenderedHTML
}

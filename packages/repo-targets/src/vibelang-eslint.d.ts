/**
 * The source parser contract used by repository import analysis.
 *
 * @since 0.1.0
 */

declare module "vibelang/eslint" {
  /**
   * Parse one source module into its ESTree representation using its file path.
   *
   * @category parsing
   * @since 0.1.0
   */
  export function parseESTree(code: string, filePath: string): any
}

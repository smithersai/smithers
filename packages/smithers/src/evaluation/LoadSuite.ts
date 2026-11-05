/**
 * Evaluation modules share the CLI host's public authoring libraries.
 * @since 1.0.0
 */

import { buildModuleUrl, importDeclarationModule, installEffectResolution } from "@smthrs/build-cli/effect-resolution"
import { Effect } from "effect"
import { pathToFileURL } from "node:url"

// Match native import's per-URL module identity for shared-loader namespaces.
const modules = new Map<string, Promise<unknown>>()

/**
 * Imports an admitted suite without requiring dependencies in its project.
 *
 * Keep native ESM URLs unchanged: embeddings may already hold that module's
 * cancellation controls, and resume must reach the same executor instance.
 * The shared loader owns TypeScript, authored ESM admission, and relative
 * helper resolution for ambiguous .ts/.js entries.
 * @category loading
 * @since 1.0.0
 */
export const load = (file: string): Effect.Effect<unknown, unknown> =>
  Effect.tryPromise(async () => {
    installEffectResolution({
      "@smthrs/evals": import.meta.url,
      "@smthrs/scorers": import.meta.url
    })
    const url = pathToFileURL(file).href
    let module = modules.get(url)
    if (module === undefined) {
      module = /\.(?:ts|js)$/.test(file)
        ? importDeclarationModule(buildModuleUrl(url), import.meta.url)
        : import(url)
      modules.set(url, module)
    }
    return await module
  })

/**
 * Flow naming: how a discovered source path becomes the owned flow name a
 * registry entry is addressed by.
 *
 * @since 0.1.0
 */

import * as Markdown from "@smthrs/core/Markdown"
import * as Option from "effect/Option"
import type { DiscoveryWarning } from "../Descriptor.ts"

/**
 * Derives an owned flow name from directory segments relative to its source root.
 *
 * @since 0.1.0
 * @category naming
 */
export const deriveFromPath = (segments: ReadonlyArray<string>): Option.Option<string> =>
  segments.length === 0 ? Option.none() : Option.some(segments.join("/"))

/**
 * Derives a foreign skill name from frontmatter, with the directory name as a
 * fallback for a name that is absent, blank, not a string, or outside the
 * Agent Skills grammar. A name outside the grammar never becomes a registry
 * key, an action tag, or catalog text.
 *
 * @since 0.1.0
 * @category naming
 */
export const deriveFromFrontmatter = (
  options: { readonly fields: Record<string, unknown>; readonly dirBasename: string; readonly path: string }
): { readonly name: string; readonly warnings: ReadonlyArray<DiscoveryWarning> } => {
  if (!Object.hasOwn(options.fields, "name")) {
    return {
      name: options.dirBasename,
      warnings: [{
        code: "missing_name",
        path: options.path,
        name: options.dirBasename,
        message: "Frontmatter name is missing; using the directory name instead"
      }]
    }
  }

  const value = options.fields.name
  if (typeof value === "string" && value.trim().length > 0) {
    const name = value.trim()
    if (!Markdown.isSkillName(name)) {
      return {
        name: options.dirBasename,
        warnings: [{
          code: "invalid_name",
          path: options.path,
          name: options.dirBasename,
          message: "Frontmatter name must be 1-64 lowercase ASCII letters, numbers, or single hyphens with no " +
            "edge hyphens; using the directory name instead"
        }]
      }
    }
    if (name !== options.dirBasename) {
      return {
        name,
        warnings: [{
          code: "directory_name_mismatch",
          path: options.path,
          name,
          message: `Frontmatter name "${name}" does not match skill directory "${options.dirBasename}"`
        }]
      }
    }
    return { name, warnings: [] }
  }

  return {
    name: options.dirBasename,
    warnings: [{
      code: "invalid_name",
      path: options.path,
      name: options.dirBasename,
      message: "Ignoring an invalid frontmatter name; using the directory name instead"
    }]
  }
}

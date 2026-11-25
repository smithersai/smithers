/**
 * Effect Schema definitions, defaults, validation, and repository loader for smithers-comments configuration.
 *
 * @since 1.0.0
 */

import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Fs from "node:fs/promises"
import * as Path from "node:path"
import { isMissing, posix, safeRelative } from "./internal/FsSafe.ts"

/**
 * Effect Schema for the repository comment storage mode.
 *
 * @since 1.0.0
 * @category schemas
 */
export const ModeSchema = Schema.Literals(["inline", "external"])
/**
 * Repository comment storage mode: inline or external.
 *
 * @since 1.0.0
 * @category models
 */
export type Mode = typeof ModeSchema.Type

/**
 * Effect Schema for the configured validation backend.
 *
 * @since 1.0.0
 * @category schemas
 */
export const AgentEngineSchema = Schema.Literals(["heuristic", "smithers", "none"])
/**
 * Configured validation backend: heuristic, smithers, or none.
 *
 * @since 1.0.0
 * @category models
 */
export type AgentEngine = typeof AgentEngineSchema.Type

/**
 * Normalized configuration governing discovery, validation, caching, and external sidecars.
 *
 * @since 1.0.0
 * @category models
 */
export interface CommentsConfig {
  readonly version: 1
  readonly mode: Mode
  readonly commentsDir: string
  readonly include: ReadonlyArray<string>
  readonly exclude: ReadonlyArray<string>
  readonly preservePragmas: boolean
  readonly extraPragmaPatterns: ReadonlyArray<string>
  readonly strictExternal: boolean
  readonly disallowEmptyComments: boolean
  readonly disallowEmptyTodo: boolean
  readonly checkRefs: boolean
  readonly checkJSDocParams: boolean
  readonly agent: AgentEngine
  readonly model: string
  readonly rubric: string
  readonly cacheFile: string
  readonly virtualOutDir: string
}

/**
 * Default smithers-comments configuration values.
 *
 * @since 1.0.0
 * @category config
 */
export const defaultConfig: CommentsConfig = {
  version: 1,
  mode: "inline",
  commentsDir: ".comments",
  include: ["src/**/*", "lib/**/*", "packages/*/src/**/*"],
  exclude: [
    "**/node_modules/**",
    "**/.git/**",
    "**/dist/**",
    "**/build/**",
    "**/coverage/**",
    "**/.smithers/**"
  ],
  preservePragmas: true,
  extraPragmaPatterns: [],
  strictExternal: true,
  disallowEmptyComments: true,
  disallowEmptyTodo: true,
  checkRefs: true,
  checkJSDocParams: true,
  agent: "heuristic",
  model: "default",
  rubric:
    "Verify that the comment accurately describes the anchored code, adds non-obvious context (why, invariants, edge cases), and does not contradict behavior or signatures.",
  cacheFile: ".smithers/comments-cache.json",
  virtualOutDir: ".smithers/comments-view"
}

/**
 * Normalized configuration governing discovery, validation, caching, and external sidecars.
 *
 * @since 1.0.0
 * @category models
 */
export const CommentsConfig = Schema.Struct({
  version: Schema.Literal(1),
  mode: ModeSchema,
  commentsDir: Schema.NonEmptyString,
  include: Schema.Array(Schema.NonEmptyString),
  exclude: Schema.Array(Schema.NonEmptyString),
  preservePragmas: Schema.Boolean,
  extraPragmaPatterns: Schema.Array(Schema.String),
  strictExternal: Schema.Boolean,
  disallowEmptyComments: Schema.Boolean,
  disallowEmptyTodo: Schema.Boolean,
  checkRefs: Schema.Boolean,
  checkJSDocParams: Schema.Boolean,
  agent: AgentEngineSchema,
  model: Schema.NonEmptyString,
  rubric: Schema.String,
  cacheFile: Schema.NonEmptyString,
  virtualOutDir: Schema.NonEmptyString
})

const PartialConfigSchema = Schema.Struct({
  version: Schema.optional(Schema.Literal(1)),
  mode: Schema.optional(ModeSchema),
  commentsDir: Schema.optional(Schema.NonEmptyString),
  include: Schema.optional(Schema.Array(Schema.NonEmptyString)),
  exclude: Schema.optional(Schema.Array(Schema.NonEmptyString)),
  preservePragmas: Schema.optional(Schema.Boolean),
  extraPragmaPatterns: Schema.optional(Schema.Array(Schema.String)),
  strictExternal: Schema.optional(Schema.Boolean),
  disallowEmptyComments: Schema.optional(Schema.Boolean),
  disallowEmptyTodo: Schema.optional(Schema.Boolean),
  checkRefs: Schema.optional(Schema.Boolean),
  checkJSDocParams: Schema.optional(Schema.Boolean),
  agent: Schema.optional(AgentEngineSchema),
  model: Schema.optional(Schema.NonEmptyString),
  rubric: Schema.optional(Schema.String),
  cacheFile: Schema.optional(Schema.NonEmptyString),
  virtualOutDir: Schema.optional(Schema.NonEmptyString)
})

/**
 * Typed failure raised when configuration JSON or paths are invalid.
 *
 * @since 1.0.0
 * @category errors
 */
export class ConfigError extends Schema.TaggedError<ConfigError>()("smithers-comments/ConfigError", {
  message: Schema.String
}) {}

/**
 * Validates and normalizes a repository-relative external comments directory path.
 *
 * @since 1.0.0
 * @category config
 */
export const validateCommentsDir = (dir: string): Effect.Effect<string, ConfigError> =>
  Effect.suspend(() => {
    const trimmed = dir.trim()
    if (!safeRelative(trimmed)) {
      return Effect.fail(new ConfigError({ message: `commentsDir must be a safe repo-relative path: ${dir}` }))
    }
    return Effect.succeed(posix(trimmed))
  })

const validateRelPath = (field: string, value: string): Effect.Effect<string, ConfigError> =>
  Effect.suspend(() => {
    const trimmed = value.trim()
    if (!safeRelative(trimmed)) {
      return Effect.fail(new ConfigError({ message: `${field} must be a safe repo-relative path: ${value}` }))
    }
    return Effect.succeed(posix(trimmed))
  })

/**
 * Parses and validates a raw JSON configuration string into a CommentsConfig.
 *
 * @since 1.0.0
 * @category config
 */
export const parseConfig = (raw: string): Effect.Effect<CommentsConfig, ConfigError> =>
  Effect.gen(function*() {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      return yield* Effect.fail(
        new ConfigError({ message: `Invalid JSON in config: ${err instanceof Error ? err.message : String(err)}` })
      )
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return yield* Effect.fail(new ConfigError({ message: "Configuration root must be a JSON object" }))
    }

    const decoded = yield* Schema.decodeUnknownEffect(PartialConfigSchema)(parsed).pipe(
      Effect.mapError((err) => new ConfigError({ message: `Invalid config schema: ${String(err)}` }))
    )

    const commentsDir = yield* validateCommentsDir(decoded.commentsDir ?? defaultConfig.commentsDir)
    const cacheFile = yield* validateRelPath("cacheFile", decoded.cacheFile ?? defaultConfig.cacheFile)
    const virtualOutDir = yield* validateRelPath("virtualOutDir", decoded.virtualOutDir ?? defaultConfig.virtualOutDir)

    const extraPragmaPatterns = decoded.extraPragmaPatterns ?? defaultConfig.extraPragmaPatterns
    for (const pattern of extraPragmaPatterns) {
      try {
        new RegExp(pattern)
      } catch (err) {
        return yield* Effect.fail(
          new ConfigError({
            message: `Invalid regex in extraPragmaPatterns (${pattern}): ${
              err instanceof Error ? err.message : String(err)
            }`
          })
        )
      }
    }

    return {
      version: 1,
      mode: decoded.mode ?? defaultConfig.mode,
      commentsDir,
      include: decoded.include ?? defaultConfig.include,
      exclude: decoded.exclude ?? defaultConfig.exclude,
      preservePragmas: decoded.preservePragmas ?? defaultConfig.preservePragmas,
      extraPragmaPatterns,
      strictExternal: decoded.strictExternal ?? defaultConfig.strictExternal,
      disallowEmptyComments: decoded.disallowEmptyComments ?? defaultConfig.disallowEmptyComments,
      disallowEmptyTodo: decoded.disallowEmptyTodo ?? defaultConfig.disallowEmptyTodo,
      checkRefs: decoded.checkRefs ?? defaultConfig.checkRefs,
      checkJSDocParams: decoded.checkJSDocParams ?? defaultConfig.checkJSDocParams,
      agent: decoded.agent ?? defaultConfig.agent,
      model: decoded.model ?? defaultConfig.model,
      rubric: decoded.rubric ?? defaultConfig.rubric,
      cacheFile,
      virtualOutDir
    }
  })

/**
 * Loads repository configuration from disk, falling back to defaults when omitted.
 *
 * @since 1.0.0
 * @category config
 */
export const loadConfig = (
  cwd: string,
  configPath?: string
): Effect.Effect<
  { readonly config: CommentsConfig; readonly configPath: string; readonly exists: boolean },
  ConfigError
> =>
  Effect.gen(function*() {
    const relPath = configPath ?? ".smithers/comments.json"
    const absPath = Path.isAbsolute(relPath) ? relPath : Path.join(cwd, relPath)
    const content = yield* Effect.tryPromise({
      try: () => Fs.readFile(absPath, "utf8"),
      catch: (cause) => cause
    }).pipe(
      Effect.catch((cause) => {
        if (isMissing(cause) && configPath === undefined) {
          return Effect.succeed<string | undefined>(undefined)
        }
        return Effect.fail(
          new ConfigError({
            message: `Unable to read config ${relPath}: ${cause instanceof Error ? cause.message : String(cause)}`
          })
        )
      })
    )

    if (content === undefined) {
      return { config: defaultConfig, configPath: relPath, exists: false }
    }

    const config = yield* parseConfig(content)
    return { config, configPath: relPath, exists: true }
  })

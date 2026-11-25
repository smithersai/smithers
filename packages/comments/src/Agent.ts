/**
 * Semantic comment validator service with deterministic heuristic, no-op, and CLI command-backed layers.
 *
 * @since 1.0.0
 */

import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { spawn } from "node:child_process"
import * as Anchor from "./Anchor.ts"
import * as DocTags from "./internal/DocTags.ts"
import type { CommentStyle, LanguageFamily } from "./Lexer.ts"
import { diagnostic } from "./Validator.ts"
import type { Diagnostic } from "./Validator.ts"

/**
 * Semantic validation input describing one comment and its anchored code region.
 *
 * @since 1.0.0
 * @category models
 */
export interface ValidationRequest {
  readonly path: string
  readonly language: LanguageFamily
  readonly commentId: string
  readonly commentStyle: CommentStyle
  readonly commentBody: string
  readonly anchoredCodeRegion: string
  readonly rubric: string
  readonly modelId: string
}

/**
 * Structured verdict returned by an AgentValidator implementation.
 *
 * @since 1.0.0
 * @category models
 */
export interface ValidationResponse {
  readonly ok: boolean
  readonly diagnostics: ReadonlyArray<Diagnostic>
  readonly suggestedBody?: string
}

/**
 * Typed failure raised when a semantic validator invocation fails.
 *
 * @since 1.0.0
 * @category errors
 */
export class AgentError extends Schema.TaggedError<AgentError>()("smithers-comments/AgentError", {
  message: Schema.String
}) {}

/**
 * Service contract for validating and repairing comments against anchored code.
 *
 * @since 1.0.0
 * @category services
 */
export interface AgentValidatorShape {
  readonly validate: (request: ValidationRequest) => Effect.Effect<ValidationResponse, AgentError>
  readonly fix: (
    request: ValidationRequest,
    diagnostics: ReadonlyArray<Diagnostic>
  ) => Effect.Effect<ValidationResponse, AgentError>
}

/**
 * Effect Context service tag for the active comment validation backend.
 *
 * @since 1.0.0
 * @category services
 */
export class AgentValidator extends Context.Service<AgentValidator, AgentValidatorShape>()(
  "smithers-comments/AgentValidator"
) {}

const FILLER_WORDS = new Set([
  "the",
  "a",
  "an",
  "to",
  "of",
  "for",
  "and",
  "by",
  "this",
  "that",
  "is",
  "it",
  "in",
  "on",
  "at",
  "as",
  "with",
  "its",
  "value",
  "variable"
])

const SPOKEN_OPERATORS: ReadonlyArray<readonly [RegExp, ReadonlyArray<string>]> = [
  [/\+\+|\+=\s*1\b/, ["increment", "add", "plus", "one", "1", "bump"]],
  [/--|-=\s*1\b/, ["decrement", "subtract", "minus", "one", "1"]],
  [/\breturn\b/, ["return", "result"]],
  [/[^=!<>]=[^=>]/, ["set", "assign", "initialize", "init", "define", "declare", "store"]],
  [/\bnew\b/, ["create", "new", "instantiate", "construct"]],
  [/\b(?:for|while)\b/, ["loop", "iterate", "each", "over"]],
  [/\bif\b/, ["if", "check", "when"]],
  [/\bthrow\b|\braise\b/, ["throw", "raise", "error"]]
]

const stem = (word: string): string => word.replace(/(?:ing|es|ed|s)$/, "")

const splitWords = (text: string): Array<string> =>
  text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0)

/** Detects short single-line comments that merely restate identifiers and operators on the first anchored line. */
const restatesCode = (body: string, codeRegion: string): boolean => {
  if (body.includes("\n") || body.length > 60) return false
  const words = splitWords(body).filter((w) => !FILLER_WORDS.has(w))
  if (words.length === 0 || words.length > 6) return false
  const firstLine = codeRegion.split("\n").find((l) => l.trim().length > 0) ?? ""
  if (firstLine.length === 0) return false
  const known = new Set(splitWords(firstLine).map(stem))
  for (const [pattern, spoken] of SPOKEN_OPERATORS) {
    if (pattern.test(firstLine)) {
      for (const word of spoken) known.add(stem(word))
    }
  }
  return words.every((w) => known.has(stem(w)))
}

const heuristicValidate = (req: ValidationRequest): ValidationResponse => {
  const diagnostics: Array<Diagnostic> = []
  const trimmed = req.commentBody.trim()

  if (trimmed.length === 0) {
    diagnostics.push(diagnostic(req.path, 1, "empty-comment", "Comment body is empty.", req.commentId))
  } else if (DocTags.isEmptyTodo(trimmed)) {
    diagnostics.push(
      diagnostic(req.path, 1, "empty-todo", "TODO/FIXME comment requires an explanation.", req.commentId)
    )
  } else if (restatesCode(trimmed, req.anchoredCodeRegion)) {
    diagnostics.push(
      diagnostic(
        req.path,
        1,
        "redundant-comment",
        "Comment restates the anchored code without explaining intent or invariants.",
        req.commentId,
        "warning"
      )
    )
  }

  // Catch clear single-return literal contradictions (e.g. "returns true" when body has only "return false")
  const claimedReturn = /\breturns?\s+(true|false|null|undefined|\d+)\b/i.exec(trimmed)
  const actualReturn = /\breturn\s+(true|false|null|undefined|\d+)\s*[;}\n]?/.exec(req.anchoredCodeRegion)
  if (
    claimedReturn !== null &&
    actualReturn !== null &&
    claimedReturn[1]!.toLowerCase() !== actualReturn[1]! &&
    (req.anchoredCodeRegion.match(/\breturn\b/g)?.length ?? 0) === 1
  ) {
    diagnostics.push(
      diagnostic(
        req.path,
        1,
        "stale-comment",
        `Comment claims return value '${claimedReturn[1]}', but anchored code returns '${actualReturn[1]}'.`,
        req.commentId
      )
    )
  }

  return {
    ok: diagnostics.every((d) => d.severity !== "error"),
    diagnostics
  }
}

const heuristicFix = (req: ValidationRequest, diagnostics: ReadonlyArray<Diagnostic>): ValidationResponse => {
  const codes = new Set(diagnostics.map((d) => d.code))
  if (codes.has("empty-comment") || codes.has("empty-todo") || codes.has("redundant-comment")) {
    return { ok: true, diagnostics: [], suggestedBody: "" }
  }

  let body = req.commentBody
  if (codes.has("stale-param")) {
    const syms = Anchor.extractSymbols(req.anchoredCodeRegion, req.language)
    const callable = syms.find((s) => s.callable && s.paramsComplete) ?? syms[0]
    if (callable !== undefined && callable.params.length > 0) {
      body = DocTags.repairParamTags(body, callable.params)
    }
  }
  if (codes.has("malformed-param")) {
    body = body.replace(/^\s*@param\s*$/gm, "").trim()
  }
  if (codes.has("stale-comment")) {
    const actual = /\breturn\s+(true|false|null|undefined|\d+)\s*[;}\n]?/.exec(req.anchoredCodeRegion)?.[1]
    if (actual !== undefined) {
      body = body.replace(/\b(returns?\s+)(true|false|null|undefined|\d+)\b/i, `$1${actual}`)
    }
  }

  return { ok: true, diagnostics: [], suggestedBody: body }
}

/**
 * Deterministic offline AgentValidator layer requiring no external model calls.
 *
 * @since 1.0.0
 * @category layers
 */
export const heuristicLayer: Layer.Layer<AgentValidator> = Layer.succeed(AgentValidator, {
  validate: (req) => Effect.sync(() => heuristicValidate(req)),
  fix: (req, diags) => Effect.sync(() => heuristicFix(req, diags))
})

/**
 * Pass-through AgentValidator layer that accepts all comments without edits.
 *
 * @since 1.0.0
 * @category layers
 */
export const noopLayer: Layer.Layer<AgentValidator> = Layer.succeed(AgentValidator, {
  validate: () => Effect.succeed({ ok: true, diagnostics: [] }),
  fix: (req) => Effect.succeed({ ok: true, diagnostics: [], suggestedBody: req.commentBody })
})

/**
 * Configuration for spawning a CLI-backed AgentValidator subprocess.
 *
 * @since 1.0.0
 * @category models
 */
export interface CommandAgentOptions {
  readonly command: string
  readonly args?: ReadonlyArray<string>
  readonly cwd?: string
  readonly timeoutMs?: number
}

const REPLY_SHAPE =
  "{\"ok\": boolean, \"diagnostics\": [{\"code\": string, \"severity\": \"error\" | \"warning\", \"message\": string}], \"suggestedBody\"?: string}"

/**
 * Builds the structured JSON prompt for validating one comment.
 *
 * @since 1.0.0
 * @category prompts
 */
export const validationPrompt = (req: ValidationRequest): string =>
  [
    "Review one code comment against its anchored code.",
    "Check accuracy, non-redundancy, and freshness against the rubric.",
    `Respond with one JSON object only: ${REPLY_SHAPE}`,
    "",
    `File: ${req.path} (comment ${req.commentId}, ${req.commentStyle})`,
    `Rubric: ${req.rubric}`,
    "Comment:",
    req.commentBody,
    "",
    "Anchored code:",
    req.anchoredCodeRegion
  ].join("\n")

/**
 * Builds the structured JSON prompt for repairing one failing comment.
 *
 * @since 1.0.0
 * @category prompts
 */
export const fixPrompt = (req: ValidationRequest, diagnostics: ReadonlyArray<Diagnostic>): string =>
  [
    "Repair one code comment so it accurately describes the anchored code.",
    `Respond with one JSON object only: ${REPLY_SHAPE}`,
    "Put repaired text in suggestedBody without comment delimiters, or empty string to remove.",
    "",
    `File: ${req.path} (comment ${req.commentId}, ${req.commentStyle})`,
    "Current comment:",
    req.commentBody,
    "",
    "Anchored code:",
    req.anchoredCodeRegion,
    "",
    "Diagnostics:",
    ...diagnostics.map((d) => `- [${d.code}] ${d.message}`)
  ].join("\n")

/**
 * Parses a raw JSON or fenced model reply into a ValidationResponse.
 *
 * @since 1.0.0
 * @category prompts
 */
export const parseAgentReply = (req: ValidationRequest, reply: string): ValidationResponse | undefined => {
  const start = reply.indexOf("{")
  const end = reply.lastIndexOf("}")
  if (start === -1 || end <= start) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(reply.slice(start, end + 1))
  } catch {
    return undefined
  }
  if (typeof parsed !== "object" || parsed === null) return undefined
  const obj = parsed as { readonly ok?: unknown; readonly diagnostics?: unknown; readonly suggestedBody?: unknown }
  if (typeof obj.ok !== "boolean") return undefined

  const diags: Array<Diagnostic> = []
  for (const item of Array.isArray(obj.diagnostics) ? obj.diagnostics : []) {
    if (typeof item !== "object" || item === null) continue
    const rec = item as { readonly code?: unknown; readonly severity?: unknown; readonly message?: unknown }
    diags.push(
      diagnostic(
        req.path,
        1,
        typeof rec.code === "string" && rec.code.length > 0 ? rec.code : "stale-comment",
        typeof rec.message === "string" ? rec.message : "Comment failed semantic validation.",
        req.commentId,
        rec.severity === "warning" ? "warning" : "error"
      )
    )
  }
  if (!obj.ok && diags.every((d) => d.severity !== "error")) {
    diags.push(diagnostic(req.path, 1, "stale-comment", "Agent rejected comment.", req.commentId))
  }
  return {
    ok: obj.ok,
    diagnostics: diags,
    ...(typeof obj.suggestedBody === "string" ? { suggestedBody: obj.suggestedBody } : {})
  }
}

const runAgentCommand = (options: CommandAgentOptions, prompt: string): Effect.Effect<string, AgentError> =>
  Effect.callback<string, AgentError>((resume) => {
    const child = spawn(options.command, [...(options.args ?? [])], {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"]
    })
    let stdout = ""
    let stderr = ""
    let settled = false

    const finish = (eff: Effect.Effect<string, AgentError>) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resume(eff)
    }

    const timer = setTimeout(() => {
      child.kill("SIGTERM")
      finish(Effect.fail(new AgentError({ message: `Agent command timed out after ${options.timeoutMs ?? 60_000}ms` })))
    }, options.timeoutMs ?? 60_000)

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8")
    })
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8")
    })
    child.on("error", (err) => {
      finish(Effect.fail(new AgentError({ message: `Agent command failed to start: ${err.message}` })))
    })
    child.on("close", (code) => {
      if (code === 0) finish(Effect.succeed(stdout))
      else finish(Effect.fail(new AgentError({ message: `Agent command exited ${code}: ${stderr.trim()}` })))
    })

    child.stdin.end(prompt)
    return Effect.sync(() => {
      clearTimeout(timer)
      if (!settled) child.kill("SIGTERM")
    })
  })

/**
 * Live CLI-backed AgentValidator layer (reads JSON reply from stdout after sending prompt on stdin).
 *
 * @since 1.0.0
 * @category layers
 */
export const commandAgentLayer = (options: CommandAgentOptions): Layer.Layer<AgentValidator> =>
  Layer.succeed(AgentValidator, {
    validate: (req) =>
      runAgentCommand(options, validationPrompt(req)).pipe(
        Effect.flatMap((reply) => {
          const parsed = parseAgentReply(req, reply)
          return parsed !== undefined
            ? Effect.succeed(parsed)
            : Effect.fail(new AgentError({ message: "Agent returned unreadable JSON reply." }))
        })
      ),
    fix: (req, diags) =>
      runAgentCommand(options, fixPrompt(req, diags)).pipe(
        Effect.flatMap((reply) => {
          const parsed = parseAgentReply(req, reply)
          return parsed !== undefined
            ? Effect.succeed(parsed)
            : Effect.fail(new AgentError({ message: "Agent returned unreadable JSON fix reply." }))
        })
      )
  })

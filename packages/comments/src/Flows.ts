/**
 * Declarative Smithers Action and Flow DAG definitions and repository check/fix workflows.
 *
 * @since 1.0.0
 */

import { FlowEngine } from "@smthrs/engine"
import { Action, Flow, Interpreter } from "@smthrs/flows"
import { Node } from "@smthrs/plan"
import * as Digest from "effect/crypto/Digest"
import * as SecureRandom from "effect/crypto/SecureRandom"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { randomUUID } from "node:crypto"
import * as Fs from "node:fs/promises"
import * as Agent from "./Agent.ts"
import * as Cache from "./Cache.ts"
import type * as Config from "./Config.ts"
import { atomicWrite, confinedPath, io } from "./internal/FsSafe.ts"
import * as Repair from "./internal/Repair.ts"
import type { RepairEdit } from "./internal/Repair.ts"
import { collectMissingRefPaths, discoverSources, loadSidecars } from "./internal/Repository.ts"
import * as Lexer from "./Lexer.ts"
import * as Sidecar from "./Sidecar.ts"
import * as Validator from "./Validator.ts"
import * as VirtualFile from "./VirtualFile.ts"

export { RepositoryError } from "./internal/FsSafe.ts"
export type { EditKind, RepairEdit } from "./internal/Repair.ts"
export {
  discoverSources,
  runExtractRepository,
  runRenderRepository,
  runStatusRepository
} from "./internal/Repository.ts"
export type { RenderReport, StatusReport } from "./internal/Repository.ts"

const DiagnosticSchema = Schema.Struct({
  file: Schema.String,
  line: Schema.Number,
  column: Schema.Number,
  severity: Schema.Literals(["error", "warning"]),
  code: Schema.String,
  commentId: Schema.optionalKey(Schema.String),
  message: Schema.String
})

const RequestSchema = Schema.Struct({
  path: Schema.String,
  language: Schema.Literals(["c-style", "hash", "dash", "markup"]),
  commentId: Schema.String,
  commentStyle: Schema.Literals(["line", "block", "doc"]),
  commentBody: Schema.String,
  anchoredCodeRegion: Schema.String,
  rubric: Schema.String,
  modelId: Schema.String
})

const ResponseSchema = Schema.Struct({
  ok: Schema.Boolean,
  diagnostics: Schema.Array(DiagnosticSchema),
  suggestedBody: Schema.optionalKey(Schema.String)
})

const CacheOutcomeSchema = Schema.Struct({
  hit: Schema.Boolean,
  ok: Schema.Boolean,
  diagnostics: Schema.Array(DiagnosticSchema),
  suggestedBody: Schema.optionalKey(Schema.String)
})

const PendingCommentSchema = Schema.Struct({
  key: Schema.String,
  cacheKey: Schema.String,
  line: Schema.Number,
  column: Schema.Number,
  request: RequestSchema
})

const CheckBatchPayloadSchema = Schema.Struct({
  readCache: Schema.Boolean,
  pending: Schema.Array(PendingCommentSchema)
})

const CheckBatchResultSchema = Schema.Struct({
  outcomes: Schema.Record(Schema.String, CacheOutcomeSchema)
})

const FixItemSchema = Schema.Struct({
  key: Schema.String,
  request: RequestSchema,
  diagnostics: Schema.Array(DiagnosticSchema)
})

const FixBatchPayloadSchema = Schema.Struct({
  items: Schema.Array(FixItemSchema)
})

const FixBatchResultSchema = Schema.Struct({
  repairs: Schema.Record(Schema.String, ResponseSchema)
})

const AnchorSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("file") }),
  Schema.Struct({ kind: Schema.Literal("line"), line: Schema.Number }),
  Schema.Struct({ kind: Schema.Literal("symbol"), symbol: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("pattern"), pattern: Schema.String })
])

const SidecarSchema = Schema.Struct({
  source: Schema.String,
  version: Schema.Literal(1),
  entries: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      anchor: AnchorSchema,
      line: Schema.optionalKey(Schema.Number),
      placement: Schema.Literals(["before", "inline", "after"]),
      style: Schema.Literals(["line", "block", "doc"]),
      codeHash: Schema.optionalKey(Schema.String),
      body: Schema.String
    })
  )
})

const RenderPayloadSchema = Schema.Struct({
  sources: Schema.Record(Schema.String, Schema.String),
  sidecars: Schema.Record(Schema.String, SidecarSchema),
  onUnresolved: Schema.optionalKey(Schema.Literals(["fail", "skip"]))
})

const VirtualFileSchema = Schema.Struct({
  path: Schema.String,
  content: Schema.String,
  digest: Schema.String,
  sourceDigest: Schema.String,
  commentsDigest: Schema.String,
  injectedCount: Schema.Number,
  lineMap: Schema.Array(
    Schema.Struct({
      commentId: Schema.String,
      virtualStartLine: Schema.Number,
      virtualEndLine: Schema.Number,
      anchorLine: Schema.Number
    })
  )
})

const RenderResultSchema = Schema.Struct({
  files: Schema.ReadonlyMap(Schema.String, VirtualFileSchema),
  treeDigest: Schema.String
})

/**
 * Smithers Action: looks up one verdict in CommentCacheStore.
 *
 * @since 1.0.0
 * @category workflows
 */
export const LookupVerdictAction = Action.make("comments/LookupVerdict", {
  payload: { key: Schema.String, read: Schema.Boolean },
  success: CacheOutcomeSchema
})

/**
 * Smithers Action: validates one comment through AgentValidator.
 *
 * @since 1.0.0
 * @category workflows
 */
export const CheckCommentAction = Action.make("comments/CheckComment", {
  payload: RequestSchema,
  success: ResponseSchema,
  error: Agent.AgentError
})

/**
 * Smithers Action: persists one fresh verdict to CommentCacheStore.
 *
 * @since 1.0.0
 * @category workflows
 */
export const StoreVerdictAction = Action.make("comments/StoreVerdict", {
  payload: { key: Schema.String, response: ResponseSchema },
  success: CacheOutcomeSchema
})

/**
 * Smithers Action: repairs one failing comment through AgentValidator.
 *
 * @since 1.0.0
 * @category workflows
 */
export const FixCommentAction = Action.make("comments/FixComment", {
  payload: { request: RequestSchema, diagnostics: Schema.Array(DiagnosticSchema) },
  success: ResponseSchema,
  error: Agent.AgentError
})

/**
 * Smithers Action: projects a VirtualFileTree from clean sources and sidecars.
 *
 * @since 1.0.0
 * @category workflows
 */
export const ProjectTreeAction = Action.make("comments/ProjectTree", {
  payload: RenderPayloadSchema,
  success: RenderResultSchema,
  error: VirtualFile.VirtualFileProjectionError
})

/** Declarative Smithers DAG node: cache lookup -> hit returns immediately; miss runs AgentValidator and stores verdict. */
const commentVerdictNode = (pending: typeof PendingCommentSchema.Type, readCache: boolean) =>
  LookupVerdictAction.call({ key: pending.cacheKey, read: readCache }).pipe(
    Node.branch({
      if: (found) => found.hit,
      then: (found) => Node.succeed(found),
      else: () =>
        CheckCommentAction.call(pending.request).pipe(
          Node.bindPlanned((response) => StoreVerdictAction.call({ key: pending.cacheKey, response }))
        )
    })
  )

/**
 * Smithers Flow: validates a batch of file comments via declarative cache-hit/miss branching nodes.
 *
 * @since 1.0.0
 * @category workflows
 */
export const CheckFileFlow = Flow.make("comments/CheckFileFlow", {
  payload: CheckBatchPayloadSchema,
  success: CheckBatchResultSchema,
  error: Agent.AgentError,
  body: (payload) => {
    const members: Record<string, ReturnType<typeof commentVerdictNode>> = {}
    for (const item of payload.pending) {
      members[item.key] = commentVerdictNode(item, payload.readCache)
    }
    return Node.all(members).pipe(Node.map((outcomes) => ({ outcomes })))
  }
})

/**
 * Smithers Flow: repairs failing comments in a file via FixCommentAction nodes.
 *
 * @since 1.0.0
 * @category workflows
 */
export const FixFileFlow = Flow.make("comments/FixFileFlow", {
  payload: FixBatchPayloadSchema,
  success: FixBatchResultSchema,
  error: Agent.AgentError,
  body: (payload) => {
    const members: Record<string, ReturnType<typeof FixCommentAction.call>> = {}
    for (const item of payload.items) {
      members[item.key] = FixCommentAction.call({ request: item.request, diagnostics: item.diagnostics })
    }
    return Node.all(members).pipe(Node.map((repairs) => ({ repairs })))
  }
})

/**
 * Smithers Flow: projects a VirtualFileTree from clean sources and external sidecars.
 *
 * @since 1.0.0
 * @category workflows
 */
export const RenderVirtualFlow = Flow.make("comments/RenderVirtualFlow", {
  payload: RenderPayloadSchema,
  success: RenderResultSchema,
  error: VirtualFile.VirtualFileProjectionError,
  body: (payload) => ProjectTreeAction.call(payload)
})

const cryptoLayer = Layer.mergeAll(Digest.layerWebCrypto, SecureRandom.layerWebCrypto)

const engineLayer = Layer.provideMerge(FlowEngine.layerMemory, cryptoLayer)

const projectTreeLayer = ProjectTreeAction.toLayer((payload) =>
  VirtualFile.projectTree(
    new Map(Object.entries(payload.sources)),
    new Map(Object.entries(payload.sidecars)),
    payload.onUnresolved === undefined ? {} : { onUnresolved: payload.onUnresolved }
  )
)

/**
 * Registers all Smithers comment flows and action implementations onto an in-memory FlowEngine.
 *
 * @since 1.0.0
 * @category layers
 */
export const makeFlowLayer = () =>
  Layer.unwrap(
    Effect.gen(function*() {
      const agent = yield* Agent.AgentValidator
      const cache = yield* Cache.CommentCacheStore
      return Layer.mergeAll(
        LookupVerdictAction.toLayer(({ key, read }) =>
          Effect.gen(function*() {
            if (!read) return { hit: false, ok: true, diagnostics: [] }
            const existing = yield* cache.get(key)
            if (existing === undefined) return { hit: false, ok: true, diagnostics: [] }
            return {
              hit: true,
              ok: existing.ok,
              diagnostics: existing.diagnostics,
              ...(existing.suggestedBody !== undefined ? { suggestedBody: existing.suggestedBody } : {})
            }
          })
        ),
        CheckCommentAction.toLayer((req) => agent.validate(req)),
        StoreVerdictAction.toLayer(({ key, response }) =>
          Effect.gen(function*() {
            yield* cache.set(key, {
              ok: response.ok,
              diagnostics: response.diagnostics,
              ...(response.suggestedBody !== undefined ? { suggestedBody: response.suggestedBody } : {}),
              updatedAt: new Date().toISOString()
            })
            return {
              hit: false,
              ok: response.ok,
              diagnostics: response.diagnostics,
              ...(response.suggestedBody !== undefined ? { suggestedBody: response.suggestedBody } : {})
            }
          })
        ),
        FixCommentAction.toLayer(({ request, diagnostics }) => agent.fix(request, diagnostics)),
        projectTreeLayer,
        Interpreter.layer(CheckFileFlow),
        Interpreter.layer(FixFileFlow),
        Interpreter.layer(RenderVirtualFlow)
      )
    })
  ).pipe(
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(engineLayer)
  )

const localEngineLayer = () => makeFlowLayer()

// --- Public report types & repository workflows ---

/**
 * Repository-wide validation report including cache hit/miss counts and diagnostics.
 *
 * @since 1.0.0
 * @category models
 */
export interface CheckReport {
  readonly mode: Config.Mode
  readonly filesScanned: number
  readonly commentsChecked: number
  readonly cacheHits: number
  readonly cacheMisses: number
  readonly agentCalls: number
  readonly diagnostics: ReadonlyArray<Validator.Diagnostic>
  readonly ok: boolean
}

/**
 * Repository-wide repair report listing changed files and applied edits.
 *
 * @since 1.0.0
 * @category models
 */
export interface FixReport {
  readonly mode: Config.Mode
  readonly dryRun: boolean
  readonly filesChanged: number
  readonly editsApplied: number
  readonly edits: ReadonlyArray<RepairEdit>
  readonly ok: boolean
}

/**
 * Runs structural and cached Smithers Flow semantic validation across a repository.
 *
 * @since 1.0.0
 * @category workflows
 */
export const runCheckRepository = (options: {
  readonly cwd: string
  readonly config: Config.CommentsConfig
  readonly paths?: ReadonlyArray<string>
  readonly strict?: boolean
  readonly noCache?: boolean
}): Effect.Effect<CheckReport, Error, Agent.AgentValidator | Cache.CommentCacheStore> =>
  Effect.gen(function*() {
    const { cwd, config, paths, strict = false, noCache = false } = options
    const cache = yield* Cache.CommentCacheStore
    const sources = yield* discoverSources(cwd, config, paths).pipe(Effect.mapError((e) => new Error(e.message)))
    const external = config.mode === "external"
      ? yield* loadSidecars(cwd, config, sources, paths).pipe(Effect.mapError((e) => new Error(e.message)))
      : { sidecars: new Map<string, Sidecar.SidecarDocument>(), diagnostics: [], sidecarFiles: 0 }

    const diagnostics: Array<Validator.Diagnostic> = [...external.diagnostics]
    let commentsChecked = 0
    let cacheHits = 0
    let cacheMisses = 0
    let agentCalls = 0

    // Collect all pending cache-miss items across files so warm runs bypass FlowEngine startup (O(1) warm cache!)
    const missBatch: Array<typeof PendingCommentSchema.Type> = []

    for (const [relPath, source] of sources) {
      const sidecar = external.sidecars.get(relPath)
      const preComments = config.mode === "inline"
        ? Lexer.lexComments(source, relPath, config).comments.filter((c) => !c.isPragma)
        : (sidecar?.entries ?? [])
      const missingRefPaths = config.checkRefs
        ? yield* collectMissingRefPaths(cwd, relPath, preComments).pipe(Effect.mapError((e) => new Error(e.message)))
        : undefined

      const stage1 = config.mode === "inline"
        ? Validator.validateStructuralInline(source, relPath, config, missingRefPaths)
        : Validator.validateStructuralExternal(source, relPath, sidecar, config, missingRefPaths)

      diagnostics.push(...stage1.diagnostics)

      if (config.mode === "external" && sidecar !== undefined) {
        const proj = VirtualFile.projectFileSync(source, sidecar, relPath)
        if (!proj.ok && !stage1.diagnostics.some((d) => d.commentId === proj.error.commentId)) {
          diagnostics.push(
            Validator.diagnostic(relPath, 1, proj.error.reason, proj.error.message, proj.error.commentId)
          )
        }
      }

      const blockingIds = new Set(
        stage1.diagnostics
          .filter((d) => d.severity === "error" && d.code !== "stale-code-hash" && d.commentId !== undefined)
          .map((d) => d.commentId!)
      )

      for (const bound of stage1.comments) {
        commentsChecked++
        if (config.agent === "none" || blockingIds.has(bound.id)) continue
        const request: Agent.ValidationRequest = {
          path: relPath,
          language: stage1.language,
          commentId: bound.id,
          commentStyle: bound.style,
          commentBody: bound.body,
          anchoredCodeRegion: bound.codeRegion,
          rubric: config.rubric,
          modelId: config.model
        }
        const cacheKey = Cache.computeCacheKey({ ...request, mode: config.mode })
        const cached = noCache ? undefined : yield* cache.get(cacheKey)
        if (cached !== undefined) {
          cacheHits++
          for (const d of cached.diagnostics) {
            diagnostics.push({ ...d, file: relPath, line: bound.line, column: bound.column, commentId: bound.id })
          }
        } else {
          missBatch.push({
            key: `${relPath}::${bound.id}`,
            cacheKey,
            line: bound.line,
            column: bound.column,
            request
          })
        }
      }
    }

    // Execute every cache miss through the real declarative Smithers CheckFileFlow DAG
    if (missBatch.length > 0) {
      const batchResult = yield* CheckFileFlow.execute(
        { readCache: false, pending: missBatch },
        { executionId: randomUUID() }
      ).pipe(
        Effect.provide(localEngineLayer()),
        Effect.mapError((err) =>
          new Error(
            typeof err === "object" && err !== null && "message" in err
              ? String((err as { message: unknown }).message)
              : String(err)
          )
        )
      )

      for (const item of missBatch) {
        const outcome = batchResult.outcomes[item.key]
        if (outcome === undefined) continue
        cacheMisses++
        agentCalls++
        for (const d of outcome.diagnostics) {
          diagnostics.push({
            ...d,
            file: item.request.path,
            line: item.line,
            column: item.column,
            commentId: item.request.commentId
          })
        }
        if (!outcome.ok && outcome.diagnostics.every((d) => d.severity !== "error")) {
          diagnostics.push(
            Validator.diagnostic(
              item.request.path,
              item.line,
              "stale-comment",
              "Validator rejected the comment.",
              item.request.commentId,
              "error",
              item.column
            )
          )
        }
      }
    }

    yield* cache.flush()

    const ok = strict ? diagnostics.length === 0 : diagnostics.every((d) => d.severity !== "error")
    return {
      mode: config.mode,
      filesScanned: sources.size,
      commentsChecked,
      cacheHits,
      cacheMisses,
      agentCalls,
      diagnostics,
      ok
    }
  })

/**
 * Runs the agentic repair and re-anchoring workflow across a repository.
 *
 * @since 1.0.0
 * @category workflows
 */
export const runFixRepository = (options: {
  readonly cwd: string
  readonly config: Config.CommentsConfig
  readonly paths?: ReadonlyArray<string>
  readonly dryRun?: boolean
}): Effect.Effect<FixReport, Error, Agent.AgentValidator | Cache.CommentCacheStore> =>
  Effect.gen(function*() {
    const { cwd, config, paths, dryRun = false } = options
    const check = yield* runCheckRepository({ cwd, config, ...(paths ? { paths } : {}) })
    const sources = yield* discoverSources(cwd, config, paths).pipe(Effect.mapError((e) => new Error(e.message)))
    const external = config.mode === "external"
      ? yield* loadSidecars(cwd, config, sources, paths).pipe(Effect.mapError((e) => new Error(e.message)))
      : { sidecars: new Map<string, Sidecar.SidecarDocument>(), diagnostics: [], sidecarFiles: 0 }

    const diagsByFile = new Map<string, Array<Validator.Diagnostic>>()
    for (const d of check.diagnostics) {
      if (d.severity !== "error" || d.commentId === undefined) continue
      const list = diagsByFile.get(d.file) ?? []
      list.push(d)
      diagsByFile.set(d.file, list)
    }

    const allEdits: Array<RepairEdit> = []
    const changedFiles = new Set<string>()

    for (const [relPath, source] of sources) {
      const language: Lexer.LanguageFamily = Lexer.detectLanguage(relPath) ?? "c-style"
      const fileDiags = diagsByFile.get(relPath) ?? []

      if (config.mode === "inline") {
        if (fileDiags.length === 0) continue
        const stage1 = Validator.validateStructuralInline(source, relPath, config)
        const diagsById = new Map<string, Array<Validator.Diagnostic>>()
        for (const d of fileDiags) {
          if (!d.commentId) continue
          const arr = diagsById.get(d.commentId) ?? []
          arr.push(d)
          diagsById.set(d.commentId, arr)
        }

        const fixItems: Array<typeof FixItemSchema.Type> = []
        for (const bound of stage1.comments) {
          const cDiags = diagsById.get(bound.id)
          if (!cDiags || cDiags.length === 0) continue
          fixItems.push({
            key: bound.id,
            request: {
              path: relPath,
              language,
              commentId: bound.id,
              commentStyle: bound.style,
              commentBody: bound.body,
              anchoredCodeRegion: bound.codeRegion,
              rubric: config.rubric,
              modelId: config.model
            },
            diagnostics: cDiags
          })
        }

        if (fixItems.length === 0) continue
        const batch = yield* FixFileFlow.execute({ items: fixItems }, { executionId: randomUUID() }).pipe(
          Effect.provide(localEngineLayer()),
          Effect.mapError((err) => new Error(String(err)))
        )
        const repairMap = new Map<string, string>()
        for (const item of fixItems) {
          const resp = batch.repairs[item.key]
          if (resp?.suggestedBody !== undefined) repairMap.set(item.key, resp.suggestedBody)
        }
        const applied = Repair.repairInlineSource(relPath, source, language, stage1.comments, repairMap)
        if (applied.edits.length > 0) {
          allEdits.push(...applied.edits)
          changedFiles.add(relPath)
          if (!dryRun) {
            yield* io("fix inline", relPath, async () => atomicWrite(await confinedPath(cwd, relPath), applied.source))
              .pipe(
                Effect.mapError((e) => new Error(e.message))
              )
          }
        }
      } else {
        const sidecar = external.sidecars.get(relPath)
        if (sidecar === undefined) continue
        const scRel = Sidecar.sidecarPathFor(config.commentsDir, relPath)
        const reanchored = Repair.reanchorSidecar(scRel, sidecar, source, language)
        allEdits.push(...reanchored.edits)

        const stage1 = Validator.validateStructuralExternal(source, relPath, reanchored.doc, config)
        const diagsById = new Map<string, Array<Validator.Diagnostic>>()
        for (const d of [...stage1.diagnostics, ...fileDiags]) {
          if (d.severity !== "error" || !d.commentId) continue
          const arr = diagsById.get(d.commentId) ?? []
          arr.push(d)
          diagsById.set(d.commentId, arr)
        }

        const fixItems: Array<typeof FixItemSchema.Type> = []
        const validatedIds = new Set<string>()
        for (const bound of stage1.comments) {
          const cDiags = diagsById.get(bound.id)
          if (!cDiags || cDiags.length === 0) {
            validatedIds.add(bound.id)
            continue
          }
          fixItems.push({
            key: bound.id,
            request: {
              path: relPath,
              language,
              commentId: bound.id,
              commentStyle: bound.style,
              commentBody: bound.body,
              anchoredCodeRegion: bound.codeRegion,
              rubric: config.rubric,
              modelId: config.model
            },
            diagnostics: cDiags
          })
        }

        const repairMap = new Map<string, string>()
        if (fixItems.length > 0) {
          const batch = yield* FixFileFlow.execute({ items: fixItems }, { executionId: randomUUID() }).pipe(
            Effect.provide(localEngineLayer()),
            Effect.mapError((err) => new Error(String(err)))
          )
          for (const item of fixItems) {
            const resp = batch.repairs[item.key]
            if (resp?.suggestedBody !== undefined) {
              repairMap.set(item.key, resp.suggestedBody)
              if (resp.ok) validatedIds.add(item.key)
            }
          }
        }

        const repaired = Repair.repairSidecar(scRel, reanchored.doc, source, language, repairMap, validatedIds)
        const totalEdits = reanchored.edits.length + repaired.edits.length
        allEdits.push(...repaired.edits)
        if (totalEdits > 0) {
          changedFiles.add(scRel)
          if (!dryRun) {
            if (repaired.doc === undefined) {
              yield* io(
                "remove empty sidecar",
                scRel,
                async () => Fs.rm(await confinedPath(cwd, scRel), { force: true })
              ).pipe(
                Effect.mapError((e) => new Error(e.message))
              )
            } else {
              yield* io(
                "fix sidecar",
                scRel,
                async () => atomicWrite(await confinedPath(cwd, scRel), Sidecar.formatSidecar(repaired.doc!))
              ).pipe(Effect.mapError((e) => new Error(e.message)))
            }
          }
        }
      }
    }

    return {
      mode: config.mode,
      dryRun,
      filesChanged: changedFiles.size,
      editsApplied: allEdits.length,
      edits: allEdits,
      ok: true
    }
  })

/**
 * HTTP and WebSocket contracts for repositories, harnesses, terminals, and targets.
 *
 * @since 1.0.0
 */
import { z } from "zod"
import { type TargetRunEvent, TargetRunEventSchema } from "./TargetGraph.ts"

/*
 * The local-app wire model (apps/ui/docs/LOCAL-APP.md "HTTP and WebSocket
 * API"): the harness, repository, and PTY session records the local server
 * answers and the SPA stores. Runtime-free zod, like Cards.ts, so the Bun
 * server, the SPA, and the Playwright doubles validate the same shapes.
 */

/**
 * Shared harness ids used by the host and its clients.
 *
 * @since 1.0.0
 * @category constants
 */
export const HARNESS_IDS = [
  "claude",
  "codex",
  "gemini",
  "kimi",
  "opencode",
  "opencode-kimi",
  "opencode-cerebras",
  "crush",
  "amp",
  "cursor-agent",
  "hermes",
  "pi"
] as const

/**
 * Validates harness values at the RPC boundary.
 *
 * @since 1.0.0
 * @category schemas
 */
export const HarnessSchema = z.object({
  id: z.enum(HARNESS_IDS),
  displayName: z.string(),
  binary: z.string().nullable(),
  version: z.string().nullable(),
  status: z.enum(["signed-in", "api-key", "binary-only", "unavailable"]),
  account: z.object({ email: z.string().optional(), label: z.string().optional() }).nullable(),
  launch: z.object({ argv: z.array(z.string()) }),
  /**
   * How this harness takes a model
   * (apps/ui/docs/workbench-lanes/custom-agents.md): the table's verified
   * suggestions and whether it has a list command
   * (`GET /api/harnesses/{id}/models` runs it). Absent when the binary's
   * `--help` names no model flag the app has verified — such a harness runs
   * only as itself, never as a custom agent. Optional so rows persisted
   * before custom agents parse.
   */
  models: z.object({ suggestions: z.array(z.string()), listable: z.boolean() }).optional()
})
/**
 * The decoded value accepted by {@link HarnessSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type Harness = z.infer<typeof HarnessSchema>

/** A target label: `//pkg:name` (`//:name` for the root package).
 * @since 1.0.0
 * @category constants
 */
export const TARGET_LABEL = /^\/\/[^\s:]*:[^\s:]+$/

/**
 * The verbs `smithers-build` executes over a pattern (`smithers-build
 * --help`). A pattern run is `<verb> <pattern>`: the CLI resolves the
 * pattern to its targets and runs every one, which is what "run everything"
 * is (`ci '//...'`); no single target does that.
 * @since 1.0.0
 * @category constants
 */
export const TARGET_RUN_VERBS = ["build", "ci", "docs", "lint", "run", "test"] as const
/**
 * Validates target run verb values at the RPC boundary.
 *
 * @since 1.0.0
 * @category schemas
 */
export const TargetRunVerbSchema = z.enum(TARGET_RUN_VERBS)
/**
 * The decoded value accepted by {@link TargetRunVerbSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type TargetRunVerb = z.infer<typeof TargetRunVerbSchema>

/** A pattern the CLI accepts: an exact label or a `//dir/...` subtree (`//...` for the whole workspace).
 * @since 1.0.0
 * @category constants
 */
export const TARGET_PATTERN = /^\/\/(?:(?:(?!\.\.\.\/)[^\s:/]+\/)*\.\.\.|(?!.*\.\.\.)[^\s:]*:[^\s:]+)$/

/** The verb and pattern of one pattern run; `title` reads `ci //packages/...`.
 * @since 1.0.0
 * @category conversions
 */
export const patternRunTitle = (verb: string, pattern: string): string => `${verb} ${pattern}`

/**
 * Validates repo workspace values at the RPC boundary.
 *
 * @since 1.0.0
 * @category schemas
 */
export const RepoWorkspaceSchema = z.object({
  /** Relative to the repo root; "." for the root itself. */
  path: z.string(),
  /** The last path segment, or the repo name for the root. */
  title: z.string()
})
/**
 * The decoded value accepted by {@link RepoWorkspaceSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type RepoWorkspace = z.infer<typeof RepoWorkspaceSchema>

/**
 * Validates repo values at the RPC boundary.
 *
 * @since 1.0.0
 * @category schemas
 */
export const RepoSchema = z.object({
  id: z.string(),
  path: z.string(),
  name: z.string(),
  git: z.object({ branch: z.string().nullable(), remote: z.string().nullable() }).nullable(),
  /*
   * The jj probe (lane piper): the checkout's own position — its change and
   * commit ids, how many commits it is ahead of trunk, and trunk's bookmark
   * name. Absent when the checkout is not a jj repo or the probe failed;
   * never a fake zero.
   */
  jj: z.object({
    changeId: z.string().nullable(),
    commitId: z.string().nullable(),
    ahead: z.number().int().nonnegative().nullable(),
    bookmark: z.string().nullable()
  }).optional(),
  /** Loader and manifest problems surfaced at open; empty when the open was clean. */
  warnings: z.array(z.string()),
  smithers: z.object({
    detected: z.boolean(),
    workspaceFile: z.string().nullable(),
    declarationFiles: z.array(z.string()),
    reason: z.string(),
    /** Root and child workspaces (LOCAL-APP.md "Repository detection"); detection is nonempty. */
    workspaces: z.array(RepoWorkspaceSchema)
  })
})
/**
 * The decoded value accepted by {@link RepoSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type Repo = z.infer<typeof RepoSchema>

/*
 * Files in an open repository (LOCAL-APP.md "HTTP and WebSocket surface"):
 * one route answers a directory or a file, the way the Cloud contents route
 * does, so the files seam renders the same file-list / file cards for both.
 * Reads are bounded: the server stops at REPO_FILE_READ_CAP_BYTES and says
 * so with `truncated`; a NUL byte or undecodable UTF-8 answers `binary` with
 * no content.
 */
/**
 * The repo files route shared by server and client.
 *
 * @since 1.0.0
 * @category constants
 */
export const REPO_FILES_PATH = "/api/repo/files"
/**
 * Shared repo file read cap bytes used by the host and its clients.
 *
 * @since 1.0.0
 * @category constants
 */
export const REPO_FILE_READ_CAP_BYTES = 256 * 1024
/** A directory answers at most this many entries (sorted by name), and says so with `truncated`.
 * @since 1.0.0
 * @category constants
 */
export const REPO_LISTING_CAP_ENTRIES = 2000
/**
 * Validates repo files request values at the RPC boundary.
 *
 * @since 1.0.0
 * @category schemas
 */
export const RepoFilesRequestSchema = z.object({
  repoId: z.string().min(1),
  /** Relative to the repository root; "" or absent is the root. */
  path: z.string().max(4096).optional()
}).strict()
/**
 * The decoded value accepted by {@link RepoFilesRequestSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type RepoFilesRequest = z.infer<typeof RepoFilesRequestSchema>
/**
 * Validates repo file entry values at the RPC boundary.
 *
 * @since 1.0.0
 * @category schemas
 */
export const RepoFileEntrySchema = z.object({ name: z.string(), kind: z.enum(["file", "dir"]) })
/**
 * The decoded value accepted by {@link RepoFileEntrySchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type RepoFileEntry = z.infer<typeof RepoFileEntrySchema>
/**
 * Validates repo files response values at the RPC boundary.
 *
 * @since 1.0.0
 * @category schemas
 */
export const RepoFilesResponseSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("dir"),
    path: z.string(),
    entries: z.array(RepoFileEntrySchema),
    /** True when the directory holds more than REPO_LISTING_CAP_ENTRIES; the entries are the first page by name. */
    truncated: z.boolean().optional()
  }),
  z.object({
    kind: z.literal("file"),
    path: z.string(),
    size: z.number().int().nonnegative(),
    content: z.string(),
    truncated: z.boolean(),
    binary: z.boolean(),
    /**
     * SHA-256 of the bytes read, hex. The file card keeps it; a language
     * server answer carries the digest of the text it was asked about, so
     * the card can tell an answer about the file it shows from one about a
     * newer file on disk. Optional for peers and fixtures that predate it.
     */
    digest: z.string().optional()
  })
])
/**
 * The decoded value accepted by {@link RepoFilesResponseSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type RepoFilesResponse = z.infer<typeof RepoFilesResponseSchema>

/**
 * Validates pty session values at the RPC boundary.
 *
 * @since 1.0.0
 * @category schemas
 */
export const PtySessionSchema = z.object({
  sessionId: z.string(),
  kind: z.enum(["terminal", "harness"]),
  harnessId: z.enum(HARNESS_IDS).optional(),
  cwd: z.string(),
  pid: z.number(),
  alive: z.boolean(),
  /** The exit code once the process has exited (null when it died by signal); absent while alive. */
  exitCode: z.number().nullable().optional()
})
/**
 * The decoded value accepted by {@link PtySessionSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type PtySession = z.infer<typeof PtySessionSchema>

/*
 * One Smithers target as `smithers-build query '//...' --format json` lists it
 * (LOCAL-APP.md "Targets: load and run"): the loader's `{ label, target,
 * kinds }` row plus the label split into its package and name.
 */
/**
 * Validates target definition values at the RPC boundary.
 *
 * @since 1.0.0
 * @category schemas
 */
export const TargetDefinitionSchema = z.object({
  label: z.string(),
  target: z.string(),
  /** Open strings: whatever the rule declares, not a closed set the contract pins. */
  kinds: z.array(z.string()),
  package: z.string(),
  name: z.string(),
  /** The detected workspace the loader ran in ("." for the repo root). */
  workspace: z.string(),
  /** The declaration's one-line summary (PACKAGE.ts `summary: "..."`), shown under the label. */
  summary: z.string().optional(),
  /** The declaration marks the target featured (PACKAGE.ts `featured: true`): it leads the Featured view. */
  featured: z.boolean().optional()
})
/**
 * The decoded value accepted by {@link TargetDefinitionSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type TargetDefinition = z.infer<typeof TargetDefinitionSchema>

/** The browser receives an opaque id minted by the local repository authority.
 * @since 1.0.0
 * @category schemas
 */
export const TargetSchema = TargetDefinitionSchema.extend({ id: z.string().min(1) })
/**
 * The decoded value accepted by {@link TargetSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type Target = z.infer<typeof TargetSchema>

/** `POST /api/targets/query`
 * @since 1.0.0
 * @category schemas
 */
export const TargetsQueryResponseSchema = z.object({
  targets: z.array(TargetSchema),
  warnings: z.array(z.string()),
  durationMs: z.number()
})
/**
 * The decoded value accepted by {@link TargetsQueryResponseSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type TargetsQueryResponse = z.infer<typeof TargetsQueryResponseSchema>

/** `POST /api/targets/run`
 * @since 1.0.0
 * @category schemas
 */
export const TargetRunResponseSchema = z.object({ runId: z.string() })

/*
 * One frame on the WS topic `target-run:<runId>` IS one recorded run event:
 * the client parses what the backend recorded, field for field. The union
 * lives once, on @smthrs/rpc/TargetGraph `TargetRunEventSchema`; this is the
 * client-side name for it.
 *
 * It must stay one schema, not a copy. A zod object strips what it does not
 * declare, so while the copy here was missing `seq` the ordering key was
 * silently deleted off every frame in flight. `seq` is the run-local, 0-based,
 * gap-free frame number and the ONLY total order replay has, because
 * stdout/stderr/exit/error frames carry no `at` of their own.
 */
/** One frame on the WS topic `target-run:<runId>`.
 * @since 1.0.0
 * @category schemas
 */
export const TargetRunFrameSchema = TargetRunEventSchema
/**
 * The decoded value accepted by {@link TargetRunFrameSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type TargetRunFrame = TargetRunEvent

/** The server -> client envelope carrying a run frame.
 * @since 1.0.0
 * @category schemas
 */
export const TargetRunMessageSchema = z.object({
  type: z.literal("target-run"),
  runId: z.string(),
  frame: TargetRunFrameSchema
})
/**
 * The decoded value accepted by {@link TargetRunMessageSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type TargetRunMessage = z.infer<typeof TargetRunMessageSchema>

/** Splits a `//pkg/path:name` label into its package and name.
 * @since 1.0.0
 * @category conversions
 */
export const splitLabel = (label: string): { readonly package: string; readonly name: string } => {
  const colon = label.lastIndexOf(":")
  if (colon < 0) return { package: label, name: label.replace(/^\/\//, "").split("/").pop() ?? label }
  return { package: label.slice(0, colon), name: label.slice(colon + 1) }
}

/** `GET /api/harnesses`
 * @since 1.0.0
 * @category schemas
 */
export const HarnessesResponseSchema = z.object({ harnesses: z.array(HarnessSchema) })
/** `GET /api/repos`
 * @since 1.0.0
 * @category schemas
 */
export const ReposResponseSchema = z.object({ repos: z.array(RepoSchema) })
/** `POST /api/pty`
 * @since 1.0.0
 * @category schemas
 */
export const PtyCreateResponseSchema = z.object({ sessionId: z.string() })

/** `GET /api/pty/:id/output`: the session's recent output (the tail of a bounded scrollback).
 * @since 1.0.0
 * @category schemas
 */
export const PtyOutputResponseSchema = z.object({
  sessionId: z.string(),
  alive: z.boolean(),
  /** Plain text: ANSI escapes stripped, carriage returns dropped. */
  output: z.string(),
  /** True when older output fell out of the bounded buffer or was cut by `tail`. */
  truncated: z.boolean()
})
/**
 * The decoded value accepted by {@link PtyOutputResponseSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type PtyOutputResponse = z.infer<typeof PtyOutputResponseSchema>

/*
 * Code intelligence, the Smithers Cloud seam, and the Linear handoff moved to
 * their own modules: import them from `./LocalLsp.ts`, `./CloudTunnel.ts`,
 * and `./LinearAuth.ts`. These re-exports keep the old import path working
 * for one release and cover only the names that existed at the move; a new
 * name is exported from its home alone.
 */
export {
  CLOUD_AUTH_SESSION_PATH,
  CLOUD_AUTH_SIGN_OUT_PATH,
  CLOUD_AUTH_START_PATH,
  CLOUD_LSP_FRAME_CAP_BYTES,
  CLOUD_LSP_REASSEMBLY_CAP_BYTES,
  CLOUD_LSP_ROOT_URI,
  CLOUD_LSP_SUBPROTOCOL,
  CLOUD_ROUTE_PREFIX,
  CLOUD_TERMINAL_FRAME_CAP_BYTES,
  CLOUD_WS_NOT_READY_CLOSE_CODE,
  CLOUD_WS_PENDING_CLOSE_CODE,
  CLOUD_WS_ROUTE_PREFIX,
  CLOUD_WS_SESSION_KINDS,
  CloudAuthStartResponseSchema,
  CloudLspFragmentSchema,
  CloudLspSessionSchema,
  CloudSessionSchema,
  retryAfterOf,
  withRetryAfter
} from "./CloudTunnel.ts"
export type {
  CloudAuthStartResponse,
  CloudLspFragment,
  CloudLspSession,
  CloudSession,
  CloudWsSessionKind
} from "./CloudTunnel.ts"
export {
  LINEAR_AUTH_SESSION_PATH,
  LINEAR_AUTH_START_PATH,
  LinearAuthSessionSchema,
  LinearAuthStartResponseSchema
} from "./LinearAuth.ts"
export type { LinearAuthSession, LinearAuthStartResponse } from "./LinearAuth.ts"
export {
  LSP_DEFINITION_PATH,
  LSP_DIAGNOSTICS_CAP,
  LSP_DIAGNOSTICS_PATH,
  LSP_HOVER_CAP_CHARS,
  LSP_HOVER_PATH,
  LSP_LANGUAGE_EXTENSIONS,
  LSP_LANGUAGE_IDS,
  LSP_LANGUAGE_SERVER_MISSING,
  LSP_LOCATIONS_CAP,
  LSP_PATH,
  LSP_REQUEST_BODY_CAP_BYTES,
  LSP_REQUEST_TIMEOUT_MS,
  LSP_SERVER_STATES,
  LSP_SERVERS_PATH,
  LSP_SEVERITIES,
  LspDefinitionResponseSchema,
  LspDiagnosticSchema,
  LspDiagnosticsMessageSchema,
  LspDiagnosticsResponseSchema,
  LspErrorResponseSchema,
  LspFileRequestSchema,
  LspHoverResponseSchema,
  LspHoverSchema,
  lspLanguageFor,
  LspLanguageIdSchema,
  LspLocationSchema,
  LspPositionRequestSchema,
  LspRangeSchema,
  LspServersResponseSchema,
  LspServerStatusSchema,
  LspSeveritySchema,
  lspTopic
} from "./LocalLsp.ts"
export type {
  LspDefinitionResponse,
  LspDiagnostic,
  LspDiagnosticsMessage,
  LspDiagnosticsResponse,
  LspErrorResponse,
  LspFileRequest,
  LspHover,
  LspHoverResponse,
  LspLanguageId,
  LspLocation,
  LspPositionRequest,
  LspRange,
  LspServersResponse,
  LspServerStatus,
  LspSeverity
} from "./LocalLsp.ts"

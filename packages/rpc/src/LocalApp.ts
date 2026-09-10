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

/*
 * Code intelligence on the local origin (apps/ui/docs/code-intel/PLAN.md §3):
 * one language server per (repository, language), owned by the Bun host and
 * reached over POST routes the way PTYs are; the renderer never names a
 * binary, an argv, or a cwd. Positions are 1-based on the wire and in flows
 * and converted once at the session. Paths are relative to the repository
 * root and pass the same segment check as REPO_FILES_PATH; access is a read.
 * The caps are what the host applies before answering, and the schemas
 * refuse anything past them, so an over-cap answer fails to parse instead of
 * rendering. A missing language server is stated with its install line and
 * never installed.
 */
/**
 * The lsp route shared by server and client.
 *
 * @since 1.0.0
 * @category constants
 */
export const LSP_PATH = "/api/lsp"
/** `POST`: the hover at a position.
 * @since 1.0.0
 * @category constants
 */
export const LSP_HOVER_PATH = `${LSP_PATH}/hover`
/** `POST`: the definitions of the symbol at a position.
 * @since 1.0.0
 * @category constants
 */
export const LSP_DEFINITION_PATH = `${LSP_PATH}/definition`
/** `POST`: the server's first publication for the file after it opens (bounded by LSP_REQUEST_TIMEOUT_MS).
 * @since 1.0.0
 * @category constants
 */
export const LSP_DIAGNOSTICS_PATH = `${LSP_PATH}/diagnostics`
/** `GET`: the language servers the host is running.
 * @since 1.0.0
 * @category constants
 */
export const LSP_SERVERS_PATH = `${LSP_PATH}/servers`
/** The `/ws` topic a repository's diagnostics stream rides; the renderer subscribes as it does to `pty:<sessionId>`.
 * @since 1.0.0
 * @category conversions
 */
export const lspTopic = (repoId: string): string => `lsp:${repoId}`

/** v1 is TypeScript (`typescript-language-server --stdio`); the host's server table gains a row here first.
 * @since 1.0.0
 * @category constants
 */
export const LSP_LANGUAGE_IDS = ["typescript"] as const
/**
 * Validates lsp language id values at the RPC boundary.
 *
 * @since 1.0.0
 * @category schemas
 */
export const LspLanguageIdSchema = z.enum(LSP_LANGUAGE_IDS)
/**
 * The decoded value accepted by {@link LspLanguageIdSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type LspLanguageId = z.infer<typeof LspLanguageIdSchema>
/**
 * The file extensions each language's server handles. The host registry
 * (apps/ui/src/bun/lsp/LanguageServers.ts) reads its rows from here, and the
 * renderer asks the same table which file cards code intelligence serves at
 * all, so a host without the `local.lsp` door can say so on exactly those.
 * @since 1.0.0
 * @category constants
 */
export const LSP_LANGUAGE_EXTENSIONS: Readonly<Record<LspLanguageId, ReadonlyArray<string>>> = {
  typescript: [".ts", ".mts", ".cts", ".tsx", ".js", ".mjs", ".cjs", ".jsx"]
}
/** The language whose server handles the path's extension, or null when no row does.
 * @since 1.0.0
 * @category conversions
 */
export const lspLanguageFor = (path: string): LspLanguageId | null => {
  const extension = /\.[^./]+$/.exec(path)?.[0]?.toLowerCase()
  if (extension === undefined) return null
  return LSP_LANGUAGE_IDS.find((id) => LSP_LANGUAGE_EXTENSIONS[id].includes(extension)) ?? null
}

/** Hover text is cut here; the card and the model see the same text.
 * @since 1.0.0
 * @category constants
 */
export const LSP_HOVER_CAP_CHARS = 4 * 1024
/**
 * Shared lsp diagnostics cap used by the host and its clients.
 *
 * @since 1.0.0
 * @category constants
 */
export const LSP_DIAGNOSTICS_CAP = 50
/**
 * Shared lsp locations cap used by the host and its clients.
 *
 * @since 1.0.0
 * @category constants
 */
export const LSP_LOCATIONS_CAP = 20
/** A request body past this answers 413.
 * @since 1.0.0
 * @category constants
 */
export const LSP_REQUEST_BODY_CAP_BYTES = 64 * 1024
/** One request's ceiling at the host and the client.
 * @since 1.0.0
 * @category constants
 */
export const LSP_REQUEST_TIMEOUT_MS = 5_000
/** The error code of the 409 whose `install` line the card prints.
 * @since 1.0.0
 * @category constants
 */
export const LSP_LANGUAGE_SERVER_MISSING = "language_server_missing"

const lspOrdinal = z.number().int().min(1)
const lspRepoId = z.string().min(1)
const lspRepoPath = z.string().min(1).max(4096)
/**
 * The digest (RepoFilesResponse.digest) of the file text the server was
 * asked about. A file card whose own digest differs shows a file the answer
 * is not about; the renderer re-reads the card before it draws the answer.
 */
const lspDigest = z.string().min(1)
const lspCount = z.number().int().nonnegative()

/** A span, 1-based on both ends; `endCharacter` is exclusive, as the server's is. */
const lspRangeShape = { line: lspOrdinal, character: lspOrdinal, endLine: lspOrdinal, endCharacter: lspOrdinal }
/**
 * Validates lsp range values at the RPC boundary.
 *
 * @since 1.0.0
 * @category schemas
 */
export const LspRangeSchema = z.object(lspRangeShape)
/**
 * The decoded value accepted by {@link LspRangeSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type LspRange = z.infer<typeof LspRangeSchema>

/** `POST /api/lsp/hover` and `/api/lsp/definition`.
 * @since 1.0.0
 * @category schemas
 */
export const LspPositionRequestSchema = z.object({
  repoId: lspRepoId,
  /** Relative to the repository root. */
  path: lspRepoPath,
  line: lspOrdinal,
  character: lspOrdinal
}).strict()
/**
 * The decoded value accepted by {@link LspPositionRequestSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type LspPositionRequest = z.infer<typeof LspPositionRequestSchema>
/** `POST /api/lsp/diagnostics`.
 * @since 1.0.0
 * @category schemas
 */
export const LspFileRequestSchema = z.object({ repoId: lspRepoId, path: lspRepoPath }).strict()
/**
 * The decoded value accepted by {@link LspFileRequestSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type LspFileRequest = z.infer<typeof LspFileRequestSchema>

/**
 * Shared lsp severities used by the host and its clients.
 *
 * @since 1.0.0
 * @category constants
 */
export const LSP_SEVERITIES = ["error", "warning", "information", "hint"] as const
/**
 * Validates lsp severity values at the RPC boundary.
 *
 * @since 1.0.0
 * @category schemas
 */
export const LspSeveritySchema = z.enum(LSP_SEVERITIES)
/**
 * The decoded value accepted by {@link LspSeveritySchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type LspSeverity = z.infer<typeof LspSeveritySchema>

/** One diagnostic as the card and the model see it; the session maps the server's numeric severity once.
 * @since 1.0.0
 * @category schemas
 */
export const LspDiagnosticSchema = z.object({
  ...lspRangeShape,
  severity: LspSeveritySchema,
  message: z.string(),
  /** The producer as the server names it (`ts`); absent when it names none. */
  source: z.string().optional(),
  /** The server's code as text (`2551`); absent when it names none. */
  code: z.string().optional()
})
/**
 * The decoded value accepted by {@link LspDiagnosticSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type LspDiagnostic = z.infer<typeof LspDiagnosticSchema>

/** A definition target. `path` is relative to the repository root; the host omits targets outside it.
 * @since 1.0.0
 * @category schemas
 */
export const LspLocationSchema = z.object({ path: z.string().min(1), ...lspRangeShape })
/**
 * The decoded value accepted by {@link LspLocationSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type LspLocation = z.infer<typeof LspLocationSchema>

/**
 * Validates lsp hover values at the RPC boundary.
 *
 * @since 1.0.0
 * @category schemas
 */
export const LspHoverSchema = z.object({
  /**
   * Markdown as the server wrote it, with the host's absolute paths made
   * repository-relative (or cut to their last segment outside it), then cut
   * at LSP_HOVER_CAP_CHARS.
   */
  contents: z.string().max(LSP_HOVER_CAP_CHARS),
  /** True when the cap cut the server's text; the card and the model state the cut. */
  truncated: z.boolean(),
  /** The token the hover describes, when the server says. */
  range: LspRangeSchema.optional()
})
/**
 * The decoded value accepted by {@link LspHoverSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type LspHover = z.infer<typeof LspHoverSchema>

/** `POST /api/lsp/hover`: `hover` is null when the server has nothing at the position.
 * @since 1.0.0
 * @category schemas
 */
export const LspHoverResponseSchema = z.object({ hover: LspHoverSchema.nullable(), digest: lspDigest })
/**
 * The decoded value accepted by {@link LspHoverResponseSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type LspHoverResponse = z.infer<typeof LspHoverResponseSchema>
/**
 * `POST /api/lsp/definition`: `total` is how many targets the server named,
 * `omitted` how many of them lie outside the repository (not a file card the
 * renderer can open), and `locations` the rest up to the cap — so an empty
 * list with `omitted > 0` is a definition elsewhere, never "none found".
 * @since 1.0.0
 * @category schemas
 */
export const LspDefinitionResponseSchema = z.object({
  locations: z.array(LspLocationSchema).max(LSP_LOCATIONS_CAP),
  total: lspCount,
  omitted: lspCount,
  digest: lspDigest
})
/**
 * The decoded value accepted by {@link LspDefinitionResponseSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type LspDefinitionResponse = z.infer<typeof LspDefinitionResponseSchema>
/**
 * `POST /api/lsp/diagnostics`: `items` is what the server published for
 * `version` up to the cap and `total` how many it published, or both null
 * when it published nothing within the wait. An unread file has no count:
 * the card states none until the stream carries one.
 * @since 1.0.0
 * @category schemas
 */
export const LspDiagnosticsResponseSchema = z.object({
  path: z.string(),
  /** The server's document version the items belong to; null when it names none or has not published. */
  version: z.number().int().nonnegative().nullable(),
  items: z.array(LspDiagnosticSchema).max(LSP_DIAGNOSTICS_CAP).nullable(),
  total: lspCount.nullable(),
  digest: lspDigest
})
/**
 * The decoded value accepted by {@link LspDiagnosticsResponseSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type LspDiagnosticsResponse = z.infer<typeof LspDiagnosticsResponseSchema>

/** One frame on the WS topic `lsp:<repoId>`: the server's publication for one file.
 * @since 1.0.0
 * @category schemas
 */
export const LspDiagnosticsMessageSchema = z.object({
  type: z.literal("lsp.diagnostics"),
  repoId: z.string(),
  path: z.string(),
  version: z.number().int().nonnegative().nullable(),
  items: z.array(LspDiagnosticSchema).max(LSP_DIAGNOSTICS_CAP),
  total: lspCount,
  digest: lspDigest
})
/**
 * The decoded value accepted by {@link LspDiagnosticsMessageSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type LspDiagnosticsMessage = z.infer<typeof LspDiagnosticsMessageSchema>

/**
 * Shared lsp server states used by the host and its clients.
 *
 * @since 1.0.0
 * @category constants
 */
export const LSP_SERVER_STATES = ["starting", "ready", "exited"] as const
/**
 * Validates lsp server status values at the RPC boundary.
 *
 * @since 1.0.0
 * @category schemas
 */
export const LspServerStatusSchema = z.object({
  repoId: z.string(),
  language: LspLanguageIdSchema,
  state: z.enum(LSP_SERVER_STATES)
})
/**
 * The decoded value accepted by {@link LspServerStatusSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type LspServerStatus = z.infer<typeof LspServerStatusSchema>
/** `GET /api/lsp/servers`
 * @since 1.0.0
 * @category schemas
 */
export const LspServersResponseSchema = z.object({ servers: z.array(LspServerStatusSchema) })
/**
 * The decoded value accepted by {@link LspServersResponseSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type LspServersResponse = z.infer<typeof LspServersResponseSchema>

/**
 * A failed answer, the `{ error: { code, message } }` envelope the repository
 * routes use. `409 language_server_missing` carries the install line verbatim
 * in `install`; the card prints it and nothing installs it.
 * @since 1.0.0
 * @category schemas
 */
export const LspErrorResponseSchema = z.object({
  error: z.object({ code: z.string(), message: z.string(), install: z.string().optional() })
})
/**
 * The decoded value accepted by {@link LspErrorResponseSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type LspErrorResponse = z.infer<typeof LspErrorResponseSchema>

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

/*
 * The Smithers Cloud seam on the local origin
 * (apps/ui/docs/decisions/0001-piper-one-truth.md): `/api/cloud/*` proxies to
 * the cloud API (SMITHERS_CLOUD_API, default https://api.jjhub.tech) with the
 * Bun-held bearer attached, and the `/api/cloud-auth/*` routes run the CLI's
 * browser login. The token NEVER reaches the renderer: the session answer
 * carries only what a person sees.
 */
/**
 * The cloud route prefix route shared by server and client.
 *
 * @since 1.0.0
 * @category constants
 */
export const CLOUD_ROUTE_PREFIX = "/api/cloud/"
/*
 * Lane citc: the workspace-terminal WebSocket tunnel. A browser upgrade can
 * carry no custom header, so this route authorizes like `/ws` — the local
 * session capability rides the subprotocol — and Bun bridges the socket to
 * the cloud API's terminal WebSocket with the Bun-held bearer and plue's
 * `terminal` subprotocol attached upstream.
 */
/**
 * The cloud ws route prefix route shared by server and client.
 *
 * @since 1.0.0
 * @category constants
 */
export const CLOUD_WS_ROUTE_PREFIX = "/api/cloud-ws/"
/*
 * Lane L6 — the cloud language-server relay (plue #505; apps/ui/docs/code-intel/
 * PLAN.md "Live"): the same tunnel carries `…/workspace/sessions/{id}/lsp`
 * with plue's `lsp` subprotocol. One JSON-RPC 2.0 message per text frame,
 * 1 MiB per frame; a larger message crosses as `{ seq, last, data }`
 * fragments (seq from 1) that the renderer reassembles, up to 16 MiB. The
 * session is `POST …/workspace/sessions { workspace_id, kind: "lsp",
 * language }`, one per (workspace, language), and the guest's checkout is the
 * server's one workspace folder. A refused upgrade reaches the renderer as a
 * 44xx close code that mirrors plue's HTTP status (ADR 0002's 4401 … 4429,
 * plus 4425 `workspace_session_pending` and 4503 `guest_not_ready`), its
 * reason plue's `code: message` verbatim and, when the refusal named a
 * `Retry-After`, that instruction in words at the end of the reason.
 */
/**
 * Shared cloud ws session kinds used by the host and its clients.
 *
 * @since 1.0.0
 * @category constants
 */
export const CLOUD_WS_SESSION_KINDS = ["terminal", "lsp"] as const
/**
 * The cloud ws session kind contract shared by the host and its clients.
 *
 * @since 1.0.0
 * @category models
 */
export type CloudWsSessionKind = (typeof CLOUD_WS_SESSION_KINDS)[number]
/**
 * Shared cloud lsp subprotocol used by the host and its clients.
 *
 * @since 1.0.0
 * @category constants
 */
export const CLOUD_LSP_SUBPROTOCOL = "lsp"
/** plue's terminal route caps a message at 64 KiB.
 * @since 1.0.0
 * @category constants
 */
export const CLOUD_TERMINAL_FRAME_CAP_BYTES = 64 * 1024
/** plue's lsp route caps a frame at 1 MiB; hover and diagnostics exceed 64 KiB.
 * @since 1.0.0
 * @category constants
 */
export const CLOUD_LSP_FRAME_CAP_BYTES = 1024 * 1024
/** A fragmented message is reassembled up to this many bytes; past it the message is dropped.
 * @since 1.0.0
 * @category constants
 */
export const CLOUD_LSP_REASSEMBLY_CAP_BYTES = 16 * 1024 * 1024
/** The guest's checkout: the server's `rootUri` and its one workspace folder.
 * @since 1.0.0
 * @category constants
 */
export const CLOUD_LSP_ROOT_URI = "file:///home/developer/workspace"
/** One fragment of a message larger than a frame: `seq` counts from 1 and `last` closes the set.
 * @since 1.0.0
 * @category schemas
 */
export const CloudLspFragmentSchema = z.object({ seq: z.number().int().min(1), last: z.boolean(), data: z.string() })
  .strict()
/**
 * The decoded value accepted by {@link CloudLspFragmentSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type CloudLspFragment = z.infer<typeof CloudLspFragmentSchema>
/** The 201 of the session POST with `kind: "lsp"`, as far as the client reads it.
 * @since 1.0.0
 * @category schemas
 */
export const CloudLspSessionSchema = z.object({
  id: z.string().min(1),
  status: z.string(),
  kind: z.literal("lsp"),
  language: z.string().min(1)
})
/**
 * The decoded value accepted by {@link CloudLspSessionSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type CloudLspSession = z.infer<typeof CloudLspSessionSchema>
/**
 * Shared cloud ws pending close code used by the host and its clients.
 *
 * @since 1.0.0
 * @category constants
 */
export const CLOUD_WS_PENDING_CLOSE_CODE = 4425
/**
 * Shared cloud ws not ready close code used by the host and its clients.
 *
 * @since 1.0.0
 * @category constants
 */
export const CLOUD_WS_NOT_READY_CLOSE_CODE = 4503
/** The close reason with the refusal's `Retry-After` in words; `retryAfterOf` reads it back.
 * @since 1.0.0
 * @category conversions
 */
export const withRetryAfter = (reason: string, seconds: number): string => `${reason} (retry after ${seconds} s)`
/** The `Retry-After` seconds a close reason names, or null when it names none.
 * @since 1.0.0
 * @category conversions
 */
export const retryAfterOf = (reason: string): number | null => {
  const match = /\(retry after (\d+) s\)$/.exec(reason.trim())
  return match === null ? null : Number(match[1])
}
/**
 * The cloud auth start route shared by server and client.
 *
 * @since 1.0.0
 * @category constants
 */
export const CLOUD_AUTH_START_PATH = "/api/cloud-auth/start"
/**
 * The cloud auth session route shared by server and client.
 *
 * @since 1.0.0
 * @category constants
 */
export const CLOUD_AUTH_SESSION_PATH = "/api/cloud-auth/session"
/**
 * The cloud auth sign out route shared by server and client.
 *
 * @since 1.0.0
 * @category constants
 */
export const CLOUD_AUTH_SIGN_OUT_PATH = "/api/cloud-auth/sign-out"
/**
 * Validates cloud session values at the RPC boundary.
 *
 * @since 1.0.0
 * @category schemas
 */
export const CloudSessionSchema = z.object({
  state: z.enum(["signed-out", "signing-in", "signed-in"]),
  username: z.string().nullable(),
  expiresAt: z.string().nullable(),
  /**
   * Set when the post-sign-in scope probe (GET /api/user/workspaces) answered
   * 403 insufficient-scope: the legacy token set lacks workspace/agent/
   * approval scopes, so those acts must say "sign in again to enable".
   */
  scopes: z.literal("degraded").optional()
})
/**
 * The decoded value accepted by {@link CloudSessionSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type CloudSession = z.infer<typeof CloudSessionSchema>
/** `POST /api/cloud-auth/start`
 * @since 1.0.0
 * @category schemas
 */
export const CloudAuthStartResponseSchema = z.object({ url: z.string() })
/**
 * The decoded value accepted by {@link CloudAuthStartResponseSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type CloudAuthStartResponse = z.infer<typeof CloudAuthStartResponseSchema>

/*
 * Lane sync (ADR 0005): the Linear OAuth handoff on the local origin. The
 * backend's OAuth callback cannot redirect to the app (its redirect URI is
 * fixed at the API host), so the local origin runs the receiver the settled
 * team-pick flow needs: `start` listens on 127.0.0.1:<random> and answers
 * the OAuth start URL (through the `/api/cloud/*` proxy, so the Bun-held
 * bearer authenticates it) with `callback_port` attached — the same shape
 * the CLI login already speaks. `callback` records the `?setup=<key>` the
 * callback redirects with; `session` answers it to the renderer. The key is
 * an opaque, one-time, user-bound handle (plue#469) — never a token.
 */
/**
 * The linear auth start route shared by server and client.
 *
 * @since 1.0.0
 * @category constants
 */
export const LINEAR_AUTH_START_PATH = "/api/linear-auth/start"
/**
 * The linear auth session route shared by server and client.
 *
 * @since 1.0.0
 * @category constants
 */
export const LINEAR_AUTH_SESSION_PATH = "/api/linear-auth/session"
/**
 * Validates linear auth session values at the RPC boundary.
 *
 * @since 1.0.0
 * @category schemas
 */
export const LinearAuthSessionSchema = z.object({
  state: z.enum(["idle", "waiting", "authorized"]),
  /** Present only in the authorized state. */
  setupKey: z.string().optional()
})
/**
 * The decoded value accepted by {@link LinearAuthSessionSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type LinearAuthSession = z.infer<typeof LinearAuthSessionSchema>
/** `POST /api/linear-auth/start`
 * @since 1.0.0
 * @category schemas
 */
export const LinearAuthStartResponseSchema = z.object({ url: z.string() })
/**
 * The decoded value accepted by {@link LinearAuthStartResponseSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type LinearAuthStartResponse = z.infer<typeof LinearAuthStartResponseSchema>

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

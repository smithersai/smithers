import { describe, expect, test } from "vitest"
import {
  CLOUD_LSP_FRAME_CAP_BYTES,
  CLOUD_LSP_REASSEMBLY_CAP_BYTES,
  CLOUD_LSP_ROOT_URI,
  CLOUD_LSP_SUBPROTOCOL,
  CLOUD_TERMINAL_FRAME_CAP_BYTES,
  CLOUD_WS_NOT_READY_CLOSE_CODE,
  CLOUD_WS_PENDING_CLOSE_CODE,
  CLOUD_WS_SESSION_KINDS,
  CloudAuthStartResponseSchema,
  CloudLspFragmentSchema,
  CloudLspSessionSchema,
  CloudSessionSchema,
  HarnessesResponseSchema,
  HarnessSchema,
  LinearAuthSessionSchema,
  LSP_DEFINITION_PATH,
  LSP_DIAGNOSTICS_CAP,
  LSP_DIAGNOSTICS_PATH,
  LSP_HOVER_CAP_CHARS,
  LSP_HOVER_PATH,
  LSP_LANGUAGE_SERVER_MISSING,
  LSP_LOCATIONS_CAP,
  LSP_SERVERS_PATH,
  LSP_SEVERITIES,
  LspDefinitionResponseSchema,
  LspDiagnosticSchema,
  LspDiagnosticsMessageSchema,
  LspDiagnosticsResponseSchema,
  LspErrorResponseSchema,
  LspFileRequestSchema,
  LspHoverResponseSchema,
  lspLanguageFor,
  LspLocationSchema,
  LspPositionRequestSchema,
  LspRangeSchema,
  LspServersResponseSchema,
  LspSeveritySchema,
  lspTopic,
  patternRunTitle,
  PtyCreateResponseSchema,
  PtyOutputResponseSchema,
  PtySessionSchema,
  RepoFilesRequestSchema,
  RepoFilesResponseSchema,
  RepoSchema,
  retryAfterOf,
  splitLabel,
  TARGET_LABEL,
  TARGET_PATTERN,
  TARGET_RUN_VERBS,
  TargetRunFrameSchema,
  TargetRunMessageSchema,
  TargetRunResponseSchema,
  TargetRunVerbSchema,
  TargetSchema,
  TargetsQueryResponseSchema,
  withRetryAfter
} from "../src/LocalApp.ts"
import { RunReplayResponseSchema, TargetRunEventSchema } from "../src/TargetGraph.ts"

/*
 * The local-app wire model (apps/ui/docs/LOCAL-APP.md "Targets: load and
 * run"): a repository carries its detected workspaces, and a target carries
 * the workspace its loader ran in plus the presentation its declaration
 * stated. There is no repository manifest: a target's summary and featured
 * flag ride the PACKAGE.ts declaration and arrive through the loader listing.
 */

describe("multi-workspace repo wire model", () => {
  test("Repo.smithers carries the detected workspaces and the repo carries warnings", () => {
    const repo = RepoSchema.parse({
      id: "r1",
      path: "/work/aomi",
      name: "aomi",
      git: null,
      warnings: [],
      smithers: {
        detected: true,
        workspaceFile: ".smithers/WORKSPACE.ts",
        declarationFiles: [".smithers/WORKSPACE.ts"],
        reason: "2 workspaces detected",
        workspaces: [
          { path: ".", title: "aomi" },
          { path: "aomi-sdk", title: "aomi-sdk" }
        ]
      }
    })
    expect(repo.smithers.workspaces).toHaveLength(2)
    expect("plugin" in repo).toBe(false)
  })

  test("a Target carries the workspace its loader ran in, and the declaration's summary and featured flag when stated", () => {
    const bare = TargetSchema.parse({
      id: "target-capability",
      label: "//src:lint",
      target: "Shell.Test",
      kinds: ["lint"],
      package: "//src",
      name: "lint",
      workspace: "aomi-sdk"
    })
    expect(bare.workspace).toBe("aomi-sdk")
    expect(bare.summary).toBeUndefined()
    expect(bare.featured).toBeUndefined()
    const annotated = TargetSchema.parse({ ...bare, summary: "ESLint over the sdk.", featured: true })
    expect(annotated.summary).toBe("ESLint over the sdk.")
    expect(annotated.featured).toBe(true)
    expect(TargetSchema.safeParse({ ...bare, summary: 7 }).success).toBe(false)
  })
})

/*
 * A pattern run is a verb over a pattern (`ci //...`, how CI runs
 * everything): the pattern is a label or a `//dir/...` subtree.
 */
test("the pattern grammar accepts labels and subtrees and refuses the rest", () => {
  for (const pattern of ["//...", "//packages/...", "//:ci", "//packages/smithers/flows/canonical:check"]) {
    expect(TARGET_PATTERN.test(pattern)).toBe(true)
  }
  for (const pattern of ["//packages", "//packages/...:lint", "//a b/...", "packages/..."]) {
    expect(TARGET_PATTERN.test(pattern)).toBe(false)
  }
})

/*
 * Code intelligence on the local origin (apps/ui/docs/code-intel/PLAN.md §3):
 * positions are 1-based on the wire, paths are repository-relative, and the
 * host's caps are the schemas' bounds, so an answer past them fails to parse
 * instead of rendering.
 */
describe("the code-intelligence wire model", () => {
  const position = { repoId: "r1", path: "src/index.ts", line: 12, character: 5 }
  const range = { line: 12, character: 5, endLine: 12, endCharacter: 9 }
  const diagnostic = { ...range, severity: "error" as const, message: "boom", source: "ts", code: "2551" }
  const digest = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"

  test("the routes hang off /api/lsp and a repository's diagnostics ride lsp:<repoId>", () => {
    expect([LSP_HOVER_PATH, LSP_DEFINITION_PATH, LSP_DIAGNOSTICS_PATH, LSP_SERVERS_PATH])
      .toEqual(["/api/lsp/hover", "/api/lsp/definition", "/api/lsp/diagnostics", "/api/lsp/servers"])
    expect(lspTopic("r1")).toBe("lsp:r1")
  })

  test("a position request is 1-based and carries nothing the routes did not ask for", () => {
    expect(LspPositionRequestSchema.parse(position)).toEqual(position)
    expect(LspPositionRequestSchema.safeParse({ ...position, line: 0 }).success).toBe(false)
    expect(LspPositionRequestSchema.safeParse({ ...position, character: 0 }).success).toBe(false)
    expect(LspPositionRequestSchema.safeParse({ ...position, line: 1.5 }).success).toBe(false)
    expect(LspPositionRequestSchema.safeParse({ ...position, cwd: "/" }).success).toBe(false)
    expect(LspFileRequestSchema.parse({ repoId: "r1", path: "src/index.ts" })).toEqual({
      repoId: "r1",
      path: "src/index.ts"
    })
    expect(LspFileRequestSchema.safeParse({ repoId: "r1", path: "" }).success).toBe(false)
    expect(LspFileRequestSchema.safeParse({ repoId: "r1", path: "a".repeat(4097) }).success).toBe(false)
  })

  test("a range is four 1-based ordinals, a location is a repository-relative path plus that range, and severity is a closed set", () => {
    expect(LspRangeSchema.parse(range)).toEqual(range)
    // Every ordinal is whole and at least 1; column 0 and a fractional line are protocol errors, not "near enough".
    for (const key of ["line", "character", "endLine", "endCharacter"] as const) {
      expect(LspRangeSchema.safeParse({ ...range, [key]: 0 }).success).toBe(false)
      expect(LspRangeSchema.safeParse({ ...range, [key]: 1.5 }).success).toBe(false)
    }
    const location = { path: "src/lib.ts", ...range }
    expect(LspLocationSchema.parse(location)).toEqual(location)
    expect(LspLocationSchema.safeParse({ ...location, path: "" }).success).toBe(false)
    expect(LspLocationSchema.safeParse(range).success).toBe(false)
    expect(LSP_SEVERITIES).toEqual(["error", "warning", "information", "hint"])
    for (const severity of LSP_SEVERITIES) expect(LspSeveritySchema.parse(severity)).toBe(severity)
    expect(LspSeveritySchema.safeParse("fatal").success).toBe(false)
  })

  test("a hover is the server's markdown cut at the cap and says when it was cut, or null when the server had nothing there", () => {
    expect(LspHoverResponseSchema.parse({ hover: null, digest })).toEqual({ hover: null, digest })
    const hover = { contents: "const x: number", truncated: false, range }
    expect(LspHoverResponseSchema.parse({ hover, digest })).toEqual({ hover, digest })
    expect(
      LspHoverResponseSchema.safeParse({
        hover: { contents: "x".repeat(LSP_HOVER_CAP_CHARS + 1), truncated: true },
        digest
      }).success
    ).toBe(false)
    // The cut is stated, never inferred from the length; an answer without a digest names no file.
    expect(LspHoverResponseSchema.safeParse({ hover: { contents: "x" }, digest }).success).toBe(false)
    expect(LspHoverResponseSchema.safeParse({ hover }).success).toBe(false)
  })

  test("definitions are repository-relative locations, at most the cap, with the server's total and the count outside the repository", () => {
    const location = { path: "src/lib.ts", ...range }
    expect(LspDefinitionResponseSchema.parse({ locations: [location], total: 1, omitted: 0, digest }).locations)
      .toEqual([location])
    // An empty list with omitted targets is a definition elsewhere, and the shape carries that fact.
    expect(LspDefinitionResponseSchema.parse({ locations: [], total: 1, omitted: 1, digest }).omitted).toBe(1)
    expect(LspDefinitionResponseSchema.safeParse({ locations: [], digest }).success).toBe(false)
    expect(
      LspDefinitionResponseSchema.safeParse({
        locations: Array.from({ length: LSP_LOCATIONS_CAP + 1 }, () => location),
        total: 21,
        omitted: 0,
        digest
      }).success
    )
      .toBe(false)
  })

  test("diagnostics distinguish an empty publication from none within the wait, and carry the total behind the cap", () => {
    expect(
      LspDiagnosticsResponseSchema.parse({ path: "src/index.ts", version: 1, items: [diagnostic], total: 1, digest })
        .items
    ).toEqual([diagnostic])
    expect(LspDiagnosticsResponseSchema.parse({ path: "src/index.ts", version: 2, items: [], total: 0, digest }).items)
      .toEqual([])
    expect(
      LspDiagnosticsResponseSchema.parse({ path: "src/index.ts", version: null, items: null, total: null, digest })
        .items
    ).toBeNull()
    expect(
      LspDiagnosticsResponseSchema.parse({ path: "src/index.ts", version: 1, items: [diagnostic], total: 132, digest })
        .total
    ).toBe(132)
    expect(
      LspDiagnosticsResponseSchema.safeParse({ path: "src/index.ts", version: 1, items: [diagnostic], digest }).success
    ).toBe(false)
    expect(
      LspDiagnosticsResponseSchema.safeParse({
        path: "src/index.ts",
        version: 1,
        items: Array.from({ length: LSP_DIAGNOSTICS_CAP + 1 }, () => diagnostic),
        total: LSP_DIAGNOSTICS_CAP + 1,
        digest
      }).success
    ).toBe(false)
    expect(LspDiagnosticSchema.safeParse({ ...diagnostic, severity: 1 }).success).toBe(false)
  })

  test("the language table names the extensions each server handles, so the renderer knows which cards code intelligence serves", () => {
    expect(lspLanguageFor("src/App.tsx")).toBe("typescript")
    expect(lspLanguageFor("lib/index.MJS")).toBe("typescript")
    expect(lspLanguageFor("README.md")).toBeNull()
    expect(lspLanguageFor("package.json")).toBeNull()
    expect(lspLanguageFor("Makefile")).toBeNull()
  })

  test("the bus frame and the server list carry the same shapes", () => {
    const frame = {
      type: "lsp.diagnostics" as const,
      repoId: "r1",
      path: "src/index.ts",
      version: 3,
      items: [diagnostic],
      total: 3,
      digest
    }
    expect(LspDiagnosticsMessageSchema.parse(frame)).toEqual(frame)
    expect(
      LspServersResponseSchema.parse({ servers: [{ repoId: "r1", language: "typescript", state: "ready" }] }).servers[0]
        ?.state
    )
      .toBe("ready")
    expect(
      LspServersResponseSchema.safeParse({ servers: [{ repoId: "r1", language: "cobol", state: "ready" }] }).success
    ).toBe(false)
  })

  test("a failure names its code, and a missing server carries the install line verbatim", () => {
    const missing = LspErrorResponseSchema.parse({
      error: {
        code: LSP_LANGUAGE_SERVER_MISSING,
        message: "No TypeScript language server on this machine.",
        install: "npm i -g typescript-language-server typescript"
      }
    })
    expect(missing.error.code).toBe("language_server_missing")
    expect(missing.error.install).toBe("npm i -g typescript-language-server typescript")
    expect(LspErrorResponseSchema.parse({ error: { code: "timeout", message: "No answer within 5 s." } }).error.install)
      .toBeUndefined()
  })
})

/*
 * Lane L6: the cloud language-server relay through the tunnel (plue #505).
 * The renderer reads plue's fragments and the tunnel's close reasons; what
 * the two sides agree on is pinned here.
 */
describe("the cloud LSP relay contract", () => {
  test("the lsp branch has its own subprotocol, frame cap and reassembly cap, and the checkout is the root", () => {
    expect(CLOUD_WS_SESSION_KINDS).toEqual(["terminal", "lsp"])
    expect(CLOUD_LSP_SUBPROTOCOL).toBe("lsp")
    expect(CLOUD_TERMINAL_FRAME_CAP_BYTES).toBe(64 * 1024)
    expect(CLOUD_LSP_FRAME_CAP_BYTES).toBe(1024 * 1024)
    expect(CLOUD_LSP_REASSEMBLY_CAP_BYTES).toBe(16 * 1024 * 1024)
    expect(CLOUD_LSP_ROOT_URI).toBe("file:///home/developer/workspace")
  })

  test("a fragment is exactly { seq ≥ 1, last, data }; a session row is an lsp session with its language", () => {
    expect(CloudLspFragmentSchema.parse({ seq: 1, last: false, data: "{" })).toEqual({ seq: 1, last: false, data: "{" })
    expect(CloudLspFragmentSchema.safeParse({ seq: 0, last: true, data: "" }).success).toBe(false)
    expect(CloudLspFragmentSchema.safeParse({ seq: 1, last: true, data: "", extra: 1 }).success).toBe(false)
    expect(
      CloudLspSessionSchema.parse({
        id: "s1",
        workspace_id: "ws-1",
        status: "running",
        kind: "lsp",
        language: "typescript",
        idle_timeout_secs: 600
      })
    )
      .toEqual({ id: "s1", status: "running", kind: "lsp", language: "typescript" })
    expect(CloudLspSessionSchema.safeParse({ id: "s1", status: "running", kind: "terminal" }).success).toBe(false)
  })

  test("a refusal's Retry-After rides the close reason in words and reads back as seconds", () => {
    expect(CLOUD_WS_PENDING_CLOSE_CODE).toBe(4425)
    expect(CLOUD_WS_NOT_READY_CLOSE_CODE).toBe(4503)
    const reason = withRetryAfter("workspace_session_pending: session pending", 2)
    expect(reason).toBe("workspace_session_pending: session pending (retry after 2 s)")
    expect(retryAfterOf(reason)).toBe(2)
    expect(retryAfterOf("access revoked: token expired")).toBeNull()
    expect(retryAfterOf("guest_not_ready: activating (retry after 30 s) ")).toBe(30)
  })
})

/*
 * A WS frame and a recorded run event are the same value: the client parses
 * what the backend recorded. They were once two hand-written unions, and the
 * copy here silently stripped `seq` off every frame in flight.
 */
describe("TargetRunFrameSchema", () => {
  const frame = {
    type: "summary" as const,
    summary: {
      total: 3,
      hit: 1,
      ran: 2,
      failed: 0,
      skipped: 0,
      durationMs: 4900,
      ok: true,
      criticalPath: ["//src:srcs", "//src:typeCheck"]
    },
    at: 4,
    seq: 7
  }

  test("is the run-event union itself, not a second copy of it", () => {
    expect(TargetRunFrameSchema).toBe(TargetRunEventSchema)
  })

  test("a frame carrying every field survives the envelope and the replay envelope unchanged", () => {
    const envelope = TargetRunMessageSchema.parse({ type: "target-run", runId: "r1", frame })
    expect(envelope.frame).toEqual(frame)
    const replay = RunReplayResponseSchema.parse({
      run: {
        runId: "r1",
        repoId: "repo1",
        label: "//src:typeCheck",
        labels: ["//src:typeCheck"],
        status: "done",
        startedAt: 1,
        endedAt: 5
      },
      events: [frame]
    })
    expect(replay.events[0]).toEqual(frame)
    expect(replay.events[0]).toEqual(envelope.frame)
  })
})

/*
 * The harness table (apps/ui/docs/workbench-lanes/custom-agents.md): a row
 * says which binary the app found, whether that binary is signed in, and
 * whether it can be pointed at a model. The account and the model table are
 * the two facts a row may not have, and they say so differently: `account`
 * is present and null when nobody is signed in, while `models` is absent
 * when the app has verified no model flag, so a row persisted before custom
 * agents still parses.
 */
describe("the harness wire model", () => {
  const harness = {
    id: "claude" as const,
    displayName: "Claude Code",
    binary: "/opt/homebrew/bin/claude",
    version: "2.0.14",
    status: "signed-in" as const,
    account: { email: "will@smithers.sh", label: "Max" },
    launch: { argv: ["claude", "--print"] },
    models: { suggestions: ["claude-opus-5"], listable: true }
  }

  test("a row carries the binary, the sign-in state, the account and the model table", () => {
    expect(HarnessSchema.parse(harness)).toEqual(harness)
    expect(HarnessesResponseSchema.parse({ harnesses: [harness] }).harnesses[0]).toEqual(harness)
  })

  test("a harness with no binary, no account and no verified model flag is a row, not a parse failure", () => {
    const unavailable = {
      id: "hermes" as const,
      displayName: "Hermes",
      binary: null,
      version: null,
      status: "unavailable" as const,
      account: null,
      launch: { argv: [] }
    }
    const parsed = HarnessSchema.parse(unavailable)
    expect(parsed).toEqual(unavailable)
    expect(parsed.models).toBeUndefined()
  })

  test("an unknown harness id or sign-in state is refused, and a missing account is not the same as no account", () => {
    expect(HarnessSchema.safeParse({ ...harness, id: "claude-code" }).success).toBe(false)
    expect(HarnessSchema.safeParse({ ...harness, status: "logged-in" }).success).toBe(false)
    const { account: _account, ...withoutAccount } = harness
    expect(HarnessSchema.safeParse(withoutAccount).success).toBe(false)
    const { launch: _launch, ...withoutLaunch } = harness
    expect(HarnessSchema.safeParse(withoutLaunch).success).toBe(false)
    expect(HarnessSchema.safeParse({ ...harness, models: { suggestions: ["x"] } }).success).toBe(false)
  })
})

/*
 * A label names one target (`//pkg:name`, `//:name` for the root package)
 * and splits back into the package and the name the loader listed. A run is
 * one of the verbs `smithers-build` executes, and a pattern run reads as the
 * command a person would type.
 */
describe("target labels, run verbs and pattern-run titles", () => {
  test("a label is `//`, a package that may be empty, and a name after the one colon", () => {
    for (const label of ["//:ci", "//a/b:c", "//packages/rpc:check"]) {
      expect(TARGET_LABEL.test(label)).toBe(true)
    }
    // No colon, an empty name, a second colon, whitespace or a missing `//` are all not labels.
    for (const label of ["//a/b", "//a:", "//a:b:c", "//a b:c", "packages/rpc:check", "//..."]) {
      expect(TARGET_LABEL.test(label)).toBe(false)
    }
  })

  test("splitting a label gives back the package and the name; a label with no colon keeps its last segment as the name", () => {
    expect(splitLabel("//:x")).toEqual({ package: "//", name: "x" })
    expect(splitLabel("//a/b:c")).toEqual({ package: "//a/b", name: "c" })
    expect(splitLabel("//packages/rpc:check")).toEqual({ package: "//packages/rpc", name: "check" })
    expect(splitLabel("//a/b")).toEqual({ package: "//a/b", name: "b" })
    expect(splitLabel("//pkg")).toEqual({ package: "//pkg", name: "pkg" })
  })

  test("the run verbs are the six the CLI executes, and a pattern run reads as the command", () => {
    expect(TARGET_RUN_VERBS).toEqual(["build", "ci", "docs", "lint", "run", "test"])
    for (const verb of TARGET_RUN_VERBS) expect(TargetRunVerbSchema.parse(verb)).toBe(verb)
    expect(TargetRunVerbSchema.safeParse("publish").success).toBe(false)
    expect(patternRunTitle("ci", "//...")).toBe("ci //...")
    expect(patternRunTitle("test", "//packages/...")).toBe("test //packages/...")
  })
})

/*
 * `POST /api/repo/files` fronts the filesystem, so its request is closed:
 * only a repository id and a repository-relative path, the path bounded at 4096
 * characters, and nothing else. The answer is a
 * discriminated union, because a directory and a file carry different facts:
 * a directory says whether its listing was cut at the entry cap, a file says
 * whether its bytes were cut at the read cap, whether they are binary, and
 * the digest a language-server answer is compared against.
 */
describe("the repo-files wire model", () => {
  test("the request carries a repo id and an optional path and refuses anything else", () => {
    expect(RepoFilesRequestSchema.parse({ repoId: "r1", path: "src/index.ts" }))
      .toEqual({ repoId: "r1", path: "src/index.ts" })
    // Absent path is the repository root, so the route needs no sentinel for it.
    expect(RepoFilesRequestSchema.parse({ repoId: "r1" })).toEqual({ repoId: "r1" })
    expect(RepoFilesRequestSchema.parse({ repoId: "r1", path: "" }).path).toBe("")
    expect(RepoFilesRequestSchema.safeParse({ repoId: "", path: "src" }).success).toBe(false)
    expect(RepoFilesRequestSchema.safeParse({ path: "src" }).success).toBe(false)
    // The route is strict: a caller cannot smuggle a root past the repository id.
    expect(RepoFilesRequestSchema.safeParse({ repoId: "r1", path: "src", cwd: "/" }).success).toBe(false)
  })

  test("the path is bounded at 4096 characters", () => {
    expect(RepoFilesRequestSchema.safeParse({ repoId: "r1", path: "a".repeat(4096) }).success).toBe(true)
    expect(RepoFilesRequestSchema.safeParse({ repoId: "r1", path: "a".repeat(4097) }).success).toBe(false)
  })

  test("a directory answer lists typed entries and says when the listing was cut at the entry cap", () => {
    const dir = {
      kind: "dir" as const,
      path: "src",
      entries: [{ name: "index.ts", kind: "file" as const }, { name: "lib", kind: "dir" as const }]
    }
    const parsed = RepoFilesResponseSchema.parse(dir)
    expect(parsed).toEqual(dir)
    expect(parsed.truncated).toBeUndefined()
    expect(RepoFilesResponseSchema.parse({ ...dir, truncated: true })).toEqual({ ...dir, truncated: true })
    expect(RepoFilesResponseSchema.safeParse({ ...dir, entries: [{ name: "sock", kind: "socket" }] }).success)
      .toBe(false)
  })

  test("a file answer states the cut, the binary verdict and the digest, and states them rather than leaving them inferred", () => {
    const file = {
      kind: "file" as const,
      path: "src/index.ts",
      size: 12,
      content: "export {}\n",
      truncated: false,
      binary: false,
      digest: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
    }
    expect(RepoFilesResponseSchema.parse(file)).toEqual(file)
    // A peer that predates the digest still parses; the cut and the binary verdict never may be omitted.
    const { digest: _digest, ...withoutDigest } = file
    expect(RepoFilesResponseSchema.parse(withoutDigest)).toEqual(withoutDigest)
    const { truncated: _truncated, ...withoutTruncated } = file
    expect(RepoFilesResponseSchema.safeParse(withoutTruncated).success).toBe(false)
    const { binary: _binary, ...withoutBinary } = file
    expect(RepoFilesResponseSchema.safeParse(withoutBinary).success).toBe(false)
    expect(RepoFilesResponseSchema.safeParse({ ...file, size: -1 }).success).toBe(false)
    expect(RepoFilesResponseSchema.safeParse({ ...file, size: 1.5 }).success).toBe(false)
    expect(RepoFilesResponseSchema.safeParse({ ...file, kind: "symlink" }).success).toBe(false)
  })
})

/*
 * The pty routes (`POST /api/pty`, `GET /api/pty/:id/output`): a session is a
 * terminal or a harness the app launched, and how it ended is three states,
 * not two. Absent `exitCode` means still running, a number is the code, and
 * null is death by signal. The output answer says when the scrollback was
 * cut, so the renderer never presents a tail as the whole session.
 */
describe("the pty wire model", () => {
  const session = {
    sessionId: "p1",
    kind: "harness" as const,
    harnessId: "codex" as const,
    cwd: "/work/smithers",
    pid: 4242,
    alive: true
  }

  test("a live harness session names the harness it launched and carries no exit code", () => {
    const parsed = PtySessionSchema.parse(session)
    expect(parsed).toEqual(session)
    expect(parsed.exitCode).toBeUndefined()
  })

  test("a plain terminal names no harness, and a dead session distinguishes an exit code from a signal", () => {
    const terminal = { sessionId: "p2", kind: "terminal" as const, cwd: "/work", pid: 7, alive: false, exitCode: 0 }
    expect(PtySessionSchema.parse(terminal)).toEqual(terminal)
    expect(PtySessionSchema.parse({ ...terminal, exitCode: null }).exitCode).toBeNull()
    expect(PtySessionSchema.safeParse({ ...session, kind: "editor" }).success).toBe(false)
    expect(PtySessionSchema.safeParse({ ...session, harnessId: "vim" }).success).toBe(false)
    const { alive: _alive, ...withoutAlive } = session
    expect(PtySessionSchema.safeParse(withoutAlive).success).toBe(false)
  })

  test("creating a session answers with its id, and reading output says whether the scrollback was cut", () => {
    expect(PtyCreateResponseSchema.parse({ sessionId: "p1" })).toEqual({ sessionId: "p1" })
    expect(PtyCreateResponseSchema.safeParse({}).success).toBe(false)
    const output = { sessionId: "p1", alive: true, output: "$ ls\n", truncated: true }
    expect(PtyOutputResponseSchema.parse(output)).toEqual(output)
    const { truncated: _truncated, ...withoutTruncated } = output
    expect(PtyOutputResponseSchema.safeParse(withoutTruncated).success).toBe(false)
    const { output: _text, ...withoutOutput } = output
    expect(PtyOutputResponseSchema.safeParse(withoutOutput).success).toBe(false)
  })
})

/*
 * `POST /api/targets/query` answers with what the loader listed plus what it
 * complained about and how long it took, so a partially loaded workspace
 * still renders with its warnings visible. Every listed target carries the
 * opaque id the local repository authority minted; the browser addresses a
 * run by that id, never by a path it composed.
 */
describe("the targets query and run wire model", () => {
  const target = {
    id: "t1",
    label: "//packages/rpc:check",
    target: "check",
    kinds: ["typecheck"],
    package: "//packages/rpc",
    name: "check",
    workspace: ".",
    summary: "Type-check the contract modules",
    featured: true
  }

  test("a query answer carries the targets, the loader's warnings and the elapsed time", () => {
    const response = { targets: [target], warnings: ["skipped //vendor/..."], durationMs: 812 }
    expect(TargetsQueryResponseSchema.parse(response)).toEqual(response)
    // An empty workspace is a successful query, not a failure to parse.
    expect(TargetsQueryResponseSchema.parse({ targets: [], warnings: [], durationMs: 0 }).targets).toEqual([])
  })

  test("summary and featured are the declaration's optional presentation, but the minted id is not optional", () => {
    const { summary: _summary, featured: _featured, ...plain } = target
    expect(TargetsQueryResponseSchema.parse({ targets: [plain], warnings: [], durationMs: 1 }).targets[0])
      .toEqual(plain)
    const { id: _id, ...withoutId } = target
    expect(TargetsQueryResponseSchema.safeParse({ targets: [withoutId], warnings: [], durationMs: 1 }).success)
      .toBe(false)
    expect(
      TargetsQueryResponseSchema.safeParse({ targets: [{ ...target, id: "" }], warnings: [], durationMs: 1 }).success
    )
      .toBe(false)
    expect(TargetsQueryResponseSchema.safeParse({ targets: [target], durationMs: 1 }).success).toBe(false)
    expect(TargetsQueryResponseSchema.safeParse({ targets: [target], warnings: [] }).success).toBe(false)
  })

  test("starting a run answers with the run id the target-run topic is keyed by", () => {
    expect(TargetRunResponseSchema.parse({ runId: "run-1" })).toEqual({ runId: "run-1" })
    expect(TargetRunResponseSchema.safeParse({}).success).toBe(false)
    expect(TargetRunResponseSchema.safeParse({ runId: 1 }).success).toBe(false)
  })
})

/*
 * The sign-in answers on the local origin (apps/ui/docs/decisions/0001-piper-one-truth.md
 * and apps/ui/docs/decisions/0005-linear-github-sync.md). Neither carries a token: the cloud session carries only what
 * a person sees, and the Linear session carries the setup key only once the
 * handoff is authorized. `scopes: "degraded"` is the one word for a legacy
 * token set that lacks the workspace scopes, so acts that need them can say
 * "sign in again to enable" instead of failing at the call.
 */
describe("the cloud and Linear sign-in wire model", () => {
  test("a signed-out session is three nulls and no scope verdict", () => {
    const signedOut = { state: "signed-out" as const, username: null, expiresAt: null }
    const parsed = CloudSessionSchema.parse(signedOut)
    expect(parsed).toEqual(signedOut)
    expect(parsed.scopes).toBeUndefined()
  })

  test("a signed-in session names the person and its expiry, and says when the token set is degraded", () => {
    const signedIn = {
      state: "signed-in" as const,
      username: "williamcory",
      expiresAt: "2026-10-01T00:00:00.000Z",
      scopes: "degraded" as const
    }
    expect(CloudSessionSchema.parse(signedIn)).toEqual(signedIn)
    // "degraded" is the only verdict the wire carries; full scopes are said by leaving it out.
    expect(CloudSessionSchema.safeParse({ ...signedIn, scopes: "full" }).success).toBe(false)
    expect(CloudSessionSchema.safeParse({ ...signedIn, state: "expired" }).success).toBe(false)
    const { username: _username, ...withoutUsername } = signedIn
    expect(CloudSessionSchema.safeParse(withoutUsername).success).toBe(false)
    // A bearer never reaches the renderer, so it is stripped rather than carried through.
    expect(CloudSessionSchema.parse({ ...signedIn, token: "secret" })).toEqual(signedIn)
  })

  test("starting a browser login answers with the url to open", () => {
    expect(CloudAuthStartResponseSchema.parse({ url: "https://jjhub.tech/login?x=1" }).url)
      .toBe("https://jjhub.tech/login?x=1")
    expect(CloudAuthStartResponseSchema.safeParse({}).success).toBe(false)
  })

  test("the Linear handoff is three states and carries the setup key only once authorized", () => {
    expect(LinearAuthSessionSchema.parse({ state: "idle" })).toEqual({ state: "idle" })
    expect(LinearAuthSessionSchema.parse({ state: "waiting" }).setupKey).toBeUndefined()
    expect(LinearAuthSessionSchema.parse({ state: "authorized", setupKey: "k1" }))
      .toEqual({ state: "authorized", setupKey: "k1" })
    expect(LinearAuthSessionSchema.safeParse({ state: "done" }).success).toBe(false)
    expect(LinearAuthSessionSchema.safeParse({}).success).toBe(false)
  })
})

import { describe, expect, test } from "vitest"
import * as CloudTunnel from "../src/CloudTunnel.ts"
import * as LinearAuth from "../src/LinearAuth.ts"
import * as LocalApp from "../src/LocalApp.ts"
import {
  HarnessesResponseSchema,
  HarnessSchema,
  patternRunTitle,
  PtyCreateResponseSchema,
  PtyOutputResponseSchema,
  PtySessionSchema,
  RepoFilesRequestSchema,
  RepoFilesResponseSchema,
  RepoSchema,
  splitLabel,
  TARGET_LABEL,
  TARGET_PATTERN,
  TARGET_RUN_VERBS,
  TargetRunFrameSchema,
  TargetRunMessageSchema,
  TargetRunResponseSchema,
  TargetRunVerbSchema,
  TargetSchema,
  TargetsQueryResponseSchema
} from "../src/LocalApp.ts"
import * as LocalLsp from "../src/LocalLsp.ts"
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
 * Code intelligence, the Smithers Cloud seam and the Linear handoff live in
 * their own modules. LocalApp re-exports the names it had at the move for one
 * release: each is its home's own value, never a second declaration, and
 * LocalApp declares nothing of those domains itself.
 */
describe("the names that moved out of LocalApp", () => {
  const homes = { LocalLsp, CloudTunnel, LinearAuth }
  const localApp: Record<string, unknown> = LocalApp

  test("still import from LocalApp, as the value their home declares", () => {
    expect(localApp.LspHoverSchema).toBe(LocalLsp.LspHoverSchema)
    expect(localApp.CloudSessionSchema).toBe(CloudTunnel.CloudSessionSchema)
    expect(localApp.LinearAuthSessionSchema).toBe(LinearAuth.LinearAuthSessionSchema)
    for (const [home, exports] of Object.entries(homes)) {
      for (const [name, value] of Object.entries(exports)) {
        if (name in localApp) expect(localApp[name], `${home}.${name}`).toBe(value)
      }
    }
  })

  test("LocalApp declares no code-intelligence, Cloud or Linear name of its own", () => {
    const domain = /^(?:LSP_|Lsp|lsp|CLOUD_|Cloud|withRetryAfter$|retryAfterOf$|LINEAR_|Linear)/
    const strays = Object.keys(localApp)
      .filter((name) => domain.test(name) && !Object.values(homes).some((home) => name in home))
    expect(strays).toEqual([])
  })
})

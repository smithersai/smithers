import { BuildAndCheckTypeScriptPackage, ReviewDocsAgainstCode, ReviewJsdocAgainstCode } from "@smthrs/repo-targets"
/**
 * Standard package targets.
 *
 * `cwd` anchors every emitted tool run in this package directory.
 */
import { Smithers } from "@smthrs/targets"
import * as Input from "@smthrs/targets/Input"

const { check, circular, docs, docsFiles, fmt, lib, lint, test } = BuildAndCheckTypeScriptPackage({
  deps: [],
  // Examples are type-checked, linted, and run by test/Examples.test.ts.
  sources: Input.glob("{src,examples}/**/*.{ts,vibe}"),
  cwd: "packages/smithers/flows/platform-browser"
})

/**
 * Changed public APIs against the package README, every docs page (concepts
 * and guides included), and the site API reference page.
 *
 * @since 1.0.0
 * @category lint
 */
const reviewDocsAgainstCode = ReviewDocsAgainstCode({
  cwd: "packages/smithers/flows/platform-browser",
  context: [
    Smithers.file("README.md"),
    Smithers.glob("docs/**/*.md"),
    Smithers.file("//apps/site/src/content/docs/docs/reference/api/platform-browser.mdx")
  ]
})

/**
 * Changed exports against their own JSDoc.
 *
 * @since 1.0.0
 * @category lint
 */
const reviewJsdocAgainstCode = ReviewJsdocAgainstCode({ cwd: "packages/smithers/flows/platform-browser" })

/**
 * The package's own suite, re-run under Bun.
 *
 * A package opts into the runtime-compatibility matrix by declaring this key,
 * so `//packages/...:bunTest` is the whole matrix and nothing central lists
 * which packages are in it.
 */
const bunTest = Smithers.BunSuite({ cwd: "packages/smithers/flows/platform-browser" })

/**
 * The durable browser engine in Playwright's Chromium, over real OPFS, Web
 * Locks and BroadcastChannel: a run resumes after the browser is killed with
 * SIGKILL, moves to a follower when the leader tab closes, and a durable sleep
 * that came due while every tab was closed is woken on load. It runs bundles
 * in the browser, so the Node `test` target measures coverage.
 */
const browserTest = Smithers.Shell.Test({
  shell: "cd packages/smithers/flows/platform-browser && npx vitest run --config vitest.browser.config.ts",
  data: [
    lib,
    Smithers.glob("src/**/*.{ts,vibe}"),
    Smithers.glob("test/**/*.ts"),
    Smithers.file("package.json"),
    Smithers.file("vitest.browser.config.ts")
  ],
  timeout: "10m",
  sandbox: { network: "loopback" }
})

/**
 * Security review: `security` reviews the diff against origin/main and
 * `securityAudit` audits every source file.
 */
const securityReview = Smithers.SecurityReview({
  cwd: "packages/smithers/flows/platform-browser",
  include: ["src/**"],
  checks: [
    {
      id: "command-line-quoting",
      title: "An argv command reaches just-bash as exactly those arguments",
      threat:
        "A flow or model that controls one argument injects extra shell commands into the tab's interpreter and reads or rewrites the whole mounted workspace.",
      lookFor: [
        "A spawn path that builds the just-bash line by string concatenation instead of CommandLine.render on the Command.",
        "An argument containing ;, |, $(), backticks, newlines, or quotes that CommandLine.render leaves unquoted before bash.exec.",
        "A PipedCommand or string shell option that is executed instead of refused with a badArgument error."
      ],
      paths: ["src/BrowserChildProcessSpawner/**"]
    },
    {
      id: "spawn-env-and-options",
      title: "Spawn options the interpreter cannot honour are refused, and a supplied env replaces the interpreter env",
      threat:
        "A caller that passes a minimal env or relies on kill/detach semantics has host secrets from the interpreter env exposed to the command, or a command it thinks stopped keeps mutating the mount.",
      lookFor: [
        "A call to bash.exec with env set but extendEnv not true that omits replaceEnv: true.",
        "stdin streams, additionalFds, detached, shell, or forceKillAfter accepted silently instead of failing before exec.",
        "An interrupt of the worker fiber that does not abort the AbortController or reports success instead of the aborted error.",
        "Concurrent runs that bypass the one-permit gate semaphore and interleave writes to the shared mount."
      ],
      paths: ["src/BrowserChildProcessSpawner/make.ts"]
    },
    {
      id: "isolation-attestation",
      title: "The kernel isolation marker is attached only when the workspace is the whole mount",
      threat:
        "A page that composes a narrower workspace root or a host node:fs gets the kernel's isolated-filesystem trust, so a grant scoped to one subtree reads or writes the rest of the volume through a swapped symlink.",
      lookFor: [
        "BrowserFileSystem.layer calling withIsolatedFileSystem for any workspaceRoot other than exactly \"/\".",
        "BrowserFileSystem.make or another export returning a service that carries the isolation marker.",
        "BrowserServices.layer or BrowserHost.layer forwarding a caller root without the / check, or attesting an fs other than the one it was given."
      ],
      paths: ["src/BrowserFileSystem/layer.ts", "src/BrowserServices.ts", "src/BrowserHost.ts"]
    },
    {
      id: "no-auto-redirect",
      title: "The browser HttpClient never follows a redirect on its own",
      threat:
        "A flow allowed to fetch one origin is redirected by that server to an origin its grant forbids, and the tab sends the request with credentials past the kernel's per-hop check.",
      lookFor: [
        "The FetchHttpClient RequestInit in internal/HttpClient.ts set to anything other than redirect: \"manual\", or dropped from the layer.",
        "A second HttpClient layer merged into BrowserHost or the BrowserRuntime engine host that uses default fetch redirect handling."
      ],
      paths: ["src/internal/HttpClient.ts", "src/BrowserHost.ts", "src/BrowserRuntime.ts"]
    },
    {
      id: "one-engine-per-origin",
      title: "Only the worker holding the engine's Web Lock opens the store or answers a request",
      threat:
        "Two workers drive the same run at once, or a new leader steals a run from a live one, and a step that already ran (a model call, a write) runs twice.",
      lookFor: [
        "Leader.serve building the engine, opening OPFS, or answering the channel before WebLock.hold has returned, or after its scope closed.",
        "A WebLock.hold whose interrupted wait can still take the lock, or whose grant is not released with the scope.",
        "BrowserRuntime.layer passing a liveness check other than Ownership.singleIncarnationLiveness, the one that judges the claimant and every other host's owner by its lease."
      ],
      paths: ["src/internal/Leader.ts", "src/WebLock.ts", "src/BrowserRuntime.ts"]
    },
    {
      id: "channel-requests-typed",
      title: "A request on the engine channel runs only a flow the worker was given, with a payload its schema decodes",
      threat:
        "Any script of the origin posts on the channel; a request that names an unlisted flow, or a payload the flow's schema never checked, runs code or data the app did not choose.",
      lookFor: [
        "A request handled without Protocol.decode, or a flow looked up anywhere but the worker's own flows by tag.",
        "A Start payload or Signal value used without decoding it with the flow's own schema.",
        "A Refused reply or a log line carrying an error's message instead of its tag."
      ],
      paths: ["src/internal/Leader.ts", "src/internal/Protocol.ts", "src/BrowserEngine.ts"]
    },
    {
      id: "content-free-telemetry",
      title: "Engine telemetry carries ids, counts and error tags, never content",
      threat:
        "A payload, a model answer or a provider error quoted in a log line, span attribute or metric attribute leaves the browser through the app's telemetry exporter.",
      lookFor: [
        "A log annotation, span attribute or metric attribute holding a payload, a value, a result, a channel message, or an error or ErrorEvent message.",
        "An error.type taken from anything but RetryPolicy.errorTag or an error's name."
      ],
      paths: ["src/internal/Leader.ts", "src/BrowserEngine.ts", "src/BrowserRuntime.ts", "src/StoragePersistence.ts"]
    },
    {
      id: "fs-error-fail-closed",
      title: "Filesystem denials and unsupported operations fail closed with the right tag",
      threat:
        "A guarded kernel path treats a permission refusal or backend malfunction as not-found or success and proceeds to create or overwrite a file it was denied.",
      lookFor: [
        "exists returning false for any reason tag other than NotFound.",
        "An EACCES or EPERM code mapped to NotFound or swallowed in platformError.",
        "An unsupported method (symlink, link, open, chmod, copy, realPath without backend support) returning success instead of failing.",
        "access() skipping the mode check when readable or writable is requested."
      ],
      paths: [
        "src/BrowserFileSystem/make.ts",
        "src/BrowserFileSystem/platformError.ts",
        "src/BrowserFileSystem/realPath.ts"
      ]
    },
    {
      id: "write-semantics-preserved",
      title: "Writes carry the caller's exclusive-create flag, mode, and a private copy of the bytes",
      threat:
        "A flow that relies on an exclusive create or a restrictive mode has another writer's file silently overwritten or widened, or its bytes changed after a kernel check and before the backend commits them.",
      lookFor: [
        "writeFile or writeFileString dropping options.flag, so \"wx\" becomes a truncating overwrite instead of AlreadyExists.",
        "writeFile or makeDirectory dropping options.mode, so a 0600 or 0700 request is created with a wider default that access() then reports as readable or writable.",
        "writeFile handing the caller's Uint8Array to fs.writeFile without the snapshot copy, or readFile returning the backend's stored array.",
        "A mutation (writeFile, rename, remove, makeDirectory, utimes) missing Effect.uninterruptible, so a replacement write can overtake an abandoned one."
      ],
      paths: ["src/BrowserFileSystem/make.ts"]
    },
    {
      id: "walk-and-stream-bounds",
      title: "Recursive listing and file streaming stay bounded on hostile volume contents",
      threat:
        "Content written into the mount by a model or command (symlink loops, huge files, lying backend reads) hangs or exhausts memory in the user's tab.",
      lookFor: [
        "readDirectory recursion that follows a directory symlink without an lstat, realpath visited set, or the maximumDepth ceiling.",
        "streamFile accepting a chunkSize above maximumChunkSize or a non-integer or negative offset or bytesToRead.",
        "A handle.read result whose bytesRead is not checked to lie within 0..size before slicing the buffer.",
        "A stream handle that is not closed on interruption or failure."
      ],
      paths: [
        "src/BrowserFileSystem/readDirectory.ts",
        "src/BrowserFileSystem/streamFile.ts",
        "src/BrowserFileSystem/normalizePath.ts"
      ]
    }
  ]
})

export const Package = Smithers.Package({
  targets: {
    browserTest,
    bunTest,
    check,
    circular,
    docs,
    docsFiles,
    fmt,
    lib,
    lint,
    reviewDocsAgainstCode,
    reviewJsdocAgainstCode,
    test,
    ...securityReview
  }
})

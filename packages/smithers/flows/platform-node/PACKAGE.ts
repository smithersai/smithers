import {
  BuildAndCheckTypeScriptPackage,
  ImportRules,
  ReviewDocsAgainstCode,
  ReviewJsdocAgainstCode
} from "@smthrs/repo-targets"
/**
 * Standard package targets.
 *
 * `cwd` anchors every emitted tool run in this package directory.
 */
import { Smithers } from "@smthrs/targets"

const cwd = "packages/smithers/flows/platform-node"

const { check, circular, docs, docsFiles, fmt, lib, lint, test } = BuildAndCheckTypeScriptPackage({
  deps: [],
  sources: Smithers.glob("{src,examples}/**/*.{ts,vibe}"),
  examples: [{
    page: Smithers.file("docs/quickstart.md"),
    example: Smithers.file("examples/quickstart.vibe"),
    test: Smithers.file("test/quickstart.test.vibe")
  }],
  cwd
})

/**
 * The atomic filesystem suites run real helper processes and inject faults as
 * parameters; module mocks and stubbed globals prove behaviour against a double.
 *
 * @since 1.0.0
 * @category lint
 */
const importRules = ImportRules({
  cwd,
  rules: [{
    kind: "forbidCalls",
    files: ["test/AtomicFileSystem*.test.ts"],
    callees: ["vi.mock", "vi.doMock", "vi.spyOn", "vi.stubGlobal", "vi.fn", "vi.hoisted", "jest.mock"],
    because: "TEST-2/TEST-7: no mocks; unhappy paths inject a faulty seam, happy paths run the real helper."
  }]
})

/**
 * Changed public APIs against the package README, every docs page (concepts
 * and guides included), and the site API reference page.
 *
 * @since 1.0.0
 * @category lint
 */
const reviewDocsAgainstCode = ReviewDocsAgainstCode({
  cwd,
  context: [
    Smithers.file("README.md"),
    Smithers.glob("docs/**/*.md"),
    Smithers.file("//apps/site/src/content/docs/docs/reference/api/platform-node.mdx")
  ]
})

/**
 * Changed exports against their own JSDoc.
 *
 * @since 1.0.0
 * @category lint
 */
const reviewJsdocAgainstCode = ReviewJsdocAgainstCode({ cwd })

const securityReview = Smithers.SecurityReview({
  cwd,
  include: ["src/**"],
  checks: [
    {
      id: "pid-probe-scope",
      title: "PID liveness probes inspect only valid pids on the selected host",
      threat: "A foreign or invalid pid probes an unrelated local process or treats uncertainty as death.",
      lookFor: [
        "A signal other than 0, or a pid that is not a positive safe integer.",
        "Probing an owner whose host differs from the configured host or claimant host.",
        "An error other than ESRCH treated as proof of death, or implicit cross-host policy."
      ],
      paths: ["src/HostLiveness.ts"]
    },
    {
      id: "atomic-helper-provenance",
      title: "The atomic filesystem helper executed is never one the confined workspace supplied",
      threat:
        "A flow running in a confined workspace plants or rewrites smithers-jj-export and gets its code run by the host outside the sandbox.",
      lookFor: [
        "A resolution path in resolveDefaultExecutable, resolveConfiguredExecutable or usableExecutable that returns a file inside boundaryRoot without staging it outside the workspace.",
        "A symlink, hard link or `..` component in the configured path that makes the inside(boundaryRoot, resolved) check describe a different file from the one spawned (TOCTOU between realpath and spawn).",
        "stagePackaged/outsideWorkspace copying into a staging directory that is not 0700 and freshly mkdtemp'd, or a cached staged path reused after it was replaced.",
        "Any fallback that consults PATH, the process cwd, or a workspace-relative node_modules install to find the helper.",
        "A helper inside boundaryRoot (checkout target/release or target/debug, or an embedded path) copied out by outsideWorkspace at the first request instead of at layer build, so bytes a flow wrote before that request still run.",
        "SMITHERS_WORKSPACE_JJ_EXPORT_BINARY or options.executable re-read on every request, so a later change to the variable redirects which binary runs."
      ],
      paths: [
        "src/AtomicFileSystem.ts",
        "src/internal/AtomicFileSystemExecutable.ts",
        "src/internal/AtomicFileSystemTransport.ts"
      ]
    },
    {
      id: "atomic-protocol-bounds",
      title: "Helper requests and responses stay inside the declared byte, count and time ceilings",
      threat:
        "A malicious or broken helper, or a flow issuing huge reads or batches, exhausts host memory or stalls the host indefinitely.",
      lookFor: [
        "A stdout, stderr or batch-entry buffer that is accumulated before its limit is checked, or a frame length read from the helper trusted before comparison with limits.response.",
        "decode/convert in AtomicFileSystemProtocol accepting a declared length, base64 payload or directory listing larger than limits.content or limits.response.",
        "A code path that spawns a helper outside the layer semaphore or without the timeoutMs deadline and SIGKILL cleanup.",
        "A limit override accepted above hardLimitBytes or a batchSize above KernelFileSystem.maxBatchSize."
      ],
      paths: [
        "src/AtomicFileSystem.ts",
        "src/internal/AtomicFileSystemProtocol.ts",
        "src/internal/AtomicFileSystemTransport.ts"
      ]
    },
    {
      id: "atomic-no-follow-authorization",
      title:
        "noFollowAuthorization is only claimed where the helper actually enforces descriptor-relative O_NOFOLLOW walks",
      threat: "A flow uses a symlink inside its workspace to read or write host files outside the boundary root.",
      lookFor: [
        "An operation routed to the stock NodeFileSystem (realPath, watch, identifyRoot or any spread field) that follows symlinks while the layer advertises noFollowAuthorization: true.",
        "A request field (path, boundaryRoot) forwarded to the helper without the boundary root the kernel pinned, or a result path converted back without checking it stays under that root."
      ],
      paths: ["src/AtomicFileSystem.ts", "src/internal/AtomicFileSystemProtocol.ts"]
    },
    {
      id: "helper-env-isolation",
      title: "Every native helper and supervisor child starts with an explicit minimal environment and inert cwd",
      threat:
        "Host secrets in process.env (model keys, tokens) leak into helper or supervisor processes, or an attacker-controlled cwd or env variable (NODE_OPTIONS, BUN config, PATH) injects code into them.",
      lookFor: [
        "A spawn or spawnSync of the atomic helper, ps, the supervisor program or the Windows job helper that omits env or passes process.env.",
        "A PATH-relative executable name (for example spawnSync(\"taskkill\") or ps without an absolute path) that a writable directory or Windows cwd search could hijack.",
        "SMITHERS_PROCESS_CHANNEL or SMITHERS_PROCESS_JOB_HELPER not deleted from the supervisor's env before the target command is spawned."
      ],
      paths: [
        "src/ProcessReaper.ts",
        "src/internal/ProcessSupervisor.ts",
        "src/internal/SupervisorProgram.ts",
        "src/internal/WindowsProcessJob.ts",
        "src/internal/AtomicFileSystemTransport.ts"
      ]
    },
    {
      id: "supervisor-channel-auth",
      title: "Only the host that started a supervisor can connect to and command it",
      threat:
        "Another local user or a sandboxed process connects to the supervisor control socket and issues spawn, stop or cleanup commands, or impersonates the owner to the host.",
      lookFor: [
        "A Unix socket directory created without mkdtemp plus chmod 0700 before listen, or a predictable /tmp path.",
        "The TLS PSK loopback server accepting a connection before the PSK identity and 32-byte random key match, or a key logged or passed on argv instead of env.",
        "Supervisor JSON messages parsed and acted on (pids, signals, commands) without validating type and shape."
      ],
      paths: ["src/internal/ProcessSupervisor.ts", "src/internal/SupervisorProgram.ts"]
    },
    {
      id: "reaper-signal-targeting",
      title: "The reaper and supervisor signal only process groups whose identity they re-verified",
      threat:
        "A forged or stale ledger record, or pid reuse, makes the host SIGKILL an unrelated process, its own group, or pid 1 of the user's session.",
      lookFor: [
        "process.kill with a negative pid whose pgid is not checked to be a safe integer above 1, equal to pid, and different from the host's own group.",
        "A kill issued when start time is unavailable or boot time predates the record, contrary to the module contract.",
        "ps or /proc output parsed with a regex that lets a crafted command name shift columns into pid, pgid or start time.",
        "taskkill /T issued for a Windows record naming the owner pid or an ancestor."
      ],
      paths: [
        "src/ProcessReaper.ts",
        "src/HostLiveness.ts",
        "src/internal/ProcSnapshot.ts",
        "src/internal/ProcessCleanup.ts",
        "src/internal/SupervisorProgram.ts"
      ]
    },
    {
      id: "egress-proxy-bypass",
      title: "Outbound HTTP honours the environment's egress proxy for every non-loopback origin",
      threat:
        "Code inside a default-deny sandbox reaches arbitrary origins directly, bypassing the egress proxy's allowlist and audit.",
      lookFor: [
        "A loopback exemption wider than exactly localhost, 127.0.0.1 and ::1 (for example a suffix or CIDR match that also exempts attacker-registered hostnames).",
        "A NodeHost layer composing NodeHttpClient.layerUndici or makeDispatcher directly instead of EgressHttpClient.layer.",
        "A redirect interceptor installed on the dispatcher so hops escape the kernel's redirect decorator."
      ],
      paths: ["src/EgressHttpClient.ts", "src/NodeHost.ts"]
    },
    {
      id: "language-server-host-process",
      title: "A host language server runs a host program, with a bounded protocol and only the environment it needs",
      threat:
        "A prompt-injected agent makes the host run a program the workspace supplies, reads host secrets through the server's inherited environment, or exhausts host memory with an unbounded LSP stream.",
      lookFor: [
        "A program, launcher (sh, env, npx, node -e) or file-naming argument that resolves inside the workspace and still starts, including through a symlink or a relative PATH entry.",
        "ChildProcessEnvironment.make(process.env, ...) handing the server anything beyond the bootstrap names and the config's own environment.",
        "An LSP frame Content-Length, queued frame count or pending request count accepted without an upper bound."
      ],
      paths: ["src/NodeLanguageServer.ts"]
    },
    {
      id: "contained-host-bypass",
      title: "Contained host layers route every child process, including jj, through the reaping spawner",
      threat:
        "A flow in a contained host starts processes that escape the ledger and survive the run, keeping access to the workspace and credentials.",
      lookFor: [
        "layerContained or layerContainedAt providing NodeJj.layer or the raw NodeChildProcessSpawner instead of the ProcessReaper spawner.",
        "PipedProcess.spawn or ScopedProcess started with detached/shell options that leave no recorded process group."
      ],
      paths: ["src/NodeHost.ts", "src/ScopedProcess.ts", "src/internal/PipedProcess.ts"]
    },
    {
      id: "guest-result-trust",
      title: "Guest-written results and diffs are untrusted data bounded and validated before the host uses them",
      threat:
        "Code running in a sandbox guest exhausts host memory, forges a success, or smuggles host-side paths into the caller's workspace diff.",
      lookFor: [
        "A read of result.json or a changed file that is not capped by readBounded at resultBytes or the remaining diffBytes budget.",
        "A guest result accepted without the per-execution attempt nonce matching, or without decoding output through the flow's success schema.",
        "A DiffEntry.path or deleted path taken from the guest listing that can contain '..', an absolute path, or a backslash once normalized, and is returned without rejection.",
        "A symlink the guest plants in the workdir that stat follows so collect reads a guest file outside the workdir into the diff.",
        "Code or docs treating the attempt nonce as proof of honesty, although request.json holding it is readable by the guest; it only rejects stale results.",
        "A request whose capabilityCeiling is not the caller's current authority intersected with the flow's declaration, a guest that runs the child under anything wider than the ceiling it decoded, or a result accepted whose capabilityCeiling echo differs from the one sent."
      ],
      paths: ["src/SandboxedFlow.ts", "src/internal/SandboxedFlowGuest.ts"]
    },
    {
      id: "guest-command-quoting",
      title: "Session commands quote every caller- or guest-shaped word",
      threat:
        "A caller-supplied runtime or a provider workdir containing shell metacharacters runs arbitrary commands in the sandbox session.",
      lookFor: [
        "A session.spawn command string that interpolates runtime, bundlePath, workdir, or a diff path without CommandLine.quote.",
        "The head -c fallback reading a path that can begin with '-' or is not quoted as one word.",
        "Env passed to the guest spawn that carries more than SMITHERS_SANDBOX_REQUEST_PATH and SMITHERS_SANDBOX_RESULT_PATH from the host."
      ],
      paths: ["src/SandboxedFlow.ts"]
    },
    {
      id: "guest-output-redaction",
      title: "Guest stdout, stderr, and failure text is redacted before it enters an error, log, or journal",
      threat:
        "A child flow that prints an API key or PEM private key leaks it to the parent's journal, terminal, and anyone who can read run history.",
      lookFor: [
        "A SandboxedFlowError message or cause built from guest text that bypasses failure() or tail() redaction.",
        "drainTail logic where a credential split across chunks, lines, or the 4096-byte ring boundary survives unredacted in the retained tail.",
        "A PEM BEGIN marker whose body is retained when no END marker arrives before stream end.",
        "The guest's describe() quoting failure fields before RedactedLogger.redactArgument runs, or truncating before redacting."
      ],
      paths: ["src/SandboxedFlow.ts", "src/internal/SandboxedFlowGuest.ts"]
    },
    {
      id: "bundle-contents-leak",
      title: "The bundle shipped to the guest contains only the entry's code, never host secrets",
      threat:
        "A sandbox provider operator or co-tenant reads host credentials or local files that esbuild inlined into bundle.mjs.",
      lookFor: [
        "esbuild options that define process.env values, inline .env or JSON config files, or embed absolute host paths beyond the entry and runner.",
        "An entry path taken from an untrusted caller string so bundling reads an arbitrary host file into the guest bundle."
      ],
      paths: ["src/SandboxedFlow.ts"]
    },
    {
      id: "sandbox-session-isolation",
      title: "One sandbox session key is exclusive to one execution and its deadline always tears it down",
      threat:
        "One parent flow reattaches another run's sandbox machine and reads or overwrites its workspace, request, or result.",
      lookFor: [
        "A toLayer session key example or default that omits executionId or callId so two runs or two parallel calls share a machine.",
        "A path where the deadline race wins but the scoped session release does not run, leaving a reattachable machine with the payload on disk.",
        "A stale result.json from an earlier attempt that is read because files.remove failed silently."
      ],
      paths: ["src/SandboxedFlow.ts"]
    },
    {
      id: "host-guarded-layering",
      title: "Flow bodies receive only the guarded, capability-checked host services",
      threat:
        "A flow body or agent action reads, writes, or spawns outside the workspace grants by resolving a raw host service.",
      lookFor: [
        "A raw platform.host.layerAt service tag that is provideMerge'd into the engine context and not overridden by layerContainedAt or HostServices.",
        "The privileged Jj or raw FileSystem reachable from Action implementations rather than only from EngineStore machinery.",
        "GrantStore built with attended: false and rules that default to allow when the caller passes none.",
        "Caller-supplied rules, containment, or signals used without the frozen snapshot, so the caller can widen grants after validateHost returns."
      ],
      paths: ["src/NativeRuntime.ts"]
    },
    {
      id: "runtime-config-secrets",
      title:
        "Runtime configuration errors and storage paths never expose DSN credentials or place engine state where flows can tamper",
      threat:
        "An operator's Postgres password leaks into an error or log, or a flow body rewrites artifact objects the engine trusts on replay.",
      lookFor: [
        "A RuntimeConfigurationError or log line that interpolates the filename or postgres:// DSN value.",
        "NativeRuntime storage placing the artifact store under workspaceRoot/.flows for a Postgres filename, inside the directory flow bodies may write.",
        "A SQLite filename accepted inside workspaceRoot, so engine.db and its objects directory sit where guarded flow bodies can rewrite journal or cache evidence.",
        "The mkdirSync fallback in databaseLayer creating a directory the confined filesystem refused as outside its root."
      ],
      paths: ["src/NativeRuntime.ts"]
    }
  ]
})

export const Package = Smithers.Package({
  targets: {
    check,
    circular,
    docs,
    docsFiles,
    fmt,
    importRules,
    lib,
    lint,
    reviewDocsAgainstCode,
    reviewJsdocAgainstCode,
    test,
    ...securityReview
  }
})

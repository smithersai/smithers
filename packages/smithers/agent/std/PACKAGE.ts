import {
  BuildAndCheckTypeScriptPackage,
  ReviewDocsAgainstCode,
  ReviewJsdocAgainstCode,
  ReviewTagsMigrationsAndKeys
} from "@smthrs/repo-targets"
/**
 * Standard package targets.
 *
 * `cwd` anchors every emitted tool run in this package directory. The targets
 * declared here are what `smthrs ci '//packages/...'` plans for this package;
 * the generated `.github/workflows/ci.yml` runs that label and names no
 * package, so a package with no `PACKAGE.ts` has no typecheck, suite, or lint
 * in CI.
 */
import { Smithers } from "@smthrs/targets"

const { check, circular, docs, docsFiles, fmt, lib, lint, test } = BuildAndCheckTypeScriptPackage({
  deps: [],
  cwd: "packages/smithers/agent/std",
  // examples/ is type-checked and formatted with the tests, and run by
  // test/examples/; each example is documentation users copy, so it is not
  // held to the library lint rules.
  testSources: Smithers.glob("{test,examples}/**/*.{ts,vibe}")
})

/**
 * Identity strings and durable keys, read out of this package's own changed
 * sources: `StdError` tags, flow names, and the digest material a call
 * identity hashes.
 *
 * @since 1.0.0
 * @category lint
 */
const reviewTagsMigrationsAndKeys = ReviewTagsMigrationsAndKeys({ cwd: "packages/smithers/agent/std" })

/**
 * Changed public APIs against the package README, every docs page (concepts,
 * guides, and reference included), and the site API reference page.
 *
 * @since 1.0.0
 * @category lint
 */
const reviewDocsAgainstCode = ReviewDocsAgainstCode({
  cwd: "packages/smithers/agent/std",
  context: [
    Smithers.file("README.md"),
    Smithers.glob("docs/**/*.md"),
    Smithers.file("//apps/site/src/content/docs/docs/reference/api/std.mdx")
  ]
})

/**
 * Changed exports against their own JSDoc.
 *
 * @since 1.0.0
 * @category lint
 */
const reviewJsdocAgainstCode = ReviewJsdocAgainstCode({ cwd: "packages/smithers/agent/std" })

const securityReview = Smithers.SecurityReview({
  cwd: "packages/smithers/agent/std",
  include: ["src/**"],
  checks: [
    {
      id: "hermetic-precheck-bypass",
      title: "A hermetic bash call cannot touch a path outside its declared reads and writes",
      threat:
        "A prompt-injected agent declares a narrow envelope yet reads secrets or deletes files outside it on the host running the flow.",
      lookFor: [
        "Shell text the tokenizer splits so a write command (rm, mv, cp, tee, >) is classified as a read or not seen at all.",
        "A path hidden behind quoting, globbing, ~, $VAR, $(...), backticks, or an interpreter other than a shell that the lexical scan misses while still admitting the call.",
        "A cwd, relative path, or dot-dot segment that resolves outside the envelope after path.resolve yet passes withinEnvelope.",
        "The /dev/ exemption or the cwd === base shortcut admitting a path that is not process plumbing or the workspace root."
      ],
      paths: ["src/Bash.ts", "src/internal/EnvelopePrecheck.ts", "src/internal/Paths.ts"]
    },
    {
      id: "effect-envelope-honesty",
      title: "effectsFor and ApplyPatch.paths name every path the handler actually reads or writes",
      threat:
        "An agent gets a write approved for one path while the handler writes another, bypassing the permission prompt for the user's files.",
      lookFor: [
        "A handler that writes, removes, or creates directories for a path absent from effectsFor(input) or ApplyPatch.paths(patch), such as a move destination or parent directory.",
        "A static envelope declared sealed or hermetic for a flow that mutates or spawns (Fetch, WebFetch, TestRun, ShellCommand).",
        "A path normalized differently in the envelope than in the handler, so the approved name and the written name diverge."
      ],
      paths: ["src/*.{ts,vibe}", "src/Manifest.ts", "src/internal/Declaration.ts"]
    },
    {
      id: "symlink-write-escape",
      title: "Atomic replacement never writes outside the workspace by following a symlink",
      threat:
        "An agent plants a symlink in the workspace so a later write, edit, or patch overwrites a host file such as ~/.ssh/authorized_keys or a shell rc file.",
      lookFor: [
        "Preserve.replace calling realPath on the target and writing the resolved destination without re-checking it against the guarded filesystem's roots.",
        "A temporary sibling or chown/chmod applied to the resolved path outside the workspace, or set-id bits preserved onto a replaced file.",
        "ApplyPatch or Edit creating parent directories through a symlinked directory."
      ],
      paths: [
        "src/internal/Preserve.vibe",
        "src/Write.vibe",
        "src/Edit.vibe",
        "src/ApplyPatch.vibe",
        "src/internal/ApplyPatch.vibe"
      ]
    },
    {
      id: "subprocess-argv-injection",
      title: "Model-supplied strings reach child processes only as argv data, never as shell text or option flags",
      threat:
        "A prompt-injected agent turns a container name, env key, test selection, checkpoint id, git ref, or search pattern into an extra flag or shell command on the host.",
      lookFor: [
        "Container.makeCommand forwarding an env key, cwd, or container name that begins with '-' or contains '=' into docker exec argv.",
        "A git, rg, or docker invocation where a caller string precedes '--' and could parse as an option (for example rev-parse on a ref starting with '-').",
        "TestRun or Bash building a 'bash -lc' string that interpolates caller text rather than passing it after \"$@\".",
        "Exec.exec called without args so the command string is parsed by the platform shell for a value the caller did not intend as shell."
      ],
      paths: [
        "src/Container.vibe",
        "src/Bash.ts",
        "src/TestRun.ts",
        "src/internal/Exec.vibe",
        "src/internal/GitWorktree.vibe",
        "src/Checkpoints.vibe",
        "src/NativeSearch.ts",
        "src/PortableSearch.vibe"
      ]
    },
    {
      id: "host-git-on-agent-repo",
      title: "Host-side git on the agent's workspace cannot run agent-authored code",
      threat:
        "An agent restricted to file writes edits .git/config or .git/hooks so the host's checkpoint capture or worktree add executes its program outside the sandbox.",
      lookFor: [
        "git worktree add, stash create, or rev-parse run with -C on an agent-writable repository without -c core.hooksPath=/dev/null, core.fsmonitor=false, and a sanitized GIT_* environment.",
        "Checkpoint ids or config keys written with git config that could alter keys outside the checkpoint section.",
        "A scratch checkout path built from caller text that could land outside the repository root."
      ],
      paths: ["src/Checkpoints.vibe", "src/internal/GitWorktree.vibe", "src/Relocate.vibe"]
    },
    {
      id: "child-env-secret-leak",
      title: "Child processes and containers receive only the environment the call needs",
      threat:
        "A command the agent runs reads host API keys or tokens inherited from the harness process and exfiltrates them.",
      lookFor: [
        "ChildProcessEnvironment.make(process.env, ...) passing the whole host environment to bash, shell_command, test runners, rg, git, or the language server.",
        "docker exec -e KEY forwarding a host value the caller named rather than one it supplied.",
        "Error or diagnostic text (quoted invocation, StdError message) that includes env values or transport credentials."
      ],
      paths: [
        "src/internal/Exec.vibe",
        "src/Container.vibe",
        "src/NativeSearch.ts",
        "src/TestRun.ts",
        "src/Bash.ts"
      ]
    },
    {
      id: "outbound-http-ssrf",
      title: "fetch, http-post, and webfetch reach only hosts the capability guard admits on every hop",
      threat:
        "A prompt-injected agent reads cloud metadata or internal services, or posts workspace data to an attacker host, through a redirect or a URL the guard does not re-check.",
      lookFor: [
        "Fetch or HttpPost executing without redirect: manual so the transport follows a redirect to a host the kernel HttpClient never checked.",
        "parseHttpUrl admitting a loopback, link-local, or metadata address, or a URL whose host differs after WHATWG normalization.",
        "Caller-supplied Authorization or Cookie headers forwarded to a cross-origin redirect target."
      ],
      paths: ["src/Fetch.vibe", "src/HttpPost.vibe", "src/WebFetch.ts", "src/internal/Http.vibe", "src/internal/Url.ts"]
    },
    {
      id: "exa-credential-handling",
      title: "The Exa API key is sent only to api.exa.ai and never appears in output or errors",
      threat: "An agent or a hostile search result obtains the operator's Exa key from a log, error, or search output.",
      lookFor: [
        "Redacted.value(secret) used anywhere but the authorization header for the fixed https://api.exa.ai URL.",
        "Error messages or logs that include the request, headers, or credential reference.",
        "An unbounded response.json read that a hostile or compromised endpoint can use to exhaust memory."
      ],
      paths: ["src/ExaWebSearch.ts", "src/WebSearch.vibe"]
    },
    {
      id: "untrusted-output-bounds",
      title: "Process, HTTP, and language-server output is bounded before it is buffered or parsed",
      threat: "A command, web page, or language server the agent reaches exhausts the host's memory or wedges the run.",
      lookFor: [
        "Exec.exec called without maxCaptureBytes on a process the agent influences.",
        "An LSP frame Content-Length or queued frame count accepted without an upper bound.",
        "A regex over untrusted text (grep pattern, HTML conversion, test report parsing) with catastrophic backtracking outside LinearRegex."
      ],
      paths: [
        "src/internal/Exec.vibe",
        "src/internal/Html.ts",
        "src/internal/TestReport.ts",
        "src/internal/LinearRegex.ts",
        "src/Grep.vibe",
        "src/PortableSearch.vibe"
      ]
    },
    {
      id: "out-of-process-reads",
      title: "Subprocess readers (rg, the language server) see no file the guarded filesystem would refuse",
      threat:
        "A prompt-injected agent uses grep, glob, or lsp to read host files outside the workspace, such as ~/.ssh keys, because the child process opens them directly.",
      lookFor: [
        "NativeSearch resolveRoot passing a caller root or explicit file to rg without checking it against the guarded filesystem's roots first.",
        "An rg argv that follows symlinks (--follow, -L) or honors RIPGREP_CONFIG_PATH from the inherited environment.",
        "Lsp.run forwarding any absolute path to the language server with only an isAbsolutePath check, so documentSymbols, hover, or diagnostics reveal an out-of-workspace file.",
        "The host language server loading workspace-controlled code (tsconfig plugins, a workspace-local typescript or node_modules binary) outside any sandbox."
      ],
      paths: ["src/NativeSearch.ts", "src/Grep.vibe", "src/Glob.vibe", "src/Lsp.vibe"]
    },
    {
      id: "container-seal",
      title: "A host sealed to one container runs nothing on the host itself",
      threat:
        "An agent confined to a benchmark or tenant container runs a command on the host by omitting or spoofing the container name.",
      lookFor: [
        "Bash.sealed or TestRun admitting a call whose container is undefined, empty, or a different name.",
        "Relocate rewriting a containerised cwd to a host path, or a host path to a container path outside the materialized checkout."
      ],
      paths: ["src/Bash.ts", "src/TestRun.ts", "src/Relocate.vibe", "src/Container.vibe"]
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
    lib,
    lint,
    reviewDocsAgainstCode,
    reviewJsdocAgainstCode,
    reviewTagsMigrationsAndKeys,
    test,
    ...securityReview
  }
})

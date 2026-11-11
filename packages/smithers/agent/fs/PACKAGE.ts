import { BuildAndCheckTypeScriptPackage, ReviewDocsAgainstCode, ReviewJsdocAgainstCode } from "@smthrs/repo-targets"
/** Standard package targets plus package-owned documentation generation. */
import { Smithers } from "@smthrs/targets"
import * as Input from "@smthrs/targets/Input"

const { check, circular, docs, docsFiles, fmt, lib, lint, test } = BuildAndCheckTypeScriptPackage({
  deps: [],
  sources: Input.glob("{src,examples}/**/*.{ts,vibe}"),
  examples: [{
    page: Input.file("docs/quickstart.md"),
    example: Input.file("examples/quickstart.vibe"),
    test: Input.file("test/quickstart.test.vibe")
  }],
  cwd: "packages/smithers/agent/fs"
})

// The manifest augments Route's types, so it needs its own compilation.
const checkTypes = Smithers.Typecheck({
  srcs: [
    Smithers.glob("src/**/*.{ts,vibe}"),
    Smithers.glob("type-tests/**/*.ts"),
    Smithers.file("tsconfig.json"),
    Smithers.file("tsconfig.test.json")
  ],
  deps: [lib],
  tsconfig: Smithers.file("tsconfig.types.json"),
  buildMode: false,
  incremental: false,
  cwd: "packages/smithers/agent/fs"
})

/**
 * Changed public APIs against the package README, every docs page, and the
 * site API reference page.
 *
 * @since 0.1.0
 * @category lint
 */
const reviewDocsAgainstCode = ReviewDocsAgainstCode({
  cwd: "packages/smithers/agent/fs",
  context: [
    Smithers.file("README.md"),
    Smithers.glob("docs/**/*.md"),
    Smithers.file("//apps/site/src/content/docs/docs/reference/api/fs.mdx")
  ]
})

/**
 * Changed exports against their own JSDoc.
 *
 * @since 0.1.0
 * @category lint
 */
const reviewJsdocAgainstCode = ReviewJsdocAgainstCode({ cwd: "packages/smithers/agent/fs" })

const securityReview = Smithers.SecurityReview({
  cwd: "packages/smithers/agent/fs",
  include: ["src/**"],
  checks: [
    {
      id: "command-route-gate",
      title: "Only module routes marked modelInvocable are executable from agent, CLI, HTTP, or MCP",
      threat: "An agent or HTTP caller runs a hidden, markdown, or non-model-invocable flow the author never exposed.",
      lookFor: [
        "A CommandTree built for Command.make or Incur.createCli without filtering through Route.isCommandRoute.",
        "Command.call, resolveExact, or the Incur metadata fallback resolving a name against the unfiltered tree.",
        "An Incur discovery surface (--mcp, /mcp, /openapi.json, llms) mounting a route that dispatch would refuse.",
        "Route.load's runtime Flow invoked without rechecking that its modelInvocable, capabilities, and effects match the statically discovered route."
      ],
      paths: [
        "src/Command.vibe",
        "src/Incur.vibe",
        "src/internal/IncurHost.ts",
        "src/CommandTree.vibe",
        "src/Route.vibe"
      ]
    },
    {
      id: "route-module-import",
      title: "Route.load imports only the discovered absolute source path of a module route",
      threat:
        "A caller that controls route metadata or a flows-tree symlink makes the host import and execute arbitrary code.",
      lookFor: [
        "Route.snapshot accepting a relative, non-absolute, NUL-bearing, or unbounded sourcePath before dynamic import.",
        "FileRouter.scan deriving sourcePath or the ui.tsx companion outside the resolved root (symlink, '..' segment).",
        "Route.load importing a markdown or skill route, or importing before the snapshot copy is taken."
      ],
      paths: ["src/Route.vibe", "src/FileRouter.vibe"]
    },
    {
      id: "command-string-no-shell",
      title: "Agent command strings are tokenized literally and never reach a shell",
      threat: "A model-authored command string injects shell syntax or smuggles flags past the flow's input schema.",
      lookFor: [
        "CommandLine.lex expanding $, backticks, globs, or ~, or its output reaching child_process or a shell.",
        "parseFlags accepting __proto__, constructor, or prototype as an option name, or writing to a prototyped object.",
        "Missing byte, token, or token-length bounds before lexing or flag parsing."
      ],
      paths: ["src/internal/CommandLine.vibe", "src/Command.vibe"]
    },
    {
      id: "input-schema-authority",
      title: "Every invocation input is decoded by the flow's own Effect schema before FlowInvoker.invoke",
      threat:
        "An agent, CLI, or HTTP caller passes input the flow schema rejects, or extra fields it silently accepts, to a flow.",
      lookFor: [
        "A path to FlowInvoker.invoke where input skips SchemaBridge decode or Command.call validateDecoded.",
        "A zod projection that is less strict than the Effect schema and whose output is used instead of decodeInput's result.",
        "scalarRecord or assemble dropping surplus positionals or unknown flags rather than failing strict decoding."
      ],
      paths: ["src/internal/SchemaBridge.vibe", "src/Command.vibe", "src/Incur.vibe", "src/internal/IncurHost.ts"]
    },
    {
      id: "untrusted-object-admission",
      title: "Caller-owned values are copied without running getters, proxies, or prototype code",
      threat:
        "A hostile route, config, or input object runs code or mutates state after validation (TOCTOU) inside the host.",
      lookFor: [
        "Reading a caller field by property access instead of Object.getOwnPropertyDescriptor in Boundary or Route.",
        "A validated value used after an await without first taking a frozen snapshot.",
        "Missing maxBytes, maxDepth, or maxNodes limits in admitJson for invocation input or output."
      ],
      paths: ["src/internal/Boundary.ts", "src/Route.vibe", "src/FileRouter.vibe", "src/FlowInvoker.vibe"]
    },
    {
      id: "incur-http-surface",
      title: "The Incur HTTP and MCP surface keeps host guards and leaks no internals",
      threat:
        "A network caller bypasses host middleware (auth guards) or reads stack traces and host paths from error responses.",
      lookFor: [
        "A dispatch or metadata CLI served without guarded() applying every registered middleware and Positionals.guard.",
        "An error envelope or 400 response including cause, stack, sourcePath, or non-FsError text.",
        "Percent-decoding a request path before splitting, so %2F or '..' invents a route boundary.",
        "process.env.COMPLETE or discovery flags diverting a run to an unguarded surface."
      ],
      paths: ["src/Incur.vibe", "src/internal/IncurHost.ts"]
    }
  ]
})

export const Package = Smithers.Package({
  targets: {
    check,
    checkTypes,
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

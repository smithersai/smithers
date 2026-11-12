import * as NodeServices from "@effect/platform-node/NodeServices"
import { Cause, Effect, Exit } from "effect"
import * as NodeFs from "node:fs"
import * as NodeOs from "node:os"
import * as NodePath from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as NodeLanguageServer from "../src/NodeLanguageServer.ts"

/**
 * The language server runs on the host as the host user. These cases plant a
 * program in the workspace that would leave a marker if the host ran it, and
 * spawn through the real Node spawner, so a regression runs the planted file.
 */
let root: string
let workspace: string
let marker: string

beforeEach(() => {
  root = NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "smithers-lsp-"))
  workspace = NodePath.join(root, "workspace")
  marker = NodePath.join(root, "ran")
  NodeFs.mkdirSync(NodePath.join(workspace, "node_modules", ".bin"), { recursive: true })
  const script = `#!/bin/sh\ntouch '${marker}'\n`
  NodeFs.writeFileSync(NodePath.join(workspace, "node_modules", ".bin", "planted-server"), script, { mode: 0o755 })
  NodeFs.writeFileSync(
    NodePath.join(workspace, "planted.js"),
    `require("fs").writeFileSync(${JSON.stringify(marker)}, "")`
  )
  NodeFs.writeFileSync(NodePath.join(workspace, "planted.py"), `open(${JSON.stringify(marker)}, "w")\n`)
  NodeFs.mkdirSync(NodePath.join(workspace, "tools", "lsp"), { recursive: true })
  NodeFs.writeFileSync(
    NodePath.join(workspace, "tools", "lsp", "index.js"),
    `require("fs").writeFileSync(${JSON.stringify(marker)}, "")`
  )
  NodeFs.symlinkSync(process.execPath, NodePath.join(workspace, "node"))
})

afterEach(() => {
  NodeFs.rmSync(root, { recursive: true, force: true })
})

const start = (config: NodeLanguageServer.Config, construct = NodeLanguageServer.make) =>
  Effect.runPromise(Effect.exit(Effect.scoped(
    construct({ timeoutMs: 2_000, ...config }).pipe(Effect.provide(NodeServices.layer))
  )))

/** Both constructors refuse up front: the lazy one before it would ever start the server. */
const constructors = [NodeLanguageServer.make, NodeLanguageServer.makeLazy]

const failure = (exit: Exit.Exit<unknown, unknown>) => {
  if (!Exit.isFailure(exit)) return undefined
  const reason = exit.cause.reasons.find(Cause.isFailReason)
  return (reason?.error as { readonly code?: unknown } | undefined)?.code
}

describe("NodeLanguageServer refuses a program the workspace supplies", () => {
  it.each([
    ["a relative command", () => ({ command: "./node_modules/.bin/planted-server", cwd: workspace })],
    [
      "an absolute command",
      () => ({ command: NodePath.join(workspace, "node_modules/.bin/planted-server"), cwd: workspace })
    ],
    [
      "a bare name found through a workspace PATH entry",
      () => ({ command: "planted-server", cwd: workspace, environment: { PATH: "node_modules/.bin" } })
    ],
    ["a workspace symlink to a host binary", () => ({ command: "./node", args: ["-e", "0"], cwd: workspace })],
    [
      "a host interpreter given a workspace script",
      () => ({ command: process.execPath, args: ["planted.js"], cwd: workspace })
    ],
    [
      "a host interpreter given a workspace directory, whose index.js it runs",
      () => ({ command: process.execPath, args: ["./tools/lsp"], cwd: workspace })
    ],
    [
      "a workspace file passed as an option value",
      () => ({
        command: process.execPath,
        args: [`--require=${NodePath.join(workspace, "planted.js")}`],
        cwd: workspace
      })
    ]
  ])("refuses %s before spawning it", async (_name, config) => {
    for (const construct of constructors) {
      const exit = await start(config(), construct)
      expect(failure(exit)).toBe("permission_denied")
    }
    expect(NodeFs.existsSync(marker)).toBe(false)
  })

  it.each([
    ["sh -c", () => ({ command: "sh", args: ["-c", "node_modules/.bin/planted-server --stdio"], cwd: workspace })],
    [
      "an absolute shell",
      () => ({ command: "/bin/sh", args: ["-c", "./node_modules/.bin/planted-server"], cwd: workspace })
    ],
    ["bash -lc", () => ({ command: "bash", args: ["-lc", "planted-server"], cwd: workspace })],
    ["env", () => ({ command: "env", args: ["node_modules/.bin/planted-server"], cwd: workspace })],
    ["npx", () => ({ command: "npx", args: ["planted-server", "--stdio"], cwd: workspace })],
    ["pnpm exec", () => ({ command: "pnpm", args: ["exec", "planted-server"], cwd: workspace })],
    ["yarn", () => ({ command: "yarn", args: ["planted-server"], cwd: workspace })],
    ["bunx", () => ({ command: "bunx", args: ["planted-server"], cwd: workspace })],
    ["bun x", () => ({ command: "bun", args: ["x", "planted-server"], cwd: workspace })],
    [
      "node -e requiring a workspace script",
      () => ({ command: process.execPath, args: ["-e", "require('./planted.js')"], cwd: workspace })
    ],
    [
      "node --import of a workspace module",
      () => ({ command: "node", args: ["--import=./planted.js", "/opt/lsp/server.js"], cwd: workspace })
    ],
    [
      "node -pe, a cluster of short code flags",
      () => ({ command: process.execPath, args: ["-pe", "require('./planted.js')"], cwd: workspace })
    ],
    [
      "python -m, which imports from cwd first",
      () => ({ command: "python3", args: ["-m", "planted"], cwd: workspace })
    ],
    ["python -c", () => ({ command: "python", args: ["-Bc", "import planted"], cwd: workspace })],
    ["ruby -S, which looks the script up", () => ({ command: "ruby", args: ["-S", "solargraph"], cwd: workspace })],
    ["perl -M of a workspace module", () => ({ command: "perl", args: ["-Mplanted", "-e1"], cwd: workspace })],
    ["nice npx", () => ({ command: "nice", args: ["npx", "planted-server"], cwd: workspace })],
    ["timeout pnpm exec", () => ({ command: "timeout", args: ["600", "pnpm", "exec", "x"], cwd: workspace })],
    ["corepack pnpm exec", () => ({ command: "corepack", args: ["pnpm", "exec", "x"], cwd: workspace })],
    ["bundle exec", () => ({ command: "bundle", args: ["exec", "solargraph", "stdio"], cwd: workspace })],
    ["uvx", () => ({ command: "uvx", args: ["python-lsp-server"], cwd: workspace })],
    ["mise x", () => ({ command: "mise", args: ["x", "--", "planted-server"], cwd: workspace })],
    ["arch", () => ({ command: "arch", args: ["-arm64", "npx", "planted-server"], cwd: workspace })],
    ["tsx -e", () => ({ command: "tsx", args: ["-e", "require('./planted.js')"], cwd: workspace })],
    [
      "bun with a host script, after bunfig.toml preloads a workspace module",
      () => ({ command: "bun", args: [process.execPath], cwd: workspace })
    ],
    [
      "python -m after a flag that took a host file as its value",
      () => ({ command: "python3", args: ["-X", process.execPath, "-m", "planted"], cwd: workspace })
    ],
    [
      "node -e after a long flag that took a host file as its value",
      () => ({ command: "node", args: ["--title", process.execPath, "-e", "require('./planted.js')"], cwd: workspace })
    ],
    [
      "node -e after a short flag that took a host file as its value",
      () => ({ command: "node", args: ["-C", process.execPath, "-e", "require('./planted.js')"], cwd: workspace })
    ],
    ["node --run of a workspace package script", () => ({ command: "node", args: ["--run", "lsp"], cwd: workspace })],
    ["a versioned ruby", () => ({ command: "ruby3.3", args: ["-e", "load './planted.rb'"], cwd: workspace })],
    ["a versioned perl", () => ({ command: "/usr/bin/perl5.34", args: ["-Mplanted"], cwd: workspace })],
    ["pythonw -m", () => ({ command: "pythonw", args: ["-m", "planted"], cwd: workspace })],
    ["py -m", () => ({ command: "py.exe", args: ["-m", "planted"], cwd: workspace })]
  ])("refuses the launcher %s, whose arguments choose what runs", async (_name, config) => {
    for (const construct of constructors) {
      const exit = await start(config(), construct)
      expect(failure(exit)).toBe("permission_denied")
    }
    expect(NodeFs.existsSync(marker)).toBe(false)
  })

  it.each(
    [
      ["node with no script, which reads code from stdin", "node", [], "runs node without a host script file"],
      ["node -", "node", ["-"], "runs node without a host script file"],
      ["node -- with nothing after it", "node", ["--"], "runs node without a host script file"],
      ["node given a module name", "node", ["typescript-language-server"], "runs node without a host script file"],
      ["node given only flags", "node", ["--stdio"], "runs node without a host script file"],
      ["a flag value, not a flag cluster", "node", ["-Cdevelopment"], "runs node without a host script file"],
      ["python given a value flag", "python3.12", ["-Wdefault::DeprecationWarning"], "runs python3.12 without"],
      ["ruby -e", "ruby", ["-we", "1"], "runs ruby -e"],
      ["node --require", "node", ["--require=./planted.js", "server.js"], "runs node --require"],
      ["bun x", "bun", ["x", "planted-server"], "runs bun,"],
      ["a long flag with no file after it", "node", ["--title", "lsp", "--stdio"], "runs node without a host script"]
    ] as const
  )("names what it refuses: %s", async (_name, command, args, message) => {
    // No args at all, as well as an empty list, leaves node reading code from stdin.
    const exit = await start({ command, ...(args.length === 0 ? {} : { args: [...args] }), cwd: workspace })
    expect(failure(exit)).toBe("permission_denied")
    expect(Exit.isFailure(exit) && Cause.pretty(exit.cause)).toContain(message)
  })

  it("refuses a workspace script named after --", async () => {
    const exit = await start({ command: process.execPath, args: ["--", "planted.js"], cwd: workspace })
    expect(failure(exit)).toBe("permission_denied")
    expect(NodeFs.existsSync(marker)).toBe(false)
  })

  it("starts a host program and forwards initializationOptions", async () => {
    const server = `
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const at = buffer.indexOf("\\r\\n\\r\\n");
  if (at < 0) return;
  const length = Number(/Content-Length: (\\d+)/.exec(buffer.slice(0, at))[1]);
  if (buffer.length < at + 4 + length) return;
  const request = JSON.parse(buffer.slice(at + 4, at + 4 + length));
  buffer = buffer.slice(at + 4 + length);
  if (request.method !== "initialize") return;
  if (JSON.stringify(request.params.initializationOptions) !== '{"tsserver":{"path":"/host/tsserver.js"}}') process.exit(3);
  const body = JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { capabilities: {} } });
  process.stdout.write("Content-Length: " + Buffer.byteLength(body) + "\\r\\n\\r\\n" + body);
});`
    const script = NodePath.join(root, "server.js")
    NodeFs.writeFileSync(script, server)
    const exit = await start({
      command: process.execPath,
      args: ["--no-warnings", "--", script],
      cwd: workspace,
      initializationOptions: { tsserver: { path: "/host/tsserver.js" } }
    })
    expect(Exit.isSuccess(exit)).toBe(true)
  })
})

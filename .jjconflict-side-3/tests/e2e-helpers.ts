import { onTestFinished } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

export const REPO_ROOT = resolve(import.meta.dir, "..");
const CLI_ENTRY = resolve(REPO_ROOT, "src/cli/index.ts");
const ROOT_NODE_MODULES = resolve(REPO_ROOT, "node_modules");
const BUN_BINARY = process.execPath;
const EXECUTABLE_SHEBANG = `#!${BUN_BINARY}`;

type RunSmithersOptions = {
  cwd: string;
  env?: Record<string, string | undefined>;
  format?: "json" | "toon" | "yaml" | "md" | "jsonl" | null;
};

export type SmithersCliResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  json?: unknown;
};

export type TempRepo = {
  dir: string;
  path: (...parts: string[]) => string;
  write: (relativePath: string, contents: string) => string;
  read: (relativePath: string) => string;
  exists: (relativePath: string) => boolean;
};

export const FAKE_AGENT_RESPONSE = JSON.stringify({
  summary: "mock agent completed the task",
  prompt: "hello",
  reviewer: "mock-reviewer",
  approved: true,
  feedback: "looks good",
  issues: [],
  filesChanged: [],
  allTestsPassing: true,
  allPassed: true,
  failingSummary: null,
  steps: ["inspect", "implement", "verify"],
  tickets: [],
});

function ensureDir(path: string) {
  mkdirSync(path, { recursive: true });
}

function writeFile(path: string, contents: string) {
  ensureDir(dirname(path));
  writeFileSync(path, contents, "utf8");
}

function symlinkIfMissing(target: string, path: string, type: "dir" | "file" | "junction" = "dir") {
  if (existsSync(path)) return;
  ensureDir(dirname(path));
  symlinkSync(target, path, type);
}

function linkRepoRuntimeDeps(repoDir: string) {
  const nodeModulesDir = join(repoDir, "node_modules");
  const binDir = join(nodeModulesDir, ".bin");
  ensureDir(nodeModulesDir);
  ensureDir(binDir);

  symlinkIfMissing(REPO_ROOT, join(nodeModulesDir, "smithers-orchestrator"));
  symlinkIfMissing(resolve(ROOT_NODE_MODULES, "zod"), join(nodeModulesDir, "zod"));
  symlinkIfMissing(resolve(ROOT_NODE_MODULES, "react"), join(nodeModulesDir, "react"));
  symlinkIfMissing(resolve(ROOT_NODE_MODULES, "react-dom"), join(nodeModulesDir, "react-dom"));
  symlinkIfMissing(resolve(ROOT_NODE_MODULES, "typescript"), join(nodeModulesDir, "typescript"));
  symlinkIfMissing(resolve(ROOT_NODE_MODULES, "@types"), join(nodeModulesDir, "@types"));
  symlinkIfMissing(resolve(ROOT_NODE_MODULES, "@mdx-js"), join(nodeModulesDir, "@mdx-js"));
  symlinkIfMissing(resolve(ROOT_NODE_MODULES, "typescript", "bin", "tsc"), join(binDir, "tsc"), "file");
}

export function createTempRepo(): TempRepo {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "smithers-e2e-")));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  writeFile(
    join(dir, "package.json"),
    JSON.stringify(
      {
        name: "smithers-e2e-fixture",
        private: true,
        type: "module",
      },
      null,
      2,
    ) + "\n",
  );

  linkRepoRuntimeDeps(dir);

  return {
    dir,
    path: (...parts: string[]) => join(dir, ...parts),
    write(relativePath, contents) {
      const path = join(dir, relativePath);
      writeFile(path, contents);
      return path;
    },
    read(relativePath) {
      return readFileSync(join(dir, relativePath), "utf8");
    },
    exists(relativePath) {
      return existsSync(join(dir, relativePath));
    },
  };
}

function parseTrailingJson(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;

  const candidates: string[] = [trimmed];
  const lastObjectStart = trimmed.lastIndexOf("\n{");
  const lastArrayStart = trimmed.lastIndexOf("\n[");
  if (lastObjectStart >= 0) {
    candidates.push(trimmed.slice(lastObjectStart + 1));
  }
  if (lastArrayStart >= 0) {
    candidates.push(trimmed.slice(lastArrayStart + 1));
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {}
  }

  return undefined;
}

export function runSmithers(args: string[], options: RunSmithersOptions): SmithersCliResult {
  const cliArgs = options.format
    ? ["run", CLI_ENTRY, ...args, "--format", options.format]
    : ["run", CLI_ENTRY, ...args];
  const result = spawnSync(BUN_BINARY, cliArgs, {
    cwd: options.cwd,
    env: {
      ...process.env,
      ...options.env,
    },
    encoding: "utf8",
  });

  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  let json: unknown;
  if (options.format === "json") {
    json = parseTrailingJson(stdout);
  }

  return {
    exitCode: result.status ?? 1,
    stdout,
    stderr,
    json,
  };
}

export function prependPath(dir: string, env?: Record<string, string | undefined>) {
  const currentPath = env?.PATH ?? process.env.PATH ?? "";
  return {
    ...env,
    PATH: `${dir}:${currentPath}`,
  };
}

export function writeTestWorkflow(repo: TempRepo, relativePath = "workflow.tsx") {
  return repo.write(
    relativePath,
    [
      "/** @jsxImportSource smithers-orchestrator */",
      'import { createSmithers, Workflow, Task } from "smithers-orchestrator";',
      'import { z } from "zod";',
      "",
      "const { smithers, outputs } = createSmithers({",
      "  result: z.object({",
      "    summary: z.string(),",
      "    prompt: z.string().nullable(),",
      "  }),",
      "});",
      "",
      "export default smithers((ctx) => (",
      '  <Workflow name="fixture-workflow">',
      '    <Task id="write-result" output={outputs.result}>',
      "      {{",
      '        summary: "fixture workflow ran",',
      "        prompt: ctx.input.prompt ?? null,",
      "      }}",
      "    </Task>",
      "  </Workflow>",
      "));",
      "",
    ].join("\n"),
  );
}

export function createExecutableDir(prefix = "smithers-fake-bin-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

export function writeExecutable(dir: string, name: string, contents: string) {
  const path = join(dir, name);
  writeFile(path, contents);
  chmodSync(path, 0o755);
  return path;
}

export function writeFakeClaudeBinary(dir: string, response = FAKE_AGENT_RESPONSE) {
  return writeExecutable(
    dir,
    "claude",
    [
      EXECUTABLE_SHEBANG,
      "const payload = process.env.SMITHERS_FAKE_AGENT_RESPONSE ?? " + JSON.stringify(response) + ";",
      "process.stdout.write(JSON.stringify({",
      '  type: "turn_end",',
      "  message: {",
      '    role: "assistant",',
      '    content: [{ type: "text", text: "```json\\n" + payload + "\\n```\\n" }],',
      "  },",
      "}) + \"\\n\");",
      "",
    ].join("\n"),
  );
}

export function writeFakeCodexBinary(dir: string, response = FAKE_AGENT_RESPONSE) {
  return writeExecutable(
    dir,
    "codex",
    [
      EXECUTABLE_SHEBANG,
      'const fs = require("node:fs");',
      "const payload = process.env.SMITHERS_FAKE_AGENT_RESPONSE ?? " + JSON.stringify(response) + ";",
      "const args = process.argv.slice(2);",
      'const outputIndex = args.indexOf("--output-last-message");',
      "if (outputIndex >= 0 && args[outputIndex + 1]) {",
      '  fs.writeFileSync(args[outputIndex + 1], "```json\\n" + payload + "\\n```\\n", "utf8");',
      "}",
      'process.stdout.write(JSON.stringify({ type: "turn.completed" }) + "\\n");',
      "",
    ].join("\n"),
  );
}

export function writeFakeGeminiBinary(dir: string, response = FAKE_AGENT_RESPONSE) {
  return writeExecutable(
    dir,
    "gemini",
    [
      EXECUTABLE_SHEBANG,
      "const payload = process.env.SMITHERS_FAKE_AGENT_RESPONSE ?? " + JSON.stringify(response) + ";",
      'process.stdout.write(JSON.stringify({ text: "```json\\n" + payload + "\\n```\\n" }) + "\\n");',
      "",
    ].join("\n"),
  );
}

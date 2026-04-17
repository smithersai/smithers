import { onTestFinished } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
export const REPO_ROOT = resolve(import.meta.dir, "../../..");
const CLI_ENTRY = resolve(REPO_ROOT, "apps/cli/src/index.js");
const ROOT_NODE_MODULES = resolve(REPO_ROOT, "node_modules");
const BUN_BINARY = process.execPath;
const EXECUTABLE_SHEBANG = `#!${BUN_BINARY}`;
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
/**
 * @param {string} path
 */
function ensureDir(path) {
    mkdirSync(path, { recursive: true });
}
/**
 * @param {string} path
 * @param {string} contents
 */
function writeFile(path, contents) {
    ensureDir(dirname(path));
    writeFileSync(path, contents, "utf8");
}
/**
 * @param {string} target
 * @param {string} path
 * @param {"dir" | "file" | "junction"} [type]
 */
function symlinkIfMissing(target, path, type = "dir") {
    if (existsSync(path))
        return;
    ensureDir(dirname(path));
    symlinkSync(target, path, type);
}
/**
 * @param {string} repoDir
 */
function linkRepoRuntimeDeps(repoDir) {
    const nodeModulesDir = join(repoDir, "node_modules");
    const binDir = join(nodeModulesDir, ".bin");
    ensureDir(nodeModulesDir);
    ensureDir(binDir);
    symlinkIfMissing(resolve(REPO_ROOT, "packages/smithers"), join(nodeModulesDir, "smithers-orchestrator"));
    symlinkIfMissing(resolve(ROOT_NODE_MODULES, "zod"), join(nodeModulesDir, "zod"));
    symlinkIfMissing(resolve(ROOT_NODE_MODULES, "react"), join(nodeModulesDir, "react"));
    symlinkIfMissing(resolve(ROOT_NODE_MODULES, "react-dom"), join(nodeModulesDir, "react-dom"));
    symlinkIfMissing(resolve(ROOT_NODE_MODULES, "typescript"), join(nodeModulesDir, "typescript"));
    symlinkIfMissing(resolve(ROOT_NODE_MODULES, "@types"), join(nodeModulesDir, "@types"));
    symlinkIfMissing(resolve(ROOT_NODE_MODULES, "@mdx-js"), join(nodeModulesDir, "@mdx-js"));
    symlinkIfMissing(resolve(ROOT_NODE_MODULES, "typescript", "bin", "tsc"), join(binDir, "tsc"), "file");
}
/**
 * @returns {TempRepo}
 */
export function createTempRepo() {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "smithers-e2e-")));
    onTestFinished(() => {
        rmSync(dir, { recursive: true, force: true });
    });
    writeFile(join(dir, "package.json"), JSON.stringify({
        name: "smithers-e2e-fixture",
        private: true,
        type: "module",
    }, null, 2) + "\n");
    linkRepoRuntimeDeps(dir);
    return {
        dir,
        path: (...parts) => join(dir, ...parts),
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
/**
 * @param {string} stdout
 * @returns {unknown}
 */
function parseTrailingJson(stdout) {
    const trimmed = stdout.trim();
    if (!trimmed)
        return undefined;
    const candidates = [trimmed];
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
        }
        catch { }
    }
    return undefined;
}
/**
 * @param {string[]} args
 * @param {RunSmithersOptions} options
 * @returns {SmithersCliResult}
 */
export function runSmithers(args, options) {
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
    let json;
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
/**
 * @param {string} dir
 * @param {Record<string, string | undefined>} [env]
 */
export function prependPath(dir, env) {
    const currentPath = env?.PATH ?? process.env.PATH ?? "";
    return {
        ...env,
        PATH: `${dir}:${currentPath}`,
    };
}
/**
 * @param {TempRepo} repo
 */
export function writeTestWorkflow(repo, relativePath = "workflow.tsx") {
    return repo.write(relativePath, [
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
    ].join("\n"));
}
export function createExecutableDir(prefix = "smithers-fake-bin-") {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    onTestFinished(() => {
        rmSync(dir, { recursive: true, force: true });
    });
    return dir;
}
/**
 * @param {string} dir
 * @param {string} name
 * @param {string} contents
 */
export function writeExecutable(dir, name, contents) {
    const path = join(dir, name);
    writeFile(path, contents);
    chmodSync(path, 0o755);
    return path;
}
/**
 * @param {string} dir
 */
export function writeFakeClaudeBinary(dir, response = FAKE_AGENT_RESPONSE) {
    return writeExecutable(dir, "claude", [
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
    ].join("\n"));
}
/**
 * @param {string} dir
 */
export function writeFakeCodexBinary(dir, response = FAKE_AGENT_RESPONSE) {
    return writeExecutable(dir, "codex", [
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
    ].join("\n"));
}
/**
 * @param {string} dir
 */
export function writeFakeGeminiBinary(dir, response = FAKE_AGENT_RESPONSE) {
    return writeExecutable(dir, "gemini", [
        EXECUTABLE_SHEBANG,
        "const payload = process.env.SMITHERS_FAKE_AGENT_RESPONSE ?? " + JSON.stringify(response) + ";",
        'process.stdout.write(JSON.stringify({ text: "```json\\n" + payload + "\\n```\\n" }) + "\\n");',
        "",
    ].join("\n"));
}

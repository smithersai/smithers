// Regression test for the `bunx smithers-orchestrator init` path bug.
//
// Before the fix, workflow-pack.js resolved `../../../package.json` relative
// to `apps/cli/src/workflow-pack.js`. That worked inside the monorepo (it
// landed on the root package.json) but failed in a published install, where
// the file lives at `node_modules/@smithers-orchestrator/cli/src/` and the
// relative path resolves to `node_modules/package.json` — which does not
// exist. Init would throw ENOENT before writing a single file.
//
// This test reproduces the installed layout in a temp directory and verifies
// `initWorkflowPack` succeeds and pins `smithers-orchestrator` to a real
// version range (not `"latest"`).

import { expect, onTestFinished, test } from "bun:test";
import {
    chmodSync,
    cpSync,
    mkdirSync,
    mkdtempSync,
    realpathSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../..");
const CLI_SRC = resolve(REPO_ROOT, "apps/cli/src");

/**
 * @param {string} path
 * @param {string} contents
 */
function writeFile(path, contents) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents, "utf8");
}

function buildFakeInstallTree() {
    const root = mkdtempSync(join(tmpdir(), "smithers-installed-layout-"));
    onTestFinished(() => {
        rmSync(root, { recursive: true, force: true });
    });
    const cwd = join(root, "user-proj");
    const nm = join(cwd, "node_modules");
    // Simulate how pnpm/npm/bunx lay out the published package. Intentionally
    // do NOT include a `package.json` at `node_modules/` — this is the exact
    // condition that triggered the ENOENT before the fix.
    const smithersDir = join(nm, "smithers-orchestrator");
    const cliDir = join(nm, "@smithers-orchestrator", "cli");
    const errorsDir = join(nm, "@smithers-orchestrator", "errors");

    writeFile(
        join(smithersDir, "package.json"),
        JSON.stringify({
            name: "smithers-orchestrator",
            version: "99.0.0",
            type: "module",
            bin: { smithers: "./src/bin/smithers.js" },
        }) + "\n",
    );
    writeFile(
        join(smithersDir, "src/bin/smithers.js"),
        "#!/usr/bin/env node\nimport \"@smithers-orchestrator/cli\";\n",
    );

    writeFile(
        join(cliDir, "package.json"),
        JSON.stringify({
            name: "@smithers-orchestrator/cli",
            version: "99.0.0",
            type: "module",
        }) + "\n",
    );
    cpSync(join(CLI_SRC, "workflow-pack.js"), join(cliDir, "src/workflow-pack.js"));
    cpSync(join(CLI_SRC, "agent-detection.js"), join(cliDir, "src/agent-detection.js"));

    // Stub out the errors package so agent-detection.js can import it.
    writeFile(
        join(errorsDir, "package.json"),
        JSON.stringify({
            name: "@smithers-orchestrator/errors",
            version: "99.0.0",
            type: "module",
            exports: { ".": "./src/index.js" },
        }) + "\n",
    );
    writeFile(
        join(errorsDir, "src/index.js"),
        [
            "export class SmithersError extends Error {",
            "  constructor(code, message, context) {",
            "    super(message);",
            "    this.code = code;",
            "    this.context = context;",
            "  }",
            "}",
            "",
        ].join("\n"),
    );

    // Fake zod + typescript so require.resolve finds versions.
    writeFile(
        join(nm, "zod", "package.json"),
        JSON.stringify({ name: "zod", version: "4.99.0", main: "index.js" }) + "\n",
    );
    writeFile(join(nm, "zod", "index.js"), "export default {};\n");
    writeFile(
        join(nm, "typescript", "package.json"),
        JSON.stringify({ name: "typescript", version: "5.99.0" }) + "\n",
    );

    // Fake claude binary so init has an agent to write into agents.ts.
    const binDir = join(root, "bin");
    writeFile(join(binDir, "claude"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(binDir, "claude"), 0o755);
    mkdirSync(join(root, "home", ".claude"), { recursive: true });

    return {
        cwd,
        cliWorkflowPack: join(cliDir, "src/workflow-pack.js"),
        home: join(root, "home"),
        path: `${binDir}:/usr/bin:/bin`,
    };
}

test("initWorkflowPack succeeds when run from a published install layout", () => {
    const tree = buildFakeInstallTree();

    // Run init in a fresh child process using the faked node_modules layout —
    // running inline would resolve deps against the monorepo's node_modules.
    const child = spawnSync(
        process.execPath,
        [
            "--input-type=module",
            "-e",
            `
            import { initWorkflowPack } from ${JSON.stringify(tree.cliWorkflowPack)};
            const result = initWorkflowPack({});
            process.stdout.write(JSON.stringify({
                ok: true,
                writtenCount: result.writtenFiles.length,
                rootDir: result.rootDir,
            }));
            `,
        ],
        {
            cwd: tree.cwd,
            env: {
                HOME: tree.home,
                PATH: tree.path,
            },
            encoding: "utf8",
        },
    );

    if (child.status !== 0) {
        throw new Error(
            `child failed (code=${child.status}):\nstdout: ${child.stdout}\nstderr: ${child.stderr}`,
        );
    }
    const summary = JSON.parse(child.stdout);
    expect(summary.ok).toBe(true);
    expect(summary.writtenCount).toBeGreaterThan(30);
    expect(realpathSync(summary.rootDir)).toBe(realpathSync(join(tree.cwd, ".smithers")));

    const generated = JSON.parse(readFileSync(join(tree.cwd, ".smithers/package.json"), "utf8"));
    // The CLI's own version (99.0.0) should be pinned, not "latest".
    expect(generated.dependencies["smithers-orchestrator"]).toBe("^99.0.0");
    // And installed dep versions should be picked up via createRequire.
    expect(generated.dependencies.zod).toBe("4.99.0");
    expect(generated.devDependencies.typescript).toBe("5.99.0");
});

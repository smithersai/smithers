import { applyPatch as applyUnifiedPatch } from "diff";
import { spawn } from "node:child_process";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { SmithersError } from "@smithers/errors/SmithersError";
/** @typedef {import("./diff-bundle.ts").DiffBundle} DiffBundle */
/** @typedef {import("./diff-bundle.ts").FilePatch} FilePatch */

/**
 * @param {string} cwd
 * @param {string[]} args
 * @param {{ input?: string; allowExitCodes?: ReadonlySet<number>; }} [options]
 * @returns {Promise<GitCommandResult>}
 */
async function runGit(cwd, args, options) {
    return new Promise((resolve, reject) => {
        const child = spawn("git", args, {
            cwd,
            stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
            stdout += chunk;
        });
        child.stderr.on("data", (chunk) => {
            stderr += chunk;
        });
        child.once("error", reject);
        child.once("close", (code) => {
            const allowExitCodes = options?.allowExitCodes;
            if (code === 0 || (typeof code === "number" && allowExitCodes?.has(code))) {
                resolve({ stdout, stderr });
                return;
            }
            reject(new SmithersError("INVALID_INPUT", `git ${args.join(" ")} failed`, { cwd, args, code, stderr: stderr.trim(), stdout: stdout.trim() }));
        });
        if (options?.input) {
            child.stdin.write(options.input);
        }
        child.stdin.end();
    });
}
/**
 * @param {string} diff
 * @returns {string[]}
 */
function splitGitDiff(diff) {
    const normalized = diff.trim();
    if (normalized.length === 0) {
        return [];
    }
    return normalized
        .split(/^diff --git /m)
        .filter((chunk) => chunk.length > 0)
        .map((chunk) => `diff --git ${chunk}`.trimEnd() + "\n");
}
/**
 * @param {string} chunk
 * @returns {string}
 */
function extractPatchPath(chunk) {
    const renameTo = chunk.match(/^rename to (.+)$/m)?.[1];
    if (renameTo) {
        return renameTo.trim();
    }
    const plusPath = chunk.match(/^\+\+\+ b\/(.+)$/m)?.[1];
    if (plusPath) {
        return plusPath.trim();
    }
    const minusPath = chunk.match(/^--- a\/(.+)$/m)?.[1];
    if (minusPath) {
        return minusPath.trim();
    }
    const diffHeader = chunk.match(/^diff --git a\/(.+?) b\/(.+)$/m);
    if (diffHeader) {
        return diffHeader[2].trim();
    }
    throw new SmithersError("INVALID_INPUT", "Unable to determine file path from diff chunk", { chunk: chunk.slice(0, 200) });
}
/**
 * @param {string} chunk
 * @returns {FilePatch["operation"]}
 */
function extractOperation(chunk) {
    if (/^new file mode /m.test(chunk)) {
        return "add";
    }
    if (/^deleted file mode /m.test(chunk)) {
        return "delete";
    }
    return "modify";
}
/**
 * @param {string} chunk
 * @returns {boolean}
 */
function isBinaryPatch(chunk) {
    return /(^GIT binary patch$)|(^Binary files )/m.test(chunk);
}
/**
 * @param {string} path
 * @returns {Promise<boolean>}
 */
async function fileExists(path) {
    try {
        await access(path);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * @param {string} baseRef
 * @param {string} currentDir
 * @returns {Promise<Set<string>>}
 */
async function listBinaryPaths(baseRef, currentDir) {
    const { stdout } = await runGit(currentDir, [
        "diff",
        "--numstat",
        "--find-renames=100%",
        baseRef,
        "--",
        ".",
    ]);
    const binaryPaths = new Set();
    for (const line of stdout.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed)
            continue;
        const [added, removed, ...rest] = trimmed.split("\t");
        if (added === "-" && removed === "-" && rest.length > 0) {
            binaryPaths.add(rest.join("\t"));
        }
    }
    return binaryPaths;
}
/**
 * @param {string} currentDir
 * @returns {Promise<string[]>}
 */
async function listUntrackedFiles(currentDir) {
    const { stdout } = await runGit(currentDir, [
        "ls-files",
        "--others",
        "--exclude-standard",
        "--",
        ".",
    ]);
    return stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
}
/**
 * @param {string} currentDir
 * @returns {Promise<string[]>}
 */
async function computeUntrackedDiffs(currentDir) {
    const untracked = await listUntrackedFiles(currentDir);
    const diffs = [];
    for (const relativePath of untracked) {
        const { stdout } = await runGit(currentDir, ["diff", "--no-index", "--binary", "--", "/dev/null", relativePath], { allowExitCodes: new Set([1]) });
        if (stdout.trim().length > 0) {
            diffs.push(stdout.trimEnd() + "\n");
        }
    }
    return diffs;
}
/**
 * @param {string} baseRef
 * @param {string} currentDir
 * @returns {Promise<DiffBundle>}
 */
export async function computeDiffBundle(baseRef, currentDir, seq = 1) {
    const [{ stdout: trackedDiff }, binaryPaths, untrackedDiffs] = await Promise.all([
        runGit(currentDir, [
            "diff",
            "--binary",
            "--find-renames=100%",
            "--no-ext-diff",
            baseRef,
            "--",
            ".",
        ]),
        listBinaryPaths(baseRef, currentDir),
        computeUntrackedDiffs(currentDir),
    ]);
    const patches = [];
    const chunks = [
        ...splitGitDiff(trackedDiff),
        ...untrackedDiffs.flatMap(splitGitDiff),
    ];
    for (const chunk of chunks) {
        const path = extractPatchPath(chunk);
        const operation = extractOperation(chunk);
        const binary = isBinaryPatch(chunk) || binaryPaths.has(path);
        const fullPath = join(currentDir, path);
        patches.push({
            path,
            operation,
            diff: chunk,
            binaryContent: binary && operation !== "delete" && await fileExists(fullPath)
                ? (await readFile(fullPath)).toString("base64")
                : undefined,
        });
    }
    return {
        seq,
        baseRef,
        patches,
    };
}
/**
 * @param {FilePatch} patch
 * @param {string} targetDir
 * @returns {Promise<void>}
 */
async function applyPatchFallback(patch, targetDir) {
    const targetPath = join(targetDir, patch.path);
    const targetExists = await fileExists(targetPath);
    if (patch.binaryContent) {
        if (patch.operation === "delete") {
            await rm(targetPath, { force: true });
            return;
        }
        await mkdir(dirname(targetPath), { recursive: true });
        await writeFile(targetPath, Buffer.from(patch.binaryContent, "base64"));
        return;
    }
    if (patch.operation === "delete" && !targetExists) {
        return;
    }
    const current = patch.operation === "add" || !targetExists
        ? ""
        : await readFile(targetPath, "utf8");
    const updated = applyUnifiedPatch(current, patch.diff);
    if (updated === false) {
        throw new SmithersError("TOOL_PATCH_FAILED", `Failed to apply patch for ${patch.path}`, { path: patch.path, operation: patch.operation });
    }
    if (patch.operation === "delete") {
        await rm(targetPath, { force: true });
        return;
    }
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, updated, "utf8");
}
/**
 * @param {DiffBundle} bundle
 * @param {string} targetDir
 * @returns {Promise<void>}
 */
export async function applyDiffBundle(bundle, targetDir) {
    if (bundle.patches.length === 0) {
        return;
    }
    await mkdir(targetDir, { recursive: true });
    const fullPatch = bundle.patches.map((patch) => patch.diff).join("");
    try {
        await runGit(targetDir, ["apply", "--binary", "--whitespace=nowarn", "--unsafe-paths", "-"], { input: fullPatch });
        return;
    }
    catch (error) {
        for (const patch of bundle.patches) {
            await applyPatchFallback(patch, targetDir);
        }
    }
}
